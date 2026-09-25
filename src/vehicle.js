// Raycast vehicle. A single rigid body (position, quaternion, linear + angular
// velocity) with four suspension raycasts. Each wheel contributes a suspension
// spring/damper force plus a tyre friction force resolved into longitudinal and
// lateral components. No external physics engine: this is the whole model.
//
// This is deliberately the highest-risk module in the project, which is why it
// gets built first and gets one sequential owner.
//
// BODY COLLISION IS OPT-IN, AND THAT IS NOT LAZINESS. Set `vehicle.blockers` to a
// src/blockers.js index and the body collides with building walls; leave it null and
// every line below behaves exactly as it did before that module existed. Same for
// `vehicle.damage`. tools/golden-trace.mjs drives this class against a FlatGround with
// neither set, and that trace is the only regression gate handling has, so the
// untouched path has to be literally untouched — not "equivalent".

import * as THREE from '../vendor/three.module.min.js';
import { contactImpulse } from './blockers.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _tq = new THREE.Vector3();
const _qi = new THREE.Quaternion();
// Collision scratch. Private to _collideBody for the reason applyImpulseAt's own
// comment gives: sharing a scratch vector with a caller turned `offset.cross(impulse)`
// into a self-cross and silently removed all suspension torque.
const _cf = new THREE.Vector3();
const _cr = new THREE.Vector3();
const _ci = new THREE.Vector3();
const _co = new THREE.Vector3();

/**
 * THE BODY COLLIDER: five circles of radius 0.95 m on the body axis, at z = -1.2 to
 * +1.2, approximating the 1.9 x 4.3 m box as a 4.3 m stadium.
 *
 * FIVE, BECAUSE TWO LEAVES A 950 MM HOLE IN THE MIDDLE OF THE CAR. "A circle at each
 * end" is the obvious collider and it is catastrophic: with the end circles placed so
 * they reach the nose and tail (centres at +/-1.2, r 0.95) the deepest point of the
 * gap between them is 0.95 m from the axis, which is the entire half-width. A wall
 * segment is a line with no thickness, so it slots straight into that gap and the car
 * drives through its own midships. Worst side notch against circle count:
 *
 *     n=2   950 mm      n=4    88 mm      n=6   31 mm
 *     n=3   213 mm      n=5    49 mm      n=7   21 mm
 *
 * 49 mm is below anything a player can see at this scale and five lookups is 600 a
 * second, which the blocker gate prices at 0.25 ms of wall clock per second on open
 * road. The cost of n=7 is not the objection; 49 mm simply is not a defect.
 *
 * WHAT THIS SHAPE GETS WRONG, stated rather than discovered later: a circle centred on
 * the axis cannot reach a square corner, so the nose and tail CORNERS at (+/-0.95,
 * +/-2.15) sit 0.394 m outside the collider. Tucking a front corner diagonally into a
 * building corner therefore overlaps the visible body by up to that much before
 * anything resists. It is a rounded car, and it is 20 times better than the hole.
 */
export const BODY_SAMPLES = Object.freeze([-1.2, -0.6, 0, 0.6, 1.2]);
export const BODY_RADIUS = 0.95;
/** Enclosing radius from the body centre: hypot(0.95, 2.15). The early-out. */
export const BODY_ENCLOSING = 2.36;

const WHEEL_LAYOUT = [
  { x: -0.78, z:  1.32, steer: true,  drive: false, brake: 0.6 },
  { x:  0.78, z:  1.32, steer: true,  drive: false, brake: 0.6 },
  { x: -0.80, z: -1.30, steer: false, drive: true,  brake: 0.4 },
  { x:  0.80, z: -1.30, steer: false, drive: true,  brake: 0.4 },
];

