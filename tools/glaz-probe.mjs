// Glazing environment probe: does a pane of tower glass answer the environment
// DIFFERENTLY from the wall beside it, and does that answer change with height
// and with viewpoint?
//
// Three critic rounds reported "glazing has no environment term - the tower pane
// sits at a fixed 0.82-0.84 of the wall beside it right through daylight". The
// first half of that is already known to be wrong: scene.environmentIntensity = 0
// takes a pane from 64.5 to 12.5, so an environment term reaches it. The claim
// this tool exists to settle is the second half - that the answer is FLAT: no
// vertical gradient up a tower, no gradient inside a pane, and no change when the
// camera moves.
//
// Four passes over one frame, so every number is attributed to the surface it
// actually came from rather than to a rectangle drawn on the image by eye:
//
//   shot  the composited frame, through post - what a critic sees
//   kind  material identity, rendered: facade / trim / other
//   rm    the packed (ao, roughness, metalness) texel behind each pixel, which is
//         what separates a glass cell from a wall cell inside ONE atlas material
//   wy    world height in metres (16-bit) and world normal.y, from a shader that
//         rides the same instancing/skinning path the real draw does
//
// The rm and kind classification is pane-audit.mjs's, deliberately: a metric that
// disagrees with the existing audit tool about what a pane IS is not comparable
// with anything already measured.
//
// Usage:
//   node tools/glaz-probe.mjs                       # capture + report
//   GLZ_TAG=after node tools/glaz-probe.mjs         # a second run to compare
//   node tools/glaz-probe.mjs --report before after # compare two captures
//
// Env:
//   GLZ_TAG     capture prefix (default 'glaz')
//   GLZ_TIMES   times of day (default 'noon,golden'; constraint 3 wants >= 2)
//   GLZ_VIEWS   views (default 'towerA,towerB')
//   GLZ_CAL     also capture an environmentIntensity=0 control, which is the
//               instrument's proof that it can produce the opposite reading
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const OUT = process.env.GLZ_OUT
  ?? '/tmp/claude-0/-home-user-gpta-6/481b6aa3-9372-53ec-9397-cb1259b5e6bf/scratchpad/glaz';
const SHOTS = 'docs/shots';
const TAG = process.env.GLZ_TAG ?? 'glaz';
const TIMES = (process.env.GLZ_TIMES ?? 'noon,golden').split(',');
const VIEW_NAMES = (process.env.GLZ_VIEWS ?? 'towerA,towerB').split(',');
// The viewport. Overridable because a view named `pano:<id>:<L|R>` has to be
// captured at tools/pano-match.mjs' 4:3 frame or its fov means something else.
const W = Number(process.env.GLZ_W ?? 1280), H = Number(process.env.GLZ_H ?? 720);

// Building 55: h 54.4 m, a 107 m glazed face, the largest unobstructed curtain
// wall in the district. Chosen by tools' pick over every h >= 26 building (all of
// which take the bayTower recipe) on projected facade area with a clear
// sightline; both camera points stand 7-11 m clear of the nearest footprint.
// A and B look at the SAME face from 20 degrees apart, which is the view
// dependence test: a reflection moves when the camera moves, a tint does not.
const VIEWS = {
  towerA: { cam: [-152.8, 2.5, -85.9], target: [-190.6, 27.2, -118.6], fov: 60 },
  towerB: { cam: [-165.9, 2.5, -70.7], target: [-190.6, 27.2, -118.6], fov: 60 },
  // hero-shots.mjs's corridor frame, its placement search run offline against
  // data/district.json and the result baked here. It is the frame the recorded
  // "pane sits at 0.82-0.84 of the wall" claim and the GLAZING contract's 64.5
  // were measured on, so the probe has to be able to stand in it.
  corridor: { cam: [3.69, 2.4, -1.93], target: [269.02, 16, -77.9], fov: 55 },
};

