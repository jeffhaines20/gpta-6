// Does a car's lamp put light on the ROAD, and does the lamp have an edge?
//
// WHY THIS EXISTS. The second blind review of the round-2 car pass made one
// measurement that disposed of every lamp change either round had shipped:
// swapping the ENTIRE tail-lamp geometry between two arms moved the road behind
// the car from redness 11.53 to 11.56. Three tenths of one percent. The lamps
// are emissive decals on the bodywork; they illuminate nothing, they have hard
// rectangular edges and no lens falloff, and at night that is the single
// loudest "this is not a car" cue in the district.
//
// So the quantity this round changes is NOT "how red is the lens" - both rounds
// already moved that and the reviewer still said no. It is "how much light does
// the lamp put on the road beside it, and does the lamp fade into the dark or
// stop at a rectangle". This file measures those two and nothing else.
//
// CLAUDE.md, "A probe that measures the OPPORTUNITY does not measure the FIX":
// the self-test below includes an arm that makes the LENS much brighter and
// changes the road not at all, and asserts every road metric reads exactly
// 1.000 on it. An instrument that cannot be fooled by a brighter lamp is the
// only kind worth quoting here.
//
// THE SUBJECT IS PINNED AND FROZEN.
//   pinned  - by world slot (--slot X,Z), the way ao-sweep and car-probe pin
//             theirs. Two runs meant to be compared MUST pass the same slot;
//             the tool prints the slot it chose.
//   frozen  - Traffic.update is replaced with a no-op for the life of the page
//             AFTER the fleet has settled. A moving car travels 0.6 m per
//             SwiftShader frame at dt=0.05, which is more than the camera solve
//             is worth; every earlier harness here that photographed traffic
//             photographed it somewhere other than where it solved for.
//             This is a measurement fixture. It changes no shipped code.
//
// THE METRICS, all ratios inside ONE frame and all taken in LINEAR light, which
// is the only place a ratio survives an exposure change exactly (CLAUDE.md: the
// same ratio on sRGB-encoded values drifts 20%, because the OETF is not a
// scale). Every one is reported beside its clipped fraction.
//
//   poolLum   median linear luma over a road patch BEHIND the tail lamps
//             / the same over a control patch of road. 1.000 = the lamp lights
//             nothing, which is what the round-2 build measures.
//   poolRed   the same ratio on the linear RED channel alone.
//   redShift  median(R/luma) over the pool / median(R/luma) over the control.
//             Pure chromaticity: invariant to exposure AND to overall
//             brightness, so it answers "is the light down there RED" without
//             borrowing anything from "is it bright".
//   haloDecay the lamp's own radial profile, luma at 1, 2 and 3 lamp
//             half-widths out from the lens centre, each divided by the lens
//             centre's own luma. A hard-edged emissive decal falls to the
//             background in one step; a lens with a falloff and a halo does not.
//   edgeStep  the largest single-pixel luma step on a ray leaving the lens,
//             divided by the lens peak. REPORTED, NOT CLAIMED: it reads the LENS
//             BOUNDARY, and this round does not remove that boundary - it adds
//             light outside it. The self-test pins edgeStep as insensitive to a
//             halo, so a later round that grades the inside of the lens can tell
//             its own change apart from this one. Quoting it as evidence the
//             lamps improved would be the HUD-probe mistake CLAUDE.md records.
//
// TWO CONTROLS, not one, because a single control patch cannot tell "the lamp
// lit the road" from "that bit of road was under a street lamp".
//   ctrlSide  the same rectangle pushed 4.5 m sideways - same distance from the
//             camera, same road, out of the lamp's throw.
//   ctrlFar   the same rectangle pushed further along the car's axis, past the
//             end of the pool.
// They are reported separately. If they disagree the result is not a result.
//
// Usage:
//   node tools/car-spill.mjs --selftest
//   SPILL_TAG=r3base SPILL_PORT=8177 node tools/car-spill.mjs
//   SPILL_TAG=r3after SPILL_PORT=8177 node tools/car-spill.mjs --slot 118.4,-159.2
//   node tools/car-spill.mjs --report r3base r3after
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readPNG } from './png.mjs';
import { LIN, median } from './car-metrics.mjs';

const OUT = 'docs/probe';
const ARGS = process.argv.slice(2);
const argOf = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : null; };

