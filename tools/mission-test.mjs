// Deterministic gate for the mission state machine.
//
// No browser, no renderer, no three.js: src/mission.js is pure state and timers, so a
// whole mission's branching can be driven in milliseconds and must land on the same
// numbers every run. That property is itself asserted here (§7) - the moment this
// module needs a scene to answer a question it has stopped being testable, which is
// the argument tools/wanted-test.mjs makes about its own subject.
//
//   node tools/mission-test.mjs
//
// Prints a scenario trace and a measurement block, then a PASS/FAIL gate line. Exits
// 1 on any failed check.
//
// HALF OF THIS FILE IS KNOWN-BAD INPUT. A validator is only worth its runtime if it
// refuses the graphs it claims to refuse, and CLAUDE.md's standing complaint is guards
// that read as guards: geom-audit "passed the whole time. That was luck, not
// evidence." So every fault defineMission() is documented to catch gets a mission
// authored to contain it, and the test fails if the throw does not happen.
import { MissionRunner, defineMission, OUTCOMES, TRIGGERS, snapshotFields } from '../src/mission.js';

const DT = 1 / 30;
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** A snapshot with every field the vocabulary can read, so tests opt out, not in. */
const snap = (o = {}) => ({
  px: 0, pz: 0, speed: 0, inVehicle: false, health: 1,
  wantedStars: 0, wantedState: 'clear', ...o,
});

/** Run until the mission finishes or the step budget runs out. */
function drive(runner, steps, fn) {
  const trace = [];
  let last = runner.report().stage;
  for (let i = 0; i < steps; i++) {
    const s = fn(i * DT, i);
    const r = runner.update(DT, s);
    if (r.stage !== last) { trace.push({ t: +(i * DT).toFixed(2), from: last, to: r.stage, outcome: r.outcome }); last = r.stage; }
    if (r.outcome !== OUTCOMES.RUNNING) return { r, trace, steps: i + 1 };
  }
  return { r: runner.report(), trace, steps };
}

// ---------------------------------------------------------------------------
// A runner that has never started anything. This is district/main.js's state from page
// load, and report() threw on it — "this._range is not iterable" — for three rounds,
// because `_range` was created in start() and read in report(). 51 checks passed here
// without ever asking a fresh runner what it was doing. tools/damage-live.mjs asked.
// ---------------------------------------------------------------------------
{
  const fresh = new MissionRunner();
  let threw = null, r = null;
  try { r = fresh.report(); } catch (e) { threw = e.message; }
  check('report() on a runner with no mission does not throw', !threw, threw);
  check('it reports no mission', r && r.mission === null && r.stage === null,
    JSON.stringify(r).slice(0, 120));
  check('its field ranges are empty rather than absent',
    r && r.fieldRange && Object.keys(r.fieldRange).length === 0 && Array.isArray(r.constantFields));
  let threwHud = null;
  try { fresh.hud(); } catch (e) { threwHud = e.message; }
  check('hud() on a runner with no mission does not throw', !threwHud, threwHud);
}

// ---------------------------------------------------------------------------
// A small well-formed mission used by the behaviour sections.
// ---------------------------------------------------------------------------
const M = defineMission({
  id: 'testrun', title: 'Test Run',
  stages: [
    { id: 'drive', objective: 'GET IN THE CAR',
      triggers: [{ kind: 'inVehicle', goto: 'go' }] },
    { id: 'go', objective: 'REACH THE YARD', marker: { x: 100, z: 0 },
      triggers: [
        { kind: 'reach', x: 100, z: 0, radius: 12, goto: 'hold' },
        { kind: 'onFoot', goto: 'drive' },
      ] },
    { id: 'hold', objective: 'WAIT', timeLimit: 5, onTimeout: 'chase',
      triggers: [{ kind: 'healthBelow', fraction: 0.25, outcome: 'failed' }] },
    { id: 'chase', objective: 'LOSE THE POLICE',
      triggers: [
        { kind: 'evaded', outcome: 'passed' },
        { kind: 'healthBelow', fraction: 0.25, outcome: 'failed' },
      ],
      onEnter: { setWanted: 2, stinger: 'chase' } },
  ],
});

