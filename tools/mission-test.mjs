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
const failed = checks.filter((c) => !c.ok);
console.log('\n=== CHECKS');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nMISSION: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}` : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
