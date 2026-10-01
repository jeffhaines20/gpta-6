// Deterministic gate for the wanted / police-response state machine.
//
// No browser, no renderer, no three.js: src/wanted.js is pure state and timers,
// so the whole police response can be driven through an hour of game time in a
// few milliseconds and must land on the same numbers every run. That property is
// itself one of the assertions here (§12) — the moment this module needs a scene
// to answer a question, it has stopped being testable and has started being a
// place bugs hide.
//
//   node tools/wanted-test.mjs
//
// Prints a scenario trace and a measurement block, then a PASS/FAIL gate line.
// Exits 1 on any failed check.

import fs from 'node:fs';
import { WantedSystem, CRIMES, RESPONSE, STATES, bindPursuit,
  SCENE_LEAVE_M, SCENE_STOP_MS, VictimWindow,
  composeWanted, composeLaw, LAW_NOTICE_S, BUST_HOLD_S } from '../src/wanted.js';
import { objectiveLine, composeBand } from '../src/hud.js';
import { DamageModel, IMPACT } from '../src/damage.js';

const DT = 1 / 30;                      // the rate the game reports at, fixed
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A player that stands still unless told otherwise. `seen` is the host's
// line-of-sight verdict; omitting it makes the module fall back to unit
// proximity, which is exactly what §7 exercises.
function run(w, seconds, at, opts = {}) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const p = typeof at === 'function' ? at(w.time, i) : { ...at };
    if (opts.seen !== undefined) p.seen = opts.seen;
    opts.each?.(w, i, p);
    w.update(DT, p);
  }
  return w;
}

const events = (w, keep = null) => {
  const log = [];
  w.on('*', (e, p) => { if (!keep || keep.includes(e)) log.push({ t: +w.time.toFixed(2), e, ...p }); });
  return log;
};

const out = {};
const ORIGIN = { x: 0, z: 0 };

// ---------------------------------------------------------------- 1. cold start
{
  const w = new WantedSystem({ seed: 1 });
  run(w, 2, ORIGIN);
  check('cold start is clear', w.stars === 0 && w.state === STATES.CLEAR);
  check('cold start requests no units', w.plan.units === 0 && w.plan.assignments.length === 0);
  check('cold start has no last known position', w.lastKnown.valid === false);
  out.cold = { stars: w.stars, state: w.state, units: w.plan.units };
}

// ------------------------------------------------- 2. minor crimes accumulate
{
  const w = new WantedSystem({ seed: 2 });
  const log = events(w, ['escalate']);
  const trace = [];
  for (let k = 0; k < 3; k++) {
    w.reportCrime('reckless', { at: ORIGIN });
    run(w, 3.1, ORIGIN);                        // 3.1 s, just past the 3 s refractory
    trace.push({ k, heat: +w.heat.toFixed(2), stars: w.stars });
  }
  check('two reckless events are still zero stars', trace[1].stars === 0, trace[1]);
  check('three reckless events make one star', trace[2].stars === 1, trace[2]);
  check('exactly one escalation fired', log.length === 1, log);
  out.accumulation = trace;
}

// ---------------------------------------------------------------- 3. refractory
{
  const w = new WantedSystem({ seed: 3 });
  let applied = 0;
  for (let i = 0; i < 30; i++) if (w.reportCrime('reckless', { at: ORIGIN }).applied) applied++;
  check('30 reckless reports in one frame count once', applied === 1, { applied });
  check('...and do not reach a star', w.stars === 0, { heat: w.heat });
  out.refractory = { reports: 30, applied, heat: +w.heat.toFixed(3) };
}

// ------------------------------------------------------- 4. sub-star heat bleed
{
  const w = new WantedSystem({ seed: 4 });
  w.reportCrime('reckless', { at: ORIGIN });
  const heat0 = w.heat;
  run(w, 2, ORIGIN);                            // inside the grace window
  const heatGrace = w.heat;
  run(w, 20, ORIGIN);
  check('heat holds during the grace window', near(heatGrace, heat0, 1e-6), { heat0, heatGrace });
  check('sub-star heat bleeds to zero', w.heat === 0 && w.stars === 0, { heat: w.heat });
  out.bleed = { heat0: +heat0.toFixed(3), afterGrace: +heatGrace.toFixed(3), after22s: w.heat };
}

// -------------------------------------------- 5. escalation and per-star response
/**
 * THE SUBJECT HERE IS THE RESPONSE TABLE, NOT THE CHARGE, so the ladder is built out of crimes
 * whose charge does not depend on a scale. It used to open with `pedestrianHit`, reported
 * unscaled, and so was quietly asserting that crime's table heat: when §24 moved it 1.15 -> 2.00
 * these three checks failed, correctly, and the failure was the only thing that said the change
 * had a second consequence. `vehicleTheft` is heat 1.00 / min 1 and takes no scale at all, and
 * the ladder it builds is step-for-step the one pedestrianHit built — 1, 2, 3, 5 stars.
 *
 * What §24 owns instead is the pedestrian charge swept over speed, with the scale the game
 * actually passes. Asserted here too, at the bottom, because an unscaled report is now the
 * REFERENCE case — the curve's 50% point — rather than the mild one, and that is a trap for any
 * new caller that forgets the scale.
 */
{
  const w = new WantedSystem({ seed: 5 });
  const requests = events(w, ['unit:request']);
  const steps = [];
  for (const id of ['vehicleTheft', 'discharge', 'policeProperty', 'officerDown']) {
    w.reportCrime(id, { at: ORIGIN });
    run(w, 1.5, ORIGIN, { seen: true });
    steps.push({
      crime: id, stars: w.stars, heat: +w.heat.toFixed(2), units: w.plan.units,
      spawn: [w.plan.spawnMin, w.plan.spawnMax], giveUp: w.plan.giveUpRadius,
      speedMul: w.plan.speedMul, intercept: w.plan.intercept,
      roles: w.plan.assignments.map((a) => a.role).join('+'),
    });
  }
  check('a taken car is one star', steps[0].stars === 1, steps[0]);
  check('one star fields one unit and does not intercept',
    steps[0].units === 1 && steps[0].intercept === false, steps[0]);
  check('escalation raises the unit count', steps[3].units > steps[0].units, steps.map((s) => s.units));
  check('escalation widens the spawn radius', steps[3].spawn[1] > steps[0].spawn[1]);
  check('intercept switches on at three stars',
    steps[2].stars === 3 && steps[2].intercept === true, steps[2]);
  check('three stars assign at least one interceptor',
    steps[2].roles.includes('intercept'), steps[2].roles);
  check('officer down is a five star response', steps[3].stars === 5, steps[3]);
  check('units were requested once each, cumulatively',
    requests.length === 1 + 1 + 2 + 4, { requested: requests.length });
  out.escalation = steps;

  /**
   * AND WHAT AN UNSCALED PEDESTRIAN REPORT MEANS, stated rather than left latent. `heat` is the
   * charge at scale 1, and src/damage.js normalises the pedestrian scale AT `pedKillSpeed`, so
   * scale 1 is the fatality threshold and an unscaled strike is the reference case. Two stars.
   * Every production caller passes a scale; a new one that forgets is asking for the worst
   * survivable case, which is the safe direction to fail but not an obvious one.
   */
  const bare = new WantedSystem({ seed: 5 });
  bare.reportCrime('pedestrianHit', { at: ORIGIN });
  const scaled = new WantedSystem({ seed: 5 });
  scaled.reportCrime('pedestrianHit', { at: ORIGIN, scale: new DamageModel().pedCrimeScale(8 / 3.6) });
  console.log(`\n5b. an unscaled pedestrianHit is ${bare.stars} star(s) at heat ${bare.heat}; ` +
    `an 8 km/h clip with the game's own scale is ${scaled.stars} at ${scaled.heat.toFixed(2)}`);
  check('an unscaled pedestrian report is the reference case, which is two stars',
    bare.stars === 2 && bare.heat === CRIMES.pedestrianHit.heat, { stars: bare.stars, heat: bare.heat });
  check('and the scale the game passes puts an 8 km/h clip back on the floor at one star',
    scaled.stars === 1 && Math.abs(scaled.heat - CRIMES.pedestrianHit.min) < 1e-9,
    { stars: scaled.stars, heat: scaled.heat });
}

// ---------------------------------------------------------- 6. hard star floors
{
  const w = new WantedSystem({ seed: 6 });
  const r = w.reportCrime('officerDown', { at: ORIGIN });
  check('a crime floor applies from a clean sheet', r.stars === 4, r);
  const w2 = new WantedSystem({ seed: 6 });
  const ignored = w2.reportCrime('evading', { at: ORIGIN });
  check('evading is meaningless with no wanted level',
    ignored.applied === false && ignored.reason === 'no-wanted-level', ignored);
  out.floors = { officerDown: r.stars, evadingIgnored: ignored.reason };
}

// ------------------------------------- 6b. an unwitnessed crime still anchors
// The failure this guards against: with no fix and no anchor, `search` quietly
// degrades into "target = wherever the player is", i.e. the teleport the whole
// state exists to prevent.
{
  const SCENE = { x: -140, z: 260 };
  const w = new WantedSystem({ seed: 61 });
  w.reportCrime('pedestrianKilled', { at: SCENE, witnessed: false });
  run(w, 1, SCENE);
  check('an unwitnessed crime hands over no fresh fix', w.hasFreshFix === false);
  check('an unwitnessed crime goes straight to the search state', w.state === STATES.SEARCH, w.state);
  check('the search anchors on the scene of the crime',
    near(w.lastKnown.x, SCENE.x, 1e-9) && near(w.lastKnown.z, SCENE.z, 1e-9), w.lastKnown);
  run(w, 12, (t) => ({ x: SCENE.x + (t - 1) * 25, z: SCENE.z }));
  check('the anchor does not follow the player away from the scene',
    near(w.plan.target.x, SCENE.x, 1e-9), { target: w.plan.target, scene: SCENE });

  // The degenerate case: a crime with no position at all and nothing known yet.
  const w2 = new WantedSystem({ seed: 62 });
  w2.reportCrime('assault', { witnessed: false });
  run(w2, 1, { x: 500, z: -300 });
  const anchor = { ...w2.lastKnown };
  run(w2, 8, (t) => ({ x: 500 + t * 25, z: -300 }));   // short of the 1-star escape
  check('a crime with no position still freezes an anchor',
    w2.state === STATES.SEARCH && w2.lastKnown.valid && near(w2.plan.target.x, anchor.x, 1e-9),
    { state: w2.state, anchor, target: w2.plan.target });
  out.unwitnessed = { scene: SCENE, anchor: { x: +anchor.x.toFixed(1), z: +anchor.z.toFixed(1) },
    state: w.state };
}

// ------------------------------------------------------------------ 7. search
let searchSample;
{
  const w = new WantedSystem({ seed: 7 });
  w.reportCrime('policeProperty', { at: ORIGIN });
  w.reportCrime('discharge', { at: ORIGIN });
  // Longer than witnessSeconds: a reported crime hands dispatch a live fix for a
  // few seconds, and the search must be measured from where that fix ran out,
  // not from the moment the button was pressed.
  run(w, w.witnessSeconds + 2, ORIGIN, { seen: true });
  const stars = w.stars;
  const contactPos = { x: 0, z: 0 };
  const t0 = w.time;

  // Contact breaks, and the player keeps driving east at 25 m/s.
  const drive = (t) => ({ x: (t - t0) * 25, z: 0 });
  run(w, 10, drive, { seen: false });
  const lk = { ...w.lastKnown };
  const playerNow = drive(w.time);
  const r10 = w.searchRadius, evade10 = w.evadeTimer;
  run(w, 10, drive, { seen: false });
  const r20 = w.searchRadius;

  check('losing contact enters the search state', w.state === STATES.SEARCH, w.state);
  check('the last known position is frozen where contact broke',
    near(lk.x, contactPos.x, 1.5) && near(lk.z, contactPos.z, 1.5), lk);
  check('police do NOT teleport to the player',
    Math.hypot(playerNow.x - lk.x, playerNow.z - lk.z) > 200,
    { playerNow, lk });
  check('the plan target is the last known position, not the player',
    near(w.plan.target.x, lk.x, 1e-9) && near(w.plan.target.z, lk.z, 1e-9), w.plan.target);
  check('the search radius grows over time', r20 > r10 + 50, { r10, r20 });
  check('the escape clock started when the fix ran out', near(evade10, 10, DT * 2), { evade10 });
  check('the search radius grows at the tuned rate',
    near(r10, w.searchRadius0 + RESPONSE[stars].searchGrow * evade10, 1e-6),
    { r10, expect: w.searchRadius0 + RESPONSE[stars].searchGrow * evade10 });

  const a = w.plan.assignments;
  const probe = a.filter((u) => u.role === 'probe');
  const ring = a.filter((u) => u.role === 'search');
  check('one unit probes the last known position itself', probe.length === 1, a.map((u) => u.role));
  check('the probe drives to the last known position',
    near(probe[0].goal.x, lk.x, 1e-9) && near(probe[0].goal.z, lk.z, 1e-9), probe[0].goal);
  check('the rest sweep a ring at the search radius',
    ring.length === a.length - 1 && ring.every((u) =>
      near(Math.hypot(u.goal.x - lk.x, u.goal.z - lk.z), w.searchRadius, 1e-6)),
    ring.map((u) => +Math.hypot(u.goal.x - lk.x, u.goal.z - lk.z).toFixed(2)));
  // Distinct bearings, or a "ring" is four cars driving to the same corner.
  const bearings = ring.map((u) => Math.atan2(u.goal.z - lk.z, u.goal.x - lk.x));
  const spread = bearings.some((b1, i) => bearings.some((b2, j) => j !== i && Math.abs(b1 - b2) > 0.5));
  check('search bearings are spread, not stacked', spread, bearings.map((b) => +b.toFixed(2)));

  searchSample = { stars, lastKnown: lk, playerNow, r10: +r10.toFixed(1), r20: +r20.toFixed(1),
    roles: a.map((u) => u.role) };
  out.search = searchSample;
}

