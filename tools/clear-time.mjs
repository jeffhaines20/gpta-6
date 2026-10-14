// HOW LONG IT ACTUALLY TAKES TO LOSE TWO STARS BY DRIVING, read at physics-step resolution.
//
//   node tools/clear-time.mjs               the measurement
//   node tools/clear-time.mjs --selftest    prove the instrument
//   CT_SPOTS=10 CT_SEEDS=1,2,3,4 CT_SECONDS=300   the defaults, overridable
//
// ROUND 11's NUMBER WAS AN UPPER BOUND AND ONE OF ITS READINGS WAS AN ARREST. BACKLOG #112, "What
// round 11 could not resolve": their probe drove route legs and tested `stars === 0` only at a
// leg's END, so the 95.2 s they quote is the end of whichever leg the level happened to clear in,
// and one seed's "45.8 s clear" was a BUST clearing the meter rather than an escape. Both defects
// are in the READING, not the drive:
//
//   - The level is read off the module's own `clear` event, which `src/wanted.js` emits from
//     `_applyStars` on the step the level reaches zero, WITH the reason — `escaped` for a decay to
//     zero and `busted` for an arrest. The clock is the session's own `t` inside that listener, so
//     the resolution is one physics step (1/120 s) rather than one route leg.
//   - An arrest and an escape are therefore different rows by construction, never one number. A
//     run that is busted is reported as busted at its time; the escape distribution is escapes.
//
// THE FLOOR IS ARITHMETIC AND THE MEASUREMENT HAS TO RESPECT IT. An escape from 2 stars needs a
// decay to 1 and a decay to 0, and each needs `cooldown + cool` seconds out of contact, so no
// escape can be faster than RESPONSE[2].cooldown + RESPONSE[1].cooldown = 30 s. Every escape
// below is asserted against that — an instrument reporting a 12 s escape is reading something
// that is not an escape, which is round 11's defect in its general form.
//
// THE DRIVER is src/roadpath.js's own follower on the shipped vehicle, the one `driveTo` uses, so
// the drive is the game's and not a paraphrase. Two policies, because "how long to lose them"
// depends on where you drive:
//   far     each leg to a random road point 350-700 m away          a player going somewhere
//   away    each leg to the road point 350-700 m away that points   a player fleeing
//           most directly AWAY from the nearest police car
// Both re-plan at every arrival and on a wedge, so the car never stops on purpose.
//
// TWO WORLDS. `bare` has no traffic and no crowd, so the only thing on the road is the pursuit
// and nothing can file a crime that raises the level mid-run. `shipped` has both, and counts the
// crimes a drive files, because a ram or a strike while fleeing raises the level and resets the
// clock — which is part of what "real" means, and the column says how often it happened.
//
// WHAT THE FOLLOWER IS: a floor on a human's PACE and not on their judgement. It caps at 22 m/s
// (79 km/h) where the car does 140, and it does not look at the police. A human who reads the
// minimap does better on `away` and a human who panics does worse on everything; this measures
// the rule, not the player.
import { RESPONSE } from '../src/wanted.js';
// RUN_SPEED from the player, not ARREST_PACE_MS from wanted.js: the "before" arm of the speed-
// arrest fix runs this same file against a tree that has no ARREST_PACE_MS, and a named import
// that does not exist is a SyntaxError rather than an undefined.
import { RUN_SPEED } from '../src/player.js';
import { followPath, ROUTE_LANE_M } from '../src/roadpath.js';
import { Session } from './playtest.mjs';
import { roadPoints, spotsOf } from './response-iso.mjs';

const SELFTEST = process.argv.includes('--selftest');
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
const DT = 1 / 120, STEP = DT * 8;

/** The fastest any escape from `stars` can be: one full cooldown per star, out of contact. */
export function escapeFloor(stars, table = RESPONSE) {
  let s = 0;
  for (let k = stars; k >= 1; k--) s += table[k].cooldown;
  return s;
}

