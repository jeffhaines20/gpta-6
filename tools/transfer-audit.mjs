// Is the frame dark because of the LIGHT or because of the ENCODE?
//
// Two hypotheses were live for the same symptom - "everything not in direct
// sunlight is two to three times too dark and has swung from warm to cold":
//
//   A. no bounce fill. If the only ambient is a sky dome, every surface facing
//      away from the sun is lit by sky alone, which is both too blue and too dim.
//   B. no display transfer function. src/post.js's composite was a
//      RawShaderMaterial with no <colorspace_fragment>, so the byte was
//      aces(radiance * exposure) with no sRGB encode and the display's own ~2.2
//      decode was applied to a value nothing had encoded.
//
// They are not mutually exclusive and the fix differs completely, so this file
// separates them with measurements instead of an argument. Three of them:
//
//   --gamma    the local slope d log(byte) / d log(radiance), measured on a real
//              frame. B is a claim about exactly this number.
//   --shape    each frame's scene-linear luminance histogram, normalised by its
//              OWN p90 so exposure cannot enter, engine against the like-placed
//              photograph. A is a claim about RADIANCE and must show up here; B
//              is a claim about the encode and cannot show up here at all.
//   --colour   how much warmer a frame's shadows are than its own body, in
//              scene-linear blue/red. Self-referenced, so white balance cannot
//              enter either. This is the half of the complaint B cannot explain.
//
// and one derivation:
//
//   --solve    the camera stop that holds a frame's median display value when
//              the chain changes. Exact, not fitted: for a frame from a KNOWN
//              chain the inverse recovers the radiance behind every pixel, so
//              re-tonemapping at a candidate stop gives the frame that build
//              would actually produce. This is where daynight.js's four new
//              stops came from.
//
// THE VERDICT IT RETURNED, on the frames committed at the time (2026-09-05):
//   gamma   the sky-lit facade and the sunlit road at the corridor camera sat at
//           ACES input 0.0796 and 0.4473 - 2.49 stops apart in radiance. Through
//           the shipped chain they land 6.41:1 apart in display code value, i.e.
//           1.076 display stops per scene stop. Through the same tonemap at the
//           same stop WITH an sRGB encode they land 2.36:1 apart, 0.498 stops per
//           stop. Same light, same exposure, 2.16x the tonal separation, on the
//           exact pair the review measured, from the encode alone.
//   shape   noon, 18 matched pairs, median of each frame's own p90-normalised
//           luminance: photographs p25 0.102 p50 0.297, engine p25 0.142 p50
//           0.454. The engine's dark tail was SHORTER than the photographs'.
//           There is no radiance deficit to find, so A cannot be the level fault.
//   colour  photographs put their darkest 30% at 0.68x the frame's own blue/red;
//           the engine at noon put them at 0.98x - no warm bounce at all. A is
//           real, and it is the colour fault, not the level fault.
//
// So B was fixed (post.js, and the four stops in daynight.js) and A was left
// standing as a separate, measured piece of work: the dome's ground albedo.
//
//   node tools/transfer-audit.mjs --gamma [--time noon]
//   node tools/transfer-audit.mjs --shape [--time noon]
//   node tools/transfer-audit.mjs --colour
//   node tools/transfer-audit.mjs --solve --from docs/shots --chain srgb-aces
// (--chain defaults to srgb-aces-roll, what ships now; the two older names read
//  frames captured before the encode and before the highlight rolloff landed.)
//   node tools/transfer-audit.mjs                       # all four
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// ------------------------------------------------------------------ transfers
export const srgbEncode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
export const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const aces = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
export function acesInverse(y) {
  const A = 2.43 * y - 2.51, B = 0.59 * y - 0.03, C = 0.14 * y;
  if (Math.abs(A) < 1e-9) return B !== 0 ? -C / B : 0;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return 0;
  const r = [(-B + Math.sqrt(disc)) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)].filter((v) => v >= 0);
  return r.length ? Math.min(...r) : 0;
}

