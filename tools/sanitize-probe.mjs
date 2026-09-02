// Is the white rectangle the NaN/Inf guard?
//
// Four independent critic sightings found a hard-edged, flat, achromatic white
// rectangle at roughly (193-290, 349-400) on the corridor tower, present at golden
// hour and absent at the same pixels at dusk and night. None could attribute it,
// and all said so. The recorded hypothesis: sanitize() in src/post.js maps every
// non-finite channel to CEIL = 60000, far above the ACES shoulder, so a half-float
// overflow that used to render as a BLACK hole now renders as a WHITE block. The
// guard is an improvement - a blown highlight is physically white and a hole is
// not - but it would make the overflow the brightest object in the frame.
//
// The test: paint every pixel the guard catches an unmistakable green
// (postParams().debugSanitize) and re-capture the same frame. If the rectangle
// turns green the hypothesis is confirmed and the fix belongs upstream at the
// overflow. If it stays white the hypothesis is dead.
//
// Both frames are captured in ONE page session at the same camera and the same
// time of day, so the only difference between them is the uniform.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
const TIME = process.env.SP_TIME ?? 'golden';
// The box the critics reported, on the 1600x900 corridor hero frame.
const BOX = (process.env.SP_BOX ?? '193,349,290,400').split(',').map(Number);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TIME);

// The corridor hero camera, copied from tools/hero-shots.mjs so the frame is the
// one the critics were looking at rather than a new view of the same street.
await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam(
    [a.x - (dx / len) * 34, 2.4, a.z - (dz / len) * 34],
    [a.x + (dx / len) * 260, 16, a.z + (dz / len) * 260], 55,
  );
});
await page.waitForTimeout(Number(process.env.SP_SETTLE ?? 20000));

const shot = async (tag, debug) => {
  await page.evaluate((d) => { __district.postParams().debugSanitize = d; }, debug);
  await page.waitForTimeout(1200);
  const file = `${OUT}/sanitize-${tag}-${TIME}.png`;
  await page.screenshot({ path: file });
  return file;
};

const before = await shot('off', false);
const after = await shot('on', true);

// How much of the reported box is the debug green, and how much is near-white?
const stat = (file) => {
  const img = readPNG(file);
  const { width: w, channels: c, data } = img;
  const [x0, y0, x1, y1] = BOX;
  let green = 0, white = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * c;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      n++;
      if (g > 120 && g > r * 1.6 && g > b * 1.6) green++;
      if (r > 235 && g > 235 && b > 235) white++;
    }
  }
  return { n, green: +(green / n).toFixed(3), white: +(white / n).toFixed(3) };
};

// A whole-frame count too: if the guard fires ONLY inside the reported box, that
// is a much stronger result than "green appeared somewhere".
const frameGreen = (file) => {
  const img = readPNG(file);
  const { width: w, height: h, channels: c, data } = img;
  let green = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, sx = 0, sy = 0;
  // Column and row histograms as well as a bounding box: the guard could be
  // firing on one compact blob or scattered over the whole frame, and those are
  // different defects with different fixes.
  const colHist = new Int32Array(w), rowHist = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (!(g > 120 && g > r * 1.6 && g > b * 1.6)) continue;
      green++; sx += x; sy += y;
      colHist[x]++; rowHist[y]++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!green) return { greenPx: 0, frac: 0 };
  // Densest 64-px band, so a scattered halo does not read as a blob.
  let bestC = 0, bestCx = 0;
  for (let x = 0; x + 64 < w; x += 8) { let s = 0; for (let k = 0; k < 64; k++) s += colHist[x + k]; if (s > bestC) { bestC = s; bestCx = x; } }
  return {
    greenPx: green, frac: +(green / (w * h)).toFixed(5),
    bbox: [x0, y0, x1, y1],
    centroid: [Math.round(sx / green), Math.round(sy / green)],
    densestColBand: [bestCx, bestCx + 64], inThatBand: +(bestC / green).toFixed(2),
  };
};

const a = stat(before), b = stat(after);
const fa = frameGreen(before), fb = frameGreen(after);
const result = {
  time: TIME, box: BOX, boxPixels: a.n,
  guardOff: { ...a, frame: fa },
  guardOn: { ...b, frame: fb },
  verdict: b.green > 0.2 ? 'CONFIRMED - the guard is painting that box'
    : (a.white > 0.05
      ? `REFUTED for this box - it is ${(a.white * 100).toFixed(0)}% white and 0% of it is the guard`
      : 'MOOT - the box is no longer white in this build'),
  guardFiresElsewhere: fb.greenPx > 0,
  pageErrors: errors,
};
fs.writeFileSync('docs/sanitize-probe.json', JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
await browser.close();
