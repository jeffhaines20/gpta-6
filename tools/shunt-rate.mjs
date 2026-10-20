#!/usr/bin/env node
/**
 * tools/shunt-rate.mjs — what a "contact rate" against the fleet actually measures.
 *
 * WRITTEN FOR #87, WHOSE HEADLINE NUMBER WAS A FRAME COUNT. The entry reported the contact
 * rate as NON-MONOTONIC in the player's speed — "19 shunts at 22 km/h against 0 at 36" — and
 * guessed the mechanism: "the fleet's own median flow is about 36 km/h, so a car crawling at
 * 22 is overtaken from behind". Both halves are wrong, and the three arms here are what says
 * so. Reproduced first, over 5 seeds at each of 8 speeds, 350 m to marlin-street's pickup:
 *
 *     km/h   FRAMES   distinct CARS   frames/car   worst dv   health
 *       22       35               3        11.67      3.721    0.945
 *       29        7               1         7.00      4.783    0.972
 *       36        0               0            -      0.000    0.993
 *       38        0               0            -      0.000    0.994
 *       40       61               2        30.50      6.190    0.641
 *       43       56               2        28.00      6.756    0.713
 *       50       50               1        50.00      7.021    0.763
 *       61       49               2        24.50      9.191    0.395
 *
 * THE COLUMN THE ENTRY QUOTED IS THE FIRST ONE AND THE EVENTS ARE IN THE SECOND. 258 frames
 * over 11 distinct cars, 23.5 frames each, worst 50 frames on ONE car. "19 against 0" is one
 * to three CARS against none, so the entry's magnitude is out by a factor of 23.
 *
 * RESTATED BY #127, AND IT RETIRES EVERY TABLE BELOW THIS ONE. All of them were driven on the
 * driver's LEFT: `offsetRight` put the route lane there, so the follower drove `ROUTE_LANE_M`
 * into the ONCOMING stream. "The car is AHEAD, and it is STOPPED, 258 of 258" was an oncoming
 * car that had stopped for a player in its lane, with the follower grinding into it head-on —
 * not a rammed car held by its own shunt rule. The same arms on the right side of the road:
 *
 *     ARM A  5 seeds x 9 speeds, 22-72 km/h    1 car and 2 frames in 45 drives, at 43 km/h:
 *                                              a car doing 2.89 m/s, rear-ended at 12.02
 *     ARM B  no fleet                          unchanged, 0 wall contacts at every speed
 *     ARM C  3 seeds x 6 speeds x 3 fleets     1 car at x0.6 / 61 km/h, 1 at x1.0 / 43, 0 at x1.5
 *
 * So the contact rate #87 was filed about is a wrong-side artifact as well as a frame count: on
 * the right side there is no rate to be monotonic or otherwise. What survives below is the
 * instrument — two counters, the seed reaching the fleet, a position taken from where the module
 * publishes it — and the frame/car ratio, which is ~2 for a brief rear-end where it was 23.5 for
 * a head-on grind. The selftest asserts the right-side shape.
 *
 * AND THE SHAPE IS NOT REAL EITHER, WHICH TOOK THREE READINGS OF ONE TABLE:
 *
 *     1. five seeds,    events 3,1,0,0,2,2,1,2      "not a signal"         right, badly argued
 *     2. sixteen seeds, 16/16 against 0/16          "real, deterministic"  WRONG
 *     3. the seed wired to the fleet, 16 FLEETS     6,5,5,6,1,4            flat
 *
 *     km/h   cars per seed, 16 DIFFERENT fleets        cars   drives with a contact
 *       22   1 0 0 0 1 1 0 0 0 0 1 0 0 0 0 2             6          5/16
 *       29   0 0 0 1 1 0 0 0 1 0 0 0 0 0 0 2             5          4/16
 *       36   0 0 1 0 1 0 1 0 1 0 0 0 0 0 0 1             5          5/16
 *       40   0 0 1 1 1 0 1 0 0 1 1 0 0 0 0 0             6          6/16
 *       43   0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0             1          1/16
 *       50   0 1 0 0 0 0 0 0 1 1 1 0 0 0 0 0             4          4/16
 *
 * `Session` never passed its seed to `Traffic` — see the note on that line in tools/playtest.mjs
 * — so steps 1 and 2 were replicates of ONE fleet. 6,5,5,6,1,4 is flat, the 36 km/h zero was one
 * layout, and the 43 km/h cell the entry called hot is the quietest in the table.
 *
 * **Step 2 looked decisive because of the defect.** 16/16 against 0/16 is not a stochastic
 * reading; it is one world repeated, so the near-determinism that convinced me is what should
 * have condemned it. **A cross-seed column that is too consistent is evidence the seed is not
 * reaching what you varied** — and that tell fired twice here before I read it, the other time as
 * a first-contact victim speed of 8.091 m/s in six of six seeds, identical to three decimals.
 *
 * So this file's `router-lever` rule needs a clause: counting the draws is not enough, CHECK THAT
 * THE DRAWS DIFFER. A sweep whose parameter does not reach the subsystem gives n=1 wearing n=16's
 * clothes, and it is the one sampling error that gets more convincing as you add samples. The
 * selftest's second check is that assertion, on the fleet's spawn EDGE SET.
 *
 * `hit()` has no per-car refractory. Both hosts call it once a frame for the worst contact,
 * and it applies a shunt whenever the delta-v clears SHUNT_MIN_DV, so a player leaning on one
 * car counts once a frame for as long as the lean delivers 1 m/s. The counters are
 * `shuntFrames` and `shuntCars` now, in src/traffic.js and in tools/playtest.mjs; this file is
 * the measurement that named them.
 *
 * THE MECHANISM, ASSERTED RATHER THAN GUESSED — and SINGLE-FLEET, like everything above step 3.
 * At the frame of contact, over all 258:
 *
 *     the car is AHEAD of the player        258 of 258
 *     the car's own speed, p50               0.00 m/s      it is STOPPED
 *     the player's speed, p50                3.92 - 5.98
 *
 * So the player rams a car, `car.stopS` holds that car still for 1.2-5 s where it was hit,
 * and a follower with no car-following term grinds on it. The entry's "overtaken from behind"
 * is the opposite of what happens, at every speed in the sweep.
 *
 * TWO INSTRUMENT ERRORS ON THE WAY TO THAT ROW, both of which printed a confident column:
 *
 *   - A car object has NO `x` and NO `z`. Its position is `_pointOn(edge, forward, t)` plus
 *     the lane offset, published once a frame into `_lastPositions`. The first version read
 *     `car.x`, got NaN, and `NaN < 0` is false — so it reported 0 behind / 197 ahead, a
 *     perfectly uniform column that happens to be the OPPOSITE of the truth once fixed. The
 *     probe prints the car's keys no more; it takes the subject from `_lastPositions` and
 *     THROWS if there is no finite position there, which is the only version that cannot do
 *     this again.
 *   - The heading frame's sign was inverted too. Forward is `(sin yaw, cos yaw)` — which is
 *     what BOTH hosts pass as `playerFwd`, so there was never anything to derive. Derived
 *     anyway, it read `-1.0000` against the car's own velocity over 195 frames, exactly, which
 *     is how a sign error announces itself when you check it by construction.
 *
 * Two wrong columns in one table, and the NaN one was wrong in the reassuring direction: it
 * agreed with the naive expectation. CLAUDE.md's rule is that the dangerous shape is the one
 * whose wrong answer is reassuring; a wrong answer that is also UNANIMOUS is the same shape.
 *
 * ARM B — NO FLEET AT ALL. The follower alone on the same route, 5 seeds, 9 speeds from 22 to
 * 72 km/h: 0 wall contacts and health 1.000 at every one, arriving 5 of 5. With the fleet in,
 * 72 km/h wrecks the car 5 of 5. So walls are not a term at any speed and the whole of #87 is
 * traffic — which the entry says by construction ("followPath has no car-following term") and
 * nothing had measured.
 *
 * ARM C — THE ISOLATION THE ENTRY ASKED FOR, and it refutes the entry's guess. Hold the
 * fleet's declared limit at a scale and sweep the player, 3 seeds, shunt FRAMES:
 *
 *     player km/h      22    29    36    43    50    61     fleet mean km/h
 *     fleet x0.6        0     0     0     0     0     0       24
 *     fleet x1.0       19     0     0    30    30    27       37
 *     fleet x1.5       17     0     0     0     0    30       50
 *
 * "MATCHES THE FLOW" PREDICTS THE CLEAN BAND MOVES WITH THE FLEET AND IT DOES NOT. The x0.6
 * row is zero at every player speed — including 61 km/h against a 24 km/h fleet, which is the
 * largest relative speed in the table and the cell the hypothesis says should be worst. And
 * at x1.5 the 43 and 50 km/h cells are clean while 22 is not. What x0.6 changes is how much
 * road the fleet covers, so what the table is sensitive to is the ENCOUNTER RATE, not the
 * speed difference.
 *
 * NO RESIDUAL IN THE ENTRY: with the event rate flat across fleets there is no non-monotonicity
 * to explain, so the mechanism question the entry opened dissolves rather than being answered.
 * What the arms still establish, in descending order of how fleet-independent they are: arm B
 * needs no fleet at all and is solid; the grind is structural (`car.stopS` holds a rammed car
 * 1.2-5 s and `followPath` cannot see it, both in the source); arm C is one fleet per scale and
 * is now moot.
 *
 * `--decide` is the arm that settles whether a zero is a zero. `SR_SEEDS` sets its seed count,
 * 16 is what the table above was measured at, and it means sixteen fleets only because of the
 * one-line fix in tools/playtest.mjs that the second selftest check now guards.
 */
