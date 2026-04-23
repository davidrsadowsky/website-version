'use strict';

/**
 * Kids Library Calendar
 * Fetches children's event schedules from 6 Westchester County libraries
 * and generates calendar.html — open it in any browser.
 *
 * Usage:
 *   node fetch_calendars.js
 *
 * To enable Mount Kisco (requires a one-time browser download):
 *   npm install playwright && npx playwright install chromium
 */

const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Library configuration
// ---------------------------------------------------------------------------

const LIBRARIES = {
  katonah:        { name: 'Katonah Village Library',              color: '#3a86ff' },
  pound_ridge:    { name: 'Pound Ridge Library',                  color: '#06d6a0' },
  bedford_free:   { name: 'Bedford Free Library',                 color: '#fb5607' },
  bedford_hills:  { name: 'Bedford Hills Free Library',           color: '#8338ec' },
  north_castle:   { name: 'North Castle Library (Armonk)',        color: '#e07a5f' },
  mount_kisco:    { name: 'Mount Kisco Public Library',           color: '#f72585' },
  mount_pleasant: { name: 'Mount Pleasant Library (Pleasantville)', color: '#43aa8b' },
  chappaqua:      { name: 'Chappaqua Library',                    color: '#d4a017' },
  larchmont:      { name: 'Larchmont Public Library',             color: '#577590' },
};

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
};
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DAY_NAMES = [
  'Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday',
];

/**
 * Normalize a time range string to consistent format: "10:30am – 11:00am"
 * Handles mixed capitalisation ("AM"/"am"), optional spaces before AM/PM,
 * and various separators (-, –, —).
 */
function normalizeTimeStr(timeStr) {
  if (!timeStr) return '';
  return timeStr
    .replace(/(\d{1,2}:\d{2})\s*([ap]m)\b/gi, (_, t, ampm) => t + ampm.toLowerCase())
    .replace(/\s*[-–—]+\s*/g, ' – ')
    .trim();
}

/** Convert the start time of a normalised time string to minutes since midnight for sorting. */
function parseStartMinutes(timeStr) {
  if (!timeStr) return 9999;
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return 9999;
  let hour = parseInt(m[1]);
  const min  = parseInt(m[2]);
  const ampm = m[3].toLowerCase();
  if (ampm === 'am' && hour === 12) hour = 0;
  if (ampm === 'pm' && hour !== 12) hour += 12;
  return hour * 60 + min;
}

/** Parse "April 25, 2026" or "Friday, April 25, 2026" → Date (local midnight). */
function parseDateStr(str) {
  const m = str.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const month = MONTH_MAP[m[1].toLowerCase()];
  if (!month) return null;
  return new Date(parseInt(m[3]), month - 1, parseInt(m[2]));
}

