// AUTHOR-TIME ONLY. Turns the OSM extract into the committed JSON the game loads.
// Nothing here runs in the browser.
//
// Source data © OpenStreetMap contributors, ODbL 1.0.
// https://www.openstreetmap.org/copyright

import fs from 'node:fs';
import { parseOSM, makeProjector } from './osm-parse.mjs';
import { CITY, fictionalizeStreet, nameMapping } from './fictionalize.mjs';

// --- Trim box. The raw request covered ~3.96 km2; this keeps the bayfront edge
// and the full downtown Marlin Street corridor through Five Points at ~1.44 km2.
const TRIM = { s: 27.3305, w: -82.5485, n: 27.3395, e: -82.5340 };
const CHUNK = 128;   // metres

const DRIVABLE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'living_street', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);

// Lane widths by class, used when `lanes` is absent. OSM in this extract tags
// `lanes` on 276 ways and `width` on none, so width is always derived.
const CLASS_DEFAULT = {
  motorway: { lanes: 3, laneW: 3.6, rank: 0 }, trunk: { lanes: 2, laneW: 3.5, rank: 1 },
  primary: { lanes: 2, laneW: 3.5, rank: 2 }, secondary: { lanes: 2, laneW: 3.4, rank: 3 },
  tertiary: { lanes: 2, laneW: 3.3, rank: 4 }, residential: { lanes: 2, laneW: 3.0, rank: 5 },
  unclassified: { lanes: 2, laneW: 3.0, rank: 6 }, living_street: { lanes: 1, laneW: 3.0, rank: 7 },
  service: { lanes: 1, laneW: 2.8, rank: 8 },
};
const linkOf = (h) => h.replace(/_link$/, '');

const lat0 = (TRIM.s + TRIM.n) / 2, lon0 = (TRIM.w + TRIM.e) / 2;
const proj = makeProjector(lat0, lon0);
const bounds = {
  min: proj.toXZ(TRIM.s, TRIM.w), max: proj.toXZ(TRIM.n, TRIM.e),
};
const X0 = Math.min(bounds.min.x, bounds.max.x), X1 = Math.max(bounds.min.x, bounds.max.x);
const Z0 = Math.min(bounds.min.z, bounds.max.z), Z1 = Math.max(bounds.min.z, bounds.max.z);
const inTrim = (p) => p.x >= X0 && p.x <= X1 && p.z >= Z0 && p.z <= Z1;
const q = (v) => Math.round(v * 100) / 100;   // centimetre precision

console.log(`Trim box ${(X1 - X0).toFixed(0)} x ${(Z1 - Z0).toFixed(0)} m = ${(((X1 - X0) * (Z1 - Z0)) / 1e6).toFixed(2)} km2`);

const { nodes, ways, relations } = parseOSM('data/raw/osm-extract.xml');
const xz = new Map();
for (const [id, n] of nodes) xz.set(id, proj.toXZ(n.lat, n.lon));

// ------------------------------------------------------------------ ROAD GRAPH
// Emit a topological graph, not a soup of polylines: shared nodes become graph
// vertices so traffic can route and so edges span chunk boundaries cleanly.
const roadWays = ways.filter((w) => DRIVABLE.has(w.tags.highway) && w.refs.length >= 2);
const nodeUse = new Map();
for (const w of roadWays) for (const r of w.refs) nodeUse.set(r, (nodeUse.get(r) || 0) + 1);

const vertIndex = new Map();          // osm node id -> vertex index
const verts = [];
function vertexFor(id) {
  if (vertIndex.has(id)) return vertIndex.get(id);
  const p = xz.get(id);
  const i = verts.length;
  verts.push({ x: q(p.x), z: q(p.z) });
  vertIndex.set(id, i);
  return i;
}