import { Session, driveTo } from './playtest.mjs';
import { MISSIONS } from '../src/missions.js';
import { followPath } from '../src/roadpath.js';
import { crossTrack } from './lane-keep.mjs';

const SELFTEST = process.argv.includes('--selftest');
const DECIDE = process.argv.includes('--decide');
/**
 * RUN THE REPORT ONLY AS THE MAIN MODULE. tools/lane-keep.mjs gated this on `!SELFTEST` alone
 * and so printed forty lines of its own report on IMPORT, in front of three other probes'
 * first statement. A tool other tools import has to be silent when imported.
 */
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

const JOB = MISSIONS['marlin-street'];
const DT = 1 / 120, STEP = DT * 8;
/** Course points the follower spends acquiring the lane it was handed. See `soloDrive`. */
const ACQUIRE_PTS = 8;
const q = (a, p) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * b.length))];
};

/**
 * One drive to the flagship's pickup, with the contact geometry taken at the frame of impact.
 *
 * `fleetScale` multiplies the fleet's DECLARED limit. `_speedLimit` is consulted at spawn and
 * at every reroute, and a car's entry speed is `limit * (0.55 + 0.35r)`, so both the cap and
 * the entry scale — and the override consumes no draw, so the stream's draw COUNT is
 * untouched. It is NOT an otherwise-identical fleet: which car reaches a junction first moves
 * with its speed, so `_chooseNext` assigns the same draws to different decisions. That is the
 * perturbation CLAUDE.md records at length; it is why this reports seeds separately.
 */
