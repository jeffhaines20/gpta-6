// DOES A STREET PROP TOUCH THE GROUND IN THE COMPOSITED FRAME, AND WHAT PUTS IT
// THERE?
//
// tools/ao-sweep.mjs answers the AO half of this question and answers it well:
// it reads post.aoBlurRT directly, so no exposure, tone curve or sky can move
// its numbers. What it cannot see is a CAST SHADOW, because a cast shadow never
// enters the AO buffer. Two blind reviewers measured the shipped build and
// reported the opposite halves of one frame:
//
//   "under the parked car luma ramps 6 -> 113 over ~48 px with no umbra edge"
//   "the meter pole grounds at 0.98 of open paving - no contact darkening"
//
// Neither is an AO statement. Both are statements about the composited frame, so
// this measures the composited frame.
//
// ---------------------------------------------------------------------------
// WHY THIS CAN DIFFERENCE TWO ARMS WHEN ao-sweep.mjs COULD NOT
// ---------------------------------------------------------------------------
// ao-sweep's header records that differencing an AO-on capture against an AO-off
// one read 44.2%, 27.6% and 31.0% for the same unchanged parameter, because
// SwiftShader renders under 1 fps and the world moves seconds' worth between two
// screenshots. That is a property of taking two SCREENSHOTS, not of differencing.
//
// Every arm here is rendered inside ONE page.evaluate() call - one JavaScript
// task. requestAnimationFrame cannot fire inside a task, so the streaming slice,
// the crowd, the traffic, the wind and the sun are bit-identical across arms by
// construction: nothing in the page gets a chance to run. post.render() draws to
// the default framebuffer and gl.readPixels() takes it back before the task
// yields, so the arms differ by exactly the uniform under test.
//
// The guard is still cheap, so it is still here: --repeat renders the baseline
// again as the LAST arm and voids the run if the two disagree by more than
// --tol. If anything did move, this fires.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED
// ---------------------------------------------------------------------------
//   CONTACT   Mean frame luma on a true 0.14 m-clear ring around a prop's base,
//             over mean luma on a 2.2 m ring around the same prop. A RATIO
//             inside one frame, so the exposure stop cancels; 1.00 is "the
//             pavement where the object meets it is exactly as bright as the
//             pavement two metres away", i.e. the object is not touching
//             anything. Props are found from the dressing pass's own merged
//             vertices by the method ao-sweep.mjs established (0.20 m plan
//             grid, connected components, classified by plan extent), because
//             there is no per-object node to look up.
//   RESOLVED  How many screen pixels 0.14 m of ground is at that prop. A prop
//             46 m out is about two pixels of base and its contact ring is
//             under the width of the FXAA kernel; this reports the number
//             instead of quietly averaging noise, and marks the prop
//             `resolved: false` below --minpx pixels.
//   ARMS      Each arm is one uniform changed and everything else held:
//               base          as shipped
//               noPropShadow  every props:* mesh castShadow = false
//               noShadow      sun.shadow.intensity = 0 (the whole shadow pass)
//               noAO          post.params.aoEnabled = false
//               bias0         sun.shadow.bias = 0
//               nbias0        sun.shadow.normalBias = 0
//               bias0nb0      both
//             The arm that moves the contact ratio is the term that is (or is
//             not) grounding the prop.
//   BOXES     The two reviewers' own pixel boxes, verbatim, so their numbers can
//             be reproduced rather than paraphrased.
//
//   node tools/prop-ground.mjs --port 8151 --cam fivepoints --tod noon
//   node tools/prop-ground.mjs --selftest
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// ---------------------------------------------------------------------------
// The pure half: sampling and verdicts, so --selftest can exercise them with no
// browser and no server.
// ---------------------------------------------------------------------------

/** Luma of an RGBA readPixels buffer at a screen pixel. readPixels is
 *  bottom-left origin; screen coordinates are top-left, so y flips here once
 *  and nowhere else. */
export function lumaAt(px, W, H, sx, sy) {
  const x = Math.round(sx), y = Math.round(sy);
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const i = ((H - 1 - y) * W + x) * 4;
  return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
}

/** Mean luma over a list of [x, y] screen points. Null points are skipped; a
 *  list that loses more than half its points returns n so the caller can drop
 *  the sample rather than average four pixels and call it a ring. */
export function ringLuma(px, W, H, pts) {
  let s = 0, n = 0;
  for (const p of pts) {
    const v = lumaAt(px, W, H, p[0], p[1]);
    if (v === null) continue;
    s += v; n++;
  }
  return { mean: n ? s / n : null, n };
}

/** contact = near / far. Below 1 the object is darkening the ground it stands
 *  on; at 1 it is not touching it. */
export function contactRatio(near, far) {
  if (near === null || far === null || !(far > 0)) return null;
  return near / far;
}

/**
 * The repeat guard. `pairs` is [[a, b], ...] of the same quantity measured
 * twice. Voids the run if any pair disagrees by more than tol.
 */
export function repeatVerdict(pairs, tol) {
  const rows = pairs.map(([a, b, name]) => ({
    name, a: +Number(a).toFixed(4), b: +Number(b).toFixed(4),
    d: +Math.abs(a - b).toFixed(4), ok: Math.abs(a - b) <= tol,
  }));
  return { ok: rows.every((r) => r.ok), tol, rows };
}

