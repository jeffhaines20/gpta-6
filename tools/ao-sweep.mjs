// WHAT DOES THE SSAO RADIUS COST AND BUY? A sweep, measured off the AO BUFFER.
//
// src/post.js runs screen-space AO at a 2.2 m view-space radius. Against a 0.41 m
// shoulder that is 5.4 body widths, and "a soft fan roughly six times his body
// width, with no edge and no direction" is what two blind reviewers called the
// thing the crowd puts on the pavement. That halo is not a pedestrian defect: it
// is a district-wide parameter, and every figure and every prop in the game is
// standing in one.
//
// ---------------------------------------------------------------------------
// WHY THIS READS THE AO BUFFER AND NOT THE FRAME
// ---------------------------------------------------------------------------
// Luminance in the composited frame is downstream of exposure, the tone curve,
// bloom and (shortly) a district interreflection term, so a number taken off it
// today does not survive the next lighting merge. The AO pass writes a single
// channel into an 8-bit half-resolution target, aoBlurRT, and that value IS the
// quantity under test: ao = 1 means unoccluded, and the composite multiplies the
// scene by mix(1, ao, aoStrength). readRenderTargetPixels() hands it back exactly.
//
// So every number here is reported as OCCLUSION = 1 - ao, in [0, 1], which is a
// property of geometry and the kernel alone. Nothing in this file depends on the
// exposure stop, the bloom threshold, or the sky.
//
// THE ALTERNATIVE WAS TRIED AND IT DOES NOT WORK ON THIS BOX. tools/ao-sweep.mjs
// at f6bf628 differenced an AO-on capture against an AO-off one, which is the
// textbook way to isolate a post pass and is unusable here: SwiftShader renders
// well under 1 fps, the two captures are seconds apart, and everything that moves
// in between lands in the difference as if it were occlusion. On one unchanged
// 2.2 m radius that instrument read 44.2%, 27.6% and 31.0% on three runs, and
// 28.4% then 45.7% TWICE INSIDE ONE RUN. Pinning the crowd and the traffic to
// zero did not fix it. Three separate metrics produced plausible monotonic trends
// that were the simulation moving.
//
// This file differences nothing. One capture of the buffer per parameter set, and
// the reading is deterministic: --repeat measures the first combination twice and
// refuses the sweep if the two do not agree, which is the guard that version was
// right to want and could never satisfy.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED, AND WHERE
// ---------------------------------------------------------------------------
// One camera - the fivepoints hero framing - because it carries all of it at
// once: sunlit brick with people on it, bollards and bins standing on that brick,
// and a shopfront wall with awnings and reveals down the right-hand side.
//
// EVERY HEADLINE NUMBER IS A DIFFERENCE OR A RATIO INSIDE ONE BUFFER. The
// absolute level of the AO term moves with intensity and strength by
// construction, so "the halo is 0.28" says nothing on its own. What says
// something is how far out the halo is still above the pavement around it, and
// how much darker a window reveal is than the wall 30 cm to its left in the
// same frame.
//
//   LOBE      A pedestrian is teleported to a verified patch of clear sunlit
//             brick and posed standing, so its width is the 0.41 m shoulder and
//             its position is known. Occlusion is sampled on the GROUND around
//             its feet on TRUE 0.1 m-spaced circles out to 4 m - circles on the
//             brick, projected, not circles on the screen, because pavement is
//             seen at a grazing angle and a screen circle is an ellipse on the
//             ground. Every ring point is checked to be flat prop-free sidewalk,
//             checked to be visible from the camera, and checked not to lie in
//             the subject's own screen column. The lobe radius is where the
//             profile decays to 10% of its rise ABOVE THE LOCAL BACKGROUND
//             measured at 3-4 m, not to 10% of its peak: this district has an
//             AO floor everywhere and a peak-relative test never terminates.
//             Reported in body widths, the unit the complaint was made in.
//   CONTACT   The pavement in a ring 0.14 m clear of a bin base or a bollard
//             base, minus the same pavement 2.2 m out. The props are found from
//             the dressing pass's own merged vertices - 0.20 m plan grid,
//             connected components, classified by plan extent against the
//             dimensions in streetfurniture.js - because there is no per-object
//             node to look up and a ground grid coarse enough to be affordable
//             steps straight over a 0.64 m bin.
//   CREASE    The crevice term AO exists to draw, measured geometrically rather
//             than by eye: occlusion on the pavement 0.12 m from a building wall
//             minus occlusion 1.80 m out, over every facing wall segment the
//             camera can actually see - outward decided by point-in-polygon on
//             the footprint, visibility decided by a ray. Same on the wall
//             itself, 0.25 m up against 2.20 m up.
//   REVEAL    AO's real job, and the measurement that decides this question.
//             src/facades.js builds windows with real depth: the glazing plane
//             sits 0.10-0.34 m behind the wall face, with jambs returning to it
//             and a head shelf over it. Rays in rows across a facade record how
//             far behind the modal wall plane each pixel landed, classifying it
//             as flush, reveal or soffit, and only pixels whose neighbours agree
//             are kept so none sits on a transition the half-res blur smeared.
//             revealContrast is reveal minus flush. If a short radius does not
//             hold that up, it is not free.
//   FRAME     Mean occlusion over the whole buffer: how grey the district is.
//
// RADIUS AND CONTRAST ARE SWEPT AS A PAIR, because a smaller hemisphere finds
// less occluding geometry and the same exponent therefore reads weaker at 0.6 m
// than at 2.2 m. Note which knob has the range: post.js line 439 composites
// mix(1.0, ao, aoStrength), so aoStrength is a fraction and 1.0 is already the
// whole AO buffer - 5% of headroom above the shipped 0.95 and no more.
// aoIntensity is the exponent in pow(ao, intensity) and it is where the
// contrast actually lives.
//
//   node tools/ao-sweep.mjs --port 8149 --tag sweep
//   node tools/ao-sweep.mjs --selftest
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TAG = arg('tag', 'aosweep');
const TOD = arg('tod', 'noon');
// Never 8123 (main tree). 8133/8135/8136 are this session's; 8134 belongs to a
// sibling worktree and tools/serve.mjs throws rather than photograph it.
const PORT = Number(arg('port', 8137));
const PEDS = Number(arg('peds', 96));
const SELFTEST = has('selftest');
const W = 1600, H = 900;
const BODY_W = 0.41;              // shoulder width, src/pedestrians.js SHOULDER_X * 2
// The two hero framings, verbatim from tools/hero-shots.mjs. fivepoints is the
// one with sunlit brick and a crowd on it; corridor stands 55 m the other way
// down the same axis with the shopfront row filling more of the frame.
const CAMS = {
  fivepoints: { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
  corridor: { name: 'corridor', wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
};
const CAM = CAMS[arg('cam', 'fivepoints')] || CAMS.fivepoints;

// radius, intensity, strength. The first row is what ships today.
// RADIUS AND CONTRAST AS A PAIR, which they are: a smaller hemisphere finds
// less occluding geometry, so the same aoIntensity exponent reads weaker at
// 0.6 m than at 2.2 m and a radius change compared at fixed intensity is
// really two changes at once. Note which knob has the range: post.js line 439
// composites mix(1.0, ao, aoStrength), so aoStrength is a fraction and 1.0 is
// already the whole AO buffer -- there is 5% of headroom above the shipped
// 0.95 and no more. aoIntensity is the pow() exponent on the AO term and it is
// where the contrast actually lives. So the sweep walks radius at the shipped
// contrast first, then re-pairs each short radius with a higher exponent to ask
// whether what a small kernel loses can be bought back.
const COMBOS = (arg('combos', '') || [
  '2.2/3.8/0.95',   // shipped
  '1.4/3.8/0.95',
  '0.9/3.8/0.95',
  '0.6/3.8/0.95',
  '0.35/3.8/0.95',
  '1.4/5.2/0.95',   // the same radii re-paired with more contrast
  '0.9/5.2/0.95',
  '0.6/5.2/0.95',
  '0.35/5.2/0.95',
  '0.6/6.8/1.00',   // and with everything both knobs have left
  '0.35/6.8/1.00',
  '0.9/2.6/0.95',   // less contrast, for the shape of the response
  '0.0/3.8/0.95',   // control: radius 0 must read exactly zero
].join(',')).split(',').map((s) => {
  const [r, i, st] = s.split('/').map(Number);
  return { radius: r, intensity: i, strength: st };
});

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** Mean luminance of a screenshot over a pixel rect. */
export function rectLum(file, r) {
  const img = readPNG(file);
  const { width, height, channels, data } = img;   // channels, NOT 4
  let s = 0, n = 0;
  for (let y = r.y; y < Math.min(height, r.y + r.h); y++) {
    for (let x = r.x; x < Math.min(width, r.x + r.w); x++) { s += lum(data, (y * width + x) * channels); n++; }
  }
  return n ? s / n : 0;
}

/**
 * Profile -> lobe radius. THE THRESHOLD IS NOT A FRACTION OF THE PEAK, and that
 * distinction is the whole reason this function exists as a named, tested thing.
 *
 * The previous pass used "the radius where occlusion has fallen to a tenth of
 * its value at the feet" and reported no lobe at all, on every radius it swept.
 * The profile it was given ran 0.278 at the feet, 0.157 at 2.2 m and back UP to
 * 0.204 at 3.0 m: the district has an ambient-occlusion FLOOR, so a tenth of
 * the peak is a level the profile never reaches and the search never terminates.
 * The floor is not the pedestrian's halo. It is the rest of the street.
 *
 * So the background is measured, from the outermost metre of the search, and
 * the lobe is where the profile has decayed to `frac` of its RISE ABOVE THAT.
 * A subject that raises nothing above its surroundings gets a null radius and
 * says so, rather than being handed the width of the search window.
 */
export function lobeFrom(profile, frac = 0.10, bgFromM = 3.0, bodyW = 0.41) {
  const prof = (profile || []).filter((p) => p && typeof p.occ === 'number');
  if (!prof.length) return { contactOcc: null, backgroundOcc: null, backgroundRings: 0,
    riseOverBackground: null, lobeRadiusM: null, lobeBodyWidths: null };
  let s = 0, bgN = 0;
  for (const p of prof) if (p.rM >= bgFromM) { s += p.occ; bgN++; }
  const bg = bgN ? s / bgN : null;
  const peak = prof[0].occ;
  let lobeM = null;
  if (bg !== null && peak > bg + 0.01) {
    const cut = bg + (peak - bg) * frac;
    for (const p of prof) {
      if (p.rM < 0.15) continue;
      if (p.occ <= cut) { lobeM = p.rM; break; }
    }
  }
  return {
    contactOcc: +peak.toFixed(4),
    backgroundOcc: bg === null ? null : +bg.toFixed(4), backgroundRings: bgN,
    riseOverBackground: bg === null ? null : +(peak - bg).toFixed(4),
    lobeRadiusM: lobeM,
    lobeBodyWidths: lobeM === null ? null : +(lobeM / bodyW).toFixed(2),
  };
}

/**
 * Did one unchanged parameter set read the same twice? The instrument this file
 * replaced did not, and nobody noticed until it had produced a whole sweep of
 * differences it could not support. This is that check, made a condition of
 * the run rather than a thing to remember to do.
 */
export function repeatVerdict(pairs, tol) {
  const keys = pairs.map(([k, a, b]) => ({ k, first: a, again: b,
    delta: (a === null || a === undefined || b === null || b === undefined) ? null : +(b - a).toFixed(4) }));
  const bad = keys.filter((e) => e.delta === null || Math.abs(e.delta) > tol);
  return { tolerance: tol, keys, agreed: bad.length === 0, failed: bad.map((e) => e.k) };
}

if (SELFTEST) {
  // The reductions, on synthetic input, with no browser. Two of these are
  // regression tests for faults this instrument actually had.
  const w = 100, h = 100;
  const occ = (b, x, y) => 1 - b[(y * w + x) * 4] / 255;
  const bad = [];
  const near = (a, b, t, what) => { if (a === null || Math.abs(a - b) > t) bad.push(`${what}: ${a} != ${b}`); };

  const white = new Uint8Array(w * h * 4).fill(255);
  if (Math.abs(occ(white, 50, 50)) > 1e-9) bad.push('white buffer is not 0 occlusion');
  const grey = new Uint8Array(w * h * 4).fill(128);
  if (Math.abs(occ(grey, 50, 50) - (1 - 128 / 255)) > 1e-9) bad.push('grey buffer misread');

  // 1. A lobe on bare ground: 0.50 at the feet, linear to 0 at 2.0 m, no floor.
  //    A tenth of the rise is 0.05, which the ramp reaches at 1.8 m.
  const ramp = (peak, reach, floor) => {
    const p = [];
    for (let r = 0; r <= 4.0001; r += 0.1) {
      p.push({ rM: +r.toFixed(2), occ: +(floor + Math.max(0, peak * (1 - r / reach))).toFixed(4) });
    }
    return p;
  };
  const bare = lobeFrom(ramp(0.50, 2.0, 0));
  near(bare.lobeRadiusM, 1.8, 0.11, 'bare lobe radius');
  near(bare.lobeBodyWidths, 1.8 / 0.41, 0.3, 'bare lobe in body widths');

  // 2. THE REGRESSION. The same lobe standing on a 0.15 AO floor -- which is
  //    what the real district gave the previous pass. Peak 0.65, background
  //    0.15, so a tenth of the RISE is 0.20 and the answer is still 1.8 m. The
  //    old rule looked for a tenth of the PEAK, 0.065, which is below the floor
  //    and is never reached; that is exactly how a whole sweep came back empty.
  const floored = ramp(0.50, 2.0, 0.15);
  const onFloor = lobeFrom(floored);
  near(onFloor.lobeRadiusM, 1.8, 0.11, 'floored lobe radius');
  near(onFloor.backgroundOcc, 0.15, 0.005, 'floor detected as background');
  near(onFloor.riseOverBackground, 0.50, 0.005, 'rise over background');
  {
    // and the retired rule, run here so the failure it caused is on the record:
    const peak = floored[0].occ, cut = peak * 0.10;
    const hit = floored.find((p) => p.rM >= 0.15 && p.occ <= cut);
    if (hit) bad.push('peak-relative rule terminated on a floored profile; it should not');
  }

  // 3. Nothing there: a flat profile must report NO lobe, not the search width.
  const flat = lobeFrom(ramp(0, 2.0, 0.15));
  if (flat.lobeRadiusM !== null) bad.push(`flat profile invented a lobe at ${flat.lobeRadiusM} m`);
  near(flat.riseOverBackground, 0, 0.005, 'flat profile rise');

  // 4. An empty profile must not throw and must not answer.
  const none = lobeFrom([]);
  if (none.lobeRadiusM !== null || none.contactOcc !== null) bad.push('empty profile answered');

  // 5. The repeat guard has to fail on known-bad input, or it is decoration.
  const same = repeatVerdict([['a', 0.100, 0.1005], ['b', 0.300, 0.2990]], 0.010);
  if (!same.agreed) bad.push('repeat guard rejected two readings that agree');
  const drift = repeatVerdict([['a', 0.100, 0.1005], ['b', 0.300, 0.2400]], 0.010);
  if (drift.agreed) bad.push('repeat guard accepted a 0.060 drift');
  if (drift.failed.join() !== 'b') bad.push(`repeat guard blamed ${drift.failed.join()} not b`);
  const missing = repeatVerdict([['a', null, 0.10]], 0.010);
  if (missing.agreed) bad.push('repeat guard accepted a missing reading');

  console.log(bad.length ? `SELFTEST FAILED: ${bad.join('; ')}` : 'SELFTEST PASSED');
  process.exit(bad.length ? 3 : 0);
}

const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
console.log(`server ${JSON.stringify(srv)}`);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 180000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate((n) => { __district.setTraffic(0); __district.setPedestrians(n); __district.sky.cloudWind.set(0, 0); }, PEDS);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);

// The fivepoints hero framing, verbatim from tools/hero-shots.mjs.
const placed = await page.evaluate((cfg) => {
  const r = __district.district.meta.route;
  const a = r[cfg.wpA], b = r[cfg.wpB];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  const px = a.x - (dx / len) * cfg.back + nx * cfg.side;
  const pz = a.z - (dz / len) * cfg.back + nz * cfg.side;
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([px, cfg.height, pz],
    [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd], cfg.fov);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return { x: +px.toFixed(1), z: +pz.toFixed(1) };
}, CAM);
console.log(`${CAM.name} camera at (${placed.x}, ${placed.z})`);
{
  let last = -1, stable = 0;
  for (let i = 0; i < 80 && stable < 3; i++) {
    const m = await page.evaluate(() => __district.worldReport().meshes);
    stable = m === last ? stable + 1 : 0; last = m;
    if (stable < 3) await page.waitForTimeout(2500);
  }
  console.log(`world settled at ${last} chunk meshes`);
}
// The crowd fills on the RENDER loop's schedule, not the streamer's; on a loaded
// box those are minutes apart and a bench frozen too early has nobody in it.
try {
  await page.waitForFunction(() => {
    const P = __district.pedestrians(); return !!P && P.aliveCount >= 20;
  }, null, { timeout: 300000, polling: 1000 });
} catch { console.error('the crowd never populated'); }
console.log(`crowd populated: ${await page.evaluate(() => __district.pedestrians().aliveCount)} alive`);

// --------------------------------------------------------------- the subject
const subject = await page.evaluate(async (bodyW) => {
  const THREE = await import('/vendor/three.module.min.js');
  const D = __district, P = D.pedestrians(), scene = D.scene, cam = D.camera;
  if (!P._aoFrozen) { P.update = () => {}; P._aoFrozen = true; }
  cam.updateMatrixWorld();

  const isCrowd = (o) => { for (let n = o; n; n = n.parent) if (n.name === 'pedestrians') return true; return false; };
  const isSky = (o) => { for (let n = o; n; n = n.parent) { const m = n.name; if (m === 'sky' || m === 'skydome' || m === 'weather') return true; } return false; };
  const ground = [], casters = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible || isCrowd(o) || isSky(o)) return;
    ground.push(o);
    if (o.castShadow) casters.push(o);
  });
  const rc = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const L = new THREE.Vector3().copy(D.tod.sun.position).sub(D.tod.sun.target.position).normalize();
  // THE FIRST HIT IS NOT THE GROUND AND NEITHER IS THE LOWEST. A ray dropped
  // from y = 8 over the pavement at a shopfront meets the AWNING first, and
  // calling that the ground is how the wall/pavement finder threw away 64 of
  // the 111 edges in range. But the lowest hit is not it either: streaming.js
  // lays a land pad 0.05 m under the district and the chunk's paving sits on
  // top of it, so "lowest" is the pad, whose material is not 'sidewalk', and
  // taking that made the whole bench search fail with "no clear sunlit brick
  // slot in frame".
  //
  // What the caller wants is THE SURFACE YOU WOULD STAND ON: the highest hit
  // that is still within half a metre of the lowest one. Above that is
  // overhead, and whether overhead matters depends on the caller -- the lobe
  // wants open sky over bare brick, the wall/pavement crease is happy under an
  // awning because the awning is part of what it is measuring.
  const probe = (x, z) => {
    rc.set(new THREE.Vector3(x, 8, z), down);
    const h = rc.intersectObjects(ground, false);
    if (!h.length) return null;
    let loY = Infinity;
    for (const q of h) if (q.point.y < loY) loY = q.point.y;
    let s = -1;
    for (let i = 0; i < h.length; i++) {
      if (h[i].point.y > loY + 0.5) continue;
      if (s < 0 || h[i].point.y > h[s].point.y) s = i;
    }
    if (s < 0) return null;
    return { y: h[s].point.y, mat: (h[s].object.material && h[s].object.material.name) || '',
      name: h[s].object.name || '', padY: loY,
      topY: h[0].point.y, topName: h[0].object.name || '',
      overhead: h[0].point.y > h[s].point.y + 0.5, hits: h.length };
  };
  const sunlit = (x, y, z) => {
    rc.set(new THREE.Vector3(x, y + 0.25, z), L);
    rc.far = 260;
    const h = rc.intersectObjects(casters, false);
    rc.far = Infinity;
    return h.length === 0;
  };
  const project = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(cam);
    return { x: (v.x * 0.5 + 0.5) * 1600, y: (-v.y * 0.5 + 0.5) * 900, z: v.z };
  };
  const onProps = (g) => !!g && /^props:/.test(g.name);
  // Something standing on this spot, or overhanging it: the lobe wants open sky
  // over bare brick, so it rejects both. The wall/pavement crease does not care
  // what is overhead -- an awning above a doorway is part of the thing being
  // measured -- so it only asks onProps().
  const cluttered = (g) => !g || onProps(g) || g.overhead;

  // A clear, sunlit patch of the reviewers' own brick, in the lower half of the
  // frame where a lobe is resolvable. Searched over the sidewalk in front of the
  // camera rather than picked, and every acceptance is a geometric test.
  // SEARCHED FROM THE CAMERA, not from a route waypoint. This used to walk out
  // from route[3] over 6-40 m, which is the ground in front of the fivepoints
  // framing and the ground BEHIND the corridor one -- the corridor camera
  // stands 55 m further along the same axis, so the search ran off the back of
  // it and reported "no clear sunlit brick slot in frame" on a street paved
  // with it. The camera's own forward vector works for any framing.
  const fwdV = new THREE.Vector3();
  cam.getWorldDirection(fwdV); fwdV.y = 0; fwdV.normalize();
  const fx = fwdV.x, fz = fwdV.z, sx = -fz, sz = fx;
  const ox = cam.position.x, oz = cam.position.z;
  let slot = null;
  outer:
  for (let along = 8; along <= 55; along += 1.5) {
    for (const across of [7, -7, 9, -9, 11, -11, 5, -5, 13, -13, 3, -3]) {
      const x = ox + fx * along + sx * across, z = oz + fz * along + sz * across;
      const g = probe(x, z);
      if (!g || g.y > 0.30 || g.y < -1 || g.mat !== 'sidewalk' || cluttered(g)) continue;
      if (!sunlit(x, g.y, z)) continue;
      // 2.6 m of clear, flat, prop-free brick all round: the lobe has to have
      // somewhere to be measured.
      let clear = true;
      for (let k = 0; k < 12 && clear; k++) {
        const th = (k / 12) * Math.PI * 2;
        for (const rad of [1.3, 2.6]) {
          const q = probe(x + Math.cos(th) * rad, z + Math.sin(th) * rad);
          if (!q || q.y > 0.30 || cluttered(q) || q.mat !== 'sidewalk') { clear = false; break; }
        }
      }
      if (!clear) continue;
      const p = project(x, g.y, z);
      if (p.x < 250 || p.x > 1350 || p.y < 420 || p.y > 820 || p.z > 1) continue;
      slot = { x, z, y: g.y, screen: p, along, across };
      break outer;
    }
  }
  if (!slot) return { ok: false, why: 'no clear sunlit brick slot in frame' };

  // Teleport one ped there and stand it up: feet together, so its width IS the
  // 0.41 m shoulder and the lobe has one unambiguous denominator.
  let idx = -1;
  for (let i = 0; i < P.count; i++) if (P.peds[i]) { idx = i; break; }
  if (idx < 0) return { ok: false, why: 'no live pedestrian' };
  const ped = P.peds[idx];
  ped.x = slot.x; ped.z = slot.z; ped.v = 0; ped.phase = 0; ped.stride = undefined;
  ped.hscale = 1.0; ped.build = 1.0; ped.yaw = Math.atan2(-L.z, -L.x);
  for (let i = 0; i < P.count; i++) {
    if (i === idx || !P.peds[i]) continue;
    const q = P.peds[i];
    if (Math.hypot(q.x - slot.x, q.z - slot.z) < 7) { P._hide(i); P.peds[i] = null; }
  }
  P._camX = cam.position.x; P._camZ = cam.position.z; P._camSeen = true;
  P.setNearLod(0);                 // the far tier: what 84 of 96 peds are
  P._assignNearLod(cam.position.x, cam.position.z);
  for (let i = 0; i < P.count; i++) {
    const q = P.peds[i];
    if (!q) { P._hide(i); continue; }
    P._writePose(i, q, 0.838 * q.hscale);
  }
  for (const m of [P.torsos, P.heads, P.limbs, P.nearTorsos, P.nearHeads, P.nearLimbs]) {
    if (!m) continue;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  P._syncNearCounts();
  P._colorDirty = false; P._nearColorDirty = false;

  // Metres per screen pixel on the ground at the subject, for the lobe profile.
  const p0 = project(slot.x, slot.y, slot.z), p1 = project(slot.x + 0.5, slot.y, slot.z + 0.5);
  const mPerPx = Math.hypot(0.5, 0.5) / (Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1);

  // ------------------------------------------------------------ visibility
  // Every sample point below has to be a point the camera can actually SEE the
  // ground at. A screen coordinate is not enough: a ring point 2 m behind the
  // subject projects onto the subject's shirt, and a pavement point at the foot
  // of a wall projects onto the parked car in front of it. Both would report
  // some other object's occlusion as the number under test. So each candidate
  // is shot at from the camera and kept only if the first thing the ray meets
  // is the point itself.
  const camPos = cam.position.clone();
  const rc2 = new THREE.Raycaster();
  const visible = (x, y, z, tol) => {
    const to = new THREE.Vector3(x, y, z);
    const d = to.clone().sub(camPos);
    const len = d.length();
    rc2.set(camPos, d.normalize());
    rc2.far = len + 1;
    const h = rc2.intersectObjects(ground, false);
    rc2.far = Infinity;
    return h.length > 0 && Math.abs(h[0].distance - len) <= (tol ?? 0.20);
  };
  // The crowd is excluded from `ground` (its meshes are instanced and raycasting
  // 96 peds x 8 bones per sample would cost minutes), so the subject's own body
  // is rejected by arithmetic instead: it fills a screen column rising from its
  // feet, and nothing on the pavement behind it is visible through that column.
  const footPx = slot.screen;
  const headPx = project(slot.x, slot.y + 1.85, slot.z);
  const halfBodyPx = Math.abs(project(slot.x + 0.42, slot.y, slot.z).x - footPx.x) + 3;
  const behindSubject = (p) => p.y < footPx.y + 2 && p.y > headPx.y - 6
    && Math.abs(p.x - footPx.x) < halfBodyPx;

  // ------------------------------------------------------------- LOBE RINGS
  // TRUE circles on the brick, not circles on the screen. The pavement is seen
  // at a grazing angle, so a screen-space circle is an ellipse on the ground
  // and the "radius" it reports is two different distances depending on which
  // way you look. These rings are laid out in metres at the subject's feet and
  // then projected, and every point is checked to be flat, prop-free sidewalk
  // at the subject's own height before it is kept: a ring point that lands on a
  // kerb, a tree pit or a bin base would report that object's occlusion as the
  // pedestrian's halo. Out to 4 m, which is 9.8 body widths -- comfortably past
  // the 2.2 m kernel, so the profile has somewhere to flatten out.
  const rings = [];
  const ringCensus = { tried: 0, offSidewalk: 0, notFlat: 0, onProps: 0, offScreen: 0,
    behind: 0, occluded: 0, kept: 0 };
  for (let rm = 0; rm <= 4.0001; rm += 0.1) {
    const pts = [];
    const N = rm < 0.05 ? 1 : Math.max(8, Math.round(rm * 16));
    for (let k = 0; k < N; k++) {
      ringCensus.tried++;
      const th = (k / N) * Math.PI * 2 + 0.19;
      const x = slot.x + Math.cos(th) * rm, z = slot.z + Math.sin(th) * rm;
      if (rm > 0.05) {
        const q = probe(x, z);
        if (!q) { ringCensus.offSidewalk++; continue; }
        if (cluttered(q)) { ringCensus.onProps++; continue; }
        if (q.mat !== 'sidewalk') { ringCensus.offSidewalk++; continue; }
        if (Math.abs(q.y - slot.y) > 0.06) { ringCensus.notFlat++; continue; }
      }
      const p = project(x, slot.y, z);
      if (p.z > 1 || p.x < 6 || p.x > 1594 || p.y < 6 || p.y > 894) { ringCensus.offScreen++; continue; }
      if (rm > 0.05 && behindSubject(p)) { ringCensus.behind++; continue; }
      if (rm > 0.05 && !visible(x, slot.y, z, 0.25)) { ringCensus.occluded++; continue; }
      ringCensus.kept++;
      pts.push([+p.x.toFixed(1), +p.y.toFixed(1)]);
    }
    rings.push({ rM: +rm.toFixed(2), n: pts.length, pts });
  }

  // ------------------------------------------------------- REAL CONTACTS
  // A bin base and a bollard base, found from the props meshes' OWN VERTICES.
  // The dressing pass merges every prop in a bucket into one mesh, so there is
  // no per-object node to look up and no transform to read; what there is, is
  // world-space vertices. A previous pass walked a 0.6 m ground grid hunting
  // for something raised, and found two bollards and no bin in 46 m of kerb --
  // not because there is no bin but because a 0.64 m-wide bin is smaller than
  // the grid that was looking for it. Vertices cannot be stepped over.
  //
  // Connected components on a 0.20 m plan grid: props stand further apart than
  // that, so one component is one object. Its plan extent then says what it is.
  // src/streetfurniture.js: a bin is a 6-sided prism of radius 0.29-0.32 and
  // 1.06 m tall, a bollard 0.115-0.098 and ~1.0 m, a hydrant 0.19 and 0.81 m.
  const propMeshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible && /^props:/.test(o.name)) propMeshes.push(o); });
  const cellOf = (x, z) => `${Math.round(x / 0.2)},${Math.round(z / 0.2)}`;
  const cells = new Map();
  let vertsRead = 0;
  for (const m of propMeshes) {
    // The bucket's bounding SPHERE, not its centre. A far-tier bucket is 512 m
    // across; rejecting it because its centre is 80 m away threw out every prop
    // in the frame and read 0 vertices from 14 meshes on the first attempt.
    const c = m.userData && m.userData.c, rad = (m.userData && m.userData.r) || 0;
    if (c && Math.hypot(c.x - camPos.x, c.z - camPos.z) - rad > 70) continue;
    const pa = m.geometry.getAttribute('position');
    if (!pa) continue;
    m.updateMatrixWorld();
    const v = new THREE.Vector3();
    for (let i = 0; i < pa.count; i += 1) {
      v.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld);
      if (Math.hypot(v.x - camPos.x, v.z - camPos.z) > 55) continue;
      vertsRead++;
      const k = cellOf(v.x, v.z);
      let e = cells.get(k);
      if (!e) cells.set(k, (e = { n: 0, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, y0: 1e9, y1: -1e9 }));
      e.n++;
      if (v.x < e.x0) e.x0 = v.x; if (v.x > e.x1) e.x1 = v.x;
      if (v.z < e.z0) e.z0 = v.z; if (v.z > e.z1) e.z1 = v.z;
      if (v.y < e.y0) e.y0 = v.y; if (v.y > e.y1) e.y1 = v.y;
    }
  }
  const seen = new Set();
  const comps = [];
  for (const k of cells.keys()) {
    if (seen.has(k)) continue;
    const stack = [k]; seen.add(k);
    const c = { n: 0, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, y0: 1e9, y1: -1e9 };
    while (stack.length) {
      const cur = stack.pop(), e = cells.get(cur);
      c.n += e.n;
      if (e.x0 < c.x0) c.x0 = e.x0; if (e.x1 > c.x1) c.x1 = e.x1;
      if (e.z0 < c.z0) c.z0 = e.z0; if (e.z1 > c.z1) c.z1 = e.z1;
      if (e.y0 < c.y0) c.y0 = e.y0; if (e.y1 > c.y1) c.y1 = e.y1;
      const g = cur.split(',');
      const gx = Number(g[0]), gz = Number(g[1]);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const nk = `${gx + dx},${gz + dz}`;
        if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    comps.push(c);
  }
  const contactCensus = { comps: comps.length, vertsRead, propMeshes: propMeshes.length,
    binShaped: 0, bollardShaped: 0, rejectedNearRing: 0, rejectedFarRing: 0 };
  const contacts = [];
  const KINDS = [
    { kind: 'bin', rMin: 0.24, rMax: 0.44, hMin: 0.80, hMax: 1.35 },
    { kind: 'bollard', rMin: 0.07, rMax: 0.17, hMin: 0.75, hMax: 1.25 },
  ];
  const cand = [];
  for (const c of comps) {
    const rx = (c.x1 - c.x0) / 2, rz = (c.z1 - c.z0) / 2;
    const rr = Math.max(rx, rz), hh = c.y1 - c.y0;
    const K = KINDS.find((k) => rr >= k.rMin && rr <= k.rMax && hh >= k.hMin && hh <= k.hMax
      && Math.min(rx, rz) > rr * 0.55);
    if (!K) continue;
    if (K.kind === 'bin') contactCensus.binShaped++; else contactCensus.bollardShaped++;
    cand.push({ kind: K.kind, x: (c.x0 + c.x1) / 2, z: (c.z0 + c.z1) / 2, rM: +rr.toFixed(3),
      hM: +hh.toFixed(2), baseY: c.y0,
      dist: Math.hypot((c.x0 + c.x1) / 2 - camPos.x, (c.z0 + c.z1) / 2 - camPos.z) });
  }
  // IN FRONT FIRST, THEN NEAREST. Sorting purely by distance put the props
  // standing behind the camera at the head of the queue -- they are the closest
  // things in the district to a camera on a pavement -- and every one of them
  // failed the on-screen test before a prop that was actually in shot got
  // looked at, which is how a 45.8 m bin came to be the nearest bin.
  for (const c of cand) {
    const p = project(c.x, c.baseY, c.z);
    c.inFrame = p.z <= 1 && p.x > 30 && p.x < 1570 && p.y > 30 && p.y < 880;
    c.screen = [Math.round(p.x), Math.round(p.y)];
  }
  cand.sort((a, b) => (a.inFrame === b.inFrame ? a.dist - b.dist : (a.inFrame ? -1 : 1)));
  contactCensus.candidates = cand.slice(0, 14).map((c) => ({ kind: c.kind, dist: +c.dist.toFixed(1),
    rM: c.rM, hM: c.hM, inFrame: c.inFrame, screen: c.screen }));
  for (const K of ['bin', 'bollard']) {
    for (const c of cand) {
      if (c.kind !== K || contacts.some((q) => q.kind === K)) continue;
      // A contact ring just clear of the footprint, and a background ring 2.2 m
      // out. The contact number is the DIFFERENCE: how much darker the AO pass
      // makes the pavement where it meets the object than the same pavement
      // two metres away. That is a within-frame ratio, so it survives whatever
      // the daylight round does to exposure.
      const ringAt = (rad) => {
        const out = [];
        for (let k = 0; k < 24; k++) {
          const th = (k / 24) * Math.PI * 2;
          const x = c.x + Math.cos(th) * rad, z = c.z + Math.sin(th) * rad;
          const g = probe(x, z);
          if (!g || onProps(g) || Math.abs(g.y - c.baseY) > 0.12) continue;
          const p = project(x, g.y, z);
          if (p.z > 1 || p.x < 6 || p.x > 1594 || p.y < 6 || p.y > 894) continue;
          if (!visible(x, g.y, z, 0.35)) continue;
          out.push([+p.x.toFixed(1), +p.y.toFixed(1)]);
        }
        return out;
      };
      const near = ringAt(c.rM + 0.14), far = ringAt(c.rM + 2.2);
      if (near.length < 4) { contactCensus.rejectedNearRing++; continue; }
      if (far.length < 4) { contactCensus.rejectedFarRing++; continue; }
      contacts.push({ kind: K, radiusM: c.rM, heightM: c.hM, dist: +c.dist.toFixed(1),
        near, far });
      break;
    }
  }

  // -------------------------------------------- WALL / PAVEMENT, geometrically
  // The previous finder returned 0 pairs and the reason was a bad outward test:
  // it decided which side of a wall segment was outdoors by probing 1.5 m each
  // way and taking the side that hit ground. The ground mesh runs UNDER the
  // buildings, so both sides hit ground, both tests failed, and every segment
  // was skipped. The building footprint is a polygon and this is a point-in-
  // polygon question, so it is now answered as one, exactly.
  const inRing = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) c = !c;
    }
    return c;
  };
  const junctions = [];
  const jCensus = { chunks: 0, buildings: 0, edges: 0, tooShort: 0, tooFar: 0, noGround: 0,
    offScreen: 0, tooClose: 0, occluded: 0, kept: 0 };
  const cs = D.district.meta.chunkSize;
  const ccx = Math.floor(camPos.x / cs), ccz = Math.floor(camPos.z / cs);
  const bSeen = new Set();
  outerJ:
  for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
    const c = D.district.chunks[`${ccx + ddx},${ccz + ddz}`];
    if (!c) continue;
    jCensus.chunks++;
    for (const bi of c.buildings) {
      if (bSeen.has(bi)) continue;
      bSeen.add(bi); jCensus.buildings++;
      const ring = D.district.buildings[bi].p;
      for (let i = 0; i < ring.length; i++) {
        jCensus.edges++;
        const A = ring[i], B = ring[(i + 1) % ring.length];
        const ex = B[0] - A[0], ez = B[1] - A[1], el = Math.hypot(ex, ez);
        if (el < 2.5) { jCensus.tooShort++; continue; }
        // FOUR STATIONS ALONG EACH EDGE, not just the midpoint. A 30 m frontage
        // seen from an oblique camera has its midpoint off the side of the
        // frame while both of its thirds are in shot; sampling only midpoints
        // rejected 80 of 95 in-range edges as off-screen and kept three pairs.
        for (const t of [0.2, 0.4, 0.6, 0.8]) {
        const mx = A[0] + ex * t, mz = A[1] + ez * t;
        // 130 m, not 55: at 55 m this rejected 261 of 306 edges and kept ONE
        // pair. Distance is the wrong filter here anyway -- what matters is
        // whether the camera can see the pavement at the foot of the wall, and
        // the visibility ray below answers that exactly. This bound is only to
        // keep the ray count finite.
        if (Math.hypot(mx - camPos.x, mz - camPos.z) > 130) { jCensus.tooFar++; continue; }
        let nx2 = -ez / el, nz2 = ex / el;
        if (inRing(ring, mx + nx2 * 0.5, mz + nz2 * 0.5)) { nx2 = -nx2; nz2 = -nz2; }
        const nearP = [mx + nx2 * 0.12, mz + nz2 * 0.12];
        const farP = [mx + nx2 * 1.80, mz + nz2 * 1.80];
        const gn = probe(nearP[0], nearP[1]), gf = probe(farP[0], farP[1]);
        if (!gn || !gf || gn.y > 0.45 || gf.y > 0.45 || onProps(gn) || onProps(gf)) {
          jCensus.noGround++; continue;
        }
        const pn = project(nearP[0], gn.y, nearP[1]);
        const pf = project(farP[0], gf.y, farP[1]);
        if (pn.z > 1 || pf.z > 1
          || pn.x < 20 || pn.x > 1580 || pn.y < 30 || pn.y > 890
          || pf.x < 20 || pf.x > 1580 || pf.y < 30 || pf.y > 890) { jCensus.offScreen++; continue; }
        // The AO target is HALF resolution. Two samples less than 16 screen
        // pixels apart are 8 apart in the buffer and the depth-aware blur has
        // already mixed them, so a pair that close measures its own blur.
        if (Math.hypot(pn.x - pf.x, pn.y - pf.y) < 10) { jCensus.tooClose++; continue; }
        if (!visible(nearP[0], gn.y, nearP[1], 0.30) || !visible(farP[0], gf.y, farP[1], 0.30)) {
          jCensus.occluded++; continue;
        }
        const wLo = project(mx + nx2 * 0.03, gn.y + 0.25, mz + nz2 * 0.03);
        const wHi = project(mx + nx2 * 0.03, gn.y + 2.20, mz + nz2 * 0.03);
        const wallOk = wLo.z <= 1 && wHi.z <= 1 && wLo.x > 20 && wLo.x < 1580
          && wHi.x > 20 && wHi.x < 1580 && wHi.y > 20 && wLo.y < 890
          && Math.hypot(wLo.x - wHi.x, wLo.y - wHi.y) >= 16;
        jCensus.kept++;
        junctions.push({ bi, groundNear: pn, groundFar: pf,
          wallLo: wallOk ? wLo : null, wallHi: wallOk ? wHi : null,
          dist: +Math.hypot(mx - camPos.x, mz - camPos.z).toFixed(1) });
        if (junctions.length >= 60) break outerJ;
        }
      }
    }
  }

  // --------------------------------------------------- FACADE DEPTH, by ray
  // AO's real job. src/facades.js builds windows with BUILT DEPTH: the glazing
  // plane sits `depth.reveal` behind the wall face -- 0.10 m on the cheapest
  // recipe, 0.34 m on the deepest -- with jambs returning to it and a head
  // shelf over it. Those are the features a contact-scale kernel exists to
  // find, and they are the reason a small radius might not be free.
  //
  // Rather than trust a footprint to say where a window is, this SCANS: rows of
  // rays across a facade, each one recording how far behind the wall plane it
  // landed. A pixel 0.06-0.65 m behind the modal plane is inside a reveal; a
  // pixel on the plane is flush wall; a downward-facing hit is a head shelf or
  // a cornice soffit. Then the AO buffer is read at each class. If the reveal
  // does not read darker than the wall beside it, the kernel is not doing the
  // one thing that is not a halo.
  const facadeSamples = { reveal: [], flush: [], soffit: [] };
  const fCensus = { coarseRays: 0, wallHits: 0, groups: 0, probeRays: 0, chosen: null,
    candidates: [], fineRays: 0, mode: null };
  {
    const nm = new THREE.Matrix3();
    const wallHit = (px, py, objs) => {
      const ndc = new THREE.Vector2((px / 1600) * 2 - 1, -(py / 900) * 2 + 1);
      rc2.setFromCamera(ndc, cam);
      const h = rc2.intersectObjects(objs || ground, false);
      if (!h.length) return null;
      const n = h[0].face
        ? h[0].face.normal.clone().applyNormalMatrix(nm.getNormalMatrix(h[0].object.matrixWorld)).normalize()
        : new THREE.Vector3(0, 1, 0);
      return { obj: h[0].object, p: h[0].point.clone(), n, d: h[0].distance };
    };
    // Coarse: where is there a facade, and which mesh and which way is it facing?
    const tally = new Map();
    for (let py = 90; py <= 600; py += 34) {
      for (let px = 100; px <= 1500; px += 44) {
        fCensus.coarseRays++;
        const h = wallHit(px, py);
        if (!h || Math.abs(h.n.y) > 0.35 || h.d < 7 || h.d > 55) continue;
        fCensus.wallHits++;
        const key = `${h.obj.id}|${Math.round(h.n.x * 4)},${Math.round(h.n.z * 4)}`;
        let t = tally.get(key);
        if (!t) tally.set(key, (t = { obj: h.obj, n: h.n.clone(), p0: h.p.clone(), pts: [], sumD: 0 }));
        t.pts.push([px, py]); t.sumD += h.d;
      }
    }
    fCensus.groups = tally.size;

    // ------------------------------------------------------ CHOOSE BY DEPTH
    // Not by how much wall is on screen. src/facades.js spends built depth only
    // on the frontages named in the chunk's plan and only on edges over 4.5 m:
    // "detailing all of them tripled the streamed geometry and blew the chunk-
    // build deadline for faces nobody ever sees", so party walls and rear
    // elevations keep the flat painted quad they always had. Choosing the
    // biggest wall on screen chose one of those -- 2737 fine-scan hits on the
    // retailStrip and EVERY ONE at the same offset, a single-bin histogram.
    //
    // Worse, the run before that reported 451 reveal pixels off the same wall,
    // because the modal plane was then computed across two meshes at different
    // depths and the second building's face landed inside the reveal window.
    // That number was a plane separation between two buildings, not a reveal.
    // So each candidate is now PROBED for depth before one is chosen, and the
    // winner is the wall with the most pixels genuinely recessed behind its own
    // modal plane by a window reveal's worth: 0.06 to 0.60 m.
    const probe1D = (t) => {
      const xs = t.pts.map((p) => p[0]), ys = t.pts.map((p) => p[1]);
      const cx = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
      const cy = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
      const x0 = Math.max(20, Math.min(...xs) - 120), x1 = Math.min(1580, Math.max(...xs) + 120);
      const offs = [];
      for (const py of [cy - 40, cy, cy + 40]) {
        if (py < 20 || py > 760) continue;
        for (let px = x0; px <= x1; px += 4) {
          fCensus.probeRays++;
          const h = wallHit(px, py, [t.obj]);
          if (!h) continue;
          offs.push(h.p.clone().sub(t.p0).dot(t.n));
        }
      }
      if (offs.length < 40) return { cx, cy, x0, x1, n: offs.length, mode: 0, recessed: 0 };
      const hist = new Map();
      for (const o of offs) { const b = Math.round(o / 0.02); hist.set(b, (hist.get(b) || 0) + 1); }
      let mode = 0, mBest = -1;
      for (const kv of hist) if (kv[1] > mBest) { mBest = kv[1]; mode = kv[0] * 0.02; }
      let recessed = 0;
      for (const o of offs) { const rel = o - mode; if (rel < -0.055 && rel > -0.60) recessed++; }
      return { cx, cy, x0, x1, n: offs.length, mode: +mode.toFixed(3), recessed };
    };
    let best = null;
    for (const t of tally.values()) {
      if (t.pts.length < 3) continue;
      // A FACADE, and nothing else. The first depth-ranked run picked an
      // unnamed mesh 26 m out with 27 recessed pixels, ahead of two real
      // facades: a parked car or a signage assembly has more depth variation
      // than a window reveal and none of it is a window reveal.
      if (!/:facade:/.test(t.obj.name || '')) continue;
      const pr = probe1D(t);
      fCensus.candidates.push({ mesh: t.obj.name || `#${t.obj.id}`,
        normal: [+t.n.x.toFixed(2), +t.n.z.toFixed(2)], coarseHits: t.pts.length,
        meanDist: +(t.sumD / t.pts.length).toFixed(1), probed: pr.n, recessed: pr.recessed });
      if (!best || pr.recessed > best.pr.recessed) best = Object.assign({ pr }, t);
    }
    fCensus.candidates.sort((a, b) => b.recessed - a.recessed);

    if (best && best.pr.recessed >= 8) {
      const { cx, cy, x0, x1 } = best.pr;
      fCensus.chosen = { mesh: best.obj.name || `#${best.obj.id}`, coarseHits: best.pts.length,
        meanDist: +(best.sumD / best.pts.length).toFixed(1), cx, cy,
        normal: [+best.n.x.toFixed(2), +best.n.y.toFixed(2), +best.n.z.toFixed(2)],
        recessedInProbe: best.pr.recessed };
      // The fine scan runs against that facade AND everything else in the same
      // chunk, so a reveal hidden behind the awning in front of it is not
      // counted as a reveal that reads -- but the depth CLASSES are only
      // applied to hits on the chosen wall itself, because another building's
      // face is not this facade's reveal however far behind this plane it sits.
      const prefix = (best.obj.name || '').replace(/:[^:]*$/, ':').replace(/facade:$/, '');
      const objs = prefix ? ground.filter((o) => (o.name || '').startsWith(prefix)) : [best.obj];
      if (!objs.includes(best.obj)) objs.push(best.obj);
      fCensus.scanMeshes = objs.map((o) => o.name || `#${o.id}`);
      const raw = [];
      // 12 px between rows: a head shelf over a window is 0.16 m deep, which at
      // 13 m is 11 screen pixels, and 25-pixel rows stepped over all of them.
      for (let dy = -216; dy <= 216; dy += 10) {
        const py = Math.round(cy + dy);
        if (py < 20 || py > 760) continue;
        for (let px = x0; px <= x1; px += 3) {
          fCensus.fineRays++;
          const h = wallHit(px, py, objs);
          if (!h) { raw.push(null); continue; }
          raw.push({ px, py, off: h.p.clone().sub(best.p0).dot(best.n), ny: h.n.y, d: h.d,
            wall: h.obj === best.obj, mesh: h.obj.name || `#${h.obj.id}` });
        }
        raw.push(null);
      }
      const hist = new Map();
      for (const r of raw) {
        if (!r || !r.wall) continue;
        const b = Math.round(r.off / 0.02); hist.set(b, (hist.get(b) || 0) + 1);
      }
      let mode = 0, mBest = -1;
      for (const kv of hist) if (kv[1] > mBest) { mBest = kv[1]; mode = kv[0] * 0.02; }
      fCensus.mode = +mode.toFixed(3);
      fCensus.byMesh = {};
      for (const r of raw) { if (r) fCensus.byMesh[r.mesh] = (fCensus.byMesh[r.mesh] || 0) + 1; }
      fCensus.offHist = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([b, n]) => [+(b * 0.02 - mode).toFixed(2), n]);
      const cls = raw.map((r) => {
        if (!r) return null;
        if (r.ny < -0.35) return 'soffit';
        if (!r.wall) return 'other';
        const rel = r.off - mode;
        if (rel < -0.055 && rel > -0.65) return 'reveal';
        if (Math.abs(rel) < 0.025 && Math.abs(r.ny) < 0.35) return 'flush';
        return 'other';
      });
      // Keep only pixels whose neighbours agree, so a sample sits INSIDE its
      // class rather than on the transition the half-res blur smears. Three
      // pixels either side at a 3-px step is 9 screen pixels, which is 4-5 in
      // the half-resolution AO target the blur ran over.
      for (let i = 0; i < raw.length; i++) {
        const c = cls[i];
        if (!c || c === 'other') continue;
        let ok = true;
        for (const dOff of [-3, -2, -1, 1, 2, 3]) {
          const j = i + dOff;
          if (j < 0 || j >= cls.length || cls[j] !== c) { ok = false; break; }
        }
        if (ok) facadeSamples[c].push([raw[i].px, raw[i].py]);
      }
    }
  }

  return {
    ok: true, pedIdx: idx, slot, mPerPx: +mPerPx.toFixed(5), bodyWidthPx: +(bodyW / mPerPx).toFixed(1),
    rings, ringCensus, contacts, contactCensus, junctions, jCensus,
    facade: { samples: facadeSamples, census: fCensus,
      counts: { reveal: facadeSamples.reveal.length, flush: facadeSamples.flush.length,
        soffit: facadeSamples.soffit.length } },
    sunElevDeg: +((Math.asin(L.y) * 180) / Math.PI).toFixed(2),
    cam: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
    alive: P.aliveCount,
  };
}, BODY_W);

