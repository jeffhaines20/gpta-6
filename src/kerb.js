// The kerb: what makes a pavement read as a pavement and not as differently
// coloured road.
//
// WHY THIS IS A MODULE AND NOT A FEW LINES IN streaming.js
//
// A blind reviewer measured the corridor frame across a street edge and got a
// monotonic fall from brick to asphalt with no gutter line, no kerb face and no
// shadow at its base: at 5x the two surfaces read as coplanar because they ARE
// coplanar to within 70 mm, and the ribbon has no side face at all. A kerb runs
// along every street edge in the district, so it is also one of the most
// expensive things that can be added — which means the geometry has to be
// planned once, priced exactly, and bounded by LOD. Everything here is pure
// arithmetic over the baked graph with no THREE import, so tools/tri-breakdown
// and tools/geom-audit can run the SAME code offline instead of keeping a second
// copy of the maths that drifts from what the streamer draws.
//
// WHAT THE REFERENCE ESTABLISHES  (reference/sarasota/)
//
// 09-Untitled-panoramio-186 shows the detail plainly: Florida Type F kerb and
// gutter, cast monolithic in PALE concrete against dark asphalt. Reading from
// the sidewalk out: kerb top, a vertical face, then a wide concrete gutter pan
// that is the brightest band in the frame, then the asphalt. 03-Five-Points
// shows the same pale concrete kerb turning the roundabout island with a hard
// shadow along its base. 05-Sarasota-Opera-House shows the carriageway is pale
// bleached asphalt, not black. So: concrete, not granite; a real pan, not just a
// face; and the pan is LIGHTER than the road it edges, which is what puts a
// bright line under the dark one.
//
// HOW IT SITS ON THE EXISTING DATUMS  (this is the whole design constraint)
//
// Three heights are already fixed by systems this must not disturb:
//   -0.05  the drawn land pad (streaming.js), which is the pavement the player
//          walks on and which every street prop is sunk to (streetfurniture.js
//          PAD_Y). It cannot move: raising it buries tree pits and cellar doors.
//   +0.02  the road ribbon (streaming.js ROAD_Y), which the vehicle, the traffic
//          and every painted marking are placed against. It cannot move either.
//   -0.07  the height parked cars are built for (PAD_Y - 0.02).
// So the pavement currently sits 70 mm BELOW the carriageway, which is the wrong
// way round by 200 mm and is exactly why there is no kerb to see.
//
// The resolution that touches none of those: put the KERB TOP at the pavement
// (-0.045, 5 mm proud so the joint reads) and take the whole 140 mm reveal out
// of the carriageway EDGE — a gutter approach falling from the ribbon edge to
// the pan, and a dished pan falling to the invert at the face. That is a real
// crowned street's edge, it leaves the ribbon and the pad untouched, and it puts
// the parking lane where OSM says it is: `w` is lanes x laneWidth, the TRAVELLED
// way only, so the 1.95 m of asphalt outboard of the ribbon is the parking lane
// that parked cars already stand in — today they stand on brick pavers, which is
// its own defect this fixes on the way past.
//
// The approach falls 6.9% so the lane surface at the parked-car axle line
// (ribbon edge + 1.30 m, streetfurniture.js parkOffset) is exactly -0.070: the
// parked pool neither floats nor sinks, and needs no edit.

/**
 * The cross-section, in metres. `o` is measured from the kerb face outward
 * TOWARD the carriageway; `y` is absolute world height. Read it as a section
 * drawn on paper with the pavement on the left.
 *
 *   pad -0.050 ______                                           ribbon +0.020
 *                    |  top -0.045 (5 mm proud of the pad)     /
 *                    |____                                    /
 *                         |  face, 140 mm, battered 15 mm    /
 *                         |____                             /
 *                              \___ pan, 1:9.3 ___         /
 *                                                 \_______/  approach, 6.9%
 *   o =            -0.185   -0.015  0.00      0.65        2.60
 */
