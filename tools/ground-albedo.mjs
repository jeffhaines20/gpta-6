// What does the dome's GROUND ALBEDO actually do to the colour of a shaded wall?
//
// src/sky.js's skyRadiance() fades the dome into groundRadiance() = uGroundAlbedo
// * E / PI below the horizon, so the dome's lower hemisphere IS the district's
// ground bounce and uGroundAlbedo is the only lever in the whole lighting model
// that puts WARM light on a surface the sun cannot see. The transfer round sized
// a candidate change to it from arithmetic — the albedo reads luminance 0.129
// against a district ground of 0.18-0.19, which is +0.28 stops on roughly half a
// wall's ambient — and deliberately did not apply it.
//
// This is the measurement that arithmetic needs. The uniform is set once at
// construction and _pushUniforms() never rewrites it, so a candidate value can be
// injected into a running district and the LUT and PMREM rebuilt around it. Every
// candidate is therefore measured on ONE streamed scene at ONE camera with one
// browser launch: nothing else moves between arms.
//
// What it reads, per candidate per preset:
//
//   - the dome's own cosine-weighted integrals over the upper and lower
//     hemispheres, in lux and in linear RGB. The lower one is what the PMREM
//     hands every down-facing and vertical surface; the upper one is what
//     audit().skyLux gates, and it must NOT move (see below).
//   - a shaded wall, a sunlit wall and the road, read out of the HDR scene target
//     in linear nits — so blue/red is a ratio of LIGHT and not a ratio of bytes
//     that ACES has already compressed.
//   - sky.audit() and daynight.audit(), so the plausibility envelope's verdict is
//     recorded next to every arm rather than checked once at the end.
//
// THE CONTROL IS NOT OPTIONAL. A probe that changes nothing produces a beautifully
// stable set of numbers, and this project has shipped one before (a visibility
// toggle that affected zero meshes). `--controls` prepends a black albedo and a
// white one: if the shaded wall's blue/red does not move a long way between those
// two, the injection is not reaching the render and every other row is noise.
//
//   node tools/ground-albedo.mjs --albedos 6b6455,7d7362,8a8070 --controls
//   GA_SHOT=fivepoints GA_TIMES=noon,golden node tools/ground-albedo.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const TIMES = (process.env.GA_TIMES ?? 'noon,golden,dusk,night').split(',');
const SHOT = process.env.GA_SHOT ?? 'corridor';
const TAG = process.env.GA_TAG ?? 'ga';
const SHOOT = has('shots');
let ALBEDOS = String(arg('albedos', '6b6455')).split(',').filter(Boolean);
if (has('controls')) ALBEDOS = ['000000', 'ffffff', ...ALBEDOS];

// Regions in 1600x900 screenshot pixels, y down. The wall boxes are the two the
// round-7 lighting isolation and tools/sky-once.mjs already name, kept so the
// numbers can be laid beside theirs; `sunPct` beside each one is how a reader
// tells a shaded wall from a sunlit one rather than trusting the label.
const REGIONS = {
  wall:   [120, 120, 120, 60],
  ground: [250, 800, 120, 40],
  plaza:  [0, 700, 1000, 200],
  road:   [1340, 575, 240, 32],
};

// The same decode src/sky.js's `srgb()` helper applies, so a hex on this command
// line means exactly what the same hex means in the source.
export const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linear = (hex) => {
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbDecode);
};

