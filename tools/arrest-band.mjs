// THE BAND WHERE A WANTED PLAYER CAN NEITHER BE ARRESTED NOR ESCAPE.
//
//   node tools/arrest-band.mjs                 the sweep, at four stars
//   node tools/arrest-band.mjs --stars 5       at another level
//   node tools/arrest-band.mjs --selftest      prove the instrument
//
// WHAT THIS MEASURES AND WHY IT IS NOT THE SAME QUESTION AS "CAN THE POLICE REACH ME".
// Two radii decide a stationary wanted player's fate and they are declared in different modules
// from different derivations, and nothing had ever compared them:
//
//   arrest    src/pursuit.js   reachRadius = max(holdRadius, RUN_SPEED * BUST_HOLD_S) = 28.00 m
//   spotted   src/wanted.js    tune().spotRadius, 85 m at 1* rising to 175 m at 5*
//
// `reachRadius` is honestly derived — an arrest is made by a person, who covers that much ground
// on foot while the clock runs — and `spotRadius` is honestly derived too. The defect is the GAP:
// being spotted holds the state at ACTIVE, which pins `evadeTimer` at 0, which is the only thing
// the decay reads. So between the two radii the game can see you, cannot touch you, and will not
// let you go. Neither module is wrong on its own; no gate compared them.
//
// NEITHER HOST NARROWS IT. `_evaluateContact` short-circuits on `player.seen` and then on
// `this.losTest`, and district/main.js sets neither — its own comment says "with no `seen` flag
// from the host, src/wanted.js decides contact purely by unit proximity". So spotting is pure
// distance with no line of sight, and the band is not an edge case.
//
// THE CONTROL IS THE POINT OF THE TOOL. The first version of this probe wired WantedSystem to
// PursuitUnits by hand, got `bindPursuit`'s interface wrong, tested `state === 'chase'` against a
// STATES enum with no such member, and printed ten rows of ZEROES — which reads as "immunity at
// every distance" and is in fact "the probe never started a pursuit". The on-road row is a
// CONTROL and this tool THROWS if it was not arrested, because without it every zero below is
// ambiguous between a finding and a broken instrument. CLAUDE.md: a check whose two sides are
// both zero is not a check.
import { RUN_SPEED } from '../src/player.js';
import { BUST_HOLD_S, STATES, RESPONSE } from '../src/wanted.js';

const argv = process.argv.slice(2);

/**
 * `tools/playtest.mjs` READS `process.argv` AT MODULE SCOPE, so a static import of it from a tool
 * that has its own `--selftest` runs PLAYTEST'S selftest instead of this one. It did: the first
 * run of `arrest-band --selftest` printed 139 passing checks about the garage and the minimap and
 * exited 0 without running a single check in this file. A green exit code from somebody else's
 * gate is the most flattering failure available.
 *
 * `tools/playtest.mjs` has a main-module guard now, which is the real fix and is where it
 * belongs. The scrub below is kept anyway: it costs one line and it means this tool does not
 * depend on a sibling file keeping a guard somebody could revert. The two `src/` imports above
 * are static because neither module looks at argv.
 */