// ------------------------------------------------------------- 8. re-acquisition
{
  const w = new WantedSystem({ seed: 8 });
  w.reportCrime('policeProperty', { at: ORIGIN });
  w.reportCrime('discharge', { at: ORIGIN });
  run(w, w.witnessSeconds + 2, ORIGIN, { seen: true });
  const t0 = w.time;
  const drive = (t) => ({ x: (t - t0) * 25, z: 0 });
  run(w, 8, drive, { seen: false });
  const rBefore = w.searchRadius, tBefore = w.evadeTimer;
  check('search is under way before re-acquisition',
    w.state === STATES.SEARCH && tBefore > 5, { state: w.state, tBefore });

  // A cruiser rolls up next to the player. No `seen` flag now: contact has to be
  // decided by the module from the reported unit position.
  const id = w.plan.assignments[0].id;
  const p = drive(w.time);
  run(w, 0.5, drive, { each: (sys) => sys.reportUnit(id, drive(sys.time).x + 8, 0) });

  check('a unit inside the spot radius re-acquires contact', w.state === STATES.ACTIVE, w.state);
  check('re-acquisition snaps the last known position to the player',
    near(w.lastKnown.x, drive(w.time).x, 30), { lk: w.lastKnown.x, player: drive(w.time).x });
  check('re-acquisition resets the escape clock and the search radius',
    w.evadeTimer === 0 && w.searchRadius === w.searchRadius0, { t: w.evadeTimer, r: w.searchRadius });
  out.reacquire = { rBefore: +rBefore.toFixed(1), tBefore: +tBefore.toFixed(1),
    stateAfter: w.state, reacquires: w.stats.reacquires, at: +p.x.toFixed(0) };

  // A unit far outside the spot radius must NOT hold contact.
  run(w, 6, drive, { each: (sys) => sys.reportUnit(id, drive(sys.time).x + 400, 0) });
  check('a distant unit does not hold contact', w.state === STATES.SEARCH, w.state);
}

// ------------------------------------------------- 9. no decay while in contact
{
  const w = new WantedSystem({ seed: 9 });
  w.reportCrime('policeProperty', { at: ORIGIN });
  w.reportCrime('discharge', { at: ORIGIN });
  run(w, 2, ORIGIN, { seen: true });
  const stars = w.stars;
  run(w, RESPONSE[stars].cooldown * 3, ORIGIN, { seen: true });
  check('stars never decay while the police have eyes on you',
    w.stars === stars && w.stats.decays === 0, { stars: w.stars, decays: w.stats.decays });
  out.noDecayInContact = { stars, heldFor: RESPONSE[stars].cooldown * 3, after: w.stars };
}

// ------------------------------------------------------- 10. stepwise decay out
{
  const w = new WantedSystem({ seed: 10 });
  const log = events(w, ['stars', 'clear', 'unit:release', 'unit:request']);
  w.reportCrime('policeProperty', { at: ORIGIN });
  w.reportCrime('discharge', { at: ORIGIN });
  run(w, 3, ORIGIN, { seen: true });
  const stars0 = w.stars;
  const requested = log.filter((e) => e.e === 'unit:request').length;

  const drops = [];
  let last = w.stars, t0 = w.time;
  for (let i = 0; i < Math.round(400 / DT) && w.stars > 0; i++) {
    w.update(DT, { x: 900, z: 900, seen: false });
    if (w.stars !== last) { drops.push({ from: last, to: w.stars, after: +(w.time - t0).toFixed(1) }); last = w.stars; t0 = w.time; }
  }

  check('the wanted level decays one star at a time',
    drops.length === stars0 && drops.every((d) => d.from - d.to === 1), drops);
  check('the wanted level reaches zero', w.stars === 0 && w.state === STATES.CLEAR, w.report());
  check('the first drop takes the tuned cooldown or longer',
    drops[0].after >= RESPONSE[stars0].cooldown, { after: drops[0].after, cooldown: RESPONSE[stars0].cooldown });
  check('escaping fires a clear event',
    log.some((e) => e.e === 'clear' && e.reason === 'escaped'), log.filter((e) => e.e === 'clear'));
  check('every requested unit is released on escape',
    log.filter((e) => e.e === 'unit:release').length >= requested && w.plan.units === 0,
    { requested, released: log.filter((e) => e.e === 'unit:release').length });
  check('lower stars field fewer units',
    RESPONSE[1].units < RESPONSE[stars0].units);
  out.decay = { from: stars0, drops, escapes: w.stats.escapes, totalS: +w.time.toFixed(1) };
}

// ------------------------------------- 11. crime decay contribution lengthens it
{
  const escapeTime = (crimes) => {
    const w = new WantedSystem({ seed: 11 });
    for (const c of crimes) w.reportCrime(c, { at: ORIGIN });
    run(w, 2, ORIGIN, { seen: true });
    const stars = w.stars, t0 = w.time;
    for (let i = 0; i < Math.round(400 / DT) && w.stars > 0; i++) {
      w.update(DT, { x: 900, z: 900, seen: false });
    }
    return { stars, seconds: +(w.time - t0).toFixed(2), cleared: w.stars === 0 };
  };
  const light = escapeTime(['vehicleTheft']);
  const heavy = escapeTime(['vehicleTheft', 'hitAndRun']);
  check('both escapes are from the same star level', light.stars === heavy.stars, { light, heavy });
  check('a crime with a bigger decay contribution takes longer to shake',
    heavy.seconds > light.seconds + 3, { light, heavy });
  check('...and still terminates', light.cleared && heavy.cleared, { light, heavy });
  out.decayContribution = { light, heavy,
    coolLight: CRIMES.vehicleTheft.cool, coolHeavy: CRIMES.vehicleTheft.cool + CRIMES.hitAndRun.cool };
}

// ------------------------------------------------------------ 12. give-up radius
{
  const w = new WantedSystem({ seed: 12 });
  w.reportCrime('policeProperty', { at: ORIGIN });
  w.reportCrime('discharge', { at: ORIGIN });
  run(w, 2, ORIGIN, { seen: true });
  const log = events(w, ['unit:release', 'unit:request']);
  const strays = w.plan.assignments.slice(0, 2).map((a) => a.id);
  const keep = w.plan.assignments.slice(2).map((a) => a.id);
  run(w, 0.5, ORIGIN, { seen: true, each: (sys) => {
    for (const id of strays) sys.reportUnit(id, w.plan.giveUpRadius + 300, 0);
    for (const id of keep) sys.reportUnit(id, 20, 0);
  } });
  const lost = log.filter((e) => e.e === 'unit:release' && e.reason === 'lost');
  check('units beyond the give-up radius are released',
    lost.length === strays.length, { lost: lost.map((l) => l.id), strays });
  check('units inside it are kept',
    w.plan.assignments.some((a) => keep.includes(a.id)), w.plan.assignments.map((a) => a.id));
  check('released units are replaced while the level holds',
    w.plan.units === RESPONSE[w.stars].units, { units: w.plan.units, want: RESPONSE[w.stars].units });
  out.giveUp = { radius: w.plan.giveUpRadius, released: lost.length, refilled: w.plan.units };
}

// ------------------------------------------------------------ 13. dt is clamped
{
  const w = new WantedSystem({ seed: 13 });
  w.reportCrime('discharge', { at: ORIGIN });
  run(w, 1, ORIGIN, { seen: true });
  run(w, 8, ORIGIN, { seen: false });
  const before = w.evadeTimer;
  w.update(30, { x: 0, z: 0, seen: false });    // a 30 s hitch
  check('one long hitch cannot fast-forward an escape',
    near(w.evadeTimer - before, w.maxDt, 1e-9), { before, after: w.evadeTimer });
  out.hitchClamp = { maxDt: w.maxDt, advanced: +(w.evadeTimer - before).toFixed(4) };
}

// ------------------------------------------------------------- 14. determinism
{
  const script = (seed) => {
    const w = new WantedSystem({ seed });
    const samples = [];
    const drive = (t) => ({ x: Math.cos(t * 0.4) * 120, z: Math.sin(t * 0.31) * 90 });
    for (let i = 0; i < Math.round(90 / DT); i++) {
      const t = w.time;
      if (near(t % 11, 0, DT / 2) && t > 1) w.reportCrime('civilianCollision', { at: drive(t) });
      if (near(t % 23, 0, DT / 2) && t > 1) w.reportCrime('pedestrianHit', { at: drive(t) });
      const p = drive(t);
      p.seen = Math.floor(t / 7) % 2 === 0;
      w.update(DT, p);
      if (i % 30 === 0) {
        const a = w.plan.assignments[0];
        samples.push([+t.toFixed(2), w.stars, w.state, +w.searchRadius.toFixed(3),
          +w.evadeTimer.toFixed(3), a ? [a.role, +a.goal.x.toFixed(3), +a.goal.z.toFixed(3)] : null]);
      }
    }
    return samples;
  };
  const a = script(99), b = script(99), c = script(1234);
  check('the same seed and script give an identical trace',
    JSON.stringify(a) === JSON.stringify(b), { a: a.length, b: b.length });
  check('the trace actually exercises several states',
    new Set(a.map((s) => s[2])).size >= 2, [...new Set(a.map((s) => s[2]))]);
  check('a different seed only jitters the search, never the level',
    a.map((s) => s[1]).join() === c.map((s) => s[1]).join(), 'star trace must not depend on the seed');
  out.determinism = { samples: a.length, states: [...new Set(a.map((s) => s[2]))],
    starsSeen: [...new Set(a.map((s) => s[1]))].sort() };
}

// -------------------------------------------------- 15. the tuning table is sane
{
  const SEARCH_R0 = new WantedSystem().searchRadius0;
  const cols = ['units', 'spawnMin', 'spawnMax', 'giveUpRadius', 'speedMul',
    'aggression', 'cooldown', 'searchGrow', 'spotRadius', 'siren'];
  const bad = [];
  for (const c of cols) {
    for (let s = 1; s < RESPONSE.length; s++) {
      if (RESPONSE[s][c] < RESPONSE[s - 1][c]) bad.push(`${c} falls at ${s} stars`);
    }
  }
  let interceptRegressed = false;
  for (let s = 1; s < RESPONSE.length; s++) {
    if (RESPONSE[s - 1].intercept && !RESPONSE[s].intercept) interceptRegressed = true;
  }
  check('every response column is monotonic in stars', bad.length === 0, bad);
  check('intercept never switches back off as stars rise', !interceptRegressed);
  check('spawn bands are ordered', RESPONSE.every((r) => r.spawnMax >= r.spawnMin));
  check('every live star level can hold the initial search ring',
    RESPONSE.slice(1).every((r) => r.giveUpRadius > SEARCH_R0));
  out.tuning = RESPONSE.map((r, s) => ({ stars: s, ...r }));
}

// ------------------------------------------- 16. listener errors cannot stop it
{
  const w = new WantedSystem({ seed: 16 });
  w.on('stars', () => { throw new Error('HUD blew up'); });
  w.on('*', () => { throw new Error('audio blew up'); });
  w.reportCrime('discharge', { at: ORIGIN });
  run(w, 2, ORIGIN, { seen: true });
  check('a throwing subscriber does not stop the police',
    w.stars === 1 && w.plan.units === 1, w.report());
  check('listener errors are counted, not swallowed silently', w.stats.listenerErrors > 0,
    { errors: w.stats.listenerErrors });
  out.listenerIsolation = { stars: w.stars, listenerErrors: w.stats.listenerErrors };
}

// --------------------------------------------- 17. clear/busted and scripting
{
  const w = new WantedSystem({ seed: 17 });
  w.reportCrime('officerDown', { at: ORIGIN });
  run(w, 2, ORIGIN, { seen: true });
  const log = events(w, ['clear', 'unit:release']);
  const held = w.plan.units;
  w.clear('busted');
  run(w, 0.5, ORIGIN, { seen: true });
  check('clear() drops the level and releases the fleet',
    w.stars === 0 && w.plan.units === 0 && w.state === STATES.CLEAR, w.report());
  check('clear() reports its reason', log.some((e) => e.e === 'clear' && e.reason === 'busted'), log);
  check('clear() released every held unit',
    log.filter((e) => e.e === 'unit:release').length === held, { held });
  w.setStars(2, 'mission');
  run(w, 1, ORIGIN, { seen: true });
  check('mission scripting can set the level directly',
    w.stars === 2 && w.plan.units === RESPONSE[2].units, w.report());
  out.scripting = { heldBeforeBust: held, afterBust: 0, scripted: w.stars };
}

// --------------------------------------------------- 18. purity, by inspection
{
  const src = fs.readFileSync(new URL('../src/wanted.js', import.meta.url), 'utf8');
  // Comments in this module talk about three.js constantly — the point of the
  // check is the CODE, so strip block and line comments before looking.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  check('the module imports nothing at all', !/^\s*import\s/m.test(code));
  check('the module never references three.js', !/THREE|three\.module/.test(code));
  check('the module creates no scene objects',
    !/\b(Mesh|BufferGeometry|Material|PointLight|Scene|Vector3|Object3D)\b/.test(code));
  check('the module touches no browser globals',
    !/\b(document|window|performance|requestAnimationFrame|localStorage)\b/.test(code));
  out.purity = { imports: 0, threeReferences: 0, browserGlobals: 0, drawCalls: 0,
    codeBytes: code.length, sourceBytes: src.length };
}

// -------------------------------------------- 19. the bridge to the pursuit layer
// This is the seam between two owners' files, so it gets its own check in both
// shapes: today's src/pursuit.js, which has plain tunable fields and no setters,
// and the shape the M3 rewrite is expected to grow.
{
  const legacy = { speed: 22, giveUpRadius: 600, count: 8 };   // PursuitUnits, as it stands
  const w = new WantedSystem({ seed: 19 });
  const bridge = bindPursuit(w, legacy);
  bridge.update(DT, { x: 0, z: 0, seen: false });
  check('an idle response leaves the pursuit layer untouched',
    legacy.speed === 22 && legacy.giveUpRadius === 600, legacy);
  w.reportCrime('officerDown', { at: ORIGIN });
  for (let i = 0; i < 30; i++) bridge.update(DT, { x: 0, z: 0, seen: true });
  check('the bridge falls back to plain fields when there are no setters',
    near(legacy.speed, 22 * RESPONSE[4].speedMul, 1e-9)
    && legacy.giveUpRadius === RESPONSE[4].giveUpRadius, legacy);
  check('the bridge never writes the instanced-mesh capacity', legacy.count === 8, legacy);
  bridge.detach();
  check('detaching restores the pursuit layer base speed', legacy.speed === 22, legacy);

  // The full interface. Positions come back through getUnitPositions, and that
  // alone has to be enough to hold contact — no `seen` flag from the host.
  const modern = {
    pos: new Map(), spawned: [], released: [], goals: 0, seen: {},
    spawnUnit(id, r) { this.spawned.push({ id, band: [r.spawnMin, r.spawnMax] });
      this.pos.set(id, { id, x: 6, z: 0 }); },
    releaseUnit(id) { this.released.push(id); this.pos.delete(id); },
    setUnitGoal() { this.goals++; },
    setUnitCount(n) { this.seen.count = n; },
    setTarget(x, z) { this.seen.target = [x, z]; },
    setSpawnBand(a, b) { this.seen.band = [a, b]; },
    setSpeedMultiplier(m) { this.seen.mul = m; },
    setGiveUpRadius(r) { this.seen.giveUp = r; },
    getUnitPositions() { return [...this.pos.values()]; },
  };
  const w2 = new WantedSystem({ seed: 20 });
  const b2 = bindPursuit(w2, modern);
  w2.reportCrime('policeProperty', { at: ORIGIN });
  for (let i = 0; i < 120; i++) b2.update(DT, { x: 0, z: 0 });   // no `seen` flag at all
  check('the bridge asks the pursuit layer to spawn each requested unit',
    modern.spawned.length === RESPONSE[w2.stars].units, modern.spawned);
  // policeProperty floors at two stars, so the first request carries RESPONSE[2].
  check('the bridge passes the spawn band of the level that requested the unit',
    modern.spawned[0].band[0] === RESPONSE[2].spawnMin
    && modern.spawned[0].band[1] === RESPONSE[2].spawnMax, modern.spawned[0]);
  check('reported positions alone are enough to hold contact',
    w2.state === STATES.ACTIVE && w2.plan.seen === true, w2.report());
  check('the bridge pushes every tuning field',
    modern.seen.count === w2.plan.units && modern.seen.mul === w2.plan.speedMul
    && modern.seen.giveUp === w2.plan.giveUpRadius
    && near(modern.seen.target[0], 0, 1e-9), modern.seen);
  check('the bridge forwards a goal for every assignment', modern.goals >= 120, { goals: modern.goals });
  w2.clear('busted');
  b2.update(DT, { x: 0, z: 0 });
  check('clearing releases every spawned unit through the bridge',
    modern.released.length === modern.spawned.length && modern.pos.size === 0,
    { spawned: modern.spawned.length, released: modern.released.length });
  out.bridge = { legacyFields: legacy, modern: modern.seen,
    spawned: modern.spawned.length, released: modern.released.length };
}

