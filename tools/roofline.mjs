// How high does the streetwall stand, in degrees above the horizon?
//
// A photograph and a render of the same street can be argued about forever. This
// turns the argument into one number per image column: the elevation angle of the
// topmost built thing. It works only because tools/pano-match.mjs captures with
// EXACTLY the camera model tools/reproject-pano.mjs reprojects with - same eye
// height, pitch, horizontal fov and aspect - so a row index maps to the same
// elevation angle in both, and the two profiles can be subtracted.
//
//   node tools/roofline.mjs 1414553883288835 R golden
//   node tools/roofline.mjs --all --time golden
//
// A column whose sky runs all the way to the bottom of the frame reports null
// (nothing built in that direction); a column with no sky at all reports the top
// of frame, which is a LOWER BOUND on the roofline and is flagged as clipped -
// "at least this tall", never "this tall".
//
// ------------------------------------------------------- WHAT THIS CANNOT SEE
//
// The sky test below is a COLOUR test, and on 2026-09-03 an adversarial review
// found three ways for it to be wrong. All three are now measured and printed
// next to every reading rather than left for the next reader to discover:
//
//   1. Sky that is not blue. The golden-hour sun sits at bearing 134 deg
//      (src/sky.js) and every "R" view on this corridor looks into that half of
//      the dome. ACES plus the horizon glow desaturates it until b - r <= 6 and
//      then past it to b < r, so the detector stops in mid-air and reports a
//      roofline up to 38 deg too high. One-sided, R views only, and it does not
//      look broken. `soft%` catches it: the boundary it chose has almost no
//      colour step across it.
//   2. Blue things that are not sky. A glass curtain wall reads 88,104,130 -
//      brighter than 90, bluer than red by 42 - so a glazed tower is invisible to
//      this and the roofline is reported BELOW it.
//   3. Pale cool render or photograph. A stucco wall in shade is lit by skylight
//      and can pass every clause of the test.
//
// tools/roofline-analytic.mjs answers the same question from the baked geometry
// with no detector at all, and is the instrument to believe when the two
// disagree on the built side. It cannot help on the reference side: a photograph
// has no geometry. The `confidence` line is what the reference side has instead.
import { readPNG } from './png.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePNG } from './crop.mjs';

const REF = 'reference/sarasota/mapillary/views';
const REN = 'docs/shots/pano-match';
const PITCH = 12, HFOV = 75, ASPECT = 4 / 3;
const VFOV = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / ASPECT) * 180) / Math.PI;

// The camera this instrument's row->angle scale assumes. tools/pano-match.mjs
// captures with these numbers and stamps them into its index.json; the CLI below
// refuses to measure frames whose stamp disagrees, because a frame shot at a
// different eye height or fov puts the horizon on a different row and every
// angle read off it is wrong by a constant nobody would notice.
export const CAM = { eye: 2.5, pitchDeg: PITCH, hfovDeg: HFOV, aspect: ASPECT, vfovDeg: VFOV };

// Sky, deliberately conservative: bright AND blue-dominant. Sarasota's sky in
// these captures is a strong blue and the render's is a pale blue-grey, so the
// margin is small on purpose - a loose detector would eat pale stucco, and pale
// stucco under a bright sky is exactly what this is trying to measure past.
export const isSky = (r, g, b) => b > 90 && b >= g && b > r + 6 && (r + g + b) / 3 > 85;

/**
 * Row index -> elevation angle above the horizon, in degrees. THE scale this
 * whole comparison is denominated in; exported so tools/roofline-analytic.mjs
 * reports on the identical one rather than keeping a second copy that can drift.
 */
export const elevOf = (row, h) => PITCH + (Math.atan((1 - 2 * (row + 0.5) / h) * Math.tan((VFOV * Math.PI) / 360)) * 180) / Math.PI;

