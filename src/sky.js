// Sky dome, atmosphere, and the aerial-perspective parameters the post stack reads.
//
// Phase 1's blind critic ranked "no atmospheric scattering — the world ends in a
// razor-sharp horizontal cut" as gap #2. The cut exists because the background was
// a flat colour and the fog colour was an unrelated hand-picked hex. Both ends of
// that mismatch are fixed here by making ONE piece of physics answer both
// questions: what colour is the sky in direction d, and what colour is the haze a
// pixel at distance z is buried in. The fog colour is literally read back out of
// the sky.
//
// Units follow daynight.js: illuminance in lux, radiance/luminance in cd/m^2
// (nits). The dome emits nits, so it lands in the same exposure system as the
// lights and needs no fudge factor. That matters more than it sounds: an sRGB hex
// like 0xa9c3e0 is a radiance of about 0.5 nits, and mixing it into a noon scene
// sitting at 7,000 nits turns the horizon black. That is the bug this file's
// `atmosphere` object exists to stop the engine from re-introducing.
//
// Cost model:
//   - The scattering integral runs ONCE per time-of-day / weather change into a
//     256x128 half-float equirect LUT, and the PMREM environment map is built
//     from that LUT. Neither happens per frame. See refresh() for the measured
//     numbers and Sky.report().
//   - The dome itself is ONE draw call and ONE triangle: a fullscreen triangle
//     written at depth 1.0 so it fills only the pixels nothing else covered. It
//     samples the LUT and adds the sun disc, moon and stars analytically at full
//     resolution, so those stay sharp however small the LUT is.

import * as THREE from '../vendor/three.module.min.js';

// Every colour in this file is a LINEAR reflectance or tint that gets multiplied
// by a luminance in nits. Declaring the source space explicitly is not pedantry:
// THREE.Color(hex) already converts under the default ColorManagement, so the
// convertSRGBToLinear() that reads as belt-and-braces applies the transfer curve
// twice and lands 8x too dark — which is exactly how the night sky lost two stops.
const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// Sun/moon geometry per time of day, matched to daynight.js PRESETS.
//
// The night preset's elevation/azimuth in daynight.js describes the MOON — it is
// what the DirectionalLight points along at 0.6 lux. So night puts the moon there
// and the sun at the antipode, which is exactly the geometry of a full moon and
// keeps the visible moon and the moonlight direction from disagreeing.
export const SKY_PRESETS = {
  noon: {
    sunElevation: 1.32, sunAzimuth: 0.6,
    moonElevation: -0.7, moonAzimuth: 3.7, moonIntensity: 0,
    turbidity: 2.4,
  },
  // Dusk deliberately sits LOWER than daynight.js's 0.055 rad. That preset quotes
  // a direct-normal 1,200 lux and a 900 lux sky, and 1,200 lux of direct sun is
  // what 0.6 deg of elevation transmits, not 3.15 deg — the elevation field and
  // the photometry in that preset disagree with each other. The photometry is the
  // half that the exposure, the plausibility gate and every material response are
  // derived from, so it is the half the dome matches. The cost is a sun disc 2.5
  // deg below where the shadows say it is, at an hour when shadows run off the end
  // of the shadow map anyway.
  dusk: {
    sunElevation: 0, sunAzimuth: 2.72,
    moonElevation: 0.62, moonAzimuth: 5.6, moonIntensity: 0.35,
    turbidity: 3.2,
  },
  night: {
    sunElevation: -0.9, sunAzimuth: 4.1 + Math.PI,
    moonElevation: 0.9, moonAzimuth: 4.1, moonIntensity: 1,
    turbidity: 2.8,
  },
};

// Plausibility envelope for the dome, in the same spirit as daynight.js PLAUSIBLE.
// Sky illuminance is the range daynight.js already asserts for its hemisphere
// light, so a mismatch between the dome and the lights is a measurable failure
// rather than a matter of taste. These describe a CLEAR sky; audit() opens the
// floor in proportion to the cloud deck, because a downpour legitimately takes
// the horizon down by an order of magnitude and a gate that fires on correct
// behaviour gets ignored.
export const PLAUSIBLE_SKY = {
  noon: { zenithNits: [1200, 9000], horizonNits: [2500, 30000], skyLux: [8000, 30000] },
  dusk: { zenithNits: [30, 1200], horizonNits: [120, 12000], skyLux: [100, 2500] },
  night: { zenithNits: [0.02, 2], horizonNits: [0.15, 8], skyLux: [0.5, 12] },
};

// Extraterrestrial normal illuminance. Divided by the sun's solid angle
// (6.8e-5 sr) this is the ~1.9e9 nits of the solar disc.
const SUN_ILLUMINANCE = 127500;
const SUN_SOLID_ANGLE = 6.8e-5;
const SUN_ANGULAR_RADIUS = 0.00465;      // radians; the moon's is the same to 2%

// Rayleigh scattering at sea level for 680/550/440 nm, and Mie at 550 nm.
// Scale heights are the standard 8 km / 1.2 km.
const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6];
const BETA_M = 21e-6;
const H_R = 8000, H_M = 1200;
const EARTH_RADIUS = 6360000;
const KY_HORIZON = 37.92;         // Kasten-Young air mass at zenith angle 90 deg
const MS_ALTITUDE = 6000;         // where twilight's multiply-scattered light is made

// Physical extinction at ground level for the clear default, kept so the artistic
// fog density can quote its multiplier honestly rather than pretending to be real.
const PHYSICAL_EXTINCTION = BETA_R[1] + BETA_M * SKY_PRESETS.noon.turbidity;

