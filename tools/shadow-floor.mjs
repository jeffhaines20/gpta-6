// THE SUN'S SHADOW REACHES UNDER A CAR AT EVERY HOUR — BACKLOG #141's gate.
//
//   node tools/shadow-floor.mjs              the gate, offline, in about a tenth of a second
//   node tools/shadow-floor.mjs --selftest   the checks against the bias this replaced
//
// three's PCF pass draws a FrontSide material's BACK faces into the sun's map, so over a car what the
// map holds is its FLOOR, and a receiver is unshadowed by anything nearer to it than the light's
// depth tolerance. For a horizontal receiver under a horizontal occluder that tolerance, measured
// VERTICALLY, is
//
//     bias_m * sin(elevation) + normalBias          bias_m = -shadow.bias * (far - near)
//
// and the shipped -0.0006 over near 1 / far 900 is 0.54 m along the ray at every hour: 0.58 m of
// vertical tolerance at noon, against a floor pan 0.19 m up. The road under every car was sunlit
// at noon and at night, which #138's blind reviewer saw as "the cars look lifted".
//
// This gate drives the REAL TimeOfDay through every preset — the setting is read after apply(), the
// way the page reads it — and builds every car body the game builds, reading the floor off the
// buffer rather than off CAR.sill, so a change to the body or to the light moves the reading.
//
//   contact   at every preset the vertical tolerance is under every car's floor pan, by a margin
//   floor     the floor pan exists on every shell: a check against a subject that is not there
//             passes for the most flattering reason (CLAUDE.md, "a negative needs its positive")
//   acne      the other side of the trade, from the map's own texel: a receiver tilted theta from
//             the light sees its own back face's depth change by texel * tan(theta) a texel, and the
//             bias covers bias_m + normalBias / cos(theta) of it. Asserted for every theta the sun
//             lights at a quarter of its beam or more (cos theta >= 0.25), which is where acne can
//             be SEEN: past that the sun is a small share of the pixel whatever the shadow does.
//             HALF a texel (ACNE_TEXELS), and that is measured, not modelled: the thin-plane
//             textbook asks for a whole one, normalBias 0.113, and over-prices it here, because three
//             puts a closed caster's BACK faces in the map and a back face is a body's thickness
//             behind the face it could shadow. tools/shadow-bias.mjs at fivepoints noon, bias 0,
//             surfaces lit in a 6x finer reference map that a 2048 map darkens past half:
//                 normalBias       0      0.03    0.06    0.09    0.12
//                 street furniture 4028   445     183     128     94   px of 22031
//             and the road under a car leaks back from 0.12 (below). 0.03 fails this check, 0.06
//             clears it by 1.3 cm at 75.5 degrees.
//   strip     the lit strip a constant bias leaves along the foot of every wall in shadow,
//             bias_m * cos(elevation) — 0.53 m at golden hour under the shipped constant.
//
// AND AT NIGHT, the lamps: PointLights with no shadow map, so the sun's bias cannot help, and
// src/carcontact.js lays a footprint under every car that multiplies what is under the body. Its
// half of the gate, off the same buffers:
//
//   inside    every point of the footprint that darkens by 10% or more lies inside the body's own
//             sill outline (per 5 cm slice, off the vertices 0.17-0.32 m up): it darkens the road
//             UNDER a car and never the road beside one
//   covers    and it covers the floor pan: three quarters of the pan between the axles at half
//             strength or more
//   derived   the profile is the gap under the sill: the core is no brighter than the sky one side
//             of the pan lets in at the ramp's inner edge, sin^2(atan(floor / ramp)), and the ramp
//             reaches a lamp 25 degrees up, floor / tan(25)
//   placed    the module puts one footprint per live car, 3-8 cm over that car's OWN contact patch
//             (a parked car's lane is 3 cm above its tyres' patch, a fleet car's road 2 cm), skips a
//             hidden pool slot, draws nothing until the lamps are lit, casts nothing, writes no
//             depth, and buckets as its own row rather than as x2.00 vehicles
import * as THREE from '../vendor/three.module.min.js';
import { PRESETS } from '../src/daynight.js';
import { buildTrafficCarGeometry, buildPlayerCar, SHAPES, CAR } from '../src/carbody.js';
import { CarContact, CONTACT, planOf, planFromCar } from '../src/carcontact.js';
import { bucketOf } from './tri-buckets.mjs';
import { makeTod } from './shadow-stable.mjs';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/shadow-floor.mjs [--selftest]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty (CLAUDE.md, car-pixel). */
export const CHECK_COUNT = 11;
/** The sun's share of its own beam below which a receiver's acne is not visible: cos(theta) = 0.25. */
export const ACNE_COS = 0.25;
/**
 * The contact tolerance must be under this fraction of the floor pan's LOWEST point. Measured, not
 * picked: the sun reaching the road under the red car at fivepoints noon, against a 6x finer
 * reference that reads 0.000, as the vertical tolerance grows (bias 0, normalBias swept):
 *     tolerance   0.03-0.09   0.12    0.15
 *     player      0.001       0.019   0.262       parked coupe 0.04 / 0.088 / 0.354 (ref 0.051)
 * The PCF tent reaches the floor's edge across a texel and a half, so the shadow under a 0.186 m
 * floor starts going at 0.12 and is a quarter gone at 0.15: half the floor is the line.
 */
