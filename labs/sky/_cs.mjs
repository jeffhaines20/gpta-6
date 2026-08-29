import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const p = await b.newPage();
p.on('pageerror', e=>console.log('PAGEERROR', e.message));
p.on('console', m=>console.log('CONSOLE', m.type(), m.text()));
await p.goto('http://127.0.0.1:8123/labs/sky/_cs.html', {waitUntil:'load'});
await p.waitForFunction(()=>window.__out, {timeout:60000});
console.log(JSON.stringify(await p.evaluate(()=>window.__out)));
await b.close();