// ------------------------------------------------------------------- ARMS
//
// TWO BUILDS IN ONE SESSION, and the reason is not convenience. A lighting change
// is normally A/B'd by capturing, editing the source, and capturing again - which
// measures that change only if nothing ELSE moved on disk in between. On
// 2026-09-05 three agents were in this tree at once and src/facades.js changed
// between one capture and the next, so a straight before/after would have
// measured a facade round and a sky round together and credited both to the sky.
//
// An arm is a set of uniform values pushed into a RUNNING district. The camera is
// placed and the streamer settles once; each arm then rebuilds the LUT and the
// PMREM around its own uniforms and takes its own frame. Geometry, materials,
// streaming state, traffic and camera are bit-identical across arms by
// construction. Exported here rather than copied into each harness, which is the
// mistake tools/framing.mjs exists because of.
export const ARM_STATE = {
  // The build as it stood before 2026-09-05: uGroundAlbedo 0x6b6455, and a ground
  // bounce whose sky term was 0.16 * uSunIlluminance * sin(elevation) PLUS the
  // night-glow constant (uNightHorizon + uNightZenith) * PI.
  //
  // That constant is 0.80 lux at every hour and it is not decoration at two of
  // them: this file's dusk preset puts the sun at elevation exactly 0 and its
  // night preset puts it below the horizon, so 0.16 * ndl is zero and the
  // constant is the WHOLE of the old sky term there. Leaving it out of the
  // emulation would have made the before-arm's ground bounce 0.000 nits at dusk
  // and night instead of 0.033, which is three display levels on a night wall lit
  // by the dome alone - small, and in the direction that would have flattered
  // this round.
  ground0: { albedo: linear('6b6455'), skyProxy: true, nightGlowLux: 0.8014 },
  // The build as it stands now - whatever the source says, untouched.
  ground1: { albedo: null, skyProxy: false, nightGlowLux: 0 },

  // THE MS WHITENING'S DIRECTIONAL SCOPE (src/sky.js, msWhitenAnti): how much of
  // the whitening survives at the anti-solar point. These arms leave the ground
  // exactly as the build has it and move only that scalar, so a frame-level
  // before/after on the anti-solar sky can be shot from ONE streamed district -
  // which matters more here than usual, because the quantity being read is a
  // 0.05 chroma offset on a sky rect and a moved cloud is worth more than that.
  //
  // anti100 IS the isotropic behaviour the whitening shipped with, so it is the
  // control: it must reproduce the r8 arm, and if it does not, the frames are
  // measuring something other than this change.
  anti100: { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 1.0 },
  anti50:  { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 0.5 },
  anti25:  { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 0.25 },
  anti00:  { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 0.0 },

  // ROUND 4's CAR LENS. carLens is the scalar district/main.js's setCarLens()
  // takes: 0 is the flat lens and the dark parked tail lamp this round replaces,
  // 1 is what it ships, and the rest are a level sweep on the parked car's rear
  // reflector. The sky fields are all null, so these arms leave the district's
  // light exactly where the build has it and move only the cars.
  //
  // Every one of them shoots from ONE page load, ONE camera and ONE settled
  // district, which is the whole reason they live here rather than in a query
  // string: two page loads is two traffic simulations, and this project has
  // twice shipped a comparison whose two arms were the same build.
  lens0:    { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0 },
  lens1:    { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1 },
  lensHalf: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0.5 },
  lensHi:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1.6 },

  // ROUND 5, THE FRONT REFLECTOR. carLens stays at 1 in all of them - these arms
  // move the headlight texel of the retro palette and NOTHING else, so a pair of
  // them isolates the front lens from the round-4 rear one that shares its
  // emissive scalar. front0 is round 4 exactly (zero headlight texel).
  // EVERY round-5 arm names BOTH terms. setArm restores nothing it is not told
  // about, so an arm list that mixes a front sweep with a tyre sweep would carry
  // the last tyre value into every front frame - a confound introduced into the
  // very A/B that exists to isolate.
  front0:  { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 1 },
  front1:  { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 1, carTyre: 1 },
  front2:  { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 2, carTyre: 1 },
  front4:  { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 4, carTyre: 1 },
  front8:  { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 8, carTyre: 1 },

  // ROUND 5, THE TYRE. Same isolation argument: rimCoV, hubPeak and hubFrac are
  // all computed inside rho < 0.55 and the tyre is the outer annulus, so these
  // arms can only move rimTyre. 1 is the build.
  tyre1:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 1 },
  tyre2:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 2 },
  tyre3:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 3 },
  tyre5:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 5 },
  tyre8:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 8 },

  // ROUND 8: LIFTING THE POOL UNDER THE CARS.
  //
  // The composite is `scene * ao` with nothing under it, and ao is
  // pow(1 - occlusion, 8.5). Measured on the near parked car, the darkest column
  // under it reaches LINEAR ZERO (tyre/min 0.000 at night, 0.071 at noon) and
  // sits 1.5-2.15 wheel radii inboard of the tyre. A contact patch that tried to
  // darken the tyre did nothing there, because multiply cannot darken black -
  // so the lever is the pool, not the tyre.
  //
  // TWO LEVERS, AND THEY REACH DIFFERENT PIXELS. That is the whole reason both
  // are swept rather than one picked.
  //
  //   INTENSITY is the exponent, and it is preferentially targeted at exactly
  //   the crushed region: raw ao 0.90 (a facade corner) lifts 1.6x going 8.5 ->
  //   4.0, while raw ao 0.35 (under a car) lifts 113x. It cannot touch a pixel
  //   the estimator calls FULLY occluded, because pow(0, n) is 0 for every n.
  //
  //   FLOOR is the only thing that reaches those. It lifts everything by the
  //   same affine amount, so it is the blunter of the two and the one more
  //   likely to wash out the junction darkening the exponent exists to produce.
  //
  // aoShip must reproduce a no-arm capture or the arms are measuring something
  // else. aoOff is the diagnostic: if the under-car black does not lift with AO
  // switched off entirely, AO is not the cause and this whole round is wrong.
  aoShip:  { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 8.5, 1.0, 0.00] },
  aoOff:   { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 8.5, 0.0, 0.00] },
  aoInt55: { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 5.5, 1.0, 0.00] },
  aoInt40: { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 4.0, 1.0, 0.00] },
  aoFlr04: { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 8.5, 1.0, 0.04] },
  aoFlr10: { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 8.5, 1.0, 0.10] },
  aoMix:   { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [0.6, 5.5, 1.0, 0.04] },

  // ROUND 6, THE GLAZING. Slot 10 ships roughness 0.06 / metalness 0.86 over a
  // vertex albedo of (0.0040, 0.0052, 0.0075), which in a metallic-roughness
  // BRDF is F0 = 0.0099 and a diffuse term of 0.0007 - a 1% reflector, i.e. a
  // hole by construction. Car glass is a DIELECTRIC: at metalness 0 the BRDF
  // uses F0 = 0.04 with a full Fresnel rise toward 1.0 at grazing incidence,
  // which is the term that makes a windscreen mirror the sky at an angle.
  //
  // The prediction is ~4x the specular at normal incidence and more at grazing.
  // gl086 is the shipped control and MUST reproduce a no-arm capture; if it does
  // not, the arms are measuring something other than this change. gl000 is the
  // dielectric; gl025 brackets it in case a full dielectric reads as chrome; and
  // gl000r12 asks whether a slightly rougher dielectric reads better than a
  // mirror-sharp one at this pixel size.
  //
  // Every arm names carLens AND carGlass, for the reason the round-5 block
  // gives: setArm restores nothing it is not told about.
  gl086:    { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0, carGlass: [0.06, 0.86] },
  gl025:    { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0, carGlass: [0.06, 0.25] },
  gl000:    { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0, carGlass: [0.06, 0.00] },
  gl000r12: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0, carGlass: [0.12, 0.00] },

  // ROUND 6, THE PARKED REFLECTOR AGAINST THE STANDING CONSTRAINT.
  //
  // The night corridor frame carries SEVEN saturated red blobs (redness > 120,
  // n >= 8) on the shipped build, against seven in round 1 - the build whose
  // parked lamps were reported as "all seem to have their lights on" - at 44% of
  // round 1's area and 88% of its peak. Round 4 put them back on purpose and had
  // a reason: lights fully off cost six of the seven and five of six cars
  // stopped reading as cars. So this is not a revert, it is a search for the
  // level and profile at which a parked lens still carries a chromatic step and
  // a gradient but no longer has a SATURATED CORE.
  //
  // Two levers, swept separately because CLAUDE.md's rule is one term at a time:
  //
  //   pk* move the LEVEL (carLens), profile left at the shipped 0.16/1.55/2.0.
  //        A level cut scales peak and step together, so it buys a clean core by
  //        spending the step the round-4 reviewer asked for.
  //   pf* move the PROFILE at the shipped level. Raising uLensEdge moves light
  //        out of the core into the rim: the peak falls while the MEAN over the
  //        lens - which is what the chromatic step is - is far less affected.
  //        If that works it is strictly the better lever, and the sweep is how
  //        this round finds out rather than assuming.
  //
  // Every arm names carLens AND carProfile, for the reason the round-5 block
  // gives: setArm restores nothing it is not told about, so a mixed list would
  // carry the last profile into every level frame.
  pk100: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1.0,  carProfile: [0.16, 1.55, 2.0] },
  pk070: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0.70, carProfile: [0.16, 1.55, 2.0] },
  pk050: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0.50, carProfile: [0.16, 1.55, 2.0] },
  pk035: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 0.35, carProfile: [0.16, 1.55, 2.0] },
  pf045: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1.0,  carProfile: [0.45, 1.25, 2.0] },
  pf065: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1.0,  carProfile: [0.65, 1.10, 2.0] },
  pf045g: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1.0, carProfile: [0.45, 1.25, 1.4] },

  // ROUND 5, THE LENS FINISH. carFront stays at 0 in all of them, so what these
  // measure is the SURFACE alone - a dielectric at 0.07/0.03 against a bowl -
  // with no emissive floor underneath it to share the credit.
  finA: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 1, carFinish: [0.07, 0.03] },
  finB: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 1, carFinish: [0.18, 0.85] },
  finC: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 1, carFinish: [0.32, 0.85] },
  finD: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carTyre: 1, carFinish: [0.32, 1.00] },

  // ROUND 5, THE HUB. hubPeak is p95/median inside the rim band, so the tyre
  // lever cannot reach it; these scale the one bright vertex at each wheel's
  // centre and nothing else. Paired with the tyre value the sweep settles on,
  // so the two wheel numbers are read off ONE frame each rather than two.
  hub10: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carHub: 1.0 },
  hub07: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carHub: 0.7 },
  hub05: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carHub: 0.5 },
  hub03: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carHub: 0.3 },

  // ROUND 5, THE LAMP ALBEDO. 1.456 is 1/0.687, i.e. the lens painted the same
  // albedo as the body rather than darker than it; past that the vertex colour
  // is authoring a reflectance over 1 and the arm exists only to bound the fit.
  alb10: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carAlbedo: 1.0 },
  alb15: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carAlbedo: 1.456 },
  alb20: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1, carFront: 0, carAlbedo: 2.0 },

  // THE ROUND-5 PAIR. r5car is the build untouched; r4car undoes all four of the
  // round's terms and is round 4 EXACTLY - the three colour scales are the exact
  // linear inverses of the authored ones and round-trip to the original bytes
  // (tyre and lamp to 0 DN, the hub to 1 DN on one channel), and carFront 0 is a
  // zero headlight texel in the retro palette, which is what round 4 had.
  //
  // Both arms therefore come off ONE page load, ONE build and ONE port. This
  // project has twice compared a build against itself; setCarLensArm's own note
  // says why that is not a convenience.
  r4car: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1,
    carFront: 0, carAlbedo: 1 / 1.3611, carTyre: 1 / 1.97946, carHub: 1 / 0.50067 },
  r5car: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1,
    carFront: 1, carAlbedo: 1, carTyre: 1, carHub: 1 },
  // ...and the two halves of the front lens on their own, so the round can say
  // which term carried it rather than claiming both.
  r5albOnly:   { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1,
    carFront: 0, carAlbedo: 1, carTyre: 1, carHub: 1 },
  r5frontOnly: { albedo: null, skyProxy: false, nightGlowLux: 0, carLens: 1,
    carFront: 1, carAlbedo: 1 / 1.3611, carTyre: 1, carHub: 1 },

  // ROUND 9: THE CUMULATIVE PAIR THE REVIEWERS ARE ASKED TO JUDGE.
  //
  // Three blind reviewers said the cars were NOT markedly improved. Four changes
  // shipped after that verdict and none has been put back in front of them:
  //
  //   35cba0b  RETRO.scale 1 -> 0   parked tail lamps off   carLens
  //   35cba0b  FRONT.scale 1 -> 0   parked headlamps off    carFront
  //   10ecf14  PALETTE[10] metalness 0.86 -> 0.00           carGlass
  //   e30b4ce  post aoFloor 0 -> 0.04                       ao[3]
  //   94a5b34  three body shells on both pools              ?shells= AT BOOT
  //
  // r5cum is b1bff3f - the tree they judged - and r9cum is the tree now. The
  // first four terms are runtime levers so both arms come off ONE page load,
  // ONE camera and ONE settled district. The shells cannot: a slot's shell is
  // fixed when its matrix is written, so THAT term is a boot query parameter and
  // the honest pair is `?shells=1` + r5cum against default + r9cum, two loads.
  // Capturing all four cells also isolates the shells from the other three,
  // which is the only reason to shoot the crosses at all.
  //
  // EVERY CAR TERM IS NAMED IN BOTH ARMS, including the four that do not move.
  // setArm restores nothing it is not told about, and this file has been bitten
  // three times by an arm inheriting the previous one's value - a confound
  // introduced into the very A/B that exists to isolate. carProfile is named
  // because setCarLens calls setLensProfile itself: at carLens 0 that writes
  // edge 1 / gain 1, so an unnamed profile would be captured from the AFTER arm
  // and then applied to the BEFORE arm, which is the confound in reverse.
  // 0.16/1.55/2.0 is setLensProfile's own `on` default and therefore exactly
  // what b1bff3f shipped; [0.07, 0.03] is PALETTE[4], unchanged by this round.
  r5cum: { albedo: null, skyProxy: false, nightGlowLux: 0,
    carLens: 1, carFront: 1, carGlass: [0.06, 0.86], carProfile: [0.16, 1.55, 2.0],
    carTyre: 1, carHub: 1, carAlbedo: 1, carFinish: [0.07, 0.03],
    ao: [0.6, 8.5, 1.0, 0.00] },
  r9cum: { albedo: null, skyProxy: false, nightGlowLux: 0,
    carLens: 0, carFront: 0, carGlass: [0.06, 0.00], carProfile: [0.16, 1.55, 2.0],
    carTyre: 1, carHub: 1, carAlbedo: 1, carFinish: [0.07, 0.03],
    ao: [0.6, 8.5, 1.0, 0.04] },

  // ROUND 10: WHICH TERM CARRIES THE PANE, because last round moved two at once.
  //
  // metalness is not one knob, it is two:
  //     F0      = mix(0.04, albedo, metalness)     the reflection
  //     diffuse = albedo * (1 - metalness)         the floor
  // so 0.86 -> 0 raised F0 4x AND the diffuse 7x, and there was no way to tell
  // which the reviewers were looking at. All three said the same thing about the
  // result - "the lift raised the median without putting any content in the
  // window" - and the quarter light went from 0.275 to 1.350 of the paint below
  // it, brighter than the paint.
  //
  // carGlassAlbedo is the missing axis. Holding metalness at 0 and scaling the
  // albedo moves the diffuse floor proportionally and leaves F0 fixed at 0.04:
  //
  //   gaOld    m 0.86, albedo x1     last round. F0 0.0099, diffuse 0.0007
  //   gaShip   m 0.00, albedo x1     the build.  F0 0.04,   diffuse 0.0050
  //   gaA033   m 0.00, albedo x0.33              F0 0.04,   diffuse 0.0017
  //   gaA014   m 0.00, albedo x0.14              F0 0.04,   diffuse 0.0007
  //   gaA000   m 0.00, albedo x0.00              F0 0.04,   diffuse 0
  //
  // gaA014 IS THE HYPOTHESIS: 0.14 is 1 - 0.86, so its diffuse floor equals
  // gaOld's exactly while its F0 is four times higher. If the pane looks like
  // gaOld there, the dielectric bought nothing and the whole visible change last
  // round was the floor. If it looks like glass, that is the fix.
  //
  // gaA000 IS THE DIAGNOSTIC and the reason this sweep can fail honestly: at zero
  // albedo the pane's ONLY content is the Fresnel reflection of the environment.
  // If it renders black, then F0 0.04 against this scene delivers nothing
  // visible, the dielectric change was a grey floor and nothing else, and no
  // albedo setting fixes it - the next lever would have to be the environment
  // response, which this pool cannot raise for the glass alone because one
  // material serves every slot on the car.
  //
  // gaShip must reproduce a no-arm capture. Every car term is named in all five.
  ...(() => {
    const base = {
      albedo: null, skyProxy: false, nightGlowLux: 0,
      carLens: 0, carFront: 0, carProfile: [0.16, 1.55, 2.0],
      carTyre: 1, carHub: 1, carAlbedo: 1, carFinish: [0.07, 0.03],
      ao: [0.6, 8.5, 1.0, 0.04],
    };
    return {
      gaOld:  { ...base, carGlass: [0.06, 0.86], carGlassAlbedo: 1 },
      gaShip: { ...base, carGlass: [0.06, 0.00], carGlassAlbedo: 1 },
      gaA033: { ...base, carGlass: [0.06, 0.00], carGlassAlbedo: 0.33 },
      gaA014: { ...base, carGlass: [0.06, 0.00], carGlassAlbedo: 0.14 },
      gaA000: { ...base, carGlass: [0.06, 0.00], carGlassAlbedo: 0.00 },
    };
  })(),

  // THE DISTRICT BOUNCE, scaled. It is a HemisphereLight and three.js gives it no
  // occlusion, so it reaches the road under a closed oak canopy in full - which is
  // exactly where noon's dapple is read. bounce00 is the build with the bounce
  // removed and nothing else touched, which is the only way to say how much of
  // noon's lost dapple contrast is the bounce and how much is everything else that
  // moved in the same round (SSAO went 2.2 m at exponent 3.8 -> 0.6 m at 8.5 and
  // the buffer to full resolution, and that is another agent's file).
  //
  // The scale is applied by WRAPPING _applyBounce, not by writing the intensity:
  // follow() recomputes the bounce from the sun every frame, so a value assigned
  // once is gone by the next frame and the arm would silently be the base build.
  bounce00: { albedo: null, skyProxy: false, nightGlowLux: 0, bounceScale: 0 },
  bounce50: { albedo: null, skyProxy: false, nightGlowLux: 0, bounceScale: 0.5 },

  // THE OTHER THING THAT MOVED IN THE SAME ROUND. Between r2post and r8 the SSAO
  // went from 2.2 m at exponent 3.8 to 0.6 m at 8.5 and its buffer to full
  // resolution, and a contact-shadow term of that size is a candidate for noon's
  // lost road dapple every bit as much as the ambient is. ao22 restores the old
  // parameters at runtime so the two can be separated in ONE session instead of
  // being attributed by argument. It writes postParams only - src/post.js is
  // another agent's file this round and is not touched.
  ao22: { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [2.2, 3.8, 1.0] },
};

