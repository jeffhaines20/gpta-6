// Measure the street edge the way the reviewer did, but at a KNOWN place.
//
// The finding this exists to settle was "at corridor y=700, x1120->1200 the
// profile falls monotonically 113.6 -> 63.9: no gutter line, no kerb face, no
// shadow at its base". A fixed pixel row is the right KIND of measurement and
// the wrong instrument for a before/after: it measures whatever happens to be
// under those pixels, and one parked car moving invalidates it. So this walks
// the section in WORLD space -- from 3.2 m out in the carriageway to 1.6 m back
// on the pavement, across a kerb line chosen from the baked graph -- projects it
// into the frame with the camera's own matrices, and samples luminance along it.
//
// `u` is metres from where the kerb FACE stands: u < 0 is the carriageway side,
// u > 0 the pavement. The face is at u = 0 whether or not a kerb is drawn there,
// so the two arms are measured across the same piece of ground.
//
// What it reports per profile:
//   monotone     the fraction of steps that move the way the majority does.
//                1.00 is the defect: a ramp from paving to asphalt with nothing
//                between.
//   reversals    turning points that clear the noise floor on both sides. A kerb
//                makes at least two: the pan is brighter than the asphalt and
//                the foot of the face is darker than both.
//   faceDrop     the darkest local minimum inside the face band, against the
//                brighter of its two shoulders. This is "the shadow at its base".
//   panLift      the brightest local maximum in the gutter band against the
//                carriageway mean. This is the gutter line.
//
//   node tools/kerb-profile.mjs --selftest
//   node tools/kerb-profile.mjs [--port 8411] [--tag k1] [--shot corridor]
//                               [--times golden,noon,dusk]
//
// readPNG returns `channels`, and it is 3 for these screenshots, not 4. A
// hardcoded 4-byte stride misaligns every sample and reads off the end of the
// buffer in the bottom quarter of the frame -- and the NaN that produces fails
// every comparison, so the corrupted rows report "no difference" rather than an
// error. Every sample below multiplies by img.channels.
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const ARGS = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
};

// ------------------------------------------------------------------ analysis
// Pure, so the selftest can drive it with profiles whose answer is known.

/** @param {{u:number, lum:number}[]} s luminance against metres from the face. */
export function analyse(s, opts = {}) {
  const noise = opts.noise ?? 3.0;          // a swing below this is not a feature
  const n = s.length;
  if (n < 8) return { ok: false, reason: 'too few samples' };

  let up = 0, down = 0;
  for (let i = 1; i < n; i++) {
    const d = s[i].lum - s[i - 1].lum;
    if (d > 0.5) up++; else if (d < -0.5) down++;
  }
  const moved = up + down;
  const monotone = moved ? Math.max(up, down) / moved : 1;

  // Turning points, found with hysteresis rather than by comparing neighbours.
  //
  // The neighbour test credits the FLAT START OF A RAMP as a minimum: at the
  // first interior sample the left shoulder is the sample before it, which on a
  // plateau is the same value, so `b <= a` holds trivially and the ramp that
  // follows supplies the swing. Measured on the reviewer's own profile -- brick
  // falling monotonically to asphalt -- that reported one reversal on a curve
  // with none, which is the single most important thing this instrument must
  // get right.
  //
  // Hysteresis has no such boundary: an extremum is only reported once the
  // signal has BOTH arrived at it by more than `noise` and left it by more than
  // `noise`. `mode` starts unknown, so the first excursion establishes the
  // direction without inventing an extremum at the start of the series.
  const rev = [];
  {
    let mn = s[0], mx = s[0], mode = 0;
    for (const p of s) {
      if (p.lum > mx.lum) mx = p;
      if (p.lum < mn.lum) mn = p;
      if (mode !== -1 && p.lum < mx.lum - noise) {
        if (mode === 1) rev.push({ u: mx.u, lum: mx.lum, kind: 'max' });
        mn = p; mode = -1;
      } else if (mode !== 1 && p.lum > mn.lum + noise) {
        if (mode === -1) rev.push({ u: mn.u, lum: mn.lum, kind: 'min' });
        mx = p; mode = 1;
      }
    }
  }

  const band = (a, b) => s.filter((p) => p.u >= a && p.u <= b);
  const maxOf = (l) => (l.length ? Math.max(...l.map((p) => p.lum)) : NaN);
  const mean = (l) => (l.length ? l.reduce((a, p) => a + p.lum, 0) / l.length : NaN);

  // faceDrop and panLift are read off the TURNING POINTS, not off band extremes.
  // Band extremes make a plain ramp score as a kerb: the darkest sample in the
  // face band of a monotonic fall is simply its far end, and subtracting the
  // bright end of the ramp reports a large "shadow" that is not there. A feature
  // has to be darker (or brighter) than BOTH its shoulders to count, which is
  // what a turning point means.
  const inBand = (e, a, b) => e.u >= a && e.u <= b;
  const faceExt = rev.filter((e) => e.kind === 'min' && inBand(e, -0.20, 0.12));
  const panExt = rev.filter((e) => e.kind === 'max' && inBand(e, -0.60, 0.10));
  const shoulderL = maxOf(band(-0.80, -0.22));
  const shoulderR = maxOf(band(0.14, 0.70));
  const road = mean(band(-3.0, -1.4));
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
    extrema: rev.map((e) => `${e.kind}@${e.u.toFixed(2)}m=${e.lum.toFixed(1)}`),
  };
}

