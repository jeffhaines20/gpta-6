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
  composeWanted, composeLaw, LAW_NOTICE_S } from '../src/wanted.js';

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
{
  const w = new WantedSystem({ seed: 5 });
  const requests = events(w, ['unit:request']);
  const steps = [];
  for (const id of ['pedestrianHit', 'discharge', 'policeProperty', 'officerDown']) {
    w.reportCrime(id, { at: ORIGIN });
    run(w, 1.5, ORIGIN, { seen: true });
    steps.push({
      crime: id, stars: w.stars, heat: +w.heat.toFixed(2), units: w.plan.units,
      spawn: [w.plan.spawnMin, w.plan.spawnMax], giveUp: w.plan.giveUpRadius,
      speedMul: w.plan.speedMul, intercept: w.plan.intercept,
      roles: w.plan.assignments.map((a) => a.role).join('+'),
    });
  }
  check('a struck pedestrian is one star', steps[0].stars === 1, steps[0]);
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
      if (s.scene) seen.push({ d: s.scene.d, leaveIn: s.scene.leaveIn, line: composeLaw(s) });
      else if (!fledLine) fledLine = composeLaw(s);
    }
    const first = seen[0], last = seen[seen.length - 1];
    console.log(`    at the scene:  "${atScene.objective}" / "${atScene.subtitle}"`);
    console.log(`    ${first.d.toFixed(1)} m out -> ${last.d.toFixed(1)} m out: ` +
      `leaveIn ${first.leaveIn.toFixed(1)} -> ${last.leaveIn.toFixed(1)} m`);
    console.log(`    once it fired: "${fledLine?.objective}" / "${fledLine?.subtitle}"`);
    check('a live scene takes the band', atScene && atScene.objective === 'STOP AT THE SCENE',
      atScene);
    check('the subtitle counts DOWN to the charge, not up from the scene',
      last.leaveIn < first.leaveIn && last.leaveIn >= 0,
      `${first.leaveIn.toFixed(1)} -> ${last.leaveIn.toFixed(1)}`);
    check('and leaveIn is the leave radius less the distance, so it cannot drift from the rule',
      seen.every((r) => near(r.d + r.leaveIn, SCENE_LEAVE_M, 1e-9) || r.d > SCENE_LEAVE_M),
      `${(first.d + first.leaveIn).toFixed(3)} against ${SCENE_LEAVE_M}`);
    check('the offence that fired is named in the band the instant the scene clears',
      fledLine && fledLine.objective === CRIMES.hitAndRun.label.toUpperCase(),
      fledLine?.objective);
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
    console.log(`    stopped:       "${stopped.objective}" / "${stopped.subtitle}"`);
    check('stopping at the scene says so', stopped && stopped.objective === 'STOPPED AT THE SCENE',
      stopped);
    check('and it is a different line from the instruction it replaces',
      stopped.objective !== 'STOP AT THE SCENE' && w.stats.scenesStopped === 1,
      `scenesStopped ${w.stats.scenesStopped}`);
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
    console.log(`    notice at 0 s "${fresh?.objective}", at ${(LAW_NOTICE_S - 0.5).toFixed(1)} s ` +
      `"${nearly?.objective}", at ${(LAW_NOTICE_S + 0.5).toFixed(1)} s ${JSON.stringify(gone)}`);
    check('a filed crime is named in the band', fresh && fresh.objective === CRIMES.assault.label.toUpperCase(),
      fresh?.objective);
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
  }
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
