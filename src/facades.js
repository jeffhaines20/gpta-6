// Facade recipes and the building kit-of-parts.
//
// Three things drive every decision in this file.
//
// 1. Phase 1's critic named "intentional irregularity" as the quality gap, so the
//    recipes below are hand-authored parameter sets — bay rhythms, colourways,
//    lit-window patterns and one-off accents are all written down, not sampled
//    from noise. Noise only ever perturbs an authored decision; it never makes one.
//
// 2. Albedo, emissive and roughness/metalness are drawn in ONE traversal of the
//    window grid. Phase 1 measured 2,219 ms per texture when the emissive mask was
//    recovered afterwards with a getImageData readback; drawing all three layers as
//    we go is effectively free and they cannot drift out of sync. Extra time-of-day
//    emissive variants replay a precomputed cell list, so the grid is walked once
//    no matter how many variants are asked for.
//
// 3. Nothing here creates a Mesh. Geometry helpers append into caller-owned arrays
//    with the same calling convention as geom.js extrudeFootprint, so the streamer
//    can merge a whole chunk into one geometry per material. Texture and material
//    factories are memoised by key, so a district of 523 buildings can never end up
//    with more materials than there are recipes.
//
// Wall UVs are in METRES (u along the wall, v up from the base), matching
// extrudeFootprint. A recipe therefore tiles by setting texture.repeat to
// 1/tileU x 1/tileV and every building of that recipe shares one texture.

import * as THREE from '../vendor/three.module.min.js';

// ---------------------------------------------------------------- determinism
// Buildings must look the same on every load and in every session, so every
// random choice comes from a seed derived from the footprint itself.

export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = typeof p === 'string' ? p : String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pick = (r, arr) => arr[Math.min(arr.length - 1, (r() * arr.length) | 0)];

// Weighted pick over [[value, weight], ...]. Used for window colour temperature,
// where the weights carry the authored intent (an office is mostly 4000 K).
function weighted(r, table) {
  let total = 0;
  for (const t of table) total += t[1];
  let x = r() * total;
  for (const t of table) { x -= t[1]; if (x <= 0) return t[0]; }
  return table[table.length - 1][0];
}

