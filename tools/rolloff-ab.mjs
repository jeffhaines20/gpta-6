// The highlight rolloff, as a two-arm A/B inside ONE page session.
//
// The question this answers is not "is the frame better" - it is the narrower
// one the round was given: does a curve that pulls the top of the range back
// from the ceiling also dull the things that are SUPPOSED to be at the top of
// the range - the sun disc, lamp lenses at night, lit windows, headlights and
// the sky. A frame average cannot answer that, because those objects are a
// fraction of a percent of the frame. So this finds them as connected regions on
// the ARM WITH THE ROLLOFF OFF and then reports the same PIXEL SET in both arms:
// a curve that moved a region out of the top decile would otherwise re-sort the
// population and measure a different object.
//
// One session, one streaming settle, one camera, uniforms swapped between arms,
// and the arms are asserted distinct before anything is read off them - this
// project has already had one A/B whose two arms were secretly identical.
//
//   node tools/rolloff-ab.mjs                       # golden, corridor camera
//   RA_TIME=night node tools/rolloff-ab.mjs
//   RA_TIME=golden RA_CAM=sun node tools/rolloff-ab.mjs
//
// Output: docs/rolloff-ab-<time>-<cam>.json, docs/shots/ra-{off,on}-<time>-<cam>.png
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const TIME = process.env.RA_TIME ?? 'golden';
const CAM = process.env.RA_CAM ?? 'corridor';
const SETTLE = Number(process.env.RA_SETTLE ?? 20000);
const BOX = (process.env.RA_BOX ?? '110,320,320,410').split(',').map(Number);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TIME);
await page.evaluate((cam) => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  __district.placeAt(a.x - (dx / len) * 16, a.z - (dz / len) * 16);
  __district.setAutopilot(() => {});
  const eye = [a.x - (dx / len) * 16, 2.4, a.z - (dz / len) * 16];
  let tgt = [a.x + (dx / len) * 260, 16, a.z + (dz / len) * 260];
  if (cam === 'sun') {
    // Straight at the disc, wherever daynight put it. sunDirection points TOWARD
    // the sun (post.js uses it as the inscatter lobe's axis), so the target is
    // the eye plus that direction.
    const d = __district.postParams().sunDirection;
    tgt = [eye[0] + d.x * 400, eye[1] + d.y * 400, eye[2] + d.z * 400];
  }
  __district.freeCam(eye, tgt, 55);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
}, CAM);
await page.waitForTimeout(SETTLE);

const arm = async (tag, knee, ceil) => {
  const set = await page.evaluate(([k, c]) => {
    const p = __district.postParams();
    p.highlightKnee = k; p.highlightCeil = c;
    return { knee: p.highlightKnee, ceil: p.highlightCeil };
  }, [knee, ceil]);
  await page.waitForTimeout(1200);
  const file = `docs/shots/ra-${tag}-${TIME}-${CAM}.png`;
  await page.screenshot({ path: file });
  return { tag, file, set };
};

// Arm A disables the curve (ceil <= knee is the documented identity case), arm B
// is whatever the build ships.
const shipped = await page.evaluate(() => {
  const p = __district.postParams();
  return { knee: p.highlightKnee, ceil: p.highlightCeil };
});
const off = await arm('off', shipped.knee, 0);
const on = await arm('on', shipped.knee, shipped.ceil);

const A = readPNG(off.file), B = readPNG(on.file);
const { width: W, height: H, channels: C } = A;
const lum = (img, p) => 0.2126 * img.data[p * img.channels] + 0.7152 * img.data[p * img.channels + 1]
  + 0.0722 * img.data[p * img.channels + 2];

// The arms must differ, or the switch never took.
let diff = 0, maxDiff = 0;
for (let p = 0; p < W * H; p++) {
  const d = Math.abs(lum(A, p) - lum(B, p));
  if (d > 0.5) diff++;
  if (d > maxDiff) maxDiff = d;
}

function frameStat(img) {
  const hist = new Uint32Array(256);
  let sum = 0, clip = 0, dark = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * img.channels;
    const L = lum(img, p);
    hist[Math.round(L)]++; sum += L;
    if (img.data[i] === 255 && img.data[i + 1] === 255 && img.data[i + 2] === 255) clip++;
    if (L < 16) dark++;
  }
  const q = (f) => { let a = 0; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= f * W * H) return i; } return 255; };
  return { mean: +(sum / (W * H)).toFixed(2), p50: q(0.5), p95: q(0.95), p99: q(0.99),
    clip255: clip, darkPct: +(100 * dark / (W * H)).toFixed(2) };
}

