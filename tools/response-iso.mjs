// WHICH COLUMN OF `RESPONSE` MAKES THREE STARS ARREST WHERE TWO DO NOT — ONE COLUMN AT A TIME.
//
//   node tools/response-iso.mjs               the sweep and the isolation
//   node tools/response-iso.mjs --selftest    prove the instrument
//   RI_SPOTS=20 RI_SEEDS=1,2,3,4 RI_SECONDS=240   the defaults, overridable
//
// THE QUESTION is round 11's, left in BACKLOG #112 under "What round 11 could not resolve": at a
// spot where a stationary player at 2 stars is never arrested, the same player at 3 stars is. The
// level moves eleven columns of `src/wanted.js`'s RESPONSE table together — units, speedMul,
// spotRadius, giveUpRadius and seven more — and a scenario that sets the STAR LEVEL can only move
// all eleven at once, which is why round 11 could not say which one does it.
//
// THE LEVER IS ONE LINE OF src/wanted.js: `this.response = opts.response ?? RESPONSE`. `tune()`
// reads that field, so a session's table can be replaced after construction and one column of one
// row swapped while every other number in the game stays the shipped one. That makes it a
// one-term isolation in both directions:
//
//   LIFT   start at 2 stars with row 2's column C set to row 3's value     does 2* now arrest?
//   DROP   start at 3 stars with row 3's column C set to row 2's value     does 3* stop arresting?
//
// A column that flips the outcome both ways is the answer; one that flips neither is not; and one
// that moves nothing at all — the trace byte-identical to the unswapped run — is a column the
// harness never reads, which this file prints rather than assumes. district/main.js's own comment
// says the pursuit shim honours "fleet size, convergence target, speed multiplier and give-up
// radius" and NOT the spawn band or the intercept roles; this is the measurement of that sentence.
//
// THE CONTROLS, without which every flip below is ambiguous:
//   - The WHOLE row swapped. 2 stars carrying row 3 entire must reproduce 3 stars shipped, byte for
//     byte, wherever no star decayed — otherwise something other than the table differs between
//     the levels and no column swap can be the whole answer. (`this.stars` is otherwise read only
//     as `> 0` and for reporting; the trace says whether that sentence is true.)
//   - An IDENTITY table — a fresh copy of the shipped one — must leave the trace byte-identical, so
//     the swap mechanism itself perturbs nothing.
//   - The seeds must reach the pursuit. CLAUDE.md, from this session: `Session` did not hand its
//     seed to `Traffic`, and "16 seeds" were sixteen replicates of one fleet. The pursuit DOES get
//     the seed; the selftest checks the draws actually differ rather than trusting the line.
//
// WHAT IT CANNOT SEE: this is the harness, not the page. The page's bridge honours the same four
// columns by its own comment and `boot-check` owns the wire, but a column the page reads and the
// harness does not would be invisible here. Said so in the report rather than discovered later.
import { createHash } from 'node:crypto';
import { RESPONSE } from '../src/wanted.js';
import { BODY_RADIUS } from '../src/vehicle.js';
import { Session } from './playtest.mjs';
import { classify } from './arrest-band.mjs';

const SELFTEST = process.argv.includes('--selftest');
/** Silent when imported, for the reason tools/arrest-band.mjs records above its own guard. */
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

/** Every column of a row, honoured or not: the report says which ones moved anything. */
export const COLUMNS = Object.keys(RESPONSE[2]);
/** The columns rows 2 and 3 actually disagree on. A column equal in both cannot be the answer. */
export const DIFFERING = COLUMNS.filter((c) => RESPONSE[2][c] !== RESPONSE[3][c]);

/**
 * A table equal to the shipped one except where `edits` says, as fresh objects so nothing frozen is
 * mutated and nothing shared with another session can leak between arms.
 * `edits` is a list of { row, col, value } and/or { row, rowFrom } (the whole row copied).
 */
export function tableWith(edits = []) {
  const t = RESPONSE.map((r) => ({ ...r }));
  for (const e of edits) {
    if (e.rowFrom !== undefined) t[e.row] = { ...RESPONSE[e.rowFrom] };
    else {
      if (!(e.col in t[e.row])) throw new Error(`no column "${e.col}" in RESPONSE — a swap of a ` +
        `column that does not exist would change nothing and read as "this column is inert"`);
      t[e.row][e.col] = e.value;
    }
  }
  return t;
}