export const KERB = {
  laneW: 1.95,        // asphalt gutter approach, outboard of the ribbon edge
  panW: 0.65,         // concrete gutter pan
  topW: 0.17,         // kerb top
  batter: 0.015,      // the face leans back: a cast kerb is never plumb
  roadY: 0.02,        // = streaming.js ROAD_Y, the ribbon edge it must meet
  lipY: -0.115,       // approach/pan joint
  invertY: -0.185,    // gutter invert, at the foot of the face
  topY: -0.045,       // kerb top
  padY: -0.05,        // = streaming.js land pad, the drawn pavement
  parkY: -0.07,       // = streetfurniture.js PAD_Y - 0.02, parked-car ground
  parkOffset: 1.30,   // = streetfurniture.js parkOffset, the axle line
  cornerR: 4.5,       // corner return radius (15 ft), the downtown standard
  maxTangent: 12,     // cap on the fillet tangent length at an acute fork
  arcStepDeg: 12,     // 38 mm of chord sag on a 4.5 m return: below one pixel
  flatGapDeg: 8,      // a joint this straight needs no corner at all
  blockPad: 0.9,      // clearance kept around a crossing road's carriageway
  sampleM: 1.0,       // resolution the crossing test breaks a run at
  lap: 0.03,          // the approach starts INSIDE the ribbon by this much
  lapDrop: 0.002,     // ...and this far under it, so the lap cannot z-fight
};

/** Exposed face height, the number the reviewer asked for. */
export const KERB_REVEAL = KERB.topY - KERB.invertY;

/** Distance from a road centreline to its kerb face. */
export function kerbOffsetFor(width) { return width / 2 + KERB.laneW + KERB.panW; }

/**
 * Which edges carry a kerb. Deliberately the same test streetfurniture.js uses
 * to decide where cars park (`e.r > 5 || e.w < 5.5` skips): every street with a
 * parking lane gets the kerb that parking lane runs against, and the district's
 * 16.9 km of service roads — alleys and car-park aisles, 38% of the graph by
 * length — get none, because they have none.
 */
export function kerbedEdge(e) { return e.r <= 5 && e.w >= 5.5; }

// The section as panels. Each is [o0, y0, o1, y1] walking from the carriageway
// toward the pavement, plus the up/outward normal in the (o, y) plane.
function panel(o0, y0, o1, y1) {
  const dO = o1 - o0, dY = y1 - y0;
  const len = Math.hypot(dO, dY) || 1;
  return { o0, y0, o1, y1, nO: dY / len, nY: -dO / len };
}
const K = KERB;
/** The asphalt half: goes in the road mesh, on the road material. */
export const KERB_APPROACH = panel(K.laneW + K.panW, K.roadY, K.panW, K.lipY);
/** The concrete half: gutter pan, face, top. One mesh, one material. */
export const KERB_CONCRETE = [
  panel(K.panW, K.lipY, 0, K.invertY),                    // pan
  panel(0, K.invertY, -K.batter, K.topY),                 // face
  panel(-K.batter, K.topY, -K.batter - K.topW, K.topY),   // top
];

// ------------------------------------------------------------------ planning

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * Offset one baked edge's polyline to a kerb line, using EXACTLY the rule
 * geom.js ribbon() uses to place the road edge. That is not a stylistic choice:
 * it is what makes the approach panel's inner edge land on the ribbon edge to
 * the last bit, so the asphalt is continuous and there is no seam to see.
 */
function offsetPolyline(pts, dist, half, side) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], prev = pts[i - 1] ?? p, next = pts[i + 1] ?? p;
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const ox = side * dz, oz = -side * dx;      // ribbon's `left` is (dz, -dx)
    // `ix, iz` is the ribbon vertex this station's approach has to land on. It
    // is carried rather than derived so that a station interpolated at a trim
    // lands on the ribbon EDGE and not merely 2.60 m along its own normal:
    // those differ by up to 196 mm at a bend, and the difference is a sliver of
    // brick paving showing between the asphalt and its own kerb.
    out.push({
      x: p.x + ox * dist, z: p.z + oz * dist, nx: -ox, nz: -oz, d: dist - half,
      ix: p.x + ox * half, iz: p.z + oz * half,
    });
  }
  return out;
}

/** Cumulative arc length along a station list. */
function arcLengths(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return s;
}

