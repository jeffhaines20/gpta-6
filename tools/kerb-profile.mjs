// Measure the street edge the way the reviewer did, but at a KNOWN place.
//
// The finding this exists to settle was "at corridor y=700, x1120->1200 the
// profile falls monotonically 113.6 -> 63.9: no gutter line, no kerb face, no
// shadow at its base". A fixed pixel row is the right kind of measurement and
// the wrong instrument for a before/after: it measures whatever happens to be
// under those pixels, and one prop moving invalidates it. So this walks the
// section in WORLD space — from 3 m out in the carriageway to 3 m back on the
// pavement, across a named kerb station — projects it into the frame with the
// camera's own matrices, and samples the luminance along that line.
//
// What it reports per profile:
//   monotone     the fraction of the run that moves the same way. 1.00 is the
//                defect: a ramp from paving to asphalt with nothing between.
//   reversals    significant turning points. A kerb makes at least two: the
//                pan is brighter than both the road and the shadow at the face.
//   faceDrop     the darkest local minimum inside the face band, against the
//                brighter of its two shoulders. This is "the shadow at its base".
//   panLift      the brightest local maximum in the gutter band against the
//                carriageway. This is the gutter line.
//
//   node tools/kerb-profile.mjs --selftest
//   node tools/kerb-profile.mjs [--port 8411] [--tag kerb] [--before sar]
//
// readPNG returns `channels`, and it is 3 for these screenshots, not 4. A
// hardcoded 4-byte stride misaligns every sample and reads NaN off the end of
// the buffer in the bottom quarter of the frame — and NaN fails every
// comparison, so the corrupted rows report "no difference" rather than an error.
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const ARGS = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
};

// ------------------------------------------------------------------ analysis
// Pure, so the selftest can drive it with profiles whose answer is known.

/**
 * @param {{o:number, lum:number}[]} s  luminance against metres across the
 *   section: o < 0 is the pavement, o > 0 the carriageway.
 */
export function analyse(s, opts = {}) {
  const noise = opts.noise ?? 3.0;          // luminance below this is not a feature
  const n = s.length;
  if (n < 8) return { ok: false, reason: 'too few samples' };

  // Monotone fraction: of the steps that move at all, how many move the way the
  // majority does. A featureless ramp is 1.00.
  let up = 0, down = 0;
  for (let i = 1; i < n; i++) {
    const d = s[i].lum - s[i - 1].lum;
    if (d > 0.5) up++; else if (d < -0.5) down++;
  }
  const moved = up + down;
  const monotone = moved ? Math.max(up, down) / moved : 1;

  // Turning points that clear the noise floor on both sides.
  const ext = [];
  for (let i = 1; i < n - 1; i++) {
    let j = i;
    while (j < n - 1 && Math.abs(s[j + 1].lum - s[i].lum) < 0.25) j++;
    const a = s[i - 1].lum, b = s[i].lum, c = s[Math.min(n - 1, j + 1)].lum;
    const isMax = b >= a && b >= c && (b - Math.min(a, c)) > noise;
    const isMin = b <= a && b <= c && (Math.max(a, c) - b) > noise;
    if (isMax || isMin) ext.push({ o: s[i].o, lum: b, kind: isMax ? 'max' : 'min' });
    i = j;
  }
  // Collapse runs of the same kind, keeping the strongest.
  const rev = [];
  for (const e of ext) {
    const last = rev[rev.length - 1];
    if (last && last.kind === e.kind) {
      if ((e.kind === 'max' && e.lum > last.lum) || (e.kind === 'min' && e.lum < last.lum)) {
        rev[rev.length - 1] = e;
      }
    } else rev.push(e);
  }

  const band = (a, b) => s.filter((p) => p.o >= a && p.o <= b);
  const maxOf = (l) => (l.length ? Math.max(...l.map((p) => p.lum)) : NaN);
  const mean = (l) => (l.length ? l.reduce((a, p) => a + p.lum, 0) / l.length : NaN);

  // faceDrop and panLift are read off the TURNING POINTS, not off the band
  // extremes. Band extremes make a plain ramp score as a kerb: the darkest
  // sample in the face band of a monotonic fall is simply its far end, and
  // subtracting the bright end of the ramp reports a 41-point "shadow" that is
  // not there. A feature has to be darker (or brighter) than BOTH its shoulders
  // to count, which is what a turning point means.
  const inBand = (e, a, b) => e.o >= a && e.o <= b;
  const faceExt = rev.filter((e) => e.kind === 'min' && inBand(e, -0.14, 0.16));
  const panExt = rev.filter((e) => e.kind === 'max' && inBand(e, 0.05, 0.95));
  const shoulderL = maxOf(band(-0.75, -0.16));
  const shoulderR = maxOf(band(0.18, 0.90));
  const road = mean(band(1.8, 3.0));
  const faceMin = faceExt.length ? Math.min(...faceExt.map((e) => e.lum)) : NaN;
  const panMax = panExt.length ? Math.max(...panExt.map((e) => e.lum)) : NaN;

  return {
    ok: true,
    samples: n,
    monotone: +monotone.toFixed(3),
    reversals: rev.length,
    faceDrop: faceExt.length ? +(Math.min(shoulderL, shoulderR) - faceMin).toFixed(1) : 0,
    panLift: panExt.length ? +(panMax - road).toFixed(1) : 0,
    range: [+Math.min(...s.map((p) => p.lum)).toFixed(1),
      +Math.max(...s.map((p) => p.lum)).toFixed(1)],
    extrema: rev.map((e) => `${e.kind}@${e.o.toFixed(2)}m=${e.lum.toFixed(1)}`),
  };
}

