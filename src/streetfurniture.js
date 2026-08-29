// Street furniture, instanced.
//
// The chase harness measured 325 draw calls p95 with 233 individually-meshed lamp
// posts accounting for ~70% of them, before any textures landed. Street furniture
// is the classic case for instancing: many copies of a handful of props.
//
// One InstancedMesh per prop part, so the whole district's lighting hardware costs
// a fixed handful of draw calls no matter how many posts there are.

import * as THREE from '../vendor/three.module.min.js';

export class StreetFurniture {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.max = opts.max ?? 400;
    this.root = new THREE.Group();
    this.root.name = 'furniture';
    scene.add(this.root);

    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.75 });
    // Lamp heads are emissive geometry; the actual illumination comes from the
    // LightPool, so these can be instanced freely.
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0x1a1c20, emissive: 0xffd9a0, emissiveIntensity: 0,
    });

    const poleGeo = new THREE.CylinderGeometry(0.11, 0.16, 8.2, 8);
    poleGeo.translate(0, 4.1, 0);
    const armGeo = new THREE.BoxGeometry(2.2, 0.13, 0.13);
    armGeo.translate(1.1, 8.05, 0);
    const headGeo = new THREE.BoxGeometry(0.9, 0.2, 0.42);
    headGeo.translate(2.2, 7.9, 0);

    this.poles = this._instanced(poleGeo, metal, true);
    this.arms = this._instanced(armGeo, metal, false);
    this.heads = this._instanced(headGeo, this.headMat, false);
    this.count = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3(1, 1, 1);
  }

  _instanced(geo, mat, shadow) {
    const m = new THREE.InstancedMesh(geo, mat, this.max);
    m.count = 0;
    m.castShadow = shadow;
    m.frustumCulled = false;      // the pool is district-wide; culling it hides everything
    this.root.add(m);
    return m;
  }

  // Returns the world position of the lamp head so the caller can register a
  // matching emitter with the LightPool.
  addLamp(x, z, yaw) {
    if (this.count >= this.max) return null;
    this._pos.set(x, 0, z);
    this._q.setFromAxisAngle(this._up, yaw);
    this._m.compose(this._pos, this._q, this._scale);
    const i = this.count++;
    this.poles.setMatrixAt(i, this._m);
    this.arms.setMatrixAt(i, this._m);
    this.heads.setMatrixAt(i, this._m);
    this.poles.count = this.arms.count = this.heads.count = this.count;
    return { x: x + Math.cos(yaw) * 2.2, y: 7.7, z: z - Math.sin(yaw) * 2.2 };
  }

  commit() {
    for (const m of [this.poles, this.arms, this.heads]) m.instanceMatrix.needsUpdate = true;
  }

  // Emissive on the fixture itself tracks whether the lamps are on, independently
  // of whether a LightPool slot currently reaches this one.
  setLit(on) {
    this.headMat.emissiveIntensity = on ? 2.4 : 0;
  }

  report() {
    return { lamps: this.count, drawCalls: 3 };
  }
}
