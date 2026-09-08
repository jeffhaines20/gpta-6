// Car legibility probe: are the wheels, the paint and the panel work of a
// PARKED car actually readable, and by how much did a change move that?
//
// Why this exists. Two blind rounds independently reported the cars as "wheels
// are featureless black discs with a baked vertical body gradient", and the
// cars had never had a measurement pass. Judging a car by eye off a hero frame
// is exactly the failure mode CLAUDE.md warns about: the subject drifts. At the
// corridor camera the pool re-seeds around the player, so "the nearest parked
// car" is not the same car twice, and every absolute number moves with it.
//
// So the subject is PINNED by its parking slot in world coordinates
// (--slot X,Z), the way ao-sweep's --slot pins its pavement. A run meant to be
// compared with an earlier one MUST pass the earlier run's slot; the tool prints
// the slot it chose so the next run can pin it.
//
// Every rectangle sampled is PROJECTED from the car's own geometry through the
// live camera, not drawn on the image by eye. The wheel disc is the projection
// of (axle centre, wheelR); the flank quad is the projection of a rectangle on
// the door skin. That is what makes "the rim is 1.02x the tyre" a statement
// about the rim rather than about whatever was at those pixels.
//
// The metrics, all ratios INSIDE one frame so they survive an exposure change
// between builds (CLAUDE.md: a raw level is not comparable across builds, and
// this project's exposure spans 1/78000 to 1/1.15):
//
//   rimTyre   median luma inside r < 0.55 R  /  median luma in 0.80..1.00 R.
//             "Is there a rim inside that tyre." A featureless black disc is
//             1.0. A real alloy against a black tyre is 2 and up.
//   rimCoV    std/mean of luma inside r < 0.75 R. "Is there structure in it" -
//             spokes, a hub, a lip. A flat disc is ~0 whatever its brightness,
//             which is why rimTyre alone is not enough: a uniformly BRIGHT disc
//             would score well on rimTyre and still read as a sticker.
//   deckSpec  the same ratio on the BOOT DECK. Added after the arm sweep showed
//             `spec` on the flank could not be moved by paint roughness or paint
//             metalness at all - at noon the sun's lobe lands on surfaces facing
//             UP, so a vertical door skin is the wrong place to ask whether the
//             paint has a specular response.
//   spec      p98 / median luma over the flank quad. A matte body is ~1.2; a
//             clearcoat with a sun glint in it runs well above that.
//             LIMIT, measured in the self-test: a highlight covering under ~2%
//             of the quad does not move p98 at all - a 1.87% glint reads exactly
//             1.000. Do not quote spec for a small, tight highlight; it can only
//             see one that is broad enough to reach the top 2% of the samples.
//   vGrad     median luma of the flank quad's top third / its bottom third.
//             This is the "baked vertical gradient" complaint as a number.
//             It is NOT meant to reach 1.0 - a real car IS darker at the rocker
//             than at the shoulder - it is meant to stop being a black fade.
//   edges     mean |Laplacian| over the car's projected box / mean luma there.
//             Panel lines, shuts, lamp divisions and arch lips all raise it.
//             Exposure-invariant by the division; scale-dependent, so it is only
//             comparable between runs at the SAME distance and framing.
//
// Usage:
//   node tools/car-probe.mjs --selftest
//   CAR_TAG=before node tools/car-probe.mjs
//   CAR_TAG=after  node tools/car-probe.mjs --slot 118.4,-159.2
//   node tools/car-probe.mjs --report before after
//
// Env:
//   CAR_TAG    capture prefix (default 'car')
//   CAR_TIMES  times of day (default 'noon,night')
//   CAR_PORT   http port. NOT 8123 - that belongs to the main tree, and a
//              worktree that reuses it photographs the wrong build.
//   CAR_WHEEL_PX  on-screen wheel DIAMETER to frame the car at (default 38, which
//              is what a parked car's wheel measures in the corridor hero frame).
//              The stand-off is bisected to hit it, because `edges` and `rimCoV`
//              are per-pixel statistics and two runs at different apparent sizes
//              are not comparable. Diameter, not car length: a kerbside car is
//              seen almost end-on from the carriageway, so its length is the one
//              dimension perspective destroys.
//   CAR_DIST   unused once CAR_WHEEL_PX solves the stand-off; kept as the seed
//   CAR_ARMS   comma-separated palette arms, captured in ONE session off ONE
//              build. An arm is `surface:roughness/metalness`, several joined
//              with '+', e.g. 'base,paint:0.18/0.35,paint:0.18/0.35+glass:0.05/0'.
//              The palette is a shared 16x1 DataTexture whose green byte is
//              roughness and blue byte metalness, so an arm is four bytes and
//              needs no rebuild. This is the same argument as HERO_ARMS: an A/B
//              shot by editing src/ between two runs only measures that edit if
//              nothing else in the tree moved in between, and it lets one term
//              be isolated at a time, which CLAUDE.md records a round getting
//              wrong by reverting the lever that was carrying 1% of the move.
import fs from 'node:fs';
import { readPNG } from './png.mjs';
import { createHash } from 'node:crypto';

