// Which of this project's checks have teeth? Break the modules on purpose and see.
//
// Three review rounds have done this by hand, and the misses were worth more than the hits:
// one round's gate caught 15 of 27 mutations, and the twelve it missed are most of what
// CLAUDE.md's "Three reviewers, 40 findings" section is made of. The most recent round found a
// clean miss — `AVOID_R` reverted to the value it replaced passed every gate that touches it,
// because the fix had been measured by a probe and asserted by nothing.
//
// Doing it by hand costs a reviewer its whole context and produces a table nobody can re-run.
// This runs the same sweep in one command and prints the same table.
//
//   node tools/mutation-sweep.mjs                 every mutation, full offline list
//   node tools/mutation-sweep.mjs --only pinned   one, by id
//   node tools/mutation-sweep.mjs --list          the table, without running anything
//   node tools/mutation-sweep.mjs --browser       also run boot-check where a mutation asks
//   node tools/mutation-sweep.mjs --selftest      prove the harness itself
//
// HOW IT RESTORES, AND WHY THE TREE MUST BE CLEAN. The district is 16 GB against 7 GB of free
// disk, so there is no shadow copy to mutate: it edits in place and restores with
// `git checkout --`, which is exact. That is only safe on a clean tree, so it REFUSES to start
// on a dirty one rather than risk somebody's uncommitted work. `--selftest` asserts the refusal.
//
// A MUTATION WHOSE `find` NO LONGER OCCURS IS REPORTED **STALE**, not missed. A table that
// silently skips the lines the code has moved past would report a shrinking set of misses as
// the code improved, which is the same trap as a diagnostic that becomes more uniform after a
// fix: CLAUDE.md's `tail -20` story. Stale lines are a failure of this file, and it says so.
//
// AND A GATE THAT THREW IS DISTINGUISHED FROM ONE THAT FAILED. Both exit non-zero, so both
// "catch" a mutation — but a throw may be incidental (a null deref three functions away) rather
// than the check noticing. `ped-audit` threw on every run for months while reading as a pass,
// which is the same confusion from the other side.
import fs from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

/** The offline list, in CLAUDE.md's own order. All of them run for every mutation. */
const OFFLINE = [
  'check-syntax', 'geom-audit', 'golden-trace', 'physics-test', 'leaf-mask', 'wanted-test',
  'mission-test', 'damage-test', 'blocker-test', 'crash-test', 'roadpath-test', 'route-drive',
  'reaction-test', 'sim-determinism', 'traffic-selftest', 'hud-cue',
];

/**
 * THE TABLE. Each line is a defect somebody could plausibly introduce — a reverted constant, a
 * dropped guard, a filter that stops filtering — written as the exact edit.
 *
 * `browser: true` marks a mutation only a gate that LOADS THE PAGE can see. district/main.js is
 * imported by no offline gate, so a mutation there is invisible to all sixteen by construction;
 * saying so in the table is the point, and `--browser` runs boot-check for those lines.
 */
