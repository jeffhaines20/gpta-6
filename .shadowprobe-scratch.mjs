import pkg from 'playwright'; const { chromium } = pkg;
import { ensureServer } from './tools/serve.mjs';
const OUT='/tmp/claude-0/-home-user-gpta-6/e685c1d8-3ea2-5d09-9506-7019c96af5cb/scratchpad';
await ensureServer();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport:{width:1600,height:900} });
page.on('pageerror', e=>console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil:'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, {timeout:120000});
await page.addStyleTag({ content:'#hud,#attr{display:none!important}' });
const cfg = { wpA:2, wpB:4, back:34, side:0, height:2.4, fov:55, tgtY:16, fwd:260 };
await page.evaluate((c)=>{
  const r = __district.district.meta.route; const a=r[c.wpA], b=r[c.wpB];
  const dx=b.x-a.x, dz=b.z-a.z, len=Math.hypot(dx,dz)||1;
  const nx=-dz/len, nz=dx/len;
  __district.placeAt(a.x,a.z); __district.setAutopilot(()=>{});
  __district.freeCam([a.x-(dx/len)*c.back+nx*c.side, c.height, a.z-(dz/len)*c.back+nz*c.side],
                     [a.x+(dx/len)*c.fwd, c.tgtY, a.z+(dz/len)*c.fwd], c.fov);
  for(let i=0;i<900;i++) __district.world.update(__district.vehicle.position);
}, cfg);
await page.waitForTimeout(14000);

async function shot(tag){ await page.waitForTimeout(6000); await page.screenshot({ path:`${OUT}/sp_${tag}.png`, timeout:180000 }); console.log('shot', tag); }

for (const tod of ['noon','dusk']) {
  await page.evaluate((t)=>__district.setTimeOfDay(t), tod);
  await page.waitForTimeout(15000);
  const info = await page.evaluate(()=>{
    const s=__district.tod.sun;
    return { castShadow:s.castShadow, mapSize:[s.shadow.mapSize.x,s.shadow.mapSize.y],
      hasMap: !!s.shadow.map, box:[s.shadow.camera.left,s.shadow.camera.right,s.shadow.camera.near,s.shadow.camera.far],
      proj00:+s.shadow.camera.projectionMatrix.elements[0].toFixed(6),
      shadowEnabled:__district.renderer.shadowMap.enabled, type:__district.renderer.shadowMap.type,
      autoUpdate:__district.renderer.shadowMap.autoUpdate,
      sunPos:[+s.position.x.toFixed(1),+s.position.y.toFixed(1),+s.position.z.toFixed(1)],
      tgt:[+s.target.position.x.toFixed(1),+s.target.position.y.toFixed(1),+s.target.position.z.toFixed(1)],
      intensity:s.intensity, bias:s.shadow.bias, normalBias:s.shadow.normalBias, radius:s.shadow.radius };
  });
  console.log(tod, 'A(as-shipped)', JSON.stringify(info));
  await shot(`${tod}_A_asshipped`);

  await page.evaluate(()=>{ __district.tod.sun.castShadow=false; });
  await shot(`${tod}_B_noshadow`);

  await page.evaluate(()=>{
    const s=__district.tod.sun; s.castShadow=true;
    Object.assign(s.shadow.camera,{left:-40,right:40,top:40,bottom:-40,near:1,far:900});
    s.shadow.camera.updateProjectionMatrix();
  });
  await shot(`${tod}_C_tight40`);

  await page.evaluate(()=>{
    const s=__district.tod.sun;
    Object.assign(s.shadow.camera,{left:-260,right:260,top:260,bottom:-260,near:1,far:900});
    s.shadow.camera.updateProjectionMatrix();
  });
}
await browser.close();
console.log('done');
