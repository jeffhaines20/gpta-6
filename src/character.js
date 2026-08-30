// Procedural character mesh + rig.
//
// Built from capsules and boxes rather than a skinned mesh: with no asset
// pipeline, a jointed hierarchy driven by LocomotionFSM.pose() gives believable
// motion for a fraction of the work a skinning solution would need, and it costs
// one draw call per material rather than one per limb if the caller instances it.
//
// The rig's joint names are the contract with src/animfsm.js. A better mesh can
// replace this file entirely as long as it applies the same pose.

import * as THREE from '../vendor/three.module.min.js';

const SKIN = [0xc79a72, 0x8d5f43, 0xe0b48f, 0x6f4630, 0xb07d55];
const SHIRT = [0x2f4a63, 0x7a3b34, 0x3d5b45, 0xb8a068, 0x2b2f38, 0x6d4e7a];
const PANTS = [0x22262c, 0x3a3f4a, 0x5a4636, 0x2e3b30];

function pick(list, r) { return list[Math.floor(r() * list.length) % list.length]; }

export class Character {
  constructor(opts = {}) {
    const r = opts.rng ?? Math.random;
    const skin = new THREE.MeshStandardMaterial({ color: pick(SKIN, r), roughness: 0.72 });
    const shirt = new THREE.MeshStandardMaterial({ color: pick(SHIRT, r), roughness: 0.85 });
    const pants = new THREE.MeshStandardMaterial({ color: pick(PANTS, r), roughness: 0.88 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.7 });
    this.materials = [skin, shirt, pants, shoe];

    this.root = new THREE.Group();
    // Hips are the animation root: bob and lean apply here so the whole body
    // moves together instead of the torso sliding off the legs.
    this.hips = new THREE.Group();
    this.hips.position.y = 0.92;
    this.root.add(this.hips);

    this.spine = new THREE.Group();
    this.hips.add(this.spine);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 5, 12), shirt);
    torso.position.y = 0.30;
    this.spine.add(torso);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.24), shirt);
    chest.position.y = 0.44;
    this.spine.add(chest);

    this.neck = new THREE.Group();
    this.neck.position.y = 0.60;
    this.spine.add(this.neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12), skin);
    head.scale.set(1, 1.15, 0.94);
    head.position.y = 0.10;
    this.neck.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.118, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), pants);
    hair.position.y = 0.115;
    this.neck.add(hair);

    const limb = (parent, x, y, upperLen, lowerLen, radius, upperMat, lowerMat, endMat) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(x, y, 0);
      parent.add(shoulder);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(radius, upperLen, 4, 8), upperMat);
      upper.position.y = -upperLen / 2 - radius * 0.4;
      shoulder.add(upper);
      const joint = new THREE.Group();
      joint.position.y = -upperLen - radius * 0.4;
      shoulder.add(joint);
      const lower = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.88, lowerLen, 4, 8), lowerMat);
      lower.position.y = -lowerLen / 2 - radius * 0.35;
      joint.add(lower);
      let end = null;
      if (endMat) {
        end = new THREE.Mesh(new THREE.BoxGeometry(radius * 2.1, radius * 1.2, radius * 3.4), endMat);
        end.position.set(0, -lowerLen - radius * 0.6, radius * 0.7);
        joint.add(end);
      }
      return { shoulder, joint, end };
    };

    this.armL = limb(this.spine, -0.255, 0.46, 0.26, 0.25, 0.058, shirt, skin, null);
    this.armR = limb(this.spine, 0.255, 0.46, 0.26, 0.25, 0.058, shirt, skin, null);
    this.legL = limb(this.hips, -0.10, 0.0, 0.42, 0.40, 0.078, pants, pants, shoe);
    this.legR = limb(this.hips, 0.10, 0.0, 0.42, 0.40, 0.078, pants, pants, shoe);

    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this._baseHipY = this.hips.position.y;
  }

  // Apply a pose from LocomotionFSM.pose(). Joint names here are the contract.
  applyPose(p) {
    this.hips.position.y = this._baseHipY + (p.hipY ?? 0);
    this.spine.rotation.x = p.spinePitch ?? 0;
    this.spine.rotation.z = p.spineRoll ?? 0;
    this.neck.rotation.y = p.headYaw ?? 0;

    this.legL.shoulder.rotation.x = p.legL ?? 0;
    this.legR.shoulder.rotation.x = p.legR ?? 0;
    this.legL.joint.rotation.x = -(p.kneeL ?? 0);
    this.legR.joint.rotation.x = -(p.kneeR ?? 0);
    this.armL.shoulder.rotation.x = p.armL ?? 0;
    this.armR.shoulder.rotation.x = p.armR ?? 0;
    this.armL.joint.rotation.x = -(p.elbowL ?? 0);
    this.armR.joint.rotation.x = -(p.elbowR ?? 0);
  }

  // Seated pose for riding in a vehicle.
  applySeated() {
    this.hips.position.y = this._baseHipY;
    this.spine.rotation.set(0.12, 0, 0);
    for (const l of [this.legL, this.legR]) { l.shoulder.rotation.x = -1.35; l.joint.rotation.x = 1.25; }
    for (const a of [this.armL, this.armR]) { a.shoulder.rotation.x = -0.85; a.joint.rotation.x = -0.55; }
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}