const SKY_COMMON = `
#define PI 3.141592653589793
const float Re = 6360000.0;      // earth radius
const float Ra = 6420000.0;      // top of atmosphere
const float Hr = 8000.0;         // Rayleigh scale height
const float Hm = 1200.0;         // Mie scale height

uniform vec3  uSunDir;
uniform float uSunIlluminance;
uniform vec3  uBetaR;
uniform float uBetaM;
uniform float uMieG;
uniform vec2  uMsBoost;          // isotropic multiple-scattering gain: (Rayleigh, Mie)
uniform vec3  uGroundAlbedo;
uniform float uOvercast;
uniform vec3  uCloudTint;        // deck albedo/tint, linear
uniform float uCloudTransmit;    // deck luminance as a share of the clear zenith
uniform float uOvercastFloor;    // deck may not go below this share of the clear sky
uniform vec3  uNightZenith;      // nits
uniform vec3  uNightHorizon;     // nits
uniform float uMaxRadiance;

// Near and far intersection of a ray with a sphere centred on the origin.
// x > y means "no hit".
vec2 raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Kasten-Young relative air mass. Accurate to the horizon and undefined past it:
// the fitted term collapses to zero air mass for zenith angles beyond ~96 deg, so
// a grazing ray comes back UNATTENUATED unless something else handles it. That
// something is sunOpticalDepth below.
#define KY_HORIZON 37.92
#define MS_PATH 0.45          // effective extinction share seen by multiple scattering
float airMass(float sinElevation) {
  float z = degrees(acos(clamp(sinElevation, -1.0, 1.0)));
  return 1.0 / (max(sinElevation, 0.0) + 0.50572 * pow(max(96.07995 - z, 0.001), -1.6364));
}

// Column density of an exponential atmosphere of scale height H along the ray
// leaving p toward the sun, in metres of sea-level-equivalent air.
//
// Above the local horizon this is the vertical column times the air mass. Below
// it, the ray dips to a tangent radius before climbing back out, so the density
// is set by the TANGENT height, not by p's — and by symmetry the path is twice
// the tangent-to-space branch minus the mirrored p-to-space branch. The two
// halves are written against the same KY_HORIZON constant, so they agree exactly
// at the terminator rather than leaving a seam there.
float sunOpticalDepth(float H, float h, float r, float cosChi) {
  float vertical = H * exp(-h / H);
  if (cosChi >= 0.0) return vertical * airMass(cosChi);
  float sinChi = sqrt(max(1.0 - cosChi * cosChi, 0.0));
  float ht = max(r * sinChi - Re, 0.0);
  return 2.0 * KY_HORIZON * H * exp(-ht / H) - vertical * airMass(-cosChi);
}

vec3 sunTransmittance(float sinElevation) {
  float odR = sunOpticalDepth(Hr, 2.0, Re + 2.0, sinElevation);
  float odM = sunOpticalDepth(Hm, 2.0, Re + 2.0, sinElevation);
  return exp(-(uBetaR * odR + uBetaM * 1.11 * odM));
}

// Single scattering with an isotropic multiple-scattering term, marched through an
// exponential atmosphere. Samples that sit in the earth's shadow contribute
// nothing, which is what makes twilight collapse in the right order instead of
// fading uniformly to black.
vec3 scatter(vec3 dir) {
  vec3 origin = vec3(0.0, Re + 2.0, 0.0);
  vec2 atmo = raySphere(origin, dir, Ra);
  vec2 grnd = raySphere(origin, dir, Re);
  bool hitGround = grnd.x > 0.0;
  float tMax = hitGround ? grnd.x : atmo.y;
  float seg = tMax / float(STEPS);

  float odR = 0.0, odM = 0.0;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  vec3 msR = vec3(0.0), msM = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = origin + dir * (seg * (float(i) + 0.5));
    float h = length(p) - Re;
    float dR = exp(-h / Hr) * seg;
    float dM = exp(-h / Hm) * seg;
    odR += dR; odM += dM;

    // Shadow test. raySphere reports "no hit" as x > y, and a miss means the sun
    // ray escapes, i.e. the sample IS lit — testing x > 0 alone throws away every
    // grazing ray and is what makes a naive twilight collapse two hours early.
    vec2 sh = raySphere(p, uSunDir, Re);
    if (sh.x <= sh.y && sh.x > 0.0) continue;

    // Optical depth along the sun ray, analytically. A uniform march cannot do
    // this: at sunset the ray is ~600 km long and all of its mass is in the first
    // 20 km, so 5 even samples put the nearest one at 60 km where the density is
    // e^-7 and report an unattenuated sun. That single error is what kept the
    // dusk sky four times brighter than the value daynight.js asserts.
    float rp = length(p);
    float cosChi = dot(p / rp, uSunDir);
    float odRs = sunOpticalDepth(Hr, h, rp, cosChi);
    float odMs = sunOpticalDepth(Hm, h, rp, cosChi);
    vec3 tau = uBetaR * (odR + odRs) + uBetaM * 1.11 * (odM + odMs);
    vec3 atten = exp(-tau);
    // Multiply-scattered light did not take this one long path — it took an
    // ensemble of shorter ones, so it is neither as dim nor as red as exp(-tau)
    // says. Without this the whole twilight dome, anti-solar horizon included,
    // comes out the colour of the sunset, which is the one direction that is
    // definitely grey-violet in every photograph of one.
    vec3 attenMs = exp(-tau * MS_PATH);
    sumR += dR * atten;
    sumM += dM * atten;
    msR += dR * attenMs;
    msM += dM * attenMs;
  }

  float mu = dot(dir, uSunDir);
  float g = uMieG;
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float phaseM = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));

  vec3 L = uSunIlluminance * (
      sumR * uBetaR * phaseR + msR * uBetaR * uMsBoost.x
    + sumM * uBetaM * phaseM + msM * uBetaM * uMsBoost.y);

  if (hitGround) {
    // Beyond the streamed district the dome IS the ground, so it has to be lit
    // rather than black — this is the half of the "razor-sharp world edge" that a
    // fog pass alone cannot fix.
    vec3 n = normalize(origin + dir * grnd.x);
    float ndl = max(dot(n, uSunDir), 0.0);
    vec3 skyE = vec3(uSunIlluminance * 0.16 * max(uSunDir.y, 0.0)) + (uNightHorizon + uNightZenith) * PI;
    vec3 E = uSunIlluminance * ndl * sunTransmittance(uSunDir.y) + skyE;
    L += uGroundAlbedo * E / PI * exp(-(uBetaR * odR + uBetaM * 1.11 * odM));
  }
  return L;
}

vec3 skyRadiance(vec3 dir) {
  vec3 L = scatter(dir);

  // Overcast: the CIE standard overcast sky, three times brighter at the zenith
  // than at the horizon, blended over the clear result. Rain without a cloud deck
  // reads as a bug, and the deck is also what makes the wet-weather fog grey.
  //
  // The deck's absolute luminance is the CLEAR ZENITH times the deck's
  // transmittance — a second march, paid for only while it is raining. The
  // alternative is an analytic estimate from the sun's elevation, and every one
  // of those has to be re-fitted whenever the turbidity or the scattering
  // constants move: at noon a direct-illuminance estimate is close, and at a sun
  // elevation of half a degree, where the diffuse term is 300x the direct one, it
  // is out by two orders of magnitude and the rain arrives with a black sky.
  if (uOvercast > 0.0) {
    float cie = (1.0 + 2.0 * max(dir.y, 0.0)) / 3.0;
    float below = mix(0.34, 1.0, smoothstep(-0.22, 0.02, dir.y));
    vec3 deck = scatter(vec3(0.0, 1.0, 0.0)) * uCloudTint * uCloudTransmit * cie * below;
    // Floor. Physically a dusk downpour is six times darker than a clear dusk,
    // and daynight.js holds the camera stop and the hemisphere light fixed across
    // weather and audits the dome against them to within 2x. Six times darker at
    // a fixed 1/330 is both correct and unviewable, so the deck may take any
    // direction down by at most this factor of the clear sky in that direction.
    // It binds only at dusk; at noon the deck is already brighter than the floor.
    deck = max(deck, L * uOvercastFloor);
    L = mix(L, deck, uOvercast);
  }

  // Urban skyglow. Orange near the horizon from sodium and warm LED, much dimmer
  // and bluer overhead; cloud bases bounce it back down, so an overcast city night
  // is brighter than a clear one.
  float night = 1.0 - smoothstep(-0.06, 0.10, uSunDir.y);
  // 2.2, not the 3.5 that looks right in isolation: the exponent sets how much of
  // the glow's energy sits near the horizon, and integrating it is what has to
  // land inside daynight.js's night envelope.
  float low = pow(1.0 - clamp(dir.y, 0.0, 1.0), 2.2) * mix(0.35, 1.0, smoothstep(-0.3, 0.02, dir.y));
  L += (uNightZenith + uNightHorizon * low) * night * (1.0 + uOvercast * 1.6);

  // Half-float render targets top out at 65504. An unclamped solar aureole would
  // write Inf, and Inf survives the bloom blur as a screen-wide white smear.
  return min(L, vec3(uMaxRadiance));
}
`;

