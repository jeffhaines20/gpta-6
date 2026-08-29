// Raycast vehicle. A single rigid body (position, quaternion, linear + angular
// velocity) with four suspension raycasts. Each wheel contributes a suspension
// spring/damper force plus a tyre friction force resolved into longitudinal and
// lateral components. No external physics engine: this is the whole model.
//
// This is deliberately the highest-risk module in the project, which is why it
// gets built first and gets one sequential owner.

import * as THREE from '../vendor/three.module.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _tq = new THREE.Vector3();
const _qi = new THREE.Quaternion();

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
    const target = steer * this.maxSteer * speedFactor;
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
      if (w.drive) longForce += this.throttle * this.engineForce * 0.5;
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
  }
}