const MUTATIONS = [
  // ---- src/traffic.js
  {
    id: 'gap-level', file: 'src/traffic.js',
    find: 'if (!(along > CAR_LENGTH)) return Infinity;',
    to: 'if (!(along > 0)) return Infinity;',
    why: 'a car drawing level with the player reads a negative bumper gap and brakes 28x',
  },
  {
    id: 'gap-range', file: 'src/traffic.js',
    find: 'return gap > PLAYER_WATCH_M ? Infinity : gap;',
    to: 'return gap;',
    why: 'the player becomes a leader from 600 m away, so the "it fired" counter counts nothing',
  },
  {
    id: 'gap-obb', file: 'src/traffic.js',
    find: '      : PLAYER_HALF_W * Math.abs(-pfz * nx + pfx * nz) + PLAYER_HALF_L * Math.abs(pfx * nx + pfz * nz);',
    to: '      : PLAYER_HALF_W;',
    why: 'a car parked ACROSS a lane is invisible again — the defect the corridor exists for',
  },
  {
    id: 'pinned', file: 'src/traffic.js',
    find: 'const playerPinned = playerIsLeader && car.v < 0.15;',
    to: 'const playerPinned = false;',
    why: 'cars stopped for the player are deleted as gridlocked, and the queue behind them too',
  },
  {
    id: 'drivable', file: 'src/traffic.js',
    find: '        && this._edgeDrivable(o.e, o.forward)',
    to: '        && true',
    why: 'traffic routes onto roads a car body cannot fit down',
  },
  // ---- src/pedestrians.js
  {
    id: 'avoid-r', file: 'src/pedestrians.js',
    find: 'export const AVOID_R = 2.86;',
    to: 'export const AVOID_R = 1.6;',
    why: 'the avoidance radius stops covering the car body — the round-3 clean miss',
  },
  {
    id: 'closing', file: 'src/pedestrians.js',
    find: 'if (!force && closing < PED_FREE_MS) return null;',
    to: 'if (!force && v < PED_FREE_MS) return null;',
    why: 'the free threshold goes back on the car\'s ground speed, not the closing speed',
  },
  {
    id: 'runover', file: 'src/pedestrians.js',
    find: '    if (!force && v < PED_FREE_MS) return null;\n    const fatal = v >= ANCHORS.pedKillSpeed;',
    to: '    const fatal = v >= ANCHORS.pedKillSpeed;',
    why: 'rolling onto a body at walking pace becomes a felony',
  },
  {
    id: 'ped-dir', file: 'src/pedestrians.js',
    find: 'if (!(L > 0) || !Number.isFinite(L)) return null;',
    to: 'if (false) return null;',
    why: 'a NaN or zero direction reaches the fall axis; a casualty stands bolt upright',
  },
  // ---- src/damage.js
  {
    id: 'crime-scale', file: 'src/damage.js',
    find: 'return this.majorSeverity > 0 ? severity / this.majorSeverity : 1;',
    to: 'return 1;',
    why: 'the crime charge goes back to speed-blind: a 110 km/h write-off costs 0 stars',
  },
  {
    id: 'free-dv', file: 'src/damage.js',
    find: 'if (!(dv > this.freeDv)) return null;',
    to: 'if (dv < this.freeDv) return null;',
    why: 'at exactly the free threshold a crime is filed with severity 0',
  },
  // ---- src/wanted.js
  {
    id: 'scene-watch', file: 'src/wanted.js',
    find: '    this._watchScene(player);\n',
    to: '',
    why: 'leaving the scene of an injury stops being an offence',
  },
  {
    id: 'scene-stop', file: 'src/wanted.js',
    find: '      if (Math.hypot(this.playerVel.x, this.playerVel.z) < SCENE_STOP_MS) {',
    to: '      if (true) {',
    why: 'driving off at speed counts as having stopped at the scene',
  },
  {
    id: 'scene-radius', file: 'src/wanted.js',
    find: 'SCENE_LEAVE_M = RESPONSE[1].spotRadius;',
    to: 'SCENE_LEAVE_M = 400;',
    why: 'the leave radius stops tracking the response table it is derived from',
  },
  // ---- src/vehicle.js
  {
    id: 'steer-pull', file: 'src/vehicle.js',
    find: 'const target = (steer * this.maxSteer + this.steerPull * this.maxSteer) * speedFactor;',
    to: 'const target = steer * this.maxSteer * speedFactor + this.steerPull * this.maxSteer;',
    why: 'the damage pull goes back to 59% of available authority at 140 km/h',
  },
  {
    id: 'reverse-taper', file: 'src/vehicle.js',
    find: '      t *= THREE.MathUtils.clamp(1 - rev / this.reverseMax, 0, 1);',
    to: '      t *= 1;',
    why: 'reverse has no speed ceiling',
  },
  // ---- src/hud.js
  {
    id: 'band-order', file: 'src/hud.js',
    find: 'const pick = wreck ?? fence ?? mission ?? ended ?? offer ?? null;',
    to: 'const pick = offer ?? ended ?? mission ?? fence ?? wreck ?? null;',
    why: 'an offer outranks a wrecked car and the world fence in the objective band',
  },
  {
    id: 'fence-subtitle', file: 'src/hud.js',
    find: "    subtitle = `still on: ${mission.objective}`;",
    to: '    subtitle = null;',
    why: 'the fence eats a running mission\'s only sign of life',
  },
  {
    id: 'pull-cue', file: 'src/hud.js',
    find: '    this._pullCue(ctx, L, d.steerPull);',
    to: '',
    why: 'nothing on screen says which way a damaged car pulls',
  },
  // ---- src/blockers.js
  {
    id: 'fence-dir', file: 'src/blockers.js',
    find: 'Math.sign(throttle) * dot > 0',
    to: 'true',
    why: 'the world fence refuses power in both directions and strands the car outside',
  },
  // ---- src/roadpath.js
  {
    id: 'crawl-floor', file: 'src/roadpath.js',
    find: 'CRAWL_MS',
    to: '0 * CRAWL_MS',
    why: 'an impossible corner stops the car dead instead of letting it creep round',
    firstOnly: true,
  },
  // ---- src/blockers.js
  {
    id: 'resolve-eps', file: 'src/blockers.js',
    find: 'const EPS = 1e-6;',
    to: 'const EPS = 0;',
    why: 'resolveCircle stops converging: a parked car is charged an impact every frame',
  },
  // ---- src/mission.js
  {
    id: 'offer-latch', file: 'src/mission.js',
    find: '  arm(id) { this.latched.add(id); return this; }',
    to: '  arm(id) { return this; }',
    why: 'aborting a mission on its own marker restarts it immediately',
  },
  // ---- src/roadpath.js
  {
    id: 'sine-cap', file: 'src/roadpath.js',
    find: '  const a90 = Math.min(Math.abs(err), Math.PI / 2);',
    to: '  const a90 = Math.abs(err);',
    why: 'pure pursuit cannot tell "pointing at it" from "pointing exactly away"',
  },
  {
    id: 'corner-now', file: 'src/roadpath.js',
    find: '    cornerSpeed(reqRadius));',
    to: '    Infinity);',
    why: 'the corner the car is IN stops being a speed ceiling; it floors the throttle at full lock',
  },
  // ---- src/traffic.js, the junction
  {
    id: 'junction', file: 'src/traffic.js',
    find: "if (cid !== car.id && this._conflicts(mv, other)) { ok = false; why = 'conflict'; break; }",
    to: 'if (false) { ok = false; }',
    why: 'cars stop yielding at junctions and drive through each other',
  },
  // ---- src/hud.js
  {
    id: 'minimap-reach', file: 'src/hud.js',
    find: 'export const MINIMAP_REACH_M = MINIMAP_ZOOM_M / 2;',
    to: 'export const MINIMAP_REACH_M = 1e9;',
    why: 'every job on the board shows as a blip from anywhere in the district',
  },
  // ---- district/main.js: no offline gate imports it, so these are invisible by construction.
  {
    id: 'charge-window', file: 'district/main.js',
    find: '  if (last !== undefined && now - last <= PED_CRIME_WINDOW_S) return false;',
    to: '  if (false) return false;',
    why: 'one pedestrian becomes five stars again, charged every knockdown cycle',
    browser: true,
  },
  {
    id: 'loop-breaker', file: 'district/main.js',
    find: '  if (looping) wreckStats.loopsBroken++;',
    to: '  looping = false;',
    why: 'the respawn puts the car back into whatever wrecked it, for ever',
    browser: true,
    expectStale: true,
  },
];

