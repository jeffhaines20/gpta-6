// IS THE ELLIPSE ACTUALLY ON A TYRE?
//
// WHY THIS EXISTS. Round 3 of the car pass found that `rimTyre` at the subject
// rounds 1 and 2 had been tuned on was dividing by SUNLIT ROAD rather than by
// tyre, so two rounds had optimised an alloy to match tarmac. The fix was to
// check the denominator, and nothing in this harness could check it.
//
// Round 4's blind reviewer then reported the near car's FRONT wheel as the one
// regression in an otherwise improved set - rim/tyre step +19.62 -> +7.85 - from
// an ellipse at (310, 811.5) with semi-axes 14.5 x 30. Run through this file
// that ellipse reads tyre/outside 1.012 and 1.127: its "tyre" annulus is as
// bright as the road outside the wheel, because the wheel is 30-38 px higher up
// the frame. Every ellipse that IS on the tyre puts the newer arm ahead. Same
// disease, new location, and it would have cost a round.
//
// THE METRIC. tyre-annulus / outside-annulus in LINEAR light, inside one frame,
// so it is exposure-invariant (CLAUDE.md: the same ratio on sRGB-encoded values
// drifts 20%, because the OETF is not a scale). A tyre is far darker than the
// road and arch around it, so:
//
//   < 0.55   the mask spans a dark tyre against a light surround - usable
//   < 0.80   partly on it; treat a small difference as unresolved
//   >= 0.80  both annuli are the same material, and every "rim/tyre step" the
//            mask reports is a step between two bits of that material
//
// It does not say the ellipse is the RIGHT size, only that it is on a tyre. Two
// masks of different size on the same wheel are still two different subjects and
// must not be compared across arms - see ao-sweep's note on pinning a slot.
//
//   node tools/wheel-mask.mjs --selftest
//   node tools/wheel-mask.mjs docs/shots/carA-corridor-dusk.png 310,811.5,14.5,30
import { readPNG } from './png.mjs';

const LIN = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

/** Mean sRGB and mean LINEAR luma over an elliptical annulus rho in [r0, r1). */
export function annulus(img, e, r0, r1) {
  let s = 0, sl = 0, n = 0;
  const y0 = Math.max(0, Math.floor(e.cy - e.ry * r1));
  const y1 = Math.min(img.height - 1, Math.ceil(e.cy + e.ry * r1));
  const x0 = Math.max(0, Math.floor(e.cx - e.rx * r1));
  const x1 = Math.min(img.width - 1, Math.ceil(e.cx + e.rx * r1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const rho = Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry);
    if (rho < r0 || rho >= r1) continue;
    // channels is 3 for these screenshots, not 4. A hardcoded stride reads NaN
    // in the bottom quarter, and NaN loses every comparison silently.
    const i = (y * img.width + x) * img.channels;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!Number.isFinite(l)) throw new Error(`non-finite sample at ${x},${y}`);
    s += l; n++;
    sl += 0.2126 * LIN(r) + 0.7152 * LIN(g) + 0.0722 * LIN(b);
  }
  return { mean: s / n, meanLin: sl / n, n };
}

export function onTyre(img, e) {
  const tyre = annulus(img, e, 0.55, 0.95);
  const outside = annulus(img, e, 1.15, 1.60);
  const ratio = tyre.meanLin / outside.meanLin;
  if (!Number.isFinite(ratio)) throw new Error('non-finite tyre/outside ratio');
  return { ratio, tyre, outside,
    verdict: ratio < 0.55 ? 'ON THE TYRE' : ratio < 0.8 ? 'partly' : 'NOT ON THE TYRE' };
}

function selftest() {
  let f = 0;
  const enc = (v) => { const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255))); };
  // A dark elliptical tyre with a lighter rim on a light road, placed LOW in a
  // tall image so a 4-byte stride or an early row cutoff reads NaN and throws.
  const W = 200, H = 400, cx = 100, cy = 330, a = 12, b = 30;
  const mk = (withWheel) => { const d = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const rho = Math.hypot((x - cx) / a, (y - cy) / b);
      let v = 0.32;
      if (withWheel) { if (rho < 0.45) v = 0.26; else if (rho < 1.0) v = 0.012; }
      const i = (y * W + x) * 3; d[i] = d[i + 1] = d[i + 2] = enc(v);
    } return { width: W, height: H, channels: 3, data: d }; };
  const wheel = mk(true), road = mk(false), e = { cx, cy, rx: a, ry: b };
  const on = onTyre(wheel, e), off = onTyre(road, e);
  const slid = onTyre(wheel, { cx, cy: cy - 110, rx: a, ry: b });
  console.log(`  on a tyre                      ${on.ratio.toFixed(3)}  ${on.verdict}`);
  console.log(`  on bare road (KNOWN-BAD)       ${off.ratio.toFixed(3)}  ${off.verdict}`);
  console.log(`  slid 110 px off the same wheel ${slid.ratio.toFixed(3)}  ${slid.verdict}`);
  if (!(on.ratio < 0.2)) { console.log(`FAIL a real tyre must read well under 1 (${on.ratio.toFixed(3)})`); f++; }
  if (!(off.ratio > 0.9)) { console.log(`FAIL bare road must read about 1 (${off.ratio.toFixed(3)})`); f++; }
  if (!(slid.ratio > 0.9)) { console.log(`FAIL a displaced mask read ${slid.ratio.toFixed(3)} and would pass`); f++; }
  if (off.ratio / on.ratio < 4) { console.log('FAIL selftest insensitive: the cases are not separated'); f++; }
  // The step a displaced mask reports is a step between two bits of road, which
  // is the whole point: it is not small, it is meaningless.
  const c = annulus(wheel, { cx, cy: cy - 110, rx: a, ry: b }, 0, 0.40);
  const t = annulus(wheel, { cx, cy: cy - 110, rx: a, ry: b }, 0.55, 0.95);
  console.log(`  ...the "rim/tyre step" there is ${(c.mean - t.mean).toFixed(2)} DN of nothing`);
  if (on.tyre.n < 100) { console.log('FAIL lost the bottom-quarter samples'); f++; }
  console.log(f ? `WHEEL-MASK SELFTEST FAIL (${f})` : 'WHEEL-MASK SELFTEST OK');
  process.exit(f ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/wheel-mask.mjs');
if (isMain && process.argv.includes('--selftest')) selftest();
else if (isMain) {
  const [file, ...ells] = process.argv.slice(2);
  const img = readPNG(file);
  if (!ells.length) throw new Error('give one or more ellipses as cx,cy,rx,ry');
  for (const spec of ells) {
    const [cx, cy, rx, ry] = spec.split(',').map(Number);
    const r = onTyre(img, { cx, cy, rx, ry });
    console.log(`  ${spec.padEnd(24)} tyre ${r.tyre.mean.toFixed(1).padStart(6)}  outside ${r.outside.mean.toFixed(1).padStart(6)}` +
      `  tyre/outside ${r.ratio.toFixed(3).padStart(7)}   ${r.verdict}`);
  }
}
