// Pedestrians: a walking crowd on the sidewalks of the baked street graph.
//
// Mirrors src/traffic.js structurally on purpose - one instanced representation,
// a spawn/despawn radius around the player, routing over the baked graph, and a
// stats object the harnesses can gate on - because that architecture is the one
// this project has already proved stays inside the draw-call budget.
//
// ---------------------------------------------------------------------------
// REPRESENTATION: three InstancedMeshes, eight rigid bones per ped. Why.
// ---------------------------------------------------------------------------
// The budget gate is warn 200 / fail 320 draw calls and the district already
// spends ~110-125 of them. That is the whole constraint, so cost drove this:
//
//   * A Character (src/character.js) per ped is a Group of ~11 meshes over four
//     materials. Three-ish draw calls each: 60 peds is ~200 calls of pedestrian
//     alone and the gate fails on the spot. Not viable at any quality.
//   * A skinned mesh per ped is one call each (still 60), needs a rigged asset
//     this project has no pipeline for, and adds per-ped skinning on the CPU.
//   * A billboard impostor is the cheapest thing that exists, and it is wrong
//     here: this is a third-person game where the player walks around people at
//     two metres. An impostor survives being looked at, not being circled.
//
// What ships is the middle option the brief called out: a small number of
// instanced body-part meshes whose per-instance matrices are driven by the
// stride phase.
//
//   torso  - 1 instance per ped
//   head   - 1 instance per ped
//   limb   - 8 instances per ped (thigh + shank, upper arm + forearm, x2 sides)
//
// Three InstancedMeshes for the entire population: 3 draw calls in the scene pass
// and 3 more in the shadow pass, FIXED, whatever the population is. Measured on
// the hero corridor: 122 -> 125 scene calls for the bodies, against a gate that
// warns at 200. (There used to be a fourth, a contact-shadow blob; the note at
// its old site in the constructor records what it was and why it is gone.)
// Colour variety comes from
// per-instance colour (skin, shirt, trousers all multiply the one material), so
// a varied crowd costs no extra materials; height and build come from
// per-instance scale.
//
// The trade-off, stated plainly: rigid capsule bones mean no shoulder twist, no
// foot roll, no cloth and no face. Peds read as people on the far pavement and
// as mannequins if you stand nose-to-nose with one. That is the right side of
// the trade when the alternative that looks better up close costs 60 draw calls
// and an asset pipeline. Eight bones is the fewest that still gives a real gait,
// and gait - not polygons - is what makes a crowd read as alive.
//
// ---------------------------------------------------------------------------
// NEAR LOD: the same rig, at the resolution the near field actually needs.
// ---------------------------------------------------------------------------
// The paragraph above priced one mesh for the whole crowd and then chose its
// resolution for the FAR pavement. Measured, that choice is wrong for the hero
// frames: in the corridor hero framing the nearest ped stands 8-10 m from the
// lens, which makes a 1.72 m figure 152-186 px tall on axis in a 900 px frame
// (265 px measured for one standing near the frame edge, where the perspective
// divide stretches it). At that size a 6-sided limb capsule shows every one of
// its six facet boundaries as a shading crease, a 7x5 sphere head is a visibly
// chipped polygon, and the absences - no foot, no hand, no neck, no pelvis -
// are what actually read as "mannequin".
//
// Four hypotheses were measured before any geometry changed, and three of them
// were WRONG (tools/ped-audit.mjs, docs/pedaudit-dusk.json):
//
//   * face winding, the defect this repo has already found twice: rendering the
//     crowd DoubleSide instead of FrontSide changes 0.00 mean luminance over
//     0.0% of the pedestrian mask, against a positive control - a deliberate
//     index flip - of 2.75 over 11.8% of the same mask. 0 of 960 live instance
//     matrices have a negative determinant. Ruled out.
//   * material response: switching the sun off at noon changes 39.3 mean
//     luminance over 55.0% of the subject box, and the environment probe is
//     79.5 over 96.9% at dusk. The crowd is lit by everything the district is
//     lit by. Ruled out.
//   * per-instance colour reaching the shader: forcing vertexColors on without a
//     colour attribute turns the whole crowd black, which is the instrument
//     proving it can see the failure. Colour works. Ruled out.
//   * pose at rest: v = 0 gives a standing figure with its feet together and its
//     arms down, not a T-pose or a frozen mid-stride. Ruled out.
//
// So the fix is resolution, spent ONLY where it is visible. A second tier of the
// same three meshes serves the nearest NEAR_POOL peds within NEAR_RADIUS of the
// CAMERA (not of the crowd's focus point - the hero cameras stand 26-34 m behind
// it, and a focus-relative test would classify every ped in the frame as far).
// The camera arrives through onBeforeRender, so nothing outside this file has to
// know the tier exists.
//
// The cost is bounded on purpose. The near tier's InstancedMesh.count is set to
// the number of peds actually holding a slot, so it submits nothing for slots it
// is not using, and its worst case is NEAR_POOL peds:
//
//   far tier   628 tris/ped x 96 slots = 60,288, unchanged
//   near tier  2,256 tris/ped x 12     = 27,072 worst case
//
// against 58,431 triangles of headroom between the drive-through's 341,569 p95
// and the 400k warn. Three more scene draw calls and three more in the shadow
// pass, fixed, whatever the population is.
//
// ---------------------------------------------------------------------------
// GAIT: phase advances by distance, and the stance foot is PROVABLY planted.
// ---------------------------------------------------------------------------
// src/animfsm.js established the rule that matters: the stride phase accumulates
// with distance travelled, never with wall-clock time, so feet cannot slide.
// This file follows it and then closes the remaining gap, because it can.
//
// Driving joint ANGLES from a sine, which is what the player's rig does, only
// approximates a planted foot: the foot traces an arc while the body moves in a
// straight line, and the difference is the residual slip. So peds specify the
// FOOT TRAJECTORY instead and solve the leg backwards from it:
//
//   * Each foot is in stance for DUTY of the gait cycle and in swing for the
//     rest. Over one cycle the body advances one stride S, so during stance the
//     foot must move backward relative to the hip at exactly the rate the hip
//     moves forward: rel = DUTY*S*(0.5 - a). Because the phase advances with
//     distance (dPhase = 2*pi * v*dt / S), that cancels to ZERO world motion for
//     the stance foot - not approximately, algebraically. No slip is possible.
//   * The swing foot arcs forward with a sine lift for ground clearance.
//   * The leg is then solved by two-link IK. Thigh and shank are equal length,
//     which collapses the general solution to one acos: the thigh and shank sit
//     at +/-beta about the hip-to-foot line, beta = acos(d / legLength). The
//     knee therefore bends the way a knee bends, by construction, rather than by
//     a sign convention that has to be argued about.
//   * The hip rides a softened compass-gait curve (lowest at double support,
//     highest at mid-stance - the bob real walking has). Where the softening
//     asks the leg to reach further than it can, the FOOT rises to meet it
//     instead of the ankle stretching: that reads as heel-off, and it keeps the
//     horizontal foot position - the part slip is visible in - exact.
//
// The upshot is a walk whose contact is correct by construction at any speed,
// any leg length and any frame rate.

import * as THREE from '../vendor/three.module.min.js';

// ------------------------------------------------------------------ skeleton
// Metres, at height scale 1: a 1.70 m adult. Per-ped scale spreads the
// population over roughly 1.56-1.87 m.
//
// Bone lengths are JOINT CENTRE to JOINT CENTRE, and the capsule for a bone is
// authored so its instance pivot is the centre of its top cap. Adjacent bones
// therefore INTERPENETRATE by a cap radius at every joint instead of meeting at
// a tangent point. The first close-up of this crowd had a visible break at every
// knee, elbow, shoulder and neck for exactly that reason: two rounded ends
// touching at one point read as a body that has come apart.
const LEG_LEN = 0.838;              // hip joint -> ankle joint
// Equal segments, and _solveLeg depends on it: with THIGH === SHANK the two-link
// IK collapses to a single acos. Changing one without the other breaks the solve.
const THIGH = LEG_LEN / 2;
const SHANK = LEG_LEN / 2;
// The shank capsule's bottom cap IS the foot, so the ankle joint sits one cap
// radius above the sole and the sole lands on the pavement.
const ANKLE_H = 0.062;
const TORSO_H = 0.475;              // hip -> shoulder
const HEAD_Y = 0.56;                // hip -> head pivot; the head sinks into the
                                    // torso from here, which is what gives a neck
const HIP_X = 0.095;                // half hip width
const SHOULDER_X = 0.205;
const UPPER_ARM = 0.29;             // shoulder -> elbow
const FOREARM = 0.26;               // elbow -> wrist (the cap is the hand)

// streaming.js reports ground as groundY through heightAt(), but the pavement
// the player actually sees is drawn at groundY - 0.05 so road ribbons (+0.02)
// and zone polygons (+0.012) can stack on it without z-fighting. A ped whose
// soles sit at exactly heightAt() therefore hovers 50 mm above the pavement -
// the same trap street furniture fell into with its lamp posts. Everything this
// system puts on the ground is placed against the PAD, not against groundY.
const GROUND_PAD_DROP = 0.05;
const FOOT_SINK = GROUND_PAD_DROP + 0.005;      // sole 5 mm inside the pavement

// ---------------------------------------------------------- SHADOW SILHOUETTE
// How far the crowd's occluder is grown, in metres, for the SHADOW PASS ONLY.
//
// NOT because the crowd was missing from the shadow pass - it was not, and the
// note beside the deleted contact blob has the numbers. It is because of what a
// person is MADE OF at the shadow map's resolution. The sun's map is 2048 texels
// over a +-120 m ortho box: 0.117 m on the ground per texel (src/daynight.js).
//
//   limb capsule   2 * LIMB_R * thick   ~0.14 m   1.2 texels
//   torso                               ~0.32 m   2.7 texels
//   head                                 0.21 m   1.8 texels
//   litter bin                           0.52 m   4.4 texels
//
// and three's PCFSoftShadowMap is a bilinear tent about 3 texels across. A
// pedestrian is not one 0.32 m object, it is a torso plus four 0.14 m tubes with
// gaps between them, and mid-stride the legs are two separate 1.2-texel stripes.
// Each survives the tent at roughly a third of its opacity, which is why the
// crowd's cast shadow measured only 30.5% of the ground it falls on.
//
// Growing the occluder 0.055 m along its normal in the DEPTH pass, and only
// there, adds 0.11 m to every silhouette: a limb goes to 2.1 texels and a torso
// to 3.7. The visible body is untouched, it costs no triangle and no draw call,
// and it widens nothing else in the district.
//
// It is not a cheat at this scale either. The sun subtends 0.53 degrees, so a
// real penumbra grows 0.0093 m per metre of throw; at golden hour a 1.7 m figure
// throws 8.7 m and its true penumbra is 0.08 m, the same order as the 0.11 m this
// adds. The dilated shadow is closer to the edge the real sun draws than the hard
// one an unfiltered map would.
//
// Measured, on the same bench and the same rectangle, before and after:
//
//   cast shadow, un-dilated   30.48%   outer edge reaches 90% in 42 px of brick
//   cast shadow, 0.055 m      36.08%   ...in 35 px
//
// which is 5.6 points deeper than the un-dilated shadow and 1.1 points deeper
// than the blob and the shadow together were, with all of it now pointing away
// from the sun. tools/ground-shade.mjs --dilate a,b,c sweeps the value in one
// session; 0 in that list is also the check that this material's depthPacking
// matches what three's shadow map reads, because at 0 it must land on the
// un-dilated build's number.
const SHADOW_DILATE = 0.055;