/**
 * Is this frame worth measuring at all?
 *
 * A black frame is the worst case this instrument has, and it used to be silent:
 * mean RGB 3,4,5 has no sky pixel anywhere, so every column reports row 0, which
 * is the MAXIMUM possible reading - 41.9 deg, no-sky 100%, +28.3 deg against the
 * reference. A failed capture therefore came back as "our streetwall is as tall
 * as this instrument can express", in the one direction a massing review is
 * looking for. Nothing about the number said so.
 */
export function frameHealth(img) {
  const { width: w, height: h, channels: c, data } = img;
  const hist = new Float64Array(256);
  let sum = 0, n = 0, sky = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));   // ~40k samples
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * c;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      hist[Math.round(l)]++; sum += l; n++;
      if (isSky(r, g, b)) sky++;
    }
  }
  const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
  const meanLuma = sum / n, dynRange = pct(0.99) - pct(0.01), skyPixelFrac = sky / n;
  const why = [], warn = [];
  if (meanLuma < 20) why.push(`nearly black (mean luma ${meanLuma.toFixed(1)}, want >= 20)`);
  if (dynRange < 12) why.push(`nearly uniform (1st-99th percentile luma spread ${dynRange}, want >= 12)`);
  if (skyPixelFrac === 1) why.push('every pixel passes the sky test, so nothing is built anywhere and there is no roofline to report');
  // Not a refusal: a bright, textured frame with no sky in it is a real view of a
  // wall that fills the frame - the analytic instrument agrees with the one in
  // this set. But every column of it is "at least 41.9 deg" and none of them is a
  // measurement, so it must not be read as one.
  if (skyPixelFrac === 0 && !why.length) {
    warn.push('no sky anywhere in the frame: every column is a LOWER BOUND, and the p50 is a floor rather than a roofline');
  }
  return { ok: why.length === 0, why, warn, meanLuma: +meanLuma.toFixed(1), dynRange, skyPixelFrac: +skyPixelFrac.toFixed(3) };
}

/**
 * Topmost non-sky row per column -> elevation angle.
 *
 * @param {string|object} src  path to a PNG, or an already-decoded readPNG result
 * @param {{allowDegenerate?:boolean}} opts  the escape hatch exists for the
 *        self-test, which has to be able to feed it a black frame on purpose.
 */
export function roofline(src, opts = {}) {
  const img = typeof src === 'string' ? readPNG(src) : src;
  const { width: w, height: h, channels: c, data } = img;
  const health = frameHealth(img);
  if (!health.ok && !opts.allowDegenerate) {
    throw new Error(`degenerate frame ${typeof src === 'string' ? path.basename(src) : ''}: ${health.why.join('; ')}`);
  }
  const cols = [];
  let clipped = 0, open = 0;
  // Confidence terms, all measured at the boundary this detector chose.
  let nb = 0, soft = 0, thin = 0, white = 0, foliage = 0, belowSum = 0;
  for (let x = 0; x < w; x++) {
    let row = -1;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * c;
      if (!isSky(data[i], data[i + 1], data[i + 2])) { row = y; break; }
    }
    if (row < 0) { cols.push(null); open++; continue; }   // sky all the way down
    if (row === 0) clipped++;                              // no sky at all in this column
    cols.push(elevOf(row, h));

    nb++;
    // How deep is the thing it stopped on, and how much sky is under it? A
    // roofline has a building beneath it all the way to the road. A cloud edge,
    // an overhead wire or a twig has sky underneath, and a stop inside a colour
    // gradient has no edge at all.
    let e = row; while (e < h) { const i = (e * w + x) * c; if (isSky(data[i], data[i + 1], data[i + 2])) break; e++; }
    if (e - row < 12) thin++;
    let sk = 0, tot = 0;
    for (let y = row + 1; y < h; y++) { const i = (y * w + x) * c; tot++; if (isSky(data[i], data[i + 1], data[i + 2])) sk++; }
    belowSum += tot ? sk / tot : 0;
    if (row > 0) {
      const i0 = ((row - 1) * w + x) * c, i1 = (row * w + x) * c;
      const d = Math.abs(data[i0] - data[i1]) + Math.abs(data[i0 + 1] - data[i1 + 1]) + Math.abs(data[i0 + 2] - data[i1 + 2]);
      if (d < 20) soft++;
    }
    const i = (row * w + x) * c, r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 200 && (mx - mn) / mx < 0.12) white++;                       // cloud, or sunlit render
    if (g >= b && g >= r - 12 && (r + g + b) / 3 < 170) foliage++;        // canopy, palm, hedge
  }
  const seen = cols.filter((v) => v !== null).sort((a, b) => a - b);
  const q = (p) => (seen.length ? seen[Math.floor((seen.length - 1) * p)] : null);
  const f = (v) => +(v / (nb || 1)).toFixed(3);
  return {
    file: typeof src === 'string' ? path.basename(src) : '(in memory)', w, h,
    skyFrac: +(open / w).toFixed(3),
    clippedFrac: +(clipped / w).toFixed(3),
    p10: q(0.1), p50: q(0.5), p90: q(0.9),
    health,
    confidence: { softFrac: f(soft), thinFrac: f(thin), whiteFrac: f(white), foliageFrac: f(foliage), skyBelowMean: f(belowSum) },
    cols,
  };
}

