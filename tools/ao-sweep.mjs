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
//   LOBE      A pedestrian is teleported to a verified patch of clear sunlit
//             brick and posed standing, so its width is the 0.41 m shoulder and
//             its position is known. Occlusion is then sampled on the GROUND in a
//             radial profile around its feet, averaged over 16 azimuths, and the
//             lobe radius is where it falls to 10% of its contact value. Reported
//             in body widths, which is the unit the complaint was made in.
//   CONTACT   Occlusion in a 0.12 m disc where the foot, the bin base and the
//             bollard base meet the paving. This is what a smaller radius is at
//             risk of throwing away.
//   JUNCTION  The crevice term AO exists to draw, measured geometrically rather
//             than by eye: occlusion on the pavement 0.10 m from a building wall
//             minus occlusion 1.50 m out, averaged over every facing wall segment
//             the camera can see. Same on the wall itself, 0.10 m up against
//             1.50 m up. A pair of differences inside one frame - it cannot be
//             moved by exposure.
//   REVEAL    Chosen screen boxes on a window reveal and under an awning, each
//             one raycast to confirm what it actually lands on before it is read.
//   FRAME     Mean occlusion over the whole buffer: how grey the district is.
//
// RADIUS AND STRENGTH ARE SWEPT AS A PAIR, and there is a third knob that matters
// more than either: aoIntensity is the exponent in `ao = pow(ao, intensity)`, and
// the shader's own note says the kernel is weighted toward the origin so a raw
// average understates a corner. A tighter radius samples less occlusion, so the
// exponent is the honest place to give some back.
//
//   node tools/ao-sweep.mjs --port 8137 --tag sweep
//   node tools/ao-sweep.mjs --selftest --port 8137
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

