// The kerb: what makes a pavement read as a pavement and not as differently
// coloured road.
//
// WHY THIS IS ITS OWN MODULE
//
// A blind reviewer measured a profile across a street edge and got a monotonic
// fall from brick to asphalt: no gutter line, no kerb face, no shadow at its
// base. The two surfaces read as coplanar because they very nearly are -- the
// drawn land pad sits at -0.05 and the road ribbon at +0.02, so the pavement is
// 70 mm BELOW the carriageway, which is the wrong way round by about 170 mm.
//
// A kerb runs along EVERY street edge, so it is also one of the most expensive
// things that can be added to this district. The geometry therefore has to be
// planned once and priced exactly. Everything in this file is arithmetic over
// the baked graph with no THREE import, so tools/kerb-cost.mjs and
// tools/geom-audit.mjs run the SAME code offline that the streamer draws --
// rather than keeping a second copy of the maths that drifts from it.
//
// WHAT THE REFERENCE ESTABLISHES  (reference/sarasota/)
//
// mapillary/mly-467303624342265.jpg and mly-4313177338733385.jpg are flat frames
// on Main Street east, the corridor this district's hero camera stands in. Both
// show the same section on the right-hand kerb, reading from the carriageway in:
// dark asphalt, then a PALE CONCRETE gutter pan noticeably brighter than the
// road, then a short kerb face carrying a hard shadow, then the pavement. It is
// Florida DOT Type F kerb-and-gutter -- cast concrete, a real pan rather than
// just a face, and the pan is LIGHTER than the road it edges, which is what puts
// a bright line under the dark one. mly-138921234938875.jpg shows the same
// detail at a side street with the pavement in pale concrete slabs.
// 03-Five-Points shows a pale concrete kerb turning the roundabout island.
//
// So: concrete, not granite; a pan, not a bare face; and the pan reads brighter
// than the asphalt, not darker.
//
// THE THREE DATUMS THIS MAY NOT MOVE, AND WHAT THEY LEAVE
//
//   +0.020  the road ribbon (streaming.js). The vehicle contacts the ground
//           plane at y = 0 and raycastDown() returns 0, so the ribbon is 20 mm
//           of tyre sink. Lowering it floats every wheel in the district.
//   -0.050  the drawn land pad, which is the pavement the player walks on and
//           the surface tools/geom-audit.mjs measures every prop against
//           (GROUND_DRAWN). Raising it buries tree pits and cellar doors.
//   -0.070  the ground the parked-car geometry is built for
//           (streetfurniture.js PAD_Y - 0.02).
//
// A kerb reveal has to come from somewhere, and with the pad pinned it can only
// come from digging a gutter below the pad and standing the kerb top above it.
// The section below does both: it takes 65 mm out of the gutter and puts 62 mm
// on top of the pad, for a 117 mm face -- inside the 100-150 mm a downtown kerb
// actually stands.
//
// WHY THE SECTION IS 2.74 m WIDE, WHICH IS THE PART THAT LOOKS EXPENSIVE
//
// `w` in the bake is lanes x laneWidth: the TRAVELLED way only. The parking lane
// a downtown street carries outboard of it is not in the ribbon at all, which is
// why streetfurniture.js parks its cars at w/2 + 1.30 -- 1.3 m beyond the drawn
// asphalt, on brick pavers. So the widening is not invented width, it is the
// parking lane the graph already assumes and the surface never drew.
//
// Every offset in the section is pinned by something already placed:
//
//   s = 0.55..2.00   parking lane, FLAT at -0.040. Parked cars straddle
//                    s = 0.55..2.05 at y = -0.070, so a flat lane sinks them
//                    23-30 mm -- against the 20 mm they sink into the pad today.
//                    A continuously falling lane (the shape a crowned street
//                    really has) was measured at +-52 mm across the same car and
//                    rejected for it: the car body is rigid.
//   s = 1.10, 1.30   signage.js stands parking plates, one-way plates and stop
//                    signs here, with their bases on the pad at -0.050. The lane
//                    at -0.040 SINKS them 10 mm. geom-audit only fails floats,
//                    and a post sunk 10 mm is a post in the ground.
//   s <= 2.74        the whole assembly stops 0.11 m short of
//                    streetfurniture.js's kerb station line at w/2 + 2.85, so
//                    every lamp, bin, bench, planter and signal still stands on
//                    the flat pad.
//
// Measured over the district: 96.2% of sampled kerb stations have at least
// 2.85 m between the road edge and the nearest building footprint (p5 = 3.46 m),
// so the section fits the pavement it is drawn on almost everywhere.

