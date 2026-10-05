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
/**
 * WHEN THE GAME SHOULD TELL A PLAYER THEY ARE JAMMED. Derivations in `_trackJam`, which carries
 * the sweep that chose the throttle threshold.
 *
 * `STUCK_HOLD_S` IS THE SAME BEAT `BUST_HOLD_S` AND `WRECK_HOLD_S` ARE — "the game has taken
 * over and is about to tell you something" — and it is declared here rather than imported so
 * that src/vehicle.js does not have to know about the law. That is the arrangement
 * `LAW_NOTICE_S` already uses against src/hud.js's `escalateSeconds`: two constants in two
 * modules, with `tools/hud-cue.mjs` — the one gate that imports both — asserting they are equal
 * rather than leaving it to a comment.
 *
 * `STUCK_SPEED_MS` is src/wanted.js's `SCENE_STOP_MS`, the same way: this file's own statement
 * of "not moving", gated against that one.
 */
export const STUCK_HOLD_S = 4.0;
export const STUCK_THROTTLE = 0.5;
export const STUCK_SPEED_MS = 1.0;
/**
 * AND A JAM IS NOT A CONTACT EVERY STEP, which the first version of `_trackJam` assumed and so
 * never fired on a real pin. A wedged car rocks against the wall: measured in a 4 m bay at 120 Hz,
 * a sample is corrected on 77.0% of steps at full throttle and the contact-free gaps are
 *
 *     p50 0.0167 s   p95 0.0333 s   worst 0.0333 s = 4 steps
 *
 * stable at throttle 1, 0.75 and 0.5 (77.0 / 77.2 / 78.7% touched). Resetting on the first
 * contact-free step therefore reset the clock about 350 times in 30 s and `stuckFor` never got
 * past one step.
 *
 * 0.05 s IS `district/main.js`'s OWN dt CLAMP — "a contact within the last frame the host could
 * possibly have taken" — and it clears the measured worst gap by x1.5. It is not load-bearing in
 * the other direction: the clock also requires the car to be under `STUCK_SPEED_MS`, and a
 * legitimate pull-away at the throttle threshold clears that in 0.400 s, a tenth of the dwell. So
 * there is no value of this between the noise and the signal where the cue could fire wrongly.
 * `tools/blocker-test.mjs` re-measures the gap and fails if it grows past this.
 */
