// Port Verano's HUD.
//
// Three constraints shaped every decision in this file.
//
//   1. It must cost the renderer nothing. Draw-call submission is this project's
//      #1 risk and the district already sits near 116 at worst case, so the HUD
//      is DOM plus four small 2D canvases and touches no WebGL at all — it does
//      not even import three.js. Its contribution to the draw-call, triangle and
//      GPU-memory budgets is exactly zero, and that is checkable by inspection:
//      there is no `import * as THREE` in this module.
//
//   2. The minimap must never re-stroke the road graph. district.json holds 935
//      edges, 523 footprints and 271 land-use polygons; stroking those per frame
//      is a guaranteed frame-time failure whatever the rest of the frame costs.
//      The static map is rasterised ONCE into an offscreen canvas at load, and
//      every frame after that is one clipped, rotated `drawImage` of only the
//      sub-rectangle actually visible, plus a handful of vector overlays (route,
//      markers, player arrow) that must stay crisp at any zoom and are cheap
//      because there are ~10 of them, not 935.
//
//   3. Game code must never touch the DOM. There is one entry point —
//      `update(state)`, taking a plain object — so there is exactly one path that
//      can write to the page. The imperative setters below are sugar that funnels
//      into it; they exist because `setWanted(3)` reads better at a call site than
//      a state literal, not because they are a second path.
//
// Scaling: the layout is authored in "design pixels" against a 1280x720 frame and
// multiplied by one scale factor derived from the viewport. Canvas backing stores
// are sized design px x scale x devicePixelRatio and the 2D context is pre-scaled
// by that product, so every drawing routine works in design px and text is
// rasterised at real device resolution instead of being upscaled.
//
// Redraw policy: the map and the gauge move with the car, so they redraw whenever
// their inputs change. The vitals strip and the wanted/weapon block are dirty-flagged
// and cost nothing on a frame where health, armour, ammo and wanted level all held
// still — which is most frames. Text panels are written only when the string differs.

// ---------------------------------------------------------------- theme
// Deliberately not any shipped game's palette: a cold slate plate, one warm amber
// accent for objectives, cyan for armour and the route, and a single alert red
// that is used for nothing except danger (wanted, damage, redline).
export const THEME = {
  text: '#e9eef7',
  dim: '#8fa1ba',
  faint: 'rgba(143,161,186,0.45)',
  plate: 'rgba(8,12,19,0.72)',
  plateSolid: '#080c13',
  edge: 'rgba(150,178,214,0.20)',
  edgeBright: 'rgba(178,204,236,0.42)',
  accent: '#ffb03a',
  route: '#3fd0e6',
  health: '#5ad98d',
  healthLow: '#ffb03a',
  healthCrit: '#ff4f5e',
  armour: '#45b7e8',
  alert: '#ff4f5e',
  shadow: 'rgba(0,0,0,0.55)',
};

// Map palette. Values are chosen so road fill stays legible against building fill
// at a glance in peripheral vision, which is the only way a minimap is ever read.
export const MAP_PALETTE = {
  outside: '#08182a',
  water: '#0c2137',
  waterDeep: '#081a2d',
  shore: 'rgba(110,165,204,0.6)',
  land: '#1c242f',
  building: '#333e4d',
  buildingEdge: '#3d4959',
  park: '#1b2c22',
  parking: '#1f2530',
  marina: '#122334',
  dirt: '#2a2620',
  roadCasing: '#0c1118',
};

// Road width on a map is not road width in the world: a 2.8 m alley rendered
// truthfully vanishes the moment the map is downscaled. These are "map metres",
// exaggerated for the narrow classes and honest for the wide ones.
const ROAD_STYLE = {
  primary:     { w: 9.6, fill: '#98a7bf' },
  secondary:   { w: 8.2, fill: '#8b9ab2' },
  tertiary:    { w: 6.6, fill: '#77869d' },
  residential: { w: 5.2, fill: '#657288' },
  service:     { w: 3.6, fill: '#525d70' },
};
const ROAD_ORDER = ['primary', 'secondary', 'tertiary', 'residential', 'service'];

const ZONE_FILL = {
  park: MAP_PALETTE.park, grass: MAP_PALETTE.park, garden: MAP_PALETTE.park,
  playground: MAP_PALETTE.park, recreation_ground: MAP_PALETTE.park,
  parking: MAP_PALETTE.parking, marina: MAP_PALETTE.marina,
  // No `construction`: the bake's two construction polygons are a 300 m strip that
  // runs off the top of the district, and transient land use earns no map ink.
};

const FONT = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';

// Design-space layout, in pixels against a 1280x720 frame.
export const LAYOUT = {
  margin: 22,
  map: { w: 232, h: 176, radius: 11, chamfer: 17 },
  vitals: { w: 232, h: 40 },
  gauge: { w: 204, h: 134 },
  status: { w: 132, h: 84 },
  gap: 6,
};

// ---------------------------------------------------------------- small helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

// Frame-rate independent approach. vehicle.js learned this the hard way: a fixed
// per-frame lerp makes behaviour a function of frame rate, and a HUD needle that
// lags differently at 30 and 120 Hz is the same bug wearing a different hat.
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// The map silhouette: a rounded rectangle with one corner cut away. The chamfer is
// the only piece of pure styling in the layout and it is there so the map reads as
// this game's map and not as a generic rounded box.
function mapShape(ctx, x, y, w, h, r, cham) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - cham, y);
  ctx.lineTo(x + w, y + cham);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function starPath(ctx, cx, cy, rOuter, rInner) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? rInner : rOuter;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Forward vector of a three.js-style quaternion, in the XZ plane only. Written
 * out rather than imported so this module stays free of three.js: it is the third
 * column of the rotation matrix applied to (0,0,1).
 */
export function forwardFromQuaternion(q) {
  const { x, y, z, w } = q;
  return { x: 2 * (y * w + z * x), z: 1 - 2 * (x * x + y * y) };
}

/** Compass bearing in radians from a forward vector: 0 = north (-z), +pi/2 = east. */
export function headingFromForward(fx, fz) { return Math.atan2(fx, -fz); }

// Six-speed shift points in km/h. The gearbox is cosmetic — vehicle.js has no
// gears — so this exists to give the readout something honest to say, and to let a
// real gearbox override it later via state.gear without touching anything else.
const GEAR_TOPS = [46, 82, 122, 164, 208, 260];

/**
 * Gear label and normalised engine speed for a road speed.
 * @param {number} forwardSpeed  signed m/s along the car's own forward axis
 * @returns {{label:string, index:number, rpm:number}}
 */
export function gearForSpeed(forwardSpeed) {
  const kmh = Math.abs(forwardSpeed) * 3.6;
  if (forwardSpeed < -0.4) return { label: 'R', index: -1, rpm: clamp(kmh / 40, 0.12, 1) };
  if (kmh < 1.2) return { label: 'N', index: 0, rpm: 0.11 };
  let g = 0;
  while (g < GEAR_TOPS.length - 1 && kmh > GEAR_TOPS[g]) g++;
  const lo = g === 0 ? 0 : GEAR_TOPS[g - 1];
  const frac = clamp((kmh - lo) / Math.max(GEAR_TOPS[g] - lo, 1), 0, 1);
  return { label: String(g + 1), index: g + 1, rpm: 0.2 + frac * 0.8 };
}

// ---------------------------------------------------------------- coastline
// The bake stores the shoreline as four open OSM ways plus two enclosed basins.
// Open ways cannot be filled, so they are chained into one polyline, pushed out to
// a box that contains everything, and closed by walking that box's perimeter. Two
// closures exist; the water one is whichever does NOT contain a point known to be
// dry land (the spawn, which sits on a baked road).