// ---------------------------------------------------------------------------
console.log('=== 1. the vocabulary and the load-time contract');
check('every trigger kind declares needs, test and validate',
  Object.entries(TRIGGERS).every(([, d]) => Array.isArray(d.needs) && typeof d.test === 'function' && typeof d.validate === 'function'),
  `${Object.keys(TRIGGERS).length} kinds`);
check('snapshotFields is the union of every kind\'s needs',
  snapshotFields().join(',') === 'health,inVehicle,px,pz,speed,wantedStars,wantedState',
  snapshotFields().join(','));
check('a valid mission records the fields it will read',
  M.needs.join(',') === 'health,inVehicle,px,pz,wantedStars,wantedState', M.needs.join(','));

// ---------------------------------------------------------------------------
console.log('\n=== 2. KNOWN-BAD GRAPHS: defineMission must refuse each one');
const refuses = (label, m, fragment) => {
  let msg = null;
  try { defineMission(m); } catch (e) { msg = e.message; }
  check(`refuses ${label}`, msg != null && msg.includes(fragment),
    msg ? `"${fragment}" ${msg.includes(fragment) ? 'found' : `NOT in: ${msg.split('\n')[1] ?? msg}`}` : 'DID NOT THROW');
};
const ok1 = { id: 'a', objective: 'o', triggers: [{ kind: 'timer', seconds: 1, outcome: 'passed' }] };
refuses('a goto naming no stage', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'timer', seconds: 1, goto: 'nowhere' }] }, ok1] },
  'is not a stage id');
refuses('an unreachable stage', { id: 'm', title: 't', stages: [
  ok1, { id: 'orphan', objective: 'o', triggers: [{ kind: 'timer', seconds: 1, outcome: 'failed' }] }] },
  'unreachable from the first stage');
refuses('a dead end', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'timer', seconds: 1, goto: 'b' }] },
  { id: 'b', objective: 'o' }, ok1] },
  'nothing can leave it');
refuses('a mission that cannot be won', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'timer', seconds: 1, outcome: 'failed' }] }] },
  'reaches outcome "passed"');
refuses('a trigger with both goto and outcome', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'timer', seconds: 1, goto: 'a', outcome: 'passed' }] }] },
  'exactly one of goto or outcome');
refuses('an unknown trigger kind', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'teleport', outcome: 'passed' }] }] },
  'unknown trigger kind');
refuses('a reach with no radius', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'reach', x: 0, z: 0, outcome: 'passed' }] }] },
  'radius above 0');
refuses('a composite whose sub-trigger carries an edge', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'all', of: [{ kind: 'onFoot', goto: 'a' }], outcome: 'passed' }] }] },
  'composites take predicates, not edges');
refuses('a typo nested inside a composite', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', triggers: [{ kind: 'all', of: [{ kind: 'nope' }], outcome: 'passed' }] }] },
  'unknown trigger kind');
refuses('a stage with no objective', { id: 'm', title: 't', stages: [
  { id: 'a', triggers: [{ kind: 'timer', seconds: 1, outcome: 'passed' }] }] },
  'needs an objective');
refuses('a timeLimit with no onTimeout', { id: 'm', title: 't', stages: [
  { id: 'a', objective: 'o', timeLimit: 3, triggers: [{ kind: 'timer', seconds: 1, outcome: 'passed' }] }] },
  'needs onTimeout');
refuses('duplicate stage ids', { id: 'm', title: 't', stages: [ok1, { ...ok1 }] }, 'duplicate stage id');
// And it must report EVERY fault, not just the first.
let multi = null;
try {
  defineMission({ id: 'm', title: 't', stages: [
    { id: 'a', triggers: [{ kind: 'nope' }, { kind: 'timer', seconds: -1, goto: 'gone' }] }] });
} catch (e) { multi = e.message; }
check('reports every fault in one pass, not the first',
  multi != null && (multi.match(/^ {2}- /gm) ?? []).length >= 4,
  `${(multi?.match(/^ {2}- /gm) ?? []).length} faults listed`);