export const CONTACT_FRACTION = 0.5;
/** Texels of depth slope the bias has to cover where the sun is a quarter of its beam. See the header. */
export const ACNE_TEXELS = 0.5;

/**
 * The floor pan of a car body, off the buffer: the area-weighted height above the contact patch of
 * the DOWNWARD-facing triangles between the axles and inboard of the wheels. Those are what the PCF
 * pass puts in the sun's map over the road under the car.
 */
export function floorPan(geometry, contactY) {
  const pos = geometry.getAttribute('position'), idx = geometry.getIndex();
  const n = idx ? idx.count / 3 : pos.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3();
  let area = 0, sum = 0, lo = Infinity, hi = -Infinity;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(3 * t) : 3 * t, i1 = idx ? idx.getX(3 * t + 1) : 3 * t + 1, i2 = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    e1.subVectors(b, a); e2.subVectors(c, a); nn.crossVectors(e1, e2);
    const ar = nn.length() / 2;
    if (!(ar > 1e-9)) continue;
    nn.multiplyScalar(1 / (2 * ar));
    const cx = (a.x + b.x + c.x) / 3, cz = (a.z + b.z + c.z) / 3;
    if (nn.y > -0.9 || Math.abs(cz) > CAR.frontAxleZ - CAR.wheelR - 0.05 || Math.abs(cx) > CAR.hw - 0.15) continue;
    const h = (a.y + b.y + c.y) / 3 - contactY;
    area += ar; sum += ar * h; lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { area, height: area > 0 ? sum / area : null, lo: area > 0 ? lo : null, hi: area > 0 ? hi : null };
}

/** Every body the game builds: the three fleet shells (contact patch at y 0) and the player's car. */
export function carFloors() {
  const out = {};
  for (const s of Object.keys(SHAPES)) out[s] = floorPan(buildTrafficCarGeometry({ groundY: 0, shape: SHAPES[s] }), 0);
  out.player = floorPan(buildPlayerCar().bodyMesh.geometry, CAR.ground);
  return out;
}

/**
 * The body's own plan outline at the sill, off the buffer: per 5 cm slice of z, the widest |x| of the
 * vertices 0.17-0.32 m over the contact patch. The fleet shells carry their tyres, so the arches count
 * as covered where the tyre is; the player's body is CAR's silhouette, the coupe's, without its wheels.
 */