export function drive({ maxSpeed = 10, seed = 0, fleetScale = 1, traffic = 12, peds = 40,
  timeout = 300, liftOff = 0 } = {}) {
  const s = new Session({ seed, traffic, peds });
  /**
   * `liftOff` REPRODUCES ROUND 8/B#11's ARM: cut the throttle for any fleet car within this many
   * metres. Round 8 measured "flat out ignoring traffic: 0 rams, 519 m; lifting off for any car
   * within 25 m: 6 rams, 357 m" and a later blind review refuted it as identical. See `--b11`.
   *
   * It hooks `session.drive` rather than re-implementing the follower, so the two arms differ in
   * exactly one term and the route, the speed cap and the stuck detector are the shipped ones.
   */
  let lifted = 0, steps = 0;
  if (liftOff > 0) {
    const origDrive = s.drive.bind(s);
    s.drive = (c) => {
      steps++;
      const near = (s.traffic._lastPositions ?? []).some((p) => p
        && Math.hypot(p.x - s.vehicle.position.x, p.z - s.vehicle.position.z) < liftOff);
      if (near) { lifted++; return origDrive({ ...c, throttle: 0 }); }
      return origDrive(c);
    };
  }
  if (fleetScale !== 1) {
    const orig = s.traffic._speedLimit.bind(s.traffic);
    s.traffic._speedLimit = (i) => orig(i) * fleetScale;
  }
  const ev = [];
  const orig = s.traffic.hit.bind(s.traffic);
  s.traffic.hit = (id, o) => {
    const p = (s.traffic._lastPositions ?? []).find((c) => c && c.id === id);
    const r = orig(id, o);
    if (!r) return r;
    // THE SUBJECT OR A THROW. A car has no x/z of its own; see the header.
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      throw new Error(`shunted car ${id} has no finite published position — `
        + `_lastPositions is the only place a car's world position lives`);
    }
    const y = s._yaw(), fx = Math.sin(y), fz = Math.cos(y);   // the hosts' own playerFwd
    const dx = p.x - s.vehicle.position.x, dz = p.z - s.vehicle.position.z;
    ev.push({ id, dv: r.dv, along: dx * fx + dz * fz, lat: dx * fz - dz * fx,
      carV: p.v ?? 0, plV: Math.hypot(s.vehicle.velocity.x, s.vehicle.velocity.z) });
    return r;
  };
  const r = driveTo(s, JOB.start.x, JOB.start.z, { maxSpeed, timeout });
  const rep = s.traffic.report();
  return { arrived: !!r.arrived, why: r.why ?? '', seconds: r.seconds ?? +s.t.toFixed(1),
    metres: r.metres ?? 0, blocked: r.blocked ?? 0, ev,
    frames: s.stats.shuntFrames, cars: s.stats.shuntCars,
    fleetFrames: rep.shuntFrames, fleetCars: rep.shuntCars,
    health: s.damage.health, wrecked: s.damage.wrecked, crashes: s.stats.crashes,
    knockdowns: s.stats.knockdowns, fleetKmh: rep.meanSpeedKmh,
    liftedPct: steps ? +(100 * lifted / steps).toFixed(1) : 0, steps,
    /**
     * `metres` above is `driveTo`'s ROUTE length and is only returned on arrival, so it reads 0
     * on a timeout — useful as an arrival proxy and NOT distance driven, which is what its first
     * printing in the B#11 table called it. `stats.distance` is the odometer.
     */
    driven: +s.stats.distance.toFixed(0) };
}