const LUT_VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const LUT_FRAG = `
precision highp float;
varying vec2 vUv;
${SKY_COMMON}
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * PI;
  float theta = (vUv.y - 0.5) * PI;
  float c = cos(theta);
  vec3 dir = vec3(cos(phi) * c, sin(theta), sin(phi) * c);
  gl_FragColor = vec4(skyRadiance(dir), 1.0);
}
`;

// The dome. A fullscreen triangle whose depth is pinned to 1.0, so it costs one
// triangle and shades only the pixels the scene left empty. Direction comes from
// the inverse view-projection, so nothing has to follow the camera in the graph.
const DOME_VERT = `
uniform mat4 uRayMatrix;
varying vec3 vDir;
void main() {
  vec4 ray = uRayMatrix * vec4(position.xy, 1.0, 1.0);
  vDir = ray.xyz / ray.w;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const DOME_FRAG = `
varying vec3 vDir;
uniform sampler2D uSkyLut;
uniform vec2  uLutSize;
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunDiscColor;
uniform float uSunDiscRadiance;
uniform float uMoonRadiance;
uniform float uMoonPhase;
uniform float uStarIntensity;
uniform float uMilkyWay;
uniform float uMaxRadiance;
uniform float uOvercast;

#define PI 3.141592653589793
#define SUN_R 0.00465

// Bilinear magnification of a 256x128 LUT shows the texel lattice as facets on a
// gradient this smooth. Warping the fractional part through a smoothstep makes the
// interpolation C1 for the cost of two extra instructions and one fetch.
vec3 sampleLut(vec3 d) {
  vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
  vec2 p = uv * uLutSize - 0.5;
  vec2 f = fract(p);
  p = (floor(p) + 0.5 + f * f * (3.0 - 2.0 * f)) / uLutSize;
  return texture2D(uSkyLut, p).rgb;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// One star per lattice cell, brightness distributed so a handful dominate. The
// smoothstep width is a screen-space derivative, otherwise every star is a
// sub-pixel point that crawls as the camera turns.
vec3 stars(vec3 d) {
  vec3 s = d * 190.0;
  vec3 cell = floor(s);
  float h = hash13(cell);
  vec3 offset = vec3(h, hash13(cell + 11.7), hash13(cell + 23.1)) - 0.5;
  float dist = length(fract(s) - 0.5 - offset * 0.7);
  float mag = pow(hash13(cell + 3.3), 9.0);
  float w = max(fwidth(dist), 0.004);
  float disc = 1.0 - smoothstep(0.02, 0.02 + w, dist);
  float warm = hash13(cell + 7.7);
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.66), warm * warm);
  return tint * disc * mag * 34.0;
}

float valueNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 L = sampleLut(dir);
  float clear = 1.0 - uOvercast;

  // Angle to a small disc, via the chord — acos loses precision exactly here.
  float sunAng = 2.0 * asin(clamp(0.5 * length(dir - uSunDir), 0.0, 1.0));
  if (sunAng < SUN_R * 1.6 && uSunDiscRadiance > 0.0) {
    float r = clamp(sunAng / SUN_R, 0.0, 1.0);
    float limb = pow(max(1.0 - r * r, 0.0), 0.32);   // solar limb darkening
    float edge = 1.0 - smoothstep(SUN_R * 0.985, SUN_R * 1.02, sunAng);
    L += uSunDiscColor * uSunDiscRadiance * limb * edge * clear;
  }

  if (uMoonRadiance > 0.0) {
    float ang = 2.0 * asin(clamp(0.5 * length(dir - uMoonDir), 0.0, 1.0));
    float edge = 1.0 - smoothstep(SUN_R * 0.98, SUN_R * 1.03, ang);
    if (edge > 0.0) {
      // Surface detail: two octaves of value noise standing in for maria, and a
      // terminator so the phase reads.
      vec3 up = abs(uMoonDir.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0);
      vec3 rt = normalize(cross(up, uMoonDir));
      vec3 tp = cross(uMoonDir, rt);
      vec2 disc = vec2(dot(dir, rt), dot(dir, tp)) / SUN_R;
      float maria = valueNoise(vec3(disc * 1.6, 4.0)) * 0.5 + valueNoise(vec3(disc * 4.0, 9.0)) * 0.2;
      float shade = mix(0.62, 1.0, smoothstep(0.25, 0.75, maria));
      float lit = smoothstep(-0.12, 0.12, disc.x + (uMoonPhase * 2.0 - 1.0) * 1.05);
      float limb = pow(max(1.0 - dot(disc, disc), 0.0), 0.22);
      L += vec3(1.0, 0.97, 0.92) * uMoonRadiance * edge * shade * limb * mix(0.02, 1.0, lit) * clear;
    }
    // Mie halo around the moon: what makes a night sky read as air rather than space.
    float halo = pow(max(dot(dir, uMoonDir), 0.0), 260.0);
    L += vec3(0.72, 0.79, 1.0) * uMoonRadiance * 2.0e-4 * halo;
  }

  if (uStarIntensity > 0.0) {
    float above = smoothstep(-0.04, 0.06, dir.y);
    L += stars(dir) * uStarIntensity * above * clear;
    if (uMilkyWay > 0.0) {
      // A band on a tilted great circle, broken up by noise. Kept faint on
      // purpose: at this scale a bright one reads as texture noise, not a galaxy.
      vec3 pole = normalize(vec3(0.42, 0.62, -0.66));
      float band = exp(-pow(dot(dir, pole) * 3.1, 2.0));
      float n = valueNoise(dir * 13.0) * 0.6 + valueNoise(dir * 31.0) * 0.4;
      L += vec3(0.78, 0.80, 0.95) * band * (0.35 + n * 0.9) * uMilkyWay * above * clear;
    }
  }

  gl_FragColor = vec4(min(L, vec3(uMaxRadiance)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function fullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

export class Sky {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene              the dome is added to it
   * @param {object} [opts]
   * @param {number} [opts.lutWidth=256]     equirect LUT width (height is half)
   * @param {number} [opts.steps=12]         view-ray samples in the scattering march
   * @param {number} [opts.sunSteps=5]       sun-ray samples per view sample
   * @param {number} [opts.probeWidth=64]    CPU read-back probe width, for fog + audit
   * @param {boolean} [opts.environment=true] build a PMREM env map from the sky
   *        (its cube size is lutWidth/4 — three derives it from the equirect)
   * @param {boolean} [opts.autoRefresh=false] allow update() to regenerate the LUT
   * @param {boolean} [opts.stars=true]
   * @param {boolean} [opts.milkyWay=true]
   * @param {number} [opts.maxRadiance=60000] nits ceiling; keeps half-float finite
   * @param {number} [opts.minRefreshMs=300] floor on automatic regeneration
   * @param {number} [opts.fogDensity=0.0018] clear-air fog density, 1/m
   */
  constructor(renderer, scene, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.lutWidth = opts.lutWidth ?? 256;
    this.lutHeight = this.lutWidth >> 1;
    this.probeWidth = opts.probeWidth ?? 64;
    this.probeHeight = this.probeWidth >> 1;
    this.wantEnvironment = opts.environment ?? true;
    this.maxRadiance = opts.maxRadiance ?? 60000;
    this.minRefreshMs = opts.minRefreshMs ?? 250;
    // Opt-in. Off by default so nothing this module owns can generate inside a
    // frame unless the caller asked for it; weather.js turns it on for the
    // duration of a transition and calls refresh() itself at the end.
    this.autoRefresh = opts.autoRefresh ?? false;
    this.fogDensityClear = opts.fogDensity ?? 0.0018;

    this.presetName = 'dusk';
    this.turbidity = SKY_PRESETS.dusk.turbidity;
    this.overcast = 0;
    this.fogBoost = 0;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonDirection = new THREE.Vector3(0, 1, 0);
    this.moonPhase = 1;

    // Everything a post pass or the engine needs, in one plain object. Colours are
    // LINEAR RADIANCE IN NITS, not sRGB — see the file header.
    this.atmosphere = {
      fogColor: new THREE.Color(0, 0, 0),
      fogInscatter: new THREE.Color(0, 0, 0),
      density: this.fogDensityClear,
      heightFalloff: 0.011,
      heightRef: 0,
      sunDirection: new THREE.Vector3(0, 1, 0),
      zenithNits: 0,
      horizonNits: 0,
      skyLux: 0,
      sunLux: 0,
      physicalExtinction: PHYSICAL_EXTINCTION,
      artisticMultiplier: 1,
    };

    const t0 = performance.now();
    this.timings = {};

    this.lut = new THREE.WebGLRenderTarget(this.lutWidth, this.lutHeight, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.lut.texture.wrapS = THREE.RepeatWrapping;        // makes the +-pi seam filter correctly
    this.lut.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.lut.texture.mapping = THREE.EquirectangularReflectionMapping;

    this.probe = new THREE.WebGLRenderTarget(this.probeWidth, this.probeHeight, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    // Two buffers and a generation counter, because the async read-back and a
    // later synchronous one otherwise share storage: a queued read of the OLD
    // sky lands after a forced refresh of the new one, overwrites the buffer and
    // re-derives the fog colour from it. That reads as "weather changes the fog
    // one state late", which looks like a transition bug and is not one.
    this._probeBuffer = new Uint16Array(this.probeWidth * this.probeHeight * 4);
    this._probeBufferAsync = new Uint16Array(this.probeWidth * this.probeHeight * 4);
    this._probeRGB = new Float32Array(this.probeWidth * this.probeHeight * 3);
    this._probeGen = 0;
    this._derivedGen = -1;

    this._uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: SUN_ILLUMINANCE },
      uBetaR: { value: new THREE.Vector3(...BETA_R) },
      uBetaM: { value: BETA_M * this.turbidity },
      uMieG: { value: opts.mieG ?? 0.76 },
      // Tuned against the read-back zenith/horizon luminance so noon lands inside
      // PLAUSIBLE_SKY rather than at the single-scattering value, which is roughly
      // a third of a real sky and far too saturated.
      uMsBoost: { value: new THREE.Vector2(0.115, 0.030) },
      uGroundAlbedo: { value: srgb(0x6b6455) },
      uOvercast: { value: 0 },
      uCloudTint: { value: new THREE.Vector3() },
      uCloudTransmit: { value: 1.0 },
      uOvercastFloor: { value: 0.32 },
      uNightZenith: { value: new THREE.Vector3() },
      uNightHorizon: { value: new THREE.Vector3() },
      uMaxRadiance: { value: this.maxRadiance },
    };
    // Urban skyglow, in nits. Sized so the dome's own hemispherical illuminance
    // lands inside the 0.5-12 lux daynight.js already asserts for night — the two
    // numbers describe the same sky and a mismatch is a measurable bug, not taste.
    // Unweighted isotropic gains, tuned so noon lands mid-envelope; _msWeight()
    // scales them with the sun.
    this.msBoost = new THREE.Vector2(0.115, 0.030);
    this.nightZenithColor = srgb(0x4c5f8e);
    this.nightHorizonColor = srgb(0xff9c50);
    this.nightZenithNits = 2.1;
    this.nightHorizonNits = 6.6;
    this.cloudColor = srgb(0xb9c2cc);
    // Deck luminance as a share of the clear zenith — near unity, because a lit
    // cloud base and a clear zenith are about equally luminous overhead (one is
    // white and dim-lit, the other blue and bright-lit). What collapses under a
    // deck is the HORIZON, and the CIE 1:3 gradient in the shader does that part.
    this.cloudTransmit = opts.cloudTransmit ?? 1.0;
    this.overcastFloor = opts.overcastFloor ?? 0.32;

    const defines = `#define STEPS ${opts.steps ?? 12}\n#define SUN_STEPS ${opts.sunSteps ?? 5}\n`;
    this.lutMaterial = new THREE.RawShaderMaterial({
      vertexShader: LUT_VERT,
      fragmentShader: defines + LUT_FRAG,
      uniforms: this._uniforms,
      depthTest: false, depthWrite: false,
    });

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.Camera();
    this.quad = new THREE.Mesh(fullscreenTriangle(), this.lutMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.domeMaterial = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uRayMatrix: { value: new THREE.Matrix4() },
        uSkyLut: { value: this.lut.texture },
        uLutSize: { value: new THREE.Vector2(this.lutWidth, this.lutHeight) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunDiscColor: { value: new THREE.Vector3(1, 1, 1) },
        uSunDiscRadiance: { value: 0 },
        uMoonRadiance: { value: 0 },
        uMoonPhase: { value: 1 },
        uStarIntensity: { value: opts.stars === false ? 0 : 1 },
        uMilkyWay: { value: 0 },
        uMaxRadiance: { value: this.maxRadiance },
        uOvercast: { value: 0 },
      },
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: true,
    });
    this.starIntensity = this.domeMaterial.uniforms.uStarIntensity.value;
    this.milkyWayIntensity = opts.milkyWay === false ? 0 : (opts.milkyWay ?? 0.6);

    this.dome = new THREE.Mesh(fullscreenTriangle(), this.domeMaterial);
    this.dome.name = 'sky';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000;         // after opaque geometry: zero sky overdraw
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    this.dome.matrixAutoUpdate = false;
    scene.add(this.dome);

    if (this.wantEnvironment) {
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.pmrem.compileEquirectangularShader();
      this.envTarget = null;
    }

    this._lastRefresh = -1e9;
    this._dirty = true;
    this._rayMatrix = new THREE.Matrix4();
    this._camRotation = new THREE.Matrix4();
    this.stats = { refreshes: 0, envRefreshes: 0, lastRefreshMs: 0, worstRefreshMs: 0,
                   lastEnvMs: 0, lastReadbackMs: 0 };
    this._post = null;
    this._postWeather = null;
    this._envScene = null;
    this._probePending = false;
    this._canReadAsync = typeof renderer.readRenderTargetPixelsAsync === 'function';

    this.setTimeOfDay('dusk');
    this.refresh({ force: true });
    this.generationMs = performance.now() - t0;
  }

  // ------------------------------------------------------------------ state
  /** Match daynight.js: 'noon' | 'dusk' | 'night'. */
  setTimeOfDay(name) {
    const p = SKY_PRESETS[name];
    if (!p) throw new Error(`unknown sky preset: ${name}`);
    this.presetName = name;
    this.turbidity = p.turbidity;
    this.setSun(p.sunElevation, p.sunAzimuth);
    this.setMoon(p.moonElevation, p.moonAzimuth, 1, p.moonIntensity);
    this._dirty = true;
    return this;
  }

  /** Elevation from the horizon and azimuth, both radians, matching daynight.js. */
  setSun(elevation, azimuth) {
    this.sunDirection.set(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.sin(azimuth) * Math.cos(elevation)
    ).normalize();
    this._dirty = true;
    return this;
  }

  setMoon(elevation, azimuth, phase = 1, intensity = 1) {
    this.moonDirection.set(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.sin(azimuth) * Math.cos(elevation)
    ).normalize();
    this.moonPhase = phase;
    this.moonIntensity = intensity;
    return this;
  }

  /**
   * 0..1 cloud deck. weather.js drives this; it is what makes rain read as rain
   * and what turns the fog grey, because the fog colour is sampled from the sky.
   */
  setOvercast(x) {
    const v = Math.min(1, Math.max(0, x));
    if (Math.abs(v - this.overcast) > 0.02) this._dirty = true;
    this.overcast = v;
    return this;
  }

  setTurbidity(t) {
    const v = Math.min(12, Math.max(1, t));
    if (Math.abs(v - this.turbidity) > 0.1) this._dirty = true;
    this.turbidity = v;
    return this;
  }

  /** Extra fog density from weather, as a multiplier on the clear-air value. */
  setFogBoost(x) { this.fogBoost = Math.max(0, x); return this; }

  // ------------------------------------------------------------------ update
  /**
   * Per frame. One matrix multiply, a dozen uniform writes and, if a PostStack
   * was attached, the aerial-perspective params pushed into it again — because
   * TimeOfDay._applyPost() rewrites those from its own hex table on every
   * apply()/setWeather(), and the last writer wins.
   *
   * It never generates anything. The scattering LUT is regenerated only by
   * refresh(), or by the opt-in throttled path below (autoRefresh), which still
   * leaves the PMREM environment map to an explicit call.
   */
  update(camera, now = performance.now()) {
    const u = this.domeMaterial.uniforms;
    this._rayMatrix.copy(camera.projectionMatrixInverse);
    // Rotation only: the ray direction must not carry the camera's translation.
    this._camRotation.extractRotation(camera.matrixWorld);
    this._rayMatrix.premultiply(this._camRotation);
    u.uRayMatrix.value.copy(this._rayMatrix);
    if (this._post) this.applyToPost(this._post, this._postWeather);
    if (this.autoRefresh && this._dirty && now - this._lastRefresh >= this.minRefreshMs) {
      // No environment map and no GPU sync on this path: it runs inside a frame.
      this.refresh({ environment: false, sync: false });
    }
    return this;
  }

  /**
   * Regenerate the scattering LUT, the fog parameters and — unless told not to —
   * the PMREM environment map. NOT per frame. Call it after a time-of-day change
   * or when weather has finished moving; daynight.js's setSky()/apply() already
   * does. Measured costs are in report().
   *
   * @param {object} [o]
   * @param {boolean} [o.force]        regenerate even if nothing is marked dirty
   * @param {boolean} [o.environment]  rebuild the PMREM env map (the expensive half)
   * @param {boolean} [o.sync]         block on the probe read-back. True gives
   *        fog params valid on return; false costs no GPU stall and lands them a
   *        frame or two later, which is what the in-frame path uses.
   * @returns {number} milliseconds spent on the calling thread
   */
  refresh({ force = false, environment = true, sync = true } = {}) {
    if (!force && !this._dirty) return 0;
    const t0 = performance.now();
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;

    this._pushUniforms();
    this.quad.material = this.lutMaterial;

    r.setRenderTarget(this.lut);
    r.render(this.quadScene, this.quadCamera);
    r.setRenderTarget(this.probe);
    r.render(this.quadScene, this.quadCamera);

    const tRead = performance.now();
    const gen = ++this._probeGen;
    if (sync || !this._canReadAsync) {
      // three's readRenderTargetPixelsAsync binds a PIXEL_PACK_BUFFER and leaves
      // it bound for the lifetime of its fence. A synchronous readPixels into a
      // typed array while that binding is live is an INVALID_OPERATION: it writes
      // nothing and leaves the previous contents in place, so the fog colour
      // trails the weather by exactly one state and looks like a transition bug.
      // The async read re-binds its own buffer after the await, so clearing the
      // binding here cannot disturb it.
      const gl = r.getContext();
      if (gl.PIXEL_PACK_BUFFER !== undefined) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      r.readRenderTargetPixels(this.probe, 0, 0, this.probeWidth, this.probeHeight, this._probeBuffer);
      this._deriveFromProbe(this._probeBuffer, gen);
    } else if (!this._probePending) {
      // A synchronous readPixels of a render target the GPU has not finished
      // writing costs a full pipeline flush — 30 ms here, and it would land in
      // the frame slice the stall gate measures. The async path fences instead.
      this._probePending = true;
      r.readRenderTargetPixelsAsync(this.probe, 0, 0, this.probeWidth, this.probeHeight, this._probeBufferAsync)
        .then(() => { this._deriveFromProbe(this._probeBufferAsync, gen); })
        .catch(() => { this._canReadAsync = false; })
        .finally(() => { this._probePending = false; });
    }
    this.stats.lastReadbackMs = +(performance.now() - tRead).toFixed(2);

    const tEnv = performance.now();
    if (this.wantEnvironment && environment) {
      // The env map deliberately excludes the sun disc: three's DirectionalLight
      // already supplies the sun's specular, and putting it in the IBL as well
      // double-counts it. The dome adds the disc afterwards, at full resolution.
      this.envTarget = this.pmrem.fromEquirectangular(this.lut.texture, this.envTarget);
      this.environment = this.envTarget.texture;
      if (this._envScene) this.applyToScene(this._envScene);
      this.stats.envRefreshes++;
    }
    this.stats.lastEnvMs = +(performance.now() - tEnv).toFixed(2);

    r.setRenderTarget(prevTarget);
    r.toneMapping = prevTone;
    this._dirty = false;
    this._lastRefresh = performance.now();
    const ms = this._lastRefresh - t0;
    this.stats.refreshes++;
    this.stats.lastRefreshMs = +ms.toFixed(2);
    this.stats.worstRefreshMs = Math.max(this.stats.worstRefreshMs, this.stats.lastRefreshMs);
    return ms;
  }

  _pushUniforms() {
    const u = this._uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uBetaM.value = BETA_M * this.turbidity;
    u.uOvercast.value = this.overcast;
    u.uMaxRadiance.value = this.maxRadiance;

    // Multiple scattering is modelled as an isotropic addition to the phase
    // functions, and it has to be weighted by how much sun reaches the air that
    // produces it — the mid-troposphere, not the ground. Left flat, single
    // scattering falls off correctly through twilight while the isotropic term
    // does not, and the model reports a 2,500 lux sky with the sun on the horizon
    // against the 100-2,500 daynight.js allows for the whole of dusk.
    const msW = this._msWeight();
    u.uMsBoost.value.set(this.msBoost.x * msW, this.msBoost.y * msW);

    u.uCloudTint.value.set(this.cloudColor.r, this.cloudColor.g, this.cloudColor.b);
    u.uCloudTransmit.value = this.cloudTransmit;
    u.uOvercastFloor.value = this.overcastFloor;

    const nz = this.nightZenithNits, nh = this.nightHorizonNits;
    u.uNightZenith.value.set(this.nightZenithColor.r * nz, this.nightZenithColor.g * nz, this.nightZenithColor.b * nz);
    u.uNightHorizon.value.set(this.nightHorizonColor.r * nh, this.nightHorizonColor.g * nh, this.nightHorizonColor.b * nh);

    const d = this.domeMaterial.uniforms;
    d.uSunDir.value.copy(this.sunDirection);
    d.uMoonDir.value.copy(this.moonDirection);
    d.uMoonPhase.value = this.moonPhase;
    d.uOvercast.value = this.overcast;
    d.uMaxRadiance.value = this.maxRadiance;

    // Solar disc luminance = illuminance / solid angle, attenuated by the air mass
    // the beam crossed. This is the same 1.9e9 nits a light meter would read.
    const t = this._transmittance(this.sunDirection.y);
    const discL = SUN_ILLUMINANCE / SUN_SOLID_ANGLE;
    const peak = Math.max(t[0], t[1], t[2]) || 1e-6;
    d.uSunDiscColor.value.set(t[0] / peak, t[1] / peak, t[2] / peak);
    d.uSunDiscRadiance.value = this.sunDirection.y > -0.02 ? discL * peak : 0;

    // Full-moon surface luminance is ~2,500 nits: bright enough to clip at night
    // exposure, which is exactly how it photographs.
    const moonUp = this.moonDirection.y > -0.02 ? 1 : 0;
    d.uMoonRadiance.value = 2500 * (this.moonIntensity ?? 1) * moonUp;
    const night = 1 - smoothstep(-0.06, 0.10, this.sunDirection.y);
    d.uStarIntensity.value = this.starIntensity * night;
    // Peak band radiance in nits, pinned to a fraction of the zenith glow: a
    // galaxy brighter than the sky it is painted on reads as texture noise.
    d.uMilkyWay.value = this.milkyWayIntensity * night
      * luminance([this.nightZenithColor.r, this.nightZenithColor.g, this.nightZenithColor.b])
      * this.nightZenithNits;

  }

  // Sunlight reaching MS_ALTITUDE, normalised to a high sun. One number per
  // refresh; it is constant across the LUT because it depends only on the sun.
  _msWeight() {
    const y = this.sunDirection.y;
    const at = (sinEl) => {
      const r = EARTH_RADIUS + MS_ALTITUDE;
      const odR = this._sunOpticalDepth(H_R, MS_ALTITUDE, r, sinEl);
      const odM = this._sunOpticalDepth(H_M, MS_ALTITUDE, r, sinEl) * this.turbidity * 1.11;
      return Math.exp(-(BETA_R[1] * odR + BETA_M * odM));
    };
    return Math.min(1, at(y) / at(1));
  }

  _airMass(sinElevation) {
    const z = (Math.acos(Math.min(1, Math.max(-1, sinElevation))) * 180) / Math.PI;
    return 1 / (Math.max(sinElevation, 0) + 0.50572 * Math.pow(Math.max(96.07995 - z, 0.001), -1.6364));
  }

  // JS mirror of sunOpticalDepth() in SKY_COMMON. Two copies of one model is a
  // liability, so they are kept adjacent in review and the audit compares the
  // result against the LUT the shader actually rendered.
  _sunOpticalDepth(H, h, r, cosChi) {
    const vertical = H * Math.exp(-h / H);
    if (cosChi >= 0) return vertical * this._airMass(cosChi);
    const sinChi = Math.sqrt(Math.max(1 - cosChi * cosChi, 0));
    const ht = Math.max(r * sinChi - EARTH_RADIUS, 0);
    return 2 * KY_HORIZON * H * Math.exp(-ht / H) - vertical * this._airMass(-cosChi);
  }

  _transmittance(sinElevation) {
    const r = EARTH_RADIUS + 2;
    const odR = this._sunOpticalDepth(H_R, 2, r, sinElevation);
    const odM = this._sunOpticalDepth(H_M, 2, r, sinElevation) * this.turbidity * 1.11;
    return BETA_R.map((b, i) => Math.exp(-(b * odR + BETA_M * odM)));
  }

  // Read the probe once per refresh and derive every CPU-side number from it, so
  // the fog colour, the audit and the shader can never drift apart.
  _deriveFromProbe(buffer, gen) {
    if (gen < this._derivedGen) return;      // a stale async read landing late
    this._derivedGen = gen;
    const W = this.probeWidth, H = this.probeHeight;
    const rgb = this._probeRGB;
    const half = THREE.DataUtils.fromHalfFloat;
    for (let i = 0, n = W * H; i < n; i++) {
      rgb[i * 3] = half(buffer[i * 4]);
      rgb[i * 3 + 1] = half(buffer[i * 4 + 1]);
      rgb[i * 3 + 2] = half(buffer[i * 4 + 2]);
    }

    // Horizon band: the first two rows above elevation 0, weighted toward the
    // lower one. Rows below the horizon are the lit ground plane, which is a
    // brown 5,000-nit surface at noon and has no business setting the haze tint.
    const bandRows = [[H >> 1, 0.72], [(H >> 1) + 1, 0.28]];
    const sunAz = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    let towards = [0, 0, 0], away = [0, 0, 0], twSum = 0, awSum = 0;
    let ringY = 0;
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      let dPhi = Math.abs(phi - sunAz) % (Math.PI * 2);
      if (dPhi > Math.PI) dPhi = Math.PI * 2 - dPhi;
      const c = [0, 0, 0];
      for (const [row, wr] of bandRows) {
        const i = (row * W + x) * 3;
        c[0] += rgb[i] * wr; c[1] += rgb[i + 1] * wr; c[2] += rgb[i + 2] * wr;
      }
      ringY += luminance(c) / W;
      // Weight by how close this azimuth is to the sun's; the post stack blends
      // the two with pow(dot(view, sun), 6), so these must be the two extremes.
      const w = Math.pow(Math.max(0, Math.cos(dPhi)), 4);
      const wa = Math.pow(Math.max(0, -Math.cos(dPhi)), 2) + 0.04;
      twSum += w; awSum += wa;
      for (let k = 0; k < 3; k++) { towards[k] += c[k] * w; away[k] += c[k] * wa; }
    }
    for (let k = 0; k < 3; k++) { towards[k] /= Math.max(twSum, 1e-6); away[k] /= Math.max(awSum, 1e-6); }

    const a = this.atmosphere;
    a.fogColor.setRGB(away[0], away[1], away[2]);
    a.fogInscatter.setRGB(towards[0], towards[1], towards[2]);
    a.horizonNits = ringY;

    // Zenith row and the hemispherical illuminance, E = int L cos(theta) dw.
    let zen = [0, 0, 0], lux = 0;
    const dPhi = (Math.PI * 2) / W, dTheta = Math.PI / H;
    for (let y = H >> 1; y < H; y++) {
      const theta = ((y + 0.5) / H - 0.5) * Math.PI;
      const w = Math.sin(theta) * Math.cos(theta) * dTheta * dPhi;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        lux += luminance([rgb[i], rgb[i + 1], rgb[i + 2]]) * w;
        if (y === H - 1) { zen[0] += rgb[i] / W; zen[1] += rgb[i + 1] / W; zen[2] += rgb[i + 2] / W; }
      }
    }
    a.zenithNits = luminance(zen);
    a.skyLux = lux;

    // Direct sun illuminance on a surface facing it, after extinction. daynight.js
    // quotes 100,000 lux at noon; this is the same quantity measured off the model.
    const t = this._transmittance(this.sunDirection.y);
    a.sunLux = this.sunDirection.y > -0.02
      ? SUN_ILLUMINANCE * luminance(t) * (1 - this.overcast * 0.93) : 0;

    // The post stack's inscatter lobe points at whatever is lighting the scene,
    // which after sunset is the moon. daynight.js aims its DirectionalLight the
    // same way, so the two agree instead of fighting once a frame.
    a.sunDirection.copy(this.sunDirection.y > 0.01 ? this.sunDirection : this.moonDirection);

    // Fog density: an artistic multiple of the physical ground extinction. A real
    // 5.5e-5 /m is invisible over a 1 km draw distance, so games exaggerate it;
    // quoting the multiplier keeps that an explicit decision.
    a.density = this.fogDensityClear * (1 + this.overcast * 0.45) * (1 + this.fogBoost * 0.55);
    a.artisticMultiplier = +(a.density / PHYSICAL_EXTINCTION).toFixed(1);
    // Haze layer thickness: ~90 m clear, compressing toward ~55 m in rain.
    a.heightFalloff = 0.011 * (1 + this.overcast * 0.35) * (1 + this.fogBoost * 0.25);
  }

  // ------------------------------------------------------------------ wiring
  /**
   * Write the atmosphere into a PostStack. MUST run after TimeOfDay.apply() or
   * TimeOfDay.setWeather(), both of which overwrite post.params from their own
   * preset table. Pass the weather to have it carry wetness across in the same
   * call. Cost: a dozen assignments.
   */
  applyToPost(post, weather = null) {
    if (!post || !post.params) return this;
    // Remembered so update() can re-assert it every frame. TimeOfDay._applyPost()
    // runs on every apply() and setWeather() and would otherwise put the hex fog
    // back — at noon that is an sRGB 0.66 multiplied by a 1/78000 stop, i.e. a
    // world that fades to black as it recedes.
    this._post = post;
    this._postWeather = weather ?? this._postWeather;
    const p = post.params, a = this.atmosphere;
    p.fogColor.copy(a.fogColor);
    p.fogInscatter.copy(a.fogInscatter);
    p.fogDensity = a.density;
    p.fogHeightFalloff = a.heightFalloff;
    p.fogHeightRef = a.heightRef;
    p.sunDirection.copy(a.sunDirection);
    if (weather) p.wetness = weather.wetness;
    return this;
  }

  /**
   * scene.environment for metals, glass and wet roads. daynight.js also runs a
   * HemisphereLight at the same sky illuminance, so leaving environmentIntensity
   * at 1 counts the sky's diffuse twice — see recommendedEnvironmentIntensity.
   */
  applyToScene(scene = this.scene) {
    this._envScene = scene;
    if (this.environment) {
      scene.environment = this.environment;
      scene.environmentIntensity = this.recommendedEnvironmentIntensity;
    }
    scene.background = null;      // the dome IS the background
    return this;
  }

  get recommendedEnvironmentIntensity() { return 0.35; }

  // ------------------------------------------------------------------ audit
  report() {
    const a = this.atmosphere;
    return {
      preset: this.presetName,
      generationMs: +this.generationMs.toFixed(1),
      lut: `${this.lutWidth}x${this.lutHeight} RGBA16F`,
      envMap: this.envTarget ? `PMREM ${this.envTarget.width}x${this.envTarget.height}` : 'none',
      refreshes: this.stats.refreshes,
      lastRefreshMs: this.stats.lastRefreshMs,
      worstRefreshMs: this.stats.worstRefreshMs,
      envMs: this.stats.lastEnvMs,
      readbackMs: this.stats.lastReadbackMs,
      drawCalls: 1,
      triangles: 1,
      turbidity: +this.turbidity.toFixed(2),
      overcast: +this.overcast.toFixed(2),
      zenithNits: +a.zenithNits.toFixed(a.zenithNits < 10 ? 3 : 0),
      horizonNits: +a.horizonNits.toFixed(a.horizonNits < 10 ? 3 : 0),
      skyLux: +a.skyLux.toFixed(a.skyLux < 10 ? 3 : 0),
      sunLux: +a.sunLux.toFixed(0),
      fogColorNits: [a.fogColor.r, a.fogColor.g, a.fogColor.b].map((v) => +v.toFixed(2)),
      fogInscatterNits: [a.fogInscatter.r, a.fogInscatter.g, a.fogInscatter.b].map((v) => +v.toFixed(2)),
      fogDensity: +a.density.toFixed(5),
      fogHeightFalloff: +a.heightFalloff.toFixed(4),
      artisticMultiplier: a.artisticMultiplier,
    };
  }

  /** Same contract as TimeOfDay.audit(): flags, not opinions. */
  audit() {
    const env = PLAUSIBLE_SKY[this.presetName];
    const a = this.atmosphere;
    const flags = [];
    if (env) {
      const dim = 1 - 0.92 * this.overcast;
      const check = (name, v, [lo, hi], unit) => {
        const min = lo * dim;
        if (v < min || v > hi) {
          flags.push(`${name} ${v.toPrecision(3)} ${unit} outside plausible ${+min.toPrecision(3)}-${hi}`
            + ` for ${this.presetName}${this.overcast > 0 ? ` at overcast ${this.overcast.toFixed(2)}` : ''}`);
        }
      };
      check('zenith luminance', a.zenithNits, env.zenithNits, 'nits');
      check('horizon luminance', a.horizonNits, env.horizonNits, 'nits');
      check('sky illuminance', a.skyLux, env.skyLux, 'lux');
    }
    if (!isFinite(a.fogColor.r) || a.fogColor.r > this.maxRadiance) {
      flags.push('fog colour is not finite — a half-float target has overflowed');
    }
    if (a.fogColor.r < 0.05 && this.presetName !== 'night') {
      flags.push('fog colour is near zero in daylight — it is probably an sRGB hex, not radiance');
    }
    return { ...this.report(), implausible: flags };
  }

  dispose() {
    this.scene.remove(this.dome);
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    this.lutMaterial.dispose();
    this.quad.geometry.dispose();
    this.lut.dispose();
    this.probe.dispose();
    if (this.envTarget) this.envTarget.dispose();
    if (this.pmrem) this.pmrem.dispose();
  }
}

function luminance(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Convenience: build the sky, park it in the scene and hand back the instance. */
export function createSky(renderer, scene, opts) { return new Sky(renderer, scene, opts); }