const fmt = (v) => (v === null ? '  -  ' : `${v >= 0 ? ' ' : ''}${v.toFixed(1)}`);
const line = (label, r) => `  ${label.padEnd(9)} p10 ${fmt(r.p10)}  p50 ${fmt(r.p50)}  p90 ${fmt(r.p90)}   `
  + `sky-to-ground ${(r.skyFrac * 100).toFixed(0)}%  no-sky ${(r.clippedFrac * 100).toFixed(0)}%`;
const conf = (label, r) => `  ${label.padEnd(9)} soft ${(r.confidence.softFrac * 100).toFixed(0).padStart(3)}%  `
  + `thin ${(r.confidence.thinFrac * 100).toFixed(0).padStart(3)}%  sky-below ${(r.confidence.skyBelowMean * 100).toFixed(0).padStart(3)}%  `
  + `white ${(r.confidence.whiteFrac * 100).toFixed(0).padStart(3)}%  foliage ${(r.confidence.foliageFrac * 100).toFixed(0).padStart(3)}%`;

// --------------------------------------------------------------- provenance
//
// Getting this wrong is silent: the numbers come out fine, they are just answers
// about the previous build. It happened on 2026-09-02 - a before/after came back
// identical to three decimals because the "before" run had measured the "after"
// frames - so pano-match now stamps its index.json with the district.json it
// rendered from, and this reads that stamp. Nothing read it before.
//
// Four things are checked, and all four were unchecked when this was mtime-only:
//   * the world - size AND mtime of data/district.json, against the stamp
//   * the CAMERA the frames were captured with, against this file's row scale
//   * COMPLETENESS - every frame the stamp claims must be on disk, and the set
//     being measured must be the stamped set, not whatever the glob found
//   * the REFERENCE side - reference/sarasota/mapillary/views/ is generated by
//     reproject-pano.mjs from data/district.json's meta.route, so a view older
//     than that file may be aimed down a street the route no longer follows
export function provenance(time, pairs) {
  const bad = [];
  const ixf = path.join(REN, 'index.json');
  if (!fs.existsSync(ixf)) {
    return { ok: false, bad: [`${ixf} is missing: there is no record of what world these frames were rendered from.`] };
  }
  const ix = JSON.parse(fs.readFileSync(ixf, 'utf8'));

  if (ix.time !== time) {
    bad.push(`${ixf} describes the "${ix.time}" run, not "${time}". Frames for another time of day `
      + 'are in this directory with no record of the world they came from. Re-run pano-match with '
      + `PM_TIME=${time}.`);
  }
  for (const [k, want] of [['eye', CAM.eye], ['pitchDeg', CAM.pitchDeg], ['hfovDeg', CAM.hfovDeg]]) {
    if (ix[k] !== undefined && Math.abs(ix[k] - want) > 1e-9) {
      bad.push(`captured with ${k} ${ix[k]}, this instrument's row scale assumes ${want}. `
        + 'Every angle read off these frames would be wrong by a constant.');
    }
  }
  if (ix.pageErrors?.length) {
    bad.push(`the capture logged ${ix.pageErrors.length} page error(s): ${ix.pageErrors.slice(0, 2).join(' | ')}`);
  }

  const ds = fs.statSync('data/district.json');
  const st = ix.district;
  if (!st) {
    bad.push(`${ixf} carries no district stamp - it predates the stamping, so these frames cannot be tied to a world.`);
  } else if (st.size !== ds.size) {
    bad.push(`data/district.json has CHANGED since the capture: ${st.size} bytes then, ${ds.size} now. `
      + 'These frames answer about the previous build.');
  } else if (st.sha256 && st.sha256 !== worldHash()) {
    bad.push(`data/district.json's CONTENT has changed since the capture (sha256 ${st.sha256} then, `
      + `${worldHash()} now). Re-run tools/pano-match.mjs.`);
  } else if (st.sha256) {
    // Content matches, so mtime is irrelevant. This is the case a hash exists to
    // rescue: a re-bake that only rewrote meta.baked's date moves mtime and
    // rewrites the file while leaving every byte of geometry identical.
  } else if (st.mtime !== ds.mtime.toISOString()) {
    bad.push(`data/district.json was written at ${ds.mtime.toISOString()}, the capture recorded `
      + `${st.mtime}. The size is identical (${ds.size}), so this is more likely a touch than a re-bake - `
      + 'but the stamp carries no content hash, so it cannot be told apart from one. Re-run pano-match.');
  }

  // Completeness. The old guard looked only at the frames it happened to find,
  // so a directory missing half a run measured the half that was there.
  const stamped = (ix.frames ?? []).map((f) => `${f.id}-${f.side}`);
  const asked = pairs.map(([id, side]) => `${id}-${side}`);
  const missing = stamped.filter((k) => !fs.existsSync(path.join(REN, `${k}-${time}.png`)));
  if (missing.length) bad.push(`${missing.length} of ${stamped.length} stamped frames are not on disk: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' ...' : ''}`);
  const extra = asked.filter((k) => !stamped.includes(k));
  if (extra.length) bad.push(`${extra.length} frame(s) on disk are not in the capture index: ${extra.slice(0, 4).join(', ')}. Provenance unknown.`);

  // The reference side, which nothing checked before.
  if (!fs.existsSync(REF)) {
    bad.push(`${REF} is missing. Run tools/reproject-pano.mjs --facades.`);
  } else {
    const missingRef = asked.filter((k) => !fs.existsSync(path.join(REF, `${k}.png`)));
    if (missingRef.length) bad.push(`${missingRef.length} reference view(s) missing: ${missingRef.slice(0, 4).join(', ')}`);
    const staleRef = asked.filter((k) => {
      const f = path.join(REF, `${k}.png`);
      return fs.existsSync(f) && fs.statSync(f).mtimeMs < ds.mtimeMs;
    });
    if (staleRef.length) {
      bad.push(`${staleRef.length} of ${asked.length} reference views predate data/district.json. `
        + 'reproject-pano.mjs aims them from meta.route, so a view older than the route may be looking '
        + 'down a different street than the frame it is subtracted from. Re-run tools/reproject-pano.mjs --facades.');
    }
  }
  return { ok: bad.length === 0, bad };
}