/**
 * The cross-section, in metres. `o` is measured OUTBOARD from the road ribbon's
 * own edge, toward the pavement; `y` is absolute world height. Read it as a
 * section drawn on paper with the carriageway on the left.
 *
 *   ribbon +0.020 \                                    kerb top +0.012
 *                  \__ shoulder 10.5%                   ___
 *                      \_________________________ ___  |   \__ back chamfer
 *                       parking lane -0.040       \   ||       -0.048  pad -0.05
 *                                          pan 13% \  ||     ______________
 *                                          invert -0.105
 *   o =   -0.06  0.55                        2.00  2.50 2.64 2.74
 */
export const KERB = {
  roadY: 0.020,        // = streaming.js ribbon height. The section starts here.
  padY: -0.050,        // = streaming.js land pad = geom-audit GROUND_DRAWN
  parkY: -0.070,       // = streetfurniture.js PAD_Y - 0.02, parked-car ground

  lap: 0.06,           // road panels start this far INSIDE the ribbon edge...
  lapDrop: 0.002,      // ...and this far under it, so the joint cannot z-fight
  shoulder: 0.55,      // crown break at the edge of the travelled way
  laneY: -0.040,       // parking-lane surface, 10 mm above the pad
  laneOuter: 2.00,     // outer edge of the parking lane
  panOuter: 2.50,      // gutter invert, at the foot of the kerb face
  invertY: -0.105,
  batter: 0.02,        // the face leans back: a cast kerb is never plumb
  topY: 0.012,         // kerb top: 62 mm proud of the pad
  topOuter: 2.64,      // back of the kerb top
  backOuter: 2.74,     // toe of the back chamfer
  backY: -0.048,       // 2 mm above the pad, so the chamfer cannot z-fight it

  cornerR: 4.5,        // corner return radius (15 ft), the downtown standard
  maxTangent: 14,      // cap on the fillet tangent length at an acute fork
  arcStepDeg: 15,      // 38 mm of chord sag on a 4.5 m return: under one pixel
  flatGapDeg: 8,       // a joint this straight needs no corner at all
  blockPad: 0.9,       // clearance kept around a crossing road's carriageway
  sampleM: 1.0,        // resolution the crossing test breaks a run at
  minRun: 0.6,         // shorter than this and there is nothing worth drawing
};

/** Exposed face height: the number the reviewer asked for. */
export const KERB_REVEAL = KERB.topY - KERB.invertY;

/** Distance from a road centreline to the kerb FACE. */
export function kerbOffsetFor(width) { return width / 2 + KERB.panOuter; }

/** Full width of the assembly from the centreline, back chamfer included. */
export function kerbBackFor(width) { return width / 2 + KERB.backOuter; }

/**
 * Which edges carry a kerb.
 *
 * Deliberately the SAME predicate streetfurniture.js `_planParking` uses to
 * decide where cars park (`e.r > 5 || e.w < 5.5` skips): every street with a
 * parking lane gets the kerb that parking lane runs against, and the district's
 * service roads and alleys -- 353 edges of the 935 -- get none, because they
 * have none. 442 edges qualify, 21,602 m of centreline.
 */
export function kerbedEdge(e) { return e.r <= 5 && e.w >= 5.5; }

// ------------------------------------------------------------------- section
//
// Each panel is [o0, y0] -> [o1, y1] walking OUTBOARD, plus its normal in the
// (o, y) plane. With `o` increasing away from the road, the up-and-roadward
// normal of a panel is (-dy, do) normalised: a flat panel gives (0, 1) and the
// kerb face, which rises as it goes outboard, gives a normal that leans back
// over the carriageway. That sign is what makes the face catch a low sun on the
// road side and fall into its own shade when the sun is behind the pavement.

const K = KERB;

function panel(o0, y0, o1, y1) {
  const dO = o1 - o0, dY = y1 - y0;
  const len = Math.hypot(dO, dY) || 1;
  return { o0, y0, o1, y1, nO: -dY / len, nY: dO / len, len };
}

/** The asphalt half: goes in the ROAD mesh, on the road material. */
export const KERB_ROAD = [
  panel(-K.lap, K.roadY - K.lapDrop, K.shoulder, K.laneY),   // shoulder
  panel(K.shoulder, K.laneY, K.laneOuter, K.laneY),          // parking lane
];
/** The concrete half: pan, face, top, back chamfer. One mesh, one material. */
export const KERB_CONCRETE = [
  panel(K.laneOuter, K.laneY, K.panOuter, K.invertY),             // gutter pan
  panel(K.panOuter, K.invertY, K.panOuter + K.batter, K.topY),    // face
  panel(K.panOuter + K.batter, K.topY, K.topOuter, K.topY),       // top
  panel(K.topOuter, K.topY, K.backOuter, K.backY),                // back chamfer
];

/** Surface height at offset `o` from the ribbon edge. For the offline audits. */
export function sectionY(o) {
  const all = [...KERB_ROAD, ...KERB_CONCRETE];
  if (o <= all[0].o0) return all[0].y0;
  for (const p of all) {
    if (o <= p.o1) {
      const f = p.o1 === p.o0 ? 0 : (o - p.o0) / (p.o1 - p.o0);
      return p.y0 + (p.y1 - p.y0) * f;
    }
  }
  return K.padY;
}