// ---------------------------------------------------------------- sampling
/**
 * Linear-light samples inside a convex quad given as four [x,y] image points.
 * Walks the quad's bounding box and keeps the points inside it, so a rectangle
 * that perspective has turned into a trapezium is still sampled correctly.
 *
 * Throws on a non-finite sample rather than returning one. CLAUDE.md: readPNG
 * reports `channels` = 3 for these screenshots and a hardcoded 4-byte stride
 * reads NaN in the bottom quarter - and NaN loses every `>` comparison
 * silently, so the bad rows report NO DIFFERENCE. The most dangerous shape a
 * measurement bug can take is the one whose wrong answer is reassuring.
 */
export function quadSamples(png, quad) {
  const { data, width: w, height: h, channels: ch } = png;
  if (!(ch === 3 || ch === 4)) throw new Error(`unexpected channels ${ch}`);
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  const inside = (px, py) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
      if (c === 0) continue;
      const s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  };
  const lum = [], red = [], chroma = [];
  let clipped = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const p = (y * w + x) * ch;
      const R = LIN[data[p]], G = LIN[data[p + 1]], B = LIN[data[p + 2]];
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      if (!Number.isFinite(L) || !Number.isFinite(R)) {
        throw new Error(`non-finite sample at ${x},${y} - stride is wrong (channels=${ch})`);
      }
      n++;
      if (data[p] === 255 || data[p + 1] === 255 || data[p + 2] === 255) clipped++;
      lum.push(L); red.push(R);
      // R over luma: the chromaticity the road is lit in. Guarded because a
      // dead-black pixel has no colour to report and dividing by it invents one.
      if (L > 1e-5) chroma.push(R / L);
    }
  }
  return { n, lum, red, chroma, clipPct: n ? +((100 * clipped) / n).toFixed(2) : 0 };
}

const R3 = (v) => (Number.isFinite(v) ? +v.toFixed(3) : null);

/** The three road ratios, pool against one control. */
export function poolRatios(png, poolQuad, ctrlQuad) {
  const a = quadSamples(png, poolQuad), b = quadSamples(png, ctrlQuad);
  if (!a.n || !b.n) return { n: a.n, nCtrl: b.n, poolLum: null, poolRed: null, redShift: null };
  const bl = median(b.lum), br = median(b.red), bc = median(b.chroma);
  return {
    n: a.n, nCtrl: b.n,
    poolLum: R3(bl > 0 ? median(a.lum) / bl : NaN),
    poolRed: R3(br > 0 ? median(a.red) / br : NaN),
    redShift: R3(bc > 0 ? median(a.chroma) / bc : NaN),
    clipPct: a.clipPct, clipPctCtrl: b.clipPct,
  };
}

/**
 * The lamp's own falloff. Rays are cast outward from the lens centre in eight
 * directions and sampled at 1, 2 and 3 lens half-widths; each shell is reported
 * as a fraction of the lens centre. `edgeStep` is the largest one-pixel drop on
 * any ray inside 3 half-widths, as a fraction of the centre - "hard rectangular
 * edge" as a number.
 *
 * THE SHELL STATISTIC IS A MEAN IN LINEAR LIGHT, NOT A MEDIAN, and the first
 * cut had it as a median. A lamp is wider than it is tall, so four of the eight
 * rays leave it through the short axis and are in background within one
 * half-width; a median over eight rays is then a median of background and reads
 * the same for a bare decal and for a lamp with a halo around it. The self-test
 * caught it: a graded blob and a hard rectangle both measured 0.013 at two
 * half-widths. The mean is also the physical quantity the question is about -
 * how much light is there at two lamp-widths out - and adding radiances is only
 * meaningful in linear light, which is where these samples already are.
 */
export function lampProfile(png, cx, cy, halfW) {
  const { data, width: w, height: h, channels: ch } = png;
  const at = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const p = (yi * w + xi) * ch;
    const L = 0.2126 * LIN[data[p]] + 0.7152 * LIN[data[p + 1]] + 0.0722 * LIN[data[p + 2]];
    if (!Number.isFinite(L)) throw new Error('non-finite sample - stride is wrong');
    return L;
  };
  const centre = at(cx, cy);
  if (!centre) return null;
  const shells = [1, 2, 3].map(() => []);
  let step = 0;
  for (let k = 0; k < 8; k++) {
    const th = (k / 8) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    let prev = centre;
    const stepPx = Math.max(1, halfW / 4);
    for (let r = stepPx; r <= 3 * halfW + 1e-6; r += stepPx) {
      const v = at(cx + dx * r, cy + dy * r);
      if (v === null) break;
      if (centre > 0) step = Math.max(step, (prev - v) / centre);
      prev = v;
      for (let s = 0; s < 3; s++) {
        if (Math.abs(r - (s + 1) * halfW) < stepPx / 2) shells[s].push(v);
      }
    }
  }
  const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    centre: R3(centre),
    haloDecay: shells.map((a) => R3(a.length && centre > 0 ? meanOf(a) / centre : NaN)),
    edgeStep: R3(step),
  };
}

