// The production material library. Everything here is drawn into a
// canvas at load time; nothing is fetched.
//
// Three constraints shaped every decision in this file:
//
//   1. Draw calls are the project's #1 risk, so a material is a budget line, not
//      a free choice. All eight wall/roof surfaces live in ONE sampler2DArray, so
//      a chunk that merges its buildings into a single geometry still costs a
//      single draw call even when the block mixes stucco, brick and tile roofs.
//      Per-building colour rides in a vertex-colour attribute, not in a material.
//
//   2. Startup time is a budget too (Phase 1 lost 2.2 s to one texture). Height
//      fields are generated at half the albedo resolution, normals are sobelled
//      out of them once, and roughness is packed into the normal map's alpha so
//      a surface costs two textures instead of three.
//
//   3. The streamer owns the mesh UVs and cannot be edited from here. Its road
//      ribbon puts u across the ribbon *whatever its width* and v in 8 m units,
//      which would stretch asphalt on an arterial and squash it in an alley. So
//      every horizontal surface derives its UV from world XZ in the vertex
//      shader instead. That is exact for flat ground, tiles across merged chunk
//      geometry, and is immune to whatever UVs a caller emits.
//
// Photometry: albedo textures are authored as sRGB reflectance for the physical
// lighting in daynight.js — asphalt sits near 0.20, sun-bleached stucco near
// 0.80. Roughness maps are absolute (material.roughness stays 1.0 and multiplies
// them), so a wet-weather pass can scale one number and get a plausible result.

import * as THREE from '../vendor/three.module.min.js';

// ---------------------------------------------------------------- determinism
// Textures are regenerated on every load, so they must be identical on every
// load — otherwise a visual regression is indistinguishable from noise.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---------------------------------------------------------------- tiling noise
// Value noise on a wrapping lattice. Everything in this file has to tile, so the
// lattice index wraps rather than clamping and the smoothstep weights are
// precomputed per axis — the inner loop is four array reads and three lerps.
function valueNoise(size, cells, rand) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const i0 = new Int32Array(size), i1 = new Int32Array(size), w = new Float32Array(size);
  const step = cells / size;
  for (let x = 0; x < size; x++) {
    const f = x * step, a = Math.floor(f), t = f - a;
    i0[x] = ((a % cells) + cells) % cells;
    i1[x] = (i0[x] + 1) % cells;
    w[x] = t * t * (3 - 2 * t);
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const r0 = i0[y] * cells, r1 = i1[y] * cells, wy = w[y], row = y * size;
    for (let x = 0; x < size; x++) {
      const wx = w[x], a = i0[x], b = i1[x];
      const top = g[r0 + a] + (g[r0 + b] - g[r0 + a]) * wx;
      const bot = g[r1 + a] + (g[r1 + b] - g[r1 + a]) * wx;
      out[row + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

function fbm(size, cells, octaves, rand, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, cells * (1 << o), rand);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp; amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Blend a tileable field across a canvas, in pixel space.
//
// The first version upscaled a small noise canvas with drawImage. It looked
// right and it cost the project 1.4 s of load time. Measured here: ONE
// drawImage onto a 2D canvas makes every subsequent path fill on that canvas
// 10-20x slower (43 ms of arc fills became 793 ms); getImageData and
// putImageData have no such effect. So nothing in this file composites through
// drawImage — the upsample and the blend are a single loop over the pixels.
//
// The lattice index wraps and pixel 0 lands exactly on node 0, so the blown-up
// field tiles with no seam.
const BLEND = { 'source-over': 0, multiply: 1, overlay: 2 };

function drawField(g, size, n, field, colorAt, alpha = 1, composite = 'source-over') {
  const mode = BLEND[composite];
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;

  // 256-entry colour LUT: colorAt is a closure, and calling it a quarter of a
  // million times costs more than the quantisation it saves.
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) colorAt(i / 255, lut, i * 4);

  const i0 = new Int32Array(size), i1 = new Int32Array(size), w = new Float32Array(size);
  const step = n / size;
  for (let x = 0; x < size; x++) {
    const f = x * step, a = Math.floor(f);
    i0[x] = ((a % n) + n) % n;
    i1[x] = (i0[x] + 1) % n;
    w[x] = f - a;
  }
  for (let y = 0; y < size; y++) {
    const r0 = i0[y] * n, r1 = i1[y] * n, wy = w[y];
    let p = y * size * 4;
    for (let x = 0; x < size; x++, p += 4) {
      const a = i0[x], b = i1[x], wx = w[x];
      const top = field[r0 + a] + (field[r0 + b] - field[r0 + a]) * wx;
      const bot = field[r1 + a] + (field[r1 + b] - field[r1 + a]) * wx;
      const li = (((top + (bot - top) * wy) * 255) & 255) * 4;
      const s0 = lut[li], s1 = lut[li + 1], s2 = lut[li + 2];
      const b0 = d[p], b1 = d[p + 1], b2 = d[p + 2];
      let v0, v1, v2;
      if (mode === 1) { v0 = b0 * s0 / 255; v1 = b1 * s1 / 255; v2 = b2 * s2 / 255; }
      else if (mode === 2) {
        v0 = b0 < 128 ? 2 * b0 * s0 / 255 : 255 - 2 * (255 - b0) * (255 - s0) / 255;
        v1 = b1 < 128 ? 2 * b1 * s1 / 255 : 255 - 2 * (255 - b1) * (255 - s1) / 255;
        v2 = b2 < 128 ? 2 * b2 * s2 / 255 : 255 - 2 * (255 - b2) * (255 - s2) / 255;
      } else { v0 = s0; v1 = s1; v2 = s2; }
      d[p] = b0 + (v0 - b0) * alpha;
      d[p + 1] = b1 + (v1 - b1) * alpha;
      d[p + 2] = b2 + (v2 - b2) * alpha;
    }
  }
  g.putImageData(img, 0, 0);
}

const greyField = (lo, hi) => (v, d, i) => {
  const c = (lo + (hi - lo) * v) * 255;
  d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
};

// Draw at every wrapped position the shape can reach, so scattered detail
// crosses the tile seam instead of being clipped by it.
function wrapped(g, size, x, y, radius, draw) {
  const xs = x < radius ? [0, size] : x > size - radius ? [0, -size] : [0];
  const ys = y < radius ? [0, size] : y > size - radius ? [0, -size] : [0];
  for (const dx of xs) {
    for (const dy of ys) {
      g.save(); g.translate(x + dx, y + dy); draw(g); g.restore();
    }
  }
}

// A polyline that starts and ends at the same height, so it meets itself across
// the seam. Used for tar seams, cracks and sand ripples.
function seamlessStroke(g, size, axis, base, wobble, steps, rand) {
  const offs = [];
  let sum = 0;
  for (let i = 0; i < steps; i++) { const d = (rand() - 0.5) * wobble; offs.push(d); sum += d; }
  const corr = sum / steps;
  g.beginPath();
  let v = base;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * size;
    if (axis === 'x') { if (i === 0) g.moveTo(0, v); else g.lineTo(t, v); }
    else if (i === 0) g.moveTo(v, 0); else g.lineTo(v, t);
    if (i < steps) v += offs[i] - corr;
  }
  g.stroke();
}

// A crack network described ONCE and painted into more than one map.
//
// seamlessStroke() draws straight from a random stream, so two maps of the same
// surface get two DIFFERENT crack networks unless their streams are still in
// step — and they never are, because paintAlbedo and paintHeight consume
// different numbers of values before they get there. Worse, its wobble and base
// are in PIXELS, and the albedo is 512 px over the same 3 m the 256 px height
// map covers, so even an aligned stream would zig-zag twice as wide on one as on
// the other.
//
// The result on the sidewalk was two unrelated crack systems per tile: a painted
// one you could see, and an embossed one somewhere else that the low sun lit as
// a warm ridge — the "yellow decal squiggles" three critics reported, at the
// right UV and the right 3 m scale, but describing a crack that is not there.
//
// crackSet() takes its numbers off the HEAD of the stream so any two paint
// passes seeded alike agree, and states everything as a fraction of the map so
// resolution cannot change the shape.
//
// `cells` clips each crack to ONE cell of a cells x cells grid, which is what a
// slab-on-grade surface actually does: the control joint is there precisely to
// take the crack, so concrete cracks BETWEEN joints and stops at them. Drawn
// unclipped, three cracks at a 3 m repeat read as one continuous fracture
// running the length of the block and straight over the slab joints — which is
// the "cracks incorrectly continue over the sidewalk" every critic round has
// reported. It costs one extra clip per crack.
function crackSet(rand, n, wobble = 0.14, steps = 10, cells = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const offs = [];
    let sum = 0;
    for (let k = 0; k < steps; k++) { const dv = (rand() - 0.5) * wobble; offs.push(dv); sum += dv; }
    const corr = sum / steps;
    for (let k = 0; k < steps; k++) offs[k] -= corr;      // ends meet across the seam
    const axis = rand() < 0.5 ? 'x' : 'y';
    if (cells > 0) {
      // Put the crack inside the cell it will be clipped to, or the clip leaves
      // nothing on screen.
      const cx = (rand() * cells) | 0, cy = (rand() * cells) | 0;
      const along = axis === 'x' ? cy : cx;
      out.push({ axis, base: (along + 0.18 + rand() * 0.64) / cells, offs, cx, cy, cells });
    } else {
      out.push({ axis, base: rand(), offs });
    }
  }
  return out;
}

function strokeCrack(g, size, c) {
  if (c.cells) {
    const cw = size / c.cells;
    g.save();
    g.beginPath();
    g.rect(c.cx * cw, c.cy * cw, cw, cw);
    g.clip();
    strokeCrackPath(g, size, c);
    g.restore();
    return;
  }
  strokeCrackPath(g, size, c);
}

function strokeCrackPath(g, size, c) {
  const steps = c.offs.length;
  g.beginPath();
  let v = c.base * size;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * size;
    if (c.axis === 'x') { if (i === 0) g.moveTo(0, v); else g.lineTo(t, v); }
    else if (i === 0) g.moveTo(v, 0); else g.lineTo(v, t);
    if (i < steps) v += c.offs[i] * size;
  }
  g.stroke();
}

// Scattered grain, blended straight into the pixel buffer. `colorAt(t, out)`
// fills out with r,g,b in 0..255 and alpha in 0..1; the modulo wrap tiles it.
function speckle(g, size, count, rand, colorAt, maxR = 2.4) {
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  const c = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    colorAt(rand(), c);
    const a = c[3];
    const w = 1 + ((rand() * maxR) | 0);
    const x0 = (rand() * size) | 0, y0 = (rand() * size) | 0;
    for (let dy = 0; dy < w; dy++) {
      const row = ((y0 + dy) % size) * size;
      for (let dx = 0; dx < w; dx++) {
        const p = (row + ((x0 + dx) % size)) * 4;
        d[p] += (c[0] - d[p]) * a;
        d[p + 1] += (c[1] - d[p + 1]) * a;
        d[p + 2] += (c[2] - d[p + 2]) * a;
      }
    }
  }
  g.putImageData(img, 0, 0);
}

// Add a disc to the current path, plus whatever wrapped copies it needs, so a
// whole bucket of stones can be filled in one call.
function arcWrapped(g, size, x, y, r) {
  const xs = x < r + 1 ? [0, size] : x > size - r - 1 ? [0, -size] : [0];
  const ys = y < r + 1 ? [0, size] : y > size - r - 1 ? [0, -size] : [0];
  for (const dx of xs) {
    for (const dy of ys) { g.moveTo(x + dx + r, y + dy); g.arc(x + dx, y + dy, r, 0, TAU); }
  }
}

// ---------------------------------------------------------------- normal maps
// Sobel over a wrapping height field. Green is +v: canvas row 0 is the TOP of the
// image and CanvasTexture flips Y, so increasing the array row index is
// decreasing v, and the sign of the y gradient flips out of that.
function sobelNormalRough(height, rough, size, strength) {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = ((y + size - 1) % size) * size, yc = y * size, yp = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xm = (x + size - 1) % size, xp = (x + 1) % size;
      const dx = (height[ym + xp] + 2 * height[yc + xp] + height[yp + xp])
               - (height[ym + xm] + 2 * height[yc + xm] + height[yp + xm]);
      const dy = (height[yp + xm] + 2 * height[yp + x] + height[yp + xp])
               - (height[ym + xm] + 2 * height[ym + x] + height[ym + xp]);
      const nx = -dx * strength, ny = dy * strength;
      const inv = 255 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (yc + x) * 4;
      px[i] = nx * inv * 0.5 + 127.5;
      px[i + 1] = ny * inv * 0.5 + 127.5;
      px[i + 2] = inv * 0.5 + 127.5;
      px[i + 3] = rough ? rough[yc + x] * 255 : 255;
    }
  }
  return px;
}

// Luminance of a canvas as a 0..1 field, one readback per surface. Phase 1's
// 2.2 s texture came from doing per-pixel canvas WORK after a readback; the
// readback itself is a memcpy and is not the expensive part.
function luminanceField(canvas, size) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
  }
  return out;
}

// ---------------------------------------------------------------- surfaces
// Each surface is three painters over the same seeded RNG, so the albedo, the
// height field and the roughness field all agree about where the bricks are.
// `tile` is the size in metres that one texture repeat covers.

function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }

const asphaltSurface = {
  tile: 3, albedo: 512, detail: 256, normalStrength: 1.4,
  paintAlbedo(g, S, rand) {
    g.fillStyle = '#54575d'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.34, 0.82), 0.30, 'overlay');
    // Aggregate. Real asphalt reads as thousands of 1-2 cm stones in a dark binder.
    speckle(g, S, 9000, rand, (r, o) => {
      const v = 62 + r * 96;
      o[0] = v; o[1] = v + 2; o[2] = v + 6; o[3] = 0.20 + r * 0.45;
    }, 2.6);
    speckle(g, S, 900, rand, (r, o) => {
      o[0] = 140 + r * 60; o[1] = 128 + r * 55; o[2] = 110 + r * 45; o[3] = 0.35;
    }, 2.0);
    // Tar seams: crack-sealing compound, proud of the surface and near-black.
    g.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      g.strokeStyle = 'rgba(22,22,25,0.72)'; g.lineWidth = 7 + rand() * 6;
      seamlessStroke(g, S, i === 0 ? 'x' : 'y', rand() * S, 26, 16, rand);
    }
    for (let i = 0; i < 5; i++) {
      g.strokeStyle = 'rgba(26,26,28,0.35)'; g.lineWidth = 1.5;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 60, 12, rand);
    }
    // Drip stains under parked traffic.
    for (let i = 0; i < 7; i++) {
      const x = rand() * S, y = rand() * S, r = 14 + rand() * 40;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, 'rgba(18,17,16,0.42)');
        grd.addColorStop(1, 'rgba(18,17,16,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.35, 0.65), 0.7);
    speckle(g, S, 4500, rand, (r, o) => { o[0] = o[1] = o[2] = 255; o[3] = 0.10 + r * 0.28; }, 1.6);
    g.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      g.strokeStyle = 'rgba(235,235,235,0.8)'; g.lineWidth = 7 + rand() * 6;
      seamlessStroke(g, S, i === 0 ? 'x' : 'y', rand() * S, 26, 16, rand);
    }
    for (let i = 0; i < 5; i++) {
      g.strokeStyle = 'rgba(20,20,20,0.6)'; g.lineWidth = 1.5;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 60, 12, rand);
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#e2e2e2'; g.fillRect(0, 0, S, S);       // 0.89 dry asphalt
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.62, 0.98), 0.55);
    for (let i = 0; i < 7; i++) {                           // oil is much smoother
      const x = rand() * S, y = rand() * S, r = 14 + rand() * 40;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, 'rgba(70,70,70,0.75)');
        grd.addColorStop(1, 'rgba(70,70,70,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
  },
};

// A running-bond course of clay pavers, stated in FRACTIONS of the map so the
// 512 px albedo and the 256 px height map lay the same bricks in the same
// places. Alternate rows are offset half a brick, which puts one brick per odd
// row across the wrap seam, so that one is drawn twice.
function runningBond(S, cols, rows, draw) {
  const bw = S / cols, bh = S / rows;
  for (let r = 0; r < rows; r++) {
    const off = (r & 1) ? bw / 2 : 0;
    for (let c = 0; c < cols; c++) {
      const x = c * bw + off, y = r * bh;
      draw(x, y, bw, bh, c, r);
      if (x + bw > S) draw(x - S, y, bw, bh, c, r);
    }
  }
}

