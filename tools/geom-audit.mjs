// Vertical-continuity audit for placed props.
//
// Three blind critics reported the same class of defect — props that float,
// posts that stop short of the ground, canopies that end in mid-air — and the
// first attempt to dismiss one of them measured the wrong quantity (an awning's
// horizontal PROJECTION, which was correct, instead of its vertical continuity,
// which was not). So this file measures exactly one thing per prop and prints
// the number:
//
//     does the prop's LOWEST vertex reach the surface it stands on?
//
// It runs the real kit helpers from facades.js and signage.js into scratch
// buffers and reads the vertices back, so it cannot drift from the geometry the
// streamer actually builds. box() emits exactly 24 vertices (six quads), which
// is what lets a merged buffer be split back into individual solids.
//
// No browser: this is arithmetic over data/district.json, so it is a cheap gate.
import fs from 'node:fs';
import { streetDirFor as geomStreetDirFor, streetDirsFor as geomStreetDirsFor } from '../src/geom.js';

// signage.js paints its atlases at import-of-first-use, and this audit reads
// VERTEX POSITIONS only — never a pixel and never a UV — so a no-op 2D context
// is a complete substitute here. Positions do not depend on the atlas: the
// helpers take a rect and write it to uv, while pos comes from the footprint.
// Without this the audit could only re-derive the arithmetic by hand, which is
// exactly the kind of second copy that drifts from the geometry it audits.
if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1, height: 1 };
      return (t[k] = (...a) => {
        if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
            k === 'createPattern' || k === 'createConicGradient') return grad;
        if (k === 'getImageData') {
          const w = a[2] | 0 || 1, h = a[3] | 0 || 1;
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        return undefined;
      });
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }),
  };
}
import {
  buildingStyle, buffers, edgesOf, facingEdges, roofUnits, fireEscape, signBlank, awnings,
  awningFabricY, impliedDoor, storefrontBays, lotPlanFor,
} from '../src/facades.js';
import {
  signPlanFor, awning as signAwning, shopRect, planStreetSignage,
  streetBladeAssembly, regulatorySign, wideSign, parkingSign, hasStreetName,
} from '../src/signage.js';

import {
  planKerbs, kerbedEdge, kerbOffsetFor, sectionY, KERB, KERB_REVEAL,
  appendKerbRun, appendKerbFan, appendKerbApron, setForceWinding,
} from '../src/kerb.js';

const TOL = 0.02;                       // 2 cm: below this a joint is a joint
// streaming.js reports ground as groundY (0) but DRAWS the land pad at
// groundY - 0.05 so the road ribbons can stack on it. A post that stops at y = 0
// therefore hovers over the pavement the player sees, which is the quantity that
// matters here.
const GROUND_DRAWN = -0.05;
const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const CHUNK = d.meta.chunkSize;

const keyOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
// The frontage answer, imported from src/geom.js rather than replayed here. It
// used to be a hand-copy of streaming.js's nearest-road-VERTEX search, and when
// that turned out to be backwards on 99 buildings the copy in each tool would
// have gone on measuring a world nobody renders.
const streetDirFor = (b) => geomStreetDirFor(d, b);
const streetDirsFor = (b) => geomStreetDirsFor(d, b, 2);

/**
 * The street elevations the STREAMER builds, which is not the same set as the
 * one this audit used to walk.
 *
 * It asked streetDirFor for a single direction and took facingEdges' 0.35 cone
 * around it. appendBuilding takes streetDirsFor and UNIONS the cones, because a
 * corner site fronts two streets and one direction can only ever admit one of
 * them — the perpendicular elevation dots to ~0 and is dropped. So every prop
 * check in this file — roof units, fire escapes, sign blanks, awning arms,
 * street doors — has been blind to the second elevation of every corner site in
 * the district. An audit that walks a smaller set than the build cannot fail on
 * what it never looks at, which is the quietest way for a gate to be useless.
 */