// ------------------------------------------------------------------- canvases
const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}
function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// One shared grain tile, generated once and scaled up by drawImage. Generating
// value noise at the full 1024 px panel size is a million-iteration JS loop per
// texture; at 192 px it is 28x cheaper and, composited in overlay at low alpha,
// indistinguishable at the frequencies a facade actually needs.
function grainTile(seed) {
  return memo(`grain:${seed}`, () => {
    const S = 192, c = canvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const grid = 24, r = rng(seed);
    const base = new Float32Array(grid * grid);
    for (let i = 0; i < base.length; i++) base[i] = r();
    const at = (x, y) => base[(((y % grid) + grid) % grid) * grid + (((x % grid) + grid) % grid)];
    const smooth = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0, amp = 0.5, freq = grid / S;
        for (let o = 0; o < 3; o++) {
          const fx = x * freq, fy = y * freq;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = smooth(fx - x0), ty = smooth(fy - y0);
          v += amp * lerp(
            lerp(at(x0, y0), at(x0 + 1, y0), tx),
            lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
          amp *= 0.5; freq *= 2;
        }
        const p = clamp01((v - 0.42) * 1.9 + 0.5) * 255;
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = p;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// A layer set: albedo, emissive and roughness/metalness drawn simultaneously in a
// single shared coordinate space. Emissive and RM are half-resolution because a
// glow and a material mask carry no high-frequency detail worth paying for, and
// the transform lets every draw call below stay in panel-space pixels.
function layers(P, emScale = 0.5, rmScale = 0.5) {
  const mk = (s) => {
    const c = canvas(Math.round(P * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    return { c, g };
  };
  return { P, al: mk(1), em: mk(emScale), rm: mk(rmScale) };
}

// Roughness/metalness are packed into one canvas: three.js samples roughnessMap.g
// and metalnessMap.b, so the same texture serves both and the red channel is left
// carrying ambient occlusion for anyone who wires up aoMap.
const rmColor = (rough, metal, ao = 1) =>
  `rgb(${Math.round(ao * 255)},${Math.round(clamp01(rough) * 255)},${Math.round(clamp01(metal) * 255)})`;

const hsl = (h, s, l) => `hsl(${h},${s}%,${l}%)`;

// ---------------------------------------------------------------- colour temps
// Interior lamps, warmest first. Real window grids read as a mix of colour
// temperatures; Phase 1's critic called flat uniform window colour a tell, and
// this table is the fix. Values are approximate sRGB for each Kelvin.
const CT = {
  k2200: '255,166,79',    // sodium / candle-warm restaurant
  k2700: '255,193,124',   // warm domestic LED
  k3000: '255,209,158',   // hotel corridor
  k4000: '255,238,222',   // neutral office
  k5000: '235,241,255',   // cool office / retail
  k6500: '206,226,255',   // fluorescent / workshop
  tv: '138,178,255',      // a television or monitor, flat and blue
};

// ---------------------------------------------------------------------- recipes
//
// Hand-authored parameter sets. Every field here is an art decision:
//   rhythm    relative bay widths across one tile — the source of intentional
//             irregularity. [1,1,1.35,1,1] is a wide centre bay, not noise.
//   floors    floors per tile; tileV = floors * floorM
//   winTop/H  window head and height as a fraction of the floor
//   reveal    depth of the recessed opening in panel pixels at 1024
//   litPattern how occupancy reads at night: 'scatter', 'floorBands' (offices
//             leave whole floors on for cleaners), 'stacks' (corridors and
//             stairwells light vertically), 'strip' (retail lights as a unit)
//   interior  lit-window luminance multiplier; a shop interior really is brighter
//             than a bedroom, and this is where that shows up
//   accents   named one-off details, applied at authored positions

export const RECIPES = {
  retailStrip: {
    label: 'Low-rise retail strip',
    tileU: 16.8, floors: 2, floorM: 3.9, panel: 1024,
    rhythm: [1, 1.45, 1, 1.2, 0.75],
    wall: { h: 36, s: 16, l: 72 },
    trimHue: 30,
    palette: [{ h: 36, s: 16, l: 72 }, { h: 172, s: 14, l: 66 }, { h: 12, s: 26, l: 64 }, { h: 48, s: 22, l: 76 }],
    win: { top: 0.10, h: 0.56, inset: 0.10, reveal: 7, mullionsV: 1, mullionsH: 1 },
    shape: 'glazed',
    spandrel: { l: -12, h: 0.30 },
    stringCourse: { at: 0.02, l: 12, thick: 9 },
    glass: ['96,120,140', '44,58,72', '20,26,34'],
    lit: { noon: 0.06, dusk: 0.62, night: 0.34 },
    litPattern: 'strip',
    ct: [[CT.k2700, 3], [CT.k3000, 3], [CT.k4000, 2], [CT.k5000, 2], [CT.k2200, 1]],
    interior: 1.5,
    blinds: 0.14,
    grime: 0.5,
    accents: ['awningStub', 'signBand', 'acUnit', 'patchedStucco'],
    rough: 0.88, metal: 0.0,
  },

  midOffice: {
    label: 'Mid-rise office',
    tileU: 18.0, floors: 5, floorM: 3.6, panel: 1024,
    rhythm: [1, 1, 1, 0.42, 1, 1],          // the narrow bay is the service riser
    wall: { h: 34, s: 6, l: 62 },
    trimHue: 34,
    palette: [{ h: 34, s: 6, l: 62 }, { h: 210, s: 5, l: 56 }, { h: 28, s: 9, l: 68 }],
    win: { top: 0.12, h: 0.50, inset: 0.045, reveal: 5, mullionsV: 2, mullionsH: 0 },
    shape: 'glazed',
    spandrel: { l: -9, h: 0.34 },
    stringCourse: { at: 0.0, l: 5, thick: 5 },
    glass: ['118,146,166', '52,72,88', '26,36,46'],
    lit: { noon: 0.10, dusk: 0.46, night: 0.30 },
    litPattern: 'floorBands',
    ct: [[CT.k4000, 5], [CT.k5000, 4], [CT.k6500, 2], [CT.tv, 1], [CT.k3000, 1]],
    interior: 1.1,
    blinds: 0.34,
    grime: 0.34,
    accents: ['riserBlank', 'precastJoints', 'washedPanel'],
    rough: 0.72, metal: 0.06,
  },

  deco: {
    label: 'Art-deco downtown block',
    tileU: 15.6, floors: 3, floorM: 3.8, panel: 1024,
    rhythm: [1.25, 0.9, 0.9, 1.25],
    wall: { h: 40, s: 22, l: 74 },
    trimHue: 22,
    palette: [{ h: 40, s: 22, l: 74 }, { h: 30, s: 16, l: 78 }, { h: 18, s: 24, l: 66 }],
    win: { top: 0.13, h: 0.52, inset: 0.20, reveal: 11, mullionsV: 1, mullionsH: 1 },
    shape: 'glazed',
    spandrel: { l: -6, h: 0.22 },
    stringCourse: { at: 0.0, l: 16, thick: 13 },
    glass: ['104,124,142', '46,58,70', '22,28,36'],
    lit: { noon: 0.06, dusk: 0.50, night: 0.34 },
    litPattern: 'stacks',
    ct: [[CT.k2700, 4], [CT.k3000, 3], [CT.k4000, 2], [CT.k2200, 2]],
    interior: 1.0,
    blinds: 0.26,
    grime: 0.42,
    accents: ['pilasters', 'chevronSpandrel', 'keystone'],
    rough: 0.82, metal: 0.0,
  },

  bayTower: {
    label: 'Bayfront residential tower',
    tileU: 19.2, floors: 6, floorM: 3.15, panel: 1024,
    rhythm: [1.35, 1, 1, 1.35],
    wall: { h: 38, s: 10, l: 84 },
    trimHue: 36,
    palette: [{ h: 38, s: 10, l: 84 }, { h: 196, s: 8, l: 80 }, { h: 30, s: 12, l: 88 }],
    win: { top: 0.09, h: 0.62, inset: 0.06, reveal: 6, mullionsV: 2, mullionsH: 0 },
    shape: 'glazed',
    spandrel: { l: -5, h: 0.24 },
    stringCourse: { at: 0.0, l: 8, thick: 7 },
    glass: ['128,158,182', '58,82,102', '28,40,54'],
    lit: { noon: 0.04, dusk: 0.40, night: 0.42 },
    litPattern: 'stacks',
    ct: [[CT.k2700, 5], [CT.k2200, 2], [CT.k3000, 3], [CT.tv, 2], [CT.k4000, 1]],
    interior: 0.8,
    blinds: 0.30,
    grime: 0.22,
    accents: ['balconyRail', 'sliderDoors', 'saltStain'],
    rough: 0.62, metal: 0.02,
  },

  parking: {
    label: 'Parking structure',
    tileU: 17.6, floors: 4, floorM: 3.0, panel: 1024,
    rhythm: [1, 1, 1, 1],
    wall: { h: 40, s: 3, l: 58 },
    trimHue: 34,
    palette: [{ h: 40, s: 3, l: 58 }, { h: 210, s: 3, l: 54 }],
    win: { top: 0.16, h: 0.52, inset: 0.03, reveal: 9, mullionsV: 0, mullionsH: 0 },
    shape: 'deck',
    spandrel: { l: -7, h: 0.32 },
    stringCourse: { at: 0.0, l: 7, thick: 11 },
    glass: ['0,0,0'],
    lit: { noon: 0.9, dusk: 1.0, night: 1.0 },   // deck ceiling lamps, always on
    litPattern: 'scatter',
    ct: [[CT.k5000, 4], [CT.k6500, 3], [CT.k2200, 1]],
    interior: 0.45,
    blinds: 0,
    grime: 0.7,
    accents: ['deckRamp', 'cableRail', 'stairCore'],
    rough: 0.93, metal: 0.0,
  },

  warehouse: {
    label: 'Industrial / warehouse',
    tileU: 16.0, floors: 2, floorM: 4.6, panel: 1024,
    rhythm: [1, 1, 1, 1, 1, 1, 1, 1],        // corrugated ribs, not bays
    wall: { h: 200, s: 7, l: 60 },
    trimHue: 205,
    palette: [{ h: 200, s: 7, l: 60 }, { h: 32, s: 6, l: 62 }, { h: 150, s: 6, l: 54 }],
    win: { top: 0.08, h: 0.26, inset: 0.10, reveal: 4, mullionsV: 1, mullionsH: 0 },
    shape: 'louvre',
    spandrel: { l: -4, h: 0.12 },
    stringCourse: { at: 0.0, l: 6, thick: 5 },
    glass: ['150,170,180', '76,92,102', '40,50,58'],
    lit: { noon: 0.2, dusk: 0.42, night: 0.22 },
    litPattern: 'floorBands',
    ct: [[CT.k6500, 5], [CT.k5000, 3], [CT.k2200, 1]],
    interior: 0.9,
    blinds: 0,
    grime: 0.85,
    accents: ['corrugation', 'rollUpDoor', 'rustStreaks'],
    rough: 0.55, metal: 0.35,
  },

  // The baked district is 131 detached houses. Mapping them onto the retail strip
  // recipe made whole residential blocks read as a shopping parade, so they get
  // their own set: stucco render, shutters, and a single storey of punched windows.
  stuccoHouse: {
    label: 'Stucco house / duplex',
    tileU: 12.6, floors: 1, floorM: 3.2, panel: 512,
    rhythm: [1, 0.7, 1.25, 0.8],
    wall: { h: 42, s: 20, l: 80 },
    trimHue: 32,
    palette: [{ h: 42, s: 20, l: 80 }, { h: 168, s: 16, l: 76 }, { h: 8, s: 22, l: 74 }, { h: 90, s: 12, l: 74 }],
    win: { top: 0.22, h: 0.44, inset: 0.24, reveal: 8, mullionsV: 1, mullionsH: 1 },
    shape: 'glazed',
    spandrel: { l: -3, h: 0.10 },
    stringCourse: { at: 0.0, l: 10, thick: 7 },
    glass: ['112,132,148', '48,60,72', '24,30,38'],
    lit: { noon: 0.03, dusk: 0.36, night: 0.26 },
    litPattern: 'scatter',
    ct: [[CT.k2700, 5], [CT.k2200, 3], [CT.tv, 2], [CT.k3000, 2]],
    interior: 0.7,
    blinds: 0.22,
    grime: 0.3,
    accents: ['shutters', 'acUnit'],
    rough: 0.9, metal: 0.0,
  },
};

export const RECIPE_NAMES = Object.keys(RECIPES);
export const TIMES = ['noon', 'dusk', 'night'];

// Emissive intensity per time of day, multiplied by a recipe's `interior`.
// These are not free parameters: they are set against daynight.js exposures
// (noon 1/78000, dusk 1/330, night 1/2.2). A lit window is a constant physical
// luminance, but at night the exposure is a 150x gain, so the stored intensity
// has to come down or every window clips to white and loses the colour
// temperature variation that is the whole point of the CT table.
export const EMISSIVE_INTENSITY = { noon: 0, dusk: 96, night: 3.1 };

// ------------------------------------------------------------- panel rendering

// Bay boundaries in panel pixels from a rhythm array.
function bayEdges(rhythm, P) {
  let total = 0;
  for (const w of rhythm) total += w;
  const out = [0];
  let acc = 0;
  for (const w of rhythm) { acc += w; out.push((acc / total) * P); }
  return out;
}

// One window opening: reveal, glass, soft occlusion under the lintel, sill and
// its grime streak, mullions. Drawn into albedo and RM together; lit state is
// recorded on the cell and rendered by drawLit so extra times of day cost a
// second short loop rather than a second grid walk.
function drawOpening(L, rec, cell, r) {
  const { al, rm } = L;
  const { x, y, w, h } = cell;
  const rev = rec.win.reveal * (L.P / 1024);
  const dark = rec.wall.l - 26;

  // The opening itself: masonry reveal, darker than the wall face.
  al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, Math.max(6, dark));
  al.g.fillRect(x, y, w, h);
  rm.g.fillStyle = rmColor(rec.rough * 0.95, rec.metal, 0.55);
  rm.g.fillRect(x, y, w, h);

  const gx = x + rev, gy = y + rev, gw = w - rev * 2, gh = h - rev * 1.4;

  if (rec.shape === 'deck') {
    // Open parking deck: a void, a concrete spandrel rail across the lower third,
    // and nothing reflective.
    al.g.fillStyle = 'rgb(16,17,20)';
    al.g.fillRect(gx, gy, gw, gh);
    const vg = al.g.createLinearGradient(0, gy, 0, gy + gh);
    vg.addColorStop(0, 'rgba(0,0,0,0.85)');
    vg.addColorStop(1, 'rgba(58,58,62,0.35)');
    al.g.fillStyle = vg;
    al.g.fillRect(gx, gy, gw, gh);
    rm.g.fillStyle = rmColor(0.98, 0, 0.15);
    rm.g.fillRect(gx, gy, gw, gh);
    al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l - 10);
    al.g.fillRect(gx, gy + gh * 0.66, gw, gh * 0.2);
    rm.g.fillStyle = rmColor(rec.rough, 0, 0.8);
    rm.g.fillRect(gx, gy + gh * 0.66, gw, gh * 0.2);
  } else if (rec.shape === 'louvre') {
    // Wired clerestory glazing: dirty, flat, barely reflective.
    al.g.fillStyle = `rgb(${rec.glass[1]})`;
    al.g.fillRect(gx, gy, gw, gh);
    rm.g.fillStyle = rmColor(0.42, 0.1, 0.7);
    rm.g.fillRect(gx, gy, gw, gh);
    al.g.strokeStyle = 'rgba(30,34,38,0.5)';
    al.g.lineWidth = 1.4;
    for (let i = 1; i < 5; i++) {
      al.g.beginPath();
      al.g.moveTo(gx, gy + (gh * i) / 5); al.g.lineTo(gx + gw, gy + (gh * i) / 5);
      al.g.stroke();
    }
  } else {
    // Glass: sky reflection falling off down the pane. The top stop is the sky,
    // the bottom is the dark interior, and the middle break is the horizon line
    // reflected in the glass — the thing that stops it reading as a flat swatch.
    const g0 = al.g.createLinearGradient(0, gy, 0, gy + gh);
    g0.addColorStop(0, `rgb(${rec.glass[0]})`);
    g0.addColorStop(0.34 + r() * 0.12, `rgb(${rec.glass[1]})`);
    g0.addColorStop(1, `rgb(${rec.glass[2]})`);
    al.g.fillStyle = g0;
    al.g.fillRect(gx, gy, gw, gh);
    rm.g.fillStyle = rmColor(0.10 + r() * 0.06, 0.55, 0.9);
    rm.g.fillRect(gx, gy, gw, gh);
  }

  // Blinds. Three states, not two: none, half-drawn, and fully drawn. A fully
  // drawn blind still passes light at night, so it is stored on the cell rather
  // than punched out of the emissive the way Phase 1 did it.
  if (cell.blind > 0) {
    const bh = cell.blind === 2 ? gh : gh * (0.28 + r() * 0.34);
    al.g.fillStyle = cell.blind === 2 ? 'rgba(216,208,192,0.88)' : 'rgba(198,192,178,0.8)';
    al.g.fillRect(gx, gy, gw, bh);
    al.g.strokeStyle = 'rgba(120,114,102,0.35)';
    al.g.lineWidth = 1;
    for (let sy = gy + 3; sy < gy + bh; sy += 4) {
      al.g.beginPath(); al.g.moveTo(gx, sy); al.g.lineTo(gx + gw, sy); al.g.stroke();
    }
    rm.g.fillStyle = rmColor(0.86, 0, 0.7);
    rm.g.fillRect(gx, gy, gw, bh);
  }

  // Mullions and transom.
  if (rec.win.mullionsV || rec.win.mullionsH) {
    al.g.fillStyle = hsl(rec.wall.h, Math.max(0, rec.wall.s - 8), Math.max(10, rec.wall.l - 34));
    const mw = Math.max(1.5, 2.6 * (L.P / 1024));
    for (let i = 1; i <= rec.win.mullionsV; i++) {
      al.g.fillRect(gx + (gw * i) / (rec.win.mullionsV + 1) - mw / 2, gy, mw, gh);
    }
    for (let i = 1; i <= rec.win.mullionsH; i++) {
      al.g.fillRect(gx, gy + (gh * i) / (rec.win.mullionsH + 1) - mw / 2, gw, mw);
    }
  }

  // Recessed-reveal shading. This is the detail Phase 1's critic singled out as
  // working, so it is kept and extended: occlusion under the lintel, a jamb
  // gradient on one side only (light comes from one direction), and a bright sill
  // with its own drop shadow. It is baked into albedo rather than left to aoMap
  // because aoMap needs a uv1 attribute the streamer does not currently emit.
  const head = al.g.createLinearGradient(0, y, 0, y + h * 0.42);
  head.addColorStop(0, 'rgba(0,0,0,0.62)');
  head.addColorStop(1, 'rgba(0,0,0,0)');
  al.g.fillStyle = head;
  al.g.fillRect(x, y, w, h * 0.42);

  const jamb = al.g.createLinearGradient(x, 0, x + w * 0.3, 0);
  jamb.addColorStop(0, 'rgba(0,0,0,0.40)');
  jamb.addColorStop(1, 'rgba(0,0,0,0)');
  al.g.fillStyle = jamb;
  al.g.fillRect(x, y, w * 0.3, h);

  // Sill: proud of the wall, so it catches light on top and casts below.
  const sillH = Math.max(2, 5 * (L.P / 1024));
  al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, Math.min(96, rec.wall.l + 12));
  al.g.fillRect(x - sillH, y + h, w + sillH * 2, sillH);
  al.g.fillStyle = 'rgba(0,0,0,0.34)';
  al.g.fillRect(x - sillH, y + h + sillH, w + sillH * 2, sillH * 0.8);
  rm.g.fillStyle = rmColor(rec.rough * 0.85, 0, 0.8);
  rm.g.fillRect(x - sillH, y + h, w + sillH * 2, sillH);

  // Grime washing down from the sill ends: the single cheapest cue that a
  // building has been standing in weather.
  if (cell.streak) {
    const sl = al.g.createLinearGradient(0, y + h, 0, y + h + h * 0.9);
    sl.addColorStop(0, `rgba(48,44,38,${0.24 * rec.grime})`);
    sl.addColorStop(1, 'rgba(48,44,38,0)');
    al.g.fillStyle = sl;
    al.g.fillRect(x - sillH, y + h, w * 0.22, h * 0.9);
    al.g.fillRect(x + w * 0.78, y + h, w * 0.22, h * 0.9);
  }
}

// Emissive for one cell at one time of day. Also draws the light spilling onto
// the reveal, which is what makes a lit window read as recessed at night.
function drawLit(L, rec, cell, tod) {
  if (!cell.lit[tod]) return;
  const eg = L.em.g;
  const rev = rec.win.reveal * (L.P / 1024);
  const { x, y, w, h } = cell;
  const gx = x + rev, gy = y + rev, gw = w - rev * 2, gh = h - rev * 1.4;
  const ct = cell.ct;

  if (rec.shape === 'deck') {
    // A parking deck shows the ceiling lamps, not a lit room: a bright band at
    // the head of the opening falling off fast.
    const g0 = eg.createLinearGradient(0, gy, 0, gy + gh * 0.7);
    g0.addColorStop(0, `rgba(${ct},0.95)`);
    g0.addColorStop(1, `rgba(${ct},0)`);
    eg.fillStyle = g0;
    eg.fillRect(gx, gy, gw, gh * 0.7);
    return;
  }

  // A fully drawn blind diffuses rather than blocks: dimmer, flatter, no hotspot.
  const a = cell.blind === 2 ? cell.glow * 0.42 : cell.glow;
  const g0 = eg.createLinearGradient(0, gy, 0, gy + gh);
  g0.addColorStop(0, `rgba(${ct},${a})`);
  g0.addColorStop(0.62, `rgba(${ct},${a * (cell.blind === 2 ? 0.92 : 0.74)})`);
  g0.addColorStop(1, `rgba(${ct},${a * (cell.blind === 2 ? 0.85 : 0.44)})`);
  eg.fillStyle = g0;
  eg.fillRect(gx, gy, gw, gh);

  if (cell.blind === 1) {
    // Half-drawn: the blind is lit from behind, the open part is the bright part.
    eg.fillStyle = `rgba(${ct},${a * 0.30})`;
    eg.fillRect(gx, gy, gw, gh * 0.4);
  }

  // Spill onto the reveal. Weak, but it is the difference between a glowing
  // rectangle and a window in a wall.
  eg.fillStyle = `rgba(${ct},${a * 0.22})`;
  eg.fillRect(x, y, w, rev);
  eg.fillRect(x, y + h - rev * 0.4, w, rev * 0.4);
  eg.fillRect(x, y, rev, h);
  eg.fillRect(x + w - rev, y, rev, h);
}

// Recipe-specific hand-placed detail. These are the "authored" half of the
// intentional-irregularity answer: each one is a decision about what this kind of
// building has on it, placed at a position the recipe chose.
function drawAccents(L, rec, cells, cols, rows, r, ex) {
  const { al, rm, P } = L;
  const fh = P / rows;
  const s = P / 1024;

  for (const a of rec.accents) {
    switch (a) {
      case 'pilasters': {
        // Deco: full-height ribs on the bay divisions, brighter than the wall,
        // with a shadow on one side. Drawn wrapped so the tile seam is invisible.
        for (let i = 0; i < ex.length; i++) {
          const x = ex[i], pw = 13 * s;
          for (const off of [0, -P, P]) {
            if (x + off < -pw || x + off > P + pw) continue;
            al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + 7);
            al.g.fillRect(x + off - pw / 2, 0, pw, P);
            al.g.fillStyle = 'rgba(0,0,0,0.22)';
            al.g.fillRect(x + off + pw / 2 - 3 * s, 0, 3 * s, P);
          }
        }
        break;
      }
      case 'chevronSpandrel': {
        // A repeated stepped motif in the spandrel band — the deco signature.
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * (rec.win.top + rec.win.h) + 10 * s;
          for (let i = 0; i < cols; i++) {
            const x0 = ex[i], x1 = ex[i + 1], cx = (x0 + x1) / 2;
            al.g.fillStyle = hsl(rec.trimHue, rec.wall.s + 14, rec.wall.l - 16);
            for (let k = 0; k < 3; k++) {
              al.g.fillRect(cx - (16 - k * 5) * s, y + k * 5 * s, (32 - k * 10) * s, 3.4 * s);
            }
          }
        }
        break;
      }
      case 'keystone': {
        for (let rr = 0; rr < rows; rr++) {
          for (let i = 0; i < cols; i++) {
            const cx = (ex[i] + ex[i + 1]) / 2, y = rr * fh + fh * rec.win.top;
            al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + 11);
            al.g.fillRect(cx - 7 * s, y - 11 * s, 14 * s, 11 * s);
            al.g.fillStyle = 'rgba(0,0,0,0.25)';
            al.g.fillRect(cx - 7 * s, y - 2 * s, 14 * s, 2 * s);
          }
        }
        break;
      }
      case 'riserBlank': {
        // The narrow bay in the office rhythm is a service riser: no glazing,
        // a different panel finish, and a louvre near the top of each floor.
        const i = rec.rhythm.indexOf(Math.min(...rec.rhythm));
        const x0 = ex[i], x1 = ex[i + 1];
        al.g.fillStyle = hsl(rec.wall.h, rec.wall.s + 2, rec.wall.l - 7);
        al.g.fillRect(x0, 0, x1 - x0, P);
        rm.g.fillStyle = rmColor(rec.rough + 0.08, rec.metal, 0.85);
        rm.g.fillRect(x0, 0, x1 - x0, P);
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * 0.2;
          al.g.fillStyle = 'rgba(40,42,46,0.85)';
          al.g.fillRect(x0 + 8 * s, y, x1 - x0 - 16 * s, fh * 0.22);
          al.g.strokeStyle = 'rgba(150,152,158,0.4)';
          al.g.lineWidth = 1;
          for (let k = 1; k < 6; k++) {
            const ly = y + (fh * 0.22 * k) / 6;
            al.g.beginPath(); al.g.moveTo(x0 + 8 * s, ly); al.g.lineTo(x1 - 8 * s, ly); al.g.stroke();
          }
        }
        break;
      }
      case 'precastJoints': {
        // Panel joints on the bay lines and the floor lines: an office facade is
        // assembled from panels and the seams are always visible in raking light.
        al.g.strokeStyle = 'rgba(0,0,0,0.20)';
        al.g.lineWidth = 2 * s;
        for (const x of ex) {
          al.g.beginPath(); al.g.moveTo(x, 0); al.g.lineTo(x, P); al.g.stroke();
        }
        break;
      }
      case 'washedPanel': {
        // One panel column was replaced or re-rendered and does not match.
        const i = (r() * cols) | 0;
        al.g.fillStyle = `rgba(255,252,244,${0.10 + r() * 0.07})`;
        al.g.fillRect(ex[i], 0, ex[i + 1] - ex[i], P);
        break;
      }
      case 'corrugation': {
        // Vertical ribs across the whole panel, with the shadow side always the
        // same side so the sheet reads as one direction of profile.
        for (let x = 0; x < P; x += 13 * s) {
          al.g.fillStyle = 'rgba(255,255,255,0.09)';
          al.g.fillRect(x, 0, 4 * s, P);
          al.g.fillStyle = 'rgba(0,0,0,0.16)';
          al.g.fillRect(x + 4 * s, 0, 3.2 * s, P);
        }
        break;
      }
      case 'rollUpDoor': {
        const i = 2 % cols;
        const x0 = ex[i], x1 = ex[Math.min(ex.length - 1, i + 2)];
        const y0 = P - fh * 0.94;
        al.g.fillStyle = 'rgb(78,84,88)';
        al.g.fillRect(x0, y0, x1 - x0, fh * 0.94);
        rm.g.fillStyle = rmColor(0.5, 0.6, 0.7);
        rm.g.fillRect(x0, y0, x1 - x0, fh * 0.94);
        al.g.strokeStyle = 'rgba(20,22,24,0.55)';
        al.g.lineWidth = 1.6 * s;
        for (let y = y0 + 8 * s; y < P; y += 11 * s) {
          al.g.beginPath(); al.g.moveTo(x0, y); al.g.lineTo(x1, y); al.g.stroke();
        }
        break;
      }
      case 'rustStreaks': {
        for (let i = 0; i < 14; i++) {
          const x = r() * P, y = r() * P * 0.7, w = (3 + r() * 7) * s, h = (40 + r() * 190) * s;
          const g0 = al.g.createLinearGradient(0, y, 0, y + h);
          g0.addColorStop(0, `rgba(112,62,30,${0.22 + r() * 0.3})`);
          g0.addColorStop(1, 'rgba(112,62,30,0)');
          al.g.fillStyle = g0;
          al.g.fillRect(x, y, w, h);
        }
        break;
      }
      case 'deckRamp': {
        // The ramp: a sloped soffit line crossing the deck openings.
        al.g.save();
        al.g.strokeStyle = 'rgba(28,28,30,0.65)';
        al.g.lineWidth = 9 * s;
        al.g.beginPath();
        al.g.moveTo(0, fh * 0.42); al.g.lineTo(P, fh * 1.34);
        al.g.stroke();
        al.g.restore();
        break;
      }
      case 'cableRail': {
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * (rec.win.top + rec.win.h * 0.5);
          al.g.strokeStyle = 'rgba(190,192,196,0.5)';
          al.g.lineWidth = 1.4 * s;
          for (let k = 0; k < 3; k++) {
            al.g.beginPath();
            al.g.moveTo(0, y + k * 6 * s); al.g.lineTo(P, y + k * 6 * s);
            al.g.stroke();
          }
        }
        break;
      }
      case 'stairCore': {
        const x0 = ex[0], x1 = ex[1];
        al.g.fillStyle = hsl(rec.wall.h, rec.wall.s + 4, rec.wall.l - 12);
        al.g.fillRect(x0, 0, x1 - x0, P);
        al.g.fillStyle = 'rgba(0,0,0,0.30)';
        for (let rr = 0; rr < rows; rr++) {
          al.g.fillRect(x0 + (x1 - x0) * 0.3, rr * fh + fh * 0.24, (x1 - x0) * 0.4, fh * 0.42);
        }
        break;
      }
      case 'signBand': {
        // A blank painted fascia over the shopfronts. Deliberately unlettered:
        // signage and branding are another builder's module.
        const y = P - fh * 1.06;
        al.g.fillStyle = hsl(rec.trimHue, rec.wall.s + 10, rec.wall.l - 26);
        al.g.fillRect(0, y, P, fh * 0.24);
        al.g.fillStyle = 'rgba(0,0,0,0.28)';
        al.g.fillRect(0, y + fh * 0.24, P, 5 * s);
        rm.g.fillStyle = rmColor(0.42, 0, 0.9);
        rm.g.fillRect(0, y, P, fh * 0.24);
        break;
      }
      case 'awningStub': {
        // The shadow an awning throws on the wall, for the bays that have one.
        for (let i = 0; i < cols; i++) {
          if (((i * 7 + 3) % 5) > 2) continue;
          const y = P - fh * 0.82;
          const g0 = al.g.createLinearGradient(0, y, 0, y + fh * 0.5);
          g0.addColorStop(0, 'rgba(0,0,0,0.45)');
          g0.addColorStop(1, 'rgba(0,0,0,0)');
          al.g.fillStyle = g0;
          al.g.fillRect(ex[i], y, ex[i + 1] - ex[i], fh * 0.5);
        }
        break;
      }
      case 'acUnit': {
        // A through-wall air conditioner in one window. One per tile, not many:
        // the point of a hand-placed accent is that it is rare.
        const c = cells[(r() * cells.length) | 0];
        if (!c) break;
        al.g.fillStyle = 'rgb(158,158,152)';
        al.g.fillRect(c.x + c.w * 0.18, c.y + c.h * 0.56, c.w * 0.64, c.h * 0.36);
        al.g.fillStyle = 'rgba(0,0,0,0.35)';
        al.g.fillRect(c.x + c.w * 0.18, c.y + c.h * 0.92, c.w * 0.64, 4 * s);
        rm.g.fillStyle = rmColor(0.55, 0.4, 0.7);
        rm.g.fillRect(c.x + c.w * 0.18, c.y + c.h * 0.56, c.w * 0.64, c.h * 0.36);
        c.blind = 2;
        break;
      }
      case 'patchedStucco': {
        for (let i = 0; i < 3; i++) {
          const x = r() * P, y = r() * P, w = (60 + r() * 150) * s, h = (40 + r() * 110) * s;
          al.g.fillStyle = `rgba(${200 + r() * 40 | 0},${190 + r() * 40 | 0},${170 + r() * 40 | 0},0.13)`;
          al.g.fillRect(x, y, w, h);
        }
        break;
      }
      case 'shutters': {
        for (const c of cells) {
          const sw = c.w * 0.17;
          al.g.fillStyle = hsl(rec.trimHue + 140, 18, 44);
          al.g.fillRect(c.x - sw, c.y, sw, c.h);
          al.g.fillRect(c.x + c.w, c.y, sw, c.h);
          al.g.fillStyle = 'rgba(0,0,0,0.25)';
          for (let sy = c.y + 3 * s; sy < c.y + c.h; sy += 6 * s) {
            al.g.fillRect(c.x - sw, sy, sw, 2 * s);
            al.g.fillRect(c.x + c.w, sy, sw, 2 * s);
          }
        }
        break;
      }
      case 'balconyRail': {
        // Glass balustrade shadow band under each floor line — the tower reads as
        // having balconies even at LOD distances where the geometry is gone.
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * (rec.win.top + rec.win.h) + 3 * s;
          al.g.fillStyle = 'rgba(126,150,164,0.30)';
          al.g.fillRect(0, y, P, fh * 0.20);
          al.g.fillStyle = 'rgba(0,0,0,0.30)';
          al.g.fillRect(0, y + fh * 0.20, P, 4 * s);
          rm.g.fillStyle = rmColor(0.22, 0.3, 0.8);
          rm.g.fillRect(0, y, P, fh * 0.20);
        }
        break;
      }
      case 'sliderDoors': {
        for (const c of cells) {
          al.g.fillStyle = 'rgba(212,216,220,0.55)';
          al.g.fillRect(c.x + c.w * 0.5 - 2 * s, c.y, 4 * s, c.h);
        }
        break;
      }
      case 'saltStain': {
        const g0 = al.g.createLinearGradient(0, P * 0.55, 0, P);
        g0.addColorStop(0, 'rgba(228,232,226,0)');
        g0.addColorStop(1, 'rgba(228,232,226,0.16)');
        al.g.fillStyle = g0;
        al.g.fillRect(0, P * 0.55, P, P * 0.45);
        break;
      }
    }
  }
}

