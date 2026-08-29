// Locomotion state machine for the player character.
//
// Sequential owner: this reads controller state every frame, so it belongs to
// whoever owns the player controller (FEASIBILITY.md §1, piece 8b). A separate
// owner desyncs it from locomotion, which is the classic way third-person
// movement starts to feel wrong without anyone being able to say why.
//
// Animation is procedural: joint rotations driven by a phase accumulator, not
// sampled clips. That keeps it asset-free and lets blend weights be exact.

export const STATE = {
  IDLE: 'idle',
  WALK: 'walk',
  RUN: 'run',
  SPRINT: 'sprint',
  JUMP: 'jump',
  FALL: 'fall',
  LAND: 'land',
  ENTER_VEHICLE: 'enterVehicle',
  IN_VEHICLE: 'inVehicle',
  EXIT_VEHICLE: 'exitVehicle',
};

// Stride length per state, so the foot phase advances with distance travelled
// rather than with time. Feet stop sliding as a side effect.
const STRIDE = { walk: 1.55, run: 2.15, sprint: 2.55 };

export class LocomotionFSM {
  constructor() {
    this.state = STATE.IDLE;
    this.prev = STATE.IDLE;
    this.timeInState = 0;
    this.phase = 0;              // stride phase, radians
    this.blend = { idle: 1, walk: 0, run: 0, sprint: 0, air: 0 };
    this.lean = 0;               // body lean into acceleration
    this.turnLean = 0;
    this.landTimer = 0;
    this.transitionLock = 0;     // seconds during which state is forced
  }

  _set(next) {
    if (this.state === next) return;
    this.prev = this.state;
    this.state = next;
    this.timeInState = 0;
  }

  // Locked transitions (entering/exiting a vehicle) must run to completion, or a
  // player mashing the key mid-animation ends up half in the car.
  lockTransition(state, seconds) {
    this._set(state);
    this.transitionLock = seconds;
  }

  get locked() { return this.transitionLock > 0; }

  update(dt, ctx) {
    this.timeInState += dt;
    if (this.transitionLock > 0) {
      this.transitionLock = Math.max(0, this.transitionLock - dt);
      this._advanceBlends(dt);
      return this.state;
    }

    const { speed, grounded, verticalVelocity, inVehicle, running, sprinting, wishLength } = ctx;

    if (inVehicle) {
      this._set(STATE.IN_VEHICLE);
    } else if (!grounded) {
      this._set(verticalVelocity > 0.5 ? STATE.JUMP : STATE.FALL);
    } else if (this.state === STATE.FALL || this.state === STATE.JUMP) {
      this._set(STATE.LAND);
      this.landTimer = 0.22;
    } else if (this.landTimer > 0) {
      this.landTimer -= dt;
      if (this.landTimer <= 0) this._set(STATE.IDLE);
    } else if (wishLength < 0.05 || speed < 0.25) {
      this._set(STATE.IDLE);
    } else if (sprinting && speed > 5.6) {
      this._set(STATE.SPRINT);
    } else if (running && speed > 3.4) {
      this._set(STATE.RUN);
    } else {
      this._set(STATE.WALK);
    }

    // Phase advances with distance so the stride matches ground speed.
    const stride = STRIDE[this.state] ?? STRIDE.walk;
    if (this.state === STATE.WALK || this.state === STATE.RUN || this.state === STATE.SPRINT) {
      this.phase += (speed / stride) * Math.PI * dt * 2;
    } else if (this.state === STATE.IDLE) {
      this.phase += dt * 1.1;    // breathing idle
    }

    this._advanceBlends(dt, ctx);
    return this.state;
  }

  _advanceBlends(dt, ctx = {}) {
    // Blends are exponentially smoothed toward the target so state changes never
    // pop, and the renderer can mix poses continuously.
    const target = { idle: 0, walk: 0, run: 0, sprint: 0, air: 0 };
    switch (this.state) {
      case STATE.WALK: target.walk = 1; break;
      case STATE.RUN: target.run = 1; break;
      case STATE.SPRINT: target.sprint = 1; break;
      case STATE.JUMP:
      case STATE.FALL: target.air = 1; break;
      case STATE.LAND: target.idle = 0.6; target.air = 0.4; break;
      default: target.idle = 1;
    }
    const k = 1 - Math.exp(-14 * dt);
    for (const key of Object.keys(this.blend)) {
      this.blend[key] += (target[key] - this.blend[key]) * k;
    }

    const leanTarget = Math.min(1, (ctx.speed ?? 0) / 8) * 0.16;
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-6 * dt));
    const turnTarget = Math.max(-1, Math.min(1, (ctx.turnRate ?? 0) * 0.35));
    this.turnLean += (turnTarget - this.turnLean) * (1 - Math.exp(-8 * dt));
  }

  // Pose for a simple humanoid rig. Returns radians per joint; the character mesh
  // decides how to apply them, so a better rig can drop in without touching this.
  pose() {
    const b = this.blend;
    const p = this.phase;
    const moveAmount = b.walk + b.run + b.sprint;
    const amplitude = b.walk * 0.55 + b.run * 0.95 + b.sprint * 1.2;

    const swing = Math.sin(p) * amplitude;
    const counter = Math.sin(p + Math.PI) * amplitude;
    // Knees bend on the back half of the stride only.
    const kneeL = Math.max(0, -Math.sin(p)) * amplitude * 1.1;
    const kneeR = Math.max(0, -Math.sin(p + Math.PI)) * amplitude * 1.1;
    const bob = Math.abs(Math.sin(p)) * (b.walk * 0.03 + b.run * 0.06 + b.sprint * 0.08);
    const breathe = Math.sin(this.phase * 0.9) * 0.02 * b.idle;

    return {
      hipY: bob + breathe,
      spinePitch: this.lean + b.sprint * 0.18 + b.air * 0.1,
      spineRoll: this.turnLean * 0.12,
      legL: swing, legR: counter,
      kneeL, kneeR,
      armL: counter * 0.7 - b.air * 0.5,
      armR: swing * 0.7 - b.air * 0.5,
      elbowL: 0.25 + moveAmount * 0.35,
      elbowR: 0.25 + moveAmount * 0.35,
      headYaw: 0,
      moveAmount,
    };
  }
}