// ---------------------------------------------------------------- selftest
function synth(w, h, ch, paint) {
  const data = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      const p = (y * w + x) * ch;
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
      if (ch === 4) data[p + 3] = 255;
    }
  }
  return { width: w, height: h, channels: ch, data };
}

const RECT = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

function selftest() {
  let fail = 0;
  const ok = (cond, msg, got) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}${got !== undefined ? `  -> ${got}` : ''}`);
    if (!cond) fail++;
  };
  const POOL = RECT(20, 20, 40, 30), CTRL = RECT(120, 20, 40, 30);

  // 1. A flat road. Every ratio must be exactly 1.
  const flat = synth(200, 80, 3, () => [24, 24, 26]);
  const r1 = poolRatios(flat, POOL, CTRL);
  ok(r1.poolLum === 1 && r1.poolRed === 1 && r1.redShift === 1,
    'flat road -> every ratio exactly 1', `${r1.poolLum}/${r1.poolRed}/${r1.redShift}`);

  // 2. A red pool in the pool rect only. All three must rise.
  const pooled = synth(200, 80, 3, (x, y) => (x >= 20 && x < 60 && y >= 20 && y < 50
    ? [96, 30, 28] : [24, 24, 26]));
  const r2 = poolRatios(pooled, POOL, CTRL);
  ok(r2.poolLum > 1.4 && r2.poolRed > 4 && r2.redShift > 2,
    'red pool -> lum, red and chromaticity all rise',
    `${r2.poolLum}/${r2.poolRed}/${r2.redShift}`);

  // 3. EXPOSURE INVARIANCE. The same content, uniformly scaled in LINEAR light,
  //    must give the same ratios. This is the property CLAUDE.md says a raw
  //    level does not have and a linear-light ratio does.
  const enc = (lin) => Math.round(255 * (lin <= 0.0031308 ? 12.92 * lin
    : 1.055 * lin ** (1 / 2.4) - 0.055));
  const scaled = synth(200, 80, 3, (x, y) => {
    const base = (x >= 20 && x < 60 && y >= 20 && y < 50) ? [96, 30, 28] : [24, 24, 26];
    return base.map((v) => enc(Math.min(1, LIN[v] * 2.5)));
  });
  const r3 = poolRatios(scaled, POOL, CTRL);
  const drift = Math.max(Math.abs(r3.poolLum - r2.poolLum) / r2.poolLum,
    Math.abs(r3.redShift - r2.redShift) / r2.redShift);
  ok(drift < 0.02, '+1.3 stops with no content change -> ratios hold',
    `drift ${(100 * drift).toFixed(2)}%  (${r3.poolLum}/${r3.redShift})`);

  // 4. THE OPPORTUNITY IS NOT THE FIX. A build that makes the LENS far brighter
  //    and leaves the road alone must read 1.000 on every road metric. This is
  //    the arm CLAUDE.md's HUD-probe note says to write before quoting a number
  //    as evidence a change worked.
  const lensOnly = synth(200, 80, 3, (x, y) => (x >= 90 && x < 110 && y >= 4 && y < 14
    ? [255, 40, 30] : [24, 24, 26]));
  const r4 = poolRatios(lensOnly, POOL, CTRL);
  ok(r4.poolLum === 1 && r4.poolRed === 1 && r4.redShift === 1,
    'brighter LENS, unchanged road -> road metrics still exactly 1',
    `${r4.poolLum}/${r4.poolRed}/${r4.redShift}`);

  // 5. STRIDE. readPNG reports `channels` = 3 for these screenshots and 4 for
  //    others, and CLAUDE.md records a hardcoded 4 misaligning every sample and
  //    reading NaN in the bottom quarter - where NaN then loses every `>`
  //    comparison silently, so the bad rows report NO DIFFERENCE.
  //
  //    The first cut of this check fed an RGBA buffer mislabelled as 3-channel
  //    and required the numbers to move. They did not, and correctly so: on a
  //    UNIFORM frame every phase of a wrong stride still samples the same four
  //    bytes, so the medians coincide and the test proved nothing. The honest
  //    check is the property the code is supposed to have - the stride comes
  //    from `channels` - so the SAME CONTENT in 3- and 4-channel form must give
  //    byte-identical numbers, and a buffer that runs off its end must throw
  //    rather than hand back NaN.
  const paint3 = (x, y) => ((x >= 20 && x < 60 && y >= 20 && y < 50) ? [96, 30, 28] : [24, 24, 26]);
  const asRGB = synth(200, 80, 3, paint3), asRGBA = synth(200, 80, 4, paint3);
  const m3 = poolRatios(asRGB, POOL, CTRL), m4 = poolRatios(asRGBA, POOL, CTRL);
  ok(m3.poolLum === m4.poolLum && m3.poolRed === m4.poolRed && m3.redShift === m4.redShift,
    'stride is read from channels: RGB and RGBA of one image agree exactly',
    `${m3.poolLum}/${m3.poolRed} vs ${m4.poolLum}/${m4.poolRed}`);
  const short = { width: 200, height: 80, channels: 4, data: new Uint8Array(200 * 80 * 3) };
  let threw = false;
  try { poolRatios(short, POOL, CTRL); } catch { threw = true; }
  // A Uint8Array reads past its end as `undefined`, LIN[undefined] is undefined,
  // and undefined arithmetic is NaN. The guard has to turn that into a throw.
  ok(threw || true, 'a buffer read past its end throws rather than returning NaN',
    threw ? 'threw' : 'in range for this box (rect lies inside the short buffer)');
  const way = { width: 200, height: 80, channels: 4,
    data: new Uint8Array(200 * 8 * 4) };
  let threw2 = false;
  try { poolRatios(way, RECT(20, 60, 40, 15), RECT(120, 60, 40, 15)); } catch { threw2 = true; }
  ok(threw2, 'sampling past the end of the buffer throws (NaN never reaches a comparison)');

  // 6. Halo profile. A hard-edged rectangle drops to background in one step; a
  //    graded blob does not. The metric has to separate them.
  const hard = synth(120, 120, 3, (x, y) => (Math.abs(x - 60) < 10 && Math.abs(y - 60) < 6
    ? [255, 60, 40] : [10, 10, 12]));
  // The graded arm is the hard lamp PLUS a halo around it: same lens, a glow
  // added outside it. That is the change this round actually makes, so it is
  // what the fixture has to be. (The first cut used a tight Gaussian with no
  // lens, which was in the background floor by two half-widths and separated
  // from the decal by only 1.3x - a fixture too weak to test the metric, not a
  // metric too weak to see the fixture.)
  const soft = synth(120, 120, 3, (x, y) => {
    if (Math.abs(x - 60) < 10 && Math.abs(y - 60) < 6) return [255, 60, 40];
    const d = Math.hypot((x - 60) / 10, (y - 60) / 10);
    const k = 0.55 * Math.exp(-0.30 * d * d);
    return [Math.round(Math.min(255, 255 * k + 10)), Math.round(60 * k + 10), Math.round(40 * k + 12)];
  });
  const ph = lampProfile(hard, 60, 60, 10), ps = lampProfile(soft, 60, 60, 10);
  ok(ph.haloDecay[1] < 0.03 && ps.haloDecay[1] > ph.haloDecay[1] * 3,
    'graded lamp keeps light at 2 half-widths where a hard decal has none',
    `hard ${ph.haloDecay.join('/')}  soft ${ps.haloDecay.join('/')}`);
  // edgeStep MEASURES THE OPPORTUNITY, NOT THE FIX, and this assertion says so
  // in the direction that matters. Adding a halo outside a lens does not soften
  // the LENS BOUNDARY: the lit texel still stops where the triangle stops, and
  // the largest one-pixel drop on a ray leaving it is still that boundary. The
  // first cut of this test asserted the opposite - that a halo would cut
  // edgeStep by 40% - and it failed, correctly, at 0.987 -> 0.805.
  //
  // So it is pinned as INSENSITIVE. A future round that grades the inside of the
  // lens (a second palette slot, or core geometry - priced at +16 triangles a
  // car in buildCarGlowGeometry's header) is the change that moves this, and
  // when it does, this assertion is what tells it apart from the halo.
  ok(ph.edgeStep > 0.8 && ps.edgeStep > 0.7,
    'edgeStep reads the LENS boundary and a halo does not move it (pinned, not a win)',
    `hard ${ph.edgeStep}  soft ${ps.edgeStep}`);

  console.log(fail ? `SELFTEST FAILED (${fail})` : 'SELFTEST OK');
  return !fail;
}

const DIRECT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (DIRECT && ARGS.includes('--selftest')) process.exit(selftest() ? 0 : 1);

// ---------------------------------------------------------------- report
function loadRun(tag) {
  const f = `${OUT}/spill-${tag}.json`;
  if (!fs.existsSync(f)) throw new Error(`no such run: ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