// Base geometry sizes. Instance scale converts these to per-bone lengths, so the
// limb capsule is authored once and stretched.
const LIMB_R = 0.072, LIMB_CYL = 0.50;
const LIMB_BASE = LIMB_CYL;                // pivot -> far joint centre
const TORSO_R = 0.158, TORSO_CYL = 0.30;
const TORSO_BASE = TORSO_CYL + 2 * TORSO_R;

// ------------------------------------------------------------------ near LOD
// Tessellation. The far tier's numbers are unchanged - they are correct for the
// far pavement and they are the cheap half of the budget. The near tier's are
// chosen against the measured near-field pixel size:
//
//   a limb capsule with N radial segments presents an N-gon cross-section, so
//   its silhouette is short of the true cylinder by r*(1 - cos(pi/N)) and its
//   shading is interpolated across facets 360/N degrees wide. 6 -> 12 takes the
//   facet from 60 to 30 degrees and the silhouette error from 13.4% to 3.4% of
//   the limb radius. That is the crease the near field is showing.
const FAR_LIMB_RADIAL = 6, FAR_LIMB_CAP = 2;
const NEAR_LIMB_RADIAL = 12, NEAR_LIMB_CAP = 2;      // 60 -> 120 tris
const FAR_TORSO_RADIAL = 8, FAR_TORSO_CAP = 2;
const NEAR_TORSO_RADIAL = 16, NEAR_TORSO_CAP = 3;    // 80 -> 224 tris
const FAR_HEAD_W = 7, FAR_HEAD_H = 5;
const NEAR_HEAD_W = 16, NEAR_HEAD_H = 12;            // 56 -> 352 tris

// Extra bones the near tier can afford and the far tier cannot. A shank capsule
// whose bottom cap IS the foot reads as a peg leg at 3 m, and a forearm whose cap
// IS the hand reads as a stump; those two absences plus a missing neck and a
// missing pelvis are most of what "mannequin" means here.
const NEAR_SLOTS = 14;          // 8 bones + 2 shoes + 2 hands + neck + pelvis
const SHOE_L = 8, SHOE_R = 9, HAND_L = 10, HAND_R = 11, NECK_I = 12, PELVIS_I = 13;
const NEAR_POOL = 12;           // peds that may hold the near tier at once
const NEAR_RADIUS = 24;         // m from the camera to claim a near slot
const NEAR_RELEASE = 30;        // ...and to keep one. Hysteresis, so a ped
                                // walking the boundary does not flicker tiers.
const SHOE_LEN = 0.185, SHOE_THICK = 0.62, SHOE_DROP = 0.016, SHOE_BACK = 0.045;
// Hands were 0.92 on the first pass, which is a radius 35% wider than the
// forearm it hangs off: at 3 m that reads as a boxing glove, not a hand. 0.70
// puts the knuckles just proud of the wrist, which is what a fist does.
const HAND_LEN = 0.080, HAND_THICK = 0.70;
const NECK_LEN = 0.13, NECK_THICK = 0.60;
const PELVIS_LEN = 0.19, PELVIS_THICK = 1.80, PELVIS_THICK_Z = 1.20;
const SHOE_MUL = 0.30, NECK_MUL = 0.92;

// ------------------------------------------------------------------ crowd look
// SKIN IS AN ALBEDO HERE, NOT A SWATCH, and the first cut of this palette was a
// swatch. The tones were authored the way skin is PICKED - the colour a photo of
// a face comes out - and handed straight to a MeshStandardMaterial as diffuse
// reflectance, where they mean something else entirely.
//
//   hex        linear albedo        luminance   vs a sunlit clay paver (0.188)
//   0xefc9a6   0.863 0.584 0.381      0.629            3.34x
//   0xd8ab84   0.687 0.407 0.231      0.454            2.41x
//
// An albedo luminance of 0.63 is a sheet of white paper. Two blind reviewers
// caught the consequence at opposite ends of the day: at night "a walker's bare
// forearms sample 138,80,40 against lamp-lit brick at 45-54 - roughly 3x the
// luminance of the ground he stands on", and at golden hour the same forearms
// "blow out into two pale sticks and read as boxes he is carrying". Both are the
// same defect and neither is a lighting bug: skin does not have three times
// brick's reflectance under the same lamp.
//
// Measured human skin diffuse reflectance runs about 0.30-0.35 luminance at the
// light end and 0.04-0.05 at the deep end - a 7x spread, against this palette's
// 17x with its light end above paper. Every tone below is the SAME AUTHORED HUE
// rescaled by a scalar on its linear RGB, so the chromaticity is bit-for-bit
// what it was and only the reflectance moved:
//
//   0xd8ab84 -> 0xab8768   lum 0.454 -> 0.270   (2.41x brick -> 1.44x)
//   0xc79a72 -> 0x9f7a5a   lum 0.365 -> 0.220   (1.94x -> 1.17x)
//   0xa8734c -> 0x906240   lum 0.211 -> 0.150   (1.12x -> 0.80x)
//   0x8d5f43 -> 0x7d543b   lum 0.143 -> 0.110   (0.76x -> 0.59x)
//   0x6f4630 -> 0x6a432d   lum 0.080 -> 0.072   (0.42x -> 0.38x)
//   0x4b2f20 -> 0x513323   lum 0.036 -> 0.042   (0.19x -> 0.22x)   <- lifted
//   0xefc9a6 -> 0xb2957b   lum 0.629 -> 0.325   (3.34x -> 1.73x)
//
// The deepest tone goes UP, not down: 0.036 is darker than any skin measured and
// it was making the far end of the palette read as a silhouette rather than a
// person. The range now spans 7.7x, which is the range skin spans.
const SKIN = [0xab8768, 0x9f7a5a, 0x906240, 0x7d543b, 0x6a432d, 0x513323, 0xb2957b];
const SHIRT = [
  0x2f4a63, 0x7a3b34, 0x3d5b45, 0xb8a068, 0x2b2f38, 0x6d4e7a, 0xd9d3c6,
  0x1f6f78, 0xa8562f, 0x39434f, 0x8f9aa6, 0x5c2f3a,
];
const PANTS = [0x22262c, 0x3a3f4a, 0x5a4636, 0x2e3b30, 0x4a4f58, 0x1b2733, 0x6b6152];
const HAIR_MUL = 0.28;              // hair = skin tone x this, baked as vertex colour

// ------------------------------------------------------------------ gait
const DUTY = 0.62;              // fraction of the cycle each foot is on the ground
const STRIDE_K = 1.52;          // stride per cycle, as a multiple of leg length
const SWING_LIFT = 0.075;       // foot clearance at mid-swing, m
const BOB_FRACTION = 0.86;       // how much of the compass-gait hip drop to keep
const REACH = 0.985;            // usable leg length; knees never lock straight
const ARM_AMP = 0.34;           // shoulder swing at full walking speed, rad
const GAIT_FADE = 0.35;         // below this speed (m/s) the gait folds away

// ------------------------------------------------------------------ behaviour
const WALK_MIN = 1.1, WALK_MAX = 1.6;      // m/s, per the brief
const MAX_TURN = 2.6;                      // rad/s - corners get turned, not snapped
const ARRIVE = 1.1;                        // waypoint capture radius, m
const SEP_RADIUS = 1.25;                   // personal space, m
const SEP_CELL = 2.0;                      // neighbour hash cell, m
// Two separation thresholds, because one number cannot answer both questions.
// CLOSE_PASS is shoulder width: people brush past each other in a real crowd and
// a system that never gets this close is a system whose peds are on rails.
// BODY_OVERLAP is two torso radii: getting inside THAT is walking through
// someone, and it is the number that must stay at zero.
const OVERLAP_DIST = 0.55;
const BODY_OVERLAP = 0.34;
const BUILDING_MARGIN = 0.28;              // keep this far off a wall
const STUCK_TURN_S = 2.5;                  // blocked this long -> turn around
const STUCK_DESPAWN_S = 7.0;               // still blocked -> give the slot back
const SPAWN_SLOTS_PER_FRAME = 20;          // bounded refill work per frame
const SPAWN_TRIES = 6;                     // attempts per slot

// Candidate sidewalk insets outward from the kerb, widest first. The kerb is at
// half the baked street width; street lamps stand at +1.4 (district/main.js), so
// 1.9 puts peds behind the lamp line against the shopfronts and 0.8 puts them at
// the kerb edge. Whichever is clear of the buildings on that side wins.
const INSETS = [1.9, 1.45, 1.05, 0.8];
const BLOCKED_TOLERANCE = 0.15;            // fraction of samples allowed to clip

const TAU = Math.PI * 2;

function pick(list) { return list[(Math.random() * list.length) | 0]; }