// ---------------------------------------------------------------------------
function selftest() {
  let fail = 0;
  const say = (name, ok, extra = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!ok) fail++;
  };
  const W = 4, H = 4;
  // A buffer whose bottom two screen rows are 100 and top two are 200, laid out
  // in readPixels order (row 0 of the buffer is the BOTTOM of the screen).
  const px = new Uint8Array(W * H * 4);
  for (let by = 0; by < H; by++) {
    const v = by < 2 ? 100 : 200;          // buffer rows 0,1 = screen rows 3,2
    for (let x = 0; x < W; x++) {
      const i = (by * W + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
  }
  // The flip is the thing most likely to be wrong and the thing least likely to
  // announce itself, so it is tested by value and not by shape.
  say('lumaAt flips y (screen row 0 is the TOP)', Math.round(lumaAt(px, W, H, 0, 0)) === 200,
    `got ${Math.round(lumaAt(px, W, H, 0, 0))}, want 200`);
  say('lumaAt bottom row', Math.round(lumaAt(px, W, H, 0, 3)) === 100);
  say('lumaAt rejects off-screen', lumaAt(px, W, H, -1, 0) === null && lumaAt(px, W, H, 0, 9) === null);

  const top = ringLuma(px, W, H, [[0, 0], [1, 0], [2, 1]]);
  const bot = ringLuma(px, W, H, [[0, 3], [1, 3], [2, 2]]);
  say('ringLuma counts its points', top.n === 3 && bot.n === 3);
  say('ringLuma skips off-screen points', ringLuma(px, W, H, [[0, 0], [99, 0]]).n === 1);

  // KNOWN-BAD INPUT 1: a ring that is not darker than its background must NOT
  // read as contact. This is the failure the reviewers reported, so the tool has
  // to be able to say it.
  const flat = contactRatio(120, 120);
  say('flat ground reads 1.000, not contact', flat !== null && Math.abs(flat - 1) < 1e-9,
    `got ${flat}`);
  // KNOWN-BAD INPUT 2: a 20% darker ring must read 0.800 and not 1.250 - i.e.
  // near and far are not transposed.
  const dark = contactRatio(80, 100);
  say('near/far not transposed', Math.abs(dark - 0.8) < 1e-9, `got ${dark}`);
  say('a zero background is refused, not divided by', contactRatio(80, 0) === null);

  // KNOWN-BAD INPUT 3: the repeat guard must FAIL on disagreeing repeats. A
  // guard that passes everything is worse than no guard, because it is quoted.
  const good = repeatVerdict([[0.80, 0.802, 'x']], 0.01);
  const bad = repeatVerdict([[0.80, 0.93, 'x']], 0.01);
  say('repeat guard passes agreeing repeats', good.ok === true);
  say('repeat guard FAILS disagreeing repeats', bad.ok === false);

  // KNOWN-BAD INPUT 4: an all-black frame (the shape a broken readPixels
  // produces) must not be reported as perfect contact.
  const black = new Uint8Array(W * H * 4);
  const bl = ringLuma(black, W, H, [[0, 0], [1, 1]]);
  say('an all-black read gives a null ratio, not 1.0', contactRatio(bl.mean, 0) === null);

  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nselftest passed');
  process.exit(fail ? 1 : 0);
}

if (has('selftest')) selftest();

// ---------------------------------------------------------------------------
// The live half.
// ---------------------------------------------------------------------------
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const PORT = Number(arg('port', 8151));       // never 8123: that is the main tree
const TOD = arg('tod', 'noon');
const CAMNAME = arg('cam', 'fivepoints');
const TAG = arg('tag', 'propground');
const PEDS = Number(arg('peds', 0));
const MINPX = Number(arg('minpx', 3));
const TOL = Number(arg('tol', 0.01));
const W = 1600, H = 900;

// Verbatim from tools/hero-shots.mjs, NOT from tools/framing.mjs: framing.mjs's
// SHOTS.corridor is still the pre-2026-09-05 mis-sited camera (wpA 2, back +34)
// and every corridor capture judged in this round came from hero-shots.
const CAMS = {
  fivepoints: { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
  corridor: { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
};
// A CLOSE-UP STANDING, so the contact is resolvable. The brief this tool was
// written for is explicit that a prop 46 m out is about two pixels of base and
// that a metric which cannot resolve what it asserts should get a closer camera
// rather than report the number anyway. --anchor x,z stands 4.5 m from that
// point at eye height looking at its base, keeping the hero camera's bearing so
// the sun sits where it sat.
const ANCHOR = arg('anchor', '');
const CAM = ANCHOR ? null : CAMS[CAMNAME];
if (!CAM && !ANCHOR) { console.error(`unknown camera ${CAMNAME}`); process.exit(2); }
const SHOTS = has('shots');

// The two reviewers' boxes, verbatim, in the framing they were measured in.
const BOXES = {
  corridor: [
    { name: 'under-parked-car', x: 1075, y: 676, w: 91, h: 61,
      note: 'reviewer 1: luma ramps 6 -> 113 over ~48 px with no umbra edge' },
    { name: 'road-10m-away', x: 700, y: 690, w: 200, h: 60, note: 'the dappled road the same sun lights' },
  ],
  fivepoints: [
    { name: 'blue-bin', x: 218, y: 585, w: 32, h: 43, note: 'reviewer 2: reads as a solid black void' },
    { name: 'brick-beside-bin', x: 252, y: 600, w: 40, h: 28, note: 'reviewer 2: drops only 83 -> 79' },
    { name: 'meter-pole-base', x: 778, y: 652, w: 10, h: 10, note: 'reviewer 1: grounds at 0.98 of open paving' },
  ],
};

const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
console.log(`server: ${srv.started ? 'started' : 'reused'} :${srv.port} root=${srv.root}`);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.evaluate(([t, p]) => { __district.setTraffic(t); __district.setPedestrians(p); }, [0, PEDS]);

const { placeCamera, describe } = await import('./framing.mjs');
let placed;
if (ANCHOR) {
  const [ax, az] = ANCHOR.split(',').map(Number);
  // Placed from the hero camera's own bearing so the sun keeps its angle to the
  // lens, then walked back to 4.5 m. __district.placeAt() first, because the
  // streamer keys resident chunks off the vehicle and a free camera dropped in
  // an unloaded block photographs a land pad.
  placed = await page.evaluate(([x, z, hero]) => {
    const r = __district.district.meta.route;
    const a = r[hero.wpA], b = r[hero.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    const cx = x - fx * 4.2, cz = z - fz * 4.2 - 1.2;
    __district.placeAt(cx, cz);
    __district.setAutopilot(() => {});
    __district.freeCam([cx, 1.7, cz], [x, 0.35, z], 40);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { x: +cx.toFixed(1), z: +cz.toFixed(1), anchor: [x, z], back: 4.5,
      requestedBack: 4.5, clearance: 4.5, stillInside: -1,
      headingDeg: +((Math.atan2(dz, dx) * 180) / Math.PI).toFixed(1) };
  }, [ax, az, CAMS[CAMNAME] || CAMS.fivepoints]);
  console.log(`closeup: camera at (${placed.x}, ${placed.z}) looking at (${ax}, ${az})`);
} else {
  placed = await page.evaluate(placeCamera, CAM);
  console.log(describe(CAMNAME, placed));
}

// Let the streamer settle: how many casters exist depends entirely on which
// chunks are resident, and a probe run before they are is measuring a different
// city from the one the hero frames photograph.
{
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const m = await page.evaluate(() => __district.world.report().meshes);
    stable = m === last ? stable + 1 : 0; last = m;
    if (stable < 3) await page.waitForTimeout(2000);
  }
  console.log(`world settled at ${last} chunk meshes`);
}
await page.waitForTimeout(6000);

const ARMS = (arg('arms', 'base,noPropShadow,noShadow,noAO,bias0,nbias0,bias0nb0') || '').split(',');

const out = await page.evaluate(async ([armNames, boxes, minpx, wpx, hpx, wantShots]) => {
  const THREE = await import('/vendor/three.module.min.js');
  const D = __district, scene = D.scene, cam = D.camera, r = D.renderer;
  cam.updateMatrixWorld();
  const gl = r.getContext();

  // ------------------------------------------------------------- geometry
  const isCrowd = (o) => { for (let n = o; n; n = n.parent) if (n.name === 'pedestrians') return true; return false; };
  const isSky = (o) => { for (let n = o; n; n = n.parent) { const m = n.name; if (m === 'sky' || m === 'skydome' || m === 'weather') return true; } return false; };
  const ground = [];
  scene.traverse((o) => { if (o.isMesh && o.visible && !isCrowd(o) && !isSky(o)) ground.push(o); });
  const rc = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
  // The surface you would stand on: the highest hit within half a metre of the
  // lowest. The first hit is the awning; the lowest is streaming.js's land pad.
  const probe = (x, z) => {
    rc.set(new THREE.Vector3(x, 8, z), down);
    const h = rc.intersectObjects(ground, false);
    if (!h.length) return null;
    let lo = Infinity;
    for (const q of h) if (q.point.y < lo) lo = q.point.y;
    let s = -1;
    for (let i = 0; i < h.length; i++) {
      if (h[i].point.y > lo + 0.5) continue;
      if (s < 0 || h[i].point.y > h[s].point.y) s = i;
    }
    return s < 0 ? null : { y: h[s].point.y, name: h[s].object.name || '' };
  };
  const project = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(cam);
    return { x: (v.x * 0.5 + 0.5) * wpx, y: (-v.y * 0.5 + 0.5) * hpx, z: v.z };
  };
  const camPos = cam.position.clone();
  const rc2 = new THREE.Raycaster();
  const visible = (x, y, z, tol) => {
    const to = new THREE.Vector3(x, y, z), d = to.clone().sub(camPos), len = d.length();
    rc2.set(camPos, d.normalize()); rc2.far = len + 1;
    const h = rc2.intersectObjects(ground, false);
    rc2.far = Infinity;
    return h.length > 0 && Math.abs(h[0].distance - len) <= (tol ?? 0.20);
  };
  const onProps = (g) => !!g && /^props:/.test(g.name);

  // ------------------------------------------- props, from their own vertices
  const propMeshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible && /^props:/.test(o.name)) propMeshes.push(o); });
  const cells = new Map();
  let vertsRead = 0;
  for (const m of propMeshes) {
    const c = m.userData && m.userData.c, rad = (m.userData && m.userData.r) || 0;
    if (c && Math.hypot(c.x - camPos.x, c.z - camPos.z) - rad > 70) continue;
    const pa = m.geometry.getAttribute('position');
    if (!pa) continue;
    m.updateMatrixWorld();
    const v = new THREE.Vector3();
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(m.matrixWorld);
      if (Math.hypot(v.x - camPos.x, v.z - camPos.z) > 55) continue;
      vertsRead++;
      const k = `${Math.round(v.x / 0.2)},${Math.round(v.z / 0.2)}`;
      let e = cells.get(k);
      if (!e) cells.set(k, (e = { n: 0, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, y0: 1e9, y1: -1e9 }));
      e.n++;
      if (v.x < e.x0) e.x0 = v.x; if (v.x > e.x1) e.x1 = v.x;
      if (v.z < e.z0) e.z0 = v.z; if (v.z > e.z1) e.z1 = v.z;
      if (v.y < e.y0) e.y0 = v.y; if (v.y > e.y1) e.y1 = v.y;
    }
  }
  const seen = new Set(), comps = [];
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
      const g = cur.split(','), gx = +g[0], gz = +g[1];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const nk = `${gx + dx},${gz + dz}`;
        if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    comps.push(c);
  }
  const KINDS = [
    { kind: 'bin', rMin: 0.24, rMax: 0.44, hMin: 0.80, hMax: 1.35 },
    { kind: 'bollard', rMin: 0.07, rMax: 0.17, hMin: 0.75, hMax: 1.25 },
    { kind: 'hydrant', rMin: 0.14, rMax: 0.24, hMin: 0.55, hMax: 0.95 },
    { kind: 'meter', rMin: 0.04, rMax: 0.14, hMin: 1.05, hMax: 1.45 },
    { kind: 'prop', rMin: 0.07, rMax: 0.70, hMin: 0.45, hMax: 1.60 },
  ];
  const cand = [];
  for (const c of comps) {
    const rx = (c.x1 - c.x0) / 2, rz = (c.z1 - c.z0) / 2;
    const rr = Math.max(rx, rz), hh = c.y1 - c.y0;
    const K = KINDS.find((k) => rr >= k.rMin && rr <= k.rMax && hh >= k.hMin && hh <= k.hMax
      && Math.min(rx, rz) > rr * 0.55);
    if (!K) continue;
    const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
    let gy = null;
    for (const [dx, dz] of [[rr + 0.6, 0], [-(rr + 0.6), 0], [0, rr + 0.6], [0, -(rr + 0.6)]]) {
      const q = probe(cx + dx, cz + dz);
      if (q && (gy === null || q.y < gy)) gy = q.y;
    }
    // A bin-sized lump three metres up is an awning end, not a bin.
    if (gy === null || c.y0 - gy < -0.30 || c.y0 - gy > 0.20) continue;
    cand.push({ kind: K.kind, x: cx, z: cz, rM: +rr.toFixed(3), hM: +hh.toFixed(2),
      baseY: c.y0, groundY: gy, dist: Math.hypot(cx - camPos.x, cz - camPos.z) });
  }
  for (const c of cand) {
    const p = project(c.x, c.baseY, c.z);
    c.inFrame = p.z <= 1 && p.x > 30 && p.x < wpx - 30 && p.y > 30 && p.y < hpx - 20;
    c.screen = [Math.round(p.x), Math.round(p.y)];
  }
  cand.sort((a, b) => (a.inFrame === b.inFrame ? a.dist - b.dist : (a.inFrame ? -1 : 1)));

  // THE PARKED CAR IS NOT A props: MESH. It is one InstancedMesh pooled by
  // src/streetfurniture.js buildParkedCars(), so the vertex-component finder
  // above cannot see it and the reviewer who measured under one would get no
  // answer from this tool. Its instances carry their own transforms, so the
  // nearest one in frame is read straight off instanceMatrix.
  const parked = D.furniture && D.furniture.parked;
  if (parked) {
    const mtx = new THREE.Matrix4(), pos = new THREE.Vector3();
    let best = null;
    for (let i = 0; i < parked.count; i++) {
      parked.mesh.getMatrixAt(i, mtx);
      pos.setFromMatrixPosition(mtx);
      // A pooled-but-unused slot is scaled to zero and parked at the origin.
      if (Math.abs(mtx.elements[0]) < 1e-6) continue;
      const d = Math.hypot(pos.x - camPos.x, pos.z - camPos.z);
      const p = project(pos.x, pos.y, pos.z);
      if (p.z > 1 || p.x < 60 || p.x > wpx - 60 || p.y < 60 || p.y > hpx - 40) continue;
      if (!best || d < best.d) best = { d, x: pos.x, y: pos.y, z: pos.z, p, i };
    }
    if (best) {
      const g = probe(best.x, best.z);
      cand.unshift({ kind: 'parkedcar', x: best.x, z: best.z, rM: 1.05, hM: 1.4,
        baseY: g ? g.y : best.y, groundY: g ? g.y : best.y, dist: best.d,
        inFrame: true, screen: [Math.round(best.p.x), Math.round(best.p.y)] });
    }
  }

  const subjects = [];
  for (const c of cand) {
    if (subjects.length >= 7) break;
    if (!c.inFrame) continue;
    const ringAt = (rad) => {
      const pts = [];
      for (let k = 0; k < 32; k++) {
        const th = (k / 32) * Math.PI * 2;
        const x = c.x + Math.cos(th) * rad, z = c.z + Math.sin(th) * rad;
        const g = probe(x, z);
        if (!g || onProps(g) || Math.abs(g.y - c.groundY) > 0.30) continue;
        const p = project(x, g.y, z);
        if (p.z > 1 || p.x < 6 || p.x > wpx - 6 || p.y < 6 || p.y > hpx - 6) continue;
        if (!visible(x, g.y, z, 0.35)) continue;
        pts.push([+p.x.toFixed(1), +p.y.toFixed(1)]);
      }
      return pts;
    };
    let near = [], nearR = 0;
    for (const d of [0.14, 0.24, 0.36]) { near = ringAt(c.rM + d); nearR = c.rM + d; if (near.length >= 4) break; }
    if (near.length < 4) continue;
    let far = [];
    for (const d of [2.2, 1.7, 2.8]) { far = ringAt(c.rM + d); if (far.length >= 4) break; }
    if (far.length < 4) continue;
    // SCREEN RESOLUTION AT THIS PROP, reported rather than assumed. 0.14 m of
    // ground at 46 m is under two pixels and a ratio taken there is noise.
    const a = project(c.x, c.groundY, c.z);
    const b = project(c.x + 0.5, c.groundY, c.z + 0.5);
    const pxPerM = Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(0.5, 0.5);
    // THE PROFILE, which is the measurement the ratio cannot make. A contact and
    // a wash have the SAME near/far ratio; what tells them apart is how fast the
    // darkening decays with distance from the base. Rings in true ground metres
    // out to 2.5 m at a 0.05 m step - two screen pixels at 19 m, eleven at 4.5 m.
    const prof = [];
    for (let d = 0.05; d <= 2.501; d += 0.05) prof.push({ d: +d.toFixed(2), pts: ringAt(c.rM + d) });
    subjects.push({ kind: c.kind, dist: +c.dist.toFixed(1), rM: c.rM, hM: c.hM, prof,
      x: +c.x.toFixed(2), z: +c.z.toFixed(2), screen: c.screen, contactRingM: +nearR.toFixed(2), near, far,
      pxPerM: +pxPerM.toFixed(2), clearPx: +((nearR - c.rM) * pxPerM).toFixed(1),
      resolved: (nearR - c.rM) * pxPerM >= minpx });
  }

  // --------------------------------------------------------------- the arms
  const sun = D.tod.sun;
  const parkedMesh = parked && parked.mesh;
  const sc0 = sun.shadow.camera;
  const saved = {
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
    intensity: sun.shadow.intensity, ao: D.post.params.aoEnabled,
    aoRadius: D.post.params.aoRadius, aoIntensity: D.post.params.aoIntensity,
    propCast: propMeshes.map((m) => m.castShadow),
    parkedCast: parkedMesh ? parkedMesh.castShadow : null,
  };
  const reset = () => {
    sun.shadow.bias = saved.bias;
    sun.shadow.normalBias = saved.normalBias;
    sun.shadow.intensity = saved.intensity;
    D.post.params.aoEnabled = saved.ao;
    D.post.params.aoRadius = saved.aoRadius;
    D.post.params.aoIntensity = saved.aoIntensity;
    propMeshes.forEach((m, i) => { m.castShadow = saved.propCast[i]; m.customDepthMaterial = undefined; });
    if (parkedMesh) { parkedMesh.castShadow = saved.parkedCast; parkedMesh.customDepthMaterial = undefined; }
    if (saved.mapSize && sun.shadow.mapSize.x !== saved.mapSize) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(saved.mapSize, saved.mapSize);
      const [l, r2, t, b] = saved.camBox;
      Object.assign(sc0, { left: l, right: r2, top: t, bottom: b });
      sc0.updateProjectionMatrix();
    }
  };
  const APPLY = {
    base: () => {},
    noPropShadow: () => propMeshes.forEach((m) => { m.castShadow = false; }),
    noParkedShadow: () => { if (parkedMesh) parkedMesh.castShadow = false; },
    noShadow: () => { sun.shadow.intensity = 0; },
    noAO: () => { D.post.params.aoEnabled = false; },
    bias0: () => { sun.shadow.bias = 0; },
    nbias0: () => { sun.shadow.normalBias = 0; },
    bias0nb0: () => { sun.shadow.bias = 0; sun.shadow.normalBias = 0; },
    // The AO arm the previous round settled on, and the one before it, so a
    // claim that the radius change cost the props their contact can be tested
    // in the same frame instead of across two builds.
    ao22: () => { D.post.params.aoRadius = 2.2; D.post.params.aoIntensity = 3.8; },
    ao06x: () => { D.post.params.aoRadius = 0.6; D.post.params.aoIntensity = 3.8; },
  };

  // ---- OCCLUDER DILATION, the mechanism src/pedestrians.js already uses.
  // A depth material that inflates along the vertex normal, so the shadow map
  // sees a silhouette `metres` wider than the object and a prop narrower than
  // the PCFSoft tent survives filtering. depthPacking must match what three's
  // own shadow depth material writes; a dilate-0 arm is the check on that,
  // because at 0 it has to land on the baseline exactly.
  const mkDepth = (metres) => {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const u = { value: metres };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uInflate = u;
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'uniform float uInflate;\nvoid main() {')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n\ttransformed += normalize( normal ) * uInflate;');
    };
    m.customProgramCacheKey = () => `probeDilate${metres}`;
    return m;
  };
  const depthCache = new Map();
  const dilate = (metres, which) => {
    const key = `${metres}`;
    if (!depthCache.has(key)) depthCache.set(key, mkDepth(metres));
    const dm = depthCache.get(key);
    for (const m of propMeshes) {
      if (which === 'near' && !/^props:near:/.test(m.name)) continue;
      if (which === 'far' && !/^props:far:/.test(m.name)) continue;
      m.customDepthMaterial = dm;
    }
    if (which === 'car' && parkedMesh) parkedMesh.customDepthMaterial = dm;
    if (which === 'nearcar') { if (parkedMesh) parkedMesh.customDepthMaterial = dm; }
  };
  // THE CEILING. Not a shippable arm - a 4096 map over a +-30 m box is 0.0146
  // m/texel, eight times finer than what ships, and daynight.js records that
  // 3072 alone failed the chunk-stall gate three times in seven runs. It is
  // here to answer one question the shippable arms cannot: if the shadow map
  // COULD resolve a 0.26 m post at noon, how much darker would the ground at
  // its base be? That number is the ceiling on every cast-shadow fix, and if it
  // is small then the cast shadow is the wrong lever and no amount of dilation
  // or bias will change that.
  APPLY.sharpShadow = () => {
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.00002;
    sun.shadow.normalBias = 0.01;
  };
  saved.mapSize = sun.shadow.mapSize.x;
  saved.camBox = [sc0.left, sc0.right, sc0.top, sc0.bottom];
  for (const d of [0, 0.04, 0.08, 0.12, 0.16, 0.24]) {
    APPLY[`dilNear${d}`] = () => dilate(d, 'near');
    APPLY[`dilAll${d}`] = () => dilate(d, 'all');
    APPLY[`dilNearCar${d}`] = () => { dilate(d, 'near'); dilate(d, 'nearcar'); };
  }
  const buf = new Uint8Array(wpx * hpx * 4);
  const lumaAt = (px, sx, sy) => {
    const x = Math.round(sx), y = Math.round(sy);
    if (x < 0 || y < 0 || x >= wpx || y >= hpx) return null;
    const i = ((hpx - 1 - y) * wpx + x) * 4;
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  };
  const ringLuma = (px, pts) => {
    let s = 0, n = 0;
    for (const p of pts) { const v = lumaAt(px, p[0], p[1]); if (v !== null) { s += v; n++; } }
    return n ? s / n : null;
  };
  const boxLuma = (px, b) => {
    let s = 0, n = 0;
    for (let y = b.y; y < Math.min(hpx, b.y + b.h); y++) {
      for (let x = b.x; x < Math.min(wpx, b.x + b.w); x++) { const v = lumaAt(px, x, y); if (v !== null) { s += v; n++; } }
    }
    return n ? +(s / n).toFixed(2) : null;
  };
  const shoot = () => {
    D.post.render();
    r.setRenderTarget(null);
    gl.readPixels(0, 0, wpx, hpx, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };

  // THE ARM HAS TO REACH THE FRAME BEFORE ITS CONTACT NUMBER MEANS ANYTHING.
  // A ratio that moves by 0.005 and a ratio that cannot move are the same
  // number in a table, so every arm is also differenced against the baseline
  // over all 1.44M pixels: how many changed by more than 4/255, and by how much
  // at the most. Free, because both frames are already in hand and neither can
  // have moved - they are two renders inside one task.
  let baseline = null;
  const deltaVs = (px) => {
    if (!baseline) return null;
    let over4 = 0, max = 0, sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const d = Math.abs((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])
        - (0.2126 * baseline[i] + 0.7152 * baseline[i + 1] + 0.0722 * baseline[i + 2]));
      sum += d; if (d > 4) over4++; if (d > max) max = d;
    }
    const n = px.length / 4;
    return { meanAbs: +(sum / n).toFixed(3), maxAbs: +max.toFixed(1), pctOver4: +(100 * over4 / n).toFixed(2) };
  };

  const shots = {};
  const results = {};
  for (const name of armNames) {
    const parts = name.split('+');
    if (parts.some((q) => !APPLY[q])) { results[name] = { error: 'unknown arm' }; continue; }
    reset();
    for (const q of parts) APPLY[q]();
    sun.shadow.needsUpdate = true;
    const px = shoot();
    const delta = deltaVs(px);
    if (!baseline) baseline = px.slice();
    if (wantShots) {
      const cv = document.createElement('canvas');
      cv.width = wpx; cv.height = hpx;
      const ctx = cv.getContext('2d');
      const im = ctx.createImageData(wpx, hpx);
      for (let y = 0; y < hpx; y++) {
        const src = (hpx - 1 - y) * wpx * 4, dst = y * wpx * 4;
        for (let x = 0; x < wpx * 4; x++) im.data[dst + x] = px[src + x];
      }
      ctx.putImageData(im, 0, 0);
      shots[name] = cv.toDataURL('image/png');
    }
    results[name] = {
      delta,
      contacts: subjects.map((s) => {
        const nl = ringLuma(px, s.near), fl = ringLuma(px, s.far);
        return { kind: s.kind, dist: s.dist, resolved: s.resolved,
          near: nl === null ? null : +nl.toFixed(2), far: fl === null ? null : +fl.toFixed(2),
          ratio: nl === null || fl === null || !(fl > 0) ? null : +(nl / fl).toFixed(4) };
      }),
      profiles: subjects.slice(0, 3).map((s) => s.prof.map((r) => {
        const v = ringLuma(px, r.pts);
        return v === null ? null : +v.toFixed(1);
      })),
      boxes: Object.fromEntries(boxes.map((b) => [b.name, boxLuma(px, b)])),
      frameMean: (() => { let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; return +(s / (px.length / 4)).toFixed(2); })(),
    };
  }
  // The repeat: baseline again, LAST, after every other arm has touched the
  // uniforms. If anything failed to restore, or the world moved, this diverges.
  reset();
  sun.shadow.needsUpdate = true;
  {
    const px = shoot();
    results.__repeat = {
      contacts: subjects.map((s) => {
        const nl = ringLuma(px, s.near), fl = ringLuma(px, s.far);
        return { ratio: nl === null || fl === null || !(fl > 0) ? null : +(nl / fl).toFixed(4) };
      }),
      frameMean: (() => { let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; return +(s / (px.length / 4)).toFixed(2); })(),
    };
  }
  reset();

  // What the shadow pass is actually configured to do, so a null result can be
  // told apart from a misconfigured one.
  const sc = sun.shadow.camera;
  const cfg = {
    mapSize: sun.shadow.mapSize.x,
    parkedCasting: parkedMesh ? parkedMesh.castShadow : null,
    parkedFilled: parked ? parked.filled : null,
    parkedVisible: parkedMesh ? parkedMesh.visible : null,
    parkedCount: parkedMesh ? parkedMesh.count : null,
    parkedMatName: parkedMesh && parkedMesh.material ? (parkedMesh.material.type + '/' + (parkedMesh.material.name || '')) : null,
    parkedTransparent: parkedMesh && parkedMesh.material ? parkedMesh.material.transparent : null,
    parkedSide: parkedMesh && parkedMesh.material ? parkedMesh.material.side : null,
    parkedShadowSide: parkedMesh && parkedMesh.material ? (parkedMesh.material.shadowSide ?? null) : null,
    parkedFrustumCulled: parkedMesh ? parkedMesh.frustumCulled : null,
    shadowMapAutoUpdate: r.shadowMap.enabled ? r.shadowMap.autoUpdate : null,
    shadowMapType: r.shadowMap.type,
    extentM: sc.right - sc.left,
    metresPerTexel: +((sc.right - sc.left) / sun.shadow.mapSize.x).toFixed(4),
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
    near: sc.near, far: sc.far,
    // shadow.bias is in NORMALISED depth over the light camera's near..far, so
    // the metres it actually displaces a receiver by along the light ray is
    // bias * (far - near). That is the number that decides whether a 1 m prop
    // can shadow its own base, and it is not the number in the source.
    biasMetres: +(Math.abs(sun.shadow.bias) * (sc.far - sc.near)).toFixed(3),
    sunElevationDeg: +(Math.asin(Math.max(-1, Math.min(1,
      new THREE.Vector3().copy(sun.position).sub(sun.target.position).normalize().y))) * 180 / Math.PI).toFixed(1),
    propMeshes: propMeshes.length,
    propCasters: propMeshes.filter((m) => m.castShadow).length,
    propVisible: propMeshes.filter((m) => m.visible).length,
    // Every visible prop bucket's distance against the reach test in
    // src/streetfurniture.js cullProps(), so "the cull is dropping near props"
    // is a measurement and not an inference.
    buckets: propMeshes.filter((m) => m.visible).map((m) => ({
      name: m.name,
      d: +Math.hypot(camPos.x - m.userData.c.x, camPos.z - m.userData.c.z).toFixed(1),
      r: +m.userData.r.toFixed(1), cull: m.userData.cull, cast: m.castShadow,
    })).sort((a, b) => a.d - b.d).slice(0, 20),
  };
  return { cfg, vertsRead, comps: comps.length, cands: cand.length, subjects, results, shots };
}, [ARMS, BOXES[CAMNAME] || [], MINPX, W, H, SHOTS]);

