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
  pedFatalityRisk } from '../src/damage.js';
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
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nDAMAGE MODEL: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nDAMAGE MODEL: PASS — ${checks.length} checks`);