const Session = await (async () => {
  const saved = process.argv;
  process.argv = [saved[0], saved[1]];
  try { return (await import('./playtest.mjs')).Session; } finally { process.argv = saved; }
})();
const KNOWN = new Set(['--selftest', '--stars', '--seconds']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/arrest-band.mjs ` +
      `[--selftest] [--stars N] [--seconds N]`);
    process.exit(2);
  }
}
const flagVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};

/** Distance from a point to the nearest road CENTRELINE, over every edge's polyline. */
export function roadDistance(segs, x, z) {
  let best = Infinity;
  for (const [ax, az, bx, bz] of segs) {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
    if (d < best) best = d;
  }
  if (!Number.isFinite(best)) {
    throw new Error(`roadDistance is ${best} over ${segs.length} segments. A non-finite ` +
      `distance fails every > comparison silently and the classifier below would then report ` +
      `"arrestable" for the most flattering possible reason.`);
  }
  return best;
}

export function segmentsOf(district) {
  const segs = [];
  for (const e of district.edges) {
    const pts = e.v.map((i) => district.verts[i]);
    for (let k = 0; k + 1 < pts.length; k++) {
      segs.push([pts[k].x, pts[k].z, pts[k + 1].x, pts[k + 1].z]);
    }
  }
  return segs;
}

/**
 * THE THREE OUTCOMES A STATIONARY WANTED PLAYER CAN HAVE, named so the band is a classification
 * and not a reading of one column. `escaped` and `stalemate` BOTH have zero busts, which is why
 * `busts === 0` on its own is not the finding — the level is what separates them.
 */
export function classify(r) {
  if (r.busts > 0) return 'arrested';
  if (r.stars === 0) return 'escaped';
  return 'stalemate';
}

export function bandOf(rows) {
  const stuck = rows.filter((r) => classify(r) === 'stalemate');
  if (!stuck.length) return null;
  return { lo: Math.min(...stuck.map((r) => r.roadD)), hi: Math.max(...stuck.map((r) => r.roadD)),
    n: stuck.length };
}

function sweep({ stars = 4, seconds = 240 } = {}) {
  const probe = new Session({ seed: 3, peds: 0, traffic: 0 });
  const district = probe.district;
  const segs = segmentsOf(district);

  // A long non-service edge, so "distance off the road" is unambiguous and the nearest road point
  // does not hop between edges as the sweep walks outward. Printed, because the subject of a
  // measurement belongs in its report — CLAUDE.md's `ao-sweep` picked a different pavement slot
  // on two runs of one configuration and every absolute number moved with it.
  let best = null;
  for (const e of district.edges) {
    if (e.c === 'service') continue;
    const pts = e.v.map((i) => district.verts[i]);
    const L = Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).z - pts[0].z);
    if (!best || L > best.L) best = { e, pts, L };
  }
  const a = best.pts[0], b = best.pts.at(-1);
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const ux = (b.x - a.x) / best.L, uz = (b.z - a.z) / best.L;
  const nx = -uz, nz = ux;

  // The offence that gets the level up. `officerDown` is the same route the committed §8 arm in
  // playtest.mjs uses, so the two arms escalate identically and a difference between them is
  // about the thing under test.
  const crime = stars >= 4 ? 'officerDown' : 'pedestrianKilled';

  function run(off) {
    const s = new Session({ seed: 3, peds: 0, traffic: 0 });
    const px = mid.x + nx * off, pz = mid.z + nz * off;
    s.placeAt(px, pz);
    s.wanted.reportCrime(crime, { at: { x: px, z: pz } });
    if (s.wanted.stars < stars) s.wanted.setStars(stars);
    const stars0 = s.wanted.stars;
    let seen = 0, frames = 0, minD = Infinity, inReach = 0, heldEver = 0, unitsEver = 0;
    for (let k = 0; k < seconds && s.stats.busts === 0; k++) {
      s.drive({ throttle: 0, brake: 1 }).step(1);
      frames++;
      if (s.wanted.state === STATES.ACTIVE) seen++;
      const u = s._unitPositions();
      unitsEver = Math.max(unitsEver, u.length);
      heldEver = Math.max(heldEver, u.filter((x) => x.held).length);
      for (const x of u) {
        const d = Math.hypot(x.x - s.vehicle.position.x, x.z - s.vehicle.position.z);
        if (d < minD) minD = d;
        if (d <= s.pursuit.reachRadius) inReach++;
      }
    }
    return { off, roadD: roadDistance(segs, px, pz), stars0, stars: s.wanted.stars,
      busts: s.stats.busts, seen: frames ? seen / frames : 0, minD, inReach, heldEver,
      unitsEver, t: s.t, spotR: s.wanted.tune().spotRadius };
  }

  const reach = probe.pursuit.reachRadius, hold = probe.pursuit.holdRadius;
  console.log(`subject edge: class ${best.e.c}, ${best.L.toFixed(0)} m long, midpoint ` +
    `(${mid.x.toFixed(0)}, ${mid.z.toFixed(0)}); ${segs.length} centreline segments`);
  console.log(`arrest reach ${reach.toFixed(2)} m = max(holdRadius ${hold.toFixed(2)}, ` +
    `RUN_SPEED ${RUN_SPEED} x BUST_HOLD_S ${BUST_HOLD_S}); spotRadius at ${stars}* is ` +
    `${RESPONSE[stars].spotRadius} m, a factor of ` +
    `${(RESPONSE[stars].spotRadius / reach).toFixed(2)} wider`);
  console.log(`\n  placed   true road d   stars    units  held   seen%    closest   in-reach  busts` +
    `   ended`);
  const rows = [];
  for (const off of [0, 15, 30, 45, 60, 90, 130, 180, 260]) {
    const r = run(off);
    rows.push(r);
    console.log(`  ${String(off).padStart(5)} m  ${r.roadD.toFixed(1).padStart(10)} m   ` +
      `${r.stars0}->${r.stars}   ${String(r.unitsEver).padStart(6)}  ${String(r.heldEver).padStart(4)}  ` +
      `${(100 * r.seen).toFixed(0).padStart(5)}%  ${r.minD === Infinity ? '      n/a' : r.minD.toFixed(1).padStart(7) + ' m'}  ` +
      `${String(r.inReach).padStart(9)}  ${String(r.busts).padStart(5)}   ${r.t.toFixed(0).padStart(4)} s  ` +
      `${classify(r)}`);
  }

  const control = rows[0];
  if (!(control.busts > 0 && control.unitsEver > 0)) {
    throw new Error(`THE ON-ROAD CONTROL WAS NOT ARRESTED: ${control.busts} busts, ` +
      `${control.unitsEver} units ever, closest ${control.minD.toFixed(1)} m. Every "no arrest" ` +
      `row below it is then the PROBE failing rather than the game, and both sides of the ` +
      `comparison are zero. Fix the harness before reading the table.`);
  }
  console.log(`\ncontrol: on the road ${control.unitsEver} units arrived, one held, and the ` +
    `arrest fired at t=${control.t.toFixed(0)} s. So a zero in a row above is the GAME.`);

  const by = (k) => rows.filter((r) => classify(r) === k).map((r) => `${r.roadD.toFixed(0)} m`);
  console.log(`arrested at   ${by('arrested').join(', ') || 'nowhere'}`);
  console.log(`escaped at    ${by('escaped').join(', ') || 'nowhere'}`);
  console.log(`NEITHER at    ${by('stalemate').join(', ') || 'nowhere'}` +
    `   <- seen, un-arrestable, and the level never falls`);
  const band = bandOf(rows);
  if (band) {
    console.log(`\nthe band, as sampled: ${band.lo.toFixed(0)}..${band.hi.toFixed(0)} m off a ` +
      `centreline, ${band.n} of ${rows.length} rows`);
    console.log(`predicted from the two constants: ${reach.toFixed(0)}..` +
      `${RESPONSE[stars].spotRadius} m — the sample's edges should bracket both`);
  } else {
    console.log('\nno stalemate row: every placement was either arrested or escaped');
  }
  return { rows, band, reach, spotR: RESPONSE[stars].spotRadius };
}