// ------------------------------------------------------- panorama stations
//
// A view named `pano:<id>:<L|R>` stands the camera exactly where the Mapillary
// panorama of that id stood and aims it at the same street wall, with
// pano-match.mjs' camera: 2.5 m eye, 12 degrees of up-pitch, 75 degrees
// horizontal on 4:3. That makes a glaz-probe capture - which carries the packed
// roughness/metalness mask and the world-height pass - directly comparable with
// reference/sarasota/mapillary/views/<id>-<side>.png, so the reference detector
// can be checked against ground truth on the SAME view of the SAME street.
//
// The guard that matters: reproject-pano.mjs picks the corridor bearing from the
// WHOLE route and pano-match.mjs from its first five waypoints only, because the
// rest of the route loops back on 2nd Street. At a station near that loop the two
// disagree and "L" is a different wall in the photograph than in the render -
// silently, and in a way that looks like a massing fault. Stations where they
// differ are refused here rather than measured.
const PM = { eye: 2.5, pitchDeg: 12, hfovDeg: 75, aspect: 4 / 3 };
export function panoStations(w = W, h = H) {
  const idx = JSON.parse(fs.readFileSync('reference/sarasota/mapillary/index.json', 'utf8'));
  const route = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route;
  const bearing = (x, z, n) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i + 1 < n; i++) {
      const a = route[i], b = route[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < bestD) { bestD = d; best = (Math.atan2(dx, -dz) * 180) / Math.PI; }
    }
    return (best + 360) % 360;
  };
  const vfov = (2 * Math.atan(Math.tan((PM.hfovDeg * Math.PI) / 360) / (w / h)) * 180) / Math.PI;
  const out = new Map();
  for (const p of idx.images) {
    if (!p.isPano) continue;
    const bHero = bearing(p.x, p.z, 5), bAll = bearing(p.x, p.z, route.length);
    let d = Math.abs(bHero - bAll); if (d > 180) d = 360 - d;
    for (const [side, off] of [['L', -90], ['R', 90]]) {
      const yaw = (((bHero + off) % 360) + 360) % 360;
      const rad = (yaw * Math.PI) / 180, DIST = 60;
      out.set(`pano:${p.id}:${side}`, {
        cam: [p.x, PM.eye, p.z],
        target: [p.x + Math.sin(rad) * DIST, PM.eye + DIST * Math.tan((PM.pitchDeg * Math.PI) / 180), p.z - Math.cos(rad) * DIST],
        fov: vfov, id: p.id, side, yaw: +yaw.toFixed(1), station: p.station,
        bearingSplit: +d.toFixed(1),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- analysis
// The right inverse for this renderer is the sRGB decode FOLLOWED BY the ACES
// one: post.js writes srgb(aces(color * exposure)) to the framebuffer. It used to
// write the tonemap output raw, and this table used to be the tonemap inverse
// alone; an archived frame from before that change needs critic-metrics.mjs's
// acesOnly(). Copied from critic-metrics.mjs, which derives it at length.
const s2lg = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  s2lg[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
// ...and the composite now runs a highlight rolloff in FRONT of the fit, so the
// inverse ends with roll^-1. Constants mirror src/post.js's params block; a
// frame captured before that change needs a2lFlat below.
const ROLL_KNEE = 0.5, ROLL_CEIL = 8.0;
const rollInverse = (y) => {
  if (y <= ROLL_KNEE) return y;
  const S = ROLL_CEIL - ROLL_KNEE, u = y - ROLL_KNEE;
  return u >= S ? Infinity : ROLL_KNEE + (S * u) / (S - u);
};
const a2l = new Float64Array(256), a2lFlat = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const y = s2lg[i];
  const A = 2.43 * y - 2.51, B = 0.59 * y - 0.03, C = 0.14 * y;
  if (Math.abs(A) < 1e-9) { a2lFlat[i] = B !== 0 ? -C / B : 0; a2l[i] = rollInverse(a2lFlat[i]); continue; }
  const disc = B * B - 4 * A * C;
  if (disc < 0) { a2lFlat[i] = 0; a2l[i] = 0; continue; }
  const roots = [(-B + Math.sqrt(disc)) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)].filter((v) => v >= 0);
  a2lFlat[i] = roots.length ? Math.min(...roots) : 0;
  a2l[i] = rollInverse(a2lFlat[i]);
}
const sceneY = (r, g, b) => 0.2126 * a2l[r] + 0.7152 * a2l[g] + 0.0722 * a2l[b];
const luma8 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const f = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : 'n/a');

// pane-audit/pane-stats' definition, unchanged: a glass texel is a smooth,
// metallic one, and nothing else in the facade atlas is both.
const isGlassTexel = (g, b) => g < 96 && b > 100;

export function loadCapture(base) {
  const meta = JSON.parse(fs.readFileSync(`${base}.meta.json`, 'utf8'));
  return {
    meta,
    png: readPNG(`${base}.png`),
    kind: new Uint8Array(fs.readFileSync(`${base}.kind.bin`)),
    rm: new Uint8Array(fs.readFileSync(`${base}.rm.bin`)),
    wy: new Uint8Array(fs.readFileSync(`${base}.wy.bin`)),
    w: meta.w, h: meta.h,
  };
}

/** Per-pixel class (0 other, 1 facade glass, 2 facade wall) + world height. */
export function classify(cap) {
  const { kind, rm, wy, w, h } = cap;
  const cls = new Uint8Array(w * h);
  const height = new Float32Array(w * h);
  const azim = new Float32Array(w * h);
  const normY = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    height[i] = ((wy[i * 4] * 256 + wy[i * 4 + 1]) / 65535) * 200;
    const ny = wy[i * 4 + 2] / 255 * 2 - 1;
    azim[i] = (wy[i * 4 + 3] / 255 - 0.5) * Math.PI * 2;
    normY[i] = ny;
    if (kind[i * 4] < 200) continue;                 // not a facade material
    if (Math.abs(ny) > 0.35) continue;               // roof, sill, parapet - not a wall face
    const g = rm[i * 4 + 1], b = rm[i * 4 + 2];
    // The parking deck's void is ao<60, roughness>240 - a hole, not glazing.
    if (rm[i * 4] < 60 && g > 240) continue;
    cls[i] = isGlassTexel(g, b) ? 1 : 2;
  }
  return { cls, height, azim, normY };
}

/**
 * The reflected ray for every pixel, from the camera matrix and the surface
 * normal the wy pass wrote - no world position needed, because
 * R = reflect( rayDir, N ) depends only on those two.
 */
function reflectElevation(cap, cls, azim, normY) {
  const { w, h, meta } = cap;
  const C = meta.cam.cam, T = meta.cam.target;
  const fwd = [T[0] - C[0], T[1] - C[1], T[2] - C[2]];
  const nrm = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  const F = nrm(fwd);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const R0 = nrm(cross(F, [0, 1, 0]));
  const U = cross(R0, F);
  const tanHalf = Math.tan((meta.cam.fov * Math.PI) / 180 / 2);
  const aspect = w / h;
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 0; y < h; y++) {
    const ndcY = 1 - ((y + 0.5) / h) * 2;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cls[i]) continue;
      const ndcX = ((x + 0.5) / w) * 2 - 1;
      const d = nrm([
        F[0] + R0[0] * ndcX * tanHalf * aspect + U[0] * ndcY * tanHalf,
        F[1] + R0[1] * ndcX * tanHalf * aspect + U[1] * ndcY * tanHalf,
        F[2] + R0[2] * ndcX * tanHalf * aspect + U[2] * ndcY * tanHalf,
      ]);
      const ny = normY[i], hxz = Math.sqrt(Math.max(0, 1 - ny * ny));
      const N = [Math.cos(azim[i]) * hxz, ny, Math.sin(azim[i]) * hxz];
      const dn = d[0] * N[0] + d[1] * N[1] + d[2] * N[2];
      const ry = d[1] - 2 * dn * N[1];
      const rx = d[0] - 2 * dn * N[0], rz = d[2] - 2 * dn * N[2];
      out[i] = (Math.asin(Math.max(-1, Math.min(1, ry / Math.hypot(rx, ry, rz)))) * 180) / Math.PI;
    }
  }
  return out;
}

/** 4-connected components of one class, for per-pane statistics. */
function components(cls, want, w, h, minArea) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (cls[i] !== want || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    const px = [];
    while (sp) {
      const p = stack[--sp];
      px.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && cls[p - 1] === want && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && cls[p + 1] === want && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && cls[p - w] === want && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && cls[p + w] === want && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (px.length >= minArea) out.push(px);
  }
  return out;
}

const BANDS = [[0, 8], [8, 16], [16, 24], [24, 32], [32, 40], [40, 60]];

