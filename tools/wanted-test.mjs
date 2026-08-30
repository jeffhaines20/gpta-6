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
import { WantedSystem, CRIMES, RESPONSE, STATES, bindPursuit } from '../src/wanted.js';

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
