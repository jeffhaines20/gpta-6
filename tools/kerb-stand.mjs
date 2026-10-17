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
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { planKerbs, KERB } from '../src/kerb.js';
import { StreetFurniture } from '../src/streetfurniture.js';
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
  const add = (run) => {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      segs.push({ ax: a.ax + a.nx * FACE, az: a.az + a.nz * FACE, bx: b.ax + b.nx * FACE,
        bz: b.az + b.nz * FACE, anx: a.nx, anz: a.nz, bnx: b.nx, bnz: b.nz });
    }
  };
  for (const er of plan.edgeRuns) if (er) for (const side of er) for (const piece of side) add(piece);
  for (const [, runs] of plan.vertexRuns) for (const run of runs) add(run);
  return {
    segs: segs.length,
    at(x, z) {
      let best = null;
      for (const s of segs) {
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
        best = { o: ((x - cx) * nx + (z - cz) * nz) / nl, d };
      }
      return best;
    },
  };
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
  const fu = new StreetFurniture(new THREE.Scene(), { max: 1200 });
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
  console.log(`\n  lamps: ${lamps.placed} placed, ${lamps.behind} moved behind the kerb, ${lamps.refused} with no room`);
  console.log(`  signs: ${signs.kerb.moved} moved behind the kerb, ${signs.kerb.refused} with no room`);
  console.log(`  the dress pass refused ${refused} props standing in the road: ${JSON.stringify(fu.kerbRefused)}`);
  check('the placers moved posts, and the guard refused props — the rules ran',
    lamps.behind > 400 && signs.kerb.moved > 300 && refused > 100,
    `${lamps.behind} lamps, ${signs.kerb.moved} signs, ${refused} props`);
  check('and every lamp candidate is accounted for: placed, or refused for want of room',
    lamps.placed + lamps.refused === lamps.behind + lamps.refused + (lamps.placed - lamps.behind)
      && lamps.heads.length === lamps.placed,
    `${lamps.placed} + ${lamps.refused}`);

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

  const failed = checks.filter((k) => !k.ok);
  console.log(`\n${'='.repeat(78)}\n\nKERB STAND: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}
