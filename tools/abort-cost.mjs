#!/usr/bin/env node
/**
 * abort-cost — WHAT EVERY WAY OUT OF A MISSION COSTS, IN SECONDS.
 *
 * #106 asks whether a player who has taken a job and changed their mind should be able to hand
 * it back, and the backlog offered two candidate levers with an ARGUMENT against one of them:
 * "where you took it is not somewhere a player who wants out is standing". This tool turns that
 * into a number, and prices every alternative in the same unit, because a comparison in two
 * units is not a comparison.
 *
 * THE THREE SHIPPED EXITS are complete, wreck and arrest. Only the geometry levers have a
 * distance, so only they need driving; the other prices are in the record and are quoted with
 * their source. The decision the numbers make is recorded at the bottom.
 *
 * ## WHY THE INSTRUMENT IS A SIMULATED DRIVE AND NOT AN INTEGRAL
 *
 * The first version integrated `pathSpeedLimit` along each route — a closed form over a
 * position-only speed limit, deterministic and instant — and CLAIMED to be a floor: a real
 * drive cannot beat a best-case one, so a lever that loses at this speed loses at every speed.
 * The claim is false. Checked against the shipped follower on the shipped vehicle over the same
 * eight routes:
 *
 *     marlin-street      integral 43.9 s   simulated 49.1 s   x1.12
 *       back from 25%             18.1              17.2      x0.95
 *       back from 50%             14.0              14.9      x1.07
 *       back from 75%             29.2              29.9      x1.02
 *     shakedown                   35.4              45.4      x1.28
 *       back from 25%              9.3               8.0       x0.86
 *       back from 50%              4.5               3.3       x0.74
 *       back from 75%              9.2               8.6       x0.94
 *
 * It reads ABOVE a real drive on four of eight and by up to 35%, so it is not a floor in either
 * direction — it is a different quantity. The integral accelerates from rest at `RESPONSE.accel`
 * and the follower's own speed cap is 22 m/s against the integral's 110 km/h, so on a short leg
 * the integral is pessimistic and on a long one optimistic. Rather than fit the integral to the
 * follower, this tool drives: the follower and the vehicle ARE the game's own, so there is one
 * instrument rather than two that have to be reconciled.
 *
 * And the first version's VERDICT could not fail. It seeded the worst ratio at `Infinity` and
 * printed "FLOOR HOLDS" when nothing arrived — eight routes, eight timeouts at the cap, and a
 * reassuring answer on zero data, which is this file's own "a check whose two sides are both
 * zero is not a check" and `car-pixel`'s vanishing worst-slot check in one. Arrivals are counted
 * and a verdict without them is refused.
 *
 * ## THE ARRIVAL TEST IS THE GAME'S OWN RULE, NOT A RADIUS
 *
 * A pickup fires when the player is inside its ring AND stopped — `MissionBoard.startableAt`,
 * under `stopMs`, which the host passes as `src/wanted.js`'s `SCENE_STOP_MS`. So "driving back
 * to hand it back" costs the drive AND the stop, and a probe that stopped at the ring's edge
 * would understate it by the braking curve. The arrival test here is both halves.
 */
import { readFileSync } from 'node:fs';
import { RoadGraph, followPath, RESPONSE } from '../src/roadpath.js';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { MISSIONS } from '../src/missions.js';
import { OFFER_RADIUS_M } from '../src/mission.js';
import { SCENE_STOP_MS } from '../src/wanted.js';

const SELFTEST = process.argv.includes('--selftest');
const HERE = new URL('.', import.meta.url).pathname;
const district = JSON.parse(readFileSync(`${HERE}../data/district.json`, 'utf8'));
const roads = new RoadGraph(district);
const ground = new FlatGround(0);

/** district/main.js's own GARAGE_AT, asserted against the host below rather than trusted. */
const GARAGE = { x: -67.9, z: 60.3, radius: OFFER_RADIUS_M };