// The highlight rolloff src/post.js's composite runs in front of the fit. The
// two constants MUST match its params block; see highlightRolloff() there for
// why the asymptote is 8.0 and not lower.
export const ROLLOFF = { knee: 0.5, ceil: 8.0 };
export const roll = (x) => {
  const S = ROLLOFF.ceil - ROLLOFF.knee, t = Math.max(0, x - ROLLOFF.knee);
  return Math.min(x, ROLLOFF.knee) + (S * t) / (S + t);
};
export const rollInverse = (y) => {
  if (y <= ROLLOFF.knee) return y;
  const S = ROLLOFF.ceil - ROLLOFF.knee, u = y - ROLLOFF.knee;
  return u >= S ? Infinity : ROLLOFF.knee + (S * u) / (S - u);
};

// A "chain" is what a build's composite does between radiance*exposure and the
// byte. Frames in docs/shots span all three, so it is a parameter and never
// assumed.
//   'aces'            before 2026-09-05 07:29: byte = aces(x)
//   'srgb-aces'       after the encode landed: byte = srgb(aces(x))
//   'srgb-aces-roll'  what ships now:          byte = srgb(aces(roll(x)))
export const CHAINS = {
  aces: { encode: (x) => aces(x), decode: (v) => acesInverse(v) },
  'srgb-aces': { encode: (x) => srgbEncode(aces(x)), decode: (v) => acesInverse(srgbDecode(v)) },
  'srgb-aces-roll': { encode: (x) => srgbEncode(aces(roll(x))),
    decode: (v) => rollInverse(acesInverse(srgbDecode(v))) },
};
function table(chain) {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = CHAINS[chain].decode(i / 255);
  return t;
}
// A photograph is sRGB with a camera's own curve baked in. That curve is not
// invertible from here, and it COMPRESSES - so every ratio measured off a
// photograph below is a LOWER bound on the scene's real ratio. That bias runs
// against hypothesis B and in favour of A, which is worth stating because the
// answer came out against A anyway.
const PHOTO = (() => { const t = new Float64Array(256); for (let i = 0; i < 256; i++) t[i] = srgbDecode(i / 255); return t; })();

const luma8 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ---------------------------------------------------------------- frame access
export function pixels(img) {
  const { width, height, channels: c, data } = img;
  return { n: width * height, at: (p) => { const i = p * c; return [data[i], data[i + 1], data[i + 2]]; } };
}

/** Mean of a box in whatever space `lut` maps bytes into. */
export function boxMean(img, [x0, y0, w, h], lut = null) {
  const { width, height, channels: c, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * c;
      if (lut) { r += lut[data[i]]; g += lut[data[i + 1]]; b += lut[data[i + 2]]; }
      else { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, n };
}

// ------------------------------------------------------------------- 1. gamma
//
// The number hypothesis B IS. For a chain byte = f(radiance * exposure), the
// quantity that decides how far a shaded surface falls below a sunlit one is
// d log(byte) / d log(radiance) - display stops per scene stop. A bare tonemap
// runs it at 0.8-1.6 through the range a shaded surface lives in; the same
// tonemap with an sRGB transfer on the end runs it at 0.37-0.90. The ratio is
// 2.0-2.4 everywhere below the shoulder, and that ratio is the whole defect.
export function gammaCurve(exposure, chain, decades = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3]) {
  const f = CHAINS[chain].encode;
  return decades.map((x) => {
    const d = 1.05;
    const lo = 255 * f(x / d), hi = 255 * f(x * d);
    return { acesInput: x, byte: +(255 * f(x)).toFixed(1),
      slope: +((Math.log(Math.max(hi, 1e-9)) - Math.log(Math.max(lo, 1e-9))) / (2 * Math.log(d))).toFixed(3) };
  });
}

