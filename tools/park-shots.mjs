// A kerb of parked cars, framed from the kerb's own geometry, with the shell
// count as the only thing that differs between the arms.
//
// WHY THIS EXISTS RATHER THAN ANOTHER HERO ANGLE. Three blind reviewers ranked
// "every parked car is the same body shell" the worst thing about these cars,
// and #56 answered it with three shells whose silhouettes differ mostly in
// `breakZ` -- where the roof meets the deck -- by up to 580 mm. The hero cameras
// stand in the carriageway and look ALONG it, so tools/car-frames.mjs measures
// the parked cars at 34x24 and 62x52 px at a quarter angle. A 580 mm roofline
// break on a 4.5 m car seen 34 px long is under 5 px, and the LENGTH difference
// between shells (0.196 m, 4.4%) is 1.5 px. That frame cannot resolve what this
// round changed, and saying so is cheaper than shooting it and arguing.
//
//   node tools/park-shots.mjs --list                   # the runs, no capture
//   node tools/park-shots.mjs --tag r6 --smoke         # ONE frame, one arm
//   node tools/park-shots.mjs --tag r6                 # the pair
//   node tools/park-shots.mjs --tag r6 --run 1 --times dusk,noon
//
// THE PAIR IS ONE TREE, ONE PORT, ONE BUILD. `?shells=1` collapses the slot
// hash's modulus to 0 for every slot, and SHAPES.coupe is `{}` which
// buildTrafficCarGeometry falls back to CAR on, so arm 1 emits exactly the
// geometry the reviewers judged. district/main.js reads it before either pool
// exists. Position, yaw and PAINT all come from separate bit ranges of the same
// slot hash and are untouched by the shell count, so the two arms are the same
// cars in the same places in the same colours -- which is a registered pair of a
// kind this project has usually had to fake with two checkouts. CLAUDE.md records
// a four-hour round lost to a worktree capture that silently reused the main
// tree's server; there is no second tree here to get wrong.
//
// THE FRAMING IS DERIVED FROM THE SLOTS, in lot-shots' sense: the same --run on
// any commit gives the same camera, because it is computed from the kerb the
// district seeds rather than typed in. `_parkCells` is built once at dress time
// and holds every slot in the district regardless of where the camera is, so the
// census is camera-independent; the pool only chooses which of them to FILL.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const OUT = 'docs/shots';
const TAG = flag('tag', 'park');
const RUN = Number(flag('run', 0));
const TIMES = (flag('times', 'dusk') || 'dusk').split(',').map((s) => s.trim()).filter(Boolean);
const ARMS = (flag('shells', '1,3') || '1,3').split(',').map(Number);
const PORT = Number(process.env.PARK_PORT ?? 8123);
// Geometry of the stand, in metres, and every one of them is reported in the
// audit so a later run can reproduce or move it deliberately.
//
// TWO VIEWS, because they answer different halves of the complaint and a single
// frame answers neither well. The first smoke frame was `along` at fov 55 and
// side 7.5: a good street picture that spent 55% of its width on empty plaza and
// showed the receding cars mostly from the REAR quarter. `breakZ` -- the roofline
// break, which is where up to 580 mm of this round's difference lives -- reads in
// PROFILE and barely at all from behind.
//
//   along      down the kerb, eye level. "Thirty of them line one street" was the
//              complaint, so this is the frame the complaint was made about.
//   broadside  square on to the middle of the run, a longer lens. Three or four
//              cars in near-profile, where a roofline is unmistakable.
const VIEWS = (flag('view', 'along,broadside') || 'along').split(',').map((v) => v.trim());
const DEFAULTS = {
  // `from` is which end of the run the camera's along-axis offset starts at:
  // standing behind the first car is what makes `along` a receding line, and
  // standing level with the middle is what makes `broadside` square on.
  along:     { back: 15, side: 4.5, height: 1.65, fov: 40, from: 'first',  tgtY: 1.0, w: 1600, h: 900 },
  broadside: { back: 0,  side: 24,  height: 1.45, fov: 15, from: 'centre', tgtY: 0.85, w: 1600, h: 480 },
};
//
// WHY BROADSIDE IS A LETTERBOX, and it is arithmetic rather than taste. A car is
// 1.5 m tall and 4.5 m long. To get four of them across a 16:9 frame the frame
// has to be 28 m wide, therefore 15.8 m tall, so the car is 1.5/15.8 = 9.5% of
// the height -- 86 px of a 900 px frame, and the first broadside smoke measured
// exactly that at 58 px with 60% of the image empty brick plaza. No camera
// placement fixes it: the aspect ratio is the constraint. At 1600x480 and a 15
// degree vertical fov from 24 m the frame is 21.1 m wide and 6.3 m tall, which is
// 3.3 cars with each 114 px tall -- and 580 mm of roofline break is then 44 px.
// Say what the frame can resolve before shooting it, not after.
// Any of them can be overridden on the command line, and the override applies to
// every view in the run -- so sweep one view at a time when you are tuning.
const OVERRIDE = {};
for (const k of ['back', 'side', 'height', 'fov', 'tgtY']) {
  const v = flag(k); if (v !== null) OVERRIDE[k] = Number(v);
}
const SMOKE = has('smoke');