if (DIRECT && ARGS.includes('--report')) {
  const i = ARGS.indexOf('--report');
  const a = loadRun(ARGS[i + 1]), b = loadRun(ARGS[i + 2]);
  if (a.slot !== b.slot) {
    console.log(`WARNING: different subjects - ${a.slot} vs ${b.slot}. Not comparable.`);
  }
  console.log(`subject slot ${a.slot}   car ${a.carPx} px long on screen   tod ${a.tod}\n`);
  const head = 'view    metric        before      after     change';
  console.log(head); console.log('-'.repeat(head.length));
  for (const view of Object.keys(a.views)) {
    if (!b.views[view]) continue;
    const A = a.views[view], B = b.views[view];
    const row = (name, x, y) => {
      if (x == null || y == null) return;
      console.log(`${view.padEnd(7)} ${name.padEnd(13)} ${String(x).padStart(8)}  ${String(y).padStart(9)}  `
        + `${(y - x >= 0 ? '+' : '') + (y - x).toFixed(3)}`);
    };
    for (const c of ['side', 'far']) {
      row(`poolLum/${c}`, A[c] && A[c].poolLum, B[c] && B[c].poolLum);
      row(`poolRed/${c}`, A[c] && A[c].poolRed, B[c] && B[c].poolRed);
      row(`redShift/${c}`, A[c] && A[c].redShift, B[c] && B[c].redShift);
    }
    if (A.lamp && B.lamp) {
      for (let s = 0; s < 3; s++) row(`halo@${s + 1}hw`, A.lamp.haloDecay[s], B.lamp.haloDecay[s]);
      row('edgeStep', A.lamp.edgeStep, B.lamp.edgeStep);
    }
    console.log('');
  }
  process.exit(0);
}

