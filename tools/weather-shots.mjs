// Nothing in tools/ has ever called setWeather.
//
// Constraint 3 makes rain and fog the district's entire weather offering, and
// every critique frame this project has produced - every hero shot, every blind
// critic round, every measurement in PROGRESS.md - was captured in clear weather.
// Two of the three authored states have never been photographed. That is the same
// sampling failure the ledger already documents twice, found a third time by
// asking what is actually IN the sample rather than what the code supports.
//
// So this captures the hero framings across all three states, and measures
// whether the rain reaches the frame at all rather than trusting report().
// weather.report() will happily say rainIntensity 0.9 with 12,000 live drops
// while the streaks render behind the camera, or at a luminance the tonemapper
// crushes - both of which are invisible, and neither of which the report knows.
//
// The measurement is a paired diff against clear, preceded by a NOISE FLOOR:
// the same untouched frame captured twice. Rain animates, so unlike the sun
// probes this floor will not be zero - it is the moving-drops baseline, and a
// state whose difference from clear does not clear it is not on screen.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TIMES = (process.env.WX_TIMES ?? 'dusk,night').split(',');
const STATES = (process.env.WX_STATES ?? 'clear,lightRain,heavyRain').split(',');
const TAG = process.env.WX_TAG ?? 'wx';
const WANT = (process.env.WX_SHOTS ?? 'corridor').split(',');

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
// Traffic and pedestrians would move between paired captures and be scored as
// rain. The drops are the only thing allowed to move.
await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
function stats(file) {
  const img = readPNG(file), W = img.width, H = img.height, c = img.channels;
  let s = 0, n = 0;
  const px = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = lum(img.data, (y * W + x) * c);
    px[y * W + x] = v; s += v; n++;
  }
  return { mean: s / n, px, W, H };
}
// Mean absolute difference: rain adds bright streaks AND darkens through
// overcast, so a signed mean would let the two cancel and report nothing.
function mad(a, b) {
  let s = 0;
  for (let i = 0; i < a.px.length; i++) s += Math.abs(a.px[i] - b.px[i]);
  return s / a.px.length;
}

const results = [];
for (const name of WANT) {
  const cfg = SHOTS[name];
  if (!cfg) throw new Error(`unknown shot: ${name}`);
  console.log(describe(name, await page.evaluate(placeCamera, cfg)));
  await page.waitForTimeout(12000);

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.evaluate(() => __district.setWeather('clear', { immediate: true }));
    await page.waitForTimeout(9000);

    // Floor: clear weather, twice, nothing touched. Anything a rain state scores
    // below this is indistinguishable from the frame's own jitter.
    const f1 = `${OUT}/${TAG}-${name}-${tod}-floor-a.png`;
    await page.screenshot({ path: f1, timeout: 180000 });
    await page.waitForTimeout(1500);
    const f2 = `${OUT}/${TAG}-${name}-${tod}-floor-b.png`;
    await page.screenshot({ path: f2, timeout: 180000 });
    const A = stats(f1), B = stats(f2);
    const floor = mad(A, B);
    fs.rmSync(f2, { force: true });
    console.log(`\n${name}/${tod}: noise floor (clear twice) ${floor.toFixed(3)}`);

    for (const st of STATES) {
      await page.evaluate((s) => __district.setWeather(s, { immediate: true }), st);
      await page.waitForTimeout(9000);
      const file = `${OUT}/${TAG}-${name}-${tod}-${st}.png`;
      await page.screenshot({ path: file, timeout: 180000 });
      const S = stats(file);
      const delta = mad(A, S);
      const wx = await page.evaluate(() => __district.weather.report());
      const visible = delta > floor * 3;
      results.push({ shot: name, tod, state: st, file, floor: +floor.toFixed(3),
        delta: +delta.toFixed(3), meanLuminance: +S.mean.toFixed(1), visible, weather: wx });
      console.log(`  ${st.padEnd(10)} delta vs clear ${delta.toFixed(3).padStart(7)}  ` +
        `mean ${S.mean.toFixed(1).padStart(5)}  ` +
        `rain ${String(wx.rainIntensity).padStart(5)} wet ${String(wx.wetness).padStart(5)} ` +
        `overcast ${String(wx.overcast).padStart(5)} drops ${String(wx.liveDrops).padStart(6)} ` +
        `splashes ${String(wx.liveSplashes).padStart(5)} +${wx.drawCalls} draws` +
        (st === 'clear' ? '' : visible ? '' : '   <- NOT DISTINGUISHABLE FROM CLEAR'));
    }
    fs.rmSync(f1, { force: true });
  }
}
fs.writeFileSync(`docs/${TAG}-report.json`, JSON.stringify({ results, errors }, null, 1));
console.log(`\nwrote docs/${TAG}-report.json (${results.length} captures)`);
if (errors.length) console.log(`page errors: ${errors.length}`);
await browser.close();