export class Vehicle {
  constructor(opts = {}) {
    this.position = new THREE.Vector3(0, 1.0, 0);
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();

    this.mass = opts.mass ?? 1400;
    this.invMass = 1 / this.mass;
    // Box inertia for a 1.9 x 1.2 x 4.3 body, scaled up in yaw for stability.
    const w = 1.9, h = 1.2, l = 4.3;
    this.inertia = new THREE.Vector3(
      (this.mass / 12) * (h * h + l * l),
      (this.mass / 12) * (w * w + l * l) * 1.35,
      (this.mass / 12) * (w * w + h * h)
    );
    this.invInertia = new THREE.Vector3(1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z);

    this.suspRest = 0.42;
    this.suspStiff = 42000;     // N/m
    this.suspDamp = 4200;       // N/(m/s)
    this.suspMaxTravel = 0.30;
    this.wheelRadius = 0.36;

    this.engineForce = 7000;    // N at the driven axle
    this.brakeForce = 7000;
    this.maxSteer = 0.55;       // radians
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;

    /**
     * Collision restitution and wall friction. 0.15 is a plastic crash: a car hitting
     * concrete does not bounce, it crumples, which is also why damage.js's barrier
     * anchors are quoted at restitution 0. Wall friction 0.4 is what makes a scrape
     * cost speed instead of being free.
     */
    this.wallRestitution = opts.wallRestitution ?? 0.15;
    this.wallFriction = opts.wallFriction ?? 0.4;
    /** Opt-in, both of them. See the header. */
    this.blockers = opts.blockers ?? null;
    this.damage = opts.damage ?? null;
    this.contacts = 0;
    this.lastContact = null;
    /** The worst APPLIED impact since the host last cleared it. See _collideBody. */
    this.pendingImpact = null;

    this.gravity = -19.6;       // 2g: arcade weight, keeps the car planted
    this.wheels = WHEEL_LAYOUT.map((w) => ({
      ...w,
      contact: false,
      compression: 0,
      suspLen: this.suspRest,
      worldPos: new THREE.Vector3(),
      spinAngle: 0,
      slip: 0,
    }));
  }

  /** 1 with no damage model attached; see src/damage.js for why it reads FRONT. */
  get enginePower() { return this.damage ? this.damage.enginePower : 1; }
  /** 0 with no damage model attached. */
  get steerPull() { return this.damage ? this.damage.steerPull : 0; }

  get speed() { return this.velocity.length(); }
  get forwardSpeed() {
    return this.velocity.dot(_v1.set(0, 0, 1).applyQuaternion(this.quaternion));
  }

  applyImpulseAt(impulse, worldOffset) {
    this.velocity.addScaledVector(impulse, this.invMass);
    // NOTE: _tq is private to this method. Using a scratch vector that a caller
    // might also hold made `offset.cross(impulse)` a self-cross (== zero), which
    // silently removed all suspension torque. Do not "optimise" this back.
    const torque = _tq.copy(worldOffset).cross(impulse);
    // Rotate torque into body space, scale by inverse inertia, rotate back.
    const inv = _qi.copy(this.quaternion).invert();
    torque.applyQuaternion(inv);
    torque.set(torque.x * this.invInertia.x, torque.y * this.invInertia.y, torque.z * this.invInertia.z);
    torque.applyQuaternion(this.quaternion);
    this.angularVelocity.add(torque);
  }

  setControls({ throttle = 0, brake = 0, steer = 0, handbrake = false }) {
    this.throttle = THREE.MathUtils.clamp(throttle, -1, 1);
    this.brake = THREE.MathUtils.clamp(brake, 0, 1);
    // Steering authority falls off with speed so the car is not twitchy at 120 km/h.
    const speedFactor = 1 / (1 + Math.abs(this.forwardSpeed) * 0.035);
    // A bent corner drags. src/damage.js caps this at a quarter of the steering
    // authority, so it is a handicap the player can hold against, not a loss of
    // control; with no damage model attached it is exactly zero and this line is a
    // `+ 0`, which is what keeps tools/golden-trace.mjs bit-identical.
    const target = steer * this.maxSteer * speedFactor + this.steerPull * this.maxSteer;
    this._steerTarget = target;
    this.handbrake = handbrake;
  }

  // Fixed-timestep driver. Vehicle handling MUST NOT depend on render rate:
  // measured divergence with a variable dt was ~40 m of path error over 8 s
  // between 30 Hz and 120 Hz. Callers should use this, never step() directly.
  stepFixed(wallDt, ground, hz = 120) {
    const fixed = 1 / hz;
    this._acc = (this._acc ?? 0) + Math.min(wallDt, 0.25);
    let n = 0;
    while (this._acc >= fixed && n < 16) { this.step(fixed, ground); this._acc -= fixed; n++; }
    return n;
  }

