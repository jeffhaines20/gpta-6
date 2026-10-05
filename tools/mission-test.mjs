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
import { DamageModel } from '../src/damage.js';
import { objectiveLine } from '../src/hud.js';
import { MissionRunner, defineMission, OUTCOMES, TRIGGERS, snapshotFields,
  MissionBoard, OFFER_RADIUS_M } from '../src/mission.js';
// For the flee stage's cue: the word the wanted strip prints is read off the module that
// prints it, not spelled a second time here. See section (c).
import { composeWanted, STATES } from '../src/wanted.js';

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
   * A STAGE WITH A CLOCK NEEDS TO SAY WHAT TO DO — AND THIS RULE USED TO DEMAND A MARKER, WHICH
   * IS THE THIRD TIME A RULE IN THIS FILE HAS PUT A WRONG MARKER ON ONE STAGE.
   *
   * It read `st.timeLimit != null && !st.marker` and was written because `ambush` had a 240 s
   * limit and no marker, and a playtester measured 156.3 s of a 249.4 s run — 63% — with a blank
   * HUD. That observation was right. The INFERENCE was that a clock implies a destination, and
   * `ambush` is the counter-example: its only exit is `{ all: [timer 2 s, evaded] }`, so there
   * is nowhere to go, and every marker the rule extracted pointed somewhere arriving at was
   * either instant completion of the NEXT stage (the drop, 0.0 m) or an arrest (322 m away, a
   * playtester drove to 1 m and stopped and was busted).
   *
   * What the clock actually owes the player is an INSTRUCTION, which is a subtitle, not a pin:
   * the cue a flee stage has is the wanted note (`EVADING 16s`, measured on entry here) and the
   * police as `enemy` blips (two at 128 m and 265 m, same measurement). Both already exist.
   *
   * So the rule is the honest one, and `src/mission.js`'s `defineMission` now REFUSES a marker
   * on a stage with no `reach` — a module rule a later round cannot satisfy sideways.
   */
  const timedNoCue = [];
  for (const m of Object.values(MISSIONS)) {
    for (const st of m.stages) {
      if (st.timeLimit == null) continue;
      if (!st.marker && !(typeof st.subtitle === 'string' && st.subtitle.trim().length > 0)) {
        timedNoCue.push(`${m.id}/${st.id}`);
      }
    }
  }
  console.log('    stages with a clock: ' + Object.values(MISSIONS).flatMap((m) => m.stages
    .filter((st) => st.timeLimit != null)
    .map((st) => `${st.id} ${st.timeLimit}s ${st.marker ? 'marker' : 'no marker'}`
      + `, subtitle ${st.subtitle ? `"${st.subtitle.slice(0, 40)}…"` : 'NONE'}`)).join(' | '));
  check('every stage with a time limit tells the player what to do', timedNoCue.length === 0,
    timedNoCue.join(', ') || '0 of them');

  /**
   * AND A POSITIONAL CUE NEEDS A POSITIONAL EXIT. `src/mission.js` refuses the authoring, so
   * this walks the real district and prints the separations — the number the module's radius
   * test cannot show — plus the known-bad table, because a rule that only ever sees valid input
   * passes for the most flattering possible reason.
   *
   * Every correct marker in this district is at 0.000 m from its own reach target. That is the
   * measurement that makes "inside the radius" a generous bound rather than a chosen one.
   */
  {
    const rows = [];
    for (const m of Object.values(MISSIONS)) {
      for (const st of m.stages) {
        if (!st.marker) continue;
        const rs = [];
        const walk = (t) => {
          if (!t || !t.kind) return;
          if (t.kind === 'reach') rs.push(t);
          if ((t.kind === 'all' || t.kind === 'any') && Array.isArray(t.of)) t.of.forEach(walk);
        };
        (st.triggers ?? []).forEach(walk);
        const sep = rs.length
          ? Math.min(...rs.map((t) => Math.hypot(st.marker.x - t.x, st.marker.z - t.z))) : null;
        rows.push({ id: `${m.id}/${st.id}`, n: rs.length, sep,
          r: rs.length ? Math.max(...rs.map((t) => t.radius)) : null });
      }
    }
    console.log('    marker to its own reach target: ' + rows.map((x) =>
      `${x.id.split('/')[1]} ${x.sep == null ? 'NO REACH' : `${x.sep.toFixed(3)} m / r${x.r}`}`)
      .join(' | '));
    check('every marker in the district is its own stage\'s reach target, to the millimetre',
      rows.length > 0 && rows.every((x) => x.sep != null && x.sep < 0.001),
      `${rows.length} markers, worst ${Math.max(...rows.map((x) => x.sep ?? Infinity)).toFixed(3)} m`);
    // The KNOWN-BAD table. `b` must stay reachable and able to pass or an unrelated fault masks
    // the one under test — the first version of this fixture made it unreachable and all four
    // valid cases came back REFUSED, which would have read as the rule being broken.
    const fixture = (extra) => ({ id: 'probe', title: 'Probe', stages: [
      { id: 'a', objective: 'GO', triggers: [{ kind: 'inVehicle', goto: 'b' }] },
      { id: 'b', objective: 'FLEE', triggers: [{ kind: 'all',
        of: [{ kind: 'timer', seconds: 2 }, { kind: 'evaded' }], outcome: 'passed' }], ...extra },
    ] });
    const refuses = (extra) => {
      try { defineMission(fixture(extra)); return false; } catch { return true; }
    };
    const REACH28 = [{ kind: 'reach', x: 0, z: 0, radius: 28, outcome: 'passed' }];
    const bad = [
      ['the ambush that shipped: a marker and no reach at all', { marker: { x: -194.8, z: 38.6 } }],
      ['a marker 322 m from its reach trigger', { marker: { x: -194.8, z: 38.6 },
        triggers: [{ kind: 'reach', x: -471, z: 205, radius: 28, outcome: 'passed' }] }],
      ['a marker whose only positional trigger is `leave`', { marker: { x: 0, z: 0 },
        triggers: [{ kind: 'leave', x: 0, z: 0, radius: 10, outcome: 'passed' }] }],
      ['a marker 0.1 m outside the radius', { marker: { x: 0, z: 28.1 }, triggers: REACH28 }],
    ];
    const good = [
      ['a marker on its reach target', { marker: { x: 0, z: 0 }, triggers: REACH28 }],
      ['a marker 0.1 m inside the radius', { marker: { x: 0, z: 27.9 }, triggers: REACH28 }],
      ['a reach inside a composite', { marker: { x: 5, z: 0 }, triggers: [{ kind: 'all',
        of: [{ kind: 'timer', seconds: 2 }, { kind: 'reach', x: 0, z: 0, radius: 10 }],
        outcome: 'passed' }] }],
      ['no marker and no reach, which is what `ambush` is now', {}],
    ];
    const missedBad = bad.filter(([, e]) => !refuses(e)).map(([n]) => n);
    const falseAlarm = good.filter(([, e]) => refuses(e)).map(([n]) => n);
    check('KNOWN-BAD: defineMission refuses a positional cue with no positional exit',
      missedBad.length === 0, missedBad.join('; ')
        || `all ${bad.length} refused, including 28.1 m against a radius of 28`);
    check('and accepts every legitimate shape, so the bound is sharp not blanket',
      falseAlarm.length === 0, falseAlarm.join('; ')
        || `all ${good.length} accepted, including 27.9 m against the same radius`);
  }

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
  /**
   * AND ITS OWN KNOWN-BAD, BECAUSE REMOVING `ambush`'s MARKER HALVED THIS ARM'S COVERAGE.
   *
   * It read 2 edges and now reads 1: `ambush -> drop` was the edge the original defect lived
   * on, and the fix for the round-8 finding deleted the marker that made it checkable. One
   * remaining edge is not vacuous, but "1 edge, all clear" is thin evidence for a rule this
   * file has now been wrong about three times, and losing coverage without restating it is
   * exactly the silent loosening CLAUDE.md forbids.
   *
   * So the detector is run against the historical configuration it was written for — the
   * marker at (-471, 205), 0.0 m from `drop`'s own trigger — and must catch it. The predicate
   * is the same one the loop above uses, applied to planted data rather than re-derived, so
   * this cannot drift away from what it guards.
   */
  {
    const detect = (mk, t) => Math.hypot(mk.x - t.x, mk.z - t.z) <= t.radius;
    const drop = MISSIONS['marlin-street'].stages.find((x) => x.id === 'drop');
    const trig = (drop.triggers ?? []).find((t) => t.kind === 'reach');
    const atTheDrop = { x: trig.x, z: trig.z };                 // what shipped, and was found
    const shortOfIt = { x: -194.8, z: 38.6 };                   // what replaced it, and also wrong
    check('KNOWN-BAD: the marker that shipped at the drop is caught by this very predicate',
      detect(atTheDrop, trig) && !detect(shortOfIt, trig),
      `at the drop: ${Math.hypot(atTheDrop.x - trig.x, atTheDrop.z - trig.z).toFixed(2)} m vs `
      + `r=${trig.radius} -> caught; 322 m short of it: `
      + `${(Math.hypot(shortOfIt.x - trig.x, shortOfIt.z - trig.z) / trig.radius).toFixed(1)}x `
      + `the radius -> passes this rule, which is why it needed the other one`);
    check('and the arm still has a live edge of its own to walk',
      entryMargins.length > 0, `${entryMargins.length}: ${entryMargins.join(' | ')}`);
  }
  /**
   * NO HEALTH AT WHICH A MISSION GIVES UP MAY BE A HEALTH THE CAR CANNOT RECOVER FROM.
   *
   * The recoverable set is `health <= fireHealth`: a hit there latches a fire (damage.js:283,
   * from hit() only — update() merely sustains one already burning), it drains at fireRate,
   * the car wrecks, and respawnCar() repairs it. Above that there is no fire, no wreck, no
   * replacement, and `damage.repair()` has no caller a player can reach. So a mission gate
   * ABOVE fireHealth opens a band in which the car runs, no job can be finished, and nothing
   * resets it. It was 0.20 against a fireHealth of 0.12 and a playtester spent three attempts
   * in it at health 0.1542.
   *
   * Asserted against damage.js's OWN constant, not against the literal 0.12, because a
   * constant that nothing re-derives is a magic number waiting for the other one to move.
   */
  const dm = new DamageModel();
  const healthGates = [];
  for (const m of Object.values(MISSIONS)) {
    for (const st of m.stages) {
      for (const t of st.triggers ?? []) {
        if (t.kind === 'healthBelow') healthGates.push({ id: `${m.id}/${st.id}`, f: t.fraction });
      }
    }
  }
  console.log(`    mission health gates against damage.js fireHealth ${dm.fireHealth}:`);
  for (const g of healthGates) console.log(`      ${g.id} ${g.f}`);
  check('every mission health gate is inside the recoverable band',
    healthGates.length > 0 && healthGates.every((g) => g.f <= dm.fireHealth),
    healthGates.map((g) => `${g.id} ${g.f}`).join(', ') + ` vs fireHealth ${dm.fireHealth}`);
  check('...and there IS a health gate to check, so the arm is not vacuous',
    healthGates.length >= 3, `${healthGates.length} gates`);

  /**
   * A FIRST STAGE THAT A DRIVING PLAYER SKIPS MUST NOT BE THE ONLY PLACE ITS WORDS APPEAR.
   *
   * A playtester measured both missions' first objective on screen for 0.008333 s — half a frame
   * at 60 Hz. `toCar`'s only exit is `inVehicle`, which is already true for anyone who drove to
   * the job's marker, so the stage completes in the frame it began. The stage is not broken: on
   * foot it holds for as long as you stand there, and "get to the car" only means anything then.
   * What was broken is that "The parcel is already in the boot." lived ONLY in that subtitle, so
   * the flagship's single piece of setup narration was never rendered for a player who arrived
   * by car. It is in the `brief` now, which is shown at the offer whatever mode you arrive in.
   *
   * MY FIRST VERSION OF THIS CHECK LOOKED IN THE WRONG PLACE and reported `none` on a defect the
   * playtester had already measured: it tested stage-to-stage edges, asking whether a stage
   * exited on the same state trigger that entered it. `toCar` is not entered by a trigger at
   * all — it is entered at mission START, and the state that satisfies it is how the player got
   * to the marker. A check aimed at the wrong relation passes cleanly and says nothing, which is
   * the failure this file's own header warns about twice.
   */
  const lostNarration = [];
  const STATE_EXIT = new Set(['inVehicle', 'onFoot']);
  for (const m of Object.values(MISSIONS)) {
    const first = m.stages[0];
    if (!first || !first.subtitle) continue;
    const exits = first.triggers ?? [];
    const skippable = exits.length > 0 && exits.every((t) => STATE_EXIT.has(t.kind));
    if (!skippable) continue;
    const brief = m.brief ?? '';
    // The subtitle's own sentences, so a reworded brief still counts as carrying it.
    const carried = first.subtitle.split(/(?<=\.)\s+/).filter(Boolean)
      .every((s) => brief.includes(s.trim()));
    if (!carried) {
      lostNarration.push(`${m.id}/${first.id}: subtitle ${JSON.stringify(first.subtitle)}` +
        ` appears nowhere else, and the stage exits on ${exits.map((t) => t.kind).join('/')}` +
        ` which a player who drives to the marker already satisfies`);
    }
  }
  console.log(`    first stages that a driving player skips:`);
  for (const m of Object.values(MISSIONS)) {
    const f = m.stages[0];
    const ex = (f.triggers ?? []).map((t) => t.kind).join('/');
    const sk = (f.triggers ?? []).length && (f.triggers ?? []).every((t) => STATE_EXIT.has(t.kind));
    console.log(`      ${m.id}/${f.id} exits ${ex}  skippable ${sk}` +
      `  subtitle ${f.subtitle ? 'yes' : 'none'}`);
  }
  check('a skippable first stage carries no narration the brief does not',
    lostNarration.length === 0, lostNarration.join(' | ') || 'none lost');



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
    const { DamageModel } = await import('../src/damage.js');
    const M = MISSIONS['marlin-street'];
    /**
     * THE CRIMES ARE REPORTED WITH THE SCALE THE GAME PASSES, not unscaled. This arm used to
     * report bare ids, which made "one accident" mean the crime's raw table heat — and when
     * `pedestrianHit.heat` moved 1.15 -> 2.00 both checks here failed, correctly, because an
     * unscaled report is the REFERENCE case (src/damage.js normalises the pedestrian scale at
     * `pedKillSpeed`) and not the mild one. An accident is a low-speed clip, so the arm has to
     * say at what speed; 8 km/h is the playtester's own figure from the transcript in
     * src/pedestrians.js.
     */
    const dm = new DamageModel();
    const atDrop = (crimes) => {
      const r = new MissionRunner(), w = new WantedSystem();
      r.start(M);
      r.stageIndex = M.stages.findIndex((st) => st.id === 'drop');
      r.stageTime = 0;
      const snap = () => ({ px: 0, pz: 0, inVehicle: true, speed: 10, health: 1,
        wantedStars: w.stars, wantedState: w.state });
      r.update(1 / 60, snap());
      for (const c of crimes) {
        w.reportCrime(c.id, { at: { x: 0, z: 0 }, scale: dm.pedCrimeScale(c.kmh / 3.6) });
      }
      w.update(0.02, { x: 0, z: 0 });
      r.update(1 / 60, snap());
      return { stars: w.stars, stage: r.report().stage };
    };
    const one = atDrop([{ id: 'pedestrianHit', kmh: 8 }]);
    const two = atDrop([{ id: 'pedestrianHit', kmh: 8 }, { id: 'pedestrianKilled', kmh: 90 }]);
    console.log(`    at the drop: one 8 km/h pedestrianHit -> ${one.stars} star, stage ${one.stage}; ` +
      `a clip and a 90 km/h death -> ${two.stars} stars, stage ${two.stage}`);
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