export function sillOutline(geometry, contactY) {
  const p = geometry.getAttribute('position');
  // The silhouette is built in RINGS, so vertices sit at a few dozen z values and a fixed slice
  // grid finds nothing in most slices: the widest |x| per ring, interpolated between rings.
  const rings = new Map();
  for (let i = 0; i < p.count; i++) {
    const h = p.getY(i) - contactY;
    if (h < 0.17 || h > 0.32) continue;
    const k = Math.round(p.getZ(i) * 1000);
    rings.set(k, Math.max(rings.get(k) ?? 0, Math.abs(p.getX(i))));
  }
  // Some rings carry only a centreline detail in the band (|x| 0 at eight z values on the coupe, and
  // the nose tip at 0.15), and the sill runs straight between rings up to 0.64 m apart: so the
  // outline is the SILL rings (|x| >= 0.5), linearly interpolated, and null past the last of them.
  const pts = [...rings.entries()].map(([k, x]) => [k / 1000, x]).filter(([, x]) => x >= 0.5)
    .sort((a, b) => a[0] - b[0]);
  return (z) => {
    if (pts.length < 2 || z < pts[0][0] || z > pts[pts.length - 1][0]) return null;
    let i = 1;
    while (i < pts.length - 1 && pts[i][0] < z) i++;
    const [z0, x0] = pts[i - 1], [z1, x1] = pts[i];
    return z1 > z0 ? x0 + ((x1 - x0) * (z - z0)) / (z1 - z0) : Math.min(x0, x1);
  };
}

/** The footprint's multiplier at a point of its plan, from CONTACT, the profile the geometry draws. */
export function contactMultiplier(plan, x, z, C = CONTACT) {
  const dx = plan.w / 2 - Math.abs(x - plan.cx), dz = plan.l / 2 - Math.abs(z - plan.cz);
  const d = Math.min(dx, dz);
  if (d < 0) return 1;
  const r = Math.min(C.ramp, plan.w / 2 - 0.01, plan.l / 2 - 0.01);
  return 1 - (1 - C.core) * Math.min(1, d / r);
}