// ------------------------------------------------------------------ planning

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * A station on a kerb line: the point at o = 0 (ON the ribbon edge / carriageway
 * datum) plus the unit direction the section walks in. Everything -- straights,
 * corner returns, dead-end caps -- is one of these, so emission never has to
 * know which it is holding.
 */
const station = (ax, az, nx, nz) => ({ ax, az, nx, nz });

/**
 * Offset one baked edge's polyline to its carriageway edge, using EXACTLY the
 * rule geom.js ribbon() uses to place that edge. That is not a stylistic
 * choice: it is what makes the section's inner edge land on the ribbon to the
 * last bit, so the asphalt is continuous and there is no seam to see.
 */
function edgeStations(pts, half, side) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], prev = pts[i - 1] ?? p, next = pts[i + 1] ?? p;
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const ox = side * dz, oz = -side * dx;      // ribbon's `left` is (dz, -dx)
    out.push(station(p.x + ox * half, p.z + oz * half, ox, oz));
  }
  return out;
}

/** Cumulative arc length along a station list. */
function arcLengths(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    s.push(s[i - 1] + Math.hypot(pts[i].ax - pts[i - 1].ax, pts[i].az - pts[i - 1].az));
  }
  return s;
}

/** Station at arc length t, interpolating anchor and normal together. */
function at(pts, s, t) {
  if (t <= s[0]) return { ...pts[0] };
  const last = s.length - 1;
  if (t >= s[last]) return { ...pts[last] };
  let i = 1;
  while (i < last && s[i] < t) i++;
  const f = (t - s[i - 1]) / Math.max(1e-6, s[i] - s[i - 1]);
  const a = pts[i - 1], b = pts[i];
  let nx = a.nx + (b.nx - a.nx) * f, nz = a.nz + (b.nz - a.nz) * f;
  const nl = Math.hypot(nx, nz) || 1;
  return station(a.ax + (b.ax - a.ax) * f, a.az + (b.az - a.az) * f, nx / nl, nz / nl);
}

/** Sub-list between two arc lengths, keeping the interior stations. */
function slice(pts, s, t0, t1) {
  if (t1 - t0 < K.minRun) return null;
  const out = [at(pts, s, t0)];
  for (let i = 0; i < pts.length; i++) if (s[i] > t0 + 1e-3 && s[i] < t1 - 1e-3) out.push(pts[i]);
  out.push(at(pts, s, t1));
  return out.length >= 2 ? out : null;
}

/**
 * A uniform grid over every edge's carriageway, so "is this kerb station
 * standing in another street?" is a nine-cell walk rather than 2,000 segment
 * tests. The kerb MUST break where a road crosses it: an alley mouth is a
 * dropped kerb in the real world, and a 117 mm wall across it if it is not
 * broken here.
 */
function blockerGrid(d) {
  const CELL = 24;
  const cells = new Map();
  const segs = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    // A kerbed street blocks only up to its own kerb face; an alley, which gets
    // no kerb of its own, blocks a little wider so its mouth opens properly.
    const h = kerbedEdge(e) ? kerbOffsetFor(e.w) - 0.05 : e.w / 2 + K.blockPad;
    // A run is not blocked by the street it BELONGS to at the full width -- its
    // own face is 2.5 m outboard of that street's edge by construction. But it
    // must still be blocked by its own CARRIAGEWAY, because an offset polyline
    // folds over itself on the inside of a sharp bend: edges 179 and 180 turn
    // about 82 degrees at a shape point with no radius at all, and the fold put
    // the kerb face 2.4 m from its own centreline, 0.6 m inside its own road.
    // Skipping the own edge entirely -- which the first version did -- is what
    // hid that.
    const ownH = e.w / 2 + 0.15;
    for (let i = 1; i < e.v.length; i++) {
      const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
      const si = segs.length;
      segs.push({ ei, ax: a.x, az: a.z, bx: b.x, bz: b.z, h, ownH });
      const x0 = Math.min(a.x, b.x) - h, x1 = Math.max(a.x, b.x) + h;
      const z0 = Math.min(a.z, b.z) - h, z1 = Math.max(a.z, b.z) + h;
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          const key = cx * 46337 + cz;
          let l = cells.get(key);
          if (!l) cells.set(key, (l = []));
          l.push(si);
        }
      }
    }
  }
  return { CELL, cells, segs };
}

function blocked(grid, x, z, own) {
  const cx = Math.floor(x / grid.CELL), cz = Math.floor(z / grid.CELL);
  const l = grid.cells.get(cx * 46337 + cz);
  if (!l) return false;
  for (const si of l) {
    const s = grid.segs[si];
    const h = s.ei === own ? s.ownH : s.h;
    const vx = s.bx - s.ax, vz = s.bz - s.az;
    const l2 = vx * vx + vz * vz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / l2)) : 0;
    const dx = x - (s.ax + vx * t), dz = z - (s.az + vz * t);
    if (dx * dx + dz * dz < h * h) return true;
  }
  return false;
}

