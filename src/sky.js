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
// Cost model, all measured on the SwiftShader software rasteriser this project
// gates against, so every number here is a ceiling rather than a target:
//   - The dome is ONE draw call and ONE triangle: a fullscreen triangle written
//     at depth 1.0, drawn after opaque geometry, so it shades only the pixels
//     nothing else covered. It samples the LUT and adds the sun disc, moon and
//     stars analytically at full resolution, so those stay sharp however small
//     the LUT is.
//   - update() generates nothing: one matrix multiply and a dozen uniform
//     writes. Measured median 0.0 ms, p99 0.1 ms, max 0.2 ms over 400 calls.
//   - The scattering integral runs into a 256x128 half-float equirect LUT ONLY
//     from refresh(), never from update() unless autoRefresh is switched on.
//     Construction, including shader compilation, the LUT, the probe read-back
//     and the PMREM: 333-386 ms over three cold loads.
//   - The PMREM environment map is the expensive half — 108-181 ms of that — and
//     is rebuilt only when refresh() is asked for it. Inside a live frame loop
//     the same rebuild measures 440-2,400 ms on this rasteriser, which is why
//     weather.js's settle refresh explicitly excludes it.

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
  // Dusk sits on the horizon, not at daynight.js's 0.055 rad (3.15 deg). That
  // preset quotes a 900 lux sky and a direct-normal 1,200 lux, and its own two
  // numbers disagree: 3.15 deg of elevation transmits about 8,800 lux and lights
  // a 5,800 lux sky, six times what the preset says and past the envelope its
  // audit asserts. Zero elevation reproduces the photometry (measured: 1,614 lux
  // sky, 394 lux direct) and the photometry is the half that the camera stop, the
  // plausibility gate and every material response are derived from. Refraction
  // lifts the visible disc about 0.57 deg anyway, so a geometrically-set sun sits
  // exactly where a photographed one does. The cost is a disc ~3 deg below where
  // the shadows say it is, at an hour when shadows run off the shadow map.
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
  night: { zenithNits: [0.005, 0.4], horizonNits: [0.05, 2.5], skyLux: [0.05, 3] },
};

// Extraterrestrial normal illuminance. Divided by the sun's solid angle
// (6.8e-5 sr) this is the ~1.9e9 nits of the solar disc.
const SUN_ILLUMINANCE = 127500;
const SUN_SOLID_ANGLE = 6.8e-5;          // subtended by a 0.00465 rad disc

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
uniform vec2  uMsBoost;          // multiple-scattering gain: (Rayleigh, Mie)
uniform float uMsAniso;          // forward bias of that term, 0 = isotropic
uniform vec3  uMsWarm;           // its tint toward the sun, luminance normalised to 1
uniform vec3  uMsCool;           // ...and away from it, likewise
uniform vec4  uGlowShape;        // urban skyglow: (layer height, self-extinction, g(zenith), 1/(g(0)-g(zenith)))
uniform vec3  uGroundAlbedo;
uniform float uGroundHaze;       // 1/radian: how fast the ground wins under the horizon
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
  // raySphere reports "no hit" as x > y, and its x is then 1.0 — which a bare
  // "grnd.x > 0" test reads as a hit one metre away. A ray leaving 2 m above the
  // surface exactly horizontally MISSES the earth, so that test collapsed the
  // march to a single metre and rendered the horizon row of the LUT at a
  // fifteenth of its neighbours: a dark line drawn along the horizon by the one
  // piece of code whose job is to stop there being a line along the horizon.
  bool hitGround = grnd.x <= grnd.y && grnd.x > 0.0;
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

  // The multiply-scattered term is NOT isotropic, and pretending it was is why
  // three independent blind critics measured this sky as x-invariant: at dusk
  // single scattering is extinguished by 38 air masses while the MS term, which
  // only ever sees exp(-tau * MS_PATH), survives - so the MS term IS the twilight
  // sky, and an isotropic MS term is a 1-D vertical ramp by construction.
  //
  // Two effects, both energy-preserving so the plausibility gate still measures
  // the same sky:
  //   - a forward bias (1 + a*mu). Its mean over any azimuth ring is exactly 1
  //     whenever the sun sits on the horizon, so zenith luminance, the horizon
  //     ring average and the hemispherical illuminance are untouched at dusk and
  //     only redistributed across azimuth. a is faded out as the sun climbs.
  //   - a spectral swing between two tints that BOTH have luminance 1: warm on
  //     the solar side, where the light that got here crossed the low, reddened
  //     atmosphere, and cool on the anti-solar side, where it came over the top.
  //     That is the Belt of Venus and the earth's shadow, and it is the reason a
  //     photograph taken facing away from a sunset is blue rather than orange.
  //
  // The forward bias is weighted DOWN with elevation. Measured on the dusk hero
  // frame, which looks 172 deg away from the sun: at 22 degrees up the sky's own
  // azimuthal gradient is the Rayleigh BACKSCATTER peak, 1.27x brighter at the
  // anti-solar point than 50 deg off it, and a flat forward bias cancels it -
  // the first version of this measured 1.18x where the isotropic code measured
  // 1.27x, i.e. it made the sky flatter, not less flat. Low in the sky the
  // solar/anti-solar split is the dominant term and the bias belongs there; high
  // up it does not. A weight that depends only on dir.y still has mean 1 around
  // every azimuth ring, so this stays energy-preserving.
  float fwd = 0.5 + 0.5 * mu;
  float lowW = mix(1.0, 0.30, smoothstep(0.02, 0.50, dir.y));
  vec3 msTint = mix(uMsCool, uMsWarm, fwd) * max(0.0, 1.0 + uMsAniso * lowW * mu);

  vec3 L = uSunIlluminance * (
      sumR * uBetaR * phaseR + msR * uBetaR * uMsBoost.x * msTint
    + sumM * uBetaM * phaseM + msM * uBetaM * uMsBoost.y * msTint);

  return L;
}

// Radiance of the lit ground the dome stands in for beyond the draw distance.
// Direction-independent: at these distances what varies with direction is the
// haze in front of it, not the terrain behind it.
vec3 groundRadiance() {
  float ndl = max(uSunDir.y, 0.0);
  vec3 skyE = vec3(uSunIlluminance * 0.16 * ndl) + (uNightHorizon + uNightZenith) * PI;
  vec3 E = uSunIlluminance * ndl * sunTransmittance(uSunDir.y) + skyE;
  return uGroundAlbedo * E / PI;
}