// Connected regions above a threshold, found ON ARM A.
function regions(img, thresh, minN) {
  const seen = new Uint8Array(W * H); const out = []; const st = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || lum(img, s) < thresh) continue;
    const g = { px: [], x0: W, y0: H, x1: 0, y1: 0 };
    st.length = 0; st.push(s); seen[s] = 1;
    while (st.length) {
      const p = st.pop(); const x = p % W, y = (p / W) | 0;
      g.px.push(p);
      if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x;
      if (y < g.y0) g.y0 = y; if (y > g.y1) g.y1 = y;
      const nb = [];
      if (x > 0) nb.push(p - 1); if (x < W - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - W); if (y < H - 1) nb.push(p + W);
      for (const q of nb) if (!seen[q] && lum(img, q) >= thresh) { seen[q] = 1; st.push(q); }
    }
    if (g.px.length >= minN) out.push(g);
  }
  out.sort((a, b) => b.px.length - a.px.length);
  return out.slice(0, 10);
}

const stat = (img, px) => {
  let sum = 0, pk = 0;
  for (const p of px) { const L = lum(img, p); sum += L; if (L > pk) pk = L; }
  return { mean: +(sum / px.length).toFixed(1), peak: +pk.toFixed(1) };
};

const thresh = Number(process.env.RA_THRESH ?? 200);
const regs = regions(A, thresh, 20).map((g) => ({
  n: g.px.length, box: [g.x0, g.y0, g.x1, g.y1], w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1,
  off: stat(A, g.px), on: stat(B, g.px),
}));

const boxStat = (img) => {
  const [x0, y0, x1, y1] = BOX;
  let white = 0, ge245 = 0, ge240 = 0, n = 0, sum = 0, hard = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * img.channels; const p = y * W + x;
    const L = lum(img, p);
    n++; sum += L;
    if (img.data[i] > 250 && img.data[i + 1] > 250 && img.data[i + 2] > 250) white++;
    if (L >= 245) ge245++; if (L >= 240) ge240++;
  }
  for (let x = x0; x <= x1; x++) {
    let prev = null, stepped = false;
    for (let y = y0; y <= y1; y++) {
      const L = lum(img, y * W + x);
      if (prev !== null && prev < 200 && L > 250) stepped = true;
      prev = L;
    }
    if (stepped) hard++;
  }
  return { whiteFrac: +(white / n).toFixed(4), ge245: +(ge245 / n).toFixed(4),
    ge240: +(ge240 / n).toFixed(4), meanLuma: +(sum / n).toFixed(1), hardStepCols: hard };
};

const out = {
  time: TIME, cam: CAM, shipped, arms: { off: off.set, on: on.set },
  armsDistinct: { pixelsDiffering: diff, maxDelta: +maxDiff.toFixed(1),
    verdict: diff > 0 ? 'DISTINCT' : 'IDENTICAL - the switch did not take' },
  frame: { off: frameStat(A), on: frameStat(B) },
  box: BOX, boxOff: boxStat(A), boxOn: boxStat(B),
  brightRegions: regs, files: [off.file, on.file], pageErrors: errors,
};
fs.writeFileSync(`docs/rolloff-ab-${TIME}-${CAM}.json`, JSON.stringify(out, null, 1));
console.log(`arms ${JSON.stringify(out.arms)}  ${out.armsDistinct.verdict} (${diff} px differ, max ${out.armsDistinct.maxDelta})`);
console.log('frame off', JSON.stringify(out.frame.off));
console.log('frame on ', JSON.stringify(out.frame.on));
console.log('box   off', JSON.stringify(out.boxOff));
console.log('box   on ', JSON.stringify(out.boxOn));
console.log(`brightest regions on the OFF arm (>= ${thresh} luma), same pixel set in both:`);
for (const g of regs) {
  console.log(`  n=${String(g.n).padStart(6)} ${String(g.w).padStart(4)}x${String(g.h).padEnd(4)} @[${g.box[0]},${g.box[1]}]` +
    `  off mean ${String(g.off.mean).padStart(5)} peak ${String(g.off.peak).padStart(5)}` +
    `  ->  on mean ${String(g.on.mean).padStart(5)} peak ${String(g.on.peak).padStart(5)}`);
}
console.log('wrote', `docs/rolloff-ab-${TIME}-${CAM}.json`);
await browser.close();