// === 10. the objective's own distance, which only a TRIGGER may name
/**
 * `src/hud.js`'s objective band has carried an element for a distance since it was written,
 * dirty-checked per whole metre, and until 77a0690 the only tenant using it was the law line.
 * Round 6's playtester ran to 404 m from the car reading "GET IN THE CAR" unchanged the whole way.
 *
 * WHAT THIS SECTION IS REALLY FOR IS THE NEGATIVE. Attaching a number to a stage's `marker` would
 * be easy and wrong: `marlin-street`'s `ambush` carries one and is satisfied by a timer AND an
 * evasion, so a distance to it promises the player something arriving there does not deliver.
 * CLAUDE.md records that defect twice already, in the other direction — both of this project's
 * mission markers have been wrong, and both times a gate RULE put them there.
 */
console.log('\n=== 10. the objective distance');
{
  // Imported here rather than at the top, as section 9 does: this file's own convention.
  const { MISSIONS } = await import('../src/missions.js');
  const M = MISSIONS['marlin-street'];
  const at = (stageId, snap) => {
    const r = new MissionRunner();
    r.start(M);
    r.stageIndex = M.stages.findIndex((st) => st.id === stageId);
    r.stageTime = 0;
    r.update(1 / 60, { px: 0, pz: 0, inVehicle: true, speed: 0, health: 1,
      wantedStars: 0, wantedState: 'clear', ...snap });
    return { hud: r.hud(), report: r.report() };
  };

  // (a) a `reach` stage counts down to its own EDGE, not to the marker's centre.
  {
    const t = M.stages.find((st) => st.id === 'eastbound').triggers
      .find((x) => x.kind === 'reach');
    const far = at('eastbound', { px: t.x, pz: t.z - 500 });
    const nearly = at('eastbound', { px: t.x, pz: t.z - t.radius - 0.5 });
    const inside = at('eastbound', { px: t.x, pz: t.z - t.radius + 0.5 });
    console.log(`  reach r=${t.radius} m: at 500 m out ${far.report.objectiveDistance} m, ` +
      `0.5 m short of the edge ${nearly.report.objectiveDistance} m, 0.5 m inside it ` +
      `stage "${inside.report.stage}" distance ${inside.report.objectiveDistance}`);
    check('a reach stage carries the distance to its edge',
      Math.abs(far.report.objectiveDistance - (500 - t.radius)) < 0.01,
      `${far.report.objectiveDistance} against ${500 - t.radius}`);
    /**
     * IT NEVER HAS TO READ 0, and the first version of this check asked it to and failed: a player
     * inside the radius has SATISFIED the trigger, so the stage has already moved on and the
     * number belongs to the next one. What the player sees is the count going to 0.5 m and the
     * objective changing. Both halves are asserted, because "distance is null inside the radius"
     * and "the stage did not advance" would otherwise look the same.
     */
    check('the number runs down to the edge and the stage completes there, not at 0',
      Math.abs(nearly.report.objectiveDistance - 0.5) < 0.01 &&
      inside.report.stage !== 'eastbound',
      `${nearly.report.objectiveDistance} m short, then stage "${inside.report.stage}"`);
    check('and the band is an object with a distance, not a bare string',
      typeof far.hud.objective === 'object'
      && far.hud.objective.text === 'DRIVE EAST ALONG MARLIN STREET',
      objectiveLine(far.hud.objective));
  }

  // (b) an `inVehicle` stage carries the range to the car.
  {
    const with180 = at('backToCar', { inVehicle: false, carRange: 180.4 });
    const without = at('backToCar', { inVehicle: false });
    console.log(`  inVehicle: with carRange 180.4 -> "${objectiveLine(with180.hud.objective)}" ` +
      `(${with180.report.objectiveDistanceFrom}); without -> ` +
      `"${objectiveLine(without.hud.objective)}" (${without.report.objectiveDistanceFrom})`);
    check('an inVehicle stage carries the range to the car',
      with180.report.objectiveDistance === 180.4 &&
      objectiveLine(with180.hud.objective) === 'GET BACK IN THE CAR — 180 m',
      objectiveLine(with180.hud.objective));
    /**
     * KNOWN-BAD, AND THE REASON `carRange` IS NOT IN ANY TRIGGER'S `needs`: a host that does not
     * compute it must get an objective with no number rather than a throw, because no PREDICATE
     * reads it and the `needs` check exists to catch a trigger reading an absent field. The two
     * cases are told apart by `objectiveDistanceFrom` instead of being indistinguishable nulls.
     */
    check('KNOWN-BAD: a host that feeds no carRange gets no number, and says so',
      without.report.objectiveDistance === null &&
      without.report.objectiveDistanceFrom === 'inVehicle:no-carRange' &&
      typeof without.hud.objective === 'string',
      `${without.report.objectiveDistanceFrom}`);
  }

  /**
   * (c) THE NEGATIVE, RESTATED. This section's premise was `!!st.marker` — "ambush has a marker
   * and no destination, and must carry no number" — so it was the FOURTH gate rule in this tree
   * depending on a marker that should never have existed, and it would have gone green on the
   * defect for as long as the defect lasted.
   *
   * What `ambush` actually owes is: no destination, therefore no distance, no waypoint, and an
   * objective that is still the bare authored string. All four, because the first three are
   * different ways of saying "nothing positional" and a stage could lose one and keep another —
   * `objectiveDistance` already excluded this stage by name while `hud()` went on posting the
   * waypoint, which is precisely how the half-covered guard shipped.
   */
  {
    const amb = at('ambush', { carRange: 42 });
    const st = M.stages.find((x) => x.id === 'ambush');
    console.log(`  ambush triggers ${st.triggers.map((t) => t.kind).join('/')}, marker ` +
      `${st.marker ? `(${st.marker.x}, ${st.marker.z})` : 'none'} -> distance ` +
      `${amb.report.objectiveDistance}, from ${amb.report.objectiveDistanceFrom}, waypoint ` +
      `${JSON.stringify(amb.hud.waypoint ?? null)}`);
    check('a flee stage carries no distance, because nothing it does is positional',
      amb.report.objectiveDistance === null && amb.report.objectiveDistanceFrom === null,
      `${amb.report.objectiveDistance} / ${amb.report.objectiveDistanceFrom}`);
    check('and no waypoint either, which is the half the old guard did not cover',
      !st.marker && !amb.hud.waypoint,
      `marker ${JSON.stringify(st.marker ?? null)}, waypoint ${JSON.stringify(amb.hud.waypoint ?? null)}`);
    check('and its band is still the bare authored string',
      typeof amb.hud.objective === 'string' && amb.hud.objective === st.objective,
      `${amb.hud.objective}`);
    /**
     * AND IT STILL SAYS WHAT TO DO, because taking the pin away without this is the 63%-blank-HUD
     * defect coming back. The subtitle is now the whole instruction, so it is asserted here, and
     * it must name a cue that FIRES: "watch the stars drop" did not — 109 s of fleeing at 40 km/h
     * read 2 stars at every sample and went 2 -> 0 in one step after the stage was already won.
     * `EVADING` is the word `composeWanted` actually puts on screen, read off that module rather
     * than spelled again here, since a probe that hardcodes the value it tests cannot see the fix.
     */
    const note = composeWanted({ stars: 2, state: STATES.SEARCH, remaining: 16, evade: 0.3 }).note;
    const word = String(note).split(' ')[0];
    check('a flee stage names a cue that fires, in the word the wanted strip uses',
      typeof st.subtitle === 'string' && st.subtitle.includes(word)
      && !/stars? drop/i.test(st.subtitle),
      `note "${note}" -> word "${word}"; subtitle "${st.subtitle}"`);
  }

  // (d) every stage of every mission: either a destination and a number, or neither.
  {
    const rows = [];
    for (const [id, mission] of Object.entries(MISSIONS)) {
      for (const st of mission.stages) {
        const kinds = (st.triggers ?? []).map((t) => t.kind);
        const names = kinds.find((k) => k === 'reach' || k === 'inVehicle') ?? null;
        const r = new MissionRunner();
        r.start(mission);
        r.stageIndex = mission.stages.findIndex((x) => x.id === st.id);
        r.stageTime = 0;
        r.update(1 / 60, { px: 0, pz: 0, inVehicle: true, speed: 0, health: 1,
          wantedStars: 0, wantedState: 'clear', carRange: 99 });
        rows.push({ id, stage: st.id, names, d: r.report().objectiveDistance,
          marker: !!st.marker });
      }
    }
    const bad = rows.filter((x) => (x.names == null) !== (x.d == null));
    console.log(`  ${rows.length} stages: ` + rows.map((x) =>
      `${x.stage}${x.names ? `/${x.names}` : ''}${x.d == null ? '' : `=${x.d.toFixed(0)}m`}`).join(' '));
    check('every stage has a number exactly when a trigger names somewhere to go',
      bad.length === 0, bad.map((x) => `${x.id}/${x.stage}`).join(' ') || 'all consistent');
    /**
     * THE THIRD KIND USED TO BE "MARKER-ONLY", WHICH MAKES THIS THE FIFTH RULE IN THIS TREE
     * THAT REQUIRED `ambush`'s MARKER TO EXIST. A marker with no reach is now refused by
     * `defineMission`, so that class is empty BY CONSTRUCTION and the arm went red — correctly,
     * and for a reason that reads nothing like its own message.
     *
     * The class this arm actually needs is a stage with NO DESTINATION OF ANY KIND, which is
     * what makes the consistency check above non-vacuous in the null direction: without one,
     * `(names == null) !== (d == null)` is only ever tested where both are non-null.
     */
    const noDest = rows.filter((x) => x.names == null);
    check('and at least one stage of each kind exists, or this arm asserts nothing',
      rows.some((x) => x.names === 'reach') && rows.some((x) => x.names === 'inVehicle') &&
      noDest.length > 0 && noDest.every((x) => !x.marker),
      `${rows.filter((x) => x.names === 'reach').length} reach, ` +
      `${rows.filter((x) => x.names === 'inVehicle').length} inVehicle, ` +
      `${noDest.length} with no destination (${noDest.map((x) => x.stage).join('/')}), ` +
      `${noDest.filter((x) => x.marker).length} of those wrongly carrying a marker`);
  }
}

// ---------------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('\n=== CHECKS');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nMISSION: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}` : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