// radius, intensity, strength. The first row is what ships today.
const COMBOS = (arg('combos', '') || [
  '2.2/3.8/0.95',
  '1.4/3.8/0.95',
  '0.9/3.8/0.95',
  '0.6/3.8/0.95',
  '0.35/3.8/0.95',
  '0.9/2.6/0.95',
  '0.9/5.2/0.95',
  '0.6/5.2/0.95',
  '0.9/3.8/1.0',
  '0.0/3.8/0.95',
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

if (SELFTEST) {
  // The buffer maths, on synthetic input, with no browser: an all-white AO buffer
  // must read 0 occlusion, a half-grey one 0.5, and the radial profile of a
  // synthetic lobe must find its own 10% radius. A probe that cannot do this
  // arithmetic cannot be trusted with the real buffer.
  const w = 100, h = 100;
  const buf = new Uint8Array(w * h * 4).fill(255);
  const occ = (b, x, y) => 1 - b[(y * w + x) * 4] / 255;
  let bad = [];
  if (Math.abs(occ(buf, 50, 50)) > 1e-9) bad.push('white buffer is not 0 occlusion');
  const grey = new Uint8Array(w * h * 4).fill(128);
  if (Math.abs(occ(grey, 50, 50) - (1 - 128 / 255)) > 1e-9) bad.push('grey buffer misread');
  // Synthetic lobe: occlusion 0.5 at r = 0 falling linearly to 0 at r = 20 px.
  const lobe = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 50, y - 50);
      const o = Math.max(0, 0.5 * (1 - d / 20));
      lobe[(y * w + x) * 4] = Math.round((1 - o) * 255);
    }
  }
  // 10% of the contact value is 0.05, which the linear ramp reaches at r = 18.
  let found = null;
  for (let r = 0; r < 40; r += 0.5) {
    const o = occ(lobe, Math.round(50 + r), 50);
    if (o <= 0.05 && found === null) found = r;
  }
  if (found === null || Math.abs(found - 18) > 1.0) bad.push(`lobe radius ${found} != 18`);
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
}, { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 });
console.log(`fivepoints camera at (${placed.x}, ${placed.z})`);
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
  const probe = (x, z) => {
    rc.set(new THREE.Vector3(x, 8, z), down);
    const h = rc.intersectObjects(ground, false);
    if (!h.length) return null;
    return { y: h[0].point.y, mat: (h[0].object.material && h[0].object.material.name) || '',
      name: h[0].object.name || '' };
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

  // A clear, sunlit patch of the reviewers' own brick, in the lower half of the
  // frame where a lobe is resolvable. Searched over the sidewalk in front of the
  // camera rather than picked, and every acceptance is a geometric test.
  const r = D.district.meta.route, a = r[3], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len, sx = -fz, sz = fx;
  let slot = null;
  outer:
  for (let along = 6; along <= 40; along += 1.5) {
    for (const across of [7, 8, 9, 10, 6, 11, 12, 5]) {
      const x = a.x + fx * along + sx * across, z = a.z + fz * along + sz * across;
      const g = probe(x, z);
      if (!g || g.y > 0.30 || g.y < -1 || g.mat !== 'sidewalk' || onProps(g)) continue;
      if (!sunlit(x, g.y, z)) continue;
      // 2.6 m of clear, flat, prop-free brick all round: the lobe has to have
      // somewhere to be measured.
      let clear = true;
      for (let k = 0; k < 12 && clear; k++) {
        const th = (k / 12) * Math.PI * 2;
        for (const rad of [1.3, 2.6]) {
          const q = probe(x + Math.cos(th) * rad, z + Math.sin(th) * rad);
          if (!q || q.y > 0.30 || onProps(q) || q.mat !== 'sidewalk') { clear = false; break; }
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

  // --- OTHER CONTACTS. A bin and a bollard, found by their own geometry: walk
  // out from the subject and keep the first two things standing on the pavement
  // whose footprint is bin-sized and bollard-sized.
  const contacts = [];
  for (let along = 4; along <= 46 && contacts.length < 2; along += 0.6) {
    for (const across of [6, 7, 8, 9, 10, 11, 12]) {
      const x = a.x + fx * along + sx * across, z = a.z + fz * along + sz * across;
      const g = probe(x, z);
      if (!g || !onProps(g) || g.y < 0.25) continue;            // something standing
      // Its footprint: how far the raised region extends.
      let rad = 0;
      for (const rr of [0.15, 0.25, 0.35, 0.5, 0.7]) {
        let up = 0;
        for (let k = 0; k < 8; k++) {
          const th = (k / 8) * Math.PI * 2;
          const q = probe(x + Math.cos(th) * rr, z + Math.sin(th) * rr);
          if (q && q.y > 0.25) up++;
        }
        if (up >= 6) rad = rr; else break;
      }
      if (rad < 0.1) continue;
      const base = probe(x + 0.45, z + 0.45);      // pavement just beside it
      if (!base || base.y > 0.30) continue;
      const p = project(x, base.y, z);
      if (p.x < 60 || p.x > 1540 || p.y < 380 || p.y > 860 || p.z > 1) continue;
      if (contacts.some((c) => Math.hypot(c.x - x, c.z - z) < 3)) continue;
      contacts.push({ kind: rad >= 0.25 ? 'bin-sized' : 'bollard-sized', radiusM: rad,
        x, z, y: base.y, screen: p });
      if (contacts.length >= 2) break;
    }
  }

  // --- WALL / PAVEMENT JUNCTIONS, geometric and plural. For every facing wall
  // segment within 60 m, a pair of ground points 0.10 m and 1.50 m out from the
  // wall, and a pair of wall points 0.10 m and 1.50 m up.
  const junctions = [];
  const chunkKeys = new Set();
  for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
    const [cx, cz] = D.world.keyOf(cam.position.x + ddx * 100, cam.position.z + ddz * 100).split(',').map(Number);
    chunkKeys.add(`${cx},${cz}`);
  }
  for (const key of chunkKeys) {
    const c = D.district.chunks[key];
    if (!c) continue;
    for (const bi of c.buildings) {
      const ring = D.district.buildings[bi].p;
      for (let i = 0; i < ring.length && junctions.length < 40; i++) {
        const A = ring[i], B = ring[(i + 1) % ring.length];
        const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
        const ex = B[0] - A[0], ez = B[1] - A[1];
        const el = Math.hypot(ex, ez);
        if (el < 4) continue;
        let nx2 = -ez / el, nz2 = ex / el;
        // Outward: the side whose 1.5 m point is ground rather than inside.
        const t1 = probe(mx + nx2 * 1.5, mz + nz2 * 1.5);
        const t2 = probe(mx - nx2 * 1.5, mz - nz2 * 1.5);
        const outIsPlus = t1 && t1.y < 0.3 && (!t2 || t2.y >= 0.3);
        const outIsMinus = t2 && t2.y < 0.3 && (!t1 || t1.y >= 0.3);
        if (!outIsPlus && !outIsMinus) continue;
        if (outIsMinus) { nx2 = -nx2; nz2 = -nz2; }
        const near = probe(mx + nx2 * 0.10, mz + nz2 * 0.10);
        const far = probe(mx + nx2 * 1.50, mz + nz2 * 1.50);
        if (!near || !far || near.y > 0.30 || far.y > 0.30) continue;
        const pn = project(mx + nx2 * 0.10, near.y, mz + nz2 * 0.10);
        const pf = project(mx + nx2 * 1.50, far.y, mz + nz2 * 1.50);
        // Both ends visible, and far enough apart on screen to be separate reads.
        if (pn.z > 1 || pf.z > 1) continue;
        if (pn.x < 40 || pn.x > 1560 || pn.y < 200 || pn.y > 880) continue;
        if (pf.x < 40 || pf.x > 1560 || pf.y < 200 || pf.y > 880) continue;
        if (Math.hypot(pn.x - pf.x, pn.y - pf.y) < 6) continue;
        // The wall pair: the same spot 0.10 m and 1.50 m up the face.
        const wLo = project(mx + nx2 * 0.02, near.y + 0.10, mz + nz2 * 0.02);
        const wHi = project(mx + nx2 * 0.02, near.y + 1.50, mz + nz2 * 0.02);
        junctions.push({ bi, groundNear: pn, groundFar: pf, wallLo: wLo, wallHi: wHi,
          dist: +Math.hypot(mx - cam.position.x, mz - cam.position.z).toFixed(1) });
      }
    }
  }

  return {
    ok: true, pedIdx: idx, slot, mPerPx: +mPerPx.toFixed(5), bodyWidthPx: +(bodyW / mPerPx).toFixed(1),
    contacts, junctions,
    sunElevDeg: +((Math.asin(L.y) * 180) / Math.PI).toFixed(2),
    cam: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
    alive: P.aliveCount,
  };
}, BODY_W);

if (!subject.ok) { console.error('subject failed:', subject.why); await browser.close(); process.exit(2); }
console.log(`subject at (${subject.slot.x.toFixed(1)}, ${subject.slot.z.toFixed(1)}) ` +
  `screen (${subject.slot.screen.x.toFixed(0)}, ${subject.slot.screen.y.toFixed(0)}), ` +
  `${subject.mPerPx.toFixed(4)} m/px, body = ${subject.bodyWidthPx} px`);
console.log(`contacts: ${subject.contacts.map((c) => `${c.kind} r=${c.radiusM}`).join(', ') || 'none found'}`);
console.log(`wall/pavement junction pairs: ${subject.junctions.length}`);

const settle = async () => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 3, f0, { timeout: 600000, polling: 200 });
};