// ------------------------ 20. the shape district/main.js actually presents
// §19 covers the two ends of the duck-typed range: a pursuit layer with no
// setters at all, and one with every setter. The wiring in district/main.js is
// neither, so the shape it does present gets its own section.
//
// It is a shim over the Phase 1b PursuitUnits with four properties §19 does not
// exercise:
//
//   - nothing is built until the first unit is actually requested. This is what
//     the whole "a fresh load renders an unchanged frame" claim rests on, and it
//     belongs in a deterministic test rather than only in a browser capture.
//   - a HARD fleet capacity: one InstancedMesh, allocated once at 8 and masked,
//     never resized.
//   - only the setters PursuitUnits can honour. `setUnitGoal` and `setSpawnBand`
//     are deliberately ABSENT — it drives every car at one shared target and
//     hard-codes its own spawn distance — so bindPursuit has to tolerate a
//     partial vocabulary, not just an empty or a complete one.
//   - id-to-slot bookkeeping by index, because releasing a unit must not
//     renumber the cars that remain.
{
  const CAPACITY = 8;
  let carSeq = 0;
  const shim = {
    ids: [], fleet: null, built: 0, spawns: 0,
    target: null, speedMul: 0, giveUp: 0,
    _fleetTo(n) {
      if (n <= 0) { if (this.fleet) this.fleet.live = 0; return; }
      if (!this.fleet) { this.fleet = { slots: new Array(CAPACITY).fill(null), live: 0 }; this.built++; }
      this.fleet.live = Math.min(n, CAPACITY);
      for (let i = 0; i < this.fleet.live; i++) {
        if (!this.fleet.slots[i]) this.fleet.slots[i] = { car: ++carSeq, x: 5, z: 0 };
      }
      for (let i = this.fleet.live; i < CAPACITY; i++) this.fleet.slots[i] = null;
    },
    spawnUnit(id) { this.spawns++; this.ids.push(id); this._fleetTo(this.ids.length); },
    releaseUnit(id) {
      const k = this.ids.indexOf(id);
      if (k < 0) return;
      this.ids.splice(k, 1);
      if (this.fleet) { this.fleet.slots.splice(k, 1); this.fleet.slots.push(null); }
      this._fleetTo(this.ids.length);
    },
    setUnitCount(n) { this._fleetTo(Math.min(n, CAPACITY)); },
    setTarget(x, z) { this.target = { x, z }; },
    setSpeedMultiplier(m) { this.speedMul = m; },
    setGiveUpRadius(r) { this.giveUp = r; },
    // No setUnitGoal, no setSpawnBand. That absence is the point.
    getUnitPositions() {
      const out = [];
      if (!this.fleet) return out;
      for (let i = 0; i < Math.min(this.ids.length, this.fleet.live); i++) {
        const s = this.fleet.slots[i];
        if (s) out.push({ id: this.ids[i], x: s.x, z: s.z });
      }
      return out;
    },
    idToCar() {
      const m = {};
      if (!this.fleet) return m;
      this.ids.forEach((id, i) => { if (this.fleet.slots[i]) m[id] = this.fleet.slots[i].car; });
      return m;
    },
  };

  const w = new WantedSystem({ seed: 21 });
  const bridge = bindPursuit(w, shim);

  // --- inert. Ten minutes of game time with no crime at all.
  let threw = null;
  try { run(w, 600, ORIGIN, { each: (_w, _i, p) => bridge.update(DT, p) }); }
  catch (e) { threw = String(e); }
  check('a partial setter vocabulary does not throw', threw === null, threw);
  check('ten idle minutes build no fleet at all', shim.built === 0 && shim.fleet === null,
    { built: shim.built });
  check('...request no unit', shim.spawns === 0 && w.stats.unitsRequested === 0);
  check('...and leave the level clear', w.stars === 0 && w.state === STATES.CLEAR);
  out.inert = { seconds: 600, built: shim.built, spawns: shim.spawns, stars: w.stars };

  // --- one crime, and only then does anything exist.
  w.reportCrime('roadblockRun', { at: ORIGIN });          // floors at three stars
  for (let i = 0; i < 20; i++) bridge.update(DT, { x: 0, z: 0 });
  check('the first crime builds the fleet exactly once', shim.built === 1, { built: shim.built });
  check('the fleet matches the response table for the level',
    shim.fleet.live === RESPONSE[w.stars].units, { live: shim.fleet.live, stars: w.stars });
  check('the shared target is written even with no per-unit goals',
    shim.target !== null && near(shim.target.x, 0, 1e-9), shim.target);
  check('tuning that PursuitUnits CAN honour still arrives',
    shim.speedMul === RESPONSE[w.stars].speedMul && shim.giveUp === RESPONSE[w.stars].giveUpRadius,
    { speedMul: shim.speedMul, giveUp: shim.giveUp });

  // --- id-to-car alignment survives a release from the middle of the fleet.
  const beforeMap = shim.idToCar();
  const victim = shim.ids[1];
  const victimCar = beforeMap[victim];
  shim.releaseUnit(victim);
  const afterMap = shim.idToCar();
  check('releasing a unit removes only its own car',
    !Object.values(afterMap).includes(victimCar), { victimCar, afterMap });
  check('...and every surviving unit keeps the car it had',
    Object.keys(afterMap).every((id) => afterMap[id] === beforeMap[id]),
    { beforeMap, afterMap });

  // --- contact holds on reported positions alone, through this shape.
  for (let i = 0; i < 30; i++) bridge.update(DT, { x: 0, z: 0 });
  check('contact holds through a partial vocabulary',
    w.state === STATES.ACTIVE && w.plan.seen === true, w.report().state);

  // --- and it all unwinds.
  w.clear('busted');
  bridge.update(DT, { x: 0, z: 0 });
  check('clearing empties the fleet', shim.ids.length === 0 && shim.fleet.live === 0,
    { ids: shim.ids.length, live: shim.fleet.live });
  out.mainShim = { built: shim.built, spawns: shim.spawns, capacity: CAPACITY };
}

// -------------------- 20b. the capacity in district/main.js is not a cap
// district/main.js allocates its InstancedMesh once, at 8, because that is the
// most the response table can ever ask for. If the table or the module default
// ever outgrows that number the fleet would be silently clipped and the top of
// the star ladder would quietly stop escalating, which is exactly the kind of
// defect that hides for months. Cross-file invariant, asserted here because this
// is the file that knows the table.
{
  const MAIN_CAPACITY = 8;                    // == PURSUIT_CAPACITY in district/main.js
  const worst = Math.max(...RESPONSE.map((r) => r.units));
  const dflt = new WantedSystem().maxUnits;
  check('the response table never outgrows the wired fleet capacity',
    worst <= MAIN_CAPACITY, { worst, MAIN_CAPACITY });
  check('...and neither does the module default', dflt <= MAIN_CAPACITY, { dflt, MAIN_CAPACITY });
  out.capacity = { tableWorst: worst, moduleDefault: dflt, wired: MAIN_CAPACITY };
}

// ------------------------------------------- 21. leaving the scene of an injury
/**
 * `hitAndRun` sat in this table from the day it was written and NOTHING in the game ever filed it:
 * one of ten crimes named by no module. It was the only one of the ten whose every input already
 * existed here — the scene arrives as `at`, the player's position every `update`, and `playerVel` is
 * already smoothed for the interceptors — so it is wired and the other nine stay priced as a refusal.
 *
 * The thresholds and why only one of them is a choice are in `_watchScene`. What this section owes
 * is that BOTH outcomes happen, because an arm where nobody ever flees and an arm where nobody ever
 * stops would each pass half of it.
 */
{
  const DT = 1 / 60;
  /**
   * APPROACH AT SPEED, hit someone, then either stop or keep going — which is the case the game
   * produces and the only one that tests anything.
   *
   * The first version of this helper settled the tracker AT REST for a second before reporting the
   * crime, and the crawl sweep below then read "counted as stopping" at every speed including
   * 3 m/s. That is correct behaviour and a worthless test: a player who is stationary at the moment
   * of the impact HAS stopped at the scene, so the scene is discharged on the first frame and
   * nothing after it can charge them. Every arm started already discharged.
   *
   * So the approach run is part of the arm: `run-up` metres at `speed` BEFORE the crime, so
   * `playerVel` holds a real driving speed when the scene arms. The smoothing rate is 6, so 1 s of
   * run-up is six time constants and the tracked speed is within 0.25% of the true one — printed
   * by the sweep rather than assumed.
   */
  const drive = (crime, { stopFirst = false, speed = 14, dist = 140, runUp = 1.0 } = {}) => {
    const w = new WantedSystem();
    const fired = [];
    w.on('crime', (p) => { if (p.applied) fired.push({ id: p.id, at: p.at }); });
    // Approach from behind the scene so the crime lands at x = 0 with the car already moving.
    let x = -speed * runUp;
    while (x < 0) { x += speed * DT; w.update(DT, { x, z: 0 }); }
    const approach = Math.hypot(w.playerVel.x, w.playerVel.z);
    w.reportCrime(crime, { at: { x: 0, z: 0 } });
    if (stopFirst) for (let i = 0; i < 180; i++) w.update(DT, { x: 0, z: 0 });   // 3 s at rest
    let firedAt = null;
    while (x < dist) {
      x += speed * DT;
      w.update(DT, { x, z: 0 });
      if (firedAt === null && fired.some((f) => f.id === 'hitAndRun')) firedAt = x;
    }
    return { w, fired, firedAt, approach, stats: w.stats };
  };

  const fled = drive('pedestrianHit');
  const stayed = drive('pedestrianHit', { stopFirst: true });
  console.log(`\n21. leaving the scene (radius ${SCENE_LEAVE_M} m, stop under ${SCENE_STOP_MS} m/s)`);
  console.log(`    drove off:      ${fled.fired.map((f) => f.id).join(' + ')} — ` +
    `${fled.w.stars} stars, heat ${fled.w.heat.toFixed(2)}, fired at ${fled.firedAt?.toFixed(1)} m`);
  console.log(`    stopped first:  ${stayed.fired.map((f) => f.id).join(' + ')} — ` +
    `${stayed.w.stars} stars, heat ${stayed.w.heat.toFixed(2)}`);
  console.log(`    scenes armed ${fled.stats.scenesArmed}/${stayed.stats.scenesArmed}, ` +
    `stopped ${fled.stats.scenesStopped}/${stayed.stats.scenesStopped}, ` +
    `fled ${fled.stats.scenesFled}/${stayed.stats.scenesFled}`);

  check('driving away from a pedestrian you hit files hitAndRun',
    fled.fired.some((f) => f.id === 'hitAndRun'), fled.fired.map((f) => f.id).join(' + '));
  check('and stopping at the scene does not',
    !stayed.fired.some((f) => f.id === 'hitAndRun'), stayed.fired.map((f) => f.id).join(' + '));
  check('both arms reported the original crime, so neither measured nothing',
    fled.fired.some((f) => f.id === 'pedestrianHit')
      && stayed.fired.some((f) => f.id === 'pedestrianHit'),
    `${fled.fired.length} / ${stayed.fired.length} crimes`);
  check('it fires at the leave radius, not before or well after',
    fled.firedAt > SCENE_LEAVE_M && fled.firedAt < SCENE_LEAVE_M + 1,
    `${fled.firedAt?.toFixed(2)} m against ${SCENE_LEAVE_M}`);
  // Reported AT THE SCENE: it is the only position a witness could give, and it is what the
  // search should converge on. The car is 85 m away by then.
  const hr = fled.fired.find((f) => f.id === 'hitAndRun');
  check('and it is reported at the scene, not where the car got to',
    hr && Math.abs(hr.at.x) < 1e-9 && Math.abs(hr.at.z) < 1e-9, JSON.stringify(hr?.at));

  // Every `scene: true` crime arms one, and nothing else does.
  const marked = Object.entries(CRIMES).filter(([, c]) => c.scene).map(([k]) => k);
  console.log(`    crimes that arm a scene: ${marked.join(', ')}`);
  check('the crimes that leave a victim are the ones that arm a scene',
    marked.length === 3 && marked.includes('pedestrianHit') && marked.includes('pedestrianKilled')
      && marked.includes('civilianCollision'), marked.join(', '));
  const wall = drive('propertyDamage');
  check('KNOWN-BAD: property damage arms nothing, because a wall needs no aid',
    wall.stats.scenesArmed === 0 && !wall.fired.some((f) => f.id === 'hitAndRun'),
    `${wall.stats.scenesArmed} scenes, ${wall.fired.map((f) => f.id).join(' + ')}`);
  for (const id of marked) {
    const r = drive(id);
    check(`${id} arms a scene and charges the flight`,
      r.stats.scenesArmed === 1 && r.stats.scenesFled === 1
        && r.fired.some((f) => f.id === 'hitAndRun'),
      `armed ${r.stats.scenesArmed}, fled ${r.stats.scenesFled}`);
  }

  /**
   * THE STOP THRESHOLD'S RELATION, not its value. SCENE_STOP_MS is the one chosen number here, so
   * what is asserted is the two bounds it has to sit between: below damage.js's 2.2 m/s free
   * threshold, or "stopped at the scene" and "rolling slowly enough for a contact to be free" would
   * be the same reading; and above the velocity tracker's floor for a stationary car, which is
   * measured rather than assumed.
   */
  const rest = new WantedSystem();
  for (let i = 0; i < 300; i++) rest.update(DT, { x: 12, z: -7 });
  const floor = Math.hypot(rest.playerVel.x, rest.playerVel.z);
  console.log(`    a parked car's tracked speed: ${floor.toExponential(2)} m/s; ` +
    `stop threshold ${SCENE_STOP_MS}; free-contact threshold 2.2`);
  check('the stop threshold is below the free-contact threshold', SCENE_STOP_MS < 2.2,
    `${SCENE_STOP_MS} < 2.2`);
  check('and clear of the tracker floor for a parked car', floor < SCENE_STOP_MS / 10,
    `${floor.toExponential(2)} against ${SCENE_STOP_MS}`);
  // Crawling past the scene under the threshold counts as stopping; this is the boundary the
  // choice actually decides, so it is walked rather than asserted at one speed.
  console.log('    crawling away instead of stopping (tracked speed printed, not assumed):');
  for (const sp of [0.4, 0.9, 1.2, 3.0, 14]) {
    const r = drive('pedestrianHit', { speed: sp, dist: SCENE_LEAVE_M + 6 });
    const flew = r.fired.some((f) => f.id === 'hitAndRun');
    console.log(`      ${sp.toFixed(1).padStart(4)} m/s commanded, ${r.approach.toFixed(3)} tracked ` +
      `-> ${flew ? 'hitAndRun' : 'counted as stopping'}`);
    check(`crawling at ${sp} m/s is ${sp >= SCENE_STOP_MS ? 'fleeing' : 'stopping'}`,
      flew === (sp >= SCENE_STOP_MS), `${flew ? 'fired' : 'did not fire'} at ${sp} m/s ` +
      `(tracked ${r.approach.toFixed(3)})`);
  }
  // The run-up has to actually establish the speed, or the sweep is testing the tracker's lag.
  const fast = drive('pedestrianHit', { speed: 14 });
  check('the approach run establishes the tracked speed it commands',
    Math.abs(fast.approach - 14) / 14 < 0.01, `${fast.approach.toFixed(3)} against 14`);

  // The leave radius is READ from the response table, not copied.
  check('the leave radius is one star\'s own spot radius', SCENE_LEAVE_M === RESPONSE[1].spotRadius,
    `${SCENE_LEAVE_M} against ${RESPONSE[1].spotRadius}`);

  /**
   * AND THE NEAR MISS IS WRITTEN DOWN RATHER THAN TUNED AWAY. A pedestrian hit plus fleeing is
   * 1.15 + 0.80 = 1.95 heat, which is one hundredth short of two stars. That is the table's own
   * arithmetic and neither number was chosen with the other in mind; nudging either to land on a
   * round outcome would be a fudge. What fleeing buys you at one star is 10 s of extra `cool`,
   * which lengthens the escape rather than raising the response.
   */
  check('fleeing adds heat and cooldown without, here, adding a star',
    fled.w.heat > stayed.w.heat && fled.w.stars === stayed.w.stars,
    `heat ${stayed.w.heat.toFixed(2)} -> ${fled.w.heat.toFixed(2)}, stars ${fled.w.stars}`);
  check('and it is the cooldown that does the work', fled.w.cool > stayed.w.cool,
    `cool ${stayed.w.cool} -> ${fled.w.cool}`);
}

