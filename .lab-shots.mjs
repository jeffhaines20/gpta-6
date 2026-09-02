import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url()));
await page.goto('http://127.0.0.1:8123/labs/materials/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__lab && window.__lab.ready, { timeout: 90000 });
const shots = [
  ['grid', 'dusk', '/home/user/gpta-6/docs/shots/lab-materials.png'],
  ['grid', 'noon', '/home/user/gpta-6/docs/shots/lab-materials-noon.png'],
  ['grid', 'night', '/home/user/gpta-6/docs/shots/lab-materials-night.png'],
  ['road', 'dusk', '/home/user/gpta-6/docs/shots/lab-materials-street.png'],
  ['atlas', 'dusk', '/home/user/gpta-6/docs/shots/lab-materials-atlas.png'],
];
for (const [view, tod, out] of shots) {
  await page.evaluate(([v, t]) => { window.__lab.setView(v); window.__lab.setTod(t); }, [view, tod]);
  await page.waitForTimeout(14000);
  await page.screenshot({ path: out });
  const st = await page.evaluate(() => window.__lab.stats);
  console.log(`${view}/${tod}: draw=${st.drawCalls} tris=${st.triangles} progs=${st.programs} implausible=${JSON.stringify(st.audit.implausible)}`);
}
console.log('report:', JSON.stringify(await page.evaluate(() => {
  const r = { ...window.__lab.report }; delete r.keys; return r; })));
console.log('ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();
