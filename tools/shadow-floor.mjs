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
//
// AND THE SHEETS (#141 round 2). The acne check above is sized for a CLOSED caster, whose back face is a
// body's thickness behind the lit one. A shop awning is a top sheet over its own underside and a valance
// front over its own back, on the same vertices, so over a lit sheet the map holds its TWIN at its own
// depth — the 4 px stripes #141's blind reviewer refused at noon. src/sheetshadow.js pushes the twin
// along the sun's ray; this half reads the sheets off the signage the district builds and asks:
//
//   sheets    the subject exists: the signage carries coincident, opposite-facing twins, and the sun
//             lights some of them at ACNE_COS or more at noon
//   reach     the twin's depth is clear of three's PCF_SOFT kernel: the reach is DERIVED here from the
//             vendored kernel's own taps (SHEET_PARTIAL), and every lit sheet at every preset stands
//             that far in front of its pushed twin. Round 1's setting fails it at noon — the KNOWN-BAD
//   cost      the push is zero where normalBias alone stands its slope (within 11.8 degrees of the sun;
//             a horizontal underside at noon, 14.4 degrees, moves 1.3 cm, so the contact under a fascia
//             or a parapet cap stays attached) and stops growing past ACNE_COS, where acne cannot be seen
//   material  the depth material carries it: its seam is found and its uniforms are the module's
//             constants and the sun's own map and normalBias
import * as THREE from '../vendor/three.module.min.js';
import fs from 'node:fs';
import { PRESETS } from '../src/daynight.js';
import { buildTrafficCarGeometry, buildPlayerCar, SHAPES, CAR } from '../src/carbody.js';
import { CarContact, CONTACT, planOf, planFromCar } from '../src/carcontact.js';
import { bucketOf } from './tri-buckets.mjs';
import { makeTod } from './shadow-stable.mjs';
import { SUN_SHADOW } from '../src/daynight.js';
import { SHEET_TEXELS, SHEET_COS, sheetDepthOffset, sheetDepthMaterial, SHEET_SEAM, SHEET_GLSL } from '../src/sheetshadow.js';

// signage.js paints its atlases at import; positions never depend on a pixel. The same no-op 2D context
// tools/sign-orient.mjs and tools/frontage-stats.mjs install, before the import that needs it.
if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1, height: 1 };
      return (t[k] = (...a) => {
        if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
            k === 'createPattern' || k === 'createConicGradient') return grad;
        if (k === 'getImageData') {
          const w = a[2] | 0 || 1, h = a[3] | 0 || 1;
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        return undefined;
      });
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }) };
}
const { districtSignageBuffers, streetAtlas, bladeCells, planStreetSignage, bladePlate } = await import('../src/signage.js');

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/shadow-floor.mjs [--selftest]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty (CLAUDE.md, car-pixel). */
export const CHECK_COUNT = 15;
/**
 * The loss of sun a lit pixel must exceed for tools/shadow-bias.mjs to count it as partial acne: the
 * census the sheet push was measured with, so the kernel's reach is derived against the same line.
 */
export const SHEET_PARTIAL = 0.15;
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

/**
 * three r180's PCF_SOFT kernel, one lookup (shadowmap_pars_fragment, transcribed): the lookup snaps to
 * base = uv - f, f = fract(uv * size + 0.5), and reads sixteen texel CENTRES at base + (i, j), i and j in
 * -1..2, the outer rows and columns bilinear in f, nine weights in all. Returns [dx, dy, w] in texels from
 * the lookup point.
 */
export function pcfTaps(fx, fy) {
  const t = [];
  const add = (i, j, w) => { if (w > 0) t.push([i - fx, j - fy, w]); };
  add(0, 0, 1); add(1, 0, 1); add(0, 1, 1); add(1, 1, 1);
  add(-1, 0, 1 - fx); add(2, 0, fx); add(-1, 1, 1 - fx); add(2, 1, fx);
  add(0, -1, 1 - fy); add(0, 2, fy); add(1, -1, 1 - fy); add(1, 2, fy);
  add(-1, -1, (1 - fx) * (1 - fy)); add(2, -1, fx * (1 - fy)); add(-1, 2, (1 - fx) * fy); add(2, 2, fx * fy);
  return t;
}