/**
 * Push an arm's uniforms and rebuild everything derived from them.
 *
 * ground0's sky term is reproduced as a GREY illuminance, including the night-glow
 * constant. What is not reproduced is that constant's COLOUR - it was
 * [1.04, 0.73, 0.83] lux and this is 0.80 grey - which at noon and golden is four
 * parts in a hundred thousand of E, and at dusk and night is a hue error on a term
 * that renders 0.033 nits against a shaded wall reading 0.278. One display level,
 * stated rather than assumed away.
 */
export async function setArm(page, name) {
  const st = ARM_STATE[name];
  if (!st) throw new Error(`unknown arm ${name}; known: ${Object.keys(ARM_STATE).join(', ')}`);
  return page.evaluate((s) => {
    const sky = __district.sky, u = sky._uniforms;
    if (!window.__armSaved) {
      const a = u.uGroundAlbedo.value;
      window.__armSaved = { albedo: [a.r, a.g, a.b] };
    }
    const a = s.albedo ?? window.__armSaved.albedo;
    u.uGroundAlbedo.value.setRGB(a[0], a[1], a[2]);
    // uSkyIlluminance CANNOT simply be assigned. refresh() reads the probe and
    // _deriveFromProbe() writes this uniform from the dome's own integral before
    // the LUT is rendered, so a value set now is overwritten by the very value
    // the arm exists to replace. Wrap the writer instead: the override then lands
    // where the real value does, on every refresh, including the ones a
    // time-of-day change makes on its own.
    if (u.uSkyIlluminance && !sky.__armPatched) {
      const orig = sky._deriveFromProbe.bind(sky);
      sky._deriveFromProbe = function patched(buf, gen) {
        orig(buf, gen);
        if (window.__armOverride != null) u.uSkyIlluminance.value = window.__armOverride;
      };
      sky.__armPatched = true;
    }
    // 127,500 is src/sky.js's SUN_ILLUMINANCE. Taken off the dome's own sun
    // direction rather than a preset table, so it cannot disagree with the sun in
    // frame.
    window.__armOverride = s.skyProxy
      ? 127500 * 0.16 * Math.max(sky.sunDirection.y, 0) + (s.nightGlowLux ?? 0)
      : null;
    // Saved and restored like the albedo, so an arm that does not name it gets
    // the build's own value rather than the previous arm's.
    if (window.__armSaved.msWhitenAnti === undefined) {
      window.__armSaved.msWhitenAnti = sky.msWhitenAnti;
    }
    sky.msWhitenAnti = s.msWhitenAnti ?? window.__armSaved.msWhitenAnti;
    // The bounce scale, wrapped once and driven by a window global thereafter, so
    // that follow()'s per-frame _applyBounce() cannot restore the base value
    // between the arm being set and the shutter opening.
    const dn = window.__district && window.__district.tod;
    if (dn && !dn.__armPatched) {
      const origBounce = dn._applyBounce.bind(dn);
      dn._applyBounce = function patchedBounce() {
        const b = origBounce();
        const k = window.__bounceScale;
        if (k != null) this.bounce.intensity *= k;
        return b;
      };
      dn.__armPatched = true;
    }
    window.__bounceScale = s.bounceScale ?? null;
    if (dn) dn._applyBounce();
    // SSAO, saved and restored the same way, so an arm that does not name it gets
    // the build's own parameters rather than the previous arm's.
    const q = window.__district && window.__district.postParams && window.__district.postParams();
    if (q) {
      if (!window.__armSavedAO) window.__armSavedAO = [q.aoRadius, q.aoIntensity, q.aoStrength, q.aoFloor ?? 0];
      const ao = s.ao ?? window.__armSavedAO;
      q.aoRadius = ao[0]; q.aoIntensity = ao[1]; q.aoStrength = ao[2]; q.aoEnabled = true;
      // A FOURTH ELEMENT, optional. An arm that names only three gets the
      // build's floor rather than zero: writing 0 here for every arm that did
      // not ask would silently reset a shipped floor the moment any other arm
      // ran, which is the confound this file has been bitten by three times.
      q.aoFloor = ao.length > 3 ? ao[3] : (window.__armSavedAO[3] ?? 0);
    }
    // THE CAR LENS ARM. Pushed through the app's own entry point rather than at
    // the material, so an arm cannot drift from what ?lens= does; setCarLens
    // re-applies the parked pool's emissive itself, because that pool only
    // recomputes when the camera STOP changes and switching arms does not
    // change the stop.
    let carLens = null;
    if (s.carLens != null && window.__district && window.__district.setCarLens) {
      carLens = window.__district.setCarLens(s.carLens);
    } else if (window.__district && window.__district.carLens) {
      carLens = window.__district.carLens();
    }
    // THE PROFILE, applied AFTER the level, because setCarLens calls
    // setLensProfile itself: setCarLensArm(k) does setLensProfile(on), which
    // resets edge/pow/gain to their defaults. Setting the profile first would
    // therefore have been silently undone by the very next line, and the sweep
    // would have reported that the profile lever does nothing - a knob that
    // clamps silently is how a round concludes a lever is a no-op (this file,
    // setFrontLensScale). Saved and restored like every other term.
    // THE GLAZING FINISH. Saved and restored like every other term, so an arm
    // that does not name it gets the BUILD's value rather than the previous
    // arm's - the confound this file has already been bitten by twice.
    let carGlass = null;
    const DG = window.__district;
    if (DG && DG.carGlass) {
      if (window.__armSavedGlass === undefined) {
        const g0 = DG.carGlass();
        window.__armSavedGlass = g0 ? [g0.roughness, g0.metalness] : null;
      }
      const wantG = s.carGlass ?? window.__armSavedGlass;
      if (wantG && DG.setCarGlass) carGlass = DG.setCarGlass(wantG[0], wantG[1]);
      else carGlass = DG.carGlass();
    }
    let carProfile = null;
    const DP = window.__district;
    if (DP && DP.carLensProfile) {
      if (window.__armSavedProfile === undefined) {
        const p0 = DP.carLensProfile();
        window.__armSavedProfile = p0 ? [p0.edge, p0.pow, p0.gain] : null;
      }
      const want = s.carProfile ?? window.__armSavedProfile;
      if (want && DP.setCarLensProfile) carProfile = DP.setCarLensProfile(want[0], want[1], want[2]);
      else if (DP.carLensProfile) carProfile = DP.carLensProfile();
    }
    // THE ROUND-5 ARMS. carFront is the front reflector level and carTyre the
    // tyre albedo, both independent of carLens so a sweep can isolate one term
    // at a time off ONE page load. Read back off the app, like carLens, because
    // a knob that clamps silently is how a round concludes a lever does nothing.
    //
    // SAVED AND RESTORED, like the albedo and msWhitenAnti above, and for a
    // reason this file has already been bitten by once: setArm restores nothing
    // it is not told about, so an arm list that mixes a front sweep with a
    // finish sweep would carry the last finish into every front frame. That is a
    // confound introduced into the very A/B that exists to isolate. An arm that
    // does not name a term now gets the BUILD's value for it, not the previous
    // arm's.
    const D = window.__district;
    if (D && !window.__armSavedCar) {
      window.__armSavedCar = {
        front: D.carFrontLens ? D.carFrontLens().scale : null,
        tyre: 1,                                   // setCarTyre composes as k off a captured base
        hub: 1,                                    // so does setCarHub
        lampAlbedo: 1,                             // and setCarLampAlbedo
        finish: D.carLensFinish ? D.carLensFinish() : null,
      };
    }
    const sv = window.__armSavedCar ?? {};
    let carFront = null;
    if (D && D.setCarFrontLens) carFront = D.setCarFrontLens(s.carFront ?? sv.front ?? 1);
    let carTyre = null;
    if (D && D.setCarTyre) carTyre = D.setCarTyre(s.carTyre ?? sv.tyre ?? 1);
    let carHub = null;
    if (D && D.setCarHub) carHub = D.setCarHub(s.carHub ?? sv.hub ?? 1);
    let carAlbedo = null;
    if (D && D.setCarLampAlbedo) carAlbedo = D.setCarLampAlbedo(s.carAlbedo ?? sv.lampAlbedo ?? 1);
    // THE GLAZING ALBEDO. Saved and restored like every other term; scaled from a
    // captured base inside setGlassAlbedo, so k = 1 restores exactly and repeated
    // arms do not compound.
    let carGlassAlbedo = null;
    if (D && D.setCarGlassAlbedo) {
      carGlassAlbedo = D.setCarGlassAlbedo(s.carGlassAlbedo ?? 1);
    }
    let carFinish = null;
    if (D && D.setCarLensFinish) {
      const fin = s.carFinish ?? [sv.finish.roughness, sv.finish.metalness];
      carFinish = D.setCarLensFinish(fin[0], fin[1]);
    }
    sky._dirty = true;
    sky.refresh({ force: true, environment: true, sync: true });
    const g = u.uGroundAlbedo.value;
    return { albedo: [+g.r.toFixed(4), +g.g.toFixed(4), +g.b.toFixed(4)],
      skyIlluminance: u.uSkyIlluminance ? +u.uSkyIlluminance.value.toFixed(1) : null,
      // Read back off the UNIFORM, not off the property that was just written -
      // an arm that sets a field _pushUniforms never reads is an arm that does
      // nothing, and this is the number proveArmsDiffer keys on.
      msWhitenAnti: u.uMsWhitenAnti ? +u.uMsWhitenAnti.value.toFixed(3) : null,
      bounceLux: dn ? +dn.bounce.intensity.toFixed(2) : null,
      ao: q ? [q.aoRadius, q.aoIntensity, q.aoStrength, q.aoFloor ?? 0] : null,
      // Read back off what the app actually reached, not off what was asked for.
      carLens: carLens ? [carLens.retroScale, carLens.lens && carLens.lens.edge,
        carLens.parkedEmissive ?? null] : null,
      // THE PROFILE IS IN THE KEY, and it has to be: the round-6 arms pf045,
      // pf065 and pf045g all run carLens 1.0 and differ ONLY here, so a key
      // without it hashes three distinct arms to one value and proveArmsDiffer
      // aborts a sweep that would have measured perfectly well. That is the same
      // failure msWhitenAnti and carLens were added to this key for. Read back
      // off the app, not off the arm table.
      carProfile: carProfile
        ? [carProfile.edge, carProfile.pow, carProfile.gain] : null,
      // In the key, because gl086/gl025/gl000 differ in NOTHING else and a key
      // without it would hash three distinct arms to one value and abort a sweep
      // that would have measured perfectly well. Read back off the app, so a
      // knob that quantises (the pack texture is 8-bit: 0.06 stores as 15/255 =
      // 0.0588) reports what it actually wrote.
      carGlass: carGlass ? [carGlass.roughness, carGlass.metalness] : null,
      // In the key for the reason msWhitenAnti and carLens are: the round-5 arms
      // differ in NOTHING ELSE, so without them a four-arm sweep would hash
      // identical and proveArmsDiffer would pass a set of frames that are all
      // the same build.
      carFront: carFront ? [carFront.scale ?? null, carFront.linearLuma ?? null] : null,
      carTyre: carTyre ? [carTyre.scale, carTyre.verticesTouched.traffic,
        carTyre.verticesTouched.parked] : null,
      carFinish: carFinish ? [carFinish.roughness, carFinish.metalness] : null,
      carHub: carHub ? [carHub.scale, carHub.verticesTouched.parked] : null,
      carAlbedo: carAlbedo ? [carAlbedo.scale, carAlbedo.verticesTouched.parked] : null,
      // IN THE KEY, and it has to be: gaShip, gaA033, gaA014 and gaA000 differ in
      // NOTHING ELSE, so without it four distinct arms hash to one value and
      // proveArmsDiffer waves through a set of frames that are all the same build.
      // That is the fourth time a term has had to be added here for exactly this
      // reason. The vertex count rides along so a run that reached no glass says so.
      carGlassAlbedo: carGlassAlbedo
        ? [carGlassAlbedo.scale,
          carGlassAlbedo.verticesTouched.parked && carGlassAlbedo.verticesTouched.parked.verticesTouched,
          carGlassAlbedo.verticesTouched.traffic && carGlassAlbedo.verticesTouched.traffic.verticesTouched]
        : null,
      // WHICH SHELL SET THE POOLS BUILT WITH. Constant within a page load, so it
      // cannot make two arms distinct - it is here so a captured frame records
      // whether it is the one-shell or the three-shell load, which is the one
      // term of this round's pair that a runtime arm cannot carry. A pair whose
      // two halves came off two loads and did not record this is how an
      // index-matched comparison ends up pairing the wrong cells.
      carShells: (window.__district && window.__district.carShells)
        ? window.__district.carShells().shells : null,
      skyLuxUpper: +(sky.audit().skyLux ?? 0).toFixed(1) };
  }, st);
}

