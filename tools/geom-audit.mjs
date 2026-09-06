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
  awningFabricY,
} from '../src/facades.js';
import {
  signPlanFor, awning as signAwning, shopRect, planStreetSignage,
  streetBladeAssembly, regulatorySign, wideSign, parkingSign, hasStreetName,
} from '../src/signage.js';
import { ribbon } from '../src/geom.js';
import { planKerbs, kerbedEdge, KERB, KERB_REVEAL } from '../src/kerb.js';

const TOL = 0.02;                       // 2 cm: below this a joint is a joint
// streaming.js reports ground as groundY (0) but DRAWS the land pad at
// groundY - 0.05 so the road ribbons can stack on it. A post that stops at y = 0
// therefore hovers over the pavement the player sees, which is the quantity that
// matters here.
const GROUND_DRAWN = -0.05;
const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const CHUNK = d.meta.chunkSize;

const keyOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
function streetDirFor(b) {
  let cx = 0, cz = 0;
  for (const [x, z] of b.p) { cx += x; cz += z; }
  cx /= b.p.length; cz /= b.p.length;
  const chunk = d.chunks[keyOf(cx, cz)];
  if (!chunk || !chunk.edges.length) return null;
  let best = null, bestD = Infinity;
  for (const ei of chunk.edges) for (const vi of d.edges[ei].v) {
    const v = d.verts[vi];
    const dd = (v.x - cx) ** 2 + (v.z - cz) ** 2;
    if (dd < bestD) { bestD = dd; best = v; }
  }
  if (!best) return null;
  const len = Math.hypot(best.x - cx, best.z - cz) || 1;
  return [(best.x - cx) / len, (best.z - cz) / len];
}
// streaming.js _capStyle, replayed: an audit that used a different style than
// the streamer would be auditing a world nobody renders.
function capStyle(style, b) {
  let per = 0;
  for (let i = 0; i < b.p.length; i++) {
    const a = b.p[i], c = b.p[(i + 1) % b.p.length];
    per += Math.hypot(c[0] - a[0], c[1] - a[1]);
  }
  const cost = style.floors * per;
  if (cost > 1400) { style.balconies = false; style.fireEscape = false; }
  if (cost > 1800) style.roofUnits = Math.min(style.roofUnits, 3);
  return style;
}

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
const stat = { roofUnits: 0, fireEscapes: 0, signBlanks: 0, awningsFac: 0, awningsSig: 0, streetPosts: 0 };
let worstRoof = 0, worstArm = 0, worstFE = 0, worstBlank = 0;

