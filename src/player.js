// Kinematic capsule character controller. Deliberately NOT a rigid body: on-foot
// movement wants direct, responsive control, and mixing it into the vehicle
// solver is the classic way to end up with a floaty player.

import * as THREE from '../vendor/three.module.js';

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

  update(dt, input, cameraYaw, ground, colliders) {
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

    // Horizontal collision against axis-aligned boxes (buildings, kerbs, the car).
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