/**
 * Walk a run and cut out the stretches standing in another street. The kerb FACE
 * is the line that must not cross a carriageway, so that is the line sampled --
 * not the anchor, which is inside the road by construction.
 *
 * Sampling finds the break; only the break lands in the mesh, so a 40 m run that
 * crosses one alley costs two extra vertices, not forty.
 */
function breakRun(run, grid, own) {
  if (!run || run.length < 2) return [];
  const s = arcLengths(run);
  const total = s[s.length - 1];
  if (total < K.minRun) return [];
  const bad = (t) => {
    const p = at(run, s, t);
    return blocked(grid, p.ax + p.nx * K.panOuter, p.az + p.nz * K.panOuter, own);
  };
  // Bisect the transition rather than backing off by half a sample. Backing off
  // leaves the piece's END up to half a sample inside the road it was cut for,
  // and the end of a run is a station the mesh actually draws: at sampleM = 1 m
  // that is 0.5 m of kerb standing in a carriageway at every alley mouth, which
  // is exactly the class of fault this cut exists to prevent.
  const edgeAt = (good, bad0) => {
    for (let k = 0; k < 8; k++) {
      const mid = (good + bad0) / 2;
      if (bad(mid)) bad0 = mid; else good = mid;
    }
    return good;
  };
  const n = Math.max(2, Math.ceil(total / K.sampleM));
  const out = [];
  let open = -1, prev = 0;
  const push = (t0, t1) => { const p = slice(run, s, t0, t1); if (p) out.push(p); };
  for (let i = 0; i <= n; i++) {
    const t = (total * i) / n;
    const isBad = bad(t);
    if (!isBad && open < 0) open = i === 0 ? t : edgeAt(t, prev);
    if (isBad && open >= 0) { push(open, edgeAt(prev, t)); open = -1; }
    prev = t;
  }
  if (open >= 0) push(open, total);
  if (run.fanX !== undefined) for (const piece of out) { piece.fanX = run.fanX; piece.fanZ = run.fanZ; }
  return out;
}

/**
 * An arc of stations about a centre.
 * `inward` true  -> the road is toward the centre (a reflex bend, a dead end).
 * `inward` false -> the road is away from it (a convex corner return, whose
 *                   fillet centre sits in the pavement behind the kerb).
 */
function arcRun(cx, cz, a0, a1, r0, r1, inward, fan) {
  const sweep = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ((K.arcStepDeg * Math.PI) / 180)));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, a = a0 + sweep * f, r = r0 + (r1 - r0) * f;
    const ux = Math.cos(a), uz = Math.sin(a);
    // The face sits at radius r. The anchor is K.panOuter further along the
    // outboard normal's REVERSE, because the section is measured from the road.
    const nx = inward ? ux : -ux, nz = inward ? uz : -uz;
    out.push(station(cx + ux * r - nx * K.panOuter, cz + uz * r - nz * K.panOuter, nx, nz));
  }
  // Carried on the run itself so a chunk build stays "walk a flat list of runs"
  // and still knows this one has a junction corner behind it to floor.
  if (fan) { out.fanX = fan.x; out.fanZ = fan.z; }
  return out;
}

/**
 * Plan every kerb line in the district, once.
 *
 * Straight runs come from offsetting each kerbed edge; corners come from the
 * junction arithmetic below. Both are trimmed against each other so a corner
 * return and the straight it belongs to meet at the tangent point rather than
 * overlapping into the junction -- which is the part a naive extrusion gets
 * wrong and the part tools/geom-audit.mjs now measures.
 *
 * @param {object} d parsed data/district.json
 * @param {{chunkSize?:number, breakAtCrossings?:boolean}} opts
 * @returns {{edgeRuns:Array, vertexRuns:Map, arcChunk:Map, stats:object}}
 */