// ----------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('ARREST-BAND SELFTEST');

  // 1. roadDistance, against a segment whose answer is arithmetic.
  const seg = [[0, 0, 10, 0]];
  say(Math.abs(roadDistance(seg, 5, 3) - 3) < 1e-12, 'a point off the middle of a segment reads ' +
    'its perpendicular distance', `${roadDistance(seg, 5, 3).toFixed(3)} against 3`);
  say(Math.abs(roadDistance(seg, 14, 0) - 4) < 1e-12, 'and a point past the END reads the ' +
    'endpoint distance, not the infinite line\'s', `${roadDistance(seg, 14, 0).toFixed(3)} against 4`);
  say(Math.abs(roadDistance(seg, 5, 0)) < 1e-12, 'a point ON the centreline reads 0',
    `${roadDistance(seg, 5, 0)}`);
  // KNOWN-BAD: a degenerate segment list must not return Infinity quietly. CLAUDE.md's rule about
  // a non-finite difference failing every comparison silently, in the one place it would read as
  // "nowhere is a stalemate".
  let threw = false;
  try { roadDistance([], 0, 0); } catch { threw = true; }
  say(threw, 'KNOWN-BAD: an empty segment list THROWS rather than returning Infinity');

  // 2. The classifier, on three synthetic rows. Two of the three have zero busts, which is the
  //    whole reason this is a classification and not a column.
  say(classify({ busts: 1, stars: 0 }) === 'arrested', 'a bust is an arrest');
  say(classify({ busts: 0, stars: 0 }) === 'escaped', 'no bust and no stars is an ESCAPE');
  say(classify({ busts: 0, stars: 4 }) === 'stalemate', 'no bust and stars still up is the band');
  say(classify({ busts: 0, stars: 0 }) !== 'stalemate',
    'KNOWN-BAD: a successful escape is NOT counted as a stalemate — the defect would read as ' +
    'present wherever the police work');

  // 3. bandOf over rows that contain no stalemate must say so rather than returning a band of one
  //    arbitrary row. A tool that always finds its own defect has found nothing.
  say(bandOf([{ busts: 1, stars: 0, roadD: 5 }, { busts: 0, stars: 0, roadD: 200 }]) === null,
    'KNOWN-BAD: a sweep with no stalemate row returns no band');
  const b = bandOf([{ busts: 0, stars: 4, roadD: 38 }, { busts: 0, stars: 4, roadD: 137 },
    { busts: 1, stars: 0, roadD: 8 }]);
  say(b && b.lo === 38 && b.hi === 137 && b.n === 2,
    'and a sweep with two reports their span', b ? `${b.lo}..${b.hi}, n=${b.n}` : 'null');

  // 4. The two constants this tool exists to compare. Asserted as a RELATION, because the
  //    numbers themselves are each other module's to choose — what is not either module's to
  //    choose is whether a gap between them is left unhandled.
  const probe = new Session({ seed: 1, peds: 0, traffic: 0 });
  const reach = probe.pursuit.reachRadius;
  say(Math.abs(reach - Math.max(probe.pursuit.holdRadius, RUN_SPEED * BUST_HOLD_S)) < 1e-9,
    'the arrest reach is still max(holdRadius, RUN_SPEED * BUST_HOLD_S)',
    `${reach.toFixed(2)} m`);
  const spots = RESPONSE.slice(1).map((r) => r.spotRadius);
  say(spots.every((s) => s > 0), 'every star level declares a spot radius', spots.join(', '));
  console.log(`    spot radius over the arrest reach, by star: ` +
    spots.map((s) => (s / reach).toFixed(2)).join(', '));
  say(spots.some((s) => s > reach),
    'at least one star level can SEE further than an arrest can REACH, which is the gap this ' +
    'tool measures', `widest ${Math.max(...spots)} m against ${reach.toFixed(2)} m`);

  console.log(`\nSELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

sweep({ stars: flagVal('--stars', 4), seconds: flagVal('--seconds', 240) });