// ------------------------------------------------- 22. one victim, one offence, in a window
/**
 * This rule was a Map and eight lines inside `district/main.js`, which no offline gate imports.
 * `tools/mutation-sweep.mjs` deleted its window test — the edit that lets one pedestrian be charged
 * every knockdown cycle again — and all sixteen offline gates plus playtest --selftest passed,
 * because not one of them can see that file. It is `VictimWindow` in src/wanted.js now, and these
 * are the checks that were impossible before.
 */
{
  const W = 20;
  console.log(`\n22. the per-victim window (${W} s)`);
  const w = new VictimWindow(W);
  // The same victim, inside the window: charged once.
  const first = w.charge('ped-7', 100);
  const again = w.charge('ped-7', 104.42);     // one knockdown cycle later
  const third = w.charge('ped-7', 119.9);      // still inside
  const after = w.charge('ped-7', 120.1);      // 20.1 s later: a fresh offence
  console.log(`    ped-7 at t=100 ${first}, 104.42 ${again}, 119.9 ${third}, 120.1 ${after}`);
  check('a victim is charged the first time', first === true, `${first}`);
  check('and not again one knockdown cycle later', again === false, `${again}`);
  check('nor anywhere else inside the window', third === false, `${third}`);
  check('but is charged again once the window has passed', after === true, `${after}`);
  // A DIFFERENT victim a second later is fully chargeable — the window is per victim, not global.
  const other = new VictimWindow(W);
  other.charge('ped-1', 100);
  check('a different victim one second later is a separate offence',
    other.charge('ped-2', 101) === true, 'ped-2 charged');
  check('and the first is still inside their own window',
    other.charge('ped-1', 101) === false, 'ped-1 refused');

  /**
   * THE MEASUREMENT IT EXISTS FOR, replayed against the real ladder rather than asserted. Seven
   * knockdowns in 30 s with no window gave heat 5.99 and five stars from ONE pedestrian, because
   * `reportCrime`'s own refractory is per crime TYPE and 1.0 s long — far too short to see a 4.42 s
   * knockdown cycle. Both arms are run, so the window's value is a difference and not a claim.
   */
  const run = (useWindow) => {
    const sys = new WantedSystem();
    const win = new VictimWindow(W);
    let charged = 0;
    for (let k = 0; k < 7; k++) {
      const t = 100 + k * 4.42;
      sys.update(4.42, { x: 0, z: 0 });
      if (!useWindow || win.charge('ped-7', t)) { sys.reportCrime('pedestrianHit', { at: { x: 0, z: 0 } }); charged++; }
    }
    return { charged, heat: +sys.heat.toFixed(2), stars: sys.stars };
  };
  const without = run(false), withIt = run(true);
  console.log(`    7 knockdowns of one person in 30 s:`);
  console.log(`      no window: ${without.charged} charged, heat ${without.heat}, ${without.stars} stars`);
  console.log(`      window:    ${withIt.charged} charged, heat ${withIt.heat}, ${withIt.stars} stars`);
  /**
   * TWO NUMBERS I ASSERTED FROM A DIFFERENT ARM, and both were wrong — the third time this session.
   *
   * I wrote `without.stars >= 5` from the live measurement of heat 5.99 and five stars. This arm
   * reads 2 stars, and it is right to: it calls `sys.update(4.42)` between reports, so heat DECAYS
   * across the 30 s, where the live run held five stars because the pursuit kept contact and the
   * escape clock never ran. Same rule, different arm, and the star count belongs to the arm rather
   * than to the rule.
   *
   * And I wrote `withIt.charged === 1`. Seven knockdowns at 4.42 s spacing span 26.5 s, so the
   * seventh falls OUTSIDE a 20 s window and is charged: 2 is the correct answer and 1 would mean
   * the window never expires. The check is the reduction, and the expiry is asserted separately
   * above rather than smuggled in here.
   */
  check('KNOWN-BAD: without the window every knockdown of one person is charged',
    without.charged === 7, `${without.charged} of 7 charged, heat ${without.heat}`);
  check('with it, the loop collapses to the window\'s own count',
    withIt.charged === 2 && withIt.charged < without.charged,
    `${withIt.charged} of 7 charged — 30 s of knockdowns against a ${W} s window`);
  check('and the heat it saves is real', withIt.heat < without.heat || withIt.charged < without.charged,
    `heat ${without.heat} -> ${withIt.heat}, charges ${without.charged} -> ${withIt.charged}`);
  /**
   * RESTATED. This check used to read `CRIMES.pedestrianHit.refractory < 4.42` — "too short to
   * substitute for the window". It is now ZERO, so that comparison still passes while saying
   * something that is no longer true: there is no per-crime refractory on a pedestrian at all.
   *
   * It was 1.0 s, and a playtester measured what the 1 s cost: two DIFFERENT people struck 0.2,
   * 0.5 or 0.9 s apart gave two knockdowns and ONE crime, refused with reason `refractory`. At
   * 40 km/h a second is 11.1 m, so two people less than 11 m apart on a pavement were one
   * offence, and a 96-pedestrian rampage filed 8 charges for 15 knockdowns. The repeat case it
   * was supposed to cover is the SAME victim, which `VictimWindow` above already owns at 20 s
   * and which `district/main.js`'s `chargeVictim` applies to both pedestrian charge sites.
   *
   * So the assertion is now the two halves of the real rule: no type window on a person, and two
   * distinct victims both charged however close together they are.
   */
  check('a pedestrian crime carries NO per-type refractory',
    CRIMES.pedestrianHit.refractory === 0 && CRIMES.pedestrianKilled.refractory === 0,
    `hit ${CRIMES.pedestrianHit.refractory}, killed ${CRIMES.pedestrianKilled.refractory}` +
    ' — de-duplication is per victim, not per kind of event');
  {
    // Two DIFFERENT people, as close together in time as the old window was wide.
    const pair = (gap) => {
      const sys = new WantedSystem();
      let n = 0;
      sys.on('crime', () => n++);
      sys.reportCrime('pedestrianHit', { at: { x: 0, z: 0 } });
      for (let t = 0; t < gap; t += 1 / 60) sys.update(1 / 60, { x: 0, z: 0 });
      sys.reportCrime('pedestrianHit', { at: { x: 11, z: 0 } });
      return n;
    };
    const gaps = [0, 0.2, 0.5, 0.9, 1.0];
    const counts = gaps.map(pair);
    console.log(`    two DIFFERENT victims, ${gaps.map((g, i) => `${g}s:${counts[i]}`).join(' ')}`);
    check('two different victims are both charged however close together',
      counts.every((c) => c === 2), `charges ${counts.join(',')} at gaps ${gaps.join(',')} s`);
    check('...and the arm is not vacuous: one report alone charges once',
      pair(0) === 2 && (() => { const s = new WantedSystem(); let n = 0; s.on('crime', () => n++);
        s.reportCrime('pedestrianHit', { at: { x: 0, z: 0 } }); return n; })() === 1,
      'a single report charges exactly once');
  }

  // The map does not grow for a session's worth of casualties.
  const many = new VictimWindow(W);
  for (let i = 0; i < 500; i++) many.charge(`ped-${i}`, i * 0.5);
  console.log(`    500 victims over 250 s -> ${many.tracked} tracked`);
  check('stale victims are expired, so the map does not grow all session',
    many.tracked > 0 && many.tracked <= 2 * W / 0.5 + 2, `${many.tracked} tracked`);
}