const edges = [];
let skippedOutside = 0;
for (const w of roadWays) {
  const hw = w.tags.highway;
  const def = CLASS_DEFAULT[linkOf(hw)] ?? CLASS_DEFAULT.service;
  const lanes = w.tags.lanes ? Math.max(1, parseInt(w.tags.lanes, 10) || def.lanes) : def.lanes;
  const oneway = w.tags.oneway === 'yes' || w.tags.oneway === '1' || w.tags.junction === 'roundabout';
  const reversed = w.tags.oneway === '-1';
  const width = +(lanes * def.laneW).toFixed(2);
  const name = fictionalizeStreet(w.tags.name);

  // Split the way at every junction so each edge is a clean graph segment.
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const pts = run.map((r) => xz.get(r)).filter(Boolean);
      if (pts.some(inTrim)) {
        const vs = run.map(vertexFor);
        edges.push({
          v: vs, w: width, lanes,
          o: oneway ? (reversed ? -1 : 1) : 0,
          c: linkOf(hw), r: def.rank,
          ...(name ? { n: name } : {}),
        });
      } else skippedOutside++;
    }
    run = run.length ? [run[run.length - 1]] : [];
  };
  for (let i = 0; i < w.refs.length; i++) {
    run.push(w.refs[i]);
    const isJunction = nodeUse.get(w.refs[i]) > 1;
    if (i > 0 && i < w.refs.length - 1 && isJunction) flush();
  }
  flush();
}

// ------------------------------------------------------------------ BUILDINGS
function ringOf(w) {
  const pts = w.refs.map((r) => xz.get(r)).filter(Boolean);
  if (pts.length < 4) return null;
  // Drop the duplicated closing vertex.
  const first = pts[0], last = pts[pts.length - 1];
  if (Math.abs(first.x - last.x) < 0.01 && Math.abs(first.z - last.z) < 0.01) pts.pop();
  return pts.length >= 3 ? pts : null;
}
function areaOf(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].x + ring[i].x) * (ring[j].z - ring[i].z);
  }
  return Math.abs(a / 2);
}
function centroidOf(ring) {
  let x = 0, z = 0;
  for (const p of ring) { x += p.x; z += p.z; }
  return { x: x / ring.length, z: z / ring.length };
}

// Land-use zones, resolved before buildings so a defaulted height can consult them.
const ZONE_WAYS = [];
for (const w of ways) {
  const zone = w.tags.landuse || w.tags.leisure ||
    (w.tags.amenity === 'parking' ? 'parking' : undefined);
  if (!zone) continue;
  const ring = ringOf(w);
  if (!ring || !ring.some(inTrim)) continue;
  ZONE_WAYS.push({ zone, ring, area: areaOf(ring), name: w.tags.name });
}
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > p.z) !== (b.z > p.z) &&
        p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function zoneAt(p) {
  let best = null;
  for (const zw of ZONE_WAYS) {
    if (pointInRing(p, zw.ring) && (!best || zw.area < best.area)) best = zw;
  }
  return best?.zone;
}

// Height defaulting. Where OSM has no height, derive one from footprint area and
// zone, and mark it so the report (and any later art pass) can tell them apart.
const LEVEL_H = 3.2;
function defaultHeight(area, zone, isBayfront) {
  let levels;
  if (area > 4000) levels = 8;            // a full-block structure downtown
  else if (area > 1800) levels = 5;
  else if (area > 900) levels = 4;
  else if (area > 400) levels = 3;
  else if (area > 150) levels = 2;
  else levels = 1;
  if (zone === 'retail' || zone === 'commercial') levels = Math.max(levels, 2);
  if (zone === 'residential' && area < 400) levels = Math.min(levels, 2);
  if (zone === 'industrial') levels = Math.min(levels, 2);
  if (zone === 'parking') levels = Math.min(levels, 3);
  // Bayfront parcels in this district are dominated by residential towers.
  if (isBayfront && area > 700) levels = Math.max(levels, 12);
  return +(levels * LEVEL_H).toFixed(1);
}

// The bayfront band: within 250 m of the real coastline. Defining it against the
// trim box's west edge instead put the band mostly out over open water.
const COAST_PTS = [];
for (const w of ways.filter((w) => w.tags.natural === 'coastline')) {
  for (const r of w.refs) {
    const p = xz.get(r);
    if (p && p.x > X0 - 600 && p.x < X1 + 600 && p.z > Z0 - 600 && p.z < Z1 + 600) COAST_PTS.push(p);
  }
}
const BAYFRONT_DIST = 250;
function nearCoast(p) {
  for (const c of COAST_PTS) {
    if (Math.abs(c.x - p.x) < BAYFRONT_DIST && Math.abs(c.z - p.z) < BAYFRONT_DIST &&
        Math.hypot(c.x - p.x, c.z - p.z) < BAYFRONT_DIST) return true;
  }
  return false;
}

