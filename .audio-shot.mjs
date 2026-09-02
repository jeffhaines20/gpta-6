import { chromium } from 'playwright';

const OUT = process.argv[2] || '/home/user/gpta-6/docs/shots/lab-audio.png';
const WAIT = Number(process.argv[3] || 24000);
const PRESET = process.argv[4] || 'engine';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('requestfailed', (r) => {
  const u = r.url();
  if (/favicon/.test(u)) return;
  errors.push('REQFAIL: ' + u + ' ' + (r.failure()?.errorText || ''));
});

await page.goto('http://127.0.0.1:8123/labs/audio/', { waitUntil: 'load', timeout: 60000 });
try { await page.waitForFunction(() => window.__lab && window.__lab.ready, { timeout: 30000 }); }
catch (e) { console.log('READY TIMEOUT'); }

// A real click: the module's resume() is gated on a user gesture exactly as a
// browser requires, so the harness has to provide one rather than work around it.
await page.mouse.click(900, 520);
await page.waitForTimeout(1500);

if (PRESET === 'pursuit') {
  await page.evaluate(async () => {
    window.__lab.set('s-rpm', 5200);
    window.__lab.set('s-thr', 90);
    window.__lab.set('s-spd', 128);
    window.__lab.set('s-slip', 92);
    window.__lab.set('s-rain', 70);
    window.__lab.set('b-night');
    window.__lab.set('b-sir-fleet');
    await window.__lab.ensureFleet();
  });
} else if (PRESET === 'stinger') {
  await page.evaluate(() => {
    window.__lab.set('s-rpm', 1400);
    window.__lab.set('s-thr', 10);
    window.__lab.set('s-spd', 20);
    setInterval(() => window.__lab.audio.stinger('success'), 2600);
  });
}
await page.waitForTimeout(WAIT);

const stats = await page.evaluate(() => window.__lab.stats);
const resumed = await page.evaluate(() => window.__lab.resumed);
console.log('resumed:', resumed);
console.log(JSON.stringify(stats, null, 1));
console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await page.screenshot({ path: OUT, timeout: 60000 });
console.log('shot ->', OUT);
await browser.close();