if (!subject.ok) { console.error('subject failed:', subject.why); await browser.close(); process.exit(2); }
console.log(`subject at (${subject.slot.x.toFixed(1)}, ${subject.slot.z.toFixed(1)}) ` +
  `screen (${subject.slot.screen.x.toFixed(0)}, ${subject.slot.screen.y.toFixed(0)}), ` +
  `${subject.mPerPx.toFixed(4)} m/px, body = ${subject.bodyWidthPx} px`);
{
  // Every acquisition reports a census, so a metric that comes back empty says
  // WHY it is empty. Three of five came back empty on the previous run and the
  // reasons were all in target acquisition, none of them in the reading.
  const rc = subject.ringCensus;
  console.log(`lobe rings: ${subject.rings.filter((r) => r.n > 0).length}/${subject.rings.length} usable, ` +
    `${rc.kept}/${rc.tried} points kept (off-sidewalk ${rc.offSidewalk}, not-flat ${rc.notFlat}, ` +
    `props ${rc.onProps}, off-screen ${rc.offScreen}, behind subject ${rc.behind}, occluded ${rc.occluded})`);
  const cc = subject.contactCensus;
  console.log(`contacts: ${subject.contacts.map((c) => `${c.kind} r=${c.radiusM} h=${c.heightM} at ${c.dist} m ` +
    `(${c.near.length} contact / ${c.far.length} background points)`).join(', ') || 'NONE'}` +
    `  [${cc.comps} components from ${cc.vertsRead} vertices in ${cc.propMeshes} prop meshes; ` +
    `${cc.binShaped} bin-shaped, ${cc.bollardShaped} bollard-shaped, ` +
    `${cc.rejectedNearRing} rejected on the contact ring]`);
  console.log(`  contact candidates: ${(cc.candidates || []).slice(0, 8)
    .map((c) => `${c.kind[0]}@${c.dist}m${c.inFrame ? '' : '(behind)'}`).join(' ')}`);
  const jc = subject.jCensus;
  console.log(`wall/pavement pairs: ${subject.junctions.length}` +
    `  [${jc.buildings} buildings in ${jc.chunks} chunks, ${jc.edges} edges: too short ${jc.tooShort}, ` +
    `too far ${jc.tooFar}, no ground ${jc.noGround}, off screen ${jc.offScreen}, too close ${jc.tooClose}, ` +
    `occluded ${jc.occluded}]`);
  const f = subject.facade;
  console.log(`facade depth scan: ${f.counts.reveal} reveal, ${f.counts.flush} flush, ${f.counts.soffit} soffit px` +
    `  [${f.census.wallHits}/${f.census.coarseRays} coarse hits in ${f.census.groups} wall groups, ` +
    `${f.census.probeRays} depth-probe rays, ${f.census.fineRays} fine rays` +
    (f.census.chosen
      ? `, chose ${f.census.chosen.mesh} at ${f.census.chosen.meanDist} m with ` +
        `${f.census.chosen.recessedInProbe} recessed probe px`
      : ', NO FACADE WITH BUILT DEPTH FOUND') + ']');
  console.log(`  depth candidates: ${(f.census.candidates || []).slice(0, 6)
    .map((c) => `${c.mesh.replace(/^chunk:[^:]*:lod\d+:/, '')}@${c.meanDist}m ${c.recessed}/${c.probed}`).join('  ') || 'none'}`);
  if (f.census.offHist) console.log(`  offsets from the wall plane (m, px): ${JSON.stringify(f.census.offHist)}`);
}

