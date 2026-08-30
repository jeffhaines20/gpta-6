import pkg from 'playwright'; const { chromium } = pkg;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport:{width:700,height:460} });
page.on('pageerror', e=>console.log('PAGEERROR', e.message));
page.on('console', m=>console.log('console:', m.text()));
await page.goto('http://127.0.0.1:8199/index.html');
await page.waitForFunction('window.ready===true', null, {timeout:60000});
for (const [label, elev, azim, fix] of [
  ['NOON  as-written (no updateProjectionMatrix)', 1.32, 0.6, false],
  ['NOON  with updateProjectionMatrix()',          1.32, 0.6, true],
  ['DUSK  as-written',                             0.055, 2.72, false],
  ['DUSK  with updateProjectionMatrix()',          0.055, 2.72, true],
]) {
  const r = await page.evaluate(([e,a,f])=>window.run(e,a,f), [elev,azim,fix]);
  console.log(label, JSON.stringify({shadowSide:r.shadowSide, lightSide:r.lightSide, farGround:r.farGround, camL:r.camL, camFar:r.camFar, m00:r.proj[0], m22:r.proj[10], m32:r.proj[14]}));
  await page.screenshot({ path:`/tmp/claude-0/-home-user-gpta-6/e685c1d8-3ea2-5d09-9506-7019c96af5cb/scratchpad/st_${label.split(' ')[0]}_${fix?'fixed':'aswritten'}.png` });
}
await browser.close();
