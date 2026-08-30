// Time-of-day in real photometric units.
//
// Phase 1 shipped a street lamp at intensity 26 that lit nothing, because the
// number was picked by eye rather than from a unit. Everything here carries its
// unit in the name, and exposure moves with the light level the way a camera's
// auto-exposure does — so "looks right" and "is physically sane" stop competing.
//
//   DirectionalLight.intensity -> lux (illuminance on a surface facing the sun)
//   PointLight.intensity       -> candela (luminous intensity)
//   HemisphereLight.intensity  -> lux (sky illuminance)

import * as THREE from '../vendor/three.module.min.js';

export const PRESETS = {
  noon: {
    label: 'Noon',
    sunLux: 100000,           // clear-sky direct normal illuminance
    skyLux: 20000,            // diffuse sky component
    elevation: 1.32, azimuth: 0.6,
    sunColor: 0xfff6e8, skyColor: 0xbcd6f5, groundColor: 0x6b6455,
    exposure: 1 / 78000,      // camera stop, not a brightness fudge
    lampsOn: false,
    fog: { color: 0xa8c2dc, density: 0.0016 },
    post: { fogColor: 0xa9c3e0, inscatter: 0xfff0d0, density: 0.0016,
            heightFalloff: 0.020, bloomThreshold: 1.7, bloomStrength: 0.30 },
  },
  dusk: {
    label: 'Dusk',
    sunLux: 1200,             // sun on the horizon, heavily attenuated
    skyLux: 900,
    elevation: 0.055, azimuth: 2.72,
    sunColor: 0xff9048, skyColor: 0x93a9d6, groundColor: 0x40382e,
    exposure: 1 / 330,
    lampsOn: true,
    fog: { color: 0x6a6480, density: 0.0034 },
    post: { fogColor: 0x6d6a88, inscatter: 0xff9a52, density: 0.0032,
            heightFalloff: 0.016, bloomThreshold: 0.85, bloomStrength: 0.62 },
  },
  night: {
    label: 'Night',
    sunLux: 0.6,              // full moon is ~0.25 lux; this is moon + skyglow
    skyLux: 0.15,             // measured from the sky model, not guessed at
    elevation: 0.9, azimuth: 4.1,
    sunColor: 0x9fb6e0, skyColor: 0x35406b, groundColor: 0x14161f,
    exposure: 1 / 1.15,       // dark sky, lamp-lit surfaces readable. At 1/3.2 the
                              // polarity was right but the frame was unplayably dark
    lampsOn: true,
    fog: { color: 0x141a2a, density: 0.0042 },
    post: { fogColor: 0x18203a, inscatter: 0x3b4a78, density: 0.0038,
            heightFalloff: 0.014, bloomThreshold: 0.55, bloomStrength: 0.85 },
  },
};

// Plausibility envelope, asserted by the sweep. These are the ranges a real
// photometric reference would put each quantity in.
export const PLAUSIBLE = {
  noon:  { sunLux: [50000, 130000], skyLux: [8000, 30000] },
  dusk:  { sunLux: [200, 4000],     skyLux: [100, 2500] },
  night: { sunLux: [0, 3],          skyLux: [0.03, 1.5] },
  lampCandela: [300, 3000],         // a street lamp is ~10-20 klm over a sphere
  shopCandela: [40, 600],
};

