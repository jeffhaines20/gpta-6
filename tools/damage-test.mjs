// Deterministic gate for the vehicle damage model.
//
// No browser, no renderer, no three.js: src/damage.js is pure arithmetic and one
// timer, so a thousand crashes run in milliseconds and must land on the same numbers
// every time.
//
//   node tools/damage-test.mjs
//
// WHAT THIS GATE IS FOR, beyond "the code runs". CLAUDE.md's rule is that every new
// metric needs a selftest that fails on known-bad input, and the damage model has
// three specific ways to be confidently wrong, each of which gets a section here
// that builds the broken version and asserts it IS broken:
//
//   §2  A model fed SPEED instead of normal delta-v. It totals the car for grazing a
//       wall at 60 km/h, which the real model scores at zero. This is the whole
//       design decision, so it gets a test that fails if the decision is undone.
//   §3  A model with no refractory on minor impacts. A bouncing grind over one
//       second of 120 Hz physics writes off a car the real model barely scratches.
//   §6  A model that accepts a non-finite delta-v. Health becomes NaN, after which
//       `health < 0.2` is FALSE and the car is immortal — the mission fail path
//       silently stops existing. This is the same shape as CLAUDE.md's NaN-in-the-
//       bottom-quarter bug: the wrong answer is the reassuring one.
//
// §1 checks the three published anchors, and the 15 km/h one is a PREDICTION of the
// energy curve rather than an input to it, which is the only evidence available here
// that the curve shape is right.
import { DamageModel, IMPACT, ANCHORS, HALF_EXTENT, normalDv, pairDv, dynamicContact,
  pedFatalityRisk, Garage, composeGarage } from '../src/damage.js';
import { hardnessFor } from '../src/audio.js';
import { WantedSystem, CRIMES as CRIME_TABLE, BUST_HOLD_S,
  SCENE_STOP_MS } from '../src/wanted.js';
import { OFFER_RADIUS_M } from '../src/mission.js';
import { objectiveLine } from '../src/hud.js';
import fs from 'node:fs';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const kmh = (v) => v / 3.6;

console.log('DAMAGE MODEL GATE');
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// §1  The published anchors, and the prediction between them.
// ---------------------------------------------------------------------------
console.log('\n§1  Anchors (FMVSS 581 / IIHS low-speed / NCAP full-frontal)');
const d = new DamageModel();
const rows = [
  ['  5 km/h nudge',        kmh(5)],
  ['  8 km/h FMVSS 581',    ANCHORS.freeDv],
  [' 15 km/h IIHS',         ANCHORS.refDv],
  [' 25 km/h',              kmh(25)],
  [' 35 km/h',              kmh(35)],
  [' 50 km/h NCAP barrier', ANCHORS.killDv],
  [' 80 km/h',              kmh(80)],
];
for (const [label, dv] of rows) {
  const s = d.severityFor(dv);
  console.log(`    ${label.padEnd(24)} dv ${dv.toFixed(2).padStart(6)} m/s   severity ${s.toFixed(4)}   -> health ${(1 - s).toFixed(4)}`);
}
check('8 km/h (FMVSS 581 bumper standard) costs nothing', d.severityFor(ANCHORS.freeDv) === 0);
check('50 km/h (NCAP rigid barrier) is a write-off', near(d.severityFor(ANCHORS.killDv), 1, 1e-9));
check('15 km/h predicted at 0.067 (IIHS: cosmetic to moderate)',
  near(d.severityFor(ANCHORS.refDv), ANCHORS.refSeverity, 0.001),
  `predicted ${d.severityFor(ANCHORS.refDv).toFixed(4)} vs anchor ${ANCHORS.refSeverity}`);
// A linear-in-dv model with the same endpoints would put 15 km/h 2.5x higher. The
// curve SHAPE is the claim, so state what the alternative would have said.
const lin = (ANCHORS.refDv - ANCHORS.freeDv) / (ANCHORS.killDv - ANCHORS.freeDv);
console.log(`    a linear-in-dv model with the same endpoints: ${lin.toFixed(4)} — ${(lin / ANCHORS.refSeverity).toFixed(1)}x the reference`);
check('the energy curve is materially below a linear one at 15 km/h', lin > ANCHORS.refSeverity * 2);
let mono = true;
for (let v = 0; v < 20; v += 0.05) if (d.severityFor(v + 0.05) < d.severityFor(v)) mono = false;
check('severity is monotonic in delta-v', mono);
check('severity saturates at 1 and never exceeds it', d.severityFor(200) === 1);
check('negative delta-v is treated by magnitude', d.severityFor(-kmh(50)) === d.severityFor(kmh(50)));

// ---------------------------------------------------------------------------
// §2  KNOWN-BAD: a model fed speed instead of normal delta-v.
// ---------------------------------------------------------------------------
console.log('\n§2  Known-bad: speed instead of normal delta-v (the graze case)');
// 60 km/h along a wall, 5 degrees of incidence. Wall normal is +x, car travels
// mostly -z with a small +x component into it.
const GRAZE_SPEED = kmh(60), GRAZE_DEG = 5;
const gvx = GRAZE_SPEED * Math.sin(GRAZE_DEG * Math.PI / 180);
const gvz = -GRAZE_SPEED * Math.cos(GRAZE_DEG * Math.PI / 180);
const grazeDv = normalDv(gvx, gvz, -1, 0, 0);     // outward normal points -x at the car
console.log(`    60 km/h at ${GRAZE_DEG}deg incidence: normal dv ${grazeDv.toFixed(3)} m/s, speed ${GRAZE_SPEED.toFixed(2)} m/s`);
console.log(`    severity from delta-v ${d.severityFor(grazeDv).toFixed(4)}   from SPEED ${d.severityFor(GRAZE_SPEED).toFixed(4)}`);
check('a 5deg graze at 60 km/h costs nothing', d.severityFor(grazeDv) === 0);
check('KNOWN-BAD: the same graze fed as speed writes the car off', d.severityFor(GRAZE_SPEED) === 1);
// And the square-on hit at the same speed must be the write-off.
const squareDv = normalDv(GRAZE_SPEED, 0, -1, 0, 0);
check('the same speed square-on IS a write-off', d.severityFor(squareDv) === 1,
  `square-on dv ${squareDv.toFixed(2)}`);
// Incidence sweep, because "it works at 5 and 90 degrees" is two points.
console.log('    incidence sweep at 60 km/h:');
for (const deg of [2, 5, 10, 15, 20, 30, 45, 60, 90]) {
  const vx = GRAZE_SPEED * Math.sin(deg * Math.PI / 180);
  const vz = -GRAZE_SPEED * Math.cos(deg * Math.PI / 180);
  const dv = normalDv(vx, vz, -1, 0, 0);
  console.log(`      ${String(deg).padStart(2)}deg  dv ${dv.toFixed(2).padStart(5)}  severity ${d.severityFor(dv).toFixed(4)}`);
}
check('normalDv: a surface being driven AWAY from is not an impact',
  normalDv(-10, 0, -1, 0, 0) === 0);
check('normalDv: restitution 1 doubles the delta-v',
  near(normalDv(10, 0, -1, 0, 1), 2 * normalDv(10, 0, -1, 0, 0), 1e-9));
check('normalDv: a zero-length normal is not an impact', normalDv(10, 0, 0, 0, 0) === 0);

// ---------------------------------------------------------------------------
// §3  KNOWN-BAD: no refractory on minor impacts.
// ---------------------------------------------------------------------------
console.log('\n§3  Known-bad: a bouncing grind with no refractory');
// 120 Hz physics, one second, each frame a 12 km/h normal bounce off the same wall.
const BOUNCE_DV = kmh(12), HZ = 120, DT = 1 / HZ;
const per = d.severityFor(BOUNCE_DV);
const real = new DamageModel();
for (let i = 0; i < HZ; i++) { real.impact({ dv: BOUNCE_DV, dirX: -1, dirZ: 0 }); real.update(DT); }
const naive = new DamageModel({ minorRefractory: 0 });
for (let i = 0; i < HZ; i++) { naive.impact({ dv: BOUNCE_DV, dirX: -1, dirZ: 0 }); naive.update(DT); }
console.log(`    one 12 km/h bounce is severity ${per.toFixed(4)}; 120 of them in one second:`);
console.log(`      with the refractory: health ${real.report().health.toFixed(4)}  applied ${real.stats.applied}  refracted ${real.stats.refracted}`);
console.log(`      KNOWN-BAD (none):    health ${naive.report().health.toFixed(4)}  applied ${naive.stats.applied}`);
check('a one-second grind does not write the car off', real.health > 0.85,
  `health ${real.health.toFixed(4)}`);
check('KNOWN-BAD: with no refractory the same grind wrecks it', naive.health === 0);
check('the refractory admits roughly one minor hit per window',
  real.stats.applied === 1 + Math.floor((HZ * DT) / real.minorRefractory),
  `applied ${real.stats.applied}, window ${real.minorRefractory}s over ${(HZ * DT).toFixed(2)}s`);
// A MAJOR impact is never refracted, even immediately after another.
const majors = new DamageModel();
majors.impact({ dv: kmh(30), dirX: 0, dirZ: 1 });
const second = majors.impact({ dv: kmh(30), dirX: 0, dirZ: 1 });
check('a major impact is never swallowed by a preceding one', second.applied,
  `second reason ${second.reason}`);
check('two 30 km/h front hits cost twice one', near(1 - majors.health, 2 * d.severityFor(kmh(30)), 1e-9));