const OUT = 'docs/probe';
const ARGS = process.argv.slice(2);
const argOf = (name) => { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : null; };

// The metrics live in tools/car-metrics.mjs so they can be imported without
// starting a browser - see the note at the top of that file. Re-exported here
// because callers and older notes refer to them by this module's name.
import {
  sampler, median, pct, mean, stdev, LIN,
  wheelMetrics, flankMetrics, edgeMetrics, hubMetrics, noseMetrics, overlay, selftest,
} from './car-metrics.mjs';

export { wheelMetrics, flankMetrics, edgeMetrics, hubMetrics, noseMetrics, overlay };

if (ARGS.includes('--selftest')) process.exit(selftest() ? 0 : 1);

// ------------------------------------------------------------------ report
function loadRun(tag) {
  const f = `${OUT}/${tag}.json`;
  if (!fs.existsSync(f)) throw new Error(`no such run: ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

if (ARGS.includes('--report')) {
  const i = ARGS.indexOf('--report');
  const a = loadRun(ARGS[i + 1]), b = loadRun(ARGS[i + 2]);
  if (a.slot !== b.slot) {
    console.log(`WARNING: different subjects - ${a.slot} vs ${b.slot}. `
      + 'Every absolute number below is of a different car; do not compare them.');
  }
  console.log(`subject slot ${a.slot}   camera ${a.dist} m   car ${a.carPx} px long on screen\n`);
  const head = 'tod      metric      before     after     change';
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const tod of Object.keys(a.tod)) {
    if (!b.tod[tod]) continue;
    const A = a.tod[tod], B = b.tod[tod];
    const row = (name, x, y, unit = '') => {
      if (x == null || y == null) return;
      const d = y - x;
      console.log(`${tod.padEnd(8)} ${name.padEnd(11)} ${String(x).padStart(8)}  `
        + `${String(y).padStart(8)}  ${(d >= 0 ? '+' : '') + d.toFixed(3)}${unit}`);
    };
    row('rimTyre F', A.wheelFront.rimTyre, B.wheelFront.rimTyre);
    row('rimCoV F', A.wheelFront.rimCoV, B.wheelFront.rimCoV);
    row('rimTyre R', A.wheelRear.rimTyre, B.wheelRear.rimTyre);
    row('rimCoV R', A.wheelRear.rimCoV, B.wheelRear.rimCoV);
    row('hubPeak F', A.hubFront && A.hubFront.hubPeak, B.hubFront && B.hubFront.hubPeak);
    row('hubFrac F', A.hubFront && A.hubFront.hubFrac, B.hubFront && B.hubFront.hubFrac);
    row('hubPeak R', A.hubRear && A.hubRear.hubPeak, B.hubRear && B.hubRear.hubPeak);
    row('hubFrac R', A.hubRear && A.hubRear.hubFrac, B.hubRear && B.hubRear.hubFrac);
    row('spec', A.flank.spec, B.flank.spec);
    row('deckSpec', A.deck && A.deck.spec, B.deck && B.deck.spec);
    row('vGrad', A.flank.vGrad, B.flank.vGrad);
    row('edges', A.edge.edges, B.edge.edges);
    console.log('');
  }
  process.exit(0);
}

// ------------------------------------------------------------------ capture
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const TAG = process.env.CAR_TAG ?? 'car';
const TIMES = (process.env.CAR_TIMES ?? 'noon,night').split(',');
const PORT = Number(process.env.CAR_PORT ?? 8161);
const DIST = Number(process.env.CAR_DIST ?? 7);
const TARGET_WHEEL_PX = Number(process.env.CAR_WHEEL_PX ?? 38);
const SLOT = argOf('--slot');
fs.mkdirSync(OUT, { recursive: true });

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 240000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

// Anchor on the Main Street east leg, the same carriageway the corridor hero
// stands on, so the subject is a car a reviewer of that frame could actually see.
const setup = await page.evaluate(async (cfg) => {
  const D = window.__district;
  const r = D.district.meta.route;
  const a = r[3], b = r[4];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ax = a.x + ((b.x - a.x) / len) * 55, az = a.z + ((b.z - a.z) / len) * 55;
  D.placeAt(ax, az);
  D.setAutopilot(() => {});
  for (let i = 0; i < 900; i++) D.world.update(D.vehicle.position);
  D.furniture.refreshParked(ax, az, true);

  const mesh = D.furniture.parked.mesh;
  const V3 = D.camera.position.constructor;
  const m = new (D.camera.matrixWorld.constructor)();
  // Every placed instance, with its world position and yaw read back off the
  // matrix rather than out of the placement code - the pool hides unused slots
  // by scaling them to zero, and a zero-scale matrix must not become a subject.
  const cars = [];
  for (let i = 0; i < D.furniture.parked.count; i++) {
    mesh.getMatrixAt(i, m);
    const e = m.elements;
    const sx = Math.hypot(e[0], e[1], e[2]);
    if (sx < 0.5) continue;
    cars.push({ i, x: e[12], y: e[13], z: e[14], yaw: Math.atan2(e[8] / sx, e[10] / sx) });
  }
  if (!cars.length) return { error: 'no parked cars placed' };

  let pick;
  if (cfg.slot) {
    const [sx2, sz2] = cfg.slot.split(',').map(Number);
    pick = cars.reduce((best, c) =>
      ((c.x - sx2) ** 2 + (c.z - sz2) ** 2 < (best.x - sx2) ** 2 + (best.z - sz2) ** 2 ? c : best));
  } else {
    // No slot given: the car nearest the anchor, which is the one a reviewer's
    // eye lands on in the corridor frame. Its slot is printed so the next run
    // can pin it - see the ao-sweep note in CLAUDE.md.
    pick = cars.reduce((best, c) =>
      ((c.x - ax) ** 2 + (c.z - az) ** 2 < (best.x - ax) ** 2 + (best.z - az) ** 2 ? c : best));
  }

  // Stand off the car's tail quarter, on whichever side is nearer the road
  // centreline - parked cars sit at the kerb and the other side is pavement.
  const cs = Math.cos(pick.yaw), sn = Math.sin(pick.yaw);
  const local = (lx, ly, lz) => [pick.x + lx * cs + lz * sn, pick.y + ly, pick.z - lx * sn + lz * cs];
  const roadT = Math.max(0, Math.min(1,
    ((pick.x - a.x) * (b.x - a.x) + (pick.z - a.z) * (b.z - a.z)) / (len * len)));
  const rx = a.x + (b.x - a.x) * roadT, rz = a.z + (b.z - a.z) * roadT;
  const side = (() => {
    const p = local(1, 0, 0);
    return Math.hypot(p[0] - rx, p[2] - rz) < Math.hypot(pick.x - rx, pick.z - rz) ? 1 : -1;
  })();
  // Down the lane, not out into the shopfronts. The lateral stand-off is FIXED
  // at roughly one lane; only the along-street distance varies. Scaling the
  // lateral offset with the distance (the first cut did) walks the camera 28 m
  // sideways at street range, which is inside the buildings - and a camera
  // inside a wall manufactures exactly the defect class it is used to look for,
  // which hero-shots records costing three rounds of blind critique.
  //
  // Project the geometry the metrics need. Local Y of the wheel centre is
  // groundY + wheelR: buildTrafficCarGeometry translates the body so the tyres
  // rest on groundY, and the axle sits one wheel radius above that.
  const GROUND_Y = -0.05 - 0.02;         // PAD_Y - 0.02, streetfurniture.js
  const WHEEL_R = 0.36, F_AXLE = 1.32, R_AXLE = -1.30;
  // buildTrafficCarGeometry ends with translate(0, groundY - CAR.ground, 0), so
  // every y AUTHORED in carbody.js sits Y0 higher in the instance's frame. The
  // first cut of this tool skipped that for the body points and only got the
  // wheels right by accident (GROUND_Y + WHEEL_R happens to be the same sum), so
  // the sampled panel projected 0.65 m low - onto the ROAD under the bumper -
  // and the metric returned a perfectly reasonable-looking gradient for it. The
  // --overlay pass is what caught it; nothing in the numbers looked wrong.
  const CAR_GROUND = -0.717;
  const Y0 = GROUND_Y - CAR_GROUND;
  const bodyPt = (lx, ly, lz) => [lx, Y0 + ly, lz];
  // Vector3.project() reads camera.matrixWorldInverse, and THAT IS ONLY
  // REFRESHED INSIDE renderer.render(). The first cut of the solve below moved
  // the camera 40 times without rendering and projected through the stale
  // placeAt() view every single time, so it "converged" to the midpoint of its
  // own bracket and framed the car at 2.4 px while reporting it had solved for
  // 200. Refresh the inverse by hand after every camera move.
  const refresh = () => {
    D.camera.updateMatrixWorld(true);
    D.camera.matrixWorldInverse.copy(D.camera.matrixWorld).invert();
  };
  const project = (lx, ly, lz) => {
    const w = new V3(...local(lx, ly, lz));
    w.project(D.camera);
    return [(w.x * 0.5 + 0.5) * innerWidth, (-w.y * 0.5 + 0.5) * innerHeight];
  };
  const lengthPx = () => {
    const n = project(0, 0.2, 2.24), t = project(0, 0.2, -2.24);
    return Math.hypot(n[0] - t[0], n[1] - t[1]);
  };
  // FRAME THE SUBJECT TO A FIXED WHEEL SIZE, not to a fixed distance, and not to
  // a fixed car LENGTH either.
  //
  // Two mistakes are buried here, both worth keeping. The first cut solved for
  // nose-to-tail pixels; but a kerbside car photographed from the carriageway is
  // seen almost end-on, so its length is the one dimension perspective destroys -
  // solving for 200 px of it put the camera 8.8 m away with a 114 px wheel, a
  // close-up dressed up as a street view. A wheel's DIAMETER is vertical, so it
  // is not foreshortened by the axial view and is the honest handle on apparent
  // size. It is also the thing the wheel metrics have to resolve.
  //
  // The second is that there is no 3/4 view of a parked car to be had here at
  // range. At a 38 degree quarter angle a 38 px wheel needs a 17.8 m stand-off
  // and 11 m of lateral offset, which is inside the shopfronts. The street's own
  // geometry forces the near-axial view, and the corridor hero frame is that
  // view - so the camera takes one lane of lateral offset and lives with it.
  // That is also WHY the panel sampled below is the tail and not the door skin.
  const LAT = 5.0;                       // kerb to mid-carriageway, in metres
  let lo = 4, hi = 200, dist = cfg.dist;
  const eyeAt = (d) => local(side * LAT, 1.5, -d);
  const tgt = local(0, 0.55, -1.4);
  const wheelPx = () => {
    const c = project(side * 0.79, GROUND_Y + WHEEL_R, R_AXLE);
    const t = project(side * 0.79, GROUND_Y + WHEEL_R * 2, R_AXLE);
    return 2 * Math.hypot(t[0] - c[0], t[1] - c[1]);
  };
  for (let it = 0; it < 44; it++) {
    dist = (lo + hi) / 2;
    D.freeCam(eyeAt(dist), tgt, 45);
    refresh();
    if (wheelPx() > cfg.wheelPx) lo = dist; else hi = dist;
  }
  const eye = eyeAt(dist);
  D.freeCam(eye, tgt, 45);
  refresh();
  for (let i = 0; i < 60; i++) D.world.update(D.vehicle.position);
  // A wheel's on-screen radius: project the axle and a point one radius above it.
  // The wheel disc lies in the plane spanned by the car's local Y and Z (its
  // spin axis is local X), so its projection is the ellipse with semi-axes
  // `up` and `fore`. Both are needed - see wheelMetrics.
  const wheelDisc = (lz) => {
    const c = project(side * 0.79, GROUND_Y + WHEEL_R, lz);
    const t = project(side * 0.79, GROUND_Y + WHEEL_R * 2, lz);
    const f = project(side * 0.79, GROUND_Y + WHEEL_R, lz + WHEEL_R);
    return { cx: c[0], cy: c[1],
      r: Math.hypot(t[0] - c[0], t[1] - c[1]),
      up: [t[0] - c[0], t[1] - c[1]], fore: [f[0] - c[0], f[1] - c[1]] };
  };
  // The sampled panel is the TAIL, from just under the boot lip down to just
  // above the plate recess, inset from both rear corners. That is where the
  // complaint actually lives - "pale at the shoulder, near-black along the
  // bottom third" is visibly true of the tail panel in the corridor hero frame -
  // and unlike the door skin it faces the camera in the only view this street
  // geometry allows. Kept clear of the tail lamps in u so the lamp division work
  // cannot flatter the paint numbers.
  // The sampled panel is the DOOR SKIN on the visible flank, shoulder down to
  // rocker, between the two wheel arches (the rear arch reaches z = -0.855 and
  // the front one z = 0.875, so -0.80..0.05 is clear of both). That is where the
  // complaint lives - "pale at the shoulder, near-black along the bottom third" -
  // and it is deliberately clear of the tail lamps, so the lamp work cannot
  // flatter the paint numbers.
  const px94 = (ly, lz) => project(...bodyPt(side * 0.94, ly, lz));
  const flank = [
    px94(0.28, 0.60), px94(0.28, -0.82), px94(-0.46, -0.82), px94(-0.46, 0.60),
  ];
  // A SECOND panel, on the boot deck, and it exists because of a limit the arm
  // sweep exposed. `spec` on the flank did not move when paint roughness was
  // halved or paint metalness cut to a fifth - and it could not have, because at
  // noon the sun's specular lobe lands on the surfaces facing UP, not on a
  // vertical door skin. Measuring "the paint has no specular response" on the
  // flank alone answers a question the geometry never asked. The boot deck faces
  // the sky and faces the corridor hero camera square on, so it is where a
  // clearcoat glint would actually appear if there were one.
  const deck = [
    project(...bodyPt(-0.60, 0.300, -1.80)), project(...bodyPt(0.60, 0.300, -1.80)),
    project(...bodyPt(0.60, 0.300, -2.10)), project(...bodyPt(-0.60, 0.300, -2.10)),
  ];
  // The whole-car box, for the edge density.
  const corners = [];
  for (const lx of [-0.98, 0.98]) for (const ly of [CAR_GROUND, 0.72]) for (const lz of [-2.3, 2.3]) {
    corners.push(project(...bodyPt(lx, ly, lz)));
  }
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const nose = project(...bodyPt(0, 0.2, 2.24)), tail = project(...bodyPt(0, 0.2, -2.24));

  return {
    slot: `${pick.x.toFixed(1)},${pick.z.toFixed(1)}`,
    yaw: +pick.yaw.toFixed(3), side,
    dist: +dist.toFixed(1),
    deck,
    eye: eye.map((v) => +v.toFixed(2)),
    wheelFront: wheelDisc(F_AXLE), wheelRear: wheelDisc(R_AXLE),
    flank,
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    carPx: +Math.hypot(nose[0] - tail[0], nose[1] - tail[1]).toFixed(1),
  };
}, { slot: SLOT, dist: DIST, wheelPx: TARGET_WHEEL_PX });

if (setup.error) { console.error(setup.error); await browser.close(); process.exit(2); }
console.log(`subject slot ${setup.slot}  (pin the next run with --slot ${setup.slot})`);
console.log(`camera ${setup.dist} m down the lane, solved for a ${TARGET_WHEEL_PX} px wheel `
  + `(what the corridor hero frame shows); car ${setup.carPx} px nose-to-tail on screen`);
console.log(`front wheel ${(2 * setup.wheelFront.r).toFixed(1)} px tall, `
  + `rear ${(2 * setup.wheelRear.r).toFixed(1)} px tall x `
  + `${(2 * Math.hypot(...setup.wheelRear.fore)).toFixed(1)} px wide`);
if (setup.wheelRear.r < 4) {
  console.log('NOTE: a wheel under 8 px across cannot resolve a rim; treat rimCoV as indicative only.');
}
// AND A STRONGER WARNING THAN THAT ONE, measured in the round-2 car pass. This
// tool frames the car from its TAIL QUARTER, one lane out, which is the honest
// street view and is why the flank quad it samples is worth having. But it makes
// the wheel 38 px tall and EIGHT PIXELS WIDE, and at that width the d >= 0.80
// annulus wheelMetrics calls "tyre" is mostly road and arch. On one unchanged
// frame that gave rimTyre 1.016 / hubFrac 0% on the front wheel and 4.354 / 92.8%
// on the rear - the same geometry, the same material, the same light, a factor of
// four apart. Neither number is about the rim.
//
// The wheel numbers both round-1 blind reviews quoted, and the real-photograph
// baselines attached to them, come from the CORRIDOR HERO FRAME instead, where
// the same cars are seen at a quarter angle 34x24 px and 62x52 px.
// tools/car-frames.mjs measures there. Use this tool for the flank, the deck and
// the edge density; use that one for wheels.
console.log('NOTE: this framing is near-axial - see the comment above on why its '
  + 'wheel numbers are not the ones to judge a rim by. tools/car-frames.mjs is.');

// The shared 16x1 palette, found by identity (a 16-wide roughnessMap on a car
// material) rather than by guessing at scene order. It is a singleton in
// carbody.js, so poking it moves the player car, traffic and the parked pool at
// once - which is the point.
const SURF = { paint: 0, trim: 1, chrome: 2, grille: 3, headlight: 4, taillight: 5,
  indicator: 6, plate: 7, tyre: 8, rim: 9, glassy: 10, matte: 11,
  meshCoarse: 12, rimCoarse: 13 };
const ARMS = (process.env.CAR_ARMS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
if (ARMS.length) {
  // FIND THE PALETTE THROUGH THE CAR, NOT BY TRAVERSING THE SCENE.
  //
  // The first cut looked for "any material with a 16-wide roughnessMap" and
  // found one - some other atlas that happens to be 16 texels across, whose
  // slot 0 reads roughness 237 / metalness 5 where carbody.js's PALETTE[0] is
  // 66 / 153. Every arm then poked a texture no car was reading, and the sweep
  // came back with SEVEN ARMS OF BYTE-IDENTICAL NUMBERS. That is the shape
  // blind-compare refuses to ship - two arms of the same build is a failure that
  // looks like data - and the only reason it was caught at all is that the
  // metrics were identical to four decimals rather than merely close.
  //
  // So: go through the parked pool's own material, and CHECK the bytes against
  // what carbody.js authors before believing it.
  const found = await page.evaluate((want) => {
    const m = __district.furniture.parked && __district.furniture.parked.mesh.material;
    const tex = m && m.roughnessMap;
    if (!tex || !tex.image || tex.image.width !== 16) {
      return { error: 'no 16x1 palette on the parked car material' };
    }
    const d = tex.image.data;
    if (Math.abs(d[1] - want.r) > 2 || Math.abs(d[2] - want.m) > 2) {
      return { error: `palette slot 0 reads r=${d[1]} m=${d[2]}, expected r=${want.r} m=${want.m}` };
    }
    window.__palTex = tex;
    window.__palBase = Uint8Array.from(d);
    return { r: d[1], m: d[2] };
  }, { r: Math.round(0.26 * 255), m: Math.round(0.60 * 255) });
  if (found.error) {
    console.error(`ABORT: ${found.error} - the arms would measure nothing.`);
    await browser.close();
    process.exit(2);
  }
  console.log(`palette confirmed on the parked car material: paint r=${found.r} m=${found.m}`);
}

const run = { tag: TAG, slot: setup.slot, dist: setup.dist, targetWheelPx: TARGET_WHEEL_PX, carPx: setup.carPx, arms: ARMS, tod: {} };
const seen = new Map();
for (const tod of TIMES) {
  seen.clear();
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 6, f0, { timeout: 180000, polling: 200 });

  for (const arm of (ARMS.length ? ARMS : [null])) {
    if (arm) {
      const applied = await page.evaluate((spec) => {
        const t = window.__palTex, d = t.image.data;
        d.set(window.__palBase);                       // every arm starts from the build's own palette
        const SU = { paint: 0, trim: 1, chrome: 2, grille: 3, headlight: 4, taillight: 5,
          indicator: 6, plate: 7, tyre: 8, rim: 9, glassy: 10, matte: 11,
          meshCoarse: 12, rimCoarse: 13 };
        const out = [];
        if (spec !== 'base') {
          for (const part of spec.split('+')) {
            const [name, rm] = part.split(':');
            const [r, m] = rm.split('/').map(Number);
            const i = SU[name];
            d[i * 4 + 1] = Math.round(r * 255);
            d[i * 4 + 2] = Math.round(m * 255);
            out.push(`${name} r=${d[i * 4 + 1]} m=${d[i * 4 + 2]}`);
          }
        }
        t.needsUpdate = true;
        return out.join(', ') || 'build default';
      }, arm);
      // Rendered FRAMES, never milliseconds: on the software rasteriser a short
      // wait can be less than one frame and the screenshot then belongs to the
      // previous arm. hero-shots learned this the same way.
      const fa = await page.evaluate(() => __district.frames);
      await page.waitForFunction((f) => __district.frames > f + 4, fa, { timeout: 180000, polling: 200 });
      console.log(`  arm ${arm}: ${applied}`);
    }
    const key = arm ? `${tod}/${arm}` : tod;
    const file = `${OUT}/${TAG}-${tod}${arm ? `-${arm.replace(/[^a-z0-9]/gi, '_')}` : ''}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    // Proof the arm reached the frame. Two arms rendering pixel-identical means
    // the poke went somewhere nothing reads, which is how the first sweep
    // produced seven arms of one build and looked like a result.
    const digest = createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    if (arm && seen.has(digest)) {
      console.error(`ABORT: arm ${arm} rendered pixel-identical to ${seen.get(digest)}. `
        + 'The palette poke is not reaching the frame; nothing here would be measured.');
      await browser.close();
      process.exit(2);
    }
    if (arm) seen.set(digest, arm);
    const png = readPNG(file);
    const rec = {
      file,
      wheelFront: wheelMetrics(png, setup.wheelFront.cx, setup.wheelFront.cy,
        setup.wheelFront.up, setup.wheelFront.fore),
      wheelRear: wheelMetrics(png, setup.wheelRear.cx, setup.wheelRear.cy,
        setup.wheelRear.up, setup.wheelRear.fore),
      // hubPeak/hubFrac beside rimTyre, never instead of it. rimTyre averages
      // "a bright face over most of the core" and "a dark face with one hot dot"
      // into the same number, and round 1 shipped the second believing it had
      // built the first. These are the only wheel numbers here with real
      // photograph baselines: Mustang 1.67 / 28.6%, parked SUV 1.60 / 7.9%.
      hubFront: hubMetrics(png, setup.wheelFront.cx, setup.wheelFront.cy,
        setup.wheelFront.up, setup.wheelFront.fore),
      hubRear: hubMetrics(png, setup.wheelRear.cx, setup.wheelRear.cy,
        setup.wheelRear.up, setup.wheelRear.fore),
      flank: flankMetrics(png, setup.flank),
      deck: flankMetrics(png, setup.deck),
      edge: edgeMetrics(png, setup.box),
    };
    if (ARGS.includes('--overlay')) {
      overlay(png, setup, file.replace(/\.png$/, '-overlay.png'));
    }
    run.tod[key] = rec;
    console.log(`${key.padEnd(30)} rimTyre F ${String(rec.wheelFront.rimTyre).padStart(6)} `
      + `R ${String(rec.wheelRear.rimTyre).padStart(6)}   `
      + `rimCoV F ${String(rec.wheelFront.rimCoV).padStart(5)} R ${String(rec.wheelRear.rimCoV).padStart(5)}   `
      + `spec ${String(rec.flank.spec).padStart(5)}  vGrad ${String(rec.flank.vGrad).padStart(6)}  `
      + `deckSpec ${String(rec.deck.spec).padStart(5)}  edges ${String(rec.edge.edges).padStart(6)}`);
    console.log(`${''.padEnd(30)} hubPeak F ${String(rec.hubFront.hubPeak).padStart(6)} `
      + `R ${String(rec.hubRear.hubPeak).padStart(6)}   `
      + `hubFrac F ${String(rec.hubFront.hubFrac).padStart(5)} R ${String(rec.hubRear.hubFrac).padStart(5)}   `
      + `[photo target: peak 1.5-2.3, frac ~8%, rimTyre ~1.0]`);
  }
}
if (ARMS.length) await page.evaluate(() => { window.__palTex.image.data.set(window.__palBase); window.__palTex.needsUpdate = true; });

fs.writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify({ ...run, setup, errors }, null, 2));
console.log(`\nwrote ${OUT}/${TAG}.json`);
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