// ------------------------------------------------------------------ the runs
//
// A run is the slots on ONE kerb, nose to tail. Found by CONNECTIVITY: two slots
// are on one kerb when the vector between them points along both their headings.
//
// THE FIRST VERSION BINNED YAW AT 2 DEGREES and bucketed a perpendicular offset,
// and it found ONE run in 2,280 slots. src/streetfurniture.js jitters each slot's
// yaw by +/-0.03 rad and that perpendicular offset is computed FROM the jittered
// yaw, so two cars on the same kerb land in different bins however the bins are
// drawn. The same trap CLAUDE.md records for awning coverage: no threshold
// rescues a proximity test whose quantity is itself noisy, and linking neighbours
// cannot be fooled that way.
const LINK_M = 9.0;        // the slot pitch is ~6.4 m; over 9 m is a break in the kerb
const COS_MIN = Math.cos(12 * Math.PI / 180);
export function findRuns(slots, minN = 4) {
  const fwd = (s) => ({ x: Math.sin(s.yaw), z: Math.cos(s.yaw) });
  const n = slots.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const a = slots[i], fa = fwd(a);
    for (let j = i + 1; j < n; j++) {
      const b = slots[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5 || d > LINK_M) continue;
      const ux = dx / d, uz = dz / d, fb = fwd(b);
      if (Math.abs(ux * fa.x + uz * fa.z) < COS_MIN) continue;
      if (Math.abs(ux * fb.x + uz * fb.z) < COS_MIN) continue;
      if (Math.abs(fa.x * fb.x + fa.z * fb.z) < COS_MIN) continue;
      adj[i].push(j); adj[j].push(i);
    }
  }
  const comp = new Int32Array(n).fill(-1);
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const stack = [i]; comp[i] = groups.length; const members = [];
    while (stack.length) {
      const k = stack.pop(); members.push(k);
      for (const m of adj[k]) if (comp[m] < 0) { comp[m] = groups.length; stack.push(m); }
    }
    groups.push(members);
  }
  const runs = groups.filter((g) => g.length >= minN).map((members) => {
    const pts = members.map((i) => slots[i]);
    const f = fwd(pts[0]);
    pts.sort((a, b) => (a.x * f.x + a.z * f.z) - (b.x * f.x + b.z * f.z));
    const A = pts[0], B = pts[pts.length - 1];
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const shells = pts.map((p) => p.shell ?? 0);
    let alt = 0;
    for (let i = 1; i < shells.length; i++) if (shells[i] !== shells[i - 1]) alt++;
    return { pts, len, shells, uniq: new Set(shells).size, alt,
      cx: pts.reduce((a, p) => a + p.x, 0) / pts.length,
      cz: pts.reduce((a, p) => a + p.z, 0) / pts.length,
      dir: { x: (B.x - A.x) / (len || 1), z: (B.z - A.z) / (len || 1) } };
  });
  // Longest first, then the most shell CHANGES along the line. A run with all
  // three shells present but clustered [000111222] reads as three groups of one
  // car; what answers the complaint is a kerb where the shape changes car to car.
  runs.sort((a, b) => b.pts.length - a.pts.length || b.alt - a.alt);
  return runs;
}

