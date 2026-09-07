// How long does the district take to reach its first rendered frames, and what
// does the texture library cost inside that?
//
// hero-shots.mjs waits 60 s for `frames > 5` and started timing out after the
// trim emissive atlas grew. That is either a real regression in startup or a
// loaded box, and the two have opposite responses, so it is measured rather than
// retried: this reports wall-clock to first frames AND the per-texture breakdown
// the loader already computes, so the atlas can be priced against the rest.
//
//   LT_PORT=8613 node tools/load-time.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const PORT = Number(process.env.LT_PORT ?? 8613);
const BUDGET = Number(process.env.LT_TIMEOUT ?? 300000);

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'domcontentloaded' });
const tDom = Date.now() - t0;
await page.waitForFunction('window.__district', null, { timeout: BUDGET, polling: 200 });
const tReady = Date.now() - t0;
await page.waitForFunction('window.__district.frames > 5', null, { timeout: BUDGET, polling: 200 });
const tFrames = Date.now() - t0;
const rep = await page.evaluate(() => __district.loadReport());
console.log(`dom ${tDom} ms   __district ${tReady} ms   frames>5 ${tFrames} ms`);
console.log(JSON.stringify(rep, null, 1));
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await browser.close();