const buildings = [];
const heightStats = { tagged: 0, levels: 0, defaulted: 0, bayfrontTagged: 0, bayfrontDefaulted: 0 };
const buildingWays = ways.filter((w) => w.tags.building && w.tags.building !== 'no');
for (const w of buildingWays) {
  const ring = ringOf(w);
  if (!ring) continue;
  const c = centroidOf(ring);
  if (!inTrim(c)) continue;
  const area = areaOf(ring);
  if (area < 12) continue;                       // sheds and map noise
  const zone = zoneAt(c);
  const isBayfront = nearCoast(c);

  let height, src;
  if (w.tags.height) {
    height = parseFloat(w.tags.height);
    src = 'tagged';
  } else if (w.tags['building:levels']) {
    height = +(parseFloat(w.tags['building:levels']) * LEVEL_H).toFixed(1);
    src = 'levels';
  }
  if (!Number.isFinite(height) || height <= 0) {
    height = defaultHeight(area, zone, isBayfront);
    src = 'defaulted';
  }
  heightStats[src]++;
  if (isBayfront) heightStats[src === 'defaulted' ? 'bayfrontDefaulted' : 'bayfrontTagged']++;

  buildings.push({
    p: ring.map((p) => [q(p.x), q(p.z)]),
    h: height,
    d: src === 'defaulted' ? 1 : 0,             // 1 = height was defaulted
    a: Math.round(area),
    ...(zone ? { z: zone } : {}),
    ...(w.tags['building'] !== 'yes' ? { k: w.tags.building } : {}),
  });
}

// ------------------------------------------------------------------ WATER
// The bayfront boundary. Its job in this probe is to be a cheap world edge.
const water = [];
for (const w of ways) {
  if (w.tags.natural === 'water' || w.tags.waterway === 'riverbank') {
    const ring = ringOf(w);
    if (ring && ring.some(inTrim)) water.push({ t: 'poly', p: ring.map((p) => [q(p.x), q(p.z)]) });
  }
}
const coastlines = [];
for (const w of ways.filter((w) => w.tags.natural === 'coastline')) {
  const pts = w.refs.map((r) => xz.get(r)).filter(Boolean);
  // Keep the portion near the trim box, with a margin so the edge runs past it.
  const kept = pts.filter((p) => p.x > X0 - 400 && p.x < X1 + 400 && p.z > Z0 - 400 && p.z < Z1 + 400);
  if (kept.length >= 2) coastlines.push(kept.map((p) => [q(p.x), q(p.z)]));
}

// ------------------------------------------------------------------ ZONES out
const zones = ZONE_WAYS.map((zw) => ({
  z: zw.zone, p: zw.ring.map((p) => [q(p.x), q(p.z)]), a: Math.round(zw.area),
}));

// ------------------------------------------------------------------ CHUNKING
// Every feature is assigned to a chunk up front so the streamer never has to
// scan the whole district at runtime.
const chunkKey = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
const chunks = new Map();
const touch = (key) => {
  if (!chunks.has(key)) chunks.set(key, { buildings: [], edges: [], zones: [], water: [] });
  return chunks.get(key);
};
buildings.forEach((b, i) => {
  const c = centroidOf(b.p.map(([x, z]) => ({ x, z })));
  touch(chunkKey(c.x, c.z)).buildings.push(i);
});
// An edge is registered in every chunk it passes through, so a road spanning a
// boundary is present from both sides.
edges.forEach((e, i) => {
  const keys = new Set();
  for (let k = 0; k < e.v.length - 1; k++) {
    const a = verts[e.v[k]], b = verts[e.v[k + 1]];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CHUNK / 3)));
    for (let s = 0; s <= steps; s++) {
      keys.add(chunkKey(a.x + ((b.x - a.x) * s) / steps, a.z + ((b.z - a.z) * s) / steps));
    }
  }
  for (const key of keys) touch(key).edges.push(i);
});
zones.forEach((zn, i) => {
  const c = centroidOf(zn.p.map(([x, z]) => ({ x, z })));
  touch(chunkKey(c.x, c.z)).zones.push(i);
});