/**
 * Every non-service edge's arc-length midpoint that is clear for the car's body, with the heading
 * along the edge there. The candidate set for the spots below and for `tools/clear-time.mjs`'s
 * destinations, so the two tools sample the same network the same way.
 */
export function roadPoints(district, blockers) {
  const cand = [];
  for (const e of district.edges) {
    if (e.c === 'service') continue;
    const pts = e.v.map((i) => district.verts[i]);
    let L = 0;
    const seg = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const d = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      seg.push(d); L += d;
    }
    if (L < 20) continue;
    let half = L / 2, k = 0;
    while (k < seg.length - 1 && half > seg[k]) { half -= seg[k]; k++; }
    const a = pts[k], b = pts[k + 1], f = seg[k] > 0 ? half / seg[k] : 0;
    const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
    if (blockers.resolveCircle(x, z, BODY_RADIUS)) continue;
    cand.push({ x, z, yaw: Math.atan2(b.x - a.x, b.z - a.z), cls: e.c });
  }
  return cand;
}

/**
 * Spots on the road network, spread out by farthest-point selection so the sample covers different
 * local topology rather than one neighbourhood twenty times, the first one the nearest to the
 * district's own spawn. Deterministic.
 */
export function spotsOf(district, blockers, n) {
  const cand = roadPoints(district, blockers);
  if (cand.length < n) throw new Error(`only ${cand.length} clear road midpoints for ${n} spots`);
  const sp = district.meta.spawn;
  const chosen = [cand.reduce((m, c) => (Math.hypot(c.x - sp.x, c.z - sp.z)
    < Math.hypot(m.x - sp.x, m.z - sp.z) ? c : m))];
  while (chosen.length < n) {
    let best = null, bestD = -1;
    for (const c of cand) {
      let d = Infinity;
      for (const p of chosen) d = Math.min(d, Math.hypot(c.x - p.x, c.z - p.z));
      if (d > bestD) { bestD = d; best = c; }
    }
    chosen.push(best);
  }
  return chosen;
}

/**
 * One stationary player, braked, at `stars`, under `table`, for up to `seconds`. Ends on a bust, on
 * the level reaching zero, or at the horizon. The trace hash covers every unit position (full
 * precision, not rounded — a rounded trace could call two different runs identical), every unit's
 * held flag, the star level and the bust count, once a second: two arms whose hashes match drove
 * the same game.
 */
export function run({ spot, seed, stars, table = null, seconds = 240 }) {
  const s = new Session({ seed, peds: 0, traffic: 0 });
  if (table) s.wanted.response = table;
  s.placeAt(spot.x, spot.z, spot.yaw);
  s.wanted.setStars(stars, 'response-iso');
  if (s.wanted.stars !== stars) {
    throw new Error(`setStars(${stars}) left the level at ${s.wanted.stars}: every row below would ` +
      `be about the wrong level`);
  }
  // Read BEFORE the first step: a star can decay inside the run, after which `tune()` is the next
  // row down and a check of "the override is what tune() reads" would be reading a different row.
  const tuneUnits = s.wanted.tune().units;
  const ev = { decays: 0, decayAt: null };
  s.wanted.on('stars', (e) => {
    if (e.reason === 'decay') { ev.decays++; if (ev.decayAt === null) ev.decayAt = s.t; }
  });
  const h = createHash('sha1');
  let minD = Infinity, unitsEver = 0, heldEver = 0, firstUnit = null, speed = null;
  const t0 = s.t;
  for (let k = 0; k < seconds && s.stats.busts === 0 && s.wanted.stars > 0; k++) {
    s.drive({ throttle: 0, brake: 1 }).step(1);
    if (speed === null) speed = s.pursuit.speed;
    const u = s._unitPositions();
    unitsEver = Math.max(unitsEver, u.length);
    heldEver = Math.max(heldEver, u.filter((p) => p.held).length);
    if (!firstUnit && u.length) firstUnit = { x: u[0].x, z: u[0].z };
    for (const p of u) {
      const d = Math.hypot(p.x - s.vehicle.position.x, p.z - s.vehicle.position.z);
      if (d < minD) minD = d;
    }
    // The level as a DELTA from where it started, not the level itself: the whole-row control
    // compares a 2-star run against a 3-star one, and an absolute level would make those two
    // hashes differ by construction and the control unable to pass. AND A CLEARED LEVEL IS ITS
    // OWN TOKEN, because the delta is not invariant across a clear: the first version of this line
    // failed the whole-row control on two runs identical to the physics step, both busted at 13 s,
    // because 0 - 3 is not 0 - 2. The control was right to fail; the encoding was the defect.
    const lvl = s.wanted.stars === 0 ? 'clear' : s.wanted.stars - stars;
    h.update(`${k}|${u.map((p) => `${p.x},${p.z},${p.held ? 1 : 0}`).join(';')}|` +
      `${lvl}|${s.stats.busts}\n`);
  }
  const r = { busts: s.stats.busts, stars: s.wanted.stars };
  return { outcome: classify(r), t: s.t - t0, ...r, decays: ev.decays, decayAt: ev.decayAt,
    minD, unitsEver, heldEver, firstUnit, hash: h.digest('hex').slice(0, 16), speed, tuneUnits };
}