// --------------------------------------------------------------------------- mechanics
/**
 * TRACKED changes only. `git status --porcelain` counts untracked files too, and the first run of
 * this tool refused to start because of ITSELF — it was untracked, so it read the tree as dirty.
 * That is the wrong predicate: the thing being guarded is `git checkout -- <file>`, which can only
 * discard modifications to a TRACKED file and cannot touch an untracked one.
 *
 * It can, however, fail outright on a file git does not know about, so `tracked()` checks that
 * separately for every target rather than folding the two questions into one.
 */
const gitClean = () => execSync('git status --porcelain --untracked-files=no',
  { cwd: ROOT, encoding: 'utf8' }).trim() === '';
const tracked = (f) => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', f],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
};

function runGate(name) {
  const t0 = Date.now();
  let out = '', rc = 0;
  try {
    out = execFileSync('node', [`tools/${name}.mjs`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
    });
  } catch (e) {
    rc = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  /**
   * A THROW IS NOT A FAILED CHECK. Both exit non-zero, and a reviewer reading only the exit code
   * cannot tell "the gate noticed" from "something died on the way". A node stack trace is the
   * tell: a gate that fails prints its own verdict line and no `at <file>:<line>` frames.
   */
  const threw = /^\s+at .+:\d+:\d+\)?$/m.test(out) || /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(out);
  const failed = out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
  return { name, rc, threw, failed, ms: Date.now() - t0 };
}