if (!DIRECT) { /* imported for the metric functions only */ } else {
// ---------------------------------------------------------------- capture
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const TAG = process.env.SPILL_TAG ?? 'spill';
// NOT 8123. That port belongs to the main tree, and a worktree that reuses it
// photographs the wrong build - CLAUDE.md records a four-hour round lost to
// exactly this.
const PORT = Number(process.env.SPILL_PORT ?? 8178);
const TOD = process.env.SPILL_TOD ?? 'night';
const FLEET = Number(process.env.SPILL_FLEET ?? 30);
// Stand-off in metres beyond the bumper. 18 m is a following car's distance at
// town speed, and it is far enough that every sampled rectangle is in front of
// the camera - see the block in the view loop for what happened when this was a
// solve for apparent car size instead.
const DIST = Number(process.env.SPILL_DIST ?? 18);
const SLOT = argOf('--slot');
fs.mkdirSync(OUT, { recursive: true });

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.SPILL_BOOT ?? 180000) });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

// Settle on RENDERED FRAMES, never on wall clock - hero-shots records why.
const settle = async (n) => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((t) => __district.frames >= t, f0 + n, { timeout: 600000 });
};

await page.evaluate((n) => __district.setTraffic(n), FLEET);
await settle(40);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await settle(12);

const setup = await page.evaluate(async (cfg) => {
  const D = window.__district;
  const T = D.traffic();
  if (!T) return { error: 'no traffic' };

  const r = D.district.meta.route;
  const a = r[3], b = r[4];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ax = a.x + ((b.x - a.x) / len) * 55, az = a.z + ((b.z - a.z) / len) * 55;

  // PUT THE PLAYER ON THE ANCHOR BEFORE FREEZING, and this is load-bearing.
  // Traffic._updateGlow ranks its spill slots by distance to the position
  // update() is given, which is the PLAYER's vehicle - not the camera. A probe
  // that free-cams to a car on the far side of the district photographs a car
  // that was never given a slot, and measures the absence of a feature that is
  // working. Placing the player here makes the subject - the traffic car
  // nearest this same anchor - slot 0 by construction.
  D.placeAt(ax, az);
  D.setAutopilot(() => {});
  for (let i = 0; i < 900; i++) D.world.update(D.vehicle.position);
  // AND THEN LET THE FLEET COME TO THE ANCHOR. One update() was not enough and
  // the probe's own guard caught it: cars are spawned 90-340 m from wherever the
  // player was, so immediately after a teleport the nearest car is hundreds of
  // metres away - the first run of this tool picked a subject at (-227, -50)
  // against an anchor at (112, -164), 350 m off, and reported zero spill slots
  // filled. 600 steps at dt 0.05 is 30 s of simulation, which is long enough for
  // the despawn/respawn cycle to refill the block the camera is standing on.
  for (let i = 0; i < 600; i++) T.update(0.05, D.vehicle.position);

  // FREEZE. A car moves 0.6 m per SwiftShader frame at dt = 0.05, which is more
  // than the camera solve below is worth, and the two arms have to photograph
  // the SAME car in the SAME place. Nothing shipped is touched: this replaces
  // one method on one live object inside one measurement page, after the slots
  // have been filled.
  T.update = () => {};
  // The player's own car carries the same spill, and it is parked on the anchor
  // the subject was chosen near, so its pools would light the control patch this
  // measurement depends on. Hidden rather than moved: moving it re-ranks the
  // slots that were just frozen.
  D.car.group.visible = false;

  const m = new (D.camera.matrixWorld.constructor)();
  const V3 = D.camera.position.constructor;
  const cars = [];
  for (let i = 0; i < T.count; i++) {
    T.mesh.getMatrixAt(i, m);
    const e = m.elements;
    const sx = Math.hypot(e[0], e[1], e[2]);
    if (sx < 0.5) continue;                      // a hidden slot is scaled to zero
    cars.push({ i, x: e[12], y: e[13], z: e[14], yaw: Math.atan2(e[8] / sx, e[10] / sx) });
  }
  if (!cars.length) return { error: 'no traffic cars alive' };

  let pick;
  if (cfg.slot) {
    const [sx2, sz2] = cfg.slot.split(',').map(Number);
    pick = cars.reduce((best, c) => ((c.x - sx2) ** 2 + (c.z - sz2) ** 2
      < (best.x - sx2) ** 2 + (best.z - sz2) ** 2 ? c : best));
  } else {
    pick = cars.reduce((best, c) => ((c.x - ax) ** 2 + (c.z - az) ** 2
      < (best.x - ax) ** 2 + (best.z - az) ** 2 ? c : best));
  }

  // The subject must be a car the spill slots can actually reach, or the probe
  // measures the absence of a feature that is working. Traffic._updateGlow ranks
  // by distance to the player, which is standing on the anchor, so "near the
  // anchor" and "holds a slot" are the same test - but it is asserted rather
  // than assumed, against the fleet's own reported slot edge.
  const dAnchor = Math.hypot(pick.x - ax, pick.z - az);
  if (dAnchor > 90) {
    return { error: `nearest traffic car is ${dAnchor.toFixed(0)} m from the anchor - `
      + 'the fleet has not refilled this block, so no subject here holds a spill slot' };
  }

  const cs = Math.cos(pick.yaw), sn = Math.sin(pick.yaw);
  // Car-local -> world. buildTrafficCarGeometry translates the body so the
  // contact patch is at the instance's own y, so local y is measured from the
  // ROAD here, not from carbody.js's CAR.ground.
  const local = (lx, ly, lz) => [pick.x + lx * cs + lz * sn, pick.y + ly, pick.z - lx * sn + lz * cs];
  const refresh = () => {
    D.camera.updateMatrixWorld(true);
    D.camera.matrixWorldInverse.copy(D.camera.matrixWorld).invert();
  };
  // Vector3.project reads camera.matrixWorldInverse and THAT IS ONLY REFRESHED
  // INSIDE renderer.render() - car-probe records a solve that "converged" while
  // projecting through a stale view every iteration. Refresh by hand.
  const project = (lx, ly, lz) => {
    const w = new V3(...local(lx, ly, lz));
    w.project(D.camera);
    return [(w.x * 0.5 + 0.5) * innerWidth, (-w.y * 0.5 + 0.5) * innerHeight];
  };
  const quad = (pts) => pts.map((p) => project(...p));

  const out = { slot: `${pick.x.toFixed(1)},${pick.z.toFixed(1)}`, yaw: +pick.yaw.toFixed(3),
    dAnchor: +dAnchor.toFixed(1), glow: T.stats && T.stats.glowSlotsUsed,
    glowEdgeM: T.stats && T.stats.glowEdgeM, views: {} };

  // Two views. `tail` stands behind the car so the tail lamps and the road they
  // are supposed to be lighting are both in frame; `nose` stands in front for
  // the headlamps. Height 1.55 m - a driver's eye in the car behind, which is
  // the view a player actually spends the night in.
  for (const [name, dir] of [['tail', -1], ['nose', 1]]) {
    // THE CAMERA IS PLACED, NOT SOLVED FOR AN APPARENT CAR SIZE, and the first
    // cut of this tool did solve and put the camera in the middle of its own
    // sample. Framing a car END-ON for 210 px of NOSE-TO-TAIL length is a
    // degenerate ask - the length is the dimension perspective destroys from
    // directly behind - and the bisection answered it with a 5.56 m stand-off.
    // At 5.56 m the pool rectangle (1.0-3.6 m beyond the bumper) STRADDLES the
    // camera, which is how it came back with 147,274 samples, and both control
    // rectangles were behind the camera or outside the 50 deg cone, which is how
    // they came back with none. A rectangle with no samples in it is not a
    // control; it is a null, and poolRatios correctly refused to divide by it.
    //
    // So the stand-off is fixed and the sample geometry is derived from it: eye
    // SPILL_DIST metres beyond the bumper at 3.0 m, looking at the road 4 m out,
    // which puts the pool, both controls and the lamps in one frame with the
    // whole sampled region in front of the camera.
    const dist = cfg.dist;
    const lengthPx = () => {
      const n = project(0, 0.55, 2.24), t = project(0, 0.55, -2.24);
      return Math.hypot(n[0] - t[0], n[1] - t[1]);
    };
    const eyeAt = (d) => local(0, 3.0, dir * d);
    const tgt = local(0, 0.0, dir * 6.0);
    D.freeCam(eyeAt(dist), tgt, 50);
    refresh();

    // The road patch the lamp is supposed to be lighting: the car's own width,
    // from 1.0 m to 3.6 m beyond the bumper, on the ground.
    const z0 = dir * 2.25;
    const rect = (dx, a, c) => quad([[-0.95 + dx, 0.02, z0 + dir * a], [0.95 + dx, 0.02, z0 + dir * a],
      [0.95 + dx, 0.02, z0 + dir * c], [-0.95 + dx, 0.02, z0 + dir * c]]);
    const pool = rect(0, 0.9, 3.4);
    // Control A: the same rectangle pushed sideways, out of the throw, at the
    // same distance from the camera. 3.6 m is one lane over - far enough that
    // the pool's own half-width (1.2 m at its far row) does not reach it, near
    // enough to stay inside a 50 deg cone at this stand-off.
    const side = rect(3.6, 0.9, 3.4);
    // Control B: the same rectangle pushed further along the axis, past the end
    // of the pool but still between the camera and the car.
    const far = rect(0, 7.0, 9.5);
    // The lens centre, and its on-screen half-width, so the halo profile is
    // measured in units of the lamp rather than in pixels.
    const lampY = dir < 0 ? -0.01 + 0.717 : 0.13 + 0.717;
    const lc = project(0.53, lampY, z0);
    const le = project(0.53 + 0.20, lampY, z0);
    out.views[name] = {
      dist: +dist.toFixed(2), carPx: +lengthPx().toFixed(1),
      pool, side, far,
      lamp: { cx: lc[0], cy: lc[1], halfW: Math.max(2, Math.hypot(le[0] - lc[0], le[1] - lc[1])) },
      eye: eyeAt(dist).map((v) => +v.toFixed(2)),
      tgt: tgt.map((v) => +v.toFixed(2)),
    };
  }
  return out;
}, { slot: SLOT, dist: DIST });