// The whole panel. One traversal of the grid produces albedo, RM and the primary
// emissive; extra times of day replay `cells`.
function buildPanel(name, opts = {}) {
  const rec = RECIPES[name];
  const P = rec.panel;
  const seed = opts.seed ?? hash32('facade', name);
  const r = rng(seed);
  const L = layers(P);
  const rows = rec.floors;
  const ex = bayEdges(rec.rhythm, P);
  const cols = rec.rhythm.length;
  const fh = P / rows;

  // Base wall + grain + a broad uneven wash, so no two areas of the wall are the
  // same value before a single window is drawn.
  L.al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l);
  L.al.g.fillRect(0, 0, P, P);
  L.al.g.globalCompositeOperation = 'overlay';
  L.al.g.globalAlpha = 0.42;
  L.al.g.drawImage(grainTile(seed ^ 0x9e37), 0, 0, P, P);
  L.al.g.globalAlpha = 0.20;
  L.al.g.drawImage(grainTile(seed ^ 0x1b3f), 0, 0, P * 2.7, P * 2.7);
  L.al.g.globalAlpha = 1;
  L.al.g.globalCompositeOperation = 'source-over';

  L.em.g.fillStyle = '#000';
  L.em.g.fillRect(0, 0, P, P);
  L.rm.g.fillStyle = rmColor(rec.rough, rec.metal, 1);
  L.rm.g.fillRect(0, 0, P, P);

  // Spandrels and string courses, drawn per floor before the openings so the
  // reveal shading lands on top of them.
  for (let rr = 0; rr < rows; rr++) {
    const y0 = rr * fh + fh * (rec.win.top + rec.win.h);
    L.al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + rec.spandrel.l);
    L.al.g.fillRect(0, y0, P, fh * rec.spandrel.h);
    const sc = rec.stringCourse;
    const scy = (rr + 1) * fh - sc.thick * (P / 1024);
    L.al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + sc.l);
    L.al.g.fillRect(0, scy, P, sc.thick * (P / 1024));
    L.al.g.fillStyle = 'rgba(0,0,0,0.26)';
    L.al.g.fillRect(0, scy + sc.thick * (P / 1024), P, 3 * (P / 1024));
  }

  // Lit-state assignment. `rank` is a stable per-window number; a time of day
  // lights every window whose rank is under that hour's fraction, so windows lit
  // at dusk are still lit at night instead of being an unrelated random set.
  const bandRank = [];
  for (let rr = 0; rr < rows; rr++) bandRank.push(r());
  const stackRank = [];
  for (let cc = 0; cc < cols; cc++) stackRank.push(r());

  const cells = [];
  for (let rr = 0; rr < rows; rr++) {
    for (let cc = 0; cc < cols; cc++) {
      const bx0 = ex[cc], bx1 = ex[cc + 1], bw = bx1 - bx0;
      const inset = bw * rec.win.inset;
      const cell = {
        x: bx0 + inset, y: rr * fh + fh * rec.win.top,
        w: bw - inset * 2, h: fh * rec.win.h,
        blind: r() < rec.blinds ? (r() < 0.45 ? 2 : 1) : 0,
        streak: r() < 0.55,
        ct: weighted(r, rec.ct),
        glow: 0.55 + r() * 0.45,
        rank: 0, lit: {},
      };
      // Authored occupancy patterns. Real night facades are not a uniform
      // scatter: offices leave whole floors on, apartments light in vertical
      // stacks along a corridor, and a retail strip lights as one unit.
      const own = r();
      if (rec.litPattern === 'floorBands') cell.rank = bandRank[rr] * 0.72 + own * 0.28;
      else if (rec.litPattern === 'stacks') cell.rank = stackRank[cc] * 0.34 + own * 0.66;
      else if (rec.litPattern === 'strip') cell.rank = own * 0.35 + bandRank[rr] * 0.15;
      else cell.rank = own;
      for (const t of TIMES) cell.lit[t] = cell.rank < rec.lit[t];
      cells.push(cell);
      drawOpening(L, rec, cell, r);
    }
  }

  drawAccents(L, rec, cells, cols, rows, r, ex);

  // Primary emissive in the same generation, then any extra hours from the same
  // cell list. This is what keeps the mask from drifting out of sync with albedo.
  const tods = opts.times ?? TIMES;
  const em = {};
  for (const t of tods) {
    if (t !== tods[0]) {
      L.em.g.setTransform(1, 0, 0, 1, 0, 0);
      L.em.g.fillStyle = '#000';
      L.em.g.fillRect(0, 0, L.em.c.width, L.em.c.height);
      const s = L.em.c.width / P;
      L.em.g.setTransform(s, 0, 0, s, 0, 0);
    }
    for (const c of cells) drawLit(L, rec, c, t);
    // Copy out, because the next hour overwrites this canvas.
    const out = canvas(L.em.c.width, L.em.c.height);
    out.getContext('2d').drawImage(L.em.c, 0, 0);
    em[t] = out;
  }

  return { albedo: L.al.c, emissive: em, rm: L.rm.c, recipe: rec, windows: cells.length };
}