const tag = (r) => r.outcome === 'arrested' ? `A${r.t.toFixed(0)}`
  : r.outcome === 'escaped' ? `E${r.t.toFixed(0)}` : 'S';

// ----------------------------------------------------------------------- the sweep
if (IS_MAIN && !SELFTEST) {
  const N = Number(process.env.RI_SPOTS ?? 20);
  const SEEDS = (process.env.RI_SEEDS ?? '1,2,3,4').split(',').map(Number);
  const SECONDS = Number(process.env.RI_SECONDS ?? 240);
  const probe = new Session({ seed: 1, peds: 0, traffic: 0 });
  const spots = spotsOf(probe.district, probe.blockers, N);
  const w0 = Date.now();

  console.log(`RESPONSE ISOLATION — ${N} spots x ${SEEDS.length} seeds, stationary and braked, ` +
    `${SECONDS} s horizon`);
  console.log(`rows 2 and 3 differ in ${DIFFERING.length} of ${COLUMNS.length} columns: ` +
    DIFFERING.map((c) => `${c} ${RESPONSE[2][c]}->${RESPONSE[3][c]}`).join(', '));
  console.log(`\n  spot                 class       2* by seed              3* by seed`);
  const cases = [];
  for (const [i, spot] of spots.entries()) {
    const r2 = SEEDS.map((seed) => run({ spot, seed, stars: 2, seconds: SECONDS }));
    const r3 = SEEDS.map((seed) => run({ spot, seed, stars: 3, seconds: SECONDS }));
    SEEDS.forEach((seed, k) => cases.push({ i, spot, seed, r2: r2[k], r3: r3[k] }));
    console.log(`  ${String(i).padStart(2)} (${spot.x.toFixed(0).padStart(5)}, ` +
      `${spot.z.toFixed(0).padStart(5)})   ${spot.cls.padEnd(10)}  ` +
      `${r2.map(tag).join(' ').padEnd(22)}  ${r3.map(tag).join(' ')}`);
  }

  // The seed has to REACH the pursuit, or the seed column above is one draw printed four times.
  const firsts = new Set(cases.filter((c) => c.i === 0 && c.r2.firstUnit)
    .map((c) => `${c.r2.firstUnit.x.toFixed(3)},${c.r2.firstUnit.z.toFixed(3)}`));
  console.log(`\nfirst unit's first position at spot 0, by seed: ${firsts.size} distinct of ` +
    `${SEEDS.length}` + (firsts.size < SEEDS.length ? '   <- THE SEEDS ARE NOT ALL DIFFERENT DRAWS' : ''));

  const count = (lvl, o) => cases.filter((c) => c[lvl].outcome === o).length;
  for (const lvl of ['r2', 'r3']) {
    console.log(`${lvl === 'r2' ? '2' : '3'} stars: arrested ${count(lvl, 'arrested')}, escaped ` +
      `${count(lvl, 'escaped')}, stalemate ${count(lvl, 'stalemate')} of ${cases.length}`);
  }
  const disc = cases.filter((c) => c.r2.outcome !== 'arrested' && c.r3.outcome === 'arrested');
  const rev = cases.filter((c) => c.r2.outcome === 'arrested' && c.r3.outcome !== 'arrested');
  console.log(`3* arrests where 2* does not: ${disc.length} of ${cases.length}; the reverse: ` +
    `${rev.length}`);

  if (disc.length) {
    console.log(`\nTHE ISOLATION, on those ${disc.length} cases. "lift" is 2* with row 2's column ` +
      `set to row 3's value; "drop" is 3* with row 3's set to row 2's. A flip is the outcome changing ` +
      `to the other level's; "same" counts traces byte-identical to the unswapped run.`);
    console.log(`\n  column          lift: arrests now   same trace    drop: stops arresting   same trace`);
    const rows = [];
    // Per CASE as well as per column: an aggregate of "1 of 3" cannot say whether one column
    // decides one kind of case and another column the other kind, which is the question.
    const perCase = disc.map(() => ({ lift: [], drop: [] }));
    for (const col of DIFFERING) {
      let liftFlip = 0, liftSame = 0, dropFlip = 0, dropSame = 0;
      for (const [ci, c] of disc.entries()) {
        const lift = run({ spot: c.spot, seed: c.seed, stars: 2, seconds: SECONDS,
          table: tableWith([{ row: 2, col, value: RESPONSE[3][col] }]) });
        const drop = run({ spot: c.spot, seed: c.seed, stars: 3, seconds: SECONDS,
          table: tableWith([{ row: 3, col, value: RESPONSE[2][col] }]) });
        if (lift.outcome === 'arrested') { liftFlip++; perCase[ci].lift.push(`${col} ${tag(lift)}`); }
        if (lift.hash === c.r2.hash) liftSame++;
        if (drop.outcome !== 'arrested') { dropFlip++; perCase[ci].drop.push(`${col} ${tag(drop)}`); }
        if (drop.hash === c.r3.hash) dropSame++;
      }
      rows.push({ col, liftFlip, liftSame, dropFlip, dropSame });
      console.log(`  ${col.padEnd(14)}  ${String(liftFlip).padStart(8)} of ${disc.length}   ` +
        `${String(liftSame).padStart(6)}        ${String(dropFlip).padStart(8)} of ${disc.length}` +
        `         ${String(dropSame).padStart(6)}`);
    }

    console.log('\n  per case: 2* and 3* shipped, then what flipped it');
    for (const [ci, c] of disc.entries()) {
      console.log(`    spot ${String(c.i).padStart(2)} (${c.spot.x.toFixed(0)}, ${c.spot.z.toFixed(0)}) seed ` +
        `${c.seed}: 2* ${tag(c.r2)} (${c.r2.decays} decays), 3* ${tag(c.r3)} — lift: ` +
        `${perCase[ci].lift.join(', ') || 'nothing'}; drop: ${perCase[ci].drop.join(', ') || 'nothing'}`);
    }
    // The whole-row controls: if these do not reproduce the other level, the table is not the
    // whole difference between the levels and no single column can be the answer.
    let up = 0, upHash = 0, down = 0, downHash = 0, decayed = 0;
    for (const c of disc) {
      const a = run({ spot: c.spot, seed: c.seed, stars: 2, seconds: SECONDS,
        table: tableWith([{ row: 2, rowFrom: 3 }]) });
      const b = run({ spot: c.spot, seed: c.seed, stars: 3, seconds: SECONDS,
        table: tableWith([{ row: 3, rowFrom: 2 }]) });
      if (a.outcome === c.r3.outcome) up++;
      if (a.hash === c.r3.hash) upHash++;
      if (b.outcome === c.r2.outcome) down++;
      if (b.hash === c.r2.hash) downHash++;
      if (c.r2.decays || c.r3.decays) decayed++;
    }
    console.log(`\ncontrol, the WHOLE row swapped: 2* carrying row 3 reproduces 3*'s outcome in ` +
      `${up} of ${disc.length} (trace byte-identical in ${upHash}); 3* carrying row 2 reproduces ` +
      `2*'s in ${down} of ${disc.length} (identical in ${downHash}). ${decayed} of the cases had a ` +
      `star decay, where the next row down differs between the arms by construction.`);
    const both = rows.filter((r) => r.liftFlip === disc.length && r.dropFlip === disc.length);
    console.log(both.length
      ? `\nflips the outcome in BOTH directions on every case: ${both.map((r) => r.col).join(', ')}`
      : `\nno single column flips every case in both directions; the table above is the answer`);
  }
  console.log(`\n${((Date.now() - w0) / 1000).toFixed(0)} s wall. Harness only: the page's bridge ` +
    `honours the same columns by its own comment, and boot-check owns that wire.`);
}