// ---------------------------------------------------------------------------
console.log('\n=== 3. KNOWN-BAD SNAPSHOT: an absent field must throw, not dead-end');
{
  const r = new MissionRunner(); r.start(M);
  let threw = null;
  try { r.update(DT, { px: 0, pz: 0, inVehicle: false, health: 1 }); } catch (e) { threw = e.message; }
  check('a snapshot missing wantedStars/wantedState throws',
    threw != null && threw.includes('wantedStars') && threw.includes('wantedState'),
    threw ? threw.split('.')[0] : 'DID NOT THROW');
}
{
  const r = new MissionRunner(); r.start(M);
  let threw = null;
  try { r.update(DT, snap({ px: NaN })); } catch (e) { threw = e.message; }
  check('a NaN in the snapshot throws rather than failing every comparison',
    threw != null && threw.includes('not finite'), threw ? 'threw' : 'DID NOT THROW');
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. the happy path');
{
  const r = new MissionRunner();
  const intents = []; const stages = [];
  r.on('intent', (i) => intents.push(i)).on('stage', (s) => stages.push(s));
  r.start(M);
  const out = drive(r, 4000, (t) => {
    if (t < 1) return snap();                                      // on foot
    if (t < 3) return snap({ inVehicle: true, px: 20 * (t - 1) });  // driving out
    if (t < 4) return snap({ inVehicle: true, px: 100 });           // arrived
    // the hold stage times out at 5 s into itself, then the chase starts wanted
    if (t < 12) return snap({ inVehicle: true, px: 100, wantedStars: 2, wantedState: 'active' });
    return snap({ inVehicle: true, px: 100, wantedStars: 0, wantedState: 'clear' });
  });
  for (const s of out.trace) console.log(`   t=${String(s.t).padStart(5)}  ${String(s.from).padEnd(6)} -> ${s.to ?? `[${s.outcome}]`}`);
  check('the happy path passes', out.r.outcome === OUTCOMES.PASSED, out.r.outcome);
  check('it walked every stage in order',
    out.r.visited.join(' > ') === 'drive > go > hold > chase', out.r.visited.join(' > '));
  check('onEnter fired as an intent, once, with its data',
    intents.length === 1 && intents[0].setWanted === 2 && intents[0].stinger === 'chase',
    JSON.stringify(intents));
  check('no transition chain overflowed', out.r.chainOverflows === 0, String(out.r.chainOverflows));
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. failure, regression and the stage clock');
{
  // Health drops during the chase.
  const r = new MissionRunner(); r.start(M);
  const out = drive(r, 4000, (t) => (t < 1 ? snap()
    : t < 4 ? snap({ inVehicle: true, px: 100 })
      : snap({ inVehicle: true, px: 100, wantedStars: 3, wantedState: 'active', health: 0.1 })));
  check('a fail trigger ends the mission failed', out.r.outcome === OUTCOMES.FAILED, out.r.outcome);
}
{
  // Stepping out of the car sends `go` back to `drive`; the stage clock must reset.
  const r = new MissionRunner(); r.start(M);
  drive(r, 60, () => snap({ inVehicle: true }));
  const beforeBack = r.report().stageElapsed;
  r.update(DT, snap({ inVehicle: false }));
  check('a backward edge resets the stage clock',
    beforeBack > 1 && r.report().stage === 'drive' && r.report().stageElapsed === 0,
    `stageElapsed ${beforeBack} -> ${r.report().stageElapsed} on ${r.report().stage}`);
}
{
  // The stage deadline. `hold` has timeLimit 5, so from entry it must resolve at 5 s
  // of STAGE time however long the mission has been running.
  //
  // DRIVE ONLY UNTIL IT ENTERS `hold`. The first version of this ran a fixed 300
  // steps - 10 s at this dt - which is twice the deadline, so it inspected the stage
  // AFTER the timeout had already carried it to `chase` and reported "timeout fires
  // at 0.000 s". The instrument was right and the test was standing in the wrong
  // place, which is this file's own §2 lesson arriving from the other side.
  const r = new MissionRunner(); r.start(M);
  let spin = 0;
  while (r.report().stage !== 'hold' && spin++ < 1000) {
    r.update(DT, spin * DT < 1 ? snap() : snap({ inVehicle: true, px: 100 }));
  }
  check('the runner is holding with a countdown',
    r.report().stage === 'hold' && r.report().secondsLeft > 0 && r.report().secondsLeft <= 5,
    `secondsLeft ${r.report().secondsLeft}`);
  const entered = r.report().elapsed - r.report().stageElapsed;
  let guard = 0;
  while (r.report().stage === 'hold' && guard++ < 1000) r.update(DT, snap({ inVehicle: true, px: 100 }));
  check('timeout fires on the STAGE clock, not the mission clock',
    near(r.report().elapsed - entered, 5, DT * 1.5) && r.report().stage === 'chase',
    `stage clock at timeout ${(r.report().elapsed - entered).toFixed(3)} s, now on ${r.report().stage}`);
  check('the countdown floors at zero and never reads negative',
    r.report().secondsLeft === null || r.report().secondsLeft >= 0, String(r.report().secondsLeft));
}
{
  // A trigger firing on the same frame the deadline expires must WIN. The player did
  // reach the marker; a timeout is the fallback, not a race.
  const race = defineMission({ id: 'race', title: 'r', stages: [
    { id: 'a', objective: 'o', timeLimit: 1, onTimeout: 'failed',
      triggers: [{ kind: 'onFoot', outcome: 'passed' }] }] });
  const r = new MissionRunner(); r.start(race);
  let guard = 0;
  while (r.report().outcome === OUTCOMES.RUNNING && guard++ < 100) r.update(DT, snap({ inVehicle: false }));
  check('a trigger beats its own stage deadline on the same frame',
    r.report().outcome === OUTCOMES.PASSED, r.report().outcome);
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. the dt guard and the chain budget');
{
  const r = new MissionRunner(); r.start(M);
  r.update(NaN, snap({ inVehicle: true }));
  r.update(-5, snap({ inVehicle: true }));
  r.update(1e6, snap({ inVehicle: true }));
  check('NaN and a negative dt add nothing, and a huge dt is clamped to 0.25',
    near(r.report().elapsed, 0.25, 1e-6), `elapsed ${r.report().elapsed}`);
}
{
  // A cycle of always-true stages. Bounded, and the overflow must be REPORTED.
  const spin = defineMission({ id: 'spin', title: 's', stages: [
    { id: 'a', objective: 'o', triggers: [{ kind: 'onFoot', goto: 'b' }] },
    { id: 'b', objective: 'o', triggers: [{ kind: 'onFoot', goto: 'a' }, { kind: 'wantedAtLeast', stars: 5, outcome: 'passed' }] }] });
  const r = new MissionRunner({ maxChainPerFrame: 8 }); r.start(spin);
  r.update(DT, snap({ inVehicle: false }));
  check('an always-true cycle is bounded inside one frame',
    r.report().transitions <= 8, `${r.report().transitions} transitions in one update`);
  check('...and the overflow is counted, not swallowed',
    r.report().chainOverflows === 1, `chainOverflows ${r.report().chainOverflows}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. determinism, purity and cost');
{
  const run = () => {
    const r = new MissionRunner(); r.start(M);
    return JSON.stringify(drive(r, 4000, (t) => (t < 1 ? snap()
      : t < 4 ? snap({ inVehicle: true, px: 100 })
        : t < 12 ? snap({ inVehicle: true, px: 100, wantedStars: 2, wantedState: 'active' })
          : snap({ inVehicle: true, px: 100, wantedStars: 0, wantedState: 'clear' }))).r);
  };
  const a = run(), b = run(), c = run();
  check('three runs are byte-identical', a === b && b === c, a === b && b === c ? 'identical' : 'DIFFER');
  // THE PURITY CHECK HAS TO READ THE CODE, NOT THE PROSE ABOUT THE CODE.
  //
  // The first version tested the raw file and FAILED on both counts - because
  // mission.js's own header says "no THREE, no DOM, no renderer, no Math.random" to
  // explain why it is written this way. The assertion was matching its own
  // documentation. That is the same shape as a probe measuring the opportunity
  // instead of the fix: it would also have passed a file that mentioned none of
  // those words while importing all of them.
  const raw = await (await import('node:fs')).promises.readFile(new URL('../src/mission.js', import.meta.url), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')       // block comments, including the JSDoc
    .replace(/(^|[^:])\/\/.*$/gm, '$1');       // line comments, sparing "http://"
  check('the comment stripper actually removes the header prose',
    /Math\.random/.test(raw) && !/Math\.random/.test(code),
    'the raw file mentions Math.random in prose; the stripped code does not');
  check('src/mission.js imports nothing', !/^\s*import\s/m.test(code), 'no import statements');
  check('...and calls no Math.random', !/Math\.random/.test(code), 'none in code');
  check('...and touches no THREE, window or document',
    !/\bTHREE\b|\bwindow\b|\bdocument\b/.test(code), 'none in code');

  const r = new MissionRunner(); r.start(M);
  const s = snap({ inVehicle: true, px: 100, wantedStars: 2, wantedState: 'active' });
  const N = 200000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) r.update(DT, s);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  check('update costs well under a frame', us < 5, `${us.toFixed(3)} us per update over ${N.toLocaleString()}`);
  console.log(`   update(): ${us.toFixed(3)} us  —  ${(us / 16700 * 100).toFixed(5)}% of a 60 fps frame`);
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. the HUD contract');
{
  const r = new MissionRunner(); r.start(M);
  const h0 = r.hud();
  check('hud() gives the HUD its own field names',
    h0 && typeof h0.objective === 'string' && 'subtitle' in h0, JSON.stringify(h0));
  drive(r, 60, () => snap({ inVehicle: true }));
  const h1 = r.hud();
  check('a stage with a marker exposes a waypoint',
    h1.waypoint && h1.waypoint.x === 100 && h1.waypoint.z === 0, JSON.stringify(h1.waypoint));
  const done = new MissionRunner(); done.start(M); done.abort('test');
  check('hud() is null once nothing is running', done.hud() === null, String(done.hud()));
  check('abort is recorded as its own outcome', done.report().outcome === OUTCOMES.ABORTED, done.report().outcome);
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. THE AUTHORED MISSIONS, walked stage by stage');
//
// A gate that only exercises a synthetic fixture is the "audit that walks less than
// the build" CLAUDE.md records: geom-audit asked for ONE street direction where the
// build unions two, and was blind to every corner site for as long as corner sites
// existed. So this section drives src/missions.js itself, and its headline assertion
// is COVERAGE: every authored stage must be entered by at least one scripted path.
// A stage no path reaches is content nobody will ever see, which is the mission
// equivalent of an unreachable branch.
{
  const { MISSIONS } = await import('../src/missions.js');
  const ROUTE = JSON.parse(await (await import('node:fs')).promises
    .readFile(new URL('../data/district.json', import.meta.url), 'utf8')).meta.route;

  check('every authored mission validated at import', Object.keys(MISSIONS).length >= 2,
    Object.keys(MISSIONS).join(', '));

  // Markers must be ON the district, and near its baked route - a waypoint in the bay
  // or outside the bounds is a marker a player cannot stand on.
  const B = JSON.parse(await (await import('node:fs')).promises
    .readFile(new URL('../data/district.json', import.meta.url), 'utf8')).meta.bounds;
  const offRoute = [];
  for (const m of Object.values(MISSIONS)) {
    for (const st of m.stages) {
      if (!st.marker) continue;
      const { x, z } = st.marker;
      const inBounds = x > B.x0 && x < B.x1 && z > B.z0 && z < B.z1;
      const d = Math.min(...ROUTE.map((w) => Math.hypot(w.x - x, w.z - z)));
      if (!inBounds || d > 5) offRoute.push(`${m.id}/${st.id} at (${x},${z}) is ${d.toFixed(1)} m from the route${inBounds ? '' : ', OUT OF BOUNDS'}`);
    }
  }
  check('every marker is in bounds and on the baked route', offRoute.length === 0,
    offRoute.length ? offRoute.join(' | ') : 'all markers within 5 m of a route waypoint');

  // Walk each mission down scripted paths and union the stages entered.
  const walk = (mission, script, steps = 40000) => {
    const r = new MissionRunner(); r.start(mission);
    const seen = new Set(r.report().visited);
    for (let i = 0; i < steps; i++) {
      const rep = r.update(DT, script(i * DT, r.report()));
      for (const v of rep.visited) seen.add(v);
      if (rep.outcome !== OUTCOMES.RUNNING) return { seen, outcome: rep.outcome, t: rep.elapsed };
    }
    return { seen, outcome: r.report().outcome, t: r.report().elapsed };
  };
  const atMarker = (m, id) => { const st = m.stages.find((s) => s.id === id); return st.marker; };

  // --- marlin-street, four paths that between them must touch all six stages.
  const MS = MISSIONS['marlin-street'];
  const fp = atMarker(MS, 'eastbound'), dropAt = atMarker(MS, 'drop');
  const paths = {
    // 1. clean run: drive to Five Points, take the heat, shake it, deliver.
    clean: (t, rep) => {
      if (t < 1) return snap();
      if (rep.stage === 'eastbound' || rep.stage === 'toCar') return snap({ inVehicle: true, px: fp.x, pz: fp.z });
      if (rep.stage === 'ambush') return snap({ inVehicle: true, px: fp.x, pz: fp.z,
        wantedStars: t < 20 ? 2 : 0, wantedState: t < 20 ? 'active' : 'clear' });
      return snap({ inVehicle: true, px: dropAt.x, pz: dropAt.z });
    },
    // 2. steps out of the car mid-run, which must route through backToCar.
    //
    // THIS SCRIPT DRIVES INSTEAD OF TELEPORTING, and the first version did not. It
    // put the player on the Five Points marker from the frame it entered the car, so
    // `eastbound` completed instantly and the scripted step-out at t=2 landed inside
    // `ambush`, which has no onFoot edge - the path reported PASSED without ever
    // seeing backToCar, and the coverage check was the only thing that noticed. A
    // script that teleports to a marker also never exercises the reach radius it is
    // supposed to be testing.
    //
    // Spawn is the marina at (-471, 205); Five Points is (57, -164). 20 m/s along the
    // straight line is ~32 s, which leaves plenty of room to stop at t=6 and restart.
    interrupted: (t, rep) => {
      if (t < 1) return snap();
      const from = { x: -471, z: 205 };
      const span = Math.hypot(fp.x - from.x, fp.z - from.z);
      const travelled = Math.min(span, 20 * Math.max(0, t - 1));
      const k = travelled / span;
      const at = { px: from.x + (fp.x - from.x) * k, pz: from.z + (fp.z - from.z) * k };
      if (t >= 6 && t < 8) return snap({ ...at, inVehicle: false });
      if (rep.stage === 'ambush') return snap({ ...at, inVehicle: true, wantedStars: 0, wantedState: 'clear' });
      if (rep.stage === 'drop' || rep.stage === 'dropHot') return snap({ inVehicle: true, px: dropAt.x, pz: dropAt.z });
      return snap({ ...at, inVehicle: true });
    },
    // 3. never shakes the police: the 240 s deadline must route to dropHot and that
    //    path must still be winnable.
    hot: (t, rep) => {
      if (t < 1) return snap();
      if (rep.stage === 'dropHot') return snap({ inVehicle: true, px: dropAt.x, pz: dropAt.z, wantedStars: 3, wantedState: 'active' });
      if (rep.stage === 'ambush') return snap({ inVehicle: true, px: fp.x, pz: fp.z, wantedStars: 3, wantedState: 'active' });
      return snap({ inVehicle: true, px: fp.x, pz: fp.z });
    },
    // 4. wrecked during the chase.
    wrecked: (t, rep) => {
      if (t < 1) return snap();
      if (rep.stage === 'ambush') return snap({ inVehicle: true, px: fp.x, pz: fp.z, wantedStars: 2, wantedState: 'active', health: 0.05 });
      return snap({ inVehicle: true, px: fp.x, pz: fp.z });
    },
  };
  const results = {};
  const covered = new Set();
  for (const [name, script] of Object.entries(paths)) {
    const out = walk(MS, script);
    results[name] = out;
    for (const v of out.seen) covered.add(v);
    console.log(`   ${name.padEnd(12)} -> ${out.outcome.padEnd(7)} at t=${out.t.toFixed(1)}s   stages ${[...out.seen].join(' > ')}`);
  }
  check('the clean path passes', results.clean.outcome === OUTCOMES.PASSED, results.clean.outcome);
  check('stepping out routes through backToCar and still passes',
    results.interrupted.seen.has('backToCar') && results.interrupted.outcome === OUTCOMES.PASSED,
    `${results.interrupted.outcome}, saw backToCar: ${results.interrupted.seen.has('backToCar')}`);
  check('never shaking the police routes to dropHot and is STILL winnable',
    results.hot.seen.has('dropHot') && results.hot.outcome === OUTCOMES.PASSED,
    `${results.hot.outcome}, saw dropHot: ${results.hot.seen.has('dropHot')}`);
  check('being wrecked fails it', results.wrecked.outcome === OUTCOMES.FAILED, results.wrecked.outcome);

  const missed = MS.stages.map((s) => s.id).filter((id) => !covered.has(id));
  check('COVERAGE: every authored stage of marlin-street is entered by some path',
    missed.length === 0, missed.length ? `never entered: ${missed.join(', ')}` : `all ${MS.stages.length} stages`);

  // --- shakedown, the short wiring check.
  const SH = MISSIONS.shakedown;
  const shOut = walk(SH, (t, rep) => {
    if (t < 1) return snap();
    const st = SH.stages.find((s) => s.id === rep.stage);
    return snap({ inVehicle: true, px: st?.marker?.x ?? 0, pz: st?.marker?.z ?? 0 });
  });
  // A CONSTANT FIELD IS AN INERT TRIGGER, and it must be visible in the report.
  {
    const r = new MissionRunner(); r.start(MS);
    for (let i = 0; i < 200; i++) r.update(DT, snap({ inVehicle: true, px: fp.x, pz: fp.z }));
    const rep = r.report();
    check('report() names fields that never varied',
      rep.constantFields.includes('health') && rep.fieldRange.health[0] === rep.fieldRange.health[1],
      `constant: ${rep.constantFields.join(', ')}  health range ${JSON.stringify(rep.fieldRange.health)}`);
    const r2 = new MissionRunner(); r2.start(MS);
    for (let i = 0; i < 200; i++) r2.update(DT, snap({ inVehicle: true, px: fp.x, pz: fp.z, health: 1 - i / 400 }));
    check('...and does not name one that did', !r2.report().constantFields.includes('health'),
      `health range ${JSON.stringify(r2.report().fieldRange.health)}`);
  }

  check('shakedown passes and covers all of its stages',
    shOut.outcome === OUTCOMES.PASSED && shOut.seen.size === SH.stages.length,
    `${shOut.outcome}, ${shOut.seen.size}/${SH.stages.length} stages`);
}

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('\n=== CHECKS');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nMISSION: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}` : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