/** Sample luminance along an image-space line, in world-offset order. */
export function sampleLine(img, p0, p1, o0, o1, steps = 160) {
  const out = [];
  const { width, height, channels, data } = img;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const x = Math.round(p0[0] + (p1[0] - p0[0]) * f);
    const y = Math.round(p0[1] + (p1[1] - p0[1]) * f);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const k = (y * width + x) * channels;      // channels, NOT 4
    out.push({ o: o0 + (o1 - o0) * f, x, y,
      lum: 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2] });
  }
  return out;
}

// ------------------------------------------------------------------ selftest
function selftest() {
  const fails = [];
  const mk = (fn) => {
    const s = [];
    for (let i = 0; i <= 160; i++) { const o = -1.5 + (4.5 * i) / 160; s.push({ o, lum: fn(o) }); }
    return s;
  };
  // KNOWN BAD: the defect itself — brick at 113.6 falling monotonically to
  // asphalt at 63.9 across a single seam, which is what the reviewer measured.
  const flat = analyse(mk((o) => 113.6 + (63.9 - 113.6) * Math.min(1, Math.max(0, (o + 0.2) / 0.4))));
  if (flat.monotone < 0.999) fails.push(`ramp should be monotone 1.000, got ${flat.monotone}`);
  if (flat.reversals !== 0) fails.push(`ramp should have 0 reversals, got ${flat.reversals}`);
  if (flat.faceDrop > 1) fails.push(`ramp should show no face, got faceDrop ${flat.faceDrop}`);

  // KNOWN GOOD: pavement, kerb top, a dark face, a bright pan, then asphalt.
  const kerb = analyse(mk((o) => {
    if (o < -0.19) return 112;          // brick pavement
    if (o < -0.02) return 122;          // pale kerb top
    if (o < 0.10) return 58;            // the face, in its own shadow
    if (o < 0.75) return 138;           // the concrete gutter pan
    return 78;                          // asphalt
  }));
  if (kerb.reversals < 2) fails.push(`kerb should show >= 2 reversals, got ${kerb.reversals}`);
  if (kerb.faceDrop < 40) fails.push(`kerb faceDrop should be >= 40, got ${kerb.faceDrop}`);
  if (kerb.panLift < 40) fails.push(`kerb panLift should be >= 40, got ${kerb.panLift}`);
  if (flat.panLift > 1) fails.push(`ramp should show no gutter, got panLift ${flat.panLift}`);
  if (kerb.monotone > 0.9) fails.push(`kerb should not be monotone, got ${kerb.monotone}`);

  // KNOWN BAD: noise alone must not be reported as a kerb.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noisy = analyse(mk(() => 90 + (rnd() - 0.5) * 4));
  if (noisy.faceDrop > 3.5) fails.push(`+-2 noise should not read as a face, got ${noisy.faceDrop}`);

  // sampleLine must use the PNG's own stride. A 3-channel image read at 4 bytes
  // per pixel walks off the end and yields NaN, which compares false against
  // everything and silently reports "no difference".
  const img = { width: 4, height: 2, channels: 3,
    data: new Uint8Array([0, 0, 0, 10, 10, 10, 20, 20, 20, 30, 30, 30,
      40, 40, 40, 50, 50, 50, 60, 60, 60, 70, 70, 70]) };
  const line = sampleLine(img, [0, 1], [3, 1], -1, 1, 3);
  const want = [40, 50, 60, 70];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(line[i].lum - want[i]) > 0.001) {
      fails.push(`sampleLine row 1 sample ${i}: got ${line[i].lum}, want ${want[i]}`);
    }
  }
  if (line.some((p) => Number.isNaN(p.lum))) fails.push('sampleLine produced NaN');

  if (fails.length) {
    console.log('KERB-PROFILE SELFTEST: FAIL');
    for (const f of fails) console.log('   ', f);
    process.exit(1);
  }
  console.log('KERB-PROFILE SELFTEST: PASS — flat ramp reads as no kerb, ' +
    'a kerb section reads as a kerb, noise reads as neither, stride is honoured');
  process.exit(0);
}
if (ARGS.includes('--selftest')) selftest();