export function report(base) {
  const cap = loadCapture(base);
  const { w, h, png, meta } = cap;
  const { cls, height, azim, normY } = classify(cap);
  const rel = reflectElevation(cap, cls, azim, normY);
  const ch = png.channels;
  const at = (i) => [png.data[i * ch], png.data[i * ch + 1], png.data[i * ch + 2]];

  // Channels are accumulated in SCENE-LINEAR as well as in 8-bit. A ratio of
  // 8-bit values out of this renderer is a ratio of aces(x) - a compressive
  // curve - so B/R read off the bytes understates a blue cast by a lot and is
  // not comparable with the same ratio taken off a photograph.
  const acc = () => ({ n: 0, y: 0, l8: 0, r: 0, g: 0, b: 0, lr: 0, lg: 0, lb: 0 });
  const push = (a, i) => {
    const [r, g, b] = at(i);
    a.n++; a.y += sceneY(r, g, b); a.l8 += luma8(r, g, b); a.r += r; a.g += g; a.b += b;
    a.lr += a2l[r]; a.lg += a2l[g]; a.lb += a2l[b];
  };
  const fin = (a) => (a.n
    ? { n: a.n, sceneY: a.y / a.n, l8: a.l8 / a.n, rgb: [a.r / a.n, a.g / a.n, a.b / a.n],
      lin: [a.lr / a.n, a.lg / a.n, a.lb / a.n], br: a.lr > 1e-9 ? a.lb / a.lr : NaN }
    : { n: 0, sceneY: 0, l8: 0, rgb: [0, 0, 0], lin: [0, 0, 0], br: NaN });

  // One frame holds three buildings at three orientations, and averaging their
  // panes into one height band hides exactly the thing being measured. The face
  // filter keeps the single dominant glass plane: the modal normal azimuth and
  // everything within 20 degrees of it.
  const azHist = new Map();
  for (let i = 0; i < w * h; i++) {
    if (cls[i] !== 1) continue;
    const b = Math.round((azim[i] * 180) / Math.PI / 5) * 5;
    azHist.set(b, (azHist.get(b) ?? 0) + 1);
  }
  let domAz = 0, domN = -1;
  for (const [b, n] of azHist) if (n > domN) { domN = n; domAz = b; }
  const inFace = (i) => {
    let d = ((azim[i] * 180) / Math.PI) - domAz;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return Math.abs(d) <= 20;
  };

  const glass = acc(), wall = acc();
  const bands = BANDS.map(() => ({ glass: acc(), wall: acc() }));
  const fGlass = acc(), fWall = acc();
  const fBands = BANDS.map(() => ({ glass: acc(), wall: acc() }));
  const elev = new Map();
  for (let i = 0; i < w * h; i++) {
    if (!cls[i]) continue;
    const isG = cls[i] === 1;
    push(isG ? glass : wall, i);
    const y = height[i];
    for (let b = 0; b < BANDS.length; b++) {
      if (y >= BANDS[b][0] && y < BANDS[b][1]) { push(isG ? bands[b].glass : bands[b].wall, i); break; }
    }
    if (!inFace(i)) continue;
    push(isG ? fGlass : fWall, i);
    for (let b = 0; b < BANDS.length; b++) {
      if (y >= BANDS[b][0] && y < BANDS[b][1]) { push(isG ? fBands[b].glass : fBands[b].wall, i); break; }
    }
    // Luminance against the elevation the pane is reflecting FROM, which is the
    // one axis the chrome-ball environment profile is also indexed by.
    if (isG && Number.isFinite(rel[i])) {
      const e = Math.round(rel[i] / 10) * 10;
      const a = elev.get(e) ?? acc();
      push(a, i);
      elev.set(e, a);
    }
  }

  // Per-pane: mean, and the top-third / bottom-third split INSIDE one pane.
  const panes = components(cls, 1, w, h, 40).map((px) => {
    let y0 = 1e9, y1 = -1e9, hs = 0;
    for (const p of px) { const y = (p / w) | 0; if (y < y0) y0 = y; if (y > y1) y1 = y; hs += height[p]; }
    const span = Math.max(1, y1 - y0 + 1);
    const top = acc(), bot = acc(), all = acc();
    for (const p of px) {
      const fr = (((p / w) | 0) - y0) / span;
      push(all, p);
      if (fr < 1 / 3) push(top, p); else if (fr >= 2 / 3) push(bot, p);
    }
    return { area: px.length, worldY: hs / px.length, mean: fin(all), top: fin(top), bot: fin(bot) };
  });
  const paneY = panes.map((p) => p.mean.sceneY);
  const mu = mean(paneY);
  const sd = Math.sqrt(mean(paneY.map((v) => (v - mu) ** 2)));
  // Within-pane vertical contrast, as a ratio so it is exposure-independent.
  const tb = panes.filter((p) => p.top.n > 4 && p.bot.n > 4).map((p) => p.top.sceneY / Math.max(1e-6, p.bot.sceneY));

  // Slope of pane luminance against world height, on the panes themselves: the
  // "does a tower have a vertical gradient" number, normalised by the mean so it
  // reads as fraction-per-metre and can be compared across times of day.
  let sxx = 0, sxy = 0, sx = 0, sy = 0, nP = 0;
  for (const p of panes) { sx += p.worldY; sy += p.mean.sceneY; sxx += p.worldY ** 2; sxy += p.worldY * p.mean.sceneY; nP++; }
  const slope = nP > 2 ? (nP * sxy - sx * sy) / Math.max(1e-9, nP * sxx - sx * sx) : 0;

  return {
    base: path.basename(base), meta,
    glass: fin(glass), wall: fin(wall),
    ratio: fin(glass).sceneY / Math.max(1e-9, fin(wall).sceneY),
    bands: BANDS.map(([lo, hi], b) => ({
      lo, hi, glass: fin(bands[b].glass), wall: fin(bands[b].wall),
      ratio: fin(bands[b].glass).sceneY / Math.max(1e-9, fin(bands[b].wall).sceneY),
    })),
    panes: {
      count: panes.length, meanY: mu, cv: mu > 0 ? sd / mu : 0,
      slopePerM: slope, slopeRel: mu > 0 ? slope / mu : 0,
      topOverBottom: mean(tb),
    },
    face: {
      azimuth: domAz, glass: fin(fGlass), wall: fin(fWall),
      ratio: fin(fGlass).sceneY / Math.max(1e-9, fin(fWall).sceneY),
      bands: BANDS.map(([lo, hi], b) => ({
        lo, hi, glass: fin(fBands[b].glass), wall: fin(fBands[b].wall),
        ratio: fin(fBands[b].glass).sceneY / Math.max(1e-9, fin(fBands[b].wall).sceneY),
      })),
      byElevation: [...elev.entries()].sort((a, b) => a[0] - b[0])
        .filter(([, a]) => a.n > 500).map(([e, a]) => ({ e, ...fin(a) })),
    },
    paneList: panes.map((p) => ({ y: +p.worldY.toFixed(1), a: p.area, m: +p.mean.sceneY.toFixed(5) })),
  };
}