function playtestSelftest() {
  const t0 = Date.now();
  let out = '', rc = 0;
  try {
    out = execFileSync('node', ['tools/playtest.mjs', '--selftest'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
    });
  } catch (e) { rc = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  const threw = /^\s+at .+:\d+:\d+\)?$/m.test(out) || /\b(TypeError|ReferenceError|SyntaxError)\b/.test(out);
  const failed = out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
  return { name: 'playtest', rc, threw, failed, ms: Date.now() - t0 };
}

/** Apply a mutation. Returns null when its `find` no longer occurs — a STALE line. */
function apply(m) {
  const p = path.join(ROOT, m.file);
  const src = fs.readFileSync(p, 'utf8');
  const n = src.split(m.find).length - 1;
  if (n === 0) return null;
  if (n > 1 && !m.firstOnly) return { ambiguous: n };
  fs.writeFileSync(p, m.firstOnly ? src.replace(m.find, m.to) : src.split(m.find).join(m.to));
  return { hits: n };
}
const restore = (m) => execFileSync('git', ['checkout', '--', m.file], { cwd: ROOT });

/**
 * ONE AT A TIME, AND I PROVED WHY BY BREAKING IT. While a sweep was running I ran `--selftest` in
 * another shell. The selftest mutates `src/damage.js` and restores it with `git checkout --`, and
 * the sweep had a DIFFERENT file mutated at that moment — so the two instances were each editing
 * and reverting the same working tree, and either could have wiped the other's mutation in the
 * middle of a gate run. The selftest's own clean-tree checks failed, which is how I noticed; had
 * they collided on the same file instead, the sweep would have quietly reported a mutation as
 * MISSED because it was no longer applied.
 *
 * A lock file, so the second instance says so instead of corrupting the first. Held for the whole
 * run and released on exit, including on a throw.
 */
