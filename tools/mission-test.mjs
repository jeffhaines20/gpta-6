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
import { MissionRunner, defineMission, OUTCOMES, TRIGGERS, snapshotFields,
  MissionBoard, OFFER_RADIUS_M } from '../src/mission.js';

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

  // THE OLD BOUND HERE WAS `us < 5`, AND IT WAS A COIN FLIP ON BOX SPEED.
  //
  // Measured on one idle box, unchanged code, six runs: 4.861, 4.953, 5.111,
  // 5.133, 5.366, 5.690 us. A hardcoded 5 sits inside that spread, so this gate
  // failed about half the time and said "1 of 88" while nothing was wrong -- the
  // same shape as `route-drive`'s seam assertion that held at one offset only.
  // A microsecond figure is a statement about the machine; the CLAIM is "well
  // under a frame", so the bound is restated as the fraction it means.
  //
  //   update() runs once per frame. A 60 Hz frame is 16,700 us. One percent of a
  //   frame is 167 us, which is a bound a structural regression breaks and box
  //   noise does not: the measurements above are 29-34x inside it.
  //
  // That is looser as a number and it is not a quiet loosening, because the thing
  // the old check was really guarding gets asserted directly below instead, and it
  // could not have been caught by any wall-clock bound: the runner must look at
  // the ACTIVE stage, not at every stage. A linear scan over stages would cost
  // ~68x more at 406 stages and still come in under a microsecond bound on a fast
  // enough box.
  const FRAME_US = 16700, FRAME_FRACTION = 0.01;
  const timeUpdate = (mission, N = 200000) => {
    const warm = new MissionRunner(); warm.start(mission);
    const s = snap({ inVehicle: true, px: 100, wantedStars: 2, wantedState: 'active' });
    for (let i = 0; i < 20000; i++) warm.update(DT, s);
    const r = new MissionRunner(); r.start(mission);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) r.update(DT, s);
    return Number(process.hrtime.bigint() - t0) / 1000 / N;
  };
  const us = timeUpdate(M);
  check('update costs well under a frame', us < FRAME_US * FRAME_FRACTION,
    `${us.toFixed(3)} us is ${(us / FRAME_US * 100).toFixed(4)}% of a 60 fps frame,` +
    ` against a ${(FRAME_FRACTION * 100).toFixed(0)}% bound (${FRAME_US * FRAME_FRACTION} us)`);

  // Cost must not scale with the mission's TOTAL stage count. The fillers chain
  // off the LAST stage so defineMission's reachability check passes and the active
  // stage's own trigger list is untouched -- inflating that would measure a
  // different question. Compared as a RATIO inside one process of the SAME
  // operation, so box speed cancels; an absolute second number would not.
  const inflate = (m, k) => {
    const far = (i) => ({ kind: 'reach', x: 9000 + i, z: 9000, radius: 1 });
    const extra = [];
    for (let i = 0; i < k; i++) {
      extra.push({ id: `filler${i}`, objective: 'X', subtitle: null,
        triggers: [i + 1 < k ? { ...far(i), goto: `filler${i + 1}` }
                             : { ...far(i), outcome: 'passed' }] });
    }
    const stages = m.stages.map((st, i) => (i === m.stages.length - 1
      ? { ...st, triggers: [...st.triggers, { ...far(999), goto: 'filler0' }] } : st));
    return defineMission({ ...m, id: `${m.id}-x${k}`, stages: [...stages, ...extra] });
  };
  const BIG = 400;
  const big = inflate(M, BIG);
  check(`inflating the mission to ${big.stages.length} stages is still validated`,
    big.stages.length === M.stages.length + BIG + 1 || big.stages.length === M.stages.length + BIG,
    `${M.stages.length} -> ${big.stages.length} stages`);
  const usBig = timeUpdate(big, 100000);
  const ratio = usBig / us;
  check('...and update() does not scale with stage count', ratio < 2,
    `${us.toFixed(3)} us at ${M.stages.length} stages vs ${usBig.toFixed(3)} us at` +
    ` ${big.stages.length}: x${ratio.toFixed(2)} (a linear scan would be ~x${(big.stages.length / M.stages.length).toFixed(0)})`);
  console.log(`   update(): ${us.toFixed(3)} us  —  ${(us / FRAME_US * 100).toFixed(5)}% of a 60 fps frame`);
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

  check('every authored mission validated at import', Object.keys(MISSIONS).length >= 2,
    Object.keys(MISSIONS).join(', '));

  /**
   * MARKERS MUST BE SOMEWHERE A CAR CAN GET TO — and the rule this replaces did not say that,
   * it said "within 5 m of one of the nine baked route WAYPOINTS", which is a much narrower
   * thing and it CAUSED a defect rather than catching one.
   *
   * Route waypoint 1 is (-328, 63) and the district spawn is (-327.84, 63.30). Shakedown's
   * stage `b` needed a marker, the only legal positions were the nine waypoints, so it got
   * waypoint 1 — 0.35 m from where the player starts, inside its own 30 m reach radius by a
   * factor of eighty. Both playtesters reported the consequence in the same words: two of that
   * mission's three objective lines can never be read, because stage `a` and stage `b` both
   * clear on the first frame. The gate was green throughout.
   *
   * What a marker actually owes is: inside the bounds, and close enough to a road the ROUTER
   * will use that a car can arrive. `nearestOn` measures exactly that against the real graph,
   * with the blocked service alleys already excluded, so the whole street network is legal and
   * a marker in the bay or inside a block is not. 15 m is a wide pavement plus a kerb.
   *
   * AND NO STAGE MAY BE STANDING IN ITS OWN DESTINATION. The second check is the one that would
   * have caught shakedown/b: a `reach` trigger whose radius contains the spawn is a stage that
   * completes itself.
   */
  const meta = JSON.parse(await (await import('node:fs')).promises
    .readFile(new URL('../data/district.json', import.meta.url), 'utf8'));
  const B = meta.meta.bounds, SPAWN = meta.meta.spawn;
  const { BlockerIndex } = await import('../src/blockers.js');
  const { RoadGraph } = await import('../src/roadpath.js');
  const roadBlockers = new BlockerIndex(meta);
  const roads = new RoadGraph(meta, { blockers: roadBlockers, carRadius: 0.95 });
  const MARKER_ROAD_M = 15;
  const offRoute = [], selfClearing = [];
  for (const m of Object.values(MISSIONS)) {
    for (const st of m.stages) {
      if (!st.marker) continue;
      const { x, z } = st.marker;
      const inBounds = x > B.x0 && x < B.x1 && z > B.z0 && z < B.z1;
      const near = roads.nearestOn(x, z);
      const d = near ? near.dist : Infinity;
      if (!inBounds || !(d <= MARKER_ROAD_M)) {
        offRoute.push(`${m.id}/${st.id} at (${x},${z}) is ${d.toFixed(1)} m from a routable ` +
          `road${inBounds ? '' : ', OUT OF BOUNDS'}`);
      }
    }
    for (const st of m.stages) {
      for (const t of st.triggers ?? []) {
        if (t.kind !== 'reach') continue;
        const d = Math.hypot(t.x - SPAWN.x, t.z - SPAWN.z);
        if (d <= t.radius) {
          selfClearing.push(`${m.id}/${st.id} reach (${t.x},${t.z}) r${t.radius} contains the ` +
            `spawn, ${d.toFixed(2)} m away`);
        }
      }
    }
  }
  console.log(`    marker distance to the nearest routable road:`);
  for (const m of Object.values(MISSIONS)) {
    for (const st of m.stages) {
      if (!st.marker) continue;
      const near = roads.nearestOn(st.marker.x, st.marker.z);
      console.log(`      ${(m.id + '/' + st.id).padEnd(24)} ${(near ? near.dist : Infinity).toFixed(1)} m` +
        `  (edge ${near ? near.edge : '-'})`);
    }
  }
  check('no stage sits inside its own reach radius at the spawn', selfClearing.length === 0,
    selfClearing.join('; ') || '0 of them');

  /**
   * A STAGE WITH A CLOCK NEEDS SOMEWHERE TO GO. `ambush` had a 240 s limit and no marker, so the
   * waypoint was gone for the whole of it — a playtester measured 156.3 s of a 249.4 s run, 63%,
   * with a blank HUD. `toCar` and `backToCar` have no marker either and correctly so: the car is
   * where you left it. The distinguishing property is the clock.
   */
  const timedNoMarker = [];
  for (const m of Object.values(MISSIONS)) {
    for (const st of m.stages) {
      if (st.timeLimit != null && !st.marker) timedNoMarker.push(`${m.id}/${st.id}`);
    }
  }
  check('every stage with a time limit has somewhere to go', timedNoMarker.length === 0,
    timedNoMarker.join(', ') || '0 of them');

  /**
   * AND WHEREVER IT SENDS YOU MUST NOT ALREADY BE THE NEXT STAGE'S DESTINATION.
   *
   * This is the second time a marker has landed inside the following stage's own reach radius,
   * and both times the gate had a hand in it. `shakedown`'s second marker sat 0.35 m from the
   * spawn against a 30 m radius, because an older rule REQUIRED every marker within 5 m of a
   * baked route waypoint and waypoint 1 is the spawn. Then `ambush` was given a marker at
   * (-471, 205) to satisfy the clock rule above — the exact coordinates of `drop`'s reach
   * trigger, 0.0 m away, radius 28 m. A player who follows the HUD shakes the tail standing on
   * the drop, so `drop` fires and is satisfied in the same breath and the flagship mission's
   * final objective is the active stage for 0.033 s: two frames at 60 Hz. The delivery leg of
   * the delivery mission did not exist.
   *
   * The assertion is the exact property that breaks, not a design minimum: walking from the
   * previous stage's marker must not already satisfy the next stage's reach trigger. A margin
   * would be a number somebody picked; the radius is the number the mission itself declares.
   * The ratio is printed beside it so an author can see whether a passing margin is also a
   * sensible one — 322.5 m against 28 m is x11.5, and 29 m would pass while being absurd.
   *
   * It only checks edges whose SOURCE has a marker. Where it does not — `toCar`, `backToCar` —
   * the player's position on entry is unconstrained and there is nothing to assert.
   */
  const instantOnEntry = [], entryMargins = [];
  for (const m of Object.values(MISSIONS)) {
    const byId = new Map(m.stages.map((s) => [s.id, s]));
    for (const from of m.stages) {
      if (!from.marker) continue;
      const gotos = [];
      const walk = (trigs) => {
        for (const t of trigs ?? []) {
          if (t.goto) gotos.push(t.goto);
          if (Array.isArray(t.of)) walk(t.of);
        }
      };
      walk(from.triggers);
      if (from.onTimeout && byId.has(from.onTimeout)) gotos.push(from.onTimeout);
      for (const id of gotos) {
        const to = byId.get(id);
        if (!to || to === from) continue;
        for (const t of to.triggers ?? []) {
          if (t.kind !== 'reach' || t.x === undefined) continue;
          const sep = Math.hypot(from.marker.x - t.x, from.marker.z - t.z);
          entryMargins.push(`${m.id}/${from.id}->${to.id} ${sep.toFixed(1)} m vs r=${t.radius}` +
            ` (x${(sep / t.radius).toFixed(1)})`);
          if (sep <= t.radius) {
            instantOnEntry.push(`${m.id}: ${from.id}'s marker is ${sep.toFixed(2)} m from` +
              ` ${to.id}'s reach trigger (radius ${t.radius}), so ${to.id}'s objective cannot be read`);
          }
        }
      }
    }
  }
  console.log(`    marker to the NEXT stage's reach trigger:`);
  for (const line of entryMargins) console.log(`      ${line}`);
  check("a stage's marker never lands inside the next stage's reach radius",
    instantOnEntry.length === 0, instantOnEntry.join(' | ') || `${entryMargins.length} edges checked, all clear`);

  /**
   * AND ONE ACCIDENT DOES NOT RESUME A CHASE. `drop` carried `wantedAtLeast: 1`, and
   * `pedestrianHit` carries `min: 1` — so one star is the FLOOR of the least serious thing a
   * driver can do, and the trigger fired on it. `ambush`'s `onEnter: {setWanted: 2}` fires on
   * every entry, so the mission's own re-entry then doubled an accident into a 30-second stage.
   *
   * Driven through the real runner and the real wanted system rather than asserted from the data,
   * because the quantity that matters is what `reportCrime` produces and not what the table says.
   */
  {
    const { WantedSystem } = await import('../src/wanted.js');
    const M = MISSIONS['marlin-street'];
    const atDrop = (crimes) => {
      const r = new MissionRunner(), w = new WantedSystem();
      r.start(M);
      r.stageIndex = M.stages.findIndex((st) => st.id === 'drop');
      r.stageTime = 0;
      const snap = () => ({ px: 0, pz: 0, inVehicle: true, speed: 10, health: 1,
        wantedStars: w.stars, wantedState: w.state });
      r.update(1 / 60, snap());
      for (const c of crimes) w.reportCrime(c, { at: { x: 0, z: 0 } });
      w.update(0.02, { x: 0, z: 0 });
      r.update(1 / 60, snap());
      return { stars: w.stars, stage: r.report().stage };
    };
    const one = atDrop(['pedestrianHit']);
    const two = atDrop(['pedestrianHit', 'pedestrianKilled']);
    console.log(`    at the drop: one pedestrianHit -> ${one.stars} star, stage ${one.stage}; ` +
      `a hit and a death -> ${two.stars} stars, stage ${two.stage}`);
    check('one accidental star does not resume the chase', one.stage === 'drop',
      `${one.stars} star -> ${one.stage}`);
    check('and the police finding you does', two.stage === 'ambush',
      `${two.stars} stars -> ${two.stage}`);
    // KNOWN-BAD: the threshold this replaces. At 1 the same single accident re-entered.
    const trig = M.stages.find((st) => st.id === 'drop').triggers
      .find((t) => t.kind === 'wantedAtLeast');
    check('KNOWN-BAD: the threshold is above the one-star floor a single accident produces',
      trig.stars > 1 && one.stars === 1, `threshold ${trig.stars}, one accident gives ${one.stars}`);
  }
  check('every marker is in bounds and on a routable road', offRoute.length === 0,
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
// §10  THE BOARD: can a player reach a mission at all?
//
// This section exists because 347 gate checks were green over a first mission that could only
// be started from the browser console. Every check here is about the world, not the graph.
// ---------------------------------------------------------------------------
console.log('\n=== 10. the mission board — what a player can walk into');
{
  const { MISSIONS } = await import('../src/missions.js');
  const meta = JSON.parse(await (await import('node:fs')).promises
    .readFile(new URL('../data/district.json', import.meta.url), 'utf8'));
  const SPAWN = meta.meta.spawn, B = meta.meta.bounds;
  const { BlockerIndex } = await import('../src/blockers.js');
  const { RoadGraph } = await import('../src/roadpath.js');
  const bi = new BlockerIndex(meta);
  const roads = new RoadGraph(meta, { blockers: bi, carRadius: 0.95 });
  const board = new MissionBoard(MISSIONS);
  console.log(`    ${JSON.stringify(board.report())}`);
  check('every authored mission is on the board', board.unreachable.length === 0,
    board.unreachable.join(', ') || 'none left off');
  check('and there is more than one', board.available().length >= 2,
    `${board.available().length}`);

  for (const m of board.list) {
    const near = roads.nearestOn(m.start.x, m.start.z);
    const dSpawn = Math.hypot(m.start.x - SPAWN.x, m.start.z - SPAWN.z);
    const inBounds = m.start.x > B.x0 && m.start.x < B.x1 && m.start.z > B.z0 && m.start.z < B.z1;
    console.log(`    ${m.id.padEnd(16)} pickup (${m.start.x}, ${m.start.z}) r${board.radiusOf(m)}` +
      `  road ${near ? near.dist.toFixed(1) : '-'} m, ${dSpawn.toFixed(0)} m from the spawn`);
    check(`${m.id}: the pickup is in bounds`, inBounds);
    // A pickup a car cannot reach is a console call with extra steps.
    check(`${m.id}: the pickup is on a routable road`, !!near && near.dist <= 8,
      `${near ? near.dist.toFixed(2) : 'no road'} m`);
    check(`${m.id}: the car body fits on it`, !bi.resolveCircle(m.start.x, m.start.z, 0.95));
    // AND IT MUST NOT FIRE AT LOAD. A mission you are standing in is not a mission you chose,
    // and it is the same defect shakedown/b had one layer down.
    check(`${m.id}: the spawn is outside the pickup radius`, dSpawn > board.radiusOf(m),
      `${dSpawn.toFixed(1)} m against r${board.radiusOf(m)}`);
    // The route the player would drive to get there has to exist.
    const p = roads.path(SPAWN.x, SPAWN.z, m.start.x, m.start.z, { spacing: 4, offset: 0 });
    check(`${m.id}: it can be driven to from the spawn`, !!p && p.points.length > 1,
      p ? `${p.length.toFixed(0)} m of road` : 'no route');
  }

  // Nothing is on offer at the spawn, which is the whole-board form of the check above.
  check('no mission fires on the first frame', board.offerAt(SPAWN.x, SPAWN.z) === null,
    JSON.stringify(board.offerAt(SPAWN.x, SPAWN.z)));
  // The notice radius announces before the start radius fires, or a marker can only be found
  // by driving through it.
  const m0 = board.list[0];
  const r = board.radiusOf(m0);
  const justOutside = { x: m0.start.x + r * 2, z: m0.start.z };
  check('an offer is announced before it fires',
    board.offerAt(justOutside.x, justOutside.z) === null
    && board.offerAt(justOutside.x, justOutside.z, 'notice') !== null,
    `at ${r * 2} m: start ${JSON.stringify(board.offerAt(justOutside.x, justOutside.z))}, ` +
    `notice ${JSON.stringify(board.offerAt(justOutside.x, justOutside.z, 'notice'))}`);
  check('and standing on the marker offers it',
    board.offerAt(m0.start.x, m0.start.z)?.mission.id === m0.id);
  check('the nearer of two offers wins', (() => {
    const two = new MissionBoard([
      { id: 'near', start: { x: 0, z: 0, radius: 50 }, stages: [] },
      { id: 'far', start: { x: 40, z: 0, radius: 50 }, stages: [] },
    ]);
    return two.offerAt(5, 0).mission.id === 'near' && two.offerAt(35, 0).mission.id === 'far';
  })());

  // A passed mission leaves the board; a failed one comes back. A game that deletes its own
  // content on the player's first mistake has one mission fewer.
  const before = board.available().length;
  board.record(m0.id, OUTCOMES.PASSED);
  check('a passed mission stops being offered', board.available().length === before - 1
    && board.offerAt(m0.start.x, m0.start.z) === null, `${board.available().length} left`);
  check('and it is off the minimap too',
    !board.markers().some((k) => k.id === m0.id), JSON.stringify(board.markers()));
  board.record(m0.id, OUTCOMES.FAILED);
  check('a failed mission is offered again', board.available().length === before
    && board.offerAt(m0.start.x, m0.start.z)?.mission.id === m0.id);
  board.record(m0.id, OUTCOMES.ABORTED);
  check('so is an aborted one', board.offerAt(m0.start.x, m0.start.z)?.mission.id === m0.id);
  /**
   * THE LATCH. A mission that ends while the player is standing in its own pickup used to restart
   * on the next frame — found by tools/mission-live.mjs, which aborted `shakedown` on its marker
   * and got stage `a` back before it could observe the abort. Every ending reaches it: wreck the
   * car on top of a marker and the job you just failed begins again.
   */
  const latch = new MissionBoard(MISSIONS);
  const lm = latch.list.find((m) => m.id === 'shakedown');
  const at = { x: lm.start.x, z: lm.start.z };
  check('a marker fires when you drive into it', latch.offerAt(at.x, at.z)?.mission.id === 'shakedown');
  latch.record('shakedown', OUTCOMES.ABORTED).arm('shakedown');
  latch.refresh(at.x, at.z);
  check('and not again while you are still standing in it',
    latch.offerAt(at.x, at.z) === null, JSON.stringify(latch.offerAt(at.x, at.z)));
  check('though the job is still on the board and still named',
    latch.available().some((m) => m.id === 'shakedown')
    && latch.offerAt(at.x, at.z, 'notice')?.mission.id === 'shakedown',
    `${latch.report().latched.join(',')} latched`);
  // Leaving re-arms it. One radius out is outside, by definition of the radius.
  latch.refresh(at.x + latch.radiusOf(lm) + 1, at.z);
  check('leaving the marker re-arms it', latch.report().latched.length === 0);
  latch.refresh(at.x, at.z);
  check('and driving back in starts it again',
    latch.offerAt(at.x, at.z)?.mission.id === 'shakedown');
  // A latch on a marker the player never left must not decay on its own: refresh INSIDE the
  // radius is what a player standing still produces, and it has to be a no-op.
  latch.arm('shakedown');
  for (let k = 0; k < 50; k++) latch.refresh(at.x, at.z);
  check('and a latch does not expire on its own', latch.offerAt(at.x, at.z) === null,
    `${latch.report().latched.length} still latched after 50 frames standing still`);

  check('markers match what is available',
    board.markers().length === board.available().length
    && board.markers().every((k) => k.kind === 'offer'), JSON.stringify(board.markers()));
  check('the default offer radius is a disc a street can hold', OFFER_RADIUS_M >= 8
    && OFFER_RADIUS_M <= 20, `${OFFER_RADIUS_M} m`);
}

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('\n=== CHECKS');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nMISSION: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}` : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