// ---------------------------------------------------------------- self-test
//
// The rule this project paid for: verify an instrument can produce the OPPOSITE
// reading before trusting a null result. The degenerate-frame guard is only worth
// anything if a black frame is refused AND a real frame is not, so both halves
// run here and both have to fire.
function selftest() {
  let bad = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const fail = (m) => { console.log(`  FAIL  ${m}`); bad++; };
  const synth = (w, h, fn) => {
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const i = (y * w + x) * 3; data[i] = r; data[i + 1] = g; data[i + 2] = b; }
    return { width: w, height: h, channels: 3, data };
  };

  const black = synth(128, 96, () => [3, 4, 5]);
  let threw = null;
  try { roofline(black); } catch (e) { threw = e.message; }
  if (threw) ok(`black frame refused: ${threw.slice(0, 70)}...`); else fail('black frame was MEASURED, not refused');
  const forced = roofline(black, { allowDegenerate: true });
  forced.p50 === elevOf(0, 96) && forced.clippedFrac === 1
    ? ok(`... and forcing it does give the maximum reading (p50 ${forced.p50.toFixed(1)}, no-sky 100%), which is what makes it dangerous`)
    : fail(`forced black frame gave p50 ${forced.p50}, expected the top of frame`);

  // All sky, but with plenty of contrast so it is refused for being ALL SKY and
  // not merely for being flat - otherwise this half of the test proves nothing.
  const allsky = synth(128, 96, (x, y) => [100 + ((y * 60 / 96) | 0), 120 + ((y * 60 / 96) | 0), 200 + ((y * 50 / 96) | 0)]);
  try { roofline(allsky); fail('a frame that is all sky was measured, not refused'); }
  catch (e) {
    /every pixel passes the sky test/.test(e.message)
      ? ok('all-sky frame refused for being all sky, not merely for being flat')
      : fail(`all-sky frame refused for the wrong reason: ${e.message}`);
  }

  // A frame the guard must NOT refuse: sky above, a wall below, at a known row.
  const cut = 40;
  const real = synth(128, 96, (x, y) => (y < cut ? [120, 150, 200] : [180, 160, 140]));
  try {
    const r = roofline(real);
    Math.abs(r.p50 - elevOf(cut, 96)) < 1e-9
      ? ok(`synthetic wall at row ${cut} measured at ${r.p50.toFixed(2)} deg, exactly elevOf(${cut})`)
      : fail(`synthetic wall measured ${r.p50}, expected ${elevOf(cut, 96)}`);
    r.confidence.softFrac === 0 && r.confidence.thinFrac === 0 && r.confidence.skyBelowMean === 0
      ? ok('confidence terms are 0 on a frame with one hard edge and solid wall beneath it')
      : fail(`confidence terms non-zero on a clean frame: ${JSON.stringify(r.confidence)}`);
  } catch (e) { fail(`a good frame was refused: ${e.message}`); }

  // And the failure the review found: a soft gradient with no edge at all must
  // come back flagged, not silently believed.
  const glow = synth(128, 96, (x, y) => {
    const t = y / 96;
    return [Math.round(150 + 90 * t), Math.round(160 + 85 * t), Math.round(200 + 40 * t)];
  });
  const g = roofline(glow, { allowDegenerate: true });
  g.p50 !== null && g.confidence.softFrac > 0.9
    ? ok(`a pure sky gradient reports a roofline of ${g.p50.toFixed(1)} deg and flags soft ${(g.confidence.softFrac * 100).toFixed(0)}% - the review's R-view failure, caught`)
    : fail(`sky gradient not flagged: p50 ${g.p50}, soft ${g.confidence.softFrac}`);

  // The other half of the provenance guard. A gate that only ever refuses is
  // indistinguishable from a gate that is stuck, so a well-formed tree is built
  // in a temp directory and has to PASS - then each field is broken in turn and
  // each break has to be caught.
  const cwd0 = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roofline-selftest-'));
  try {
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, REN), { recursive: true });
    fs.mkdirSync(path.join(tmp, REF), { recursive: true });
    const dj = path.join(tmp, 'data/district.json');
    fs.writeFileSync(dj, '{}');
    const px = new Uint8Array(3 * 4 * 3).fill(128);
    fs.writeFileSync(path.join(tmp, REN, 'X-L-golden.png'), Buffer.alloc(0));
    writePNG(path.join(tmp, REN, 'X-L-golden.png'), 3, 4, px);
    writePNG(path.join(tmp, REF, 'X-L.png'), 3, 4, px);
    const st0 = fs.statSync(dj);
    const stampFile = path.join(tmp, REN, 'index.json');
    const writeStamp = (over = {}) => fs.writeFileSync(stampFile, JSON.stringify({
      district: { mtime: st0.mtime.toISOString(), size: st0.size },
      time: 'golden', eye: CAM.eye, pitchDeg: CAM.pitchDeg, hfovDeg: CAM.hfovDeg,
      pageErrors: [], frames: [{ id: 'X', side: 'L' }], ...over,
    }));
    process.chdir(tmp);
    writeStamp();
    const good = provenance('golden', [['X', 'L']]);
    good.ok ? ok('a well-formed capture directory PASSES provenance')
      : fail(`a well-formed capture directory was refused: ${good.bad.join(' | ')}`);
    const breaks = [
      ['world changed', { district: { mtime: st0.mtime.toISOString(), size: st0.size + 1 } }],
      ['camera changed', { eye: 1.6 }],
      ['page errors', { pageErrors: ['TypeError: x'] }],
      ['incomplete run', { frames: [{ id: 'X', side: 'L' }, { id: 'Y', side: 'R' }] }],
      ['wrong time', { time: 'noon' }],
    ];
    for (const [name, over] of breaks) {
      writeStamp(over);
      provenance('golden', [['X', 'L']]).ok ? fail(`provenance accepted a tree with ${name}`) : ok(`refuses: ${name}`);
    }
    writeStamp();
    fs.utimesSync(path.join(tmp, REF, 'X-L.png'), 0, 0);        // reference older than the world
    provenance('golden', [['X', 'L']]).ok ? fail('provenance accepted a stale reference view') : ok('refuses: stale reference view');
  } finally {
    process.chdir(cwd0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bad;
}

// ---------------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(`${path.sep}roofline.mjs`)) {
  if (process.argv.includes('--selftest')) {
    console.log('roofline selftest');
    const bad = selftest();
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nall checks passed');
    process.exit(bad ? 1 : 0);
  }

  const all = process.argv.includes('--all');
  // `--time X`, or the third positional. It used to be argv[argv.length - 1],
  // which made `roofline.mjs --all` read the time as "--all", match no file,
  // measure an EMPTY set, print nothing, write roofline---all.json and exit 0.
  const ti = process.argv.indexOf('--time');
  const time = ti >= 0 ? process.argv[ti + 1] : (all ? undefined : process.argv[4]);
  if (!time || time.startsWith('--')) {
    console.error('usage: roofline.mjs <id> <L|R> <time>   |   roofline.mjs --all --time <time>');
    console.error('       roofline.mjs --selftest');
    console.error('a time of day is required: it names the frames to measure and there is no default.');
    process.exit(2);
  }

  const pairs = [];
  if (all) {
    for (const f of fs.readdirSync(REN).filter((n) => n.endsWith(`-${time}.png`))) {
      const [id, side] = f.replace(`-${time}.png`, '').split('-');
      pairs.push([id, side]);
    }
  } else {
    if (!process.argv[2] || !process.argv[3]) { console.error('usage: roofline.mjs <id> <L|R> <time>'); process.exit(2); }
    pairs.push([process.argv[2], process.argv[3]]);
  }
  if (!pairs.length) {
    console.error(`REFUSING TO MEASURE: no frames matching *-${time}.png in ${REN}.`);
    console.error('An empty set is not a result. Run tools/pano-match.mjs first.');
    process.exit(2);
  }

  const prov = provenance(time, pairs);
  if (!prov.ok) {
    console.error(`REFUSING TO MEASURE: ${prov.bad.length} provenance problem(s).\n`);
    for (const b of prov.bad) console.error(`  - ${b}`);
    console.error('\nA stale or unaccounted-for frame answers about a different build, and the answer looks fine.');
    console.error('tools/roofline-analytic.mjs measures the built side straight from data/district.json and needs no capture.');
    process.exit(3);
  }

  console.log(`camera: eye ${CAM.eye} m, pitch ${PITCH} deg, hfov ${HFOV} on ${ASPECT.toFixed(3)} -> vfov ${VFOV.toFixed(1)}`);
  console.log('roofline elevation above the horizon, degrees. higher = taller streetwall.');
  console.log('confidence, per boundary this detector chose: soft = no colour step across it (it may have');
  console.log('stopped inside a gradient); thin = under 12 rows deep (a wire, a twig, a cloud edge);');
  console.log('sky-below = sky still found under it; white/foliage = what it stopped on.\n');
  const rows = [];
  const refused = [];
  for (const [id, side] of pairs.sort()) {
    const rf = path.join(REF, `${id}-${side}.png`);
    const rn = path.join(REN, `${id}-${side}-${time}.png`);
    if (!fs.existsSync(rf) || !fs.existsSync(rn)) continue;
    let a, b;
    try { a = roofline(rf); b = roofline(rn); }
    catch (e) { refused.push(`${id} ${side}: ${e.message}`); continue; }
    console.log(`${id} ${side}`);
    console.log(line('reference', a));
    console.log(conf('  ', a));
    for (const wmsg of a.health.warn) console.log(`  reference WARNING: ${wmsg}`);
    console.log(line('built', b));
    console.log(conf('  ', b));
    for (const wmsg of b.health.warn) console.log(`  built     WARNING: ${wmsg}`);
    const d = a.p50 !== null && b.p50 !== null ? b.p50 - a.p50 : null;
    console.log(`  ${d === null ? 'delta    n/a' : `delta     p50 ${d > 0 ? '+' : ''}${d.toFixed(1)} deg  (built is ${d > 0 ? 'TALLER' : 'shorter'})`}\n`);
    rows.push({ id, side,
      reference: { p10: a.p10, p50: a.p50, p90: a.p90, skyFrac: a.skyFrac, clippedFrac: a.clippedFrac, confidence: a.confidence },
      built: { p10: b.p10, p50: b.p50, p90: b.p90, skyFrac: b.skyFrac, clippedFrac: b.clippedFrac, confidence: b.confidence },
      deltaP50: d });
  }
  if (refused.length) {
    console.error(`REFUSING TO MEASURE: ${refused.length} degenerate frame(s).`);
    for (const r of refused) console.error(`  - ${r}`);
    process.exit(3);
  }
  if (rows.length > 1) {
    const ds = rows.map((r) => r.deltaP50).filter((v) => v !== null).sort((a, b) => a - b);
    console.log(`${rows.length} pairs.  delta p50: min ${ds[0]?.toFixed(1)}  median ${ds[Math.floor(ds.length / 2)]?.toFixed(1)}  max ${ds[ds.length - 1]?.toFixed(1)}`);
    console.log(`taller in ${ds.filter((v) => v > 0).length} of ${ds.length}`);
    const m = (side, k) => {
      const v = rows.filter((r) => r.side === side).map((r) => r.built.confidence[k]);
      return v.length ? `${(v.reduce((s, x) => s + x, 0) / v.length * 100).toFixed(0)}%` : ' -';
    };
    console.log(`built-side soft boundaries: L ${m('L', 'softFrac')}  R ${m('R', 'softFrac')}`
      + '   a large L/R gap is the glow failure; cross-check with tools/roofline-analytic.mjs.');
  }
  fs.writeFileSync(path.join(REN, `roofline-${time}.json`), JSON.stringify({
    camera: { ...CAM, vfovDeg: +VFOV.toFixed(2) },
    detector: 'sky = b>90 && b>=g && b>r+6 && mean>85',
    caveat: 'a colour test, not geometry. see tools/roofline-analytic.mjs for the built side.',
    pairs: rows,
  }, null, 1));
}
