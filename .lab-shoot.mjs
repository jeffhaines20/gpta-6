import { chromium } from 'playwright';

const OUT = process.argv[2] || '/home/user/gpta-6/docs/shots/lab-materials.png';
const WAIT = Number(process.argv[3] || 30000);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto('http://127.0.0.1:8123/labs/materials/', { waitUntil: 'load', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__lab && window.__lab.ready, { timeout: WAIT });
} catch (e) {
  console.log('READY TIMEOUT');
}
await page.waitForTimeout(WAIT);

const stats = await page.evaluate(() => (window.__lab ? window.__lab.stats : null));
console.log(JSON.stringify(stats, null, 1));
console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await page.screenshot({ path: OUT });
console.log('shot ->', OUT);
await browser.close();