// ------------------- 23. what the player is SHOWN, which was almost nothing
/**
 * TWO PLAYTESTERS REPORTED THE SAME HOLE FROM OPPOSITE ENDS, and neither was about the rules.
 *
 * Over a whole 96 s escape from four stars the only field of the HUD that ever differed was the
 * star COUNT — no state, no clock, no reason — while the shed times are 40/66/84/96 s. And a
 * hit-and-run filed itself 85.6 m and 4.61 s after the impact with the band reading "DRIVE EAST
 * ALONG MARLIN STREET": the one mechanic in the game with an 85 m deadline and a 3.6 km/h
 * discharge, and no way to learn either from playing. `hudState`, `composeWanted` and `composeLaw`
 * are the answer and this section is what they owe.
 *
 * The composers are pure over a snapshot precisely so this can be a table rather than a drive, but
 * every reading below that could be wrong in a flattering direction is taken from a LIVE system:
 * a note ladder walked over literals proves the ladder and says nothing about whether the machine
 * ever reaches those states.
 */
{
  const DT = 1 / 60;
  console.log('\n23. the HUD state');

  // --- (a) a snapshot at zero stars says nothing at all. This is the known-bad guard for the
  //     whole section: a composer that always returns a line would pass every check after it.
  {
    const w = new WantedSystem();
    const s = w.hudState();
    const cw = composeWanted(s);
    const law = composeLaw(s);
    console.log(`    clean:  ${JSON.stringify(cw)}  law ${JSON.stringify(law)}`);
    check('KNOWN-BAD: a clean record draws no note, no drain and no alarm',
      cw.note === null && cw.evade === 0 && cw.flash === false && cw.stars === 0, cw);
    check('and no law line either', law === null, law);
    check('a clean snapshot carries no scene and no notice',
      s.scene === null && s.notice === null, s);
  }

  // --- (b) the flash is CONTACT and the drain is the escape clock, and they were one animation.
  //     district/main.js fed `state === SEARCH` as the flash while src/hud.js also flashed on any
  //     star increase, so "they have just spotted me" and "I have shaken them" looked identical.
  {
    const w = new WantedSystem();
    w.reportCrime('assault', { at: ORIGIN });
    /**
     * REPORTED FIRST, THEN SEEN, and the order is the module's and not a detail of this arm. A
     * witnessed crime hands dispatch a fix for `witnessSeconds` whether or not a car is near, so
     * for the first 6 s contact is being held by the REPORT. Only once that lapses is a player who
     * is still in contact being held by somebody's eyes. The first version of this check asserted
     * SEEN at 3 s and read REPORTED, which is the module answering correctly.
     */
    run(w, 3, ORIGIN, { seen: true });
    const reported = composeWanted(w.hudState());
    run(w, w.witnessSeconds, ORIGIN, { seen: true });
    const active = composeWanted(w.hudState());
    /**
     * Out of contact the clock runs, so the alarm must drop and the drain must climb — but both
     * arms have to stay INSIDE the star's own cooldown, or the level sheds and the note goes null.
     * The first version ran 8 s and then 6 more after a 6 s witness hold and overran it, and the
     * gate THREW on `null.padEnd` rather than failing, which is the shape CLAUDE.md records: a
     * tool that throws is not a tool that passes and nobody notices which. Sized against the
     * module's own figure, and `stars > 0` is asserted below so an overrun fails instead.
     */
    const leg = w.evadeRequired() / 3;
    run(w, leg, ORIGIN, { seen: false });
    const searching = composeWanted(w.hudState());
    const midEvade = searching.evade;
    run(w, leg, ORIGIN, { seen: false });
    const later = composeWanted(w.hudState());
    const show = (r) => `${String(r.note ?? '—').padEnd(12)} flash ${r.flash}  evade ${r.evade.toFixed(3)}`;
    console.log(`    reported:    ${show(reported)}`);
    console.log(`    in contact:  ${show(active)}`);
    console.log(`    evading:     ${show(searching)}`);
    console.log(`    ${leg.toFixed(1)} s later:  ${show(later)}`);
    check('the out-of-contact arms stayed inside the cooldown, so they measured a live level',
      w.stars > 0, `${w.stars} stars after ${(2 * leg).toFixed(1)} s of a ` +
      `${w.evadeRequired().toFixed(1)} s cooldown`);
    check('in contact the alarm is up', active.flash === true && reported.flash === true,
      [reported.flash, active.flash]);
    check('and out of contact it is DOWN, which is the whole point of the change',
      searching.flash === false && later.flash === false, [searching.flash, later.flash]);
    check('in contact the drain reads empty, because the escape clock is pinned at zero',
      active.evade === 0 && reported.evade === 0, [reported.evade, active.evade]);
    check('and out of contact it climbs', later.evade > midEvade && midEvade > 0,
      `${midEvade.toFixed(3)} -> ${later.evade.toFixed(3)}`);
    check('the two signals are not the same signal',
      active.flash !== searching.flash && active.evade !== later.evade, 'distinct');
    // The note names which of the three it is, in words, for a host with no canvas.
    check('a fresh witness report reads REPORTED, then eyes alone read SEEN',
      reported.note === 'REPORTED' && active.note === 'SEEN',
      `${reported.note} -> ${active.note}`);
    check('and out of contact it reads EVADING with a countdown',
      /^EVADING \d+s$/.test(searching.note), searching.note);
  }

  // --- (c) the drain is a READING: it reaches the top just before the star goes, and resets.
  {
    const w = new WantedSystem();
    w.reportCrime('assault', { at: ORIGIN });
    run(w, 2, ORIGIN, { seen: true });
    const before = w.stars;
    let peak = 0, shedAt = null;
    for (let i = 0; i < Math.round(200 / DT); i++) {
      w.update(DT, { x: 0, z: 0, seen: false });
      const e = composeWanted(w.hudState()).evade;
      if (w.stars === before) peak = Math.max(peak, e);
      else if (shedAt === null) shedAt = +w.time.toFixed(2);
    }
    console.log(`    the drain peaked at ${peak.toFixed(3)} and the star went at t=${shedAt}s`);
    check('the drain fills before the star sheds, so it is a countdown and not a light',
      peak > 0.97, peak);
    check('and the star did shed, or the peak above measured nothing',
      shedAt !== null && w.stars < before, `${before} -> ${w.stars}`);
    check('the drain is bounded to 0..1', peak <= 1, peak);
  }

  // --- (d) the four notes are four DIFFERENT strings. The band's five tenants had this defect:
  //     a ladder can pass by returning one tenant twice.
  {
    const notes = [
      composeWanted({ stars: 2, state: STATES.ACTIVE, hasFreshFix: false }).note,
      composeWanted({ stars: 2, state: STATES.ACTIVE, hasFreshFix: true }).note,
      composeWanted({ stars: 2, state: STATES.SEARCH, remaining: 24 }).note,
      composeWanted({ stars: 2, state: STATES.CLEAR }).note,
    ];
    console.log(`    notes: ${notes.join(' | ')}`);
    check('the four wanted notes are four different strings', new Set(notes).size === 4,
      notes.join(' | '));
    check('a witnessed report reads differently from being seen',
      notes[0] === 'SEEN' && notes[1] === 'REPORTED', notes.slice(0, 2).join(' / '));
    check('the evading note carries the seconds, rounded up so it never shows 0s while running',
      composeWanted({ stars: 1, state: STATES.SEARCH, remaining: 0.2 }).note === 'EVADING 1s',
      composeWanted({ stars: 1, state: STATES.SEARCH, remaining: 0.2 }).note);
  }

  // --- (e) the scene line, driven rather than tabulated: it has to count DOWN to the charge.
  {
    const w = new WantedSystem();
    const speed = 14;
    let x = -speed;
    while (x < 0) { x += speed * DT; w.update(DT, { x, z: 0 }); }
    w.reportCrime('pedestrianHit', { at: { x: 0, z: 0 } });
    const atScene = composeLaw(w.hudState());
    const seen = [];
    let fledLine = null;
    while (x < SCENE_LEAVE_M + 20) {
      x += speed * DT;
      w.update(DT, { x, z: 0 });
      const s = w.hudState();
      if (s.scene) {
        seen.push({ d: s.scene.d, leaveIn: s.scene.leaveIn, line: composeLaw(s),
          // The distance recomputed from the car's own position and the scene's, which is what
          // `_watchScene` decides on. `sc.d` has to BE this, not agree with a sibling field.
          trueD: Math.hypot(x - s.scene.x, 0 - s.scene.z) });
      }
      else if (!fledLine) fledLine = composeLaw(s);
    }
    const first = seen[0], last = seen[seen.length - 1];
    console.log(`    at the scene:  "${objectiveLine(atScene.objective)}" / "${atScene.subtitle}"`);
    console.log(`    ${first.d.toFixed(1)} m out -> ${last.d.toFixed(1)} m out: ` +
      `leaveIn ${first.leaveIn.toFixed(1)} -> ${last.leaveIn.toFixed(1)} m`);
    console.log(`    once it fired: "${objectiveLine(fledLine?.objective)}" / "${fledLine?.subtitle}"`);
    check('a live scene takes the band',
      atScene && objectiveLine(atScene.objective).startsWith('STOP AT THE SCENE'), atScene);
    check('the distance counts DOWN to the charge, not up from the scene',
      last.leaveIn < first.leaveIn && last.leaveIn >= 0,
      `${first.leaveIn.toFixed(1)} -> ${last.leaveIn.toFixed(1)}`);
    /**
     * AND THE NUMBER IS READ OFF THE COMPOSED LINE, not off the snapshot it came from. Every check
     * here read `leaveIn` from `hudState()`, so a composer that dropped the number, or printed the
     * wrong field, passed — a blind reviewer's mutation replacing `sc.leaveIn` with `sc.d` in the
     * string, which inverts the whole meaning, was missed by the entire offline list.
     */
    const lineAt = seen.map((r) => ({ d: r.d, leaveIn: r.leaveIn, line: objectiveLine(r.line.objective) }));
    const nums = lineAt.map((r) => {
      const m = /(\d+)\s*m$/.exec(r.line);
      return m ? +m[1] : null;
    });
    console.log(`    the line carries it: "${lineAt[0].line}" ... "${lineAt[lineAt.length - 1].line}"`);
    check('the composed line carries the distance, and it is the one the rule counts down',
      nums.every((n, i) => n !== null && Math.abs(n - lineAt[i].leaveIn) <= 1),
      `${nums[0]} vs ${lineAt[0].leaveIn.toFixed(1)}, ` +
      `${nums[nums.length - 1]} vs ${lineAt[lineAt.length - 1].leaveIn.toFixed(1)}`);
    check('and it is leaveIn and NOT the distance from the scene, which is the inversion',
      nums.some((n, i) => Math.abs(n - lineAt[i].d) > 5),
      `first: line ${nums[0]} m, leaveIn ${lineAt[0].leaveIn.toFixed(1)}, ` +
      `d ${lineAt[0].d.toFixed(1)}`);
    check('the number on the line goes DOWN as the car drives away',
      nums[nums.length - 1] < nums[0], `${nums[0]} -> ${nums[nums.length - 1]}`);
    /**
     * AND `sc.d` IS THE REAL DISTANCE, recomputed from the drive's own coordinates. The old check
     * asserted `d + leaveIn === SCENE_LEAVE_M`, which is an algebraic identity between two fields
     * written in one return statement — it cannot fail for any `sc.d` whatsoever, and a reviewer
     * showed it passing for both `sc.d = 0` and `sc.d = d * 0.5`. The rule's `d` is a local in
     * `_watchScene`; the readout's is a field; nothing compared them.
     */
    check('and the scene distance is the real distance, not a decoupled copy of it',
      seen.every((r) => near(r.d, r.trueD, 1e-6)),
      `worst ${Math.max(...seen.map((r) => Math.abs(r.d - r.trueD))).toExponential(2)} m apart`);
    check('the offence that fired is named in the band the instant the scene clears',
      fledLine && objectiveLine(fledLine.objective) === CRIMES.hitAndRun.label.toUpperCase(),
      objectiveLine(fledLine?.objective));
    // Non-empty by construction: an arm that never left the radius would satisfy the two above.
    check('the drive actually crossed the leave radius',
      seen.length > 0 && fledLine !== null && w.stats.scenesFled === 1,
      `${seen.length} frames inside, fled ${w.stats.scenesFled}`);
  }

  // --- (f) stopping gets its own line, because a mechanic whose reward is "nothing happens"
  //     teaches nothing. A playtester measured a decay indistinguishable from doing nothing.
  {
    const w = new WantedSystem();
    const speed = 14;
    let x = -speed;
    while (x < 0) { x += speed * DT; w.update(DT, { x, z: 0 }); }
    w.reportCrime('pedestrianHit', { at: { x: 0, z: 0 } });
    for (let i = 0; i < 180; i++) w.update(DT, { x: 0, z: 0 });
    const stopped = composeLaw(w.hudState());
    console.log(`    stopped:       "${objectiveLine(stopped.objective)}" / "${stopped.subtitle}"`);
    check('stopping at the scene says so',
      stopped && objectiveLine(stopped.objective) === 'STOPPED AT THE SCENE', stopped);
    check('and it is a different line from the instruction it replaces',
      objectiveLine(stopped.objective) !== 'STOP AT THE SCENE' && w.stats.scenesStopped === 1,
      `scenesStopped ${w.stats.scenesStopped}`);
    // The stopped line carries NO distance, because there is nothing left to count down to.
    check('and the stopped line drops the distance, there being nothing to count down to',
      !/\d+\s*m$/.test(objectiveLine(stopped.objective)), objectiveLine(stopped.objective));
    // Drive off afterwards: no charge, and the line goes rather than sticking.
    while (x < SCENE_LEAVE_M + 20) { x += speed * DT; w.update(DT, { x, z: 0 }); }
    check('driving off after stopping files nothing and leaves no line',
      w.stats.scenesFled === 0 && composeLaw(w.hudState()) === null,
      `fled ${w.stats.scenesFled}, line ${JSON.stringify(composeLaw(w.hudState()))}`);
  }

  // --- (g) the notice expires, and an IGNORED crime never sets one.
  {
    const w = new WantedSystem();
    w.reportCrime('assault', { at: ORIGIN });
    const fresh = composeLaw(w.hudState());
    run(w, LAW_NOTICE_S - 0.5, ORIGIN, { seen: false });
    const nearly = composeLaw(w.hudState());
    run(w, 1.0, ORIGIN, { seen: false });
    const gone = composeLaw(w.hudState());
    console.log(`    notice at 0 s "${objectiveLine(fresh?.objective)}" / "${fresh?.subtitle}", at ` +
      `${(LAW_NOTICE_S - 0.5).toFixed(1)} s "${objectiveLine(nearly?.objective)}", at ` +
      `${(LAW_NOTICE_S + 0.5).toFixed(1)} s ${JSON.stringify(gone)}`);
    check('a filed crime is named in the band',
      fresh && objectiveLine(fresh.objective) === CRIMES.assault.label.toUpperCase(),
      objectiveLine(fresh?.objective));
    /**
     * AND THE NOTICE'S SUBTITLE SAYS WHAT IT COST, which nothing asserted: only `objective` was
     * ever read, so a composer that always said "nobody saw it" — on a crime that had just made
     * the player wanted — passed the whole offline list.
     */
    check('the notice says what the crime cost, and it is the live star count',
      /wanted — \d+ star/.test(fresh.subtitle) && fresh.subtitle.includes(String(w.stars)),
      `${fresh.subtitle} at ${w.stars} stars`);
    const quiet = new WantedSystem();
    quiet.reportCrime('propertyDamage', { at: ORIGIN, witnessed: false });
    const qLine = composeLaw(quiet.hudState());
    check('and an unwitnessed crime with no level says the other thing',
      qLine && qLine.subtitle !== fresh.subtitle,
      `${qLine?.subtitle} against ${fresh.subtitle}`);
    check('it is still there just before the notice expires', nearly !== null, nearly);
    check(`and gone after LAW_NOTICE_S (${LAW_NOTICE_S} s)`, gone === null, gone);

    // An ignored crime is not an event, so it must not produce a line. `requiresWanted` with no
    // stars is the cleanest ignore in the table.
    const w2 = new WantedSystem();
    const p = w2.reportCrime('evading', { at: ORIGIN });
    check('an IGNORED crime sets no notice, so the band does not name something that never happened',
      p.applied === false && w2.hudState().notice === null && composeLaw(w2.hudState()) === null,
      `${p.reason}, notice ${JSON.stringify(w2.hudState().notice)}`);
  }

  // --- (h) the snapshot tracks the live system rather than being a second copy of it.
  {
    const w = new WantedSystem();
    w.reportCrime('officerDown', { at: ORIGIN });
    run(w, 4, ORIGIN, { seen: true });
    const s = w.hudState();
    check('the snapshot reports the live stars, state and unit count',
      s.stars === w.stars && s.state === w.state && s.units === w.units.length, s);
    check('and the live escape progress and the seconds left',
      near(s.evade, w.evadeProgress, 1e-12)
      && near(s.remaining, Math.max(0, w.evadeRequired() - w.evadeTimer), 1e-12),
      `${s.evade} / ${s.remaining}`);
    check('remaining is the required cooldown while in contact, not zero',
      s.remaining > 0 && near(s.remaining, w.evadeRequired(), 1e-9),
      `${s.remaining.toFixed(2)} against ${w.evadeRequired().toFixed(2)}`);
    /**
     * AND OUT OF CONTACT, WHICH IS THE ONLY PLACE THE CHECK MEANS ANYTHING. Every sample above is
     * taken IN CONTACT, where `evadeTimer` is pinned at zero — so `remaining` and
     * `evadeRequired()` are the same number and `near(remaining, required - timer)` compares a
     * value with itself. A blind reviewer replaced the whole expression with `req`, freezing the
     * `EVADING 24s` countdown at the full cooldown for ever, and the entire offline list missed it:
     * §23(b) only regex-matches `/^EVADING \d+s$/`.
     */
    const ticks = [];
    for (let k = 0; k < 4; k++) {
      run(w, w.evadeRequired() / 6, ORIGIN, { seen: false });
      const t = w.hudState();
      ticks.push({ remaining: t.remaining, timer: w.evadeTimer, req: w.evadeRequired(),
        note: composeWanted(t).note });
    }
    console.log(`    out of contact, remaining ticks down: ` +
      ticks.map((t) => t.remaining.toFixed(1)).join(' -> ') +
      `  (notes ${ticks.map((t) => t.note).join(', ')})`);
    check('out of contact the seconds left tick DOWN, so the countdown is a countdown',
      ticks.every((t, i) => i === 0 || t.remaining < ticks[i - 1].remaining),
      ticks.map((t) => t.remaining.toFixed(2)).join(' '));
    check('and each one is the cooldown less the clock, measured where those differ',
      ticks.every((t) => near(t.remaining, t.req - t.timer, 1e-9) && t.timer > 0),
      ticks.map((t) => `${t.remaining.toFixed(1)}=${t.req.toFixed(1)}-${t.timer.toFixed(1)}`).join(' '));
    check('the note carries those falling seconds, not one frozen number',
      new Set(ticks.map((t) => t.note)).size === ticks.length, ticks.map((t) => t.note).join(' '));
  }
}