// ---------------------------------------------------------------------------
// §4  Regions, and the corner case that motivated box space.
// ---------------------------------------------------------------------------
console.log('\n§4  Region weighting in box space');
const corner = d.regionWeights(HALF_EXTENT.x, HALF_EXTENT.z);
console.log(`    front corner (${HALF_EXTENT.x}, ${HALF_EXTENT.z}): ` +
  Object.entries(corner).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  '));
check('a hit on the exact front corner is half front, half side',
  near(corner.front, 0.5, 1e-9) && near(corner.right, 0.5, 1e-9));
// KNOWN-BAD: the same test in metres calls the corner a pure front hit.
const mx = HALF_EXTENT.x, mz = HALF_EXTENT.z;
const metreVerdict = (mz * mz) / (mx * mx + mz * mz);
console.log(`    KNOWN-BAD in metres, the same corner reads front ${metreVerdict.toFixed(3)} — a pure front hit`);
check('KNOWN-BAD: a metres-space test misfiles the corner as front', metreVerdict > 0.8);
for (const [label, x, z, want] of [
  ['square front', 0, 1, 'front'], ['square rear', 0, -1, 'rear'],
  ['square left', -1, 0, 'left'], ['square right', 1, 0, 'right'],
]) {
  const w = d.regionWeights(x, z);
  check(`${label} is 100% ${want}`, near(w[want], 1, 1e-9),
    Object.entries(w).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' '));
}
for (const [x, z] of [[0, 1], [1, 1], [-3, 0.2], [0.4, -2], [0, 0]]) {
  const w = d.regionWeights(x, z);
  const sum = w.front + w.rear + w.left + w.right;
  check(`region weights sum to 1 at (${x}, ${z})`, near(sum, 1, 1e-9), `sum ${sum}`);
}

// ---------------------------------------------------------------------------
// §5  Degradation: the outputs that make this gameplay rather than a number.
// ---------------------------------------------------------------------------
console.log('\n§5  Degradation');
const deg = new DamageModel();
console.log('    front damage   health  enginePower  steerPull  smoke');
const steps = [];
for (let i = 0; i < 9; i++) {
  const r = deg.report();
  steps.push(r);
  console.log(`      ${r.regions.front.toFixed(3)}        ${r.health.toFixed(3)}   ${r.enginePower.toFixed(3)}        ${r.steerPull.toFixed(3)}     ${r.smoke.toFixed(3)}`);
  deg.impact({ dv: kmh(25), dirX: 0, dirZ: 1 });
  deg.time += 1;
}
check('a showroom car has full engine power', steps[0].enginePower === 1);
check('engine power survives light front damage', steps[1].enginePower === 1,
  `front ${steps[1].regions.front} -> power ${steps[1].enginePower}`);
check('engine power falls once the front is bent', steps[4].enginePower < 0.95,
  `front ${steps[4].regions.front} -> power ${steps[4].enginePower}`);
let engMono = true;
for (let i = 1; i < steps.length; i++) if (steps[i].enginePower > steps[i - 1].enginePower) engMono = false;
check('engine power is monotonically non-increasing under front damage', engMono);
// Rear damage must NOT take the engine away: that was the specific mistake of
// driving degradation off overall health instead of the region that carries it.
const rear = new DamageModel();
for (let i = 0; i < 4; i++) { rear.impact({ dv: kmh(20), dirX: 0, dirZ: -1 }); rear.time += 1; }
const rr = rear.report();
console.log(`    four 20 km/h REAR hits: health ${rr.health.toFixed(3)}, front ${rr.regions.front.toFixed(3)}, rear ${rr.regions.rear.toFixed(3)}, enginePower ${rr.enginePower.toFixed(3)}`);
// The counterfactual is the point: if degradation were driven off overall health,
// this car — reversed into things four times, engine untouched — would be down to
// the same power as a car with the same fraction of FRONT damage.
const asIfHealth = 1 - Math.min(1, Math.max(0, ((1 - rr.health) - 0.35) / 0.5)) * 0.75;
console.log(`    KNOWN-BAD: driven off overall health instead, the same car reads enginePower ${asIfHealth.toFixed(3)}`);
check('rear damage does not cost engine power', rear.enginePower === 1 && rear.health < 0.55,
  `health ${rear.health.toFixed(3)} power ${rear.enginePower}`);
check('KNOWN-BAD: a health-driven degradation would have taken power from it', asIfHealth < 0.95,
  `${asIfHealth.toFixed(3)}`);
// Steering pull is signed and bounded.
const pull = new DamageModel();
pull.impact({ dv: kmh(45), dirX: 1, dirZ: 0 });
check('a near-side hit pulls that way with the right sign', pull.steerPull > 0, `${pull.steerPull}`);
check('steering pull is capped', pull.steerPull <= 0.25, `${pull.steerPull}`);
const pull2 = new DamageModel();
pull2.impact({ dv: kmh(45), dirX: -1, dirZ: 0 });
check('the mirrored hit pulls the other way by the same amount',
  near(pull2.steerPull, -pull.steerPull, 1e-9));
const balanced = new DamageModel();
balanced.impact({ dv: kmh(45), dirX: 1, dirZ: 0 }); balanced.time += 1;
balanced.impact({ dv: kmh(45), dirX: -1, dirZ: 0 });
check('symmetric damage does not pull', near(balanced.steerPull, 0, 1e-9),
  `${balanced.steerPull}`);

// ---------------------------------------------------------------------------
// §6  KNOWN-BAD: a non-finite delta-v, and the immortality it buys.
// ---------------------------------------------------------------------------
console.log('\n§6  Known-bad: NaN delta-v');
const nan = new DamageModel();
const r1 = nan.impact({ dv: NaN, dirX: 0, dirZ: 1 });
const r2 = nan.impact({ dv: Infinity, dirX: 0, dirZ: 1 });
const r3 = nan.impact({ dv: 10, dirX: NaN, dirZ: 1 });
check('NaN delta-v is rejected', !r1.applied && r1.reason === 'non-finite');
check('Infinite delta-v is rejected', !r2.applied && r2.reason === 'non-finite');
check('NaN direction is rejected', !r3.applied && r3.reason === 'non-finite');
check('health survives all three intact', nan.health === 1);
// The known-bad half: what an unguarded accumulator buys you.
let poisoned = 1 - NaN;
console.log(`    KNOWN-BAD: health after an unguarded NaN is ${poisoned}, and \`${poisoned} < 0.2\` is ${poisoned < 0.2}`);
check('KNOWN-BAD: a NaN health passes the mission fail test, i.e. the car is immortal',
  !(poisoned < 0.2));
// dt is guarded the same way.
const dtBad = new DamageModel();
dtBad.impact({ dv: kmh(60), dirX: 0, dirZ: 1 });       // start a fire
dtBad.update(NaN); dtBad.update(-5); dtBad.update(1e9);
check('a NaN/negative/huge dt cannot poison the clock', Number.isFinite(dtBad.time) && dtBad.time <= 0.25 * 3,
  `time ${dtBad.time}`);

// ---------------------------------------------------------------------------
// §7  Fire, and the wrecked latch.
// ---------------------------------------------------------------------------
console.log('\n§7  Fire and the wrecked latch');
const fire = new DamageModel();
fire.impact({ dv: kmh(48), dirX: 0, dirZ: 1 });
console.log(`    one 48 km/h hit: health ${fire.report().health.toFixed(4)}, onFire ${fire.onFire}`);
check('a hit that leaves under 12% health lights a fire', fire.onFire, `health ${fire.health}`);
let tToWreck = 0;
for (let i = 0; i < 10000 && !fire.wrecked; i++) { fire.update(1 / 60); tToWreck += 1 / 60; }
console.log(`    burned out after ${tToWreck.toFixed(2)} s`);
check('fire wrecks the car', fire.wrecked);
check('fire gives the player between 1 and 6 seconds', tToWreck > 1 && tToWreck < 6,
  `${tToWreck.toFixed(2)} s`);
check('the fire is out once wrecked', !fire.onFire);
check('wrecked latches: further updates do not un-wreck it',
  (fire.update(1), fire.wrecked && fire.health === 0));
check('a wrecked car has no engine power', fire.enginePower === 0);
const noFire = new DamageModel();
noFire.impact({ dv: kmh(25), dirX: 0, dirZ: 1 });
for (let i = 0; i < 600; i++) noFire.update(1 / 60);
check('a lightly damaged car never catches fire', !noFire.onFire && noFire.health > 0.7,
  `health ${noFire.health.toFixed(3)}`);

// ---------------------------------------------------------------------------
// §8  Crime classification, against src/wanted.js's actual vocabulary.
// ---------------------------------------------------------------------------
console.log('\n§8  Crime classification');
const { CRIMES } = await import('../src/wanted.js');
const dm = new DamageModel();
const crimeRows = [
  ['wall at 3 km/h',        { dv: kmh(3), kind: IMPACT.wall },                     null],
  ['wall at 20 km/h',       { dv: kmh(20), kind: IMPACT.wall },                    'propertyDamage'],
  ['prop at 20 km/h',       { dv: kmh(20), kind: IMPACT.prop },                    'propertyDamage'],
  ['civilian car',          { dv: kmh(20), kind: IMPACT.vehicle },                 'civilianCollision'],
  ['police car',            { dv: kmh(20), kind: IMPACT.police },                  'policeProperty'],
  ['roadblock',             { dv: kmh(30), kind: IMPACT.roadblock },               'roadblockRun'],
  ['ped at 20 km/h',        { dv: 0.2, kind: IMPACT.pedestrian, speed: kmh(20) },  'pedestrianHit'],
  ['ped at 44 km/h',        { dv: 0.6, kind: IMPACT.pedestrian, speed: kmh(44) },  'pedestrianHit'],
  ['ped at 46 km/h',        { dv: 0.7, kind: IMPACT.pedestrian, speed: kmh(46) },  'pedestrianHit'],
  ['ped at 76 km/h',        { dv: 1.1, kind: IMPACT.pedestrian, speed: kmh(76) },  'pedestrianHit'],
  ['ped at 78 km/h',        { dv: 1.1, kind: IMPACT.pedestrian, speed: kmh(78) },  'pedestrianKilled'],
];
for (const [label, ev, want] of crimeRows) {
  dm.repair();
  const got = dm.impact(ev).crime;
  console.log(`    ${label.padEnd(20)} -> ${String(got)}`);
  check(`${label} reports ${want}`, got === want, `got ${got}`);
  if (want) check(`${want} exists in wanted.js`, !!CRIMES[want]);
}
/**
 * THE LINE MOVED, AND HERE IS WHY, because a gate threshold is never restated without its
 * derivation. It was 45 km/h, cited as the 50% point of the published speed-versus-fatality
 * curve. It is not the 50% point of any curve either cited paper offers: Rosen & Sander (2009)
 * fit P = 1/(1 + exp(6.9 - 0.090v)), which reads 5.5% at 45 km/h and crosses 50% at 76.7. The
 * 10/50/90-at-30/45/80 shape came from the older Ashton-family studies, which Rosen, Stigson &
 * Sander's 2011 review — the same authors, co-cited in the old comment — corrects explicitly as
 * biased toward severe accidents and therefore too high.
 *
 * `pedKillSpeed` is now that 50% point and nothing else. A host with a crowd module does not use
 * it at all: src/pedestrians.js draws against the whole curve, and district/main.js files the
 * crime from what actually happened to the body.
 */