// ------------------------------------------------------------------ capture
//
// The control is the SAME build with ?kerbs=0, not an older committed capture.
// The first attempt compared against docs/shots/sar-* and measured a parked car
// that had moved: same camera, different frame, and the profile was of a car
// door. One page, two loads, one thing different.
//
// And the profile is a MEDIAN over a band of parallel sections a metre apart
// along the kerb, not one line. A single line samples whatever pedestrian, crack
// or lamp post happens to lie on it; the median of nine survives all three.
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');
const { SHOTS, placeCamera, describe } = await import('./framing.mjs');

const PORT = Number(arg('port', process.env.HERO_PORT ?? 8411));
const TAG = arg('tag', 'kerb');
const SHOT = arg('shot', 'corridor');
const TIMES = arg('times', 'golden,dusk').split(',');
const SETTLE = Number(arg('settle', 15000));
const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const O0 = -0.9, O1 = 3.0, LINES = 9, SPACING = 0.7;

/** Median profile over the band, resampled onto a common offset axis. */
function medianBand(img, lines) {
  const STEPS = 130;
  const out = [];
  for (let i = 0; i <= STEPS; i++) {
    const o = O0 + ((O1 - O0) * i) / STEPS;
    const f = i / STEPS;
    const v = [];
    for (const L of lines) {
      const x = Math.round(L.p0[0] + (L.p1[0] - L.p0[0]) * f);
      const y = Math.round(L.p0[1] + (L.p1[1] - L.p0[1]) * f);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const k = (y * img.width + x) * img.channels;   // channels, NOT 4
      v.push(0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2]);
    }
    if (!v.length) continue;
    v.sort((a, b) => a - b);
    out.push({ o, lum: v[v.length >> 1] });
  }
  return out;
}

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const rows = [];
let probe = null;