// ------------------- 24. the charge ladder: a person over a building, at every speed
/**
 * THE TABLE'S ORDER WAS INVERTED AND ITS OWN COMMENTS DID NOT COMPARE THE TWO SIDES.
 *
 * `min` is a floor on heat — "this crime is at least N stars" — and several crimes have none,
 * which is the table saying they are not enough on their own to make you wanted. `opts.scale` had
 * no ceiling, and src/damage.js scales a delta-v crime by `severity / majorSeverity`, which reaches
 * 8.33x. So on a clean record a wall at 60 km/h charged 2.50 (two stars) and a civilian car 4.17
 * (FOUR stars), against 1.00 — one star — for a pedestrian struck at any survivable speed.
 *
 * A round-5 playtester reported the wall half. The car half is nearly twice as large and nobody had
 * looked, because damage.js's own refusal table measures the PEDESTRIAN side in detail and never
 * puts the two next to each other.
 *
 * What this section owes is the RELATION, swept over speed, rather than either side's number: a
 * crime the table ranks above another must not be out-charged by it.
 */
{
  console.log('\n24. the charge ladder');
  // Derived here from the table rather than imported from src/wanted.js, so the two derivations
  // have to agree; the check below asserts this IS the table's lowest positive floor.
  const FLOORLESS_CAP_EXPECTED = Math.min(...Object.values(CRIMES)
    .map((c) => c.min ?? 0).filter((m) => m > 0));
  /**
   * NOT ROUNDED. This returned `+w.heat.toFixed(4)` and the known-bad check below compares the raw
   * product against it — so 0.022411 rounded to 0.0224 read as "the cap bit here", and the arm
   * reported the cap biting at 8 of 8 speeds including 8 km/h, where the raw charge is 0.02 and
   * nothing is capped at all. The check would have passed for a cap that did nothing. Round at the
   * print, never before a comparison.
   */
  const clean = (id, scale) => {
    const w = new WantedSystem();
    w.reportCrime(id, { at: ORIGIN, scale });
    return { heat: w.heat, stars: w.stars };
  };

  /**
   * What ONE impact of `kind` at `kmh` charges, through the model's own scale — never through a
   * number copied out of it. A fresh DamageModel per call so no refractory and no accumulated
   * health can decide the answer.
   */
  const impactCharge = (kind, kmh) => {
    const v = kmh / 3.6;
    // A struck body cannot take the car's whole closing speed: damage.js's own pedestrian dv is
    // bounded. The pedestrian SCALE is a function of `speed` alone, so this only has to be enough
    // to file the crime.
    const dv = kind === IMPACT.pedestrian ? Math.min(v, 12) : v * 1.15;
    const rec = new DamageModel().impact({ dv, kind, speed: v });
    if (!rec || !rec.crime) return { id: null, heat: 0, stars: 0, scale: 0 };
    return { id: rec.crime, scale: rec.crimeScale, ...clean(rec.crime, rec.crimeScale) };
  };

  const dmg = new DamageModel();
  const SPEEDS = [8, 20, 40, 60, 70, +(dmg.pedKillSpeed * 3.6).toFixed(1), 90, 110];
  const rows = SPEEDS.map((kmh) => ({
    kmh,
    ped: impactCharge(IMPACT.pedestrian, kmh),
    wall: impactCharge(IMPACT.wall, kmh),
    car: impactCharge(IMPACT.vehicle, kmh),
  }));
  console.log('    km/h   a person                a wall          a civilian car');
  for (const r of rows) {
    const fmt = (c, w) => `${(c.id ?? '-').padEnd(w)} ${c.heat.toFixed(2)}/${c.stars}*`;
    console.log(`   ${r.kmh.toFixed(1).padStart(5)}   ${fmt(r.ped, 16)}   ${fmt(r.wall, 8)}` +
      `   ${fmt(r.car, 8)}`);
  }
  out.chargeLadder = rows.map((r) => ({ kmh: r.kmh, ped: +r.ped.heat.toFixed(4),
    pedStars: r.ped.stars, wall: +r.wall.heat.toFixed(4), wallStars: r.wall.stars,
    car: +r.car.heat.toFixed(4), carStars: r.car.stars }));

  // Every arm has to assert the thing it measures HAPPENED: a sweep where no crime is filed
  // satisfies every ordering below with both sides at zero.
  check('every speed in the sweep files all three crimes',
    rows.every((r) => r.ped.id && r.wall.id && r.car.id),
    rows.map((r) => `${r.kmh}:${r.ped.id ?? '-'}/${r.wall.id ?? '-'}/${r.car.id ?? '-'}`).join(' '));
  check('a struck person always costs at least as much as a wall at the same speed',
    rows.every((r) => r.ped.heat >= r.wall.heat - 1e-9),
    rows.filter((r) => r.ped.heat < r.wall.heat).map((r) => `${r.kmh}: ${r.ped.heat} vs ${r.wall.heat}`)
      .join(' ') || 'every speed');
  check('and at least as much as a civilian car, which was the larger inversion',
    rows.every((r) => r.ped.heat >= r.car.heat - 1e-9),
    rows.filter((r) => r.ped.heat < r.car.heat).map((r) => `${r.kmh}: ${r.ped.heat} vs ${r.car.heat}`)
      .join(' ') || 'every speed');
  check('in STARS too, which is the only part of it a player reads',
    rows.every((r) => r.ped.stars >= r.wall.stars && r.ped.stars >= r.car.stars),
    rows.map((r) => `${r.kmh}:${r.ped.stars}/${r.wall.stars}/${r.car.stars}`).join(' '));

  /**
   * KNOWN-BAD, AND NOT OPTIONAL: the cap has to BITE, or every check above passes for a model whose
   * scale never exceeded 1 in the first place. The raw product is what the table used to apply, so
   * it is this arm's own control — and the number it would have charged is printed beside it.
   */
  const rawOf = (c) => (c.id ? CRIMES[c.id].heat * c.scale : 0);
  const bit = rows.filter((r) => rawOf(r.wall) > r.wall.heat + 1e-9 || rawOf(r.car) > r.car.heat + 1e-9);
  const unbit = rows.filter((r) => r.kmh < 20);
  const at60 = rows.find((r) => r.kmh === 60);
  console.log(`    the cap bites at ${bit.length} of ${rows.length} speeds; at 60 km/h a wall would ` +
    `raw-charge ${rawOf(at60.wall).toFixed(2)} and charges ${at60.wall.heat.toFixed(2)}, ` +
    `a car ${rawOf(at60.car).toFixed(2)} -> ${at60.car.heat.toFixed(2)}`);
  check('KNOWN-BAD: the cap actually bites, so the ordering is not true by accident',
    bit.length >= 4 && rawOf(at60.car) > 3, `${bit.length} of ${rows.length} speeds, ` +
    `car raw ${rawOf(at60.car).toFixed(2)}`);
  // And it bites at SOME speeds and not others, which is the other half of the same statement: a
  // cap that engaged everywhere would be a flat charge wearing a ceiling's name.
  check('and does not bite below the speeds where the raw charge is under it',
    unbit.length > 0 && unbit.every((r) => !bit.includes(r)),
    unbit.map((r) => `${r.kmh}: wall raw ${rawOf(r.wall).toFixed(3)} charged ` +
      `${r.wall.heat.toFixed(3)}`).join('; '));

  /**
   * AND WHERE IT FIRST BITES, because "the cap engages at 60 km/h" is not the same claim as "the
   * cap engages while driving" and only the second one says the fix is not cosmetic. Swept on a
   * 1 km/h grid: a wall crosses the ceiling at 29 km/h and a civilian car at 23, both well inside
   * ordinary street speed, and `severityFor` saturates at 50 so everything above that is one
   * reading.
   *
   * THIS IS ALSO WHAT SAYS THE FIX IS INVISIBLE ON A SLOW DRIVE, which is worth knowing before
   * quoting it. A recorded 200 m drive of 16 offences — 13 of them `civilianCollision` in a
   * low-speed traffic scrum — produced a worst scale of 1.82, raw charge 0.91, UNDER the ceiling:
   * replayed through both policies the cap never engaged once and the whole 3.77 -> 3.85 heat
   * difference was the pedestrian table value, with the star trajectory identical (1* at offence
   * 1, 2* at 8, 3* at 13). A drive is not the instrument for this change; the sweep is.
   */
  {
    /**
     * MEASURED AGAINST THE MODULE, NOT AGAINST THIS FILE'S OWN CONSTANT. The first version
     * thresholded the raw product on `FLOORLESS_CAP_EXPECTED` — a number computed HERE — so it
     * printed "wall 29, car 23" whatever the module's cap actually was. A blind mutation reviewer
     * swept it: with the module's cap at 0, 0.15, 1 and 4 the truths are 7/7, 13/11, 29/23 and
     * null/43, and this arm said 29/23 at all four. That is CLAUDE.md's self-validation closing
     * over the same quantity twice, inside the arm whose own comment claims it "says the fix is
     * not cosmetic".
     *
     * So it asks the module: the first speed at which the CHARGE is less than the raw product is
     * the first speed at which something capped it, whatever the cap is.
     */
    const firstBite = (id, kind) => {
      for (let k = 1; k <= 140; k++) {
        const r = new DamageModel().impact({ dv: (k / 3.6) * 1.15, kind, dirZ: 1, speed: k / 3.6 });
        if (r.crime !== id) continue;
        const raw = CRIMES[id].heat * r.crimeScale;
        if (raw > clean(id, r.crimeScale).heat + 1e-9) return k;
      }
      return null;
    };
    const wallAt = firstBite('propertyDamage', IMPACT.wall);
    const carAt = firstBite('civilianCollision', IMPACT.vehicle);
    console.log(`    the cap first bites at ${wallAt} km/h against a wall and ${carAt} km/h ` +
      `against a civilian car`);
    check('the cap engages at ordinary street speed, so the fix is not cosmetic',
      wallAt !== null && carAt !== null && wallAt < 40 && carAt < 40 && carAt < wallAt,
      `wall ${wallAt} km/h, car ${carAt} km/h`);
  }

  /**
   * AND IT IS THE TABLE'S OWN LOWEST FLOOR, not a number somebody picked. A crime WITH a floor is
   * uncapped, because its floor already ranks it above — `officerDown` still has to reach five.
   */
  const lowest = Math.min(...Object.values(CRIMES).map((c) => c.min ?? 0).filter((m) => m > 0));
  const floorless = Object.entries(CRIMES).filter(([, c]) => (c.min ?? 0) === 0).map(([k]) => k);
  console.log(`    the lowest floor in the table is ${lowest}; floorless: ${floorless.join(', ')}`);
  check('the cap is the table\'s own lowest floor, which is the least a struck person can cost',
    lowest === 1 && lowest === CRIMES.pedestrianHit.min, `${lowest}`);
  /**
   * AT the cap, not merely under it. This was `<= lowest + 1e-9`, and a reviewer pointed out that
   * `clean(id, 1e6).heat` reads EXACTLY 1 — so the one-sided bound left room for a cap that
   * clamped lower than the table's floor and still passed. An equality is one token and says the
   * whole thing: an absurd scale lands exactly on the ceiling.
   */
  /**
   * AND `evading` IS REFUSED RATHER THAN CAPPED, which the equality found. It reads 0.0000 at an
   * absurd scale because `reportCrime` ignores it with no wanted level at all — running from a
   * pursuit that does not exist is not an offence — and §6 owns that rule. So the two cases are
   * asserted separately rather than the bound being loosened to cover both: a crime that is
   * ACCEPTED lands exactly on the ceiling, and `evading` is accepted by nobody here.
   */
  const accepted = floorless.filter((id) => clean(id, 1).heat > 0);
  const refused = floorless.filter((id) => clean(id, 1).heat === 0);
  console.log(`    at an absurd scale: ${accepted.map((id) => `${id} ${clean(id, 1e6).heat}`)
    .join(', ')}; refused outright: ${refused.join(', ') || 'none'}`);
  check('every floorless crime that files at all lands exactly ON the cap, not merely under',
    accepted.length >= 3 &&
    accepted.every((id) => Math.abs(clean(id, 1e6).heat - lowest) < 1e-9),
    accepted.map((id) => `${id}:${clean(id, 1e6).heat.toFixed(4)}`).join(' '));
  check('and the ones that read zero are refused rather than capped to zero',
    refused.every((id) => clean(id, 1e6).heat === 0 && (CRIMES[id].min ?? 0) === 0),
    refused.join(' ') || 'none');
  check('and a crime WITH a floor is NOT capped, or the worst offence would be the mildest',
    clean('officerDown', 8.33).stars === 5,
    `officerDown at 8.33x -> ${clean('officerDown', 8.33).heat.toFixed(2)} heat, ` +
    `${clean('officerDown', 8.33).stars} stars`);

  // The cap is on ONE crime's contribution, not on the running total, so repeats still stack. Run
  // the clock between them with the module's own stepper, past propertyDamage's 2.5 s refractory.
  {
    const w = new WantedSystem();
    const each = [];
    for (let k = 0; k < 5; k++) {
      w.reportCrime('propertyDamage', { at: ORIGIN, scale: 8.33 });
      each.push(+w.heat.toFixed(2));
      run(w, 3, ORIGIN, { seen: true });     // seen: no decay, so this isolates the stacking
    }
    console.log(`    five wall strikes 3 s apart: heat ${each.join(' -> ')}`);
    check('the cap is per crime, not per record, so repeats still stack',
      each[4] > each[0] * 3, each.join(' '));
  }

  /**
   * AND THE PEDESTRIAN CHARGE MEETS THE KILLED FLOOR AT THE CLASSIFICATION SWITCH, instead of
   * jumping at one published speed. `_crimeFor` switches at `pedKillSpeed`, the fatality curve's
   * own 50% point, so a strike AT that speed should cost what a kill costs at its floor.
   */
  console.log(`    pedestrianHit heat ${CRIMES.pedestrianHit.heat} against pedestrianKilled's ` +
    `floor ${CRIMES.pedestrianKilled.min}`);
  check('a strike at the fatality threshold costs exactly what a kill costs at its floor',
    CRIMES.pedestrianHit.heat === CRIMES.pedestrianKilled.min,
    `${CRIMES.pedestrianHit.heat} against ${CRIMES.pedestrianKilled.min}`);
  {
    const kmh = dmg.pedKillSpeed * 3.6;
    const below = impactCharge(IMPACT.pedestrian, kmh - 0.5);
    const above = impactCharge(IMPACT.pedestrian, kmh + 0.5);
    console.log(`    across the switch at ${kmh.toFixed(1)} km/h: ${below.id} ` +
      `${below.heat.toFixed(2)} -> ${above.id} ${above.heat.toFixed(2)}`);
    check('the two pedestrian crimes meet at the switch rather than stepping',
      below.id !== above.id && Math.abs(above.heat - below.heat) < 0.2,
      `${below.id} ${below.heat.toFixed(2)} -> ${above.id} ${above.heat.toFixed(2)}`);
  }
  /**
   * The graduation is in HEAT and not in STARS below the switch, and that is the table's structure
   * rather than a defect: `min: 1` is a floor and the next rung is 2, so every scale under 0.5 comes
   * back out as one star. src/damage.js records that mechanism and was right about it. Asserted both
   * ways so nobody "fixes" the star half by lowering the floor.
   */
  {
    const band = [50, 60, 70, 76].map((k) => impactCharge(IMPACT.pedestrian, k));
    console.log(`    50-76 km/h: heat ${band.map((b) => b.heat.toFixed(2)).join(' ')}, ` +
      `stars ${band.map((b) => b.stars).join(' ')}`);
    check('the charge graduates in heat over the band where the risk curve is steep',
      band[3].heat > band[0].heat + 0.3, band.map((b) => b.heat.toFixed(2)).join(' '));
    check('and stays one star there, because min is a floor and the next rung is 2',
      band.every((b) => b.stars === 1), band.map((b) => b.stars).join(' '));
  }
}

