// IS CANCELLING A JOB BY WRECKING THE CAR PENALISED WHEN YOU DO IT AGAIN?
//
//   node tools/wreck-cancel.mjs               take a job, wreck out of it, come back, four times
//   node tools/wreck-cancel.mjs --selftest    prove the instrument
//   WC_SEEDS=1,2,3 WC_ATTEMPTS=4                the defaults, overridable
//
// ROUND 11 ASKED AND COULD NOT ANSWER, because its arm failed its own assertion: "wrecks stayed at
// 1 across attempts 2-4 — so it measured nothing, and the page's LOOP_R/LOOP_S loop-breaker went
// unexercised" (BACKLOG #112). So the first thing this tool owns is the WRECK: every attempt is
// asserted to add exactly one to `stats.wrecks`, and an attempt that cannot wreck the car says so
// and stops rather than reporting attempts that did not happen.
//
// THE LOOP, as a player would run it. Stop on the pickup, so the job starts; drive full throttle
// into the nearest building with a run-up; sit through the four-second hold and the respawn; drive
// back to the pickup, leaving its ring first if the respawn landed inside it (the board LATCHES a
// marker when its job ends and re-arms it only once the player is outside the radius — see
// MissionBoard.latched); stop; the job starts again. Four times.
//
// WHAT COULD MAKE A REPEAT COST MORE THAN THE FIRST, each read off the module that owns it:
//   - HEAT. Each wreck files `propertyDamage`, which the soft knee holds under one star on its
//     own. Two inside the idle bleed's reach are a star (CLAUDE.md, #97's ladder), so a fast
//     enough loop could make the player wanted. Read as heat and stars after every wreck.
//   - THE LOOP-BREAKER. district/main.js and the harness both send a respawn to the district's
//     own spawn when its candidate lands within LOOP_R = 60 m of one of the last three respawns,
//     inside LOOP_S = 45 s. It was written for a car that wrecks ITSELF on respawn under held
//     throttle; a player wrecking on purpose near one pickup is the same sequence, so it should
//     fire, and when it does the player is put back at the spawn — read as `loopsBroken` and as
//     the respawn's distance from the pickup.
//   - ARRESTS, if the level gets that far: `stats.busts` across the loop.
//
// The world is BARE — no traffic and no crowd — so every crime in the table is the loop's own.
import { MISSIONS } from '../src/missions.js';
import { OUTCOMES } from '../src/mission.js';
import { BODY_RADIUS } from '../src/vehicle.js';
import { Session, driveTo } from './playtest.mjs';

const SELFTEST = process.argv.includes('--selftest');
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
const DT = 1 / 120, STEP = DT * 8;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Signed bearing from the car's nose to (x, z), in `look()`'s convention, so `steer = -bearing`
 * converges: tools/playtest.mjs measured the other sign diverging, 30 m to 214 m.
 */
function bearingTo(s, x, z) {
  const p = s.vehicle.position, yaw = s._yaw();
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1;
  return Math.atan2(fx * (dz / d) - fz * (dx / d), (dx * fx + dz * fz) / d);
}

/**
 * The wall to drive into: the nearest blocked point along any heading within `span` of the nose,
 * at least `runUp` metres away so full throttle reaches a wrecking speed (round 11's own wreck was
 * one impact at 15.9 m/s from 23 m). Marched at 0.5 m, against the same body radius the collision
 * pass uses.
 */
export function pickWall(s, { runUp = 20, reach = 90, span = Math.PI }) {
  const p = s.vehicle.position, yaw = s._yaw();
  let best = null;
  for (let a = -span; a <= span + 1e-9; a += Math.PI / 60) {
    const h = yaw + a, sx = Math.sin(h), sz = Math.cos(h);
    for (let d = 2; d <= reach; d += 0.5) {
      if (s.blockers.resolveCircle(p.x + sx * d, p.z + sz * d, BODY_RADIUS)) {
        // Score by distance, with a mild preference for what is already ahead: a wall behind
        // costs a turn, which is time a player would not spend.
        if (d >= runUp) {
          const score = d + 15 * Math.abs(a);
          if (!best || score < best.score) best = { x: p.x + sx * d, z: p.z + sz * d, d, a, score };
        }
        break;
      }
    }
  }
  return best;
}

/**
 * Drive into the wall until the car is wrecked. Rams again after a non-wrecking contact by
 * reversing and re-picking, as a player would. Returns how long it took and whether it worked.
 */
