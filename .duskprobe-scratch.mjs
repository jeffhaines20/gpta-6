import pkg from 'playwright'; const { chromium } = pkg;
import { ensureServer } from './tools/serve.mjs';
const OUT='/tmp/claude-0/-home-user-gpta-6/e685c1d8-3ea2-5d09-9506-7019c96af5cb/scratchpad';
await ensureServer();
const browser = await chromium.launch({
  executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
page.on('pageerror', e=>console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil:'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, {timeout:120000});
await page.addStyleTag({ content:'#hud,#attr{display:none!important}' });
const cfg = { wpA:2, wpB:4, back:34, side:0, height:2.4, fov:55, tgtY:16, fwd:260 };
await page.evaluate((c)=>{
  const r=__district.district.meta.route, a=r[c.wpA], b=r[c.wpB];
  const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz)||1, nx=-dz/len, nz=dx/len;
  __district.placeAt(a.x,a.z); __district.setAutopilot(()=>{});
  __district.freeCam([a.x-(dx/len)*c.back+nx*c.side,c.height,a.z-(dz/len)*c.back+nz*c.side],
                     [a.x+(dx/len)*c.fwd,c.tgtY,a.z+(dz/len)*c.fwd], c.fov);
  for(let i=0;i<900;i++) __district.world.update(__district.vehicle.position);
}, cfg);
await page.waitForTimeout(14000);
await page.evaluate(()=>__district.setTimeOfDay('dusk'));
await page.waitForTimeout(15000);

const variants = [
  ['E0','shipped elevation 0.055', 0.055, null, null],
  ['E1','elevation 0.14 (8.0 deg)', 0.14, null, null],
  ['E2','elevation 0.20 (11.5 deg)', 0.20, null, null],
  ['E3','elevation 0.20 + sunLux 4200 / skyLux 700', 0.20, 4200, 700],
];
for (const [tag, label, elev, sunLux, skyLux] of variants) {
  await page.evaluate(([e,s,k])=>{
    const t=__district.tod; t.preset.elevation=e;
    if(s!==null){ t.preset.sunLux=s; t.sun.intensity=s; }
    if(k!==null){ t.preset.skyLux=k; t.hemi.intensity=k; }
  }, [elev, sunLux, skyLux]);
  await page.waitForTimeout(6000);
  await page.screenshot({ path:`${OUT}/dp_${tag}.png`, timeout:180000 });
  console.log('shot', tag, label);
}
await browser.close(); console.log('done');