function streetEdgesFor(b) {
  const dirs = streetDirsFor(b);
  const faces = 2;
  if (!dirs || !dirs.length) {
    const one = streetDirFor(b);
    return one ? facingEdges(b.p, one[0], one[1], { minLen: 4, max: faces })
      : edgesOf(b.p, { minLen: 4, longest: faces });
  }
  const seen = new Map();
  for (const dir of dirs) {
    for (const e of facingEdges(b.p, dir[0], dir[1], { minLen: 4, max: faces })) {
      if (!seen.has(e.i)) seen.set(e.i, e);
    }
  }
  return [...seen.values()].sort((x, y) => y.len - x.len)
    .slice(0, dirs.length > 1 ? faces + 1 : faces);
}
// streaming.js _capStyle, replayed: an audit that used a different style than
// the streamer would be auditing a world nobody renders.
// The cap was a hand copy of StreamingWorld._capStyle. It is now imported from
// the module they both read, so this audit cannot go on checking the geometry of
// a rule the streamer has stopped applying - which it would have done silently,
// and which is the whole failure mode an audit exists to prevent.
import { capStyle } from '../src/build-cost.js';

// Split a buffer written only by box() back into its solids. box() emits six
// quads = 24 vertices, so solid boundaries fall on multiples of 24.
function solids(buf) {
  const out = [];
  for (let v = 0; v + 24 <= buf.pos.length / 3; v += 24) {
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = v; i < v + 24; i++) {
      const x = buf.pos[i * 3], y = buf.pos[i * 3 + 1], z = buf.pos[i * 3 + 2];
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    out.push({ y0, y1, x0, x1, z0, z1 });
  }
  return out;
}
const minY = (buf) => {
  let m = Infinity;
  for (let i = 1; i < buf.pos.length; i += 3) if (buf.pos[i] < m) m = buf.pos[i];
  return m;
};

// A prop is supported if its own base reaches the host surface, or if it lands
// on the top of another solid it overlaps in plan. A rooftop condenser standing
// on its own 0.24 m curb is supported; the same box with nothing under it is
// not. Testing only "base == host" would flag every legitimate stack, which is
// how a real gap gets lost in the noise and dismissed.
function unsupported(list, hostY) {
  const bad = [];
  for (const s of list) {
    if (s.y0 <= hostY + TOL) continue;
    const rests = list.some((o) => o !== s &&
      o.y1 >= s.y0 - TOL && o.y0 < s.y0 - TOL &&
      Math.min(s.x1, o.x1) - Math.max(s.x0, o.x0) > 0 &&
      Math.min(s.z1, o.z1) - Math.max(s.z0, o.z0) > 0);
    if (!rests) bad.push(s);
  }
  return bad;
}

const fail = [];
const note = (kind, id, gap, detail) => fail.push({ kind, id, gap: +gap.toFixed(3), ...detail });
const stat = { roofUnits: 0, fireEscapes: 0, signBlanks: 0, awningsFacKit: 0, awningsSig: 0, doorsImplied: 0, streetPosts: 0 };
let worstRoof = 0, worstArm = 0, worstFE = 0, worstBlank = 0;