check('the pedestrian fatality line is the 50% point of the published curve',
  near(ANCHORS.pedKillSpeed * 3.6, 76.7, 0.3));
for (const [kmh, want] of [[30, 1.48], [45, 5.47], [50, 8.32], [80, 57.44]]) {
  const got = pedFatalityRisk(kmh / 3.6) * 100;
  console.log(`    fatality risk at ${kmh} km/h: ${got.toFixed(2)}% (published ${want}%)`);
  check(`the curve reproduces Rosen & Sander at ${kmh} km/h`, near(got, want, 0.02),
    `${got.toFixed(3)} vs ${want}`);
}
check('and it crosses 50% exactly at the anchor',
  near(pedFatalityRisk(ANCHORS.pedKillSpeed), 0.5, 0.002),
  `${(pedFatalityRisk(ANCHORS.pedKillSpeed) * 100).toFixed(2)}%`);
// KNOWN-BAD: the curve this used to quote, against the one it cited.
console.log('    KNOWN-BAD, the old 10/50/90 shape against the published curve:');
let worstRatio = 0;
for (const [kmh, old] of [[30, 10], [45, 50], [80, 90]]) {
  const got = pedFatalityRisk(kmh / 3.6) * 100;
  const ratio = old / got;
  worstRatio = Math.max(worstRatio, ratio);
  console.log(`      ${kmh} km/h: the old comment said ${old}%, the curve says ${got.toFixed(2)}% ` +
    `— ${ratio.toFixed(1)}x`);
}
check('KNOWN-BAD: the old figures are out by up to an order of magnitude', worstRatio > 5,
  `${worstRatio.toFixed(1)}x`);

// ---------------------------------------------------------------------------
// §9  The mass ratio, which is the reason there is no pedestrian special case.
// ---------------------------------------------------------------------------
console.log('\n§9  Mass ratios');
const CAR = 1400;
const massRows = [
  ['head-on, equal cars, 100 km/h closing', kmh(100), CAR, CAR],
  ['into a parked car, 50 km/h',            kmh(50),  CAR, CAR],
  ['into a 3500 kg van, 50 km/h',           kmh(50),  CAR, 3500],
  ['pedestrian (80 kg), 60 km/h',           kmh(60),  CAR, 80],
  ['pedestrian (80 kg), 100 km/h',          kmh(100), CAR, 80],
];
for (const [label, closing, ma, mb] of massRows) {
  const dv = pairDv(closing, ma, mb);
  console.log(`    ${label.padEnd(40)} dv ${dv.toFixed(3).padStart(6)} m/s  severity ${d.severityFor(dv).toFixed(4)}`);
}
// killDv is 13.9 m/s, which is 50.04 km/h rather than exactly 50, so the
// equivalence holds to 0.08% and not to the millimetre. Assert the fraction, and
// print it, rather than picking a tolerance that happens to pass.
const headOn = pairDv(kmh(100), CAR, CAR);
console.log(`    head-on at 100 km/h closing gives ${headOn.toFixed(4)} m/s against the ` +
  `${ANCHORS.killDv} m/s barrier anchor: ${(Math.abs(headOn / ANCHORS.killDv - 1) * 100).toFixed(3)}% apart`);
check('head-on between equals at 100 km/h closing IS the 50 km/h barrier test',
  Math.abs(headOn / ANCHORS.killDv - 1) < 0.002);
// The first draft of this check asserted a pedestrian can NEVER damage the car, and
// it failed: at 200 km/h the mass ratio gives 3.00 m/s, which clears the 8 km/h
// bumper threshold and scores 2.4%. That is the physics being right, not the model
// being wrong — a person struck at 200 km/h does dent a bonnet. The claim worth
// making is the one about speeds the car can actually reach.
const pedFast = pairDv(kmh(200), CAR, 80);
console.log(`    at a wholly unreachable 200 km/h: dv ${pedFast.toFixed(3)} m/s, ` +
  `severity ${d.severityFor(pedFast).toFixed(4)} — the model does not special-case people, and does not need to`);
check('a pedestrian costs under 1% of the car at any reachable speed',
  d.severityFor(pairDv(kmh(120), CAR, 80)) < 0.01,
  `dv ${pairDv(kmh(120), CAR, 80).toFixed(3)} -> ${d.severityFor(pairDv(kmh(120), CAR, 80)).toFixed(5)}`);
check('a heavier obstacle hurts more than a lighter one',
  pairDv(kmh(50), CAR, 3500) > pairDv(kmh(50), CAR, CAR));
check('pairDv rejects nonsense masses', pairDv(10, 0, 100) === 0 && pairDv(10, 100, -1) === 0);

// ---------------------------------------------------------------------------
// §9b  Moving bodies: the convoy case, which is the whole argument in one row.
// ---------------------------------------------------------------------------
console.log('\n§9b Contacts against moving bodies');
const S = [-1.2, -0.6, 0, 0.6, 1.2];
const carBase = { carX: 0, carZ: 0, fwdX: 0, fwdZ: 1, rightX: 1, rightZ: 0,
  samples: S, carRadius: 0.95, carMass: 1400 };
const dyn = (o) => dynamicContact({ ...carBase, ...o });
const CAR_B = { bodyRadius: 0.95, bodyMass: 1400 };
const dq = new DamageModel();
const dynRows = [
  ['head-on, 60 and 60',      { ...CAR_B, carVX: 0, carVZ: 16.67, bodyX: 0, bodyZ: 3.0, bodyVX: 0, bodyVZ: -16.67 }],
  ['convoy, both at 60',      { ...CAR_B, carVX: 0, carVZ: 16.67, bodyX: 0, bodyZ: 3.0, bodyVX: 0, bodyVZ: 16.67 }],
  ['rear-end, 60 into 40',    { ...CAR_B, carVX: 0, carVZ: 16.67, bodyX: 0, bodyZ: 3.0, bodyVX: 0, bodyVZ: 11.11 }],
  ['into a parked car at 50', { ...CAR_B, carVX: 0, carVZ: 13.89, bodyX: 0, bodyZ: 3.0, bodyVX: 0, bodyVZ: 0 }],
  ['side-swipe at 5 lateral', { ...CAR_B, carVX: 5, carVZ: 16.67, bodyX: 1.6, bodyZ: 0.6, bodyVX: 0, bodyVZ: 16.67 }],
  ['pedestrian, car at 60',   { bodyRadius: 0.35, bodyMass: 80, carVX: 0, carVZ: 16.67, bodyX: 0, bodyZ: 2.4, bodyVX: 1.2, bodyVZ: 0 }],
];
console.log('    case                       closing    charged dv   severity   contact (body space)');
for (const [label, o] of dynRows) {
  const r = dyn(o);
  if (!r) { console.log(`    ${label.padEnd(26)}   no contact / separating`); continue; }
  console.log(`    ${label.padEnd(26)} ${r.closing.toFixed(2).padStart(6)} m/s  ` +
    `${r.dv.toFixed(3).padStart(8)} m/s   ${dq.severityFor(r.dv).toFixed(4)}   ` +
    `(${r.dirX.toFixed(2)}, ${r.dirZ.toFixed(2)})  depth ${r.depth.toFixed(3)}`);
}
// THE ROW THAT MATTERS. Two cars travelling together at 60 that touch have a closing
// speed of zero; a model reading either car's SPEED calls that a write-off, and calls
// the head-on at 60 each — which is twice the barrier test — survivable. Backwards.
check('a convoy touch at 60 km/h is not a contact at all',
  dyn(dynRows[1][1]) === null);
check('KNOWN-BAD: a speed-based model would write the convoy car off',
  dq.severityFor(16.67) === 1);
check('a head-on at 60 each is twice the barrier and a write-off',
  near(dyn(dynRows[0][1]).closing, 2 * 16.67, 0.01) && dq.severityFor(dyn(dynRows[0][1]).dv) === 1);
check('a 60-into-40 rear-end costs a few per cent',
  dq.severityFor(dyn(dynRows[2][1]).dv) < 0.05,
  `${dq.severityFor(dyn(dynRows[2][1]).dv).toFixed(4)}`);
check('hitting a parked car at 50 is the barrier test halved',
  near(dyn(dynRows[3][1]).dv, 13.89 / 2 * 1.15, 0.01));
const swipe = dyn(dynRows[4][1]);
check('a side-swipe is filed to a side, not to the front',
  Math.abs(swipe.dirX) / 0.95 > Math.abs(swipe.dirZ) / 2.15,
  `dirX ${swipe.dirX.toFixed(2)} dirZ ${swipe.dirZ.toFixed(2)}`);
check('the side-swipe region is right or left',
  ['right', 'left'].includes(dq.regionWeights(swipe.dirX, swipe.dirZ).right > 0 ? 'right' : 'left'));