// ----------------------------------------------------------------------- selftest
if (IS_MAIN && SELFTEST) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('RESPONSE-ISO SELFTEST');
  const probe = new Session({ seed: 1, peds: 0, traffic: 0 });
  const spots = spotsOf(probe.district, probe.blockers, 4);
  const spot = spots[0];
  const S = 40;

  // 1. The table helper: an edit lands where it says and nowhere else, and nothing frozen moved.
  const t = tableWith([{ row: 2, col: 'units', value: 4 }]);
  check('a column edit lands on its row', t[2].units === 4 && t[3].units === RESPONSE[3].units,
    `row 2 units ${t[2].units}, row 3 ${t[3].units}`);
  check('and leaves the shipped table alone', RESPONSE[2].units === 2, `${RESPONSE[2].units}`);
  let threw = false;
  try { tableWith([{ row: 2, col: 'unitz', value: 4 }]); } catch { threw = true; }
  check('KNOWN-BAD: a misspelt column THROWS rather than reading as an inert one', threw);
  check('rows 2 and 3 differ in more than one column, which is why the level cannot isolate',
    DIFFERING.length > 1, DIFFERING.join(', '));

  // 2. The override reaches the module, and the honoured columns reach the pursuit.
  const ship = run({ spot, seed: 1, stars: 2, seconds: S });
  const liftU = run({ spot, seed: 1, stars: 2, seconds: S,
    table: tableWith([{ row: 2, col: 'units', value: 4 }]) });
  check('the override is what tune() reads', liftU.tuneUnits === 4 && ship.tuneUnits === 2,
    `${ship.tuneUnits} -> ${liftU.tuneUnits}`);
  check('and a lifted unit count reaches the fleet the harness drives',
    ship.unitsEver === 2 && liftU.unitsEver === 4, `${ship.unitsEver} -> ${liftU.unitsEver} units`);
  const liftS = run({ spot, seed: 1, stars: 2, seconds: 2,
    table: tableWith([{ row: 2, col: 'speedMul', value: RESPONSE[3].speedMul }]) });
  check('a lifted speed multiplier reaches the pursuit speed',
    Math.abs(liftS.speed - 22 * RESPONSE[3].speedMul) < 1e-9, `${liftS.speed.toFixed(3)} m/s`);

  // 3. The identity control, with its known-bad twin: the mechanism perturbs nothing, and the hash
  //    is able to see a perturbation when there is one.
  const ident = run({ spot, seed: 1, stars: 2, seconds: S, table: tableWith([]) });
  check('an IDENTITY table leaves the trace byte-identical', ident.hash === ship.hash,
    `${ident.hash} vs ${ship.hash}`);
  check('KNOWN-BAD: a lifted unit count does NOT, so the hash can tell', liftU.hash !== ship.hash,
    `${liftU.hash} vs ${ship.hash}`);

  // 4. The whole-row control over a horizon with no decay: if this differs, `this.stars` is read
  //    for something other than `> 0` and the column table cannot be the whole story. 20 s is
  //    under row 3's 26 s cooldown, so neither arm CAN decay, and the check says so as well.
  const three = run({ spot, seed: 1, stars: 3, seconds: 20 });
  const twoAs3 = run({ spot, seed: 1, stars: 2, seconds: 20, table: tableWith([{ row: 2, rowFrom: 3 }]) });
  check('2 stars carrying row 3 entire drives the same game as 3 stars',
    twoAs3.hash === three.hash && twoAs3.decays === 0 && three.decays === 0,
    `${twoAs3.hash} vs ${three.hash}, decays ${twoAs3.decays}/${three.decays}`);

  // 5. The seeds are different draws. CLAUDE.md: a sweep whose parameter does not reach the
  //    subsystem is n=1 wearing n=16's clothes.
  const firsts = [1, 2, 3].map((seed) => run({ spot, seed, stars: 2, seconds: 5 }).firstUnit);
  const distinct = new Set(firsts.map((f) => f && `${f.x},${f.z}`)).size;
  check('three seeds put the first unit in three different places', distinct === 3 && firsts.every(Boolean),
    firsts.map((f) => f && `(${f.x.toFixed(1)}, ${f.z.toFixed(1)})`).join(' '));

  // 6. The spots are spread, and every one is clear for the car.
  let minSep = Infinity;
  for (let a = 0; a < spots.length; a++) {
    for (let b = a + 1; b < spots.length; b++) {
      minSep = Math.min(minSep, Math.hypot(spots[a].x - spots[b].x, spots[a].z - spots[b].z));
    }
  }
  check('farthest-point spots are spread out', minSep > 150, `closest pair ${minSep.toFixed(0)} m`);
  check('and every spot is clear for the body',
    spots.every((p) => !probe.blockers.resolveCircle(p.x, p.z, BODY_RADIUS)));

  console.log(`\nRESPONSE-ISO SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks` +
    `${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