/** The footprint against every body, and the module's own behaviour, offline. */
export function measureContact(floors, C = CONTACT, opts = {}) {
  const bodies = {};
  const shells = {};
  for (const s of Object.keys(SHAPES)) shells[s] = buildTrafficCarGeometry({ groundY: 0, shape: SHAPES[s] });
  const coupeOutline = sillOutline(shells.coupe, 0);
  const planFor = opts.planFor ?? ((name, g) => (name === 'player' ? planFromCar() : planOf(g)));
  for (const [name, g, outline] of [
    ...Object.entries(shells).map(([n, g]) => [n, g, sillOutline(g, 0)]),
    ['player', null, coupeOutline],
  ]) {
    const plan = planFor(name, g);
    let dark = 0, outside = 0, worst = -Infinity;
    for (let z = plan.cz - plan.l / 2; z <= plan.cz + plan.l / 2 + 1e-9; z += 0.025) {
      for (let x = plan.cx - plan.w / 2; x <= plan.cx + plan.w / 2 + 1e-9; x += 0.025) {
        if (contactMultiplier(plan, x, z, C) > 0.9) continue;
        dark++;
        const o = outline(z);
        const over = o === null ? Infinity : Math.abs(x) - o;
        if (over > worst) worst = over;
        if (over > 0.03) outside++;
      }
    }
    // Coverage of the floor pan between the axles at half strength or more.
    const fp = floors[name];
    let pan = 0, covered = 0;
    const zA = CAR.frontAxleZ - CAR.wheelR - 0.05, xA = CAR.hw - 0.15;
    for (let z = -zA; z <= zA + 1e-9; z += 0.025) {
      for (let x = -xA; x <= xA + 1e-9; x += 0.025) {
        pan++;
        if (contactMultiplier(plan, x, z, C) <= 0.5 + 1e-9) covered++;
      }
    }
    bodies[name] = { plan, dark, outside, worstOverM: worst, cover: pan ? covered / pan : null, floor: fp ? fp.height : null };
  }
  // The module itself, on a stub scene: two pool cars, one hidden slot, and the player's group.
  const scene = new THREE.Scene();
  const g = shells.coupe;
  const pool = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 3);
  pool.setMatrixAt(0, new THREE.Matrix4().makeRotationY(1.1).setPosition(12, 0, -4));
  pool.setMatrixAt(1, new THREE.Matrix4().makeScale(0, 0, 0));
  pool.setMatrixAt(2, new THREE.Matrix4().makeRotationY(-0.4).setPosition(-3, 0.02, 7));
  scene.add(pool);
  // Yaw first ('YXZ'), so the heading the module must recover is exactly 2.0 whatever the pitch and roll.
  const grp = new THREE.Group(); grp.position.set(2, 0.717, 1); grp.rotation.set(0.04, 2.0, -0.03, 'YXZ'); scene.add(grp);
  const cc = opts.contact ?? new CarContact(scene);
  const hiddenAtStart = cc.mesh.visible === false;
  const placed = cc.update([{ mesh: pool }, { object: grp, plan: planFromCar() }]);
  // Each placed footprint, back in its own car's frame: its four corners must sit inside that car's
  // plan. The frames are built from the yaw and position the TEST placed, not read off a matrix, so
  // a module that recovered the wrong heading or the wrong offset cannot agree with them by
  // construction. The player's frame is its heading alone: the footprint lies on the road, flat,
  // whatever the body's pitch and roll.
  const cars = [new THREE.Matrix4().makeRotationY(1.1).setPosition(12, 0, -4),
    new THREE.Matrix4().makeRotationY(-0.4).setPosition(-3, 0.02, 7),
    new THREE.Matrix4().makeRotationY(2.0).setPosition(2, 0.717, 1)];
  const unit = cc.unit;
  let cornerWorst = -Infinity, yMin = Infinity, yMax = -Infinity;
  const mtx = new THREE.Matrix4(), v = new THREE.Vector3();
  for (let i = 0; i < Math.min(placed, cars.length); i++) {
    cc.mesh.getMatrixAt(i, mtx);
    const inv = cars[i].clone().invert();
    const plan = i < 2 ? planOf(g) : planFromCar();
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.set(sx * unit.w / 2, 0, sz * unit.l / 2).applyMatrix4(mtx);
      // Height over THIS car's own contact patch, which the test placed: the two pool cars at 0 and
      // 0.02 (a coupe's patch is its origin), the player's group 0.717 up with CAR.ground -0.717.
      const contactY = [0, 0.02, 0][i];
      yMin = Math.min(yMin, v.y - contactY); yMax = Math.max(yMax, v.y - contactY);
      v.applyMatrix4(inv);
      // Distance outside the plan rectangle in the car's own frame, metres (negative inside). The
      // player's group is pitched and rolled, so its own frame is tilted and y is not compared there.
      const ox = Math.abs(v.x - plan.cx) - plan.w / 2, oz = Math.abs(v.z - plan.cz) - plan.l / 2;
      cornerWorst = Math.max(cornerWorst, Math.max(ox, oz));
    }
  }
  cc.setLit(true);
  const litVisible = cc.mesh.visible === true;
  cc.setLit(false);
  const darkHidden = cc.mesh.visible === false;
  const mat = cc.mesh.material;
  return {
    bodies, C: { core: C.core, ramp: C.ramp, lift: C.lift },
    module: { placed, wantPlaced: 3, hiddenAtStart, litVisible, darkHidden, cornerWorstM: cornerWorst, yMin, yMax,
      castShadow: cc.mesh.castShadow, depthWrite: mat.depthWrite, multiply: mat.blending === THREE.MultiplyBlending,
      bucket: bucketOf(cc.mesh) },
  };
}

