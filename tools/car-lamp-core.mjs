// THE MEASUREMENT HALF OF tools/car-lamp.html, importable by the page and by node, so the selftest in
// tools/car-lamp.mjs runs the SAME function the page runs rather than a copy of it.
//
// A frame and its class mask, both RGB with THREE channels per pixel (CLAUDE.md: `readPNG` returns 3
// here, and a hardcoded 4-byte stride reads NaN in the bottom quarter). The mask's red byte is the
// class (CLASS below); only INTERIOR pixels are read — all nine of a pixel's 3x3 neighbourhood the
// same class — so an edge carrying two surfaces' colours is never counted as either.
//
// Per lamp, split at `splitX` (the car's centreline on screen):
//   p05 / p10 / p50 / p90 of linear luma, and the share over twice its own median
//   fascia: forward-facing paint BESIDE AND BELOW that lamp, as reference/sarasota/lamp-census.json
//           boxed it — from the lamp's top down to one and a half of its own height under its foot,
//           across its own width and half of it either side
//   overFascia: the lamp's median over that paint's median — the census's box
//   beside: paint at the LAMP'S OWN TILT beside it (the `nose` class: within 16 degrees of the lamp's
//           mean normal), from half its height above its top to half below its foot, across its own
//           width either side. The census asked for paint "facing the same way"; on these bodies the
//           lamp leans back 49 degrees and the bumper under it stands near vertical, so only this one
//           holds the orientation
//   overBeside: the lamp's median over that paint's median
// and, for the car, the bonnet (paint facing the sky), which is the reviewer's denominator.

export const CLASS = { bg: 0, wheel: 40, glass: 80, head: 100, otherLens: 110, fascia: 140, nose: 150, bonnet: 160, paint: 180, dark: 200 };
const NAME = Object.fromEntries(Object.entries(CLASS).map(([k, v]) => [v, k]));

export const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

const sorted = (v) => Float64Array.from(v).sort();
const pc = (s, f) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * (s.length - 1) + 0.5))] : null);

export function measureLamps(rgb, mask, W, H, splitX) {
  if (rgb.length !== W * H * 3 || mask.length !== W * H * 3) {
    throw new Error(`buffers ${rgb.length} / ${mask.length} != ${W}*${H}*3 — stride wrong`);
  }
  const L = (i) => {
    const v = 0.2126 * LIN[rgb[i * 3]] + 0.7152 * LIN[rgb[i * 3 + 1]] + 0.0722 * LIN[rgb[i * 3 + 2]];
    if (!Number.isFinite(v)) throw new Error(`non-finite luma at pixel ${i}`);
    return v;
  };
  const pure = (i, c) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (mask[(i + dy * W + dx) * 3] !== c) return false;
    return true;
  };
  const counts = {};
  const box = () => ({ L: [], x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  const lamps = [box(), box()];
  const bonnet = [], fasciaAll = [], fasciaPx = [], nosePx = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, c = mask[i * 3];
    if (!c) continue;
    const nm = NAME[c] ?? String(c);
    counts[nm] = (counts[nm] ?? 0) + 1;
    if (!pure(i, c)) continue;
    if (c === CLASS.head) {
      const l = lamps[x < splitX ? 0 : 1];
      l.L.push(L(i)); l.x0 = Math.min(l.x0, x); l.x1 = Math.max(l.x1, x); l.y0 = Math.min(l.y0, y); l.y1 = Math.max(l.y1, y);
    } else if (c === CLASS.bonnet) bonnet.push(L(i));
    else if (c === CLASS.fascia) { const v = L(i); fasciaAll.push(v); fasciaPx.push([x, y, v]); }
    else if (c === CLASS.nose) nosePx.push([x, y, L(i)]);
  }
  const lampOut = lamps.map((l, k) => {
    const side = k ? 'right' : 'left';
    if (!l.L.length) return { side, n: 0 };
    const s = sorted(l.L), p50 = pc(s, 0.5);
    const h = l.y1 - l.y0 + 1, w = l.x1 - l.x0 + 1;
    const near = fasciaPx.filter(([x, y]) => y >= l.y0 && y <= l.y1 + 1.5 * h && x >= l.x0 - 0.5 * w && x <= l.x1 + 0.5 * w).map((p) => p[2]);
    const fs = sorted(near), f50 = pc(fs, 0.5);
    const bes = sorted(nosePx.filter(([x, y]) => y >= l.y0 - 0.5 * h && y <= l.y1 + 0.5 * h && x >= l.x0 - w && x <= l.x1 + w).map((p) => p[2]));
    const b50 = pc(bes, 0.5);
    let over2 = 0;
    for (const v of l.L) if (v > 2 * p50) over2++;
    return { side, n: l.L.length, box: [l.x0, l.y0, w, h],
      p05: pc(s, 0.05), p10: pc(s, 0.10), p50, p90: pc(s, 0.90), over2x: over2 / l.L.length,
      fascia: { n: near.length, p50: f50, p10: pc(fs, 0.1), p90: pc(fs, 0.9) },
      overFascia: f50 > 0 ? p50 / f50 : null,
      beside: { n: bes.length, p50: b50, p10: pc(bes, 0.1), p90: pc(bes, 0.9) },
      overBeside: b50 > 0 ? p50 / b50 : null };
  });
  const bs = sorted(bonnet), fa = sorted(fasciaAll);
  return { counts, lamps: lampOut,
    bonnet: { n: bonnet.length, p50: pc(bs, 0.5), p90: pc(bs, 0.9) },
    fasciaAll: { n: fasciaAll.length, p50: pc(fa, 0.5) } };
}