export function fmt(r) {
  const L = [];
  const c = (a) => `(${a.map((v) => Math.round(v)).join(',')})`;
  L.push(`${r.base}   exposure ${f(r.meta.exposure, 6)}  chunks ${r.meta.world?.chunksLoaded}  queued ${r.meta.world?.queued}`);
  L.push(`  glass ${String(r.glass.n).padStart(7)} px  8-bit ${f(r.glass.l8).padStart(6)}  sceneY ${f(r.glass.sceneY, 5).padStart(9)}  rgb ${c(r.glass.rgb)}`);
  L.push(`  wall  ${String(r.wall.n).padStart(7)} px  8-bit ${f(r.wall.l8).padStart(6)}  sceneY ${f(r.wall.sceneY, 5).padStart(9)}  rgb ${c(r.wall.rgb)}`);
  L.push(`  linear B/R   glass ${f(r.glass.br, 3)}   wall ${f(r.wall.br, 3)}   `
    + `shift ${f(r.glass.br / r.wall.br, 3)}      (reference photographs: glass 0.82, shift 0.94 median)`);
  L.push(`  glass:wall ${f(r.ratio, 3)}   panes ${r.panes.count}  cv ${f(r.panes.cv, 3)}  ` +
    `top/bottom-in-pane ${f(r.panes.topOverBottom, 3)}  slope ${f(r.panes.slopeRel * 100, 3)} %/m`);
  for (const b of r.bands) {
    if (b.glass.n < 200 || b.wall.n < 200) continue;
    L.push(`   ${String(b.lo).padStart(2)}-${String(b.hi).padStart(2)} m  glass ${String(b.glass.n).padStart(6)} px ${f(b.glass.l8).padStart(6)}` +
      `   wall ${String(b.wall.n).padStart(6)} px ${f(b.wall.l8).padStart(6)}   ratio ${f(b.ratio, 3)}`);
  }
  L.push(`  MAIN FACE (azimuth ${r.face.azimuth} deg +-20)  glass ${r.face.glass.n} px ${f(r.face.glass.l8)}  ` +
    `wall ${r.face.wall.n} px ${f(r.face.wall.l8)}  ratio ${f(r.face.ratio, 3)}`);
  for (const b of r.face.bands) {
    if (b.glass.n < 200 || b.wall.n < 200) continue;
    L.push(`   ${String(b.lo).padStart(2)}-${String(b.hi).padStart(2)} m  glass ${String(b.glass.n).padStart(6)} px ${f(b.glass.l8).padStart(6)}` +
      `   wall ${String(b.wall.n).padStart(6)} px ${f(b.wall.l8).padStart(6)}   ratio ${f(b.ratio, 3)}`);
  }
  // The crux: pane luminance against the elevation it reflects from, beside what
  // a chrome ball says the environment offers at that same elevation.
  const env = new Map((r.meta.envProfile ?? []).map((e) => [e.el, e.nits]));
  L.push('   reflected elev:  ' + r.face.byElevation.map((e) => `${e.e}deg`).map((s2) => s2.padStart(8)).join(''));
  L.push('   pane 8-bit:      ' + r.face.byElevation.map((e) => f(e.l8)).map((s2) => s2.padStart(8)).join(''));
  L.push('   pane nits:       ' + r.face.byElevation.map((e) => Math.round(e.sceneY / (r.meta.exposure || 1))).map((s2) => String(s2).padStart(8)).join(''));
  L.push('   env nits (ball): ' + r.face.byElevation.map((e) => {
    const v = env.get(e.e) ?? env.get(e.e - 5) ?? env.get(e.e + 5);
    return v === undefined ? '-' : String(Math.round(v));
  }).map((s2) => s2.padStart(8)).join(''));
  // The decomposition, on one line: a pane's blue is its COATING's blue times
  // the blue of what it is reflecting. Both halves are measured here - the pane
  // from the frame, the environment from the chrome ball - at the same elevation.
  const envBR = new Map((r.meta.envProfile ?? []).map((e) => [e.el, e.br]));
  L.push('   pane B/R:        ' + r.face.byElevation.map((e) => f(e.br, 2)).map((s2) => s2.padStart(8)).join(''));
  L.push('   env  B/R:        ' + r.face.byElevation.map((e) => {
    const v = envBR.get(e.e) ?? envBR.get(e.e - 5) ?? envBR.get(e.e + 5);
    return v === undefined ? '-' : v.toFixed(2);
  }).map((s2) => s2.padStart(8)).join(''));
  L.push('   pane/env B/R:    ' + r.face.byElevation.map((e) => {
    const v = envBR.get(e.e) ?? envBR.get(e.e - 5) ?? envBR.get(e.e + 5);
    return v === undefined || !v ? '-' : (e.br / v).toFixed(2);
  }).map((s2) => s2.padStart(8)).join(''));
  return L.join('\n');
}