/** Date → "YYYY-MM-DD" string for comparison/dedup. */
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** Today at local midnight. */
function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Next n month starts as [year, month] arrays. */
function getMonths(n = 3) {
  const result = [];
  let d = new Date(today().getFullYear(), today().getMonth(), 1);
  for (let i = 0; i < n; i++) {
    result.push([d.getFullYear(), d.getMonth() + 1]);
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return result;
}

/** Format a Date for display in the HTML. */
function formatDate(d) {
  const isToday    = dateKey(d) === dateKey(today());
  const isTomorrow = dateKey(d) === dateKey(new Date(today().getFullYear(), today().getMonth(), today().getDate() + 1));
  const base = `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  if (isToday)    return `Today — ${base}`;
  if (isTomorrow) return `Tomorrow — ${base}`;
  return base;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    console.log(`    [warn] ${url}\n           ${e.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Scrapers
// ---------------------------------------------------------------------------

// --- 1. librarycalendar.com / Drupal library_calendar (Katonah, Pound Ridge, Bedford Hills)

const LC_BASES = {
  katonah:        'https://katonah.librarycalendar.com',
  pound_ridge:    'https://poundridge.librarycalendar.com',
  bedford_hills:  'https://www.bedfordhillsfreelibrary.org',
  mount_pleasant: 'https://mountpleasant.librarycalendar.com',
  chappaqua:      'https://www.chappaqualibrary.org',
  larchmont:      'https://larchmont.librarycalendar.com',
};

function parseLcCalendar(html, libraryKey, options = {}) {
  // Shared parser for the Drupal library_calendar module (list/upcoming view).
  // Date lives in aria-label: '... on Friday, April 25, 2026 @ 10:00am'
  // options.branchFilter: if set, skip events whose branch text doesn't include this string
  const events = [];
  if (!html) return events;

  const $      = cheerio.load(html);
  const cutoff = today();

  $('article.event-card, article.lc-event').each((_, el) => {
    const $el  = $(el);
    const link = $el.find('a[aria-label]').first();
    if (!link.length) return;

    const aria      = link.attr('aria-label') || '';
    const dateMatch = aria.match(/on ([A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4})/);
    if (!dateMatch) return;

    const eventDate = parseDateStr(dateMatch[1]);
    if (!eventDate || eventDate < cutoff) return;

    // Branch filter: skip events not at the requested branch (e.g. Pleasantville only)
    if (options.branchFilter) {
      const branchText = $el.find('.lc-event__branch').text();
      if (!branchText.includes(options.branchFilter)) return;
    }

    // Extract the quoted event name from the aria-label when available
    const titleMatch = aria.match(/[“”](.+?)[“”]/);
    const title = titleMatch ? titleMatch[1] : link.text().trim();
    if (!title) return;

    let href = link.attr('href') || '';
    if (href.startsWith('/')) href = (LC_BASES[libraryKey] || '') + href;

    // Primary: dedicated time element. Fallback: full date+time string like
    // “Thursday, April 23, 2026 at 10:30am - 11:00am” — extract the part after “at”.
    let timeStr = $el.find('.lc-event-info-item--time').first().text().trim();
    if (!timeStr) {
      const dtText = $el.find('.lc-list-event-info-item--date, .lc-list-event-info-item--time')
        .first().text().trim();
      const atMatch = dtText.match(/\bat\s+(.+)$/i);
      if (atMatch) timeStr = atMatch[1].trim();
    }
    timeStr = timeStr.replace(/\s+/g, ' ');

    events.push({ date: eventDate, time: timeStr, title, url: href, library: libraryKey, category: options.category || 'kids' });
  });

  return events;
}

// Fetch the list/upcoming view, paginating up to maxPages pages.
// Stops early when a page yields no events within the 3-month window.
async function scrapeLcListView(baseUrl, libraryKey, options = {}, maxPages = 3) {
  const cutoffDate = new Date(today().getFullYear(), today().getMonth() + 3, 1);
  const allEvents  = [];

  for (let page = 0; page < maxPages; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}page=${page}`;
    const html = await fetchHtml(url);
    if (!html) break;

    const batch = parseLcCalendar(html, libraryKey, options);
    allEvents.push(...batch);

    if (batch.length === 0) break;
    if (batch.every(e => e.date >= cutoffDate)) break;
    await sleep(400);
  }

  return allEvents;
}

async function scrapeKatonah() {
  const base = 'https://katonah.librarycalendar.com/events/list';
  const [kids, adults] = await Promise.all([
    scrapeLcListView(base + '?age_groups[160]=160&age_groups[1]=1&age_groups[161]=161&age_groups[2]=2', 'katonah', { category: 'kids' }),
    scrapeLcListView(base + '?age_groups[4]=4', 'katonah', { category: 'adult' }),
  ]);
  return [...kids, ...adults];
}

async function scrapePoundRidge() {
  const base = 'https://poundridge.librarycalendar.com/events/list';
  const [kids, adults] = await Promise.all([
    scrapeLcListView(base + '?age_groups[1]=1&age_groups[90]=90&age_groups[2]=2&age_groups[91]=91', 'pound_ridge', { category: 'kids' }),
    scrapeLcListView(base + '?age_groups[93]=93', 'pound_ridge', { category: 'adult' }),
  ]);
  return [...kids, ...adults];
}

async function scrapeBedfordHills() {
  const base = 'https://www.bedfordhillsfreelibrary.org/events/upcoming';
  // tid-6=Adults & Seniors, tid-4=Teens
  const [kids, adults] = await Promise.all([
    scrapeLcListView(base + '?age_groups[3]=3&age_groups[97]=97&age_groups[105]=105', 'bedford_hills', { category: 'kids' }),
    scrapeLcListView(base + '?age_groups[6]=6&age_groups[4]=4', 'bedford_hills', { category: 'adult' }),
  ]);
  return [...kids, ...adults];
}

async function scrapeMountPleasant() {
  const base = 'https://mountpleasant.librarycalendar.com/events/list';
  // tid-2=Children (Main), tid-4=Adults (Main); branchFilter keeps only Pleasantville
  const [kids, adults] = await Promise.all([
    scrapeLcListView(base + '?age_groups[2]=2', 'mount_pleasant', { category: 'kids', branchFilter: 'Main Library' }),
    scrapeLcListView(base + '?age_groups[4]=4', 'mount_pleasant', { category: 'adult', branchFilter: 'Main Library' }),
  ]);
  return [...kids, ...adults];
}

async function scrapeChappaqua() {
  const base = 'https://www.chappaqualibrary.org/events/list';
  // tid-30=Kids, tid-32=Adults
  const [kids, adults] = await Promise.all([
    scrapeLcListView(base + '?age_groups[30]=30', 'chappaqua', { category: 'kids' }),
    scrapeLcListView(base + '?age_groups[32]=32', 'chappaqua', { category: 'adult' }),
  ]);
  return [...kids, ...adults];
}

async function scrapeLarchmont() {
  const base = 'https://larchmont.librarycalendar.com/events/list';
  // kids: tid-75,74,98,102,141,142; adults: tid-77
  const [kids, adults] = await Promise.all([
    scrapeLcListView(base + '?age_groups[75]=75&age_groups[74]=74&age_groups[98]=98&age_groups[102]=102&age_groups[141]=141&age_groups[142]=142', 'larchmont', { category: 'kids' }),
    scrapeLcListView(base + '?age_groups[77]=77', 'larchmont', { category: 'adult' }),
  ]);
  return [...kids, ...adults];
}


// --- 2. Bedford Free Library (WordPress + Events Manager plugin)

async function fetchBedfordFreePage(urlPath, year, month, category) {
  const url  = `https://bedfordfreelibrary.org${urlPath}?mo=${month}&yr=${year}`;
  const html = await fetchHtml(url);
  const events = [];
  if (!html) return events;

  const $      = cheerio.load(html);
  const cutoff = today();

  $('div.event-list-post, li.em-event, article.em-event').each((_, el) => {
    const $el = $(el);

    const titleEl = $el.find('h2 > a, .em-event-name a, h3 > a').first();
    const dateEl  = $el.find('h4.la-date, .em-event-date, .em-date').first();
    const timeEl  = $el.find('h4.le-temps, .em-event-time, .em-time').first();

    if (!titleEl.length) return;

    const title   = titleEl.text().trim();
    const href    = titleEl.attr('href') || '';
    const rawDate = dateEl.text().trim();
    const timeStr = timeEl.text().trim().replace(/\s+/g, ' ');

    if (!rawDate || !title) return;

    const eventDate = parseDateStr(`${rawDate}, ${year}`);
    if (!eventDate || eventDate < cutoff) return;

    events.push({ date: eventDate, time: timeStr, title, url: href, library: 'bedford_free', category });
  });

  return events;
}

async function scrapeBedfordFree(year, month) {
  const [kids, adults] = await Promise.all([
    fetchBedfordFreePage('/children/programs/', year, month, 'kids'),
    fetchBedfordFreePage('/adults/programs/', year, month, 'adult'),
  ]);
  return [...kids, ...adults];
}


// --- 3. North Castle / Armonk (MH Software connectDaily)

async function scrapeNorthCastle(year, month) {
  const url =
    `https://ncpl.mhsoftware.com/ViewNonBannerMonth.html` +
    `?calendar_id=2&year=${year}&month=${month}`;
  const html = await fetchHtml(url);
  const events = [];
  if (!html) return events;

  const $      = cheerio.load(html);
  const cutoff = today();

  $('td').each((_, td) => {
    const $td = $(td);

    // Find the day number. connectDaily puts it in .MHVCDayNumber or a prominent text node.
    let dayNum = null;

    const dayEl = $td.find('.MHVCDayNumber, [class*="DayNumber"], [class*="dayNum"]').first();
    if (dayEl.length) {
      const n = parseInt(dayEl.text().trim(), 10);
      if (n >= 1 && n <= 31) dayNum = n;
    }

    if (dayNum === null) {
      // Fall back: look for a direct child whose sole text is a number 1-31
      $td.children().each((_, child) => {
        if (dayNum !== null) return;
        const text = $(child).clone().children().remove().end().text().trim();
        if (/^\d{1,2}$/.test(text)) {
          const n = parseInt(text, 10);
          if (n >= 1 && n <= 31) dayNum = n;
        }
      });
    }

    if (dayNum === null) return;

    let eventDate;
    try {
      eventDate = new Date(year, month - 1, dayNum);
      if (eventDate.getDate() !== dayNum) return; // invalid date (e.g. Feb 30)
    } catch (_) { return; }

    if (eventDate < cutoff) return;

    // item_type_id: 9=Children, 22=Virtual Children, 7=Adult, 18=Teen
    $td.find('a.MHVCItemLink').each((_, a) => {
      const $a     = $(a);
      const typeId = $a.attr('data-item_type_id') || '';
      let category;
      if (typeId === '9' || typeId === '22') category = 'kids';
      else if (typeId === '7' || typeId === '18') category = 'adult';
      else return;

      const title   = $a.text().trim();
      const timeStr = ($a.attr('title') || '').trim();
      if (!title) return;

      const href      = $a.attr('href') || '';
      const popMatch  = href.match(/popItem\((\d+),(\d+)\)/);
      const eventUrl  = popMatch
        ? `https://ncpl.mhsoftware.com/ViewItem.html?integral=0&cal_item_id=${popMatch[1]}&dtwhen=${popMatch[2]}`
        : '';

      events.push({ date: eventDate, time: timeStr, title, url: eventUrl, library: 'north_castle', category });
    });
  });

  return events;
}


// --- 4. Mount Kisco (CalendarWiz via Playwright)

async function scrapeMountKisco(year, month) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (_) {
    return { events: [], playwrightMissing: true };
  }

  const url =
    `https://www.calendarwiz.com/calendars/calendar.php` +
    `?crd=mountkiscopubliclibrary&op=cal&month=${month}&year=${year}`;
  const events  = [];
  const cutoff  = today();
  const eventRe = /^\s*(\d{1,2}:\d{2}[ap]m)\s*-\s*(\d{1,2}:\d{2}[ap]m)\s+(.+)/i;

  try {
    const browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page    = await browser.newPage();
    await page.goto(url, { timeout: 30_000 });
    await page.waitForTimeout(2_000);

    // Build a map of category CSS classes → 'kids' or 'adult'
    const catClasses = await page.evaluate(() => {
      const select = document.querySelector('#catsellist');
      const result = { kids: ['cat97858'], adult: ['cat97859', 'cat98089'] }; // fallbacks
      if (!select) return result;
      result.kids = []; result.adult = [];
      for (const opt of select.options) {
        const t = opt.text.toLowerCase();
        if (t.includes('kids') || t.includes('family')) result.kids.push(`cat${opt.value}`);
        else if (t.includes('adult') || t.includes('teen')) result.adult.push(`cat${opt.value}`);
      }
      return result;
    });

    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);

    function parseMkEvents($td, catClassList, category, eventDate) {
      catClassList.forEach(cls => {
        $td.find(`a.${cls}`).each((_, a) => {
          const text  = $(a).text().trim();
          const match = text.match(eventRe);
          if (!match) return;

          let title = match[3].replace(/\s*@\s*.+$/, '').trim();
          if (!title) return;

          const onclick  = $(a).attr('onclick') || '';
          const idMatch  = onclick.match(/epopup\('(\d+)'\)/);
          const eventUrl = idMatch
            ? `https://www.calendarwiz.com/calendars/popup.php?op=view&id=${idMatch[1]}&crd=mountkiscopubliclibrary`
            : '';

          events.push({ date: eventDate, time: `${match[1]} – ${match[2]}`, title, url: eventUrl, library: 'mount_kisco', category });
        });
      });
    }

    // CalendarWiz day cells have id="day_YYYYMMDD"
    $('td[id^="day_"]').each((_, td) => {
      const $td     = $(td);
      const dayId   = $td.attr('id') || '';
      const dateStr = dayId.replace('day_', '');
      if (dateStr.length !== 8) return;

      const eventDate = new Date(
        parseInt(dateStr.slice(0, 4)),
        parseInt(dateStr.slice(4, 6)) - 1,
        parseInt(dateStr.slice(6, 8))
      );
      if (isNaN(eventDate.getTime()) || eventDate < cutoff) return;

      parseMkEvents($td, catClasses.kids, 'kids', eventDate);
      parseMkEvents($td, catClasses.adult, 'adult', eventDate);
    });

  } catch (e) {
    console.log(`    [error] Mount Kisco: ${e.message}`);
  }

  return { events, playwrightMissing: false };
}


// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function generateHtml(allEvents, mountKiscoMissing) {
  // Deduplicate — if same event appears in both kids and adult fetch, mark as 'both'
  const eventMap = new Map();
  for (const e of allEvents) {
    const key = `${e.library}|${e.title}|${dateKey(e.date)}`;
    if (eventMap.has(key)) {
      const ex = eventMap.get(key);
      if (ex.category !== e.category) ex.category = 'both';
    } else {
      eventMap.set(key, { ...e });
    }
  }
  const unique = [...eventMap.values()];

  // Normalise all time strings before sorting
  for (const e of unique) e.time = normalizeTimeStr(e.time);

  // Sort by date → start time (numeric) → title
  unique.sort((a, b) => {
    const dc = dateKey(a.date).localeCompare(dateKey(b.date));
    if (dc !== 0) return dc;
    return parseStartMinutes(a.time) - parseStartMinutes(b.time);
  });

  // Group by date
  const groups = new Map();
  for (const e of unique) {
    const k = dateKey(e.date);
    if (!groups.has(k)) groups.set(k, { date: e.date, events: [] });
    groups.get(k).events.push(e);
  }

  // Build day sections
  let daysHtml = '';
  for (const { date: d, events } of [...groups.values()].sort((a,b) => dateKey(a.date).localeCompare(dateKey(b.date)))) {
    let cards = '';
    for (const e of events) {
      const lib      = LIBRARIES[e.library];
      const timeHtml = e.time ? `<span class="ev-time">${e.time}</span>` : '';
      const titleHtml = e.url
        ? `<a class="ev-title" href="${e.url}" target="_blank" rel="noopener">${e.title}</a>`
        : `<span class="ev-title">${e.title}</span>`;
      cards += `<div class="event" data-lib="${e.library}" data-cat="${e.category || 'kids'}">${timeHtml}${titleHtml}<span class="badge" style="--c:${lib.color}">${lib.name}</span></div>\n`;
    }
    daysHtml += `<section class="day"><h2 class="day-hdr">${formatDate(d)}</h2>${cards}</section>\n`;
  }

  // Legend — clickable filter buttons
  const legend = Object.entries(LIBRARIES)
    .map(([key, l]) =>
      `<button class="badge filter-btn" data-lib="${key}" style="--c:${l.color}">${l.name}</button>`
    ).join('');

  const warning = mountKiscoMissing
    ? `<div class="warn"><strong>Mount Kisco not shown</strong> — Playwright is not installed.
       To add it, open Terminal and run:<br>
       <code>npm install playwright &amp;&amp; npx playwright install chromium</code></div>`
    : '';

  const now   = new Date().toLocaleString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' });
  const total = unique.length;
  const empty = '<p class="empty">No upcoming events found. Try running the script again.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kids Library Calendar</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f0f2f5;
  color: #1a1a1a;
  min-height: 100vh;
}
header {
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
  padding: 18px 24px 14px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 1px 6px rgba(0,0,0,.07);
}
h1 { font-size: 1.55rem; font-weight: 800; letter-spacing: -.02em; margin-bottom: 4px; }
.meta { font-size: .82rem; color: #666; margin-bottom: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px; }
.warn {
  margin-top: 12px;
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: .83rem;
  line-height: 1.5;
}
.warn code {
  background: #f5f5f5;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: .82rem;
}
main {
  max-width: 740px;
  margin: 24px auto;
  padding: 0 16px 48px;
}
.day {
  background: #fff;
  border-radius: 12px;
  margin-bottom: 14px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
}
.day-hdr {
  font-size: .93rem;
  font-weight: 700;
  padding: 10px 16px;
  background: #f8f8f8;
  border-bottom: 1px solid #ececec;
  color: #333;
}
.event {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #f3f3f3;
  flex-wrap: wrap;
}
.event:last-child { border-bottom: none; }
.ev-time {
  font-size: .8rem;
  color: #555;
  white-space: nowrap;
  min-width: 140px;
  flex-shrink: 0;
}
.ev-title {
  flex: 1;
  font-size: .92rem;
  color: #1a1a1a;
  text-decoration: none;
}
a.ev-title:hover { text-decoration: underline; }
.badge {
  display: inline-block;
  font-size: .68rem;
  font-weight: 700;
  color: #fff;
  background: var(--c, #888);
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
  flex-shrink: 0;
}
.empty {
  text-align: center;
  color: #888;
  padding: 48px 16px;
  font-size: 1rem;
}
@media (max-width: 520px) {
  .ev-time { min-width: 0; width: 100%; }
}
.filter-btn {
  cursor: pointer;
  border: none;
  transition: opacity .15s;
}
.filter-btn.off {
  opacity: 0.3;
  text-decoration: line-through;
}
.cat-filter {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.cat-btn {
  font-size: .82rem;
  font-weight: 600;
  border: 2px solid #ccc;
  border-radius: 20px;
  padding: 4px 14px;
  background: none;
  cursor: pointer;
  color: #555;
  transition: background .15s, color .15s, border-color .15s;
}
.cat-btn.active { background: #1a1a1a; border-color: #1a1a1a; color: #fff; }
.filter-controls {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.ctrl-btn {
  font-size: .75rem;
  background: none;
  border: 1px solid #ccc;
  border-radius: 20px;
  padding: 3px 10px;
  cursor: pointer;
  color: #555;
}
.ctrl-btn:hover { background: #f0f0f0; }
.event.hidden { display: none; }
.day.hidden { display: none; }
@media (max-width: 640px) {
  header { padding: 12px 16px 10px; }
  h1 { font-size: 1.2rem; }
  .meta { font-size: .75rem; margin-bottom: 6px; }
  .cat-btn { padding: 5px 14px; min-height: 36px; }
  .filter-btn { padding: 5px 10px; min-height: 36px; }
  .ctrl-btn { padding: 4px 10px; min-height: 32px; }
  main { margin: 10px auto; padding: 0 10px 32px; }
  .day { margin-bottom: 10px; border-radius: 8px; }
  .day-hdr { padding: 8px 12px; font-size: .88rem; }
  .event { padding: 8px 12px; gap: 6px; }
  .ev-time { min-width: 0; width: 100%; }
  .badge { font-size: .65rem; }
}
</style>
</head>
<body>
<header>
  <h1>Kids Library Calendar</h1>
  <p class="meta">
    Last updated: ${now}
    &nbsp;·&nbsp; ${total} upcoming event${total !== 1 ? 's' : ''}
    &nbsp;·&nbsp; <em>Run the script again to refresh</em>
  </p>
  <div class="cat-filter">
    <button class="cat-btn active" data-cat="all">All events</button>
    <button class="cat-btn" data-cat="kids">Kids</button>
    <button class="cat-btn" data-cat="adult">Adults</button>
  </div>
  <div class="filter-controls">
    <button class="ctrl-btn" id="btn-all">Select all libraries</button>
    <button class="ctrl-btn" id="btn-none">Deselect all libraries</button>
  </div>
  <div class="legend">${legend}</div>
  ${warning}
</header>
<main>
  ${unique.length ? daysHtml : empty}
</main>
<script>
const filterBtns = document.querySelectorAll('.filter-btn');
let catMode = 'all';

function updateDays() {
  document.querySelectorAll('.day').forEach(day => {
    const anyVisible = [...day.querySelectorAll('.event')].some(e => !e.classList.contains('hidden'));
    day.classList.toggle('hidden', !anyVisible);
  });
}

function applyFilters() {
  document.querySelectorAll('.event').forEach(ev => {
    const libOff = document.querySelector('.filter-btn[data-lib="' + ev.dataset.lib + '"]')?.classList.contains('off');
    const cat    = ev.dataset.cat;
    const catOk  = catMode === 'all' || cat === catMode || cat === 'both';
    ev.classList.toggle('hidden', libOff || !catOk);
  });
  updateDays();
}

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('off');
    applyFilters();
  });
});

document.getElementById('btn-all').addEventListener('click', () => {
  filterBtns.forEach(b => b.classList.remove('off'));
  applyFilters();
});

document.getElementById('btn-none').addEventListener('click', () => {
  filterBtns.forEach(b => b.classList.add('off'));
  applyFilters();
});

document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    catMode = btn.dataset.cat;
    applyFilters();
  });
});
</script>
</body>
</html>`;
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const months    = getMonths(3);
  const allEvents = [];
  let   mountKiscoMissing = false;

  // These libraries all use the Drupal library_calendar platform with internal pagination
  const lcScrapers = [
    ['Katonah Village Library',              scrapeKatonah],
    ['Pound Ridge Library',                  scrapePoundRidge],
    ['Bedford Hills Free Library',           scrapeBedfordHills],
    ['Mount Pleasant Library (Pleasantville)', scrapeMountPleasant],
    ['Chappaqua Library',                    scrapeChappaqua],
    ['Larchmont Public Library',             scrapeLarchmont],
  ];
  for (const [name, scraper] of lcScrapers) {
    console.log(`Fetching ${name}...`);
    const evs = await scraper();
    allEvents.push(...evs);
    console.log(`  → ${evs.length} events`);
  }

  // Bedford Free and North Castle loop through months
  const monthScrapers = [
    ['Bedford Free Library',          scrapeBedfordFree],
    ['North Castle Library (Armonk)', scrapeNorthCastle],
  ];
  for (const [name, scraper] of monthScrapers) {
    console.log(`Fetching ${name}...`);
    let count = 0;
    for (const [year, month] of months) {
      const evs = await scraper(year, month);
      allEvents.push(...evs);
      count += evs.length;
      await sleep(400);
    }
    console.log(`  → ${count} events`);
  }

  console.log('Fetching Mount Kisco Public Library (headless browser)...');
  let mkCount = 0;
  for (const [year, month] of months) {
    const { events: mkEvs, playwrightMissing } = await scrapeMountKisco(year, month);
    if (playwrightMissing) {
      mountKiscoMissing = true;
      console.log('  → Playwright not installed; Mount Kisco skipped');
      console.log('     To enable: npm install playwright && npx playwright install chromium');
      break;
    }
    allEvents.push(...mkEvs);
    mkCount += mkEvs.length;
    await sleep(400);
  }
  if (!mountKiscoMissing) console.log(`  → ${mkCount} events`);

  console.log(`\nTotal events: ${allEvents.length}`);

  const outputPath = path.join(__dirname, 'calendar.html');
  fs.writeFileSync(outputPath, generateHtml(allEvents, mountKiscoMissing), 'utf8');
  console.log(`Calendar saved → ${outputPath}`);

  try {
    execSync(`open "${outputPath}"`);
  } catch (_) {}
}

main().catch(console.error);
