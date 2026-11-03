// THE LAMPS' SHADOW UNDER A CAR — #141's night half.
//
// #141 put the sun's shadow back under every car: the map holds a car's floor 0.19 m up, and the bias
// had been letting a receiver ignore anything within 0.58 m of it at noon. That fixes every hour the
// SUN lights the road. It does nothing at night, because at night the road is lit by the street lamps
// and the lamps are PointLights from a ten-slot pool with no shadow maps at all: the road under a
// parked car is lit as if the car were not there, and the car hovers over its own pool of lamplight.
// Measured with #141's bias in (tools/shadow-bias.mjs at fivepoints night, the road under the body the
// camera can see over the road 3.5-6 m round the car, one task, this footprint hidden and shown):
//
//                              HDR scene target, before AO       composited, AO and tone curve in
//                              without      with                 without      with
//     the red car, 26.9 m       0.773       0.323                 0.112       0.039
//     a parked coupe, 22.3 m    0.826       0.389                 0.125       0.099
//
// and 0.14% of the frame changes by more than 4/255, every pixel of it under a car. The moon is the
// sun's light at night and #141's bias already shadows it there; it is under a tenth of the light on
// these roads, which is why taking the old bias back moves the red car's 0.323 to 0.328 and no more.
//
// A shadow map per lamp is six renders a lamp, so the honest cheap thing is the occluder the lamps
// cannot see: a footprint under each car that MULTIPLIES what is under the body, because under the
// body the sky, the lamps and the moon are all blocked by the same floor pan. One InstancedMesh for
// every car in the district (parked, traffic, pursuit and the player's), so it is ONE draw call, not
// a mesh per pool, and it is a nine-slice of 18 triangles a car that casts nothing (x1.00 in the
// gate's units, tools/shadow-bill.mjs).
//
// THE PROFILE IS THE GAP UNDER THE SILL, not a picked blur. Light reaches a point d metres inside the
// sill only from elevations under atan(h / d), h the floor pan's 0.19 m: a lamp 6-8 m up and 5-15 m
// away stands 25-55 degrees high and is blocked from d = 0.41 m in, and the sky's share through one
// side is sin^2(atan(h / d)) — 0.47 at 0.2 m, 0.18 at 0.4, 0.05 at 0.8. So the multiplier falls from 1
// at the sill to CONTACT.core over CONTACT.ramp = 0.45 m, and deep under the body only the bounce off
// the road outside gets in. It stops AT the plan footprint: just outside the sill the car blocks the
// lamps on its far side only, which is a directional shadow a symmetric footprint would get wrong.
//
// IT IS ON WHEN THE LAMPS ARE. By day the sun's shadow does this job, and does it better — it is
// directional, and at golden hour the low sun genuinely reaches under a car from its sun side, which a
// footprint would black out. At dusk the lamps are lit and the sun is 2% of the light on the road
// (src/daynight.js), so the footprint costs that 2% under a car and buys the lamps' contact.
import * as THREE from '../vendor/three.module.min.js';
import { CAR } from './carbody.js';

export const CONTACT = {
  core: 0.12,     // the multiplier deep under the body
  ramp: 0.45,     // metres inside the sill over which it falls from 1 to the core
  // Metres over the car's OWN contact patch, not a world height. A parked car's tyres stand at
  // PARKED_GROUND_Y -0.07 with the parking lane drawn at -0.04 (src/kerb.js laneY), a fleet car's at its
  // instance origin with the road ribbon at +0.02 and the markings at +0.032: one world height would be
  // 8 cm over a parked car's lane, and from a camera 2.4 m up and 8.6 m away a footprint 8 cm over the
  // road is seen 0.3 m nearer the camera than the road it covers — measured, the near parked wagon at
  // corridor night darkened by 13% where the profile says half. 4.5 cm over the contact is 1.5 cm over
  // the lane and 1.3 cm over the markings.
  lift: 0.045,
  inset: 0.04,    // metres inside the body's plan outline, at the sides
  // and at the ends, more: the body draws in at nose and tail (planTaper), from 0.95 m to 0.80 m in
  // its last 0.2 m, and the underbody rises into the overhangs, so a rectangle to the bumpers would
  // darken road beside the corners. tools/shadow-floor.mjs measures the corners against the sill.
  endInset: 0.20,
};

/**
 * A nine-slice in the car's own plan, centred on its origin, `w` across and `l` long, with the
 * multiplier as a vertex colour: 1 round the outline, CONTACT.core over the inner rectangle `ramp`
 * metres in. 9 quads, 18 triangles; y = 0, the instance matrix lifts it.
 */
export function contactGeometry(w = 1.90, l = 4.49, ramp = CONTACT.ramp, core = CONTACT.core) {
  const r = Math.min(ramp, w / 2 - 0.01, l / 2 - 0.01);
  const xs = [-w / 2, -w / 2 + r, w / 2 - r, w / 2], zs = [-l / 2, -l / 2 + r, l / 2 - r, l / 2];
  const pos = [], col = [], idx = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      pos.push(xs[i], 0, zs[j]);
      const inner = i > 0 && i < 3 && j > 0 && j < 3;
      const v = inner ? core : 1;
      col.push(v, v, v);
    }
  }
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const a = j * 4 + i, b = a + 1, c = a + 4, d = c + 1;
      // Wound so the face looks UP (+y): a, c, b and b, c, d in this x-right, z-down-the-list grid.
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * The material: dst *= src. Premultiplied, because three refuses MultiplyBlending otherwise; alpha 1,
 * so the scene target's alpha — src/post.js keeps an emitted-share tag there — is multiplied by 1.
 * Linear and un-tone-mapped: it writes a MULTIPLIER into the HDR target, not a colour.
 */
