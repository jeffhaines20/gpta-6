// Rain, wetness and the weather state machine.
//
// Scope is fixed by the cut list: rain and fog only. No storms, no snow. What is
// left has to be good, so the three things that actually sell rain get the budget:
// streaks that move with real fall speed and wind, ground that goes dark and
// mirror-smooth, and a sky that clouds over — a downpour under a clear blue dome
// reads as a bug no matter how good the particles are.
//
// Draw-call cost is TWO: one InstancedMesh of streak quads and one of splash
// rings. Nothing about a drop is simulated on the CPU. Each instance carries a
// seed, and the vertex shader derives its position from that seed plus a single
// uTime uniform, wrapping through a volume that is re-centred on the camera. So
// intensity 0 -> 1 is a change to instanceCount and a couple of uniforms, and the
// per-frame CPU cost of the whole system is constant.
//
// The sky owns the atmosphere. weather.js pushes overcast, turbidity and a fog
// boost INTO src/sky.js and lets the fog colour come back out of the scattering
// LUT, so wet-weather fog is the actual colour of the actual cloud deck rather
// than a second hand-picked hex that has to be kept in sync with the first.

import * as THREE from '../vendor/three.module.min.js';

/**
 * The three states and everything that varies between them. Anything a designer
 * would want to touch is here rather than buried in the shaders.
 *   rain      drops as a fraction of maxDrops, and streak opacity
 *   wetness   target surface wetness 0..1 (materials consume this)
 *   overcast  cloud deck for src/sky.js, 0..1
 *   fogBoost  multiplier added to the sky's clear-air fog density
 *   turbidity Mie load; rain air is dirty air
 */
export const WEATHER_STATES = {
  clear: { rain: 0, wetness: 0, overcast: 0, fogBoost: 0, turbidity: 2.6, splash: 0 },
  lightRain: { rain: 0.32, wetness: 0.55, overcast: 0.62, fogBoost: 0.55, turbidity: 4.2, splash: 0.35 },
  heavyRain: { rain: 1, wetness: 1, overcast: 1, fogBoost: 1.7, turbidity: 6.4, splash: 1 },
};

// Transitions walk this line; clear -> heavyRain goes through lightRain rather
// than cross-fading, because a downpour that arrives without a shower first reads
// as a teleport.
const ORDER = ['clear', 'lightRain', 'heavyRain'];

// Surfaces do not dry as fast as they wet. One time constant for each direction is
// the cheapest way to get the "it stopped ten minutes ago and the road is still
// black" look that a symmetric lerp cannot produce.
const WET_RISE_SECONDS = 22;
const WET_DRY_SECONDS = 95;

const RAIN_VERT = `
uniform vec3  uCenter;
uniform float uTime;
uniform vec2  uExtent;        // (horizontal half-extent, vertical extent)
uniform vec3  uWind;          // m/s
uniform float uFallSpeed;     // m/s at unit variation
uniform vec2  uStreak;        // (half width, length scale) in metres
attribute vec4 aSeed;         // xz cell position -1..1, y phase 0..1, w variation 0..1
varying vec2 vUv;
varying float vFade;

void main() {
  float speed = uFallSpeed * (0.72 + 0.56 * aSeed.w);
  float fall = mod(aSeed.y * uExtent.y - uTime * speed, uExtent.y);
  float age = (uExtent.y - fall) / speed;
  vec3 world = uCenter + vec3(aSeed.x * uExtent.x, fall - uExtent.y * 0.28, aSeed.z * uExtent.x);
  world.xz += uWind.xz * age;

  vec4 mv = viewMatrix * vec4(world, 1.0);

  // Stretch along the drop's screen-space velocity, so streaks foreshorten to
  // points when you look along the fall and lengthen when you look across it.
  vec3 vel = (viewMatrix * vec4(uWind.x, -speed, uWind.z, 0.0)).xyz;
  vec2 axis = vel.xy;
  float len2 = dot(axis, axis);
  axis = len2 > 1e-6 ? axis * inversesqrt(len2) : vec2(0.0, -1.0);
  vec2 perp = vec2(-axis.y, axis.x);
  float stretch = uStreak.y * (0.6 + 0.85 * aSeed.w);
  mv.xy += perp * (position.x * uStreak.x) + axis * (position.y * stretch);

  // Drops crossing the near plane become full-screen smears; fade them out first.
  vFade = smoothstep(0.7, 3.5, -mv.z) * (1.0 - smoothstep(0.55, 1.0, fall / uExtent.y));
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}
`;