const pedHit = dyn(dynRows[5][1]);
check('a pedestrian is a contact', !!pedHit);
check('a pedestrian at 60 km/h costs the car essentially nothing',
  dq.severityFor(pedHit.dv) < 0.001, `${dq.severityFor(pedHit.dv).toFixed(6)}`);
// And the five samples matter here too: one enclosing circle would collide with a
// pedestrian well clear of the car.
const farPed = dyn({ bodyRadius: 0.35, bodyMass: 80, carVX: 0, carVZ: 16.67,
  bodyX: 2.0, bodyZ: 0, bodyVX: 0, bodyVZ: 0 });
console.log(`    a pedestrian 2.0 m to the side of the car's centre: ${farPed ? 'CONTACT' : 'clear'}`);
check('a pedestrian 2.0 m abeam is clear of the car', farPed === null);
check('KNOWN-BAD: one enclosing circle of 2.36 m would have hit them',
  Math.hypot(2.0, 0) < 2.36 + 0.35);
// A body exactly on the car's centre has no direction: must not return NaN.
const degen = dyn({ ...CAR_B, carVX: 0, carVZ: 10, bodyX: 0, bodyZ: 0, bodyVX: 0, bodyVZ: 0 });
check('a body at the car\'s exact centre gives finite numbers',
  degen && Number.isFinite(degen.dv) && Number.isFinite(degen.dirX) && Number.isFinite(degen.dirZ),
  JSON.stringify(degen));

// ---------------------------------------------------------------------------
// §10  Determinism, purity and cost.
// ---------------------------------------------------------------------------
console.log('\n§10  Determinism, purity, cost');
function crashRun() {
  const m = new DamageModel();
  // A deterministic pseudo-random crash sequence, seeded here rather than in the
  // module: src/damage.js must not contain a generator at all.
  let a = 12345;
  const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  for (let i = 0; i < 4000; i++) {
    m.update(1 / 120);
    if (i % 7 === 0) m.impact({ dv: rnd() * 16, kind: IMPACT.wall,
      dirX: rnd() * 2 - 1, dirZ: rnd() * 2 - 1, speed: rnd() * 30 });
  }
  return JSON.stringify(m.report());
}
const a1 = crashRun(), a2 = crashRun();
check('4,000 ticks and 572 impacts are bit-identical across runs', a1 === a2);
console.log(`    ${JSON.parse(a1).stats.impacts} impacts, ${JSON.parse(a1).stats.applied} applied, ` +
  `${JSON.parse(a1).stats.refracted} refracted, final health ${JSON.parse(a1).health}`);

// Purity: read the source with comments stripped, and prove the stripper works.
const src = fs.readFileSync(new URL('../src/damage.js', import.meta.url), 'utf8');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the comment stripper works (it removed the header)',
  src.includes('WHY IT LOOKS LIKE THIS') && !stripped.includes('WHY IT LOOKS LIKE THIS'));
for (const forbidden of ['Math.random', 'performance.now', 'Date.now', 'from \'three', 'document.', 'window.']) {
  check(`no ${forbidden} in src/damage.js`, !stripped.includes(forbidden));
}

// Cost. A per-frame cost has to be priced against the frame budget, per CLAUDE.md,
// or it is not a result.
const N = 200000;
const perf = new DamageModel();
let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) perf.update(1 / 120);
let updNs = Number(process.hrtime.bigint() - t0) / N;
const perf2 = new DamageModel();
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { perf2.impact({ dv: 5, dirX: 0.3, dirZ: 1, kind: IMPACT.wall }); perf2.time += 1; }
let impNs = Number(process.hrtime.bigint() - t0) / N;
console.log(`    update()  ${updNs.toFixed(3)} ns  = ${(updNs / 16.67e6 * 100).toFixed(6)}% of a 60 fps frame`);
console.log(`    impact()  ${impNs.toFixed(3)} ns  = ${(impNs / 16.67e6 * 100).toFixed(6)}% of a 60 fps frame`);
check('update() is under 1 us', updNs < 1000, `${updNs.toFixed(1)} ns`);
check('impact() is under 5 us', impNs < 5000, `${impNs.toFixed(1)} ns`);

// ---------------------------------------------------------------------------
// §10b  The crash voice: one exit, every record, and a hardness that is derived.
// ---------------------------------------------------------------------------
console.log('\n§10b The crash voice');
{
  const dm = new DamageModel();
  const seen = [];
  dm.onImpact = (rec) => seen.push(rec);
  // One of each outcome: applied, below-threshold, refracted, non-finite.
  dm.impact({ dv: kmh(50), kind: IMPACT.wall, dirX: 0, dirZ: 1 });
  dm.impact({ dv: 1.0, kind: IMPACT.wall, dirX: 0, dirZ: 1 });
  dm.impact({ dv: 3.0, kind: IMPACT.wall, dirX: 0, dirZ: 1 });
  dm.impact({ dv: 3.0, kind: IMPACT.wall, dirX: 0, dirZ: 1 });
  dm.impact({ dv: NaN, kind: IMPACT.wall, dirX: 0, dirZ: 1 });
  const reasons = seen.map((r) => r.reason);
  console.log(`    five impacts -> ${seen.length} records: ${reasons.join(', ')}`);
  /**
   * EVERY RECORD, NOT ONLY THE APPLIED ONES. impact()'s own doc says a caller that wants to
   * play a sound needs to know a graze happened even when it cost nothing — and the four
   * return paths each set `lastImpact` by hand, so a fifth would have forgotten one. They
   * now leave through `_finish`.
   */
  check('onImpact fires once per impact, whatever the outcome', seen.length === 5,
    `${seen.length}`);
  check('including the ones that cost nothing',
    reasons.includes('below-threshold') && reasons.includes('refractory')
      && reasons.includes('non-finite'), reasons.join(','));
  check('and the record it hands over is the one impact() returns',
    seen[0].applied === true && seen[0].dv > 0, JSON.stringify(seen[0]).slice(0, 80));
  // The hardness map, against the reduced mass it claims to be.
  const M = 1400, PED = 80;
  const reduced = { wall: M, vehicle: M / 2, pedestrian: (M * PED) / (M + PED) };
  for (const [kind, m] of Object.entries(reduced)) {
    const want = m / M, got = hardnessFor(kind);
    console.log(`    ${kind.padEnd(11)} reduced mass ${m.toFixed(1).padStart(6)} kg -> ` +
      `${want.toFixed(3)} against the shipped ${got}`);
    check(`${kind} hardness is its reduced-mass ratio`, Math.abs(got - want) < 0.001,
      `${got} vs ${want.toFixed(4)}`);
  }
  check('an unknown kind falls back to the loudest rather than to silence',
    hardnessFor('something-else') === 1.0, `${hardnessFor('something-else')}`);
  // And what that means in the mix, through audio.js's own gain law.
  const amp = (dv, h) => Math.pow(Math.min(1.25, Math.max(0.02, dv / 22)), 1.15) * 0.23
    * Math.min(2, Math.max(0.1, h));
  const dB = (a, b) => 20 * Math.log10(a / b);
  const wallAmp = amp(ANCHORS.killDv, hardnessFor('wall'));
  const pedDb = dB(amp(ANCHORS.killDv, hardnessFor('pedestrian')), wallAmp);
  const carDb = dB(amp(ANCHORS.killDv, hardnessFor('vehicle')), wallAmp);
  console.log(`    at the NCAP delta-v: a body ${pedDb.toFixed(1)} dB under masonry, ` +
    `a car ${carDb.toFixed(1)} dB`);
  check('a body strike is about 20 dB under the same blow into masonry',
    Math.abs(pedDb + 20) < 0.5, `${pedDb.toFixed(2)} dB`);
  check('and a car is 6 dB under it', Math.abs(carDb + 6) < 0.1, `${carDb.toFixed(2)} dB`);
}

// ---------------------------------------------------------------------------
// §11  The mission fail path this exists to light up.
// ---------------------------------------------------------------------------
console.log('\n§11  The mission fail path');
// Every driving stage of Marlin Street carries `healthBelow 0.2 -> failed`. Find the
// single square-on wall speed that crosses it, and check the number is sane: a
// player who hits a building at that speed should feel they deserved it.
let crossAt = 0;
for (let v = 0; v < 80; v += 0.01) {
  const m = new DamageModel();
  m.impact({ dv: kmh(v), dirX: 0, dirZ: 1 });
  if (m.health < 0.2) { crossAt = v; break; }
}
console.log(`    one square-on wall hit fails the mission at ${crossAt.toFixed(2)} km/h`);
check('a single wall hit fails the mission somewhere between 40 and 50 km/h',
  crossAt > 40 && crossAt < 50, `${crossAt.toFixed(2)} km/h`);