/** Station at arc length t, interpolating position and normal. */
function at(pts, s, t) {
  if (t <= s[0]) return { ...pts[0] };
  const last = s.length - 1;
  if (t >= s[last]) return { ...pts[last] };
  let i = 1;
  while (i < last && s[i] < t) i++;
  const f = (t - s[i - 1]) / Math.max(1e-6, s[i] - s[i - 1]);
  const a = pts[i - 1], b = pts[i];
  const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
  // Interpolate the ribbon vertex with the SAME factor, then read the normal
  // off the two: that is what keeps the approach on the ribbon through a bend.
  const ix = a.ix + (b.ix - a.ix) * f, iz = a.iz + (b.iz - a.iz) * f;
  const dx = ix - x, dz = iz - z;
  const d = Math.hypot(dx, dz) || 1;
  return { x, z, nx: dx / d, nz: dz / d, d, ix, iz };
}

/** Sub-list between two arc lengths, keeping the interior stations. */
function slice(pts, s, t0, t1) {
  if (t1 - t0 < 0.4) return null;
  const out = [at(pts, s, t0)];
  for (let i = 0; i < pts.length; i++) if (s[i] > t0 + 1e-3 && s[i] < t1 - 1e-3) out.push(pts[i]);
  out.push(at(pts, s, t1));
  return out.length >= 2 ? out : null;
}

/**
 * A uniform grid over every edge's carriageway, so "is this kerb station
 * standing in another street?" is a nine-cell walk rather than 935 segment
 * tests. The kerb must break where a road crosses it — an alley mouth is a
 * dropped kerb in the real world and a 200 mm trench under the alley's asphalt
 * if it is not broken here.
 */
function blockerGrid(d) {
  const CELL = 24;
  const cells = new Map();
  const segs = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    const h = e.w / 2 + (kerbedEdge(e) ? 0.5 : K.blockPad);
    for (let i = 1; i < e.v.length; i++) {
      const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
      const si = segs.length;
      segs.push({ ei, ax: a.x, az: a.z, bx: b.x, bz: b.z, h });
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

function blocked(grid, x, z, skip) {
  const cx = Math.floor(x / grid.CELL), cz = Math.floor(z / grid.CELL);
  const l = grid.cells.get(cx * 46337 + cz);
  if (!l) return false;
  for (const si of l) {
    const s = grid.segs[si];
    if (skip.has(s.ei)) continue;
    const vx = s.bx - s.ax, vz = s.bz - s.az;
    const l2 = vx * vx + vz * vz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / l2)) : 0;
    const dx = x - (s.ax + vx * t), dz = z - (s.az + vz * t);
    if (dx * dx + dz * dz < s.h * s.h) return true;
  }
  return false;
}

/**
 * Walk a run and cut out the stretches standing in another street. Sampling
 * finds the break; only the break lands in the mesh, so a 40 m run that crosses
 * one alley costs two extra vertices, not forty.
 */
function breakRun(run, grid, skip) {
  if (!run || run.length < 2) return [];
  const s = arcLengths(run);
  const total = s[s.length - 1];
  if (total < 0.5) return [];
  const n = Math.max(2, Math.ceil(total / K.sampleM));
  const out = [];
  let open = -1;
  for (let i = 0; i <= n; i++) {
    const t = (total * i) / n;
    const p = at(run, s, t);
    const bad = blocked(grid, p.x, p.z, skip);
    if (!bad && open < 0) open = t;
    if (bad && open >= 0) {
      const piece = slice(run, s, open, Math.max(open, t - K.sampleM * 0.5));
      if (piece) out.push(piece);
      open = -1;
    }
  }
  if (open >= 0) {
    const piece = slice(run, s, open, total);
    if (piece) out.push(piece);
  }
  if (run.fanX !== undefined) for (const piece of out) { piece.fanX = run.fanX; piece.fanZ = run.fanZ; }
  return out;
}