export function planKerbs(d, opts = {}) {
  const chunkSize = opts.chunkSize ?? d.meta.chunkSize;
  // geom-audit turns the crossing test off to check that corner returns and the
  // straights they belong to actually meet: with it on, a run legitimately cut
  // at an alley mouth looks identical to a corner that does not join, and the
  // check that matters would be unfalsifiable.
  const cut = opts.breakAtCrossings !== false;
  const grid = blockerGrid(d);

  // Incidence at every kerbed edge END. Junction vertices are always edge
  // endpoints in this bake, which is what lets the corner maths stay local.
  const inc = new Map();
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    if (!kerbedEdge(e)) continue;
    let edgeLen = 0;
    for (let i = 1; i < e.v.length; i++) {
      const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
      edgeLen += Math.hypot(b.x - a.x, b.z - a.z);
    }
    for (const end of [0, 1]) {
      const vi = end === 0 ? e.v[0] : e.v[e.v.length - 1];
      const p = d.verts[vi];
      const q = d.verts[end === 0 ? e.v[1] : e.v[e.v.length - 2]];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz) || 1;
      if (!inc.has(vi)) inc.set(vi, []);
      inc.get(vi).push({
        ei, end, edgeLen, dx: dx / len, dz: dz / len,
        ang: Math.atan2(dz / len, dx / len), K: kerbOffsetFor(e.w),
      });
    }
  }

  const trims = [], joins = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    trims.push([[0, 0], [0, 0]]);            // trims[ei][sideIndex][end]
    joins.push([[null, null], [null, null]]);
  }
  const vertexRuns = new Map();
  const stats = { straightRuns: 0, fillets: 0, reflexArcs: 0, caps: 0, miters: 0, straightThrough: 0 };

  // At an edge END the outgoing direction is reversed, so "left of the way I am
  // pointing" is the edge's own +side at one end and its -side at the other.
  // Getting this backwards puts every corner return on the wrong side of the
  // street, which is the kind of error that looks like a rendering bug.
  const sideForLeft = (end) => (end === 0 ? -1 : 1);
  const sideIndex = (side) => (side > 0 ? 0 : 1);

  for (const [vi, list] of inc) {
    const v = d.verts[vi];
    list.sort((a, b) => a.ang - b.ang);
    const n = list.length;
    const runs = [];
    for (let i = 0; i < n; i++) {
      const A = list[i], B = list[(i + 1) % n];
      // Gap swept counter-clockwise from A to B. A single incident edge gives
      // the full turn, which is the 180 degree wrap round a dead end.
      let g = n === 1 ? TAU : norm(B.ang - A.ang);
      if (n > 1 && g < 1e-6) g = TAU;
      const gDeg = (g * 180) / Math.PI;
      const lA = { x: -A.dz, z: A.dx };                 // left of A's outgoing dir
      const lB = { x: -B.dz, z: B.dx };
      const sA = sideIndex(sideForLeft(A.end)), sB = sideIndex(-sideForLeft(B.end));

      if (Math.abs(gDeg - 180) <= K.flatGapDeg) { stats.straightThrough++; continue; }

      if (gDeg < 180) {
        // Convex pavement corner: the two kerb FACE lines meet at a sharp point
        // and a real street rounds it off with a corner return.
        const A1 = { x: v.x + lA.x * A.K, z: v.z + lA.z * A.K };
        const A2 = { x: v.x - lB.x * B.K, z: v.z - lB.z * B.K };
        const den = A.dx * B.dz - A.dz * B.dx;
        if (Math.abs(den) < 1e-6) continue;
        const t1 = ((A2.x - A1.x) * B.dz - (A2.z - A1.z) * B.dx) / den;
        const Qx = A1.x + A.dx * t1, Qz = A1.z + A.dz * t1;
        const t2 = (Qx - A2.x) * B.dx + (Qz - A2.z) * B.dz;
        const half = g / 2;
        let R = K.cornerR;
        let T = R / Math.tan(half);
        if (T > K.maxTangent) { T = K.maxTangent; R = T * Math.tan(half); }
        // Never eat more of a street than it has: a short block between two
        // junctions must still show some straight kerb.
        const room = Math.min(A.edgeLen, B.edgeLen) * 0.45;
        if (t1 + T > room || t2 + T > room) {
          const shrink = Math.min(room - Math.max(t1, t2), T);
          if (shrink <= 0.2) {
            // No room for a return: an acute fork, or two junctions closer
            // together than a corner radius. Close the corner with a MITER
            // rather than leaving it open -- an open one is a hole in the kerb
            // line exactly where two streets meet, which is where the eye is.
            stats.miters++;
            const ta = Math.min(t1, room), tb = Math.min(t2, room);
            trims[A.ei][sA][A.end] = Math.max(trims[A.ei][sA][A.end], ta);
            trims[B.ei][sB][B.end] = Math.max(trims[B.ei][sB][B.end], tb);
            // (nx, nz) is the OUTBOARD normal -- from the road toward the
            // pavement -- and it is what the anchor is measured back along. Its
            // sign was inverted here in the first version, which put both miter
            // tips' sections on the road side of their own kerb line and stood
            // 117 mm of concrete across three arterials. A's face line is its
            // LEFT (A1 = v + lA * A.K) so its outboard is +lA; B's is its RIGHT
            // (A2 = v - lB * B.K) so B's is -lB. tools/geom-audit.mjs's
            // kerbInCarriageway check is what found it, at 1.94 m deep.
            const tip = (base, dir, nx, nz, t) =>
              station(base.x + dir.dx * t - nx * K.panOuter,
                base.z + dir.dz * t - nz * K.panOuter, nx, nz);
            const miter = [
              tip(A1, A, lA.x, lA.z, ta),
              tip(A2, B, -lB.x, -lB.z, tb),
            ];
            miter.fanX = v.x; miter.fanZ = v.z;
            runs.push(miter);
            joins[A.ei][sA][A.end] = { arc: miter, which: 0 };
            joins[B.ei][sB][B.end] = { arc: miter, which: 1 };
            continue;
          }
          T = shrink; R = T * Math.tan(half);
        }
        const P1 = { x: Qx + A.dx * T, z: Qz + A.dz * T };
        const P2 = { x: Qx + B.dx * T, z: Qz + B.dz * T };
        let bx = A.dx + B.dx, bz = A.dz + B.dz;
        const bl = Math.hypot(bx, bz) || 1;
        bx /= bl; bz /= bl;
        const dC = R / Math.sin(half);
        const Cx = Qx + bx * dC, Cz = Qz + bz * dC;
        let a0 = Math.atan2(P1.z - Cz, P1.x - Cx);
        let a1 = Math.atan2(P2.z - Cz, P2.x - Cx);
        // Take the short way round: a return is always less than a half turn.
        while (a1 - a0 > Math.PI) a1 -= TAU;
        while (a0 - a1 > Math.PI) a1 += TAU;
        const arc = arcRun(Cx, Cz, a0, a1, R, R, false, v);
        runs.push(arc);
        stats.fillets++;
        trims[A.ei][sA][A.end] = Math.max(trims[A.ei][sA][A.end], t1 + T);
        trims[B.ei][sB][B.end] = Math.max(trims[B.ei][sB][B.end], t2 + T);
        joins[A.ei][sA][A.end] = { arc, which: 0 };
        joins[B.ei][sB][B.end] = { arc, which: 1 };
      } else {
        // Reflex gap: the two kerb lines diverge and the carriageway's natural
        // offset round the vertex is an arc of the kerb's own radius. A dead end
        // is this case with the whole turn to sweep.
        const a0 = Math.atan2(lA.z, lA.x);
        const a1 = a0 + (g - Math.PI);
        const arc = arcRun(v.x, v.z, a0, a1, A.K, B.K, true, v);
        runs.push(arc);
        joins[A.ei][sA][A.end] = { arc, which: 0 };
        joins[B.ei][sB][B.end] = { arc, which: 1 };
        if (n === 1) stats.caps++; else stats.reflexArcs++;
      }
    }
    if (runs.length) vertexRuns.set(vi, runs);
  }

  // ---- straight runs, trimmed, then broken where another street crosses them.
  const edgeRuns = [];
  const pending = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    if (!kerbedEdge(e)) { edgeRuns.push(null); continue; }
    const pts = e.v.map((vi) => d.verts[vi]);
    edgeRuns.push([[], []]);
    for (const side of [1, -1]) {
      const si = sideIndex(side);
      const line = edgeStations(pts, e.w / 2, side);
      const s = arcLengths(line);
      const total = s[s.length - 1];
      // Two corner returns can between them ask for more kerb than a 3 m stub of
      // street has. Dropping the straight would leave the two returns not
      // meeting, so the trims give way instead and a minimum run survives to
      // hand over to.
      const [t0, t1] = trims[ei][si];
      let a = Math.min(t0, total), b = Math.max(0, total - t1);
      if (b - a < K.minRun) {
        const mid = Math.min(total - K.minRun / 2, Math.max(K.minRun / 2, (a + b) / 2));
        a = Math.max(0, mid - K.minRun / 2); b = Math.min(total, mid + K.minRun / 2);
      }
      const run = slice(line, s, a, b);
      // Hand the corner return over to the straight EXACTLY, by extending the
      // ARC to the straight's own first station rather than dragging the
      // straight back onto the arc's tangent point. The trim is measured along
      // the kerb ray from the junction while the run is walked along the offset
      // polyline, so at a bend the two disagree by a few centimetres; closing
      // that on the arc's side keeps the straight's shoulder landing on the
      // ribbon, which is what stops a sliver of brick opening beside it.
      if (run) {
        for (const [end, st] of [[0, run[0]], [1, run[run.length - 1]]]) {
          const j = joins[ei][si][end];
          if (!j) continue;
          const tip = j.arc[j.which === 0 ? 0 : j.arc.length - 1];
          const gap = Math.hypot(tip.ax - st.ax, tip.az - st.az);
          if (gap < 0.02 || gap > 14) continue;
          if (j.which === 0) j.arc.unshift({ ...st }); else j.arc.push({ ...st });
        }
      }
      pending.push({ ei, si, run });
    }
  }
  for (const { ei, si, run } of pending) {
    const pieces = cut ? breakRun(run, grid, ei) : (run ? [run] : []);
    stats.straightRuns += pieces.length;
    edgeRuns[ei][si] = pieces;
  }

  // Junction arcs get the crossing test too, with NO skip list: a corner return
  // is 2.5 m clear of both carriageways by construction, so anything of it that
  // IS in one is a corner the tangent arithmetic got wrong -- most often where
  // an acute fork forced the radius down -- and it would stand as a 117 mm wall
  // across the road.
  if (cut) {
    for (const [vi, runs] of vertexRuns) {
      const kept = [];
      for (const run of runs) for (const piece of breakRun(run, grid, -1)) kept.push(piece);
      if (kept.length) vertexRuns.set(vi, kept); else vertexRuns.delete(vi);
    }
  }

  // Corner returns belong to the chunk their junction is in, so a chunk build
  // stays "walk my own edges, plus my own junctions" and nothing has to scan the
  // district.
  const arcChunk = new Map();
  for (const vi of vertexRuns.keys()) {
    const v = d.verts[vi];
    const key = `${Math.floor(v.x / chunkSize)},${Math.floor(v.z / chunkSize)}`;
    let l = arcChunk.get(key);
    if (!l) arcChunk.set(key, (l = []));
    l.push(vi);
  }

  return { edgeRuns, vertexRuns, arcChunk, stats };
}