// And how many moderate knocks it takes, which is the other half of the feel.
const knocks = new DamageModel();
let n = 0;
while (knocks.health >= 0.2 && n < 100) { knocks.impact({ dv: kmh(25), dirX: 0, dirZ: 1 }); knocks.time += 1; n++; }
console.log(`    or ${n} separate 25 km/h knocks`);
check('25 km/h knocks take between 3 and 8 to fail a mission', n >= 3 && n <= 8, `${n}`);
const { MissionRunner } = await import('../src/mission.js');
const { MISSIONS } = await import('../src/missions.js');
// Drive the real mission with a real damage model in the loop and check the fail
// path actually fires, rather than asserting it from the numbers.
const marlinId = Object.keys(MISSIONS).find((k) => /marlin/i.test(k)) ?? Object.keys(MISSIONS)[0];
const marlin = MISSIONS[marlinId];
check('the authored mission this fail path belongs to is loadable', !!marlin, marlinId);
const runner = new MissionRunner();
const hp = new DamageModel();
runner.start(marlin);
// THE FIRST DRAFT OF THIS TEST CRASHED THE CAR ON THE WRONG STAGE and read `running`
// for 3,000 frames. `healthBelow` is on `ambush`, `drop` and `dropHot` — not on
// `toCar` or `eastbound`, because being run off the road before the ambush is not how
// that mission is meant to end. So the test has to drive to Five Points first, and a
// test that asserts a fail path has to prove it reached the stage that owns it.
let outcome = null, at = 0, reached = [];
for (let i = 0; i < 3000; i++) {
  const t = i / 30;
  const st = runner.report().stage;
  if (!reached.includes(st)) reached.push(st);
  // At Five Points from t=1s, so `eastbound` completes and `ambush` begins.
  const atFivePoints = t >= 1;
  if (st === 'ambush' && t >= 4) hp.impact({ dv: kmh(48), dirX: 0, dirZ: 1 });
  hp.update(1 / 30);
  const r = runner.update(1 / 30, {
    px: atFivePoints ? 57 : -471.21, pz: atFivePoints ? -164 : 204.55,
    speed: 12, inVehicle: true, health: hp.health,
    wantedStars: 2, wantedState: 'active',
  });
  if (r.outcome !== 'running') { outcome = r.outcome; at = t; break; }
}
console.log(`    Marlin Street, 48 km/h wall hit once on \`ambush\`: ${reached.join(' > ')} -> ${outcome} at ${at.toFixed(1)}s`);
check('the run reached the stage that owns the health trigger', reached.includes('ambush'),
  reached.join(' > '));
check('the real mission fails on real damage', outcome === 'failed', `${outcome} at ${at}`);

// ---------------------------------------------------------------------------
/**
 * THE CRIME SCALE, which nothing could see. A playtester found that writing the car off at
 * 110 km/h cost 0 stars while a 9 km/h pedestrian nudge cost 1, because `reportCrime`'s
 * `opts.scale` had never been passed by any caller since the day it was written. The fix landed
 * and all 120 checks in this file, 97 in wanted-test and 76 in crash-test still passed — none of
 * them looked at the charge. So these arms assert the QUANTITY THE CHANGE ALTERS, which is
 * CLAUDE.md's rule about a probe that measures the opportunity instead of the fix.
 */