export class Pedestrians {
  constructor(scene, district, opts = {}) {
    this.d = district;
    this.count = opts.count ?? 72;
    this.ground = opts.ground ?? null;               // StreamingWorld: heightAt(x, z)
    this.despawnRadius = opts.despawnRadius ?? 140;
    this.spawnMin = opts.spawnMin ?? 18;
    this.spawnMax = opts.spawnMax ?? 100;
    this.overlapDistance = opts.overlapDistance ?? OVERLAP_DIST;
    this.avoidPlayer = opts.avoidPlayer ?? true;

    this._buildAdjacency();
    this._buildBuildingIndex();

    // --- geometry, authored so the instance matrix pivot is the JOINT CENTRE.
    // The capsule keeps a cap radius of material above its pivot and below its
    // far end, which is what makes neighbouring bones overlap at the joint.
    const limbGeo = new THREE.CapsuleGeometry(LIMB_R, LIMB_CYL, FAR_LIMB_CAP, FAR_LIMB_RADIAL);
    limbGeo.translate(0, -LIMB_CYL / 2, 0);

    const torsoGeo = new THREE.CapsuleGeometry(TORSO_R, TORSO_CYL, FAR_TORSO_CAP, FAR_TORSO_RADIAL);
    torsoGeo.translate(0, TORSO_CYL / 2 + TORSO_R, 0);        // pivot at the hips
    torsoGeo.scale(1, 1, 0.72);                               // chests are not round

    const headGeo = Pedestrians._headGeometry(FAR_HEAD_W, FAR_HEAD_H, false);

    // --- the near tier. Same authoring, same pivots, same conventions - only the
    // tessellation and the vertex shading differ, so _writePose can drive either
    // one from the same skeleton without a second set of rules to keep in step.
    const nearLimbGeo = new THREE.CapsuleGeometry(LIMB_R, LIMB_CYL, NEAR_LIMB_CAP, NEAR_LIMB_RADIAL);
    nearLimbGeo.translate(0, -LIMB_CYL / 2, 0);
    Pedestrians._shadeLimb(nearLimbGeo);

    const nearTorsoGeo = new THREE.CapsuleGeometry(TORSO_R, TORSO_CYL, NEAR_TORSO_CAP, NEAR_TORSO_RADIAL);
    nearTorsoGeo.translate(0, TORSO_CYL / 2 + TORSO_R, 0);
    nearTorsoGeo.scale(1, 1, 0.72);
    Pedestrians._shadeTorso(nearTorsoGeo);

    const nearHeadGeo = Pedestrians._headGeometry(NEAR_HEAD_W, NEAR_HEAD_H, true);

    // THE CONTACT BLOB IS GONE, and the reason is not the one the comment it
    // replaces gave.
    //
    // What stood here read: "The sun's shadow map is 2048 texels over a 520 m
    // ortho box: 0.25 m per texel. A pedestrian is about 1.5 texels wide, so the
    // real shadow pass cannot resolve one however correctly it is set up." That
    // was true when it was written and has not been true since: src/daynight.js
    // traded the ortho extent for resolution and runs 2048 over +-120 m, which is
    // 0.117 m per texel, and its own note says so - "a pedestrian is now ~4.3
    // texels and a bollard ~1.3". The stand-in outlived the problem it stood in
    // for, and this file was the only system in the district still carrying one.
    //
    // MEASURED. tools/ground-shade.mjs teleports one pedestrian to a fixed slot on
    // sunlit brick, poses it mid-stride in the far tier, and captures the frame
    // with and without it; tools/ground-shade-rect.mjs reads the pair through one
    // rectangle laid on the shadow's own plateau, 0.4 m screen-left of the feet
    // and clear of the figure's trousers. Noon, Main St east, crowd pinned at 96:
    //
    //                                       ground darkening   noise
    //   blob + body, as it shipped               34.96%        0.05%
    //   body alone, blob switched off            30.48%
    //   body alone, this build (no blob)         36.08%        1.69%
    //   control rectangle 4 m away                0.00%
    //
    // So the crowd was NEVER outside the shadow pass. It has carried castShadow on
    // all six body meshes the whole time, and it lands a real 30% cast shadow on
    // the brick. What the blob added was 4.5 points of that number with no
    // direction in it at all - a CircleGeometry fan 0.80 x 0.68 m, black at alpha
    // 0.7 at the ONE centre vertex and alpha 0 at every rim vertex, so its mean
    // alpha over the disc is 0.7/3 = 0.23 - laid on top of a scene-wide SSAO pass
    // (src/post.js, radius 2.2 m, strength 0.95) that already darkens the ground
    // around anything standing on it. Two blind reviewers read the pair together as
    // "3-12%, across a soft fan roughly six times his body width, with no edge and
    // no direction". 2.2 m of AO radius against a 0.4 m body IS six times his body
    // width: what they were describing is an ambient term counted twice, sitting
    // where a shadow's edge should be, and they were right to refuse to call it a
    // shadow.
    //
    // Deleting it costs one draw call and 12 triangles per ped and returns the
    // contact to the two systems that own it: the sun's shadow map for the
    // direction and the AO pass for the ambient. SHADOW_DILATE then buys back more
    // than the blob was contributing - 30.48% -> 36.08%, and a shadow edge that
    // reaches 90% of its depth in 35 px of brick instead of 42.

    const cloth = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0 });
    // The near tier's cloth reads a vertex colour as well as the instance colour,
    // which is what pays for a collar, a hem and joint occlusion without a single
    // extra triangle. The FAR cloth must stay vertexColors:false - its geometry
    // carries no colour attribute, and in this three build a material that
    // declares USE_COLOR without one gets the default generic attribute (0,0,0)
    // and renders the whole crowd black. That was measured, not assumed:
    // tools/ped-audit.mjs forces exactly that and captures it.
    const nearCloth = new THREE.MeshStandardMaterial({
      roughness: 0.86, metalness: 0, vertexColors: true,
    });
    const skin = new THREE.MeshStandardMaterial({
      roughness: 0.74, metalness: 0, vertexColors: true,
    });
    this.materials = [cloth, nearCloth, skin];

    this.root = new THREE.Group();
    this.root.name = 'pedestrians';
    scene.add(this.root);

    this.torsos = this._instanced(torsoGeo, cloth, this.count);
    this.heads = this._instanced(headGeo, skin, this.count);
    this.limbs = this._instanced(limbGeo, cloth, this.count * 8);

    this.nearPool = Math.min(NEAR_POOL, this.count);
    this._nearDefault = this.nearPool;
    this.nearTorsos = this._instanced(nearTorsoGeo, nearCloth, this.nearPool);
    this.nearHeads = this._instanced(nearHeadGeo, skin, this.nearPool);
    this.nearLimbs = this._instanced(nearLimbGeo, nearCloth, this.nearPool * NEAR_SLOTS);
    // Allocate the instance-colour buffers at FULL pool size before count drops.
    // setColorAt() sizes instanceColor from mesh.count on first use, so a first
    // write while count is 0 allocates a zero-length Float32Array and every
    // colour after that is silently dropped out of bounds.
    {
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < this.nearPool; i++) {
        this.nearTorsos.setColorAt(i, white); this.nearHeads.setColorAt(i, white);
      }
      for (let i = 0; i < this.nearPool * NEAR_SLOTS; i++) this.nearLimbs.setColorAt(i, white);
    }
    // Every body mesh casts through the dilated depth material. One material for
    // all six: they are all instanced and all FrontSide, so they compile to one
    // program and three's per-object side fix-up cannot make them disagree.
    this.depthMaterial = Pedestrians._dilatedDepthMaterial(SHADOW_DILATE);
    for (const m of [this.torsos, this.heads, this.limbs,
      this.nearTorsos, this.nearHeads, this.nearLimbs]) {
      m.customDepthMaterial = this.depthMaterial;
    }

    // Nothing is claiming a near slot yet, and an InstancedMesh with count 0 is
    // skipped by the renderer entirely - no draw call, no triangles.
    this.nearTorsos.count = 0; this.nearHeads.count = 0; this.nearLimbs.count = 0;
    this._nearLive = 0;

    // Which camera? The crowd's update() is handed the FOCUS point (the player or
    // the car), and at the hero framings the camera stands 26-34 m behind it, so
    // a focus-relative near test classifies every ped in the frame as far. The
    // camera arrives here instead, one frame stale, which for an LOD selection is
    // no latency at all. Guarded on isPerspectiveCamera so the sun's orthographic
    // shadow camera cannot be mistaken for the player's.
    this.torsos.onBeforeRender = (_r, _s, cam) => {
      if (cam && cam.isPerspectiveCamera) {
        this._camX = cam.position.x; this._camZ = cam.position.z; this._camSeen = true;
      }
    };

    // --- state
    this.peds = new Array(this.count).fill(null);
    this._shown = new Uint8Array(this.count);
    // Which near-pool slot each ped holds, or -1. Packed 0..nearLive-1 so the
    // near meshes can submit exactly the instances that are in use.
    this._nearSlot = new Int16Array(this.count).fill(-1);
    // NOT _nearKey / _nearPick: _edgesNear() already owns this._nearKey and
    // stores a CHUNK KEY STRING in it. Shadowing it made _assignNearLod write
    // key[j] into "0,-1" and throw on every frame.
    this._lodPick = new Int16Array(this.nearPool);
    this._lodKey = new Float32Array(this.nearPool);
    this._nearColorDirty = false;
    this._camX = 0; this._camZ = 0; this._camSeen = false;
    this.aliveCount = 0;
    this._nextId = 0;
    this._walks = new Map();          // edge*2+side -> baked sidewalk polyline
    this._hash = new Map();           // neighbour hash, rebuilt each frame
    this._colorDirty = true;

    // Scratch, reused every frame: this loop runs count*10 times a frame and has
    // no business allocating.
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._qx = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._col = new THREE.Color();
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._axisX = new THREE.Vector3(1, 0, 0);
    this._tipOut = [0, 0, 0];
    this._fL = { rel: 0, y: 0, stance: true };
    this._fR = { rel: 0, y: 0, stance: true };
    this._legs = [0, 0, 0, 0];        // thighL, shankL, thighR, shankR
    this._focus = { x: 0, z: 0 };
    this._tgt = { x: 0, z: 0 };

    this.stats = {
      spawns: 0, despawns: 0, spawnFailures: 0, frames: 0, pedFrames: 0,
      corners: 0, deadEndTurns: 0, uTurnsWhenStuck: 0, stuckDespawns: 0,
      buildingPushes: 0, avoidBrakeFrames: 0, orphanPedFrames: 0,
      overlapFrames: 0, bodyOverlapFrames: 0, closestApproachM: Infinity,
      sidewalksBaked: 0, sidewalksRejected: 0,
    };
    this._minHist = new Array(6).fill(0);   // closest pair per frame, 0.25 m buckets
  }

  _instanced(geo, mat, n) {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Everything this file draws is a body, and every body casts and receives.
    // The `shadow` parameter that used to sit here existed for one caller, the
    // contact blob, and went with it.
    m.castShadow = true;
    m.receiveShadow = true;
    // The crowd is spread over a 140 m radius around the player and its instance
    // bounding sphere is the geometry's, not the crowd's; culling it would hide
    // everyone. Same reasoning as traffic.js and streetfurniture.js.
    m.frustumCulled = false;
    for (let i = 0; i < n; i++) m.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    this.root.add(m);
    return m;
  }

  /**
   * A depth material that inflates along the vertex normal, so the shadow map
   * sees a silhouette SHADOW_DILATE metres wider than the body. See the note on
   * SHADOW_DILATE for why the crowd needs one and nothing else in the district
   * does.
   *
   * Object space, not world: every instance matrix in this file scales by 0.68
   * to 1.05 laterally (see _bone), so the world dilation lands within a third of
   * the nominal figure everywhere, which is well inside the tolerance of a
   * quantity whose job is "more than one shadow texel".
   *
   * customProgramCacheKey is not decoration. three keys compiled programs by
   * material type plus defines, and two MeshDepthMaterials that differ only in
   * an injected uniform would otherwise share one program.
   */
  static _dilatedDepthMaterial(metres) {
    // depthPacking must match what three's own shadow depth material writes, or
    // the map is filled in one encoding and read in another. Read out of the
    // vendored build rather than remembered: three.module.min.js constructs its
    // shadow depth material with `depthPacking: Ee`, and its import list has
    // `RGBADepthPacking as Ee` (= 3201). Checked at runtime as well: `node tools/ground-shade.mjs --dilate 0,...` measures the crowd's
    // ground darkening with this material installed and the inflation turned OFF,
    // where it must land on the number the un-dilated build gives through three's
    // own depth material. A packing mismatch cannot survive that comparison.
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    const u = { value: metres };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uInflate = u;
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'uniform float uInflate;\nvoid main() {')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n\ttransformed += normalize( normal ) * uInflate;');
    };
    m.customProgramCacheKey = () => 'pedDilatedDepth';
    m.userData.inflate = u;
    return m;
  }

  // ------------------------------------------------------- geometry authoring
  // A head, at either tessellation, with its hair painted as a vertex colour so
  // it costs no draw call and no triangle.
  //
  // The far tier's hairline is a single latitude threshold: every vertex above
  // y = 0.018 is hair. On a 5-ring sphere that lands the boundary at a very high
  // ring and paints roughly the top 55% of the skull at HAIR_MUL, which at 8 m
  // reads as a dark egg rather than as a person with hair. The near tier gets a
  // hairline that is a function of height AND of how far forward a vertex faces,
  // which is what a hairline actually is: high at the brow, low at the nape.
  static _headGeometry(w, h, detailed) {
    const g = new THREE.SphereGeometry(0.105, w, h);
    g.scale(1, 1.14, 0.95);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const step = (a, b, x) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < p.count; i++) {
      let shade;
      if (!detailed) {
        shade = p.getY(i) > 0.018 ? HAIR_MUL : 1;
      } else {
        const ny = p.getY(i) / (0.105 * 1.14);
        const nz = p.getZ(i) / (0.105 * 0.95);      // +Z is the direction of travel
        // Hair where ny - 0.325*nz clears about -0.13, smoothed - because a hard
        // threshold on a lathe sphere is a jagged ring of facet corners. Solving
        // that for the two points a hairline is actually defined by puts the
        // front hairline at ny = 0.20 (just above the brow) and the back one at
        // ny = -0.45 (the nape).
        //
        // The first cut of this used ny - 0.45*nz over the band [0.02, 0.20],
        // which puts the FRONT hairline at ny = 0.47 - the top quarter of the
        // skull. Analytically it looked right, because the check only asked what
        // the crown and the back were; from the front the ped renders BALD, and
        // that is how it shipped into the first hero frame. Look at the thing
        // from the side the change is supposed to fix.
        const hair = step(-0.24, -0.02, ny - 0.325 * nz);
        shade = 1 + (HAIR_MUL - 1) * hair;
        // A brow shadow, and the shadow a jaw casts on its own neck. Both are
        // pure shading - the "normal detail without geometry" half of the
        // near-field budget - and the brow window peaks at ny = 0.02, below the
        // hairline rather than inside it.
        if (nz > 0.45) shade *= 1 - 0.14 * step(-0.18, 0.02, ny) * step(0.22, 0.02, ny);
        shade *= 1 - 0.28 * step(-0.45, -0.88, ny);
      }
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // The head centre sits well above its pivot so the skull sinks into the top
    // of the torso capsule: overlap, not tangency, is what reads as a neck.
    g.translate(0, 0.125, 0);
    return g;
  }

  // Joint occlusion on a bone, as a vertex colour. Every near-tier bone shares
  // this one capsule - thigh, shank, arm, forearm, shoe, hand, neck and pelvis -
  // so the shading has to be true of all of them: darker where the bone plugs
  // into its parent, slightly darker at its far cap, plain along the shaft.
  static _shadeLimb(g) {
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const top = LIMB_R, span = LIMB_CYL + 2 * LIMB_R;
    for (let i = 0; i < p.count; i++) {
      const t = (top - p.getY(i)) / span;             // 0 at the pivot, 1 at the tip
      let shade = 1;
      if (t < 0.14) shade = 0.80 + (t / 0.14) * 0.20;
      else if (t > 0.90) shade = 1 - ((t - 0.90) / 0.10) * 0.12;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  // The same idea on the torso: a neckline, a hem where the shirt falls over the
  // trousers, and the value break under the arms that stops the upper body
  // reading as one blob when the arms hang close to it.
  static _shadeTorso(g) {
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const v = p.getY(i) / TORSO_BASE;                // 0 at the hips, 1 at the neck
      const ax = Math.abs(p.getX(i)) / TORSO_R;
      let shade = 0.93 + 0.07 * v;
      if (v > 0.90) shade *= 0.82;                    // collar
      if (v < 0.14) shade *= 0.80;                    // hem over the waistband
      if (v > 0.55 && v < 0.90) shade *= 1 - 0.14 * Math.max(0, (ax - 0.55) / 0.45);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  // ---------------------------------------------------------------- near LOD
  /**
   * Harness hook. 0 disables the near tier (which is exactly the geometry that
   * shipped before it existed, so it is the honest "before" arm of a paired
   * measurement); a negative value restores the default pool.
   */
  setNearLod(n) {
    this.nearPool = n < 0 ? this._nearDefault
      : Math.max(0, Math.min(this._nearDefault, n | 0));
    return this.nearPool;
  }

  // Choose the peds that hold the near tier this frame: the nearest `nearPool`
  // within NEAR_RADIUS of the CAMERA, with hysteresis out to NEAR_RELEASE so a
  // ped walking the boundary does not swap tiers every frame.
  //
  // Selection is a fixed-size insertion sort over at most nearPool entries, so
  // it allocates nothing and costs count*nearPool comparisons in the worst case.
  _assignNearLod(fx, fz) {
    const prev = this._nearSlot;
    if (!this.nearPool) {
      for (let i = 0; i < this.count; i++) prev[i] = -1;
      this._nearLive = 0;
      return;
    }
    // Before the first render there is no camera; the focus point is the best
    // available stand-in and it is right in gameplay, where the chase camera is
    // a few metres behind it.
    const cx = this._camSeen ? this._camX : fx;
    const cz = this._camSeen ? this._camZ : fz;
    const idx = this._lodPick, key = this._lodKey;
    const pool = this.nearPool;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.peds[i];
      if (!p) { prev[i] = -1; continue; }
      const d = Math.hypot(p.x - cx, p.z - cz);
      const held = prev[i] >= 0;
      if (d > (held ? NEAR_RELEASE : NEAR_RADIUS)) { prev[i] = -1; continue; }
      const k = held ? d - (NEAR_RELEASE - NEAR_RADIUS) : d;
      prev[i] = -1;
      if (n < pool) {
        let j = n++;
        while (j > 0 && key[j - 1] > k) { key[j] = key[j - 1]; idx[j] = idx[j - 1]; j--; }
        key[j] = k; idx[j] = i;
      } else if (k < key[n - 1]) {
        let j = n - 1;
        while (j > 0 && key[j - 1] > k) { key[j] = key[j - 1]; idx[j] = idx[j - 1]; j--; }
        key[j] = k; idx[j] = i;
      }
    }
    for (let s = 0; s < n; s++) {
      prev[idx[s]] = s;
      this._writeNearColors(s, this.peds[idx[s]]);
    }
    this._nearLive = n;
  }

  // Submit exactly the near instances that are in use. three.js skips an
  // InstancedMesh whose count is 0 before it issues the draw, so an empty near
  // tier costs no call and no triangle at all. Separate from update() because
  // the measurement harness poses a frozen ped by hand and needs the same step.
  _syncNearCounts() {
    this.nearTorsos.count = this._nearLive;
    this.nearHeads.count = this._nearLive;
    this.nearLimbs.count = this._nearLive * NEAR_SLOTS;
    if (this._nearLive) {
      this.nearTorsos.instanceMatrix.needsUpdate = true;
      this.nearHeads.instanceMatrix.needsUpdate = true;
      this.nearLimbs.instanceMatrix.needsUpdate = true;
    }
  }

  _writeNearColors(ns, ped) {
    const c = this._col;
    c.setHex(ped.shirt); this.nearTorsos.setColorAt(ns, c);
    c.setHex(ped.skin); this.nearHeads.setColorAt(ns, c);
    const b = ns * NEAR_SLOTS;
    const L = this.nearLimbs;
    c.setHex(ped.pants);
    L.setColorAt(b + 0, c); L.setColorAt(b + 2, c); L.setColorAt(b + PELVIS_I, c);
    c.setHex(ped.pants).multiplyScalar(0.62);
    L.setColorAt(b + 1, c); L.setColorAt(b + 3, c);
    c.setHex(ped.pants).multiplyScalar(SHOE_MUL);
    L.setColorAt(b + SHOE_L, c); L.setColorAt(b + SHOE_R, c);
    c.setHex(ped.shirt).multiplyScalar(0.84);
    L.setColorAt(b + 4, c); L.setColorAt(b + 6, c);
    if (ped.bare) c.setHex(ped.skin); else c.setHex(ped.shirt).multiplyScalar(0.78);
    L.setColorAt(b + 5, c); L.setColorAt(b + 7, c);
    c.setHex(ped.skin);
    L.setColorAt(b + HAND_L, c); L.setColorAt(b + HAND_R, c);
    c.setHex(ped.skin).multiplyScalar(NECK_MUL);
    L.setColorAt(b + NECK_I, c);
    this._nearColorDirty = true;
  }

  // ------------------------------------------------------------------ graph
  // Adjacency for people, not cars. One-way restrictions (edge.o) are deliberately
  // ignored: a one-way street still has two pavements and people walk both ways
  // along both of them. Service alleys (r > 6) are excluded - they are the strips
  // between buildings, where a "sidewalk" offset has nowhere to go.
  _buildAdjacency() {
    this.out = new Map();
    const add = (v, e, forward) => {
      if (!this.out.has(v)) this.out.set(v, []);
      this.out.get(v).push({ e, forward });
    };
    this._lenCache = new Map();
    this.walkableEdges = [];
    this.d.edges.forEach((e, i) => {
      if (e.r > 6) return;
      this.walkableEdges.push(i);
      add(e.v[0], i, true);
      add(e.v[e.v.length - 1], i, false);
    });
    this.spawnable = this.walkableEdges.filter((i) => this._len(i) > 18);
    this._spawnSet = new Set(this.spawnable);
    this._nearKey = null;
    this._nearEdges = this.spawnable;
  }

  // Walkable edges in the chunks around a point.
  //
  // Traffic can sample the whole district at random because it spawns out to
  // 340 m; peds spawn inside 100 m, where a random draw from all 405 spawnable
  // edges lands in range about 3% of the time. Measured: 24 attempts produced
  // ZERO pedestrians and an empty pavement. The baked chunk index already lists
  // the edges per 128 m cell, so sample from the 3x3 block around the player and
  // the hit rate becomes the useful one. Cached until the player changes chunk.
  _edgesNear(x, z) {
    const cs = this.d.meta.chunkSize;
    const cx = Math.floor(x / cs), cz = Math.floor(z / cs);
    const key = `${cx},${cz}`;
    if (this._nearKey === key) return this._nearEdges;
    const span = Math.max(1, Math.ceil(this.spawnMax / cs));
    const seen = new Set();
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const c = this.d.chunks[`${cx + dx},${cz + dz}`];
        if (!c) continue;
        for (const ei of c.edges) if (this._spawnSet.has(ei)) seen.add(ei);
      }
    }
    this._nearKey = key;
    // Off the edge of the mapped area there may be nothing local; fall back to
    // the district-wide list rather than stopping the crowd dead.
    this._nearEdges = seen.size ? [...seen] : this.spawnable;
    return this._nearEdges;
  }

  _len(i) {
    if (this._lenCache.has(i)) return this._lenCache.get(i);
    const e = this.d.edges[i];
    let l = 0;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = this.d.verts[e.v[k]], b = this.d.verts[e.v[k + 1]];
      l += Math.hypot(b.x - a.x, b.z - a.z);
    }
    this._lenCache.set(i, l);
    return l;
  }

  // ------------------------------------------------------- building avoidance
  // A uniform grid over the footprints. Peds test against the real polygon, not
  // the bounding box: OSM footprints are L-shaped and courtyarded often enough
  // that a box test would push people into the roadway on 12% of edge-sides.
  _buildBuildingIndex() {
    this.BCELL = 64;
    this._bgrid = new Map();
    this._bboxes = [];
    this.d.buildings.forEach((b, i) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of b.p) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      this._bboxes.push({ x0, x1, z0, z1, ring: b.p });
      for (let cx = Math.floor(x0 / this.BCELL); cx <= Math.floor(x1 / this.BCELL); cx++) {
        for (let cz = Math.floor(z0 / this.BCELL); cz <= Math.floor(z1 / this.BCELL); cz++) {
          const k = this._cellKey(cx, cz);
          if (!this._bgrid.has(k)) this._bgrid.set(k, []);
          this._bgrid.get(k).push(i);
        }
      }
    });
  }

  _cellKey(cx, cz) { return (cx + 4096) * 8192 + (cz + 4096); }

  _bucketAt(x, z) {
    return this._bgrid.get(this._cellKey(Math.floor(x / this.BCELL), Math.floor(z / this.BCELL)));
  }

  static _pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Squared distance from a point to a ring's boundary, plus the closest point.
  static _distToRing(x, z, ring, out) {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = ring[j][0], az = ring[j][1], bx = ring[i][0], bz = ring[i][1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t, pz = az + dz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < best) { best = d2; if (out) { out.x = px; out.z = pz; } }
    }
    return best;
  }

  // Is this point inside a building, or within `margin` of one?
  _blocked(x, z, margin) {
    const list = this._bucketAt(x, z);
    if (!list) return false;
    for (const i of list) {
      const b = this._bboxes[i];
      if (x < b.x0 - margin || x > b.x1 + margin || z < b.z0 - margin || z > b.z1 + margin) continue;
      if (Pedestrians._pointInRing(x, z, b.ring)) return true;
      if (margin > 0 && Pedestrians._distToRing(x, z, b.ring, null) < margin * margin) return true;
    }
    return false;
  }

  // Shove a ped that has ended up inside a wall out to the nearest facade. The
  // baked sidewalk offsets keep this rare; corner-cutting at junctions is what
  // still triggers it, and "rare" is not "never".
  _pushOut(ped) {
    const list = this._bucketAt(ped.x, ped.z);
    if (!list) return false;
    for (const i of list) {
      const b = this._bboxes[i];
      if (ped.x < b.x0 || ped.x > b.x1 || ped.z < b.z0 || ped.z > b.z1) continue;
      if (!Pedestrians._pointInRing(ped.x, ped.z, b.ring)) continue;
      const p = { x: 0, z: 0 };
      Pedestrians._distToRing(ped.x, ped.z, b.ring, p);
      let ox = p.x - ped.x, oz = p.z - ped.z;
      const l = Math.hypot(ox, oz);
      if (l < 1e-4) { ox = 1; oz = 0; } else { ox /= l; oz /= l; }
      ped.x = p.x + ox * BUILDING_MARGIN;
      ped.z = p.z + oz * BUILDING_MARGIN;
      this.stats.buildingPushes++;
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------- sidewalk bake
  // The sidewalk for (edge, side) is the street centreline pushed sideways by
  // half the baked width plus an inset. The widest inset whose samples clear the
  // buildings on that side wins; if even the tightest is mostly inside a
  // building, that pavement does not exist and nobody is routed onto it.
  //
  // Baked lazily and cached: 582 walkable edges x 2 sides is 1164 possible
  // pavements, and a session touches a fraction of them. Doing it all at load
  // would be a startup stall for nothing.
  _walk(ei, side) {
    const key = ei * 2 + side;
    if (this._walks.has(key)) return this._walks.get(key);
    const e = this.d.edges[ei];
    const base = [];
    for (const vi of e.v) {
      const v = this.d.verts[vi];
      const last = base[base.length - 1];
      if (last && Math.abs(last.x - v.x) < 1e-4 && Math.abs(last.z - v.z) < 1e-4) continue;
      base.push({ x: v.x, z: v.z });
    }
    let best = null;
    if (base.length >= 2) {
      for (const inset of INSETS) {
        const pts = this._offsetPolyline(base, (e.w / 2 + inset) * (side ? -1 : 1));
        const blocked = this._blockedFraction(pts);
        if (!best || blocked < best.blocked) best = { pts, blocked, inset };
        if (blocked === 0) break;
      }
    }
    const walk = best && best.blocked <= BLOCKED_TOLERANCE
      ? { pts: best.pts, inset: best.inset } : null;
    this._walks.set(key, walk);
    if (walk) this.stats.sidewalksBaked++; else this.stats.sidewalksRejected++;
    return walk;
  }

  // Mitred offset: each vertex moves along the bisector of its two segment
  // normals, so the pavement stays parallel to the kerb through a bend instead
  // of pinching in and cutting the corner off.
  _offsetPolyline(base, off) {
    const n = base.length;
    const seg = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = base[i + 1].x - base[i].x, dz = base[i + 1].z - base[i].z;
      const l = Math.hypot(dx, dz) || 1;
      seg.push({ nx: -dz / l, nz: dx / l });
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = seg[Math.max(0, i - 1)], b = seg[Math.min(seg.length - 1, i)];
      let nx = a.nx + b.nx, nz = a.nz + b.nz;
      const l = Math.hypot(nx, nz);
      if (l < 1e-4) { nx = b.nx; nz = b.nz; } else { nx /= l; nz /= l; }
      const cos = Math.max(0.4, nx * b.nx + nz * b.nz);
      const k = Math.min(2.4, 1 / cos) * off;
      out.push({ x: base[i].x + nx * k, z: base[i].z + nz * k });
    }
    return out;
  }

  _blockedFraction(pts) {
    let total = 0, bad = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(l / 4));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps;
        total++;
        if (this._blocked(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, BUILDING_MARGIN)) bad++;
      }
    }
    return total ? bad / total : 1;
  }

  _endVertex(ei, forward) {
    const e = this.d.edges[ei];
    return forward ? e.v[e.v.length - 1] : e.v[0];
  }

  // Waypoint `k` of a traversal, in travel order.
  _node(ped, k) {
    return Pedestrians._at(ped.walk, ped.forward, k);
  }

  _nodeCount(ped) { return ped.walk.pts.length; }

  // ---------------------------------------------------------------- routing
  // At a junction, pick the next pavement. Two things decide it: keep going
  // roughly straight, and stay on the SAME CORNER - the candidate whose first
  // waypoint is nearest is the one that does not require crossing the road we
  // just walked along. That is what turns peds around corners instead of
  // marching them over the carriageway, and it is why side is chosen here rather
  // than carried over.
  _chooseNext(ped) {
    const v = this._endVertex(ped.edge, ped.forward);
    const opts = this.out.get(v) ?? [];
    const here = this._node(ped, this._nodeCount(ped) - 1) ?? { x: ped.x, z: ped.z };
    const fx = Math.sin(ped.yaw), fz = Math.cos(ped.yaw);

    let best = null, bestScore = -Infinity;
    for (const o of opts) {
      const straightBack = o.e === ped.edge && o.forward !== ped.forward;
      for (let side = 0; side < 2; side++) {
        const walk = this._walk(o.e, side);
        if (!walk || walk.pts.length < 2) continue;
        const q = o.forward ? walk.pts[0] : walk.pts[walk.pts.length - 1];
        const corner = Math.hypot(q.x - here.x, q.z - here.z);
        // Anything this far away is on the far pavement across the road.
        if (corner > 16) continue;
        const q2 = o.forward ? walk.pts[1] : walk.pts[walk.pts.length - 2];
        const dx = q2.x - q.x, dz = q2.z - q.z;
        const l = Math.hypot(dx, dz) || 1;
        const straight = fx * (dx / l) + fz * (dz / l);
        const score = straight * 0.9 - corner * 0.32 + Math.random() * 0.55
          - (straightBack ? 1.6 : 0);
        if (score > bestScore) { bestScore = score; best = { e: o.e, forward: o.forward, side }; }
      }
    }
    if (best) return best;
    // Dead end, or every continuation is across the road: about-face on the
    // pavement we are already standing on and walk back out. Peds must never
    // simply stop existing at a cul-de-sac.
    this.stats.deadEndTurns++;
    return { e: ped.edge, forward: !ped.forward, side: ped.side, uTurn: true };
  }

  _enter(ped, next) {
    const walk = this._walk(next.e, next.side);
    if (!walk) return false;
    ped.edge = next.e;
    ped.forward = next.forward;
    ped.side = next.side;
    ped.walk = walk;
    ped.node = 0;
    ped.lateral = this._laneOf(ped);
    return true;
  }

  // Personal lane across the width of the pavement.
  //
  // Every ped on a given (edge, side) follows the SAME baked polyline, and the
  // first hero shot showed the result: a conga line hugging the kerb, one
  // pedestrian deep. Displacing each ped sideways by its own fixed amount
  // spreads the crowd over the pavement instead.
  //
  // The displacement always points AWAY from the carriageway (the same sign the
  // sidewalk itself was offset by), so nobody can be nudged into the road; the
  // building side is covered by _pushOut. Peds walking the two directions take
  // separate bands, which is both what people do and what stops head-on pairs
  // from having to resolve every meeting through avoidance alone.
  _laneOf(ped) {
    const away = ped.side ? -1 : 1;
    const band = ped.forward ? ped.laneJitter * 0.42 : 0.48 + ped.laneJitter * 0.42;
    return away * band;
  }

  // The waypoint a ped is actually steering for: the polyline node pushed into
  // that ped's lane, perpendicular to the direction of travel there.
  _targetAt(ped, k, out) {
    const p = this._node(ped, k);
    if (!p) return null;
    const n = this._nodeCount(ped);
    const a = k > 0 ? this._node(ped, k - 1) : p;
    const b = k > 0 ? p : this._node(ped, Math.min(1, n - 1));
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) { out.x = p.x; out.z = p.z; return out; }
    out.x = p.x + (-dz / l) * ped.lateral;
    out.z = p.z + (dx / l) * ped.lateral;
    return out;
  }

  // ---------------------------------------------------------------- spawning
  _appearance(ped) {
    ped.skin = pick(SKIN);
    ped.shirt = pick(SHIRT);
    ped.pants = pick(PANTS);
    ped.bare = Math.random() < 0.45;       // short sleeves -> forearms are skin
    ped.hscale = 0.92 + Math.random() * 0.18;
    ped.build = 0.86 + Math.random() * 0.32;
    ped.desired = WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN);
    ped.laneJitter = Math.random();
  }

  // Waypoint `k` of a walk in TRAVEL order, which is the polyline forwards or
  // backwards depending on which way the ped is going along it.
  static _at(walk, forward, k) {
    return forward ? walk.pts[k] : walk.pts[walk.pts.length - 1 - k];
  }

  _spawn(i, focus, budget) {
    const pool = this._edgesNear(focus.x, focus.z);
    if (!pool.length) { this.stats.spawnFailures++; return false; }
    for (let a = 0; a < budget; a++) {
      const ei = pool[(Math.random() * pool.length) | 0];
      const side = Math.random() < 0.5 ? 0 : 1;
      const walk = this._walk(ei, side);
      if (!walk || walk.pts.length < 2) continue;
      const forward = Math.random() < 0.5;
      const k = 1 + ((Math.random() * (walk.pts.length - 1)) | 0);
      const from = Pedestrians._at(walk, forward, k - 1);
      const to = Pedestrians._at(walk, forward, k);
      const f = Math.random();
      const x = from.x + (to.x - from.x) * f, z = from.z + (to.z - from.z) * f;

      const dist = Math.hypot(x - focus.x, z - focus.z);
      if (dist < this.spawnMin || dist > this.spawnMax) continue;
      if (this._blocked(x, z, BUILDING_MARGIN)) continue;

      // Never materialise inside somebody. Traffic learned this the expensive way.
      let clash = false;
      for (const other of this.peds) {
        if (!other) continue;
        if (Math.hypot(other.x - x, other.z - z) < 1.4) { clash = true; break; }
      }
      if (clash) continue;

      const ped = {
        id: ++this._nextId, edge: ei, side, forward, walk, node: k,
        x, z, yaw: Math.atan2(to.x - from.x, to.z - from.z),
        v: 0, phase: Math.random() * TAU, stuck: 0, turned: false, lateral: 0,
      };
      this._appearance(ped);
      ped.lateral = this._laneOf(ped);
      this.peds[i] = ped;
      this._writeColors(i, ped);
      this.stats.spawns++;
      return true;
    }
    this.stats.spawnFailures++;
    return false;
  }

  _writeColors(i, ped) {
    const c = this._col;
    c.setHex(ped.shirt); this.torsos.setColorAt(i, c);
    c.setHex(ped.skin); this.heads.setColorAt(i, c);
    const b = i * 8;
    c.setHex(ped.pants);
    this.limbs.setColorAt(b + 0, c);
    this.limbs.setColorAt(b + 2, c);
    // Shanks a touch darker: trouser break and shoe in one instance.
    c.setHex(ped.pants).multiplyScalar(0.62);
    this.limbs.setColorAt(b + 1, c);
    this.limbs.setColorAt(b + 3, c);
    // Sleeves a shade under the shirt. Identical tones made the whole upper body
    // read as one blob in the first close-up, because the arms hang close enough
    // to the torso that only a value break separates them.
    c.setHex(ped.shirt).multiplyScalar(0.84);
    this.limbs.setColorAt(b + 4, c);
    this.limbs.setColorAt(b + 6, c);
    if (ped.bare) c.setHex(ped.skin); else c.setHex(ped.shirt).multiplyScalar(0.78);
    this.limbs.setColorAt(b + 5, c);
    this.limbs.setColorAt(b + 7, c);
    this._colorDirty = true;
  }

  // Empty slots collapse to a zero-scale matrix, the same trick traffic uses.
  // Written once on the transition, not every frame: an idle slot should cost
  // nothing at all.
  _hide(i) {
    // A ped can die AFTER _assignNearLod has already reserved it a near slot for
    // this frame, and that slot is inside nearLimbs.count, so it would still be
    // drawn. Collapse it here rather than waiting for the next assignment.
    const ns = this._nearSlot[i];
    if (ns >= 0) {
      this._nearSlot[i] = -1;
      this.nearTorsos.setMatrixAt(ns, this._hidden);
      this.nearHeads.setMatrixAt(ns, this._hidden);
      for (let k = 0; k < NEAR_SLOTS; k++) this.nearLimbs.setMatrixAt(ns * NEAR_SLOTS + k, this._hidden);
    }
    if (!this._shown[i]) return;
    this._shown[i] = 0;
    this.torsos.setMatrixAt(i, this._hidden);
    this.heads.setMatrixAt(i, this._hidden);
    for (let k = 0; k < 8; k++) this.limbs.setMatrixAt(i * 8 + k, this._hidden);
  }

  // ------------------------------------------------------------------ update
  update(dt, focus) {
    this.stats.frames++;
    const fx = focus?.x ?? 0, fz = focus?.z ?? 0;

    // --- fill empty slots. Bounded two ways: at most SPAWN_SLOTS_PER_FRAME
    // slots are attempted and each gets SPAWN_TRIES attempts, so a frame where
    // every candidate is rejected still costs a fixed amount of work. The
    // per-frame cap has to be generous because it is measured in FRAMES: under
    // the software renderer the harnesses run at a few frames a second, and a
    // stingy cap left the pavement visibly half-empty in a 20 s capture.
    this._focus.x = fx; this._focus.z = fz;
    // Pick the near tier BEFORE anything is posed, using last frame's positions
    // and last frame's camera. Both are one frame stale and neither matters at
    // walking pace: a ped covers 25 mm in a 60 Hz frame, against a 6 m hysteresis
    // band.
    this._assignNearLod(fx, fz);
    let slots = SPAWN_SLOTS_PER_FRAME;
    for (let i = 0; i < this.count && slots > 0; i++) {
      if (this.peds[i]) continue;
      slots--;
      this._spawn(i, this._focus, SPAWN_TRIES);
    }

    // --- neighbour hash from this frame's positions, so every ped steers
    // against the same snapshot and the result does not depend on slot order.
    this._hash.clear();
    for (const p of this.peds) {
      if (!p) continue;
      const k = this._cellKey(Math.floor(p.x / SEP_CELL), Math.floor(p.z / SEP_CELL));
      let list = this._hash.get(k);
      if (!list) { list = []; this._hash.set(k, list); }
      list.push(p);
    }

    let minPair = Infinity;

    for (let i = 0; i < this.count; i++) {
      const ped = this.peds[i];
      if (!ped) { this._hide(i); continue; }
      this.stats.pedFrames++;

      // --- waypoint following
      let target = this._targetAt(ped, ped.node, this._tgt);
      if (!target) {
        const next = this._chooseNext(ped);
        if (!this._enter(ped, next)) { this.peds[i] = null; this._hide(i); continue; }
        this.stats.corners++;
        target = this._targetAt(ped, ped.node, this._tgt);
        if (!target) { this.peds[i] = null; this._hide(i); continue; }
      }
      let tx = target.x - ped.x, tz = target.z - ped.z;
      let td = Math.hypot(tx, tz);
      const fwdX = Math.sin(ped.yaw), fwdZ = Math.cos(ped.yaw);
      if (td < ARRIVE || (td < 3 && (tx * fwdX + tz * fwdZ) < 0)) {
        ped.node++;
        if (ped.node >= this._nodeCount(ped)) {
          const next = this._chooseNext(ped);
          if (!this._enter(ped, next)) { this.peds[i] = null; this._hide(i); continue; }
          this.stats.corners++;
        }
        target = this._targetAt(ped, ped.node, this._tgt);
        if (!target) { this.peds[i] = null; this._hide(i); continue; }
        tx = target.x - ped.x; tz = target.z - ped.z; td = Math.hypot(tx, tz) || 1;
      }
      let wishX = tx / (td || 1), wishZ = tz / (td || 1);

      // --- separation. Cheap reciprocal avoidance: push sideways off anyone
      // close, and brake for anyone directly in front. Two peds on a collision
      // course each veer, so they pass rather than interpenetrate.
      let brake = 1;
      const cx = Math.floor(ped.x / SEP_CELL), cz = Math.floor(ped.z / SEP_CELL);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const list = this._hash.get(this._cellKey(cx + ox, cz + oz));
          if (!list) continue;
          for (const o of list) {
            if (o === ped) continue;
            const dx = ped.x - o.x, dz = ped.z - o.z;
            const d = Math.hypot(dx, dz);
            if (d < minPair) minPair = d;
            if (d > SEP_RADIUS || d < 1e-4) continue;
            const w = (1 - d / SEP_RADIUS);
            wishX += (dx / d) * w * 1.9;
            wishZ += (dz / d) * w * 1.9;
            // Ahead and close: slow down instead of shouldering through.
            if (d < 0.95 && (-dx * fwdX - dz * fwdZ) / d > 0.55) brake = Math.min(brake, 0.25);
          }
        }
      }
      if (this.avoidPlayer) {
        const dx = ped.x - fx, dz = ped.z - fz;
        const d = Math.hypot(dx, dz);
        if (d < 1.6 && d > 1e-4) {
          const w = 1 - d / 1.6;
          wishX += (dx / d) * w * 2.6;
          wishZ += (dz / d) * w * 2.6;
        }
      }
      if (brake < 1) this.stats.avoidBrakeFrames++;

      // --- steer. Yaw slews at a bounded rate, which is what makes a corner
      // look walked round rather than teleported through.
      const wl = Math.hypot(wishX, wishZ) || 1;
      const wantYaw = Math.atan2(wishX / wl, wishZ / wl);
      let dy = wantYaw - ped.yaw;
      while (dy > Math.PI) dy -= TAU;
      while (dy < -Math.PI) dy += TAU;
      const maxStep = MAX_TURN * dt;
      ped.yaw += Math.max(-maxStep, Math.min(maxStep, dy));

      // Slow into a sharp turn; nobody walks a right angle at full pace.
      const turnScale = 1 - Math.min(0.55, Math.abs(dy) * 0.45);
      const targetV = ped.desired * brake * turnScale;
      ped.v += (targetV - ped.v) * (1 - Math.exp(-6 * dt));

      const nx = Math.sin(ped.yaw), nz = Math.cos(ped.yaw);
      ped.x += nx * ped.v * dt;
      ped.z += nz * ped.v * dt;
      if (this._pushOut(ped)) ped.v *= 0.5;

      // --- stride phase advances with DISTANCE, never with time (animfsm.js).
      // Stride scales with the ped's own legs, so a tall ped covers ground in
      // fewer, longer steps at the same cadence, and stretches slightly at pace.
      const legLen = LEG_LEN * ped.hscale;
      ped.stride = legLen * STRIDE_K * (0.86 + 0.14 * (ped.v / 1.35));
      ped.phase = (ped.phase + (TAU * ped.v * dt) / ped.stride) % TAU;

      // --- stuck handling. A ped that is not making progress turns around, and
      // if that does not free it, gives its slot back. Neither piling up nor
      // vanishing on the spot is acceptable; this bounds both.
      if (ped.v < 0.2) {
        ped.stuck += dt;
        if (ped.stuck > STUCK_DESPAWN_S) {
          this.peds[i] = null; this._hide(i);
          this.stats.stuckDespawns++; this.stats.despawns++;
          continue;
        }
        if (ped.stuck > STUCK_TURN_S && !ped.turned) {
          ped.turned = true;
          this.stats.uTurnsWhenStuck++;
          if (this._enter(ped, { e: ped.edge, forward: !ped.forward, side: ped.side })) {
            // Restart on the pavement we are standing on, walking the other way.
            let nearest = 0, nd = Infinity;
            for (let k = 0; k < this._nodeCount(ped); k++) {
              const p = this._node(ped, k);
              const d = Math.hypot(p.x - ped.x, p.z - ped.z);
              if (d < nd) { nd = d; nearest = k; }
            }
            ped.node = Math.min(this._nodeCount(ped) - 1, nearest + 1);
          }
        }
      } else { ped.stuck = 0; ped.turned = false; }

      // --- despawn out of range
      if (Math.hypot(ped.x - fx, ped.z - fz) > this.despawnRadius) {
        this.peds[i] = null; this._hide(i);
        this.stats.despawns++;
        continue;
      }
      if (this.isChunkLoaded && !this.isChunkLoaded(ped.x, ped.z)) this.stats.orphanPedFrames++;

      this._writePose(i, ped, legLen);
    }

    if (Number.isFinite(minPair)) {
      this._minHist[Math.min(5, Math.floor(minPair / 0.25))]++;
      if (minPair < this.stats.closestApproachM) this.stats.closestApproachM = +minPair.toFixed(2);
      if (minPair < this.overlapDistance) this.stats.overlapFrames++;
      if (minPair < BODY_OVERLAP) this.stats.bodyOverlapFrames++;
    }

    // Kept as a plain counter so the HUD can read it every frame without going
    // through report(), which allocates.
    let alive = 0;
    for (const p of this.peds) if (p) alive++;
    this.aliveCount = alive;

    this.torsos.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.limbs.instanceMatrix.needsUpdate = true;
    this._syncNearCounts();
    if (this._colorDirty) {
      for (const m of [this.torsos, this.heads, this.limbs]) {
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      this._colorDirty = false;
    }
    if (this._nearColorDirty) {
      for (const m of [this.nearTorsos, this.nearHeads, this.nearLimbs]) {
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      this._nearColorDirty = false;
    }
  }

  // ---------------------------------------------------------- forward kinematics
  // Eight bones, written straight into the instance matrices. Conventions:
  //   * local +Z is the direction of travel (yaw = atan2(dx, dz)), matching
  //     traffic.js and character.js.
  //   * a limb pivots at its TOP, and a POSITIVE X rotation swings its far end
  //     BACKWARD. Knees and elbows therefore only ever add in the direction that
  //     folds the joint the way a joint actually folds - the shank swings back
  //     under the body, the forearm swings forward. Getting that sign wrong is
  //     what makes procedural walks look like broken marionettes.
  _writePose(i, ped, legLen) {
    const yaw = ped.yaw;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const s = ped.hscale, b = ped.build;

    // Below walking pace the gait folds away, so a ped held up by a crowd stands
    // upright with its feet together instead of shuffling on the spot.
    const move = Math.min(1, ped.v / GAIT_FADE);
    const S = (ped.stride ?? legLen * STRIDE_K) * move;
    const reach = REACH * legLen;
    const thighLen = THIGH * s, shankLen = SHANK * s;

    // Feet first: where each ankle wants to be, relative to the hip, in the
    // sagittal plane. Left leads, right is half a cycle behind.
    const ankle = ANKLE_H * s;
    const u = ped.phase / TAU;
    const fL = this._footTarget(u, S, ankle, this._fL);
    const fR = this._footTarget((u + 0.5) % 1, S, ankle, this._fR);

    // Hip height: the compass-gait solution (hip on a circle about the planted
    // foot) softened toward level, because a rigid straight leg bobs about twice
    // as much as a person does. Whatever the softening then over-reaches is paid
    // for by lifting the foot inside _solveLeg, never by sliding it.
    let relStance = 0;
    if (fL.stance) relStance = Math.abs(fL.rel);
    if (fR.stance) relStance = Math.max(relStance, Math.abs(fR.rel));
    const compass = Math.sqrt(Math.max(0.01, reach * reach - relStance * relStance));
    const hipY = ankle + reach - BOB_FRACTION * (reach - compass);

    const legs = this._legs;
    this._solveLeg(fL, hipY, reach, thighLen, legs, 0);
    this._solveLeg(fR, hipY, reach, thighLen, legs, 2);
    const thighL = legs[0], shankL = legs[1];
    const thighR = legs[2], shankR = legs[3];

    // Arms counter-swing the legs: the left leg is furthest forward at phase 0,
    // so the left arm is furthest back there. Elbows carry a constant angle plus
    // a little more at speed, which is what stops the arms reading as planks.
    const cp = Math.cos(ped.phase);
    const armL = ARM_AMP * move * cp, armR = -ARM_AMP * move * cp;
    const elbow = (0.13 + 0.16 * move) + Math.abs(cp) * 0.10 * move;

    const ground = this.ground ? this.ground.heightAt(ped.x, ped.z) : 0;
    const rootY = ground - FOOT_SINK;

    // Girth tracks height as well as build, so a tall ped is not a stretched
    // thin one; combined the population spans roughly 0.8x to 1.3x in section.
    const g = b * s;
    const hipXL = -HIP_X * g, hipXR = HIP_X * g;
    const shX = SHOULDER_X * g;
    const shY = hipY + TORSO_H * s;
    const neckY = hipY + HEAD_Y * s;

    // --- which tier draws this ped. The skeleton above is tier-independent; only
    // the meshes the matrices land in change, so the two tiers cannot drift.
    const ns = this._nearSlot[i];
    const near = ns >= 0;
    const torsoMesh = near ? this.nearTorsos : this.torsos;
    const headMesh = near ? this.nearHeads : this.heads;
    const limbMesh = near ? this.nearLimbs : this.limbs;
    const tSlot = near ? ns : i;
    if (near) {
      // ...and the far tier must not draw it a second time.
      this.torsos.setMatrixAt(i, this._hidden);
      this.heads.setMatrixAt(i, this._hidden);
      for (let k = 0; k < 8; k++) this.limbs.setMatrixAt(i * 8 + k, this._hidden);
    }

    this._qy.setFromAxisAngle(this._axisY, yaw);

    // --- torso and head
    this._v.set(ped.x, rootY + hipY, ped.z);
    this._s.set(g, ((HEAD_Y + 0.06) * s) / TORSO_BASE, g);
    this._m.compose(this._v, this._qy, this._s);
    torsoMesh.setMatrixAt(tSlot, this._m);

    this._v.set(ped.x, rootY + neckY, ped.z);
    this._s.set(s, s, s);
    this._m.compose(this._v, this._qy, this._s);
    headMesh.setMatrixAt(tSlot, this._m);

    // --- limbs. Each shank/forearm hangs off the tip of the bone above it, so
    // the chain never comes apart however the joints are driven.
    const base = near ? ns * NEAR_SLOTS : i * 8;
    const hipYW = rootY + hipY, shYW = rootY + shY;
    const t = this._tipOut;

    const hlx = ped.x + hipXL * cy, hlz = ped.z - hipXL * sy;
    this._bone(limbMesh, base + 0, hlx, hipYW, hlz, yaw, thighL, thighLen, 1.02 * g);
    this._tip(hlx, hipYW, hlz, thighL, thighLen, cy, sy);
    const klx = t[0], kly = t[1], klz = t[2];
    this._bone(limbMesh, base + 1, klx, kly, klz, yaw, shankL, shankLen, 0.86 * g);

    const hrx = ped.x + hipXR * cy, hrz = ped.z - hipXR * sy;
    this._bone(limbMesh, base + 2, hrx, hipYW, hrz, yaw, thighR, thighLen, 1.02 * g);
    this._tip(hrx, hipYW, hrz, thighR, thighLen, cy, sy);
    const krx = t[0], kry = t[1], krz = t[2];
    this._bone(limbMesh, base + 3, krx, kry, krz, yaw, shankR, shankLen, 0.86 * g);

    const slx = ped.x - shX * cy, slz = ped.z + shX * sy;
    this._bone(limbMesh, base + 4, slx, shYW, slz, yaw, armL, UPPER_ARM * s, 0.78 * g);
    this._tip(slx, shYW, slz, armL, UPPER_ARM * s, cy, sy);
    const elx = t[0], ely = t[1], elz = t[2];
    this._bone(limbMesh, base + 5, elx, ely, elz, yaw, armL - elbow, FOREARM * s, 0.68 * g);

    const srx = ped.x + shX * cy, srz = ped.z - shX * sy;
    this._bone(limbMesh, base + 6, srx, shYW, srz, yaw, armR, UPPER_ARM * s, 0.78 * g);
    this._tip(srx, shYW, srz, armR, UPPER_ARM * s, cy, sy);
    const erx = t[0], ery = t[1], erz = t[2];
    this._bone(limbMesh, base + 7, erx, ery, erz, yaw, armR - elbow, FOREARM * s, 0.68 * g);

    if (near) {
      // Six bones the far tier cannot afford, hung off joints the far tier
      // already computes. A shoe is the same capsule laid along the direction of
      // travel: angle -pi/2 turns the bone's local -Y into world forward, so no
      // second convention is introduced. It sits SHOE_DROP below the ankle and
      // SHOE_BACK behind it, which puts the heel under the ankle and the toe in
      // front of it, and buries the bottom of the capsule in the pavement so the
      // sole reads flat instead of round.
      // Written out rather than looped through a closure: this runs once per near
      // ped per frame and a closure per call is an allocation per call, which is
      // the kind of thing that shows up as GC inside somebody else's slice.
      this._tip(klx, kly, klz, shankL, shankLen, cy, sy);
      this._bone(limbMesh, base + SHOE_L, t[0] - sy * SHOE_BACK * s, t[1] - SHOE_DROP * s,
        t[2] - cy * SHOE_BACK * s, yaw, -Math.PI / 2, SHOE_LEN * s, SHOE_THICK * g);
      this._tip(krx, kry, krz, shankR, shankLen, cy, sy);
      this._bone(limbMesh, base + SHOE_R, t[0] - sy * SHOE_BACK * s, t[1] - SHOE_DROP * s,
        t[2] - cy * SHOE_BACK * s, yaw, -Math.PI / 2, SHOE_LEN * s, SHOE_THICK * g);

      // Hands continue along the forearm, so a swinging arm ends in something
      // instead of stopping at a cap.
      this._tip(elx, ely, elz, armL - elbow, FOREARM * s, cy, sy);
      this._bone(limbMesh, base + HAND_L, t[0], t[1], t[2], yaw, armL - elbow,
        HAND_LEN * s, HAND_THICK * g);
      this._tip(erx, ery, erz, armR - elbow, FOREARM * s, cy, sy);
      this._bone(limbMesh, base + HAND_R, t[0], t[1], t[2], yaw, armR - elbow,
        HAND_LEN * s, HAND_THICK * g);

      // A neck between the shoulders and the skull, and a pelvis under the shirt
      // hem. The torso capsule tapers to a POINT at the hip pivot, so without the
      // pelvis the seat of the trousers is two bare tubes and a gap.
      this._bone(limbMesh, base + NECK_I, ped.x, rootY + neckY + 0.045 * s, ped.z,
        yaw, 0, NECK_LEN * s, NECK_THICK * g);
      this._bone(limbMesh, base + PELVIS_I, ped.x, hipYW + 0.045 * s, ped.z,
        yaw, 0, PELVIS_LEN * s, PELVIS_THICK * g, PELVIS_THICK_Z * g);
    }

    this._shown[i] = 1;
  }

  // Where one sole should be, relative to the hip, at cycle position u in [0,1).
  //
  //   stance (u < DUTY): the foot is planted. Relative to the hip it slides back
  //     at exactly the rate the hip advances - DUTY*S of travel over the stance
  //     window - so its WORLD position does not move at all. This is the whole
  //     no-slip guarantee, and it holds only because the phase is advanced by
  //     distance rather than by time.
  //   swing:  the foot returns forward over the remaining (1 - DUTY) of the
  //     cycle, arcing over a sine lift so it clears the pavement.
  _footTarget(u, S, ankle, out) {
    if (u < DUTY) {
      const a = u / DUTY;
      out.rel = DUTY * S * (0.5 - a);
      out.y = ankle;
      out.stance = true;
    } else {
      const b = (u - DUTY) / (1 - DUTY);
      out.rel = DUTY * S * (b - 0.5);
      out.y = ankle + SWING_LIFT * Math.sin(Math.PI * b);
      out.stance = false;
    }
    return out;
  }

  // Two-link IK for one leg. Working in the sagittal plane with the hip at the
  // origin, the foot wants to be `foot.rel` ahead of it and `hipY - foot.y`
  // below it. Thigh and shank are the same length `segment`, so the general
  // two-link solution collapses to one deviation, beta = acos(d / (2*segment)),
  // taken either side of the hip-to-foot line - knee forward, which is the only
  // way a knee goes. Writes [thighAngle, shankAngle] into `out` at `at`, in the
  // file's rotation convention (positive swings the far end backward).
  _solveLeg(foot, hipY, reach, segment, out, at) {
    let drop = hipY - foot.y;
    let d = Math.hypot(foot.rel, drop);
    if (d > reach) {
      // The hip is further from the ground than this leg can span. Raise the
      // FOOT to meet it - a heel coming off the pavement - rather than letting
      // the sole skate to where the leg can reach.
      drop = Math.sqrt(Math.max(1e-4, reach * reach - foot.rel * foot.rel));
      d = reach;
    }
    if (d < 0.06) d = 0.06;
    const alpha = Math.atan2(foot.rel, drop);            // + = foot ahead of hip
    const beta = Math.acos(Math.min(1, d / (2 * segment)));
    out[at] = -alpha - beta;                             // thigh
    out[at + 1] = -alpha + beta;                         // shank
  }

  // World position of the far end of a bone: R_y(yaw) * R_x(angle) applied to
  // (0, -len, 0), added to the pivot. Written into a reused array - this runs
  // four times per ped per frame and must not allocate.
  _tip(px, py, pz, angle, len, cy, sy) {
    const lz = -len * Math.sin(angle);
    this._tipOut[0] = px + lz * sy;
    this._tipOut[1] = py - len * Math.cos(angle);
    this._tipOut[2] = pz + lz * cy;
  }

  // `mesh` and `slot` rather than a bare slot, because the same skeleton drives
  // the far tier's 8-bone layout and the near tier's 14-bone one. `thickZ`
  // defaults to `thick`: only the pelvis is wider than it is deep.
  //
  // Every scale here is POSITIVE, so every instance matrix has a positive
  // determinant and no instance mirrors its geometry. That is the property
  // src/streetfurniture.js lost, and tools/ped-audit.mjs measures it: 0 of 960
  // live instances wind backwards.
  _bone(mesh, slot, px, py, pz, yaw, angle, len, thick, thickZ = thick) {
    this._qy.setFromAxisAngle(this._axisY, yaw);
    this._qx.setFromAxisAngle(this._axisX, angle);
    this._q.copy(this._qy).multiply(this._qx);
    this._v.set(px, py, pz);
    this._s.set(thick, len / LIMB_BASE, thickZ);
    this._m.compose(this._v, this._q, this._s);
    mesh.setMatrixAt(slot, this._m);
  }

  // ------------------------------------------------------------------ report
  report() {
    const alive = this.peds.filter(Boolean);
    const f = Math.max(1, this.stats.frames);
    return {
      population: this.count,
      alive: alive.length,
      ...this.stats,
      closestApproachM: Number.isFinite(this.stats.closestApproachM)
        ? this.stats.closestApproachM : null,
      // Any pair in the whole crowd within CLOSE_PASS this frame. In a dense
      // crowd this is SUPPOSED to fire often; it is a liveliness reading, not a
      // fault count. bodyOverlapPctOfFrames is the fault count.
      closePassPctOfFrames: +((this.stats.overlapFrames / f) * 100).toFixed(1),
      bodyOverlapPctOfFrames: +((this.stats.bodyOverlapFrames / f) * 100).toFixed(1),
      avoidBrakePctOfPedFrames:
        +((this.stats.avoidBrakeFrames / Math.max(1, this.stats.pedFrames)) * 100).toFixed(1),
      meanSpeedMs: alive.length
        ? +(alive.reduce((a, p) => a + p.v, 0) / alive.length).toFixed(2) : 0,
      // Closest pair per frame in 0.25 m buckets: separates "brushed past" from
      // "walked through", which a single overlap percentage cannot.
      closestPairHistogram: this._minHist,
      sidewalksCached: this._walks.size,
      // Fixed, whatever the population is - that is the whole point of the
      // representation. 3 body meshes in the scene pass and the same 3 again in
      // the sun's shadow pass, through the dilated depth material. The near tier
      // adds 3 more of each, and only while somebody is standing close enough to
      // hold a slot.
      drawCalls: 3 + (this._nearLive ? 3 : 0),
      shadowDrawCalls: 3 + (this._nearLive ? 3 : 0),
      shadowDilateM: SHADOW_DILATE,
      nearLod: {
        pool: this.nearPool,
        live: this._nearLive,
        radiusM: NEAR_RADIUS,
        releaseM: NEAR_RELEASE,
        slotsPerPed: NEAR_SLOTS,
        farTrisPerPed: this._triOf(this.torsos) + this._triOf(this.heads)
          + 8 * this._triOf(this.limbs),
        nearTrisPerPed: this._triOf(this.nearTorsos) + this._triOf(this.nearHeads)
          + NEAR_SLOTS * this._triOf(this.nearLimbs),
        farCrowdTris: (this._triOf(this.torsos) + this._triOf(this.heads)
          + 8 * this._triOf(this.limbs)) * this.count,
        nearCrowdTrisWorstCase: (this._triOf(this.nearTorsos) + this._triOf(this.nearHeads)
          + NEAR_SLOTS * this._triOf(this.nearLimbs)) * this.nearPool,
      },
    };
  }

  _triOf(mesh) {
    const g = mesh.geometry;
    return (g.index ? g.index.count : g.attributes.position.count) / 3;
  }

  // Live positions, for harnesses that need to prove peds are where they claim.
  positions() {
    return this.peds.filter(Boolean).map((p) => ({
      x: +p.x.toFixed(2), z: +p.z.toFixed(2), v: +p.v.toFixed(2), edge: p.edge, side: p.side,
    }));
  }

  dispose() {
    this.torsos.onBeforeRender = () => {};
    for (const m of [this.torsos, this.heads, this.limbs,
      this.nearTorsos, this.nearHeads, this.nearLimbs]) {
      this.root.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    for (const m of this.materials) m.dispose();
    this.depthMaterial.dispose();
    this.root.parent?.remove(this.root);
  }
}
