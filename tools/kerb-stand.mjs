// Does anything stand in the road? Every lamp post, signal mast, utility pole, sign post and
// pavement prop in the district, against the kerb face the streamer draws (#132).
//
//   node tools/kerb-stand.mjs
//   node tools/kerb-stand.mjs --selftest
//
// WHY THIS EXISTS. src/kerb.js widened every kerbed street by 2.74 m — a parking lane, a gutter
// pan and a kerb — and its header says "every lamp, bin, bench, planter and signal still stands
// on the flat pad". That was true of the furniture's kerb ROW and of nothing placed anywhere
// else. Against the drawn face, before this gate:
//
//     lamp posts      472 of 543 in front of it, all at -1.10 m (district/main.js's w/2 + 1.4)
//     signal masts    199 of 237: 108 at -1.15 (w/2 + 1.35), the rest up to 3.8 m out in a
//                     junction, in front of the corner return
//     utility poles    84 of 140 at -1.00 (w/2 + 1.5)
//     sign posts      every stop, one-way and parking plate (w/2 + 1.1 and 1.3), which kerb.js's
//                     own header had noted were now "sunk 10 mm" in its parking lane
//     pavement props  about 250 bollards, meters, bins, trees and the rest, at corners and run ends
//
// Nothing noticed for as long as the kerb existed, because nothing could collide with any of it.
// #126 made the furniture solid and the route follower hit a mast 3 m in front of a corner kerb
// on every lap.
//
// THE CLASSIFIER IS THIS FILE'S OWN, not src/kerb.js's KerbFace, which is what every placer now
// asks: asserting the placers' rule with the placers' query would be the self-validation CLAUDE.md
// records under the shunt-fit ladder. Both read the same plan — that IS the drawn kerb — and the
// selftest pins this one's geometry on synthetic faces, including the case the first version of
// the probe got wrong: a point nearest a VERTEX of a corner return projects outside both segments
// that meet there, and an unclamped projection reported such masts as having no kerb at all.
//
// AND THE LAMPS AS A SYSTEM (#135, #137), because this file already builds the page's lamps and
// owns their accounting:
//   - every arm over its roadway, read off the instance matrices and the head mesh's own buffer:
//     the outer globe nearer its OWN carriageway than the post by the arm's length, and in front of
//     its own street's drawn kerb face, the inner globe behind it. Before #135, 509 of 509 arms ran
//     along the street; the KNOWN-BAD replays that yaw on the shipped posts.
//   - every station accounted for, overflow included, which the module used to fold into `placed`.
//   - how much of the street has a lamp within the spacing on EACH side (`lampCoverage`), and the
//     side split. Before #137 the per-segment loop lit both sides of 25.5% of the street, neither of
//     26.1%, and stood 73.3% of its lamps on side +1; the KNOWN-BAD replays it from its expression,
//     at its pre-#132 line. The 509 the build shipped after #132's refusals measured worse through
//     the same function: 22.0% both, 29.0% neither, 72.7% on +1 (docs/BACKLOG.md #137).
// Both instruments are pure functions with selftest arms on synthetic streets.
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { planKerbs, KERB, kerbedEdge } from '../src/kerb.js';
import { StreetFurniture, LAMP_POOL, LAMP_ARM, LAMP_SPACING, LAMP_HEAD_Y, __kit } from '../src/streetfurniture.js';
import { planStreetSignage } from '../src/signage.js';

const SELFTEST = process.argv.includes('--selftest');
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
};

/** The kerb's own section: the face is panOuter past the ribbon edge, the back chamfer's toe backOuter. */
const FACE = KERB.panOuter;
const BACK = KERB.backOuter - KERB.panOuter;
// 8 m, as src/kerb.js's own reach and for the same reason: a junction's corner apron reaches 5.4 m
// in front of its return, and the first version's 4 m let a mast 4.08 m out read as "no kerb".
const REACH = 8;

/**
 * Every face segment of a plan, and a classifier over them: `{ o, d }` for the nearest segment
 * within REACH — `o` metres BEHIND the face, negative in front of it — or null where there is no
 * kerb. `clamp: false` is the known-bad: it skips a segment the point does not project inside.
 */
export function faceClassifier(plan, { clamp = true } = {}) {
  const segs = [];
  const add = (run, ei) => {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      segs.push({ ax: a.ax + a.nx * FACE, az: a.az + a.nz * FACE, bx: b.ax + b.nx * FACE,
        bz: b.az + b.nz * FACE, anx: a.nx, anz: a.nz, bnx: b.nx, bnz: b.nz, ei });
    }
  };
  plan.edgeRuns.forEach((er, ei) => { if (er) for (const side of er) for (const piece of side) add(piece, ei); });
  for (const [, runs] of plan.vertexRuns) for (const run of runs) add(run, -1);
  return {
    segs: segs.length,
    /** The nearest face of any kind; `ei` given, the nearest STRAIGHT face of that edge's own kerb. */
    at(x, z, ei = null) {
      let best = null;
      for (const s of segs) {
        if (ei !== null && s.ei !== ei) continue;
        const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
        if (l2 < 1e-12) continue;
        let t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
        if (!clamp && (t < 0 || t > 1)) continue;
        t = Math.max(0, Math.min(1, t));
        const cx = s.ax + dx * t, cz = s.az + dz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d > REACH || (best && d >= best.d)) continue;
        const nx = s.anx + (s.bnx - s.anx) * t, nz = s.anz + (s.bnz - s.anz) * t;
        const nl = Math.hypot(nx, nz) || 1;
        best = { o: ((x - cx) * nx + (z - cz) * nz) / nl, d, cx, cz, nx: nx / nl, nz: nz / nl };
      }
      return best;
    },
  };
}

/**
 * #135: how much nearer its OWN carriageway a lamp's head hangs than its post stands — the distance
 * from each point to the carriageway edge of the edge the lamp was planned for (nearest segment,
 * less half the road's width), post minus head. An arm square across the street reads its whole
 * length; one along the street reads about nothing; one over the pavement reads minus its length.
 *
 * OWN edge, not the nearest road, and measured, not assumed: against "the nearest carriageway", an
 * arm near a corner is read against the CROSS street. On the first plan that put 128 correct heads
 * under half an arm and credited 114 of the old along-the-street arms with a gain over half; on the
 * shipped one, whose posts keep a corner clear, it still credits 15 of the old arms — the KNOWN-BAD
 * this gate replays would have read partly fixed. CLAUDE.md's "a distance to the nearest X is not a
 * distance to the X the subject belongs to".
 * `pts` is the edge's centreline as {x, z}, `w` its width.
 */
