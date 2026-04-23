'use strict';

const express    = require('express');
const cron       = require('node-cron');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const app      = express();
const PORT     = process.env.PORT || 3000;
const CALENDAR = path.join(__dirname, 'calendar.html');

app.get('/', (req, res) => {
  if (fs.existsSync(CALENDAR)) {
    res.sendFile(CALENDAR);
  } else {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kids Library Calendar</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
  .box { text-align: center; background: #fff; padding: 40px 48px;
         border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h2 { font-size: 1.4rem; margin-bottom: 10px; }
  p  { color: #666; font-size: .95rem; }
</style>
</head>
<body>
<div class="box">
  <h2>Calendar is being generated…</h2>
  <p>This takes about 30 seconds. The page will refresh automatically.</p>
</div>
<script>setTimeout(() => location.reload(), 30000);</script>
</body></html>`);
  }
});

function runScraper() {
  console.log('[' + new Date().toISOString() + '] Generating calendar...');
  const child = spawn('node', ['fetch_calendars.js'], { cwd: __dirname, stdio: 'inherit' });
  child.on('exit', code => {
    console.log('[' + new Date().toISOString() + '] Done (exit code: ' + code + ')');
  });
}

// Generate on startup so the calendar is ready as soon as the server boots
runScraper();

// Regenerate daily at noon UTC (7–8am Eastern depending on DST)
cron.schedule('0 12 * * *', runScraper);

app.listen(PORT, () => console.log('Library Calendar server running on port ' + PORT));
