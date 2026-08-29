// Third-person spring-arm camera. Orbit yaw/pitch from the mouse, a boom that
// shortens when it would clip geometry, and a smoothed follow target.
// One camera rig serves both modes; only its tuning constants swap.

import * as THREE from '../vendor/three.module.min.js';

const FOOT = { dist: 4.6, height: 1.55, lag: 14, fov: 62, shoulder: 0.55 };
const CAR  = { dist: 8.2, height: 2.55, lag: 5.5, fov: 68, shoulder: 0.0 };

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.16;
    this.sensitivity = 0.0022;
    this.focus = new THREE.Vector3();
    this.mode = 'foot';
    this.dist = FOOT.dist;
    this.autoAlign = 0;
  }

  get tuning() { return this.mode === 'car' ? CAR : FOOT; }

  handleMouse(input) {
    this.yaw -= input.mouseDX * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + input.mouseDY * this.sensitivity, -0.55, 0.95
    );
  }

  // targetYaw lets the car gently pull the camera behind it when driving forward.
  update(dt, targetPos, ground, targetYaw = null, alignStrength = 0) {
    const t = this.tuning;
    if (targetYaw !== null && alignStrength > 0) {
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, alignStrength * dt);
    }

    this.focus.lerp(targetPos, Math.min(1, t.lag * dt));

    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp
    );

    const pivot = this.focus.clone();
    pivot.y += t.height;
    if (t.shoulder) {
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      pivot.addScaledVector(right, t.shoulder);
    }

    // Boom collision: pull in if the ground rises into the arm.
    let want = t.dist;
    const probe = pivot.clone().addScaledVector(dir, want);
    const gy = ground.heightAt(probe.x, probe.z);
    if (probe.y < gy + 0.6) want *= 0.6;
    this.dist += (want - this.dist) * Math.min(1, 8 * dt);

    const pos = pivot.clone().addScaledVector(dir, this.dist);
    const minY = ground.heightAt(pos.x, pos.z) + 0.7;
    if (pos.y < minY) pos.y = minY;

    this.camera.position.copy(pos);
    this.camera.lookAt(pivot);
    if (Math.abs(this.camera.fov - t.fov) > 0.05) {
      this.camera.fov += (t.fov - this.camera.fov) * Math.min(1, 6 * dt);
      this.camera.updateProjectionMatrix();
    }
  }
}