/** From the record, with the source, because a price with no provenance is a guess. */
const SHIPPED_EXITS = [
  { name: 'wreck your own car, deliberately', s: 13.4, src: '#96, 5 seeds, median' },
  { name: 'get arrested, deliberately', lo: 7.7, hi: 19.9, src: 'round 10 B#12, 25 arms' },
];

const DT = 1 / 120;

/**
 * Drive `pts` with the shipped follower and the shipped vehicle until the car is inside
 * `radius` of the last point AND under `SCENE_STOP_MS`. Returns the seconds and WHY it ended,
 * because "0 s" cannot tell a car that arrived instantly from one that never set off — the
 * distinction `boot-check`'s run-over arm needed three versions to learn.
 */
export function driveSeconds(pts, radius = OFFER_RADIUS_M, capS = 240) {
  const v = new Vehicle();
  v.position.set(pts[0][0], 0.55, pts[0][1]);
  const yaw0 = Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw0);
  const st = { i: 0 };
  const endX = pts[pts.length - 1][0], endZ = pts[pts.length - 1][1];
  let inRing = null;
  for (let k = 0; k < capS * 120; k++) {
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    const f = followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: v.speed }, st, { dt: DT });
    const d = Math.hypot(v.position.x - endX, v.position.z - endZ);
    // Inside the ring the follower is still chasing the last point, so the car has to be
    // braked deliberately — which is exactly what the pickup rule asks of the player.
    if (d <= radius) {
      if (inRing === null) inRing = k * DT;
      v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: false });
    } else {
      v.setControls(f.controls);
    }
    v.stepFixed(DT, ground, 120);
    if (d <= radius && v.speed < SCENE_STOP_MS) {
      return { t: k * DT, why: 'stopped-in-ring', ring: inRing, arrived: true };
    }
  }
  return { t: capS, why: 'cap', ring: inRing, arrived: false };
}

/** Every stop a mission asks the player to make, starting from its own pickup. */
export function legsOf(m) {
  const pts = [{ x: m.start.x, z: m.start.z, name: 'pickup', radius: m.start.radius ?? OFFER_RADIUS_M }];
  for (const s of m.stages) for (const t of s.triggers ?? []) {
    if (t.kind === 'reach' && Number.isFinite(t.x)) {
      const last = pts[pts.length - 1];
      if (Math.hypot(t.x - last.x, t.z - last.z) > 1) pts.push({ x: t.x, z: t.z, name: s.id, radius: t.radius ?? 0 });
    }
  }
  return pts;
}

/** One edge list for the whole mission, which is roadpath's rule: per-leg routing doubles back. */
function routeOf(stops) {
  let path = [];
  for (let i = 1; i < stops.length; i++) {
    const r = roads.path(stops[i - 1].x, stops[i - 1].z, stops[i].x, stops[i].z, { spacing: 5 });
    if (!r || r.points.length < 2) return null;
    path = path.concat(i === 1 ? r.points : r.points.slice(1));
  }
  return path;
}

const arcsOf = (path) => {
  let a = 0; const out = [0];
  for (let i = 1; i < path.length; i++) { a += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); out.push(a); }
  return out;
};

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); return ok; };