for (let bi = 0; bi < d.buildings.length; bi++) {
  const b = d.buildings[bi];
  const style = capStyle(buildingStyle(b), b);
  const h = b.h ?? 6;
  const street = streetDirFor(b);
  const streetEdges = streetEdgesFor(b);

  // --- roof mechanical: every unit must sit ON the roof slab at y = h.
  if (style.roofUnits) {
    const buf = buffers(); buf.col = null;
    roofUnits(b.p, h, buf.pos, buf.nrm, buf.uv, buf.idx, { count: style.roofUnits, seed: style.seed });
    const list = solids(buf);
    stat.roofUnits += list.length;
    for (const s of unsupported(list, h)) {
      const gap = s.y0 - h;
      note('roofUnit', bi, gap, { y0: +s.y0.toFixed(2), roof: h });
      worstRoof = Math.max(worstRoof, gap);
    }
  }

  // --- fire escape. Cantilevered off the wall, so "reaches the ground" is the
  //     wrong test: a real escape's lowest landing hangs with its drop ladder
  //     stowed. Recorded, not failed, so the number is visible without turning
  //     correct architecture into a finding.
  if (style.fireEscape) {
    const buf = buffers(); buf.col = null;
    fireEscape(b.p, buf.pos, buf.nrm, buf.uv, buf.idx,
      { floors: Math.min(style.floors, 6), floorM: style.rec.floorM });
    if (buf.pos.length) { stat.fireEscapes++; worstFE = Math.max(worstFE, minY(buf)); }
  }

  // --- parapet sign blank: its legs must reach the parapet cap they stand on.
  if (style.signBlank) {
    const y = h + (style.parapet?.height ?? 0);
    const buf = buffers(); buf.col = null;
    signBlank(b.p, y, buf.pos, buf.nrm, buf.uv, buf.idx, {});
    if (buf.pos.length) {
      stat.signBlanks++;
      const gap = minY(buf) - y;
      if (gap > TOL) { note('signBlank', bi, gap, { lowestY: +minY(buf).toFixed(2), cap: +y.toFixed(2) }); worstBlank = Math.max(worstBlank, gap); }
    }
  }

  // --- awnings. The canopy is a barrel from the wall (yTop) to its leading edge
  //     (yFront). Whatever carries it must lie AT OR BELOW the fabric over the
  //     whole projection and must reach the leading edge; a bar that rises above
  //     the fabric is not a bracket, it is a stray tube in the air. Nothing in
  //     the assembly may sit above that surface, because anything that does is
  //     hardware poking through the cloth it is supposed to carry. Measured
  //     against the real emitted vertices, not re-derived: this is the check
  //     that was missed the first time, when only the horizontal projection was
  //     measured and it was correct.
  //
  //     The surface itself comes from facades.js's awningFabricY(), the same
  //     function the geometry is built from, because an audit that carries its
  //     OWN model of the thing it audits is a second copy of the maths and
  //     drifts from it. When the canopy went from a rake to a barrel this line
  //     needed no edit at all — which is the whole point of importing it.
  const checkAwningBuf = (tag, buf, e, yTop, drop, out) => {
    let worst = 0, at = null;
    for (let i = 0; i < buf.pos.length / 3; i++) {
      const x = buf.pos[i * 3], y = buf.pos[i * 3 + 1], z = buf.pos[i * 3 + 2];
      const o = (x - e.a[0]) * e.nx + (z - e.a[1]) * e.nz;      // projection off the wall
      if (o <= 0.03) continue;
      const fabric = awningFabricY(o, yTop, out, drop);
      if (y - fabric > worst) { worst = y - fabric; at = { o: +o.toFixed(2), y: +y.toFixed(2), fabric: +fabric.toFixed(2) }; }
    }
    if (worst > TOL) { note(`awningArm:${tag}`, bi, worst, at); worstArm = Math.max(worstArm, worst); }
  };
  // --- street doors on an UNLOTTED frontage.
  //
  // A lotted frontage takes its door from the lot planner, which already picks
  // the bay it lands in. An unlotted one derives it from impliedDoor(), and a
  // door that misses its bay is a leaf floating in front of a pier -- so the
  // span it returns has to be inside the bay storefront() will actually build,
  // and wide enough to walk through. Both were true of the lot planner by
  // construction and neither is free here.
  if (style.storefront) {
    const lotPlan = lotPlanFor(b.p, style, h, streetEdges);
    for (const e of streetEdges) {
      if (lotPlan.has(e.i)) continue;
      const bays = storefrontBays(e.len, style.storefront);
      const pairs = Math.ceil(bays.length / 2);
      for (let pr = 0; pr < pairs; pr++) {
        const dsp = impliedDoor(style.seed ?? 0, e.i, pr, bays);
        if (!dsp) continue;
        stat.doorsImplied++;
        const inBay = bays.some(([q0, q1]) => dsp[0] >= q0 - 1e-6 && dsp[1] <= q1 + 1e-6);
        if (!inBay) note('doorOffBay', bi, 0, { edge: e.i, span: dsp.map((v) => +v.toFixed(2)) });
        const w = dsp[1] - dsp[0];
        if (w < 0.85) note('doorNarrow', bi, 0.85 - w, { edge: e.i, w: +w.toFixed(3) });
        const leaf = Math.min(2.35, style.storefront.head - 0.5);
        if (leaf < 1.9) note('doorShort', bi, 1.9 - leaf, { edge: e.i, leaf: +leaf.toFixed(2) });
      }
    }
  }

  if (style.storefront) {
    // KIT CHECK, NOT A DISTRICT CENSUS. appendBuilding stopped emitting these
    // (signage.js owns awnings; see the comment there and tools/awning-overlap.mjs),
    // so `awningsFacKit` counts what the exported kit WOULD build if a caller
    // opted in -- the arm-above-fabric gate still has to hold for it. It is not
    // a count of awnings on screen; the district ships zero from this kit.
    if (style.awnings) {
      for (const e of streetEdges) {
        const buf = buffers(); buf.col = null;
        awnings(b.p, buf.pos, buf.nrm, buf.uv, buf.idx,
          { head: style.storefront.head, edges: [e], cell: style.fabric, seed: style.seed });
        if (!buf.pos.length) continue;
        stat.awningsFacKit += Math.max(1, Math.round(e.len / 3.2));
        checkAwningBuf('fac', buf, e, style.storefront.head + 0.35, 0.55, 1.35);
      }
    }
    // `streets` as well as `street`, for the same reason streetEdgesFor exists:
    // the streamer passes both, and a corner site plans tenancies on an
    // elevation a single direction never admits.
    const plan = signPlanFor(b, style, { street, streets: streetDirsFor(b) });
    for (const t of plan.tenants) {
      if (!t.awning) continue;
      stat.awningsSig++;
      const buf = buffers(); buf.col = null;
      signAwning(t.e, t.s0, t.s1, t.head, shopRect('stripe', 0), shopRect('valance', 0),
        buf, null, {});
      checkAwningBuf('sig', buf, t.e, t.head + 0.34, 0.5, 1.3);
    }
  }
}