vec3 skyRadiance(vec3 dir) {
  // Below the horizon the dome is standing in for terrain past the draw
  // distance, and what that terrain looks like from here is the HORIZON's
  // airlight — a long grazing path — not the airlight of the short downward ray
  // that actually reaches it. Marching the real ray gives a dark, physically
  // clear strip; the frame puts the same distance at 80% haze because the
  // engine's fog is ~20x physical extinction. The visible result of getting this
  // wrong is a hard band exactly where the far plane clips the ground plane:
  // 1.5 degrees deep from a 46 m camera, which is the razor cut again wearing a
  // different colour.
  //
  // So: evaluate the scattering along the horizon, then fade the lit ground in
  // underneath it. Continuous at dir.y = 0 by construction.
  float below = max(-dir.y, 0.0);
  vec3 L = scatter(normalize(vec3(dir.x, max(dir.y, 0.0), dir.z)));
  if (below > 0.0) L = mix(L, groundRadiance(), 1.0 - exp(-below * uGroundHaze));

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

  // Urban skyglow: city light scattered back down out of the boundary layer.
  //
  // The profile is the AIR MASS of that layer, 1/(mu + h), not an ad-hoc power of
  // (1 - mu). That matters because it is the physics that makes the horizon the
  // BRIGHTEST part of a real city sky - the line of sight crosses ~7x more lit
  // haze at the rooftops than at the zenith - and because it turns over in the
  // last couple of degrees, where the glow's own extinction finally beats the
  // growing path. exp(-k*(X-1)) is that turnover. Normalised so the shaped term
  // is 1 at the horizon and 0 at the zenith, which lets the two colours below be
  // stated as plain luminances: uNightZenith IS the zenith in nits and
  // uNightHorizon IS the amber the horizon adds on top of it.
  float night = 1.0 - smoothstep(-0.06, 0.10, uSunDir.y);
  float X = 1.0 / (max(dir.y, 0.0) + uGlowShape.x);
  float g = X * exp(-uGlowShape.y * (X - 1.0));
  float warmLow = clamp((g - uGlowShape.z) * uGlowShape.w, 0.0, 1.0);
  L += (uNightZenith + uNightHorizon * warmLow) * night * (1.0 + uOvercast * 1.15);

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
uniform float uStarKeep;         // fraction of lattice cells that host NO star
uniform float uStarGain;         // nits at magnitude 1
uniform float uMilkyWay;
uniform float uMaxRadiance;
uniform float uOvercast;
uniform float uAureole;          // nits at the centre of the solar aureole
uniform vec3  uSunTint;          // beam colour, normalised to peak 1

// Cloud deck. Every one of these is derived in _pushUniforms from the same
// photometry the rest of the file uses; none is a hand-picked look value.
uniform sampler2D uCloudNoise;
uniform float uCloudCover;       // fBm threshold: higher = less sky covered
uniform float uCloudSoft;        // width of the coverage ramp, i.e. edge softness
uniform float uCloudScale;       // metres -> noise UV
uniform float uCloudHeight;      // deck base, metres
uniform vec2  uCloudDrift;       // advection, in noise UV
uniform vec2  uCloudLightStep;   // one step toward the sun, in noise UV
uniform float uCloudExtinct;     // optical depth of that step at full density
uniform float uCloudAmbient;     // deck albedo x sky, as a share of the zenith
uniform vec3  uCloudSunColor;    // beam colour at deck altitude, peak 1
uniform float uCloudSunNits;     // radiance of a fully lit face
uniform vec3  uCloudUnderlit;    // city light bounced off the base, nits
uniform float uCloudHaze;        // aerial perspective on the deck, 1/m
uniform vec2  uCloudFade;        // metres over which the deck relaxes into haze

#define PI 3.141592653589793
#define SUN_R 0.00465
#define EARTH_R 6360000.0

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

// One star per OCCUPIED lattice cell, with a magnitude-dependent point spread.
//
// Two things were wrong here and both were measured, not guessed. Counting local
// maxima in the masked sky wedge of the night hero frame gave 570 stars in
// 0.35 sr - 1,633 per steradian, where a city sky offers a few tens - and their
// median rendered luminance was 0.15 against a sky background of 0.006, i.e.
// every single one of them sat 25x above the sky and therefore read as the same
// brightness. A magnitude distribution nobody can see the bottom of is not a
// magnitude distribution.
//
// Density is now cut by culling cells with a hash rather than by coarsening the
// lattice: coarsening makes the spacing regular enough to see, whereas culling
// leaves the positions random and simply empties most of them.
vec3 stars(vec3 d) {
  vec3 s = d * 118.0;
  vec3 cell = floor(s);
  float h = hash13(cell);
  vec3 offset = vec3(h, hash13(cell + 11.7), hash13(cell + 23.1)) - 0.5;
  float dist = length(fract(s) - 0.5 - offset * 0.7);
  float exists = step(uStarKeep, hash13(cell + 41.3));
  // pow 11: a steep magnitude distribution, so a handful read as genuinely bright
  // and the bulk sit near the noise floor.
  float mag = pow(hash13(cell + 3.3), 11.0);

  // Distance in PIXELS. The old code compared dist against a fixed 0.015 in cell
  // units - 0.007 degrees, an eighth of a pixel - so what actually set every
  // star's size was the fwidth() term in the smoothstep, which is the same for
  // all of them. That is why the critics measured every star as an identical
  // hard-edged 2x2 block: the size was the pixel grid, not the star. Working in
  // pixels lets a bright star be genuinely bigger and carry a real point spread,
  // and the whole spread still fits inside one 0.49-degree cell.
  float w = max(fwidth(dist), 1e-4);
  float px = dist / w;
  float size = 0.55 + 1.75 * pow(mag, 0.33);
  float core = 1.0 - smoothstep(size * 0.70, size * 1.45, px);
  float psf = exp(-(px * px) / (size * size * 2.6));

  float warm = hash13(cell + 7.7);
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.66), warm * warm);
  return tint * (core * 0.80 + psf * 0.45) * mag * uStarGain * exists;
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

