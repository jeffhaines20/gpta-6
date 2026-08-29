// Deliberate illustrative capture. The drive-through's own end-of-run screenshot
// lands wherever the route happens to stop, which is not a usable frame.
import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

await page.evaluate(() => {
  __district.setTraffic(true);
  __district.setTimeOfDay('dusk');
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];                     // along the Marlin Street corridor
  __district.placeAt(a.x, a.z, Math.atan2(b.x - a.x, b.z - a.z));
  __district.setTimeScale(8);
  // Cruise gently down the corridor so the chase camera settles behind the car.
  __district.setAutopilot(() => {
    __district.vehicle.setControls({ throttle: 0.5, brake: 0, steer: 0, handbrake: false });
  });
});
await page.waitForTimeout(22000);
await page.evaluate(() => { __district.setTimeScale(1); __district.setAutopilot(() => {
  __district.vehicle.setControls({ throttle: 0, brake: 1, steer: 0 }); }); });
await page.waitForTimeout(12000);
console.log(JSON.stringify(await page.evaluate(() => ({
  ...__district.worldReport(), ...__district.renderStats(), traffic: __district.trafficReport().alive,
}))));
await page.screenshot({ path: 'docs/shots/district-drive-traffic.png', timeout: 120000 });
await browser.close();