// --acquire stops here. Finding the targets is the part that needs iterating
// and the sweep behind it is thirteen settles long, so there is a way to check
// the census without paying for the measurement.
if (has('acquire')) {
  fs.writeFileSync(`docs/ao-sweep-${TAG}-acquire.json`, JSON.stringify({ tag: TAG, subject, errors }, null, 1));
  console.log(`\nacquire only: wrote docs/ao-sweep-${TAG}-acquire.json`);
  if (errors.length) console.log('PAGE ERRORS:', errors);
  await browser.close();
  process.exit(0);
}

const settle = async () => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 3, f0, { timeout: 600000, polling: 200 });
};

/**
 * Read the AO buffer and reduce it to this round's numbers.
 *
 * Everything here is a DIFFERENCE OR A RATIO INSIDE ONE BUFFER. The absolute
 * level of the AO term moves with intensity and strength by construction, so
 * "the halo is 0.28" says nothing on its own; what says something is how far
 * out the halo is still above the pavement around it, and how much darker a
 * reveal is than the wall 30 cm to its left in the same frame.
 */
async function readAO(subj) {
  return page.evaluate((S) => {
    const D = __district, post = D.post, r = D.renderer;
    const rt = post.aoBlurRT;
    const w = rt.width, h = rt.height;
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    // The target is bottom-up; screen y maps to h-1-(y*h/900).
    const sx = w / 1600, sy = h / 900;
    const occAt = (x, y) => {
      const bx = Math.round(x * sx), by = Math.round(h - 1 - y * sy);
      if (bx < 0 || by < 0 || bx >= w || by >= h) return null;
      return 1 - buf[(by * w + bx) * 4] / 255;
    };
    const meanAt = (pts) => {
      let s = 0, n = 0;
      for (const p of pts) { const v = occAt(p[0], p[1]); if (v !== null) { s += v; n++; } }
      return n ? { occ: s / n, n } : { occ: null, n: 0 };
    };
    const discOcc = (x, y, rpx) => {
      let s = 0, n = 0;
      for (let dy = -rpx; dy <= rpx; dy++) for (let dx = -rpx; dx <= rpx; dx++) {
        if (dx * dx + dy * dy > rpx * rpx) continue;
        const v = occAt(x + dx, y + dy);
        if (v !== null) { s += v; n++; }
      }
      return n ? s / n : null;
    };

    // ------------------------------------------------------------- THE LOBE
    // The profile only. The reduction from profile to lobe radius happens in
    // lobeFrom() in the Node half of this file, so --selftest exercises the
    // real code rather than a copy of it that could drift away from it.
    const prof = [];
    for (const ring of S.rings) {
      if (!ring.n) continue;
      const m = meanAt(ring.pts);
      if (m.occ === null) continue;
      prof.push({ rM: ring.rM, occ: +m.occ.toFixed(4), n: m.n });
    }
    const out = {
      bufferSize: [w, h],
      frameMeanOcc: +(() => { let s = 0; for (let i = 0; i < w * h; i++) s += 1 - buf[i * 4] / 255; return s / (w * h); })().toFixed(4),
      lobe: { profile: prof },
      footOcc: +(discOcc(S.slot.screen.x, S.slot.screen.y, Math.max(2, 0.12 / S.mPerPx)) ?? 0).toFixed(4),
    };

    // --------------------------------------------------------- REAL CONTACTS
    // Contact ring minus background ring, both on the same pavement in the same
    // frame. This is the number that says whether the object is bedded in.
    out.contacts = S.contacts.map((c) => {
      const a = meanAt(c.near), b = meanAt(c.far);
      return { kind: c.kind, radiusM: c.radiusM, dist: c.dist,
        contactOcc: a.occ === null ? null : +a.occ.toFixed(4),
        backgroundOcc: b.occ === null ? null : +b.occ.toFixed(4),
        contactRise: (a.occ === null || b.occ === null) ? null : +(a.occ - b.occ).toFixed(4) };
    });

    // ------------------------------------------------- WALL / PAVEMENT CREASE
    let gn = 0, gf = 0, n = 0, wl = 0, wh = 0, wn = 0;
    for (const j of S.junctions) {
      const a = discOcc(j.groundNear.x, j.groundNear.y, 2);
      const b = discOcc(j.groundFar.x, j.groundFar.y, 2);
      if (a !== null && b !== null) { gn += a; gf += b; n++; }
      if (j.wallLo && j.wallHi) {
        const c = discOcc(j.wallLo.x, j.wallLo.y, 2), d = discOcc(j.wallHi.x, j.wallHi.y, 2);
        if (c !== null && d !== null) { wl += c; wh += d; wn++; }
      }
    }
    out.junction = n ? {
      pairs: n,
      groundAtWall: +(gn / n).toFixed(4), groundOpen: +(gf / n).toFixed(4),
      groundCrease: +((gn - gf) / n).toFixed(4),
      wallPairs: wn,
      wallLow: wn ? +(wl / wn).toFixed(4) : null, wallHigh: wn ? +(wh / wn).toFixed(4) : null,
      wallCrease: wn ? +((wl - wh) / wn).toFixed(4) : null,
    } : null;

    // ----------------------------------------------------------- THE REVEAL
    const F = S.facade.samples;
    const rv = meanAt(F.reveal), fl = meanAt(F.flush), so = meanAt(F.soffit);
    out.facade = {
      revealOcc: rv.occ === null ? null : +rv.occ.toFixed(4), revealPx: rv.n,
      flushOcc: fl.occ === null ? null : +fl.occ.toFixed(4), flushPx: fl.n,
      soffitOcc: so.occ === null ? null : +so.occ.toFixed(4), soffitPx: so.n,
      revealContrast: (rv.occ === null || fl.occ === null) ? null : +(rv.occ - fl.occ).toFixed(4),
      soffitContrast: (so.occ === null || fl.occ === null) ? null : +(so.occ - fl.occ).toFixed(4),
    };
    return out;
  }, subj);
}