// ------------------------------------------------------------------ emission

/**
 * One panel of the section, swept along a run.
 *
 * `metreUV` writes plain metre UVs for the concrete, which keeps its map on the
 * mesh rather than on the world-planar XZ projection the ground materials use --
 * a kerb is a vertical face as much as a horizontal one, and XZ would smear it.
 *
 * The asphalt half writes u = 1 for every vertex instead. That is not a
 * placeholder: applyMarkingUV maps u = 1 to the outer edge of the edge's own
 * marking column, and the road shader clamps `across` there, which decodes as
 * x = +halfW -- outboard of every lane line, off the wheel tracks, and fully
 * inside the kerbside grime ramp. So the parking lane comes out as plain grimy
 * asphalt with the correct de-tiling, and no lane paint is dragged onto it.
 */
/**
 * Wind a quad so its face agrees with the normal its own vertices carry.
 *
 * These materials are FrontSide, and the handedness of (travel, outboard) flips
 * between the two sides of a street: edgeStations() walks the same polyline
 * order for both sides and only flips the offset, so a FIXED index order is
 * front-facing on one kerb and back-facing on the other. Half the district's
 * kerbs were invisible, and it did not look like a bug -- it looked like a
 * street with a kerb down one side, which plenty of streets have. It took a
 * before/after profile that came back IDENTICAL across the left kerb while a
 * whole-frame diff of the same two PNGs showed a 2.7 m band of change on the
 * right.
 *
 * Decided from the EMITTED POSITIONS rather than from a rule about sides:
 *   - a per-side rule cannot cope with an offset polyline that folds over
 *     itself on the inside of a sharp bend, which two of this district's edges
 *     do (179 and 180, an 82 degree turn at a shape point with no radius);
 *   - a per-run sign cannot either, because the fold reverses the handedness
 *     PART WAY ALONG one run: it left 763 of 46,033 triangles inverted;
 *   - and a sign derived from one station's normal is wrong on a corner return,
 *     where the normal rotates 15 degrees between the two ends of a quad.
 * The triangle's own geometric normal against the vertex normal it was given is
 * the only test that is true by construction, and it is four subtractions and a
 * cross product per quad.
 */
