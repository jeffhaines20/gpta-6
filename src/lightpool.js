// Nearest-N light pool.
//
// three.js forward-renders: every light in the scene is evaluated by every lit
// fragment, and each material compiles against the current light count. 233
// street lamps is therefore not "233 cheap lights" — it is a per-fragment loop of
// 233 and a shader that may not compile at all on real hardware.
//
// This container renders in software so frame rate cannot expose it, which is
// exactly why it has to be fixed structurally rather than measured away: keep a
// small fixed pool of real PointLights and move them to the nearest emitters each
// frame. Shader light count becomes constant and knowable.

import * as THREE from '../vendor/three.module.min.js';

export class LightPool {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.size = opts.size ?? 10;
    this.maxDistance = opts.maxDistance ?? 120;
    // Hysteresis stops a light flickering between two emitters at equal distance.
    this.swapMargin = opts.swapMargin ?? 8;

    this.emitters = [];        // { x, y, z, candela, color, distance }
    this.lights = [];
    this.assigned = new Array(this.size).fill(-1);
    for (let i = 0; i < this.size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 60, 2);
      l.visible = false;
      scene.add(l);
      this.lights.push(l);
    }
    this._scratch = [];
    this.enabled = true;
  }

  // Register a light SOURCE without creating a THREE light for it. The emissive
  // geometry that represents the fixture is the caller's business.
  addEmitter(x, y, z, candela, color = 0xffc98a, distance = 46) {
    this.emitters.push({ x, y, z, candela, color, distance });
    return this.emitters.length - 1;
  }

  clear() {
    this.emitters.length = 0;
    for (const l of this.lights) { l.visible = false; l.intensity = 0; }
    this.assigned.fill(-1);
  }

  // masterScale lets the day/night system switch the whole set off at noon
  // without the pool losing its assignments.
  update(cameraPos, masterScale = 1) {
    if (!this.enabled) return;
    const near = this._scratch;
    near.length = 0;
    const maxD2 = this.maxDistance * this.maxDistance;
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      const dx = e.x - cameraPos.x, dz = e.z - cameraPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < maxD2) near.push({ i, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2);

    const want = near.slice(0, this.size).map((n) => n.i);
    const wantSet = new Set(want);

    // Keep already-assigned emitters in place where possible, so lights do not
    // reshuffle every frame and pop.
    const free = [];
    for (let s = 0; s < this.size; s++) {
      if (this.assigned[s] >= 0 && wantSet.has(this.assigned[s])) wantSet.delete(this.assigned[s]);
      else free.push(s);
    }
    const incoming = [...wantSet];
    for (const slot of free) {
      const idx = incoming.pop();
      this.assigned[slot] = idx === undefined ? -1 : idx;
    }

    for (let s = 0; s < this.size; s++) {
      const l = this.lights[s];
      const idx = this.assigned[s];
      if (idx < 0 || masterScale <= 0) { l.visible = false; l.intensity = 0; continue; }
      const e = this.emitters[idx];
      l.visible = true;
      l.position.set(e.x, e.y, e.z);
      l.color.setHex(e.color);
      l.distance = e.distance;
      l.intensity = e.candela * masterScale;
    }
  }

  report() {
    return {
      emitters: this.emitters.length,
      poolSize: this.size,
      active: this.lights.filter((l) => l.visible && l.intensity > 0).length,
    };
  }
}
