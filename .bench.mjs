import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const p = await b.newPage();
await p.goto('http://127.0.0.1:8123/.bench.html', {waitUntil:'load'});
await p.waitForFunction(() => window.__bench, {timeout: 120000});
console.log((await p.evaluate(()=>window.__bench)).join('\n'));
await b.close();