// Emit a FIXED index order instead of testing the triangle, which is the bug the
// geometric test replaced. tools/geom-audit.mjs turns this on to prove its
// facing check can fail; nothing that draws should ever call it.
let forceWinding = false;
export function setForceWinding(v) { forceWinding = !!v; }

function windTri(pos, nrm, idx, a, b, c) {
  if (forceWinding) { idx.push(a, b, c); return; }
  const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
  const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
  const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
  const dot = gx * nrm[a * 3] + gy * nrm[a * 3 + 1] + gz * nrm[a * 3 + 2];
  if (dot >= 0) idx.push(a, b, c); else idx.push(a, c, b);
}

/**
 * Per TRIANGLE, not per quad. A corner return's quads are not planar -- the
 * section's normal rotates 15 degrees between their two ends -- so the two
 * halves of one quad can face opposite ways, and winding them together from the
 * first half's normal left 82 back-facing slivers at junction corners, one per
 * corner return, up to 0.09 m2 each.
 */
function windQuad(pos, nrm, idx, a, b, c, d) {
  windTri(pos, nrm, idx, a, b, c);
  windTri(pos, nrm, idx, a, c, d);
}

function sweep(run, p, pos, nrm, uv, idx, uBase, metreUV) {
  let dist = 0;
  const start = pos.length / 3;
  for (let i = 0; i < run.length; i++) {
    const st = run[i];
    const prev = i > 0 ? run[i - 1] : null;
    if (prev) dist += Math.hypot(st.ax - prev.ax, st.az - prev.az);
    const v = pos.length / 3;
    pos.push(st.ax + st.nx * p.o0, p.y0, st.az + st.nz * p.o0);
    pos.push(st.ax + st.nx * p.o1, p.y1, st.az + st.nz * p.o1);
    nrm.push(st.nx * p.nO, p.nY, st.nz * p.nO);
    nrm.push(st.nx * p.nO, p.nY, st.nz * p.nO);
    if (metreUV) uv.push(uBase, dist, uBase + p.len, dist);
    else uv.push(1, dist / 8, 1, dist / 8);
    if (!prev) continue;
    windQuad(pos, nrm, idx, v - 2, v - 1, v + 1, v);
  }
  return { start, count: pos.length / 3 - start, length: dist };
}