// ------------------------------------------------------------------- 2. shape
//
// THE SEPARATOR. Normalising each frame by its own p90 removes exposure, and
// inverting each with its own chain removes the encode, so what is left is the
// scene's own contrast. A predicts a wider engine distribution; B predicts none
// of this moves at all.
function lumaSeries(img, lut) {
  const { width, height, channels: c, data } = img;
  const v = new Float64Array(width * height);
  for (let p = 0; p < v.length; p++) {
    const i = p * c;
    v[p] = 0.2126 * lut[data[i]] + 0.7152 * lut[data[i + 1]] + 0.0722 * lut[data[i + 2]];
  }
  v.sort();
  return v;
}
const quant = (v, f) => v[Math.min(v.length - 1, Math.floor(v.length * f))];
export function shape(img, lut) {
  const v = lumaSeries(img, lut);
  const p90 = quant(v, 0.9) || 1e-9;
  const o = {};
  for (const f of [0.05, 0.10, 0.25, 0.50, 0.75, 0.99]) o[`p${String(f * 100).padStart(2, '0')}`] = quant(v, f) / p90;
  o.stopsP50toP90 = Math.log2(1 / Math.max(1e-9, o.p50));
  return o;
}

// ------------------------------------------------------------------ 3. colour
//
// The half of the complaint a transfer function cannot touch. Both quantities
// are scene-linear and both are referenced to the SAME frame, so exposure, the
// encode and white balance all cancel; what survives is whether a frame's
// shadows are warmer than its body, which is what bounced light off pale
// pavement does and what a sky-only ambient does not.
export function shadowShift(img, lut) {
  const { width, height, channels: c, data } = img;
  const n = width * height;
  const idx = new Uint32Array(n), key = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * c;
    key[p] = 0.2126 * lut[data[i]] + 0.7152 * lut[data[i + 1]] + 0.0722 * lut[data[i + 2]];
    idx[p] = p;
  }
  const order = Array.from(idx).sort((a, b) => key[a] - key[b]);
  const mean = (from, to) => {
    let r = 0, b = 0;
    for (let k = from; k < to; k++) { const i = order[k] * c; r += lut[data[i]]; b += lut[data[i + 2]]; }
    return { r: r / (to - from), b: b / (to - from) };
  };
  const dark = mean(0, Math.floor(n * 0.30));
  // The body excludes the top decile: the sky is very blue and would swamp it.
  const body = mean(0, Math.floor(n * 0.90));
  const dBR = dark.b / Math.max(1e-9, dark.r), bBR = body.b / Math.max(1e-9, body.r);
  return { darkBR: dBR, bodyBR: bBR, shift: dBR / Math.max(1e-9, bBR) };
}

// ------------------------------------------------------------------- 4. solve
//
// Recover the radiance behind every pixel of a frame taken on a known chain at a
// known stop, then find the stop at which a NEW chain reproduces the frame's
// median display value. Exact wherever the shipped byte is neither clipped at
// 255 nor sitting in the bottom code or two, and the fraction that is is
// reported rather than assumed away.
export function recover(img, exposure, chain) {
  const lut = table(chain);
  const n = img.width * img.height, c = img.channels;
  const rad = new Float32Array(n * 3);
  let clipped = 0, floored = 0;
  for (let p = 0; p < n; p++) {
    const i = p * c;
    for (let k = 0; k < 3; k++) {
      const v = img.data[i + k];
      if (v >= 255) clipped++;
      if (v <= 1) floored++;
      rad[p * 3 + k] = lut[v] / exposure;
    }
  }
  return { rad, w: img.width, h: img.height,
    clippedPct: (100 * clipped) / (n * 3), flooredPct: (100 * floored) / (n * 3) };
}
export function regrade({ rad, w, h }, exposure, chain) {
  const f = CHAINS[chain].encode;
  const data = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h * 3; p++) data[p] = Math.max(0, Math.min(255, Math.round(255 * f(rad[p] * exposure))));
  return { width: w, height: h, channels: 3, data };
}