export function wreck(s, { maxS = 60 } = {}) {
  const w0 = s.stats.wrecks, t0 = s.t;
  let wall = pickWall(s, { span: Math.PI / 2.5 }) ?? pickWall(s, {});
  let slow = 0, rams = 0;
  while (s.t - t0 < maxS && s.stats.wrecks === w0) {
    if (!wall) return { ok: false, why: 'no wall within reach', seconds: s.t - t0, rams };
    const steer = clamp(-2 * bearingTo(s, wall.x, wall.z), -1, 1);
    s.drive({ throttle: 1, steer }).step(STEP);
    slow = s.vehicle.speed < 0.6 ? slow + STEP : 0;
    if (slow > 1.0 && s.stats.wrecks === w0) {
      // Pinned without being wrecked: back off and go again.
      rams++;
      for (let k = 0; k < 12; k++) s.drive({ throttle: -1, steer: 0 }).step(STEP);
      wall = pickWall(s, { span: Math.PI / 2.5 }) ?? pickWall(s, {});
      slow = 0;
    }
  }
  return { ok: s.stats.wrecks === w0 + 1, why: s.stats.wrecks === w0 ? 'timeout' : null,
    seconds: s.t - t0, rams, wrecks: s.stats.wrecks - w0 };
}

/** Sit through the hold until the replacement arrives. */
function awaitRespawn(s, maxS = 8) {
  const r0 = s.stats.respawns, t0 = s.t;
  while (s.stats.respawns === r0 && s.t - t0 < maxS) s.drive({ throttle: 0, brake: 1 }).step(STEP);
  return s.stats.respawns > r0;
}

/**
 * Back onto the pickup and stopped, so the board starts the job again. If the marker is latched
 * — the job just ended while the player was inside its ring, or the respawn landed inside it —
 * the player has to leave the ring first, so the drive goes out to a road point past the radius
 * and back.
 */
function retake(s, m, { maxS = 240 } = {}) {
  const t0 = s.t, starts0 = s.board.starts;
  const r = s.board.radiusOf(m);
  if (s.board.latched.has(m.id)) {
    const p = s.vehicle.position;
    const out = s.roads.nearestOn(m.start.x + (p.x - m.start.x) * 3 + 0.1,
      m.start.z + (p.z - m.start.z) * 3 + 0.1);
    const dest = out && Math.hypot(out.x - m.start.x, out.z - m.start.z) > r + 5
      ? out : { x: m.start.x + r + 25, z: m.start.z };
    driveTo(s, dest.x, dest.z, { maxSpeed: 12, timeout: 60 });
    // Make sure the ring is left: refresh() re-arms the marker only from outside it.
    for (let k = 0; k < 60 && s.board.latched.has(m.id); k++) s.drive({ throttle: 0.4 }).step(STEP);
  }
  driveTo(s, m.start.x, m.start.z, { maxSpeed: 12, timeout: Math.max(5, maxS - (s.t - t0)) });
  for (let k = 0; k < 90 && s.board.starts === starts0; k++) s.drive({ throttle: 0, brake: 1 }).step(STEP);
  return { ok: s.board.starts > starts0, seconds: s.t - t0 };
}

/** The whole loop for one job and one seed. */
export function loop({ id, seed, attempts = 4 }) {
  const m = MISSIONS[id];
  const s = new Session({ seed, peds: 0, traffic: 0 });
  s.placeAt(m.start.x, m.start.z, 0);
  for (let k = 0; k < 120 && !s.mission.hud(); k++) s.drive({ throttle: 0, brake: 1 }).step(STEP);
  if (!s.mission.hud()) throw new Error(`${id}: parked on the pickup and the job never started`);
  const rows = [];
  for (let a = 1; a <= attempts; a++) {
    const busts0 = s.stats.busts, loops0 = s.stats.loopsBroken, t0 = s.t;
    const w = wreck(s);
    const after = { heat: s.wanted.heat, stars: s.wanted.stars, outcome: s.mission.outcome };
    if (!w.ok) { rows.push({ a, failed: w.why, wreckS: w.seconds }); break; }
    const respawned = awaitRespawn(s);
    const at = { x: s.vehicle.position.x, z: s.vehicle.position.z };
    const back = respawned ? retake(s, m) : { ok: false, seconds: 0 };
    rows.push({
      a, wreckS: w.seconds, rams: w.rams, heat: after.heat, stars: after.stars,
      aborted: after.outcome === OUTCOMES.ABORTED, loopBroken: s.stats.loopsBroken - loops0,
      respawnFromPickup: Math.hypot(at.x - m.start.x, at.z - m.start.z),
      returnS: back.seconds, retaken: back.ok, starsAtRetake: s.wanted.stars,
      busts: s.stats.busts - busts0, cycleS: s.t - t0,
    });
    if (!back.ok) break;
  }
  return { id, seed, rows, wrecks: s.stats.wrecks, respawns: s.stats.respawns };
}