/**
 * The worst share of the sun a lit sheet loses to its own twin when the twin stands `m` texels of slope
 * behind it, over every sub-texel phase and every direction the slope can run across the map. A tap is
 * dark when it lies more than m texels uphill (toward the light).
 */
export function pcfWorstLoss(m, phases = 24, dirs = 48) {
  let worst = 0;
  for (let a = 0; a < dirs; a++) {
    const c = Math.cos((2 * Math.PI * a) / dirs), s = Math.sin((2 * Math.PI * a) / dirs);
    for (let i = 0; i < phases; i++) for (let j = 0; j < phases; j++) {
      let lost = 0;
      for (const [dx, dy, w] of pcfTaps((i + 0.5) / phases, (j + 0.5) / phases)) if (dx * c + dy * s > m) lost += w;
      if (lost / 9 > worst) worst = lost / 9;
    }
  }
  return worst;
}

/** The smallest margin, in texels of slope, at which no lit sheet loses over `partial` of its sun. */
export function pcfReach(partial = SHEET_PARTIAL) {
  let lo = 0, hi = 3;
  for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (pcfWorstLoss(mid) <= partial) hi = mid; else lo = mid; }
  return hi;
}

/**
 * Zero-thickness sheets in a buffer: triangles with an OPPOSITE-facing triangle in the same plane that
 * covers its centroid. Not a vertex match: a quad and its reverse are cut along different diagonals, so
 * a top sheet's triangles and its underside's share no three vertices. Returns the unit normals of every
 * triangle that has a twin (both members of a pair), and the counts.
 */
export function twinFaces(buf) {
  const P = buf.pos, I = buf.idx, nT = I.length / 3;
  const tris = [];
  const byPlane = new Map();
  for (let t = 0; t < nT; t++) {
    const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
    const A = [P[a], P[a + 1], P[a + 2]], B = [P[b], P[b + 1], P[b + 2]], C = [P[c], P[c + 1], P[c + 2]];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 1e-8)) continue;
    n[0] /= len; n[1] /= len; n[2] /= len;
    // The plane, sign-canonical, so a face and its twin share a key.
    const sg = (Math.abs(n[0]) > 1e-6 ? n[0] : Math.abs(n[1]) > 1e-6 ? n[1] : n[2]) > 0 ? 1 : -1;
    const d = n[0] * A[0] + n[1] * A[1] + n[2] * A[2];
    const key = [n[0] * sg, n[1] * sg, n[2] * sg, d * sg].map((v) => Math.round(v * 200)).join(',');
    const tri = { A, B, C, n, sg, cen: [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3] };
    tris.push(tri);
    if (!byPlane.has(key)) byPlane.set(key, []);
    byPlane.get(key).push(tri);
  }
  // Barycentric containment of a point already in the plane.
  const inside = (q, t) => {
    const v0 = t.B.map((v, i) => v - t.A[i]), v1 = t.C.map((v, i) => v - t.A[i]), v2 = q.map((v, i) => v - t.A[i]);
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    if (!(Math.abs(den) > 1e-14)) return false;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    return v >= -1e-6 && w >= -1e-6 && v + w <= 1 + 1e-6;
  };
  const normals = [];
  let twins = 0;
  for (const group of byPlane.values()) {
    if (group.length < 2) continue;
    for (const t of group) {
      if (group.some((o) => o !== t && o.sg !== t.sg && inside(t.cen, o))) { twins++; normals.push(t.n); }
    }
  }
  return { tris: tris.length, twins, normals };
}