// HUD furniture, excluded from every whole-frame histogram. Same boxes as
// tools/tod-readability.mjs, at 1440x810.
const HUD = [[20, 530, 275, 240], [1180, 630, 260, 180], [1260, 20, 180, 100], [280, 660, 80, 150], [900, 775, 540, 35]];
const inBox = (x, y, [bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh;
export function frameHist(img, { skipHud = true } = {}) {
  const { width, height, channels: c, data } = img;
  const h = new Uint32Array(256);
  let n = 0;
  const sx = width / 1440, sy = height / 810;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (skipHud && HUD.some((b) => inBox(x / sx, y / sy, b))) continue;
      const i = (y * width + x) * c;
      h[Math.round(luma8(data[i], data[i + 1], data[i + 2]))]++; n++;
    }
  }
  let sum = 0, cr = 0, dp = 0, cl = 0;
  for (let v = 0; v < 256; v++) { sum += v * h[v]; if (v < 16) cr += h[v]; if (v < 8) dp += h[v]; if (v > 250) cl += h[v]; }
  const pct = (p) => { let a = 0; for (let v = 0; v < 256; v++) { a += h[v]; if (a >= n * p) return v; } return 255; };
  // Fractional median, so bisecting on it converges instead of stepping.
  const medianF = () => { let a = 0; for (let v = 0; v < 256; v++) { const prev = a; a += h[v]; if (a >= n * 0.5) return v + (n * 0.5 - prev) / Math.max(1, h[v]); } return 255; };
  return { mean: sum / n, p05: pct(0.05), p50: pct(0.5), p50f: medianF(), p95: pct(0.95),
    crushedPct: (cr / n) * 100, deepPct: (dp / n) * 100, clippedPct: (cl / n) * 100 };
}
export function solveStop(rec, targetMedian, chain, bracket = [1e-8, 1e3]) {
  let lo = Math.log(bracket[0]), hi = Math.log(bracket[1]);
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (frameHist(regrade(rec, Math.exp(m), chain)).p50f < targetMedian) lo = m; else hi = m;
  }
  return Math.exp((lo + hi) / 2);
}

// ---------------------------------------------------------------------- CLI
// --pano points the paired statistics at a different directory of engine frames.
// tools/pano-match.mjs's arms mode writes each arm to its own subdirectory rather
// than over the canonical set, and an A/B is only an A/B if both sides can be
// read the same way.
const PANO = arg('pano', 'docs/shots/pano-match'), VIEWS = 'reference/sarasota/mapillary/views';
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };

function pairs(time) {
  if (!fs.existsSync(PANO)) return [];
  return fs.readdirSync(PANO)
    .map((f) => f.match(new RegExp(`^(\\d+)-([LR])-${time}\\.png$`)))
    .filter(Boolean)
    .map((m) => ({ eng: `${PANO}/${m[0]}`, pho: `${VIEWS}/${m[1]}-${m[2]}.png` }))
    .filter((p) => fs.existsSync(p.pho));
}