/**
 * Emit one kerb run into the two buffers a chunk keeps: the asphalt shoulder and
 * parking lane on the road material, the pan/face/top/chamfer on the concrete.
 * @returns {{roadStart:number, roadCount:number}} so the caller can code the UVs
 */
export function appendKerbRun(run, road, kerb) {
  let a = { start: road ? road.pos.length / 3 : 0, count: 0 };
  if (road) {
    for (const p of KERB_ROAD) {
      const r = sweep(run, p, road.pos, road.nrm, road.uv, road.idx, 0, false);
      a = { start: Math.min(a.start, r.start), count: a.count + r.count };
    }
  }
  if (kerb) {
    let u = 0;
    for (const p of KERB_CONCRETE) {
      sweep(run, p, kerb.pos, kerb.nrm, kerb.uv, kerb.idx, u, true);
      u += p.len;
    }
  }
  return { roadStart: a.start, roadCount: a.count };
}

/**
 * Floor the corner a return turns around.
 *
 * The section's inner edge lands on the ribbon along a straight but NOT round a
 * corner: at a 90 degree return of 4.5 m radius, the arc's anchor circle stands
 * about 2 m clear of where the two ribbons cross, leaving a wedge of brick
 * paving poking into the junction at every corner in the district. This is the
 * fan that closes it -- one triangle per arc station, from the junction vertex
 * out to the arc's own anchor line.
 *
 * It lies lapDrop under the ribbons it overlaps so the lap cannot z-fight, and
 * it carries the same u = 1 coding as the rest of the asphalt half.
 */
export function appendKerbFan(run, road) {
  if (run.fanX === undefined) return null;
  const { pos, nrm, uv, idx } = road;
  const y = K.roadY - K.lapDrop;
  const hub = pos.length / 3;
  pos.push(run.fanX, y, run.fanZ);
  nrm.push(0, 1, 0);
  uv.push(1, 0);
  for (let i = 0; i < run.length; i++) {
    const st = run[i];
    pos.push(st.ax, y, st.az);
    nrm.push(0, 1, 0);
    uv.push(1, 0);
    if (i === 0) continue;
    // Same reason as sweep(): the fan's winding follows whichever way the
    // junction's angular walk happened to sweep, so it is read off the triangle
    // rather than assumed. The fan is flat, so its own normal is up.
    const p0 = run[i - 1];
    const up = (p0.ax - run.fanX) * (st.az - run.fanZ) - (p0.az - run.fanZ) * (st.ax - run.fanX);
    if (up <= 0) idx.push(hub, hub + i, hub + i + 1);
    else idx.push(hub, hub + i + 1, hub + i);
  }
  return { roadStart: hub, roadCount: run.length + 1 };
}

/**
 * The far tier's version: the same FOOTPRINT, flat, asphalt, no concrete and no
 * vertical face.
 *
 * The face itself is not worth drawing out there. The far ring starts at 192 m
 * and runs to 320 m; the camera stands 2.4 m up, so ground at 192 m is 0.72
 * degrees below the horizon and ground 2.74 m nearer is 0.73 -- the whole
 * section is 0.17 of a pixel deep at 1600x900 and 55 degrees. The WIDENING is a
 * different matter, because it is LATERAL: the road edge moves 2.74 m sideways,
 * which at 200 m is about 12 px of notch in the kerb line at the LOD seam. So
 * the far tier keeps the footprint and drops everything else: 2 triangles per
 * station pair instead of 12.
 */
export function appendKerbApron(run, road) {
  const flat = { o0: -K.lap, y0: K.roadY - K.lapDrop, o1: K.backOuter, y1: K.roadY - K.lapDrop,
    nO: 0, nY: 1, len: K.backOuter + K.lap };
  return sweep(run, flat, road.pos, road.nrm, road.uv, road.idx, 0, false);
}

/** Triangles a run costs at each tier. Used by the offline price. */
export function runCost(run) {
  const segs = run.length - 1;
  const fan = run.fanX === undefined ? 0 : segs;
  return {
    nearRoad: segs * KERB_ROAD.length * 2 + fan,
    nearKerb: segs * KERB_CONCRETE.length * 2,
    far: segs * 2 + fan,
  };
}