  step(dt, ground) {
    // Frame-rate independent steering rate (was a fixed per-frame lerp).
    const k = 1 - Math.exp(-14 * dt);
    this.steer += ((this._steerTarget ?? 0) - this.steer) * k;

    const up = _v1.set(0, 1, 0);
    this.velocity.y += this.gravity * dt;

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion);
    const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);

    let groundedWheels = 0;
    for (const w of this.wheels) {
      // Wheel anchor in world space.
      const offset = new THREE.Vector3()
        .addScaledVector(right, w.x)
        .addScaledVector(bodyUp, -0.10)
        .addScaledVector(fwd, w.z);
      const anchor = new THREE.Vector3().copy(this.position).add(offset);

      const maxLen = this.suspRest + this.suspMaxTravel;
      const hit = ground.raycastDown(anchor, maxLen + this.wheelRadius);
      w.contact = !!hit;

      if (!hit) {
        w.suspLen = maxLen;
        w.compression = 0;
        w.worldPos.copy(anchor).addScaledVector(bodyUp, -w.suspLen);
        w.slip = 0;
        continue;
      }
      groundedWheels++;

      const dist = anchor.y - hit.y - this.wheelRadius;
      const len = THREE.MathUtils.clamp(dist, 0, maxLen);
      const compression = this.suspRest - len;
      const suspVel = (w.suspLen - len) / dt;
      w.suspLen = len;
      w.compression = compression;
      w.worldPos.copy(anchor).addScaledVector(bodyUp, -(len));

      // --- Suspension force (along world up, projected onto the contact normal).
      let springN = compression * this.suspStiff + suspVel * this.suspDamp;
      springN = Math.max(0, Math.min(springN, this.mass * 60));
      const suspImpulse = _v2.copy(up).multiplyScalar(springN * dt);
      this.applyImpulseAt(suspImpulse, offset);

      // --- Tyre forces. Build the wheel's own basis (steered).
      const steerAngle = w.steer ? this.steer : 0;
      const wFwd = fwd.clone().applyAxisAngle(up, steerAngle).normalize();
      const wRight = right.clone().applyAxisAngle(up, steerAngle).normalize();

      // Contact-point velocity = linear + angular x r.
      const contactVel = _v3.copy(this.angularVelocity).cross(offset).add(this.velocity);
      const vLat = contactVel.dot(wRight);
      const vLong = contactVel.dot(wFwd);

      // Friction budget scales with normal load (a crude but stable friction circle).
      const load = springN;
      const grip = this.handbrake && !w.steer ? 0.35 : 1.15;
      const maxFriction = load * grip;

      // Lateral: resist sideways slide. Impulse-style so it cannot overshoot.
      let latForce = -vLat * this.mass * 0.55 / Math.max(dt, 1e-4) * 0.02;
      // Longitudinal: engine, brake, rolling resistance.
      let longForce = 0;
      if (w.drive) longForce += this.throttle * this.engineForce * this.enginePower * 0.5;
      if (this.brake > 0) longForce += -Math.sign(vLong) * this.brake * this.brakeForce * w.brake;
      if (this.handbrake && !w.steer) longForce += -Math.sign(vLong) * this.brakeForce * 0.18;
      longForce += -vLong * 22; // rolling drag

      // Clamp the combined force into the friction circle.
      const mag = Math.hypot(latForce, longForce);
      if (mag > maxFriction && mag > 0) {
        const s = maxFriction / mag;
        latForce *= s;
        longForce *= s;
      }
      w.slip = mag > 0 ? Math.min(1, mag / Math.max(maxFriction, 1)) : 0;

      const tyreImpulse = new THREE.Vector3()
        .addScaledVector(wRight, latForce * dt)
        .addScaledVector(wFwd, longForce * dt);
      this.applyImpulseAt(tyreImpulse, offset);

      // Visual wheel spin.
      w.spinAngle += (vLong / this.wheelRadius) * dt;
    }

    this.grounded = groundedWheels > 0;

    // Aerodynamic drag + angular damping.
    const dragK = 0.95;
    this.velocity.addScaledVector(this.velocity, -dragK * this.speed * dt * this.invMass * 2.2);
    this.angularVelocity.multiplyScalar(Math.max(0, 1 - 2.6 * dt));

    // Self-righting: gently pull the body upright when airborne or rolled.
    if (groundedWheels < 3) {
      const tilt = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
      const corrective = tilt.clone().cross(up).multiplyScalar(2.4 * dt);
      this.angularVelocity.add(corrective);
    }

    // Integrate.
    this.position.addScaledVector(this.velocity, dt);
    const w = this.angularVelocity;
    const spin = _q1.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(this.quaternion);
    this.quaternion.set(
      this.quaternion.x + spin.x,
      this.quaternion.y + spin.y,
      this.quaternion.z + spin.z,
      this.quaternion.w + spin.w
    ).normalize();

    // Floor clamp so a bad frame can never drop the car through the world.
    const floor = ground.heightAt(this.position.x, this.position.z);
    if (this.position.y < floor + 0.35) {
      this.position.y = floor + 0.35;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    // Body collision LAST, after integration, so it corrects a position that has
    // already moved rather than a velocity that has not yet been applied. Opt-in: with
    // no index attached this is one property read and a return.
    if (this.blockers) this._collideBody();
  }

  /**
   * Resolve the body collider against static walls and charge the damage model.
   *
   * ONE CHARGE PER STEP, NOT PER SAMPLE. Five circles hitting the same wall in the
   * same fixed step is one crash, and charging each of them would multiply every
   * impact by up to five while looking entirely reasonable in the code. The deepest
   * contact's delta-v and its body-space direction are what the damage model is told.
   *
   * SAMPLES ARE RESOLVED IN SEQUENCE against a position that is updated as it goes,
   * so a later sample sees the correction the earlier one made. Resolving them all
   * against the entry position and then summing double-counts a flat wall by up to
   * five times the penetration and launches the car.
   */
  _collideBody() {
    const px = this.position.x, pz = this.position.z;
    // THE SPEED THE DAMAGE MODEL IS TOLD IS THE PRE-COLLISION SPEED, captured here.
    // Reading `this.speed` at the bottom of this method, which is what the first draft
    // did, reports the speed AFTER every sample's impulse has been applied: a 15 km/h
    // wall hit passed `2.3 km/h`, because by then the wall had already stopped the car.
    // damage.js reads it for one thing only — the pedestrian fatality line, which is a
    // statement about how fast the bumper was travelling — so the post-collision figure
    // would have quietly moved that line from 45 km/h to something like 250.
    const speedIn = this.speed;
    // Whole-body early out: one grid lookup covers all five samples, and on open road
    // — which is almost every frame of a drive — this is where it returns.
    if (!this.blockers.anyNear(px, pz, BODY_ENCLOSING + BODY_RADIUS)) return;

    const fwd = _cf.set(0, 0, 1).applyQuaternion(this.quaternion);
    const right = _cr.set(1, 0, 0).applyQuaternion(this.quaternion);
    let worstDv = 0, worstLocalZ = 1, worstLocalX = 0, any = false;

    for (const sz of BODY_SAMPLES) {
      const sx = this.position.x + fwd.x * sz;
      const sw = this.position.z + fwd.z * sz;
      const res = this.blockers.resolveCircle(sx, sw, BODY_RADIUS);
      if (!res) continue;
      any = true;
      // Push the whole body by the sample's correction. Rotating instead would be
      // more faithful and is not stable at this step size: a 0.3 m correction at a
      // 1.2 m lever arm is 14 degrees of yaw in one frame.
      this.position.x += res.x - sx;
      this.position.z += res.z - sw;

      // THE CONTACT POINT IS ON THE CIRCLE, NOT AT ITS CENTRE, and the first draft of
      // this used the centre. The consequence was invisible in the position — the
      // car stopped at the wall correctly — and wrong everywhere else: the sample
      // offsets lie on the body axis, so every contact reported a lever arm with no
      // lateral component, which means every crash in the district was filed as pure
      // front or pure rear damage, `steerPull` could never leave zero, and a
      // 50 km/h clip at 31 degrees imparted 0.0016 rad/s of yaw instead of spinning
      // the car. The crash gate's region and yaw checks are what found it.
      const cx = res.x - res.nx * BODY_RADIUS, cz = res.z - res.nz * BODY_RADIUS;
      const ox = cx - this.position.x, oz = cz - this.position.z;
      const imp = contactImpulse({
        vx: this.velocity.x, vz: this.velocity.z,
        rx: ox, rz: oz, nx: res.nx, nz: res.nz,
        mass: this.mass, inertiaY: this.inertia.y,
        restitution: this.wallRestitution, friction: this.wallFriction,
        omega: this.angularVelocity.y,
      });
      if (!imp) continue;
      this.applyImpulseAt(_ci.set(imp.jx, 0, imp.jz), _co.set(ox, 0, oz));
      if (imp.dv > worstDv) {
        worstDv = imp.dv;
        // Body-space direction from the centre toward the contact.
        worstLocalX = ox * right.x + oz * right.z;
        worstLocalZ = ox * fwd.x + oz * fwd.z;
      }
    }
    if (!any) return;
    this.contacts++;
    this.lastContact = { dv: worstDv, localX: worstLocalX, localZ: worstLocalZ,
      x: this.position.x, z: this.position.z,
      movedX: this.position.x - px, movedZ: this.position.z - pz };
    if (this.damage && worstDv > 0) {
      const rec = this.damage.impact({ dv: worstDv, kind: 'wall',
        dirX: worstLocalX, dirZ: worstLocalZ, speed: speedIn });
      // THE HOST CANNOT READ damage.lastImpact FOR THIS, and the reason is stepFixed.
      // One rendered frame is up to 16 fixed substeps, and damage.lastImpact is
      // overwritten by every impact including the rejected ones — so a real crash
      // followed by one below-threshold scrape in the same frame leaves the host
      // looking at the scrape. `pendingImpact` only ever holds an APPLIED record, and
      // keeps the worst of them until whoever consumes it clears it.
      if (rec.applied && (!this.pendingImpact || rec.severity > this.pendingImpact.severity)) {
        this.pendingImpact = rec;
      }
    }
  }
}