/** An arc of stations about a centre, normals pointing at `inward ? centre : away`. */
function arcRun(cx, cz, a0, a1, r0, r1, inward, fan) {
  const sweep = a1 - a0;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (K.arcStepDeg * Math.PI / 180)));
  const inner = K.laneW + K.panW;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, a = a0 + sweep * f, r = r0 + (r1 - r0) * f;
    const ux = Math.cos(a), uz = Math.sin(a);
    const nx = inward ? -ux : ux, nz = inward ? -uz : uz;
    out.push({ x: cx + ux * r, z: cz + uz * r, nx, nz, d: inner,
      ix: cx + ux * r + nx * inner, iz: cz + uz * r + nz * inner });
  }
  // Carried on the run itself, so a chunk build can stay "walk a flat list of
  // runs" and still know that this one has a corner behind it to floor.
  if (fan) { out.fanX = fan.x; out.fanZ = fan.z; }
  return out;
}

/**
 * Plan every kerb line in the district, once.
 *
 * Straight runs come from offsetting each kerbed edge; corners come from the
 * junction arithmetic below. Both are trimmed against each other so the corner
 * return and the straight it belongs to meet at the tangent point rather than
 * overlapping into the junction, which is the part a naive extrusion gets wrong
 * and the part tools/geom-audit now measures.
 *
 * @returns {{edgeRuns:Array, vertexRuns:Map, arcChunk:Map, stats:object}}
 */