// ------------------------------- 25. being busted, which nothing in the game could do
/**
 * `clear()` AND `damage.repair()` HAVE ALWAYS EXISTED AND NOTHING EVER CALLED THEM. Measured
 * before this section was written: five stars, engine off, never moving, `units 6/0` — six units
 * requested and ZERO reporting a position, because tools/playtest.mjs builds no pursuit layer — and
 * the level bled 4* -> 3* -> 2* -> ... -> 0 over 87 s while the player sat still. The escape was
 * automatic and unconditional, so every playtester's report on evasion was measured against a game
 * with no police in it.
 *
 * THE RULE IS A CONJUNCTION AND EVERY TERM OF IT IS TESTED HERE SEPARATELY, because the failure
 * mode of a rule like this is not firing wrongly — it is never firing at all, which looks exactly
 * like a player who keeps escaping.
 */
{
  console.log('\n25. being busted');
  const at = (x, z) => ({ x, z });
  /**
   * Hold the player at one spot with `held` as given. `run` cannot be used: it does not carry a
   * `held` flag, and adding one there would put a bust-specific field in every other section's
   * helper.
   */
  const hold = (w, seconds, opts = {}) => {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      const p = { ...(opts.at ?? ORIGIN), seen: opts.seen ?? true, held: opts.held ?? true };
      if (opts.each) opts.each(w, i, p);
      w.update(DT, p);
    }
    return w;
  };
  const wanted1 = () => {
    const w = new WantedSystem({ seed: 25 });
    w.reportCrime('pedestrianHit', { at: ORIGIN, scale: 0.01 });
    return w;
  };

  // (a) the whole flow, once, with the event and the numbers it carries.
  {
    const w = wanted1();
    const busts = [];
    w.on('busted', (e) => busts.push({ t: +w.time.toFixed(2), stars: w.stars, at: e.at,
      heldFor: e.heldFor }));
    const before = w.stars;
    hold(w, BUST_HOLD_S + 0.2, { at: at(12, -4) });
    console.log(`    held stopped for ${(BUST_HOLD_S + 0.2).toFixed(1)} s at ${before} star: ` +
      `${busts.length} bust, stars now ${w.stars}, state ${w.state}`);
    check('a unit holding a stopped player busts them', busts.length === 1,
      `${busts.length} busts`);
    check('and the level is already zero when the event lands, not five',
      busts[0] && busts[0].stars === 0, busts[0] ? `${busts[0].stars}` : 'no event');
    check('the event carries where it happened and how long the hold was',
      busts[0] && Math.abs(busts[0].at.x - 12) < 1e-9 && Math.abs(busts[0].at.z + 4) < 1e-9
        && busts[0].heldFor === BUST_HOLD_S,
      busts[0] ? `${busts[0].at.x},${busts[0].at.z} for ${busts[0].heldFor}` : 'no event');
    check('the reason is `busted`, so a host can tell it from an escape',
      w.stars === 0 && w.state === STATES.CLEAR, `${w.stars}* ${w.state}`);
    check('and it is counted, so a rule that never fires is visible',
      w.stats.busts === 1 && w.stats.bustHolds === 1,
      `busts ${w.stats.busts}, holds ${w.stats.bustHolds}`);
  }

  // (b) KNOWN-BAD on the clock: shorter than BUST_HOLD_S must not bust.
  {
    const w = wanted1();
    let n = 0;
    w.on('busted', () => n++);
    hold(w, BUST_HOLD_S - 0.2, { at: ORIGIN });
    console.log(`    held for ${(BUST_HOLD_S - 0.2).toFixed(1)} s: ${n} busts, ` +
      `clock at ${w.bustFor.toFixed(2)} s, HUD says ${w.hudState().bustIn?.toFixed(2)} s left`);
    check('KNOWN-BAD: a hold shorter than the full clock does not bust',
      n === 0 && w.stars > 0, `${n} busts at ${w.stars}*`);
    check('and the HUD countdown is running, not null and not frozen',
      w.hudState().bustIn > 0 && w.hudState().bustIn < 0.3,
      `${w.hudState().bustIn}`);
  }

  // (c) every term of the conjunction, each removed alone.
  {
    const arms = [
      { name: 'nobody holding you', opts: { held: false } },
      { name: 'moving faster than the stop threshold',
        opts: { each: (w, i, p) => { p.x = i * DT * 6; } } },
      { name: 'no wanted level at all', crime: false, opts: {} },
    ];
    for (const a of arms) {
      const w = a.crime === false ? new WantedSystem({ seed: 25 }) : wanted1();
      let n = 0;
      w.on('busted', () => n++);
      hold(w, BUST_HOLD_S * 3, a.opts);
      console.log(`    ${a.name.padEnd(38)} ${n} busts over ${(BUST_HOLD_S * 3).toFixed(0)} s ` +
        `(armed ${w.stats.bustHolds})`);
      check(`no bust while ${a.name}`, n === 0, `${n} busts`);
    }
  }

  /**
   * (d) THE CLOCK RESETS RATHER THAN DECAYS, and this is the arm that says so. Four separate
   * holds of 0.9 * BUST_HOLD_S with a moment of movement between them add to 3.6x the clock; a
   * decaying or accumulating timer busts on the second one and calls it "a unit held you".
   */
  {
    const w = wanted1();
    let n = 0;
    w.on('busted', () => n++);
    const peaks = [];
    for (let k = 0; k < 4; k++) {
      hold(w, BUST_HOLD_S * 0.9, { at: ORIGIN });
      peaks.push(+w.bustFor.toFixed(2));
      // One step of real movement: 6 m/s for 0.5 s is past the threshold with the smoothing.
      hold(w, 0.5, { held: true, each: (ww, i, p) => { p.x = i * DT * 6; } });
    }
    console.log(`    four holds of ${(BUST_HOLD_S * 0.9).toFixed(1)} s with movement between: ` +
      `${n} busts, clock peaked at ${peaks.join(' ')} s, armed ${w.stats.bustHolds}x`);
    check('four interrupted holds do not add up to a bust', n === 0, `${n} busts`);
    check('and the clock started over each time, which is what makes that true',
      w.stats.bustHolds === 4 && peaks.every((v) => v < BUST_HOLD_S),
      `armed ${w.stats.bustHolds}, peaks ${peaks.join(' ')}`);
  }

  // (e) what the player is shown while it runs, through the real composer.
  {
    const w = wanted1();
    const lines = [];
    for (let k = 0; k < 4; k++) {
      hold(w, BUST_HOLD_S / 5, { at: ORIGIN });
      const st = w.hudState();
      lines.push({ bustIn: +st.bustIn.toFixed(2), law: composeLaw(st) });
    }
    const texts = lines.map((l) => objectiveLine(l.law.objective));
    console.log(`    the band while held: ${texts.join(' | ')}`);
    check('the law band says you are being busted and in how long',
      lines.every((l) => l.law && /BUSTED IN/.test(l.law.objective.text)),
      texts.join(' | '));
    check('in SECONDS, not metres — the one objective in the game that is not a distance',
      texts.every((t) => / s$/.test(t)), texts.join(' | '));
    /**
     * THE COUNTDOWN IS THE `bustIn` VALUE; THE TEXT IS THAT VALUE ROUNDED. The first version of
     * this asserted four DISTINCT rendered strings and failed on 2.4 s and 1.6 s both printing
     * "2 s" — a check on the renderer's rounding wearing a countdown's name. What matters is that
     * the quantity falls monotonically and that the drawn string is not frozen.
     */
    check('and the number falls, so it is a countdown rather than one frozen value',
      lines.every((l, i) => i === 0 || l.bustIn < lines[i - 1].bustIn),
      lines.map((l) => l.bustIn).join(' '));
    /**
     * DERIVED, NOT A THRESHOLD. This was `new Set(texts).size >= 3` and the four samples render
     * "3 s | 2 s | 2 s | 1 s" — a set of exactly 3 against a bound of 3, MARGIN ZERO. A blind
     * reviewer flagged it, and CLAUDE.md already has the rule: a check that compares against an
     * absolute number needs the same sweep a measurement does, and a threshold that holds at one
     * value is a coincidence. 3 is not a property of the countdown, it is a property of taking
     * four samples at BUST_HOLD_S/5 through a renderer that rounds.
     *
     * `objectiveLine` prints `Math.round(o.distance)`, so how many distinct strings FOUR samples
     * of a falling quantity must produce is computable exactly from the quantity. Asserting the
     * computed number instead of a floor means the check follows a change to the sample count,
     * the hold length or the rounding, and still fails a renderer that freezes.
     */
    const wantDistinct = new Set(lines.map((l) => Math.round(l.bustIn))).size;
    check('the countdown crosses more than one whole second, so a frozen string would be visible',
      wantDistinct > 1, `${wantDistinct} distinct rounded values in ${lines.length} samples`);
    check('and the drawn string takes exactly the values the rounded quantity does',
      new Set(texts).size === wantDistinct,
      `${new Set(texts).size} drawn against ${wantDistinct} rounded: ${texts.join(' | ')}`);
    check('the subtitle says what to do about it, because the out is not obvious',
      lines[0].law.subtitle === 'drive', `${lines[0].law.subtitle}`);
    /**
     * AND IT SAYS `reverse` TO SOMEBODY ALREADY HOLDING THE THROTTLE OPEN, because "drive" is
     * advice they are already following. A blind playtester nosed into a building at full throttle
     * and was arrested at 9.3 / 13.0 / 19.5 s in 3 of 4 spots, at 0.07-0.25 km/h, with reverse
     * clearing the stop threshold in 2.2 s and nothing saying so. In ordinary play one 9.9 m/s
     * wall impact was BOTH the crime that summoned the police and the thing that stopped the
     * escape, with 10.42 s under the threshold against a 4 s clock.
     *
     * Swept over the sign, because the whole point is which way to go: a NEGATIVE throttle is
     * already reverse in both hosts' control schemes and must not latch it.
     */
    const verb = (throttle) => {
      const w = wanted1();
      const seen = new Set();
      const steps = Math.round((BUST_HOLD_S * 0.6) / DT);
      for (let i = 0; i < steps; i++) {
        w.update(DT, { ...ORIGIN, held: true, seen: true, throttle });
        const l = composeLaw(w.hudState());
        if (l && l.subtitle) seen.add(l.subtitle);
      }
      return [...seen];
    };
    const verbs = [0, 1, 0.5, -0.55, 0.02].map((t) => ({ t, v: verb(t) }));
    console.log('    the verb against the throttle: ' +
      verbs.map((x) => `${x.t} -> ${x.v.join('/')}`).join(', '));
    check('a player already holding the throttle open is told to reverse',
      verbs.find((x) => x.t === 1).v.join() === 'reverse' &&
      verbs.find((x) => x.t === 0.5).v.join() === 'reverse',
      verbs.map((x) => `${x.t}:${x.v.join('/')}`).join(' '));
    check('KNOWN-BAD: and one who is already reversing is NOT, nor is one coasting',
      verbs.find((x) => x.t === -0.55).v.join() === 'drive' &&
      verbs.find((x) => x.t === 0).v.join() === 'drive',
      verbs.map((x) => `${x.t}:${x.v.join('/')}`).join(' '));
    check('the verb does not flicker during one hold, because it latches',
      verbs.every((x) => x.v.length === 1), verbs.map((x) => x.v.length).join(' '));
    // And it outranks the scene of the injury that put the police there.
    const w2 = wanted1();
    w2.reportCrime('pedestrianHit', { at: at(200, 0), scale: 0.01 });
    hold(w2, BUST_HOLD_S / 2, { at: at(200, 0) });
    const st2 = w2.hudState();
    check('being held outranks the scene line, which cannot both fit in four seconds',
      st2.scene && /BUSTED IN/.test(composeLaw(st2).objective.text),
      `scene ${!!st2.scene}, band ${composeLaw(st2).objective.text}`);
  }

  /**
   * (f) THE DERIVATION, ASSERTED AS A RELATION. BUST_HOLD_S's comment measures the floor at
   * 0.68 s — the contiguous time a full brake to rest followed immediately by full throttle spends
   * under 2.2 m/s, flat across entry speeds from 20 to 110 km/h. What must hold is the ordering,
   * not the number: the clock has to outlast an unavoidable stop-and-go and a deliberate pause,
   * and must not outlast a player's patience.
   */
  {
    /**
     * THE FLOOR ON THE QUANTITY THE CLOCK READS. These were 0.68 and 2.67 — the car's RAW speed
     * under `ANCHORS.freeDv` — and `_watchBust` tests the SMOOTHED `playerVel` against
     * `SCENE_STOP_MS`. A blind mutation reviewer caught the mismatch; re-measured on the right
     * signal it is 0.20 and 2.28, so the margin was understated rather than overstated.
     */
    const FLOOR_STOPGO = 0.20, FLOOR_PAUSE_2S = 2.28;  // src/vehicle.js fed to this module
    console.log(`    BUST_HOLD_S ${BUST_HOLD_S} s against a ${FLOOR_STOPGO} s stop-and-go ` +
      `(x${(BUST_HOLD_S / FLOOR_STOPGO).toFixed(1)}) and a ${FLOOR_PAUSE_2S} s pause ` +
      `(x${(BUST_HOLD_S / FLOOR_PAUSE_2S).toFixed(2)}), both on the SMOOTHED velocity the clock ` +
      `tests against SCENE_STOP_MS ${SCENE_STOP_MS}`);
    check('the clock outlasts an unavoidable stop-and-go by at least 10x',
      BUST_HOLD_S > FLOOR_STOPGO * 10, `${BUST_HOLD_S} against ${FLOOR_STOPGO}`);
    check('and outlasts a deliberate two-second pause',
      BUST_HOLD_S > FLOOR_PAUSE_2S, `${BUST_HOLD_S} against ${FLOOR_PAUSE_2S}`);
    check('and is under the shortest star cooldown, or being caught is slower than escaping',
      BUST_HOLD_S < RESPONSE[1].cooldown, `${BUST_HOLD_S} against ${RESPONSE[1].cooldown}`);
    check('the stop test is the scene watcher\'s threshold and not a second one',
      SCENE_STOP_MS === 1.0, `${SCENE_STOP_MS}`);
  }
  /**
   * (g) TWO THINGS A BLIND PLAYTESTER FOUND BY PLAYING, both of which made the rule toothless in
   * a way no number in this file could see.
   */
  {
    // THE VERB SURVIVES A MISSION. `src/hud.js`'s HOLDS_MISSION_SUBTITLE hands a running mission's
    // objective to the subtitle of any tenant above it, and `law` is in that set — so "drive", the
    // one place the game says how to get out of an arrest, was replaced by "still on: ..." in
    // every mission, which is most of the game. Measured at 0 of them.
    const w = wanted1();
    hold(w, BUST_HOLD_S / 2, { at: ORIGIN });
    const line = composeLaw(w.hudState());
    const alone = composeBand({ law: line });
    const running = composeBand({ law: line, mission: { objective: 'DRIVE EAST ALONG MARLIN ST' } });
    console.log(`    the band while held, alone: "${alone.subtitle}"; in a mission: ` +
      `"${running.subtitle}"`);
    check('the bust line keeps its own subtitle, because it is an instruction',
      alone.subtitle === 'drive' && running.subtitle === 'drive',
      `${alone.subtitle} / ${running.subtitle}`);
    check('KNOWN-BAD: and a tenant that does NOT claim one still yields to the mission',
      composeBand({ fence: { objective: 'TURN BACK', subtitle: 'the district ends here' },
        mission: { objective: 'DRIVE EAST' } }).subtitle === 'still on: DRIVE EAST',
      'the fence still yields');

    /**
     * A STEP OUT OF THE CAR IS NOT 114 m/s OF TRAVEL. The host moves the body 1.9 m in one frame
     * and the reported position switches between the player's and the car's, so without
     * `player.teleported` the smoothed velocity spikes and the clock is zeroed. Measured through
     * the harness: pressing F every second armed the clock 109 times in 120 s, peak 0.59 of 4, and
     * never fired, against a control arrested at 16 s.
     */
    const jump = new WantedSystem({ seed: 25 });
    jump.reportCrime('pedestrianHit', { at: ORIGIN, scale: 0.01 });
    let n = 0;
    jump.on('busted', () => n++);
    const steps = Math.round((BUST_HOLD_S + 0.2) / DT);
    for (let i = 0; i < steps; i++) {
      // Every 15th frame, jump 1.9 m and declare it — what toggleVehicle does.
      const tp = i % 15 === 0 && i > 0;
      jump.update(DT, { x: tp ? 1.9 * (i / 15) : 1.9 * Math.floor(i / 15), z: 0,
        held: true, seen: true, teleported: tp });
    }
    console.log(`    ${Math.floor(steps / 15)} declared teleports of 1.9 m during a ${BUST_HOLD_S} s ` +
      `hold: ${n} bust(s), ${jump.stats.teleports} teleports seen, clock armed ` +
      `${jump.stats.bustHolds}x`);
    check('a declared teleport does not become velocity, so stepping out is not an escape',
      n === 1 && jump.stats.teleports > 2 && jump.stats.bustHolds === 1,
      `${n} busts, ${jump.stats.teleports} teleports, ${jump.stats.bustHolds} arms`);
    // KNOWN-BAD: the same jumps NOT declared are what the defect looked like.
    const silent = new WantedSystem({ seed: 25 });
    silent.reportCrime('pedestrianHit', { at: ORIGIN, scale: 0.01 });
    let m = 0;
    silent.on('busted', () => m++);
    for (let i = 0; i < steps; i++) {
      const tp = i % 15 === 0 && i > 0;
      silent.update(DT, { x: tp ? 1.9 * (i / 15) : 1.9 * Math.floor(i / 15), z: 0,
        held: true, seen: true });
    }
    console.log(`    the same jumps undeclared: ${m} bust(s), clock armed ` +
      `${silent.stats.bustHolds}x — which is what the page did before the flag`);
    check('KNOWN-BAD: undeclared, those same jumps clear the clock and nobody is arrested',
      m === 0 && silent.stats.bustHolds > 1,
      `${m} busts, ${silent.stats.bustHolds} arms`);
  }
  /**
   * (h) COOPERATING COSTS TIME, NOT THE JOB, and this is the arm for the choice the band was
   * offering. A blind playtester obeyed "STOP AT THE SCENE", braked, and was arrested at
   * 22.5-32.7 s with the mission ABORTED 4 times out of 4 — while ignoring it kept the mission 4
   * of 4. Priced on this module: fleeing costs 0.80 heat, NO extra star, 10.8 s of cooldown and
   * 11.7 s longer to clear. Eleven seconds against a mission is not a choice.
   *
   * What the hosts do with `cooperated` is theirs; what this asserts is that the flag means what
   * it says, including the two ways it must go false.
   */
  {
    /** Arrive at the scene DRIVING, which the first version of this probe did not. */
    const toScene = (seed = 88) => {
      const w = new WantedSystem({ seed });
      let x = -50;
      for (let t = 0; t < 3; t += DT) { x += 16.7 * DT; w.update(DT, { x, z: 0, seen: false }); }
      w.reportCrime('pedestrianHit', { at: { x, z: 0 }, scale: 0.08 });
      return { w, x };
    };
    /**
     * THE PROBE HAS TO ARRIVE AT THE SCENE, and the first version did not. It filed the hit at
     * t = 0 from rest, and `playerVel` is a smoothed difference that starts at ZERO — so the car
     * read as stopped inside the leave radius on the first frame, `_watchScene` discharged the
     * scene permanently, and `hitAndRun` never fired at all. The arm measured fleeing as free.
     * Three seconds of approach fixes it, and the check below is that the control still charges.
     */
    {
      const bad = new WantedSystem({ seed: 88 });
      bad.reportCrime('pedestrianHit', { at: ORIGIN, scale: 0.08 });
      let x = 0, fled = 0;
      bad.on('crime', (p) => { if (p.id === 'hitAndRun' && p.applied) fled++; });
      while (x < SCENE_LEAVE_M + 40) { x += 16.7 * DT; bad.update(DT, { x, z: 0, seen: false }); }
      console.log(`    a scene armed from REST discharges itself: hitAndRun fired ${fled} time(s)` +
        ` — which is why this section drives in`);
      check('KNOWN-BAD: a probe that does not arrive at the scene measures fleeing as free',
        fled === 0, `${fled} hitAndRun`);
    }

    // Stop: the scene discharges, `cooperated` goes true, and no second offence is filed.
    const { w: stopW, x: sx } = toScene();
    let fledStop = 0;
    stopW.on('crime', (p) => { if (p.id === 'hitAndRun' && p.applied) fledStop++; });
    for (let v = 16.7; v > 0; v -= 11 * DT) stopW.update(DT, { x: sx, z: 0, seen: false });
    for (let t = 0; t < 4; t += DT) stopW.update(DT, { x: sx, z: 0, seen: false });
    // Flee: `hitAndRun` is filed and `cooperated` stays false.
    const { w: fleeW, x: fx } = toScene();
    let fledFlee = 0;
    fleeW.on('crime', (p) => { if (p.id === 'hitAndRun' && p.applied) fledFlee++; });
    let fz = fx;
    while (fz < fx + SCENE_LEAVE_M + 40) { fz += 16.7 * DT; fleeW.update(DT, { x: fz, z: 0, seen: false }); }
    console.log(`    stopped: cooperated ${stopW.cooperated}, hitAndRun ${fledStop}, ` +
      `heat ${stopW.heat.toFixed(2)}, cool ${stopW.cool.toFixed(1)} s`);
    console.log(`    fled:    cooperated ${fleeW.cooperated}, hitAndRun ${fledFlee}, ` +
      `heat ${fleeW.heat.toFixed(2)}, cool ${fleeW.cool.toFixed(1)} s`);
    check('stopping at the scene records that the driver cooperated',
      stopW.cooperated === true && fledStop === 0,
      `${stopW.cooperated}, ${fledStop} hitAndRun`);
    check('and fleeing it does not, and is charged for it',
      fleeW.cooperated === false && fledFlee === 1,
      `${fleeW.cooperated}, ${fledFlee} hitAndRun`);
    check('fleeing costs heat and cooldown but NOT a star, which is why it won',
      fleeW.heat > stopW.heat && fleeW.cool > stopW.cool + 5 && fleeW.stars === stopW.stars,
      `${stopW.heat.toFixed(2)}/${stopW.stars}* cool ${stopW.cool.toFixed(1)} against ` +
      `${fleeW.heat.toFixed(2)}/${fleeW.stars}* cool ${fleeW.cool.toFixed(1)}`);

    // The arrest carries it, which is the whole point.
    {
      const { w, x } = toScene();
      for (let v = 16.7; v > 0; v -= 11 * DT) w.update(DT, { x, z: 0, seen: false });
      const seen = [];
      w.on('busted', (e) => seen.push(e.cooperated));
      hold(w, BUST_HOLD_S + 0.2, { at: { x, z: 0 } });
      console.log(`    arrested after stopping: busted carries cooperated=${seen[0]}`);
      check('the busted event carries the cooperation, so a host can price the arrest',
        seen.length === 1 && seen[0] === true, `${JSON.stringify(seen)}`);
      check('and the flag is reset by the arrest itself', w.cooperated === false,
        `${w.cooperated}`);
    }

    /**
     * AND A LATER OFFENCE ENDS IT. This is the bound on the flag: you stopped, and then you did
     * something else, and the job is no longer protected. Without it, cooperating once would
     * excuse every arrest for the rest of the wanted level.
     */
    {
      const { w, x } = toScene();
      for (let v = 16.7; v > 0; v -= 11 * DT) w.update(DT, { x, z: 0, seen: false });
      for (let t = 0; t < 1; t += DT) w.update(DT, { x, z: 0, seen: false });
      const before = w.cooperated;
      w.reportCrime('policeProperty', { at: { x, z: 0 } });
      const seen = [];
      w.on('busted', (e) => seen.push(e.cooperated));
      hold(w, BUST_HOLD_S + 0.2, { at: { x, z: 0 } });
      console.log(`    then rammed a cruiser: cooperated ${before} -> ${seen[0]}`);
      check('a later crime ends the cooperation, or one stop would excuse everything after it',
        before === true && seen[0] === false, `${before} -> ${JSON.stringify(seen)}`);
    }

    // And the band says what stopping bought, through the real composer, in a mission.
    {
      const { w, x } = toScene();
      for (let v = 16.7; v > 0; v -= 11 * DT) w.update(DT, { x, z: 0, seen: false });
      for (let t = 0; t < 1; t += DT) w.update(DT, { x, z: 0, seen: false });
      const line = composeLaw(w.hudState());
      const band = composeBand({ law: line, mission: { objective: 'DRIVE EAST' } });
      console.log(`    the band after stopping, in a mission: "${objectiveLine(band.objective)}" / ` +
        `"${band.subtitle}"`);
      check('the band tells the player what stopping bought, even in a mission',
        /arrest will not cost the job/.test(String(band.subtitle)), `${band.subtitle}`);
    }
  }
  out.bust = { holdS: BUST_HOLD_S };
}