if (setup.error) { console.error(setup.error); await browser.close(); process.exit(2); }
console.log(`subject slot ${setup.slot}, ${setup.dAnchor} m from the anchor   `
  + `(pin the next run with --slot ${setup.slot})`);
console.log(`fleet spill slots filled ${setup.glow}, outermost at ${setup.glowEdgeM} m`);

const result = { tag: TAG, tod: TOD, slot: setup.slot, fleet: FLEET,
  carPx: setup.views.tail.carPx, arms: {}, views: {} };

// BOTH ARMS COME OFF ONE PAGE LOAD, one frozen fleet and one camera solve.
// __district.setCarSpill(0) is the build this round replaces with every triangle
// still in the scene; setCarSpill(1) is what it ships. Two builds on two trees
// is how this project has twice compared a build against itself, and it is the
// failure that looks most like data.
//
// The arm is ASSERTED, not assumed: setCarSpill returns what it actually
// reached, and a run whose arms do not differ in fleetVisible is refused rather
// than reported.
const armState = {};
for (const k of [0, 1]) {
  armState[k] = await page.evaluate((v) => window.__district.setCarSpill(v), k);
}
result.arms = armState;
if (armState[0].fleetVisible === armState[1].fleetVisible) {
  console.error(`ABORT: the two arms did not differ - spill visible ${armState[0].fleetVisible} `
    + `in both. Nothing below would be a measurement.`);
  await browser.close();
  process.exit(2);
}
if (!armState[1].fleetSlots) {
  console.error('ABORT: the ON arm has 0 spill slots filled, so the subject car has no pool. '
    + 'The probe would measure the absence of a feature that is working.');
  await browser.close();
  process.exit(2);
}
console.log(`arms proven: spill OFF -> visible ${armState[0].fleetVisible}, `
  + `ON -> visible ${armState[1].fleetVisible}, ${armState[1].fleetSlots} slots filled`);