export function planKerbs(d, opts = {}) {
  const chunkSize = opts.chunkSize ?? d.meta.chunkSize;
  // tools/geom-audit.mjs turns the crossing test off to check that the corner
  // returns and the straights they belong to actually meet: with it on, a run
  // that is legitimately cut at an alley mouth looks identical to a corner that
  // does not join, and the check that matters would be unfalsifiable.
  const cut = opts.breakAtCrossings !== false;
  const grid = blockerGrid(d);

  // ---- incidence at every kerbed edge END. Junction vertices are always edge
  // endpoints in this bake (measured: zero vertices are shared as an interior
  // point by two kerbed edges), which is what lets the corner maths be local.
  const inc = new Map();
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    if (!kerbedEdge(e)) continue;
    for (const end of [0, 1]) {
      const vi = end === 0 ? e.v[0] : e.v[e.v.length - 1];
      const p = d.verts[vi];
      const q = d.verts[end === 0 ? e.v[1] : e.v[e.v.length - 2]];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz) || 1;
      let edgeLen = 0;
      for (let i = 1; i < e.v.length; i++) {
        const a = d.verts[e.v[i - 1]], b = d.verts[e.v[i]];
        edgeLen += Math.hypot(b.x - a.x, b.z - a.z);
      }
      if (!inc.has(vi)) inc.set(vi, []);
      inc.get(vi).push({
        ei, end, edgeLen,
        dx: dx / len, dz: dz / len,
        ang: Math.atan2(dz / len, dx / len),
        K: kerbOffsetFor(e.w),
      });
    }
  }

  // trims[ei][sideIndex] = [fromStart, fromEnd]
  const trims = [];
  const joins = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    trims.push([[0, 0], [0, 0]]);
    joins.push([[null, null], [null, null]]);
  }
  const vertexRuns = new Map();
  const stats = { straightRuns: 0, fillets: 0, convexArcs: 0, caps: 0, miters: 0 };

  // At an edge END the outgoing direction is reversed, so "left of the way I am
  // pointing" is the edge's own +side at one end and its -side at the other.
  // Getting this backwards puts every corner return on the wrong side of the
  // street, which is the kind of error that looks like a rendering bug.
  const sideForLeft = (end) => (end === 0 ? -1 : 1);
  const sideIndex = (side) => (side > 0 ? 0 : 1);
  const endIndex = (end) => end;

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
      const lA = { x: -A.dz, z: A.dx };            // left of A's outgoing dir
      const lB = { x: -B.dz, z: B.dx };
      const A1 = { x: v.x + lA.x * A.K, z: v.z + lA.z * A.K };
      const A2 = { x: v.x - lB.x * B.K, z: v.z - lB.z * B.K };

      if (Math.abs(gDeg - 180) <= K.flatGapDeg) continue;      // straight through

      if (gDeg < 180) {
        // Convex pavement corner: the two kerb lines meet at a sharp point and
        // the real street rounds it off with a corner return.
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
            // instead of leaving it open — 80 of these, and an open one is a
            // hole in the kerb line exactly where two streets meet, which is
            // where the eye already is.
            stats.miters++;
            const sA0 = sideIndex(sideForLeft(A.end)), sB0 = sideIndex(-sideForLeft(B.end));
            const ta = Math.min(t1, room), tb = Math.min(t2, room);
            trims[A.ei][sA0][endIndex(A.end)] =
              Math.max(trims[A.ei][sA0][endIndex(A.end)], ta);
            trims[B.ei][sB0][endIndex(B.end)] =
              Math.max(trims[B.ei][sB0][endIndex(B.end)], tb);
            const inner = K.laneW + K.panW;
            const tip = (o, dir, t) => {
              const x = o.x + dir.dx * t, z = o.z + dir.dz * t;
              const nx = -dir.lx, nz = -dir.lz;          // left-of-dir points out
              return { x, z, nx, nz, d: inner, ix: x + nx * inner, iz: z + nz * inner };
            };
            const miter = [
              tip(A1, { dx: A.dx, dz: A.dz, lx: lA.x, lz: lA.z }, ta),
              tip(A2, { dx: B.dx, dz: B.dz, lx: -lB.x, lz: -lB.z }, tb),
            ];
            miter.fanX = v.x; miter.fanZ = v.z;
            runs.push(miter);
            joins[A.ei][sA0][endIndex(A.end)] = { arc: miter, which: 0 };
            joins[B.ei][sB0][endIndex(B.end)] = { arc: miter, which: 1 };
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
        // Take the short way round: the return is always less than a half turn.
        while (a1 - a0 > Math.PI) a1 -= TAU;
        while (a0 - a1 > Math.PI) a1 += TAU;
        // Normals point at the ROAD, which for a corner return is away from the
        // fillet centre: the centre sits in the pavement, behind the kerb.
        const arc = arcRun(Cx, Cz, a0, a1, R, R, false, v);
        runs.push(arc);
        stats.fillets++;
        const sA = sideIndex(sideForLeft(A.end)), sB = sideIndex(-sideForLeft(B.end));
        trims[A.ei][sA][endIndex(A.end)] = Math.max(trims[A.ei][sA][endIndex(A.end)], t1 + T);
        trims[B.ei][sB][endIndex(B.end)] = Math.max(trims[B.ei][sB][endIndex(B.end)], t2 + T);
        joins[A.ei][sA][endIndex(A.end)] = { arc, which: 0 };
        joins[B.ei][sB][endIndex(B.end)] = { arc, which: 1 };
      } else {
        // Reflex gap: the two kerb lines diverge and the natural offset of the
        // carriageway round the vertex is an arc of the kerb's own radius. A
        // dead end is this case with the whole turn to sweep.
        const a0 = Math.atan2(lA.z, lA.x);
        const a1 = a0 + (g - Math.PI);
        const arc = arcRun(v.x, v.z, a0, a1, A.K, B.K, true, v);
        runs.push(arc);
        const sA = sideIndex(sideForLeft(A.end)), sB = sideIndex(-sideForLeft(B.end));
        joins[A.ei][sA][endIndex(A.end)] = { arc, which: 0 };
        joins[B.ei][sB][endIndex(B.end)] = { arc, which: 1 };
        if (n === 1) stats.caps++; else stats.convexArcs++;
      }
    }
    if (runs.length) vertexRuns.set(vi, runs);
  }

  // ---- straight runs, trimmed, then broken where another street crosses them.
  const edgeRuns = [];
  const straightRuns = [];
  for (let ei = 0; ei < d.edges.length; ei++) {
    const e = d.edges[ei];
    if (!kerbedEdge(e)) { edgeRuns.push(null); continue; }
    const pts = e.v.map((vi) => d.verts[vi]);
    const off = kerbOffsetFor(e.w);
    const skip = new Set([ei]);
    const sides = [[], []];     // filled by the second pass below
    for (const side of [1, -1]) {
      const si = sideIndex(side);
      const line = offsetPolyline(pts, off, e.w / 2, side);
      const s = arcLengths(line);
      const total = s[s.length - 1];
      // Two corner returns can between them ask for more kerb than a 3 m stub
      // of a street has. Dropping the straight would leave the two returns not
      // meeting — measured as a 0.93 m hole at two junctions — so the trims give
      // way instead and a minimum run survives to hand over to.
      const [t0, t1] = trims[ei][si];
      let a = Math.min(t0, total), b = Math.max(0, total - t1);
      if (b - a < 0.5) {
        const mid = Math.min(total - 0.25, Math.max(0.25, (a + b) / 2));
        a = Math.max(0, mid - 0.25); b = Math.min(total, mid + 0.25);
      }
      const run = slice(line, s, a, b);
      // Hand the corner return over to the straight EXACTLY, by extending the
      // arc to the straight's own first station rather than dragging the
      // straight back onto the arc's tangent point. The trim is measured along
      // the kerb RAY from the junction while the run is walked along the offset
      // POLYLINE, so at a bend the two disagree by up to a few metres; closing
      // that on the arc's side keeps the straight's approach landing on the
      // ribbon, which is what stops a sliver of brick opening beside it.
      if (run) {
        for (const [end, st] of [[0, run[0]], [1, run[run.length - 1]]]) {
          const j = joins[ei][si][end];
          if (!j) continue;
          const tip = j.arc[j.which === 0 ? 0 : j.arc.length - 1];
          const gap = Math.hypot(tip.x - st.x, tip.z - st.z);
          if (gap < 0.02 || gap > 12) continue;
          if (j.which === 0) j.arc.unshift({ ...st }); else j.arc.push({ ...st });
        }
      }
      straightRuns.push({ ei, si, run, skip });
    }
    edgeRuns.push(sides);
  }
  for (const { ei, si, run, skip } of straightRuns) {
    const pieces = cut ? breakRun(run, grid, skip) : (run ? [run] : []);
    stats.straightRuns += pieces.length;
    edgeRuns[ei][si] = pieces;
  }

  // ---- corner returns belong to the chunk their junction is in, so a chunk
  // build is still "walk my own edges, plus my own junctions" and nothing has to
  // scan the district.
  const arcChunk = new Map();
  for (const vi of vertexRuns.keys()) {
    const v = d.verts[vi];
    const key = `${Math.floor(v.x / chunkSize)},${Math.floor(v.z / chunkSize)}`;
    let l = arcChunk.get(key);
    if (!l) arcChunk.set(key, (l = []));
    l.push(vi);
  }

  // Junction arcs also get the crossing test: a corner return that clips the
  // street it is turning out of would sit in a 200 mm trench.
  if (cut) {
    // No skip list here. A corner return is 2.6 m clear of both carriageways by
    // construction, so anything of it that IS in one is a corner the tangent
    // arithmetic got wrong — most often where an acute fork forced the radius
    // down — and it would sit in a 205 mm trench under the road.
    const none = new Set();
    for (const [vi, runs] of vertexRuns) {
      const kept = [];
      for (const run of runs) for (const piece of breakRun(run, grid, none)) kept.push(piece);
      if (kept.length) vertexRuns.set(vi, kept); else vertexRuns.delete(vi);
    }
  }

  return { edgeRuns, vertexRuns, arcChunk, stats };
}