// ---------------------------------------------------------------------- kerbs
//
// A kerb runs along every street edge in the district, which makes it the prop
// class most able to break every other one: it changes the height of the ground
// under a strip 2.74 m wide on both sides of 21.6 km of street, and everything
// signage.js and streetfurniture.js stand in that strip was placed against a
// flat pad at -0.05.
//
// So the audit gains a SURFACE, not just a check. drawnGroundAt() answers "how
// high is the ground the player sees, here", replaying src/kerb.js's own section
// rather than a second copy of it, and the street-sign check above now measures
// against that instead of against the constant it used to assume.
//
// KERB_AUDIT_FAULT injects a known fault so the gate can be shown to fail:
//   float  the kerb's back edge ends 120 mm ABOVE the pavement it abuts
//   sink   ...120 mm below it
//   road   the crossing cuts are skipped, so kerbs stand across carriageways
//   lane   the parking lane is dropped to the gutter invert, floating the posts
//   wind   the geometric winding test is switched off for a fixed index order,
//          which is the bug that made half the district's kerbs back-facing
// Without it the plan is exactly the one the streamer builds.
const FAULT = process.env.KERB_AUDIT_FAULT || '';
const KERB_PAD_TOL = 0.02;

const kerbPlan = planKerbs(d, { breakAtCrossings: FAULT !== 'road' });
const faultLaneDrop = FAULT === 'lane' ? KERB.invertY - KERB.laneY : 0;
const kerbBackY = KERB.backY + (FAULT === 'float' ? 0.12 : FAULT === 'sink' ? -0.12 : 0);

// Every emitted station, in a coarse grid, so "what is under this point" is a
// nine-cell walk rather than a scan of 4,700 stations per query.
const KCELL = 16;
const kerbCells = new Map();
const kerbSegs = [];
{
  const addRun = (run) => {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      const si = kerbSegs.length;
      kerbSegs.push({ a, b });
      const pts = [a, b].flatMap((p) => [[p.ax, p.az],
        [p.ax + p.nx * KERB.backOuter, p.az + p.nz * KERB.backOuter]]);
      const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
      for (let cz = Math.floor(Math.min(...zs) / KCELL); cz <= Math.floor(Math.max(...zs) / KCELL); cz++) {
        for (let cx = Math.floor(Math.min(...xs) / KCELL); cx <= Math.floor(Math.max(...xs) / KCELL); cx++) {
          const k = cx * 46337 + cz;
          let l = kerbCells.get(k);
          if (!l) kerbCells.set(k, (l = []));
          l.push(si);
        }
      }
    }
  };
  for (const sides of kerbPlan.edgeRuns) {
    if (!sides) continue;
    for (const pieces of sides) for (const run of pieces) addRun(run);
  }
  for (const runs of kerbPlan.vertexRuns.values()) for (const run of runs) addRun(run);
}