// ----------------------------------------------------------------------- the measurement
if (IS_MAIN && !SELFTEST) {
  const SEEDS = (process.env.WC_SEEDS ?? '1,2,3').split(',').map(Number);
  const ATTEMPTS = Number(process.env.WC_ATTEMPTS ?? 4);
  const w0 = Date.now();
  console.log(`WRECK-CANCEL — take a job, wreck out of it, retake it; ${ATTEMPTS} attempts, ` +
    `seeds ${SEEDS.join(',')}, bare world`);
  let unwrecked = 0;
  for (const id of Object.keys(MISSIONS)) {
    for (const seed of SEEDS) {
      const r = loop({ id, seed, attempts: ATTEMPTS });
      console.log(`\n  ${id}  seed ${seed}   wrecks ${r.wrecks}, respawns ${r.respawns}`);
      console.log(`    try   wreck s  rams   heat  stars  aborted  loop-broken  respawn->pickup  ` +
        `back s  retaken  busts   cycle s`);
      for (const x of r.rows) {
        if (x.failed) { unwrecked++; console.log(`    ${x.a}     COULD NOT WRECK: ${x.failed}`); continue; }
        console.log(`    ${x.a}   ${x.wreckS.toFixed(1).padStart(7)}  ${String(x.rams).padStart(4)}  ` +
          `${x.heat.toFixed(3).padStart(5)}  ${String(x.stars).padStart(5)}  ${String(x.aborted).padStart(7)}  ` +
          `${String(x.loopBroken).padStart(11)}  ${x.respawnFromPickup.toFixed(0).padStart(13)} m  ` +
          `${x.returnS.toFixed(1).padStart(6)}  ${String(x.retaken).padStart(7)}  ${String(x.busts).padStart(5)}  ` +
          `${x.cycleS.toFixed(1).padStart(8)}`);
      }
    }
  }
  console.log(`\nattempts that could not wreck the car: ${unwrecked}` +
    (unwrecked ? '   <- those rows measured nothing, which is round 11\'s failure' : ''));
  console.log(`${((Date.now() - w0) / 1000).toFixed(0)} s wall`);
}

// ----------------------------------------------------------------------- selftest
if (IS_MAIN && SELFTEST) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('WRECK-CANCEL SELFTEST');
  const id = Object.keys(MISSIONS)[0], m = MISSIONS[id];

  // 1. The wreck is real: one attempt, exactly one more wreck, and the job ends with it.
  const s = new Session({ seed: 1, peds: 0, traffic: 0 });
  s.placeAt(m.start.x, m.start.z, 0);
  for (let k = 0; k < 120 && !s.mission.hud(); k++) s.drive({ throttle: 0, brake: 1 }).step(STEP);
  check('parked on the pickup, the job starts', !!s.mission.hud(), `starts ${s.board.starts}`);
  const w = wreck(s);
  check('one attempt wrecks the car exactly once — the assertion round 11\'s arm failed',
    w.ok && w.wrecks === 1, `${w.wrecks} wrecks in ${w.seconds.toFixed(1)} s, ${w.rams} re-rams`);
  check('and the wreck ends the job', s.mission.outcome === OUTCOMES.ABORTED, s.mission.outcome);

  // KNOWN-BAD: holding still does not wreck anything, so the check above can fail.
  const idle = new Session({ seed: 1, peds: 0, traffic: 0 });
  idle.placeAt(m.start.x, m.start.z, 0);
  idle.drive({ throttle: 0, brake: 1 }).step(10);
  check('KNOWN-BAD: ten seconds parked is no wreck', idle.stats.wrecks === 0, `${idle.stats.wrecks}`);

  // 2. The loop-breaker, BOTH halves of its rule. boot-check owns the page's copy and asks only
  //    the distance half (two respawns back to back); the TIME half — LOOP_S — is asked here.
  const lb = new Session({ seed: 1, peds: 0, traffic: 0 });
  lb.placeAt(518, 77, 0); lb.respawn();
  lb.placeAt(518, 77, 0); lb.respawn();
  check('two respawns from one place inside LOOP_S trip the breaker', lb.stats.loopsBroken === 1,
    `${lb.stats.loopsBroken}`);
  const lt = new Session({ seed: 1, peds: 0, traffic: 0 });
  lt.placeAt(518, 77, 0); lt.respawn();
  lt.drive({ throttle: 0, brake: 1 }).step(46);
  lt.placeAt(518, 77, 0); lt.respawn();
  check('KNOWN-BAD: the same pair 46 s apart, past LOOP_S, does not', lt.stats.loopsBroken === 0,
    `${lt.stats.loopsBroken}`);

  // 3. A whole loop runs every attempt it was asked for, each one a real wreck.
  const r = loop({ id, seed: 2, attempts: 2 });
  check('a two-attempt loop wrecks twice and retakes the job twice',
    r.rows.length === 2 && r.rows.every((x) => !x.failed && x.retaken) && r.wrecks === 2,
    r.rows.map((x) => x.failed ?? `wreck ${x.wreckS.toFixed(1)} s, back ${x.returnS.toFixed(1)} s`).join(' | '));

  console.log(`\nWRECK-CANCEL SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks` +
    `${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