const apply = async (c) => page.evaluate((cc) => {
  const p = __district.postParams();
  p.aoRadius = cc.radius; p.aoIntensity = cc.intensity; p.aoStrength = cc.strength;
  p.aoEnabled = true;
  return { aoRadius: p.aoRadius, aoIntensity: p.aoIntensity, aoStrength: p.aoStrength };
}, c);

const fmt = (v, d = 3) => (v === null || v === undefined ? ' n/a' : v.toFixed(d));
const line = (c, ao) => {
  const j = ao.junction || {}, f = ao.facade || {}, l = ao.lobe;
  return `r=${String(c.radius).padStart(4)} i=${c.intensity} s=${c.strength}  ` +
    `lobe ${l.lobeRadiusM === null ? ' n/a' : l.lobeRadiusM.toFixed(1)} m = ` +
    `${l.lobeBodyWidths === null ? ' n/a' : l.lobeBodyWidths.toFixed(1).padStart(4)} bw  ` +
    `rise ${fmt(l.riseOverBackground)}  foot ${fmt(ao.footOcc)}  ` +
    `contacts ${ao.contacts.map((q) => `${q.kind[0]}${fmt(q.contactRise)}`).join(' ')}  ` +
    `crease g${fmt(j.groundCrease)} w${fmt(j.wallCrease)}  ` +
    `reveal ${fmt(f.revealContrast)}  soffit ${fmt(f.soffitContrast)}  ` +
    `frame ${fmt(ao.frameMeanOcc)}`;
};

