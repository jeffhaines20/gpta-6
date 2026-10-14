// HOW MUCH OF A ROAD BOX IS SKY-COLOURED GLOSS — BACKLOG #116's instrument.
//
//   node tools/road-gloss.mjs <png> x0 y0 x1 y1 [factor]
//   node tools/road-gloss.mjs --selftest
//
// A blind reviewer found "rows of pale blue elliptical spots on the asphalt" at dusk, 7.63% of
// corridor's road box (560-1040, 600-760). They were the asphalt ROUGHNESS map's seven smooth spots
// per 3 m tile, repeating on a lattice the road shader's de-tiling never touched, each catching the
// brightest sky of the day. This counts them: a pixel is gloss when its linear luma exceeds `factor`
// times the median of its own 31x31 neighbourhood AND it is bluer than it is red by BLUE levels.
//
// THE BLUE TERM IS WHAT MAKES IT A GLOSS COUNT and not a brightness count. Without it the first
// version read 17.8% at NOON as well as at dusk, because lane paint and crack edges are brighter than
// their surroundings too; white and yellow paint are never bluer than red, and a reflection of the
// sky is. Blobs (4-connected, at least 6 px) are reported beside the coverage, so a lattice of spots
// and a continuous sheen — the tyre-track polish the road shader draws in world space, which is
// real and stays — read differently.
import { readPNG } from './png.mjs';

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

/**
 * @param img  { width, height, channels, data } as readPNG returns it — `channels` is 3 for these
 *             frames, not 4, and is read rather than assumed (CLAUDE.md)
 * @param box  [x0, y0, x1, y1], exclusive at the far edge
 */
export function measure(img, box, { factor = 1.2, blue = 10, radius = 15 } = {}) {
  const { width: W, height: H, channels: C, data } = img;
  const [x0, y0, x1, y1] = box;
  if (!(x1 > x0 && y1 > y0 && x0 >= 0 && y0 >= 0 && x1 <= W && y1 <= H)) {
    throw new Error(`box ${box} is empty or outside the ${W}x${H} image`);
  }
  const L = (x, y) => {
    const k = (y * W + x) * C;
    const v = 0.2126 * LIN[data[k]] + 0.7152 * LIN[data[k + 1]] + 0.0722 * LIN[data[k + 2]];
    if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y}: a NaN fails every > silently`);
    return v;
  };
  const w = x1 - x0, h = y1 - y0;
  const hot = new Uint8Array(w * h);
  let n = 0, gloss = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const win = [];
    for (let dy = -radius; dy <= radius; dy += 3) for (let dx = -radius; dx <= radius; dx += 3) {
      win.push(L(Math.min(W - 1, Math.max(0, x + dx)), Math.min(H - 1, Math.max(0, y + dy))));
    }
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const k = (y * W + x) * C;
    n++;
    if (med > 1e-5 && L(x, y) > factor * med && data[k + 2] - data[k] >= blue) { hot[(y - y0) * w + (x - x0)] = 1; gloss++; }
  }
  const seen = new Uint8Array(w * h);
  let blobs = 0;
  for (let i = 0; i < w * h; i++) {
    if (!hot[i] || seen[i]) continue;
    let size = 0; const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(); size++;
      const jx = j % w, jy = (j / w) | 0;
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = jx + ax, ny = jy + ay;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const kk = ny * w + nx;
        if (hot[kk] && !seen[kk]) { seen[kk] = 1; st.push(kk); }
      }
    }
    if (size >= 6) blobs++;
  }
  return { pixels: n, gloss, coverage: gloss / n, blobs };
}

const DIRECT = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (DIRECT && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
  console.log('ROAD-GLOSS SELFTEST');
  // A synthetic road: dark grey asphalt, 3 channels like the real frames.
  const make = (W, H, paint) => {
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x, y); const k = (y * W + x) * 3; data[k] = r; data[k + 1] = g; data[k + 2] = b;
    }
    return { width: W, height: H, channels: 3, data };
  };
  const asphalt = [52, 54, 58];
  const plain = make(120, 80, () => asphalt);
  const r0 = measure(plain, [10, 10, 110, 70]);
  check('plain asphalt reads no gloss', r0.gloss === 0 && r0.blobs === 0, JSON.stringify(r0));
  // KNOWN-BAD: a lattice of sky-coloured spots, every 20 px.
  const spotty = make(120, 80, (x, y) => ((x % 20 - 10) ** 2 + (y % 20 - 10) ** 2 < 9 ? [110, 130, 170] : asphalt));
  const r1 = measure(spotty, [10, 10, 110, 70]);
  check('KNOWN-BAD: a lattice of sky-coloured spots reads as gloss, one blob a spot', r1.coverage > 0.05 && r1.blobs >= 12,
    `${(100 * r1.coverage).toFixed(2)}%, ${r1.blobs} blobs`);
  // Paint is brighter than asphalt and must NOT count: white and yellow are never bluer than red.
  const painted = make(120, 80, (x) => (x % 30 < 3 ? [235, 233, 224] : x % 30 > 26 ? [232, 186, 58] : asphalt));
  const r2 = measure(painted, [10, 10, 110, 70]);
  check('white and yellow paint are bright and are not gloss', r2.gloss === 0, JSON.stringify(r2));
  // A WARM bright spot is a lamp pool or a sunlit fleck, not a sky reflection.
  const warm = make(120, 80, (x, y) => ((x % 20 - 10) ** 2 + (y % 20 - 10) ** 2 < 9 ? [180, 150, 110] : asphalt));
  check('warm highlights are not gloss', measure(warm, [10, 10, 110, 70]).gloss === 0);
  let threw = false;
  try { measure(plain, [100, 10, 10, 70]); } catch { threw = true; }
  check('KNOWN-BAD: an inverted box throws rather than reading 0%', threw);
  threw = false;
  try { measure({ width: 4, height: 4, channels: 3, data: new Uint8Array(4 * 4 * 3 - 3) }, [0, 0, 4, 4]); } catch { threw = true; }
  check('KNOWN-BAD: a short buffer throws rather than reading NaN as no gloss', threw);
  console.log(`\nROAD-GLOSS SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
if (DIRECT && !process.argv.includes('--selftest')) {
  const [f, X0, Y0, X1, Y1, F] = process.argv.slice(2);
  if (!f || Y1 === undefined) { console.error('usage: node tools/road-gloss.mjs <png> x0 y0 x1 y1 [factor]  |  --selftest'); process.exit(2); }
  const r = measure(readPNG(f), [X0, Y0, X1, Y1].map(Number), { factor: F ? Number(F) : 1.2 });
  console.log(`${f}  box ${X0},${Y0}-${X1},${Y1}: ${(100 * r.coverage).toFixed(2)}% sky-coloured gloss, ${r.blobs} blobs of >= 6 px`);
}
