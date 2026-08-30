import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
await page.goto('http://127.0.0.1:8123/labs/sky/_probe.html', { waitUntil: 'load', timeout: 60000 });
try { await page.waitForFunction(() => window.__probe && window.__probe.ready, { timeout: 120000 }); }
catch { console.log('TIMEOUT'); }
console.log(JSON.stringify(await page.evaluate(() => window.__probe), null, 1));
console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();