export function contactMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true,
    blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true,
    depthWrite: false, toneMapped: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

/** The plan rectangle a car body covers, off its geometry's bounding box, inset by CONTACT.inset. */
export function planOf(geometry, archLip = 0.07) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  // The bounding box's x carries the wheel-arch lips, which stand proud of the sill: take them off,
  // so the footprint is the floor pan's width and not the lips'.
  return {
    cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2,
    w: Math.max(0.2, b.max.x - b.min.x - 2 * archLip - 2 * CONTACT.inset),
    l: Math.max(0.2, b.max.z - b.min.z - 2 * CONTACT.endInset),
    // The contact patch in the body's own frame: the tyres' lowest point, which every fleet shell is
    // translated to stand on (buildTrafficCarGeometry's groundY).
    y: b.min.y,
  };
}

/**
 * The player's car's plan, from CAR rather than off its buffer: the player's body carries its door
 * mirrors, which stand 0.2 m past the sill and would widen a bounding box by 0.4 m.
 */
export function planFromCar(P = CAR) {
  return { cx: 0, cz: 0, w: 2 * P.hw - 2 * CONTACT.inset, l: 2 * P.halfLen - 2 * CONTACT.endInset, y: P.ground };
}

const _plans = new WeakMap();
/** planOf, once per geometry. */
function planCached(geometry) {
  let p = _plans.get(geometry);
  if (!p) { p = planOf(geometry); _plans.set(geometry, p); }
  return p;
}

const _m = new THREE.Matrix4(), _w = new THREE.Matrix4(), _o = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class CarContact {
  /**
   * @param {THREE.Object3D} scene
   * @param {{max?: number}} opts  capacity, every car in the district at once
   */
  constructor(scene, opts = {}) {
    this.max = opts.max ?? 160;
    // Authored at unit plan and scaled per instance: one geometry serves every shell. The ramp is
    // then scaled with the plan, by under 4% across the shells (1.90-1.97 x 4.49-4.69 m), which is
    // well inside what the profile above can claim.
    this.unit = { w: 1.90, l: 4.49 };
    this.geometry = contactGeometry(this.unit.w, this.unit.l);
    this.mesh = new THREE.InstancedMesh(this.geometry, contactMaterial(), this.max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // NAMED, and its own bucket in tools/tri-buckets.mjs: a mesh that casts nothing must not sit in
    // the `vehicles` row, which bills x2.00 (CLAUDE.md, "An unnamed mesh is invisible").
    this.mesh.name = 'contactShadow:cars';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;     // instances move; the geometry's sphere does not
    this.mesh.count = 0;
    this.mesh.visible = false;           // until setLit says the lamps are on
    // After the opaque road it darkens, and after the lamp spill pools, which are additive light ON
    // the road and are darkened with it where they reach under a body.
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.stats = { placed: 0, sources: 0, skipped: 0 };
  }

  /** Lamps on: the footprint draws. Off: it is hidden, so it is no draw call and no triangle by day. */
  setLit(on) { this.mesh.visible = !!on; }

  /**
   * Place one footprint per live car. `sources` is a list of
   *   { mesh: InstancedMesh, plan? }   every instance below mesh.count; plan defaults to planOf(geometry)
   *   { object: Object3D, plan }       one car, at the object's world transform
   * Only the car's plan position, its YAW and the height of its contact patch are taken: the
   * footprint lies flat CONTACT.lift over the patch whatever the body's pitch or roll, because it is
   * the road under the car that it darkens. Returns how many it placed.
   */
  update(sources) {
    let n = 0, skipped = 0;
    const put = (world, plan) => {
      const e = world.elements;
      // A hidden pool slot is scaled to zero: no footprint for a car that is not there.
      const sx = Math.hypot(e[0], e[1], e[2]);
      if (!(sx > 1e-6) || n >= this.max) { skipped++; return; }
      const yaw = Math.atan2(e[8], e[10]);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const x = e[12] + c * plan.cx + s * plan.cz, z = e[14] - s * plan.cx + c * plan.cz;
      // The contact patch's height in the world: the body's own up axis times its local contact y,
      // from the origin. For a level car that is origin.y + plan.y; a pitched one moves it by
      // millimetres, and the footprint stays flat on the road either way.
      const y = e[13] + e[5] * plan.y + CONTACT.lift;
      _q.setFromAxisAngle(_p.set(0, 1, 0), yaw);
      _s.set(plan.w / this.unit.w, 1, plan.l / this.unit.l);
      _o.compose(_p.set(x, y, z), _q, _s);
      this.mesh.setMatrixAt(n++, _o);
    };
    for (const src of sources) {
      if (!src) continue;
      if (src.mesh) {
        const m = src.mesh;
        if (!m.visible) continue;
        m.updateMatrixWorld();
        const plan = src.plan ?? planCached(m.geometry);
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, _m);
          _w.multiplyMatrices(m.matrixWorld, _m);
          put(_w, plan);
        }
      } else if (src.object) {
        if (!src.object.visible) continue;
        src.object.updateMatrixWorld();
        put(src.object.matrixWorld, src.plan);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.stats.placed = n;
    let k = 0;
    for (const src of sources) if (src) k++;
    this.stats.sources = k;
    this.stats.skipped = skipped;
    return n;
  }

  report() {
    const tris = (this.geometry.index ? this.geometry.index.count : 0) / 3;
    return {
      visible: this.mesh.visible, placed: this.stats.placed, skipped: this.stats.skipped,
      trianglesEach: tris, triangles: this.mesh.visible ? tris * this.stats.placed : 0,
      core: CONTACT.core, ramp: CONTACT.ramp, lift: CONTACT.lift,
    };
  }
}