/** Perpendicular offset of (x,z) from a station pair's anchor line, or null. */
function offsetOn(seg, x, z) {
  const { a, b } = seg;
  const vx = b.ax - a.ax, vz = b.az - a.az;
  const l2 = vx * vx + vz * vz;
  if (!l2) return null;
  const t = ((x - a.ax) * vx + (z - a.az) * vz) / l2;
  if (t < 0 || t > 1) return null;                  // past an end: another piece owns it
  const px = a.ax + vx * t, pz = a.az + vz * t;
  let nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t;
  const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
  return (x - px) * nx + (z - pz) * nz;
}

// Which ribbons cover a point. Gridded for the same reason everything else here
// is: this is asked a few thousand times.
const RCELL = 24;
const rCells = new Map(), rSegs = [];
for (let ei = 0; ei < d.edges.length; ei++) {
  const e = d.edges[ei];
  for (let i = 1; i < e.v.length; i++) {
    const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
    const si = rSegs.length;
    rSegs.push({ ei, ax: a.x, az: a.z, bx: b.x, bz: b.z, h: e.w / 2 });
    const x0 = Math.min(a.x, b.x) - e.w, x1 = Math.max(a.x, b.x) + e.w;
    const z0 = Math.min(a.z, b.z) - e.w, z1 = Math.max(a.z, b.z) + e.w;
    for (let cz = Math.floor(z0 / RCELL); cz <= Math.floor(z1 / RCELL); cz++) {
      for (let cx = Math.floor(x0 / RCELL); cx <= Math.floor(x1 / RCELL); cx++) {
        const k = cx * 46337 + cz;
        let l = rCells.get(k);
        if (!l) rCells.set(k, (l = []));
        l.push(si);
      }
    }
  }
}
/** How far inside a carriageway (x,z) is, in metres. 0 if outside every one. */
function intoRoad(x, z) {
  const cx = Math.floor(x / RCELL), cz = Math.floor(z / RCELL);
  let worst = 0;
  for (const si of rCells.get(cx * 46337 + cz) ?? []) {
    const s2 = rSegs[si];
    const vx = s2.bx - s2.ax, vz = s2.bz - s2.az, l2 = vx * vx + vz * vz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - s2.ax) * vx + (z - s2.az) * vz) / l2)) : 0;
    const dep = s2.h - Math.hypot(x - (s2.ax + vx * t), z - (s2.az + vz * t));
    if (dep > worst) worst = dep;
  }
  return worst;
}

/**
 * The height of the ground the player sees at (x, z): the kerb section where one
 * is drawn, the road ribbon inside a carriageway, otherwise the drawn land pad.
 *
 * Where two surfaces overlap -- a junction corner, where a section and a ribbon
 * both cover the ground -- the HIGHER one is what is seen, because both are
 * opaque and neither is depth-sorted away.
 */
function drawnGroundAt(x, z) {
  const cx = Math.floor(x / KCELL), cz = Math.floor(z / KCELL);
  let best = null;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      for (const si of kerbCells.get((cx + i) * 46337 + (cz + j)) ?? []) {
        const o = offsetOn(kerbSegs[si], x, z);
        if (o === null || o < -KERB.lap || o > KERB.backOuter) continue;
        let y = sectionY(o);
        if (faultLaneDrop && o > KERB.shoulder && o <= KERB.laneOuter) y += faultLaneDrop;
        if (o >= KERB.topOuter) y = kerbBackY;
        if (best === null || y > best) best = y;
      }
    }
  }
  if (intoRoad(x, z) > 0 && (best === null || KERB.roadY > best)) best = KERB.roadY;
  return best === null ? GROUND_DRAWN : best;
}