export function ownEdgeGain(pts, w, post, head) {
  const dist = (p) => {
    let best = Infinity;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      let t = l2 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
    }
    return best - w / 2;
  };
  return dist(post) - dist(head);
}

/**
 * #137: HOW MUCH OF THE STREET HAS A LAMP WITHIN THE SPACING ON EACH SIDE. Every edge is sampled
 * every metre of centreline; at each sample, in the local frame of the segment it is on, a side is
 * lit when some post stands on that side (0 < lateral) of THIS street's pavement (lateral within
 * w/2 + PAVE) and within `spacing` along the street. Any post counts, whichever edge placed it, so
 * the lamps of the street continuing across a junction light its end — and a cross street's lamps
 * do not, because they stand further out than any pavement of this one.
 *
 * PAVE is 5 m past the half-width: the post line is w/2 + 2.9 behind a kerb (its back chamfer, 2.74,
 * plus the pole) and w/2 + 1.4 without one, and the nearest a cross street's first lamp stands is
 * that street's own kerb back plus a corner return, ~w'/2 + 7 from its centreline — which is how far
 * it is from THIS street's centreline when it stands at the corner. The gate prints the shipped
 * figure at PAVE 4 and 6 beside it: 83.4 / 85.2 / 86.6%, all far from the bound below.
 *
 * `edges` is [{ pts: [{x, z}], w }], `posts` [{x, z}]. Returns metres of street lit on both sides,
 * one, neither, and per edge the metres lit on each side.
 */