for (let bi = 0; bi < d.buildings.length; bi++) {
  const b = d.buildings[bi];
  const style = capStyle(buildingStyle(b), b);
  const h = b.h ?? 6;
  const street = streetDirFor(b);
  const streetEdges = street
    ? facingEdges(b.p, street[0], street[1], { minLen: 4, max: 2 })
    : edgesOf(b.p, { minLen: 4, longest: 2 });

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
  if (style.storefront) {
    if (style.awnings) {
      for (const e of streetEdges) {
        const buf = buffers(); buf.col = null;
        awnings(b.p, buf.pos, buf.nrm, buf.uv, buf.idx,
          { head: style.storefront.head, edges: [e], cell: style.fabric, seed: style.seed });
        if (!buf.pos.length) continue;
        stat.awningsFac += Math.max(1, Math.round(e.len / 3.2));
        checkAwningBuf('fac', buf, e, style.storefront.head + 0.35, 0.55, 1.35);
      }
    }
    const plan = signPlanFor(b, style, { street });
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

// --- street signage. EVERY post individually: a district-wide minimum is not a
//     per-post check, and one post reaching the pavement hides every one that
//     does not.
{
  const plan = planStreetSignage(d, {});
  let worstPost = 0;
  const one = (kind, fn) => {
    const buf = buffers(); buf.col = null;
    if (fn(buf) === false) return;
    stat.streetPosts++;
    const m = minY(buf);
    if (m > GROUND_DRAWN + TOL) {
      note('streetSignPost', kind, m - GROUND_DRAWN, { lowestY: +m.toFixed(3), ground: GROUND_DRAWN });
      worstPost = Math.max(worstPost, m - GROUND_DRAWN);
    }
  };
  for (const b of plan.blades) {
    const names = b.names.filter(hasStreetName);
    one('blade', (buf) => (names.length ? streetBladeAssembly(b.x, b.z, b.yaw, names, buf, null, {}) : false));
  }
  for (const s of plan.stops) one('stop', (buf) => regulatorySign(s.x, s.z, s.yaw, 'stop', buf, null, {}));
  for (const o of plan.oneWays) one('oneWay', (buf) => wideSign(o.x, o.z, o.yaw, o.key, buf, null, {}));
  for (const p of plan.parking) one('parking', (buf) => parkingSign(p.x, p.z, p.yaw, p.key, buf, null, {}));
  console.log('            worst sign post gap above the drawn pavement (m):', worstPost.toFixed(3));
}

// --- the kerb. A prop that floats is one prop; a kerb that floats is 43 km of
//     it, and its failure modes are not a post's. Four things are measured, each
//     a way the kerb could be wrong that a screenshot would not settle:
//
//       1. the section reaches the surfaces it claims to — top to the drawn
//          pavement, approach to the ribbon, invert 100-150 mm under the top,
//          and the parked-car datum under the parked-car axle line;
//       2. the asphalt approach lands ON the carriageway ribbon rather than
//          beside it, measured against the ribbon geometry the streamer emits
//          rather than against the arithmetic that made it;
//       3. corner returns and the straights they belong to MEET — checked with
//          the crossing test off, because a run legitimately cut at an alley
//          mouth is otherwise indistinguishable from a corner that does not join;
//       4. nothing stands in a carriageway. The gutter invert is 205 mm below
//          the road surface, so a kerb crossing a street is a trench under it.
{
  const plan = planKerbs(d);
  const strict = planKerbs(d, { breakAtCrossings: false });
  const kfail = [];
  const knote = (kind, id, v, detail) => kfail.push({ kind, id, v: +v.toFixed(4), ...detail });

  // 1. the section itself.
  if (Math.abs(KERB.padY - GROUND_DRAWN) > 1e-9) {
    knote('kerbDatum', 'padY', KERB.padY - GROUND_DRAWN,
      { kerb: KERB.padY, streamer: GROUND_DRAWN });
  }
  if (KERB.topY < GROUND_DRAWN - TOL) knote('kerbTopSunk', 'section', GROUND_DRAWN - KERB.topY, {});
  if (KERB.topY > GROUND_DRAWN + 0.03) knote('kerbTopFloats', 'section', KERB.topY - GROUND_DRAWN, {});
  if (KERB_REVEAL < 0.10 || KERB_REVEAL > 0.15) knote('kerbReveal', 'section', KERB_REVEAL, {});
  const yAxle = KERB.roadY + (KERB.lipY - KERB.roadY) * (KERB.parkOffset / KERB.laneW);
  if (Math.abs(yAxle - KERB.parkY) > 0.005) {
    knote('parkedCarDatum', 'approach', yAxle - KERB.parkY, { yAxle, want: KERB.parkY });
  }

  // 2. + 4. every emitted station, against its own ribbon and every carriageway.
  const CELL = 24;
  const cells = new Map();
  const segs = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    const h = e.w / 2;
    for (let i = 1; i < e.v.length; i++) {
      const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
      const si = segs.length;
      segs.push({ ei, ax: a.x, az: a.z, bx: b.x, bz: b.z, h });
      for (let cz = Math.floor((Math.min(a.z, b.z) - h) / CELL); cz <= Math.floor((Math.max(a.z, b.z) + h) / CELL); cz++) {
        for (let cx = Math.floor((Math.min(a.x, b.x) - h) / CELL); cx <= Math.floor((Math.max(a.x, b.x) + h) / CELL); cx++) {
          const key = cx * 46337 + cz;
          let l = cells.get(key);
          if (!l) cells.set(key, (l = []));
          l.push(si);
        }
      }
    }
  }
  const inCarriageway = (x, z, skip) => {
    const l = cells.get(Math.floor(x / CELL) * 46337 + Math.floor(z / CELL));
    if (!l) return -1;
    for (const si of l) {
      const g = segs[si];
      if (g.ei === skip) continue;
      const vx = g.bx - g.ax, vz = g.bz - g.az, l2 = vx * vx + vz * vz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - g.ax) * vx + (z - g.az) * vz) / l2)) : 0;
      const dx = x - (g.ax + vx * t), dz = z - (g.az + vz * t);
      if (dx * dx + dz * dz < g.h * g.h) return g.ei;
    }
    return -1;
  };

  // How far OUTSIDE the nearest carriageway the approach's inner edge lands.
  // Negative is a lap over the asphalt and is free; positive is a sliver of
  // brick paving showing between the road and its own kerb, which is the defect.
  // Overlap is not measured as error because two coplanar pieces of the same
  // asphalt are invisible, and demanding they be flush would fail on the miter
  // shortfall at every bend for no visible reason.
  const outsideBy = (x, z) => {
    const l = cells.get(Math.floor(x / CELL) * 46337 + Math.floor(z / CELL));
    let best = Infinity;
    for (const si of l ?? []) {
      const g = segs[si];
      const vx = g.bx - g.ax, vz = g.bz - g.az, l2 = vx * vx + vz * vz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - g.ax) * vx + (z - g.az) * vz) / l2)) : 0;
      const dx = x - (g.ax + vx * t), dz = z - (g.az + vz * t);
      best = Math.min(best, Math.hypot(dx, dz) - g.h);
    }
    return best;
  };

  let stations = 0, worstGap = -Infinity, gaps = 0, inRoad = 0;
  // The ribbon's own height, read off the geometry the streamer emits rather
  // than assumed, so a change to ROAD_Y fails here instead of silently leaving
  // the approach hanging.
  {
    const e = d.edges.find((x) => kerbedEdge(x));
    const rb = { pos: [], nrm: [], uv: [], idx: [] };
    ribbon(e.v.map((vi) => d.verts[vi]), e.w, 0.02, rb.pos, rb.nrm, rb.uv, rb.idx);
    if (Math.abs(rb.pos[1] - KERB.roadY) > 1e-6) {
      knote('kerbApproachHeight', 'ribbon', rb.pos[1] - KERB.roadY, { ribbonY: rb.pos[1] });
    }
  }
  // A straight run's approach must reach the ribbon on its own. A corner
  // return's cannot — it stops 2.2 m short of where the two ribbons cross — so
  // it is floored by a fan from the junction vertex instead, and what is
  // checked there is that the fan exists and that the vertex it fans from is
  // itself on a carriageway. Testing an arc station against a ribbon it is not
  // supposed to touch would fail 1,468 correct stations and hide the real ones.
  let unfannedArcs = 0;
  const walk = (run, ownEdge) => {
    const fanned = run.fanX !== undefined;
    if (fanned && outsideBy(run.fanX, run.fanZ) > 0.001) unfannedArcs++;
    for (const st of run) {
      stations++;
      if (!fanned) {
        const o = st.d + KERB.lap;
        const g = outsideBy(st.x + st.nx * o, st.z + st.nz * o);
        if (g > worstGap) worstGap = g;
        if (g > 0.001) gaps++;
      }
      if (inCarriageway(st.x, st.z, ownEdge) >= 0) inRoad++;
    }
  };
  for (let ei = 0; ei < d.edges.length; ei++) {
    const sides = plan.edgeRuns[ei];
    if (!sides) continue;
    for (const pieces of sides) for (const run of pieces) walk(run, ei);
  }
  for (const runs of plan.vertexRuns.values()) for (const run of runs) walk(run, -1);
  if (gaps > 0) knote('kerbApproachOffRibbon', 'all', worstGap, { gaps, stations });
  if (unfannedArcs > 0) knote('kerbCornerNotFloored', 'all', unfannedArcs, {});
  if (inRoad > 0) knote('kerbInCarriageway', 'all', inRoad, { stations });

  // 3. corner continuity, on the uncut plan.
  const ecell = new Map();
  const ekey = (x, z) => Math.round(x / 2) * 46337 + Math.round(z / 2);
  for (const sides of strict.edgeRuns) {
    if (!sides) continue;
    for (const pieces of sides) for (const r of pieces) {
      for (const p of [r[0], r[r.length - 1]]) {
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const k = ekey(p.x + dx * 2, p.z + dz * 2);
          let l = ecell.get(k);
          if (!l) ecell.set(k, (l = []));
          l.push(p);
        }
      }
    }
  }
  let arcEnds = 0, orphanArcEnds = 0, worstJoin = 0;
  for (const runs of strict.vertexRuns.values()) {
    for (const r of runs) for (const p of [r[0], r[r.length - 1]]) {
      arcEnds++;
      let best = Infinity;
      for (const q of ecell.get(ekey(p.x, p.z)) ?? []) {
        best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
      }
      if (best > 0.05) { orphanArcEnds++; worstJoin = Math.max(worstJoin, Math.min(best, 99)); }
    }
  }
  if (orphanArcEnds > 0) knote('kerbCornerGap', 'junctions', worstJoin, { orphanArcEnds, arcEnds });

  let kerbedEdges = 0;
  for (const e of d.edges) if (kerbedEdge(e)) kerbedEdges++;
  console.log(`GEOM-AUDIT  kerb: reveal ${(KERB_REVEAL * 1000).toFixed(0)} mm, top ` +
    `${((KERB.topY - GROUND_DRAWN) * 1000).toFixed(0)} mm proud of the drawn pavement, ` +
    `${kerbedEdges} kerbed edges, ${stations} stations`);
  console.log(`            approach lands ${(-worstGap * 1000).toFixed(0)} mm inside the ` +
    `carriageway at worst (${gaps} stations short of it); ` +
    `stations standing in a carriageway ${inRoad}; ` +
    `corner returns joined ${arcEnds - orphanArcEnds}/${arcEnds}`);
  for (const f of kfail) fail.push(f);
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