/**
 * ARM B. The follower alone, so the only thing that can touch anything is the player's own
 * lane keeping. Driven directly rather than through `driveTo` so the cross-track error can be
 * sampled per frame against the same points the follower is tracking.
 */
export function soloDrive({ maxSpeed = 10, seed = 0, timeout = 300 } = {}) {
  const s = new Session({ seed, traffic: 0, peds: 0 });
  const from = s.vehicle.position;
  const path = s.roads.path(from.x, from.z, JOB.start.x, JOB.start.z,
    { spacing: 4, offset: 1.5, smoothPasses: 2 });
  const st = { i: 0 };
  const xt = [], idx = [];
  const t0 = s.t;
  let arrived = false, why = 'timeout';
  while (s.t - t0 < timeout) {
    const v = s.vehicle;
    const f = followPath(path.points, { x: v.position.x, z: v.position.z, yaw: s._yaw(),
      speed: v.speed }, st, { maxSpeed, dt: STEP });
    if (f.done) { arrived = true; why = 'arrived'; break; }
    if (f.wedged) { why = 'wedged'; break; }
    s.drive(f.controls).step(STEP);
    // `crossTrack` RETURNS AN OBJECT. The first version of this arm did Math.abs() on it and
    // printed NaN in every row of the column it was added for.
    xt.push(Math.abs(crossTrack(path.points, v.position.x, v.position.z, f.i, 8).d));
    idx.push(f.i);
  }
  /**
   * AND THE CROSS-TRACK'S TAIL ON THIS ROUTE IS ROUTE ACQUISITION, NOT LANE KEEPING. p90 reads
   * 5.743 m and max 8.405 m at 14 m/s, which looks like a follower wandering half a street --
   * and all 99 frames over 4 m sit at course index 1..6 of 115, in one contiguous block, with
   * an unwindowed nearest-point search agreeing to the digit. `roads.path` starts from the
   * car's own position projected onto the lane 1.5 m right of the centreline, so the car begins
   * off the line it is given and swings out acquiring it. Past that block the p50 is 0.592 m.
   * Reported as two numbers for that reason: a single p90 over this route is a statement about
   * the first twenty metres.
   */
  const far = xt.filter((_, k) => idx[k] >= ACQUIRE_PTS);
  const over = xt.map((d, k) => ({ d, i: idx[k] })).filter((o) => o.d > 4);
  return { arrived, why, crashes: s.stats.crashes, health: s.damage.health,
    seconds: +(s.t - t0).toFixed(1), frames: xt.length, points: path.points.length,
    xtP90: q(xt, 0.9), xtMax: xt.length ? Math.max(...xt) : NaN,
    settledP50: q(far, 0.5), settledP90: q(far, 0.9),
    settledMax: far.length ? Math.max(...far) : NaN,
    overI: over.length ? [Math.min(...over.map((o) => o.i)), Math.max(...over.map((o) => o.i))] : null,
    overN: over.length };
}

const SPEEDS = [6, 8, 10, 10.5, 11, 12, 14, 17, 20];
const SEEDS = [0, 1, 2, 3, 4];

function agg(rows) {
  const all = rows.flatMap((r) => r.ev);
  const ahead = all.filter((e) => e.along > 0).length;
  return { all, ahead,
    frames: rows.reduce((a, r) => a + r.frames, 0),
    cars: rows.reduce((a, r) => a + r.cars, 0),
    health: rows.reduce((a, r) => a + r.health, 0) / rows.length,
    fleetKmh: rows.reduce((a, r) => a + r.fleetKmh, 0) / rows.length,
    worst: all.length ? Math.max(...all.map((e) => e.dv)) : 0,
    arrived: rows.filter((r) => r.arrived).length, wrecked: rows.filter((r) => r.wrecked).length };
}