for (const kerbs of [1, 0]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/?kerbs=${kerbs}`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
  await page.addStyleTag({ content: '#attr{display:none!important}' });
  await page.addStyleTag({ content: '#hud,.pv-hud{display:none!important}' });
  const placed = await page.evaluate(placeCamera, SHOTS[SHOT]);
  console.log(`kerbs=${kerbs} ${describe(SHOT, placed)}`);
  await page.waitForTimeout(14000);

  // The band is chosen on the WITH-kerb load and reused, so both builds are
  // measured across the same piece of ground.
  if (!probe) {
    probe = await page.evaluate(({ o0, o1, lines, spacing }) => {
      const cam = __district.camera;
      cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements;
      const project = (x, y, z) => {
        const vx = V[0] * x + V[4] * y + V[8] * z + V[12];
        const vy = V[1] * x + V[5] * y + V[9] * z + V[13];
        const vz = V[2] * x + V[6] * y + V[10] * z + V[14];
        const vw = V[3] * x + V[7] * y + V[11] * z + V[15];
        const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12] * vw;
        const cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13] * vw;
        const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15] * vw;
        return [((cx / cw) * 0.5 + 0.5) * 1600, ((-cy / cw) * 0.5 + 0.5) * 900];
      };
      const plan = __district.world.kerbPlan;
      const m = cam.matrixWorld.elements;
      let fx = -m[8], fz = -m[10];
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      const cx = cam.position.x, cz = cam.position.z;
      // The longest straight run whose middle is 14-26 m ahead and well inside
      // the frame: near enough that a 140 mm face is several pixels, far enough
      // that the section is not foreshortened into one.
      let best = null;
      const rejected = { short: 0, range: 0, behind: 0, offscreen: 0 };
      for (const sides of plan.edgeRuns) {
        if (!sides) continue;
        for (const pieces of sides) for (const run of pieces) {
          if (run.fanX !== undefined || run.length < 2) continue;
          for (let i = 0; i + 1 < run.length; i++) {
            const a = run[i], b = run[i + 1];
            const seg = Math.hypot(b.x - a.x, b.z - a.z);
            if (seg < 3 * spacing) { rejected.short++; continue; }
            const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
            const dist = Math.hypot(mx - cx, mz - cz);
            if (dist < 8 || dist > 45) { rejected.range++; continue; }
            if (((mx - cx) * fx + (mz - cz) * fz) / dist < 0.5) { rejected.behind++; continue; }
            const p = project(mx, -0.045, mz);
            if (p[0] < 150 || p[0] > 1450 || p[1] < 80 || p[1] > 880) { rejected.offscreen++; continue; }
            // Long, near the middle distance, and square-on to the camera: a
            // section seen end-on is one pixel wide however good the kerb is.
            const square = 1 - Math.abs(((b.x - a.x) * fx + (b.z - a.z) * fz) / seg);
            const score = Math.min(seg, 12) - Math.abs(dist - 18) * 0.4 + square * 8;
            if (!best || score > best.score) best = { a, b, seg, dist, score, mx, mz };
          }
        }
      }
      if (!best) return { rejected };
      const { a, b, seg } = best;
      const n = Math.max(3, Math.min(lines, Math.floor(seg / spacing)));
      const ux = (b.x - a.x) / seg, uz = (b.z - a.z) / seg;
      const t0 = seg / 2 - ((n - 1) * spacing) / 2;
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = t0 + i * spacing;
        const f = t / seg;
        const sx = a.x + ux * t, sz = a.z + uz * t;
        let nx = a.nx + (b.nx - a.nx) * f, nz = a.nz + (b.nz - a.nz) * f;
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        out.push({
          p0: project(sx + nx * o0, -0.05, sz + nz * o0),
          p1: project(sx + nx * o1, 0.02, sz + nz * o1),
        });
      }
      return { lines: out, x: +best.mx.toFixed(2), z: +best.mz.toFixed(2),
        dist: +best.dist.toFixed(1), seg: +best.seg.toFixed(1), rejected };
    }, { o0: O0, o1: O1, lines: LINES, spacing: SPACING });
    if (!probe || !probe.lines) {
      console.log('no kerb run in view; rejected', JSON.stringify(probe && probe.rejected));
      await browser.close(); process.exit(1);
    }
    console.log(`band: ${probe.lines.length} sections ${SPACING} m apart across a ` +
      `${probe.seg} m run at (${probe.x}, ${probe.z}), ${probe.dist} m from the ${SHOT} camera` +
      `; rejected ${JSON.stringify(probe.rejected)}`);
  }

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(SETTLE);
    const file = `${OUT}/${TAG}-${kerbs ? 'after' : 'before'}-${SHOT}-${tod}.png`;
    await page.screenshot({ path: file, timeout: 240000 });
    const s = medianBand(readPNG(file), probe.lines);
    rows.push({ tod, which: kerbs ? 'after  (kerb)' : 'before (no kerb)', file, ...analyse(s),
      profile: s.map((p) => [+p.o.toFixed(3), +p.lum.toFixed(1)]) });
    console.log('shot', file);
  }
  if (errors.length) console.log(`kerbs=${kerbs} page errors:`, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}
await browser.close();

console.log(`\nPROFILE ACROSS THE STREET EDGE — median of ${probe.lines.length} sections ` +
  `${SPACING} m apart,\n` +
  `at (${probe.x}, ${probe.z}), ${probe.dist} m from the ${SHOT} camera. ` +
  `o < 0 is pavement, o > 0 carriageway.\n`);
console.log('  time    build              monotone  reversals  faceDrop  panLift  range');
for (const r of rows) {
  console.log(`  ${r.tod.padEnd(7)} ${r.which.padEnd(18)} ${String(r.monotone).padStart(8)} ` +
    `${String(r.reversals).padStart(10)} ${String(r.faceDrop).padStart(9)} ` +
    `${String(r.panLift).padStart(8)}  ${JSON.stringify(r.range)}`);
}
console.log('');
for (const r of rows) {
  const at = (o) => {
    let best = r.profile[0];
    for (const p of r.profile) if (Math.abs(p[0] - o) < Math.abs(best[0] - o)) best = p;
    return best[1].toFixed(1);
  };
  console.log(`  ${r.tod}/${r.which}  pavement(-0.60) ${at(-0.6)}  top(-0.10) ${at(-0.1)}  ` +
    `face(0.02) ${at(0.02)}  pan(0.40) ${at(0.4)}  lane(1.60) ${at(1.6)}  road(2.80) ${at(2.8)}`);
}
fs.writeFileSync(`docs/${TAG}-profile.json`, JSON.stringify({ probe, rows }, null, 1));
console.log(`\nwrote docs/${TAG}-profile.json`);