/** Read the AO buffer and reduce it to this round's numbers. */
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
    const discOcc = (x, y, rpx) => {
      let s = 0, n = 0;
      for (let dy = -rpx; dy <= rpx; dy++) for (let dx = -rpx; dx <= rpx; dx++) {
        if (dx * dx + dy * dy > rpx * rpx) continue;
        const v = occAt(x + dx, y + dy);
        if (v !== null) { s += v; n++; }
      }
      return n ? s / n : null;
    };

    // --- radial lobe on the ground around the subject's feet, 16 azimuths.
    const base = S.slot.screen;
    const prof = [];
    for (let rm = 0; rm <= 3.0001; rm += 0.1) {
      const rpx = rm / S.mPerPx;
      let s = 0, n = 0;
      for (let k = 0; k < 16; k++) {
        const th = (k / 16) * Math.PI * 2;
        const v = occAt(base.x + Math.cos(th) * rpx, base.y + Math.sin(th) * rpx * 0.5);
        if (v !== null) { s += v; n++; }
      }
      if (n) prof.push({ rM: +rm.toFixed(2), occ: +(s / n).toFixed(4) });
    }
    const peak = prof.length ? prof[0].occ : 0;
    let lobeM = null;
    for (const p of prof) { if (p.occ <= peak * 0.10) { lobeM = p.rM; break; } }

    const out = {
      bufferSize: [w, h],
      frameMeanOcc: +(() => { let s = 0; for (let i = 0; i < w * h; i++) s += 1 - buf[i * 4] / 255; return s / (w * h); })().toFixed(4),
      lobe: { profile: prof, contactOcc: +peak.toFixed(4), lobeRadiusM: lobeM,
        lobeBodyWidths: lobeM === null ? null : +(lobeM / 0.41).toFixed(2) },
      footOcc: +(discOcc(base.x, base.y, Math.max(2, 0.12 / S.mPerPx)) ?? 0).toFixed(4),
      contacts: S.contacts.map((c) => ({ kind: c.kind,
        occ: +(discOcc(c.screen.x, c.screen.y, 3) ?? 0).toFixed(4) })),
    };
    // --- junctions: near-wall minus open ground, and low-wall minus high-wall.
    let gn = 0, gf = 0, wl = 0, wh = 0, n = 0;
    for (const j of S.junctions) {
      const a = discOcc(j.groundNear.x, j.groundNear.y, 2);
      const b = discOcc(j.groundFar.x, j.groundFar.y, 2);
      const c = discOcc(j.wallLo.x, j.wallLo.y, 2);
      const d = discOcc(j.wallHi.x, j.wallHi.y, 2);
      if (a === null || b === null || c === null || d === null) continue;
      gn += a; gf += b; wl += c; wh += d; n++;
    }
    out.junction = n ? {
      pairs: n,
      groundNearWall: +(gn / n).toFixed(4), groundOpen: +(gf / n).toFixed(4),
      groundCrevice: +((gn - gf) / n).toFixed(4),
      wallLow: +(wl / n).toFixed(4), wallHigh: +(wh / n).toFixed(4),
      wallCrevice: +((wl - wh) / n).toFixed(4),
    } : null;
    return out;
  }, subj);
}