console.log('\n' + '='.repeat(78));
console.log('CRIME SCALE — how big an offence was, not just which offence');
{
  const d = new DamageModel();
  // The record carries it, and it is the record's own severity over the module's own major line.
  const light = d.impact({ dv: kmh(20) * 1.15, kind: IMPACT.wall, dirX: 0, dirZ: 1, speed: kmh(20) });
  const d2 = new DamageModel();
  const heavy = d2.impact({ dv: kmh(110) * 1.15, kind: IMPACT.wall, dirX: 0, dirZ: 1, speed: kmh(110) });
  console.log(`  20 km/h:  severity ${light.severity.toFixed(3)}  crimeScale ${light.crimeScale.toFixed(2)}`);
  console.log(` 110 km/h:  severity ${heavy.severity.toFixed(3)}  crimeScale ${heavy.crimeScale.toFixed(2)}`);
  check('the impact record carries a crime scale', Number.isFinite(light.crimeScale),
    `${light.crimeScale}`);
  check('it is severity over the major-impact line',
    Math.abs(light.crimeScale - light.severity / d.majorSeverity) < 1e-12,
    `${light.crimeScale} vs ${light.severity / d.majorSeverity}`);
  check('a write-off scales up by more than 8x', heavy.crimeScale > 8 && heavy.crimeScale <= 1 / d.majorSeverity + 1e-9,
    `${heavy.crimeScale.toFixed(3)}`);
  check('and a light scrape scales DOWN', light.crimeScale < heavy.crimeScale && light.crimeScale > 0,
    `${light.crimeScale.toFixed(3)} < ${heavy.crimeScale.toFixed(3)}`);

  // Monotonic, and it has to actually move: a constant would pass a >0 test at every speed.
  let mono = true, seen = new Set();
  let prev = -1;
  for (const k of [10, 15, 20, 25, 30, 40, 50, 60]) {
    const m = new DamageModel();
    const r = m.impact({ dv: kmh(k) * 1.15, kind: IMPACT.wall, dirX: 0, dirZ: 1, speed: kmh(k) });
    if (r.crimeScale < prev - 1e-12) mono = false;
    prev = r.crimeScale;
    seen.add(r.crimeScale.toFixed(4));
  }
  check('the scale rises with speed and is not a constant', mono && seen.size >= 6,
    `${seen.size} distinct values over 8 speeds, monotonic ${mono}`);

  // No crime, no scale: a caller that passes it blindly must not invent heat out of a graze.
  const m = new DamageModel();
  const graze = m.impact({ dv: kmh(3), kind: IMPACT.wall, dirX: 0, dirZ: 1, speed: kmh(3) });
  check('a contact below the free threshold carries no crime and no scale',
    graze.crime === null && graze.crimeScale === 0, `${graze.crime} / ${graze.crimeScale}`);

  /**
   * THE BOUNDARY THE TWO PREDICATES DISAGREED ON. `_crimeFor` read `dv < freeDv` and
   * `severityFor` reads `!(a > freeDv)`, so at exactly `dv === freeDv` a crime was filed with a
   * severity of 0 — an offence that charged no heat, burned its refractory and reported itself
   * applied. Both now use the same test, and this is the arm that would fail if either moved.
   */
  const at = new DamageModel();
  const edge = at.impact({ dv: at.freeDv, kind: IMPACT.wall, dirX: 0, dirZ: 1, speed: at.freeDv });
  check('at exactly the free threshold there is no crime, matching severity 0',
    edge.crime === null && edge.severity === 0, `crime ${edge.crime}, severity ${edge.severity}`);

  // AND IT REACHES THE STARS. The scale is worth nothing if the ladder ignores it.
  const wl = new WantedSystem(), wh = new WantedSystem();
  wl.reportCrime('propertyDamage', { at: { x: 0, z: 0 }, scale: light.crimeScale });
  wh.reportCrime('propertyDamage', { at: { x: 0, z: 0 }, scale: heavy.crimeScale });
  console.log(`  one building hit:  20 km/h -> ${wl.stars}* (heat ${wl.heat.toFixed(2)})   ` +
    `110 km/h -> ${wh.stars}* (heat ${wh.heat.toFixed(2)})`);
  /**
   * RESTATED FROM `wh.stars >= 2`, WHICH ENCODED THE INVERSION THE CAP FIXES. The write-off
   * charged 2.50 and read two stars — more than the ONE a struck pedestrian reads at any
   * survivable speed, and two stars is the police actively hunting. `propertyDamage` has no `min`
   * at all, which is the table saying a wall is not on its own enough to make you wanted, so
   * src/wanted.js's FLOORLESS_CAP holds it to the lowest floor in the table: 1, the least a
   * struck person can cost. A write-off is now one star and a scrape is none.
   *
   * The property this arm exists for is unchanged — the scale REACHES the stars — and it is
   * still a 0-to-1 transition, which is the only transition a ceiling of 1 can show. The teeth
   * are kept by checking the raw product separately below: the cap is what holds the write-off
   * down, not a scale that stopped graduating.
   */
  /**
   * RESTATED AGAIN, AND THIS TIME THE GAMEPLAY MOVES, SO IT IS SAID OUT LOUD. The cap became a
   * soft knee (see src/wanted.js's `floorlessCharge`, and wanted-test §24 for the derivation),
   * and a knee is ASYMPTOTIC to the cap where a clip met it exactly. So:
   *
   *     one 110 km/h building hit   raw 2.50   clip 1.0000 -> 1 star   knee 0.9000 -> 0 stars
   *     two of them                 raw 5.00   clip 2.0000 -> 2        knee 1.8000 -> 1
   *
   * A SINGLE write-off into a building no longer makes you wanted, where it used to be worth
   * exactly one star. That is a change a player can feel and it was not the point of the fix, so
   * here is the argument for keeping it rather than tuning around it: `propertyDamage` has no
   * `min`, and this file's own comment above says what that means — "the table saying a wall is
   * not on its own enough to make you wanted". The clip set the ceiling AT the lowest floor,
   * which is one star, so it granted precisely the star the missing floor denies. Every floorless
   * crime at high severity landed on exactly one star, whatever it was. The knee makes the table's
   * own statement true at every severity instead of at every severity but the top.
   *
   * It is not immunity: the offences STACK. Two building hits are a star, and the recorded
   * 3,304 m drive that produced 11 `propertyDamage` offences reaches five either way.
   *
   * The alternative — give `propertyDamage` a `min` so a write-off is a star by right — is
   * recorded in docs/BACKLOG.md and was retracted there, because a floored crime is exempt from
   * the cap entirely and that re-creates the inversion #80 fixed: a write-off would out-charge a
   * struck pedestrian again.
   *
   * So the property this arm asserts is the SEPARATION and the ORDER, which is what it was always
   * for, plus the invariant the knee newly makes true.
   */
  console.log(`    two building hits at 110 km/h: heat ${(2 * wh.heat).toFixed(4)} -> ` +
    `${Math.min(5, Math.floor(2 * wh.heat))}*, so it stacks rather than being immunity`);
  check('a write-off charges far more than a scrape, which is what the scale is for',
    wh.heat > 1.5 * wl.heat && wl.stars === 0,
    `${wl.heat.toFixed(4)} vs ${wh.heat.toFixed(4)}, ${wl.stars}* vs ${wh.stars}*`);
  check('and no single floorless crime makes you wanted, which the clip granted at the ceiling',
    wh.stars === 0 && wh.heat < CRIME_TABLE.pedestrianHit.min,
    `${wh.heat.toFixed(4)} against the lowest floor ${CRIME_TABLE.pedestrianHit.min}`);
  check('but two of them do, so it is a threshold rather than an exemption',
    Math.floor(2 * wh.heat) >= 1, `2 x ${wh.heat.toFixed(4)} = ${(2 * wh.heat).toFixed(4)}`);
  check('and the cap is what holds it there, not a scale that stopped graduating',
    heavy.crimeScale > 4 * light.crimeScale && heavy.crimeScale > 8,
    `scale ${light.crimeScale.toFixed(2)} -> ${heavy.crimeScale.toFixed(2)}, ` +
    `raw heat ${(0.3 * heavy.crimeScale).toFixed(2)} charged as ${wh.heat.toFixed(2)}`);
  // The known-bad: the shipped behaviour before the fix. Both arms scale 1 and both read 0.
  const b1 = new WantedSystem(), b2 = new WantedSystem();
  b1.reportCrime('propertyDamage', { at: { x: 0, z: 0 } });
  b2.reportCrime('propertyDamage', { at: { x: 0, z: 0 } });
  check('and the unscaled call this replaced cannot tell them apart',
    b1.stars === b2.stars && b1.stars === 0 && Math.abs(b1.heat - b2.heat) < 1e-12,
    `both ${b1.stars}* at heat ${b1.heat.toFixed(2)} — the defect this arm exists for`);

  /**
   * THE PEDESTRIAN RANGE WHERE THE SCALE IS INVISIBLE, asserted rather than left as a comment.
   * `pedestrianHit` carries `min: 1` and `min` floors HEAT, so a scale under `min / heat` comes
   * back out as exactly 1.00 and the charge cannot move. That is deliberate — the escalation is
   * the switch to `pedestrianKilled` at a published fatality speed, not a curve.
   *
   * THE FIRST VERSION OF THIS CHECK ASSERTED HEAT === 1 UP TO 76 km/h AND FAILED AT 75, which is
   * CLAUDE.md's "a threshold that holds at one value" arriving in a check I had just written from
   * five sample points. The floor stops dominating where `heat * risk(v)/risk(pedKillSpeed) = 1`.
   * At `heat: 1.15` that was 73.8 km/h and the flat range ran 8-73.8; at 2.00 it is 64.5 and the
   * range runs 8-64.5, with the heat creeping 1.67 / 1.85 / 1.99 at 73 / 75 / 76.6 where it used
   * to creep 1.02 / 1.06 / 1.14. That is the whole point of the table move — see src/wanted.js —
   * and this arm needed NO edit to follow it, because it bisects the crossover off the table
   * instead of writing the number down. Stars stay at one across the whole non-fatal range
   * either way, since reaching two needs heat 2.00 and the scale caps at 1.00 at the switch.
   */
  const ref = pedFatalityRisk(d.pedKillSpeed);
  const pedScale = (k) => pedFatalityRisk(kmh(k)) / ref;
  const pedRows = [8, 20, 40, 60, 73, 75, 76.6].map((k) => {
    const w = new WantedSystem();
    w.reportCrime('pedestrianHit', { at: { x: 0, z: 0 }, scale: pedScale(k) });
    return { k, sc: pedScale(k), stars: w.stars, heat: w.heat };
  });
  // Where the min stops dominating, found by bisection on the curve rather than asserted.
  let lo = 0, hi = d.pedKillSpeed * 3.6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (CRIME_TABLE.pedestrianHit.heat * pedScale(mid) > CRIME_TABLE.pedestrianHit.min) hi = mid;
    else lo = mid;
  }
  console.log('  pedestrian below the kill speed: ' +
    pedRows.map((r) => `${r.k}km/h ${r.stars}* ${r.heat.toFixed(2)}`).join('  '));
  console.log(`  the min:1 floor stops dominating at ${hi.toFixed(1)} km/h ` +
    `(scale ${pedScale(hi).toFixed(3)} against 1/${CRIME_TABLE.pedestrianHit.heat} = ` +
    `${(CRIME_TABLE.pedestrianHit.min / CRIME_TABLE.pedestrianHit.heat).toFixed(3)})`);
  check('every non-fatal pedestrian hit is exactly one star, whatever the scale',
    pedRows.every((r) => r.stars === 1),
    pedRows.map((r) => `${r.k}:${r.stars}*`).join(' '));
  check('and the heat floor holds flat below the crossover it derives',
    pedRows.filter((r) => r.k < hi - 0.5).every((r) => Math.abs(r.heat - 1) < 1e-12)
      && pedRows.some((r) => r.k > hi + 0.5 && r.heat > 1),
    `crossover ${hi.toFixed(1)} km/h, ` + pedRows.map((r) => `${r.k}:${r.heat.toFixed(2)}`).join(' '));
  check('and the two pedestrian crimes join at 1.00 where the classification switches',
    Math.abs(pedFatalityRisk(d.pedKillSpeed) / ref - 1) < 1e-12,
    `scale at pedKillSpeed = ${(pedFatalityRisk(d.pedKillSpeed) / ref).toFixed(6)}`);
  const wk = new WantedSystem();
  const fast = kmh(110);
  wk.reportCrime('pedestrianKilled', { at: { x: 0, z: 0 }, scale: pedFatalityRisk(fast) / ref });
  console.log(`  and above it: 110 km/h -> ${wk.stars}* (heat ${wk.heat.toFixed(2)})`);
  check('above the kill speed the pedestrian charge does graduate', wk.stars > 2,
    `${wk.stars}* at heat ${wk.heat.toFixed(2)} against 2* unscaled`);

  /**
   * THE RUN-OVER CHARGE, WHICH LIVED IN district/main.js AND SO WAS UNGATEABLE. That site read
   * `r.fatal ? 'pedestrianKilled' : 'pedestrianHit'` and passed a literal `scale: 1`, under a
   * comment reasoning that a run-over has no delta-v so the table value must be the charge.
   * Correct about the delta-v; a PEDESTRIAN scale is a function of SPEED, which that site had.
   * `runOverCrime` is both halves in one place, next to the classifier they have to agree with.
   *
   * `charge-window` in mutation-sweep is the precedent: no offline gate imports
   * district/main.js, so a rule that lives there cannot be mutation-tested at all.
   */
  {
    const speeds = [0, 2, 8, 20, 40, 60, 73, 76.6, 76.8, 90, 110];
    const rows = speeds.map((k) => {
      const own = d.runOverCrime(kmh(k));                            // the module's own verdict
      const told = d.runOverCrime(kmh(k), k >= d.pedKillSpeed * 3.6); // the ped module's
      const w = new WantedSystem();
      w.reportCrime(own.crime, { at: { x: 0, z: 0 }, scale: own.scale });
      return { k, own, told, stars: w.stars, heat: w.heat };
    });
    console.log('  a run-over: ' + rows.map((r) =>
      `${r.k}km/h ${r.own.crime === 'pedestrianKilled' ? 'K' : 'h'}${r.stars}*` +
      `/${r.own.scale.toFixed(2)}`).join(' '));
    check('a run-over charge follows the speed, which a literal scale of 1 could not',
      rows[1].own.scale !== rows[9].own.scale &&
      rows.slice(1).every((r, i) => r.own.scale > rows[i].own.scale),
      rows.map((r) => r.own.scale.toFixed(4)).join(' '));
    check('and the caller\'s fatality verdict agrees with the classifier at every speed',
      rows.every((r) => r.own.crime === r.told.crime),
      rows.filter((r) => r.own.crime !== r.told.crime).map((r) => r.k).join(' ') || 'all agree');
    check('every non-fatal run-over is one star, which the old literal claimed without cause',
      rows.filter((r) => r.own.crime === 'pedestrianHit').every((r) => r.stars === 1),
      rows.filter((r) => r.own.crime === 'pedestrianHit')
        .map((r) => `${r.k}:${r.stars}*`).join(' '));
    check('and a fatal one is worse, so the two are not the same charge wearing two names',
      rows[rows.length - 1].stars > 1 &&
      rows[rows.length - 1].heat > rows.find((r) => r.k === 60).heat,
      `110 km/h ${rows[rows.length - 1].stars}* vs 60 km/h ` +
      `${rows.find((r) => r.k === 60).stars}*`);
    // A speed nothing sane produces still must not throw or return a non-finite scale.
    const bad = [NaN, Infinity, -30].map((v) => d.runOverCrime(v, false));
    check('a non-finite or negative speed reads as a finite scale, not a NaN charge',
      bad.every((b) => Number.isFinite(b.scale) && b.scale >= 0 && b.crime === 'pedestrianHit'),
      bad.map((b) => b.scale).join(' '));
  }

  /**
   * HOW MANY CRIMES NOTHING NAMES. It was ten of sixteen; `hitAndRun` has since been wired, because
   * it was the only one of the ten whose every input already existed — see `_watchScene` in
   * src/wanted.js and section 21 of wanted-test.
   *
   * The remaining nine are a priced refusal, not an oversight: the systems that would file them do
   * not exist. Weapons (brandish, discharge), theft (vehicleTheft), police on foot (assault,
   * officerAssault, officerDown), restricted zones (restrictedArea), the pursuit layer's own
   * `evading`, and reckless driving, which has no speed limit to break. The count is pinned so
   * adding a crime without a reporter is visible in the diff.
   */
  const named = ['propertyDamage', 'civilianCollision', 'pedestrianHit', 'pedestrianKilled',
    'policeProperty', 'roadblockRun', 'hitAndRun'];
  const orphans = Object.keys(CRIME_TABLE).filter((k) => !named.includes(k));
  console.log(`  crimes nothing files: ${orphans.length} of ${Object.keys(CRIME_TABLE).length} — ${orphans.join(', ')}`);
  check('the unreported-crime list is exactly the one that has been priced',
    orphans.length === 9, `${orphans.length}: ${orphans.join(', ')}`);
  check('and every crime something names is in the table',
    named.every((k) => k in CRIME_TABLE), `all ${named.length} exist in CRIMES`);
  // hitAndRun is filed by wanted.js itself rather than by a damage record, so it is named but not
  // classified by `_crimeFor` — the distinction the list above would otherwise blur.
  check('hitAndRun is filed by the wanted system, not by an impact',
    CRIME_TABLE.hitAndRun && !['propertyDamage', 'civilianCollision', 'pedestrianHit',
      'pedestrianKilled', 'policeProperty', 'roadblockRun'].includes('hitAndRun'),
    'reported from _watchScene');
}