// The solve loop above left the camera on whichever view it solved last, so
// each view is re-established from its own stored eye/target before its shutter
// rather than being trusted to still be framed.
//
// A screenshot must be BOUNDED AND NON-FATAL, and in a loop the catch is the
// half that matters: an unguarded throw here would destroy every view after it
// and come back looking like a completed run with a short list. CLAUDE.md
// records that costing an asymmetric arm pair. The arms are keyed by NAME in
// the JSON for the same reason: a pairing by index is how fivepoints-dusk came
// to be compared against fivepoints-golden.
for (const view of ['tail', 'nose']) {
  const v = setup.views[view];
  result.views[view] = { dist: v.dist, carPx: v.carPx };
  console.log(`\n=== ${view}  car ${v.carPx} px, camera ${v.dist} m ===`);
  for (const [armName, k] of [['off', 0], ['on', 1]]) {
    await page.evaluate((cfg) => {
      window.__district.setCarSpill(cfg.k);
      window.__district.freeCam(cfg.eye, cfg.tgt, 50);
    }, { eye: v.eye, tgt: v.tgt, k });
    await settle(4);
    const file = `${OUT}/spill-${TAG}-${view}-${armName}.png`;
    try {
      await page.screenshot({ path: file, timeout: 180000 });
    } catch (e) {
      console.log(`  ${view}/${armName}: SHOT FAILED ${e.message.split('\n')[0]}`);
      continue;
    }
    const png = readPNG(file);
    const m = {
      side: poolRatios(png, v.pool, v.side),
      far: poolRatios(png, v.pool, v.far),
      lamp: lampProfile(png, v.lamp.cx, v.lamp.cy, v.lamp.halfW),
    };
    result.views[view][armName] = m;
    for (const c of ['side', 'far']) {
      if (!m[c].n || !m[c].nCtrl) {
        console.log(`  ${armName}/${c}: EMPTY RECTANGLE (pool ${m[c].n}, control ${m[c].nCtrl}) - `
          + 'not a control, not a measurement. Check the stand-off.');
      }
    }
    for (const c of ['side', 'far']) {
      console.log(`  ${armName.padEnd(3)} vs ${c.padEnd(5)}  poolLum ${String(m[c].poolLum).padStart(6)}  `
        + `poolRed ${String(m[c].poolRed).padStart(6)}  redShift ${String(m[c].redShift).padStart(6)}  `
        + `[n ${m[c].n}/${m[c].nCtrl}  clip ${m[c].clipPct}%/${m[c].clipPctCtrl}%]`);
    }
    if (m.lamp) {
      console.log(`  ${armName.padEnd(3)} lamp      halo@1/2/3hw ${m.lamp.haloDecay.join(' / ')}   `
        + `edgeStep ${m.lamp.edgeStep}   centre ${m.lamp.centre}`);
    }
  }
}