// --- Route waypoints for the scripted drive-through. Given as real lat/lon and
// snapped to the nearest road vertex, so the route follows actual streets.
const WAYPOINTS = [
  { name: 'Marina / bayfront',        lat: 27.33285, lon: -82.54650 },
  { name: 'Bayfront @ Marlin St',     lat: 27.33440, lon: -82.54460 },
  { name: 'Marlin St @ Tarpon Row',   lat: 27.33506, lon: -82.54106 },
  { name: 'Five Points junction',     lat: 27.33647, lon: -82.54067 },
  { name: 'Marlin St east',           lat: 27.33646, lon: -82.53550 },
  { name: 'Turn north',               lat: 27.33810, lon: -82.53500 },
  { name: '2nd St westbound',         lat: 27.33830, lon: -82.53900 },
  { name: '2nd St @ Calusa',          lat: 27.33880, lon: -82.54300 },
  { name: 'Back to bayfront',         lat: 27.33500, lon: -82.54470 },
];
function snapToRoad(p) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const d = (verts[i].x - p.x) ** 2 + (verts[i].z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { v: best, dist: +Math.sqrt(bestD).toFixed(1) };
}
const route = WAYPOINTS.map((w) => {
  const p = proj.toXZ(w.lat, w.lon);
  const snap = snapToRoad(p);
  return { name: w.name, x: verts[snap.v].x, z: verts[snap.v].z, snapDist: snap.dist };
});

const district = {
  meta: {
    route,
    spawn: { x: route[0].x, z: route[0].z },
    city: CITY.name, bay: CITY.bay,
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL 1.0',
    source: 'OpenStreetMap via api.openstreetmap.org/api/0.6/map',
    baked: new Date().toISOString().slice(0, 10),
    note: 'Geometry is real. All names, businesses and signage are invented.',
    origin: { lat: lat0, lon: lon0 },
    trim: TRIM,
    bounds: { x0: q(X0), x1: q(X1), z0: q(Z0), z1: q(Z1) },
    areaKm2: +(((X1 - X0) * (Z1 - Z0)) / 1e6).toFixed(3),
    chunkSize: CHUNK,
  },
  verts, edges, buildings, zones,
  water: { polys: water, coastlines },
  chunks: Object.fromEntries([...chunks].map(([k, v]) => [k, v])),
  streetNames: nameMapping(),
};

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/district.json', JSON.stringify(district));
const bytes = fs.statSync('data/district.json').size;
const rawBytes = fs.statSync('data/raw/osm-extract.xml').size;

const totalH = heightStats.tagged + heightStats.levels + heightStats.defaulted;
const report = {
  extract_bytes: rawBytes, extract_mb: +(rawBytes / 1048576).toFixed(2),
  baked_bytes: bytes, baked_kb: +(bytes / 1024).toFixed(1),
  compression_ratio: +(rawBytes / bytes).toFixed(1),
  area_km2: district.meta.areaKm2,
  road_vertices: verts.length, road_edges: edges.length,
  oneway_edges: edges.filter((e) => e.o !== 0).length,
  named_edges: edges.filter((e) => e.n).length,
  edges_dropped_outside_trim: skippedOutside,
  footprints: buildings.length,
  height_tagged: heightStats.tagged, height_from_levels: heightStats.levels,
  height_defaulted: heightStats.defaulted,
  height_real_pct: +(((heightStats.tagged + heightStats.levels) / totalH) * 100).toFixed(1),
  bayfront_footprints: heightStats.bayfrontTagged + heightStats.bayfrontDefaulted,
  bayfront_real_pct: +((heightStats.bayfrontTagged /
    Math.max(1, heightStats.bayfrontTagged + heightStats.bayfrontDefaulted)) * 100).toFixed(1),
  coastline_points: COAST_PTS.length,
  zones: zones.length, water_polys: water.length, coastline_ways: coastlines.length,
  chunks: chunks.size,
  streets_renamed: Object.keys(district.streetNames).length,
  route_waypoints: route.length,
  route_worst_snap_m: Math.max(...route.map((r) => r.snapDist)),
  route_length_m: Math.round(route.reduce((a, r, i) =>
    i ? a + Math.hypot(r.x - route[i - 1].x, r.z - route[i - 1].z) : 0, 0)),
};
fs.writeFileSync('data/bake-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