/** The light's terms at every preset, read off a TimeOfDay after apply(), in metres. */
export function measure(tod, floors = carFloors(), contact = null) {
  const out = { floors, presets: {}, contact: contact ?? measureContact(floors) };
  for (const name of Object.keys(PRESETS)) {
    tod.apply(name);
    const s = tod.sun.shadow, cam = s.camera;
    const el = PRESETS[name].elevation;
    const b = -s.bias * (cam.far - cam.near), nb = s.normalBias;
    const texel = (cam.right - cam.left) / s.mapSize.x;
    // The acne margin over every receiver angle the sun lights at ACNE_COS or more: the worst case
    // of (bias_m + nb / cos) - texel * tan, sampled finely enough that a minimum between samples
    // cannot hide (it is monotone or has one turning point in theta).
    let worst = Infinity, worstAt = null;
    const tMax = Math.acos(ACNE_COS);
    for (let i = 0; i <= 400; i++) {
      const th = (tMax * i) / 400;
      const d = b + nb / Math.cos(th) - ACNE_TEXELS * texel * Math.tan(th);
      if (d < worst) { worst = d; worstAt = th; }
    }
    out.presets[name] = {
      elevationDeg: el * 180 / Math.PI, biasMetres: b, normalBias: nb, texel,
      tolerance: b * Math.sin(el) + nb, acneWorst: worst, acneWorstDeg: worstAt * 180 / Math.PI,
      strip: b * Math.cos(el),
    };
  }
  return out;
}