// ------------------------------------------------------------------ trim atlas
// One 512px atlas of 4x4 material cells shared by EVERY kit part of EVERY recipe.
// A near chunk therefore costs one extra draw call for all its cornices, awnings,
// balconies, fire escapes, roof units and storefronts combined.

export const TRIM = {
  stone: [0, 0], metalDark: [1, 0], gravel: [2, 0], fabricA: [3, 0],
  glass: [0, 1], bulkhead: [1, 1], steel: [2, 1], signFace: [3, 1],
  stucco: [0, 2], concrete: [1, 2], brick: [2, 2], mullion: [3, 2],
  fabricB: [0, 3], rust: [1, 3], louvre: [2, 3], asphalt: [3, 3],
};

const TRIM_GRID = 4;
const TRIM_PAD = 0.004;   // keeps mip sampling inside the cell

// UV rect for a trim cell. Canvas rows run top-down, texture v runs bottom-up.
export function trimCell(cell) {
  const [ix, iy] = cell;
  const s = 1 / TRIM_GRID;
  return {
    u0: ix * s + TRIM_PAD, u1: (ix + 1) * s - TRIM_PAD,
    v0: 1 - (iy + 1) * s + TRIM_PAD, v1: 1 - iy * s - TRIM_PAD,
  };
}

// A mip chain built by downscaling every cell INDEPENDENTLY and re-packing it,
// instead of letting the GPU average the whole atlas. Auto-generated mips mix
// neighbouring cells together: at a grazing angle the sidewalk five metres in
// front of the camera is already sampling mip 5, where a 128 px cell is 4 texels
// and the brick swatch two cells away is bleeding into the concrete. Packing each
// level from per-cell downscales removes that entirely and costs ~1 ms.
function packedMips(cells, grid, cellSize) {
  const mips = [];
  let cs = cellSize;
  while (cs >= 1) {
    const c = canvas(grid * cs), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    for (let i = 0; i < cells.length; i++) {
      g.drawImage(cells[i], (i % grid) * cs, ((i / grid) | 0) * cs, cs, cs);
    }
    mips.push(c);
    cs = Math.floor(cs / 2);
  }
  // Below one texel per cell the atlas is 4 px across and nothing can bleed that
  // is not already a single average colour, so finish the chain conventionally.
  let last = mips[mips.length - 1];
  while (last.width > 1) {
    const c = canvas(Math.max(1, last.width >> 1));
    c.getContext('2d').drawImage(last, 0, 0, c.width, c.height);
    mips.push(c);
    last = c;
  }
  return mips;
}