// ------------------------------------------------------------------- selftest
if (SELFTEST && IS_MAIN) {
  console.log('SHUNT RATE SELFTEST\n');
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    ok ? pass++ : fail++;
  };

  /**
   * 1. THE TWO COUNTERS ARE TWO COUNTERS. This is the whole defect #87's number came from, and
   * it is the one check a build that reverted the split cannot pass: `shuntCars` incrementing
   * per frame reads 2/2 where the answer is 2 frames and 1 car. `mutation-sweep`'s
   * `shunt-cars-frames` is that revert.
   */
  {
    const s = new Session({ seed: 0, traffic: 2, peds: 0 });
    s.traffic.update(0.05, s.vehicle.position);
    const ids = s.traffic.cars.filter(Boolean).map((c) => c.id);
    s.traffic.hit(ids[0], { dv: 5, dirX: 0, dirZ: 1 });
    s.traffic.hit(ids[0], { dv: 5, dirX: 0, dirZ: 1 });
    const one = { f: s.traffic.stats.shuntFrames, c: s.traffic.stats.shuntCars };
    check('two shunts on ONE car are two frames and one car',
      one.f === 2 && one.c === 1, `frames ${one.f}, cars ${one.c}`);
    if (ids.length > 1) {
      s.traffic.hit(ids[1], { dv: 5, dirX: 0, dirZ: 1 });
      check('and a second car moves the car count but not by a frame',
        s.traffic.stats.shuntFrames === 3 && s.traffic.stats.shuntCars === 2,
        `frames ${s.traffic.stats.shuntFrames}, cars ${s.traffic.stats.shuntCars}`);
    }
    // A scuff is refused, so neither counter moves: the frame counter is not "every call".
    const before = s.traffic.stats.shuntFrames;
    s.traffic.hit(ids[0], { dv: 0.5, dirX: 0, dirZ: 1 });
    check('a contact under SHUNT_MIN_DV moves neither counter',
      s.traffic.stats.shuntFrames === before, `${s.traffic.stats.shuntFrames} vs ${before}`);
  }

  /**
   * 2. BY CONSTRUCTION: THE SEED REACHES THE FLEET. This check exists because it did not, and
   * the whole of this file's second conclusion was drawn against one fleet replicated 16 times.
   * `Session` passed `seed` to `PursuitUnits` and `Pedestrians` and gave `Traffic` only `count`,
   * so `Traffic` fell through to its own fixed default for every seed. `--decide` then read
   * 16/16 drives with a contact at 22 km/h against 0/16 at 36 and I wrote that up as a real,
   * nearly deterministic effect. With the fleet actually varying it is 5/16 against 5/16.
   *
   * Compared on the EDGE SET the cars are spawned onto rather than on a derived statistic,
   * because two different fleets can share a mean speed and nothing else.
   */
  {
    /**
     * AND THE FLEET HAS TO BE STEPPED BEFORE IT EXISTS. `cars` is filled by `_spawn` from inside
     * `update()`, so a freshly built Session holds ONE car against a requested twelve — the first
     * version of this check read the unspawned array, found two identical one-element lists and
     * reported the defect it was written to catch over a fleet that was not there. Its own detail
     * string said "1 cars each", which is how it was caught. Third instrument error of this family
     * in one round: a module's state read before the module has produced it.
     */
    const fleetOf = (seed) => {
      const sx = new Session({ seed, traffic: 12, peds: 0 });
      for (let k = 0; k < 20; k++) sx.traffic.update(1 / 15, sx.vehicle.position);
      const cars = sx.traffic.cars.filter(Boolean);
      if (cars.length < 8) throw new Error(`fleet of ${cars.length} against 12 requested — `
        + `the spawn pass has not run, so this check has no subject`);
      return cars.map((c) => `${c.edge}:${c.forward ? 1 : 0}`).join(',');
    };
    const a0 = fleetOf(0), a1 = fleetOf(1), a0again = fleetOf(0);
    check('two different seeds build two different fleets', a0 !== a1 && a0.length > 0,
      `seed 0 and seed 1 spawn on ${a0 === a1 ? 'the SAME' : 'different'} edges `
      + `(${a0.split(',').length} and ${a1.split(',').length} cars)`);
    check('and the same seed builds the same fleet, so the difference is the seed',
      a0 === a0again, a0 === a0again ? 'identical' : 'NOT reproducible');
  }

  /**
   * 3. BY CONSTRUCTION: the fleet's own speed tracks `fleetScale`. Arm C's whole conclusion is
   * a comparison between scales, so a mis-wired override — the method replaced on a prototype
   * the instance does not use, or an override `_spawn` has already run past — makes every row
   * of it a reading of the same fleet. The ratio is read first for that reason: it is
   * src/traffic.js's own `car.limit = _speedLimit(e) * (0.85 + 0.3r)`, so the jitter ceiling
   * is x1.15 of the scaled limit and nothing can legitimately exceed it.
   */
  {
    const seen = [0.6, 1.5].map((k) => {
      const r = drive({ maxSpeed: 10, seed: 0, fleetScale: k, traffic: 12, peds: 0, timeout: 90 });
      return { k, kmh: r.fleetKmh };
    });
    const base = drive({ maxSpeed: 10, seed: 0, fleetScale: 1, traffic: 12, peds: 0, timeout: 90 });
    const lo = seen[0].kmh / base.fleetKmh, hi = seen[1].kmh / base.fleetKmh;
    /**
     * RESTATED BY #128. The bound was `lo < 0.85 && hi > 1.15`, picked, and x1.5 read x1.11 once the
     * follower stopped cutting corners — the player's car is a leader in the fleet's car-following
     * term, so how the player drives moves how fast a scaled fleet can go. What the check is FOR is
     * the wiring, and the drive is deterministic for a seed: an override that did not reach the fleet
     * reads exactly x1.000 at both scales. So the bound only has to exclude 1, in each direction.
     * (#61's junction fillets moved it again, to x0.65 and x1.33: the same wiring, a different drive.)
     */
    check('the fleet-scale override reaches the fleet, and in the right direction',
      lo < 0.99 && hi > 1.01, `x0.6 -> x${lo.toFixed(2)} of the unscaled fleet, `
      + `x1.5 -> x${hi.toFixed(2)} (${seen[0].kmh} / ${base.fleetKmh} / ${seen[1].kmh} km/h)`);
    check('and the scaled fleet never exceeds its own jitter ceiling',
      seen[1].kmh <= base.fleetKmh * 1.5 * 1.15 + 1e-9,
      `${seen[1].kmh} km/h against ${(base.fleetKmh * 1.5 * 1.15).toFixed(1)} = `
      + `x1.5 x1.15 of ${base.fleetKmh}`);
  }

  /**
   * 4. THE DRIVE HAPPENED, and arm B's control is zero in BOTH counters. "Every column is
   * zero" has two causes and only one of them is a result: CLAUDE.md's "a check whose two
   * sides are both zero is not a check".
   */
  {
    const solo = soloDrive({ maxSpeed: 14, seed: 0 });
    check('the no-fleet arm completes the route, so its zero is a measurement',
      solo.arrived && solo.frames > 100, `${solo.why} in ${solo.seconds} s over ${solo.frames} frames`);
    check('and the follower alone touches nothing at 50 km/h',
      solo.crashes === 0 && solo.health === 1,
      `${solo.crashes} wall contacts, health ${solo.health.toFixed(3)}`);
    check('and its cross-track is a number rather than NaN',
      Number.isFinite(solo.xtP90) && Number.isFinite(solo.settledP50),
      `whole route p90 ${solo.xtP90.toFixed(3)} m / max ${solo.xtMax.toFixed(3)} m, `
      + `settled p50 ${solo.settledP50.toFixed(3)} m`);
    /**
     * AND THE TAIL IS AT THE START, which is what makes the big number acquisition rather than
     * wandering. A follower that drifted along the course would spread these frames over it;
     * this one puts every frame over 4 m inside the first `ACQUIRE_PTS` points.
     */
    check('and every excursion over 4 m is in the route\'s first few points, not spread along it',
      solo.overN > 0 && solo.overI[1] < ACQUIRE_PTS,
      `${solo.overN} frames over 4 m, at course index ${solo.overI[0]}..${solo.overI[1]} `
      + `of ${solo.points}; settled max ${solo.settledMax.toFixed(3)} m`);
  }

  /**
   * 5. A SHUNT ACTUALLY HAPPENS, and the frame counter really does multiply. Without the
   * second clause the rename is cosmetic; with it, the factor is the finding.
   *
   * RESTATED BY #128. This drove 12 m/s "because it is above the cliff arm A finds between 10.5 and
   * 11 m/s", and after the follower's look-ahead change there is no cliff: arm A reads 0-2 shunted
   * cars per five drives at every speed from 6 to 20 m/s, and 12 m/s over these seeds reads none —
   * a subject removed by a fix, which this file's CLAUDE.md records is a check passing on nothing.
   * At 20 m/s seeds 0-4 shunt two cars over 15 frames, every frame a rear-end into a STOPPED car
   * (car p50 0.00 m/s), so that is the subject. The one exception seen anywhere is a single frame
   * at 14 m/s, seed 1, with the car beside the player rather than ahead of it.
   *
   * RESTATED BY #61, NOT RE-SUBJECTED. The junction fillets change the course these seeds drive, and
   * the subject thinned to ONE car over 9 frames (still a rear-end into a stopped car, still ahead
   * of the player). The check needs one and has one; the next change to the route should look here
   * before it looks anywhere else, because one car is the least a subject can be.
   */
  {
    const rows = [0, 1, 2, 3, 4].map((seed) => drive({ maxSpeed: 20, seed, timeout: 300 }));
    const a = agg(rows);
    check('a shunt happens at all, so the geometry rows below have a subject',
      a.cars > 0, `${a.cars} cars over ${a.frames} frames, 5 seeds at 72 km/h`);
    /**
     * RESTATED BY #127. This read "the frame counter multiplies the event count several times
     * over", at 23.5 frames a car, and it was a property of WHERE the harness drove: every route
     * lane sat on the driver's LEFT, oncoming cars stopped for a player in their lane, and the
     * follower ground on them. On the right side of the road a contact is a brief rear-end and
     * the ratio is ~2 — still more than one, which is all the rename needed, and stated as that.
     */
    check('and the frame counter counts more than the event count, so the rename is not cosmetic',
      a.frames / Math.max(1, a.cars) > 1,
      `${(a.frames / Math.max(1, a.cars)).toFixed(2)} frames per car`);
    /**
     * 6. THE MECHANISM. Both of these were measured wrong first — see the header — so they are
     * asserted off `_lastPositions` and the hosts' own forward convention, and a missing
     * subject throws inside `drive` rather than reaching a comparison as NaN.
     */
    check('the shunted car is AHEAD of the player at the frame of contact',
      a.ahead === a.all.length && a.all.length > 0,
      `${a.ahead} of ${a.all.length}; the first version of this column read it the other way `
      + `round, from car.x, which does not exist`);
    const carV = q(a.all.map((e) => e.carV), 0.5);
    const plV = q(a.all.map((e) => e.plV), 0.5);
    // RESTATED BY #127: "it is stopped, held there by its own shunt rule" was a car that had
    // stopped for a wrong-side player. On the right side the fleet car ahead is MOVING, slower
    // than a follower that has no car-following term: a rear-end, not a head-on.
    check('and it is slower than the player: a rear-end by a follower with no car-following term',
      carV < plV && plV > 1, `car p50 ${carV.toFixed(2)} m/s, player p50 ${plV.toFixed(2)} m/s`);
  }

  console.log(`\nSHUNT RATE SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// -------------------------------------------------------------------- decide
if (DECIDE && IS_MAIN) {
  /**
   * THE ONE ARM THAT CAN SAY WHETHER A ZERO IS A ZERO. Arm A's events run 0 to 3 per 5 seeds,
   * which is a low-rate count, and CLAUDE.md's `router-lever` section is about exactly this:
   * a sparse metric over few draws cannot tell CANNOT from DID NOT. More seeds, events only.
   */
  const seeds = Number(process.env.SR_SEEDS ?? 12);
  const SD = Array.from({ length: seeds }, (_, i) => i);
  console.log(`IS THE 36 km/h ZERO A ZERO?  ${seeds} seeds per speed, EVENTS not frames\n`);
  console.log('  m/s   km/h | cars per seed                         | cars  frames | seeds with any');
  for (const v of [6, 8, 10, 11, 12, 14]) {
    const rows = SD.map((seed) => drive({ maxSpeed: v, seed, timeout: 300 }));
    const cars = rows.reduce((a, r) => a + r.cars, 0);
    const any = rows.filter((r) => r.cars > 0).length;
    console.log(`${v.toFixed(1).padStart(5)} ${String(Math.round(v * 3.6)).padStart(6)} |`
      + ` ${rows.map((r) => String(r.cars)).join(' ').padEnd(37)} |`
      + ` ${String(cars).padStart(4)} ${String(rows.reduce((a, r) => a + r.frames, 0)).padStart(7)} |`
      + ` ${any}/${seeds}`);
  }
  process.exit(0);
}

// ----------------------------------------------------------------------- b11
if (process.argv.includes('--b11') && IS_MAIN) {
  /**
   * RE-RUNNING A RECORDED REFUTATION ACROSS FLEETS. Round 8 found that lifting off for traffic
   * was WORSE than ignoring it (0 rams / 519 m against 6 rams / 357 m); a blind review refuted
   * that as "identical in all five seeds, 1.98 rams/km either way". **That phrase is the seed
   * defect's signature** — `Session` did not pass its seed to `Traffic`, so five seeds held one
   * fleet. The review's own caveat already said the lift rule fired on 3% of frames. This runs
   * the same pair over real fleets, and reports the firing rate so a null result can be read as
   * "no effect" rather than "the rule did nothing".
   */
  const seeds = Number(process.env.SR_SEEDS ?? 16);
  const SD = Array.from({ length: seeds }, (_, i) => i);
  console.log(`B#11 ACROSS FLEETS — lift off for traffic within 25 m, or ignore it. ${seeds} fleets.\n`);
  console.log('  arm      | cars  frames | drives w/ a contact | health mean | m DRIVEN | arrived | lift fired');
  const out = {};
  for (const lift of [0, 25]) {
    const rows = SD.map((seed) => drive({ maxSpeed: 12, seed, liftOff: lift, timeout: 300 }));
    const cars = rows.reduce((a, r) => a + r.cars, 0);
    out[lift] = { rows, cars };
    console.log(`  ${lift ? 'lift 25m' : 'ignore  '} | ${String(cars).padStart(4)} `
      + `${String(rows.reduce((a, r) => a + r.frames, 0)).padStart(7)} | `
      + `${String(rows.filter((r) => r.cars > 0).length).padStart(19)} | `
      + `${(rows.reduce((a, r) => a + r.health, 0) / rows.length).toFixed(4).padStart(11)} | `
      + `${(rows.reduce((a, r) => a + r.driven, 0) / rows.length).toFixed(0).padStart(8)} | `
      + `${String(rows.filter((r) => r.arrived).length).padStart(2)}/${rows.length}   | `
      + `${lift ? (rows.reduce((a, r) => a + r.liftedPct, 0) / rows.length).toFixed(1) + '% of steps' : 'n/a'}`);
  }
  // PAIRED, because both arms walk the same fleet at each seed — the DIFFERENCE is what this
  // licenses, not either absolute. CLAUDE.md's router-lever section is that rule.
  for (const lift of [0, 25]) {
    const km = out[lift].rows.reduce((a, r) => a + r.driven, 0) / 1000;
    console.log(`  ${lift ? 'lift 25m' : 'ignore  '} -> ${(out[lift].cars / km).toFixed(3)} `
      + `CARS/km over ${km.toFixed(2)} km driven`);
  }
  const diffs = SD.map((i) => out[25].rows[i].cars - out[0].rows[i].cars);
  const worse = diffs.filter((d) => d > 0).length, better = diffs.filter((d) => d < 0).length;
  console.log(`\n  paired per fleet: lifting off is worse on ${worse}, better on ${better}, `
    + `level on ${diffs.length - worse - better} of ${diffs.length}`);
  console.log(`  per-fleet deltas: ${diffs.join(' ')}`);
  process.exit(0);
}

