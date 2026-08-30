// Wanted-system lab.
//
// src/wanted.js is pure state and timers, so it cannot be judged by looking at a
// 3D frame — a wanted system is judged by whether the police converge on the
// right place. This page draws the decision layer directly over the real baked
// road graph in 2D: last known position, the growing search ring, each unit's
// role and where it has been told to drive, and a live line-of-sight ray per
// unit so the moment contact breaks is visible rather than inferred.
//
// Three things here are deliberately NOT in the module under test, because the
// module must not own them:
//
//   1. Movement. `Patrol` below drives cars along the graph. It is a stand-in
//      for src/pursuit.js and it is wired through the same duck-typed interface
//      (`bindPursuit`) that the real one will use — if that interface is wrong,
//      this page cannot work.
//   2. Line of sight. The game will raycast; here it is a real 2D occlusion test
//      against the district's 523 building footprints, injected with
//      `setLineOfSight`. The module never learns what a building is.
//   3. The clock. Simulation runs on a fixed 1/30 s accumulator, because this
//      container renders in software and a wall-clock dt would make the state
//      machine's behaviour a function of the frame rate.
//
// No WebGL: this page is 2D canvas only, so its cost against the project's
// draw-call budget is zero, the same as the module's.

import { WantedSystem, CRIMES, RESPONSE, STATES, bindPursuit } from '../../src/wanted.js';

const errors = [];
window.__errors = errors;
window.addEventListener('error', (e) => { errors.push(String(e.message)); showErr(); });
window.addEventListener('unhandledrejection', (e) => { errors.push(String(e.reason)); showErr(); });
const showErr = () => { $('err').textContent = errors.slice(-4).join('\n'); };

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const district = await (await fetch('../../data/district.json')).json();

// Same seeded PRNG the module uses, for the same reason: a screenshot of this
// page should be the same picture every time it is taken.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x7a11ed);

