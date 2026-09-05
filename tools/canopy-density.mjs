// Why is `xings` short when `holesPerK` is already past the reference?
//
// Two rounds of foliage work moved crossings from 6.7 to 38 against a
// photographic 50, and neither produced a story for the residual. Porosity is no
// longer the explanation: oak-tunnel now reads holesPerK 5.58 against a
// reference 3.57, i.e. MORE porous than the photographs, while still crossing
// fewer times per scanline. Those two can only diverge through the arrangement
// of canopy across a row, so this decomposes the per-row crossing count into the
// three things that produce it:
//
//   span        how much of the row's width the canopy reaches across, end to end
//   skyInSpan   how much of THAT is sky rather than leaf
//   meanRun     how long an unbroken run of canopy is, in pixels
//
// and runs/row follows, with xings ~= 2 * runs. Splitting it this way separates
// three different faults that all show up as "not enough crossings": a canopy
// that does not reach across the frame (span), one that is too coarse (meanRun),
// and one that is simply too thin (skyInSpan).
//
//   node tools/canopy-density.mjs --selftest
//   node tools/canopy-density.mjs --reference
//   node tools/canopy-density.mjs docs/shots/tree3-after2-oak-tunnel-golden.png
//
// THE ANSWER, measured 2026-09-05:
//
//                     span   runs/row  meanRun  skyInSpan
//     photographs     0.913    25.5      23.5     0.34
//     oak-tunnel      0.896    19.5      24.0     0.49
//
// Span matches. Mean run length matches almost exactly - 24.0 px against 23.5 -
// so the canopy is NOT too coarse and the grain work is done. What differs is
// that half again as much of the canopy's own envelope is sky: 49% against 34%.
// Covered fraction of a row is 0.454 against 0.603.
//
// So the crossings deficit is CANOPY MASS, inside an envelope that is already
// the right size and a grain that is already the right scale. And that is in
// direct tension with the alpha stencil, whose whole job is removing mass: the
// round that fixed the silhouette is the reason this number did not close. The
// previous round saw the symptom - "the stencil cut the crown to 26% mass and
// read skeletal" - without connecting it to the xings residual. Closing it means
// paying triangles for more clumps while keeping the stencil grain, which is why
// it has not happened rather than because nobody understood it.
//
// WHAT THE DENSITY ROUND THEN FOUND, 2026-09-05. "More clumps" is the one thing
// that does NOT work, and this tool is what says so: +50% clumps on the same
// branch lines took the tunnel from covered 0.454 to 0.482 and meanRun from
// 23.8 px to 28.5, i.e. it bought mass by MERGING, and xings went DOWN, 38.6 to
// 33.7. Coverage and run length are locked together by the stencil: n
// independent plates of duty q give covered 1-(1-q)^n and mean gap g0/n, so
// covered = 0.576 at this stencil's q = 0.38 arrives with meanRun near 26 px
// however the mass is paid for. The lever that moves the FRONTIER rather than
// sliding along it is DISPERSION - more branch lines, clumps scattered further
// off them, and a bigger polygon under the same mask - and that is what shipped:
// covered 0.482/0.524/0.454 -> 0.554/0.560/0.473 with meanRun 43.6/32.3/23.8 ->
// 39.6/29.8/23.3 and xings 21.5/31.2/38.6 -> 27.1/37.3/40.9.
//
// AND READ THE TUNNEL FRAME'S NUMBER WITH THE CROP IN MIND. `span` runs from
// the leftmost dark pixel of a row to the rightmost, so on a frame looking DOWN
// a street it spans the two building walls and counts the sky at the vanishing
// point - which no canopy can ever fill - as sky in the span. Cropped to the
// near crown (480,0 - 1160,430 on the 1400x900 bench frame) the same two builds
// read covered 0.595 -> 0.637 and skyInSpan 0.242 -> 0.218, past the 0.576 the
// photographs sit at, with meanRun 28.2 -> 24.0 px and runs/row 14.6 -> 18.0 on
// the same crop. The oak-up and oak-row frames do not have that dilution; the
// tunnel's full-frame figure is a floor, not a measurement of the canopy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPNG } from './png.mjs';