function chainWays(ways) {
  const key = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const rest = ways.slice(1).map((w) => w.slice());
  const chain = ways[0].slice();
  let progress = true;
  while (rest.length && progress) {
    progress = false;
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i];
      if (key(w[0]) === key(chain[chain.length - 1])) { chain.push(...w.slice(1)); }
      else if (key(w[w.length - 1]) === key(chain[0])) { chain.unshift(...w.slice(0, -1)); }
      else if (key(w[w.length - 1]) === key(chain[chain.length - 1])) { chain.push(...w.slice(0, -1).reverse()); }
      else if (key(w[0]) === key(chain[0])) { chain.unshift(...w.slice(1).reverse()); }
      else continue;
      rest.splice(i, 1); progress = true; break;
    }
  }
  return chain;
}

function boxT(p, b) {
  const e = 1e-4;
  if (Math.abs(p[1] - b.z0) < e) return (p[0] - b.x0) / (b.x1 - b.x0);
  if (Math.abs(p[0] - b.x1) < e) return 1 + (p[1] - b.z0) / (b.z1 - b.z0);
  if (Math.abs(p[1] - b.z1) < e) return 2 + (b.x1 - p[0]) / (b.x1 - b.x0);
  return 3 + (b.z1 - p[1]) / (b.z1 - b.z0);
}

function boxPoint(t, b) {
  const u = ((t % 4) + 4) % 4;
  if (u < 1) return [b.x0 + u * (b.x1 - b.x0), b.z0];
  if (u < 2) return [b.x1, b.z0 + (u - 1) * (b.z1 - b.z0)];
  if (u < 3) return [b.x1 - (u - 2) * (b.x1 - b.x0), b.z1];
  return [b.x0, b.z1 - (u - 3) * (b.z1 - b.z0)];
}

function perimeterWalk(from, to, b, dir) {
  const t0 = boxT(from, b), t1 = boxT(to, b);
  const span = ((((t1 - t0) * dir) % 4) + 4) % 4;
  const out = [];
  for (let k = 1; k <= 4; k++) {
    const corner = dir > 0 ? Math.floor(t0) + k : Math.ceil(t0) - k;
    const travelled = ((((corner - t0) * dir) % 4) + 4) % 4;
    if (travelled > span || travelled === 0) break;
    out.push(boxPoint(corner, b));
  }
  return out;
}