export class TimeOfDay {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const S = 260;
    Object.assign(this.sun.shadow.camera,
      { left: -S, right: S, top: S, bottom: -S, near: 1, far: 900 });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.06;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);

    this.lamps = [];          // registered by whoever builds street furniture
    this.post = null;         // optional PostStack; see attachPost()
    this.skyDome = null;      // set once src/sky.js provides a real dome
    this.envIntensity = 1.0;  // PMREM radiance is physical; do not dim it
    this.weather = { wetness: 0, fogBoost: 0 };
    this.preset = null;
    this.apply('dusk');
  }

  registerLamp(light, candela) { this.lamps.push({ light, candela }); }

  // Preferred over registerLamp: one instanced fixture set plus a nearest-N pool.
  // The streamer owns the facade library; time of day has to reach it so lit
  // windows switch with the cycle.
  setWorld(world) { this.world = world; this.apply(this.presetName); }

  // Attaching a sky hands it the background and the fog/inscatter terms. Without
  // one, apply() falls back to a radiance-scaled flat colour, which is a stand-in
  // and not a sky.
  setSky(sky, weather = null) {
    this.skyDome = sky;
    this.weatherSys = weather;
    this.apply(this.presetName);
  }

  setFurniture(furniture, lightPool) {
    this.furniture = furniture;
    this.lightPool = lightPool;
    this.apply(this.presetName);
  }

  // When a PostStack is attached it takes over tonemapping and exposure, and
  // scene.fog is dropped in favour of the depth-based height fog in the composite
  // pass (per-vertex fog cannot do aerial perspective or fog the sky).
  attachPost(post) {
    this.post = post;
    this.apply(this.presetName);
  }

  // Weather drives fog density and surface wetness without disturbing the
  // photometric values, so the plausibility gate stays meaningful in the rain.
  setWeather({ wetness = 0, fogBoost = 0 } = {}) {
    this.weather.wetness = wetness;
    this.weather.fogBoost = fogBoost;
    this._applyPost();
  }

  // Fog radiance has to survive the camera stop. Whatever the sky hands over is a
  // physical radiance; what ACES actually receives is radiance x exposure, and
  // anything much above ~1.5 saturates to white. Measured at dusk: fog 2.14 and
  // inscatter 6.52, which blew the whole frame while the illuminance ratio gate
  // still read "pass" - the gate was checking the wrong quantity.
  //
  // Fog colour is a look parameter; only its ratio to exposure matters. So it is
  // renormalised here, preserving hue, after the sky and weather have written.
  normalisePostExposure() {
    if (!this.post) return null;
    const q = this.post.params;
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const fit = (color, target) => {
      const l = lum(color) * q.exposure;
      if (l > target && l > 1e-9) color.multiplyScalar(target / l);
      return l;
    };
    // Fog fills most of a wide shot, so it must stay clearly below saturation.
    // Inscatter only applies in a narrow lobe toward the sun and is allowed to
    // bloom, which is what a sun behind haze actually does.
    const before = { fog: lum(q.fogColor) * q.exposure, inscatter: lum(q.fogInscatter) * q.exposure };
    fit(q.fogColor, 0.85);
    fit(q.fogInscatter, 2.2);
    // The sky's physical extinction veils the mid-ground at street level. Real
    // aerial perspective is far weaker over 300 m of clear air; this keeps depth
    // separation without turning the district into a white sheet.
    q.fogDensity = Math.min(q.fogDensity, 0.0009 + this.weather.fogBoost * 0.004);
    q.fogHeightFalloff = Math.max(q.fogHeightFalloff, 0.02);
    return { before, after: { fog: lum(q.fogColor) * q.exposure, inscatter: lum(q.fogInscatter) * q.exposure } };
  }

  _applyPost() {
    if (!this.post) return;
    const p = this.preset, pp = p.post;
    const q = this.post.params;
    q.exposure = p.exposure;
    q.fogColor.setHex(pp.fogColor);
    q.fogInscatter.setHex(pp.inscatter);
    q.fogDensity = pp.density * (1 + this.weather.fogBoost * 3);
    q.fogHeightFalloff = pp.heightFalloff;
    q.bloomThreshold = pp.bloomThreshold;
    q.bloomStrength = pp.bloomStrength;
    q.wetness = this.weather.wetness;
    q.sunDirection.copy(this.sun.position).normalize();
  }

  apply(name) {
    const p = PRESETS[name];
    if (!p) throw new Error(`unknown time of day: ${name}`);
    this.presetName = name;
    this.preset = p;

    this.sun.intensity = p.sunLux;
    this.sun.color.setHex(p.sunColor);
    const d = 400;
    this.sun.position.set(
      Math.cos(p.azimuth) * Math.cos(p.elevation) * d,
      Math.sin(p.elevation) * d,
      Math.sin(p.azimuth) * Math.cos(p.elevation) * d
    );

    this.hemi.intensity = p.skyLux;
    this.hemi.color.setHex(p.skyColor);
    this.hemi.groundColor.setHex(p.groundColor);

    if (this.post) {
      // The post stack tonemaps; the renderer must stay linear.
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.scene.fog = null;
      this._applyPost();
    } else {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = p.exposure;
      this.scene.fog = new THREE.FogExp2(p.fog.color, p.fog.density);
    }
    // Approximate sky radiance from the preset's sky illuminance (L = E / pi).
    // src/sky.js replaces this with a real dome; without the scale the background
    // is an sRGB colour multiplied by a camera stop, i.e. black.
    if (!this.skyDome) {
      this.scene.background = new THREE.Color(p.fog.color).multiplyScalar(p.skyLux / Math.PI);
    }

    for (const { light, candela } of this.lamps) {
      light.intensity = p.lampsOn ? candela : 0;
    }
    if (this.skyDome) {
      this.skyDome.setTimeOfDay(name);
      this.skyDome.refresh({ force: true });
      this.skyDome.applyToScene(this.scene);
      // Restore full strength after the sky writes: the environment map is the
      // only light reaching a wall when the sun is overhead.
      this.scene.environmentIntensity = this.envIntensity;
      if (this.post) this.skyDome.applyToPost(this.post, this.weatherSys);
    }
    if (this.furniture) this.furniture.setLit(p.lampsOn);
    if (this.world && this.world.setFacadeTime) this.world.setFacadeTime(name);
    if (this.lightPool) this.lightPool.update({ x: 0, y: 0, z: 0 }, p.lampsOn ? 1 : 0);
    return p;
  }

  follow(pos) {
    const p = this.preset, d = 400;
    this.sun.position.set(
      pos.x + Math.cos(p.azimuth) * Math.cos(p.elevation) * d,
      Math.sin(p.elevation) * d,
      pos.z + Math.sin(p.azimuth) * Math.cos(p.elevation) * d
    );
    this.sun.target.position.copy(pos);
    this.sun.target.updateMatrixWorld();
    if (this.post) this.post.params.sunDirection.copy(this.sun.position).sub(pos).normalize();
  }

  // Scene-graph audit: what is ACTUALLY in the graph, with units, so a visual
  // review can never again mistake a mis-tuned constant for a missing system.
  audit() {
    const lights = [];
    let shadowCasters = 0, shadowReceivers = 0;
    this.scene.traverse((o) => {
      if (o.isLight) {
        lights.push({
          type: o.type,
          intensity: +o.intensity.toFixed(3),
          unit: o.isDirectionalLight || o.isHemisphereLight ? 'lux' : 'candela',
          color: '#' + o.color.getHexString(),
          castShadow: !!o.castShadow,
          ...(o.distance !== undefined ? { distance: o.distance, decay: o.decay } : {}),
        });
      }
      if (o.isMesh) {
        if (o.castShadow) shadowCasters++;
        if (o.receiveShadow) shadowReceivers++;
      }
    });
    const byType = {};
    for (const l of lights) byType[l.type] = (byType[l.type] || 0) + 1;

    // Plausibility checks against the envelope above.
    const flags = [];
    const env = PLAUSIBLE[this.presetName];
    const sun = lights.find((l) => l.type === 'DirectionalLight');
    const hemi = lights.find((l) => l.type === 'HemisphereLight');
    if (sun && (sun.intensity < env.sunLux[0] || sun.intensity > env.sunLux[1])) {
      flags.push(`sun ${sun.intensity} lux outside plausible ${env.sunLux.join('-')} for ${this.presetName}`);
    }
    if (hemi && (hemi.intensity < env.skyLux[0] || hemi.intensity > env.skyLux[1])) {
      flags.push(`sky ${hemi.intensity} lux outside plausible ${env.skyLux.join('-')} for ${this.presetName}`);
    }
    for (const l of lights.filter((x) => x.type === 'PointLight' && x.intensity > 0)) {
      const [lo, hi] = PLAUSIBLE.lampCandela;
      if (l.intensity < lo || l.intensity > hi) {
        flags.push(`point light ${l.intensity} cd outside plausible ${lo}-${hi}`);
      }
    }
    if (this.preset.lampsOn === false && lights.some((l) => l.type === 'PointLight' && l.intensity > 0)) {
      flags.push('street lamps are lit at a time of day when they should be off');
    }

    if (this.post) {
      const q = this.post.params;
      const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const fogExposed = lum(q.fogColor) * q.exposure;
      const insExposed = lum(q.fogInscatter) * q.exposure;
      // This, not the illuminance ratio, is what decides whether the frame blows
      // out. ACES saturates above roughly 1.5.
      if (fogExposed > 1.2) {
        flags.push(`fog radiance x exposure = ${fogExposed.toFixed(2)}; above ~1.2 the frame washes out`);
      }
      if (insExposed > 3.0) {
        flags.push(`inscatter radiance x exposure = ${insExposed.toFixed(2)}; above ~3.0 the sun lobe blows`);
      }
    }
    if (this.skyDome) {
      const skyAudit = this.skyDome.audit();
      for (const f of skyAudit.implausible ?? []) flags.push(`sky: ${f}`);
      // The sky is the dominant light source in frame. If its illuminance
      // disagrees with the preset the camera stop was set from, the image is
      // wrong however plausible each half looks alone.
      if (Number.isFinite(skyAudit.skyLux)) {
        const ratio = skyAudit.skyLux / Math.max(1e-6, this.preset.skyLux);
        if (ratio > 2 || ratio < 0.5) {
          flags.push(`sky illuminance ${skyAudit.skyLux.toFixed(0)} lux is ${ratio.toFixed(1)}x ` +
            `the ${this.presetName} preset's ${this.preset.skyLux} lux that exposure ` +
            `1/${Math.round(1 / this.preset.exposure)} was calibrated for`);
        }
      }
    }

    return {
      timeOfDay: this.presetName,
      exposure: this.post ? this.post.params.exposure : this.renderer.toneMappingExposure,
      exposureAsStop: `1/${Math.round(1 / (this.post ? this.post.params.exposure : this.renderer.toneMappingExposure))}`,
      toneMapping: this.post ? 'ACESFilmic (post composite)'
        : this.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 'ACESFilmic (renderer)'
        : String(this.renderer.toneMapping),
      postProcessing: this.post ? {
        bloomThreshold: this.post.params.bloomThreshold,
        bloomStrength: this.post.params.bloomStrength,
        fogDensity: +this.post.params.fogDensity.toFixed(5),
        fogHeightFalloff: this.post.params.fogHeightFalloff,
        wetness: this.post.params.wetness,
        passes: this.post.stats.passes,
      } : null,
      shadowMapEnabled: this.renderer.shadowMap.enabled,
      lightCount: lights.length, lightsByType: byType,
      sunLux: sun?.intensity, skyLux: hemi?.intensity,
      litPointLights: lights.filter((l) => l.type === 'PointLight' && l.intensity > 0).length,
      lightPool: this.lightPool ? this.lightPool.report() : null,
      environmentIntensity: this.scene.environmentIntensity,
      hasEnvironment: !!this.scene.environment,
      sky: this.skyDome ? this.skyDome.audit() : null,
      weather: this.weatherSys ? this.weatherSys.report() : null,
      samplePointLightCandela: lights.find((l) => l.type === 'PointLight' && l.intensity > 0)?.intensity ?? 0,
      shadowCasters, shadowReceivers,
      implausible: flags,
    };
  }
}