// Per-brick variation from the brick's own COORDINATES, not from the shared
// random stream. paintAlbedo and paintHeight consume different numbers of
// values before they get here — the exact trap crackSet() exists for — and a
// paver whose colour and whose height came from two different bricks reads as
// a shimmer rather than as a paver.
function brickHash(c, r, k) {
  let h = (Math.imul(c, 374761393) + Math.imul(r, 668265263) + Math.imul(k, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// -------------------------------------------------------- BRICK PAVER SIDEWALK
//
// reference/sarasota/02-Worth-s-Block shows the definitive downtown Sarasota
// block, and the pavement in front of it is red-brown clay pavers in running
// bond, not the poured concrete slabs this surface used to paint. Same in
// 05-Sarasota-Opera-House, where a paver band runs the width of the crossing.
// It is the second-loudest wrong note in the district after the vegetation and
// it costs NOTHING: this is a canvas painter, so the whole change is zero
// triangles and zero draw calls.
//
// 15 x 30 modules over the 3 m tile is a 200 x 100 mm paver, which is the
// standard clay unit, with a 9 mm joint. At 512 px that is 34 x 17 px per
// brick — enough to carry a per-brick colour — and at the 256 px height map it
// is 17 x 8.5, enough to carry the joint.
//
// The palette is authored, not sampled: binding constraint 9 keeps every
// texture procedural and it is also what keeps the reference photographs'
// CC BY-SA share-alike off the shipped assets. What the photograph establishes
// is the RANGE — clay pavers are not one red, they are a spread from orange-red
// through brown to buff with the odd burnt one — and a single flat red is the
// thing that would read as a texture rather than as a pavement.
const sidewalkSurface = {
  // normalStrength was 2.2, the highest of any ground surface here, which turned
  // a 1.2 px hairline into a kerb-sized crease. 1.6 matches concrete and leaves
  // the joints reading without embossing every scratch.
  tile: 3, albedo: 512, detail: 256, normalStrength: 1.6,
  paintAlbedo(g, S, rand) {
    // Off the head of the stream, before anything else draws from it, so
    // paintHeight below embosses these exact cracks and not a second set.
    const cracks = crackSet(rand, 4, 0.11, 9, 2);
    // Bedding sand and silt, showing in every joint.
    g.fillStyle = hsl(30, 9, 30); g.fillRect(0, 0, S, S);
    const J = (S / 512) * 1.6;                     // ~9 mm of joint at either size
    runningBond(S, 15, 30, (x, y, w, h, c, r) => {
      const a = brickHash(c, r, 1), b = brickHash(c, r, 2), d = brickHash(c, r, 3);
      // The FIRST cut of this ran hue 9-26, saturation 18-33 and lightness
      // 31-44 with a burnt paver every 14 bricks and a buff one every 14, and
      // the capture read as confetti: a mosaic of independently coloured chips
      // rather than a pavement. A brick pavement's variation is real but it is
      // NARROW — one clay, one kiln, one delivery — and the wide version also
      // aliased, because a per-brick step with that much variance mips to an
      // average nothing like what the near view shows. Half the range, and the
      // outliers moved from 1-in-14 to 1-in-40.
      // Lightness 40-48 was the first authored range and it measured a real
      // cost at night: clay is darker than the concrete this replaced, and
      // tools/critic-metrics.mjs on corridor-night went crushed 6.05% -> 7.79%
      // and the lamp pool's "away" band 11.2 -> 4.9 against a same-build noise
      // of 0.09pp. That frame is already logged in PROGRESS.md as a black hole
      // below y~560, so darkening it further is not a trade this change gets to
      // make. 44-52 is still plainly brick and still inside what the reference
      // supports; the sunlit judgement that set the hue and saturation was made
      // at golden hour and is unaffected.
      let hue = 13 + a * 10, sat = 15 + b * 10, lit = 44 + d * 8;
      // The outliers stay WARM. At saturation 10 and lightness 50 the buff
      // paver was the only near-neutral thing in a warm field, so the sky lit
      // it blue and it read as a chip of tile dropped on a brick pavement -
      // clearly visible in the 3x crop of the first capture. A replaced paver
      // is a different firing of the same clay, not a different material.
      if (d > 0.975) { hue = 14 + a * 6; sat = 17 + b * 6; lit = 37 + b * 3; }
      else if (d < 0.025) { hue = 22 + a * 8; sat = 17 + b * 6; lit = 52 + b * 3; }
      g.fillStyle = hsl(hue, sat, lit);
      g.fillRect(x + J * 0.5, y + J * 0.5, w - J, h - J);
      // Fired clay is not flat: one end of a paver is darker than the other.
      const grd = g.createLinearGradient(x, y, x + w, y + h);
      grd.addColorStop(0, `rgba(0,0,0,${0.09 * a})`);
      grd.addColorStop(1, `rgba(255,240,225,${0.07 * b})`);
      g.fillStyle = grd;
      g.fillRect(x + J * 0.5, y + J * 0.5, w - J, h - J);
    });
    // Weathering across the bond: sun bleach, traffic film, damp patches. All
    // at scales LARGER than one brick, so the eye reads a pavement that has
    // been there thirty years rather than a tiled pattern.
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.56, 0.92), 0.22, 'overlay');
    drawField(g, S, 24, fbm(24, 3, 2, rand), greyField(0.78, 1.0), 0.16, 'multiply');
    speckle(g, S, 5200, rand, (r, o) => {
      o[0] = 158 + r * 62; o[1] = 132 + r * 58; o[2] = 116 + r * 54; o[3] = 0.05 + r * 0.12;
    }, 1.6);
    // Cracking runs through the BEDDING, not through fired clay: on a paver
    // field what a critic reads as a crack is a line of settled, silted joints.
    g.strokeStyle = 'rgba(38,28,22,0.30)'; g.lineWidth = 2.0;
    for (const c of cracks) strokeCrack(g, S, c);
    for (let i = 0; i < 12; i++) {                           // flattened gum
      const x = rand() * S, y = rand() * S, r = 2 + rand() * 4;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = `rgba(86,80,72,${0.22 + rand() * 0.28})`;
        c.beginPath(); c.ellipse(0, 0, r, r * 0.85, rand() * TAU, 0, TAU); c.fill();
      });
    }
  },
  paintHeight(g, S, rand) {
    const cracks = crackSet(rand, 4, 0.11, 9, 2);  // same seed, same draws, same cracks
    // Mid grey is the joint; every paver stands above it.
    g.fillStyle = '#7c7c7c'; g.fillRect(0, 0, S, S);
    const J = (S / 512) * 1.6;
    runningBond(S, 15, 30, (x, y, w, h, c, r) => {
      // Pavers settle. A few sit proud of their neighbours and a few have sunk,
      // and that unevenness is most of what says "laid on sand" rather than
      // "printed on". Kept to a +/-8/255 band: the lesson two surfaces above is
      // that a step of 87/255 across one pixel is a trench, not a texture.
      const e = brickHash(c, r, 4);
      const lvl = Math.round(162 + e * 40);
      g.fillStyle = `rgb(${lvl},${lvl},${lvl})`;
      g.fillRect(x + J * 0.5, y + J * 0.5, w - J, h - J);
      // Chamfer: a clay paver's edges are eased, so the joint is a soft V and
      // not a slot. One inset stroke does it and costs no second map.
      g.strokeStyle = `rgba(${lvl - 34},${lvl - 34},${lvl - 34},0.85)`;
      g.lineWidth = Math.max(1, (S / 512) * 2.2);
      g.strokeRect(x + J * 0.5, y + J * 0.5, w - J, h - J);
    });
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.44, 0.58), 0.42);
    // A settled line across the bond is a dip, not a cut: wide and shallow.
    g.strokeStyle = 'rgba(110,110,110,0.40)'; g.lineWidth = (S / 512) * 3.0;
    for (const c of cracks) strokeCrack(g, S, c);
  },
  paintRough(g, S, rand) {
    // Fired clay is matte and slightly less rough than a wind-blown joint, and
    // the worn crowns of the pavers polish over time.
    g.fillStyle = '#e2e2e2'; g.fillRect(0, 0, S, S);
    const J = (S / 512) * 1.6;
    runningBond(S, 15, 30, (x, y, w, h, c, r) => {
      const v = Math.round(196 + brickHash(c, r, 5) * 40);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x + J * 0.5, y + J * 0.5, w - J, h - J);
    });
    drawField(g, S, 64, fbm(64, 8, 3, rand), greyField(0.74, 1.0), 0.5);
  },
};

const concreteSurface = {
  tile: 3, albedo: 512, detail: 256, normalStrength: 1.6,
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(36, 6, 64); g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 4, rand), greyField(0.3, 0.8), 0.36, 'overlay');
    speckle(g, S, 5000, rand, (r, o) => {
      o[0] = 160 + r * 70; o[1] = 156 + r * 66; o[2] = 146 + r * 60; o[3] = 0.08 + r * 0.2;
    }, 1.6);
    for (let i = 0; i < 40; i++) {                    // air bubbles from the pour
      const x = rand() * S, y = rand() * S, r = 1 + rand() * 3;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = 'rgba(96,92,84,0.45)';
        c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
    for (let i = 0; i < 4; i++) {                     // rain streaking
      const x = rand() * S;
      g.fillStyle = `rgba(96,92,84,${0.05 + rand() * 0.07})`;
      g.fillRect(x, 0, 6 + rand() * 22, S);
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 4, rand), greyField(0.42, 0.58), 0.85);
    for (let i = 0; i < 40; i++) {
      const x = rand() * S, y = rand() * S, r = 1 + rand() * 3;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = 'rgba(20,20,20,0.7)';
        c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 4, rand), greyField(0.75, 1.0), 0.6);
  },
};

const parkingSurface = {
  // 10.8 m tile: four 2.7 m bays across, two 5.4 m rows back to back. Integer
  // bays on both axes is what lets a painted lot tile at all.
  tile: 10.8, albedo: 512, detail: 160, normalStrength: 1.0,
  paintAlbedo(g, S, rand) {
    g.fillStyle = '#585b61'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.36, 0.80), 0.34, 'overlay');
    speckle(g, S, 6000, rand, (r, o) => {
      const v = 66 + r * 86;
      o[0] = v; o[1] = v + 2; o[2] = v + 6; o[3] = 0.16 + r * 0.34;
    }, 2.0);
    for (let i = 0; i < 10; i++) {
      const x = rand() * S, y = rand() * S, r = 8 + rand() * 26;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, 'rgba(16,15,14,0.45)');
        grd.addColorStop(1, 'rgba(16,15,14,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
    const lw = Math.max(3, (S / 10.8) * 0.1);          // 10 cm paint
    g.strokeStyle = 'rgba(236,232,214,0.80)'; g.lineWidth = lw;
    for (let i = 0; i < 4; i++) {
      const x = (i / 4) * S;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke();
    }
    g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
    // Worn paint: scrub some of it back out with the asphalt colour.
    speckle(g, S, 2400, rand, (r, o) => { o[0] = 88; o[1] = 91; o[2] = 97; o[3] = 0.55; }, 3.4);
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.36, 0.64), 0.8);
    speckle(g, S, 3000, rand, (r, o) => { o[0] = o[1] = o[2] = 255; o[3] = 0.08 + r * 0.22; }, 1.4);
    const lw = Math.max(3, (S / 10.8) * 0.1);
    g.strokeStyle = 'rgba(220,220,220,0.7)'; g.lineWidth = lw;
    for (let i = 0; i < 4; i++) {
      const x = (i / 4) * S;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke();
    }
    g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#e0e0e0'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.6, 0.98), 0.6);
    const lw = Math.max(3, (S / 10.8) * 0.1);
    g.strokeStyle = 'rgba(150,150,150,0.8)'; g.lineWidth = lw;  // paint is smoother
    for (let i = 0; i < 4; i++) {
      const x = (i / 4) * S;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke();
    }
    g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  },
};

const grassSurface = {
  tile: 4, albedo: 320, detail: 160, normalStrength: 1.1,
  // St Augustine turf: coarse, blue-green, and patchy where it burns off.
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(92, 26, 30); g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), (v, d, i) => {
      d[i] = 110 + v * 70; d[i + 1] = 130 + v * 60; d[i + 2] = 60 + v * 40; d[i + 3] = 255;
    }, 0.5, 'overlay');
    // Blades in colour buckets: one path and one stroke per bucket instead of
    // 8000 individual stroke calls, which is the difference between 6 ms and 300.
    const buckets = 24;
    for (let b = 0; b < buckets; b++) {
      const t = (b + 0.5) / buckets;
      g.strokeStyle = hsl(78 + t * 34, 22 + ((b * 7) % 26), 20 + ((b * 11) % 24), 0.55 + t * 0.35);
      g.lineWidth = 1 + (b % 3) * 0.35;
      g.beginPath();
      for (let i = 0; i < 340; i++) {
        const x = rand() * S, y = rand() * S, a = rand() * TAU, len = 3 + rand() * 6;
        g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      }
      g.stroke();
    }
    for (let i = 0; i < 9; i++) {                    // sun-burnt patches
      const x = rand() * S, y = rand() * S, r = 18 + rand() * 54;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, `rgba(150,132,74,${0.24 + rand() * 0.2})`);
        grd.addColorStop(1, 'rgba(150,132,74,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.25, 0.75), 0.9);
    speckle(g, S, 5000, rand, (r, o) => { o[0] = o[1] = o[2] = 255; o[3] = 0.1 + r * 0.3; }, 2.2);
  },
  paintRough: null,
  roughness: 0.94,
};

const dirtSurface = {
  tile: 4, albedo: 320, detail: 160, normalStrength: 1.5,
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(32, 22, 40); g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 4, rand), (v, d, i) => {
      d[i] = 120 + v * 74; d[i + 1] = 98 + v * 62; d[i + 2] = 70 + v * 48; d[i + 3] = 255;
    }, 0.72, 'overlay');
    speckle(g, S, 5200, rand, (r, o) => {
      o[0] = 150 + r * 70; o[1] = 126 + r * 58; o[2] = 96 + r * 46; o[3] = 0.12 + r * 0.3;
    }, 2.6);
    for (let i = 0; i < 90; i++) {                    // pebbles
      const x = rand() * S, y = rand() * S, r = 1.4 + rand() * 3.4;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = `rgba(${150 + rand() * 60},${142 + rand() * 52},${126 + rand() * 44},0.8)`;
        c.beginPath(); c.ellipse(0, 0, r, r * 0.8, rand() * TAU, 0, TAU); c.fill();
      });
    }
    for (let i = 0; i < 6; i++) {
      g.strokeStyle = 'rgba(64,50,36,0.4)'; g.lineWidth = 1.6;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 80, 12, rand);
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 4, rand), greyField(0.28, 0.72), 0.9);
    for (let i = 0; i < 90; i++) {
      const x = rand() * S, y = rand() * S, r = 1.4 + rand() * 3.4;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = 'rgba(255,255,255,0.55)';
        c.beginPath(); c.ellipse(0, 0, r, r * 0.8, rand() * TAU, 0, TAU); c.fill();
      });
    }
  },
  paintRough: null,
  roughness: 0.97,
};

const sandSurface = {
  tile: 6, albedo: 320, detail: 160, normalStrength: 1.0,
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(42, 28, 76); g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.55, 0.95), 0.45, 'overlay');
    // Wind ripples: a slow drift line repeated across the tile.
    g.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(168,146,112,${0.10 + rand() * 0.12})`;
      g.lineWidth = 2 + rand() * 3;
      seamlessStroke(g, S, 'x', (i / 26) * S + (rand() - 0.5) * 6, 12, 14, rand);
    }
    speckle(g, S, 5000, rand, (r, o) => {
      o[0] = 226 + r * 24; o[1] = 212 + r * 24; o[2] = 186 + r * 30; o[3] = 0.1 + r * 0.24;
    }, 1.4);
    speckle(g, S, 260, rand, (r, o) => {         // shell fragments
      o[0] = 252; o[1] = 250; o[2] = 244; o[3] = 0.85;
    }, 2.2);
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.42, 0.58), 0.8);
    g.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(230,230,230,${0.2 + rand() * 0.2})`;
      g.lineWidth = 2 + rand() * 3;
      seamlessStroke(g, S, 'x', (i / 26) * S + (rand() - 0.5) * 6, 12, 14, rand);
    }
  },
  paintRough: null,
  roughness: 0.92,
};

// ---------------------------------------------------------------- wall + roof
// These eight are packed into one texture array. `uvTile` is in UV units, not
// metres, because extrudeFootprint emits wall UVs in metres but roof UVs in
// metres * 0.25 — the roof layers carry the 0.25 so both land on a 3 m repeat.

const stuccoSurface = {
  uvTile: 3, normalStrength: 1.0,
  paintAlbedo(g, S, rand) {
    g.fillStyle = '#f2eee4'; g.fillRect(0, 0, S, S);
    // One field spanning trowel-scale down to sand-scale: two full-size blends
    // cost twice as much as six octaves of noise on a 96-cell lattice.
    drawField(g, S, 96, fbm(96, 3, 6, rand), greyField(0.58, 1.0), 0.70, 'multiply');
    speckle(g, S, 6000, rand, (r, o) => {
      o[0] = 196 + r * 50; o[1] = 190 + r * 50; o[2] = 178 + r * 50; o[3] = 0.06 + r * 0.14;
    }, 1.6);
    for (let i = 0; i < 5; i++) {                   // hairline cracks and patches
      g.strokeStyle = 'rgba(150,142,128,0.4)'; g.lineWidth = 1.1;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 90, 10, rand);
    }
    for (let i = 0; i < 3; i++) {
      const x = rand() * S, y = rand() * S, r = 20 + rand() * 50;
      wrapped(g, S, x, y, r, (c) => {
        c.fillStyle = `rgba(228,222,208,${0.3 + rand() * 0.25})`;
        c.beginPath(); c.ellipse(0, 0, r, r * (0.5 + rand() * 0.6), rand() * TAU, 0, TAU); c.fill();
      });
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.34, 0.66), 0.9);   // trowel
    drawField(g, S, 96, fbm(96, 12, 2, rand), greyField(0.42, 0.58), 0.7);  // sand
    for (let i = 0; i < 5; i++) {
      g.strokeStyle = 'rgba(30,30,30,0.65)'; g.lineWidth = 1.1;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 90, 10, rand);
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#e0e0e0'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.78, 1.0), 0.5);
  },
};