/** Small, seedable, and not the session's: the destination draw must not perturb the game's. */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One chase. Starts at `stars` with no crime and no scene — `ambush`'s own `onEnter: { setWanted:
 * 2 }`, the case round 11 measured — and drives until the level clears or the horizon.
 */
export function chase({ spot, seed, policy = 'far', world = 'bare', stars = 2, seconds = 300,
  maxSpeed = 22, points }) {
  const s = new Session(world === 'bare' ? { seed, peds: 0, traffic: 0 } : { seed });
  // FACING THE WAY THERE IS CITY. A spot's yaw is just its edge's first-to-second vertex, so at the
  // district's edge it can point out of town, where nothing lies ahead and the first leg has to be
  // a U-turn under the police's noses. Of the road's two directions, the one with more of the
  // destination ring ahead of it — the respawn's own `clearerHeading` idea, applied to the route.
  const aheadCount = (yaw) => {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let n = 0;
    for (const c of points) {
      const dx = c.x - spot.x, dz = c.z - spot.z, d = Math.hypot(dx, dz);
      if (d >= 350 && d <= 700 && (dx * fx + dz * fz) / d > Math.cos(Math.PI / 3)) n++;
    }
    return n;
  };
  const yaw0 = aheadCount(spot.yaw) >= aheadCount(spot.yaw + Math.PI) ? spot.yaw : spot.yaw + Math.PI;
  s.placeAt(spot.x, spot.z, yaw0);
  s.wanted.setStars(stars, 'clear-time');
  const ev = { clearAt: null, reason: null, decays: [], escalations: 0, pollAt: null,
    crimeTypes: {}, bustSpeed: null, firstDest: null };
  s.wanted.on('clear', (e) => {
    if (ev.clearAt === null) { ev.clearAt = s.t; ev.reason = e.reason; }
  });
  // WHICH crimes, not how many: a bare world still has walls and police cars in it, and ramming a
  // unit files `policeProperty`, which raises the level. The first selftest asserted "no crimes"
  // there and was wrong about the world, not about the drive.
  s.wanted.on('crime', (p) => {
    if (p.applied) ev.crimeTypes[p.id] = (ev.crimeTypes[p.id] ?? 0) + 1;
  });
  // HOW FAST THE PLAYER WAS GOING WHEN ARRESTED. An arrest is an officer on foot reaching the
  // car, so one made above the officer's running pace is not an arrest anybody could make — see
  // the station-keeping defect this probe found on its first real drive.
  s.wanted.on('busted', () => {
    if (ev.bustSpeed === null) ev.bustSpeed = Math.hypot(s.vehicle.velocity.x, s.vehicle.velocity.z);
  });
  s.wanted.on('stars', (e) => {
    if (e.reason === 'decay') ev.decays.push(s.t);
    else if (e.stars > e.prev) ev.escalations++;
  });
  const rng = mulberry32((seed * 2654435761) ^ Math.round(spot.x * 7 + spot.z * 13));
  const t0 = s.t;
  let path = null, state = null, legs = 0, wedges = 0, respawns = s.stats.respawns;
  const crimes0 = s.stats.crimes;
  // Half a second braked first, so the units exist before the first leg is chosen: `away` reads
  // their positions, and before the pursuit's first update there are none, which would make its
  // first leg the same random draw as `far`'s and the two policies one drive. Counted in the time.
  s.drive({ throttle: 0, brake: 1 }).step(0.5);
  // Where the first unit is NOW, for the seed check. Read at the END it was always null — a clear
  // releases every unit — so four seeds read as one draw: a check that cannot tell a broken seed
  // from a finished chase, which printed "NOT ALL DIFFERENT DRAWS" over seeds that were.
  const u0 = s._unitPositions();
  const firstUnit = u0.length ? { x: u0[0].x, z: u0[0].z } : null;

  /**
   * AHEAD OF THE CAR, OR THE FIRST LEG IS A U-TURN. The first version drew from the whole ring, so
   * a car placed facing one way was routed the other: the follower reversed at full lock, then
   * crawled round at 2.5 m/s for ten seconds, and the police arrested it mid-turn — the selftest
   * caught it as "46 m driven in 17.6 s" and as two policies driving the identical 99.5 m. A
   * player told to lose the police drives ON. So the draw is from the points within 60 degrees of
   * the nose, and only falls back to the whole ring when there are none.
   */
  const pick = () => {
    const p = s.vehicle.position;
    const ringAll = points.filter((c) => {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      return d >= 350 && d <= 700;
    });
    const yaw = s._yaw(), fx = Math.sin(yaw), fz = Math.cos(yaw);
    const ahead = ringAll.filter((c) => {
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz) || 1;
      return (dx * fx + dz * fz) / d > Math.cos(Math.PI / 3);
    });
    const ring = ahead.length ? ahead : ringAll;
    if (!ring.length) return null;
    if (policy === 'away') {
      const units = s._unitPositions();
      if (units.length) {
        let near = units[0], nd = Infinity;
        for (const u of units) {
          const d = Math.hypot(u.x - p.x, u.z - p.z);
          if (d < nd) { nd = d; near = u; }
        }
        const ax = p.x - near.x, az = p.z - near.z, al = Math.hypot(ax, az) || 1;
        let best = ring[0], bestDot = -Infinity;
        for (const c of ring) {
          const dx = c.x - p.x, dz = c.z - p.z, dl = Math.hypot(dx, dz) || 1;
          const dot = (dx * ax + dz * az) / (dl * al);
          if (dot > bestDot) { bestDot = dot; best = c; }
        }
        return best;
      }
    }
    return ring[Math.floor(rng() * ring.length)];
  };

  while (s.t - t0 < seconds && ev.clearAt === null) {
    // A wreck's respawn moves the car out from under its path: start a fresh leg from where it is.
    if (s.stats.respawns !== respawns) { respawns = s.stats.respawns; path = null; }
    if (!path) {
      const dst = pick();
      const from = s.vehicle.position;
      const pp = dst && s.roads.path(from.x, from.z, dst.x, dst.z,
        { spacing: 4, offset: ROUTE_LANE_M, smoothPasses: 2 });
      if (!pp || !pp.points || pp.points.length < 2) {
        // Nowhere routable from here this step: hold still for one control step and re-draw.
        s.drive({ throttle: 0, brake: 1 }).step(STEP);
        continue;
      }
      path = pp; state = { i: 0 }; legs++;
      if (!ev.firstDest) ev.firstDest = { x: dst.x, z: dst.z };
    }
    const v = s.vehicle;
    const f = followPath(path.points, { x: v.position.x, z: v.position.z, yaw: s._yaw(),
      speed: v.speed }, state, { maxSpeed, dt: STEP });
    if (f.done) { path = null; continue; }
    if (f.wedged) { wedges++; path = null; }
    s.drive(f.controls).step(STEP);
  }
  // A SECOND READING of the same quantity by a different route — the level polled after the run,
  // which must agree with the event about WHETHER it cleared (it cannot say when).
  const clearedByPoll = s.wanted.stars === 0;
  return {
    outcome: ev.clearAt === null ? 'unresolved' : ev.reason === 'escaped' ? 'escaped'
      : ev.reason === 'busted' ? 'arrested' : `other:${ev.reason}`,
    t: ev.clearAt === null ? null : ev.clearAt - t0,
    firstDecay: ev.decays.length ? ev.decays[0] - t0 : null,
    decays: ev.decays.length, escalations: ev.escalations, crimes: s.stats.crimes - crimes0,
    crimeTypes: ev.crimeTypes, bustSpeed: ev.bustSpeed, firstDest: ev.firstDest,
    legs, wedges, wrecks: s.stats.wrecks, busts: s.stats.busts, reacquires: s.wanted.stats.reacquires,
    metres: s.stats.distance, clearedByPoll, eventCleared: ev.clearAt !== null,
    firstUnit,
  };
}

const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const fmt = (v) => v === null ? '   -' : v.toFixed(1).padStart(5);

// ----------------------------------------------------------------------- the measurement
if (IS_MAIN && !SELFTEST) {
  const N = Number(process.env.CT_SPOTS ?? 10);
  const SEEDS = (process.env.CT_SEEDS ?? '1,2,3,4').split(',').map(Number);
  const SECONDS = Number(process.env.CT_SECONDS ?? 300);
  const probe = new Session({ seed: 1, peds: 0, traffic: 0 });
  const points = roadPoints(probe.district, probe.blockers);
  const spots = spotsOf(probe.district, probe.blockers, N);
  const floor = escapeFloor(2);
  const w0 = Date.now();
  console.log(`CLEAR TIME — 2 stars set with no scene (ambush's onEnter), the follower at 22 m/s, ` +
    `${N} spots x ${SEEDS.length} seeds, ${SECONDS} s horizon`);
  console.log(`the floor: an escape from 2 stars needs ${RESPONSE[2].cooldown} + ` +
    `${RESPONSE[1].cooldown} = ${floor} s out of contact, so no escape below can be faster`);
  let floorBroken = 0, disagree = 0;
  const all = [];
  for (const world of ['bare', 'shipped']) {
    for (const policy of ['far', 'away']) {
      const rows = [];
      for (const spot of spots) {
        for (const seed of SEEDS) {
          const r = chase({ spot, seed, policy, world, seconds: SECONDS, points });
          rows.push(r);
          if (r.outcome === 'escaped' && r.t < floor - 1e-6) floorBroken++;
          if (r.clearedByPoll !== r.eventCleared && r.outcome !== 'arrested') disagree++;
        }
      }
      all.push({ world, policy, rows });
      const esc = rows.filter((r) => r.outcome === 'escaped').map((r) => r.t);
      const arr = rows.filter((r) => r.outcome === 'arrested').map((r) => r.t);
      const unr = rows.filter((r) => r.outcome === 'unresolved').length;
      const dec1 = rows.filter((r) => r.firstDecay !== null).map((r) => r.firstDecay);
      console.log(`\n  ${world.padEnd(8)} ${policy.padEnd(5)}  escaped ${String(esc.length).padStart(2)}/` +
        `${rows.length}   p10 ${fmt(q(esc, 0.1))}  p50 ${fmt(q(esc, 0.5))}  p90 ${fmt(q(esc, 0.9))}  ` +
        `max ${fmt(q(esc, 1))} s`);
      console.log(`                  arrested ${String(arr.length).padStart(2)}  at p50 ${fmt(q(arr, 0.5))} s` +
        `   unresolved at ${SECONDS} s: ${unr}   first star shed p50 ${fmt(q(dec1, 0.5))} s`);
      // ARRESTS NO OFFICER COULD MAKE: the car moving faster than a person runs at the moment the
      // clock fired. Every one of these is the station-keeping defect ARREST_PACE_MS ends.
      const bs = rows.filter((r) => r.outcome === 'arrested' && r.bustSpeed !== null)
        .map((r) => r.bustSpeed);
      const fast = bs.filter((v) => v >= RUN_SPEED).length;
      console.log(`                  arrested at speed: ${fast} of ${bs.length} above the officer's ` +
        `${(RUN_SPEED * 3.6).toFixed(1)} km/h running pace; car speed at the arrest p50 ` +
        `${bs.length ? (q(bs, 0.5) * 3.6).toFixed(0) : '-'} km/h, max ` +
        `${bs.length ? (q(bs, 1) * 3.6).toFixed(0) : '-'} km/h`);
      const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
      console.log(`                  per run: crimes ${(sum('crimes') / rows.length).toFixed(2)}, ` +
        `escalations ${(sum('escalations') / rows.length).toFixed(2)}, wrecks ` +
        `${(sum('wrecks') / rows.length).toFixed(2)}, wedges ${(sum('wedges') / rows.length).toFixed(2)}, ` +
        `reacquired ${(sum('reacquires') / rows.length).toFixed(1)} times, ` +
        `${(sum('metres') / rows.length).toFixed(0)} m`);
    }
  }
  const firsts = new Set(all[0].rows.slice(0, SEEDS.length)
    .map((r) => r.firstUnit && `${r.firstUnit.x.toFixed(2)},${r.firstUnit.z.toFixed(2)}`));
  console.log(`\nseeds reaching the pursuit: ${firsts.size} distinct final unit positions over ` +
    `${SEEDS.length} seeds at spot 0` + (firsts.size < SEEDS.length ? '   <- NOT ALL DIFFERENT DRAWS' : ''));
  console.log(`escapes faster than the ${floor} s floor: ${floorBroken}` +
    (floorBroken ? '   <- THE INSTRUMENT IS COUNTING SOMETHING THAT IS NOT AN ESCAPE' : ''));
  console.log(`runs where the event and a poll disagree about whether the level cleared: ${disagree}`);
  console.log(`\n${((Date.now() - w0) / 1000).toFixed(0)} s wall`);
  if (floorBroken || disagree) process.exit(1);
}

