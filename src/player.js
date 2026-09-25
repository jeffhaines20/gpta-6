// Kinematic capsule character controller. Deliberately NOT a rigid body: on-foot
// movement wants direct, responsive control, and mixing it into the vehicle
// solver is the classic way to end up with a floaty player.

import * as THREE from '../vendor/three.module.min.js';

export class Player {
  constructor() {
    this.position = new THREE.Vector3(0, 0, -6);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;              // facing, radians
    this.radius = 0.35;
    this.height = 1.8;
    this.walkSpeed = 3.2;
    this.runSpeed = 7.0;
    this.accel = 26;
    this.grounded = true;
    this.gravity = -22;
    this.jumpSpeed = 6.2;
    this.moveAmount = 0;       // 0..1, drives the walk-cycle animation
    this.phase = 0;
  }

  update(dt, input, cameraYaw, ground, colliders, blockers = null) {
    const axis = input.moveAxis();
    const running = input.down('ShiftLeft') || input.down('ShiftRight');
    const target = running ? this.runSpeed : this.walkSpeed;

    // Movement is camera-relative: this is what makes third-person feel right.
    const sin = Math.sin(cameraYaw), cos = Math.cos(cameraYaw);
    const wishX = axis.x * cos - axis.y * sin;
    const wishZ = axis.x * sin + axis.y * cos;
    const wishLen = Math.hypot(wishX, wishZ);

    const desiredX = wishLen > 0 ? (wishX / wishLen) * target : 0;
    const desiredZ = wishLen > 0 ? (wishZ / wishLen) * target : 0;

    const a = this.accel * dt;
    this.velocity.x += THREE.MathUtils.clamp(desiredX - this.velocity.x, -a, a);
    this.velocity.z += THREE.MathUtils.clamp(desiredZ - this.velocity.z, -a, a);

    if (wishLen > 0.01) {
      const want = Math.atan2(wishX, wishZ);
      let d = want - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, 16 * dt);
    }

    if (this.grounded && input.hit('Space')) {
      this.velocity.y = this.jumpSpeed;
      this.grounded = false;
    }
    this.velocity.y += this.gravity * dt;

    this.position.addScaledVector(this.velocity, dt);

    /**
     * WALLS FIRST, as real line segments, when an index is given.
     *
     * WHAT THIS REPLACES. Until src/blockers.js existed, district/main.js handed this
     * loop the axis-aligned BOUNDING BOX of every nearby building footprint, which
     * fills in every notch of every L-shaped site. Measured over the whole district:
     * 142,932 m2 of area inside some box and outside every polygon, 30.9% of all box
     * area, and along road centrelines sampled every 2 m a body-sized circle could not
     * fit at 1,806 of 24,517 points against 64 for the real walls. The player has been
     * walking into invisible corners for as long as this file has had collision.
     *
     * Iterated twice: once to leave the wall, once for the corner the first push may
     * have moved into. src/blockers.js's own resolveCircle already iterates internally
     * for a single circle; the second pass here is for the case where the box loop
     * below then pushes the body back into a wall.
     */
    if (blockers) {
      const hit = blockers.resolveCircle(this.position.x, this.position.z, this.radius);
      if (hit) { this.position.x = hit.x; this.position.z = hit.z; }
    }

    // Horizontal collision against axis-aligned boxes (the car, and anything else a
    // caller hands over that genuinely IS a box).
    for (const c of colliders) {
      const dx = this.position.x - c.x;
      const dz = this.position.z - c.z;
      const px = c.hx + this.radius - Math.abs(dx);
      const pz = c.hz + this.radius - Math.abs(dz);
      if (px > 0 && pz > 0 && this.position.y < c.y + c.hy) {
        if (px < pz) this.position.x += Math.sign(dx || 1) * px;
        else this.position.z += Math.sign(dz || 1) * pz;
      }
    }
    // A box push can put the body back into a wall — walking behind a parked car
    // against a shopfront is exactly that case.
    if (blockers) {
      const again = blockers.resolveCircle(this.position.x, this.position.z, this.radius);
      if (again) { this.position.x = again.x; this.position.z = again.z; }
    }

    const floor = ground.heightAt(this.position.x, this.position.z);
    if (this.position.y <= floor) {
      this.position.y = floor;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveAmount = THREE.MathUtils.clamp(planar / this.runSpeed, 0, 1);
    this.phase += planar * dt * 1.9;
  }
}