// Running bond at 24 cm x 7.5 cm over a 2.4 m tile: 10 bricks by 32 courses.
const brickSurface = {
  uvTile: 2.4, normalStrength: 2.4,
  paintAlbedo(g, S, rand) {
    const cols = 10, rows = 32, bw = S / cols, bh = S / rows, m = Math.max(1.6, S / 240);
    g.fillStyle = '#b8b2a6'; g.fillRect(0, 0, S, S);      // mortar
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw * 0.5;
      for (let c = -1; c < cols; c++) {
        const x = c * bw + off, y = r * bh;
        const l = 74 + (rand() - 0.5) * 22;
        const h = 18 + (rand() - 0.5) * 16;
        g.fillStyle = hsl(h, 6 + rand() * 8, Math.max(40, Math.min(92, l)));
        for (const dx of x < 0 ? [0, S] : x + bw > S ? [0, -S] : [0]) {
          g.fillRect(x + dx + m / 2, y + m / 2, bw - m, bh - m);
        }
      }
    }
    drawField(g, S, 64, fbm(64, 4, 4, rand), greyField(0.68, 1.0), 0.42, 'multiply');
    speckle(g, S, 4000, rand, (r, o) => {
      o[0] = 190 + r * 60; o[1] = 186 + r * 58; o[2] = 176 + r * 54; o[3] = 0.05 + r * 0.14;
    }, 1.4);
    for (let i = 0; i < 4; i++) {                          // efflorescence
      const x = rand() * S, y = rand() * S, r = 16 + rand() * 40;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.20)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
  },
  paintHeight(g, S, rand) {
    const cols = 10, rows = 32, bw = S / cols, bh = S / rows, m = Math.max(1.6, S / 240);
    g.fillStyle = '#4a4a4a'; g.fillRect(0, 0, S, S);      // recessed mortar
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw * 0.5;
      for (let c = -1; c < cols; c++) {
        const x = c * bw + off, y = r * bh;
        const v = 190 + rand() * 50;
        g.fillStyle = `rgb(${v},${v},${v})`;
        for (const dx of x < 0 ? [0, S] : x + bw > S ? [0, -S] : [0]) {
          g.fillRect(x + dx + m / 2, y + m / 2, bw - m, bh - m);
        }
      }
    }
    drawField(g, S, 96, fbm(96, 12, 2, rand), greyField(0.44, 0.56), 0.5);
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, S, S);
    const cols = 10, rows = 32, bw = S / cols, bh = S / rows, m = Math.max(1.6, S / 240);
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw * 0.5;
      for (let c = -1; c < cols; c++) {
        const v = 190 + rand() * 45;                       // fired brick is glossier
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(c * bw + off + m / 2, r * bh + m / 2, bw - m, bh - m);
      }
    }
  },
};

// Precast panels with a 3 m module, board-marked face and form-tie dimples.
const panelSurface = {
  uvTile: 3, normalStrength: 1.8,
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(38, 5, 70); g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 4, rand), greyField(0.55, 1.0), 0.36, 'multiply');
    for (let i = 0; i < 22; i++) {                         // board-form banding
      const y = (i / 22) * S;
      g.fillStyle = `rgba(${150 + rand() * 40},${146 + rand() * 38},${136 + rand() * 36},${0.10 + rand() * 0.12})`;
      g.fillRect(0, y, S, S / 22);
    }
    const j = Math.max(2.5, S / 200);
    g.fillStyle = 'rgba(88,84,76,0.65)';                   // control joints
    g.fillRect(0, 0, S, j); g.fillRect(0, 0, j, S);
    g.fillStyle = 'rgba(180,175,164,0.4)';
    g.fillRect(0, j, S, 1.5); g.fillRect(j, 0, 1.5, S);
    for (let i = 0; i < 4; i++) {                          // form ties
      for (let k = 0; k < 4; k++) {
        const x = (i + 0.5) * (S / 4), y = (k + 0.5) * (S / 4);
        g.fillStyle = 'rgba(120,115,105,0.5)';
        g.beginPath(); g.arc(x, y, 2.6, 0, TAU); g.fill();
      }
    }
    for (let i = 0; i < 5; i++) {                          // streaking below joints
      const x = rand() * S;
      g.fillStyle = `rgba(110,105,96,${0.05 + rand() * 0.08})`;
      g.fillRect(x, 0, 8 + rand() * 26, S);
    }
    speckle(g, S, 3500, rand, (r, o) => {
      o[0] = 180 + r * 60; o[1] = 176 + r * 56; o[2] = 164 + r * 52; o[3] = 0.06 + r * 0.14;
    }, 1.4);
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.44, 0.56), 0.8);
    for (let i = 0; i < 22; i++) {
      const y = (i / 22) * S, v = 140 + rand() * 26;
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.fillRect(0, y, S, S / 22);
    }
    const j = Math.max(2.5, S / 200);
    g.fillStyle = '#1e1e1e';
    g.fillRect(0, 0, S, j); g.fillRect(0, 0, j, S);
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 4; k++) {
        g.fillStyle = 'rgba(40,40,40,0.8)';
        g.beginPath(); g.arc((i + 0.5) * (S / 4), (k + 0.5) * (S / 4), 2.6, 0, TAU); g.fill();
      }
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#e4e4e4'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.8, 1.0), 0.5);
  },
};

// Terracotta rainscreen: 30 cm clay planks with open shadow joints. Reads very
// differently from brick at range because the joints are dark, not pale.
const terracottaSurface = {
  uvTile: 3, normalStrength: 2.2,
  paintAlbedo(g, S, rand) {
    const rows = 10, rh = S / rows, gap = Math.max(2.5, S / 170);
    g.fillStyle = '#3f3833'; g.fillRect(0, 0, S, S);      // shadow behind the joint
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      const h = 24 + (rand() - 0.5) * 8, l = 74 + (rand() - 0.5) * 10;
      const grd = g.createLinearGradient(0, y, 0, y + rh - gap);
      grd.addColorStop(0, hsl(h, 11, l + 5));
      grd.addColorStop(0.75, hsl(h, 10, l));
      grd.addColorStop(1, hsl(h, 9, l - 9));
      g.fillStyle = grd;
      g.fillRect(0, y, S, rh - gap);
      g.fillStyle = `rgba(255,248,240,${0.10 + rand() * 0.08})`;   // top arris
      g.fillRect(0, y, S, 2);
    }
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.7, 1.0), 0.35, 'multiply');
    speckle(g, S, 3200, rand, (r, o) => {
      o[0] = 200 + r * 46; o[1] = 164 + r * 44; o[2] = 132 + r * 40; o[3] = 0.06 + r * 0.16;
    }, 1.4);
    for (let i = 0; i < 6; i++) {                          // vertical panel breaks
      const x = Math.floor(rand() * 6) * (S / 6);
      g.fillStyle = 'rgba(58,42,32,0.55)';
      g.fillRect(x, 0, gap * 0.8, S);
    }
  },
  paintHeight(g, S, rand) {
    const rows = 10, rh = S / rows, gap = Math.max(2.5, S / 170);
    g.fillStyle = '#242424'; g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      const grd = g.createLinearGradient(0, y, 0, y + rh - gap);
      grd.addColorStop(0, '#d8d8d8'); grd.addColorStop(0.8, '#c4c4c4'); grd.addColorStop(1, '#7a7a7a');
      g.fillStyle = grd; g.fillRect(0, y, S, rh - gap);
    }
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(rand() * 6) * (S / 6);
      g.fillStyle = '#2a2a2a'; g.fillRect(x, 0, gap * 0.8, S);
    }
    drawField(g, S, 96, fbm(96, 12, 2, rand), greyField(0.46, 0.54), 0.4);
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#d6d6d6'; g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.72, 1.0), 0.5);
  },
};

// Painted CMU: the default Florida commercial wall. 40 x 20 cm units, 2.4 m tile.
const blockSurface = {
  uvTile: 2.4, normalStrength: 2.0,
  paintAlbedo(g, S, rand) {
    const cols = 6, rows = 12, bw = S / cols, bh = S / rows, m = Math.max(2, S / 200);
    g.fillStyle = '#d9d5cb'; g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw * 0.5;
      for (let c = -1; c < cols; c++) {
        const x = c * bw + off, y = r * bh;
        const l = 88 + (rand() - 0.5) * 8;
        g.fillStyle = hsl(40, 6, Math.max(70, Math.min(96, l)));
        for (const dx of x < 0 ? [0, S] : x + bw > S ? [0, -S] : [0]) {
          g.fillRect(x + dx + m / 2, y + m / 2, bw - m, bh - m);
        }
      }
    }
    // Paint sits ON the block, so grain crosses the joints instead of stopping.
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.74, 1.0), 0.42, 'multiply');
    speckle(g, S, 5000, rand, (r, o) => {
      o[0] = 196 + r * 50; o[1] = 192 + r * 48; o[2] = 182 + r * 46; o[3] = 0.05 + r * 0.14;
    }, 1.8);
    for (let i = 0; i < 4; i++) {
      const x = rand() * S;
      g.fillStyle = `rgba(150,144,130,${0.05 + rand() * 0.09})`;
      g.fillRect(x, 0, 10 + rand() * 26, S);
    }
  },
  paintHeight(g, S, rand) {
    const cols = 6, rows = 12, bw = S / cols, bh = S / rows, m = Math.max(2, S / 200);
    g.fillStyle = '#3c3c3c'; g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw * 0.5;
      for (let c = -1; c < cols; c++) {
        const x = c * bw + off, y = r * bh, v = 200 + rand() * 40;
        g.fillStyle = `rgb(${v},${v},${v})`;
        for (const dx of x < 0 ? [0, S] : x + bw > S ? [0, -S] : [0]) {
          g.fillRect(x + dx + m / 2, y + m / 2, bw - m, bh - m);
        }
      }
    }
    drawField(g, S, 64, fbm(64, 8, 2, rand), greyField(0.44, 0.56), 0.6);
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#dcdcdc'; g.fillRect(0, 0, S, S);      // semi-gloss masonry paint
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.78, 1.0), 0.5);
  },
};

// Single-ply membrane roof: heat-welded 1.5 m laps, ponding rings, and the dirt
// that always collects around a rooftop unit.
const membraneSurface = {
  uvTile: 0.75, normalStrength: 0.8,
  paintAlbedo(g, S, rand) {
    g.fillStyle = '#dcdcd4'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.72, 1.0), 0.5, 'multiply');
    for (const y of [0, S / 2]) {                          // welded laps
      g.fillStyle = 'rgba(168,168,158,0.55)'; g.fillRect(0, y, S, 4);
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, y + 4, S, 2);
    }
    for (let i = 0; i < 6; i++) {                          // ponding stains
      const x = rand() * S, y = rand() * S, r = 22 + rand() * 60;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, `rgba(120,124,110,${0.18 + rand() * 0.16})`);
        grd.addColorStop(0.8, 'rgba(120,124,110,0.05)');
        grd.addColorStop(1, 'rgba(120,124,110,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
    speckle(g, S, 2600, rand, (r, o) => {
      o[0] = 140 + r * 60; o[1] = 140 + r * 58; o[2] = 130 + r * 56; o[3] = 0.06 + r * 0.16;
    }, 1.6);
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.45, 0.55), 0.8);
    for (const y of [0, S / 2]) { g.fillStyle = '#c8c8c8'; g.fillRect(0, y, S, 5); }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, S, S);       // 0.70 chalked membrane
    for (let i = 0; i < 6; i++) {                          // ponded water is smooth
      const x = rand() * S, y = rand() * S, r = 22 + rand() * 60;
      wrapped(g, S, x, y, r, (c) => {
        const grd = c.createRadialGradient(0, 0, 0, 0, 0, r);
        grd.addColorStop(0, 'rgba(80,80,80,0.7)');
        grd.addColorStop(1, 'rgba(80,80,80,0)');
        c.fillStyle = grd; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
      });
    }
  },
};

// Barrel tile: 15 pans across a 3 m repeat, staggered courses, lichen in the valleys.
const roofTileSurface = {
  uvTile: 0.75, normalStrength: 2.0,
  paintAlbedo(g, S, rand) {
    const cols = 15, rows = 7, cw = S / cols, rh = S / rows;
    g.fillStyle = '#8f827a'; g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw, y = r * rh;
        const h = 20 + (rand() - 0.5) * 12, l = 60 + (rand() - 0.5) * 12;
        const grd = g.createLinearGradient(x, 0, x + cw, 0);
        grd.addColorStop(0, hsl(h, 12, l - 16));
        grd.addColorStop(0.35, hsl(h, 15, l + 12));
        grd.addColorStop(0.75, hsl(h, 14, l));
        grd.addColorStop(1, hsl(h, 11, l - 22));
        g.fillStyle = grd;
        g.fillRect(x, y, cw, rh);
        g.fillStyle = 'rgba(44,36,30,0.45)';               // course shadow line
        g.fillRect(x, y, cw, Math.max(2, rh * 0.07));
      }
    }
    for (let i = 0; i < 26; i++) {                         // lichen
      const x = rand() * S, y = rand() * S, r = 3 + rand() * 12;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = `rgba(${168 + rand() * 40},${172 + rand() * 34},${146 + rand() * 34},${0.15 + rand() * 0.24})`;
        c.beginPath(); c.ellipse(0, 0, r, r * 0.7, rand() * TAU, 0, TAU); c.fill();
      });
    }
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.72, 1.0), 0.3, 'multiply');
  },
  paintHeight(g, S, rand) {
    const cols = 15, rows = 7, cw = S / cols, rh = S / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw, y = r * rh;
        const grd = g.createLinearGradient(x, 0, x + cw, 0);
        grd.addColorStop(0, '#303030');
        grd.addColorStop(0.4, '#ececec');
        grd.addColorStop(0.8, '#a0a0a0');
        grd.addColorStop(1, '#303030');
        g.fillStyle = grd; g.fillRect(x, y, cw, rh);
        g.fillStyle = '#141414'; g.fillRect(x, y, cw, Math.max(2, rh * 0.09));
      }
    }
    drawField(g, S, 96, fbm(96, 12, 2, rand), greyField(0.46, 0.54), 0.4);
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#d2d2d2'; g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.74, 1.0), 0.6);
  },
};

const gravelRoofSurface = {
  uvTile: 0.75, normalStrength: 1.6,
  paintAlbedo(g, S, rand) {
    g.fillStyle = '#5c574d'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.5, 1.0), 0.4, 'overlay');
    for (let b = 0; b < 18; b++) {                         // ballast, one fill per tone
      const t = (b + 0.5) / 18, v = 96 + t * 96, warm = ((b * 5) % 22);
      g.fillStyle = `rgba(${v + warm},${v + warm * 0.6},${v * 0.92},${0.55 + t * 0.4})`;
      g.beginPath();
      for (let i = 0; i < 190; i++) {
        arcWrapped(g, S, rand() * S, rand() * S, 1.6 + rand() * 3.6);
      }
      g.fill();
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#4a4a4a'; g.fillRect(0, 0, S, S);
    for (let b = 0; b < 18; b++) {
      const v = 150 + ((b + 0.5) / 18) * 100;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.beginPath();
      for (let i = 0; i < 190; i++) {
        arcWrapped(g, S, rand() * S, rand() * S, 1.6 + rand() * 3.6);
      }
      g.fill();
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.86, 1.0), 0.5);
  },
};

// Order is the texture-array layer order and is part of the public contract:
// a merged chunk geometry writes these indices into its `aLayer` attribute.
export const __BENCH = { SURFACE_SET: () => SURFACE_SET, drawField, fbm, mulberry32, makeCanvas, arcWrapped, speckle, greyField };

export const SURFACE_LAYERS = [
  'stucco', 'brick', 'panel', 'terracotta', 'block',
  'roofMembrane', 'roofTile', 'roofGravel',
];

const SURFACE_SET = {
  stucco: stuccoSurface, brick: brickSurface, panel: panelSurface,
  terracotta: terracottaSurface, block: blockSurface,
  roofMembrane: membraneSurface, roofTile: roofTileSurface, roofGravel: gravelRoofSurface,
};

// Sun-bleached Gulf-coast palette. The base albedos are near-neutral so the tint
// is the only thing that changes between variants — N colours cost N materials
// and zero extra texture memory.
export const SURFACE_TINTS = {
  stucco: {
    shell: 0xf1ece0, cream: 0xefe2c4, peach: 0xf2cdb2, mint: 0xd2e2d6,
    sky: 0xcfdde8, coral: 0xefb7a4,
  },
  brick: { red: 0xa8563c, whitewash: 0xe9e5dc, ochre: 0xc9a15c, teal: 0x7ba39c },
  panel: { grey: 0xcac7c0, warm: 0xd9d0c0, sandstone: 0xd6bf9c },
  terracotta: { clay: 0xd08a58, bleached: 0xe0b48c },
  block: { white: 0xeeece4, seafoam: 0xc3ded2, buff: 0xe3d6ba, flamingo: 0xefc3c0 },
  roofMembrane: { white: 0xe8e8e0, grey: 0xa9aaa4 },
  roofTile: { clay: 0xd8a483, bleached: 0xe6c3a4 },
  roofGravel: { grey: 0xd6d2c8 },
};

// ---------------------------------------------------------------- markings
// Lane paint cannot be a mesh per stripe: the streamer merges every road edge in
// a chunk into ONE geometry, so a stripe would be a draw call per edge. The
// paint therefore rides in the road's own shader, addressed by the ribbon's uv.
//
// MARKINGS names the profile an edge asks for. It is still an atlas COLUMN
// index, because the columns below remain the reference drawing of each profile
// and the material lab renders them — but the district itself no longer samples
// the atlas: applyRoadMarkings draws the same profiles arithmetically, which is
// the only way to place a crosswalk a fixed number of metres back from a
// junction. See "road coding" below for what the uv channels carry, and
// paintMarkingAtlas (lazy — see MaterialRegistry.get) for the reference art.
export const MARKINGS = {
  none: 0,          // clear: alleys, service roads, junction interiors
  lane2: 1,         // two-way, broken yellow centre
  lane2solid: 2,    // two-way, double yellow (no passing)
  lane4: 3,         // four lanes, double yellow centre, broken white divides
  crosswalk: 4,     // continental bars, addressed across the full carriageway
  stopbar: 5,       // one transverse bar per column height
  arrowThrough: 6,  // single LANE width, not carriageway width
  arrowTurn: 7,     // left turn; mirror with flipU for a right turn
};
const MARKING_COLUMNS = 8;
const MARKING_COL_PX = 256;
const MARKING_H_PX = 256;      // one column height == 8 m of road
const MARKING_GUARD = 5 / MARKING_COL_PX;  // transparent margin so mips bleed nothing