if (SELFTEST) {
  console.log('ABORT-COST SELFTEST\n');
  // 1. THE INSTRUMENT MOVES WITH THE QUANTITY IT MEASURES. A straight 200 m must cost more
  //    than a straight 50 m, and both must arrive — CLAUDE.md's "a probe that measures the
  //    OPPORTUNITY does not measure the FIX" arriving as the cheapest possible version.
  const line = (n, step) => Array.from({ length: n }, (_, i) => [0, i * step, -1]);
  const short = driveSeconds(line(11, 5), 12, 60);      //  50 m
  const long = driveSeconds(line(41, 5), 12, 60);       // 200 m
  check('a 200 m drive costs more than a 50 m drive', long.t > short.t,
    `${short.t.toFixed(1)} s against ${long.t.toFixed(1)} s`);
  check('and both arrived, so neither reading is a timeout', short.arrived && long.arrived,
    `${short.why} / ${long.why}`);
  // 2. KNOWN-BAD: the arrival test without the stop. Reporting the ring entry alone must be
  //    CHEAPER than the real rule, by the braking curve — the understatement this tool's
  //    header says a ring-edge probe would make. If the two are equal the stop is not being
  //    required and every price below is wrong in the flattering direction.
  check('requiring the stop costs more than touching the ring', long.t > long.ring,
    `ring at ${long.ring.toFixed(2)} s, stopped at ${long.t.toFixed(2)} s,`
    + ` +${(long.t - long.ring).toFixed(2)} s of braking`);
  // 3. AND THE BRAKING COST IS DERIVED, NOT BANDED. The first version of this check asserted
  //    "within the measured 0.2 - 0.7 s band" and read 1.85 s, which passed only because the
  //    bound had been widened to 2.0 and left the NAME behind. The 0.2 s it named is
  //    src/wanted.js's figure for how long a driver spends UNDER 1.0 m/s, which is not how
  //    long it takes to GET under it — this file's "quote the signal the code reads", arriving
  //    inside a check about braking. The right quantity is the car's own curve: shedding
  //    v_entry down to SCENE_STOP_MS at RESPONSE.brake, with the follower's own cap as v_entry.
  const vCap = 22;                                   // followPath's default maxSpeed, m/s
  const tBrake = (vCap - SCENE_STOP_MS) / RESPONSE.brake;
  check('and the braking cost is the car\'s own curve from the follower\'s cap',
    Math.abs((long.t - long.ring) - tBrake) < 0.25,
    `${(long.t - long.ring).toFixed(2)} s measured against ${tBrake.toFixed(2)} s derived`
    + ` ((${vCap} - ${SCENE_STOP_MS}) / ${RESPONSE.brake} m/s2)`);
  // 4. A CAP IS NOT AN ARRIVAL. A route the car cannot finish must say so rather than
  //    returning its cap as a price — the "0 run-overs" ambiguity in another file.
  const blocked = driveSeconds(line(3, 5), 0.001, 2);
  check('an unreachable target reports the cap rather than a price', !blocked.arrived && blocked.why === 'cap',
    `why "${blocked.why}", t ${blocked.t.toFixed(1)} s`);
  // 5. The constants are read from the modules, not copied. A second copy of a constant is
  //    this repo's recurring defect, and the garage's position is the one literal here.
  check('the stop threshold is src/wanted.js\'s own', SCENE_STOP_MS === 1.0, `${SCENE_STOP_MS} m/s`);
  check('the pickup radius is src/mission.js\'s own', OFFER_RADIUS_M === 12, `${OFFER_RADIUS_M} m`);
  const hostGarage = readFileSync(`${HERE}../district/main.js`, 'utf8')
    .match(/const GARAGE_AT = \{ x: (-?[\d.]+), z: (-?[\d.]+) \}/);
  check('and the garage position matches the host\'s literal',
    hostGarage && +hostGarage[1] === GARAGE.x && +hostGarage[2] === GARAGE.z,
    hostGarage ? `(${hostGarage[1]}, ${hostGarage[2]})` : 'GARAGE_AT not found in district/main.js');
  // 6. Every mission routes. A route that fails would silently drop a row from the table.
  let routed = 0, total = 0;
  for (const m of Object.values(MISSIONS)) {
    if (!m.start) continue;
    total++;
    if (routeOf(legsOf(m))) routed++;
  }
  check('every mission with a pickup routes end to end', routed === total && total > 0, `${routed} of ${total}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nABORT-COST: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

console.log('=== #106: every way out of a mission, priced in seconds ===\n');
console.log('SHIPPED EXITS, from the record:');
for (const e of SHIPPED_EXITS) {
  console.log(`  ${e.name.padEnd(36)} ${e.s != null ? `${e.s.toFixed(1)} s` : `${e.lo} - ${e.hi} s`}`.padEnd(60) + `(${e.src})`);
}
const WRECK = SHIPPED_EXITS[0].s;
console.log(`\nCANDIDATE LEVERS, measured here by driving the shipped follower to the zone and`);
console.log(`stopping under ${SCENE_STOP_MS} m/s, which is the rule a pickup already fires under:\n`);

const verdict = [];
for (const m of Object.values(MISSIONS)) {
  if (!m.start) continue;
  const stops = legsOf(m);
  const path = routeOf(stops);
  if (!path) { console.log(`  ROUTE FAILED ${m.id}`); continue; }
  const arcs = arcsOf(path);
  const total = arcs[arcs.length - 1];
  const whole = driveSeconds(path, stops[stops.length - 1].radius || OFFER_RADIUS_M);
  console.log(`--- ${m.id}: ${total.toFixed(0)} m of route, ${stops.map((s) => s.name).join(' -> ')}`);
  console.log(`    COMPLETING it from the pickup: ${whole.t.toFixed(1)} s (${whole.why})\n`);
  console.log('    pos    arc      back to own pickup        to the garage          against the wreck');
  for (const f of [0.1, 0.25, 0.5, 0.75, 1.0]) {
    const k = arcs.reduce((b, v, i) => (Math.abs(v - f * total) < Math.abs(arcs[b] - f * total) ? i : b), 0);
    const p = path[k];
    const back = roads.path(p[0], p[1], m.start.x, m.start.z, { spacing: 5 });
    const gar = roads.path(p[0], p[1], GARAGE.x, GARAGE.z, { spacing: 5 });
    const tb = back && back.points.length > 2 ? driveSeconds(back.points, m.start.radius ?? OFFER_RADIUS_M, 120) : null;
    const tg = gar && gar.points.length > 2 ? driveSeconds(gar.points, GARAGE.radius, 120) : null;
    const fmt = (r, d) => (r ? `${d.toFixed(0).padStart(4)} m /${r.t.toFixed(1).padStart(6)} s${r.arrived ? '' : ' CAP'}` : '      no route');
    const best = [tb, tg].filter((r) => r && r.arrived).map((r) => r.t).sort((a, b) => a - b)[0];
    const note = best == null ? 'no lever reaches a zone'
      : best < WRECK ? `beats the wreck by ${(WRECK - best).toFixed(1)} s`
        : `LOSES to the wreck by ${(best - WRECK).toFixed(1)} s`;
    console.log(`    ${(100 * f).toFixed(0).padStart(3)}%  ${arcs[k].toFixed(0).padStart(4)} m`
      + `   ${fmt(tb, back?.length ?? 0)}   ${fmt(tg, gar?.length ?? 0)}   ${note}`);
    verdict.push({ mission: m.id, f, best, beats: best != null && best < WRECK });
  }
  console.log('');
}

const beats = verdict.filter((v) => v.beats).length;
console.log('=== WHAT THE NUMBERS DECIDE ===\n');
console.log(`A geometry lever — drive to a zone and stop — is cheaper than wrecking your own car`);
console.log(`on ${beats} of ${verdict.length} sampled positions. Wrecking it costs ${WRECK.toFixed(1)} s and is reachable`);
console.log('from anywhere, so a lever that loses to it does not remove the inversion it was meant');
console.log('to remove: a player who wants out would still drive into a wall. The per-mission split');
console.log('is the reason a single lever cannot be chosen from this table —');
for (const id of [...new Set(verdict.map((v) => v.mission))]) {
  const rows = verdict.filter((v) => v.mission === id);
  console.log(`  ${id.padEnd(16)} ${rows.filter((r) => r.beats).length} of ${rows.length} positions`);
}
console.log('\nA KEY costs 0 s from every position in this table, which is the only price that beats');
console.log(`${WRECK.toFixed(1)} s everywhere. The deliberate act it needs is the one the pickup already asks for`);
console.log(`and src/mission.js already derives: the car STOPPED, under ${SCENE_STOP_MS} m/s. That reuses a`);
console.log('measured constant and the garage\'s own "stop here" cue instead of inventing a hold.');