// ---------------------------------------------------------------------------
/**
 * THE GARAGE, which exists because destroying the car was the fastest way to repair it. A
 * playtester measured it: a car at 0.686 health with no engine power and no repair but a console
 * call, where wrecking it on purpose hands back a perfect one. The owner chose "a garage you
 * drive to" over an automatic trickle, so the question this section answers is whether the zone
 * can be driven to, waited in, and refused for the three reasons it refuses for.
 *
 * WHY THESE ARMS AND NOT OTHERS. Each one is a defect this file or CLAUDE.md has already paid
 * for, arriving in a new module:
 *
 *   (a) THREE CONSTANTS, ONE COPY. The zone radius, the dwell and the stop threshold are
 *       OFFER_RADIUS_M, BUST_HOLD_S and SCENE_STOP_MS, owned by src/mission.js and
 *       src/wanted.js. src/damage.js must not import either — it is the bottom of the stack —
 *       so the host passes them in and this file asserts the fallbacks equal the real ones.
 *       A fallback that drifts is the second copy of a number, which CLAUDE.md names as the
 *       recurring defect in this repo.
 *   (b) SIMULATED TIME, SWEPT. "Two holds were counting rendered frames instead of simulated
 *       time" — the wreck hold and the bust hold both did, and under ?timeScale=40 a four-second
 *       wreck hold took 160 s. The dwell is `+= dt`, which is correct, and a gate that runs at
 *       one dt cannot tell that from `+= 1/60`. Both are run at four step sizes here and the
 *       frame-counting version is the known-bad.
 *   (c) THE DWELL RESETS, IT DOES NOT DECAY. A decaying dwell lets a player bank progress over
 *       many short visits, which makes the "hold still" instruction a lie. The known-bad is that
 *       version and it repairs on a vehicle that never once stood still for the hold.
 *   (d) EVERY REFUSAL IS SEPARABLE. A 2x2x2 over hurt/wanted/moving, so no single predicate can
 *       be deleted without a row moving. A sweep like this is what blocker-test's six-case
 *       condition table is for, and it is the answer to "a guard that covers half a case reads
 *       as a guard".
 *   (e) THE BAND LINE CARRIES ITS OWN SUBTITLE AND ITS OWN UNIT. src/hud.js's
 *       HOLDS_MISSION_SUBTITLE ate composeLaw's "reverse" for a round, and the bust countdown
 *       shipped a dropped `unit` that read "3 m" for three seconds. Both are one token and both
 *       are asserted on every branch.
 */