const WHITE = 'rgba(240,238,228,';
const YELLOW = 'rgba(232,186,58,';

function paintMarkingAtlas(rand) {
  const W = MARKING_COLUMNS * MARKING_COL_PX, H = MARKING_H_PX;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, W, H);

  // Paint is never crisp on a real street: scrub it with the wear mask so the
  // markings read as maintained-in-2009 rather than decal-stamped.
  const wear = (x0, w) => {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (let b = 0; b < 8; b++) {
      g.fillStyle = `rgba(0,0,0,${0.15 + (b / 8) * 0.5})`;
      for (let i = 0; i < 90; i++) {
        const r = 1 + rand() * 4;
        g.fillRect(x0 + rand() * w, rand() * H, r, r * (0.6 + rand()));
      }
    }
    g.restore();
  };
  const col = (i) => i * MARKING_COL_PX;

  // Wheel polish and kerbside grime: dark, wide, low alpha. They ride in the
  // marking layer because they vary ACROSS the road, which is exactly what the
  // column addresses — a tiling asphalt texture cannot express them.
  const carriageway = (x0, lanes) => {
    g.fillStyle = 'rgba(28,28,30,0.20)';
    g.fillRect(x0 + 5, 0, 12, H); g.fillRect(x0 + MARKING_COL_PX - 17, 0, 12, H);
    const lw = MARKING_COL_PX / lanes;
    for (let l = 0; l < lanes; l++) {
      for (const t of [0.3, 0.7]) {
        const x = x0 + (l + t) * lw;
        const grd = g.createLinearGradient(x - 11, 0, x + 11, 0);
        grd.addColorStop(0, 'rgba(24,24,26,0)');
        grd.addColorStop(0.5, 'rgba(24,24,26,0.16)');
        grd.addColorStop(1, 'rgba(24,24,26,0)');
        g.fillStyle = grd; g.fillRect(x - 11, 0, 22, H);
      }
    }
  };
  const edgeLines = (x0, w) => {
    g.fillStyle = WHITE + '0.85)';
    g.fillRect(x0 + 8, 0, w, H);
    g.fillRect(x0 + MARKING_COL_PX - 8 - w, 0, w, H);
  };
  const dashes = (x, w, style, onPx, offPx, phase = 0) => {
    g.fillStyle = style;
    for (let y = -phase; y < H; y += onPx + offPx) g.fillRect(x, y, w, onPx);
  };

  // 0: clear.
  // 1: two-way, broken yellow centre. 3 m stripe / 5 m gap over the 8 m column.
  {
    const x0 = col(1);
    carriageway(x0, 2);
    edgeLines(x0, 5);
    dashes(x0 + MARKING_COL_PX / 2 - 2.5, 5, YELLOW + '0.8)', H * 0.375, H * 0.625);
    wear(x0, MARKING_COL_PX);
  }
  // 2: two-way, double yellow.
  {
    const x0 = col(2);
    carriageway(x0, 2);
    edgeLines(x0, 5);
    g.fillStyle = YELLOW + '0.8)';
    g.fillRect(x0 + MARKING_COL_PX / 2 - 8, 0, 5, H);
    g.fillRect(x0 + MARKING_COL_PX / 2 + 3, 0, 5, H);
    wear(x0, MARKING_COL_PX);
  }
  // 3: four lanes. Thinner paint because the same column now covers ~13 m.
  {
    const x0 = col(3);
    carriageway(x0, 4);
    edgeLines(x0, 3.5);
    g.fillStyle = YELLOW + '0.78)';
    g.fillRect(x0 + MARKING_COL_PX / 2 - 6, 0, 3.5, H);
    g.fillRect(x0 + MARKING_COL_PX / 2 + 2.5, 0, 3.5, H);
    dashes(x0 + MARKING_COL_PX * 0.25 - 1.75, 3.5, WHITE + '0.72)', H * 0.375, H * 0.625);
    dashes(x0 + MARKING_COL_PX * 0.75 - 1.75, 3.5, WHITE + '0.72)', H * 0.375, H * 0.625);
    wear(x0, MARKING_COL_PX);
  }
  // 4: continental crosswalk. Bars run WITH traffic, so they tile up the column.
  {
    const x0 = col(4);
    g.fillStyle = WHITE + '0.86)';
    for (let i = 0; i < 8; i++) g.fillRect(x0 + 7 + i * 30, 0, 17, H);
    wear(x0, MARKING_COL_PX);
  }
  // 5: stop bar. One bar per column, so the caller scales v to the segment.
  {
    const x0 = col(5);
    g.fillStyle = WHITE + '0.86)';
    g.fillRect(x0 + 8, H * 0.10, MARKING_COL_PX - 16, H * 0.09);
    wear(x0, MARKING_COL_PX);
  }
  // 6 / 7: lane arrows. The column is ONE lane wide here, not the carriageway.
  const arrow = (x0, turn) => {
    const cx = x0 + MARKING_COL_PX / 2;
    g.fillStyle = WHITE + '0.88)';
    g.beginPath();
    if (!turn) {
      g.moveTo(cx, H * 0.20);
      g.lineTo(cx + 30, H * 0.40); g.lineTo(cx + 12, H * 0.40);
      g.lineTo(cx + 12, H * 0.80); g.lineTo(cx - 12, H * 0.80);
      g.lineTo(cx - 12, H * 0.40); g.lineTo(cx - 30, H * 0.40);
    } else {
      g.moveTo(cx - 58, H * 0.30);
      g.lineTo(cx - 24, H * 0.14); g.lineTo(cx - 24, H * 0.24);
      g.lineTo(cx + 12, H * 0.24); g.lineTo(cx + 12, H * 0.80);
      g.lineTo(cx - 12, H * 0.80); g.lineTo(cx - 12, H * 0.40);
      g.lineTo(cx - 24, H * 0.40); g.lineTo(cx - 24, H * 0.46);
    }
    g.closePath(); g.fill();
    wear(x0, MARKING_COL_PX);
  };
  arrow(col(6), false);
  arrow(col(7), true);
  return c;
}

// ---------------------------------------------------------------- road coding
// What a road actually needs painted on it is not a function of the ribbon's UV
// alone. A crosswalk sits a fixed number of METRES back from the junction, a
// stop bar sits behind that, a lane line is 10 cm wide whatever the carriageway
// is, and the wheel tracks are 1.6 m apart in a lane, not in a fraction of one.
// So the shader needs three numbers the ribbon does not carry: the road's width
// in metres, its LENGTH in metres, and whether it is one-way.
//
// The streamer is not editable from here and passes exactly one integer and one
// uv array per edge, so those three numbers ride in the two channels that are
// already there:
//
//   u = code + columnU     code   = round(width) + 16 * oneway   (integer part)
//                          columnU = the marking column, still 0..1
//   v = 64 * lenMetres + s/8  s = metres from the ribbon start, and s/8 < 64 for
//                          any edge shorter than 512 m, so floor(v/64) recovers
//                          the length and the remainder recovers s
//
// Both survive linear interpolation because the added terms are constant over an
// edge, and 64 * lenMetres is an INTEGER, so fract(v) - which is all a
// wrapT-repeating atlas ever sees - is untouched. The magnitudes decide the
// precision, which is why the two codes are NOT packed into one channel: u peaks
// at 31.99 and stays exact to a fraction of a millimetre across the road, while
// v peaks near 27000 on the district's longest edge and still resolves 1.6 cm
// along it. Paint is 10 cm wide and 3 m long, so both have margin.
const MARK_COLUMN_MASK = 7;
const MARK_WIDTH_SHIFT = 3;     // round(metres), 0..15
const MARK_ONEWAY_BIT = 1 << 7;
const MARK_LEN_STRIDE = 64;     // v decoder: lengthMetres = floor(v / 64)
const MARK_LEN_MAX = 511;       // ...and an edge longer than this is clamped

/**
 * Rewrite a slice of a merged road ribbon's UV array so those vertices sample one
 * marking column. Operates in place on the flat [u,v,u,v,...] array that
 * geom.js `ribbon` fills, so a chunk builder records the vertex range each edge
 * contributed and calls this once per edge — no extra geometry, no extra material.
 *
 * The ribbon's own v is metres/8 measured from the start of the edge, so the
 * largest v in the slice IS the edge's length: it is read out here rather than
 * asked of the caller.
 *
 * @param {number[]|Float32Array} uv  the merged uv array
 * @param {number} vertexStart        first vertex index this edge wrote
 * @param {number} vertexCount        how many vertices it wrote
 * @param {number} marking            a MARKINGS value, or markingForEdge()'s code
 * @param {object} [opts]
 * @param {number} [opts.vRepeat=1]   multiply v; ribbon v is already metres/8, so
 *                                    1 puts one 8 m marking period on 8 m of road
 * @param {number} [opts.vOffset=0]   added after vRepeat, to phase dashes
 * @param {boolean} [opts.flipU]      mirror the profile (right-turn arrow)
 */
export function applyMarkingUV(uv, vertexStart, vertexCount, marking, opts = {}) {
  const { vRepeat = 1, vOffset = 0, flipU = false } = opts;
  const column = marking & MARK_COLUMN_MASK;
  const widthCode = (marking >> MARK_WIDTH_SHIFT) & 15;
  const oneWay = marking & MARK_ONEWAY_BIT ? 16 : 0;
  const span = 1 / MARKING_COLUMNS;
  const lo = (column + MARKING_GUARD) * span;
  const width = span * (1 - 2 * MARKING_GUARD);
  const end = vertexStart + vertexCount;

  let longest = 0;
  for (let i = vertexStart; i < end; i++) {
    const v = uv[i * 2 + 1] * vRepeat + vOffset;
    if (v > longest) longest = v;
  }
  const lenCode = Math.min(MARK_LEN_MAX, Math.round(longest * 8));   // ribbon v is metres/8
  const uCode = widthCode + oneWay;
  const vCode = lenCode * MARK_LEN_STRIDE;

  for (let i = vertexStart; i < end; i++) {
    const p = i * 2;
    const u = flipU ? 1 - uv[p] : uv[p];
    uv[p] = uCode + lo + u * width;
    uv[p + 1] = uv[p + 1] * vRepeat + vOffset + vCode;
  }
}

/**
 * Pick a marking profile for a baked road edge, and pack the road's width and
 * one-way flag in alongside it. Keeps the choice in one place so the streamer
 * and the traffic system agree about what a road looks like.
 *
 * The return value is still a MARKINGS value in its low three bits, so anything
 * that only wants the column can mask it; applyMarkingUV reads the rest.
 * @param {{w:number,lanes:number,o:number,c:string}} edge
 */
export function markingForEdge(edge) {
  const code = (Math.max(0, Math.min(15, Math.round(edge.w))) << MARK_WIDTH_SHIFT)
    | (edge.o !== 0 ? MARK_ONEWAY_BIT : 0);
  // Alleys and service roads carry no paint, but they still carry the width so
  // the shader can put wheel tracks down them.
  if (edge.c === 'service' || edge.w < 5) return MARKINGS.none | (code & ~MARK_ONEWAY_BIT);
  if (edge.lanes >= 4 || edge.w >= 12) return MARKINGS.lane4 | code;
  // A one-way street has no centre line but it does have edge lines, lane
  // divides and arrows: it was previously drawn blank, which is a third of the
  // district's marked carriageway with nothing on it at all.
  if (edge.o !== 0) return MARKINGS.lane2 | code;
  return (edge.c === 'primary' || edge.c === 'secondary'
    ? MARKINGS.lane2solid : MARKINGS.lane2) | code;
}

/**
 * Pick a wall family + tint for a baked building. Deterministic in the building
 * index so a block does not reshuffle its colours when a chunk reloads.
 * @param {{z?:string,k?:string,h:number,a:number}} b
 * @param {number} index
 */
export function wallFamilyFor(b, index) {
  const r = mulberry32(index * 2654435761 + 17);
  const roll = r();
  let family;
  if (b.h > 26) family = roll < 0.55 ? 'panel' : 'terracotta';
  else if (b.k === 'house' || b.z === 'residential') family = roll < 0.62 ? 'stucco' : roll < 0.85 ? 'block' : 'brick';
  else if (b.z === 'commercial') family = roll < 0.4 ? 'stucco' : roll < 0.66 ? 'block' : roll < 0.88 ? 'brick' : 'panel';
  else family = roll < 0.5 ? 'block' : 'stucco';
  const names = Object.keys(SURFACE_TINTS[family]);
  return { family, tint: names[Math.floor(r() * names.length) % names.length] };
}

/**
 * The tint for a family/name pair as three floats, in the sRGB convention that
 * `buildingMerged` expects in its `color` vertex attribute.
 */
export function surfaceTintRGB(family, tint) {
  const tints = SURFACE_TINTS[family];
  const hex = tints[tint] ?? Object.values(tints)[0];
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Roof kind for a baked building, on the same deterministic seed. */
export function roofFor(b, index) {
  const r = mulberry32(index * 40503 + 991);
  const roll = r();
  if (b.h > 20) return { family: 'roofGravel', tint: 'grey' };
  if ((b.k === 'house' || b.z === 'residential') && roll < 0.55) {
    return { family: 'roofTile', tint: roll < 0.35 ? 'clay' : 'bleached' };
  }
  return { family: 'roofMembrane', tint: roll < 0.7 ? 'white' : 'grey' };
}

// ---------------------------------------------------------------- shader patches
// Patches are additive: each one appends a tag so the program cache key stays
// exact, and chains onto whatever onBeforeCompile is already installed.
//
// Additive, but not REPEATABLE. Every patch below injects a declaration at
// `#include <common>` - a uniform, or in applyGlazingEnv's case a whole
// `float geHash( vec2 )` - and GLSL has no tolerance for a second one. Applying
// the same patch twice to one material therefore does not layer, it fails to
// compile, and the symptom is a black material behind a wall of driver log.
//
// It is not reachable today: facadeMaterial is memoised, the registry hands out
// one instance per key and calls each patch on it once, and materials are never
// cloned (see the note at _groundMaterial - clone() drops onBeforeCompile
// anyway). The tags array was already here for the cache key, so the guard is
// free. It warns rather than returning quietly, because the second call was
// asking for something - most likely different parameters - and it is not going
// to get it.
function patch(material, tag, fn) {
  const tags = material.userData.veranoTags || (material.userData.veranoTags = []);
  if (tags.includes(tag)) {
    console.warn(`materials: '${tag}' is already applied to ${material.name || material.type}`
      + ` [${tags.join('|')}]; ignoring the repeat, which would not have compiled`);
    return material;
  }
  tags.push(tag);
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    fn(shader, renderer);
  };
  material.customProgramCacheKey = () => tags.join('|');
  return material;
}

// Horizontal surfaces derive UV from world XZ instead of the mesh's own UVs.
// See the header: the streamer's ribbon UVs are unusable as texture coordinates,
// and world-planar also makes texture detail continuous across chunk seams.
function applyPlanarUV(material, uvPerMetre) {
  const u = { value: uvPerMetre };
  material.userData.planarScale = u;
  return patch(material, 'planarUV', (shader) => {
    shader.uniforms.uPlanarScale = u;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uPlanarScale;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  vec3 veranoWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vec3 veranoAxis = abs( normalize( mat3( modelMatrix ) * objectNormal ) );
  vec2 veranoPlanarUv = ( veranoAxis.y >= max( veranoAxis.x, veranoAxis.z ) )
    ? veranoWorldPos.xz
    : ( veranoAxis.x > veranoAxis.z
        ? vec2( veranoWorldPos.z, - veranoWorldPos.y )
        : vec2( veranoWorldPos.x, - veranoWorldPos.y ) );
  veranoPlanarUv *= uPlanarScale;
  #ifdef USE_MAP
    vMapUv = veranoPlanarUv;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = veranoPlanarUv;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = veranoPlanarUv;
  #endif`);
  });
}