const RAIN_FRAG = `
uniform vec3  uColor;         // radiance, nits
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;

void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float along = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float a = across * across * smoothstep(0.0, 0.45, along) * vFade * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_VERT = `
uniform vec3  uCenter;
uniform float uTime;
uniform float uRadius;        // horizontal half-extent
uniform float uGroundY;
uniform float uRate;          // ring cycles per second
uniform float uMaxSize;
attribute vec3 aSeed;         // xz cell position -1..1, z phase offset 0..1
varying vec2 vUv;
varying float vAge;

void main() {
  float phase = fract(uTime * uRate + aSeed.z);
  float size = uMaxSize * (0.25 + 0.75 * phase);
  vec3 world = vec3(uCenter.x + aSeed.x * uRadius, uGroundY + 0.012, uCenter.z + aSeed.y * uRadius);
  world.xz += position.xy * size;
  vAge = phase;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const SPLASH_FRAG = `
uniform vec3  uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vAge;

void main() {
  // An expanding ring, not a disc: the readable part of a raindrop impact is the
  // ripple crest, and a ring costs the same as a blob.
  float d = length(vUv * 2.0 - 1.0);
  float ring = smoothstep(1.0, 0.72, d) * smoothstep(0.34, 0.72, d);
  float a = ring * (1.0 - vAge) * (1.0 - vAge) * uOpacity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How a wet surface differs from a dry one, as two multipliers. Exposed as a pure
 * function so callers can apply it to materials this module has never heard of.
 *
 * Water fills the surface microstructure: the specular lobe tightens (roughness
 * falls) and more light is transmitted into the substrate and absorbed (albedo
 * darkens). materials.js keeps material.roughness at 1.0 multiplying an absolute
 * roughness map, so scaling that one number is exactly the intended hook.
 */
/**
 * How much of the wetness response each surface takes, by material name. A
 * horizontal road holds a film of water; a vertical facade sheds it; glass and
 * water are already smooth and darkening them reads as a bug.
 *
 * Keys are matched as name prefixes against `material.name`, which
 * materials.js sets for every material it registers.
 */
export const SURFACE_WETTING = {
  road: 1, land: 0.85, ground: 0.85, pavement: 1, roadMarkings: 0.9,
  building: 0.45, facade: 0.45, trim: 0.5,
  metal: 0.55, glass: 0, water: 0, sky: 0, rain: 0,
};
const DEFAULT_WETTING = 0.7;

function wettingFor(name) {
  if (!name) return DEFAULT_WETTING;
  const n = String(name).toLowerCase();
  for (const key of Object.keys(SURFACE_WETTING)) {
    if (n.startsWith(key)) return SURFACE_WETTING[key];
  }
  return DEFAULT_WETTING;
}

// Materials arrive as a registry, an array, a Map or a nested plain object.
function* flattenMaterials(x, depth = 0) {
  if (!x || depth > 3 || typeof x === 'string') return;
  if (x.isMaterial) { yield x; return; }
  // MaterialRegistry: everything it built, not just the streaming subset.
  if (typeof x.keys === 'function' && typeof x.get === 'function' && typeof x.streamingMaterials === 'function') {
    for (const k of x.keys()) yield* flattenMaterials(x.get(k), depth + 1);
    return;
  }
  if (x instanceof Map) { for (const v of x.values()) yield* flattenMaterials(v, depth + 1); return; }
  if (typeof x[Symbol.iterator] === 'function') {
    for (const v of x) yield* flattenMaterials(v, depth + 1);
    return;
  }
  if (typeof x === 'object') { for (const v of Object.values(x)) yield* flattenMaterials(v, depth + 1); }
}

export function wetSurfaceParams(wetness) {
  const w = Math.min(1, Math.max(0, wetness));
  return { roughnessScale: 1 - 0.62 * w, albedoScale: 1 - 0.34 * w, envBoost: 1 + 0.9 * w };
}

export class Weather {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   * @param {import('./sky.js').Sky} [opts.sky]   pushed overcast/turbidity/fog boost
   * @param {number} [opts.maxDrops=9000]         streak instances allocated once
   * @param {number} [opts.maxSplashes=900]       ripple instances allocated once
   * @param {number} [opts.radius=26]             half-extent of the rain volume, m
   * @param {number} [opts.height=26]             vertical extent of the volume, m
   * @param {number} [opts.splashRadius=22]       ripple spread around the camera, m
   * @param {number} [opts.groundY=0]             splash plane height
   * @param {number} [opts.fallSpeed=8.5]         m/s; a 2 mm drop terminates near 6.5
   * @param {string} [opts.state='clear']
   * @param {number} [opts.seed=90210]
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.sky = opts.sky ?? null;
    this.maxDrops = opts.maxDrops ?? 9000;
    this.maxSplashes = opts.maxSplashes ?? 900;
    this.radius = opts.radius ?? 26;
    this.height = opts.height ?? 26;
    this.splashRadius = opts.splashRadius ?? 22;
    this.groundY = opts.groundY ?? 0;
    this.fallSpeed = opts.fallSpeed ?? 8.5;
    this.dropLuminanceScale = opts.dropLuminanceScale ?? 0.85;

    const t0 = performance.now();

    this.stateName = opts.state ?? 'clear';
    this.targetName = this.stateName;
    this._fromName = this.stateName;
    this._queue = [];
    this._from = { ...WEATHER_STATES[this.stateName] };
    this._to = { ...WEATHER_STATES[this.stateName] };
    this._t = 1;
    this._legSeconds = 1;
    this.current = { ...WEATHER_STATES[this.stateName] };
    this.wetness = this.current.wetness;

    this.wind = new THREE.Vector3(1.6, 0, 0.7);
    this.time = 0;
    this.auto = false;
    this._autoTimer = 0;
    this._rand = mulberry32(opts.seed ?? 90210);
    this._bound = [];
    this._lastAppliedWetness = -1;

    this.root = new THREE.Group();
    this.root.name = 'weather';
    scene.add(this.root);

    this.rain = this._buildRain();
    this.splashes = this._buildSplashes();
    this.root.add(this.rain, this.splashes);

    this.generationMs = performance.now() - t0;
  }

  // One unit quad in XY, reused by every instance. Corner offsets live in
  // `position`; the vertex shaders expand them in view space (streaks) or on the
  // ground plane (ripples).
  _quad() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  _buildRain() {
    const geo = this._quad();

    const seeds = new Float32Array(this.maxDrops * 4);
    for (let i = 0; i < this.maxDrops; i++) {
      seeds[i * 4] = this._rand() * 2 - 1;
      seeds[i * 4 + 1] = this._rand();
      seeds[i * 4 + 2] = this._rand() * 2 - 1;
      seeds[i * 4 + 3] = this._rand();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;
    // The volume follows the camera, so a fixed sphere around the origin would be
    // culled the moment the player drove away from it.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.rainMaterial = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uExtent: { value: new THREE.Vector2(this.radius, this.height) },
        uWind: { value: new THREE.Vector3() },
        uFallSpeed: { value: this.fallSpeed },
        uStreak: { value: new THREE.Vector2(0.016, 0.5) },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    const mesh = new THREE.Mesh(geo, this.rainMaterial);
    mesh.name = 'rain';
    mesh.frustumCulled = false;
    mesh.renderOrder = 900;      // after opaque, before the sky dome's depth-1 fill
    mesh.castShadow = false;
    return mesh;
  }

  _buildSplashes() {
    const geo = this._quad();

    const seeds = new Float32Array(this.maxSplashes * 3);
    for (let i = 0; i < this.maxSplashes; i++) {
      seeds[i * 3] = this._rand() * 2 - 1;
      seeds[i * 3 + 1] = this._rand() * 2 - 1;
      seeds[i * 3 + 2] = this._rand();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.splashMaterial = new THREE.ShaderMaterial({
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uRadius: { value: this.splashRadius },
        uGroundY: { value: this.groundY },
        uRate: { value: 2.6 },
        uMaxSize: { value: 0.34 },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    const mesh = new THREE.Mesh(geo, this.splashMaterial);
    mesh.name = 'rain-splashes';
    mesh.frustumCulled = false;
    mesh.renderOrder = 899;
    mesh.castShadow = false;
    return mesh;
  }

  // ------------------------------------------------------------------ machine
  /**
   * Move to a state. Non-adjacent targets are queued through the intermediate
   * state instead of cross-faded.
   * @param {'clear'|'lightRain'|'heavyRain'} name
   * @param {object} [opts]
   * @param {number} [opts.seconds=8]  duration of each leg
   * @param {boolean} [opts.immediate] snap, for a lab or a mission start
   */
  set(name, opts = {}) {
    if (!WEATHER_STATES[name]) throw new Error(`unknown weather state: ${name}`);
    const seconds = opts.seconds ?? 8;
    this.targetName = name;

    if (opts.immediate) {
      this._queue.length = 0;
      this.stateName = name;
      this._fromName = name;
      this._from = { ...WEATHER_STATES[name] };
      this._to = { ...WEATHER_STATES[name] };
      this._t = 1;
      this.current = { ...WEATHER_STATES[name] };
      this.wetness = this.current.wetness;
      this._push();
      return this;
    }

    const pos = this._position();
    const there = ORDER.indexOf(name);
    const step = there >= pos ? 1 : -1;
    this._queue = [];
    let i = step > 0 ? Math.floor(pos) + 1 : Math.ceil(pos) - 1;
    for (; step > 0 ? i <= there : i >= there; i += step) this._queue.push({ name: ORDER[i], seconds });
    if (!this._queue.length) this._queue.push({ name, seconds });
    this._beginLeg();
    return this;
  }

  /** Ambient weather without a script: random dwell, one step at a time. */
  setAuto(enabled, { minSeconds = 90, maxSeconds = 300 } = {}) {
    this.auto = enabled;
    this._autoRange = [minSeconds, maxSeconds];
    this._autoTimer = enabled ? minSeconds : 0;
    return this;
  }

  // Where we are on the clear/lightRain/heavyRain line, as a continuous index.
  // Mid-transition that is a fraction, which is what lets a reversal start from
  // the values on screen rather than snapping to the leg it had been heading for.
  _position() {
    const a = ORDER.indexOf(this._fromName), b = ORDER.indexOf(this.stateName);
    return a + (b - a) * Math.min(1, this._t);
  }

  _beginLeg() {
    const leg = this._queue.shift();
    if (!leg) return;
    this._from = { ...this.current };
    this._to = { ...WEATHER_STATES[leg.name] };
    this._fromName = this.stateName;
    this.stateName = leg.name;
    this._legSeconds = Math.max(0.001, leg.seconds);
    this._t = 0;
  }

  // ------------------------------------------------------------------ frame
  /**
   * Per frame. Constant cost: no per-drop work, no allocation.
   * @param {number} dt seconds
   * @param {THREE.Camera|{position:THREE.Vector3}} camera the volume follows it
   */
  update(dt, camera) {
    this.time += dt;

    if (this._t < 1) {
      this._t = Math.min(1, this._t + dt / this._legSeconds);
      const s = this._t * this._t * (3 - 2 * this._t);
      for (const k of Object.keys(this._to)) {
        this.current[k] = this._from[k] + (this._to[k] - this._from[k]) * s;
      }
      if (this._t >= 1 && this._queue.length) this._beginLeg();
    }

    if (this.auto) {
      this._autoTimer -= dt;
      if (this._autoTimer <= 0 && this._t >= 1 && !this._queue.length) {
        const [lo, hi] = this._autoRange;
        this._autoTimer = lo + this._rand() * (hi - lo);
        const here = ORDER.indexOf(this.targetName);
        const step = here === 0 ? 1 : here === ORDER.length - 1 ? -1 : (this._rand() < 0.5 ? -1 : 1);
        this.set(ORDER[here + step], { seconds: 14 + this._rand() * 30 });
      }
    }

    // Wetness has its own dynamics; it lags the cloud, not the other way round.
    const target = this.current.wetness;
    const tau = target > this.wetness ? WET_RISE_SECONDS : WET_DRY_SECONDS;
    this.wetness += (target - this.wetness) * (1 - Math.exp(-dt / tau));

    this._push();
    this._applyWetness();

    const pos = camera.position ?? camera;
    const ru = this.rainMaterial.uniforms;
    ru.uTime.value = this.time;
    ru.uCenter.value.set(pos.x, pos.y, pos.z);
    ru.uWind.value.copy(this.wind);
    ru.uOpacity.value = 0.55 * Math.min(1, this.current.rain * 1.6);
    // Longer streaks as it gets heavier: the eye reads streak length as rain rate
    // more readily than it reads drop count.
    ru.uStreak.value.set(0.016 + 0.010 * this.current.rain, 0.34 + 0.62 * this.current.rain);
    this.rain.geometry.instanceCount = Math.round(this.maxDrops * this.current.rain);
    this.rain.visible = this.current.rain > 0.005;

    const su = this.splashMaterial.uniforms;
    su.uTime.value = this.time;
    // Snap to a 2 m grid so ripples sit on the ground instead of sliding with the
    // camera. The jump is 2 m once per 2 m travelled, over a 0.4 s lifetime.
    su.uCenter.value.set(Math.round(pos.x / 2) * 2, pos.y, Math.round(pos.z / 2) * 2);
    su.uGroundY.value = this.groundY;
    su.uOpacity.value = 0.5 * this.current.splash;
    su.uMaxSize.value = 0.26 + 0.2 * this.current.splash;
    this.splashes.geometry.instanceCount = Math.round(this.maxSplashes * this.current.splash);
    this.splashes.visible = this.current.splash > 0.005;

    this._tintFromSky();
    return this;
  }

  // Rain is not white: a streak is a lens showing the sky behind it, so its
  // radiance has to come from the sky or it will glow at night and vanish at noon.
  _tintFromSky() {
    let r = 900, g = 950, b = 1000;
    if (this.sky && this.sky.atmosphere) {
      const f = this.sky.atmosphere.fogColor;
      r = f.r; g = f.g; b = f.b;
    }
    const k = this.dropLuminanceScale;
    this.rainMaterial.uniforms.uColor.value.set(r * k, g * k, b * k);
    this.splashMaterial.uniforms.uColor.value.set(r * k * 1.15, g * k * 1.15, b * k * 1.15);
  }

  _push() {
    if (!this.sky) return;
    this.sky.setOvercast(this.current.overcast);
    this.sky.setTurbidity(this.current.turbidity);
    this.sky.setFogBoost(this.current.fogBoost);
    // Moving weather needs the cloud deck to follow it, so the sky's throttled
    // LUT path is switched on for the duration and off again at the end. That
    // path never touches the PMREM env map; this does, once, when it settles.
    const moving = this._t < 1 || this._queue.length > 0;
    this.sky.autoRefresh = moving;
    if (!moving && this._settle) {
      this._settle = false;
      this.sky.refresh({ force: true });
    }
    if (moving) this._settle = true;
  }

  // ------------------------------------------------------------------ wiring
  /**
   * Bind shared materials so wetness darkens their albedo and drops their
   * roughness. Dry values are captured once at bind time and every later value is
   * derived from them, so repeated calls cannot ratchet a material into black.
   *
   * Accepts a MaterialRegistry, an array, a Map, or a plain object of materials.
   * The registry case matters: `Object.values(registry)` would walk its private
   * fields, find no materials, bind nothing and report success — a wet-look
   * system that silently does nothing is worse than one that throws.
   *
   * Susceptibility comes from SURFACE_WETTING, keyed on material.name, because a
   * pane of glass and a wet asphalt lane do not respond the same way and
   * materials.js already names everything it builds.
   *
   * @param {object|Iterable<THREE.Material>} materials
   */
  bindMaterials(materials) {
    for (const m of flattenMaterials(materials)) {
      if (!m || !m.isMaterial) continue;
      const share = wettingFor(m.name);
      if (share <= 0) continue;
      if (this._bound.some((b) => b.mat === m)) continue;
      this._bound.push({
        mat: m,
        share,
        roughness: m.roughness ?? 1,
        color: m.color ? m.color.clone() : null,
        envMapIntensity: m.envMapIntensity ?? 1,
      });
    }
    this._lastAppliedWetness = -1;
    return this;
  }

  _applyWetness() {
    if (Math.abs(this.wetness - this._lastAppliedWetness) < 0.004) return;
    this._lastAppliedWetness = this.wetness;
    for (const b of this._bound) {
      const { roughnessScale, albedoScale, envBoost } = wetSurfaceParams(this.wetness * b.share);
      if (b.mat.roughness !== undefined) b.mat.roughness = b.roughness * roughnessScale;
      if (b.color) b.mat.color.setRGB(b.color.r * albedoScale, b.color.g * albedoScale, b.color.b * albedoScale);
      if (b.mat.envMapIntensity !== undefined) b.mat.envMapIntensity = b.envMapIntensity * envBoost;
    }
  }

  /**
   * Wetness into the post stack. Fog is the sky's job — call sky.applyToPost()
   * after this and after any TimeOfDay.apply(), which overwrites both.
   */
  applyToPost(post) {
    if (post && post.params) post.params.wetness = this.wetness;
    return this;
  }

  /** Push cloud/haze state into a Sky that was not passed to the constructor. */
  applyToSky(sky) {
    this.sky = sky;
    this._push();
    return this;
  }

  report() {
    return {
      state: this.stateName,
      target: this.targetName,
      transition: +this._t.toFixed(3),
      queued: this._queue.length,
      rainIntensity: +this.current.rain.toFixed(3),
      wetness: +this.wetness.toFixed(3),
      overcast: +this.current.overcast.toFixed(3),
      fogBoost: +this.current.fogBoost.toFixed(3),
      turbidity: +this.current.turbidity.toFixed(2),
      liveDrops: this.rain.geometry.instanceCount,
      liveSplashes: this.splashes.geometry.instanceCount,
      maxDrops: this.maxDrops,
      drawCalls: (this.rain.visible ? 1 : 0) + (this.splashes.visible ? 1 : 0),
      boundMaterials: this._bound.length,
      generationMs: +this.generationMs.toFixed(1),
    };
  }

  dispose() {
    for (const b of this._bound) {
      if (b.mat.roughness !== undefined) b.mat.roughness = b.roughness;
      if (b.color) b.mat.color.copy(b.color);
      if (b.mat.envMapIntensity !== undefined) b.mat.envMapIntensity = b.envMapIntensity;
    }
    this._bound.length = 0;
    this.scene.remove(this.root);
    this.rain.geometry.dispose();
    this.splashes.geometry.dispose();
    this.rainMaterial.dispose();
    this.splashMaterial.dispose();
  }
}

/** Convenience: build the weather, park it in the scene and hand back the instance. */
export function createWeather(scene, opts) { return new Weather(scene, opts); }