/** A mask overlay so what is IN the sample is looked at, not assumed. */
export function overlay(base, out) {
  const cap = loadCapture(base);
  const { w, h, png } = cap;
  const { cls } = classify(cap);
  const ch = png.channels;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let r = png.data[i * ch], g = png.data[i * ch + 1], b = png.data[i * ch + 2];
      if (cls[i] === 0) { r = (r * 0.25) | 0; g = (g * 0.25) | 0; b = (b * 0.25) | 0; }
      else if (cls[i] === 2) { r = Math.min(255, (r * 0.45 + 60) | 0); g = (g * 0.45) | 0; b = (b * 0.45) | 0; }
      else { r = (r * 0.45) | 0; g = Math.min(255, (g * 0.45 + 60) | 0); b = (b * 0.45) | 0; }
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(out, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  return out;
}
let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/**
 * A/B over the pixels BOTH captures call the same thing. The classification
 * itself can move when a material's roughness moves, so comparing two
 * independently-built masks compares two different sets of pixels.
 */
export function pair(a, b) {
  const A = loadCapture(a), B = loadCapture(b);
  const ca = classify(A), cb = classify(B);
  const { w, h } = A;
  const out = { shared: 0 };
  for (const want of [1, 2]) {
    const key = want === 1 ? 'glass' : 'wall';
    for (const [name, cap] of [['before', A], ['after', B]]) {
      const ch = cap.png.channels;
      let n = 0, y = 0, l8 = 0;
      for (let i = 0; i < w * h; i++) {
        if (ca.cls[i] !== want || cb.cls[i] !== want) continue;
        const r = cap.png.data[i * ch], g = cap.png.data[i * ch + 1], bl = cap.png.data[i * ch + 2];
        n++; y += sceneY(r, g, bl); l8 += luma8(r, g, bl);
      }
      out[`${key}.${name}`] = { n, sceneY: y / (n || 1), l8: l8 / (n || 1) };
    }
    // Height-banded, on shared pixels only.
    out[`${key}.bands`] = BANDS.map(([lo, hi]) => {
      const r = { lo, hi, before: 0, after: 0, n: 0 };
      for (let i = 0; i < w * h; i++) {
        if (ca.cls[i] !== want || cb.cls[i] !== want) continue;
        const yy = ca.height[i];
        if (yy < lo || yy >= hi) continue;
        const cA = A.png.channels, cB = B.png.channels;
        r.before += sceneY(A.png.data[i * cA], A.png.data[i * cA + 1], A.png.data[i * cA + 2]);
        r.after += sceneY(B.png.data[i * cB], B.png.data[i * cB + 1], B.png.data[i * cB + 2]);
        r.n++;
      }
      if (r.n) { r.before /= r.n; r.after /= r.n; }
      return r;
    });
  }
  return out;
}

// ---------------------------------------------------------- compile check
// glassStorefront and glassTinted are registered by MaterialRegistry but nothing
// in the streamed district draws them today, so a GLSL error in the mask-free
// branch of applyGlazingEnv would never surface in a district frame. This puts
// one quad of each in front of the camera and renders it, and fails on anything
// WebGL logs. A shader that is never compiled is not known to compile.
async function compileCheck() {
  await ensureServer();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // A missing favicon is not a shader error; everything else is worth failing on.
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push(`console: ${m.text()}`);
    }
  });
  await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
  const out = await page.evaluate(async () => {
    const THREE = await import('/vendor/three.module.min.js');
    const reg = __district.world.registry;
    const cam = __district.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const made = [];
    for (const key of ['glassStorefront', 'glassTinted']) {
      const mat = reg.get(key);
      if (!mat) { made.push({ key, missing: true }); continue; }
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      q.position.copy(cam.position).addScaledVector(fwd, 4);
      q.quaternion.copy(cam.quaternion);
      __district.scene.add(q);
      made.push({ key, tags: (mat.userData.veranoTags ?? []).join('|') });
    }
    __district.renderer.compile(__district.scene, cam);
    __district.renderer.render(__district.scene, cam);
    return made;
  });
  await page.waitForTimeout(3000);
  console.log('compile check:', JSON.stringify(out));
  console.log(errors.length ? `FAILED:\n${errors.join('\n')}` : 'no GL or page errors');
  await browser.close();
  if (errors.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ canyon
// Where GLAZING.canyon's H and D come from, kept here so the constants in
// src/materials.js can be re-derived rather than believed. Casts a ray out of the
// outward normal of every building edge in the bake and records the first
// footprint it hits: that distance and that building's height ARE the street the
// pane is standing in.
export function canyonScan(file = 'data/district.json') {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const B = d.buildings;
  const inRing = (r, x, z) => {
    let s2 = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) s2 = !s2;
    }
    return s2;
  };
  const hit = (ox, oz, dx, dz, x0, z0, x1, z1) => {
    const ex = x1 - x0, ez = z1 - z0;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) return Infinity;
    const t = ((x0 - ox) * ez - (z0 - oz) * ex) / den;
    const u = ((x0 - ox) * dz - (z0 - oz) * dx) / den;
    return (t <= 0.1 || u < 0 || u > 1) ? Infinity : t;
  };
  const MAX = 160;
  const rec = [];
  for (let bi = 0; bi < B.length; bi++) {
    const p = B[bi].p;
    for (let i = 0; i < p.length; i++) {
      const A = p[i], C = p[(i + 1) % p.length];
      const len = Math.hypot(C[0] - A[0], C[1] - A[1]);
      if (len < 4) continue;                        // a chamfer is not a facade
      const mx = (A[0] + C[0]) / 2, mz = (A[1] + C[1]) / 2;
      let nx = (C[1] - A[1]) / len, nz = -(C[0] - A[0]) / len;
      if (inRing(p, mx + nx * 0.5, mz + nz * 0.5)) { nx = -nx; nz = -nz; }
      let best = Infinity, bh = 0;
      for (let k = 0; k < B.length; k++) {
        if (k === bi) continue;
        const q = B[k].p;
        for (let j = 0; j < q.length; j++) {
          const t = hit(mx + nx * 0.2, mz + nz * 0.2, nx, nz,
            q[j][0], q[j][1], q[(j + 1) % q.length][0], q[(j + 1) % q.length][1]);
          if (t < best) { best = t; bh = B[k].h ?? 6; }
        }
      }
      rec.push({ len, d: Math.min(best, MAX), h: bh, open: best > MAX, self: B[bi].h ?? 6 });
    }
  }
  const wq = (arr, key, q) => {
    const srt = arr.slice().sort((a, b) => a[key] - b[key]);
    const tot = srt.reduce((t, r) => t + r.len, 0);
    let acc2 = 0;
    for (const r of srt) { acc2 += r.len; if (acc2 >= tot * q) return r[key]; }
    return srt.length ? srt[srt.length - 1][key] : 0;
  };
  const closed = rec.filter((r) => !r.open);
  const tall = closed.filter((r) => r.self >= 26);
  return {
    edges: rec.length, closed: closed.length,
    all: { d: wq(closed, 'd', 0.5), h: wq(closed, 'h', 0.5) },
    towers: { n: tall.length, d: wq(tall, 'd', 0.5), h: wq(tall, 'h', 0.5) },
  };
}

// The source files whose contents decide what a capture MEANS. A before/after
// pair is only a comparison of one change if everything else was identical, and
// on 2026-09-05 it was not: another agent moved the noon exposure 1/69,490 ->
// 1/14,000 (+2.31 stops) in the middle of a capture run. A page holds the module
// it imported at load, so half a run can silently predate an edit the other half
// postdates, and the resulting before/after shows a large, confident, spurious
// improvement. Hashing them at page load AND at every shot makes that visible
// instead of leaving it for a reviewer to find.
const SRC_WATCH = ['src/daynight.js', 'src/materials.js', 'src/facades.js', 'src/post.js', 'src/sky.js'];
export function srcStamp() {
  const out = {};
  for (const f of SRC_WATCH) {
    try { out[f] = createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12); }
    catch { out[f] = 'missing'; }
  }
  return out;
}