{
  const kstat = { runs: 0, stations: 0, arcs: 0 };
  for (const sides of kerbPlan.edgeRuns) {
    if (!sides) continue;
    for (const pieces of sides) for (const run of pieces) { kstat.runs++; kstat.stations += run.length; }
  }
  for (const runs of kerbPlan.vertexRuns.values()) {
    for (const run of runs) { kstat.arcs++; kstat.stations += run.length; }
  }

  // --- 1. the section meets the two surfaces it abuts.
  //
  //     This is the check the brief asks for in as many words: a kerb that
  //     floats or sinks must not pass. The road half has to start ON the ribbon
  //     and the concrete half has to end ON the drawn pavement, because those
  //     are the only two surfaces it can hand over to.
  const startGap = Math.abs(sectionY(-KERB.lap) - (KERB.roadY - KERB.lapDrop));
  if (startGap > 0.005) {
    note('kerbSection', 'ribbon', startGap,
      { sectionY: +sectionY(-KERB.lap).toFixed(4), ribbon: KERB.roadY - KERB.lapDrop });
  }
  const padGap = kerbBackY - GROUND_DRAWN;
  if (Math.abs(padGap) > KERB_PAD_TOL) {
    note('kerbSection', padGap > 0 ? 'floatsAbovePavement' : 'sinksBelowPavement', Math.abs(padGap),
      { backY: +kerbBackY.toFixed(3), pavement: GROUND_DRAWN });
  }
  if (KERB_REVEAL < 0.10 || KERB_REVEAL > 0.15) {
    note('kerbSection', 'reveal', KERB_REVEAL, { reveal: +KERB_REVEAL.toFixed(3), band: [0.10, 0.15] });
  }

  // --- 2. no kerb stands in a carriageway.
  //
  //     A 117 mm face across a road is a wall a car drives into, and it is the
  //     failure the corner arithmetic can actually produce: an acute fork forces
  //     the fillet radius down until the return clips the street it is turning
  //     out of. Every station's FACE and BACK is tested against every ribbon.
  //     Run with KERB_AUDIT_FAULT=road to watch it fail.
  let inRoad = 0, worstInRoad = 0;
  const walk = (run) => {
    for (const st of run) {
      for (const o of [KERB.panOuter, KERB.backOuter]) {
        const dep = intoRoad(st.ax + st.nx * o, st.az + st.nz * o);
        if (dep > 0.15) { inRoad++; worstInRoad = Math.max(worstInRoad, dep); }
      }
    }
  };
  for (const sides of kerbPlan.edgeRuns) {
    if (!sides) continue;
    for (const pieces of sides) for (const run of pieces) walk(run);
  }
  for (const runs of kerbPlan.vertexRuns.values()) for (const run of runs) walk(run);
  if (inRoad) {
    note('kerbInCarriageway', 'stations', worstInRoad, { count: inRoad, worstDepthM: +worstInRoad.toFixed(2) });
  }

  // --- 3. parked cars still reach the ground.
  //
  //     streetfurniture.js builds the parked-car geometry with its wheels at
  //     PAD_Y - 0.02 = -0.070 and parks it at w/2 + 1.30, which is inside the
  //     kerb section. The car body is rigid, so what matters is the height under
  //     each WHEEL, not under the centre. Sinking is what the pad already does
  //     to them (20 mm) and is not a finding; FLOATING is.
  const PARK_OFF = 1.30, CAR_HALF = 0.75, CAR_LEN = 4.9;
  let parkSlots = 0, worstFloat = 0, worstSink = 0, badPark = 0, deepSink = 0;
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    if (!kerbedEdge(e)) continue;
    for (let i = 1; i < e.v.length; i++) {
      const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 14) continue;
      const ax = (b.x - a.x) / len, az = (b.z - a.z) / len;
      for (let t = 11; t < len - 11; t += CAR_LEN + 1.5) {
        for (const side of [1, -1]) {
          const ox = -az * side, oz = ax * side;
          const cxm = a.x + ax * t + ox * (e.w / 2 + PARK_OFF);
          const czm = a.z + az * t + oz * (e.w / 2 + PARK_OFF);
          // streetfurniture.js drops any slot standing within 1.05 m of ANOTHER
          // street's carriageway, so a slot that fails that test is not a slot.
          // Without this line the audit measures cars nobody parks: it reported
          // a 90 mm sink that was entirely slots sitting on a crossing ribbon.
          let clear = 99;
          for (const si of rCells.get(Math.floor(cxm / RCELL) * 46337 + Math.floor(czm / RCELL)) ?? []) {
            const s2 = rSegs[si];
            if (s2.ei === ei) continue;
            const vx = s2.bx - s2.ax, vz = s2.bz - s2.az, l2 = vx * vx + vz * vz;
            const tt = l2 ? Math.max(0, Math.min(1, ((cxm - s2.ax) * vx + (czm - s2.az) * vz) / l2)) : 0;
            clear = Math.min(clear, Math.hypot(cxm - (s2.ax + vx * tt), czm - (s2.az + vz * tt)) - s2.h);
          }
          if (clear < 1.05) continue;
          parkSlots++;
          for (const w of [-CAR_HALF, CAR_HALF]) {
            const off = e.w / 2 + PARK_OFF + w;
            const x = a.x + ax * t + ox * off, z = a.z + az * t + oz * off;
            const gap = KERB.parkY - drawnGroundAt(x, z);      // > 0: the wheel floats
            if (gap > worstFloat) worstFloat = gap;
            if (-gap > worstSink) worstSink = -gap;
            if (gap > 0.04) badPark++;
            if (-gap > 0.04) deepSink++;
          }
        }
      }
    }
  }
  if (badPark) {
    note('parkedCarWheel', 'floats', worstFloat, { count: badPark, worstFloatM: +worstFloat.toFixed(3) });
  }

  // --- 4. how much pavement the section eats. Reported, not failed: a kerb
  //     standing against a building wall is what a narrow pavement looks like,
  //     and walls are opaque, so this is a number to watch rather than a gate.
  let intoBuilding = 0, sampled = 0;
  {
    const BCELL = 24, bCells = new Map();
    for (let bi = 0; bi < d.buildings.length; bi++) {
      const ring = d.buildings[bi].p;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of ring) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let cz = Math.floor(z0 / BCELL); cz <= Math.floor(z1 / BCELL); cz++) {
        for (let cx = Math.floor(x0 / BCELL); cx <= Math.floor(x1 / BCELL); cx++) {
          const k = cx * 46337 + cz;
          let l = bCells.get(k);
          if (!l) bCells.set(k, (l = []));
          l.push(bi);
        }
      }
    }
    const inside = (x, z) => {
      const cx = Math.floor(x / BCELL), cz = Math.floor(z / BCELL);
      for (const bi of bCells.get(cx * 46337 + cz) ?? []) {
        const ring = d.buildings[bi].p;
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
        }
        if (hit) return true;
      }
      return false;
    };
    const sample = (run) => {
      for (const st of run) {
        sampled++;
        if (inside(st.ax + st.nx * KERB.backOuter, st.az + st.nz * KERB.backOuter)) intoBuilding++;
      }
    };
    for (const sides of kerbPlan.edgeRuns) {
      if (!sides) continue;
      for (const pieces of sides) for (const run of pieces) sample(run);
    }
    for (const runs of kerbPlan.vertexRuns.values()) for (const run of runs) sample(run);
  }

  // --- 5. every emitted triangle faces the way its own vertices say it does.
  //
  //     These materials are FrontSide. A quad wound the other way round is not a
  //     visual defect that looks like a defect: it is INVISIBLE, and a street
  //     with a kerb down one side looks like plenty of real streets. That is
  //     what happened - the handedness of (travel, outboard) flips between the
  //     two sides of a street, and half the district's kerbs were being culled.
  //     A before/after profile across the left kerb came back identical while a
  //     whole-frame diff of the same two PNGs showed a 2.7 m band of change on
  //     the right; nothing in any number said "back-facing".
  //
  //     Run with KERB_AUDIT_FAULT=wind to watch it fail.
  {
    const road = { pos: [], nrm: [], uv: [], idx: [] };
    const kerb = { pos: [], nrm: [], uv: [], idx: [] };
    const far = { pos: [], nrm: [], uv: [], idx: [] };
    setForceWinding(FAULT === 'wind');
    const emit = (run) => {
      appendKerbRun(run, road, kerb);
      appendKerbFan(run, road);
      appendKerbApron(run, far);
      appendKerbFan(run, far);
    };
    for (const sides of kerbPlan.edgeRuns) {
      if (!sides) continue;
      for (const pieces of sides) for (const run of pieces) emit(run);
    }
    for (const runs of kerbPlan.vertexRuns.values()) for (const run of runs) emit(run);

    setForceWinding(false);
    let facing = 0, tris = 0, worstArea = 0;
    for (const [name, buf] of [['road', road], ['kerb', kerb], ['far', far]]) {
      const { pos, nrm, idx } = buf;
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
        const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
        const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
        const gl = Math.hypot(gx, gy, gz);
        if (gl < 1e-12) continue;
        tris++;
        const dot = (gx * nrm[a * 3] + gy * nrm[a * 3 + 1] + gz * nrm[a * 3 + 2]) / gl;
        if (dot < 0.001) { facing++; worstArea = Math.max(worstArea, gl / 2); void name; }
      }
    }
    if (facing) {
      note('kerbBackFacing', 'triangles', worstArea,
        { count: facing, of: tris, worstAreaM2: +worstArea.toFixed(4) });
    }
    console.log(`            triangles wound against their own normal: ${facing} of ${tris}` +
      (facing ? `, worst ${worstArea.toFixed(3)} m2` : ''));
  }

  console.log('GEOM-AUDIT  kerb:', JSON.stringify({
    ...kstat, ...kerbPlan.stats,
    revealMm: Math.round(KERB_REVEAL * 1000),
    faceOffsetM: KERB.panOuter,
    fault: FAULT || 'none',
  }));
  console.log(`            back edge ${(padGap * 1000).toFixed(0)} mm from the drawn pavement; ` +
    `stations standing in a carriageway ${inRoad}`);
  console.log(`            parked-car wheels over ${parkSlots} slots: worst float ` +
    `${(worstFloat * 1000).toFixed(0)} mm, worst sink ${(worstSink * 1000).toFixed(0)} mm on ` +
    `${deepSink} of ${parkSlots * 2} wheels (the bare pad already sinks them 20 mm)`);
  console.log(`            back edge inside a building footprint: ${intoBuilding} of ${sampled} ` +
    `stations (${((100 * intoBuilding) / sampled).toFixed(1)}%)`);
}