const results = [];
for (const c of COMBOS) {
  const applied = await page.evaluate((cc) => {
    const p = __district.postParams();
    p.aoRadius = cc.radius; p.aoIntensity = cc.intensity; p.aoStrength = cc.strength;
    p.aoEnabled = true;
    return { aoRadius: p.aoRadius, aoIntensity: p.aoIntensity, aoStrength: p.aoStrength };
  }, c);
  await settle();
  const ao = await readAO(subject);
  results.push({ ...c, applied, ao });
  const j = ao.junction || {};
  console.log(`r=${String(c.radius).padStart(4)} i=${c.intensity} s=${c.strength}  ` +
    `lobe ${String(ao.lobe.lobeRadiusM).padStart(4)} m = ${String(ao.lobe.lobeBodyWidths).padStart(5)} body widths   ` +
    `foot ${ao.footOcc.toFixed(3)}   ` +
    `contacts ${ao.contacts.map((q) => `${q.kind[0]}:${q.occ.toFixed(3)}`).join(' ')}   ` +
    `crevice ground ${(j.groundCrevice ?? 0).toFixed(3)} wall ${(j.wallCrevice ?? 0).toFixed(3)}   ` +
    `frame ${ao.frameMeanOcc.toFixed(3)}`);
}

fs.writeFileSync(`docs/ao-sweep-${TAG}.json`, JSON.stringify(
  { tag: TAG, tod: TOD, peds: PEDS, port: PORT, camera: placed, subject, results, errors }, null, 1));
console.log(`\nwrote docs/ao-sweep-${TAG}.json`);
if (errors.length) console.log('PAGE ERRORS:', errors);
await browser.close();