/** Sample luminance along an image-space line, in world-offset order. */
export function sampleLine(img, p0, p1, u0, u1, steps = 160) {
  const out = [];
  const { width, height, channels, data } = img;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const x = Math.round(p0[0] + (p1[0] - p0[0]) * f);
    const y = Math.round(p0[1] + (p1[1] - p0[1]) * f);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const k = (y * width + x) * channels;      // channels, NOT 4
    out.push({ u: u0 + (u1 - u0) * f, x, y,
      lum: 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2] });
  }
  return out;
}

// ------------------------------------------------------------------ selftest
if (ARGS.includes('--selftest')) {
  const fails = [];
  const mk = (fn) => {
    const s = [];
    for (let i = 0; i <= 160; i++) { const u = -3.2 + (4.8 * i) / 160; s.push({ u, lum: fn(u) }); }
    return s;
  };
  // KNOWN BAD: the defect itself. Brick at 113.6 falling monotonically to
  // asphalt at 63.9 across a single seam, which is what the reviewer measured.
  const flat = analyse(mk((u) => 113.6 + (63.9 - 113.6) * Math.min(1, Math.max(0, (0.2 - u) / 0.4))));
  if (flat.monotone < 0.999) fails.push(`ramp should be monotone 1.000, got ${flat.monotone}`);
  if (flat.reversals !== 0) fails.push(`ramp should have 0 reversals, got ${flat.reversals}`);
  if (flat.faceDrop > 1) fails.push(`ramp should show no face, got faceDrop ${flat.faceDrop}`);
  if (flat.panLift > 1) fails.push(`ramp should show no gutter, got panLift ${flat.panLift}`);

  // KNOWN GOOD: asphalt, a bright concrete pan, a dark face, the kerb top, then
  // brick pavement.
  const kerb = analyse(mk((u) => {
    if (u < -0.55) return 78;           // asphalt parking lane
    if (u < -0.06) return 138;          // concrete gutter pan
    if (u < 0.06) return 58;            // the face, in its own shade
    if (u < 0.24) return 122;           // pale kerb top
    return 112;                         // brick pavement
  }));
  if (kerb.reversals < 2) fails.push(`kerb should show >= 2 reversals, got ${kerb.reversals}`);
  if (kerb.faceDrop < 40) fails.push(`kerb faceDrop should be >= 40, got ${kerb.faceDrop}`);
  if (kerb.panLift < 40) fails.push(`kerb panLift should be >= 40, got ${kerb.panLift}`);
  if (kerb.monotone > 0.9) fails.push(`kerb should not be monotone, got ${kerb.monotone}`);

  // KNOWN BAD: noise alone must not be reported as a kerb.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noisy = analyse(mk(() => 90 + (rnd() - 0.5) * 4));
  if (noisy.faceDrop > 3.5) fails.push(`+-2 noise should not read as a face, got ${noisy.faceDrop}`);

  // KNOWN BAD: a step in the WRONG PLACE - the road edge 2.5 m out, which is
  // exactly what the before arm has - must not be credited as a kerb.
  const wrongPlace = analyse(mk((u) => (u < -2.5 ? 68 : 118)));
  if (wrongPlace.faceDrop > 1) fails.push(`a seam at u=-2.5 should not read as a face, got ${wrongPlace.faceDrop}`);
  if (wrongPlace.panLift > 1) fails.push(`a seam at u=-2.5 should not read as a gutter, got ${wrongPlace.panLift}`);

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
  console.log('KERB-PROFILE SELFTEST: PASS -- a flat ramp reads as no kerb, a kerb section ' +
    'reads as a kerb,\n  noise reads as neither, a seam 2.5 m from the kerb line is not ' +
    'credited, and the PNG stride is honoured.');
  process.exit(0);
}