// --- street signage. EVERY post individually: a district-wide minimum is not a
//     per-post check, and one post reaching the pavement hides every one that
//     does not.
{
  const plan = planStreetSignage(d, {});
  let worstPost = 0;
  // The ground a post stands on is no longer a constant. signage.js sets its
  // plates at w/2 + 1.1 to 1.3, which is INSIDE the kerb section's parking lane,
  // so measuring them against a flat -0.05 would miss exactly the regression a
  // kerb can introduce: a post left hanging over a gutter it did not know about.
  const one = (kind, x, z, fn) => {
    const buf = buffers(); buf.col = null;
    if (fn(buf) === false) return;
    stat.streetPosts++;
    const m = minY(buf);
    const host = drawnGroundAt(x, z);
    if (m > host + TOL) {
      note('streetSignPost', kind, m - host, { lowestY: +m.toFixed(3), ground: +host.toFixed(3) });
      worstPost = Math.max(worstPost, m - host);
    }
  };
  for (const b of plan.blades) {
    const names = b.names.filter(hasStreetName);
    one('blade', b.x, b.z, (buf) => (names.length ? streetBladeAssembly(b.x, b.z, b.yaw, names, buf, null, {}) : false));
  }
  for (const s of plan.stops) one('stop', s.x, s.z, (buf) => regulatorySign(s.x, s.z, s.yaw, 'stop', buf, null, {}));
  for (const o of plan.oneWays) one('oneWay', o.x, o.z, (buf) => wideSign(o.x, o.z, o.yaw, o.key, buf, null, {}));
  for (const p of plan.parking) one('parking', p.x, p.z, (buf) => parkingSign(p.x, p.z, p.yaw, p.key, buf, null, {}));
  console.log('            worst sign post gap above the ground it stands on (m):', worstPost.toFixed(3));
}

const byKind = {};
for (const f of fail) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
console.log('GEOM-AUDIT  props:', JSON.stringify(stat));
console.log('            worst gaps (m): roofUnit', worstRoof.toFixed(2),
  ' lowestFireEscapeLanding', worstFE.toFixed(2), ' signBlank', worstBlank.toFixed(2),
  ' awningArmAboveFabric', worstArm.toFixed(2));
if (!fail.length) { console.log('GEOM-AUDIT: PASS — every prop reaches its host surface'); process.exit(0); }
console.log('GEOM-AUDIT: FAIL —', fail.length, 'props', JSON.stringify(byKind));
for (const f of fail.slice(0, 8)) console.log('   ', JSON.stringify(f));
process.exit(1);