// ---------------------------------------------------------------- the guard
// The instrument this replaced was retired for reading three different numbers
// off one unchanged parameter set, so this one is required to prove it does
// not. The first combination is measured, the whole sweep is run, and then the
// first combination is measured AGAIN at the end. If those two disagree by
// more than REPEAT_TOL on any headline number the sweep is void, and it says
// so rather than reporting a difference it cannot support.
const REPEAT_TOL = 0.010;
const results = [];
for (const c of COMBOS) {
  const applied = await apply(c);
  await settle();
  const ao = await readAO(subject);
  results.push({ ...c, applied, ao });
  console.log(line(c, ao));
}

let repeat = null;
if (COMBOS.length) {
  const c = COMBOS[0];
  await apply(c);
  await settle();
  const ao = await readAO(subject);
  const first = results[0].ao;
  const keys = [
    ['frameMeanOcc', first.frameMeanOcc, ao.frameMeanOcc],
    ['footOcc', first.footOcc, ao.footOcc],
    ['lobeRise', first.lobe.riseOverBackground, ao.lobe.riseOverBackground],
    ['revealContrast', first.facade.revealContrast, ao.facade.revealContrast],
    ['groundCrease', first.junction && first.junction.groundCrease, ao.junction && ao.junction.groundCrease],
  ];
  const bad = keys.filter(([, a, b]) => a === null || b === null || Math.abs(a - b) > REPEAT_TOL);
  repeat = { combo: c, tolerance: REPEAT_TOL,
    keys: keys.map(([k, a, b]) => ({ k, first: a, again: b, delta: (a === null || b === null) ? null : +(b - a).toFixed(4) })),
    agreed: bad.length === 0 };
  console.log(`\nREPEAT of r=${c.radius} i=${c.intensity} s=${c.strength}: ` +
    keys.map(([k, a, b]) => `${k} ${fmt(a, 4)}->${fmt(b, 4)}`).join('  '));
  console.log(repeat.agreed
    ? `REPEAT AGREES within ${REPEAT_TOL} on all five. The sweep stands.`
    : `REPEAT DISAGREES on ${bad.map((b) => b[0]).join(', ')} -- THE SWEEP IS VOID.`);
}

fs.writeFileSync(`docs/ao-sweep-${TAG}.json`, JSON.stringify(
  { tag: TAG, tod: TOD, peds: PEDS, port: PORT, camera: placed, subject, results, repeat, errors }, null, 1));
console.log(`\nwrote docs/ao-sweep-${TAG}.json`);
if (errors.length) console.log('PAGE ERRORS:', errors);
await browser.close();
if (repeat && !repeat.agreed) process.exit(3);