// ---------------------------------------------------------------- the verdict
const rep = out.results.__repeat;
const pairs = [[out.results.base.frameMean, rep.frameMean, 'frameMean/255']];
out.subjects.forEach((s, i) => {
  const a = out.results.base.contacts[i].ratio, b = rep.contacts[i].ratio;
  if (a !== null && b !== null) pairs.push([a, b, `${s.kind}@${s.dist}m`]);
});
const guard = repeatVerdict(pairs.map(([a, b, n]) => [a / (n.endsWith('/255') ? 255 : 1), b / (n.endsWith('/255') ? 255 : 1), n]), TOL);

console.log(`\nshadow config: ${out.cfg.mapSize} over ${out.cfg.extentM} m = ${out.cfg.metresPerTexel} m/texel`);
console.log(`  bias ${out.cfg.bias} over near ${out.cfg.near}/far ${out.cfg.far} = ${out.cfg.biasMetres} m along the light ray`);
console.log(`  normalBias ${out.cfg.normalBias} m,  sun elevation ${out.cfg.sunElevationDeg} deg`);
console.log(`  prop buckets: ${out.cfg.propMeshes} total, ${out.cfg.propVisible} visible, ${out.cfg.propCasters} casting`);
console.log('  nearest visible buckets (d, r, cull, casting):');
for (const b of out.cfg.buckets.slice(0, 8)) {
  console.log(`    ${b.name.padEnd(28)} d=${String(b.d).padStart(7)}  r=${String(b.r).padStart(6)}  cull=${b.cull}  cast=${b.cast}`);
}
console.log(`\nprops found: ${out.comps} components from ${out.vertsRead} verts -> ${out.cands} shaped -> ${out.subjects.length} measurable`);
for (const s of out.subjects) {
  console.log(`  ${s.kind.padEnd(8)} ${String(s.dist).padStart(5)} m  r=${s.rM}  screen ${s.screen}  ` +
    `ring ${s.clearPx} px clear  ${s.resolved ? 'RESOLVED' : 'UNRESOLVED (< ' + MINPX + ' px)'}`);
}