// ----------------------------------------------------------------------- selftest
if (IS_MAIN && SELFTEST) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('CLEAR-TIME SELFTEST');
  const probe = new Session({ seed: 1, peds: 0, traffic: 0 });
  const points = roadPoints(probe.district, probe.blockers);
  const spots = spotsOf(probe.district, probe.blockers, 6);

  // 1. The floor is the table's, and it moves with the table.
  check('the 2-star escape floor is the sum of the two cooldowns', escapeFloor(2) ===
    RESPONSE[2].cooldown + RESPONSE[1].cooldown, `${escapeFloor(2)} s`);
  const t2 = RESPONSE.map((r) => ({ ...r }));
  t2[1].cooldown = 1;
  check('KNOWN-BAD: and it is computed from the table it is given, not a remembered 30',
    escapeFloor(2, t2) === RESPONSE[2].cooldown + 1, `${escapeFloor(2, t2)} s`);

  // 2. An ARREST is not an escape. Parked on the road at 2 stars the police arrest a stationary
  //    player at 17-19 of 20 spots (round 11's own sweep), so a parked run is the known-bad that
  //    round 11's "45.8 s clear" was: the meter goes to zero, and it must read as `busted`.
  let parked = null;
  for (const spot of spots) {
    const s = new Session({ seed: 1, peds: 0, traffic: 0 });
    s.placeAt(spot.x, spot.z, spot.yaw);
    s.wanted.setStars(2, 'selftest');
    let reason = null, at = null;
    s.wanted.on('clear', (e) => { if (reason === null) { reason = e.reason; at = s.t; } });
    for (let k = 0; k < 120 && reason === null; k++) s.drive({ throttle: 0, brake: 1 }).step(1);
    if (reason) { parked = { reason, at, busts: s.stats.busts }; break; }
  }
  check('a parked run that clears the meter clears it as an ARREST, which is round 11\'s 45.8 s',
    parked && parked.reason === 'busted' && parked.busts === 1,
    parked ? `reason "${parked.reason}" at ${parked.at.toFixed(1)} s, busts ${parked.busts}` : 'none cleared');

  // 3. A real drive: it moves, it re-plans, and in the bare world nothing files a crime.
  const r = chase({ spot: spots[1], seed: 2, policy: 'far', world: 'bare', seconds: 90, points });
  check('the follower actually drives', r.metres > 300 && r.legs >= 1,
    `${r.metres.toFixed(0)} m over ${r.legs} legs`);
  const kinds = Object.keys(r.crimeTypes);
  check('the bare world files only crimes against walls and the police — no person, no civilian car',
    kinds.every((k) => k === 'propertyDamage' || k === 'policeProperty'),
    JSON.stringify(r.crimeTypes));
  check('an escape, if it happened, respects the floor',
    r.outcome !== 'escaped' || r.t >= escapeFloor(2), `${r.outcome} at ${r.t}`);
  check('the event and a poll agree about whether the level cleared',
    r.outcome === 'arrested' || r.clearedByPoll === r.eventCleared,
    `event ${r.eventCleared}, poll ${r.clearedByPoll}`);

  // 4. The policies choose different destinations from the same start, so the second column is
  //    not the first printed twice. Compared on the DESTINATION, not on distance driven: two runs
  //    arrested at the same second drive the same metres whatever they were aiming at, which is
  //    what the first version of this check measured.
  const a = chase({ spot: spots[2], seed: 3, policy: 'far', world: 'bare', seconds: 30, points });
  const b = chase({ spot: spots[2], seed: 3, policy: 'away', world: 'bare', seconds: 30, points });
  const fd = (x) => x.firstDest ? `(${x.firstDest.x.toFixed(0)}, ${x.firstDest.z.toFixed(0)})` : 'none';
  check('`far` and `away` aim at different places from the same start',
    !!a.firstDest && !!b.firstDest && (a.firstDest.x !== b.firstDest.x || a.firstDest.z !== b.firstDest.z),
    `${fd(a)} against ${fd(b)}`);

  // 5. The seeds reach the pursuit, read where a unit EXISTS. The report's first version read the
  //    unit at the end of each chase, after the clear had released every unit, and printed "NOT
  //    ALL DIFFERENT DRAWS" over four seeds that were — CLAUDE.md's too-consistent column,
  //    produced by the instrument rather than by the seed.
  const firsts = [1, 2, 3, 4].map((seed) => chase({ spot: spots[0], seed, policy: 'far',
    world: 'bare', seconds: 5, points }).firstUnit);
  const distinct = new Set(firsts.map((f) => f && `${f.x},${f.z}`)).size;
  check('four seeds put the first unit in four different places', firsts.every(Boolean) && distinct === 4,
    firsts.map((f) => f ? `(${f.x.toFixed(0)}, ${f.z.toFixed(0)})` : 'none').join(' '));

  console.log(`\nCLEAR-TIME SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks` +
    `${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