console.log('\n' + '='.repeat(78));
console.log('THE GARAGE — the repair a player can reach');
{
  const G = { x: -67.9, z: 60.3 };
  const hurtCar = (over = {}) => ({ x: G.x, z: G.z, speed: 0, wantedStars: 0, health: 0.5, ...over });

  // (a) ------------------------------------------------------------------
  const bare = new Garage({ x: G.x, z: G.z });
  console.log(`  fallbacks: radius ${bare.radius} holdS ${bare.holdS} stopMs ${bare.stopMs}` +
    `  against OFFER_RADIUS_M ${OFFER_RADIUS_M} BUST_HOLD_S ${BUST_HOLD_S} SCENE_STOP_MS ${SCENE_STOP_MS}`);
  check('the zone radius falls back to the mission layer’s own offer radius',
    bare.radius === OFFER_RADIUS_M, `${bare.radius} === ${OFFER_RADIUS_M}`);
  check('the dwell falls back to the bust hold, which is the same beat',
    bare.holdS === BUST_HOLD_S, `${bare.holdS} === ${BUST_HOLD_S}`);
  check('the stop threshold falls back to the wanted layer’s own stop threshold',
    bare.stopMs === SCENE_STOP_MS, `${bare.stopMs} === ${SCENE_STOP_MS}`);

  // (b) ------------------------------------------------------------------
  /**
   * The repair time, measured by running the dwell at four step sizes and recording the
   * SIMULATED time at which `repaired` comes back true. Sub-stepping is not available here —
   * the dwell is a scalar the host advances — so the figure lands within one step of the hold
   * by construction, and the claim is that the spread is BOUNDED BY THE STEP rather than that
   * it is zero. The known-bad is a version that adds a fixed 1/60 whatever dt is: at dt 1/6 it
   * takes ten times as long, which is the ?timeScale defect in one number.
   */
  const dts = [1 / 120, 1 / 60, 1 / 30, 1 / 6];
  const realAt = [], frameAt = [];
  for (const dt of dts) {
    const g = new Garage({ x: G.x, z: G.z, radius: OFFER_RADIUS_M, holdS: BUST_HOLD_S,
      stopMs: SCENE_STOP_MS });
    let t = 0, fired = null;
    for (let i = 0; i < 40000 && fired === null; i++) {
      t += dt;
      if (g.update(dt, hurtCar()).repaired) fired = t;
    }
    realAt.push(fired);
    // The frame-counting version: the same code with the step replaced by a constant.
    let ft = 0, fdwell = 0, ffired = null;
    for (let i = 0; i < 40000 && ffired === null; i++) {
      ft += dt;
      fdwell += 1 / 60;
      if (fdwell >= BUST_HOLD_S) ffired = ft;
    }
    frameAt.push(ffired);
  }
  console.log('    dt            repair at (sim s)   frame-counting version');
  for (let i = 0; i < dts.length; i++) {
    console.log(`    ${(1 / dts[i]).toFixed(0).padStart(3)} Hz` +
      `       ${realAt[i].toFixed(4).padStart(8)}` +
      `            ${frameAt[i].toFixed(4).padStart(8)}`);
  }
  /**
   * THE BOUND IS THE PROPERTY, NOT A TUNED TOLERANCE. A dwell advanced by `+= dt` crosses the
   * hold on the first step at or after it, so the repair's simulated time lies in
   * [holdS, holdS + dt] — one step wide, by construction, at every step size. 1e-6 is the
   * accumulated float error of summing 1/6 twenty-four times, which is why 6 Hz needs a
   * twenty-fifth step for a hold that divides exactly into twenty-four.
   */
  const inWindow = realAt.every((v, i) => v >= BUST_HOLD_S - 1e-6 && v <= BUST_HOLD_S + dts[i] + 1e-6);
  const worstErr = Math.max(...realAt.map((v, i) => (v - BUST_HOLD_S) / dts[i]));
  check('the repair lands in [hold, hold + dt] at every step size, which is the exact property',
    inWindow, `worst ${worstErr.toFixed(4)} steps late, never early`);
  const realSpread = Math.max(...realAt) - Math.min(...realAt);
  check('and the spread across step sizes is bounded by the coarsest step',
    realSpread <= Math.max(...dts) + 1e-9,
    `${realSpread.toFixed(4)} s against a ${Math.max(...dts).toFixed(4)} s step`);
  const frameSpread = Math.max(...frameAt) - Math.min(...frameAt);
  check('KNOWN-BAD: counting frames instead of seconds makes the hold depend on the frame rate',
    frameSpread > 10 * realSpread && frameAt[3] > 8 * BUST_HOLD_S,
    `spread ${frameSpread.toFixed(2)} s against ${realSpread.toFixed(4)}; at 6 Hz it takes ` +
    `${frameAt[3].toFixed(1)} s for a ${BUST_HOLD_S} s hold`);

  // (c) ------------------------------------------------------------------
  /**
   * BANKING. Three visits of 1.6 s each, driving out between them, against a 4 s hold. The real
   * garage repairs nothing — it is three resets — and the decaying version repairs on the third,
   * never having held the car still for the hold at all.
   */
  const dt = 1 / 60;
  const visit = (g, hold, s) => {
    let fired = 0;
    for (let t = 0; t < s; t += dt) if (g.update(dt, hurtCar()).repaired) fired++;
    // out of the zone and back
    for (let t = 0; t < 2; t += dt) g.update(dt, hurtCar({ x: G.x + 400 }));
    return fired;
  };
  const real = new Garage({ x: G.x, z: G.z, holdS: BUST_HOLD_S });
  let realFired = 0;
  for (let k = 0; k < 3; k++) realFired += visit(real, BUST_HOLD_S, 1.6);
  /**
   * The decaying version, written out rather than patched, so the only difference between the two
   * is the reset. The leak is a tenth of the fill rate, which is the generous case for the broken
   * version — ANY leak slower than the fill banks, and a faster one is a reset with extra steps.
   * Three 1.6 s visits is 4.8 s of holding against a 4 s hold, minus 0.4 s of leak over the two
   * gaps, so it fires on the third visit having never once stood still for four seconds.
   */
  let decay = 0, decayFired = 0;
  for (let k = 0; k < 3; k++) {
    for (let t = 0; t < 1.6; t += dt) {
      decay += dt;
      if (decay >= BUST_HOLD_S) { decay = 0; decayFired++; }
    }
    for (let t = 0; t < 2; t += dt) decay = Math.max(0, decay - dt * 0.1);
  }
  console.log(`    three 1.6 s visits against a ${BUST_HOLD_S} s hold:` +
    ` resetting ${realFired} repairs, decaying ${decayFired}`);
  check('three visits too short to finish the hold repair nothing',
    realFired === 0, `${realFired} repairs; dwell left at ${real.dwell}`);
  check('and the dwell is zero after leaving, not merely smaller',
    real.dwell === 0, `${real.dwell}`);
  check('KNOWN-BAD: a dwell that decays instead of resetting can be banked over short visits',
    decayFired > 0, `${decayFired} repairs without ever holding ${BUST_HOLD_S} s`);

  // (d) ------------------------------------------------------------------
  /**
   * THE 2x2x2. Every row runs the full hold and reports whether it repaired, so a deleted
   * predicate moves a row. `inside` is swept separately below because its false case is the
   * only one where the module returns before any counter can move.
   */
  const rows = [];
  for (const hurt of [true, false]) {
    for (const wanted of [0, 2]) {
      for (const speed of [0, 8]) {
        const g = new Garage({ x: G.x, z: G.z, holdS: BUST_HOLD_S, stopMs: SCENE_STOP_MS });
        let fired = 0;
        // Two holds' worth of steps plus the one the second repair lands ON: a dwell of `+= dt`
        // crosses the hold on the step AFTER it, so `2 * holdS / dt` iterations contain one
        // repair and not two. The first draft read `1 repairs in two holds` and the arm below
        // caught it.
        for (let t = 0; t < BUST_HOLD_S * 2 + dt * 2; t += dt) {
          if (g.update(dt, hurtCar({ health: hurt ? 0.5 : 1, wantedStars: wanted, speed })).repaired) fired++;
        }
        rows.push({ hurt, wanted, speed, fired, ...g.stats });
      }
    }
  }
  console.log('    hurt  wanted  speed   repairs  refusedWanted  refusedMoving');
  for (const r of rows) {
    console.log(`    ${String(r.hurt).padEnd(5)} ${String(r.wanted).padStart(6)} ` +
      `${String(r.speed).padStart(6)}   ${String(r.fired).padStart(7)} ` +
      `${String(r.refusedWanted).padStart(14)} ${String(r.refusedMoving).padStart(14)}`);
  }
  const only = rows.filter((r) => r.fired > 0);
  check('exactly one of the eight states repairs, and it is the undamaged-car exclusion too',
    only.length === 1 && only[0].hurt && only[0].wanted === 0 && only[0].speed === 0,
    `${only.length} rows repaired: ${only.map((r) => `hurt=${r.hurt} w=${r.wanted} v=${r.speed}`).join('; ')}`);
  check('and it repairs once per hold rather than once per frame',
    only[0].fired === 2, `${only[0].fired} repairs in two holds`);
  /**
   * EACH REFUSAL COUNTED, which is CLAUDE.md's "every arm has to assert that the thing it is
   * measuring HAPPENED". A wanted row whose refusedWanted is 0 did not refuse for that reason,
   * it just never got there.
   */
  const wantedRow = rows.find((r) => r.hurt && r.wanted === 2 && r.speed === 0);
  const movingRow = rows.find((r) => r.hurt && r.wanted === 0 && r.speed === 8);
  check('the wanted refusal fires for being wanted, and is counted',
    wantedRow.refusedWanted > 0 && wantedRow.refusedMoving === 0,
    `wanted ${wantedRow.refusedWanted}, moving ${wantedRow.refusedMoving}`);
  check('the moving refusal fires for moving, and is counted',
    movingRow.refusedMoving > 0 && movingRow.refusedWanted === 0,
    `moving ${movingRow.refusedMoving}, wanted ${movingRow.refusedWanted}`);
  const fineRow = rows.find((r) => !r.hurt && r.wanted === 0 && r.speed === 0);
  check('an undamaged car is refused SILENTLY, with no refusal charged against it',
    fineRow.fired === 0 && fineRow.refusedWanted === 0 && fineRow.refusedMoving === 0,
    `entries ${fineRow.entries}, refusals ${fineRow.refusedWanted + fineRow.refusedMoving}`);

  // the zone edge, swept, because a radius is a threshold and thresholds are what this file sweeps
  {
    const g = new Garage({ x: G.x, z: G.z, radius: OFFER_RADIUS_M, holdS: BUST_HOLD_S });
    const insideAt = [];
    for (const d of [0, OFFER_RADIUS_M - 0.01, OFFER_RADIUS_M, OFFER_RADIUS_M + 0.01, 400]) {
      insideAt.push([d, g.update(dt, hurtCar({ x: G.x + d })).inside]);
    }
    console.log(`    the zone edge: ${insideAt.map(([d, i]) => `${d.toFixed(2)}m ${i ? 'in' : 'out'}`).join(', ')}`);
    check('the zone is the radius, closed at the edge and open beyond it',
      insideAt[0][1] && insideAt[1][1] && insideAt[2][1] && !insideAt[3][1] && !insideAt[4][1],
      insideAt.map(([d, i]) => `${d}:${i}`).join(' '));
    check('and a car outside it has no dwell and no entry',
      g.dwell === 0, `dwell ${g.dwell}`);
  }

  // (e) ------------------------------------------------------------------
  /**
   * THE BAND LINE. Four states, and the assertions are on the three things a composer in this
   * project gets wrong: a missing `ownSubtitle`, a missing `unit`, and a line shown when there is
   * nothing to say.
   */
  const line = (g, player) => composeGarage(g, player);
  const g2 = new Garage({ x: G.x, z: G.z, radius: OFFER_RADIUS_M, holdS: BUST_HOLD_S,
    stopMs: SCENE_STOP_MS });
  const out = line(g2.update(dt, hurtCar({ x: G.x + 400 })), { health: 0.5, wantedStars: 0, speed: 0 });
  const moving = line(g2.update(dt, hurtCar({ speed: 8 })), { health: 0.5, wantedStars: 0, speed: 8 });
  const wantedL = line(g2.update(dt, hurtCar({ wantedStars: 3 })), { health: 0.5, wantedStars: 3, speed: 0 });
  g2.update(dt, hurtCar());
  const holding = line(g2.report(), { health: 0.5, wantedStars: 0, speed: 0 });
  const fine = line(g2.update(dt, hurtCar({ health: 1 })), { health: 1, wantedStars: 0, speed: 0 });
  const shown = [moving, wantedL, holding].filter(Boolean);
  console.log(`    out: ${out === null ? 'null' : objectiveLine(out.objective)}` +
    ` | moving: "${objectiveLine(moving.objective)}" / "${moving.subtitle}"` +
    ` | wanted: "${objectiveLine(wantedL.objective)}" / "${wantedL.subtitle}"` +
    ` | holding: "${objectiveLine(holding.objective)}" / "${holding.subtitle}"` +
    ` | perfect: ${fine === null ? 'null' : objectiveLine(fine.objective)}`);
  check('outside the zone the band says nothing about the garage',
    out === null, `${JSON.stringify(out)}`);
  check('a perfect car in the zone says nothing either',
    fine === null, `${JSON.stringify(fine)}`);
  check('all three live states carry their own subtitle, so the mission objective cannot eat it',
    shown.length === 3 && shown.every((l) => l.ownSubtitle === true),
    shown.map((l) => `${l.ownSubtitle}`).join(' '));
  check('and each one says something different, because three identical lines are one cue',
    new Set(shown.map((l) => `${objectiveLine(l.objective)}|${l.subtitle}`)).size === 3,
    shown.map((l) => l.subtitle).join(' / '));
  check('the countdown is in SECONDS and says so, which the bust countdown once did not',
    holding.objective.unit === 's' && Number.isInteger(holding.objective.distance) &&
    holding.objective.distance >= 1 && holding.objective.distance <= BUST_HOLD_S,
    `${objectiveLine(holding.objective)}`);
  check('the two refusals do not pretend to be a countdown',
    moving.objective.distance === undefined && wantedL.objective.distance === undefined,
    `${JSON.stringify(moving.objective)} ${JSON.stringify(wantedL.objective)}`);
  /**
   * THE FRAME THE REPAIR LANDS ON. `update()` zeroes the dwell before reporting, so without the
   * `repaired` guard this frame is indistinguishable from "just arrived" and flashes "stop here"
   * at the moment of success — for a host that composes before applying the repair. Asserted at
   * the UNREPAIRED health, which is the order that would show the flash.
   */
  const g3 = new Garage({ x: G.x, z: G.z, holdS: BUST_HOLD_S });
  let fired = null;
  for (let t = 0; t < BUST_HOLD_S * 2 && fired === null; t += dt) {
    const r = g3.update(dt, hurtCar());
    if (r.repaired) fired = r;
  }
  check('the repair frame reports itself, so the host has something to act on',
    fired && fired.repaired === true, `${JSON.stringify(fired)}`);
  check('and the band says nothing on it whichever order the host composes in',
    line(fired, { health: 0.5, wantedStars: 0, speed: 0 }) === null &&
    line(fired, { health: 1, wantedStars: 0, speed: 0 }) === null,
    `before ${JSON.stringify(line(fired, { health: 0.5, wantedStars: 0, speed: 0 }))}`);
  check('the minimap blip is the style src/hud.js has carried since it was written',
    g3.marker().kind === 'shop' && g3.marker().x === G.x && g3.marker().z === G.z,
    JSON.stringify(g3.marker()));
  /**
   * AND A BARE `report()` CARRIES THE DISTANCE, which is a field that only existed on one of two
   * call paths. `report(d)` takes it as an argument, so `update()` supplies it and a HOST HOOK
   * calling `report()` got null — boot-check's first run printed `distance: -1` on every frame of
   * the drive in while the number was correct the whole time, and the probe was asking a function
   * that had not been told.
   */
  const g4 = new Garage({ x: G.x, z: G.z, radius: OFFER_RADIUS_M });
  g4.update(dt, hurtCar({ x: G.x + 37.5 }));
  console.log(`    a bare report() after a frame 37.5 m out: ` +
    `distance ${g4.report().distance}, inside ${g4.report().inside}`);
  check('a bare report() carries the distance the last frame measured',
    Math.abs(g4.report().distance - 37.5) < 1e-9, `${g4.report().distance}`);
  check('and a fresh one has no distance rather than a wrong one',
    new Garage({ x: G.x, z: G.z }).report().distance === null,
    `${new Garage({ x: G.x, z: G.z }).report().distance}`);
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nDAMAGE MODEL: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nDAMAGE MODEL: PASS — ${checks.length} checks`);