const LOCK = path.join(ROOT, '.mutation-sweep.lock');
function takeLock(what) {
  try {
    fs.writeFileSync(LOCK, `${what} pid ${process.pid} at ${new Date().toISOString()}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = '';
    try { held = fs.readFileSync(LOCK, 'utf8').trim(); } catch { /* raced away */ }
    console.error('REFUSING: another mutation-sweep is running, and two of them share one working');
    console.error('tree — each would revert the other\'s mutation mid-gate and report it MISSED.');
    if (held) console.error(`  lock held by: ${held}`);
    console.error(`  if that process is gone, delete ${path.relative(ROOT, LOCK)}`);
    process.exit(2);
  }
  const drop = () => { try { fs.unlinkSync(LOCK); } catch { /* already gone */ } };
  process.on('exit', drop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { drop(); process.exit(130); });
}

// --------------------------------------------------------------------------- selftest
if (has('--selftest')) {
  takeLock('selftest');
  const checks = [];
  const say = (ok, name, detail) => { checks.push({ ok, name, detail }); };

  // 1. The refusal. Restoring by `git checkout --` is only safe on a clean tree.
  say(typeof gitClean() === 'boolean', 'it can read whether the tree is clean');
  say(gitClean(), 'the selftest itself needs a clean tree to prove anything', 'commit first');
  // Untracked files must NOT count as dirty, or this tool refuses to run because of itself.
  say(gitClean(), 'an untracked file does not read as dirty', 'this file was untracked on its first run');
  const untracked = [...new Set(MUTATIONS.map((m) => m.file))].filter((f) => !tracked(f));
  say(untracked.length === 0, 'every mutation targets a file git tracks, so restore cannot fail',
    untracked.join(', ') || 'all tracked');

  /**
   * 2. A MUTATION THAT MUST BE CAUGHT. Breaking syntax in a src file has to fail check-syntax, or
   *    the harness is not running the gates it claims to.
   */
  const bad = { id: 'selftest-syntax', file: 'src/damage.js',
    find: 'export function pedFatalityRisk(speedMs) {', to: 'export function pedFatalityRisk(speedMs) { (' };
  const a1 = apply(bad);
  const g1 = a1 ? runGate('check-syntax') : null;
  if (a1) restore(bad);
  say(!!a1 && g1.rc !== 0, 'a broken module fails check-syntax', g1 ? `rc ${g1.rc}` : 'find string missing');
  say(gitClean(), 'and the tree is clean again afterwards');

  /**
   * 3. A NO-OP MUTATION MUST BE REPORTED AS MISSED. Without this the harness could be finding
   *    something for every line — including the ones it has broken by accident — and a table of
   *    all-caught would read as good news.
   */
  const noop = { id: 'selftest-noop', file: 'src/damage.js',
    find: 'export const THROW = Object.freeze(', to: 'export const THROW = /* noop */ Object.freeze(' };
  const a2 = apply(noop);
  const g2 = a2 ? runGate('check-syntax') : null;
  const g2b = a2 ? runGate('damage-test') : null;
  if (a2) restore(noop);
  say(!!a2 && g2.rc === 0 && g2b.rc === 0, 'a semantically identical edit is caught by nothing',
    g2 ? `check-syntax rc ${g2.rc}, damage-test rc ${g2b.rc}` : 'find string missing');

  // 4. A STALE line is reported as stale, not as a miss.
  const stale = { id: 'selftest-stale', file: 'src/damage.js',
    find: 'a string that is certainly not in this file 8f3a', to: 'x' };
  say(apply(stale) === null, 'a find string that does not occur reports STALE');

  // The lock is untracked, so holding it must not make the tree read as dirty — otherwise the
  // tool locks itself out on its own second check.
  say(fs.existsSync(LOCK) && gitClean(), 'holding the lock does not make the tree read as dirty');

  // 5. And the throw/fail distinction, on real output shapes.
  say(/^\s+at .+:\d+:\d+\)?$/m.test('    at file:///x/y.mjs:12:3'), 'a node stack frame reads as a throw');
  say(!/^\s+at .+:\d+:\d+\)?$/m.test('  FAIL  some check — 3 against 4'),
    'and a FAIL line does not');

  console.log('MUTATION SWEEP SELFTEST');
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  const bad2 = checks.filter((c) => !c.ok).length;
  console.log(bad2 ? `\nSELFTEST: FAIL — ${bad2} of ${checks.length}` : `\nSELFTEST: PASS — ${checks.length} checks`);
  process.exit(bad2 ? 1 : 0);
}

// --------------------------------------------------------------------------- listing
if (has('--list')) {
  console.log(`${MUTATIONS.length} mutations\n`);
  for (const m of MUTATIONS) {
    console.log(`  ${m.id.padEnd(16)} ${m.file.padEnd(22)} ${m.browser ? '[browser] ' : ''}${m.why}`);
  }
  process.exit(0);
}

// --------------------------------------------------------------------------- the sweep
if (!gitClean()) {
  console.error('REFUSING: the working tree is dirty.');
  console.error('This tool restores by `git checkout -- <file>`, which would discard your changes.');
  console.error('Commit or stash first. (The district is 16 GB against 7 GB free, so there is no');
  console.error('shadow copy to mutate instead.)');
  process.exit(2);
}

const untracked = [...new Set(MUTATIONS.map((m) => m.file))].filter((f) => !tracked(f));
if (untracked.length) {
  console.error(`REFUSING: these targets are not tracked by git, so restore would fail: ${untracked.join(', ')}`);
  process.exit(2);
}

takeLock('sweep');
const only = val('--only', null);
const browser = has('--browser');
const list = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
if (!list.length) { console.error(`no mutation with id "${only}"`); process.exit(2); }

console.log(`MUTATION SWEEP — ${list.length} mutation(s), ${OFFLINE.length} offline gates` +
  `${browser ? ' + boot-check where asked' : ''}`);
console.log(`tree ${execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()}\n`);

const rows = [];
for (const m of list) {
  process.stdout.write(`  ${m.id.padEnd(16)} `);
  const a = apply(m);
  if (a === null) {
    rows.push({ m, verdict: 'STALE', gates: [] });
    console.log('STALE — its `find` string is not in the file any more');
    continue;
  }
  if (a.ambiguous) {
    restore(m);
    rows.push({ m, verdict: 'AMBIGUOUS', gates: [] });
    console.log(`AMBIGUOUS — ${a.ambiguous} occurrences; narrow the find string or set firstOnly`);
    continue;
  }
  const gates = [];
  for (const g of OFFLINE) gates.push(runGate(g));
  gates.push(playtestSelftest());
  if (browser && m.browser) gates.push(runGate('boot-check'));
  restore(m);
  const caught = gates.filter((g) => g.rc !== 0);
  const verdict = caught.length ? 'caught' : 'MISSED';
  rows.push({ m, verdict, gates: caught });
  console.log(`${verdict}${caught.length ? ` by ${caught.map((g) => g.name + (g.threw ? '(threw)' : '')).join(', ')}` : ''}`);
  if (!gitClean()) {
    console.error(`\nSTOPPING: the tree did not come back clean after ${m.id}. Inspect it by hand.`);
    process.exit(2);
  }
}

// --------------------------------------------------------------------------- report
console.log('\n' + '='.repeat(78));
const missed = rows.filter((r) => r.verdict === 'MISSED');
const stale = rows.filter((r) => r.verdict === 'STALE' || r.verdict === 'AMBIGUOUS');
const caught = rows.filter((r) => r.verdict === 'caught');
console.log(`caught ${caught.length}   MISSED ${missed.length}   stale/ambiguous ${stale.length}` +
  `   of ${rows.length}`);

if (missed.length) {
  console.log('\nMISSED — a defect no gate in the list noticed:');
  for (const r of missed) {
    console.log(`  ${r.m.id}  (${r.m.file})`);
    console.log(`      ${r.m.why}`);
    if (r.m.browser && !browser) {
      console.log('      NOTE: marked [browser]; no offline gate imports district/main.js, so this');
      console.log('      is invisible BY CONSTRUCTION. Re-run with --browser to include boot-check.');
    }
  }
}
if (stale.length) {
  console.log('\nSTALE — this file is out of date, which is a defect in this file and not a pass:');
  for (const r of stale) console.log(`  ${r.m.id}  (${r.m.file})  ${r.verdict}`);
}
const threwOnly = caught.filter((r) => r.gates.every((g) => g.threw));
if (threwOnly.length) {
  console.log('\nCAUGHT ONLY BY A THROW — a weaker catch than a failed check, because the gate did');
  console.log('not notice, something died on the way:');
  for (const r of threwOnly) {
    console.log(`  ${r.m.id}  ${r.gates.map((g) => g.name).join(', ')}`);
  }
}
console.log('\nper mutation:');
for (const r of rows) {
  const by = r.gates.map((g) => `${g.name}${g.threw ? '(threw)' : ''}`).join(' ');
  console.log(`  ${r.verdict.padEnd(10)} ${r.m.id.padEnd(16)} ${by}`);
}
// The sweep is a report, not a gate: a MISS is information, and failing the command on one would
// make a round delete the mutation rather than close the hole. Stale lines DO fail, because they
// are this file rotting.
console.log(stale.length
  ? `\nMUTATION SWEEP: ${stale.length} STALE LINE(S) — fix the table`
  : '\nMUTATION SWEEP: done');
process.exit(stale.length ? 1 : 0);
