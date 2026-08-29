import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const p = await b.newPage({viewport:{width:900,height:600}});
p.on('pageerror', e=>console.log('PAGEERROR', e.message));
p.on('console', m=>{ if(m.type()!=='log') console.log(m.type().toUpperCase(), m.text()); });
await p.goto('http://127.0.0.1:8123/labs/materials/', {waitUntil:'load'});
await p.waitForFunction(() => window.__lab && window.__lab.ready, {timeout: 90000});
await p.waitForTimeout(3000);
const st = await p.evaluate(()=>{const s=window.__lab.stats; delete s.keys; return s;});
console.log(JSON.stringify({env:st.env,envIntensity:st.envIntensity,bg:st.bg,floatRT:st.floatRT,halfFloatLinear:st.halfFloatLinear}, null, 1));
await b.close();