function buildTrimAtlas() {
  const S = 512, C = S / TRIM_GRID;
  const al = canvas(S), ag = al.getContext('2d');
  const rm = canvas(S), rg = rm.getContext('2d');
  const r = rng(hash32('trim'));

  const at = (cell) => ({ x: cell[0] * C, y: cell[1] * C });
  const fill = (cell, colour, rough, metal) => {
    const { x, y } = at(cell);
    ag.fillStyle = colour; ag.fillRect(x, y, C, C);
    rg.fillStyle = rmColor(rough, metal, 1); rg.fillRect(x, y, C, C);
    return { x, y };
  };
  const speck = (x, y, n, lo, hi, a) => {
    for (let i = 0; i < n; i++) {
      const v = lo + r() * (hi - lo);
      ag.fillStyle = `rgba(${v | 0},${(v * 0.98) | 0},${(v * 0.94) | 0},${a})`;
      ag.fillRect(x + r() * C, y + r() * C, 1 + r() * 2, 1 + r() * 2);
    }
  };

  // Cornice / cast stone: horizontal mouldings with their own shadow lines, so a
  // parapet band picks up a profile without any extra geometry.
  {
    const { x, y } = fill(TRIM.stone, 'rgb(206,198,180)', 0.78, 0);
    speck(x, y, 900, 170, 225, 0.35);
    for (const [t, h, sh] of [[0.14, 0.10, 0.28], [0.42, 0.16, 0.34], [0.76, 0.09, 0.30]]) {
      ag.fillStyle = 'rgba(255,252,240,0.5)';
      ag.fillRect(x, y + C * t, C, C * h);
      ag.fillStyle = `rgba(0,0,0,${sh})`;
      ag.fillRect(x, y + C * (t + h), C, C * 0.05);
    }
  }
  // Dark painted metal: railings, fire escapes, awning frames.
  {
    const { x, y } = fill(TRIM.metalDark, 'rgb(44,47,52)', 0.44, 0.85);
    speck(x, y, 500, 30, 80, 0.4);
    for (let i = 0; i < 26; i++) {
      ag.fillStyle = `rgba(120,70,40,${0.06 + r() * 0.12})`;
      ag.fillRect(x + r() * C, y + r() * C, 3 + r() * 14, 6 + r() * 30);
    }
  }
  // Roof gravel / ballast.
  {
    const { x, y } = fill(TRIM.gravel, 'rgb(96,94,88)', 0.97, 0);
    speck(x, y, 5200, 60, 165, 0.55);
  }
  // Awning fabric, colourway A: authored two-tone stripe, not a random pattern.
  for (const [cell, a, b] of [[TRIM.fabricA, 'rgb(178,58,52)', 'rgb(236,228,214)'],
                              [TRIM.fabricB, 'rgb(30,86,104)', 'rgb(232,226,208)']]) {
    const { x, y } = fill(cell, b, 0.86, 0);
    for (let i = 0; i < TRIM_GRID * 2; i++) {
      ag.fillStyle = a;
      ag.fillRect(x + (i * C) / 8, y, C / 16, C);
    }
    ag.fillStyle = 'rgba(0,0,0,0.18)';
    ag.fillRect(x, y + C * 0.86, C, C * 0.14);
  }
  // Storefront glazing: dark, flat, very smooth.
  {
    const { x, y } = fill(TRIM.glass, 'rgb(26,32,40)', 0.08, 0.6);
    const g0 = ag.createLinearGradient(x, y, x, y + C);
    g0.addColorStop(0, 'rgba(126,152,172,0.55)');
    g0.addColorStop(0.5, 'rgba(30,40,50,0.2)');
    g0.addColorStop(1, 'rgba(12,16,22,0.5)');
    ag.fillStyle = g0; ag.fillRect(x, y, C, C);
  }
  // Shopfront bulkhead: dark glazed tile with a grout grid.
  {
    const { x, y } = fill(TRIM.bulkhead, 'rgb(58,52,48)', 0.5, 0.1);
    ag.strokeStyle = 'rgba(150,146,138,0.30)'; ag.lineWidth = 1.5;
    for (let i = 1; i < 6; i++) {
      ag.beginPath(); ag.moveTo(x, y + (C * i) / 6); ag.lineTo(x + C, y + (C * i) / 6); ag.stroke();
      ag.beginPath(); ag.moveTo(x + (C * i) / 6, y); ag.lineTo(x + (C * i) / 6, y + C); ag.stroke();
    }
  }
  // Galvanised steel: roof plant, ducting, vents.
  {
    const { x, y } = fill(TRIM.steel, 'rgb(150,154,158)', 0.38, 0.92);
    for (let i = 0; i < 70; i++) {
      ag.fillStyle = `rgba(${190 + r() * 50 | 0},${190 + r() * 50 | 0},${196 + r() * 50 | 0},${0.1 + r() * 0.25})`;
      ag.fillRect(x + r() * C, y, 1 + r() * 5, C);
    }
    ag.fillStyle = 'rgba(70,76,80,0.25)';
    for (let i = 0; i < 6; i++) ag.fillRect(x, y + (C * i) / 6, C, 2);
  }
  // Signage blank: a painted board face. Left deliberately blank — original
  // business names and logos are the signage builder's module, not this one.
  {
    const { x, y } = fill(TRIM.signFace, 'rgb(228,222,208)', 0.55, 0);
    ag.fillStyle = 'rgba(0,0,0,0.16)';
    ag.fillRect(x, y, C, 5); ag.fillRect(x, y + C - 5, C, 5);
    ag.fillRect(x, y, 5, C); ag.fillRect(x + C - 5, y, 5, C);
    speck(x, y, 300, 190, 240, 0.3);
  }
  // Stucco render matching the general wall tone.
  {
    const { x, y } = fill(TRIM.stucco, 'rgb(206,196,178)', 0.9, 0);
    speck(x, y, 2600, 165, 225, 0.4);
  }
  // Fair-faced concrete: balcony slabs, parking decks.
  {
    const { x, y } = fill(TRIM.concrete, 'rgb(148,146,142)', 0.93, 0);
    speck(x, y, 2200, 120, 180, 0.35);
    ag.fillStyle = 'rgba(80,80,78,0.2)';
    for (let i = 0; i < 5; i++) ag.fillRect(x, y + r() * C, C, 2 + r() * 3);
  }
  // Brick.
  {
    const { x, y } = fill(TRIM.brick, 'rgb(132,74,58)', 0.92, 0);
    const bh = C / 10;
    for (let row = 0; row < 10; row++) {
      const off = (row % 2) * (C / 8);
      for (let b = -1; b < 8; b++) {
        const v = 0.8 + r() * 0.45;
        ag.fillStyle = `rgb(${(132 * v) | 0},${(74 * v) | 0},${(58 * v) | 0})`;
        ag.fillRect(x + off + (b * C) / 4 + 1.5, y + row * bh + 1.5, C / 4 - 3, bh - 3);
      }
    }
  }
  // Anodised aluminium mullion stock.
  {
    const { x, y } = fill(TRIM.mullion, 'rgb(96,100,104)', 0.3, 0.9);
    ag.fillStyle = 'rgba(190,196,200,0.4)';
    for (let i = 0; i < 4; i++) ag.fillRect(x + (C * i) / 4, y, C / 16, C);
  }
  // Rusted metal.
  {
    const { x, y } = fill(TRIM.rust, 'rgb(122,68,38)', 0.85, 0.35);
    for (let i = 0; i < 180; i++) {
      ag.fillStyle = `rgba(${80 + r() * 90 | 0},${40 + r() * 50 | 0},${20 + r() * 30 | 0},${0.2 + r() * 0.5})`;
      ag.fillRect(x + r() * C, y + r() * C, 2 + r() * 12, 2 + r() * 12);
    }
  }
  // Louvre / vent grille.
  {
    const { x, y } = fill(TRIM.louvre, 'rgb(70,74,78)', 0.5, 0.8);
    for (let i = 0; i < 14; i++) {
      ag.fillStyle = 'rgba(180,186,190,0.35)';
      ag.fillRect(x, y + (C * i) / 14, C, 2);
      ag.fillStyle = 'rgba(0,0,0,0.45)';
      ag.fillRect(x, y + (C * i) / 14 + 2, C, (C / 14) - 4);
    }
  }
  // Asphalt / bitumen roof membrane.
  {
    const { x, y } = fill(TRIM.asphalt, 'rgb(52,52,54)', 0.88, 0.05);
    speck(x, y, 2600, 30, 90, 0.5);
    ag.fillStyle = 'rgba(90,90,92,0.25)';
    for (let i = 0; i < 4; i++) ag.fillRect(x, y + (C * (i + 0.5)) / 4, C, 4);
  }

  // Split the finished atlas back into cells so the mip chain can be packed
  // per-cell rather than across cell boundaries.
  const cut = (src) => {
    const out = [];
    for (let iy = 0; iy < TRIM_GRID; iy++) {
      for (let ix = 0; ix < TRIM_GRID; ix++) {
        const c = canvas(C);
        c.getContext('2d').drawImage(src, ix * C, iy * C, C, C, 0, 0, C, C);
        out.push(c);
      }
    }
    return out;
  };
  return {
    albedo: al, rm,
    albedoMips: packedMips(cut(al), TRIM_GRID, C),
    rmMips: packedMips(cut(rm), TRIM_GRID, C),
  };
}