// -------------------------------------------------------------------- report
if (IS_MAIN) {
  console.log('SHUNT RATE — what a contact rate against the fleet measures (#87)\n');

  console.log('ARM A  the shipped fleet, sweeping the player. FRAMES is the column #87 quoted.');
  console.log('  m/s   km/h | arr wrk | frames  cars  per car | ahead | carV p50 plV p50 | worstDv | health');
  for (const v of SPEEDS) {
    const a = agg(SEEDS.map((seed) => drive({ maxSpeed: v, seed, timeout: 300 })));
    const perCar = a.cars ? (a.frames / a.cars).toFixed(2) : '    -';
    console.log(`${v.toFixed(1).padStart(5)} ${String(Math.round(v * 3.6)).padStart(6)} |`
      + ` ${a.arrived}/${SEEDS.length} ${String(a.wrecked).padStart(3)} |`
      + ` ${String(a.frames).padStart(6)} ${String(a.cars).padStart(5)} ${String(perCar).padStart(8)} |`
      + ` ${String(a.ahead).padStart(5)} |`
      + ` ${q(a.all.map((e) => e.carV), 0.5).toFixed(2).padStart(8)} ${q(a.all.map((e) => e.plV), 0.5).toFixed(2).padStart(7)} |`
      + ` ${a.worst.toFixed(3).padStart(7)} | ${a.health.toFixed(3)}`);
  }

  console.log('\nARM B  no fleet. If the cliff were the follower leaving its lane it would be here.');
  console.log('  m/s   km/h | arr | wall contacts | health | settled xt p50   p90    max | acquire max');
  for (const v of SPEEDS) {
    const rows = SEEDS.map((seed) => soloDrive({ maxSpeed: v, seed }));
    console.log(`${v.toFixed(1).padStart(5)} ${String(Math.round(v * 3.6)).padStart(6)} |`
      + ` ${rows.filter((r) => r.arrived).length}/${SEEDS.length} |`
      + ` ${String(rows.reduce((a, r) => a + r.crashes, 0)).padStart(13)} |`
      + ` ${(rows.reduce((a, r) => a + r.health, 0) / rows.length).toFixed(3)}  |`
      + ` ${q(rows.map((r) => r.settledP50), 0.5).toFixed(3).padStart(12)} `
      + `${q(rows.map((r) => r.settledP90), 0.5).toFixed(3).padStart(5)} `
      + `${Math.max(...rows.map((r) => r.settledMax)).toFixed(3).padStart(6)} |`
      + ` ${Math.max(...rows.map((r) => r.xtMax)).toFixed(3).padStart(11)}`);
  }

  console.log('\nARM C  hold the fleet, sweep the player. "Matches the flow" says the clean band MOVES.');
  let armCcars = 0, armCdrives = 0;
  for (const k of [0.6, 1.0, 1.5]) {
    const sd = [0, 1, 2];
    const out = [6, 8, 10, 12, 14, 17].map((v) => {
      const a = agg(sd.map((seed) => drive({ maxSpeed: v, seed, fleetScale: k, timeout: 300 })));
      armCcars += a.cars; armCdrives += sd.length;
      return { v, a };
    });
    console.log(`  fleet x${k.toFixed(1)}  (mean ${(out.reduce((s, o) => s + o.a.fleetKmh, 0) / out.length).toFixed(0)} km/h)`
      + `   frames ` + out.map((o) => `${Math.round(o.v * 3.6)}:${o.a.frames}`).join('  ')
      + `   cars ` + out.map((o) => o.a.cars).join(','));
  }
  // COMPUTED, not printed as a conclusion. This line read "the x0.6 row is the refutation: zero at
  // EVERY player speed", which was true of the wrong side of the road and false the first time
  // the arms ran on the right one — a sentence a run cannot fail is a check that cannot fail.
  console.log(`\nArm C shunted ${armCcars} distinct car${armCcars === 1 ? '' : 's'} over ${armCdrives} drives`
    + ' (arm A on the driver\'s LEFT, before #127: 11 cars over 40 drives, 258 frames).');
}