// ---------------------------------------------------------------- scenario trace
// One readable run of the thing it is actually for: a chase from first offence
// to a clean escape, printed the way a designer would want to read it.
{
  const w = new WantedSystem({ seed: 42 });
  const rows = [];
  const note = (what) => rows.push({
    t: +w.time.toFixed(1), what, stars: w.stars, state: w.state,
    units: w.plan.units, lkp: w.lastKnown.valid
      ? `${w.lastKnown.x.toFixed(0)},${w.lastKnown.z.toFixed(0)}` : '-',
    searchR: +w.plan.searchRadius.toFixed(0), evade: `${w.plan.evade.timer.toFixed(0)}/${w.plan.evade.required.toFixed(0)}`,
  });
  const drive = (t) => ({ x: t * 18, z: 0 });

  run(w, 1, drive, { seen: false }); note('cruising');
  w.reportCrime('civilianCollision', { at: drive(w.time) });
  run(w, 2, drive, { seen: true }); note('clipped a car');
  w.reportCrime('pedestrianHit', { at: drive(w.time) });
  run(w, 3, drive, { seen: true }); note('struck a pedestrian');
  w.reportCrime('policeProperty', { at: drive(w.time) });
  run(w, 4, drive, { seen: true }); note('rammed a cruiser');
  w.reportCrime('evading', { at: drive(w.time) });
  run(w, 6, drive, { seen: true }); note('running from the pursuit');
  const breakAt = w.time;
  run(w, 12, drive, { seen: false }); note('broke line of sight');
  run(w, 20, drive, { seen: false }); note('search widening');
  let guard = 0;
  while (w.stars > 0 && guard++ < 20000) w.update(DT, { ...drive(w.time), seen: false });
  note('clean');
  out.scenario = rows;
  out.scenarioBrokeContactAt = +breakAt.toFixed(1);
}

// ---------------------------------------------------------------- cost
{
  const w = new WantedSystem({ seed: 7 });
  w.reportCrime('officerDown', { at: ORIGIN });
  run(w, 2, ORIGIN, { seen: true });
  const N = 200000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) w.update(DT, { x: i * 0.01, z: 0, seen: i % 600 < 300 });
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  out.cost_per_update_us = +us.toFixed(3);
  out.updates_per_ms = Math.round(1000 / us);
  check('an update at five stars costs well under a frame', us < 100, { us });
}

// ---------------------------------------------------------------- report
console.log(JSON.stringify(out, null, 1));
const failed = checks.filter((c) => !c.ok);
console.log('');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
if (failed.length) {
  console.error(`\nWANTED: FAIL — ${failed.length}/${checks.length} checks`);
  for (const c of failed) console.error(`  ${c.name}: ${JSON.stringify(c.detail)}`);
  process.exit(1);
}
console.log(`\nWANTED: PASS — ${checks.length} checks, ${out.cost_per_update_us} us per update`);