/**
 * Apply every arm once and refuse to continue if they resolve to the same
 * uniforms. An injection that reaches nothing produces a beautifully consistent
 * set of frames and a confident "the change did nothing"; this project has
 * shipped exactly that probe before.
 */
export async function proveArmsDiffer(page, arms) {
  const seen = [];
  for (const a of arms) seen.push({ arm: a, ...(await setArm(page, a)) });
  // msWhitenAnti is in the key because the sky arms differ in NOTHING ELSE: with
  // the old two-field key, four whitening arms would have hashed identical and
  // this guard would have passed a set of frames that were all the same build.
  // carLens is in the key for exactly the reason msWhitenAnti is: the round-4
  // lens arms differ in NOTHING ELSE, so without it four of them would hash
  // identical and this guard would wave through a set of frames that were all
  // the same build - the failure it exists to catch, for the second time.
  // carFront and carTyre joined the key in round 5 for the same reason, for the
  // third time: those arms move one texel and one vertex-colour set and nothing
  // a uniform readback would otherwise show.
  const distinct = new Set(seen.map((s) => JSON.stringify([s.albedo, s.skyIlluminance, s.msWhitenAnti, s.bounceLux, s.ao, s.carLens, s.carProfile, s.carGlass, s.carFront, s.carTyre, s.carFinish, s.carHub, s.carAlbedo, s.carGlassAlbedo, s.carShells]))).size;
  return { seen, ok: distinct === arms.length };
}