// ------------------------------------------------------------------- textures
function toTexture(c, { srgb = false, repeatU = 1, repeatV = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatU, repeatV);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Textures for one facade recipe, memoised so a district of 523 buildings holds
 * exactly one set per recipe. UVs are in metres, so `repeat` is 1/tile and every
 * building of the recipe shares the same texture with no per-building state.
 *
 * @param {string} name  key into RECIPES
 * @returns {{map, rmMap, emissive: Object<string,Texture>, tileU:number, tileV:number, recipe:Object}}
 */
export function facadeMaps(name) {
  return memo(`facade:${name}`, () => {
    const p = buildPanel(name);
    const rec = p.recipe;
    const tileU = rec.tileU, tileV = rec.floors * rec.floorM;
    const ru = 1 / tileU, rv = 1 / tileV;
    const emissive = {};
    for (const t of TIMES) {
      emissive[t] = toTexture(p.emissive[t], { srgb: true, repeatU: ru, repeatV: rv });
    }
    return {
      map: toTexture(p.albedo, { srgb: true, repeatU: ru, repeatV: rv }),
      rmMap: toTexture(p.rm, { repeatU: ru, repeatV: rv }),
      emissive, tileU, tileV, recipe: rec, windows: p.windows,
    };
  });
}

/** The single shared trim atlas used by every kit part. */
export function trimMaps() {
  return memo('trim', () => {
    const a = buildTrimAtlas();
    const mk = (c, mips, srgb) => {
      const t = toTexture(c, { srgb });
      t.mipmaps = mips;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      return t;
    };
    return {
      map: mk(a.albedo, a.albedoMips, true),
      rmMap: mk(a.rm, a.rmMips, false),
    };
  });
}

/**
 * Optional material factory. Memoised by recipe, so a caller physically cannot
 * end up with a material per building — the failure mode this project's
 * performance contract exists to prevent.
 */
export function facadeMaterial(name, { time = 'night' } = {}) {
  const mat = memo(`mat:${name}`, () => {
    const m = facadeMaps(name);
    return new THREE.MeshStandardMaterial({
      map: m.map,
      roughnessMap: m.rmMap, metalnessMap: m.rmMap,
      roughness: 1, metalness: 1,
      emissiveMap: m.emissive.night,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      vertexColors: true,
    });
  });
  setFacadeTime(name, time);
  return mat;
}

/** Trim material, shared across all recipes: one draw call for the whole kit. */
export function trimMaterial() {
  return memo('mat:trim', () => {
    const t = trimMaps();
    return new THREE.MeshStandardMaterial({
      map: t.map, roughnessMap: t.rmMap, metalnessMap: t.rmMap,
      roughness: 1, metalness: 1, vertexColors: true,
    });
  });
}

/**
 * Swap a recipe's lit-window set and glow for a time of day. Cheap: the maps are
 * already generated, this only rebinds and rescales.
 */
export function setFacadeTime(name, time) {
  const m = cache.get(`mat:${name}`);
  if (!m) return;
  const maps = facadeMaps(name);
  m.emissiveMap = maps.emissive[time] ?? maps.emissive.night;
  m.emissiveIntensity = (EMISSIVE_INTENSITY[time] ?? 0) * maps.recipe.interior;
  m.needsUpdate = true;
}

/** Apply a time of day to every recipe material that has been created. */
export function setAllFacadeTimes(time) {
  for (const n of RECIPE_NAMES) setFacadeTime(n, time);
}

/**
 * Generate the whole library up front behind the loading screen and report the
 * cost, because with 100% procedural assets texture generation is a startup
 * budget that has to be profiled like any other.
 */
export function generateFacadeLibrary({ recipes = RECIPE_NAMES } = {}) {
  const t0 = performance.now();
  const per = {};
  for (const n of recipes) {
    const t = performance.now();
    facadeMaps(n);
    per[n] = +(performance.now() - t).toFixed(1);
  }
  const tt = performance.now();
  trimMaps();
  per.trim = +(performance.now() - tt).toFixed(1);
  return { ms: +(performance.now() - t0).toFixed(1), per };
}

// -------------------------------------------------------------- recipe picking

// A footprint's identity: stable across reloads, array reordering and rebakes,
// because it is derived from the geometry rather than from the index.
export function seedOf(b) {
  const p = b.p[0];
  return hash32(p[0].toFixed(2), p[1].toFixed(2), b.p.length, (b.h ?? 0).toFixed(1));
}

/**
 * Pick a facade recipe for a baked building. Deterministic: same footprint,
 * same recipe, every session.
 *
 * @param {{p:Array, h:number, a:number, z?:string, k?:string}} b  district.json building
 * @returns {string} key into RECIPES
 */
export function pickRecipe(b) {
  const z = b.z ?? '', k = b.k ?? '', h = b.h ?? 6, a = b.a ?? 100;
  const r = rng(seedOf(b));

  if (z === 'parking' || k === 'parking' || k === 'garages') return 'parking';
  if (z === 'industrial' || k === 'industrial' || k === 'warehouse' ||
      k === 'construction' || (k === 'roof' && a > 400)) return 'warehouse';
  if (h >= 26) return 'bayTower';
  if (k === 'house' || k === 'hut' || k === 'cabin' ||
      (z === 'residential' && !k && a < 320 && h <= 7)) return 'stuccoHouse';
  if (k === 'apartments' || k === 'hotel' || k === 'residential') {
    return h >= 15 ? 'bayTower' : 'deco';
  }
  if (k === 'office' || (z === 'commercial' && h >= 12)) return 'midOffice';
  if (h <= 8) return 'retailStrip';

  // The genuinely ambiguous middle of the stock — 3 to 5 storeys of downtown
  // commercial. Split it deterministically so a street is a mix rather than a
  // run of identical blocks, weighted toward deco in the historic core.
  const t = r();
  if (t < 0.42) return 'deco';
  if (t < 0.78) return 'midOffice';
  return 'retailStrip';
}

// Per-building colour, applied as vertex colours so a whole chunk keeps one
// material. Linear-space RGB, since three.js treats vertex colours as linear.
function tintOf(rec, r) {
  const base = pick(r, rec.palette);
  const c = new THREE.Color();
  c.setHSL(base.h / 360, base.s / 100, base.l / 100, THREE.SRGBColorSpace);
  const wall = new THREE.Color();
  wall.setHSL(rec.wall.h / 360, rec.wall.s / 100, rec.wall.l / 100, THREE.SRGBColorSpace);
  // Divide out the baked wall colour so the tint is a true recolour, then nudge
  // the value so no two neighbours are identical even within one colourway.
  const v = 0.9 + r() * 0.22;
  return [
    clamp01((c.r / Math.max(0.02, wall.r)) * v),
    clamp01((c.g / Math.max(0.02, wall.g)) * v),
    clamp01((c.b / Math.max(0.02, wall.b)) * v),
  ];
}

/**
 * The full deterministic style for one building: recipe, storey count, colour
 * and which kit parts it carries.
 *
 * @param {Object} b  district.json building
 * @returns {Object} style, consumed by appendBuilding and by the kit helpers
 */
export function buildingStyle(b) {
  const name = pickRecipe(b);
  const rec = RECIPES[name];
  const seed = seedOf(b);
  const r = rng(seed ^ 0x5f3a);
  const h = b.h ?? 6;
  const floors = Math.max(1, Math.round(h / rec.floorM));
  const area = b.a ?? 200;

  const commercialGround = name === 'retailStrip' || name === 'deco' ||
    (name === 'midOffice' && r() < 0.7);

  return {
    recipe: name, rec, seed, height: h, floors,
    tint: tintOf(rec, r),
    // A parapet is nearly universal on a flat-roofed building and is the single
    // cheapest silhouette upgrade: without it every roof is a bare cut edge.
    parapet: { height: name === 'deco' ? 1.5 : name === 'bayTower' ? 0.95 : 1.15,
               project: name === 'deco' ? 0.34 : 0.2,
               stepped: name === 'deco' },
    storefront: commercialGround && h > 4.2
      ? { head: Math.min(4.0, h - 0.8), depth: 0.55 + r() * 0.35, bulkhead: 0.42 }
      : null,
    awnings: commercialGround && name !== 'midOffice' && r() < 0.72,
    fabric: r() < 0.5 ? TRIM.fabricA : TRIM.fabricB,
    fireEscape: (name === 'deco' || name === 'midOffice') && h >= 9 && r() < 0.45,
    balconies: name === 'bayTower' && r() < 0.85,
    signBlank: commercialGround && area > 260 && r() < 0.55,
    roofUnits: name === 'stuccoHouse' ? 0
      : Math.min(9, Math.max(1, Math.round((area / 420) * (0.6 + r())))),
  };
}

// ------------------------------------------------------------- geometry helpers
//
// Every helper below appends into caller-owned arrays with the same convention as
// geom.js extrudeFootprint: (shape args..., pos, nrm, uv, idx, opts). None of
// them constructs a Mesh, a Material or a BufferGeometry — the streamer owns
// meshing so it can merge a whole chunk into one geometry per material.
//
// Buffers may carry an optional `col` array (opts.col) for per-building vertex
// colours. Pass it consistently: a geometry either has colours on every vertex or
// on none.

function pushCol(col, tint, n) {
  if (!col) return;
  for (let i = 0; i < n; i++) col.push(tint[0], tint[1], tint[2]);
}

// One quad, wound a-b-c-d, with `uvq` = [u0,v0,u1,v1] mapped a=(u0,v0) b=(u1,v0)
// c=(u1,v1) d=(u0,v1).
//
// The winding is corrected against the supplied normal rather than trusted. Every
// helper below places quads relative to a footprint edge whose outward direction
// depends on the ring's winding, and OSM gives both windings (168 of the
// district's 523 footprints wind the other way). Hand-deriving the correct vertex
// order for each of those cases is exactly the kind of bug that only shows up as
// a hole in a facade seen from one side, so it is computed instead.
function quad(pos, nrm, uv, idx, a, b, c, d, n, uvq, col, tint) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const gx = e1[1] * e2[2] - e1[2] * e2[1];
  const gy = e1[2] * e2[0] - e1[0] * e2[2];
  const gz = e1[0] * e2[1] - e1[1] * e2[0];
  if (gx * n[0] + gy * n[1] + gz * n[2] < 0) { const t = b; b = d; d = t; }
  const v = pos.length / 3;
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  for (let i = 0; i < 4; i++) nrm.push(n[0], n[1], n[2]);
  uv.push(uvq[0], uvq[1], uvq[2], uvq[1], uvq[2], uvq[3], uvq[0], uvq[3]);
  idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  pushCol(col, tint, 4);
}

/**
 * An axis-aligned box, all six faces sampling one trim cell. The workhorse for
 * roof plant, railings, sign blanks and awning frames.
 */
export function box(cx, cy, cz, sx, sy, sz, pos, nrm, uv, idx, opts = {}) {
  const cell = trimCell(opts.cell ?? TRIM.concrete);
  const q = [cell.u0, cell.v0, cell.u1, cell.v1];
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  quad(pos, nrm, uv, idx, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], q, col, t);
  quad(pos, nrm, uv, idx, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], q, col, t);
  quad(pos, nrm, uv, idx, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], q, col, t);
  quad(pos, nrm, uv, idx, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], q, col, t);
  quad(pos, nrm, uv, idx, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], q, col, t);
  quad(pos, nrm, uv, idx, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], q, col, t);
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

// Edge list with outward normals, sorted long-first when asked. OSM footprints
// arrive in both windings — 168 of the district's 523 wind the other way — so
// outwardness is derived from the signed area rather than assumed. (geom.js
// extrudeFootprint does assume it, which is why its wall normals point inward
// for those 168; harmless for a Lambert box, wrong once the wall is lit.)
export function edgesOf(ring, { minLen = 1.5, longest = 0 } = {}) {
  const flip = ringArea(ring) > 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < minLen) continue;
    out.push({
      a, b, len, i,
      tx: dx / len, tz: dz / len,
      nx: (dz / len) * flip, nz: (-dx / len) * flip,
    });
  }
  if (longest > 0) {
    return out.slice().sort((p, q) => q.len - p.len).slice(0, longest);
  }
  return out;
}

/**
 * Edges whose outward normal faces a given direction, longest first. The streamer
 * can pass the direction of the nearest road; without one, callers fall back to
 * the longest edges, which is right often enough for a block interior.
 *
 * @param {Array<[number,number]>} ring
 * @param {number} dx  street direction x (the way the front should face)
 * @param {number} dz  street direction z
 */