// ---------------------------------------------------------------- road graph
// Two adjacency sets from one bake: an undirected one for routing the player
// (a fleeing driver ignores a one-way sign) and a directed one for the police,
// who do not.
const V = district.verts, E = district.edges;
const edgeLen = E.map((e) => {
  let l = 0;
  for (let k = 0; k < e.v.length - 1; k++) {
    const a = V[e.v[k]], b = V[e.v[k + 1]];
    l += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return l;
});
const drivable = E.map((_, i) => i).filter((i) => E[i].r <= 6 && edgeLen[i] > 18);

const undirected = new Map();
const directed = new Map();
const push = (m, v, o) => { if (!m.has(v)) m.set(v, []); m.get(v).push(o); };
E.forEach((e, i) => {
  const a = e.v[0], b = e.v[e.v.length - 1];
  push(undirected, a, { e: i, forward: true, to: b });
  push(undirected, b, { e: i, forward: false, to: a });
  if (e.o >= 0) push(directed, a, { e: i, forward: true, to: b });
  if (e.o <= 0) push(directed, b, { e: i, forward: false, to: a });
});

function pointOn(edgeIdx, forward, t) {
  const e = E[edgeIdx];
  const pts = forward ? e.v.map((v) => V[v]) : [...e.v].reverse().map((v) => V[v]);
  let rem = t;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (rem <= seg || k === pts.length - 2) {
      const f = seg > 0 ? Math.min(1, rem / seg) : 0;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
        yaw: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    rem -= seg;
  }
  return null;
}
const endVertex = (edgeIdx, forward) => (forward ? E[edgeIdx].v[E[edgeIdx].v.length - 1] : E[edgeIdx].v[0]);

function nearestVertex(x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < V.length; i++) {
    const d = (V[i].x - x) ** 2 + (V[i].z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Dijkstra with a binary heap. Run nine times at load to stitch the route
// waypoints into one closed circuit, then never again.
function shortestPath(from, to) {
  const dist = new Float64Array(V.length).fill(Infinity);
  const prev = new Int32Array(V.length).fill(-1);
  const prevEdge = new Int32Array(V.length).fill(-1);
  const heap = [{ v: from, d: 0 }];
  dist[from] = 0;
  const pop = () => {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i].d < heap[bi].d) bi = i;
    const n = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
    return n;
  };
  while (heap.length) {
    const cur = pop();
    if (cur.v === to) break;
    if (cur.d > dist[cur.v]) continue;
    for (const o of undirected.get(cur.v) ?? []) {
      const nd = cur.d + edgeLen[o.e];
      if (nd < dist[o.to]) {
        dist[o.to] = nd; prev[o.to] = cur.v; prevEdge[o.to] = o.e;
        heap.push({ v: o.to, d: nd });
      }
    }
  }
  if (dist[to] === Infinity) return null;
  const legs = [];
  for (let v = to; prev[v] !== -1; v = prev[v]) legs.push({ e: prevEdge[v], endVert: v });
  legs.reverse();
  return legs;
}

// Route waypoints -> one dense polyline the player follows. Working in points
// rather than edges means the player mover is ten lines instead of fifty.
function buildRoutePolyline() {
  const wps = district.meta.route.map((r) => nearestVertex(r.x, r.z));
  const pts = [];
  for (let i = 0; i < wps.length; i++) {
    const legs = shortestPath(wps[i], wps[(i + 1) % wps.length]);
    if (!legs) continue;
    for (const leg of legs) {
      const e = E[leg.e];
      const forward = e.v[e.v.length - 1] === leg.endVert;
      const ring = forward ? e.v : [...e.v].reverse();
      for (const v of ring) {
        const p = V[v];
        if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.z - pts[pts.length - 1].z) > 0.5) {
          pts.push({ x: p.x, z: p.z });
        }
      }
    }
  }
  return pts;
}
const ROUTE = buildRoutePolyline();
const ROUTE_LEN = ROUTE.reduce((s, p, i) =>
  i ? s + Math.hypot(p.x - ROUTE[i - 1].x, p.z - ROUTE[i - 1].z) : 0, 0);

// ---------------------------------------------------------------- line of sight
// Real occlusion against the baked footprints. AABB broad phase first: 523
// rectangle rejects is nothing, 523 polygon walks per unit per frame is not.
const boxes = district.buildings.map((b) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of b.p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x0, x1, z0, z1, p: b.p };
});

function segmentsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function clearLine(ax, az, bx, bz) {
  const lo = { x: Math.min(ax, bx), z: Math.min(az, bz) };
  const hi = { x: Math.max(ax, bx), z: Math.max(az, bz) };
  for (const b of boxes) {
    if (b.x1 < lo.x || b.x0 > hi.x || b.z1 < lo.z || b.z0 > hi.z) continue;
    const p = b.p;
    for (let i = 0; i < p.length; i++) {
      const c = p[i], d = p[(i + 1) % p.length];
      if (segmentsCross(ax, az, bx, bz, c[0], c[1], d[0], d[1])) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- the player
const player = {
  s: 0, x: ROUTE[0].x, z: ROUTE[0].z, yaw: 0, speed: 21, hold: false,
  step(dt) {
    if (!this.hold) this.s = (this.s + this.speed * dt) % ROUTE_LEN;
    let rem = this.s;
    for (let i = 0; i < ROUTE.length; i++) {
      const a = ROUTE[i], b = ROUTE[(i + 1) % ROUTE.length];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (rem <= seg) {
        const f = seg > 0 ? rem / seg : 0;
        this.x = a.x + (b.x - a.x) * f;
        this.z = a.z + (b.z - a.z) * f;
        this.yaw = Math.atan2(b.x - a.x, b.z - a.z);
        return;
      }
      rem -= seg;
    }
  },
};

// ---------------------------------------------------------------- the police
/**
 * Stand-in for src/pursuit.js. It implements the interface `bindPursuit`
 * prefers — spawnUnit / releaseUnit / setUnitGoal / setSpeedMultiplier /
 * getUnitPositions — and nothing else. It makes exactly one decision of its own:
 * which edge to take at the next junction to get closer to the goal it was
 * given. Where that goal IS, is the module's business, not this one's.
 */
class Patrol {
  constructor() { this.units = new Map(); this.speed = 24; this.mul = 1; }

  spawnUnit(id, req) {
    for (let a = 0; a < 80; a++) {
      const e = drivable[(rand() * drivable.length) | 0];
      const edge = E[e];
      const forward = edge.o === -1 ? false : edge.o === 1 ? true : rand() < 0.5;
      const t = rand() * edgeLen[e];
      const p = pointOn(e, forward, t);
      if (!p) continue;
      const d = Math.hypot(p.x - req.target.x, p.z - req.target.z);
      if (d < req.spawnMin || d > req.spawnMax) continue;
      this.units.set(id, { id, edge: e, forward, t, len: edgeLen[e],
        x: p.x, z: p.z, yaw: p.yaw, role: req.role, goal: { ...req.target } });
      return true;
    }
    return false;
  }

  releaseUnit(id) { this.units.delete(id); }

  setUnitGoal(id, x, z, role) {
    const u = this.units.get(id);
    if (!u) return;
    u.goal.x = x; u.goal.z = z; u.role = role;
  }

  setSpeedMultiplier(m) { this.mul = m || 1; }

  getUnitPositions() { return [...this.units.values()].map((u) => ({ id: u.id, x: u.x, z: u.z })); }

  update(dt) {
    const v = this.speed * this.mul;
    for (const u of this.units.values()) {
      u.t += v * dt;
      let p = pointOn(u.edge, u.forward, u.t);
      if (!p || u.t >= u.len) {
        const next = this._chooseNext(u);
        u.edge = next.e; u.forward = next.forward; u.t = 0; u.len = edgeLen[next.e];
        p = pointOn(u.edge, u.forward, 0);
      }
      if (p) { u.x = p.x; u.z = p.z; u.yaw = p.yaw; }
    }
  }

  // Greedy descent toward the goal, one junction at a time. Crude on purpose:
  // the point of the lab is whether the GOALS are right.
  _chooseNext(u) {
    const v = endVertex(u.edge, u.forward);
    let opts = (directed.get(v) ?? []).filter((o) => !(o.e === u.edge && o.forward !== u.forward));
    // A U-turn beats vanishing: a dead end must not silently delete a unit and
    // make the module look like it under-spawned.
    if (!opts.length) opts = [{ e: u.edge, forward: !u.forward, to: endVertex(u.edge, !u.forward) }];
    let best = opts[0], bestScore = Infinity;
    for (const o of opts) {
      const p = V[o.to];
      const s = Math.hypot(p.x - u.goal.x, p.z - u.goal.z);
      if (s < bestScore) { bestScore = s; best = o; }
    }
    return best;
  }
}

// ---------------------------------------------------------------- wiring
const patrol = new Patrol();
const wanted = new WantedSystem({ seed: 0x1f0e });
let hidden = false;   // the "break line of sight" button
wanted.setLineOfSight((u, p) => !hidden && clearLine(u.x, u.z, p.x, p.z));
const bridge = bindPursuit(wanted, patrol);

const log = [];
wanted.on('*', (e, p) => {
  if (e === 'contact' || e === 'lastKnown') return;    // too chatty to read
  const bits = { crime: () => `${p.label}${p.applied ? '' : ` (ignored: ${p.reason})`}`,
    stars: () => `${p.prev} -> ${p.stars} stars (${p.reason})`,
    escalate: () => `WANTED ${p.stars}`,
    clear: () => `clear (${p.reason})`,
    state: () => `${p.prev} -> ${p.state}`,
    'unit:request': () => `unit ${p.id} requested, ${p.spawnMin}-${p.spawnMax} m`,
    'unit:release': () => `unit ${p.id} released (${p.reason})`,
    siren: () => `siren ${p.on ? p.intensity.toFixed(2) : 'off'}` };
  log.push({ t: wanted.time, e, text: bits[e] ? bits[e]() : JSON.stringify(p) });
  if (log.length > 60) log.shift();
});

// ---------------------------------------------------------------- base map
// Baked ONCE. 935 edges, 523 footprints and 271 zone polygons re-stroked every
// frame is a guaranteed frame-time failure whatever else the frame costs — the
// same lesson src/hud.js records for the minimap.
const B = district.meta.bounds;
const MAPW = Math.ceil(B.x1 - B.x0), MAPH = Math.ceil(B.z1 - B.z0);
const base = document.createElement('canvas');
base.width = MAPW; base.height = MAPH;

const ZONE_FILL = { park: '#16281d', grass: '#16281d', parking: '#1d232d', pitch: '#183024',
  marina: '#102030', dirt: '#272319', school: '#1f2530', retail: '#232a34' };
const ROAD_W = { 2: 13, 3: 11, 4: 8.5, 5: 6.5, 8: 4 };
const ROAD_FILL = { 2: '#39404c', 3: '#353c47', 4: '#2f3641', 5: '#2b323c', 8: '#252b34' };

function bakeMap() {
  const g = base.getContext('2d');
  g.translate(-B.x0, -B.z0);
  g.fillStyle = '#0b1420'; g.fillRect(B.x0, B.z0, MAPW, MAPH);

  const ring = (pts) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); };

  g.fillStyle = '#141c26';
  ring([[B.x0, B.z0], [B.x1, B.z0], [B.x1, B.z1], [B.x0, B.z1]]); g.fill();

  g.fillStyle = '#0a1b2c';
  for (const w of district.water.polys ?? []) { if (w.p?.length > 2) { ring(w.p); g.fill(); } }

  for (const z of district.zones) {
    g.fillStyle = ZONE_FILL[z.z] ?? '#1a212b';
    if (z.p?.length > 2) { ring(z.p); g.fill(); }
  }

  // Road casing under fill, so junctions read as junctions rather than as a
  // pile of overlapping rectangles.
  for (const pass of [0, 1]) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const e of E) {
      const w = ROAD_W[e.r] ?? 5;
      g.strokeStyle = pass ? (ROAD_FILL[e.r] ?? '#2b323c') : '#0d1219';
      g.lineWidth = pass ? w : w + 3;
      g.beginPath();
      e.v.forEach((v, i) => (i ? g.lineTo(V[v].x, V[v].z) : g.moveTo(V[v].x, V[v].z)));
      g.stroke();
    }
  }

  g.fillStyle = '#2c3746'; g.strokeStyle = '#37445608'; g.lineWidth = 0.6;
  for (const b of district.buildings) { if (b.p?.length > 2) { ring(b.p); g.fill(); } }

  g.strokeStyle = 'rgba(63,208,230,0.28)'; g.lineWidth = 2.4; g.setLineDash([9, 7]);
  g.beginPath();
  ROUTE.forEach((p, i) => (i ? g.lineTo(p.x, p.z) : g.moveTo(p.x, p.z)));
  g.closePath(); g.stroke(); g.setLineDash([]);
}
bakeMap();