const NORM_W = 1024;
const has = (k) => process.argv.includes(`--${k}`);

/** Otsu mask of the upper band, area-averaged to a common width. Same pipeline
 *  as foliage-grain.mjs, deliberately: two instruments disagreeing because they
 *  segment differently is a debugging session nobody needs. */
function maskOf(img, band = 0.55) {
  const c = img.channels, sw = img.width;
  const sh0 = Math.round(img.height * band), sw0 = sw;
  const src = new Float32Array(sw0 * sh0);
  for (let y = 0; y < sh0; y++) {
    for (let x = 0; x < sw0; x++) {
      const i = (y * sw + x) * c;
      src[y * sw0 + x] = c === 1 ? img.data[i]
        : 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    }
  }
  let L = src, w = sw0, h = sh0;
  if (sw0 > NORM_W) {
    const k = NORM_W / sw0; w = NORM_W; h = Math.max(1, Math.round(sh0 * k));
    L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const a = (y * sh0) / h, b = ((y + 1) * sh0) / h;
      const j0 = Math.floor(a), j1 = Math.min(sh0, Math.ceil(b));
      for (let x = 0; x < w; x++) {
        const p = (x * sw0) / w, q = ((x + 1) * sw0) / w;
        const i0 = Math.floor(p), i1 = Math.min(sw0, Math.ceil(q));
        let acc = 0, wt = 0;
        for (let j = j0; j < j1; j++) {
          const fy = Math.min(b, j + 1) - Math.max(a, j);
          if (fy <= 0) continue;
          for (let i = i0; i < i1; i++) {
            const fx = Math.min(q, i + 1) - Math.max(p, i);
            if (fx <= 0) continue;
            acc += src[j * sw0 + i] * fx * fy; wt += fx * fy;
          }
        }
        L[y * w + x] = wt > 0 ? acc / wt : 0;
      }
    }
  }
  const hist = new Float64Array(256);
  for (let i = 0; i < L.length; i++) hist[Math.max(0, Math.min(255, Math.round(L[i])))]++;
  const n = L.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sumB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, bt = wB * wF * (mB - mF) * (mB - mF);
    if (bt > best) { best = bt; thr = t; }
  }
  const m = new Uint8Array(w * h);
  for (let i = 0; i < L.length; i++) if (Math.round(L[i]) <= thr) m[i] = 1;
  return { m, w, h };
}

export function decompose(m, w, h) {
  let rows = 0, spanSum = 0, runSum = 0, gapSum = 0, runLenSum = 0, nRuns = 0;
  for (let y = 0; y < h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (m[y * w + x]) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    rows++;
    spanSum += (last - first + 1) / w;
    let runs = 0, x = first;
    while (x <= last) {
      if (!m[y * w + x]) { x++; continue; }
      const s = x;
      while (x <= last && m[y * w + x]) x++;
      runs++; runLenSum += x - s; nRuns++;
    }
    runSum += runs;
    let sky = 0;
    for (let i = first; i <= last; i++) if (!m[y * w + i]) sky++;
    gapSum += sky / (last - first + 1);
  }
  if (!rows || !nRuns) return null;
  const span = spanSum / rows, runsPerRow = runSum / rows;
  const meanRun = runLenSum / nRuns, skyInSpan = gapSum / rows;
  return {
    span: +span.toFixed(3), runsPerRow: +runsPerRow.toFixed(2),
    meanRun: +meanRun.toFixed(1), skyInSpan: +skyInSpan.toFixed(3),
    covered: +(span * (1 - skyInSpan)).toFixed(3),
  };
}