// ---------------------------------------------------------------- capture
async function capture() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  await ensureServer();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
  await page.evaluate(() => { __district.setHudEnabled(false); __district.setTraffic(0); __district.setPedestrians(0); });

  await page.evaluate(async () => {
    const THREE = await import('/vendor/three.module.min.js');
    // World height + world normal.y, on the same instancing path the real draw
    // uses, so an InstancedMesh street tree occludes here exactly as it does in
    // the frame. 16-bit height over 0-200 m is 3 mm, which is finer than a pane.
    const wyMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vW; varying vec3 vN;
        void main() {
          vec4 wp = vec4( position, 1.0 );
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
          #endif
          vec3 n = normalMatrix * normal;
          vW = ( modelMatrix * wp ).xyz;
          vN = normalize( mat3( modelMatrix ) * normal );
          gl_Position = projectionMatrix * modelViewMatrix * wp;
        }`,
      fragmentShader: `
        varying vec3 vW; varying vec3 vN;
        void main() {
          float y = clamp( vW.y / 200.0, 0.0, 1.0 ) * 65535.0;
          float hi = floor( y / 256.0 );
          // alpha carries the normal's azimuth, which is what lets the reflected
          // ray be reconstructed per pixel and compared against the chrome ball.
          float az = atan( vN.z, vN.x ) / 6.2831853 + 0.5;
          gl_FragColor = vec4( hi / 255.0, ( y - hi * 256.0 ) / 255.0, vN.y * 0.5 + 0.5, az );
        }`,
    });

    window.__glzScan = (mode) => {
      const d = __district, r = d.renderer, sc = d.scene, cam = d.camera;
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      const SW = size.x, SH = size.y;
      const rt = new THREE.WebGLRenderTarget(SW, SH, { type: THREE.UnsignedByteType });
      const saved = [], hidden = [], csSaved = [];
      const meshes = [];
      sc.traverse((o) => {
        if (o.name === 'sky') { if (o.visible) { hidden.push(o); o.visible = false; } return; }
        if (o.isMesh && o.visible && o.material && !Array.isArray(o.material)) meshes.push(o);
      });
      for (const o of meshes) {
        const m = o.material;
        let mat;
        if (mode === 'wy') mat = wyMat;
        else if (mode === 'kind') {
          const n = m.name || '';
          const v = n.startsWith('facade:') ? 1 : (n === 'trim' ? 0.5 : 0);
          mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(v, 0, 0) });
          mat.toneMapped = false;
        } else {
          const tex = m.roughnessMap;
          if (!tex) { mat = new THREE.MeshBasicMaterial({ color: 0x000000 }); }
          else {
            if (tex.colorSpace && tex.colorSpace !== THREE.NoColorSpace) {
              csSaved.push([tex, tex.colorSpace]); tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
            }
            mat = new THREE.MeshBasicMaterial({ map: tex });
          }
          mat.toneMapped = false;
        }
        if (mat !== wyMat) { mat.side = m.side; mat.fog = false; }
        saved.push([o, m]);
        o.material = mat;
      }
      const oldTone = r.toneMapping;
      const oldClear = r.getClearColor(new THREE.Color()).getHex(), oldAlpha = r.getClearAlpha();
      r.toneMapping = THREE.NoToneMapping;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.render(sc, cam);
      const buf = new Uint8Array(SW * SH * 4);
      r.readRenderTargetPixels(rt, 0, 0, SW, SH, buf);
      r.setRenderTarget(null);
      r.toneMapping = oldTone;
      r.setClearColor(oldClear, oldAlpha);
      for (const [o, m] of saved) { if (o.material !== wyMat) o.material.dispose(); o.material = m; }
      for (const [t, cs] of csSaved) { t.colorSpace = cs; t.needsUpdate = true; }
      for (const o of hidden) o.visible = true;
      rt.dispose();
      // Readback is bottom-up; hand back top-down to match the screenshot.
      const out = new Uint8Array(SW * SH * 4);
      for (let y = 0; y < SH; y++) out.set(buf.subarray((SH - 1 - y) * SW * 4, (SH - y) * SW * 4), y * SW * 4);
      let s = '';
      for (let i = 0; i < out.length; i += 32768) s += String.fromCharCode.apply(null, out.subarray(i, i + 32768));
      return { w: SW, h: SH, b64: btoa(s) };
    };

    // What the environment ITSELF looks like to a mirror, independent of any
    // building: a chrome ball rendered through an orthographic camera into a
    // FLOAT target, so the readback is radiance in nits rather than a tone-mapped
    // byte. Pixel -> sphere normal -> reflect direction is exact under ortho, so
    // every sample carries the elevation it came from. This is the premise of the
    // whole exercise ("a flat pane and the flat wall reflect nearly the same
    // uniform patch") measured rather than assumed.
    window.__glzEnv = (diffuse) => {
      const d = __district, r = d.renderer, sc = d.scene, cam = d.camera;
      const N = 128;
      // metalness 1 / roughness 0.02 is a mirror and reports RADIANCE by
      // direction; metalness 0 / roughness 1 is a lambertian and reports the
      // IRRADIANCE the same point stands in. The second arm exists because the
      // diffuse remainder of a pane (16-45% of its albedo, depending on the cell)
      // is lit by irradiance and applyGlazingEnv deliberately does not touch it -
      // so if the panes are blue because the SKY IRRADIANCE is blue, no amount of
      // work on what the mirror reflects will move them.
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(1, 96, 64),
        new THREE.MeshStandardMaterial(diffuse
          ? { color: 0xffffff, metalness: 0, roughness: 1 }
          : { color: 0xffffff, metalness: 1, roughness: 0.02 }));
      const oc = new THREE.OrthographicCamera(-1.02, 1.02, 1.02, -1.02, 0.1, 20);
      oc.position.copy(cam.position);
      oc.quaternion.copy(cam.quaternion);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      ball.position.copy(cam.position).addScaledVector(fwd, 6);
      const hidden = [];
      sc.traverse((o) => { if (o !== sc && o.visible && o.parent === sc) { hidden.push(o); o.visible = false; } });
      sc.add(ball);
      const rt = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType });
      const oldTone = r.toneMapping;
      r.toneMapping = THREE.NoToneMapping;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.render(sc, oc);
      const buf = new Float32Array(N * N * 4);
      r.readRenderTargetPixels(rt, 0, 0, N, N, buf);
      r.setRenderTarget(null);
      r.toneMapping = oldTone;
      sc.remove(ball);
      ball.geometry.dispose(); ball.material.dispose();
      rt.dispose();
      for (const o of hidden) o.visible = true;
      // Bin by the elevation of the reflected ray.
      const bins = new Map();
      const m = new THREE.Matrix3().setFromMatrix4(cam.matrixWorld);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const nx = ((x + 0.5) / N * 2 - 1) * 1.02, ny = ((y + 0.5) / N * 2 - 1) * 1.02;
          const r2 = nx * nx + ny * ny;
          if (r2 > 0.92) continue;                       // skip the rim, where the lobe smears
          const nz = Math.sqrt(1 - r2);
          const V = new THREE.Vector3(0, 0, 1);
          const Nv = new THREE.Vector3(nx, ny, nz);
          const R = Nv.clone().multiplyScalar(2 * Nv.dot(V)).sub(V).applyMatrix3(m).normalize();
          // A lambertian ball has no reflected direction; bin it by the surface
          // normal's own elevation instead, which is the hemisphere it integrates.
          const Nw = Nv.clone().applyMatrix3(m).normalize();
          const el = Math.round((Math.asin(diffuse ? Nw.y : R.y) * 180 / Math.PI) / 5) * 5;
          const i = (y * N + x) * 4;
          const L = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
          const b = bins.get(el) ?? [0, 0, 0, 0, 0];
          b[0] += L; b[1]++; b[2] += buf[i]; b[3] += buf[i + 1]; b[4] += buf[i + 2];
          bins.set(el, b);
        }
      }
      return [...bins.entries()].sort((a, b) => a[0] - b[0])
        .filter(([, v]) => v[1] > 8)
        .map(([el, v]) => ({
          el, nits: +(v[0] / v[1]).toFixed(1), n: v[1],
          rgb: [v[2] / v[1], v[3] / v[1], v[4] / v[1]].map((q) => +q.toFixed(2)),
          br: +(v[4] / Math.max(1e-6, v[2])).toFixed(3),
        }));
    };

    // The instrument's own check: a raycast world position for a pixel, to be
    // compared against what the wy pass says about the same pixel.
    window.__glzRay = (px, py) => {
      const rc = new THREE.Raycaster();
      const cam = __district.camera;
      rc.setFromCamera(new THREE.Vector2((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1), cam);
      const hits = rc.intersectObject(__district.scene, true);
      for (const hit of hits) {
        if (!hit.object.visible || hit.object.name === 'sky') continue;
        return { y: hit.point.y, mat: hit.object.material?.name ?? '', dist: hit.distance };
      }
      return null;
    };
  });

  const srcAtLoad = srcStamp();
  console.log(`source at page load: ${Object.entries(srcAtLoad).map(([k, v]) => `${path.basename(k)} ${v}`).join('  ')}`);
  const index = [];
  const stations = VIEW_NAMES.some((v) => v.startsWith('pano:')) ? panoStations(W, H) : new Map();
  for (const vname of VIEW_NAMES) {
    const v = VIEWS[vname] ?? stations.get(vname);
    if (!v) throw new Error(`unknown view ${vname}`);
    if (v.bearingSplit > 5) {
      throw new Error(`${vname}: the hero-corridor bearing and the whole-route bearing differ by `
        + `${v.bearingSplit} deg, so "${v.side}" is a different wall here than in the reference view`);
    }
    // Streaming follows the vehicle, so the vehicle goes where the camera is and
    // the world is pumped until it stops loading. A fixed wait measures a
    // half-built district; this waits on the queue instead.
    await page.evaluate((cfg) => {
      __district.setAutopilot(() => {});
      __district.placeAt(cfg.cam[0], cfg.cam[2]);
      __district.freeCam(cfg.cam, cfg.target, cfg.fov);
    }, v);
    // Scenes take ~30 s to finish streaming and a fixed wait measures a
    // half-built district, so this pumps the streamer directly and stops when
    // the chunk count stops moving - not on a clock, and not on queued == 0,
    // which never reaches zero here: the far ring keeps re-queueing.
    let prev = -1, stable = 0;
    for (let i = 0; i < 30 && stable < 3; i++) {
      const w = await page.evaluate(() => {
        for (let k = 0; k < 400; k++) __district.world.update(__district.vehicle.position);
        return __district.worldReport();
      });
      stable = w.chunksLoaded === prev ? stable + 1 : 0;
      prev = w.chunksLoaded;
      await page.waitForTimeout(1200);
    }
    console.log(`${vname}: streamed to ${prev} chunks`);
    await page.waitForTimeout(8000);

    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      // Generous: other harnesses share this container, and the sky rebuilds its
      // PMREM on a time-of-day change.
      await page.waitForTimeout(14000);
      const base = path.join(OUT, `${TAG}-${vname.replace(/:/g, '_')}-${tod}`);
      await page.screenshot({ path: `${base}.png`, timeout: 240000 });
      fs.copyFileSync(`${base}.png`, path.join(SHOTS, `glaz-${TAG}-${vname.replace(/:/g, '_')}-${tod}.png`));
      for (const mode of ['kind', 'rm', 'wy']) {
        const s = await page.evaluate((m) => __glzScan(m), mode);
        fs.writeFileSync(`${base}.${mode}.bin`, Buffer.from(s.b64, 'base64'));
      }
      const check = await page.evaluate(() => {
        const pts = [];
        for (const [x, y] of [[640, 200], [640, 360], [640, 520], [400, 300], [880, 420]]) {
          pts.push({ x, y, ray: __glzRay(x, y) });
        }
        const sun = __district.tod.sun;
        // Assert the shader patch is actually ON the materials in this frame. An
        // A/B whose two arms are secretly identical returns a clean, confident,
        // meaningless null; this is what makes that impossible to miss.
        const tags = {};
        __district.scene.traverse((o) => {
          if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
          const m = o.material;
          if (!m.name || tags[m.name]) return;
          tags[m.name] = (m.userData.veranoTags ?? []).join('|') || '(none)';
        });
        const programs = (__district.renderer.info.programs ?? []).map((pr) => pr.cacheKey ?? '');
        return {
          pts,
          exposure: __district.postParams().exposure,
          world: __district.worldReport(),
          render: __district.renderStats(),
          env: { intensity: __district.scene.environmentIntensity, has: !!__district.scene.environment },
          sun: sun ? { pos: sun.position.toArray().map((v) => +v.toFixed(1)), lux: +sun.intensity.toFixed(0) } : null,
          tags,
          glazeEnvPrograms: programs.filter((k) => k.includes('glazeEnv')).length,
          totalPrograms: programs.length,
        };
      });
      // What the environment itself offers a mirror at this hour, measured off a
      // chrome ball rather than inferred from the frame.
      const envProfile = await page.evaluate(() => __glzEnv(false));
      const irrProfile = await page.evaluate(() => __glzEnv(true));
      const srcAtShot = srcStamp();
      const drift = SRC_WATCH.filter((f) => srcAtShot[f] !== srcAtLoad[f]);
      if (drift.length) {
        console.log(`  *** SOURCE DRIFT since page load: ${drift.join(', ')} - this frame's page is `
          + `running the OLDER module and cannot be compared with one captured after a reload ***`);
      }
      fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
        w: W, h: H, view: vname, tod, ...check, cam: v, envProfile, irrProfile,
        srcAtLoad, srcAtShot, srcDrift: drift,
      }, null, 1));
      const r = report(base);
      overlay(base, `${SHOTS}/glaz-${TAG}-${vname.replace(/:/g, '_')}-${tod}.mask.png`);
      console.log(fmt(r));
      // Instrument check: the wy pass against a real raycast, same pixels.
      const wy = new Uint8Array(fs.readFileSync(`${base}.wy.bin`));
      const cmp = check.pts.filter((p) => p.ray).map((p) => {
        const i = (p.y * W + p.x) * 4;
        return `${p.x},${p.y} wy ${(((wy[i] * 256 + wy[i + 1]) / 65535) * 200).toFixed(2)} ray ${p.ray.y.toFixed(2)} (${p.ray.mat})`;
      });
      console.log(`  patched materials: ` +
        Object.entries(check.tags).filter(([k]) => k.startsWith('facade:') || k.startsWith('glass') || k === 'trim')
          .map(([k, v]) => `${k}=${v}`).join('  ') +
        `   programs with glazeEnv ${check.glazeEnvPrograms}/${check.totalPrograms}`);
      console.log(`  wy-vs-raycast: ${cmp.join(' | ')}`);
      console.log(`  env by reflected elevation (nits, B/R): ` +
        envProfile.filter((e) => e.el % 20 === 0 && e.el >= -20 && e.el <= 60)
          .map((e) => `${e.el}deg ${e.nits}/${e.br}`).join('  '));
      console.log(`  irradiance by normal elevation (nits, B/R): ` +
        irrProfile.filter((e) => e.el % 20 === 0 && e.el >= -20 && e.el <= 60)
          .map((e) => `${e.el}deg ${e.nits}/${e.br}`).join('  '));
      index.push({ base, view: vname, tod });
    }
  }

  if (process.env.GLZ_CAL) {
    // Can this instrument produce the opposite reading? Kill the environment and
    // the glass must collapse. A probe that cannot show the effect it is looking
    // for is not evidence of its absence.
    const v = VIEWS[VIEW_NAMES[0]];
    await page.evaluate((cfg) => {
      __district.placeAt(cfg.cam[0], cfg.cam[2]);
      __district.freeCam(cfg.cam, cfg.target, cfg.fov);
    }, v);
    await page.evaluate((t) => __district.setTimeOfDay(t), TIMES[0]);
    await page.waitForTimeout(12000);
    await page.evaluate(() => { __district.scene.environmentIntensity = 0; });
    await page.waitForTimeout(4000);
    const base = path.join(OUT, `${TAG}-${VIEW_NAMES[0]}-${TIMES[0]}-noenv`);
    await page.screenshot({ path: `${base}.png`, timeout: 240000 });
    for (const mode of ['kind', 'rm', 'wy']) {
      const s = await page.evaluate((m) => __glzScan(m), mode);
      fs.writeFileSync(`${base}.${mode}.bin`, Buffer.from(s.b64, 'base64'));
    }
    const check = await page.evaluate(() => ({
      exposure: __district.postParams().exposure, world: __district.worldReport(),
      env: { intensity: __district.scene.environmentIntensity, has: !!__district.scene.environment },
    }));
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
      w: W, h: H, view: VIEW_NAMES[0], tod: TIMES[0], cam: v, ...check,
    }, null, 1));
    console.log('CONTROL environmentIntensity = 0');
    console.log(fmt(report(base)));
    await page.evaluate(() => { __district.scene.environmentIntensity = 1; });
  }

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  fs.writeFileSync(path.join(OUT, `${TAG}-index.json`), JSON.stringify(index, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--compile-check') {
    await compileCheck();
  } else if (args[0] === '--stations') {
    const st = panoStations(Number(process.env.GLZ_W ?? 1280), Number(process.env.GLZ_H ?? 960));
    const bad = [...st.values()].filter((v) => v.bearingSplit > 5).length;
    console.log(`${st.size} station views  (${bad} refused: hero and whole-route bearings disagree)`);
    for (const [k, v] of st) {
      if (v.bearingSplit > 5) continue;
      console.log(`  ${k.padEnd(28)} at (${v.cam[0]}, ${v.cam[2]})  yaw ${v.yaw}  fov ${v.fov.toFixed(2)}  ${v.station ?? ''}`);
    }
  } else if (args[0] === '--canyon') {
    const c = canyonScan(args[1] ?? 'data/district.json');
    console.log(`${c.edges} building edges, ${c.closed} face something within 160 m ` +
      `(${((100 * c.closed) / c.edges).toFixed(0)}%)`);
    console.log(`  all facades       median ${c.all.d.toFixed(1)} m away, opposite height ${c.all.h.toFixed(1)} m`);
    console.log(`  facades of h>=26  median ${c.towers.d.toFixed(1)} m away, opposite height ${c.towers.h.toFixed(1)} m  (${c.towers.n} edges)`);
  } else if (args[0] === '--report') {
    for (const a of args.slice(1)) console.log(fmt(report(a)));
  } else if (args[0] === '--pair') {
    const p = pair(args[1], args[2]);
    for (const k of ['glass', 'wall']) {
      console.log(`${k.padEnd(6)} ${String(p[`${k}.before`].n).padStart(7)} shared px   ` +
        `8-bit ${f(p[`${k}.before`].l8)} -> ${f(p[`${k}.after`].l8)}   ` +
        `sceneY ${f(p[`${k}.before`].sceneY, 5)} -> ${f(p[`${k}.after`].sceneY, 5)}`);
      for (const b of p[`${k}.bands`]) {
        if (b.n < 200) continue;
        console.log(`   ${String(b.lo).padStart(2)}-${String(b.hi).padStart(2)} m  ${String(b.n).padStart(6)} px  ` +
          `sceneY ${f(b.before, 5)} -> ${f(b.after, 5)}  x${f(b.after / Math.max(1e-9, b.before), 3)}`);
      }
    }
  } else {
    await capture();
  }
}