export const PAVE = 5;
export function lampCoverage(edges, posts, spacing, pave = PAVE) {
  const C = 32, grid = new Map();
  posts.forEach((p, i) => {
    const k = `${Math.floor(p.x / C)},${Math.floor(p.z / C)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const out = { total: 0, both: 0, one: 0, none: 0, perEdge: [] };
  for (const { pts, w } of edges) {
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    const L = cum[cum.length - 1];
    const row = { L, lit: { [1]: 0, [-1]: 0 } };
    out.perEdge.push(row);
    if (L < 1e-6) continue;
    const M = Math.max(1, Math.ceil(L)), dw = L / M;
    for (let j = 0; j < M; j++) {
      const s = (j + 0.5) * dw;
      let k = 1;
      while (k < pts.length - 1 && cum[k] < s) k++;
      const a = pts[k - 1], b = pts[k], l = (cum[k] - cum[k - 1]) || 1e-9, t = (s - cum[k - 1]) / l;
      const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
      const tx = (b.x - a.x) / l, tz = (b.z - a.z) / l;
      const lit = { [1]: false, [-1]: false };
      const gx = Math.floor(cx / C), gz = Math.floor(cz / C);
      for (let u = -1; u <= 1; u++) {
        for (let v = -1; v <= 1; v++) {
          for (const i of grid.get(`${gx + u},${gz + v}`) ?? []) {
            const dx = posts[i].x - cx, dz = posts[i].z - cz;
            const along = dx * tx + dz * tz, lat = dx * -tz + dz * tx;
            if (Math.abs(along) > spacing || lat === 0 || Math.abs(lat) > w / 2 + pave) continue;
            lit[lat > 0 ? 1 : -1] = true;
          }
        }
      }
      out.total += dw;
      if (lit[1]) row.lit[1] += dw;
      if (lit[-1]) row.lit[-1] += dw;
      if (lit[1] && lit[-1]) out.both += dw; else if (lit[1] || lit[-1]) out.one += dw; else out.none += dw;
    }
  }
  return out;
}

if (SELFTEST && IS_MAIN) {
  console.log('KERB STAND SELFTEST');
  // A straight kerb along x: the ribbon edge on z = 0, the pavement toward +z, so the face is at
  // z = FACE and the back chamfer's toe at z = KERB.backOuter.
  const straight = [];
  for (let x = -20; x <= 20; x += 5) straight.push({ ax: x, az: 0, nx: 0, nz: 1 });
  const one = (run) => ({ edgeRuns: [[[run], []]], vertexRuns: new Map() });
  const c = faceClassifier(one(straight));
  const lane = c.at(0, 1.4), pad = c.at(0, 3.0), far = c.at(0, 12);
  check('a post at w/2 + 1.4 reads 1.10 m IN FRONT of the face', lane && Math.abs(lane.o + 1.1) < 1e-9,
    lane ? lane.o.toFixed(3) : 'null');
  check('and one at 3.0 reads 0.50 behind it', pad && Math.abs(pad.o - 0.5) < 1e-9,
    pad ? pad.o.toFixed(3) : 'null');
  check('and nothing 12 m away has a kerb', far === null, JSON.stringify(far));
  // A corner return: a quarter circle of stations, the shape planKerbs emits at a convex corner.
  // A point on the ROAD side of the corner, nearest the arc's middle vertex, projects outside
  // both segments that meet there whenever the arc is coarse enough to have a vertex at all.
  const arc = [];
  const R = 4.5, cx = 0, cz = 0;
  for (let k = 0; k <= 2; k++) {
    const a = (k / 2) * Math.PI / 2;
    const nx = -Math.cos(a), nz = -Math.sin(a);               // outboard, away from the junction
    arc.push({ ax: cx + Math.cos(a) * R - nx * FACE, az: cz + Math.sin(a) * R - nz * FACE, nx, nz });
  }
  // The face's middle point is (R cos45, R sin45); a point 2 m further OUT from the centre is in
  // the junction, in front of the face.
  const px = Math.cos(Math.PI / 4) * (R + 2), pz = Math.sin(Math.PI / 4) * (R + 2);
  const clamped = faceClassifier(one(arc)).at(px, pz);
  const loose = faceClassifier(one(arc), { clamp: false }).at(px, pz);
  check('a point in the junction, nearest a corner return\'s vertex, reads IN FRONT of the face',
    clamped && clamped.o < -1.5, clamped ? `o ${clamped.o.toFixed(3)}` : 'null');
  check('KNOWN-BAD: an unclamped projection finds no kerb there at all',
    loose === null || loose.d > clamped.d + 0.5, JSON.stringify(loose));

  // #135's instrument on a street it can be checked against by hand: a 6 m road along +x, its post
  // 5.9 m out on +z. An arm square across it gains its whole 2.2 m; along it, nothing; over the
  // pavement, minus 2.2. The second is the shipped defect and the third its mirror image.
  const road = [{ x: -60, z: 0 }, { x: 60, z: 0 }];
  const post = { x: 0, z: 5.9 };
  const across = ownEdgeGain(road, 6, post, { x: 0, z: 3.7 });
  const along = ownEdgeGain(road, 6, post, { x: 2.2, z: 5.9 });
  const away = ownEdgeGain(road, 6, post, { x: 0, z: 8.1 });
  check('an arm square across the street reads its whole length toward the carriageway',
    Math.abs(across - 2.2) < 1e-9, across.toFixed(4));
  check('KNOWN-BAD: one along the street reads nothing, and one over the pavement reads minus its length',
    Math.abs(along) < 1e-9 && Math.abs(away + 2.2) < 1e-9, `${along.toFixed(4)}, ${away.toFixed(4)}`);
  // And against its OWN edge, not the nearest road: a cross street 4 m beyond the post is nearer the
  // head of an along-the-street arm than the post is, which is the misreading the gate avoids.
  const cross = [{ x: 6.2, z: -60 }, { x: 6.2, z: 60 }];
  check('the gain is read against the edge it is handed, so a nearer cross street does not move it',
    Math.abs(ownEdgeGain(road, 6, post, { x: 2.2, z: 5.9 })) < 1e-9
      && ownEdgeGain(cross, 6, post, { x: 2.2, z: 5.9 }) > 2,
    `own ${ownEdgeGain(road, 6, post, { x: 2.2, z: 5.9 }).toFixed(3)}, cross ${ownEdgeGain(cross, 6, post, { x: 2.2, z: 5.9 }).toFixed(3)}`);

  // #137's instrument: a 104 m street, w 6, posts every 26 m alternating sides, lights both of its
  // sides end to end; the same five posts all on one side light one side and never both.
  const st = [{ pts: [{ x: 0, z: 0 }, { x: 104, z: 0 }], w: 6 }];
  const alt = [0, 26, 52, 78, 104].map((x, k) => ({ x, z: k % 2 ? -5.9 : 5.9 }));
  const same = [0, 26, 52, 78, 104].map((x) => ({ x, z: 5.9 }));
  const cA = lampCoverage(st, alt, 26), cS = lampCoverage(st, same, 26);
  check('posts every 26 m, sides alternating, light both sides of every metre',
    Math.abs(cA.both - 104) < 1e-6 && cA.one === 0, `both ${cA.both.toFixed(1)} of ${cA.total.toFixed(1)} m`);
  check('KNOWN-BAD: the same posts all on one side light one side and never both',
    cS.both === 0 && Math.abs(cS.one - 104) < 1e-6 && cS.perEdge[0].lit[-1] === 0,
    `both ${cS.both.toFixed(1)}, one ${cS.one.toFixed(1)}, side -1 ${cS.perEdge[0].lit[-1]}`);
  // A post on ANOTHER street's pavement 30 m away, and one 27 m along: neither lights this street.
  const far1 = lampCoverage(st, [{ x: 52, z: 30 }], 26), far2 = lampCoverage(st, [{ x: 131, z: 5.9 }], 26);
  check('and a post off this street\'s pavement, or beyond the spacing, lights none of it',
    far1.both + far1.one === 0 && far2.both + far2.one === 0,
    `lateral 30 m: ${far1.one.toFixed(1)} m; 27 m along: ${far2.one.toFixed(1)} m`);
  const failed = checks.filter((k) => !k.ok);
  console.log(`\nKERB STAND SELFTEST: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

if (!SELFTEST && IS_MAIN) {
  const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
  console.log('KERB STAND — does anything stand in the road?');
  console.log('='.repeat(78));
  const t0 = performance.now();
  const plan = planKerbs(district);
  const cls = faceClassifier(plan);
  // The furniture exactly as district/main.js builds it: the lamps, then the dress pass with the
  // crowd's audit and the shop frontage on.
  const fu = new StreetFurniture(new THREE.Scene(), { max: LAMP_POOL });
  const lamps = fu.placeStreetLamps(district);
  fu.commit();
  fu.dressDistrict(district, { audit: true, auditFoot: true, shopFrontage: true });
  const signs = planStreetSignage(district, {});
  console.log(`  ${cls.segs} face segments; built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  /**
   * Two rules, and they are different because the placers are. A post the module MOVES behind the
   * kerb has to clear the back chamfer with its whole footprint: the lamps, masts, utility poles
   * and sign posts. A prop the dress pass's guard REFUSES in front of the face has to have its
   * centre behind it — the kerb row stands on STATION_LINE, 0.11 m past the chamfer, and its
   * widest bins and news boxes have always overhung it, which is the row's design and not #132.
   */
  const TOL = 0.02;
  const MOVED = new Set(['lamp', 'signal', 'utilityPole']);
  const IN_ROAD = new Set(['gully', 'manhole', 'span']);
  const rows = new Map();
  const row = (k) => rows.get(k) ?? rows.set(k, { n: 0, kerbed: 0, bad: 0, worst: Infinity }).get(k);
  /**
   * A footprint is its OWN POINTS where the module emitted them (`auditFoot`): a footing turned to a
   * corner return reaches the face with its corner, and a box in world axes measures a square at 45
   * degrees as 1.41x itself in every direction, so it cannot tell a footing that clears from one that
   * does not. A round post, which has no points here, is its centre less its radius.
   */
  const tally = (kind, x, z, r, rule, foot = null) => {
    const R = row(kind);
    R.n++;
    const c = cls.at(x, z);
    if (!c) return;
    R.kerbed++;
    let margin;
    if (rule === 'centre') margin = c.o;
    else if (foot && foot.length) {
      margin = Infinity;
      for (const [px, pz] of foot) {
        const q = cls.at(px, pz);
        if (q && q.o - BACK < margin) margin = q.o - BACK;
      }
    } else {
      // A round post: its rim, each point against the face nearest it — near a corner return the
      // centre's nearest face is not the one the rim reaches.
      margin = Infinity;
      for (let k = 0; k < 8; k++) {
        const q = cls.at(x + r * Math.cos(k * Math.PI / 4), z + r * Math.sin(k * Math.PI / 4));
        if (q && q.o - BACK < margin) margin = q.o - BACK;
      }
    }
    if (margin < R.worst) R.worst = margin;
    if (margin < -TOL) R.bad++;
  };
  for (const p of fu.placed) {
    if (IN_ROAD.has(p.kind)) { row(p.kind).n++; continue; }
    // A tree's near half is judged by its tree (#139: the two halves are one verdict), and its own
    // "footprint" is the lowest point of what it draws -- for an oak, the canopy, 2-3 m up and out over
    // the road by design. The tree it belongs to is tallied as a 'tree'; this would be the canopy.
    if (p.kind === 'treeDetail') { row(p.kind).n++; continue; }
    tally(p.kind, p.x, p.z, Math.max(p.rx, p.rz), MOVED.has(p.kind) ? 'footprint' : 'centre', p.foot);
  }
  // The lamps are instanced posts, not emitted geometry: round, and measured on their rim above.
  const footless = fu.placed.filter((p) => MOVED.has(p.kind) && p.kind !== 'lamp'
    && !(p.foot && p.foot.length >= 4)).length;
  check('every moved footing came with its own points, so none was measured by a box',
    footless === 0, `${footless} without`);
  const POST_R = 0.085;          // the sign post's own half-width (src/signage.js streetBladeAssembly)
  for (const [k, list] of [['blade', signs.blades], ['stop', signs.stops], ['oneWay', signs.oneWays],
    ['parkingSign', signs.parking]]) {
    for (const s of list) tally(`sign:${k}`, s.x, s.z, POST_R, 'footprint');
  }
  console.log('\n  kind                 n   near a kerb   in the road   worst margin (m)');
  for (const [k, R] of [...rows].sort((a, b) => b[1].n - a[1].n)) {
    const note = IN_ROAD.has(k) ? '   exempt: belongs in the road' : '';
    console.log(`  ${k.padEnd(18)} ${String(R.n).padStart(5)}   ${String(R.kerbed).padStart(9)}   ` +
      `${String(R.bad).padStart(9)}   ${Number.isFinite(R.worst) ? R.worst.toFixed(3).padStart(8) : '       -'}${note}`);
  }

  const lampRow = row('lamp'), sigRow = row('signal'), utRow = row('utilityPole');
  check('every lamp post stands behind the kerb, its base clear of the back chamfer',
    lampRow.kerbed > 400 && lampRow.bad === 0, `${lampRow.bad} of ${lampRow.kerbed} near a kerb`);
  check('every signal mast\'s footing stands behind the kerb, corner masts included',
    sigRow.kerbed > 150 && sigRow.bad === 0, `${sigRow.bad} of ${sigRow.kerbed}`);
  check('every utility pole stands behind the kerb', utRow.kerbed > 50 && utRow.bad === 0,
    `${utRow.bad} of ${utRow.kerbed}`);
  const signRows = [...rows].filter(([k]) => k.startsWith('sign:'));
  const signBad = signRows.reduce((a, [, R]) => a + R.bad, 0);
  const signKerbed = signRows.reduce((a, [, R]) => a + R.kerbed, 0);
  check('every sign post stands behind the kerb: blades, stops, one-way and parking plates',
    signKerbed > 300 && signBad === 0, `${signBad} of ${signKerbed}`);
  const props = [...rows].filter(([k]) => !MOVED.has(k) && !IN_ROAD.has(k) && !k.startsWith('sign:'));
  const propBad = props.reduce((a, [, R]) => a + R.bad, 0);
  const propKerbed = props.reduce((a, [, R]) => a + R.kerbed, 0);
  check('and no pavement prop of any kind stands with its centre in the road',
    propKerbed > 2000 && propBad === 0, `${propBad} of ${propKerbed} near a kerb, ${props.length} kinds`);

  // The rules fired: a gate that reads zero in the road over a build where nothing moved would be
  // reading its own blindness. Printed with the reasons a post or a prop was given up.
  const refused = Object.values(fu.kerbRefused ?? {}).reduce((a, b) => a + b, 0);
  console.log(`\n  lamps: ${lamps.placed} placed of ${lamps.planned} stations, ${lamps.behind} moved behind the kerb, `
    + `${lamps.redundant} on a side already lit, ${lamps.dropped} with no usable spot, ${lamps.refused} refused, `
    + `${lamps.overflow} past the pool of ${LAMP_POOL}`);
  console.log(`  signs: ${signs.kerb.moved} moved behind the kerb, ${signs.kerb.refused} with no room`);
  console.log(`  the dress pass refused ${refused} props standing in the road: ${JSON.stringify(fu.kerbRefused)}`);
  check('the placers moved posts, and the guard refused props — the rules ran',
    lamps.behind > 400 && signs.kerb.moved > 300 && refused > 100,
    `${lamps.behind} lamps, ${signs.kerb.moved} signs, ${refused} props`);
  /**
   * EVERY STATION IS ACCOUNTED FOR, AND NONE IS HIDDEN. This check used to read `placed + refused ===
   * behind + refused + (placed - behind)`, which is true of any four numbers, beside a `heads.length
   * === placed` that the module guaranteed by counting `placed` whether addLamp() drew the lamp or
   * returned null past the pool. Now `overflow` is its own column, so the identity can fail, the
   * pool is asserted to hold the whole plan, and the instance count is read off the meshes.
   */
  const sum = lamps.placed + lamps.redundant + lamps.dropped + lamps.refused + lamps.overflow;
  check('every lamp station is placed, skipped as lit, dropped, refused or past the pool — and none is past it',
    sum === lamps.planned && lamps.overflow === 0 && LAMP_POOL >= lamps.planned
      && lamps.heads.length === lamps.placed && fu.poles.count === lamps.placed && fu.heads.count === lamps.placed,
    `${lamps.placed} + ${lamps.redundant} + ${lamps.dropped} + ${lamps.refused} + ${lamps.overflow} = ${sum} of `
      + `${lamps.planned}; pool ${LAMP_POOL}; ${fu.poles.count} instances drawn`);
  {
    // KNOWN-BAD: the same plan into a pool too small for it. The lamps it cannot hold must come out
    // as `overflow`, not as a `placed` count the meshes do not draw.
    const small = new StreetFurniture({ add() {} }, { max: 1000 });
    const r = small.placeStreetLamps(district);
    check('KNOWN-BAD: the same plan into a pool of 1,000 reads its overflow rather than hiding it',
      r.overflow === lamps.placed - 1000 && r.placed === 1000 && small.poles.count === 1000
        && r.placed + r.redundant + r.dropped + r.refused + r.overflow === r.planned,
      `placed ${r.placed}, overflow ${r.overflow}, ${small.poles.count} drawn`);
  }

  /**
   * KNOWN-BAD: the lamp line as it was, w/2 + 1.4 off the centreline. The pre-#132 placement is
   * replayed here from the recorded expression rather than from the module, because the module no
   * longer has it — and the classifier must see that line in the road, or a zero above is a zero
   * about nothing.
   */
  let oldFront = 0, oldKerbed = 0;
  for (const e of district.edges) {
    if (e.r > 6) continue;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 26);
      for (let s = 1; s <= n; s++) {
        const f = s / (n + 1), side = s % 2 ? 1 : -1;
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len, off = (e.w / 2 + 1.4) * side;
        const c = cls.at(a.x + (b.x - a.x) * f + nx * off, a.z + (b.z - a.z) * f + nz * off);
        if (!c) continue;
        oldKerbed++;
        if (c.o < 0) oldFront++;
      }
    }
  }
  check('KNOWN-BAD: the old lamp line, w/2 + 1.4, reads in front of the face on nearly every kerbed street',
    oldFront > 400 && oldFront / oldKerbed > 0.95, `${oldFront} of ${oldKerbed}`);

  /**
   * #135: EVERY ARM OVER ITS ROADWAY, MEASURED OFF WHAT IS DRAWN. The post is each pole instance's
   * origin; the two globes are the head mesh's own buffer — its vertices split by side of the post,
   * each cluster's centre — taken through the same instance matrix, so no fixture dimension is typed
   * here. Three readings:
   *   - against its OWN edge (`ownEdgeGain`): the outer globe nearer the carriageway than the post by
   *     the arm's length, and the inner one further from it;
   *   - against the KERB FACE, by this file's own classifier and with no edge bookkeeping at all: on
   *     a kerbed street the outer globe hangs in front of the face, over the road, and the inner one
   *     behind it, over the pavement;
   *   - and the emitter the page hands its LightPool (placeStreetLamps' `heads`) is the outer globe
   *     that is drawn, not a point computed beside it.
   * KNOWN-BAD: the loop's own yaw before #135, atan2(-nx * side, -nz * side), on the SAME posts, with
   * the normal and the side read off the geometry (the post's nearest segment of its own edge).
   */
  console.log('\n  #135 — which way every arm points, off the instance matrices');
  const m4 = new THREE.Matrix4(), v3 = new THREE.Vector3();
  // A globe's centre is its POLES' midpoint: a five-sided sphere's bounding box is lopsided across
  // it (its widest ring vertex is at +0.81 r one way and -r the other), and the first version of
  // this read the outer globe's centre 21 mm short of where the sphere is centred.
  const hp = fu.heads.geometry.attributes.position;
  const poles = { o: { top: null, bot: null }, i: { top: null, bot: null } };
  for (let k = 0; k < hp.count; k++) {
    const q = poles[hp.getX(k) > 0 ? 'o' : 'i'], y = hp.getY(k);
    if (!q.top || y > q.top[1]) q.top = [hp.getX(k), y, hp.getZ(k)];
    if (!q.bot || y < q.bot[1]) q.bot = [hp.getX(k), y, hp.getZ(k)];
  }
  const centre = (q) => [(q.top[0] + q.bot[0]) / 2, (q.top[1] + q.bot[1]) / 2, (q.top[2] + q.bot[2]) / 2];
  const OUTER = centre(poles.o), INNER = centre(poles.i);
  const ARM = Math.hypot(OUTER[0], OUTER[2]);
  console.log(`    off the head buffer: outer globe (${OUTER.map((q) => q.toFixed(3)).join(', ')}), `
    + `inner (${INNER.map((q) => q.toFixed(3)).join(', ')}); the arm reaches ${ARM.toFixed(3)} m`);
  const posts = [], outer = [], inner = [];
  let emitterOff = 0;
  for (let i = 0; i < fu.count; i++) {
    fu.poles.getMatrixAt(i, m4);
    v3.set(0, 0, 0).applyMatrix4(m4); posts.push({ x: v3.x, z: v3.z });
    fu.heads.getMatrixAt(i, m4);
    v3.set(...OUTER).applyMatrix4(m4); outer.push({ x: v3.x, y: v3.y, z: v3.z });
    v3.set(...INNER).applyMatrix4(m4); inner.push({ x: v3.x, z: v3.z });
    const h = lamps.heads[i];
    emitterOff = Math.max(emitterOff, Math.hypot(h.x - outer[i].x, h.y - outer[i].y, h.z - outer[i].z));
  }
  check('the emitter the page lights is the outer globe that is drawn, on every lamp',
    // 0.2 mm: the instance matrices are float32, and one float32 step at a district coordinate of
    // 900 m is 6e-5 m — the measured worst is that rounding, an arm misplaced would be metres.
    fu.count === lamps.heads.length && emitterOff < 2e-4 && Math.abs(ARM - LAMP_ARM) < 1e-6,
    `worst ${emitterOff.toExponential(1)} m over ${fu.count}; arm off the buffer ${ARM.toFixed(4)} against LAMP_ARM ${LAMP_ARM}`);
  const edgeOf = (ei) => ({ pts: district.edges[ei].v.map((vi) => district.verts[vi]), w: district.edges[ei].w });
  // The post's nearest segment of its own edge: its normal, and which side of it the post stands.
  const frameOf = (ei, p) => {
    const { pts } = edgeOf(ei);
    let best = null;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1e-9;
      let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (l * l);
      t = Math.max(0, Math.min(1, t));
      const q = Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
      if (!best || q < best.q) best = { q, nx: -dz / l, nz: dx / l, lat: ((p.x - a.x) * -dz + (p.z - a.z) * dx) / l };
    }
    return { ...best, side: best.lat >= 0 ? 1 : -1 };
  };
  const gain = [], gainIn = [], gainOld = [];
  let overRoad = 0, innerBack = 0, kerbedLamps = 0, oldOverRoad = 0, sideAgrees = 0;
  let worst = null;
  lamps.lamps.forEach((L, i) => {
    const { pts, w } = edgeOf(L.ei);
    const f = frameOf(L.ei, posts[i]);
    if (f.side === L.side) sideAgrees++;
    const g = ownEdgeGain(pts, w, posts[i], outer[i]);
    gain.push(g);
    gainIn.push(ownEdgeGain(pts, w, posts[i], inner[i]));
    if (!worst || g < worst.g) worst = { i, ei: L.ei, g, w, at: [posts[i].x.toFixed(1), posts[i].z.toFixed(1)] };
    // KNOWN-BAD: the recorded expression, its inputs taken off the geometry.
    const yawOld = Math.atan2(-f.nx * f.side, -f.nz * f.side);
    const headOld = { x: posts[i].x + Math.cos(yawOld) * ARM, z: posts[i].z - Math.sin(yawOld) * ARM };
    gainOld.push(ownEdgeGain(pts, w, posts[i], headOld));
    // In the frame of the post's OWN street's straight kerb — the nearest face segment `planKerbs`
    // drew for this edge, extended — not each point's nearest face, which near a corner is the cross
    // street's: the first version measured each globe against its own nearest face and read heads
    // "over the road" of a corner, and the second measured all three against the post's nearest face
    // and found 43 posts whose nearest face was a side street's, the arm square to it. The nearest-X
    // trap twice. Which face is the lamp's own is read off the plan, not off the arm.
    const cp = cls.at(posts[i].x, posts[i].z, L.ei);
    if (cp && cp.o > 0) {
      kerbedLamps++;
      const o = (p) => (p.x - cp.cx) * cp.nx + (p.z - cp.cz) * cp.nz;
      if (o(outer[i]) < 0) overRoad++;
      if (o(inner[i]) > cp.o) innerBack++;
      if (o(headOld) < 0) oldOverRoad++;
    }
  });
  const sorted = (a) => [...a].sort((p, q) => p - q);
  const med = (a) => sorted(a)[a.length >> 1];
  const gs = sorted(gain), go = sorted(gainOld);
  console.log(`    outer globe nearer its own carriageway than the post: min ${gs[0].toFixed(3)}, median ${med(gain).toFixed(3)}, `
    + `max ${gs[gs.length - 1].toFixed(3)} m; inner globe ${med(gainIn).toFixed(3)}`);
  console.log(`    KNOWN-BAD, the old yaw on the same posts: min ${go[0].toFixed(3)}, median ${med(gainOld).toFixed(3)}, `
    + `max ${go[go.length - 1].toFixed(3)} m`);
  console.log(`    the least: lamp ${worst.i} on edge ${worst.ei} (w ${worst.w}) at (${worst.at}), ${worst.g.toFixed(3)} m`);
  check('every lamp\'s outer globe hangs nearer its own carriageway than its post, by the arm\'s length',
    gs[0] >= ARM / 2 && Math.abs(med(gain) - ARM) < 1e-3,
    `${gs.filter((g) => g >= ARM / 2).length} of ${gain.length} gain at least half the arm; least ${gs[0].toFixed(3)}, `
      + `median ${med(gain).toFixed(3)} m`);
  check('and its inner globe hangs further from it than the post: over the pavement',
    sorted(gainIn)[gainIn.length - 1] < 0, `max ${sorted(gainIn)[gainIn.length - 1].toFixed(3)} m`);
  check('against its own street\'s drawn kerb: the outer globe in front of the face, the inner behind the post',
    kerbedLamps > 800 && overRoad === kerbedLamps && innerBack === kerbedLamps,
    `outer over the road ${overRoad}, inner behind ${innerBack}, of ${kerbedLamps} lamps behind a kerb`);
  check('KNOWN-BAD: the old yaw on the same posts runs every arm along the street — none gains half its length',
    go.filter((g) => g >= ARM / 2).length === 0 && Math.abs(med(gainOld)) < 0.01 && oldOverRoad < kerbedLamps / 20,
    `${go.filter((g) => g >= ARM / 2).length} of ${gainOld.length} gain half the arm; median ${med(gainOld).toFixed(3)} m; `
      + `${oldOverRoad} of ${kerbedLamps} heads over the road`);
  check('and the placer\'s side for every lamp is the side its post stands on', sideAgrees === lamps.lamps.length,
    `${sideAgrees} of ${lamps.lamps.length}`);

  /**
   * NO POST STANDS NEARER SOMEBODY ELSE'S ROAD THAN ITS OWN. A post beside an unkerbed road keeps a
   * clearance from that road's carriageway, measured here off the posts themselves (their median),
   * and no post may stand nearer any OTHER unkerbed carriageway than that. A kerbed road's own kerb
   * already keeps every post behind it — the checks above. The placer's first plan stood posts 0.26
   * and 0.40 m off a narrow one-way carriageway at a fork, which route-drive's follower hit; with its
   * corner clearance in place route-drive's course passes none of the rest, and without this census
   * `lamp-line-carriageway` came back MISSED while it stood 10 posts within 1.4 m of another road,
   * the nearest 0.19 m off it. Measured with this file's own segment distance, not the placer's rule.
   */
  const segDistXZ = (x, z, a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    let t = l2 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
  };
  const roadClear = (p, ei) => {
    const e = district.edges[ei];
    let best = Infinity;
    for (let k = 1; k < e.v.length; k++) best = Math.min(best, segDistXZ(p.x, p.z, district.verts[e.v[k - 1]], district.verts[e.v[k]]));
    return best - e.w / 2;
  };
  const ownUnkerbed = [];
  lamps.lamps.forEach((L, i) => { if (!kerbedEdge(district.edges[L.ei])) ownUnkerbed.push(roadClear(posts[i], L.ei)); });
  const ownRef = sorted(ownUnkerbed)[ownUnkerbed.length >> 1];
  let nearOther = 0, nearest = { c: Infinity };
  lamps.lamps.forEach((L, i) => {
    district.edges.forEach((o, oi) => {
      if (oi === L.ei || kerbedEdge(o)) return;
      const c = roadClear(posts[i], oi);
      if (c < ownRef - 1e-3) nearOther++;
      if (c < nearest.c) nearest = { c, i, oi };
    });
  });
  console.log(`    an unkerbed road's own posts stand ${ownRef.toFixed(3)} m off its carriageway (median of ${ownUnkerbed.length}); `
    + `the nearest any post stands to ANOTHER unkerbed carriageway is ${nearest.c.toFixed(3)} m (lamp ${nearest.i}, edge ${nearest.oi})`);
  check('and no post stands nearer another unkerbed road\'s carriageway than unkerbed posts stand to their own',
    ownUnkerbed.length > 50 && nearOther === 0, `${nearOther} posts nearer than ${ownRef.toFixed(3)} m; nearest ${nearest.c.toFixed(3)} m`);

  /**
   * #137: THE STREET, LIT ON BOTH SIDES. `lampCoverage` over every drivable edge (r <= 6, the
   * placer's own filter) with the posts read off the pole instances — any post, from any edge. The
   * side split is per lamp, its side read off the geometry (the sign of its post's offset from its
   * own edge), and printed two-way and one-way apart: the left of a one-way carriageway is often a
   * median with no room for a post, so that split is geometry and the two-way one is the rule's.
   *
   * KNOWN-BAD: the per-segment loop, `floor(len / 26)` lamps a SEGMENT alternating by `s % 2`,
   * replayed from its recorded expression at its nominal w/2 + 1.4, through the same measure.
   */
  console.log('\n  #137 — how much of the street has a lamp within the spacing on each side');
  const drivable = [];
  district.edges.forEach((e, ei) => { if (e.r <= 6) drivable.push({ ei, ...edgeOf(ei), o: e.o }); });
  const cov = lampCoverage(drivable, posts, LAMP_SPACING);
  const pct = (a, b) => (100 * a / b).toFixed(1);
  const oneSided = (c) => c.perEdge.filter((r) => (r.lit[1] > 0) !== (r.lit[-1] > 0)).length;
  console.log(`    ${posts.length} posts over ${cov.total.toFixed(0)} m of street: both sides ${pct(cov.both, cov.total)}%, `
    + `one ${pct(cov.one, cov.total)}%, neither ${pct(cov.none, cov.total)}%; ${oneSided(cov)} edges lit on one side only`);
  for (const pv of [4, 6]) {
    const c = lampCoverage(drivable, posts, LAMP_SPACING, pv);
    console.log(`      the same with PAVE ${pv}: both sides ${pct(c.both, c.total)}%`);
  }
  const split = { two: [0, 0], one: [0, 0] };
  lamps.lamps.forEach((L, i) => {
    const f = frameOf(L.ei, posts[i]);
    split[district.edges[L.ei].o ? 'one' : 'two'][f.side > 0 ? 0 : 1]++;
  });
  const share = (q) => q[0] / (q[0] + q[1]);
  console.log(`    sides +1 / -1: two-way streets ${split.two.join(' / ')} (${(100 * share(split.two)).toFixed(1)}% on +1), `
    + `one-way ${split.one.join(' / ')} (${(100 * share(split.one)).toFixed(1)}%)`);
  const oldPosts = [];
  let oldPlus = 0, oldMinus = 0;
  for (const e of district.edges) {
    if (e.r > 6) continue;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 26);
      for (let s = 1; s <= n; s++) {
        const f = s / (n + 1), side = s % 2 ? 1 : -1;
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len, off = (e.w / 2 + 1.4) * side;
        oldPosts.push({ x: a.x + (b.x - a.x) * f + nx * off, z: a.z + (b.z - a.z) * f + nz * off });
        if (side > 0) oldPlus++; else oldMinus++;
      }
    }
  }
  const covOld = lampCoverage(drivable, oldPosts, LAMP_SPACING);
  console.log(`    KNOWN-BAD, the per-segment loop: ${oldPosts.length} posts, both sides ${pct(covOld.both, covOld.total)}%, `
    + `one ${pct(covOld.one, covOld.total)}%, neither ${pct(covOld.none, covOld.total)}%; ${oneSided(covOld)} edges lit on `
    + `one side only; ${oldPlus} / ${oldMinus} on +1 / -1 (${pct(oldPlus, oldPlus + oldMinus)}%)`);
  /**
   * The bounds sit between the shipped plan and the defect, and every number on either side of them
   * is deterministic — no RNG reaches the furniture. Measured over the district (lamps, both sides,
   * neither), shipped first:
   *     anchored ends, a side already lit skipped   1,228   85.2%   1.6%
   *     anchored ends, nothing skipped              1,439   86.3%   1.4%
   *     one per gap, centred, short edge two        1,183   75.7%   2.5%
   *     one per gap, centred, short edge one        1,030   67.1%   2.7%
   *     KNOWN-BAD, the per-segment loop               543   25.5%  26.1%
   * 80% fails both centred layouts, which are the measured alternatives this plan was chosen over —
   * so a retune back to one is a restatement here, not a quiet drift — and 3% fails nothing shipped.
   */
  check('the street is lit within the spacing on both sides almost everywhere, and on neither almost nowhere',
    cov.both / cov.total >= 0.80 && cov.none / cov.total <= 0.03,
    `both ${pct(cov.both, cov.total)}% against 80, neither ${pct(cov.none, cov.total)}% against 3`);
  /**
   * AND NO SIDE IS CROWDED. Anchoring both ends of every edge stood lamps 2 to 5 m apart where short
   * edges meet, each edge anchoring its own beside its neighbour's; the placer skips a station whose
   * side already has a lamp within half a spacing. Counted here independently, in each lamp's own
   * street's frame, as pairs of posts on the same side of that street closer than half a spacing:
   * 10 over the shipped plan, none under 3 m, against 225 — 85 of them under 3 m — with the skip
   * removed, which is `mutation-sweep`'s `lamp-skip-off`. 2% sits between the two.
   */
  let crowded = 0;
  {
    const C = 16, grid = new Map();
    posts.forEach((p, j) => {
      const k = `${Math.floor(p.x / C)},${Math.floor(p.z / C)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(j);
    });
    lamps.lamps.forEach((L, i) => {
      const f = frameOf(L.ei, posts[i]), w = district.edges[L.ei].w;
      const gx = Math.floor(posts[i].x / C), gz = Math.floor(posts[i].z / C);
      for (let u = -1; u <= 1; u++) {
        for (let v = -1; v <= 1; v++) {
          for (const j of grid.get(`${gx + u},${gz + v}`) ?? []) {
            if (j <= i || Math.hypot(posts[j].x - posts[i].x, posts[j].z - posts[i].z) >= LAMP_SPACING / 2) continue;
            const lat = (posts[j].x - posts[i].x) * f.nx + (posts[j].z - posts[i].z) * f.nz + f.lat;
            if (Math.sign(lat) === f.side && Math.abs(lat) <= w / 2 + PAVE) crowded++;
          }
        }
      }
    });
  }
  console.log(`    same-side pairs closer than half a spacing (${LAMP_SPACING / 2} m): ${crowded} of ${posts.length} lamps`);
  check('no side of a street is crowded: same-side pairs closer than half a spacing are under 2% of the lamps',
    crowded < 0.02 * posts.length, `${crowded} pairs, ${pct(crowded, posts.length)}% against 2`);
  check('the sides split evenly on two-way streets, and one-way medians take no more than they do',
    Math.abs(share(split.two) - 0.5) <= 0.03 && Math.abs(share([split.two[0] + split.one[0], split.two[1] + split.one[1]]) - 0.5) <= 0.05,
    `two-way ${(100 * share(split.two)).toFixed(1)}%, all ${(100 * share([split.two[0] + split.one[0], split.two[1] + split.one[1]])).toFixed(1)}% on +1`);
  check('KNOWN-BAD: the per-segment loop leaves most of the street lit on one side or none, its lamps on one side',
    covOld.both / covOld.total < 0.5 && covOld.none / covOld.total > 0.1 && oldPlus / (oldPlus + oldMinus) > 0.7,
    `both ${pct(covOld.both, covOld.total)}%, neither ${pct(covOld.none, covOld.total)}%, ${pct(oldPlus, oldPlus + oldMinus)}% on +1`);

  /**
   * #139: THE LAMPS AGAINST THE PALMS, AND EACH TREE AS ONE TREE. #137's blind review read lamp posts
   * running up palm trunks and globes inside crowns. Measured, it is neither: every head clears every
   * palm crown and every post clears every trunk line. What the census found instead was the tree
   * placer itself: a tree is two emits (the far tier and the near-tier `treeDetail`), each judged
   * against the kerb face on its own footprint, so 5 of the 16 trees refused there still drew their
   * near half -- fronds and boot plates with no trunk -- one accepted tree lost its own, and all 16
   * were counted in `treeSpecies`.
   *
   * The crown is the palm's own parameters (`treeParams`) placed by the frame the dress pass used
   * (`treeSites`): a sphere of the crown's radius R round the trunk top. The head is 2.2 m out over
   * the road at LAMP_HEAD_Y; the post a vertical line to 8.2 m; the trunk the plan segment from base
   * to top, as thick as its own radius plus the pole's.
   */
  const POLE_R = 0.155, POLE_TOP = 8.2;
  const palmsOf = (sites) => sites.map(({ key, f }) => ({ key, f, p: __kit.treeParams(key, f.x, f.z) }))
    .filter(({ p }) => !p.oak).map(({ f, p }) => ({
      bx: f.x, bz: f.z, h: p.trunkH, R: p.R, tr: p.trunkR,
      cx: f.x + p.tiltX * f.ox + p.tiltZ * f.ax, cz: f.z + p.tiltX * f.oz + p.tiltZ * f.az,
    }));
  const segDist = (px, pz, ax, az, bx, bz) => {
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0;
    return Math.hypot(px - (ax + ex * t), pz - (az + ez * t));
  };
  const crownCensus = (palms) => {
    let head = 0, post = 0, trunk = 0, headGap = Infinity, trunkGap = Infinity;
    for (const L of lamps.lamps) {
      for (const q of palms) {
        if (Math.hypot(q.cx - L.x, q.cz - L.z) > q.R + 8) continue;
        const dh = Math.hypot(L.head.x - q.cx, LAMP_HEAD_Y - q.h, L.head.z - q.cz) - q.R;
        const dp = Math.hypot(Math.hypot(L.x - q.cx, L.z - q.cz), Math.max(0, q.h - POLE_TOP)) - q.R;
        const dt = segDist(L.x, L.z, q.bx, q.bz, q.cx, q.cz) - q.tr - POLE_R;
        if (dh < 0) head++;
        if (dp < 0) post++;
        if (dt < 0) trunk++;
        headGap = Math.min(headGap, dh); trunkGap = Math.min(trunkGap, dt);
      }
    }
    return { head, post, trunk, headGap: +headGap.toFixed(2), trunkGap: +trunkGap.toFixed(2) };
  };
  const palms = palmsOf(fu.treeSites ?? []);
  const cc = crownCensus(palms);
  // KNOWN-BAD: the same census with one real palm moved under a real lamp's head.
  const L0 = lamps.lamps[0], s0 = (fu.treeSites ?? []).find(({ key, f }) => !__kit.treeParams(key, f.x, f.z).oak);
  const planted = s0 ? palmsOf([{ key: s0.key, f: { ...s0.f, x: L0.x + 0.8, z: L0.z } }]) : [];
  const ccBad = crownCensus(planted);
  console.log(`\n  #139: ${palms.length} palms against ${lamps.lamps.length} lamps: ${cc.head} heads in a crown, ` +
    `${cc.post} posts through one, ${cc.trunk} through a trunk; nearest head ${cc.headGap} m outside a crown, ` +
    `nearest trunk ${cc.trunkGap} m clear of a post`);
  check('no lamp head is inside a palm crown, and no post runs through a crown or a trunk',
    palms.length > 0 && cc.head === 0 && cc.post === 0 && cc.trunk === 0,
    `${cc.head} / ${cc.post} / ${cc.trunk} over ${palms.length} palms; margins ${cc.headGap} m and ${cc.trunkGap} m`);
  check('KNOWN-BAD: a palm planted 0.8 m from a lamp post is seen by the census',
    ccBad.post + ccBad.trunk + ccBad.head > 0, JSON.stringify(ccBad));
  // Each tree as one tree, paired by IDENTITY (the audit record's tag, the tree's key): every near
  // half has its tree and every tree its near half. Not by footprint: the first version paired within
  // 1.5 m, a radius picked rather than read, and an oak's near tier is its canopy, whose lowest point
  // is 2-3 m up and 1.8-2.0 m off the pit -- two oaks read as orphans of a build that has none.
  const recs = fu.placed ?? [];
  const treesR = recs.filter((r) => r.kind === 'tree'), details = recs.filter((r) => r.kind === 'treeDetail');
  const tTags = new Set(treesR.map((r) => r.tag)), dTags = new Set(details.map((r) => r.tag));
  const orphans = details.filter((d) => d.tag === undefined || !tTags.has(d.tag)).length;
  const bare = treesR.filter((t) => t.tag === undefined || !dTags.has(t.tag)).length;
  const counted = Object.values(fu.treeSpecies ?? {}).reduce((a, b) => a + b, 0);
  console.log(`  trees standing ${treesR.length}, near halves ${details.length}: ${orphans} near halves with no tree, ` +
    `${bare} trees with no near half; ${counted} counted in treeSpecies`);
  check('every tree that stands has its near half, and no near half stands without its tree',
    treesR.length > 0 && orphans === 0 && bare === 0, `${orphans} orphan halves, ${bare} bare trees of ${treesR.length}`);
  check('and the species census counts the trees that stand, not the ones the kerb refused',
    counted === treesR.length, `${counted} counted, ${treesR.length} standing`);

  const failed = checks.filter((k) => !k.ok);
  console.log(`\n${'='.repeat(78)}\n\nKERB STAND: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}