// The road surface, composited into the road's own shader instead of a second
// transparent mesh. The asphalt comes from the world-planar UV, everything a
// street has ON it comes from the coded mesh UV, so roads stay ONE opaque draw
// call per chunk with no sorting, no depth-write games and no polygon offset.
//
// This used to sample a marking ATLAS: a column per road profile, addressed by
// the ribbon's u. That can express a centre line and an edge line and nothing
// else, because everything a junction needs — crosswalk, stop bar, arrows — is
// positioned in METRES BACK FROM THE JUNCTION, and an atlas column has no idea
// where along the road it is. Three critic rounds in a row reported exactly that
// absence at exactly the hero frames, which are junction views.
//
// Drawing the profile arithmetically instead fixes three things at once:
//   * the junction furniture becomes expressible at all, off the decoded
//     distance-to-the-end-of-the-edge;
//   * a 10 cm line is 10 cm on a 6 m street and on a 13 m arterial, instead of
//     1.6% of whatever the carriageway happens to be;
//   * it is resolution-free — fwidth() antialiasing keeps a dash crisp at the
//     kerb and quiet at 200 m, where a 256 px column aliases into a dotted mess.
//
// Cost is arithmetic, not memory: no texture is fetched for any of it.
function applyRoadMarkings(material, tileMetres) {
  const K = {
    tile: tileMetres.toFixed(3),
    cols: MARKING_COLUMNS.toFixed(1),
    guard: MARKING_GUARD.toFixed(6),
    across: (1 / (1 - 2 * MARKING_GUARD)).toFixed(6),
    stride: MARK_LEN_STRIDE.toFixed(1),
  };
  return patch(material, 'roadSurface', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMeshUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMeshUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vMeshUv;

// Everything the road surface contributes, in one place so the roughness stage
// downstream can read the same numbers the albedo stage used.
float pvPaint;          // paint coverage 0..1
vec3  pvPaintCol;       // linear-space paint colour
float pvIron;           // manhole / gully coverage
vec3  pvIronCol;
float pvPolish;         // tyre-polish wheel path
float pvOil;            // oil drip down the lane centre
float pvGrime;          // kerbside grime
float pvPatch;          // asphalt patch
float pvSeal;           // poured crack-sealing band
float pvPale;           // dust the wheels never sweep
float pvMacro;          // de-tiling tone multiplier

// map_fragment has already decoded the albedo to linear, so the paint has to be
// linear too. sRGB 240,238,228 and 232,186,58 — the same two the atlas used.
const vec3 PV_WHITE  = vec3( 0.871, 0.855, 0.776 );
const vec3 PV_YELLOW = vec3( 0.807, 0.491, 0.042 );

float pvHash( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453 ); }
float pvHash2( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float pvNoise( float x ) {
  float i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( pvHash( i ), pvHash( i + 1.0 ), f );
}
float pvNoise2( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( pvHash2( i ), pvHash2( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( pvHash2( i + vec2( 0.0, 1.0 ) ), pvHash2( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// An antialiased slab |p - c| <= h, measured in p's own units.
float pvSlab( float p, float c, float h, float fw ) {
  return 1.0 - smoothstep( -fw, fw, abs( p - c ) - h );
}

void pvRoadSurface( float lum, vec2 worldXZ ) {
  pvPaint = 0.0; pvPaintCol = PV_WHITE; pvIron = 0.0; pvIronCol = vec3( 0.05 );
  pvPolish = 0.0; pvOil = 0.0; pvGrime = 0.0; pvPatch = 0.0; pvSeal = 0.0; pvPale = 0.0;

  // De-tiling. The asphalt map repeats every 3 m and from above the eye finds
  // that instantly; a two-octave tonal wander at 26 m and 8 m breaks the motif
  // without touching the crack network a critic called the best surface here.
  pvMacro = 0.82 + 0.36 * ( pvNoise2( worldXZ * 0.038 ) * 0.65
                          + pvNoise2( worldXZ * 0.128 + 11.0 ) * 0.35 );

  // ---- decode (see "road coding" in materials.js) --------------------------
  float code = floor( vMeshUv.x );
  float oneWay = step( 16.0, code );
  float roadW = code - oneWay * 16.0;
  if ( roadW < 2.0 ) roadW = 6.6;            // uncoded caller: assume a street
  float colU = vMeshUv.x - code;
  float column = floor( colU * ${K.cols} );
  float across = clamp( ( colU - ( column + ${K.guard} ) / ${K.cols} ) * ${K.cols} * ${K.across}, 0.0, 1.0 );
  float lenM = floor( vMeshUv.y / ${K.stride} );
  float s = ( vMeshUv.y - lenM * ${K.stride} ) * 8.0;   // metres from the edge start

  float halfW = roadW * 0.5;
  float x = ( across - 0.5 ) * roadW;        // metres right of the centreline
  float fwx = fwidth( x ) + 1e-4;
  float fws = fwidth( s ) + 1e-4;
  float fwr = max( fwx, fws );

  // ---- explicit feature quads (columns 4-7) --------------------------------
  // A caller can also PLACE a marking: put down a quad, hand it one of the
  // feature columns, and get u across the quad and v along it. The district
  // does not use this - it gets the same shapes from the junction arithmetic
  // below, which knows where the junction actually is - but the material lab
  // does, and so would anything that wants a crosswalk somewhere the road graph
  // cannot describe. Drawn here rather than sampled from the atlas so the atlas
  // can stay unbuilt.
  if ( column >= 4.0 ) {
    float fl = clamp( s * 0.125, 0.0, 1.0 );          // 0..1 along the quad
    float fa = across;                                // 0..1 across it
    float fwa = fwidth( fa ) + 1e-4, fwl = fwidth( fl ) + 1e-4;
    float cov;
    if ( column < 5.0 ) {                             // continental crosswalk
      cov = pvSlab( fract( fa * 8.0 ), 0.5, 0.30, fwa * 8.0 );
    } else if ( column < 6.0 ) {                      // stop bar
      cov = pvSlab( fl, 0.15, 0.05, fwl ) * pvSlab( fa, 0.5, 0.47, fwa );
    } else {
      // Arrow, in a quad ONE lane wide. t runs from the tip backwards.
      float t = ( 1.0 - fl ) * 4.6, xl = ( fa - 0.5 ) * 3.3;
      float fx2 = fwa * 3.3, fl2 = fwl * 4.6;
      if ( column < 7.0 ) {
        float head = 0.62 * clamp( ( t - 0.10 ) / 1.15, 0.0, 1.0 ) * ( 1.0 - step( 1.30, t ) );
        float shaft = 0.085 * step( 1.20, t ) * ( 1.0 - step( 4.30, t ) );
        float aw = max( head, shaft );
        cov = pvSlab( xl, 0.0, aw, fx2 ) * step( 0.03, aw );
      } else {                                        // left turn: shaft, hook, head
        float hh = 0.30 * clamp( ( 1.24 + xl ) / 0.46, 0.0, 1.0 ) * step( 0.78, -xl );
        cov = max( pvSlab( t, 3.10, 1.20, fl2 ) * pvSlab( xl, 0.0, 0.085, fx2 ),
              max( pvSlab( t, 1.90, 0.085, fl2 ) * pvSlab( xl, -0.39, 0.39, fx2 ),
                   pvSlab( t, 1.90, hh, fl2 ) * step( 0.02, hh ) ) );
      }
    }
    float qWear = 0.45 + 0.55 * smoothstep( 0.16, 0.74,
      pvNoise( s * 2.7 + x * 3.1 ) * 0.6 + pvNoise( x * 0.9 ) * 0.4 );
    pvPaint = clamp( cov * qWear, 0.0, 1.0 );
    return;
  }

  // ---- wear every carriageway carries, painted or not ----------------------
  float lanes = column < 0.5 ? 1.0
    : oneWay > 0.5 ? max( 1.0, floor( roadW / 3.0 ) )
    : ( column >= 3.0 ? 4.0 : 2.0 );
  float lw = roadW / lanes;
  float li = clamp( floor( ( x + halfW ) / lw ), 0.0, lanes - 1.0 );
  float dx = x - ( -halfW + ( li + 0.5 ) * lw );

  // The cross-lane wear profile. Two polished tracks 1.64 m apart, a narrow oil
  // line dripped between them, and PALE strips where no tyre ever runs — between
  // the tracks and outboard of them. Darkening alone was the mistake in the first
  // pass: bands 0.8 m wide with an oil band between them darkened 80% of the
  // carriageway, which is a uniformly darker road, not a banded one. The contrast
  // has to be two-sided to read at all.
  float track = 1.0 - smoothstep( 0.0, 0.30, abs( abs( dx ) - 0.82 ) );
  pvPolish = track * ( 0.62 + 0.38 * pvNoise( s * 0.16 + li * 3.7 ) );
  pvPale = clamp( ( 1.0 - smoothstep( 0.12, 0.50, abs( dx ) ) )
                + 0.75 * smoothstep( 1.28, 1.62, abs( dx ) ), 0.0, 1.0 )
         * ( 0.55 + 0.45 * pvNoise( s * 0.09 + li * 2.3 ) );
  pvOil = ( 1.0 - smoothstep( 0.04, 0.24, abs( dx ) ) )
        * smoothstep( 0.28, 0.86, pvNoise( s * 0.55 + li * 11.0 ) );
  pvGrime = smoothstep( halfW - 1.4, halfW - 0.10, abs( x ) );

  // ---- ironwork and patching ------------------------------------------------
  // Hashed off the metre along the edge, so none of it tiles with the 3 m
  // asphalt map. The seed is the road's own width and length, which is the only
  // per-edge identity the coding carries — without it every 6.6 m street in the
  // district would put its manhole the same distance from its own start.
  float seed = roadW * 3.1 + lenM * 0.73;
  float mCell = floor( s / 26.0 );
  float mOn = step( 0.44, pvHash( mCell * 4.11 + seed ) );
  float mx = ( pvHash( mCell * 2.71 + 5.0 + seed ) - 0.5 ) * max( 0.6, roadW - 2.6 );
  float ms = mCell * 26.0 + 4.0 + pvHash( mCell * 1.37 + seed ) * 18.0;
  float mr = length( vec2( x - mx, s - ms ) );
  float lid = ( 1.0 - smoothstep( 0.33 - fwr, 0.33 + fwr, mr ) ) * mOn;
  float ribs = 0.5 + 0.5 * cos( atan( s - ms, x - mx ) * 14.0 );
  vec3 lidCol = mix( vec3( 0.030, 0.029, 0.027 ), vec3( 0.062, 0.058, 0.052 ), ribs );
  lidCol = mix( lidCol, vec3( 0.085, 0.080, 0.072 ), pvSlab( mr, 0.300, 0.030, fwr ) );

  float gCell = floor( s / 34.0 );
  float gOn = step( 0.42, pvHash( gCell * 5.1 + 4.0 + seed ) );
  float gs = gCell * 34.0 + 7.0 + pvHash( gCell * 3.3 + seed ) * 20.0;
  float gx = ( step( 0.5, pvHash( gCell * 7.7 + 2.0 + seed ) ) * 2.0 - 1.0 ) * ( halfW - 0.30 );
  float grate = pvSlab( s, gs, 0.44, fws ) * pvSlab( x, gx, 0.20, fwx ) * gOn;
  vec3 grateCol = mix( vec3( 0.070, 0.068, 0.062 ), vec3( 0.008 ),
    pvSlab( mod( s - gs + 5.0, 0.16 ), 0.08, 0.045, fws ) );

  pvIron = max( lid, grate );
  pvIronCol = grate > lid ? grateCol : lidCol;

  // A resurfaced trench: darker, coarser, with a tar lip around it.
  float pCell = floor( s / 47.0 );
  float pOn = step( 0.55, pvHash( pCell * 9.13 + 3.0 + seed ) );
  float ps = pCell * 47.0 + 6.0 + pvHash( pCell * 6.6 + seed ) * 30.0;
  float px = ( pvHash( pCell * 1.9 + 7.0 + seed ) - 0.5 ) * max( 0.4, roadW - 2.2 );
  float ph = 1.4 + pvHash( pCell * 2.2 + seed ) * 2.4;
  float pw = 0.8 + pvHash( pCell * 8.4 + seed ) * 1.1;
  float ragged = 0.10 * pvNoise( s * 1.6 + pCell ) + 0.10 * pvNoise( x * 2.4 + pCell * 3.0 );
  pvPatch = pvSlab( s, ps, ph + ragged, fws ) * pvSlab( x, px, pw + ragged, fwx ) * pOn;
  float pLip = ( pvSlab( s, ps, ph + ragged + 0.09, fws ) * pvSlab( x, px, pw + ragged + 0.09, fwx ) * pOn ) - pvPatch;

  // Crack sealing poured across the carriageway, wandering as the crack did.
  float bCell = floor( s / 19.0 );
  float bs = bCell * 19.0 + 3.0 + pvHash( bCell * 2.9 + seed ) * 13.0 + 0.5 * pvNoise( x * 1.1 + bCell );
  pvSeal = pvSlab( s, bs, 0.05 + 0.035 * pvNoise( x * 2.7 + bCell * 5.0 ), fws )
    * step( 0.46, pvHash( bCell * 13.7 + 1.0 + seed ) );

  // The tar lip poured round a patch is as dark as ironwork, so it rides the
  // same channel rather than paying for another mix.
  float lip = clamp( pLip, 0.0, 1.0 ) * 0.85;
  if ( lip > pvIron ) { pvIron = lip; pvIronCol = vec3( 0.014, 0.013, 0.013 ); }

  if ( column < 0.5 ) return;                // alley or service road: no paint

  // ---- longitudinal paint ---------------------------------------------------
  float dash = pvSlab( mod( s, 9.0 ), 1.5, 1.5, fws );        // 3 m on, 6 m off
  float jz = max( 3.5, halfW + 0.9 );                         // junction box reach
  float dEnd = lenM > 1.0 ? min( s, lenM - s ) : 1e4;
  float white = pvSlab( abs( x ), halfW - 0.40, 0.055, fwx ); // 11 cm edge lines
  float yellow = 0.0;

  if ( oneWay < 0.5 ) {
    if ( column >= 2.0 ) {
      yellow = max( pvSlab( x, -0.115, 0.055, fwx ), pvSlab( x, 0.115, 0.055, fwx ) );
    } else {
      // Broken centre line that goes solid on the run-in to a junction, which is
      // what a no-passing zone looks like from a windscreen.
      float solid = 1.0 - smoothstep( jz + 11.0, jz + 19.0, dEnd );
      yellow = pvSlab( x, 0.0, 0.06, fwx ) * max( dash, solid );
    }
  }
  float perDir = oneWay > 0.5 ? lanes : lanes * 0.5;
  if ( perDir > 1.5 ) {
    float b = floor( x / lw + 0.5 ) * lw;
    float keep = ( 1.0 - step( halfW - 0.7, abs( b ) ) )
      * ( oneWay > 0.5 ? 1.0 : step( 0.02, abs( b ) ) );
    white = max( white, pvSlab( x, b, 0.05, fwx ) * dash * keep );
  }

  // ---- junction furniture ---------------------------------------------------
  if ( dEnd < jz + 14.0 ) {
    float far = step( lenM * 0.5, s );
    float side = far * 2.0 - 1.0;                 // the approaching half's sign
    float appr = oneWay > 0.5 ? 1.0 : smoothstep( -fwx, fwx, x * side );
    float live = oneWay > 0.5 ? far : 1.0;        // one-way: only one end stops

    // Continental crosswalk: 50 cm bars, 42 cm gaps, right across the road.
    float cw = pvSlab( dEnd, jz + 1.9, 1.4, fws );
    white = max( white, cw * pvSlab( mod( x + halfW, 0.92 ), 0.46, 0.25, fwx ) );

    // Stop bar 1.1 m behind it, on the approaching half only.
    white = max( white, pvSlab( dEnd, jz + 4.4, 0.22, fws ) * appr * live );

    // A through arrow per approaching lane, where the block is long enough that
    // one fits behind the stop bar.
    if ( lenM > 2.0 * jz + 26.0 ) {
      float t = dEnd - ( jz + 7.2 );
      float xa = x * side;
      float xl = xa - ( floor( xa / lw ) + 0.5 ) * lw;
      float head = 0.62 * clamp( ( t - 0.10 ) / 1.15, 0.0, 1.0 ) * ( 1.0 - step( 1.30, t ) );
      float shaft = 0.085 * step( 1.20, t ) * ( 1.0 - step( 4.30, t ) );
      float aw = max( head, shaft );
      white = max( white, pvSlab( xl, 0.0, aw, fwx ) * step( 0.03, aw ) * appr * live );
    }
  }

  // ---- wear on the paint ----------------------------------------------------
  // Fresh uniform paint is the tell. Real paint thins where the aggregate stands
  // proud of the binder and is scrubbed away where wheels cross it.
  float grain = smoothstep( 0.045, 0.155, lum );
  float wear = 0.40 + 0.60 * smoothstep( 0.16, 0.74,
      pvNoise( s * 0.33 + seed ) * 0.6 + pvNoise( s * 2.7 + x * 3.1 ) * 0.4 );
  wear *= 1.0 - 0.55 * pvPolish;
  wear *= mix( 0.62, 1.0, grain );

  pvPaint = clamp( max( white, yellow ) * wear * ( 1.0 - 0.85 * pvPatch ), 0.0, 1.0 );
  pvPaintCol = yellow > white ? PV_YELLOW : PV_WHITE;
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  pvRoadSurface( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), vMapUv * ${K.tile} );
  diffuseColor.rgb *= pvMacro;
  diffuseColor.rgb *= 1.0 + 0.20 * pvPale
    - 0.38 * pvPolish - 0.34 * pvOil - 0.20 * pvGrime - 0.22 * pvPatch;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.011, 0.011, 0.012 ), pvSeal );
  diffuseColor.rgb = mix( diffuseColor.rgb, pvIronCol, pvIron );
  diffuseColor.rgb = mix( diffuseColor.rgb, pvPaintCol, pvPaint );`)
      // roughnessmap_fragment has already been rewritten by applyPackedRoughness
      // on this material, so a second replace of it silently does nothing — which
      // is exactly how the old paint-roughness override came to be dead code.
      // Hang the modification off the next include instead.
      .replace('#include <metalnessmap_fragment>', `
  roughnessFactor = clamp( roughnessFactor - 0.30 * pvPolish - 0.20 * pvOil
    + 0.08 * pvPale + 0.10 * pvPatch, 0.06, 1.0 );
  roughnessFactor = mix( roughnessFactor, 0.55, pvSeal );
  roughnessFactor = mix( roughnessFactor, 0.42, pvIron );
  roughnessFactor = mix( roughnessFactor, 0.62, pvPaint );
#include <metalnessmap_fragment>`)
      // A wheel path is not just darker, it is SMOOTHER: the aggregate is
      // burnished flat. Flattening the asphalt normal there is what makes the
      // tracks read at a grazing angle, where roughness alone barely shows.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = normalize( mix( normal, nonPerturbedNormal,
    clamp( 0.55 * pvPolish + 0.45 * pvIron + 0.35 * pvPaint, 0.0, 1.0 ) ) );`);
  });
}

// Slab-to-slab variation for paving, hashed off the slab's own world position
// rather than baked into the tile. A 3 m tile holds exactly four slabs and then
// repeats, which is the "clean repeating grid with uniform seam width, no
// cracked slab, no stain, no patch" three critic rounds have named. A hash of
// the slab index holds as many distinct slabs as the district has pavement.
//
// The planar UV is already world-locked and the albedo painted its joints on
// halves of the tile, so the slab index is just that UV times slabs-per-tile: it
// lands exactly on the painted joints, and it needs no varying, no attribute and
// no texture.
function applySlabVariation(material, slabsPerTile) {
  const N = slabsPerTile.toFixed(4);
  return patch(material, 'slabs', (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
float pvPaveHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  vec2 pvSlabUv = vMapUv * ${N};
  vec2 pvSlabId = floor( pvSlabUv );
  vec2 pvSlabF = pvSlabUv - pvSlabId;
  // A per-slab hash is a STEP function, and a step has no mip chain: once a
  // pixel covers most of a slab it samples a different slab every frame and the
  // pavement boils. Fade the whole effect out as the footprint approaches one
  // slab — by then the slabs are sub-pixel and their average is the right answer.
  float pvSlabFade = 1.0 - smoothstep( 0.22, 0.75,
    max( fwidth( pvSlabUv.x ), fwidth( pvSlabUv.y ) ) );
  float pvS0 = mix( 0.5, pvPaveHash( pvSlabId ), pvSlabFade );
  float pvS1 = mix( 0.5, pvPaveHash( pvSlabId + 41.0 ), pvSlabFade );
  float pvS2 = mix( 0.0, pvPaveHash( pvSlabId * 1.7 + 91.0 ), pvSlabFade );
  // Every slab is its own pour: a different batch, a different age, a different
  // number of summers of traffic film on it.
  diffuseColor.rgb *= 0.86 + 0.26 * pvS0;
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.05, 1.01, 0.93 ), pvS1 );
  // The odd replaced slab: newer, greyer and cleaner than its neighbours.
  diffuseColor.rgb = mix( diffuseColor.rgb,
    diffuseColor.rgb * vec3( 1.17, 1.18, 1.21 ), step( 0.945, pvS2 ) );
  // Joints are cut and filled by hand and silt up at different rates, so their
  // width and darkness vary slab by slab instead of being one painted constant.
  float pvEdge = min( min( pvSlabF.x, 1.0 - pvSlabF.x ), min( pvSlabF.y, 1.0 - pvSlabF.y ) );
  diffuseColor.rgb *= 1.0 - 0.34 * pvS2 * ( 1.0 - smoothstep( 0.0, 0.020 + 0.030 * pvS1, pvEdge ) );
  // Staining. A drip belongs to one slab; a spill crosses the joint, so there
  // are two scales of it.
  float pvBlot = smoothstep( 0.40, 0.06, length( pvSlabF - vec2( pvS0, pvS1 ) ) )
    * step( 0.66, pvS2 ) * ( 0.12 + 0.26 * pvS1 );
  vec2 pvWide = vMapUv * 0.42;
  pvBlot += smoothstep( 0.34, 0.02, length( fract( pvWide ) - 0.5 ) )
    * step( 0.70, pvPaveHash( floor( pvWide ) + 7.0 ) ) * 0.20;
  diffuseColor.rgb *= 1.0 - pvBlot;`);
  });
}