/** Every sheet the district's signage carries: the shop kit and the street-name blades, as the page builds them. */
export function sheetCensus() {
  const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
  // The blades are lettered from an atlas the page bakes from the district's own names; primed the way
  // tools/sign-orient.mjs primes it, before anything memoises it.
  const names = Object.values(district.streetNames ?? {});
  streetAtlas(names, [...bladeCells(planStreetSignage(district)), ...names.map((n) => [n, bladePlate(n)])]);
  const res = districtSignageBuffers(district);
  const shop = { tris: 0, twins: 0, normals: [] };
  for (const bk of res.buckets) {
    const f = twinFaces(bk.sign);
    shop.tris += f.tris; shop.twins += f.twins; shop.normals.push(...f.normals);
  }
  const street = twinFaces(res.street);
  return { shop, street, normals: [...shop.normals, ...street.normals] };
}

/**
 * The sheet terms at one preset: every twin the sun lights at ACNE_COS or more, its margin against the
 * kernel's reach, and the same margin over EVERY angle in that range whether or not a sheet sits at it.
 * `push` is the module's own function unless a selftest hands in a known-bad one.
 */
export function sheetTerms(sun, texel, b, nb, normals, reach, push = sheetDepthOffset) {
  const marginAt = (c) => {
    const tan = Math.sqrt(Math.max(0, 1 - c * c)) / c;
    return push(c, texel, nb) + b + nb / c - reach * texel * tan;
  };
  let lit = 0, worst = Infinity, worstCos = null;
  for (const n of normals) {
    const c = n[0] * sun.x + n[1] * sun.y + n[2] * sun.z;
    if (c < ACNE_COS) continue;
    lit++;
    const m = marginAt(c);
    if (m < worst) { worst = m; worstCos = c; }
  }
  let any = Infinity, anyCos = null;
  for (let i = 0; i <= 400; i++) {
    const c = ACNE_COS + ((1 - ACNE_COS) * i) / 400;
    const m = marginAt(c);
    if (m < any) { any = m; anyCos = c; }
  }
  return { lit, worst: lit ? worst : null, worstDeg: worstCos === null ? null : Math.acos(worstCos) * 180 / Math.PI,
    any, anyDeg: Math.acos(anyCos) * 180 / Math.PI };
}

/** The push as a function, swept: where it is zero and where it stops growing. */
export function pushShape(texel, nb, push = sheetDepthOffset) {
  let maxPush = 0;
  const atAcne = push(ACNE_COS, texel, nb);
  // Zero while normalBias alone covers the reach: SHEET_TEXELS * texel * sin(theta) <= nb.
  const covered = Math.asin(Math.min(1, nb / (SHEET_TEXELS * texel)));
  let worstCovered = 0;
  for (let i = 0; i <= 2000; i++) {
    const c = i / 2000, th = Math.acos(c), p = push(c, texel, nb);
    // A push that is not a number fails the bound rather than slipping under it: NaN > x is false.
    if (!Number.isFinite(p)) { maxPush = Infinity; worstCovered = th <= covered ? Infinity : worstCovered; continue; }
    if (p > maxPush) maxPush = p;
    if (th <= covered - 1e-9 && p > worstCovered) worstCovered = p;
  }
  return { coveredDeg: covered * 180 / Math.PI, worstCovered, maxPush, atAcne };
}

/** The depth material, compiled offline against three's own depth vertex shader. */
export function sheetMaterialTerms(material = sheetDepthMaterial()) {
  const shader = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader, uniforms: {} };
  let threw = null;
  try { material.onBeforeCompile(shader); } catch (e) { threw = e.message; }
  const u = shader.uniforms;
  const val = (k) => (u[k] ? u[k].value : null);
  return {
    threw, seam: shader.vertexShader.includes(`${SHEET_SEAM}\n${SHEET_GLSL}`),
    declared: ['uSheetK', 'uSheetCos', 'uSheetNB', 'uSheetMap'].every((k) => shader.vertexShader.includes(`uniform float ${k};`)),
    K: val('uSheetK'), cos: val('uSheetCos'), nb: val('uSheetNB'), map: val('uSheetMap'),
    rgba: material.depthPacking === THREE.RGBADepthPacking,
  };
}