console.log('\ncontact ratio (ring at base / ring 2.2 m out; 1.00 = not touching)');
const hdr = ['arm'.padEnd(14), ...out.subjects.map((s) => `${s.kind}@${s.dist}`.padStart(16))].join('');
console.log(hdr);
for (const name of ARMS) {
  const rr = out.results[name];
  if (!rr || rr.error) { console.log(`${name.padEnd(14)}  ${rr && rr.error}`); continue; }
  console.log([name.padEnd(14), ...rr.contacts.map((c) => String(c.ratio ?? '-').padStart(16))].join(''));
}
console.log('\nreviewer boxes (mean luma of 255)');
for (const b of (BOXES[CAMNAME] || [])) {
  console.log(`  ${b.name.padEnd(20)} ${ARMS.map((n) => `${n}=${out.results[n] && out.results[n].boxes[b.name]}`).join('  ')}`);
}
console.log(`\nframe mean: ${ARMS.map((n) => `${n}=${out.results[n] && out.results[n].frameMean}`).join('  ')}`);
// The profile, printed as a table: the number that separates a contact from a
// wash is how much of the darkening is gone by 0.5 m.
const PROF_D = out.subjects.length ? out.subjects[0].prof.map((r) => r.d) : [];
for (let si = 0; si < Math.min(3, out.subjects.length); si++) {
  const s = out.subjects[si];
  console.log(`\nground profile out from ${s.kind}@${s.dist} m  (${s.pxPerM} px/m; 0.05 m = ${(0.05 * s.pxPerM).toFixed(1)} px)`);
  console.log('  d(m)  ' + PROF_D.filter((d, i) => i % 2 === 1 && d <= 2.5).map((d) => String(d.toFixed(2)).padStart(7)).join(''));
  for (const n of ARMS) {
    const p = out.results[n] && out.results[n].profiles && out.results[n].profiles[si];
    if (!p) continue;
    console.log(`  ${n.padEnd(6)}` + p.filter((v, i) => i % 2 === 1 && PROF_D[i] <= 2.5).map((v) => String(v ?? '-').padStart(7)).join(''));
  }
  // How much of the contact darkening survives to 0.5 m, per arm: a real contact
  // is mostly gone by then, a wash is not.
  for (const n of ARMS) {
    const p = out.results[n] && out.results[n].profiles && out.results[n].profiles[si];
    if (!p) continue;
    const at = (d) => { const i = PROF_D.findIndex((q) => Math.abs(q - d) < 1e-6); return i < 0 ? null : p[i]; };
    const a = at(0.05), b = at(0.5), c = at(2.0);
    if (a === null || b === null || c === null) continue;
    console.log(`    ${n.padEnd(14)} 0.05 m ${String(a).padStart(6)}   0.5 m ${String(b).padStart(6)}   2.0 m ${String(c).padStart(6)}` +
      `   drop@base ${(1 - a / c).toFixed(3)}   still@0.5 ${(1 - b / c).toFixed(3)}`);
  }
}