/** The verdict as a pure function of the measurement, so the selftest can feed it known-bads. */
export function verdict(m) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const P = Object.entries(m.presets ?? {});
  const F = Object.entries(m.floors ?? {});
  const num = (v) => (Number.isFinite(v) ? v : null);
  add('every preset was read', P.length >= 4 && P.every(([, p]) => [p.biasMetres, p.normalBias, p.texel].every(Number.isFinite)),
    P.map(([k]) => k).join(', '));
  add('the floor pan exists on every car body, 0.15-0.25 m up and over 2.5 m2',
    F.length >= 4 && F.every(([, f]) => f.area > 2.5 && f.height > 0.15 && f.height < 0.25),
    F.map(([k, f]) => `${k} ${num(f.height)?.toFixed(4) ?? '-'} m / ${f.area?.toFixed(2)} m2`).join(', '));
  const floorLo = Math.min(...F.map(([, f]) => num(f.lo) ?? -Infinity));
  const bound = CONTACT_FRACTION * floorLo;
  const worstTol = Math.max(...P.map(([, p]) => num(p.tolerance) ?? Infinity));
  add(`at every hour the road under a car is in its shadow: tolerance <= ${CONTACT_FRACTION} x the floor's lowest point`,
    worstTol <= bound,
    P.map(([k, p]) => `${k} ${p.tolerance.toFixed(3)}`).join(', ') + ` m against ${bound.toFixed(3)} (floor from ${floorLo.toFixed(4)} m)`);
  add('and the bias is not negative: a receiver is never pushed INTO its occluder',
    P.every(([, p]) => p.biasMetres >= 0 && p.normalBias >= 0),
    P.map(([k, p]) => `${k} ${p.biasMetres.toFixed(4)}/${p.normalBias}`).join(', '));
  const worstAcne = Math.min(...P.map(([, p]) => num(p.acneWorst) ?? -Infinity));
  add(`no acne where the sun lights a surface at ${ACNE_COS * 100}% of its beam or more: bias + normalBias/cos covers ${ACNE_TEXELS} texel of slope`,
    worstAcne >= 0,
    P.map(([k, p]) => `${k} ${p.acneWorst.toFixed(4)} m at ${p.acneWorstDeg.toFixed(1)} deg`).join(', '));
  const worstStrip = Math.max(...P.map(([, p]) => num(p.strip) ?? Infinity));
  const texel = Math.max(...P.map(([, p]) => num(p.texel) ?? Infinity));
  add('the foot of a wall in shadow is not lit: the strip a constant bias leaves is under half a texel',
    worstStrip <= texel / 2,
    P.map(([k, p]) => `${k} ${p.strip.toFixed(3)}`).join(', ') + ` m against ${(texel / 2).toFixed(4)}`);
  add('the map is the one the bias is sized for: 2048 over +-120 m',
    P.every(([, p]) => Math.abs(p.texel - 240 / 2048) < 1e-9),
    P.map(([k, p]) => `${k} ${p.texel.toFixed(4)}`).join(', ') + ' m/texel');
  // ---- the night half: the footprint under every car (src/carcontact.js)
  const C = m.contact ?? {};
  const B = Object.entries(C.bodies ?? {});
  add('NIGHT: the footprint darkens only inside each body\'s own sill outline (10% or more, within 3 cm)',
    B.length >= 4 && B.every(([, b]) => b.dark > 100 && b.outside === 0),
    B.map(([k, b]) => `${k} ${b.outside}/${b.dark} outside, worst ${Number.isFinite(b.worstOverM) ? b.worstOverM.toFixed(3) : '-'} m`).join(', '));
  add('NIGHT: and it covers the floor pan, three quarters of it at half strength or more',
    B.length >= 4 && B.every(([, b]) => b.cover >= 0.75),
    B.map(([k, b]) => `${k} ${b.cover === null ? '-' : (100 * b.cover).toFixed(1)}%`).join(', '));
  const fl = Math.min(...F.map(([, f]) => num(f.height) ?? -Infinity));
  const cc = C.C ?? {};
  const skyAtRamp = Math.sin(Math.atan(fl / cc.ramp)) ** 2;
  const lampDepth = fl / Math.tan(25 * Math.PI / 180);
  add('NIGHT: the profile is the gap under the sill: core <= the sky one side lets in at the ramp, ramp >= a 25-degree lamp\'s reach',
    Number.isFinite(skyAtRamp) && cc.core > 0 && cc.core <= skyAtRamp && cc.ramp >= lampDepth,
    `core ${cc.core} against sin^2(atan(${fl.toFixed(3)} / ${cc.ramp})) = ${skyAtRamp.toFixed(3)}, ramp ${cc.ramp} m against ${lampDepth.toFixed(3)} m`);
  const M = C.module ?? {};
  add('NIGHT: one footprint per live car, on the road, hidden until the lamps are lit, casting and occluding nothing, in its own bucket',
    M.placed === M.wantPlaced && M.cornerWorstM <= 0.005 && M.yMin > 0.03 && M.yMax < 0.08 && M.hiddenAtStart &&
      M.litVisible && M.darkHidden && M.castShadow === false && M.depthWrite === false && M.multiply === true &&
      M.bucket === 'contact shadows',
    `placed ${M.placed}/${M.wantPlaced}, corners ${Number.isFinite(M.cornerWorstM) ? M.cornerWorstM.toFixed(4) : '-'} m past the plan, ` +
    `${Number.isFinite(M.yMin) ? M.yMin.toFixed(3) : '-'}..${Number.isFinite(M.yMax) ? M.yMax.toFixed(3) : '-'} m over its own contact patch, ` +
    `hidden ${M.hiddenAtStart}/${M.darkHidden}, lit ${M.litVisible}, cast ${M.castShadow}, depthWrite ${M.depthWrite}, ` +
    `multiply ${M.multiply}, bucket "${M.bucket}"`);
  return checks;
}

