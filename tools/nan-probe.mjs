// Where the non-finite values are in the post chain, pass by pass, frame-wide.
//
// tools/whitebox-repeat.mjs read the post targets back inside the whitebox box
// and found something nobody has looked at: the BLOOM target carries non-finite
// values. Over that box, at golden, every capture: HDR 2,744 non-finite of
// 19,201, the bright pass 2 of 4,876, blurA 542 and blurB 1,251. The composite
// then hands blurB to sanitize(), which turns each of those into the 60,000-nit
// ceiling, multiplies by bloomStrength and ADDS it to the scene - a flat,
// hard-edged, additive block that owes nothing to the geometry underneath it.
// That is the shape four critic sightings have described and none could
// attribute.
//
// This reads every target FRAME-WIDE and reports, per pass: how many channels
// are Inf, how many NaN, where they are (bounding box and a coarse map), and
// what the composite would add for them. Two seed texels in the bright pass and
// four blur passes at +-3.2 and +-6.5 texels is a blob of roughly 20x20 half-res
// texels, so the arithmetic of "2 becomes 1,251" is checkable rather than
// asserted.
//
//   node tools/nan-probe.mjs
//   NP_TIME=noon node tools/nan-probe.mjs
//
// Output: docs/nan-probe-<time>.json and docs/shots/nan-<time>.png
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const TIME = process.env.NP_TIME ?? 'golden';
const SETTLE = Number(process.env.NP_SETTLE ?? 20000);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TIME);
await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  __district.placeAt(a.x - (dx / len) * 16, a.z - (dz / len) * 16);
  __district.setAutopilot(() => {});
  __district.freeCam([a.x - (dx / len) * 16, 2.4, a.z - (dz / len) * 16],
    [a.x + (dx / len) * 260, 16, a.z + (dz / len) * 260], 55);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
});
await page.waitForTimeout(SETTLE);

const result = await page.evaluate(async () => {
  const THREE = await import('/vendor/three.module.min.js');
  const d = __district, r = d.renderer, p = d.post;

  const half = (v) => {
    const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
    if (e === 0) return s * f * 5.9604644775390625e-8;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };

  const scan = (name, rt) => {
    if (!rt) return { name, missing: true };
    const w = rt.width, h = rt.height;
    const isHalf = rt.texture.type === THREE.HalfFloatType;
    const isByte = rt.texture.type === THREE.UnsignedByteType;
    const buf = isByte ? new Uint8Array(w * h * 4)
      : isHalf ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
    try { r.readRenderTargetPixels(rt, 0, 0, w, h, buf); }
    catch (e) { return { name, error: e.message }; }
    const dec = isHalf ? half : (v) => v;
    let nan = 0, inf = 0, ceil = 0, mx = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    // Coarse 20x12 occupancy map of the non-finite pixels, in target texels.
    const GX = 20, GY = 12;
    const grid = new Array(GX * GY).fill(0);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        const a = dec(buf[i]), b = dec(buf[i + 1]), c = dec(buf[i + 2]);
        const bad = Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c);
        const big = !bad && (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c));
        const m = Math.max(a, b, c);
        if (Number.isFinite(m)) { if (m > mx) mx = m; if (m > 60000) ceil++; }
        if (bad) nan++; if (big) inf++;
        if (bad || big) {
          // readRenderTargetPixels is bottom-up; report in screen coordinates.
          const sy = h - 1 - py;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
          grid[Math.min(GY - 1, (sy * GY / h) | 0) * GX + Math.min(GX - 1, (px * GX / w) | 0)]++;
        }
      }
    }
    return { name, w, h, type: isByte ? 'byte' : isHalf ? 'half' : 'float',
      nan, inf, nonFinite: nan + inf, gtCeil: ceil, finiteMax: Math.round(mx),
      box: x1 < 0 ? null : [x0, y0, x1, y1],
      // Same box scaled to the 1600x900 frame, so it can be compared with the
      // boxes the reviewers and the whitebox probe quote.
      screenBox: x1 < 0 ? null : [Math.round(x0 * 1600 / w), Math.round(y0 * 900 / h),
        Math.round(x1 * 1600 / w), Math.round(y1 * 900 / h)],
      grid };
  };

  const out = {
    exposure: d.postParams().exposure,
    bloomStrength: d.postParams().bloomStrength,
    aa: d.aaState(),
    passes: [scan('hdr', p.hdr), scan('bright', p.brightRT), scan('blurA', p.blurA),
      scan('blurB', p.blurB), scan('ao', p.aoRT), scan('aoBlur', p.aoBlurRT)],
  };
  // What one non-finite bloom texel is worth on the display, through the chain
  // the composite actually runs: sanitize -> * bloomStrength -> + scene -> ...
  const e = out.exposure, S = 60000 * out.bloomStrength * e;
  out.oneNanBloomPixel = {
    nitsAdded: Math.round(60000 * out.bloomStrength),
    exposedAdded: +S.toFixed(3),
  };
  return out;
});

const file = `docs/nan-probe-${TIME}.json`;
fs.writeFileSync(file, JSON.stringify({ time: TIME, ...result, pageErrors: errors }, null, 1));
await page.screenshot({ path: `docs/shots/nan-${TIME}.png` });
for (const p of result.passes) {
  if (p.missing || p.error) { console.log(p.name, p.error ?? 'missing'); continue; }
  console.log(`${p.name.padEnd(7)} ${p.w}x${p.h} ${p.type.padEnd(5)} NaN ${String(p.nan).padStart(6)}  Inf ${String(p.inf).padStart(6)}` +
    `  >ceil ${String(p.gtCeil).padStart(6)}  finiteMax ${String(p.finiteMax).padStart(8)}  box ${JSON.stringify(p.screenBox)}`);
}
console.log('one non-finite bloom texel adds', JSON.stringify(result.oneNanBloomPixel));
console.log('wrote', file);
await browser.close();