const score = (file) => {
  const { m, w, h } = maskOf(readPNG(file));
  const d = decompose(m, w, h);
  return d && { ...d, w };
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// The decomposition is an identity, and the identity is the self-test: the
// covered fraction of a row computed from span and skyInSpan must equal the one
// computed from run count and run length. If the row walk is wrong - an
// off-by-one at a span end, a run counted twice - the two disagree. Three
// synthetic rasters with known answers, plus that cross-check on each.
if (IS_MAIN && has('selftest')) {
  const W = 1024, H = 400;
  const mk = (fn) => { const m = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fn(x, y)) m[y * W + x] = 1; return m; };
  const cases = {
    solid: { m: mk(() => true), want: { span: 1.0, runsPerRow: 1, skyInSpan: 0 } },
    // 32 on, 32 off from x=0 across 1024 px. The LAST stripe is an off-stripe,
    // so the canopy ends at x=991 and the span is 992/1024 = 0.969, not 1.0 -
    // and the sky inside that span is 480/992 = 0.484, not 0.5. The first
    // version of this test asserted the round numbers, failed, and was right to:
    // the expectations were wrong and the walk was correct. Worth keeping as
    // written, because "span is not quite 1 on a striped frame" is exactly the
    // kind of off-by-a-stripe that would otherwise be read as a bug in the tool.
    stripes: { m: mk((x) => Math.floor(x / 32) % 2 === 0), want: { span: 0.969, runsPerRow: 16, skyInSpan: 0.484, meanRun: 32 } },
    // canopy only in the middle half of the frame
    narrow: { m: mk((x) => x >= 256 && x < 768), want: { span: 0.5, runsPerRow: 1, skyInSpan: 0 } },
  };
  const fails = [];
  for (const [name, c] of Object.entries(cases)) {
    const d = decompose(c.m, W, H);
    console.log(`  ${name.padEnd(8)} ${JSON.stringify(d)}`);
    for (const [k, v] of Object.entries(c.want)) {
      if (Math.abs(d[k] - v) > 0.02) fails.push(`${name}.${k} = ${d[k]}, expected ${v}`);
    }
    // the identity: span*(1-sky) must equal runs*meanRun/width
    const viaRuns = (d.runsPerRow * d.meanRun) / W;
    if (Math.abs(viaRuns - d.covered) > 0.02) {
      fails.push(`${name} identity broken: covered ${d.covered} vs runs*meanRun/W ${viaRuns.toFixed(3)}`);
    }
  }
  console.log(fails.length ? `\nSELFTEST FAILED: ${fails.join('; ')}` : '\nselftest ok - decomposition matches its own identity on all three');
  process.exit(fails.length ? 1 : 0);
}

const fmt = (d) => `span ${d.span.toFixed(3)}  runs/row ${String(d.runsPerRow).padStart(6)}`
  + `  meanRun ${String(d.meanRun).padStart(5)}px  skyInSpan ${d.skyInSpan.toFixed(3)}  covered ${d.covered.toFixed(3)}`;

if (IS_MAIN && has('reference')) {
  const census = JSON.parse(fs.readFileSync('docs/oak-census.json', 'utf8'));
  const rows = [];
  for (const r of census.rows.filter((x) => x.upper > 0.25).sort((a, b) => b.upper - a.upper)) {
    const f = `reference/sarasota/mapillary/views/${r.id}-${r.side}.png`;
    if (!fs.existsSync(f)) continue;
    const d = score(f); if (d) rows.push(d);
  }
  if (!rows.length) { console.error('no reprojected views - run: node tools/reproject-pano.mjs --facades'); process.exit(2); }
  const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const m = { span: med('span'), runsPerRow: med('runsPerRow'), meanRun: med('meanRun'), skyInSpan: med('skyInSpan'), covered: med('covered') };
  console.log(`  PHOTOGRAPHS (median of ${rows.length})   ${fmt(m)}`);
  fs.writeFileSync('docs/canopy-density.json', JSON.stringify({ generated: new Date().toISOString().slice(0, 10), n: rows.length, reference: m }, null, 1));
}

for (const f of process.argv.slice(2).filter((a) => !a.startsWith('--') && a.endsWith('.png'))) {
  const d = score(f);
  console.log(`  ${path.basename(f).padEnd(38)} ${d ? fmt(d) : 'n/a - no canopy in the band'}`);
}