if (has('selftest')) {
  let checks = 0, failed = 0;
  const ok = (c, label, got) => {
    checks++;
    if (c) console.log(`  ok    ${label}${got !== undefined ? `   ${got}` : ''}`);
    else { failed++; console.log(`  FAIL  ${label}${got !== undefined ? `   ${got}` : ''}`); }
  };
  console.log('PARK-SHOTS SELFTEST');
  // A straight kerb of six, 6.4 m apart, pointing +x (yaw = pi/2).
  const line = (n, jitter = 0) => Array.from({ length: n }, (_, i) => ({
    x: i * 6.4, z: 0, yaw: Math.PI / 2 + (jitter ? ((i % 2) ? jitter : -jitter) : 0),
    hue: i / n, shell: i % 3,
  }));
  const r1 = findRuns(line(6));
  ok(r1.length === 1 && r1[0].pts.length === 6, 'six slots on one kerb are one run of six',
    `${r1.length} runs, ${r1[0] ? r1[0].pts.length : 0} long`);
  ok(Math.abs(r1[0].len - 32.0) < 1e-6, '...and its length is the end-to-end span', r1[0].len.toFixed(3));
  // THE KNOWN-BAD THE BINNED VERSION FAILED. The real seeder jitters yaw by up to
  // 0.03 rad; a run must survive that. This is the exact defect, as a check.
  const r2 = findRuns(line(6, 0.03));
  ok(r2.length === 1 && r2[0].pts.length === 6,
    'KNOWN-BAD for the binned version: +/-0.03 rad of yaw jitter is still ONE run',
    `${r2.length} runs, ${r2[0] ? r2[0].pts.length : 0} long`);
  // A gap wider than LINK_M splits it, and that is the point of LINK_M.
  const broken = line(8); for (let i = 4; i < 8; i++) broken[i].x += 14;
  const r3 = findRuns(broken);
  ok(r3.length === 2 && r3.every((r) => r.pts.length === 4),
    'a 20.4 m hole in the kerb is two runs, not one', r3.map((r) => r.pts.length).join('+'));
  // Two kerbs crossing at a junction must not merge: same position scale, 90 deg apart.
  const cross = [...line(5), ...line(5).map((s) => ({ ...s, x: 0, z: s.x, yaw: 0 }))];
  const r4 = findRuns(cross);
  ok(r4.length === 2, 'two kerbs meeting at right angles stay two runs', `${r4.length}`);
  // The ORDER is what --run 0 means, so assert it rather than trusting the sort.
  const mixed = findRuns([...line(4), ...line(7).map((s) => ({ ...s, z: 40 }))]);
  ok(mixed[0].pts.length === 7, '--run 0 is the LONGEST run', mixed.map((r) => r.pts.length).join(','));
  // alt counts CHANGES, not distinct shells: the tie-break has to prefer a kerb
  // whose shape changes car to car over one with three cars of each.
  const clustered = { pts: [], shells: [0, 0, 0, 1, 1, 1] };
  let altC = 0; for (let i = 1; i < 6; i++) if (clustered.shells[i] !== clustered.shells[i - 1]) altC++;
  ok(altC === 1, 'a clustered [000111] kerb scores alt 1, not uniq 2', `${altC}`);
  const six = findRuns(line(6));
  ok(six[0].alt === 5 && six[0].uniq === 3,
    '...where [012012] scores alt 5 of 5', `alt ${six[0].alt}, uniq ${six[0].uniq}`);
  // Fewer than minN is not a run at all.
  ok(findRuns(line(3)).length === 0, 'three slots is not a run at the default minimum 4',
    `${findRuns(line(3)).length}`);
  console.log(`\n${checks - failed}/${checks} checks passed`);
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------------- capture
fs.mkdirSync(OUT, { recursive: true });
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());