// Specular anti-aliasing for horizontal surfaces, on the real texel footprint.
//
// The asphalt normal map repeats every 3 m at 512 px, i.e. 5.9 mm per texel.
// That is right up close and hopelessly under-sampled at a grazing angle: one
// screen pixel covers many texels, the normal it happens to sample is not the
// average of them, and the specular lobe turns that error into bright dashes.
// Measured on the night corridor camera in heavy rain, the ground band's
// high-frequency energy (mean deviation from a 3x3 mean) sits at 10.04 and the
// frame shows a white crackle across the carriageway.
//
// Two things this is NOT. It is not a texture-sampling problem: raising
// anisotropy to the hardware maximum of 16 moved the number by 0.4%. And it is
// not a distance problem - the first version of this faded the normal between
// 18 m and 70 m and moved it by 0.8%, because at a camera height of 2.4 m the
// most grazing ground in the frame is at the viewer's FEET, not down the street.
// Distance is the wrong proxy for under-sampling; footprint is the right one.
//
// So the fade is driven by the actual texel footprint of a pixel, from the
// screen-space derivatives of the normal map's own UV. At one texel per pixel
// the map is fully resolved and is used as authored; by `flat` texels per pixel
// it is noise and the normal is the geometric one. The variance the fade removes
// is handed to roughness rather than thrown away, which is the trade Toksvig
// makes - taken on a measured footprint rather than a per-texel variance this
// pipeline has nowhere to store.
function applyDistanceNormalFade(material, texels, flat, roughFloor) {
  const T = texels.toFixed(1), F = flat.toFixed(1), R = roughFloor.toFixed(3);
  return patch(material, 'nfade', (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
  #ifdef USE_NORMALMAP
  {
    // Texels of the normal map covered by this pixel, along its longer axis.
    float pvFoot = max( length( dFdx( vNormalMapUv ) ), length( dFdy( vNormalMapUv ) ) ) * ${T};
    float pvNFade = 1.0 - smoothstep( 1.0, ${F}, pvFoot );
    normal = normalize( mix( nonPerturbedNormal, normal, pvNFade ) );
    // Flattening the normal removes specular spread; give it back as roughness
    // so the surface does not turn into a mirror as its detail fades out.
    roughnessFactor = mix( max( roughnessFactor, ${R} ), roughnessFactor, pvNFade );
  }
  #endif`);
  });
}

// Roughness lives in the normal map's alpha. Canvas 2D premultiplies alpha, so
// this only works because these normal maps are DataTextures assembled byte by
// byte rather than read back out of a canvas.
function applyPackedRoughness(material) {
  return patch(material, 'packedRough', (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `float roughnessFactor = roughness;
  #ifdef USE_NORMALMAP
    roughnessFactor *= texture2D( normalMap, vNormalMapUv ).a;
  #endif`);
  });
}

// ---------------------------------------------------------------- glazing
// GLAZING is the shading contract for every pane of glass in the district, kept
// as numbers rather than as prose because three separate modules have to agree
// on them and two of them got it wrong independently.
//
// What was measured, on the dusk hero frame and on the registry's own materials:
//
//   surface                       roughness   metalness   F0 (linear RGB)
//   car glass (carbody.js)          0.045       0.88      0.007 0.009 0.011
//   THIS FILE's glassTinted, was    0.322*      0.62      0.070 0.094 0.112
//   facade atlas glass cell         0.129       0.549     0.038 0.059 0.082
//   facade atlas WALL cell          0.220       0.302     0.173 0.182 0.182
//
//   * 1.0 material roughness multiplying a packed roughness map that measures
//     0.176-0.541 over its texels. Nobody reading `roughness: 1` next to
//     `applyPackedRoughness` guesses the surface actually shades at 0.32.
//
// Two things fall out of that table. First, on luminance-weighted F0 the wall is
// 3.2x more specular than the glass beside it (0.180 against 0.056), which is
// exactly backwards and is why a pane reads darker
// and flatter than the masonry around it. Second, the car's glass has the LOWEST
// F0 in the table and is still the only surface in the frame with a highlight:
// what buys the highlight is roughness 0.045, not reflectance. A 0.32-roughness
// lobe smears a whole hemisphere of sky into one dim average — which is the
// definition of "uniform tint with no internal gradient".
//
// So: F0 first, roughness second, and never a dark colour under a metallic term
// (same trap as the painted-steel note further down — for a metal the colour IS
// the reflectance, and 0x54646e at metalness 0.62 is a 9% mirror). Measured on
// the facade atlas, one lever at a time, on the same pane of the same frame:
// dropping roughness 0.129 -> 0.059 moved the pane's mean luminance 64.5 -> 66.1
// and raising metalness 0.549 -> 0.902 moved it 64.5 -> 64.1, but making the
// colour the coating's reflectance moved it 64.5 -> 126.6. A FLAT wall reflects
// a nearly uniform patch of sky, so sharpening the lobe buys almost nothing
// there; it is the car's curvature that turns low roughness into a glint.
//
// And one trap that costs an afternoon if you do not know it: **envMapIntensity
// is inert on every material in this project.** three.js does
//
//   material.isMeshStandardMaterial && material.envMap === null
//     && scene.environment !== null  ->  uniforms.envMapIntensity.value
//                                          = scene.environmentIntensity
//
// every frame, so a material that takes its environment from scene.environment —
// which is all of them — has its own envMapIntensity overwritten with 1.0.
// Verified: setting it to 30 on the facade materials changed the frame by zero
// levels, while scene.environmentIntensity = 0 took the same pane from 64.5 to
// 12.5. The numbers below are kept because they are the right intent if a
// material is ever given its own envMap, but nothing is tunable through them
// today, and carbody's 2.6 is not what buys the car its highlight either.
//
// Read that 64.5 -> 12.5 the right way round, because three critic rounds did
// not: it says the environment is already 81% of a pane's light, not that a pane
// is missing one. Re-measured on a 54 m tower, a pane returns a near-constant
// third of whatever the environment holds in its reflected direction, and the
// direction is right too - it is a mirror, and it works. What it reflects is the
// bug: an environment with no city in it. See applyGlazingEnv below.
const GLAZING = {
  // Multiplies the packed roughness map (0.176-0.541), so the grime still
  // modulates gloss instead of being flattened away.
  //
  // Lowered with the facade atlas' own glass cell (facades.js drawOpening, which
  // has the measurement) from 0.22/0.30. The reason is the corridor tower's white
  // rectangle: a flat pane at mirror angle to the sun returns ~1e6 cd/m2 through
  // a GGX lobe of this width, against an ACES white point of 30,000 and the
  // sanitize() ceiling of 60,000 below, so the highlight is not a peak but an
  // AREA - and that area grows with roughness until alpha = r^2 reaches ~0.084.
  // A narrower lobe is what gives a sun-struck pane a gradient instead of a
  // plateau. Measured curve and crops are in the facades.js note.
  //
  // Said out loud, because it decides how much weight to give these two: NOTHING
  // IN THE STREAMED DISTRICT DRAWS glassStorefront OR glassTinted today
  // (tools/glaz-probe.mjs' compile check exists for exactly that reason), so
  // unlike the atlas cell these two are contract rather than measurement. They
  // are moved to keep this table honest about what the district's glazing is,
  // not because a frame changed.
  coatedRoughness: 0.17,      // -> 0.030 .. 0.092, mean 0.055
  shopRoughness: 0.23,        // -> 0.040 .. 0.124, mean 0.074 (older, dirtier)
  // A reflective coating is 20-40% reflective. This colour IS that reflectance.
  //
  // WARM, not blue. 0x8798a0 was linear B/R 1.44, and against 295 reprojected
  // reference views whose glazing has a median linear B/R of 0.82 that is the
  // wrong side of neutral: a coating tinted blue multiplies the blue of what it
  // reflects instead of standing against it. This is the same re-chroma the
  // facades.js recipes carry, at the district's median, and at the SAME linear
  // luminance the old value had - so it is a hue change and not a brightness one.
  coatedColor: 0x9c948b,      // F0 0.304 0.271 0.238 at metalness 0.90
  coatedMetalness: 0.90,
  // Grime tilts the mirror direction; at 0.35 it scatters the reflection into
  // the same average the roughness bug produced. Glass is FLAT.
  normalScale: 0.10,
  paneMetres: [1.45, 1.75],   // a curtain-wall module: 1.45 m wide, 1.75 m floor band
  mullionMetres: 0.055,
  // The street a pane stands in - see applyGlazingEnv. Every number here was
  // measured off data/district.json or off the district's own palettes; none is
  // a taste value.
  canyon: {
    // tools/glaz-probe.mjs' canyon scan casts a ray out of the outward normal of
    // all 2,962 building edges in the bake and records the first footprint it
    // hits. 86% hit something. Length-weighted medians: 22.5 m away at 9.6 m tall
    // for the district as a whole, 21.7 m at 19.2 m for the facades of the
    // buildings over 26 m - which are the ones the critics were looking at. This
    // pair sits between them.
    oppositeHeight: 16.0,
    oppositeDistance: 22.0,
    // The crossover is soft over +-0.06 in tan space (+-3.4 deg) and ragged by
    // +-0.15 (+-3.3 m of roofline at 22 m) on a 14 m plot rhythm, because the
    // other side of a street is a row of separate buildings, not one extrusion.
    skylineSoft: 0.06,
    skylineRagged: 0.30,
    plotMetres: 14.0,
    // What the mass across the street returns, as an albedo applied to the
    // irradiance the pane itself is standing in. 0.506/0.431/0.382 is the mean
    // LINEAR albedo of the 16 wall palette entries of the four glazed recipes in
    // facades.js - the district's own colours, warm-tilted because they are - and
    // a street elevation is roughly 65% of that wall against 35% openings at
    // about 0.10, which is the mix below.
    urbanAlbedo: [0.364, 0.315, 0.283],
    // A curtain wall's units are never coplanar; 0.010 rad is 0.57 deg.
    facetTilt: 0.010,
  },
};