console.log('\ndoes the arm reach the frame at all? (vs base, over 1600x900)');
for (const n of ARMS) {
  const d = out.results[n] && out.results[n].delta;
  console.log(`  ${n.padEnd(16)} ${d ? `meanAbs=${String(d.meanAbs).padStart(7)}  maxAbs=${String(d.maxAbs).padStart(6)}  pctOver4=${d.pctOver4}%` : '(baseline)'}`);
}
console.log(`\nrepeat guard (tol ${TOL}): ${guard.ok ? 'PASS' : 'VOID — the arms are not comparable'}`);
for (const r of guard.rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.name).padEnd(20)} ${r.a} vs ${r.b}  d=${r.d}`);
if (errors.length) console.log('\npage errors:', errors.slice(0, 5));

if (SHOTS && out.shots) {
  fs.mkdirSync('docs/shots', { recursive: true });
  for (const [name, url] of Object.entries(out.shots)) {
    const f = `docs/shots/${TAG}-${CAMNAME}-${TOD}-${name}.png`;
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`  wrote ${f}`);
  }
}
delete out.shots;
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(`docs/${TAG}-${CAMNAME}-${TOD}.json`,
  JSON.stringify({ tag: TAG, cam: CAMNAME, tod: TOD, port: PORT, placed, guard, ...out, errors }, null, 1));
console.log(`\nwrote docs/${TAG}-${CAMNAME}-${TOD}.json`);
await browser.close();
process.exit(guard.ok ? 0 : 3);
