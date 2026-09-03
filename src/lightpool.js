// Nearest-N light pool.
//
// three.js forward-renders: every light in the scene is evaluated by every lit
// fragment, and each material compiles against the current light count. 233
// street lamps is therefore not "233 cheap lights" — it is a per-fragment loop of
// 233 and a shader that may not compile at all on real hardware.
//
// This container renders in software so frame rate cannot expose it, which is
// exactly why it has to be fixed structurally rather than measured away: keep a
// small fixed pool of real PointLights and move them to the emitters that matter
// most each frame. Shader light count becomes constant and knowable.
//
// "Nearest" was the whole of that judgement until it was measured, and it is the
// wrong half of it: at the night corridor camera six of the ten slots were spent
// on lamps BEHIND the viewer. Ranking is view-aware now - an emitter that cannot
// light any visible surface is ranked after every emitter that can - so the class
// is a nearest-N-THAT-YOU-CAN-SEE pool. See _rank().

import * as THREE from '../vendor/three.module.min.js';

export class LightPool {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.size = opts.size ?? 10;
    this.maxDistance = opts.maxDistance ?? 120;
    // Hysteresis, in METRES, and now actually read - see _rank() below. It was a
    // dead field for as long as selection was distance-only, because distance
    // does not change when the player turns and so there was no boundary for a
    // light to flicker across. Making selection view-dependent creates one: an
    // emitter whose illumination just touches the edge of the frustum would swap
    // in and out on the smallest camera movement. The margin is applied twice,
    // both times as a length: it dilates an incumbent's illumination sphere
    // (so it has to fall CLEARLY outside the view before it is dropped) and it
    // shortens an incumbent's effective distance (so a challenger has to be
    // clearly closer, not equal). Measured against margin 0 in
    // tools/lamp-onscreen.mjs, which is the check that it is still doing work.
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
    // Sticky view state. Selection needs to know where the camera is LOOKING,
    // but one of the two callers - daynight.apply(), which rescales the pool for
    // a new time of day - has only a position to give. So the last view handed in
    // is remembered, and a call without a camera re-ranks against it rather than
    // throwing the bias away and re-pinning the pool to whatever is nearest.
    this._viewMat = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._frustum = new THREE.Frustum();
    this._sphere = new THREE.Sphere();
    this._held = new Set();
    this.hasView = false;
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

  // Point the pool at a camera. Selection ranks by DISTANCE alone until this has
  // been called at least once, which is the behaviour every caller had before.
  //
  // The camera's world matrix is refreshed here rather than assumed: the pool
  // runs inside the frame, before the renderer has updated anything, and the
  // headless harnesses set camera.position/quaternion directly and never call it.
  // updateMatrixWorld() is what WebGLRenderer.render() does with the same object
  // a few lines later, so this is a re-computation, not a mutation of intent.
  setView(camera) {
    if (!camera || !camera.isCamera) return false;
    camera.updateMatrixWorld();
    this._viewMat.copy(camera.matrixWorld).invert();
    this._viewProj.multiplyMatrices(camera.projectionMatrix, this._viewMat);
    this._frustum.setFromProjectionMatrix(this._viewProj);
    this.hasView = true;
    return true;
  }

  // Where an emitter stands in the queue for a pool slot, in metres. Lower wins.
  //
  // Distance alone put six of ten lights BEHIND the corridor camera at night,
  // measured: they lit nothing the player could see while the emissive fixture
  // geometry down the street - which is drawn whether or not a slot reaches it -
  // glowed with no pool of light under it. That is the "lamps glow without
  // lighting" note three critic rounds filed.
  //
  // The test is not "is the lamp on screen". It is "can this lamp light anything
  // on screen": the emitter's own falloff radius as a sphere against the view
  // frustum. That keeps a lamp just off the left edge, which lights pavement that
  // IS in shot, and keeps a lamp a few metres behind the camera, whose 46 m pool
  // still reaches the road ahead - while dropping one 60 m behind, which cannot
  // reach any visible surface at all. Everything that fails it is ranked after
  // everything that passes (the penalty is maxDistance, and no in-range emitter
  // can score that high), so wasted slots go to the far end of the street the
  // player is actually looking down instead of to the road behind them.
  _rank(e, d, held) {
    if (!this.hasView) return d;
    this._sphere.center.set(e.x, e.y, e.z);
    // An incumbent is judged on a sphere dilated by the margin, so it has to fall
    // clearly out of view before it loses its slot.
    this._sphere.radius = e.distance + (held ? this.swapMargin : 0);
    if (!this._frustum.intersectsSphere(this._sphere)) return d + this.maxDistance;
    return held ? Math.max(0, d - this.swapMargin) : d;
  }

  // masterScale lets the day/night system switch the whole set off at noon
  // without the pool losing its assignments. `camera` is optional: pass it and
  // selection becomes view-aware, omit it and the last view handed in is reused.
  update(cameraPos, masterScale = 1, camera = null) {
    if (!this.enabled) return;
    if (camera) this.setView(camera);
    const near = this._scratch;
    near.length = 0;
    const maxD2 = this.maxDistance * this.maxDistance;
    // Who currently holds a slot, so the margin can be applied to them alone.
    this._held.clear();
    for (const a of this.assigned) if (a >= 0) this._held.add(a);
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      const dx = e.x - cameraPos.x, dz = e.z - cameraPos.z;
      const d2 = dx * dx + dz * dz;
      // `rank`, not `d2`: once the view is known this is no longer a distance
      // and sorting it as one is how the units get away from you.
      if (d2 < maxD2) near.push({ i, rank: this._rank(e, Math.sqrt(d2), this._held.has(i)) });
    }
    near.sort((a, b) => a.rank - b.rank);

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
    // `active` counts lights that are ON. `illuminating` counts the ones that are
    // on AND can reach a visible surface, which is the number that moved when
    // selection stopped being distance-only: the old pool reported 10 active at
    // the night corridor camera with 5 of them lighting nothing in shot, and an
    // audit that only counts `active` calls that healthy.
    const active = this.lights.filter((l) => l.visible && l.intensity > 0);
    let illuminating = null;
    if (this.hasView) {
      illuminating = 0;
      for (const l of active) {
        this._sphere.center.copy(l.position);
        this._sphere.radius = l.distance;
        if (this._frustum.intersectsSphere(this._sphere)) illuminating++;
      }
    }
    return {
      emitters: this.emitters.length,
      poolSize: this.size,
      active: active.length,
      viewAware: this.hasView,
      illuminating,
      swapMargin: this.swapMargin,
    };
  }
}