// Panes, procedurally, in world metres — no texture, no draw call, no memory.
//
// Two reasons this is arithmetic rather than an atlas cell. The mesh UVs are not
// ours (see the header), and a pane has to be 1.45 m on a 6 m shopfront and on a
// 60 m tower alike; and a critic's complaint was specifically that every pane is
// a UNIFORM FILL, which is a per-pane variation problem, not a resolution one.
//
// What it adds inside one pane: a vertical dirt/reflectance gradient, a per-pane
// tint and gloss jitter off a cell hash, mullions that are frame metal rather
// than glass, a bright catch on the head of each pane, and — for a shopfront —
// an interior that falls off from a sky-lit mouth instead of reading as a hole
// cut in the building.
//
// It hangs off `normal_fragment_maps` rather than the roughness/metalness stages
// because applyPackedRoughness has already rewritten roughnessmap_fragment, and
// because Fresnel needs the perturbed normal. roughnessFactor, metalnessFactor
// and diffuseColor are all still live at that point and are all consumed later,
// by lights_physical_fragment.
function applyGlazing(material, opts = {}) {
  const K = {
    paneW: (opts.paneMetres ?? GLAZING.paneMetres)[0].toFixed(4),
    paneH: (opts.paneMetres ?? GLAZING.paneMetres)[1].toFixed(4),
    mull: (opts.mullionMetres ?? GLAZING.mullionMetres).toFixed(4),
    // 0 = coated mirror, 1 = you are looking into a room.
    interior: (opts.interior ?? 0.15).toFixed(3),
    // Alpha rises to 1 at grazing. Glass reflects IN ADDITION to what it
    // transmits, and a constant alpha cannot say that: it multiplies the
    // specular by the opacity too, which is how a 4% reflection became 1.3%.
    fresnelAlpha: opts.fresnelAlpha ? '1.0' : '0.0',
    jitter: (opts.jitter ?? 0.16).toFixed(3),
  };
  return patch(material, 'glazing', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlazeWorld;\nvarying vec3 vGlazeNormal;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  vGlazeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vGlazeNormal = mat3( modelMatrix ) * objectNormal;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGlazeWorld;
varying vec3 vGlazeNormal;
float pvHash( vec2 c ) { return fract( sin( dot( c, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // Wall-planar pane grid: horizontal run along the wall, and world height. A
  // vertical surface's dominant axis picks which horizontal coordinate runs
  // across it, the same rule applyPlanarUV uses for the ground.
  vec3 gN = abs( normalize( vGlazeNormal ) );
  float across = gN.x > gN.z ? vGlazeWorld.z : vGlazeWorld.x;
  vec2 gUv = vec2( across / ${K.paneW}, vGlazeWorld.y / ${K.paneH} );
  vec2 cell = floor( gUv );
  vec2 f = fract( gUv );
  float h = pvHash( cell );

  // Distance to the nearest pane edge, in metres, so a mullion is a mullion at
  // any pane aspect and antialiases with fwidth instead of shimmering.
  vec2 edge = min( f, 1.0 - f ) * vec2( ${K.paneW}, ${K.paneH} );
  float dEdge = min( edge.x, edge.y );
  float aa = max( fwidth( dEdge ), 1e-4 );
  float mullion = 1.0 - smoothstep( ${K.mull} - aa, ${K.mull} + aa, dEdge );

  // Glass, before the frame is drawn over it.
  // 1. per-pane tint and gloss jitter — the fix for "every pane a uniform fill"
  float jTint = 1.0 + ( h - 0.5 ) * ${K.jitter};
  float jRough = 1.0 + ( pvHash( cell + 7.3 ) - 0.5 ) * 0.85;
  // 2. a vertical gradient inside the pane: run-off keeps the head of a light
  //    clean and the sill end dirty, so gloss falls and tint warms downward.
  float down = 1.0 - f.y;
  float grime = mix( 1.0, 1.85, down * down );
  roughnessFactor = clamp( roughnessFactor * jRough * grime, 0.012, 0.65 );
  diffuseColor.rgb *= jTint * mix( 1.0, 0.88, down );

  // 3. the interior behind the pane. A dark room is dark, not zero: it is lit
  //    through its own mouth, so it keeps a floor bounce and a soffit shadow
  //    and never returns a flat black rectangle. Structure, not just a fill.
  float interior = ${K.interior};
  if ( interior > 0.001 ) {
    float soffit = smoothstep( 0.86, 1.0, f.y );          // dark under the head
    float bounce = smoothstep( 0.34, 0.0, f.y );          // pavement light in
    float shelf = smoothstep( 0.02, 0.0, abs( f.y - 0.46 ) );
    vec3 room = vec3( 0.055, 0.052, 0.050 ) * ( 0.55 + 1.7 * bounce )
      + vec3( 0.028, 0.030, 0.034 ) * ( 1.0 - soffit )
      + vec3( 0.09, 0.08, 0.07 ) * shelf;
    diffuseColor.rgb = mix( diffuseColor.rgb, room, interior );
    metalnessFactor = mix( metalnessFactor, metalnessFactor * 0.35, interior );
    roughnessFactor = mix( roughnessFactor, 0.55, interior * 0.5 );
  }

  // 4. the frame. Mill-finish aluminium, and a bright catch on the head of each
  //    pane where the reveal turns up into the sky — the mullion highlight.
  float head = ( 1.0 - smoothstep( ${K.mull} * 0.55, ${K.mull} * 1.9, ( 1.0 - f.y ) * ${K.paneH} ) ) * mullion;
  vec3 frame = mix( vec3( 0.24, 0.245, 0.25 ), vec3( 0.62, 0.63, 0.64 ), head );
  diffuseColor.rgb = mix( diffuseColor.rgb, frame, mullion );
  roughnessFactor = mix( roughnessFactor, mix( 0.34, 0.18, head ), mullion );
  metalnessFactor = mix( metalnessFactor, 1.0, mullion * 0.9 );

  // 5. Fresnel. Cheap Schlick on the perturbed normal; used to open the alpha of
  //    a transparent pane at grazing so it stops dimming its own reflection.
  if ( ${K.fresnelAlpha} > 0.5 ) {
    float ndv = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
    float fres = pow( 1.0 - ndv, 5.0 );
    diffuseColor.a = clamp( mix( diffuseColor.a, 1.0, fres * 0.92 ) + mullion * 0.6, 0.0, 1.0 );
  }
}`);
  });
}

// ------------------------------------------------- glazing: what glass reflects
// A pane and the wall beside it are handed the SAME environment, and that is the
// whole of the defect. scene.environment is the sky dome's PMREM: a gradient
// above the horizon and, below it, one direction-independent lit-ground colour
// (src/sky.js groundRadiance). There is no city in it anywhere.
//
// Measured, on a 54 m tower filling the frame, glazing masked by the packed
// roughness/metalness texel and split by the world height the shader itself
// wrote out (tools/glaz-probe.mjs), against a chrome ball rendered into a float
// target in the same frame:
//
//   noon, one facade, pane luminance against the elevation it reflects FROM
//     reflected elevation      0     10     20     30     40     50  deg
//     pane                  1981   2138   1883   1628   1608   1463  nits
//     environment (ball)    5989   8109   5713   4604   4095   4024  nits
//     pane / environment    0.33   0.26   0.33   0.35   0.39   0.36
//
// So the pane is ALREADY a directional mirror, returning a near-constant third
// of whatever the environment holds in its reflected direction, and killing
// scene.environmentIntensity flattens it to 0.9 of 255 at every elevation. The
// reported diagnosis - "glazing has no environment term" - is wrong, and so is
// the fix it implies. envMapIntensity would not have helped either; see the note
// on GLAZING above, that lever is inert here.
//
// What the pane has no way to know is that a CITY is in the way. Our sky is
// brightest just above the horizon (8,109 nits at +10 deg at noon, 7,945 at
// golden) and dimmest overhead, and a pane low on a tower reflects nearly
// horizontally while a pane high up reflects steeply upward. So the district's
// towers come out BRIGHTEST AT THE PAVEMENT and fade toward the parapet - the
// exact inverse of every photograph of a glass building, where the lower floors
// are dark with the mass across the street and the sky only takes over above the
// opposite roofline.
//
// This puts the street back in, analytically, per pixel:
//
//   a pane at height y sees the mass across the street subtend atan((H-y)/D);
//   the reflected ray leaves at atan(R.y/|R.xz|); below that skyline it is
//   looking at building, above it at sky, and below the true horizon it is
//   looking at the ground the dome already models.
//
// Three sources, each taken from the right place. H and D are measured off the
// baked footprints (GLAZING.canyon). The city's radiance is NOT a painted colour
// but urbanAlbedo * iblIrradiance / PI - the wall opposite is lit by the same sky
// this pane is standing in, so it tracks the hour, the weather and the fog for
// free, goes dark at night with everything else, and needs no uniform anyone has
// to remember to update.
//
// Two deliberate omissions. It leaves iblIrradiance itself alone: the diffuse
// remainder of a pane at metalness 0.84 is 16% of its albedo, and the wall it is
// being compared against is occluded by the same street with nobody modelling
// that either. And it needs no varying of its own - world position and the flat
// pane normal come from cameraPosition, viewMatrix and geometryPosition, all
// built-ins - so it composes with applyGlazing instead of fighting it over the
// vertex shader.
//
// @param {object} [opts]
// @param {boolean} [opts.glassTexelsOnly] mask to the smooth metallic texels of a
//   shared atlas - pane-audit.mjs' test, so the shader and the measurement agree
//   about what a pane is. Off for a material that is all glass.
export function applyGlazingEnv(material, opts = {}) {
  const C = { ...GLAZING.canyon, ...opts };
  const n = (v) => Number(v).toFixed(4);
  const K = {
    oppH: n(C.oppositeHeight), oppD: n(C.oppositeDistance),
    soft: n(C.skylineSoft), rag: n(C.skylineRagged), plot: n(C.plotMetres),
    tilt: n(C.facetTilt),
    paneW: n((C.paneMetres ?? GLAZING.paneMetres)[0]),
    paneH: n((C.paneMetres ?? GLAZING.paneMetres)[1]),
    city: C.urbanAlbedo.map(n).join(', '),
    mask: C.glassTexelsOnly
      ? '( 1.0 - smoothstep( 0.34, 0.44, roughnessFactor ) ) * smoothstep( 0.34, 0.44, metalnessFactor )'
      : '1.0',
  };
  return patch(material, 'glazeEnv', (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
float geHash( vec2 c ) { return fract( sin( dot( c, vec2( 91.7, 47.3 ) ) ) * 24634.6345 ); }`)
      .replace('#include <lights_fragment_end>', `
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && defined( RE_IndirectDiffuse )
{
  vec3 geN = inverseTransformDirection( nonPerturbedNormal, viewMatrix );
  // A roof is not in a street: fade this out as the surface turns horizontal.
  float geGlass = ${K.mask} * ( 1.0 - smoothstep( 0.55, 0.85, abs( geN.y ) ) );
  if ( geGlass > 0.002 ) {
    // The camera ray and the world position it lands on, from built-ins only.
    // geometryPosition is the view-space fragment position lights_fragment_begin
    // set, and inverseTransformDirection returns it as a unit world direction.
    // Perspective camera assumed - cameraPosition is the ray origin.
    vec3 geDir = inverseTransformDirection( geometryPosition, viewMatrix );
    vec3 geWorld = cameraPosition + geDir * length( geometryPosition );
    // Which horizontal axis runs across this wall - applyPlanarUV's rule.
    float geAcross = abs( geN.x ) > abs( geN.z ) ? geWorld.z : geWorld.x;

    // A curtain wall is not one plane: separately glazed units sit a fraction of
    // a degree out of true and pillow under load. The tilt is tiny, and what it
    // buys is that the skyline crossover below lands on a scatter of panes
    // instead of on a ruled horizontal line across the elevation.
    vec2 geCell = floor( vec2( geAcross / ${K.paneW}, geWorld.y / ${K.paneH} ) );
    vec3 geTan = cross( vec3( 0.0, 1.0, 0.0 ), geN );
    float geTanLen = length( geTan );
    geTan = geTanLen > 1e-3 ? geTan / geTanLen : vec3( 1.0, 0.0, 0.0 );
    vec3 geFacet = normalize( geN
      + geTan * ( geHash( geCell ) - 0.5 ) * ${K.tilt}
      + vec3( 0.0, 1.0, 0.0 ) * ( geHash( geCell + 3.7 ) - 0.5 ) * ${K.tilt} );
    vec3 geR = reflect( geDir, geFacet );

    // The canyon, in tan space so there is no trig per pixel.
    float geTanR = geR.y / max( length( geR.xz ), 1e-4 );
    float geTanSky = ( ${K.oppH} - geWorld.y ) / ${K.oppD}
      + ( geHash( vec2( floor( geAcross / ${K.plot} ), 17.0 ) ) - 0.5 ) * ${K.rag};
    float geSky = smoothstep( - ${K.soft}, ${K.soft}, geTanR - geTanSky );
    // Under the true horizon the dome already models the lit ground, so the
    // street term applies only between the horizon and the opposite roofline.
    float geAbove = smoothstep( - 0.02, 0.08, geTanR );

    // What the mass opposite RETURNS. It was lit by the sky alone, and that is
    // the second half of the cobalt-pane defect: a wall the photographs show
    // sunlit and warm was being rendered as a sky-lit wall and reflected back
    // into every pane in the district. Measured on 12 corridor views at noon,
    // the sky irradiance a vertical surface stands in has B/R 1.40, so
    // urbanAlbedo * iblIrradiance came out at B/R 1.09 - a "city" no warmer
    // than an overcast day - while the sun that actually lights it is 0.81 at
    // noon and 0.23 at golden.
    //
    // Which side of the street is in sun is already decided by the geometry in
    // this block: the opposite wall's outward normal is -geN, so it faces the
    // sun exactly when this wall does not. directionalLights[0] is daynight.js'
    // sun - the scene's only directional light - and three.js folds intensity
    // into colour, so that uniform IS an irradiance in lux, in the same units as
    // iblIrradiance, and no new uniform is needed.
    //
    // ...minus the shadow this side throws across the street, which is what
    // stops golden hour turning a canyon into two sunlit walls facing each
    // other. The canyon is already described as H tall and D wide, so a
    // reflected ray leaving at geTanR lands on the wall opposite at
    // geWorld.y + D * geTanR, and this side's parapet shades that wall up to
    // H - D * tan(sun elevation). At noon's 75.6 deg that line is far below the
    // pavement and nothing is shaded; at golden's 8 deg it stands at 12.9 m and
    // most of the elevation is in shade, which is what a photograph of a street
    // at that hour shows.
    //
    // Omitted, and said out loud: the opposite wall's own sky irradiance is
    // taken to be this wall's (they differ near the sun's glow), and buildings
    // beyond the one opposite cast no shadow here.
    vec3 geSunE = vec3( 0.0 );
    #if NUM_DIR_LIGHTS > 0
    {
      vec3 geSunW = inverseTransformDirection( directionalLights[ 0 ].direction, viewMatrix );
      float geFacing = max( 0.0, dot( geSunW, -geN ) );
      float geTanSun = geSunW.y / max( length( geSunW.xz ), 1e-4 );
      float geHitY = geWorld.y + ${K.oppD} * geTanR;
      float geLit = smoothstep( -1.5, 1.5, geHitY - ( ${K.oppH} - ${K.oppD} * geTanSun ) );
      geSunE = directionalLights[ 0 ].color * geFacing * geLit;
    }
    #endif
    vec3 geCity = vec3( ${K.city} ) * ( iblIrradiance + geSunE ) / PI;
    radiance = mix( radiance, geCity, geGlass * geAbove * ( 1.0 - geSky ) );
  }
}
#endif
#include <lights_fragment_end>`);
  });
}

// One sampler2DArray for every wall and roof surface. `aLayer` is a per-vertex
// attribute so a merged chunk mixing stucco walls and tile roofs is still one
// draw call; uLayerBias lets a single-surface mesh skip the attribute entirely.
function applySurfaceArray(material, arrays, layerBias, layerScale) {
  return patch(material, 'surfaceArray', (shader) => {
    shader.uniforms.tSurfaceAlbedo = { value: arrays.albedo };
    shader.uniforms.tSurfaceNormal = { value: arrays.normal };
    shader.uniforms.uLayerBias = layerBias;
    shader.uniforms.uLayerScale = { value: layerScale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aLayer;
varying float vLayer;
uniform float uLayerBias;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
  vLayer = aLayer + uLayerBias;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray tSurfaceAlbedo;
uniform sampler2DArray tSurfaceNormal;
uniform float uLayerScale[ ${SURFACE_LAYERS.length} ];
varying float vLayer;
int veranoLayer() { return int( vLayer + 0.5 ); }
vec3 veranoSrgb( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
}`)
      .replace('#include <map_fragment>', `
  int vLayerI = veranoLayer();
  vec3 veranoUvw = vec3( vMapUv * uLayerScale[ vLayerI ], float( vLayerI ) );
  vec4 veranoAlbedo = texture( tSurfaceAlbedo, veranoUvw );
  diffuseColor *= vec4( veranoSrgb( veranoAlbedo.rgb ), veranoAlbedo.a );`)
      .replace('#include <roughnessmap_fragment>', `
  float roughnessFactor = roughness * texture( tSurfaceNormal, veranoUvw ).a;`)
      .replace('#include <normal_fragment_maps>', `
  vec3 mapN = texture( tSurfaceNormal, veranoUvw ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );`)
      // Vertex colours on this material are sRGB, not linear: they come straight
      // from a SURFACE_TINTS hex divided by 255, which is what every caller
      // naturally writes. Decoding here keeps that convention honest.
      .replace('#include <color_fragment>', `
  #ifdef USE_COLOR
    diffuseColor.rgb *= veranoSrgb( vColor );
  #endif`);
  });
}

// Two normal-map layers scrolling against each other. The plane is horizontal by
// construction, so the tangent frame is built from the view matrix directly
// instead of from screen-space derivatives of a UV that is being animated.
function applyWater(material, time) {
  return patch(material, 'water', (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
      .replace('#include <fog_vertex>',
        '#include <fog_vertex>\n  vWorldXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;\nuniform float uTime;')
      .replace('#include <normal_fragment_maps>', `
  vec3 wave1 = texture2D( normalMap, vWorldXZ * 0.055 + vec2( 0.013, 0.009 ) * uTime ).xyz * 2.0 - 1.0;
  vec3 wave2 = texture2D( normalMap, vWorldXZ * 0.017 - vec2( 0.007, 0.011 ) * uTime ).xyz * 2.0 - 1.0;
  vec3 mapN = normalize( vec3( wave1.xy * normalScale + wave2.xy * normalScale * 0.75, 1.0 ) );
  // Tangent frame from the surface normal itself rather than from screen-space
  // derivatives of the UV: the UV is being animated, and a 1 km water plane's
  // mesh UV derivatives underflow anyway.
  vec3 waterN = normalize( ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz );
  vec3 waterT = normalize( cross(
    abs( waterN.y ) > 0.99 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 ), waterN ) );
  vec3 waterB = cross( waterN, waterT );
  vec3 waterWorld = normalize( waterT * mapN.x + waterB * mapN.y + waterN * mapN.z );
  normal = normalize( ( viewMatrix * vec4( waterWorld, 0.0 ) ).xyz );`);
  });
}

// ---------------------------------------------------------------- registry
export class MaterialRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.anisotropy=16] clamped to the device max at upload
   * @param {number} [opts.seed=1337]     changes every texture; keep it fixed in the game
   */
  constructor(opts = {}) {
    const t0 = performance.now();
    // 16 is the max every desktop GL implementation this targets reports, and
    // three clamps to capabilities.getMaxAnisotropy() at upload, so asking for
    // more than a device has costs nothing. The old default was 8 with a note
    // saying to pass the max, and no caller ever did.
    //
    // Honest caveat: measured on the SwiftShader harness this changes the ground
    // band's high-frequency energy by 0.4%, i.e. nothing - that renderer appears
    // not to implement anisotropic filtering. It is kept because it is correct
    // where the extension exists, NOT because it was seen to help here.
    this.anisotropy = opts.anisotropy ?? 16;
    this.seed = opts.seed ?? 1337;
    this._materials = new Map();
    this._textures = [];
    this._bytes = 0;
    this.time = { value: 0 };

    // Texture generation is a startup budget and is profiled like any other.
    this.timings = { markings: 0 };
    this._phase('surfaces', () => this._buildSurfaceArray());
    // markings: built on demand, see get(). The road paints its profile
    // arithmetically now, so the district never touches the atlas.
    this._phase('ground', () => this._buildGround());
    this._phase('water', () => this._buildWater());
    this._phase('trim', () => this._buildGlassAndMetal());

    this.generationMs = performance.now() - t0;
  }

  // -------------------------------------------------------------- book-keeping
  _phase(name, fn) {
    const t = performance.now();
    const r = fn();
    this.timings[name] = +(performance.now() - t).toFixed(1);
    return r;
  }

  _track(texture, w, h, layers = 1) {
    texture.anisotropy = this.anisotropy;
    // Mip chain adds a third; count it, because the GPU allocates it.
    this._bytes += Math.round(w * h * layers * 4 * (texture.generateMipmaps === false ? 1 : 4 / 3));
    this._textures.push(texture);
    return texture;
  }

  _put(key, material) {
    material.name = key;
    this._materials.set(key, material);
    return material;
  }

  // -------------------------------------------------------------- ground
  // A ground surface is albedo (sRGB canvas) + one packed normal/roughness
  // DataTexture, addressed by world XZ. Two textures, not three.
  _groundMaps(name, surface) {
    const seed = this.seed + hashName(name);
    const A = surface.albedo, D = surface.detail;
    const albedoCanvas = makeCanvas(A);
    surface.paintAlbedo(
      albedoCanvas.getContext('2d', { willReadFrequently: true }), A, mulberry32(seed));
    const albedo = new THREE.CanvasTexture(albedoCanvas);
    albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
    albedo.colorSpace = THREE.SRGBColorSpace;
    this._track(albedo, A, A);

    const heightCanvas = makeCanvas(D);
    surface.paintHeight(heightCanvas.getContext('2d', { willReadFrequently: true }), D, mulberry32(seed));
    const height = luminanceField(heightCanvas, D);
    let rough = null;
    if (surface.paintRough) {
      const rc = makeCanvas(D);
      surface.paintRough(rc.getContext('2d', { willReadFrequently: true }), D, mulberry32(seed));
      rough = luminanceField(rc, D);
    }
    const px = sobelNormalRough(height, rough, D, surface.normalStrength * D * 0.02);
    const normal = this._normalTexture(px, D);
    return { albedo, normal, packedRough: !!rough };
  }

  // Normal maps ship as DataTextures, not CanvasTextures, because the roughness
  // rides in the alpha channel and canvas 2D would premultiply it into the RGB.
  _normalTexture(px, size) {
    flipRows(px, size, size);   // DataTexture has flipY off; CanvasTexture has it on
    const t = new THREE.DataTexture(new Uint8Array(px.buffer), size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return this._track(t, size, size);
  }

  // Materials are never cloned: Material.clone() does not carry onBeforeCompile
  // or customProgramCacheKey, so a cloned material silently loses its patches and
  // renders with the wrong UVs. Variants are built from the same cached maps.
  _groundMaterial(key, maps, tileMetres, extra = {}) {
    const m = new THREE.MeshStandardMaterial({
      map: maps.albedo,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 1, metalness: 0.0,
      ...extra,
    });
    applyPlanarUV(m, 1 / tileMetres);
    if (maps.packedRough) applyPackedRoughness(m);
    // Every world-planar ground surface has the same grazing-angle problem, so
    // the fade goes on all of them rather than only on the road that showed it.
    applyDistanceNormalFade(m, maps.normal?.image?.width ?? 512, 5, 0.34);
    return this._put(key, m);
  }

  _buildGround() {
    const maps = {};
    for (const [key, s] of Object.entries({
      road: asphaltSurface, sidewalk: sidewalkSurface, parkingLot: parkingSurface,
      grass: grassSurface, dirt: dirtSurface, sand: sandSurface, concrete: concreteSurface,
    })) {
      maps[key] = this._groundMaps(key, s);
      if (key === 'concrete') continue;
      const m = this._groundMaterial(key, maps[key], s.tile, { roughness: s.roughness ?? 1 });
      if (key === 'road') applyRoadMarkings(m, s.tile);
      // Was s.tile / 1.5 — one cell per 1.5 m slab, the standard 5 ft pour the
      // albedo used to draw joints for. The albedo is clay pavers now, and a
      // 1.5 m grid of tint steps over a 200 mm bond reads as concrete slabs
      // printed with a brick pattern, which is worse than either. One cell per
      // 3 m tile is a paver BAY: pavers are laid and lifted in bays, they silt
      // and settle by bay, and the occasional lighter cell this shader draws is
      // a bay that has been taken up and relaid.
      if (key === 'sidewalk') applySlabVariation(m, s.tile / 3);
    }

    // The district's land pad: bare urban ground between roads and footprints.
    // Same maps as dirt, greyer and at a coarser repeat so the two do not read as
    // one continuous surface where they meet.
    this._groundMaterial('land', maps.dirt, 7, { color: 0x9fa08c, roughness: 0.97 });

    // Kerbs are vertical faces as much as horizontal ones, so world-planar XZ
    // would smear them: they keep mesh UVs and a plain repeat.
    const c = maps.concrete;
    c.albedo.repeat.set(1 / concreteSurface.tile, 1 / concreteSurface.tile);
    c.normal.repeat.copy(c.albedo.repeat);
    for (const [key, color, rough] of [
      ['kerb', 0xd8d4cb, 1], ['kerbPainted', 0xe8b53a, 0.9], ['concrete', 0xc4c0b6, 1],
    ]) {
      const m = new THREE.MeshStandardMaterial({
        map: c.albedo, normalMap: c.normal, color, roughness: rough, metalness: 0,
      });
      applyPackedRoughness(m);
      this._put(key, m);
    }
  }

  // -------------------------------------------------------------- markings
  _buildMarkings() {
    const canvas = paintMarkingAtlas(mulberry32(this.seed + 4001));
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.ClampToEdgeWrapping;     // columns must not bleed into each other
    t.wrapT = THREE.RepeatWrapping;          // ...but the profile repeats along the road
    t.colorSpace = THREE.SRGBColorSpace;
    this._track(t, canvas.width, canvas.height);
    this._markingTexture = t;
    const m = new THREE.MeshStandardMaterial({
      map: t, transparent: true, depthWrite: false,
      roughness: 0.55, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    });
    m.userData.atlas = { columns: MARKING_COLUMNS, columnPx: MARKING_COL_PX, metresPerColumn: 8 };
    this._put('roadMarkings', m);
  }

  // -------------------------------------------------------------- walls + roofs
  _buildSurfaceArray() {
    const A = 512, D = 256, n = SURFACE_LAYERS.length;
    const albedoData = new Uint8Array(A * A * 4 * n);
    const normalData = new Uint8Array(D * D * 4 * n);
    const scales = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const name = SURFACE_LAYERS[i], s = SURFACE_SET[name];
      const seed = this.seed + hashName(name);
      scales[i] = 1 / s.uvTile;

      const ac = makeCanvas(A);
      s.paintAlbedo(ac.getContext('2d', { willReadFrequently: true }), A, mulberry32(seed));
      copyFlipped(ac.getContext('2d').getImageData(0, 0, A, A).data,
        albedoData, i * A * A * 4, A, A);

      const hc = makeCanvas(D);
      s.paintHeight(hc.getContext('2d', { willReadFrequently: true }), D, mulberry32(seed));
      const rc = makeCanvas(D);
      s.paintRough(rc.getContext('2d', { willReadFrequently: true }), D, mulberry32(seed));
      const px = sobelNormalRough(
        luminanceField(hc, D), luminanceField(rc, D), D, s.normalStrength * D * 0.02);
      copyFlipped(px, normalData, i * D * D * 4, D, D);
    }

    const albedo = new THREE.DataArrayTexture(albedoData, A, A, n);
    const normal = new THREE.DataArrayTexture(normalData, D, D, n);
    for (const t of [albedo, normal]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
    }
    this._track(albedo, A, A, n);
    this._track(normal, D, D, n);
    this.surfaceArrays = { albedo, normal };
    this.layerScales = scales;

    // The array is sampled by hand, so `map` etc. exist only to make three define
    // USE_MAP / USE_NORMALMAP / USE_ROUGHNESSMAP and emit the uv varyings.
    this._stub = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._stub.needsUpdate = true;
  }

  _surfaceMaterial(key, layerBias, extra = {}) {
    const m = new THREE.MeshStandardMaterial({
      map: this._stub, normalMap: this._stub,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 1, metalness: 0, ...extra,
    });
    m.defaultAttributeValues = { aLayer: [0, 0, 0, 0], color: [1, 1, 1] };
    applySurfaceArray(m, this.surfaceArrays, { value: layerBias }, this.layerScales);
    return this._put(key, m);
  }

  /**
   * A shared wall or roof material. N buildings in the district collapse onto the
   * number of family/tint pairs actually used, and every one of them samples the
   * same two array textures.
   * @param {string} family  a SURFACE_LAYERS name
   * @param {string} [tint]  a SURFACE_TINTS[family] key
   */
  surface(family, tint) {
    const layer = SURFACE_LAYERS.indexOf(family);
    if (layer < 0) throw new Error(`unknown surface family: ${family}`);
    const tints = SURFACE_TINTS[family];
    const name = tint && tints[tint] !== undefined ? tint : Object.keys(tints)[0];
    const key = `${family}:${name}`;
    return this._materials.get(key) || this._surfaceMaterial(key, layer, { color: tints[name] });
  }

  /**
   * The one material a merged chunk should use for ALL of its building geometry.
   * The geometry must carry:
   *   `aLayer` (Float32, 1 per vertex)  — a SURFACE_LAYERS index
   *   `color`  (Float32, 3 per vertex)  — the per-building tint, linear-space
   * Without them the mesh falls back to layer 0 and white, which is stucco.
   */
  buildingMerged() {
    return this._materials.get('buildingMerged')
      || this._surfaceMaterial('buildingMerged', 0, { vertexColors: true });
  }

  // -------------------------------------------------------------- water
  _buildWater() {
    const D = 256;
    const rand = mulberry32(this.seed + 77);
    const hc = makeCanvas(D);
    const g = hc.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#808080'; g.fillRect(0, 0, D, D);
    drawField(g, D, 32, fbm(32, 4, 4, rand), greyField(0.2, 0.8), 1);
    drawField(g, D, 64, fbm(64, 8, 3, rand), greyField(0.35, 0.65), 0.5);
    const normal = this._normalTexture(sobelNormalRough(luminanceField(hc, D), null, D, 1.4), D);

    // Sarasota Bay is shallow Gulf water over sand: green, not navy, and it is the
    // sky reflection that carries it, so scene.environment matters here.
    const m = new THREE.MeshStandardMaterial({
      color: 0x18404a, normalMap: normal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.09, metalness: 0.0, envMapIntensity: 1.6,
    });
    applyWater(m, this.time);
    this._put('water', m);
  }

  // -------------------------------------------------------------- glass, metal
  _buildGlassAndMetal() {
    const D = 256;
    const rand = mulberry32(this.seed + 555);
    const hc = makeCanvas(D);
    const g = hc.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#7e7e7e'; g.fillRect(0, 0, D, D);
    drawField(g, D, 48, fbm(48, 6, 3, rand), greyField(0.46, 0.54), 0.8);
    const rc = makeCanvas(D);
    const rg = rc.getContext('2d', { willReadFrequently: true });
    rg.fillStyle = '#1a1a1a'; rg.fillRect(0, 0, D, D);        // 0.10 base gloss
    drawField(rg, D, 24, fbm(24, 3, 3, rand), greyField(0.05, 0.5), 0.9);
    for (let i = 0; i < 30; i++) {                            // rain streaks and salt
      const x = rand() * D;
      rg.fillStyle = `rgba(190,190,190,${0.1 + rand() * 0.25})`;
      rg.fillRect(x, 0, 1 + rand() * 4, D);
    }
    const grime = this._normalTexture(
      sobelNormalRough(luminanceField(hc, D), luminanceField(rc, D), D, 0.6), D);
    grime.repeat.set(0.5, 0.5);

    // Two glazing options on purpose. `glassTinted` is opaque and therefore
    // mergeable and free of sorting; use it for anything that ships in a chunk.
    //
    // Shop glazing is uncoated: 4% head-on, and the reason it reads as glass at
    // all from the street is that a shopfront is nearly always seen at a glancing
    // angle, where Fresnel takes it to a mirror. `opacity` is the HEAD-ON value
    // only; applyGlazing opens the alpha as the angle grazes, because a constant
    // alpha multiplies the reflection as well as the transmission and turned this
    // material's 4% into a measured 1.3%.
    const storefront = new THREE.MeshStandardMaterial({
      color: 0xa9c2bd, normalMap: grime,
      normalScale: new THREE.Vector2(GLAZING.normalScale, GLAZING.normalScale),
      roughness: GLAZING.shopRoughness, metalness: 0.02, transparent: true, opacity: 0.32,
      envMapIntensity: 2.0, side: THREE.DoubleSide,
    });
    applyPackedRoughness(storefront);
    // A shopfront is mostly the room behind it, so the interior weight is high
    // and its structure — soffit, shelf line, floor bounce — is what stops the
    // opening reading as a hole cut in the elevation.
    applyGlazing(storefront, {
      interior: 0.86, fresnelAlpha: true, jitter: 0.22,
      paneMetres: [1.15, 2.6], mullionMetres: 0.075,
    });
    // A shopfront stands at the bottom of the canyon, so it is on the city side
    // of the skyline from every angle: this is what stops it reflecting the
    // brightest band of the sky back at a viewer standing in a street.
    applyGlazingEnv(storefront, { paneMetres: [1.15, 2.6] });
    this._put('glassStorefront', storefront);

    // Reflective-coated curtain wall. A pure dielectric reflects 4% head-on and
    // reads as a black hole in daylight; the metallic term stands in for the
    // coating, which is what makes a tower's glazing a mirror of the sky. That
    // only works if the colour is the COATING's reflectance — see GLAZING.
    const tinted = new THREE.MeshStandardMaterial({
      color: GLAZING.coatedColor, normalMap: grime,
      normalScale: new THREE.Vector2(GLAZING.normalScale, GLAZING.normalScale),
      roughness: GLAZING.coatedRoughness, metalness: GLAZING.coatedMetalness,
      envMapIntensity: 2.2,
    });
    applyPackedRoughness(tinted);
    applyGlazing(tinted, { interior: 0.22, jitter: 0.14 });
    applyGlazingEnv(tinted);
    this._put('glassTinted', tinted);

    const mc = makeCanvas(D);
    const mg = mc.getContext('2d', { willReadFrequently: true });
    mg.fillStyle = '#c8c8c8'; mg.fillRect(0, 0, D, D);
    drawField(mg, D, 32, fbm(32, 4, 3, rand), greyField(0.72, 1.0), 0.5, 'multiply');
    speckle(mg, D, 900, rand, (r, o) => {
      o[0] = 150 + r * 70; o[1] = 146 + r * 66; o[2] = 140 + r * 62; o[3] = 0.1 + r * 0.3;
    }, 2.2);
    const metalAlbedo = new THREE.CanvasTexture(mc);
    metalAlbedo.wrapS = metalAlbedo.wrapT = THREE.RepeatWrapping;
    metalAlbedo.colorSpace = THREE.SRGBColorSpace;
    metalAlbedo.repeat.set(2, 2);
    this._track(metalAlbedo, D, D);

    // Paint is a dielectric, so painted steel is NOT metallic: giving it
    // metalness with a dark colour drops F0 to nothing and the lamp posts
    // render as black cutouts in full sun. Only bare metal is metallic, and
    // bare metal needs a bright colour because that colour IS its F0.
    this._put('metalPainted', new THREE.MeshStandardMaterial({
      map: metalAlbedo, color: 0x33423b, roughness: 0.38, metalness: 0.0, envMapIntensity: 1.0,
    }));
    this._put('metalGalvanised', new THREE.MeshStandardMaterial({
      map: metalAlbedo, color: 0xc6cacc, roughness: 0.44, metalness: 1.0, envMapIntensity: 1.2,
    }));
    this._put('metalAnodised', new THREE.MeshStandardMaterial({
      map: metalAlbedo, color: 0xa8adb2, roughness: 0.26, metalness: 1.0, envMapIntensity: 1.3,
    }));
  }

  // -------------------------------------------------------------- public API
  /** Any material by registry key. Throws rather than silently returning grey. */
  get(key) {
    // The marking atlas is the one lazily-built entry: nothing in the district
    // samples it any more, and building it eagerly cost every load 7-9 ms and
    // every GPU 2.67 MB for a texture only the material lab looks at.
    if (key === 'roadMarkings' && !this._materials.has(key)) {
      this._phase('markings', () => this._buildMarkings());
    }
    const m = this._materials.get(key);
    if (!m) throw new Error(`no material "${key}" — have: ${[...this._materials.keys()].join(', ')}`);
    return m;
  }

  /** Every key currently realised, for a lab page or an audit. */
  keys() { return [...this._materials.keys()]; }

  /**
   * Drop-in for StreamingWorld's `opts.materials`. `building` is the same merged
   * material at both LODs — the far LOD keeps the texture so a block does not
   * change colour when it swaps. There is deliberately no separate `markings`
   * entry: `road` paints the lane atlas in its own shader, so a chunk's roads
   * stay one opaque draw call.
   */
  streamingMaterials() {
    const merged = this.buildingMerged();
    return {
      building: [merged, merged],
      road: this.get('road'),
      land: this.get('land'),
      // A downtown's unbuilt ground is paving, not soil. 'land' stays available
      // for genuinely bare areas.
      ground: this.get('sidewalk') ?? this.get('concrete') ?? this.get('land'),
      water: this.get('water'),
    };
  }

  /** Advance animated materials. Only water uses it today. */
  update(dt) { this.time.value += dt; }

  report() {
    const layers = this._textures.reduce((n, t) => n + (t.isDataArrayTexture ? t.image.depth : 1), 0);
    return {
      materials: this._materials.size,
      textures: this._textures.length,
      textureLayers: layers,
      textureMemoryMB: +(this._bytes / (1024 * 1024)).toFixed(2),
      generationMs: +this.generationMs.toFixed(1),
      surfaceLayers: SURFACE_LAYERS.length,
      timingsMs: this.timings,
      keys: this.keys(),
    };
  }

  dispose() {
    for (const t of this._textures) t.dispose();
    for (const m of this._materials.values()) m.dispose();
    this._textures.length = 0;
    this._materials.clear();
  }
}

// One registry per page. Generation is ~O(100 ms) and must happen behind the
// loading screen, so a second caller must never trigger a second build.
let singleton = null;

/** The memoised registry. Pass opts only on the first call. */
export function getMaterials(opts) {
  if (!singleton) singleton = new MaterialRegistry(opts);
  return singleton;
}

export function disposeMaterials() {
  if (singleton) { singleton.dispose(); singleton = null; }
}

// ---------------------------------------------------------------- small helpers
const TAU = Math.PI * 2;

function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 8;
}

function flipRows(px, w, h) {
  const row = w * 4, tmp = new Uint8ClampedArray(row);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * row, b = (h - 1 - y) * row;
    tmp.set(px.subarray(a, a + row));
    px.copyWithin(a, b, b + row);
    px.set(tmp, b);
  }
}

function copyFlipped(src, dst, dstOffset, w, h) {
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    dst.set(src.subarray((h - 1 - y) * row, (h - y) * row), dstOffset + y * row);
  }
}