function rayToBox(p, d, b) {
  const len = Math.hypot(d[0], d[1]) || 1;
  const dx = d[0] / len, dz = d[1] / len;
  let best = Infinity;
  const test = (t) => {
    if (!(t > 1e-6) || t >= best) return;
    const x = p[0] + dx * t, z = p[1] + dz * t;
    if (x >= b.x0 - 1e-3 && x <= b.x1 + 1e-3 && z >= b.z0 - 1e-3 && z <= b.z1 + 1e-3) best = t;
  };
  if (dx !== 0) { test((b.x0 - p[0]) / dx); test((b.x1 - p[0]) / dx); }
  if (dz !== 0) { test((b.z0 - p[1]) / dz); test((b.z1 - p[1]) / dz); }
  return isFinite(best) ? [p[0] + dx * best, p[1] + dz * best] : p.slice();
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], c = poly[j];
    if ((a[1] > pt[1]) !== (c[1] > pt[1]) &&
        pt[0] < ((c[0] - a[0]) * (pt[1] - a[1])) / (c[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function waterPolygon(district) {
  const ways = district.water && district.water.coastlines;
  if (!ways || !ways.length) return null;
  const chain = chainWays(ways);
  if (chain.length < 3) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of chain) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
  }
  const b = { x0: x0 - 600, x1: x1 + 600, z0: z0 - 600, z1: z1 + 600 };
  const head = rayToBox(chain[0], [chain[0][0] - chain[1][0], chain[0][1] - chain[1][1]], b);
  const n = chain.length;
  const tail = rayToBox(chain[n - 1], [chain[n - 1][0] - chain[n - 2][0], chain[n - 1][1] - chain[n - 2][1]], b);
  const open = [head, ...chain, tail];
  const dry = [district.meta.spawn.x, district.meta.spawn.z];
  const cw = open.concat(perimeterWalk(tail, head, b, 1));
  return pointInPoly(dry, cw) ? open.concat(perimeterWalk(tail, head, b, -1)) : cw;
}

// ---------------------------------------------------------------- static map bake
/**
 * Rasterise the whole baked district into one offscreen canvas, once.
 *
 * This is the reason the minimap can afford to exist. 935 road edges stroked twice
 * (casing then fill), 523 building footprints and 271 land-use polygons is a few
 * hundred milliseconds of path work — perfectly affordable behind the loading
 * screen, and completely unaffordable at 60 Hz. Afterwards the minimap only ever
 * transforms this image.
 *
 * The scale is the one real tradeoff: `pixelsPerMetre` buys sharpness with memory,
 * quadratically. 1.8 px/m over the playable extent is ~9 Mpx / ~36 MB and is 1:1
 * sharp at 1080p, softening to roughly a 2x upscale only at 1440p with a 2x device
 * pixel ratio. Vector overlays are drawn after the blit so the player arrow, route
 * and markers stay crisp regardless.
 *
 * @param {object} district  parsed data/district.json
 * @param {{pixelsPerMetre?:number, padMetres?:number}} [opts]
 * @returns {{canvas:HTMLCanvasElement, ppm:number, x0:number, z0:number,
 *           widthMetres:number, heightMetres:number, ms:number, megabytes:number,
 *           timings:object, counts:object}}
 */
export function bakeDistrictMap(district, opts = {}) {
  const t0 = performance.now();
  const ppm = opts.pixelsPerMetre ?? 1.8;
  const pad = opts.padMetres ?? 32;

  // Cover everything the streamer can ever put in front of the player: the chunk
  // grid is the authority on playable extent, and it is wider than the trim box.
  const bounds = district.meta.bounds;
  const ext = { x0: bounds.x0, x1: bounds.x1, z0: bounds.z0, z1: bounds.z1 };
  const cs = district.meta.chunkSize;
  for (const k of Object.keys(district.chunks || {})) {
    const [cx, cz] = k.split(',').map(Number);
    ext.x0 = Math.min(ext.x0, cx * cs); ext.x1 = Math.max(ext.x1, (cx + 1) * cs);
    ext.z0 = Math.min(ext.z0, cz * cs); ext.z1 = Math.max(ext.z1, (cz + 1) * cs);
  }
  for (const v of district.verts) {
    ext.x0 = Math.min(ext.x0, v.x); ext.x1 = Math.max(ext.x1, v.x);
    ext.z0 = Math.min(ext.z0, v.z); ext.z1 = Math.max(ext.z1, v.z);
  }
  const x0 = ext.x0 - pad, z0 = ext.z0 - pad;
  const widthMetres = (ext.x1 + pad) - x0, heightMetres = (ext.z1 + pad) - z0;
  const W = Math.round(widthMetres * ppm), H = Math.round(heightMetres * ppm);

  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ppm, 0, 0, ppm, -x0 * ppm, -z0 * ppm);   // draw in world metres
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const timings = {};
  const mark = (k, t) => { timings[k] = +(performance.now() - t).toFixed(1); };

  // --- water and land. Land exists only inside the trim box because that is
  // exactly what streaming.js builds (one land pad, water everywhere else); the
  // OSM coastline then carves the real bay out of it.
  let t = performance.now();
  ctx.fillStyle = MAP_PALETTE.water;
  ctx.fillRect(x0, z0, widthMetres, heightMetres);
  const water = waterPolygon(district);
  ctx.save();
  ctx.beginPath();
  ctx.rect(bounds.x0, bounds.z0, bounds.x1 - bounds.x0, bounds.z1 - bounds.z0);
  ctx.clip();
  ctx.fillStyle = MAP_PALETTE.land;
  ctx.fillRect(x0, z0, widthMetres, heightMetres);
  if (water) {
    ctx.fillStyle = MAP_PALETTE.water;
    ctx.beginPath();
    ctx.moveTo(water[0][0], water[0][1]);
    for (let i = 1; i < water.length; i++) ctx.lineTo(water[i][0], water[i][1]);
    ctx.closePath();
    ctx.fill();
  }
  for (const w of (district.water && district.water.polys) || []) {
    ctx.beginPath();
    ctx.moveTo(w.p[0][0], w.p[0][1]);
    for (let i = 1; i < w.p.length; i++) ctx.lineTo(w.p[i][0], w.p[i][1]);
    ctx.closePath();
    ctx.fillStyle = MAP_PALETTE.waterDeep;
    ctx.fill();
  }
  ctx.restore();
  mark('water', t);

  // --- land-use. Drawn under the buildings so a car park reads as ground, not
  // as a building the player could crash into.
  t = performance.now();
  let zones = 0;
  for (const z of district.zones || []) {
    const fill = ZONE_FILL[z.z];
    if (!fill || z.p.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(z.p[0][0], z.p[0][1]);
    for (let i = 1; i < z.p.length; i++) ctx.lineTo(z.p[i][0], z.p[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    zones++;
  }
  mark('zones', t);

  t = performance.now();
  ctx.fillStyle = MAP_PALETTE.building;
  ctx.strokeStyle = MAP_PALETTE.buildingEdge;
  ctx.lineWidth = 0.6;
  for (const b of district.buildings || []) {
    if (b.p.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(b.p[0][0], b.p[0][1]);
    for (let i = 1; i < b.p.length; i++) ctx.lineTo(b.p[i][0], b.p[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  mark('buildings', t);

  // --- roads. Casings for every class first, then fills for every class: that
  // ordering is what makes junctions look joined instead of stacked, and it costs
  // one extra pass over an array we are walking anyway.
  t = performance.now();
  const byClass = new Map(ROAD_ORDER.map((c) => [c, []]));
  for (const e of district.edges) (byClass.get(e.c) || byClass.get('service')).push(e);
  const strokeClass = (list, width, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const e of list) {
      const v0 = district.verts[e.v[0]];
      ctx.moveTo(v0.x, v0.z);
      for (let i = 1; i < e.v.length; i++) {
        const v = district.verts[e.v[i]];
        ctx.lineTo(v.x, v.z);
      }
    }
    ctx.stroke();
  };
  for (const c of ROAD_ORDER) strokeClass(byClass.get(c), ROAD_STYLE[c].w + 2.0, MAP_PALETTE.roadCasing);
  for (const c of ROAD_ORDER) strokeClass(byClass.get(c), ROAD_STYLE[c].w, ROAD_STYLE[c].fill);
  mark('roads', t);

  // --- shoreline. Both the real coastline and the trim edge are genuine
  // land/water boundaries in this world, so both get the same line.
  t = performance.now();
  ctx.strokeStyle = MAP_PALETTE.shore;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(bounds.x0, bounds.z0, bounds.x1 - bounds.x0, bounds.z1 - bounds.z0);
  if (water) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bounds.x0, bounds.z0, bounds.x1 - bounds.x0, bounds.z1 - bounds.z0);
    ctx.clip();
    ctx.beginPath();
    for (const w of district.water.coastlines) {
      ctx.moveTo(w[0][0], w[0][1]);
      for (let i = 1; i < w.length; i++) ctx.lineTo(w[i][0], w[i][1]);
    }
    ctx.stroke();
    ctx.restore();
  }
  mark('shore', t);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const ms = +(performance.now() - t0).toFixed(1);
  return {
    canvas, ppm, x0, z0, widthMetres, heightMetres, ms,
    megabytes: +((W * H * 4) / (1024 * 1024)).toFixed(1),
    pixels: W * H, width: W, height: H, timings,
    counts: { edges: district.edges.length, buildings: (district.buildings || []).length, zones },
  };
}

// One bake per document. The district is 36 MB of canvas; a second HUD (a lab page
// showing two, a pause-menu map) must share it, never build another.
const bakeCache = new Map();
export function getDistrictMap(district, opts = {}) {
  const key = `${opts.pixelsPerMetre ?? 1.8}/${opts.padMetres ?? 32}`;
  let m = bakeCache.get(key);
  if (!m) { m = bakeDistrictMap(district, opts); bakeCache.set(key, m); }
  return m;
}

// ---------------------------------------------------------------- minimap
const MARKER_STYLE = {
  objective: { fill: THEME.accent, shape: 'pin' },
  waypoint: { fill: THEME.route, shape: 'pin' },
  enemy: { fill: THEME.alert, shape: 'dot' },
  friend: { fill: THEME.health, shape: 'dot' },
  vehicle: { fill: '#cfd8e6', shape: 'square' },
  shop: { fill: '#8fd36a', shape: 'square' },
};

/**
 * The rotating minimap. Owns nothing but a context and the baked image; the HUD
 * hands it a viewport and a state each frame.
 *
 * Per-frame work is deliberately bounded: one clip, one drawImage of the visible
 * sub-rectangle, one Path2D stroke for the route (rebuilt only when the route
 * array identity changes), and a marker loop over however many blips the mission
 * has posted. Nothing here is proportional to the size of the road graph.
 */
export class Minimap {
  constructor(bake, opts = {}) {
    this.bake = bake;                      // may be null: draws an empty plate
    this.zoomMetres = opts.zoomMetres ?? 210;   // world metres across the map width
    this.northUp = false;
    this.forwardBias = opts.forwardBias ?? 0.16; // push the car below centre
    this.route = null;
    this._routeSrc = null;
    this._routePath = null;
    this.ms = 0;
    this.worstMs = 0;
    this.avgMs = 0;
  }

  /** Rebuild the route path only when the caller hands over a different array. */
  setRoute(points) {
    if (points === this._routeSrc) return;
    this._routeSrc = points;
    if (!points || points.length < 2) { this._routePath = null; return; }
    const p = new Path2D();
    p.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) p.lineTo(points[i][0], points[i][1]);
    this._routePath = p;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx  pre-scaled to design px
   * @param {{x:number,y:number,w:number,h:number}} box  in design px
   * @param {object} s  { px, pz, heading, markers, waypoint, northUp, zoomMetres }
   */
  draw(ctx, box, s) {
    const t0 = performance.now();
    const { x, y, w, h } = box;
    const zoom = s.zoomMetres || this.zoomMetres;
    const ppm = w / zoom;                       // design px per world metre
    const northUp = s.northUp ?? this.northUp;
    const rot = northUp ? 0 : -s.heading;

    ctx.save();
    mapShape(ctx, x, y, w, h, LAYOUT.map.radius, LAYOUT.map.chamfer);
    ctx.clip();
    ctx.fillStyle = MAP_PALETTE.outside;
    ctx.fillRect(x, y, w, h);

    // The car sits below centre so more of the road ahead is on screen. In
    // north-up mode there is no "ahead", so the bias is dropped.
    const biasPx = northUp ? 0 : h * this.forwardBias;
    const cx = x + w / 2, cy = y + h / 2 + biasPx;

    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(ppm, ppm);
    ctx.translate(-s.px, -s.pz);

    if (this.bake) this._blit(ctx, box, s, ppm, rot, cx, cy);

    // Route: a vector, not part of the bake, because it changes and because a
    // stroked line must keep a constant screen width at every zoom.
    if (this._routePath) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(4,10,16,0.85)';
      ctx.lineWidth = 5 / ppm;
      ctx.stroke(this._routePath);
      ctx.strokeStyle = THEME.route;
      ctx.lineWidth = 2.6 / ppm;
      ctx.stroke(this._routePath);
    }
    ctx.restore();

    // Markers and the arrow are drawn in screen space: their size must not scale
    // with the zoom, and off-map blips have to be clamped to the frame.
    ctx.save();
    mapShape(ctx, x, y, w, h, LAYOUT.map.radius, LAYOUT.map.chamfer);
    ctx.clip();
    const toScreen = (wx, wz) => {
      const dx = (wx - s.px) * ppm, dz = (wz - s.pz) * ppm;
      const c = Math.cos(rot), n = Math.sin(rot);
      return [cx + dx * c - dz * n, cy + dx * n + dz * c];
    };
    const blips = s.markers ? s.markers.slice() : [];
    if (s.waypoint) blips.push({ ...s.waypoint, kind: 'waypoint' });
    for (const m of blips) this._marker(ctx, toScreen(m.x, m.z), box, m);
    this._compass(ctx, box, rot);
    this._arrow(ctx, cx, cy, northUp ? s.heading : 0);
    ctx.restore();

    this._frame(ctx, box);
    const dt = performance.now() - t0;
    this.ms = dt;
    this.worstMs = Math.max(this.worstMs, dt);
    this.avgMs = this.avgMs ? this.avgMs * 0.94 + dt * 0.06 : dt;
  }

  // Sample only the part of the bake the map can actually show. Without this the
  // browser is handed a 9-megapixel source every frame and has to work out the
  // answer itself; with it, the source rect is a few hundred pixels square.
  _blit(ctx, box, s, ppm, rot, cx, cy) {
    const b = this.bake;
    const c = Math.cos(-rot), n = Math.sin(-rot);
    let wx0 = Infinity, wx1 = -Infinity, wz0 = Infinity, wz1 = -Infinity;
    for (const [ux, uy] of [[box.x, box.y], [box.x + box.w, box.y],
                            [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]]) {
      const dx = (ux - cx) / ppm, dz = (uy - cy) / ppm;
      const wx = s.px + dx * c - dz * n, wz = s.pz + dx * n + dz * c;
      wx0 = Math.min(wx0, wx); wx1 = Math.max(wx1, wx);
      wz0 = Math.min(wz0, wz); wz1 = Math.max(wz1, wz);
    }
    wx0 = Math.max(wx0, b.x0); wz0 = Math.max(wz0, b.z0);
    wx1 = Math.min(wx1, b.x0 + b.widthMetres); wz1 = Math.min(wz1, b.z0 + b.heightMetres);
    if (!(wx1 > wx0 && wz1 > wz0)) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(
      b.canvas,
      (wx0 - b.x0) * b.ppm, (wz0 - b.z0) * b.ppm,
      (wx1 - wx0) * b.ppm, (wz1 - wz0) * b.ppm,
      wx0, wz0, wx1 - wx0, wz1 - wz0
    );
  }

  _marker(ctx, [mx, my], box, m) {
    const pad = 9;
    const ix0 = box.x + pad, ix1 = box.x + box.w - pad;
    const iy0 = box.y + pad, iy1 = box.y + box.h - pad;
    const off = mx < ix0 || mx > ix1 || my < iy0 || my > iy1;
    let px = clamp(mx, ix0, ix1), py = clamp(my, iy0, iy1);
    // The map's top-right corner is cut away; a blip clamped into that triangle is
    // clipped in half. Slide it back along the chamfer instead.
    const ch = LAYOUT.map.chamfer;
    const over = (px - (ix1 - ch)) + ((iy0 + ch) - py) - ch;
    if (over > 0) { px -= over * 0.5; py += over * 0.5; }
    const st = MARKER_STYLE[m.kind] || MARKER_STYLE.waypoint;
    const r = off ? 4.4 : 6;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(3,7,12,0.9)';
    ctx.fillStyle = st.fill;
    ctx.beginPath();
    if (st.shape === 'pin' && !off) {
      // A teardrop: unmistakable at 6 px and it points at its own ground position.
      ctx.moveTo(px, py + r * 1.55);
      ctx.quadraticCurveTo(px - r, py + r * 0.2, px - r, py - r * 0.25);
      ctx.arc(px, py - r * 0.25, r, Math.PI, 0);
      ctx.quadraticCurveTo(px + r, py + r * 0.2, px, py + r * 1.55);
    } else if (st.shape === 'square') {
      ctx.rect(px - r * 0.8, py - r * 0.8, r * 1.6, r * 1.6);
    } else {
      ctx.arc(px, py, r, 0, TAU);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  _compass(ctx, box, rot) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const rx = box.w / 2 - 5, ry = box.h / 2 - 5;
    const dirs = [[0, -1, 'N'], [1, 0, ''], [0, 1, ''], [-1, 0, '']];
    ctx.save();
    for (const [dx, dz, label] of dirs) {
      const c = Math.cos(rot), n = Math.sin(rot);
      const sx = dx * c - dz * n, sy = dx * n + dz * c;
      // Project the cardinal ray onto the map frame so the tick rides the edge.
      const t = Math.min(Math.abs(rx / (sx || 1e-6)), Math.abs(ry / (sy || 1e-6)));
      const px = cx + sx * t, py = cy + sy * t;
      if (label) {
        ctx.fillStyle = THEME.text;
        ctx.font = `700 9px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.globalAlpha = 0.92;
        ctx.fillText(label, px - sx * 5, py - sy * 5);
      } else {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = THEME.dim;
        ctx.fillRect(px - sx * 4 - 1, py - sy * 4 - 1, 2, 2);
      }
    }
    ctx.restore();
  }

  _arrow(ctx, cx, cy, spin) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    ctx.beginPath();
    ctx.moveTo(0, -8.5);
    ctx.lineTo(6.4, 7.4);
    ctx.lineTo(0, 3.6);
    ctx.lineTo(-6.4, 7.4);
    ctx.closePath();
    ctx.fillStyle = '#f4f8ff';
    ctx.strokeStyle = 'rgba(4,8,14,0.92)';
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _frame(ctx, box) {
    mapShape(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1,
      LAYOUT.map.radius, LAYOUT.map.chamfer);
    ctx.strokeStyle = THEME.edgeBright;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- stylesheet
// One stylesheet per document, memoised by id the way materials.js memoises a
// texture: N HUDs must never mean N copies of the same rules.
const STYLE_ID = 'pv-hud-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  // No backdrop-filter anywhere: a blurred backdrop is a per-frame full-screen
  // compositor pass, which is exactly the kind of invisible cost this project's
  // budget gate exists to catch. Plates are flat and slightly transparent instead.
  el.textContent = `
.pv-hud{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:40;--s:1;
  font-family:${FONT};color:${THEME.text};-webkit-font-smoothing:antialiased;
  transition:opacity .22s ease}
.pv-hud[data-hidden="1"]{opacity:0}
.pv-hud canvas{position:absolute;display:block}
.pv-band{position:absolute;left:50%;opacity:0;
  transform:translateX(-50%) translateY(calc(var(--s) * -5px));
  transition:opacity .18s ease,transform .18s ease}
.pv-band.pv-on{opacity:1;transform:translateX(-50%) translateY(0)}
.pv-obj{top:calc(var(--s) * 22px);max-width:calc(var(--s) * 560px);
  background:${THEME.plate};border:1px solid ${THEME.edge};
  border-left:calc(var(--s) * 3px) solid ${THEME.accent};
  border-radius:calc(var(--s) * 5px);
  padding:calc(var(--s) * 7px) calc(var(--s) * 15px) calc(var(--s) * 8px);
  box-shadow:0 calc(var(--s) * 3px) calc(var(--s) * 16px) rgba(0,0,0,.42)}
.pv-obj-title{font-size:calc(var(--s) * 9.5px);letter-spacing:.2em;color:${THEME.accent};
  font-weight:700;text-transform:uppercase}
.pv-obj-text{font-size:calc(var(--s) * 15.5px);font-weight:600;line-height:1.3;
  margin-top:calc(var(--s) * 2px);
  text-shadow:0 calc(var(--s) * 1px) calc(var(--s) * 3px) rgba(0,0,0,.75)}
.pv-obj-dist{font-size:calc(var(--s) * 11px);color:${THEME.dim};font-variant-numeric:tabular-nums;
  margin-top:calc(var(--s) * 1px);letter-spacing:.04em}
.pv-obj-dist:empty{display:none}
.pv-sub{bottom:calc(var(--s) * 66px);width:calc(var(--s) * 720px);max-width:82vw;
  text-align:center;font-size:calc(var(--s) * 17px);line-height:1.35;font-weight:500;
  text-shadow:0 calc(var(--s) * 2px) calc(var(--s) * 6px) rgba(0,0,0,.92),
              0 0 calc(var(--s) * 2px) rgba(0,0,0,.8)}
.pv-sub-speaker{color:${THEME.accent};font-weight:700;letter-spacing:.07em}
.pv-prompt{bottom:calc(var(--s) * 126px);display:flex;align-items:center;
  gap:calc(var(--s) * 9px);background:${THEME.plate};border:1px solid ${THEME.edge};
  border-radius:calc(var(--s) * 20px);
  padding:calc(var(--s) * 6px) calc(var(--s) * 15px);
  box-shadow:0 calc(var(--s) * 3px) calc(var(--s) * 14px) rgba(0,0,0,.42)}
.pv-prompt.pv-haskey{padding-left:calc(var(--s) * 7px)}
.pv-key{display:none;place-items:center;min-width:calc(var(--s) * 23px);
  height:calc(var(--s) * 23px);padding:0 calc(var(--s) * 5px);
  border-radius:calc(var(--s) * 6px);background:${THEME.text};color:#0a0f16;
  font-weight:800;font-size:calc(var(--s) * 12.5px)}
.pv-prompt.pv-haskey .pv-key{display:inline-grid}
.pv-prompt-text{font-size:calc(var(--s) * 12.5px);font-weight:700;letter-spacing:.15em;
  text-transform:uppercase;white-space:nowrap}
.pv-veil{position:absolute;inset:0;opacity:0;will-change:opacity}
.pv-vig{background:radial-gradient(ellipse 76% 66% at 50% 52%,
  rgba(0,0,0,0) 42%,rgba(0,0,0,.34) 74%,rgba(0,0,0,.86) 100%)}
.pv-dmg{background:radial-gradient(ellipse 70% 60% at 50% 52%,
  rgba(140,4,14,0) 34%,rgba(158,10,20,.45) 70%,rgba(196,22,34,.92) 100%)}
`;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------- the HUD
export class HUD {
  /**
   * @param {object} [opts]
   * @param {HTMLElement} [opts.container=document.body]
   * @param {object} [opts.district]   parsed district.json; omit for a blank map
   * @param {object} [opts.map]        forwarded to bakeDistrictMap
   * @param {number} [opts.zoomMetres] world metres across the minimap, default 210
   */
  constructor(opts = {}) {
    ensureStyle();
    this.container = opts.container || document.body;
    this.units = opts.units || 'kmh';
    this.escalateSeconds = opts.escalateSeconds ?? 4;
    this.damageDecay = opts.damageDecay ?? 1.4;

    this.state = {
      visible: true, inVehicle: false,
      speed: 0, forwardSpeed: 0, slip: 0, gear: null, rpm: null,
      px: 0, pz: 0, heading: 0,
      wanted: 0, wantedFlash: false,
      health: 1, armour: 0,
      weapon: null, prompt: null, objective: null, subtitle: null,
      location: '', district: '',
      markers: null, waypoint: null, route: null,
      northUp: false, zoomMetres: opts.zoomMetres ?? 210,
      vignette: 0, damage: 0,
    };
    // Smoothed mirror of the state. Needles and bars must not step.
    this.disp = { speed: 0, rpm: 0.11, health: 1, armour: 0, heading: 0,
      px: 0, pz: 0, damage: 0, vignette: 0, slip: 0 };

    this._hit = 0;
    this._wantedPrev = 0;
    this._escalateUntil = -1;
    this._flashPhase = 0;
    this._dirty = { vitals: true, status: true, gauge: true, map: true };
    this._mapAt = { x: NaN, z: NaN, h: NaN };
    this._text = {};
    this._last = null;

    this.stats = { scale: 1, dpr: 1, drawCalls: 0, warmMs: 0, updateMs: 0, worstUpdateMs: 0,
      avgUpdateMs: 0, minimapMs: 0, worstMinimapMs: 0, avgMinimapMs: 0,
      bakeMs: 0, bakeMB: 0, frames: 0 };

    this._build();
    const district = opts.district || null;
    const bake = district ? getDistrictMap(district, opts.map) : null;
    if (bake) { this.stats.bakeMs = bake.ms; this.stats.bakeMB = bake.megabytes; this.bake = bake; }
    this.minimap = new Minimap(bake, { zoomMetres: this.state.zoomMetres });

    this._onResize = () => this.layout();
    window.addEventListener('resize', this._onResize);
    this.layout();

    // Force the first blit here, while the loading screen is still up. The bake is
    // ~34 MB of canvas and the first drawImage from it is what makes the driver
    // upload it; measured at 92 ms, which is a visible hitch if it lands on the
    // first frame of gameplay instead of on the last frame of loading.
    const tw = performance.now();
    this.state.px = district ? district.meta.spawn.x : 0;
    this.state.pz = district ? district.meta.spawn.z : 0;
    this.disp.px = this.state.px; this.disp.pz = this.state.pz;
    this._drawMap();
    this.stats.warmMs = +(performance.now() - tw).toFixed(1);
  }

  // ------------------------------------------------------------ construction
  _build() {
    const root = document.createElement('div');
    root.className = 'pv-hud';
    const mk = (cls, parent, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      parent.appendChild(e);
      return e;
    };
    this.vig = mk('pv-veil pv-vig', root);
    this.dmg = mk('pv-veil pv-dmg', root);

    this.cMap = mk('pv-map', root, 'canvas');
    this.cVitals = mk('pv-vitals', root, 'canvas');
    this.cGauge = mk('pv-gauge', root, 'canvas');
    this.cStatus = mk('pv-status', root, 'canvas');

    this.elObj = mk('pv-band pv-obj', root);
    this.elObjTitle = mk('pv-obj-title', this.elObj);
    this.elObjText = mk('pv-obj-text', this.elObj);
    this.elObjDist = mk('pv-obj-dist', this.elObj);

    this.elSub = mk('pv-band pv-sub', root);
    this.elPrompt = mk('pv-band pv-prompt', root);
    this.elKey = mk('pv-key', this.elPrompt);
    this.elPromptText = mk('pv-prompt-text', this.elPrompt);

    this.root = root;
    this.container.appendChild(root);
  }

  /**
   * Recompute the design-pixel scale and resize every canvas backing store.
   * Called on construction, on window resize, and whenever devicePixelRatio moves
   * (a window dragged between displays).
   */
  layout() {
    const r = this.container === document.body
      ? { width: window.innerWidth, height: window.innerHeight }
      : this.container.getBoundingClientRect();
    const W = Math.max(1, r.width), H = Math.max(1, r.height);
    // A purely linear scale keeps the HUD at a fixed fraction of the frame, which
    // over-inflates it at 1440p: legibility is angular, and a bigger display is
    // not viewed proportionally closer. The 0.85 exponent gives 1.00x at 720p,
    // 1.41x at 1080p and 1.80x at 1440p — still clearly readable at speed, with
    // more clear road left over the higher the resolution goes.
    const raw = Math.min(W / 1280, H / 720);
    this.scale = clamp(Math.pow(raw, 0.85), 0.62, 2.4);
    this.dpr = window.devicePixelRatio || 1;
    this._px = this.scale * this.dpr;
    this.root.style.setProperty('--s', String(this.scale));
    this.stats.scale = +this.scale.toFixed(3);
    this.stats.dpr = this.dpr;

    const s = this.scale, L = LAYOUT, m = L.margin * s;
    const place = (c, w, h, css) => {
      c.style.width = `${w * s}px`;
      c.style.height = `${h * s}px`;
      const bw = Math.max(1, Math.round(w * this._px)), bh = Math.max(1, Math.round(h * this._px));
      if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
      Object.assign(c.style, css);
    };
    place(this.cMap, L.map.w, L.map.h,
      { left: `${m}px`, bottom: `${m + (L.vitals.h + L.gap) * s}px` });
    place(this.cVitals, L.vitals.w, L.vitals.h, { left: `${m}px`, bottom: `${m}px` });
    place(this.cGauge, L.gauge.w, L.gauge.h, { right: `${m}px`, bottom: `${m}px` });
    place(this.cStatus, L.status.w, L.status.h, { right: `${m}px`, top: `${m}px` });

    for (const k in this._dirty) this._dirty[k] = true;
    return this;
  }

  // ------------------------------------------------------------ the one entry point
  /**
   * The only way anything reaches the page.
   *
   * Keys absent from `state` keep their previous value; a key explicitly set to
   * `null` clears it. That asymmetry is what lets a caller send only what changed
   * and still be able to dismiss a prompt.
   *
   * Recognised keys:
   *   visible, inVehicle
   *   vehicle              a src/vehicle.js Vehicle; supplies speed / forwardSpeed /
   *                        wheel slip / position / heading in one go
   *   speed, forwardSpeed, slip, gear, rpm
   *   player               {x, z, heading} | {x, z, forward:{x,z}} | {x, z, quaternion}
   *   wanted 0..5, wantedFlash
   *   health 0..1, armour 0..1
   *   weapon               {name, ammo, reserve, icon:'pistol'|'smg'|'none'} | null
   *   prompt               'PRESS F TO ENTER VEHICLE' | {key:'F', text:'ENTER VEHICLE'} | null
   *   objective            {title, text, distance} | 'text' | null
   *   subtitle             {speaker, text} | 'text' | null
   *   location, district   strings under the minimap
   *   markers              [{x, z, kind}]   kind: objective|waypoint|enemy|friend|vehicle|shop
   *   waypoint             {x, z} | null
   *   route                [[x,z], ...] | null   (pass a stable array; identity is the change test)
   *   northUp, zoomMetres
   *   vignette 0..1, damage 0..1
   *   dt                   seconds; measured from the clock if omitted
   */
  update(state = {}) {
    const t0 = performance.now();
    const now = t0 / 1000;
    const dt = state.dt ?? clamp(now - (this._last ?? now), 0, 0.25);
    this._last = now;
    const s = this.state;

    if (state.vehicle) this._readVehicle(state.vehicle);
    for (const k in state) {
      if (k === 'vehicle' || k === 'player' || k === 'dt') continue;
      if (state[k] !== undefined) this._set(k, state[k]);
    }
    if (state.player) this._readPlayer(state.player);

    if (!s.visible) {
      if (this.root.dataset.hidden !== '1') this.root.dataset.hidden = '1';
      this._finish(t0);
      return this;
    }
    if (this.root.dataset.hidden === '1') this.root.dataset.hidden = '0';
    if ((window.devicePixelRatio || 1) !== this.dpr) this.layout();

    // --- animation
    const gear = s.gear != null ? { label: String(s.gear), rpm: s.rpm ?? 0.3 }
                                : gearForSpeed(s.forwardSpeed);
    const rpm = s.rpm != null ? s.rpm : gear.rpm;
    const d = this.disp;
    d.speed = damp(d.speed, s.speed, 9, dt);
    d.rpm = damp(d.rpm, rpm, 11, dt);
    d.slip = damp(d.slip, s.slip, 12, dt);
    d.health = damp(d.health, clamp(s.health, 0, 1), 10, dt);
    d.armour = damp(d.armour, clamp(s.armour, 0, 1), 10, dt);
    d.px = s.px; d.pz = s.pz;
    let dh = s.heading - d.heading;
    dh = ((dh + Math.PI) % TAU + TAU) % TAU - Math.PI;
    d.heading += dh * (1 - Math.exp(-9 * dt));

    if (s.wanted > this._wantedPrev) this._escalateUntil = now + this.escalateSeconds;
    this._wantedPrev = s.wanted;
    const flashing = s.wanted > 0 && (s.wantedFlash || now < this._escalateUntil);
    if (flashing) { this._flashPhase += dt * 2.7; this._dirty.status = true; }

    this._hit = Math.max(0, this._hit - dt * this.damageDecay);
    const lowHp = clamp((0.3 - d.health) / 0.3, 0, 1);
    const pulse = 0.5 + 0.5 * Math.sin(now * 4.4);
    d.damage = clamp(Math.max(s.damage, this._hit) + lowHp * (0.2 + 0.18 * pulse), 0, 1);
    d.vignette = clamp(s.vignette, 0, 1);

    // --- draw
    this._syncText();
    this._syncVeils();
    this._drawMap();
    this._drawGauge(gear.label, rpm);
    if (this._dirty.vitals) this._drawVitals();
    if (this._dirty.status) this._drawStatus(flashing);
    this._finish(t0);
    return this;
  }

  _finish(t0) {
    const ms = performance.now() - t0;
    const st = this.stats;
    st.updateMs = ms;
    st.worstUpdateMs = Math.max(st.worstUpdateMs, ms);
    st.avgUpdateMs = st.frames ? st.avgUpdateMs * 0.94 + ms * 0.06 : ms;
    st.minimapMs = this.minimap.ms;
    st.worstMinimapMs = this.minimap.worstMs;
    st.avgMinimapMs = this.minimap.avgMs;
    st.frames++;
  }

  _set(k, v) {
    const s = this.state;
    if (s[k] === v) return;
    s[k] = v;
    if (k === 'health' || k === 'armour' || k === 'location' || k === 'district') this._dirty.vitals = true;
    else if (k === 'wanted' || k === 'weapon' || k === 'wantedFlash') this._dirty.status = true;
    else if (k === 'markers' || k === 'waypoint' || k === 'route' || k === 'northUp' || k === 'zoomMetres') this._dirty.map = true;
  }

  _readVehicle(v) {
    const s = this.state;
    s.speed = v.speed ?? 0;
    s.forwardSpeed = v.forwardSpeed ?? 0;
    let slip = 0;
    if (v.wheels) for (const w of v.wheels) slip = Math.max(slip, w.slip || 0);
    s.slip = slip;
    s.inVehicle = true;
    if (v.position) { s.px = v.position.x; s.pz = v.position.z; }
    if (v.quaternion) {
      const f = forwardFromQuaternion(v.quaternion);
      s.heading = headingFromForward(f.x, f.z);
    }
  }

  _readPlayer(p) {
    const s = this.state;
    if (p.x !== undefined) s.px = p.x;
    if (p.z !== undefined) s.pz = p.z;
    if (p.heading !== undefined) s.heading = p.heading;
    else if (p.forward) s.heading = headingFromForward(p.forward.x, p.forward.z);
    else if (p.quaternion) {
      const f = forwardFromQuaternion(p.quaternion);
      s.heading = headingFromForward(f.x, f.z);
    }
  }

  // ------------------------------------------------------------ sugar
  // All of these are `update` calls. They exist so a call site reads like an
  // intention, not like a state literal — never as a second way into the DOM.
  setWanted(level, { flash } = {}) {
    return this.update({ wanted: clamp(Math.round(level), 0, 5),
      wantedFlash: flash === undefined ? undefined : !!flash });
  }
  setPrompt(p) { return this.update({ prompt: p ?? null }); }
  setObjective(o) { return this.update({ objective: o ?? null }); }
  setSubtitle(t) { return this.update({ subtitle: t ?? null }); }
  setRoute(points) { return this.update({ route: points ?? null }); }
  setWaypoint(p) { return this.update({ waypoint: p ?? null }); }
  setVisible(v) { return this.update({ visible: !!v }); }
  setNorthUp(v) { return this.update({ northUp: !!v }); }
  /** Damage overlay hook: one hit, decaying at `damageDecay` per second. */
  flashDamage(amount = 0.75) { this._hit = clamp(Math.max(this._hit, amount), 0, 1); return this; }
  resetStats() {
    Object.assign(this.stats, { updateMs: 0, worstUpdateMs: 0, avgUpdateMs: 0,
      minimapMs: 0, worstMinimapMs: 0, avgMinimapMs: 0, frames: 0 });
    this.minimap.worstMs = 0; this.minimap.avgMs = 0;
    return this;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.root.remove();
  }

  // ------------------------------------------------------------ text panels
  // DOM writes are gated on the string actually differing. A per-frame textContent
  // assignment is cheap on its own but it invalidates layout for the whole band,
  // and at 60 Hz across four panels that is real work for no change on screen.
  _write(key, el, str) {
    if (this._text[key] === str) return false;
    this._text[key] = str;
    el.textContent = str;
    return true;
  }

  _band(el, on) {
    const has = el.classList.contains('pv-on');
    if (has !== on) el.classList.toggle('pv-on', on);
  }

  _syncText() {
    const s = this.state;

    const o = s.objective;
    if (o) {
      const obj = typeof o === 'string' ? { text: o } : o;
      this._write('objTitle', this.elObjTitle, obj.title || 'Objective');
      this._write('objText', this.elObjText, obj.text || '');
      this._write('objDist', this.elObjDist,
        obj.distance == null ? '' : `${Math.round(obj.distance)} m`);
    }
    this._band(this.elObj, !!o);

    const sub = s.subtitle;
    if (sub) {
      const t = typeof sub === 'string' ? { text: sub } : sub;
      const key = `${t.speaker || ''}|${t.text || ''}`;
      if (this._text.sub !== key) {
        this._text.sub = key;
        this.elSub.textContent = '';
        if (t.speaker) {
          const sp = document.createElement('span');
          sp.className = 'pv-sub-speaker';
          sp.textContent = `${t.speaker}: `;
          this.elSub.appendChild(sp);
        }
        this.elSub.appendChild(document.createTextNode(t.text || ''));
      }
    }
    this._band(this.elSub, !!sub);

    const p = s.prompt;
    if (p) {
      const t = typeof p === 'string' ? { text: p } : p;
      const hasKey = !!t.key;
      this.elPrompt.classList.toggle('pv-haskey', hasKey);
      if (hasKey) this._write('key', this.elKey, String(t.key));
      this._write('prompt', this.elPromptText, t.text || '');
    }
    this._band(this.elPrompt, !!p);
  }

  // Opacity only, so both veils stay compositor-only work. The 1/255 threshold
  // stops a slowly decaying value from writing style every frame forever.
  _syncVeils() {
    const setOpacity = (el, key, v) => {
      const q = Math.round(clamp(v, 0, 1) * 255) / 255;
      if (this._text[key] === q) return;
      this._text[key] = q;
      el.style.opacity = String(q);
    };
    setOpacity(this.vig, 'vigA', this.disp.vignette);
    setOpacity(this.dmg, 'dmgA', this.disp.damage);
  }

  // ------------------------------------------------------------ minimap
  _drawMap() {
    const d = this.disp;
    const moved = Math.abs(d.px - this._mapAt.x) > 0.02
      || Math.abs(d.pz - this._mapAt.z) > 0.02
      || Math.abs(d.heading - this._mapAt.h) > 0.0012;
    if (!moved && !this._dirty.map) return;
    this._mapAt = { x: d.px, z: d.pz, h: d.heading };
    this._dirty.map = false;

    const s = this.state;
    const ctx = this.cMap.getContext('2d');
    ctx.setTransform(this._px, 0, 0, this._px, 0, 0);
    ctx.clearRect(0, 0, LAYOUT.map.w, LAYOUT.map.h);
    this.minimap.setRoute(s.route);
    this.minimap.draw(ctx, { x: 0, y: 0, w: LAYOUT.map.w, h: LAYOUT.map.h }, {
      px: d.px, pz: d.pz, heading: d.heading,
      northUp: s.northUp, zoomMetres: s.zoomMetres,
      markers: s.markers, waypoint: s.waypoint,
    });
  }

  // ------------------------------------------------------------ vitals
  _drawVitals() {
    this._dirty.vitals = false;
    const L = LAYOUT.vitals;
    const ctx = this.cVitals.getContext('2d');
    ctx.setTransform(this._px, 0, 0, this._px, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    const d = this.disp;

    // Health colour is a state readout, not decoration: below a third it goes
    // amber, below a sixth red, so peripheral vision alone reports the trouble.
    const hp = d.health;
    const hpColour = hp > 0.34 ? THEME.health : hp > 0.16 ? THEME.healthLow : THEME.healthCrit;
    this._bar(ctx, 0, 2, L.w, 7, hp, hpColour);
    this._bar(ctx, 0, 13, L.w, 5, d.armour, THEME.armour);

    const s = this.state;
    ctx.textBaseline = 'alphabetic';
    if (s.location) {
      ctx.font = `600 11.5px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(2,5,9,0.85)';
      ctx.fillText(s.location, 1.8, 33.8);
      ctx.fillStyle = THEME.text;
      ctx.fillText(s.location, 1, 33);
    }
    if (s.district) {
      ctx.font = `600 10px ${FONT}`;
      ctx.fillStyle = THEME.dim;
      ctx.textAlign = 'right';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px';
      ctx.fillText(s.district.toUpperCase(), L.w - 1, 33);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
  }

  // Segmented, because a segmented bar is readable at a glance without being read:
  // "four notches left" lands faster than a bar length does.
  _bar(ctx, x, y, w, h, v, colour) {
    const r = h / 2;
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = 'rgba(6,10,17,0.78)';
    ctx.fill();
    ctx.strokeStyle = THEME.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    const f = clamp(v, 0, 1);
    if (f > 0.001) {
      ctx.save();
      roundRect(ctx, x + 1, y + 1, w - 2, h - 2, r - 0.5);
      ctx.clip();
      ctx.fillStyle = colour;
      ctx.fillRect(x + 1, y + 1, (w - 2) * f, h - 2);
      // Notches are cut out of the fill rather than drawn over the whole bar, so
      // the empty part of the track stays a clean unbroken groove.
      ctx.globalCompositeOperation = 'destination-out';
      for (let i = 1; i < 10; i++) ctx.fillRect(x + (w * i) / 10 - 0.7, y, 1.4, h);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ wanted + weapon
  _drawStatus(flashing) {
    this._dirty.status = flashing;
    const L = LAYOUT.status;
    const ctx = this.cStatus.getContext('2d');
    ctx.setTransform(this._px, 0, 0, this._px, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    const s = this.state;

    const n = 5, size = 19, gap = 5.4;
    const total = n * size + (n - 1) * gap;
    const x0 = L.w - total, cy = 13.5;
    // A 2 Hz square wave, not a sine: the escalation flash has to read as an alarm,
    // and a sine spends most of its time in the middle where it reads as a fade.
    const beat = Math.sin(this._flashPhase * Math.PI) > 0;
    for (let i = 0; i < n; i++) {
      const cx = x0 + size / 2 + i * (size + gap);
      const lit = i < s.wanted;
      const on = lit && (!flashing || beat);
      const ghost = lit && !on;
      if (on) {
        // A fat translucent stroke instead of shadowBlur: a real blur is a
        // per-pixel gather and this runs every frame while the flash is up.
        starPath(ctx, cx, cy, size / 2 + 2.4, size / 4.6);
        ctx.strokeStyle = 'rgba(255,79,94,0.22)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      starPath(ctx, cx, cy, size / 2, size / 4.4);
      ctx.fillStyle = on ? THEME.alert : ghost ? 'rgba(255,79,94,0.26)' : 'rgba(10,15,23,0.55)';
      ctx.fill();
      ctx.strokeStyle = on ? 'rgba(12,4,6,0.85)' : ghost ? 'rgba(255,79,94,0.5)' : THEME.faint;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    // --- weapon slot. A stub by design: the shapes are placeholders, the slot,
    // the ammo layout and the reserve split are the part that has to be right.
    const w = s.weapon;
    const bx = 0, by = 36, bw = L.w, bh = 42;
    roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 5);
    ctx.fillStyle = THEME.plate;
    ctx.fill();
    ctx.strokeStyle = THEME.edge;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = `700 8.5px ${FONT}`;
    ctx.fillStyle = THEME.dim;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.3px';
    ctx.fillText((w && w.name ? w.name : 'Unarmed').toUpperCase(), 9, by + 13);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    this._weaponIcon(ctx, 9, by + 20, 30, 13, w && w.icon);

    ctx.textAlign = 'right';
    if (w && w.ammo != null) {
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = THEME.dim;
      const reserve = w.reserve == null ? '' : ` / ${w.reserve}`;
      const rw = reserve ? ctx.measureText(reserve).width : 0;
      if (reserve) ctx.fillText(reserve, bw - 9, by + 32);
      ctx.font = `700 18px ${MONO}`;
      ctx.fillStyle = THEME.text;
      ctx.fillText(String(w.ammo), bw - 9 - rw, by + 32);
    } else {
      ctx.font = `700 16px ${MONO}`;
      ctx.fillStyle = THEME.faint;
      ctx.fillText('--', bw - 9, by + 32);
    }
  }

  _weaponIcon(ctx, x, y, w, h, kind) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = kind ? THEME.text : THEME.faint;
    ctx.globalAlpha = kind ? 0.86 : 0.5;
    if (kind === 'smg') {
      ctx.fillRect(0, h * 0.18, w * 0.72, h * 0.3);
      ctx.fillRect(w * 0.72, h * 0.24, w * 0.28, h * 0.16);
      ctx.fillRect(w * 0.3, h * 0.48, h * 0.26, h * 0.52);   // magazine
      ctx.fillRect(w * 0.06, h * 0.48, h * 0.22, h * 0.4);   // grip
    } else if (kind === 'pistol') {
      ctx.fillRect(0, h * 0.12, w * 0.8, h * 0.28);
      ctx.beginPath();
      ctx.moveTo(w * 0.08, h * 0.4);
      ctx.lineTo(w * 0.34, h * 0.4);
      ctx.lineTo(w * 0.26, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(w * 0.42, h * 0.44, h * 0.24, 0.1, Math.PI - 0.1);
      ctx.stroke();
    } else {
      ctx.fillRect(0, h * 0.42, w * 0.6, 1.6);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ speedometer
  _drawGauge(gearLabel, rpm) {
    const L = LAYOUT.gauge;
    const ctx = this.cGauge.getContext('2d');
    ctx.setTransform(this._px, 0, 0, this._px, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    if (!this.state.inVehicle) return;

    const cx = 102, cy = 80, R = 64;
    const A0 = Math.PI * 0.985, A1 = Math.PI * 2.015;
    const MAXKMH = 240;
    const d = this.disp;
    const kmh = d.speed * (this.units === 'mph' ? 2.23694 : 3.6);
    const at = (v) => A0 + (clamp(v, 0, MAXKMH) / MAXKMH) * (A1 - A0);

    // Soft ground under the dial instead of a plate. The gauge sits over the road
    // at the bottom of the frame, and a hard rectangle there is exactly the thing
    // the brief calls obscuring.
    const g = ctx.createRadialGradient(cx, cy + 12, 6, cx, cy + 12, 94);
    g.addColorStop(0, 'rgba(4,8,14,0.66)');
    g.addColorStop(0.6, 'rgba(4,8,14,0.38)');
    g.addColorStop(1, 'rgba(4,8,14,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, L.w, L.h);

    // Two concentric rings that never share space: engine speed OUTSIDE the tick
    // ring, road speed inside it. The first pass put the rpm sweep at R-12.5, where
    // it painted straight over the '0' and '60' labels.
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(160,186,220,0.16)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 7, A0, A1);
    ctx.stroke();
    // Redline belongs to the engine, so it lives on the engine ring.
    ctx.strokeStyle = 'rgba(255,79,94,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 7, A0 + 0.86 * (A1 - A0), A1);
    ctx.stroke();
    ctx.lineCap = 'round';
    ctx.strokeStyle = rpm > 0.86 ? THEME.alert : THEME.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 7, A0, A0 + clamp(rpm, 0, 1) * (A1 - A0));
    ctx.stroke();

    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(160,186,220,0.22)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(cx, cy, R, A0, A1);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= MAXKMH; v += 20) {
      const a = at(v), major = v % 60 === 0;
      const c = Math.cos(a), sn = Math.sin(a);
      ctx.strokeStyle = major ? 'rgba(228,238,252,0.88)' : 'rgba(160,186,220,0.42)';
      ctx.lineWidth = major ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + c * (R - (major ? 8 : 5)), cy + sn * (R - (major ? 8 : 5)));
      ctx.lineTo(cx + c * R, cy + sn * R);
      ctx.stroke();
      if (major) {
        ctx.font = `600 8.5px ${MONO}`;
        ctx.fillStyle = THEME.dim;
        ctx.fillText(String(v), cx + c * (R - 17), cy + sn * (R - 17));
      }
    }

    const a = at(kmh);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(6, -3.8);
    ctx.lineTo(R - 10, -1.4);
    ctx.lineTo(R - 10, 1.4);
    ctx.lineTo(6, 3.8);
    ctx.closePath();
    ctx.fillStyle = kmh > 200 ? THEME.alert : '#f4f8ff';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, 4.8, 0, TAU);
    ctx.fillStyle = '#0b1119';
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,220,246,0.62)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.font = `700 37px ${MONO}`;
    ctx.fillStyle = THEME.text;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(Math.round(kmh)), cx, cy + 41);
    ctx.font = `700 8.5px ${FONT}`;
    ctx.fillStyle = THEME.dim;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2.4px';
    ctx.fillText(this.units === 'mph' ? 'MPH' : 'KM/H', cx + 1, cy + 53);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    this._chip(ctx, cx + 63, cy + 27, 32, 27, gearLabel, `700 15px ${MONO}`,
      gearLabel === 'R' ? THEME.alert : THEME.text, false);
    // Traction telltale, straight off vehicle.js's per-wheel slip. It lights before
    // the driver can feel the back stepping out on a controller.
    const slipping = d.slip > 0.55;
    this._chip(ctx, cx - 63, cy + 27, 32, 27, 'TC', `700 11px ${FONT}`,
      slipping ? '#12181f' : THEME.faint, slipping);
  }

  _chip(ctx, cx, cy, w, h, label, font, colour, filled) {
    roundRect(ctx, cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1, 5);
    ctx.fillStyle = filled ? THEME.accent : 'rgba(6,10,17,0.72)';
    ctx.fill();
    ctx.strokeStyle = filled ? THEME.accent : THEME.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = font;
    ctx.fillStyle = colour;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + 0.5);
    ctx.textBaseline = 'alphabetic';
  }
}

/** Convenience constructor mirroring getMaterials()/generateFacadeLibrary() style. */
export function createHUD(opts = {}) { return new HUD(opts); }