/** Settle on RENDERED FRAMES, never on the wall clock. See tools/hero-shots.mjs. */
async function settleFrames(page, n, why) {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((t) => __district.frames >= t, f0 + n,
    { timeout: Number(process.env.PARK_SETTLE_MS ?? 240000) });
  console.log(`    settled ${n} frames (${why})`);
}

const shotErrors = [];
const audits = [];

for (const shells of (SMOKE ? [ARMS[ARMS.length - 1]] : ARMS)) {
  const page = await browser.newPage({ viewport: { width: DEFAULTS[VIEWS[0]].w, height: DEFAULTS[VIEWS[0]].h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/?shells=${shells}`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null,
    { timeout: Number(process.env.PARK_BOOT ?? 120000) });
  await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
  // PIN THE CLOUD DECK. CLAUDE.md: sky.js advected the deck off performance.now(),
  // and because headless capture is minutes per frame the sky was the largest
  // single component of several pairs' whole-frame difference. The arms here are
  // captured from two page loads minutes apart, which is exactly that case.
  const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds() : null));

  // The census, and the run, from the page's own seeding.
  const census = await page.evaluate(() => {
    const f = __district.furniture;
    if (!f || !f._parkCells) return null;
    const slots = [];
    for (const [, list] of f._parkCells) for (const s of list) {
      slots.push({ x: s.x, z: s.z, yaw: s.yaw, hue: s.hue, shell: s.shell ?? 0 });
    }
    return { slots, shells: __district.carShells() };
  });
  if (!census) throw new Error('no _parkCells on the page — the pool never dressed');
  const runs = findRuns(census.slots);
  if (!runs[RUN]) throw new Error(`--run ${RUN} does not exist; found ${runs.length} runs`);
  const run = runs[RUN];
  console.log(`shells=${shells}: ${census.slots.length} slots, ${runs.length} runs; ` +
    `run ${RUN} is ${run.pts.length} cars over ${run.len.toFixed(1)} m at ` +
    `(${run.cx.toFixed(0)},${run.cz.toFixed(0)}), shells [${run.shells.join('')}]` +
    `${froze ? '' : '  WARNING: clouds not frozen'}`);
  if (has('list')) { await page.close(); break; }

  for (const view of VIEWS) {
  if (!DEFAULTS[view]) throw new Error(`--view names no such view: ${view} (have: ${Object.keys(DEFAULTS).join(', ')})`);
  const V = { ...DEFAULTS[view], ...OVERRIDE };
  await page.setViewportSize({ width: V.w, height: V.h });
  // Place the camera from the run's own geometry. WHICH SIDE is the carriageway
  // is measured, not assumed: the kerb has buildings on one side and road on the
  // other, so the side with more clearance to the nearest footprint is the road.
  const placed = await page.evaluate((cfg) => {
    const { A, dir, back, side, height, fov, tgt } = cfg;
    const inRing = (ring, x, z) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    const segDist = (px, pz, x0, z0, x1, z1) => {
      const vx = x1 - x0, vz = z1 - z0, l2 = vx * vx + vz * vz;
      const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0;
      return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t));
    };
    const clearance = (x, z) => {
      const [cx, cz] = __district.world.keyOf(x, z).split(',').map(Number);
      let best = Infinity, inside = -1;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const c = __district.district.chunks[`${cx + dx},${cz + dz}`];
        if (!c) continue;
        for (const bi of c.buildings) {
          const ring = __district.district.buildings[bi].p;
          let d = Infinity;
          for (let i = 0; i < ring.length; i++) {
            const P = ring[i], Q = ring[(i + 1) % ring.length];
            d = Math.min(d, segDist(x, z, P[0], P[1], Q[0], Q[1]));
          }
          if (inRing(ring, x, z)) { inside = bi; d = -d; }
          if (d < best) best = d;
        }
      }
      return { d: best === Infinity ? 99 : best, inside };
    };
    // n is perpendicular to the run; probe both signs at `side` metres out.
    const nx = -dir.z, nz = dir.x;
    const mid = { x: tgt.x, z: tgt.z };
    const plus = clearance(mid.x + nx * side, mid.z + nz * side);
    const minus = clearance(mid.x - nx * side, mid.z - nz * side);
    const sgn = plus.d >= minus.d ? 1 : -1;
    // KEEP THE CAMERA OUT OF THE BUILDINGS, which is not a hypothetical: the
    // first `along` stand at back 15 put the camera 0.8 m INSIDE building 374.
    // Walls here are single-sided, so from in there the block's own facades
    // vanish and its awnings and parapet hang over the street with nothing under
    // them -- three rounds of blind critics reported exactly that frame as
    // floating props, and it was the camera. tools/hero-shots.mjs pulls `back`
    // in for the same reason; this walks the whole offset toward the kerb instead,
    // because `broadside` has back 0 and there is nothing to pull in.
    let px = 0, pz = 0, cl = { d: 99, inside: -1 }, k = 1;
    const MIN_CLEAR = 3.0;
    for (; k > 0.15; k -= 0.05) {
      px = A.x - dir.x * back * k + nx * side * k * sgn;
      pz = A.z - dir.z * back * k + nz * side * k * sgn;
      cl = clearance(px, pz);
      if (cl.d >= MIN_CLEAR) break;
    }
    const pulled = +(1 - k).toFixed(2);
    // THE PLAYER'S CAR GOES TO THE CAMERA AND IS THEN HIDDEN, and both halves
    // are needed. The first broadside smoke parked it at the run's centre --
    // `placeAt(mid)` -- so the frame about parked cars had the player's own car
    // across the middle of it with its headlights on. Moving it is not enough to
    // put it out of shot reliably, and hiding it alone is not enough either:
    // `world.update` streams around the VEHICLE position, so a car left at the
    // district spawn streams the wrong chunks. Put it where the camera is, then
    // hide it; `playerLampSpill` is a child of the same group, so the spill goes
    // with it.
    __district.placeAt(px, pz);
    __district.setAutopilot(() => {});
    if (__district.car && __district.car.group) __district.car.group.visible = false;
    __district.freeCam([px, height, pz], [tgt.x, tgt.y, tgt.z], fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    // Seed the pool at the CAMERA, which is where src/streetfurniture.js's own
    // per-frame call puts it -- forcing it anywhere else only changes frame one.
    const filled = __district.furniture.refreshParked(px, pz, true);
    return { x: +px.toFixed(2), z: +pz.toFixed(2), side: sgn > 0 ? '+n' : '-n',
      pulledIn: pulled, standScale: +k.toFixed(2),
      roadClear: +Math.max(plus.d, minus.d).toFixed(1),
      wallClear: +Math.min(plus.d, minus.d).toFixed(1),
      camClear: +cl.d.toFixed(1), inside: cl.inside, filled,
      playerHidden: !!(__district.car && __district.car.group && !__district.car.group.visible) };
  }, { A: V.from === 'centre' ? { x: run.cx, z: run.cz } : run.pts[0],
       dir: run.dir, back: V.back, side: V.side, height: V.height, fov: V.fov,
       tgt: { x: run.cx, y: V.tgtY, z: run.cz } });
  console.log(`  ${view}: camera (${placed.x},${placed.z}) on the ${placed.side} side, ` +
    `${placed.camClear} m clear` +
    (placed.pulledIn > 0 ? ` (pulled ${(placed.pulledIn * 100).toFixed(0)}% toward the kerb)` : '') +
    (placed.camClear < 3.0 ? `  WARNING inside/against building ${placed.inside}` : '') +
    `; road side ${placed.roadClear} m / wall side ${placed.wallClear} m; pool filled ${placed.filled}` +
    (placed.playerHidden ? '' : '  WARNING: the player car is still visible and will be in shot'));
  await settleFrames(page, Number(process.env.PARK_FRAMES ?? 14), `camera, ${view}, shells=${shells}`);

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await settleFrames(page, 6, `tod ${tod}`);
    // WHICH CARS ARE ACTUALLY DRAWN, and how big each is on the film.
    //
    // Matched to slots BY POSITION, which is exact: refreshParked writes
    // setPosition(s.x, 0, s.z) straight from the slot. The shell is the mesh the
    // instance is in. And the projected extent is computed from the car's OWN
    // geometry through the LIVE camera, car-probe's rule -- a box drawn on the
    // image by eye is not a measurement of the car, and this round MOVED the
    // geometry, which is the case CLAUDE.md says no fixed box survives.
    const seen = await page.evaluate((runPts) => {
      // THREE is not a global on this page. Both constructors are reachable from
      // objects __district already exposes, which is better than a global anyway:
      // it cannot pick up a different copy of the library than the scene uses.
      const cam = __district.camera;
      const p = __district.furniture.parked;
      const names = __district.carShells().names;
      const Matrix4 = __district.scene.matrixWorld.constructor;
      const Vector3 = cam.position.constructor;
      const m = new Matrix4(), v = new Vector3();
      const W = window.innerWidth, H = window.innerHeight;
      const cars = [];
      for (let sh = 0; sh < p.meshes.length; sh++) {
        const mesh = p.meshes[sh];
        const g = mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m);
          const e = m.elements;
          if (e[0] === 0 && e[5] === 0 && e[10] === 0) continue;   // the hidden matrix
          const wx = e[12], wz = e[14];
          let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, behind = 0;
          for (let c = 0; c < 8; c++) {
            v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z);
            v.applyMatrix4(m).project(cam);
            if (v.z > 1) behind++;
            const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
            minx = Math.min(minx, sx); maxx = Math.max(maxx, sx);
            miny = Math.min(miny, sy); maxy = Math.max(maxy, sy);
          }
          const onScreen = maxx > 0 && minx < W && maxy > 0 && miny < H && behind === 0;
          // THE EXTENT OF AN OFF-SCREEN CAR IS NOT A SIZE. A perspective divide
          // stretches without bound toward the frustum edge, so the first version
          // of this table reported a car at 33.3 m as 507 px wide and one at 21 m
          // as 345 -- correct projective arithmetic, and backwards as a reading of
          // how big the subject is. Reported as null rather than as a number.
          cars.push({ shell: names[sh], x: +wx.toFixed(2), z: +wz.toFixed(2),
            px: onScreen ? Math.round(maxx - minx) : null,
            py: onScreen ? Math.round(maxy - miny) : null,
            cx: Math.round((minx + maxx) / 2), cy: Math.round((miny + maxy) / 2),
            dist: +Math.hypot(wx - cam.position.x, wz - cam.position.z).toFixed(1), onScreen });
        }
      }
      // Match each run slot to a drawn car by position; exact, see above.
      const inRun = runPts.map((s) => {
        const hit = cars.find((c) => Math.hypot(c.x - s.x, c.z - s.z) < 0.05);
        return hit ? { ...hit, slotShell: s.shell } : { x: s.x, z: s.z, slotShell: s.shell, missing: true };
      });
      return { drawn: cars.length, inRun,
        cam: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2),
          fov: cam.fov } };
    }, run.pts);

    const vis = seen.inRun.filter((c) => c.onScreen);
    // CAN THIS FRAME RESOLVE WHAT THE ROUND CHANGED? The shells differ by up to
    // 580 mm of `breakZ` on a 1.5 m tall car and by 196 mm of length on a 4.5 m
    // one, so say what those are worth in pixels HERE rather than leaving a
    // reader to wonder. CLAUDE.md: check your sampling can resolve what you
    // assert, and if it cannot, say so instead of quoting it.
    const tallest = vis.length ? Math.max(...vis.map((c) => c.py)) : 0;
    const longest = vis.length ? Math.max(...vis.map((c) => c.px)) : 0;
    console.log(`    ${tod}: ${seen.drawn} cars drawn, ${seen.inRun.filter((c) => !c.missing).length}/${run.pts.length} of the run filled, ${vis.length} on screen` +
      (vis.length ? `; biggest ${longest}x${tallest} px, so 580 mm of roofline break is ` +
        `${(0.58 / 1.5 * tallest).toFixed(0)} px and 196 mm of length is ${(0.196 / 4.5 * longest).toFixed(0)} px` : ''));
    for (const c of seen.inRun) {
      console.log(`      ${c.missing ? 'NOT FILLED' : (c.onScreen ? 'on ' : 'off')} ` +
        `${String(c.shell ?? '-').padEnd(7)} ${String(c.dist ?? '-').padStart(5)} m  ` +
        `${String(c.px ?? '-').padStart(4)}x${String(c.py ?? '-').padEnd(4)} px  at (${c.x},${c.z})`);
    }

    const name = `${TAG}-park${RUN}-${view}-s${shells}-${tod}`;
    // BOUNDED AND NON-FATAL. CLAUDE.md: a screenshot that throws inside a loop
    // destroys every frame after it and the run reads as a short list rather than
    // a crash -- and the two arms do NOT lose the same frames, so a pairing by
    // index silently compares different ground.
    try {
      await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 180000 });
      console.log(`    wrote ${OUT}/${name}.png`);
    } catch (e) {
      shotErrors.push(`${name}: ${e.message.split('\n')[0]}`);
      console.log(`    SHOT FAILED ${name}: ${e.message.split('\n')[0]}`);
    }
    audits.push({ name, view, shells, tod, run: RUN, runLen: +run.len.toFixed(1),
      runShells: run.shells, placed, cam: seen.cam, stand: V,
      cloudsFrozen: !!froze, drawn: seen.drawn,
      inRun: seen.inRun, pageErrors: errors.slice() });
    fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(audits[audits.length - 1], null, 1));
  }
  }
  if (errors.length) console.log(`    PAGE ERRORS: ${errors.slice(0, 3).join(' | ')}`);
  await page.close();
}
await browser.close();

// PROVE THE ARMS DIFFER. CLAUDE.md: without this the capture runs perfectly, the
// numbers come out beautifully consistent, and the conclusion is that the lever
// does nothing -- the failure proveArmsDiffer exists for.
if (!SMOKE && !has('list') && audits.length >= 2) {
  const byArm = new Map();
  for (const a of audits) {
    byArm.set(`${a.shells}|${a.view}|${a.tod}`, a.inRun.map((c) => c.shell ?? 'x').join(','));
  }
  for (const view of VIEWS) for (const tod of TIMES) {
    const a = byArm.get(`${ARMS[0]}|${view}|${tod}`), b = byArm.get(`${ARMS[ARMS.length - 1]}|${view}|${tod}`);
    if (!a || !b) continue;
    console.log(`\n${view}/${tod}: shells=${ARMS[0]}  [${a}]\n${' '.repeat(view.length + tod.length + 1)}  shells=${ARMS[ARMS.length - 1]}  [${b}]`);
    if (a === b) {
      console.error('ABORT: both arms assigned the same shell to every car; nothing is being compared.');
      process.exitCode = 2;
    }
  }
  // And the thing that makes it a REGISTERED pair: same cars, same places.
  for (const view of VIEWS) for (const tod of TIMES) {
    const A = audits.find((x) => x.shells === ARMS[0] && x.view === view && x.tod === tod);
    const B = audits.find((x) => x.shells === ARMS[ARMS.length - 1] && x.view === view && x.tod === tod);
    if (!A || !B) continue;
    let worst = 0, n = 0;
    for (let i = 0; i < Math.min(A.inRun.length, B.inRun.length); i++) {
      if (A.inRun[i].missing || B.inRun[i].missing) continue;
      worst = Math.max(worst, Math.hypot(A.inRun[i].x - B.inRun[i].x, A.inRun[i].z - B.inRun[i].z));
      n++;
    }
    console.log(`  registered (${view}/${tod}): ${n} cars in both arms, worst position difference ${worst.toFixed(4)} m`);
  }
}
if (shotErrors.length) console.log(`\nFRAMES LOST: ${shotErrors.length}\n  ${shotErrors.join('\n  ')}`);
console.log(`\nPARK-SHOTS: ${audits.length} frames` + (shotErrors.length ? `, ${shotErrors.length} LOST` : ''));