// ---------------------------------------------------------------- clouds
// Seven octaves of tileable value noise in TWO texture fetches.
//
// The obvious way to write this is a loop of hash-based value noise, which for
// seven octaves is ~56 hash evaluations per sky pixel. On the SwiftShader
// rasteriser this project gates against, that is not affordable on 400k sky
// pixels. Instead the noise is baked once on the CPU into a 256x256 RGBA texture
// whose four channels hold four different lattice frequencies, so ONE fetch is
// already a four-octave fBm. A second fetch at an incommensurate scale adds
// three more octaves and breaks up the tile, and its own low frequency warps the
// domain, which is what turns bland blobs into sheared cumulus.
//
// Mipmaps do the anti-aliasing: near the horizon one screen pixel covers
// kilometres of deck, and without a mip chain that is a shimmering moire.
float cloudFbm(vec2 p) {
  vec4 a = texture2D(uCloudNoise, p * 0.5);
  vec2 q = p * 2.13 + vec2(0.317, 0.113) + (a.rg - 0.5) * 0.30;
  vec4 b = texture2D(uCloudNoise, q);
  return a.r * 0.34 + a.g * 0.21 + a.b * 0.13
       + b.r * 0.14 + b.g * 0.09 + b.b * 0.06 + b.a * 0.03;
}

// Distance from the ground to a shell of radius Re + h. Using the SHELL rather
// than a flat plane is what gives the deck its perspective: the flat-plane
// h/dir.y diverges at the horizon, while this saturates at sqrt(2*Re*h) - 167 km
// for a 2.2 km base - which is exactly why real clouds crowd into a band above
// the rooftops instead of streaking off to infinity.
float shellDistance(float mu, float h) {
  return -EARTH_R * mu + sqrt(EARTH_R * EARTH_R * mu * mu + 2.0 * EARTH_R * h + h * h);
}