export function facingEdges(ring, dx, dz, { minLen = 3, max = 2, cone = 0.35 } = {}) {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  return edgesOf(ring, { minLen })
    .filter((e) => e.nx * ux + e.nz * uz > cone)
    .sort((a, b) => b.len - a.len)
    .slice(0, max);
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// A band running along an edge, subdivided so the trim cell tiles at `cellM`
// metres instead of being stretched over a 40 m wall.
function bandAlong(e, y0, y1, outset, cell, pos, nrm, uv, idx, opts, cellM = 2.0) {
  const c = trimCell(cell);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const segs = Math.max(1, Math.round(e.len / cellM));
  const ox = e.nx * outset, oz = e.nz * outset;
  for (let s = 0; s < segs; s++) {
    const t0 = s / segs, t1 = (s + 1) / segs;
    const ax = e.a[0] + e.tx * e.len * t0 + ox, az = e.a[1] + e.tz * e.len * t0 + oz;
    const bx = e.a[0] + e.tx * e.len * t1 + ox, bz = e.a[1] + e.tz * e.len * t1 + oz;
    quad(pos, nrm, uv, idx,
      [ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az],
      [e.nx, 0, e.nz], [c.u0, c.v0, c.u1, c.v1], col, t);
  }
}

/**
 * Cornice / parapet. A projecting band at roof level plus the wall that carries
 * on above it, with an inner face and a capping so it reads from the street and
 * from above. `stepped` adds the deco centre step on the longest edges.
 *
 * @param {Array<[number,number]>} ring  footprint
 * @param {number} y  roof height
 */
export function parapet(ring, y, pos, nrm, uv, idx, opts = {}) {
  const h = opts.height ?? 1.1, proj = opts.project ?? 0.22;
  const cell = opts.cell ?? TRIM.stone;
  const c = trimCell(cell);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = edgesOf(ring, { minLen: 0.6 });
  const cornice = y - h * 0.35;

  for (const e of edges) {
    // Projecting cornice: soffit, face, and the top wash.
    const ox = e.nx * proj, oz = e.nz * proj;
    const ax = e.a[0], az = e.a[1], bx = e.b[0], bz = e.b[1];
    quad(pos, nrm, uv, idx,
      [bx, cornice, bz], [ax, cornice, az], [ax + ox, cornice, az + oz], [bx + ox, cornice, bz + oz],
      [0, -1, 0], [c.u0, c.v0, c.u1, c.v1], col, t);
    bandAlong(e, cornice, y, proj, cell, pos, nrm, uv, idx, opts);
    quad(pos, nrm, uv, idx,
      [ax + ox, y, az + oz], [bx + ox, y, bz + oz], [bx, y, bz], [ax, y, az],
      [0, 1, 0], [c.u0, c.v0, c.u1, c.v1], col, t);
    // Parapet above the cornice: outer face, cap, inner face.
    const top = y + h;
    bandAlong(e, y, top, 0, cell, pos, nrm, uv, idx, opts);
    const ix = -e.nx * 0.26, iz = -e.nz * 0.26;
    quad(pos, nrm, uv, idx,
      [ax, top, az], [bx, top, bz], [bx + ix, top, bz + iz], [ax + ix, top, az + iz],
      [0, 1, 0], [c.u0, c.v0, c.u1, c.v1], col, t);
    quad(pos, nrm, uv, idx,
      [bx + ix, y, bz + iz], [ax + ix, y, az + iz], [ax + ix, top, az + iz], [bx + ix, top, bz + iz],
      [-e.nx, 0, -e.nz], [c.u0, c.v0, c.u1, c.v1], col, t);
  }

  if (opts.stepped) {
    for (const e of edgesOf(ring, { minLen: 4, longest: 2 })) {
      const mx = (e.a[0] + e.b[0]) / 2, mz = (e.a[1] + e.b[1]) / 2;
      const w = Math.min(6, e.len * 0.34);
      for (let s = 0; s < 3; s++) {
        const sw = w * (1 - s * 0.26), sh = 0.44;
        box(mx + e.nx * 0.08, y + h + sh / 2 + s * sh, mz + e.nz * 0.08,
          Math.abs(e.tx) * sw + Math.abs(e.nx) * 0.5, sh,
          Math.abs(e.tz) * sw + Math.abs(e.nz) * 0.5,
          pos, nrm, uv, idx, { cell, col: opts.col, tint: opts.tint });
      }
    }
  }
}

/**
 * Ground-floor storefront band with GEOMETRICALLY recessed glazing: the glass
 * plane sits `depth` metres behind the wall line with real jamb, head and sill
 * returns. Reveals are painted into the facade texture everywhere else, but at
 * eye level the depth has to be real or the shopfront reads as a decal.
 *
 * Call this on the street-facing edges only (opts.edges), otherwise every
 * building gets shops on its back alley.
 */
export function storefront(ring, pos, nrm, uv, idx, opts = {}) {
  const head = opts.head ?? 3.6, depth = opts.depth ?? 0.6, bulk = opts.bulkhead ?? 0.42;
  const bayM = opts.bayM ?? 3.2, pier = opts.pier ?? 0.32;
  const glass = trimCell(opts.glassCell ?? TRIM.glass);
  const bulkC = trimCell(opts.bulkheadCell ?? TRIM.bulkhead);
  const jambC = trimCell(opts.jambCell ?? TRIM.stucco);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = opts.edges ?? edgesOf(ring, { minLen: 4, longest: opts.faces ?? 2 });

  for (const e of edges) {
    const bays = Math.max(1, Math.round((e.len - pier * 2) / bayM));
    const bw = (e.len - pier * 2) / bays;
    const P = (x) => [e.a[0] + e.tx * x, e.a[1] + e.tz * x];
    const back = (p, d) => [p[0] - e.nx * d, p[1] - e.nz * d];

    for (let i = 0; i < bays; i++) {
      const s0 = pier + i * bw + pier * 0.5, s1 = pier + (i + 1) * bw - pier * 0.5;
      const o0 = P(s0), o1 = P(s1);            // opening edges at the wall line
      const g0 = back(o0, depth), g1 = back(o1, depth);

      // Recessed glass, its bulkhead, and the transom over it.
      quad(pos, nrm, uv, idx,
        [g0[0], bulk, g0[1]], [g1[0], bulk, g1[1]], [g1[0], head, g1[1]], [g0[0], head, g0[1]],
        [e.nx, 0, e.nz], [glass.u0, glass.v0, glass.u1, glass.v1], col, t);
      quad(pos, nrm, uv, idx,
        [g0[0], 0, g0[1]], [g1[0], 0, g1[1]], [g1[0], bulk, g1[1]], [g0[0], bulk, g0[1]],
        [e.nx, 0, e.nz], [bulkC.u0, bulkC.v0, bulkC.u1, bulkC.v1], col, t);

      // Jambs: the returns that make the recess real.
      quad(pos, nrm, uv, idx,
        [o0[0], 0, o0[1]], [g0[0], 0, g0[1]], [g0[0], head, g0[1]], [o0[0], head, o0[1]],
        [e.tx, 0, e.tz], [jambC.u0, jambC.v0, jambC.u1, jambC.v1], col, t);
      quad(pos, nrm, uv, idx,
        [g1[0], 0, g1[1]], [o1[0], 0, o1[1]], [o1[0], head, o1[1]], [g1[0], head, g1[1]],
        [-e.tx, 0, -e.tz], [jambC.u0, jambC.v0, jambC.u1, jambC.v1], col, t);
      // Soffit over the recess: this is the surface that catches shop light and
      // gives the storefront its occlusion at street level.
      quad(pos, nrm, uv, idx,
        [o0[0], head, o0[1]], [o1[0], head, o1[1]], [g1[0], head, g1[1]], [g0[0], head, g0[1]],
        [0, -1, 0], [jambC.u0, jambC.v0, jambC.u1, jambC.v1], col, t);
      // Threshold slab.
      quad(pos, nrm, uv, idx,
        [g0[0], 0.02, g0[1]], [g1[0], 0.02, g1[1]], [o1[0], 0.02, o1[1]], [o0[0], 0.02, o0[1]],
        [0, 1, 0], [bulkC.u0, bulkC.v0, bulkC.u1, bulkC.v1], col, t);
    }
  }
}

/**
 * Sloped fabric awnings over alternate storefront bays, with a valance and side
 * gussets. Deliberately not every bay: an unbroken run of awnings is the exact
 * kind of regularity that reads as procedural.
 */
export function awnings(ring, pos, nrm, uv, idx, opts = {}) {
  const head = opts.head ?? 3.6, out = opts.project ?? 1.35, drop = opts.drop ?? 0.55;
  const bayM = opts.bayM ?? 3.2;
  const fab = trimCell(opts.cell ?? TRIM.fabricA);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = opts.edges ?? edgesOf(ring, { minLen: 4, longest: opts.faces ?? 2 });
  const r = rng(opts.seed ?? 1);

  for (const e of edges) {
    const bays = Math.max(1, Math.round(e.len / bayM));
    const bw = e.len / bays;
    for (let i = 0; i < bays; i++) {
      if (r() < 0.42) continue;
      const s0 = i * bw + 0.15, s1 = (i + 1) * bw - 0.15;
      const a0 = [e.a[0] + e.tx * s0, e.a[1] + e.tz * s0];
      const a1 = [e.a[0] + e.tx * s1, e.a[1] + e.tz * s1];
      const f0 = [a0[0] + e.nx * out, a0[1] + e.nz * out];
      const f1 = [a1[0] + e.nx * out, a1[1] + e.nz * out];
      const yTop = head + 0.35, yFront = head + 0.35 - drop;
      const nl = Math.hypot(drop, out);
      const n = [(e.nx * drop) / nl, out / nl, (e.nz * drop) / nl];

      // Top surface and its underside, so it is not a one-sided plane from below.
      quad(pos, nrm, uv, idx,
        [a0[0], yTop, a0[1]], [a1[0], yTop, a1[1]], [f1[0], yFront, f1[1]], [f0[0], yFront, f0[1]],
        n, [fab.u0, fab.v0, fab.u1, fab.v1], col, t);
      quad(pos, nrm, uv, idx,
        [f0[0], yFront, f0[1]], [f1[0], yFront, f1[1]], [a1[0], yTop, a1[1]], [a0[0], yTop, a0[1]],
        [-n[0], -n[1], -n[2]], [fab.u0, fab.v0, fab.u1, fab.v1], col, t);
      // Valance hanging off the front edge.
      quad(pos, nrm, uv, idx,
        [f0[0], yFront - 0.32, f0[1]], [f1[0], yFront - 0.32, f1[1]],
        [f1[0], yFront, f1[1]], [f0[0], yFront, f0[1]],
        [e.nx, 0, e.nz], [fab.u0, fab.v0, fab.u1, fab.v1], col, t);
      // Side gussets close the wedge.
      const side = (p0, pf, sx, sz) => quad(pos, nrm, uv, idx,
        [p0[0], head + 0.35, p0[1]], [pf[0], yFront, pf[1]], [pf[0], yFront - 0.32, pf[1]],
        [p0[0], head - 0.05, p0[1]], [sx, 0, sz], [fab.u0, fab.v0, fab.u1, fab.v1], col, t);
      side(a0, f0, -e.tx, -e.tz);
      side(a1, f1, e.tx, e.tz);
      // Support arm.
      const mx = (a0[0] + a1[0]) / 2, mz = (a0[1] + a1[1]) / 2;
      box(mx + e.nx * out * 0.5, head + 0.18, mz + e.nz * out * 0.5,
        Math.abs(e.nx) * out + 0.06, 0.06, Math.abs(e.nz) * out + 0.06,
        pos, nrm, uv, idx, { cell: TRIM.metalDark, col, tint: t });
    }
  }
}

/**
 * Roof mechanical: condensers, a stair bulkhead, a duct run and a vent stack,
 * all placed inside the footprint and clear of the parapet. This is the part of
 * the kit that most changes how a city reads from a high camera.
 */
export function roofUnits(ring, y, pos, nrm, uv, idx, opts = {}) {
  const n = opts.count ?? 3;
  const r = rng(opts.seed ?? 7);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  // Rejection-sample inside the footprint. Bounded so a pathological concave
  // footprint cannot spin here during a chunk build.
  const spots = [];
  for (let tries = 0; tries < n * 24 && spots.length < n; tries++) {
    const x = lerp(x0 + 1.2, x1 - 1.2, r()), z = lerp(z0 + 1.2, z1 - 1.2, r());
    if (!inRing(ring, x, z)) continue;
    if (spots.some((s) => Math.hypot(s[0] - x, s[1] - z) < 2.4)) continue;
    spots.push([x, z]);
  }

  spots.forEach(([x, z], i) => {
    if (i === 0 && spots.length > 1) {
      // Stair bulkhead: the tallest thing on the roof, and the one that reads.
      const w = 2.6 + r() * 1.6, d = 2.2 + r() * 1.4, hh = 2.4 + r() * 0.9;
      box(x, y + hh / 2, z, w, hh, d, pos, nrm, uv, idx, { cell: TRIM.stucco, col, tint: t });
      box(x, y + hh + 0.08, z, w + 0.3, 0.16, d + 0.3, pos, nrm, uv, idx,
        { cell: TRIM.asphalt, col, tint: t });
      return;
    }
    const kind = r();
    if (kind < 0.6) {
      const w = 1.5 + r() * 1.5, d = 1.1 + r() * 1.1, hh = 0.8 + r() * 0.7;
      box(x, y + 0.12, z, w + 0.4, 0.24, d + 0.4, pos, nrm, uv, idx,
        { cell: TRIM.asphalt, col, tint: t });                       // curb
      box(x, y + 0.24 + hh / 2, z, w, hh, d, pos, nrm, uv, idx,
        { cell: TRIM.steel, col, tint: t });
      box(x, y + 0.24 + hh + 0.05, z, w * 0.7, 0.1, d * 0.7, pos, nrm, uv, idx,
        { cell: TRIM.louvre, col, tint: t });                        // fan grille
    } else if (kind < 0.85) {
      const len = 2.5 + r() * 4;
      box(x, y + 0.85, z, r() < 0.5 ? len : 0.7, 0.7, r() < 0.5 ? 0.7 : len,
        pos, nrm, uv, idx, { cell: TRIM.steel, col, tint: t });      // duct run
    } else {
      box(x, y + 0.9, z, 0.5, 1.8, 0.5, pos, nrm, uv, idx,
        { cell: TRIM.rust, col, tint: t });                          // vent stack
    }
  });
}

/**
 * Fire escape: landings, balustrades and stair stringers zig-zagging up one
 * face. Cheap and enormously characterful on a deco or older office block.
 */
export function fireEscape(ring, pos, nrm, uv, idx, opts = {}) {
  const floors = opts.floors ?? 4, floorM = opts.floorM ?? 3.6;
  const w = opts.width ?? 2.4, out = opts.project ?? 1.25;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const e = opts.edge ?? edgesOf(ring, { minLen: 5, longest: 1 })[0];
  if (!e) return;
  const cx = e.a[0] + e.tx * (e.len * (opts.at ?? 0.5));
  const cz = e.a[1] + e.tz * (e.len * (opts.at ?? 0.5));
  const sx = Math.abs(e.tx) * w + Math.abs(e.nx) * out;
  const sz = Math.abs(e.tz) * w + Math.abs(e.nz) * out;
  const px = cx + e.nx * (out / 2), pz = cz + e.nz * (out / 2);
  const cell = { cell: TRIM.metalDark, col, tint: t };

  for (let f = 1; f <= floors; f++) {
    const y = f * floorM - 0.35;
    box(px, y, pz, sx, 0.09, sz, pos, nrm, uv, idx, cell);              // landing
    box(px + e.nx * (out / 2), y + 0.55, pz + e.nz * (out / 2),
      Math.abs(e.tx) * w + Math.abs(e.nx) * 0.06, 1.05,
      Math.abs(e.tz) * w + Math.abs(e.nz) * 0.06, pos, nrm, uv, idx, cell);  // rail
    // Two verticals per landing edge.
    for (const s of [-1, 1]) {
      box(px + e.tx * s * (w / 2), y + 0.55, pz + e.tz * s * (w / 2),
        0.07, 1.05, 0.07, pos, nrm, uv, idx, cell);
    }
    if (f < floors) {
      // Stringer to the next landing, offset to one side so the runs alternate.
      const side = f % 2 ? 1 : -1;
      box(px + e.tx * side * (w * 0.28) + e.nx * out * 0.35, y + floorM / 2,
        pz + e.tz * side * (w * 0.28) + e.nz * out * 0.35,
        Math.abs(e.tx) * 0.9 + Math.abs(e.nx) * 0.9, floorM * 0.92,
        Math.abs(e.tz) * 0.9 + Math.abs(e.nz) * 0.9, pos, nrm, uv, idx, cell);
    }
  }
}

/**
 * Balconies for towers: a cantilevered slab per floor with a glass balustrade,
 * on the long faces only. This is the silhouette that separates a bayfront tower
 * from an extruded box.
 */
export function balconies(ring, pos, nrm, uv, idx, opts = {}) {
  const floors = opts.floors ?? 8, floorM = opts.floorM ?? 3.15;
  const from = opts.from ?? 2, depth = opts.depth ?? 1.7;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = opts.edges ?? edgesOf(ring, { minLen: 6, longest: opts.faces ?? 2 });
  const r = rng(opts.seed ?? 11);

  for (const e of edges) {
    const runs = Math.max(1, Math.floor(e.len / (opts.bayM ?? 6.5)));
    const rw = e.len / runs;
    for (let f = from; f < floors; f++) {
      const y = f * floorM;
      for (let i = 0; i < runs; i++) {
        if (r() < 0.12) continue;             // a few units are enclosed instead
        const s0 = i * rw + 0.35, s1 = (i + 1) * rw - 0.35;
        const mx = e.a[0] + e.tx * ((s0 + s1) / 2) + e.nx * (depth / 2);
        const mz = e.a[1] + e.tz * ((s0 + s1) / 2) + e.nz * (depth / 2);
        const w = s1 - s0;
        const bx = Math.abs(e.tx) * w + Math.abs(e.nx) * depth;
        const bz = Math.abs(e.tz) * w + Math.abs(e.nz) * depth;
        box(mx, y + 0.09, mz, bx, 0.18, bz, pos, nrm, uv, idx,
          { cell: TRIM.concrete, col, tint: t });
        // Balustrade: three sides, glass panel with a metal cap rail.
        const rail = (ox, oz, sx, sz) => {
          box(mx + ox, y + 0.62, mz + oz, sx, 0.88, sz, pos, nrm, uv, idx,
            { cell: TRIM.glass, col, tint: t });
          box(mx + ox, y + 1.09, mz + oz, sx + 0.05, 0.07, sz + 0.05, pos, nrm, uv, idx,
            { cell: TRIM.metalDark, col, tint: t });
        };
        rail(e.nx * (depth / 2), e.nz * (depth / 2), bx * Math.abs(e.tx) + 0.08, bz * Math.abs(e.tz) + 0.08);
        rail(e.tx * (w / 2), e.tz * (w / 2), Math.abs(e.nx) * depth + 0.08, Math.abs(e.nz) * depth + 0.08);
        rail(-e.tx * (w / 2), -e.tz * (w / 2), Math.abs(e.nx) * depth + 0.08, Math.abs(e.nz) * depth + 0.08);
      }
    }
  }
}

/**
 * A blank parapet sign panel standing proud of the roofline, with its frame.
 * Left unlettered on purpose: business names, logos and neon are the signage
 * builder's module. This provides the mounting surface and the silhouette.
 */
export function signBlank(ring, y, pos, nrm, uv, idx, opts = {}) {
  const h = opts.height ?? 1.9, thick = opts.thick ?? 0.22;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const e = opts.edge ?? edgesOf(ring, { minLen: 6, longest: 1 })[0];
  if (!e) return;
  const w = Math.min(opts.maxWidth ?? 9, e.len * 0.62);
  const cx = e.a[0] + e.tx * (e.len / 2) + e.nx * 0.1;
  const cz = e.a[1] + e.tz * (e.len / 2) + e.nz * 0.1;
  const sx = Math.abs(e.tx) * w + Math.abs(e.nx) * thick;
  const sz = Math.abs(e.tz) * w + Math.abs(e.nz) * thick;
  box(cx, y + h / 2 + 0.25, cz, sx, h, sz, pos, nrm, uv, idx,
    { cell: opts.cell ?? TRIM.signFace, col, tint: t });
  // Legs, so it stands on the parapet rather than floating.
  for (const s of [-1, 1]) {
    box(cx + e.tx * s * (w * 0.35), y + 0.14, cz + e.tz * s * (w * 0.35),
      0.14, 0.5, 0.14, pos, nrm, uv, idx, { cell: TRIM.metalDark, col, tint: t });
  }
}

/**
 * Wall extrusion for a facade-textured building. Same job as geom.js
 * extrudeFootprint, with three differences the facade system needs:
 *   - outward normals for BOTH windings (see edgesOf)
 *   - the u origin is centred on each wall, so bays land symmetrically on a
 *     facade instead of being cut at whichever corner happened to be first
 *   - an optional vertex-colour array, which is how per-building colour survives
 *     merging a whole chunk into one material
 *
 * @param {Array<[number,number]>} ring
 * @param {number} height  metres
 */
export function extrudeFacade(ring, height, pos, nrm, uv, idx, opts = {}) {
  const base = opts.base ?? 0;
  const tileU = opts.tileU ?? 16;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const roofCell = trimCell(opts.roofCell ?? TRIM.gravel);
  const vTop = opts.vTop ?? height;

  if (opts.walls !== false) {
    for (const e of edgesOf(ring, { minLen: 0.05 })) {
      const u0 = -((e.len % tileU) / 2);
      quad(pos, nrm, uv, idx,
        [e.a[0], base, e.a[1]], [e.b[0], base, e.b[1]],
        [e.b[0], base + height, e.b[1]], [e.a[0], base + height, e.a[1]],
        [e.nx, 0, e.nz], [u0, 0, u0 + e.len, vTop], col, t);
    }
  }

  if (opts.roof !== false) {
    const tris = triangulateRing(ring);
    const start = pos.length / 3;
    const cellM = opts.roofCellM ?? 4;
    for (const p of ring) {
      pos.push(p[0], base + height, p[1]);
      nrm.push(0, 1, 0);
      const fu = ((p[0] / cellM) % 1 + 1) % 1, fv = ((p[1] / cellM) % 1 + 1) % 1;
      uv.push(lerp(roofCell.u0, roofCell.u1, fu), lerp(roofCell.v0, roofCell.v1, fv));
      pushCol(col, t, 1);
    }
    // Emit each triangle in the order that faces up. A roof polygon whose winding
    // is taken on trust is back-facing for one of the two windings OSM produces,
    // and a back-facing roof is invisible from a helicopter and from the shadow
    // pass while still looking fine from the street — so it survives review.
    for (let i = 0; i < tris.length; i += 3) {
      const a = ring[tris[i]], b = ring[tris[i + 1]], c = ring[tris[i + 2]];
      const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (up < 0) idx.push(start + tris[i], start + tris[i + 1], start + tris[i + 2]);
      else idx.push(start + tris[i + 2], start + tris[i + 1], start + tris[i]);
    }
  }
}

// Ear clipping, kept local so this module has no dependency on geom.js ordering
// and can be used by a caller that only wants the kit.
function triangulateRing(ring) {
  const n = ring.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  if (ringArea(ring) > 0) idx.reverse();
  const out = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = ring[ia], b = ring[ib], c = ring[ic];
      if (cross(a, b, c) <= 0) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(ring[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/**
 * The one-call form: append a whole styled building into two shared buffers.
 *
 *   wall  {pos,nrm,uv,idx,col}  -> facadeMaterial(style.recipe)
 *   trim  {pos,nrm,uv,idx,col}  -> trimMaterial()  (shared by all recipes)
 *
 * A chunk therefore costs (recipes present in that chunk) + 1 draw calls for its
 * buildings. Nothing here allocates a geometry, mesh or material.
 *
 * @param {Array<[number,number]>} ring   footprint in world XZ
 * @param {number} height                 metres
 * @param {Object} style                  from buildingStyle()
 */
export function appendBuilding(ring, height, style, wall, trim, opts = {}) {
  const rec = style.rec;
  const t = style.tint;
  const streetEdges = opts.street
    ? facingEdges(ring, opts.street[0], opts.street[1], { minLen: 4, max: opts.faces ?? 2 })
    : edgesOf(ring, { minLen: 4, longest: opts.faces ?? 2 });

  extrudeFacade(ring, height, wall.pos, wall.nrm, wall.uv, wall.idx, {
    tileU: rec.tileU, tint: t, col: wall.col,
    roofCell: style.recipe === 'stuccoHouse' ? TRIM.asphalt : TRIM.gravel,
    roof: false,
  });
  // The roof goes in the trim buffer: gravel and membrane are trim materials, and
  // keeping them out of the facade buffer means the facade texture never has to
  // reserve space for a surface nobody sees from the street.
  extrudeFacade(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
    tint: [1, 1, 1], col: trim.col, walls: false, roof: true,
    roofCell: style.recipe === 'stuccoHouse' ? TRIM.asphalt : TRIM.gravel,
  });

  const tArgs = { col: trim.col, tint: [1, 1, 1] };
  if (style.parapet) {
    parapet(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
      ...style.parapet, cell: TRIM.stone, ...tArgs, tint: t,
    });
  }
  if (style.storefront) {
    storefront(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
      ...style.storefront, edges: streetEdges, ...tArgs,
    });
    if (style.awnings) {
      awnings(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
        head: style.storefront.head, edges: streetEdges, cell: style.fabric,
        seed: style.seed, ...tArgs,
      });
    }
  }
  if (style.fireEscape) {
    fireEscape(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
      floors: Math.min(style.floors, 6), floorM: rec.floorM, ...tArgs,
    });
  }
  if (style.balconies) {
    balconies(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
      floors: style.floors, floorM: rec.floorM, seed: style.seed, ...tArgs,
    });
  }
  if (style.roofUnits) {
    roofUnits(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
      count: style.roofUnits, seed: style.seed, ...tArgs,
    });
  }
  if (style.signBlank) {
    signBlank(ring, height + (style.parapet?.height ?? 0), trim.pos, trim.nrm, trim.uv, trim.idx, tArgs);
  }
}

/** An empty buffer bundle in the shape every helper here appends into. */
export function buffers() {
  return { pos: [], nrm: [], uv: [], idx: [], col: [] };
}