export const STUCK_CONTACT_GRACE_S = 0.05;

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
    /**
     * REVERSE IS ONE SHORT GEAR, AND IT WAS NOT A GEAR AT ALL. The drive force was symmetric in
     * the throttle's sign, so reverse accelerated exactly like forward and kept going: a
     * playtester measured it at 17 34 48 62 73 84 93 101 108 114 119 123 127 130 km/h, one
     * reading a second, and wrote it up as "reverse is not a gear, it is negative throttle with
     * full engine power".
     *
     * A real car's reverse tops out in the thirties because there is a single short ratio and
     * nothing to change up into. The force is therefore tapered to zero as the reverse road speed
     * approaches this, which is a gear rather than a governor: full torque off the mark, where
     * reverse is actually used, and nothing left at the top. The terminal speed is a little under
     * it, where the taper meets the rolling drag.
     *
     * 8.3 m/s is 30 km/h. It has to stay well above src/roadpath.js's reverse manoeuvre, which
     * backs out of an unreachable aim point at 0.35 of throttle and needs only a few m/s.
     */
    this.reverseMax = opts.reverseMax ?? 8.3;
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
    // Seconds the car has been pressing geometry under power without moving, and which way it
    // was being asked to go. See `_trackJam` and `composeStuck`.
    this.stuckFor = 0;
    this.stuckDir = 0;
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
  /**
   * ROAD SPEED: the horizontal magnitude, which is what a speedometer reads.
   *
   * `speed` is the 3-D magnitude and that is right for the physics — src/damage.js prices an
   * impact off it, and a car landing hard really is moving that fast. It is wrong on a dial. The
   * spawn sets y = 0.550 while the suspension rests at 0.717, so for the first second of every
   * session the springs push the body up at 1.84 m/s and the speedo reads 7 km/h ON A PARKED CAR.
   * A playtester led its "small things that read as bugs from the seat" list with it.
   *
   * The same conflation was a real fault one layer up: district/main.js used to hand
   * `vehicle.speed` to the crowd as the impact speed, so a car landing hard threw a pedestrian
   * its full 3-D speed sideways and could cross the fatality line on vertical velocity alone.
   */
  get roadSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }
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
    /**
     * A bent corner drags, and `src/damage.js` caps that at a quarter of the steering authority so
     * it is a handicap the player can hold against rather than a loss of control.
     *
     * IT WAS A QUARTER OF THE WRONG QUANTITY. The player's input is scaled by `speedFactor` and
     * the pull was not, so the cap was a quarter of the RAW `maxSteer` while the authority the
     * player actually commands shrinks with speed. As a fraction of what is available to hold it
     * with:
     *
     *       km/h   speedFactor   player's full lock   pull at the cap   pull / player
     *          0         1.000                1.000             0.250           25.0%
     *         50         0.673                0.673             0.250           37.2%
     *        100         0.507                0.507             0.250           49.3%
     *        140         0.424                0.424             0.250           59.0%
     *
     * A playtester called it violent and that is what they were feeling: at 140 km/h it is 2.4
     * times the handicap the derivation claims, and going straight costs 59% of the wheel.
     *
     * The comment's other claim does survive, and it is worth writing down because it bounds how
     * bad this was: full opposite lock nets -0.423 of maxSteer at 50 km/h, -0.257 at 100 and
     * -0.174 at 140, so the pull was always holdable. It was a bigger handicap than stated, not a
     * loss of control. One 10 m/s one-sided impact is enough to reach the cap.
     *
     * Scaling the pull by the same `speedFactor` makes the cap mean what it says at every speed.
     * With no damage model attached `steerPull` is exactly zero, so this whole term is a `+ 0` and
     * tools/golden-trace.mjs stays bit-identical.
     */
    const target = (steer * this.maxSteer + this.steerPull * this.maxSteer) * speedFactor;
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
      if (w.drive) {
        let t = this.throttle;
        // The reverse gear's taper. See `reverseMax`.
        if (t < 0 && this.reverseMax > 0) {
          const rev = Math.max(0, -vLong);
          t *= THREE.MathUtils.clamp(1 - rev / this.reverseMax, 0, 1);
        }
        longForce += t * this.engineForce * this.enginePower * 0.5;
      }
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
    const contactsIn = this.contacts;
    if (this.blockers) this._collideBody();
    this._trackJam(dt, this.contacts > contactsIn);
  }

  /**
   * HOW LONG THE CAR HAS BEEN PRESSING SOMETHING UNDER POWER AND NOT MOVING.
   *
   * A blind playtester rebuilt one pin five times and held each control for 30 s:
   *
   *     full throttle forward     0.34 m
   *     full reverse            145.15 m
   *
   * with engine power at 0.46 — not powerless, just pointed at a wall — and 34,296 wall
   * contacts over 360 s of which 34,295 charged nothing, so the car presses a wall at about 96
   * contacts a second for free. The game already has the word: `src/wanted.js`'s `composeLaw`
   * prints "BUSTED IN — 4 s / reverse" for a driver who has tried the throttle, and that is the
   * only place in the game reverse is ever suggested — available only once an arrest is already
   * running. So the fix is one tenant away, and this is the half that belongs to the car.
   *
   * THREE CONDITIONS, AND THE CONTACT IS THE ONE THAT DOES THE WORK. An unobstructed car
   * pulling away gently is also slow with the throttle open; what it is not is pressing
   * anything. `contacts` rises in `_collideBody` only when a sample is actually corrected, so
   * requiring it removes the whole false-positive class rather than dialling a threshold
   * against it.
   *
   * PLANAR SPEED, not `this.speed`, which is the 3D velocity length: a car settling on its
   * suspension reads over any threshold from vertical motion alone, and a jam is a question
   * about travel. The first version of the measurement below read one frame everywhere for
   * exactly that reason.
   *
   * THE THROTTLE THRESHOLD IS 0.5 AND IT IS NOT `composeLaw`'s 0.05, which was the obvious
   * reuse and is wrong here. 0.05 asks "did they touch it"; this asks "are they holding it
   * down", and the difference is a measurement. Full brake to rest then full power, time spent
   * under `SCENE_STOP_MS`, flat across entry speed because the last metre per second of a
   * braking curve does not depend on where it started:
   *
   *     throttle  1.00   0.75   0.50   0.40   0.30   0.25   0.10   0.05   -1.00
   *     seconds  0.200  0.267  0.408  0.508  0.683  0.825  2.158  4.658   0.217
   *
   * At 0.05 a legitimate crawl away spends 4.658 s under the threshold — LONGER than the dwell
   * below — so the bust's constant would make this cue fire on a player driving off carefully.
   * At 0.5 the worst honest pull-away is 0.408 s, which the dwell clears by x9.8.
   */
  _trackJam(dt, touched) {
    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    const pushing = Math.abs(this.throttle) >= STUCK_THROTTLE;
    // Time since a body sample was last corrected. A wedged car rocks, so it is contact-free on
    // about a quarter of steps; see STUCK_CONTACT_GRACE_S for the measurement.
    this._sinceContact = touched ? 0 : (this._sinceContact ?? Infinity) + dt;
    if (this._sinceContact <= STUCK_CONTACT_GRACE_S && pushing && planar < STUCK_SPEED_MS) {
      this.stuckFor += dt;
      // The direction being tried, so the cue can name the other one. Signed, and latched with
      // the clock rather than read live, so a player who lifts off mid-cue does not flip the
      // word they are reading.
      this.stuckDir = Math.sign(this.throttle);
    } else {
      this.stuckFor = 0;
      this.stuckDir = 0;
    }
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

/**
 * THE BAND LINE FOR A JAMMED CAR, and it lives here for the reason `composeLaw` lives in
 * src/wanted.js: presentation assembled inside district/main.js is presentation the node harness
 * cannot reproduce, and when `composeBand` lived there four of its five tenants were missing from
 * `look()` — so the harness was harder to play than the game.
 *
 * `ownSubtitle` BECAUSE THE SUBTITLE IS THE WHOLE POINT. src/hud.js's `HOLDS_MISSION_SUBTITLE`
 * hands a running mission's objective to the subtitle of any tenant above it, and that rule ate
 * `composeLaw`'s "reverse" for a whole round — a blind playtester measured the word `drive` in 0
 * of them. One word is the entire content of this line; a reminder of what the player was doing
 * before they got wedged is not.
 *
 * NAMES THE DIRECTION NOT BEING TRIED, which is the measurement: forward moved the car 0.34 m
 * and reverse moved it 145.15 m from the same pin. The same two words `composeLaw` uses, so a
 * player who has seen one has read the other.
 *
 * @param {{stuckFor:number, stuckDir:number}} v  a Vehicle, or anything carrying those two.
 */
export function composeStuck(v) {
  if (!v || !((v.stuckFor ?? 0) >= STUCK_HOLD_S)) return null;
  return {
    objective: { text: 'THE CAR IS WEDGED' },
    // Signed: a nose-in jam is told to reverse, a tail-in jam to drive. `stuckDir` is latched
    // with the clock, so lifting off does not flip the word mid-read.
    subtitle: (v.stuckDir ?? 0) < 0 ? 'drive' : 'reverse',
    ownSubtitle: true,
  };
}