if (process.argv[1] && process.argv[1].endsWith('transfer-audit.mjs')) {
  const chain = arg('chain', 'srgb-aces-roll');
  const lutEngine = table(chain);
  const all = !has('gamma') && !has('shape') && !has('colour') && !has('solve') && !has('shift');

  if (all || has('gamma')) {
    console.log('\n=== 1. DISPLAY STOPS PER SCENE STOP (hypothesis B is a claim about this column)');
    console.log('  ACES input   byte (aces only)  slope      byte (srgb(aces))  slope');
    for (const a of gammaCurve(1, 'aces')) {
      const b = gammaCurve(1, 'srgb-aces', [a.acesInput])[0];
      console.log(`  ${String(a.acesInput).padStart(9)}   ${String(a.byte).padStart(15)}  ${String(a.slope).padStart(5)}      ${String(b.byte).padStart(16)}  ${String(b.slope).padStart(5)}`);
    }
    // The pair the complaint was actually about, so the number comes off the
    // frame rather than off the formula. Defaults are the two regions
    // tools/tod-readability.mjs already names at the corridor camera, in ACES
    // input, on the noon frame that provoked the review.
    const lo = Number(arg('lo', 0.0796)), hi = Number(arg('hi', 0.4473));
    const gap = Math.log2(hi / lo);
    console.log(`\n  A MEASURED PAIR: noon's sky-lit facade at ${lo} against its sunlit road at ${hi},`);
    console.log(`  ${gap.toFixed(2)} stops apart in radiance. At ONE stop, so only the encode differs:`);
    for (const c of ['aces', 'srgb-aces', 'srgb-aces-roll']) {
      const f = CHAINS[c].encode;
      const a = 255 * f(lo), b = 255 * f(hi);
      console.log(`    ${c.padEnd(10)} ${a.toFixed(1).padStart(6)} and ${b.toFixed(1).padStart(6)} of 255` +
        `  ->  ${(b / a).toFixed(2)}:1 apart,  ${(Math.log2(b / a) / gap).toFixed(3)} display stops per scene stop`);
    }
    console.log('  Same light, same stop, same tonemap. The separation halves because of the');
    console.log('  encode alone, which is the whole of "shaded surfaces 2-3x too dark".');
  }

  if (all || has('shape')) {
    for (const time of (arg('time', null) ? [arg('time')] : ['noon', 'golden'])) {
      const ps = pairs(time);
      if (!ps.length) { console.log(`\n=== 2. SHAPE (${time}): no matched pairs on disk`); continue; }
      const E = ps.map((p) => shape(readPNG(p.eng), lutEngine));
      const P = ps.map((p) => shape(readPNG(p.pho), PHOTO));
      console.log(`\n=== 2. SCENE-LINEAR SHAPE, each frame normalised by its own p90 — ${time}, n=${ps.length}` +
        `\n    engine frames read as chain '${chain}' (pass --chain aces for shots taken before 2026-09-05)`);
      console.log('              p05      p10      p25      p50      p75      p99    p50->p90');
      for (const [label, S] of [['photo ', P], ['engine', E]]) {
        const k = ['p05', 'p10', 'p25', 'p50', 'p75', 'p99'];
        console.log(`  ${label}  ${k.map((kk) => med(S.map((s) => s[kk])).toFixed(4).padStart(8)).join(' ')}  ${med(S.map((s) => s.stopsP50toP90)).toFixed(2).padStart(6)} stops`);
      }
      console.log('  A (missing fill) would widen the engine row. B (missing encode) cannot move it at all.');
    }
  }

  if (all || has('colour')) {
    for (const time of (arg('time', null) ? [arg('time')] : ['noon', 'golden'])) {
      const ps = pairs(time);
      if (!ps.length) { console.log(`\n=== 3. COLOUR (${time}): no matched pairs on disk`); continue; }
      const E = ps.map((p) => shadowShift(readPNG(p.eng), lutEngine));
      const P = ps.map((p) => shadowShift(readPNG(p.pho), PHOTO));
      console.log(`\n=== 3. SHADOW WARMTH, scene-linear blue/red, self-referenced — ${time}, n=${ps.length}` +
        `\n    engine frames read as chain '${chain}' (pass --chain aces for shots taken before 2026-09-05)`);
      for (const [label, S] of [['photo ', P], ['engine', E]]) {
        console.log(`  ${label}  body B/R ${med(S.map((s) => s.bodyBR)).toFixed(3)}   darkest 30% B/R ${med(S.map((s) => s.darkBR)).toFixed(3)}   shift ${med(S.map((s) => s.shift)).toFixed(3)}`);
      }
      console.log('  Below 1 means the shadows are warmer than the frame. This is what bounced');
      console.log('  light off pale pavement does, and it is the half of the fault the encode');
      console.log('  cannot explain — see the ground albedo in src/sky.js.');
    }
  }

  // The same statistic on frames that have no photograph beside them.
  //
  // --colour is a PAIRED test and pano-match only stands where a Mapillary
  // panorama stood, which is noon and golden. Dusk and night have no photograph
  // to be referenced against - but shadowShift() is self-referenced by
  // construction, so the engine's own number is still meaningful and still
  // comparable across a change. This is how a lighting round measures all four
  // times of day without inventing a second statistic that would disagree with
  // the first.
  //
  //   node tools/transfer-audit.mjs --shift docs/shots/tod-noon.png,docs/shots/tod-golden.png
  if (has('shift')) {
    const files = String(arg('shift', '')).split(',').filter(Boolean);
    console.log(`\n=== 5. SHADOW WARMTH on single frames, scene-linear blue/red, self-referenced` +
      `\n    read as chain '${chain}'.  Below 1 = shadows warmer than the frame.`);
    console.log('  frame                                          body B/R   dark 30% B/R   shift');
    for (const f of files) {
      if (!fs.existsSync(f)) { console.log(`  ${f.padEnd(46)} (missing)`); continue; }
      const s = shadowShift(readPNG(f), lutEngine);
      console.log(`  ${f.padEnd(46)} ${s.bodyBR.toFixed(3).padStart(8)}   ${s.darkBR.toFixed(3).padStart(12)}   ${s.shift.toFixed(3).padStart(5)}`);
    }
  }

  if (all || has('solve')) {
    const dir = arg('from', 'docs/shots');
    const sweepPath = arg('sweep', 'docs/daynight.json');
    const fromChain = arg('fromchain', chain), toChain = arg('tochain', chain);
    const sweep = fs.existsSync(sweepPath) ? JSON.parse(fs.readFileSync(sweepPath, 'utf8')) : null;
    const asNumber = (e) => (typeof e === 'number' ? e : /^1\//.test(e) ? 1 / Number(String(e).slice(2)) : Number(e));
    // exposureValue is the raw number; `exposure` is Math.round(1/e) as a string
    // and prints night's 1/1.15 as "1/1". Prefer the number, fall back for
    // archived artifacts written before the sweep recorded it.
    const stops = sweep ? Object.fromEntries(sweep.presets.map(
      (p) => [p.tod, Number.isFinite(p.exposureValue) ? p.exposureValue : asNumber(p.exposure)])) : {};
    console.log(`\n=== 4. STOP THAT HOLDS THE MEDIAN, ${fromChain} -> ${toChain}   (${dir}/tod-*.png)`);
    console.log('preset   stop now      median   unrecoverable      stop that holds it');
    for (const tod of ['noon', 'golden', 'dusk', 'night']) {
      const f = `${dir}/tod-${tod}.png`;
      if (!fs.existsSync(f) || !stops[tod]) { console.log(`${tod.padEnd(8)} (missing)`); continue; }
      const img = readPNG(f);
      const rec = recover(img, stops[tod], fromChain);
      const h = frameHist(img);
      const e = solveStop(rec, h.p50f, toChain);
      console.log(`${tod.padEnd(8)} 1/${(1 / stops[tod]).toPrecision(6).padEnd(11)} ${h.p50f.toFixed(2).padStart(7)}   ` +
        `clip ${rec.clippedPct.toFixed(3)}% floor ${rec.flooredPct.toFixed(2)}%   1/${(1 / e).toPrecision(6)}` +
        `  (${(Math.log2(stops[tod] / e)).toFixed(2)} stops)`);
    }
    console.log('An identity run (fromchain == tochain) must return the stop it was given;');
    console.log('that is the check that the recover/regrade pair is not fitting anything.');
  }
}