// ---------------------------------------------------------------- view
const canvas = $('map');
const ctx = canvas.getContext('2d');
const view = { scale: 1.5, fit: false, dpr: 1, w: 0, h: 0 };

function resize() {
  view.dpr = window.devicePixelRatio || 1;
  view.w = window.innerWidth; view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const cam = { x: player.x, z: player.z };
const S = (x) => (x - cam.x) * view.scale + view.w / 2;
const T = (z) => (z - cam.z) * view.scale + view.h / 2;

const ROLE_COLOR = { chase: '#ff4f5e', intercept: '#ffb03a', probe: '#3fd0e6', search: '#8f7ce8' };

function carAt(x, z, yaw, color, size) {
  ctx.save();
  ctx.translate(S(x), T(z));
  ctx.rotate(-yaw + Math.PI / 2);   // world yaw is atan2(dx,dz); screen y is +z
  ctx.beginPath();
  ctx.moveTo(size * 1.5, 0); ctx.lineTo(-size, size * 0.85); ctx.lineTo(-size * 0.45, 0);
  ctx.lineTo(-size, -size * 0.85); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = 'rgba(5,8,13,0.85)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function draw() {
  const plan = wanted.plan;
  if (view.fit) {
    view.scale = Math.min(view.w / (MAPW + 60), view.h / (MAPH + 60));
    cam.x = (B.x0 + B.x1) / 2; cam.z = (B.z0 + B.z1) / 2;
  } else {
    cam.x += (player.x - cam.x) * 0.18;
    cam.z += (player.z - cam.z) * 0.18;
  }

  // Off-map, not a hole: the bake covers 1.44 km2 and the view can see past it.
  ctx.fillStyle = '#071320';
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, S(B.x0), T(B.z0), MAPW * view.scale, MAPH * view.scale);

  // --- give-up radius: the ring outside which a unit is out of the fight.
  if (plan.stars > 0) {
    ctx.strokeStyle = 'rgba(143,161,186,0.20)';
    ctx.setLineDash([2, 9]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(S(plan.target.x), T(plan.target.z), plan.giveUpRadius * view.scale, 0, TAU);
    ctx.stroke(); ctx.setLineDash([]);
  }

  // --- last known position and the growing search radius.
  if (plan.state === STATES.SEARCH && wanted.lastKnown.valid) {
    const lx = S(wanted.lastKnown.x), lz = T(wanted.lastKnown.z);
    const r = plan.searchRadius * view.scale;
    ctx.fillStyle = 'rgba(232,237,245,0.05)';
    ctx.beginPath(); ctx.arc(lx, lz, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(232,237,245,0.55)';
    ctx.lineWidth = 1.4; ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.arc(lx, lz, r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#e8edf5'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx - 7, lz - 7); ctx.lineTo(lx + 7, lz + 7);
    ctx.moveTo(lx + 7, lz - 7); ctx.lineTo(lx - 7, lz + 7);
    ctx.stroke();
    ctx.fillStyle = '#e8edf5'; ctx.font = '10px ui-monospace,monospace';
    ctx.fillText(`LAST KNOWN  r=${plan.searchRadius.toFixed(0)} m`, lx + 11, lz - 10);
  }

  // --- per unit: line of sight, assigned goal, the car.
  for (const a of plan.assignments) {
    const u = patrol.units.get(a.id);
    if (!u) continue;
    const color = ROLE_COLOR[a.role] ?? '#ff4f5e';
    const sees = !hidden && clearLine(u.x, u.z, player.x, player.z)
      && Math.hypot(u.x - player.x, u.z - player.z) <= (RESPONSE[plan.stars]?.spotRadius ?? 0);
    ctx.strokeStyle = sees ? 'rgba(90,217,141,0.72)' : 'rgba(255,79,94,0.20)';
    ctx.lineWidth = sees ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(S(u.x), T(u.z)); ctx.lineTo(S(player.x), T(player.z)); ctx.stroke();

    ctx.strokeStyle = color; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(S(u.x), T(u.z)); ctx.lineTo(S(a.goal.x), T(a.goal.z)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(S(a.goal.x), T(a.goal.z), 4, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;

    carAt(u.x, u.z, u.yaw, color, 7);
  }

  carAt(player.x, player.z, player.yaw, '#5ad98d', 7.5);
  if (wanted.stars > 0 && !view.fit) {
    ctx.strokeStyle = 'rgba(90,217,141,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(S(player.x), T(player.z), (RESPONSE[plan.stars]?.spotRadius ?? 0) * view.scale, 0, TAU);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- star meter
const starCanvas = $('stars');
const sctx = starCanvas.getContext('2d');
function starPath(c, cx, cy, ro, ri) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro, a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.closePath();
}
let flashPhase = 0;
function drawStars(dt) {
  const s = wanted.stars;
  const flashing = wanted.searching && s > 0;
  if (flashing) flashPhase += dt * 3.2;
  sctx.clearRect(0, 0, starCanvas.width, starCanvas.height);
  for (let i = 0; i < 5; i++) {
    const cx = 14 + i * 26, cy = 15;
    const lit = i < s;
    if (lit) {
      const dim = flashing && Math.sin(flashPhase) < 0;
      sctx.fillStyle = dim ? 'rgba(255,79,94,0.22)' : '#ff4f5e';
      starPath(sctx, cx, cy, 11, 4.9); sctx.fill();
    }
    sctx.strokeStyle = lit ? 'rgba(255,175,182,0.85)' : 'rgba(143,161,186,0.34)';
    sctx.lineWidth = 1.2;
    starPath(sctx, cx, cy, 11, 4.9); sctx.stroke();
  }
}

// ---------------------------------------------------------------- panel
const GROUPS = {
  'c-driving': ['reckless', 'civilianCollision', 'propertyDamage', 'hitAndRun', 'evading', 'restrictedArea'],
  'c-people': ['pedestrianHit', 'pedestrianKilled', 'vehicleTheft', 'assault', 'brandish', 'discharge'],
  'c-police': ['policeProperty', 'roadblockRun', 'officerAssault', 'officerDown'],
};
for (const [id, ids] of Object.entries(GROUPS)) {
  const host = $(id);
  for (const cid of ids) {
    const b = document.createElement('button');
    b.textContent = CRIMES[cid].label;
    b.title = `${cid}: +${CRIMES[cid].heat} stars, +${CRIMES[cid].cool}s to shake`
      + (CRIMES[cid].min ? `, min ${CRIMES[cid].min} stars` : '');
    b.onclick = () => wanted.reportCrime(cid, { at: { x: player.x, z: player.z } });
    host.appendChild(b);
  }
}

const bLos = $('b-los'), bHold = $('b-hold'), bFit = $('b-fit');
bLos.onclick = () => { hidden = !hidden; bLos.classList.toggle('on', hidden);
  bLos.textContent = hidden ? 'hiding — restore sight' : 'break line of sight'; };
bHold.onclick = () => { player.hold = !player.hold; bHold.classList.toggle('on', player.hold); };
bFit.onclick = () => { view.fit = !view.fit; bFit.classList.toggle('on', view.fit); };
$('b-clear').onclick = () => wanted.clear('busted');

let timeScale = 1;
$('s-time').oninput = (e) => { timeScale = e.target.value / 100; $('v-time').textContent = timeScale.toFixed(1); };
$('s-zoom').oninput = (e) => { view.scale = e.target.value / 100; view.fit = false;
  bFit.classList.remove('on'); $('v-zoom').textContent = view.scale.toFixed(2); };

addEventListener('keydown', (e) => {
  if (e.code === 'Space') { bHold.onclick(); e.preventDefault(); }
  if (e.key === 'l' || e.key === 'L') bLos.onclick();
  if (e.key >= '0' && e.key <= '5') wanted.setStars(+e.key, 'lab');
});

function syncPanel() {
  const p = wanted.plan;
  const fix = wanted.hasFreshFix ? '  (fresh fix)' : '';
  $('state').innerHTML =
    `state    <b>${p.state}</b>${fix}\n` +
    `heat     <b>${wanted.heat.toFixed(2)}</b> of ${wanted.maxStars}\n` +
    `contact  <b>${p.seen ? 'in sight' : 'lost'}</b>\n` +
    `units    <b>${p.units}</b> / ${RESPONSE[p.stars].units} wanted\n` +
    `spawn    ${p.spawnMin}-${p.spawnMax} m\n` +
    `give up  ${p.giveUpRadius} m\n` +
    `speed x  ${p.speedMul.toFixed(2)}${p.intercept ? '   intercept' : ''}\n` +
    `search r <b>${p.searchRadius.toFixed(0)}</b> m\n` +
    `escape   ${p.evade.timer.toFixed(1)} / ${p.evade.required.toFixed(1)} s`;
  $('barfill').style.width = `${(p.evade.progress * 100).toFixed(1)}%`;
  // "whole district" recomputes the scale in draw(), so the readout is written
  // from the scale actually in force rather than from the slider.
  $('v-zoom').textContent = view.scale.toFixed(2);

  const t = RESPONSE[p.stars];
  $('tune').textContent = `RESPONSE[${p.stars}]\n` + Object.entries(t)
    .map(([k, v]) => `  ${k.padEnd(13)}${v}`).join('\n');

  $('log').innerHTML = log.slice(-11).map((l) =>
    `<b>${l.t.toFixed(1)}s</b> <span class="e">${l.e}</span> ${l.text}`).join('<br>');
}

// ---------------------------------------------------------------- loop
// Fixed step, for the same reason src/vehicle.js uses one: this container
// renders in software at a handful of frames per second, and a state machine
// whose escape timer depends on the frame rate is not a state machine.
const STEP = 1 / 30;
let acc = 0, prev = performance.now(), simTime = 0;

function simulate(seconds) {
  let left = seconds;
  let guard = 0;
  while (left > 1e-6 && guard++ < 4000) {
    const dt = Math.min(STEP, left);
    left -= dt;
    simTime += dt;
    player.step(dt);
    // Order matters and is the documented contract: the bridge feeds unit
    // positions in, ticks the decision layer, and pushes the plan back out;
    // only then does the pursuit layer move anything.
    bridge.update(dt, { x: player.x, z: player.z });
    patrol.update(dt);
  }
}

function frame(now) {
  const wall = Math.min(0.25, (now - prev) / 1000);
  prev = now;
  acc = Math.min(acc + wall * timeScale, 2);
  simulate(acc);
  acc = 0;
  draw();
  drawStars(wall);
  syncPanel();
  window.__lab.frames++;
  requestAnimationFrame(frame);
}

window.__lab = {
  ready: false, frames: 0, wanted, patrol, player,
  crime: (id) => wanted.reportCrime(id, { at: { x: player.x, z: player.z } }),
  setHidden: (v) => { hidden = !!v; bLos.classList.toggle('on', hidden);
    bLos.textContent = hidden ? 'hiding — restore sight' : 'break line of sight'; },
  setHold: (v) => { player.hold = !!v; bHold.classList.toggle('on', player.hold); },
  setStars: (n) => wanted.setStars(n, 'lab'),
  setZoom: (s) => { view.scale = s; view.fit = false; bFit.classList.remove('on');
    $('s-zoom').value = Math.round(s * 100); },
  // 0 freezes the simulation so a screenshot can hold one exact moment; the
  // page still renders, it just stops advancing.
  setTimeScale: (v) => { timeScale = Math.max(0, v); $('s-time').value = Math.round(timeScale * 100);
    $('v-time').textContent = timeScale.toFixed(1); },
  setFit: (v) => { view.fit = !!v; bFit.classList.toggle('on', !!v); },
  advance: (seconds) => { simulate(seconds); draw(); syncPanel(); },
  get report() {
    return {
      routeMetres: +ROUTE_LEN.toFixed(0), routePoints: ROUTE.length,
      buildings: boxes.length, edges: E.length,
      webglDrawCalls: 0, simTime: +simTime.toFixed(1),
      plan: JSON.parse(JSON.stringify(wanted.plan)),
      wanted: wanted.report(),
      patrolUnits: patrol.units.size,
      errors: errors.length,
    };
  },
};

$('load').remove();
window.__lab.ready = true;
requestAnimationFrame(frame);