// ------------------------------------------------------------------ emission

/**
 * One panel of the section, swept along a run.
 * `code`/`uv0` are the road-material coding for the asphalt half; the concrete
 * half writes plain metre UVs, because a kerb is a vertical face as much as a
 * horizontal one and the world-planar XZ projection the ground materials use
 * would smear it (see materials.js _buildGround).
 */
function sweep(run, p, pos, nrm, uv, idx, uBase, metreUV, lapInner) {
  let dist = 0;
  const start = pos.length / 3;
  for (let i = 0; i < run.length; i++) {
    const st = run[i];
    if (i > 0) dist += Math.hypot(st.x - run[i - 1].x, st.z - run[i - 1].z);
    const v = pos.length / 3;
    // The approach reaches the ribbon vertex this station carries and then goes
    // 30 mm past it, 2 mm under it: a lap joint. Stopping ON the edge would
    // leave a hairline of brick wherever the two disagree, and stopping on it
    // exactly would z-fight two different shadings of the same asphalt.
    const o0 = lapInner ? st.d + K.lap : p.o0;
    const y0 = lapInner ? p.y0 - K.lapDrop : p.y0;
    pos.push(st.x + st.nx * o0, y0, st.z + st.nz * o0);
    pos.push(st.x + st.nx * p.o1, p.y1, st.z + st.nz * p.o1);
    nrm.push(st.nx * p.nO, p.nY, st.nz * p.nO);
    nrm.push(st.nx * p.nO, p.nY, st.nz * p.nO);
    if (metreUV) {
      uv.push(uBase, dist, uBase + Math.hypot(p.o1 - p.o0, p.y1 - p.y0), dist);
    } else {
      uv.push(0, dist / 8, 1, dist / 8);
    }
    if (i > 0) idx.push(v - 2, v - 1, v + 1, v - 2, v + 1, v);
  }
  return { start, count: pos.length / 3 - start, length: dist };
}