// Returns (radiance, coverage). skyL is the clear sky behind the deck, zenithL
// the zenith radiance the deck is ambient-lit by.
vec4 cloudLayer(vec3 dir, vec3 skyL, vec3 zenithL) {
  if (dir.y <= 0.002 || uCloudCover >= 1.0) return vec4(0.0);
  float t = shellDistance(dir.y, uCloudHeight);
  vec2 p = dir.xz * t * uCloudScale + uCloudDrift;
  // Beyond ~55 km the deck is more haze than shape, so let the noise relax to its
  // own mean. This is both the honest look and the cheapest anti-aliasing there is.
  float far = smoothstep(uCloudFade.x, uCloudFade.y, t);
  float d = mix(cloudFbm(p), 0.5, far);
  // Self-shadowing: one step along the beam. With the sun on the horizon that
  // step is long and nearly horizontal, so dusk clouds come out edge-lit with
  // dark cores - which is the whole look - while a high sun lights their tops.
  //
  // Both fetches are taken BEFORE the coverage test. texture2D picks its mip from
  // screen-space derivatives, and a derivative taken inside a branch that some
  // pixels of the 2x2 quad did not enter is undefined - which at a cloud edge,
  // where exactly that happens, is a licence for the driver to sample any mip it
  // likes. Hoisting costs a clear-sky pixel one extra fetch and removes the class.
  float ds = smoothstep(uCloudCover, uCloudCover + uCloudSoft,
                        mix(cloudFbm(p + uCloudLightStep), 0.5, far));
  float dens = smoothstep(uCloudCover, uCloudCover + uCloudSoft, d);
  if (dens <= 0.0) return vec4(0.0);
  // How far past the coverage threshold this sample is, i.e. how thick the cloud
  // is here rather than merely whether there is one. dens saturates within one
  // soft-edge width and is therefore 1.0 across almost the whole deck, which is
  // fine for compositing and useless for shading.
  float thick = clamp((d - uCloudCover) / (uCloudSoft * 3.0), 0.0, 1.0);
  float lit = exp(-uCloudExtinct * ds);

  // Forward scattering through the thin edges: the silver lining. Peaks where the
  // line of sight passes close to the sun and the cloud is optically thin.
  float fwd = pow(max(dot(dir, uSunDir), 0.0), 10.0);

  // Ambient on the deck is not just the zenith: a cloud base near the horizon is
  // lit by the bright low sky it sits in front of, which is what keeps sunset
  // bases mauve rather than black.
  vec3 amb = mix(zenithL, skyL, 0.45) * uCloudAmbient;
  vec3 col = amb * (0.42 + 0.58 * lit)
           + uCloudSunColor * uCloudSunNits * lit
           + uCloudSunColor * uCloudSunNits * fwd * 0.6 * (1.0 - lit)
           // City light off the base. Scaled by thickness, because at night the
           // sun terms are zero and without this the whole deck is one flat
           // amber sheet - which is exactly how the first night build read.
           + uCloudUnderlit * (0.35 + 0.90 * thick);

  // Aerial perspective on the deck itself, on the same physics as the ground fade.
  float haze = 1.0 - exp(-t * uCloudHaze);
  col = mix(col, skyL, haze);
  float alpha = dens * (1.0 - haze * 0.40) * smoothstep(0.002, 0.030, dir.y);
  return vec4(col, alpha);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 L = sampleLut(dir);
  float clear = 1.0 - uOvercast;

  // Cloud deck, composited before everything analytic so the disc, the moon and
  // the stars are all correctly occluded by it.
  vec4 cloud = cloudLayer(dir, L, sampleLut(vec3(0.0, 1.0, 0.0)));
  L = mix(L, cloud.rgb, cloud.a);
  float open = (1.0 - cloud.a) * clear;

  // Solar aureole. The LUT carries the Mie forward peak, but at 256x128 one texel
  // is 1.4 degrees, so the peak arrives smeared into a soft blob. Adding it back
  // analytically at full resolution costs three pow() and gives the sun the tight
  // bright core and the wide skirt that make it read as a source rather than as a
  // white dot. Three lobes: aureole (~1 deg), circumsolar (~8 deg), general glow.
  float mus = max(dot(dir, uSunDir), 0.0);
  if (uAureole > 0.0) {
    float lobes = pow(mus, 1600.0) * 1.0 + pow(mus, 70.0) * 0.11 + pow(mus, 7.0) * 0.012;
    L += uSunTint * uAureole * lobes * open;
  }

  // The disc. Refraction squashes a setting sun: at the horizon its vertical
  // diameter is about 80% of its horizontal one, and the flattening is gone by a
  // few degrees up. Stretching the vertical offset before the angle is measured
  // is the cheapest way to draw an ellipse with code that thinks in angles.
  vec3 off = dir - uSunDir;
  float squash = mix(1.0, 1.0 / 0.80, 1.0 - smoothstep(0.0, 0.09, uSunDir.y));
  off.y *= squash;
  float sunAng = 2.0 * asin(clamp(0.5 * length(off), 0.0, 1.0));
  if (sunAng < SUN_R * 1.6 && uSunDiscRadiance > 0.0) {
    float r = clamp(sunAng / SUN_R, 0.0, 1.0);
    float limb = pow(max(1.0 - r * r, 0.0), 0.32);   // solar limb darkening
    float edge = 1.0 - smoothstep(SUN_R * 0.985, SUN_R * 1.02, sunAng);
    L += uSunDiscColor * uSunDiscRadiance * limb * edge * open;
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
      L += vec3(1.0, 0.97, 0.92) * uMoonRadiance * edge * shade * limb * mix(0.02, 1.0, lit) * open;
    }
    // Mie halo around the moon: what makes a night sky read as air rather than space.
    float halo = pow(max(dot(dir, uMoonDir), 0.0), 260.0);
    L += vec3(0.72, 0.79, 1.0) * uMoonRadiance * 2.0e-4 * halo * open;
  }

  if (uStarIntensity > 0.0) {
    // Extinction, from the air mass rather than from a smoothstep.
    //
    // The previous smoothstep(0.02, 0.42) was already meant to be this, and the
    // critics still reported full-brightness stars at the rooftops - because it
    // reaches 1.0 by 25 degrees, and in a street canyon the visible sky runs from
    // about 5 to 30 degrees, so that curve spent its whole range inside the one
    // band it was supposed to clear out. Measured on the night hero frame: 355 of
    // 570 detected stars sat below 20 degrees. exp(-k*(X-1)) with X the air mass
    // is the real curve, and it leaves 18% at 10 degrees and 44% at 20.
    float above = smoothstep(-0.04, 0.06, dir.y);
    float airmass = 1.0 / (max(dir.y, 0.0) + 0.09);
    float extinction = min(1.0, exp(-0.62 * (airmass - 1.0)));
    L += stars(dir) * uStarIntensity * above * extinction * open;
    if (uMilkyWay > 0.0) {
      // A band on a tilted great circle, broken up by noise. Kept faint on
      // purpose: at this scale a bright one reads as texture noise, not a galaxy.
      vec3 pole = normalize(vec3(0.42, 0.62, -0.66));
      float band = exp(-pow(dot(dir, pole) * 3.1, 2.0));
      float n = valueNoise(dir * 13.0) * 0.6 + valueNoise(dir * 31.0) * 0.4;
      L += vec3(0.78, 0.80, 0.95) * band * (0.35 + n * 0.9) * uMilkyWay * above * extinction * open;
    }
  }

  gl_FragColor = vec4(min(L, vec3(uMaxRadiance)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Tileable value noise, four lattice frequencies packed one to a channel.
//
// Baked on the CPU because the alternative is paying for it per pixel per frame:
// a seven-octave hash fBm is ~56 hash evaluations, and the dome shades every sky
// pixel in the frame. 256x256x4 channels of smooth-interpolated lattice noise is
// ~262k interpolations, measured at 18-59 ms once at construction (median 36 ms
// over ten cold loads), against a generation budget the whole module has to fit
// inside - and against a per-frame cost of nothing. The generator is an
// xorshift seeded from a constant rather than Math.random(), so the deck is the
// same on every machine and in every run - a sky that reshuffles itself between
// captures cannot be compared against a previous capture.
function bakeCloudNoise(size = 256, seed = 0x9e3779b9) {
  const data = new Uint8Array(size * size * 4);
  const lattices = [4, 8, 16, 32];
  for (let c = 0; c < 4; c++) {
    const L = lattices[c];
    const grid = new Float32Array(L * L);
    let x = (seed + c * 0x7f4a7c15) >>> 0;
    for (let i = 0; i < L * L; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      grid[i] = (x >>> 8) / 16777216;
    }
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * L, y0 = Math.floor(gy);
      const ty = gy - y0, fy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % L) * L, r1 = ((y0 + 1) % L) * L;
      for (let px = 0; px < size; px++) {
        const gx = (px / size) * L, x0 = Math.floor(gx);
        const tx = gx - x0, fx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % L, c1 = (x0 + 1) % L;
        const v = (grid[r0 + c0] * (1 - fx) + grid[r0 + c1] * fx) * (1 - fy)
                + (grid[r1 + c0] * (1 - fx) + grid[r1 + c1] * fx) * fy;
        data[(y * size + px) * 4 + c] = Math.round(v * 255);
      }
    }
  }
  return data;
}

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
   * @param {number} [opts.steps=12]        view-ray samples in the scattering march
   * @param {number} [opts.probeWidth=64]    CPU read-back probe width, for fog + audit
   * @param {boolean} [opts.environment=true] build a PMREM env map from the sky
   *        (its cube size is lutWidth/4 — three derives it from the equirect)
   * @param {boolean} [opts.autoRefresh=false] allow update() to regenerate the LUT
   * @param {boolean} [opts.stars=true]
   * @param {boolean} [opts.milkyWay=true]
   * @param {number} [opts.maxRadiance=60000] nits ceiling; keeps half-float finite
   * @param {number} [opts.minRefreshMs=300] floor on automatic regeneration
   * @param {number} [opts.fogDensity=0.0013] clear-air fog density, 1/m
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
    this.minRefreshMs = opts.minRefreshMs ?? 400;
    // Opt-in. Off by default so nothing this module owns can generate inside a
    // frame unless the caller asked for it; weather.js turns it on for the
    // duration of a transition and calls refresh() itself at the end.
    this.autoRefresh = opts.autoRefresh ?? false;
    // Clear-air extinction, 1/m. Physical sea-level extinction is 5.5e-5, which
    // is invisible over a 1 km draw distance, so this is an artistic multiple and
    // report() quotes the multiplier rather than pretending otherwise. Chosen by
    // eye against the dusk street frame: at 0.0018 a building 200 m away is 30%
    // haze and the middle distance loses its edges; at 0.0013 the same building
    // is 23% and the district still dissolves properly by 1 km.
    this.fogDensityClear = opts.fogDensity ?? 0.0013;

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
      fogClamp: 1,
      inscatterClamp: 1,
    };
    // Exposed-unit ceilings for what reaches post.js. daynight.js audits these at
    // 1.2 and 3.0; sitting just under leaves the gate meaningful.
    this.fogCeiling = opts.fogCeiling ?? 1.1;
    this.inscatterCeiling = opts.inscatterCeiling ?? 2.7;

    const t0 = performance.now();

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

    // Cloud noise. Baked here, before the dome material that samples it.
    const tNoise = performance.now();
    const noiseSize = opts.cloudNoiseSize ?? 256;
    this.cloudNoise = new THREE.DataTexture(
      bakeCloudNoise(noiseSize, opts.cloudSeed ?? 0x9e3779b9),
      noiseSize, noiseSize, THREE.RGBAFormat);
    this.cloudNoise.wrapS = THREE.RepeatWrapping;
    this.cloudNoise.wrapT = THREE.RepeatWrapping;
    this.cloudNoise.minFilter = THREE.LinearMipmapLinearFilter;
    this.cloudNoise.magFilter = THREE.LinearFilter;
    this.cloudNoise.generateMipmaps = true;      // the horizon is kilometres per pixel
    this.cloudNoise.needsUpdate = true;
    this.cloudNoiseMs = +(performance.now() - tNoise).toFixed(1);

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
      uMsAniso: { value: 0 },
      uMsWarm: { value: new THREE.Vector3(1, 1, 1) },
      uMsCool: { value: new THREE.Vector3(1, 1, 1) },
      uGlowShape: { value: new THREE.Vector4(0.09, 0.035, 0.92, 0.145) },
      uGroundAlbedo: { value: srgb(0x6b6455) },
      uGroundHaze: { value: 8 },
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
    // Distribution matters as much as the total here. daynight.js asserts night
    // sky illuminance in 0.5-12 lux and audits the dome against its 3.5 lux
    // preset to within 2x, so the dome cannot go below ~1.8 lux however dark a
    // real city night is (a light-polluted zenith is nearer 0.001 nits than 0.5).
    // What is left to choose is where that fixed energy sits: pushed to the
    // horizon it becomes the fog colour and floods the frame orange, so it is
    // biased toward the zenith and the sodium tint is pulled back off full
    // saturation. See the report — this preset is the one place the photometric
    // contract and a night that reads as night genuinely pull apart.
    // 2026-08-30: these two constants used to contradict the paragraph above them.
    // The horizon carried 0.42 nits against the zenith's 0.045 - energy biased 9.3:1
    // TOWARD the horizon, at 0xffab6e (57% saturation) - which is the opposite of
    // "biased toward the zenith and the sodium tint pulled back off full saturation".
    // sky.js:1017 samples the horizon as post's fogColor AND the dome feeds the PMREM
    // environment at envIntensity 1.0, so that orange became the fog, the ambient, and
    // therefore every surface in the district. Four blind critics independently measured
    // the night frames as monochromatic with no warm/cool contrast; all four blamed a
    // missing lighting system. The lighting system was fine. This was the cause.
    this.nightZenithColor = srgb(0x3d5590);
    this.nightHorizonColor = srgb(0xe0b49a);
    // These are LUMINANCES IN NITS, and as of 2026-08-31 they finally are.
    //
    // The 2026-08-30 pass believed it had rebalanced the glow from 9.3:1 to 2:1 in
    // favour of the horizon. It had not, and the file said so in a comment that was
    // wrong twice over: these numbers were multiplied by a COLOUR whose luminance
    // was not 1, and the two colours differ in luminance by 3.5x (0x54689c is
    // 0.144, 0xd8b89a is 0.512). 0.10 and 0.20 therefore rendered 0.014 and 0.102
    // nits - a 7.1:1 horizon bias, not 2:1. _pushUniforms now divides each colour
    // by its own luminance, so the ratio you read here is the ratio that renders.
    //
    // A clear urban night sky is ~0.01-0.05 cd/m2 at zenith, with skyglow lifting
    // the horizon to a few tenths; lamp-lit asphalt is ~1.3 nits, and the sky must
    // stay well under it or there is no night. The horizon term is what the blind
    // critics asked for - "3-6x zenith, amber-pink at the rooftops to deep blue at
    // zenith" - and 0.045 + 0.21 is 5.7:1 total. Measured hemispherical
    // illuminance: 0.196 lux, inside both the 0.05-3 lux PLAUSIBLE_SKY night
    // envelope and daynight.js's separate demand that the dome land within 2x of
    // the 0.15 lux its camera stop was derived from.
    this.nightZenithNits = 0.045;
    this.nightHorizonNits = 0.21;
    // Skyglow profile: the air mass of the light-polluted layer, 1/(mu + h),
    // damped by its own extinction so it turns over in the last degrees rather
    // than running to infinity at the horizon. h sets how tall the glow is, k how
    // hard it rolls off. Integrating the pair is what has to land inside the night
    // illuminance envelope, so they are not free.
    this.glowLayer = opts.glowLayer ?? 0.09;
    this.glowExtinction = opts.glowExtinction ?? 0.035;

    // Multiple-scattering anisotropy, faded out as the sun climbs. 0.6 at dusk
    // puts 1.6x of the isotropic value toward the sun and 0.4x away from it, a 4:1
    // solar/anti-solar ratio at a given elevation, which is at the low end of what
    // a twilight sky actually does. Energy-preserving; see scatter().
    this.msAniso = opts.msAniso ?? 0.60;

    // Cloud deck. `cloudiness` is the fraction of sky the deck covers in CLEAR
    // weather; weather.js's overcast drives it the rest of the way to solid.
    this.cloudiness = opts.cloudiness ?? 0.52;
    this.cloudHeight = opts.cloudHeight ?? 2200;      // metres, fair-weather cumulus
    // One noise tile is 15 km of deck. At 30 degrees elevation the deck is only
    // 4.4 km away, so a 34 km tile put barely a fifth of one cloud in the upper
    // frame and the sky read as empty above the rooftops; 15 km puts three or
    // four cloud diameters across the visible wedge, which is what a fair-weather
    // cumulus field looks like from a street.
    this.cloudTileMetres = opts.cloudTileMetres ?? 15000;
    this.cloudWind = opts.cloudWind ?? new THREE.Vector2(5.5, 2.0);   // m/s at the deck
    // Radiance of a cloud face turned toward the beam is E_normal * albedo / pi.
    // cloudFace is the geometric factor that a broken deck's VISIBLE faces return:
    // most of what a camera sees is flank and base, not the fully lit top. 0.30
    // puts the brightest dusk rim at ~1,345 nits against an anti-solar low sky
    // measured at ~990, so sunlit cloud reads BRIGHTER than the sky it sits on -
    // which is the whole point of a sunset - while shaded interiors at ~555 nits
    // read darker. At 0.16 every cloud was darker than the sky and the deck
    // rendered as silhouettes.
    this.cloudAlbedo = opts.cloudAlbedo ?? 0.72;
    this.cloudFace = opts.cloudFace ?? 0.30;
    // Starfield. keep = fraction of lattice cells left EMPTY; gain = nits at
    // magnitude 1. Both measured against the night hero frame - see stars().
    this.starKeep = opts.starKeep ?? 0.94;
    this.starGain = opts.starGain ?? 2.6;
    this.cloudColor = srgb(0xb9c2cc);
    // Deck luminance as a share of the clear zenith — near unity, because a lit
    // cloud base and a clear zenith are about equally luminous overhead (one is
    // white and dim-lit, the other blue and bright-lit). What collapses under a
    // deck is the HORIZON, and the CIE 1:3 gradient in the shader does that part.
    this.cloudTransmit = opts.cloudTransmit ?? 1.0;
    this.overcastFloor = opts.overcastFloor ?? 0.32;

    // 12 view samples, and the constant is set by COMPILE time as much as by
    // accuracy. STEPS is a #define, so the GLSL compiler unrolls the march and
    // the program grows with it; measured end-to-end construction on the software
    // rasteriser, 12 steps costs 83 ms, 16 costs 192 ms and 32 costs 4,169 ms,
    // which is superlinear and is the compiler, not the integral. Against a
    // 32-step reference, 12 steps moves the dusk sky illuminance 8% and the
    // horizon luminance 13% — inside the accuracy of a single-scattering model
    // with an isotropic multiple-scattering term, and cheap enough to keep the
    // whole module inside a 400 ms generation budget. The sun-ray march that used
    // to sit inside this loop is gone; see sunOpticalDepth.
    const defines = `#define STEPS ${opts.steps ?? 12}\n`;
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
        uStarKeep: { value: 0 },
        uStarGain: { value: 0 },
        uMilkyWay: { value: 0 },
        uMaxRadiance: { value: this.maxRadiance },
        uOvercast: { value: 0 },
        uAureole: { value: 0 },
        uSunTint: { value: new THREE.Vector3(1, 1, 1) },
        uCloudNoise: { value: this.cloudNoise },
        uCloudCover: { value: 1 },
        uCloudSoft: { value: 0.16 },
        uCloudScale: { value: 1 / 34000 },
        uCloudHeight: { value: 2200 },
        uCloudDrift: { value: new THREE.Vector2() },
        uCloudLightStep: { value: new THREE.Vector2() },
        uCloudExtinct: { value: 3.1 },
        uCloudAmbient: { value: 0.34 },
        uCloudSunColor: { value: new THREE.Vector3(1, 1, 1) },
        uCloudSunNits: { value: 0 },
        uCloudUnderlit: { value: new THREE.Vector3() },
        uCloudHaze: { value: 1.15e-5 },
        uCloudFade: { value: new THREE.Vector2(38000, 130000) },
      },
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: true,
    });
    this.starIntensity = this.domeMaterial.uniforms.uStarIntensity.value;
    // 0.6 read as soft 30-50 px grey blobs rather than a galaxy - a blind critic
    // called them 'low-res noise-texture artifacts, not clouds and not a Milky Way',
    // which is exactly what a low-frequency value-noise octave looks like when it is
    // bright enough to see but too coarse to resolve. Pulled back to a faint band.
    this.milkyWayIntensity = opts.milkyWay === false ? 0 : (opts.milkyWay ?? 0.28);

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
    this._t0 = performance.now();     // cloud advection origin
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
    const tSetup = performance.now();
    this._t0 = tSetup;
    this.refresh({ force: true });
    this.generationMs = performance.now() - t0;
    // Broken out the way materials.js reports its phases: on a software
    // rasteriser the first refresh is dominated by compiling the scattering and
    // PMREM programs, not by the integral, and a single total hides that.
    this.timings = {
      setup: +(tSetup - t0).toFixed(1),
      cloudNoiseBake: this.cloudNoiseMs,
      lutAndCompile: +(this.stats.lastRefreshMs - this.stats.lastReadbackMs - this.stats.lastEnvMs).toFixed(1),
      probeReadback: this.stats.lastReadbackMs,
      environment: this.stats.lastEnvMs,
      total: +this.generationMs.toFixed(1),
    };
  }

  // ------------------------------------------------------------------ state
  /** Match daynight.js: 'noon' | 'dusk' | 'night'. */
  setTimeOfDay(name) {
    const p = SKY_PRESETS[name];
    if (!p) throw new Error(`unknown sky preset: ${name}`);
    this.presetName = name;
    // Only take the preset's turbidity if nothing has overridden it. weather.js
    // pushes turbidity every frame; without this guard a time-of-day change in
    // the middle of a downpour silently reverts the Mie load to the clear-air
    // value and the LUT keeps it until the next explicit refresh.
    if (!this._turbidityOverridden) this.turbidity = p.turbidity;
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
    this._turbidityOverridden = true;
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
    // The deck drifts. Two float writes; nothing regenerates.
    this._pushCloudDrift(u, now);
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

    // Probe FIRST, then the LUT. A synchronous read blocks until everything
    // already submitted has finished, so reading after the 256x128 LUT waits on
    // 32,768 pixels of scattering integral; reading after only the 64x32 probe
    // waits on 2,048. Measured at construction on the software rasteriser: 320 ms
    // the old way, 20 ms this way, for identical output.
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

    r.setRenderTarget(this.lut);
    r.render(this.quadScene, this.quadCamera);

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

    // Multiple-scattering anisotropy. Faded out as the sun climbs: the asymmetry
    // is a twilight phenomenon, and leaving it on at noon would move the zenith,
    // which is the one number the noon envelope has least room in.
    u.uMsAniso.value = this.msAniso * (1 - smoothstep(0.05, 0.45, this.sunDirection.y));
    const tMs = this._transmittanceAt(MS_ALTITUDE, Math.max(this.sunDirection.y, -0.01));
    const msN = tMs.map((v) => v / Math.max(luminance(tMs), 1e-9));
    // Softened with a fractional power: the raw beam transmittance at the horizon
    // is 500:1 red-to-blue, which is the colour of the DISC, not of the diffuse
    // light the whole sky is made of. Both tints are then renormalised to
    // luminance 1, which is what makes the swing purely chromatic and leaves
    // zenith luminance, the horizon ring and the sky illuminance untouched.
    const unitLum = (c) => { const l = Math.max(luminance(c), 1e-9); return c.map((v) => v / l); };
    const warm = unitLum(msN.map((v) => Math.pow(Math.max(v, 1e-6), 0.45)));
    const cool = unitLum(msN.map((v) => Math.pow(Math.max(v, 1e-6), -0.22)));
    u.uMsWarm.value.set(warm[0], warm[1], warm[2]);
    u.uMsCool.value.set(cool[0], cool[1], cool[2]);

    // Skyglow shape, normalised on the CPU so the shader carries no constants:
    // (layer height, self-extinction, value at the zenith, 1/(horizon - zenith)).
    const gAt = (mu) => {
      const X = 1 / (mu + this.glowLayer);
      return X * Math.exp(-this.glowExtinction * (X - 1));
    };
    const gz = gAt(1), g0 = gAt(0);
    u.uGlowShape.value.set(this.glowLayer, this.glowExtinction, gz, 1 / Math.max(g0 - gz, 1e-6));

    // Both colours are divided by their own luminance, so nightZenithNits and
    // nightHorizonNits are luminances in nits and their ratio is the ratio that
    // renders. See the comment where they are declared for why that had to change.
    const zc = [this.nightZenithColor.r, this.nightZenithColor.g, this.nightZenithColor.b];
    const hc = [this.nightHorizonColor.r, this.nightHorizonColor.g, this.nightHorizonColor.b];
    const nz = this.nightZenithNits / Math.max(luminance(zc), 1e-9);
    const nh = this.nightHorizonNits / Math.max(luminance(hc), 1e-9);
    u.uNightZenith.value.set(zc[0] * nz, zc[1] * nz, zc[2] * nz);
    u.uNightHorizon.value.set(hc[0] * nh, hc[1] * nh, hc[2] * nh);

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
    d.uSunTint.value.copy(d.uSunDiscColor.value);
    // Aureole peak, as a fixed fraction of the disc. 2e-4 puts it at ~2,200 nits
    // at dusk against a 2,000-nit near-sun sky, i.e. it roughly doubles the sky
    // within a couple of degrees of the disc and is invisible past ~25.
    d.uAureole.value = d.uSunDiscRadiance.value * 2.0e-4;

    d.uStarKeep.value = this.starKeep;
    d.uStarGain.value = this.starGain;
    this._pushCloudUniforms(d);

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

  /**
   * Cloud-deck uniforms. Split out of _pushUniforms because every one of them is
   * derived rather than dialled, and the derivation is the interesting part.
   */
  _pushCloudUniforms(d) {
    const coverage = Math.min(1, this.cloudiness + (1 - this.cloudiness) * this.overcast);
    // Threshold on an fBm whose mean is 0.5: lower threshold, more sky covered.
    // The fBm has mean 0.5 and sd 0.082, so the threshold is roughly the coverage
    // quantile: 0.464 at the default leaves 46% of the sky covered, 0.32 under
    // full overcast leaves 95%.
    d.uCloudCover.value = coverage <= 0 ? 1 : 0.62 - 0.30 * coverage;
    d.uCloudSoft.value = 0.035 + 0.10 * coverage;
    d.uCloudScale.value = 1 / this.cloudTileMetres;
    d.uCloudHeight.value = this.cloudHeight;
    d.uCloudAmbient.value = 0.34;
    d.uCloudHaze.value = 7.0e-6;
    d.uCloudFade.value.set(45000, 150000);

    // The deck sees the sun higher than the ground does: sqrt(2h/Re) is 1.5 deg at
    // 2.2 km. At dusk that is the difference between a lit deck and a dead one,
    // because the sun is ON the horizon and 1.5 deg of elevation is a factor of
    // 1.7 in air mass.
    const lift = Math.sqrt((2 * this.cloudHeight) / EARTH_RADIUS);
    const sunElev = Math.asin(Math.max(-1, Math.min(1, this.sunDirection.y)));
    const sinDeck = Math.sin(sunElev + lift);
    const tDeck = this._transmittanceAt(this.cloudHeight, sinDeck);
    const tl = Math.max(luminance(tDeck), 1e-12);
    // Softened the same way the multiple-scattering tint is, and for the same
    // reason: a cloud is lit by the beam AND by the sky around it, so it never
    // reaches the 500:1 red/blue of the raw beam.
    const l1 = (c) => { const l = Math.max(luminance(c), 1e-9); return c.map((v) => v / l); };
    const beam = l1(tDeck.map((v) => Math.pow(Math.max(v / tl, 1e-6), 0.55)));
    d.uCloudSunColor.value.set(beam[0], beam[1], beam[2]);
    // E_normal * albedo / pi * (what fraction of that a broken deck's visible
    // faces actually return). Measured at dusk: 19,600 lux normal at the deck,
    // 720 nits on the brightest rim.
    const eNormal = sinDeck > -0.01 ? SUN_ILLUMINANCE * tl : 0;
    d.uCloudSunNits.value = (eNormal * this.cloudAlbedo) / Math.PI * this.cloudFace;

    // Self-shadowing step: how far the beam travels horizontally while crossing a
    // 900 m deck. Vertical at noon (231 m, so tops are lit), nearly horizontal at
    // dusk (clamped at 4.2 km, so the deck is edge-lit with dark cores).
    // Capped at 1.6 km - about one cloud diameter. Past that the tap is
    // uncorrelated with the cloud it is meant to be shadowing and the deck reads
    // as noise rather than as lit and unlit sides.
    const horiz = Math.min(900 / Math.max(Math.tan(sunElev + lift), 0.18), 1600);
    const az = Math.hypot(this.sunDirection.x, this.sunDirection.z) || 1;
    const stepUV = horiz / this.cloudTileMetres;
    d.uCloudLightStep.value.set((this.sunDirection.x / az) * stepUV, (this.sunDirection.z / az) * stepUV);

    // Self-shadowing has to vanish for a vertical sun, and this is the one place
    // a horizontal-offset shadow tap gets it exactly backwards. At noon the step
    // is 206 m, far shorter than a ~1.5 km cloud, so the tap lands INSIDE the same
    // cloud and reports full density - i.e. it shadows the very top the sun is
    // shining straight down onto. Measured: noon clouds rendered at half the
    // luminance of the sky behind them, dark grey against blue, which is the one
    // thing a noon cumulus never is. Scaling the extinction by how many cloud
    // diameters the beam actually crosses fixes noon (0.14 -> nearly unshadowed)
    // and leaves dusk alone (capped step, factor 1.0).
    // 1.0 at full obliquity, not the 3.1 the first pass used: at 3.1 an interior
    // kept 4.5% of the beam and the whole deck was a silhouette with a bright rim.
    d.uCloudExtinct.value = 1.0 * Math.min(1, Math.max(0.12, horiz / 1500));

    // City light bounced off the cloud base. This is why an overcast city night is
    // brighter than a clear one, and why a night deck must not read as a black hole
    // punched in the skyglow.
    const night = 1 - smoothstep(-0.06, 0.10, this.sunDirection.y);
    const hc = l1([this.nightHorizonColor.r, this.nightHorizonColor.g, this.nightHorizonColor.b]);
    const under = this.nightHorizonNits * 1.15 * night;
    d.uCloudUnderlit.value.set(hc[0] * under, hc[1] * under, hc[2] * under);

    this._pushCloudDrift(d);
  }

  _pushCloudDrift(d, now = performance.now()) {
    // 5.5 m/s at 2.2 km over a 34 km tile is 0.00016 UV per second: the deck
    // moves, but a capture taken 20 s later than another is still the same sky.
    const s = (now - this._t0) / 1000;
    d.uCloudDrift.value.set(
      (-this.cloudWind.x * s) / this.cloudTileMetres,
      (-this.cloudWind.y * s) / this.cloudTileMetres,
    );
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

  _transmittance(sinElevation) { return this._transmittanceAt(2, sinElevation); }

  /** Beam transmittance to altitude h, for the cloud deck and the MS tints. */
  _transmittanceAt(h, sinElevation) {
    const r = EARTH_RADIUS + h;
    const odR = this._sunOpticalDepth(H_R, h, r, sinElevation);
    const odM = this._sunOpticalDepth(H_M, h, r, sinElevation) * this.turbidity * 1.11;
    return BETA_R.map((b) => Math.exp(-(b * odR + BETA_M * odM)));
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

    // Display-referred clamp, and the one place in this file where the physics
    // is knowingly overruled.
    //
    // post.js mixes EVERY pixel toward fogColor by distance and toward
    // fogInscatter inside a pow(dot, 6) lobe around the sun. A dusk horizon
    // really is ~800 nits, which at the preset's 1/330 stop is 2.4 in exposed
    // units — past ACES saturation — so the correct radiance turns the whole far
    // half of the frame into flat white. Photographs of sunsets do that too, but
    // they are not asking the player to drive through it. The measurement stays
    // untouched in `atmosphere`; only the copy handed to the display is scaled,
    // and report() prints both so the gap is never invisible.
    const e = p.exposure || 1;
    a.exposure = e;
    a.fogClamp = Math.min(1, this.fogCeiling / Math.max(1e-9, luminance3(a.fogColor) * e));
    a.inscatterClamp = Math.min(1, this.inscatterCeiling / Math.max(1e-9, luminance3(a.fogInscatter) * e));
    p.fogColor.copy(a.fogColor).multiplyScalar(a.fogClamp);
    p.fogInscatter.copy(a.fogInscatter).multiplyScalar(a.inscatterClamp);
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
      generationMsByPhase: this.timings,
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
      // The deck lives in the dome shader, not in the LUT, so it costs nothing to
      // regenerate and does not enter zenithNits / horizonNits / skyLux. Those
      // three describe the CLEAR sky the environment map and the fog are built
      // from, which is what they have always described; the deck is a foreground
      // layer over it. Reported here so the gap is stated rather than hidden.
      cloud: {
        coverage: +Math.min(1, this.cloudiness + (1 - this.cloudiness) * this.overcast).toFixed(2),
        baseM: this.cloudHeight,
        litFaceNits: +this.domeMaterial.uniforms.uCloudSunNits.value.toFixed(1),
        underlitNits: +luminance([
          this.domeMaterial.uniforms.uCloudUnderlit.value.x,
          this.domeMaterial.uniforms.uCloudUnderlit.value.y,
          this.domeMaterial.uniforms.uCloudUnderlit.value.z]).toFixed(3),
        noiseBakeMs: this.cloudNoiseMs,
        inLut: false,
      },
      msAniso: +this._uniforms.uMsAniso.value.toFixed(2),
      nightZenithNits: this.nightZenithNits,
      nightHorizonNits: this.nightHorizonNits,
      zenithNits: +a.zenithNits.toFixed(a.zenithNits < 10 ? 3 : 0),
      horizonNits: +a.horizonNits.toFixed(a.horizonNits < 10 ? 3 : 0),
      skyLux: +a.skyLux.toFixed(a.skyLux < 10 ? 3 : 0),
      sunLux: +a.sunLux.toFixed(0),
      fogColorNits: [a.fogColor.r, a.fogColor.g, a.fogColor.b].map((v) => +v.toFixed(2)),
      fogInscatterNits: [a.fogInscatter.r, a.fogInscatter.g, a.fogInscatter.b].map((v) => +v.toFixed(2)),
      fogClamp: +a.fogClamp.toFixed(3),
      inscatterClamp: +a.inscatterClamp.toFixed(3),
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
    // Saturation is radiance x exposure, not illuminance. This gate previously
    // checked only nits and lux, so a dome rendering at 3.6x ACES saturation reported
    // `implausible: []` at dusk while the frame was a flat white sheet - the sky
    // illuminance (1612 lux) sat comfortably inside its 100-2500 envelope the whole
    // time. The same correction was already applied to fogColor and fogInscatter
    // above and was never extended to the dome itself.
    //
    // Mid-sky is the geometric mean of zenith and horizon: roughly what fills the
    // upper half of a street-level frame. The zenith is the darkest part of a clear
    // sky, so if MID-sky clips, most of the visible sky is gone. Some clipping in the
    // sun's immediate lobe is correct and is deliberately not gated here.
    if (a.exposure) {
      const midSky = Math.sqrt(Math.max(0, a.zenithNits) * Math.max(0, a.horizonNits)) * a.exposure;
      a.midSkyExposed = +midSky.toFixed(3);
      if (midSky > 1.0) {
        flags.push(`mid-sky renders at ${midSky.toFixed(2)}x ACES saturation for ${this.presetName}`
          + ` (zenith ${a.zenithNits.toPrecision(3)} nits, horizon ${a.horizonNits.toPrecision(3)} nits`
          + ` at a 1/${Math.round(1 / a.exposure)} stop) — the sky is blown, not merely bright`);
      }
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
    this.cloudNoise.dispose();
    if (this.envTarget) this.envTarget.dispose();
    if (this.pmrem) this.pmrem.dispose();
  }
}

function luminance(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function luminance3(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Convenience: build the sky, park it in the scene and hand back the instance. */
export function createSky(renderer, scene, opts) { return new Sky(renderer, scene, opts); }