/** The light's terms at every preset, read off a TimeOfDay after apply(), in metres. */
// Both are a property of the build, not of the light, so a selftest's dozen known-bads pay for them once.
let _census = null, _reach = null;
export function measure(tod, floors = carFloors(), contact = null, sheets = null) {
  const census = sheets?.census ?? (_census ??= sheetCensus());
  const reach = sheets?.reach ?? (_reach ??= pcfReach());
  const push = sheets?.push ?? sheetDepthOffset;
  const out = { floors, presets: {}, contact: contact ?? measureContact(floors),
    sheets: { census: { shop: census.shop.twins, shopTris: census.shop.tris, street: census.street.twins, streetTris: census.street.tris },
      reach, K: SHEET_TEXELS, presets: {}, material: sheets?.material ?? sheetMaterialTerms() } };
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
    out.sheets.presets[name] = sheetTerms(tod.sunDirection(new THREE.Vector3()), texel, b, nb, census.normals, reach, push);
    if (name === Object.keys(PRESETS)[0]) out.sheets.shape = pushShape(texel, nb, push);
  }
  out.sheets.light = { map: tod.sun.shadow.mapSize.x, nb: tod.sun.shadow.normalBias };
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
  // ---- the sheets (#141 round 2): src/sheetshadow.js
  const S = m.sheets ?? {};
  const SP = Object.entries(S.presets ?? {});
  const cen = S.census ?? {};
  const noonLit = S.presets?.noon?.lit ?? 0;
  add(`SHEETS: the district's signage carries zero-thickness twins, and at noon the sun lights some at ${ACNE_COS * 100}% of its beam or more`,
    (cen.shop ?? 0) + (cen.street ?? 0) >= 100 && noonLit > 0,
    `shop ${cen.shop}/${cen.shopTris} triangles in a twin, street ${cen.street}/${cen.streetTris}; lit at noon ${noonLit}`);
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(4) : '-');
  add(`SHEETS: every sheet the sun lights at ${ACNE_COS * 100}% or more stands the PCF_SOFT kernel's reach (${fmt(S.reach)} texels of slope) in front of its twin, at every preset`,
    SP.length >= 4 && Number.isFinite(S.reach) && S.K >= S.reach &&
      SP.every(([, q]) => (q.worst === null || q.worst >= -1e-9) && q.any >= -1e-9),
    `K ${S.K}; ` + SP.map(([k, q]) => `${k} ${q.lit} lit, worst ${fmt(q.worst)} m${q.worstDeg === null ? '' : ` at ${q.worstDeg.toFixed(1)} deg`}, any angle ${fmt(q.any)} m at ${q.anyDeg.toFixed(1)}`).join('; '));
  const sh = S.shape ?? {};
  add(`SHEETS: the push is zero where normalBias alone stands its K texels of slope (within ${fmt(sh.coveredDeg)} deg of the sun) and stops growing past ${ACNE_COS * 100}% of the beam`,
    sh.worstCovered === 0 && Number.isFinite(sh.maxPush) && sh.atAcne > 0 && sh.maxPush <= sh.atAcne + 1e-12,
    `inside ${fmt(sh.coveredDeg)} deg it moves a twin ${fmt(sh.worstCovered)} m; at most ${fmt(sh.maxPush)} m, ${fmt(sh.atAcne)} m at ACNE_COS`);
  const mt = S.material ?? {}, lt = S.light ?? {};
  add('SHEETS: the depth material carries the push: its seam is found, its uniforms are the module\'s K and clamp and the sun\'s own map and normalBias, RGBA packed',
    mt.threw === null && mt.seam && mt.declared && mt.rgba && mt.K === SHEET_TEXELS && mt.cos === SHEET_COS &&
      mt.nb === lt.nb && mt.map === lt.map && S.K === SHEET_TEXELS,
    `threw ${mt.threw}, seam ${mt.seam}, declared ${mt.declared}, rgba ${mt.rgba}, K ${mt.K}, cos ${mt.cos}, nb ${mt.nb} (sun ${lt.nb}), map ${mt.map} (sun ${lt.map})`);
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
  // ---- the sheets. One census and one reach for every known-bad, so the selftest pays for them once.
  const census = sheetCensus();
  const reach = pcfReach();
  const material = sheetMaterialTerms();
  const sheetRun = (push, mat = material, cz = census) => verdict(measure(makeTod(), floors, null, { census: cz, reach, push, material: mat }));
  const failsSheet = (v, needle) => ({ hit: v.some((c) => !c.ok && c.name.includes(needle)), failing: v.filter((c) => !c.ok).map((c) => c.name) });
  // KNOWN-BAD 10: ROUND 1's SETTING, bias 0 / normalBias 0.06 with no push: the reviewer's stripes.
  r = failsSheet(sheetRun(() => 0), 'reach');
  say(r.hit, 'KNOWN-BAD: round 1\'s map, no push, leaves the awnings\' twins inside the kernel at noon', r.failing.join(' | '));
  // KNOWN-BAD 11: a push of one texel, under the kernel's 1.52-texel reach.
  r = failsSheet(sheetRun((c, t, nb) => sheetDepthOffset(c, t, nb, 1)), 'reach');
  say(r.hit, 'KNOWN-BAD: a push of 1 texel fails the reach (the reviewer\'s boxes read clean from 1.5 up; the kernel loses a third of the sun at 1)', r.failing.join(' | '));
  // KNOWN-BAD 12: no normalBias credit moves the faces normalBias covers: the contact under a fascia.
  r = failsSheet(sheetRun((c, t) => sheetDepthOffset(c, t, 0)), 'push is zero');
  say(r.hit, 'KNOWN-BAD: a push that does not credit normalBias moves every face, a fascia\'s underside at noon 7.5 cm against 1.3', r.failing.join(' | '));
  // KNOWN-BAD 13: no clamp: an edge-on twin pushed 4.7 m along the ray.
  r = failsSheet(sheetRun((c, t, nb) => sheetDepthOffset(c, t, nb, SHEET_TEXELS, 0.05)), 'stops growing');
  say(r.hit, 'KNOWN-BAD: a push with no clamp keeps growing past the visible range', r.failing.join(' | '));
  // KNOWN-BAD 14: a depth material with no push in it, and a census that found no sheets.
  r = failsSheet(sheetRun(sheetDepthOffset, sheetMaterialTerms(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }))), 'depth material carries');
  say(r.hit, 'KNOWN-BAD: a plain depth material on the signage fails the material check', r.failing.join(' | '));
  r = failsSheet(sheetRun(sheetDepthOffset, material, { shop: { tris: 10, twins: 0, normals: [] }, street: { tris: 10, twins: 0, normals: [] }, normals: [] }), 'carries zero-thickness');
  say(r.hit, 'KNOWN-BAD: a census that finds no sheets fails, rather than passing every margin over nothing', r.failing.join(' | '));
  // The kernel against what it must read, and the twin finder against shapes whose answer is known.
  const l1 = pcfWorstLoss(1), l2 = pcfWorstLoss(2), lc = pcfWorstLoss(2 * Math.SQRT2 + 0.01);
  say(l1 > 0.3 && l2 > 0 && l2 < SHEET_PARTIAL && lc === 0 && reach > 1.5 && reach < 1.7,
    'the kernel: a twin 1 texel behind loses a third of the sun, 2 texels a sliver, past the corner tap nothing; reach between 1.5 and 1.7',
    `loss ${l1.toFixed(4)} / ${l2.toFixed(4)} / ${lc}, reach ${reach.toFixed(4)}`);
  const qb = { pos: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], idx: [0, 1, 2, 0, 2, 3, 3, 2, 1, 3, 1, 0] };
  const single = { pos: qb.pos, idx: [0, 1, 2, 0, 2, 3] };
  const box = new THREE.BoxGeometry(1, 0.2, 1);
  const boxBuf = { pos: [...box.getAttribute('position').array], idx: [...box.getIndex().array] };
  const tq = twinFaces(qb), ts = twinFaces(single), tb = twinFaces(boxBuf);
  say(tq.twins === 4 && ts.twins === 0 && tb.twins === 0,
    'twinFaces: a quad over its reverse (cut on the other diagonal) is 4 twins; a lone quad and a closed slab are none',
    `${tq.twins} / ${ts.twins} / ${tb.twins}`);
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