// ------------------------------------------------------------------- capture
//
// The control is the SAME build with ?kerbs=0, not an older committed capture:
// one page, two loads, one thing different. Comparing against a committed frame
// measures every unrelated thing that moved since, and this project has twice
// spent a review round on two arms that turned out to be the same commit.
//
// And the profile is a MEDIAN over a band of parallel sections along the kerb,
// not one line. A single line samples whatever pedestrian, crack or lamp post
// happens to lie on it; the median of nine survives all three.
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');
const { placeCamera, describe } = await import('./framing.mjs');
const { KERB, kerbedEdge } = await import('../src/kerb.js');

// The hero framings, taken from tools/hero-shots.mjs rather than from
// framing.mjs's SHOTS: hero-shots carries a long note explaining that the
// corridor camera used to interpolate waypoint 2 to waypoint 4 - a diagonal
// across blocks - and every `*-corridor-*` frame judged before 2026-09-05 was of
// a street called McAnsh Square. framing.mjs still holds the old constants.
// These are the ones the frames under review were actually shot with.
const SHOTS = {
  corridor: { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  fivepoints: { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
};

const PORT = Number(arg('port', process.env.HERO_PORT ?? 8411));
const TAG = arg('tag', 'kerb');
const SHOT = arg('shot', 'corridor');
const TIMES = arg('times', 'golden,noon,dusk').split(',');
const SETTLE = Number(arg('settle', 12000));
const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const U0 = -3.2, U1 = 1.6, LINES = 9, SPACING = 0.8, STEPS = 160;

function medianBand(img, lines) {
  const out = [];
  for (let i = 0; i <= STEPS; i++) {
    const u = U0 + ((U1 - U0) * i) / STEPS;
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
    out.push({ u, lum: v[v.length >> 1] });
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
  await page.waitForTimeout(10000);

  // The band is chosen on the WITH-kerb load and REUSED, so both arms are
  // measured across the same piece of ground. It is derived from the baked
  // graph, not from world.kerbPlan, so the same tool works on a build that has
  // no kerb at all -- which is what makes the before arm measurable.
  if (!probe) {
    probe = await page.evaluate(({ u0, u1, lines, spacing, face }) => {
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
      const d = __district.district;
      const m = cam.matrixWorld.elements;
      let fx = -m[8], fz = -m[10];
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      const cx = cam.position.x, cz = cam.position.z;
      let best = null;
      const rejected = { notKerbed: 0, short: 0, range: 0, behind: 0, offscreen: 0 };
      // The point on the kerb line 20 m in front of the lens, not the segment's
      // MIDPOINT. Main Street east is one 512 m polyline segment whose midpoint
      // is 200 m from the corridor camera, so scoring on midpoints rejected the
      // very street the camera is standing in and reported "no kerb line in
      // view" with 816 range rejections.
      const AIM = 20;
      const tx = cx + fx * AIM, tz = cz + fz * AIM;
      const want = 4 * spacing + 2;
      for (let ei = 0; ei < d.edges.length; ei++) {
        const e = d.edges[ei];
        if (!(e.r <= 5 && e.w >= 5.5)) { rejected.notKerbed++; continue; }
        for (let i = 0; i + 1 < e.v.length; i++) {
          const a = d.verts[e.v[i]], b = d.verts[e.v[i + 1]];
          const seg = Math.hypot(b.x - a.x, b.z - a.z);
          if (seg < want) { rejected.short++; continue; }
          const ux = (b.x - a.x) / seg, uz = (b.z - a.z) / seg;
          for (const side of [1, -1]) {
            // The kerb FACE line: w/2 out from the centreline, plus the section.
            const ox = -uz * side, oz = ux * side;
            const off = e.w / 2 + face;
            const lx = a.x + ox * off, lz = a.z + oz * off;
            // Nearest point on this side's kerb line to the aim point, held far
            // enough from the segment ends that the whole band fits on it.
            let t = (tx - lx) * ux + (tz - lz) * uz;
            t = Math.max(want / 2, Math.min(seg - want / 2, t));
            const mx = lx + ux * t, mz = lz + uz * t;
            const dist = Math.hypot(mx - cx, mz - cz);
            if (dist < 9 || dist > 45) { rejected.range++; continue; }
            if (((mx - cx) * fx + (mz - cz) * fz) / dist < 0.55) { rejected.behind++; continue; }
            const p = project(mx, 0, mz);
            if (p[0] < 180 || p[0] > 1420 || p[1] < 120 || p[1] > 860) { rejected.offscreen++; continue; }
            // Square-on and at the aim distance: a section seen end-on is one
            // pixel wide however good the kerb is.
            const square = 1 - Math.abs(ux * fx + uz * fz);
            const score = 20 - Math.abs(dist - AIM) * 0.5 + square * 10;
            if (!best || score > best.score) {
              best = { lx, lz, ux, uz, ox, oz, off, t, seg, dist, score, mx, mz, ei };
            }
          }
        }
      }
      if (!best) return { rejected };
      const n = Math.max(3, Math.min(lines, Math.floor(best.seg / spacing)));
      const t0 = best.t - ((n - 1) * spacing) / 2;
      const out = [];
      for (let i = 0; i < n; i++) {
        const t = t0 + i * spacing;
        const sx = best.lx + best.ux * t, sz = best.lz + best.uz * t;
        out.push({
          p0: project(sx + best.ox * u0, 0.02, sz + best.oz * u0),
          p1: project(sx + best.ox * u1, -0.05, sz + best.oz * u1),
        });
      }
      return { lines: out, edge: best.ei, x: +best.mx.toFixed(2), z: +best.mz.toFixed(2),
        dist: +best.dist.toFixed(1), seg: +best.seg.toFixed(1), rejected };
    }, { u0: U0, u1: U1, lines: LINES, spacing: SPACING, face: KERB.panOuter });
    if (!probe || !probe.lines) {
      console.log('no kerb line in view; rejected', JSON.stringify(probe && probe.rejected));
      await browser.close(); process.exit(1);
    }
    console.log(`band: ${probe.lines.length} sections ${SPACING} m apart across a ${probe.seg} m ` +
      `run of edge ${probe.edge} at (${probe.x}, ${probe.z}), ${probe.dist} m from the ${SHOT} camera`);
  }

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(SETTLE);
    const file = `${OUT}/${TAG}-${kerbs ? 'after' : 'before'}-${SHOT}-${tod}.png`;
    await page.screenshot({ path: file, timeout: 240000 });
    const s = medianBand(readPNG(file), probe.lines);
    rows.push({ tod, which: kerbs ? 'after  (kerb)' : 'before (no kerb)', file, ...analyse(s),
      profile: s.map((p) => [+p.u.toFixed(3), +p.lum.toFixed(1)]) });
    console.log('shot', file);
  }
  if (errors.length) console.log(`kerbs=${kerbs} page errors:`, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}
await browser.close();

console.log(`\nPROFILE ACROSS THE STREET EDGE -- median of ${probe.lines.length} sections ` +
  `${SPACING} m apart\nat (${probe.x}, ${probe.z}), ${probe.dist} m from the ${SHOT} camera. ` +
  'u = 0 is the kerb face; u < 0 is the carriageway.\n');
console.log('  time    build              monotone  reversals  faceDrop  panLift  range');
for (const r of rows) {
  console.log(`  ${r.tod.padEnd(7)} ${r.which.padEnd(18)} ${String(r.monotone).padStart(8)} ` +
    `${String(r.reversals).padStart(10)} ${String(r.faceDrop).padStart(9)} ` +
    `${String(r.panLift).padStart(8)}  ${JSON.stringify(r.range)}`);
}
console.log('');
for (const r of rows) {
  const at = (u) => {
    let best = r.profile[0];
    for (const p of r.profile) if (Math.abs(p[0] - u) < Math.abs(best[0] - u)) best = p;
    return best[1].toFixed(1).padStart(5);
  };
  console.log(`  ${r.tod.padEnd(7)} ${r.which.padEnd(18)} road(-2.60)${at(-2.6)}  lane(-1.20)${at(-1.2)}  ` +
    `pan(-0.30)${at(-0.3)}  face(0.00)${at(0)}  top(+0.18)${at(0.18)}  brick(+1.00)${at(1.0)}`);
}
fs.writeFileSync(`docs/${TAG}-profile.json`, JSON.stringify({ probe, rows }, null, 1));
console.log(`\nwrote docs/${TAG}-profile.json`);