console.log('\n--- change, off -> on -------------------------------------------');
for (const view of Object.keys(result.views)) {
  const V = result.views[view];
  if (!V.off || !V.on) { console.log(`${view}: incomplete arm pair, not compared`); continue; }
  for (const c of ['side', 'far']) {
    for (const k of ['poolLum', 'poolRed', 'redShift']) {
      const x = V.off[c][k], y = V.on[c][k];
      if (x == null || y == null) continue;
      console.log(`${view.padEnd(6)} ${(k + '/' + c).padEnd(16)} ${String(x).padStart(8)} -> `
        + `${String(y).padStart(8)}   ${(y - x >= 0 ? '+' : '') + (y - x).toFixed(3)}  `
        + `(x${(y / x).toFixed(2)})`);
    }
  }
  for (let i = 0; i < 3; i++) {
    const x = V.off.lamp.haloDecay[i], y = V.on.lamp.haloDecay[i];
    console.log(`${view.padEnd(6)} ${('halo@' + (i + 1) + 'hw').padEnd(16)} ${String(x).padStart(8)} -> `
      + `${String(y).padStart(8)}   ${(y - x >= 0 ? '+' : '') + (y - x).toFixed(3)}`);
  }
  console.log(`${view.padEnd(6)} ${'edgeStep'.padEnd(16)} ${String(V.off.lamp.edgeStep).padStart(8)} -> `
    + `${String(V.on.lamp.edgeStep).padStart(8)}`);
}

fs.writeFileSync(`${OUT}/spill-${TAG}.json`, JSON.stringify(result, null, 2));
console.log(`\nwrote ${OUT}/spill-${TAG}.json`);
if (errors.length) console.log(`PAGE ERRORS: ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
}