const IS_MAIN = process.argv[1] && import.meta.url.endsWith(`/${process.argv[1].split('/').pop()}`);
if (IS_MAIN && argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, name, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
  console.log('SHADOW-FLOOR SELFTEST');
  const floors = carFloors();
  const good = verdict(measure(makeTod(), floors));
  say(good.length === CHECK_COUNT && good.every((c) => c.ok), `the shipped light passes all ${CHECK_COUNT} checks`,
    good.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  const failsOn = (tod, needle, fl = floors) => {
    const v = verdict(measure(tod, fl));
    return { hit: v.some((c) => !c.ok && c.name.includes(needle)), failing: v.filter((c) => !c.ok).map((c) => c.name) };
  };
  // A TimeOfDay whose apply() leaves the shadow terms at a fixed pair, the way the shipped one did.
  const fixed = (bias, normalBias) => {
    const t = makeTod();
    const apply = t.apply.bind(t);
    t.apply = (n) => { const p = apply(n); t.sun.shadow.bias = bias; t.sun.shadow.normalBias = normalBias; return p; };
    return t;
  };
  // KNOWN-BAD 1: the constant this replaced. 0.58 m of tolerance at noon against a 0.19 m floor.
  let r = failsOn(fixed(-0.0006, 0.06), 'under a car');
  say(r.hit, 'KNOWN-BAD: bias -0.0006 / normalBias 0.06 leaves the road under a car lit', r.failing.join(' | '));
  r = failsOn(fixed(-0.0006, 0.06), 'foot of a wall');
  say(r.hit, 'KNOWN-BAD: and leaves a lit strip along the foot of every wall in shadow at golden hour', r.failing.join(' | '));
  // KNOWN-BAD 2: the other side. No bias at all: contact everywhere, and acne on every lit surface.
  r = failsOn(fixed(0, 0), 'no acne');
  say(r.hit, 'KNOWN-BAD: bias 0 / normalBias 0 fails the acne check', r.failing.join(' | '));
  // KNOWN-BAD 3: the normal offset halved — 445 px of furniture acne at fivepoints noon against 183.
  r = failsOn(fixed(0, 0.03), 'no acne');
  say(r.hit, 'KNOWN-BAD: bias 0 with normalBias 0.03 fails the acne check', r.failing.join(' | '));
  // KNOWN-BAD 4: a normal offset big enough for any acne is a normal offset over the floor: at 0.15 the
  // red car's road is a quarter lit again (0.262).
  r = failsOn(fixed(0, 0.15), 'under a car');
  say(r.hit, 'KNOWN-BAD: normalBias 0.15 buys the acne back with the contact', r.failing.join(' | '));
  // KNOWN-BAD 4b: "a constant set from the preset's elevation" — the tolerance held at 0.10 m by a bias of
  // 0.04 / sin(elevation). The contact holds; the constant is 0.73 m along the ray at dusk, and every
  // wall in shadow gets that lit strip at its foot.
  const elev = makeTod(); const applyE = elev.apply.bind(elev);
  elev.apply = (n) => { const p = applyE(n); elev.sun.shadow.bias = -(0.04 / Math.sin(PRESETS[n].elevation)) / 899; elev.sun.shadow.normalBias = 0.06; return p; };
  r = failsOn(elev, 'foot of a wall');
  say(r.hit, 'KNOWN-BAD: a bias set from the elevation (tolerance 0.10) fails the wall-foot strip', r.failing.join(' | '));
  // KNOWN-BAD 5: a body with no floor. The contact check must not pass on a subject that is missing.
  const noFloor = { ...floors, coupe: { area: 0, height: null, lo: null, hi: null } };
  r = failsOn(makeTod(), 'floor pan exists', noFloor);
  say(r.hit, 'KNOWN-BAD: a car body with no floor pan fails, rather than passing every bound', r.failing.join(' | '));
  r = failsOn(makeTod(), 'under a car', noFloor);
  say(r.hit, 'KNOWN-BAD: and the contact check fails with it rather than comparing against nothing', r.failing.join(' | '));
  // KNOWN-BAD 6: an empty measurement cannot pass, and the check count does not shrink.
  const empty = verdict({ presets: {}, floors: {} });
  say(empty.length === CHECK_COUNT && empty.filter((c) => !c.ok).length >= 1,
    'KNOWN-BAD: nothing read fails, and the check count does not shrink', `${empty.length} checks`);
  // KNOWN-BAD 7: a footprint twice the car's width darkens the road beside every car.
  const wide = measureContact(floors, CONTACT, { planFor: (n, g) => { const p = n === 'player' ? planFromCar() : planOf(g); return { ...p, w: p.w * 2 }; } });
  r = { v: verdict({ ...measure(makeTod(), floors, wide) }) };
  say(r.v.some((c) => !c.ok && c.name.includes('sill outline')), 'KNOWN-BAD: a footprint twice as wide fails "inside the sill outline"',
    r.v.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  // KNOWN-BAD 8: a profile that is not the gap under the sill — a weak core, then a short ramp.
  const weak = measureContact(floors, { ...CONTACT, core: 0.5 });
  r = { v: verdict(measure(makeTod(), floors, weak)) };
  say(r.v.some((c) => !c.ok && c.name.includes('profile is the gap')), 'KNOWN-BAD: core 0.5 fails the derived profile',
    r.v.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  const short = measureContact(floors, { ...CONTACT, ramp: 0.15 });
  r = { v: verdict(measure(makeTod(), floors, short)) };
  say(r.v.some((c) => !c.ok && c.name.includes('profile is the gap')), 'KNOWN-BAD: a 0.15 m ramp fails the derived profile',
    r.v.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  // KNOWN-BAD 9: a footprint that never placed anything is not a pass of "inside the outline".
  const none = measureContact(floors, CONTACT, { contact: { mesh: { visible: false, castShadow: false, material: { depthWrite: false, blending: 0 },
    getMatrixAt: () => {} }, unit: { w: 1.9, l: 4.49 }, update: () => 0, setLit() {} } });
  r = { v: verdict(measure(makeTod(), floors, none)) };
  say(r.v.some((c) => !c.ok && c.name.includes('one footprint per live car')), 'KNOWN-BAD: a module that places nothing fails',
    r.v.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  // The floor reader against a hand-built slab whose answer is known.
  const slab = new THREE.BoxGeometry(1.4, 0.1, 1.6); slab.translate(0, 0.25, 0);
  const fs = floorPan(slab, 0);
  say(Math.abs(fs.height - 0.2) < 1e-6 && Math.abs(fs.area - 1.4 * 1.6) < 1e-5,
    'floorPan reads a slab\'s underside: 2.24 m2 at 0.200 m', `${fs.area.toFixed(4)} m2 at ${fs.height.toFixed(4)} m`);
  console.log(`\nSHADOW-FLOOR SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
if (IS_MAIN && !argv.includes('--selftest')) {
  const t0 = performance.now();
  const m = measure(makeTod());
  console.log('SHADOW-FLOOR — the sun\'s shadow terms at every preset against the floor of every car the game builds\n');
  console.log('  floor pans (between the axles, off the buffer):');
  for (const [k, f] of Object.entries(m.floors)) {
    console.log(`    ${k.padEnd(8)} ${f.area.toFixed(3)} m2 at ${f.height.toFixed(4)} m  (${f.lo.toFixed(4)}..${f.hi.toFixed(4)})`);
  }
  console.log('\n  preset   elev     bias      normalBias   tolerance   acne margin (worst, at)   wall-foot strip');
  for (const [k, p] of Object.entries(m.presets)) {
    console.log(`  ${k.padEnd(8)} ${p.elevationDeg.toFixed(2).padStart(5)}   ${p.biasMetres.toFixed(4)} m   ${p.normalBias.toFixed(3)} m     ` +
      `${p.tolerance.toFixed(3)} m     ${p.acneWorst.toFixed(4)} m at ${p.acneWorstDeg.toFixed(1)} deg        ${p.strip.toFixed(3)} m`);
  }
  console.log('\n  night: the footprint under every car (src/carcontact.js), against each body');
  for (const [k, b] of Object.entries(m.contact.bodies)) {
    console.log(`    ${k.padEnd(8)} plan ${b.plan.w.toFixed(3)} x ${b.plan.l.toFixed(3)} m, ${b.outside} of ${b.dark} darkening samples outside the sill ` +
      `(worst ${b.worstOverM.toFixed(3)} m), floor pan covered ${(100 * b.cover).toFixed(1)}%`);
  }
  console.log('');
  const checks = verdict(m);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nSHADOW-FLOOR: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks in ${((performance.now() - t0) / 1000).toFixed(2)} s` +
    `${failed.length ? `, ${failed.length} failed` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