/**
 * Emit one kerb run into the two buffers a chunk keeps: the asphalt approach on
 * the road material, the pan/face/top on the concrete one.
 * @returns {{roadStart:number, roadCount:number}} so the caller can code the UVs
 */
export function appendKerbRun(run, road, kerb) {
  const a = road
    ? sweep(run, KERB_APPROACH, road.pos, road.nrm, road.uv, road.idx, 0, false, true)
    : { start: 0, count: 0 };
  if (kerb) {
    let u = 0;
    for (const p of KERB_CONCRETE) {
      sweep(run, p, kerb.pos, kerb.nrm, kerb.uv, kerb.idx, u, true);
      u += Math.hypot(p.o1 - p.o0, p.y1 - p.y0);
    }
  }
  return { roadStart: a.start, roadCount: a.count };
}

/**
 * Floor the corner a return turns around.
 *
 * The approach panel reaches 2.63 m in from the kerb face, which lands on the
 * ribbon along a straight but NOT round a corner: at a 90 degree return of 4.5 m
 * radius the arc's inner edge stops 2.2 m short of where the two ribbons cross,
 * leaving a wedge of brick paving poking into the junction at every corner in
 * the district. This is the fan that closes it: one triangle per arc station,
 * from the junction vertex out to the approach's inner edge.
 *
 * It lies 2 mm under the ribbons it overlaps so the lap cannot z-fight, and it
 * is coded at u = 0.6 — off the oil line, inside the grime threshold, and clear
 * of the wheel tracks — so a junction corner reads as plain asphalt rather than
 * as a stripe of whatever happens to live at u = 0.
 */
export function appendKerbFan(run, road) {
  if (run.fanX === undefined) return;
  const { pos, nrm, uv, idx } = road;
  const y = KERB.roadY - KERB.lapDrop;
  const hub = pos.length / 3;
  pos.push(run.fanX, y, run.fanZ);
  nrm.push(0, 1, 0);
  uv.push(0.6, 0);
  for (let i = 0; i < run.length; i++) {
    const st = run[i], o = st.d + KERB.lap;
    pos.push(st.x + st.nx * o, y, st.z + st.nz * o);
    nrm.push(0, 1, 0);
    uv.push(0.6, 0);
    if (i > 0) idx.push(hub, hub + i, hub + i + 1);
  }
  return { roadStart: hub, roadCount: run.length + 1 };
}

/**
 * The far tier's version: the same footprint, flat, asphalt, no concrete and no
 * vertical face. 2 triangles per station-pair instead of 8.
 *
 * A 140 mm face is 0.8 px at the 256 m the near tier ends at, so the far tier
 * does not need the kerb. It DOES need the widening, or the ground changes
 * colour along the street at the LOD line where 2.8 m of asphalt per side turns
 * back into brick — 17 px of it at that distance, which is not subtle.
 */
export function appendKerbApron(run, road) {
  const flat = { o0: KERB.laneW + KERB.panW, y0: KERB.roadY,
    o1: -KERB.batter - KERB.topW, y1: KERB.roadY, nO: 0, nY: 1 };
  const a = sweep(run, flat, road.pos, road.nrm, road.uv, road.idx, 0, false, true);
  return { roadStart: a.start, roadCount: a.count };
}

/** Triangles a run costs at each tier. Used by the offline price. */
export function runCost(run) {
  const segs = run.length - 1;
  const fan = run.fanX === undefined ? 0 : segs;
  return { near: segs * 8 + fan, far: segs * 2 + fan };
}
