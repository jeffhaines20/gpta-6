import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const p = await b.newPage();
p.on('pageerror', e=>console.log('PAGEERROR', e.message));
await p.goto('http://127.0.0.1:8123/labs/materials/', {waitUntil:'load'});
await p.waitForFunction(() => window.__lab && window.__lab.ready, {timeout: 120000});
const r = await p.evaluate(()=>({prof: window.__matProf, t: window.__lab.report.timingsMs, gen: window.__lab.report.generationMs}));
console.log(JSON.stringify(r, null, 1));
await b.close();