// Everything below is the CLI. Guarded so that a harness importing setArm() from
// this module does not launch a browser as a side effect of the import - which is
// what a top-level-await script does otherwise.
if (process.argv[1] && process.argv[1].endsWith('ground-albedo.mjs')) await main();

async function main() {
  fs.mkdirSync('docs/shots', { recursive: true });
  await ensureServer();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

  const placed = await page.evaluate(placeCamera, SHOTS[SHOT]);
  console.log(describe(SHOT, placed));
  await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });

  // Settle on the streaming COUNT holding still, not on a stopwatch: a fixed wait
  // measures a half-built district, which is the mistake the ledger records twice.
  await page.waitForFunction(() => {
    const w = __district.world.report();
    const prev = window.__gaSettle;
    const same = prev && prev.n === w.chunksLoaded && prev.m === w.meshes;
    window.__gaSettle = { n: w.chunksLoaded, m: w.meshes, still: same ? (prev.still ?? 0) + 1 : 0 };
    return window.__gaSettle.still >= 4;
  }, null, { timeout: 240000, polling: 2000 });
  const settled = await page.evaluate(() => {
    const w = __district.world.report();
    return { chunks: w.chunksLoaded, meshes: w.meshes, queued: w.queued ?? 0 };
  });
  console.log(`streaming settled: ${settled.chunks} chunks, ${settled.meshes} meshes, queue ${settled.queued}`);

  // --------------------------------------------------------------- in-page probe
  await page.evaluate(() => {
    const D = __district;
    // Half-float decode. THREE is not a browser global on this page, so DataUtils
    // is out of reach and this is ten lines rather than a dependency.
    const half = (h) => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 0x1f) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    function readBox(x, y, w, h) {
      const rt = D.post.hdr;
      const sx = rt.width / 1600, sy = rt.height / 900;
      const X = Math.round(x * sx), W = Math.max(1, Math.round(w * sx));
      const H = Math.max(1, Math.round(h * sy));
      const Y = Math.round(rt.height - (y + h) * sy);
      const buf = new Uint16Array(W * H * 4);
      D.renderer.readRenderTargetPixels(rt, X, Math.max(0, Y), W, H, buf);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < W * H; i++) {
        const R = half(buf[i * 4]), G = half(buf[i * 4 + 1]), B = half(buf[i * 4 + 2]);
        if (!isFinite(R) || !isFinite(G) || !isFinite(B)) continue;
        r += R; g += G; b += B; n++;
      }
      return n ? { r: r / n, g: g / n, b: b / n, y: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, n }
               : { r: 0, g: 0, b: 0, y: 0, n: 0 };
    }

    // The dome's own cosine-weighted integrals, read off the LUT the PMREM is
    // built from. Same convention as sky.js's _deriveFromProbe: elevation runs
    // -pi/2..+pi/2 up the texture, azimuth is atan2(z, x) across it. The UPPER
    // integral is the one audit().skyLux gates and the LOWER one is the ground
    // bounce this tool exists to move; reading both makes "the envelope is
    // untouched" a measurement instead of a claim about which loop bound is used.
    function domeIntegrals() {
      const sky = D.sky;
      const W = sky.lutWidth, H = sky.lutHeight;
      const buf = new Uint16Array(W * H * 4);
      D.renderer.readRenderTargetPixels(sky.lut, 0, 0, W, H, buf);
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const dPhi = (Math.PI * 2) / W, dTheta = Math.PI / H;
      const up = [0, 0, 0], down = [0, 0, 0], wall = [0, 0, 0];
      let eUp = 0, eDown = 0, eWall = 0;
      // A wall normal pointing back down the lens: the facade on the camera's own
      // side of the street, which is the surface every "shaded wall" number here is
      // about. Read off the camera matrix rather than off a preset.
      const e = D.camera.matrixWorld.elements;
      const wallAz = Math.atan2(e[10], e[8]);       // +Z column: away from the view
      for (let y = 0; y < H; y++) {
        const el = ((y + 0.5) / H - 0.5) * Math.PI;
        const se = Math.sin(el), ce = Math.cos(el);
        for (let x = 0; x < W; x++) {
          const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
          const i = (y * W + x) * 4;
          const c = [half(buf[i]), half(buf[i + 1]), half(buf[i + 2])];
          if (!isFinite(c[0])) continue;
          const l = lum(c), dw = ce * dTheta * dPhi;
          if (se > 0) { const w = se * dw; eUp += l * w; for (let k = 0; k < 3; k++) up[k] += c[k] * w; }
          else { const w = -se * dw; eDown += l * w; for (let k = 0; k < 3; k++) down[k] += c[k] * w; }
          const dW = ce * Math.cos(phi - wallAz);
          if (dW > 0) { const w = dW * dw; eWall += l * w; for (let k = 0; k < 3; k++) wall[k] += c[k] * w; }
        }
      }
      const r3 = (a) => a.map((v) => +v.toFixed(2));
      return { eUp: +eUp.toFixed(2), eDown: +eDown.toFixed(2), eWall: +eWall.toFixed(2),
        upRGB: r3(up), downRGB: r3(down), wallRGB: r3(wall),
        upBR: +(up[2] / Math.max(1e-9, up[0])).toFixed(3),
        downBR: +(down[2] / Math.max(1e-9, down[0])).toFixed(3),
        wallBR: +(wall[2] / Math.max(1e-9, wall[0])).toFixed(3) };
    }

    // Inject a candidate ground albedo and rebuild everything derived from it.
    // uGroundAlbedo is set once in the constructor and _pushUniforms() never
    // rewrites it, so this survives a time-of-day change; refresh() regenerates the
    // scattering LUT, the probe-derived fog parameters and the PMREM around it.
    function setAlbedo(rgb) {
      const sky = D.sky;
      const u = sky._uniforms.uGroundAlbedo.value;
      if (!window.__gaOriginal) window.__gaOriginal = { r: u.r, g: u.g, b: u.b };
      // LINEAR components, decoded by the caller. setHex(hex, SRGBColorSpace) would
      // be the natural call and THREE is not a global on this page; passing the
      // decode in rather than guessing at three's colour-space token keeps the
      // injected value exactly the one src/sky.js's srgb() helper would produce.
      u.setRGB(rgb[0], rgb[1], rgb[2]);
      sky._dirty = true;
      sky.refresh({ force: true, environment: true, sync: true });
      return { r: +u.r.toFixed(4), g: +u.g.toFixed(4), b: +u.b.toFixed(4),
        lum: +(0.2126 * u.r + 0.7152 * u.g + 0.0722 * u.b).toFixed(4),
        br: +(u.b / Math.max(1e-9, u.r)).toFixed(3) };
    }
    window.__ga = { readBox, domeIntegrals, setAlbedo };
  });

  const readRegions = () => page.evaluate((bx) => {
    const out = {};
    for (const [k, b] of Object.entries(bx)) {
      const v = window.__ga.readBox(b[0], b[1], b[2], b[3]);
      out[k] = { nits: +v.y.toFixed(4), rgb: [+v.r.toFixed(4), +v.g.toFixed(4), +v.b.toFixed(4)],
        br: +(v.b / Math.max(1e-9, v.r)).toFixed(3) };
    }
    return out;
  }, REGIONS);

  // Wait for rendered FRAMES, never for milliseconds: on the software rasteriser a
  // fixed wait is sometimes less than one frame and the readback then returns the
  // previous arm's render target, which is how a probe reports a change it did not
  // make.
  async function settleFrames(n = 8) {
    const f0 = await page.evaluate(() => __district.frames);
    // Both numbers travel INTO the page. Closing over `n` here reads it in the
    // browser, where it does not exist, and the run dies after the first arm.
    await page.waitForFunction(([f, k]) => __district.frames > f + k, [f0, n], { timeout: 180000, polling: 100 });
  }

  const rows = [];
  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(9000);
    for (const hex of ALBEDOS) {
      const albedo = await page.evaluate((c) => window.__ga.setAlbedo(c), linear(hex));
      await settleFrames(8);
      const dome = await page.evaluate(() => window.__ga.domeIntegrals());
      const regions = await readRegions();
      const audit = await page.evaluate(() => __district.audit());
      if (SHOOT) {
        await page.screenshot({ path: `docs/shots/${TAG}-${SHOT}-${tod}-${hex}.png`, timeout: 180000 });
      }
      const row = { tod, hex, albedo, dome, regions,
        skyLuxUpper: audit.sky?.skyLux, skyDelivered: audit.skyDelivery?.totalLux,
        skyPaths: audit.skyDelivery?.paths, exposure: audit.exposureAsStop,
        implausible: audit.implausible };
      rows.push(row);
      console.log(`${tod.padEnd(7)} ${hex}  albedo lum ${String(albedo.lum).padEnd(6)} B/R ${String(albedo.br).padEnd(5)}` +
        `  dome up ${String(dome.eUp).padStart(9)} lux / down ${String(dome.eDown).padStart(9)} lux` +
        `  wall ${regions.wall.nits.toFixed(1).padStart(8)} nits B/R ${regions.wall.br}` +
        `  skyLux ${audit.sky?.skyLux?.toFixed?.(1)}  flags ${audit.implausible.length}`);
    }
  }
  await page.evaluate(() => {
    const o = window.__gaOriginal;
    if (!o) return;
    const u = __district.sky._uniforms.uGroundAlbedo.value;
    u.setRGB(o.r, o.g, o.b);
    __district.sky._dirty = true;
    __district.sky.refresh({ force: true, environment: true, sync: true });
  });
  fs.writeFileSync(`docs/${TAG}-albedo.json`, JSON.stringify({ shot: SHOT, placed, settled, regions: REGIONS, rows, errors }, null, 1));
  console.log(`\nwrote docs/${TAG}-albedo.json (${rows.length} arms)`);
  await browser.close();
}
