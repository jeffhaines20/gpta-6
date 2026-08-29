// Port Verano's production material library. Everything here is drawn into a
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

// Blit a tileable field across a canvas. The field is emitted at (n+1)² with the
// last row/column duplicating the first, then drawn half a lattice cell to the
// left and up — that makes the browser's bilinear upscale land node 0 on pixel 0
// and node n on pixel size, so the blown-up noise wraps exactly.
function drawField(g, size, n, field, colorAt, alpha = 1, composite = 'source-over') {
  const src = makeCanvas(n + 1);
  const sg = src.getContext('2d');
  const img = sg.createImageData(n + 1, n + 1);
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const v = field[(y % n) * n + (x % n)];
      const i = (y * (n + 1) + x) * 4;
      colorAt(v, img.data, i);
    }
  }
  sg.putImageData(img, 0, 0);
  const s = (size * (n + 1)) / n, off = -0.5 * (size / n);
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = composite;
  g.drawImage(src, off, off, s, s);
  g.restore();
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

function speckle(g, size, count, rand, colorAt, maxR = 2.4) {
  for (let i = 0; i < count; i++) {
    const x = rand() * size, y = rand() * size, r = 0.6 + rand() * maxR;
    g.fillStyle = colorAt(rand());
    if (x < r || y < r || x > size - r || y > size - r) {
      wrapped(g, size, x, y, r + 1, (c) => c.fillRect(-r / 2, -r / 2, r, r));
    } else {
      g.fillRect(x - r / 2, y - r / 2, r, r);
    }
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
    g.fillStyle = '#43464b'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.25, 0.75), 0.30, 'overlay');
    // Aggregate. Real asphalt reads as thousands of 1-2 cm stones in a dark binder.
    speckle(g, S, 9000, rand, (r) => {
      const v = 52 + r * 92;
      return `rgba(${v},${v + 2},${v + 6},${0.20 + r * 0.45})`;
    }, 2.6);
    speckle(g, S, 900, rand, (r) => `rgba(${140 + r * 60},${128 + r * 55},${110 + r * 45},0.35)`, 2.0);
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
    speckle(g, S, 4500, rand, (r) => `rgba(255,255,255,${0.10 + r * 0.28})`, 1.6);
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

const sidewalkSurface = {
  tile: 3, albedo: 512, detail: 256, normalStrength: 2.2,
  // Two 1.5 m slabs per axis: the standard 5 ft pour, which is what makes a
  // sidewalk read as a sidewalk from a car window.
  paintAlbedo(g, S, rand) {
    const half = S / 2;
    for (let sy = 0; sy < 2; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const l = 66 + rand() * 8;
        g.fillStyle = hsl(38, 7, l);
        g.fillRect(sx * half, sy * half, half, half);
      }
    }
    drawField(g, S, 64, fbm(64, 8, 3, rand), greyField(0.35, 0.72), 0.34, 'overlay');
    speckle(g, S, 7000, rand, (r) => `rgba(${170 + r * 60},${166 + r * 58},${152 + r * 55},${0.10 + r * 0.22})`, 1.8);
    // Joints, then the dirt that collects in them.
    g.strokeStyle = 'rgba(74,70,63,0.55)'; g.lineWidth = 2.6;
    for (const p of [0, half]) {
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    g.strokeStyle = 'rgba(58,52,44,0.16)'; g.lineWidth = 11;
    for (const p of [0, half]) {
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    for (let i = 0; i < 3; i++) {                            // hairline cracking
      g.strokeStyle = 'rgba(70,64,56,0.42)'; g.lineWidth = 1.2;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 70, 10, rand);
    }
    for (let i = 0; i < 14; i++) {                           // flattened gum
      const x = rand() * S, y = rand() * S, r = 2 + rand() * 4;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = `rgba(58,55,50,${0.25 + rand() * 0.3})`;
        c.beginPath(); c.ellipse(0, 0, r, r * 0.85, rand() * TAU, 0, TAU); c.fill();
      });
    }
  },
  paintHeight(g, S, rand) {
    const half = S / 2;
    g.fillStyle = '#909090'; g.fillRect(0, 0, S, S);
    for (let sy = 0; sy < 2; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const grd = g.createRadialGradient(
          sx * half + half / 2, sy * half + half / 2, 0,
          sx * half + half / 2, sy * half + half / 2, half * 0.8);
        grd.addColorStop(0, 'rgba(255,255,255,0.30)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd; g.fillRect(sx * half, sy * half, half, half);
      }
    }
    drawField(g, S, 64, fbm(64, 8, 3, rand), greyField(0.4, 0.6), 0.5);
    g.strokeStyle = '#141414'; g.lineWidth = 3.2;
    for (const p of [0, half]) {
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    for (let i = 0; i < 3; i++) {
      g.strokeStyle = 'rgba(20,20,20,0.7)'; g.lineWidth = 1.2;
      seamlessStroke(g, S, rand() < 0.5 ? 'x' : 'y', rand() * S, 70, 10, rand);
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#ebebeb'; g.fillRect(0, 0, S, S);
    drawField(g, S, 64, fbm(64, 8, 3, rand), greyField(0.72, 1.0), 0.5);
  },
};

const concreteSurface = {
  tile: 3, albedo: 512, detail: 256, normalStrength: 1.6,
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(36, 6, 64); g.fillRect(0, 0, S, S);
    drawField(g, S, 48, fbm(48, 6, 4, rand), greyField(0.3, 0.8), 0.36, 'overlay');
    speckle(g, S, 5000, rand, (r) => `rgba(${160 + r * 70},${156 + r * 66},${146 + r * 60},${0.08 + r * 0.2})`, 1.6);
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
  tile: 10.8, albedo: 512, detail: 256, normalStrength: 1.0,
  paintAlbedo(g, S, rand) {
    g.fillStyle = '#474a4f'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.28, 0.72), 0.34, 'overlay');
    speckle(g, S, 6000, rand, (r) => {
      const v = 56 + r * 80;
      return `rgba(${v},${v + 2},${v + 6},${0.16 + r * 0.34})`;
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
    g.globalAlpha = 0.55;
    speckle(g, S, 2400, rand, () => '#474a4f', 3.4);
    g.globalAlpha = 1;
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.36, 0.64), 0.8);
    speckle(g, S, 3000, rand, (r) => `rgba(255,255,255,${0.08 + r * 0.22})`, 1.4);
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
  tile: 4, albedo: 512, detail: 256, normalStrength: 1.1,
  // St Augustine turf: coarse, blue-green, and patchy where it burns off.
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(92, 26, 30); g.fillRect(0, 0, S, S);
    drawField(g, S, 24, fbm(24, 3, 3, rand), (v, d, i) => {
      d[i] = 110 + v * 70; d[i + 1] = 130 + v * 60; d[i + 2] = 60 + v * 40; d[i + 3] = 255;
    }, 0.5, 'overlay');
    for (let i = 0; i < 14000; i++) {
      const x = rand() * S, y = rand() * S, a = rand() * TAU, len = 3 + rand() * 6;
      const h = 78 + rand() * 34, s = 22 + rand() * 26, l = 20 + rand() * 24;
      g.strokeStyle = hsl(h, s, l, 0.5 + rand() * 0.4);
      g.lineWidth = 1 + rand() * 0.8;
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
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
    speckle(g, S, 5000, rand, (r) => `rgba(255,255,255,${0.1 + r * 0.3})`, 2.2);
  },
  paintRough: null,
  roughness: 0.94,
};

const dirtSurface = {
  tile: 4, albedo: 512, detail: 256, normalStrength: 1.5,
  paintAlbedo(g, S, rand) {
    g.fillStyle = hsl(32, 22, 40); g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 4, rand), (v, d, i) => {
      d[i] = 120 + v * 74; d[i + 1] = 98 + v * 62; d[i + 2] = 70 + v * 48; d[i + 3] = 255;
    }, 0.72, 'overlay');
    speckle(g, S, 5200, rand, (r) => `rgba(${150 + r * 70},${126 + r * 58},${96 + r * 46},${0.12 + r * 0.3})`, 2.6);
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
  tile: 6, albedo: 512, detail: 256, normalStrength: 1.0,
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
    speckle(g, S, 5000, rand, (r) => `rgba(${226 + r * 24},${212 + r * 24},${186 + r * 30},${0.1 + r * 0.24})`, 1.4);
    speckle(g, S, 260, rand, () => 'rgba(252,250,244,0.85)', 2.2);   // shell fragments
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
    drawField(g, S, 24, fbm(24, 3, 3, rand), greyField(0.62, 1.0), 0.55, 'multiply');
    drawField(g, S, 96, fbm(96, 12, 3, rand), greyField(0.80, 1.0), 0.40, 'multiply');
    speckle(g, S, 6000, rand, (r) => `rgba(${196 + r * 50},${190 + r * 50},${178 + r * 50},${0.06 + r * 0.14})`, 1.6);
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
    drawField(g, S, 64, fbm(64, 8, 2, rand), greyField(0.7, 1.0), 0.4, 'multiply');
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
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.72, 1.0), 0.34, 'multiply');
    speckle(g, S, 4000, rand, (r) => `rgba(${190 + r * 60},${186 + r * 58},${176 + r * 54},${0.05 + r * 0.14})`, 1.4);
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
    speckle(g, S, 3500, rand, (r) => `rgba(${180 + r * 60},${176 + r * 56},${164 + r * 52},${0.06 + r * 0.14})`, 1.4);
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
  uvTile: 3, normalStrength: 2.6,
  paintAlbedo(g, S, rand) {
    const rows = 10, rh = S / rows, gap = Math.max(2.5, S / 170);
    g.fillStyle = '#3a2a20'; g.fillRect(0, 0, S, S);      // shadow behind the joint
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      const h = 20 + (rand() - 0.5) * 6, l = 62 + (rand() - 0.5) * 12;
      const grd = g.createLinearGradient(0, y, 0, y + rh - gap);
      grd.addColorStop(0, hsl(h, 34, l + 6));
      grd.addColorStop(0.75, hsl(h, 32, l));
      grd.addColorStop(1, hsl(h, 30, l - 10));
      g.fillStyle = grd;
      g.fillRect(0, y, S, rh - gap);
      g.fillStyle = `rgba(255,236,214,${0.10 + rand() * 0.08})`;   // top arris
      g.fillRect(0, y, S, 2);
    }
    drawField(g, S, 48, fbm(48, 6, 3, rand), greyField(0.7, 1.0), 0.35, 'multiply');
    speckle(g, S, 3200, rand, (r) => `rgba(${200 + r * 46},${164 + r * 44},${132 + r * 40},${0.06 + r * 0.16})`, 1.4);
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
    speckle(g, S, 5000, rand, (r) => `rgba(${196 + r * 50},${192 + r * 48},${182 + r * 46},${0.05 + r * 0.14})`, 1.8);
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
    speckle(g, S, 2600, rand, (r) => `rgba(${140 + r * 60},${140 + r * 58},${130 + r * 56},${0.06 + r * 0.16})`, 1.6);
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
  uvTile: 0.75, normalStrength: 2.8,
  paintAlbedo(g, S, rand) {
    const cols = 15, rows = 7, cw = S / cols, rh = S / rows;
    g.fillStyle = '#8a4a2c'; g.fillRect(0, 0, S, S);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw, y = r * rh;
        const h = 16 + (rand() - 0.5) * 12, l = 44 + (rand() - 0.5) * 16;
        const grd = g.createLinearGradient(x, 0, x + cw, 0);
        grd.addColorStop(0, hsl(h, 40, l - 14));
        grd.addColorStop(0.35, hsl(h, 46, l + 12));
        grd.addColorStop(0.75, hsl(h, 44, l));
        grd.addColorStop(1, hsl(h, 38, l - 20));
        g.fillStyle = grd;
        g.fillRect(x, y, cw, rh);
        g.fillStyle = 'rgba(30,16,10,0.5)';                // course shadow line
        g.fillRect(x, y, cw, Math.max(2, rh * 0.07));
      }
    }
    for (let i = 0; i < 26; i++) {                         // lichen
      const x = rand() * S, y = rand() * S, r = 3 + rand() * 12;
      wrapped(g, S, x, y, r + 1, (c) => {
        c.fillStyle = `rgba(${140 + rand() * 50},${146 + rand() * 40},${112 + rand() * 40},${0.15 + rand() * 0.28})`;
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
    for (let i = 0; i < 5200; i++) {                       // ballast
      const x = rand() * S, y = rand() * S, r = 1.6 + rand() * 3.6;
      const v = 96 + rand() * 96, warm = rand() * 22;
      g.fillStyle = `rgba(${v + warm},${v + warm * 0.6},${v * 0.92},${0.5 + rand() * 0.45})`;
      if (x < r + 1 || y < r + 1 || x > S - r - 1 || y > S - r - 1) {
        wrapped(g, S, x, y, r + 1, (c) => { c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); });
      } else { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
    }
  },
  paintHeight(g, S, rand) {
    g.fillStyle = '#4a4a4a'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 5200; i++) {
      const x = rand() * S, y = rand() * S, r = 1.6 + rand() * 3.6;
      const v = 150 + rand() * 100;
      g.fillStyle = `rgb(${v},${v},${v})`;
      if (x < r + 1 || y < r + 1 || x > S - r - 1 || y > S - r - 1) {
        wrapped(g, S, x, y, r + 1, (c) => { c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); });
      } else { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
    }
  },
  paintRough(g, S, rand) {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, S, S);
    drawField(g, S, 32, fbm(32, 4, 3, rand), greyField(0.86, 1.0), 0.5);
  },
};

// Order is the texture-array layer order and is part of the public contract:
// a merged chunk geometry writes these indices into its `aLayer` attribute.
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
// a chunk into ONE geometry, so a stripe would be a draw call per edge. Instead
// the atlas is a row of full-height COLUMNS, each column a road cross-section.
// The ribbon's u (0..1 across the ribbon, whatever its width) selects a position
// in the profile and v (metres/8) runs up the column, so wrapT can repeat freely
// while wrapS clamps. Remapping u/v into a column is a pure arithmetic pass over
// the merged UV array — see applyMarkingUV.
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
const MARKING_GUARD = 0.035;   // transparent margin so mip levels bleed nothing

const WHITE = 'rgba(240,238,228,';
const YELLOW = 'rgba(232,186,58,';

function paintMarkingAtlas(rand) {
  const W = MARKING_COLUMNS * MARKING_COL_PX, H = MARKING_H_PX;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);

  // Paint is never crisp on a real street: scrub it with the wear mask so the
  // markings read as maintained-in-2009 rather than decal-stamped.
  const wear = (x0, w) => {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 900; i++) {
      const x = x0 + rand() * w, y = rand() * H, r = 1 + rand() * 4;
      g.fillStyle = `rgba(0,0,0,${0.15 + rand() * 0.5})`;
      g.fillRect(x, y, r, r * (0.6 + rand()));
    }
    g.restore();
  };
  const col = (i) => i * MARKING_COL_PX;

  // Wheel polish and kerbside grime: dark, wide, low alpha. They ride in the
  // marking layer because they vary ACROSS the road, which is exactly what the
  // column addresses — a tiling asphalt texture cannot express them.
  const carriageway = (x0, lanes) => {
    g.fillStyle = 'rgba(28,28,30,0.20)';
    g.fillRect(x0, 0, 10, H); g.fillRect(x0 + MARKING_COL_PX - 10, 0, 10, H);
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
    g.fillRect(x0 + 9, 0, w, H);
    g.fillRect(x0 + MARKING_COL_PX - 9 - w, 0, w, H);
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
    for (let i = 0; i < 8; i++) g.fillRect(x0 + 8 + i * 30, 0, 17, H);
    wear(x0, MARKING_COL_PX);
  }
  // 5: stop bar. One bar per column, so the caller scales v to the segment.
  {
    const x0 = col(5);
    g.fillStyle = WHITE + '0.86)';
    g.fillRect(x0 + 9, H * 0.10, MARKING_COL_PX - 18, H * 0.09);
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

/**
 * Rewrite a slice of a merged road ribbon's UV array so those vertices sample one
 * marking column. Operates in place on the flat [u,v,u,v,...] array that
 * geom.js `ribbon` fills, so a chunk builder records the vertex range each edge
 * contributed and calls this once per edge — no extra geometry, no extra material.
 *
 * @param {number[]|Float32Array} uv  the merged uv array
 * @param {number} vertexStart        first vertex index this edge wrote
 * @param {number} vertexCount        how many vertices it wrote
 * @param {number} marking            a MARKINGS value
 * @param {object} [opts]
 * @param {number} [opts.vRepeat=1]   multiply v; ribbon v is already metres/8, so
 *                                    1 puts one 8 m marking period on 8 m of road
 * @param {number} [opts.vOffset=0]   added after vRepeat, to phase dashes
 * @param {boolean} [opts.flipU]      mirror the profile (right-turn arrow)
 */
export function applyMarkingUV(uv, vertexStart, vertexCount, marking, opts = {}) {
  const { vRepeat = 1, vOffset = 0, flipU = false } = opts;
  const span = 1 / MARKING_COLUMNS;
  const lo = (marking + MARKING_GUARD) * span;
  const width = span * (1 - 2 * MARKING_GUARD);
  for (let i = vertexStart; i < vertexStart + vertexCount; i++) {
    const p = i * 2;
    const u = flipU ? 1 - uv[p] : uv[p];
    uv[p] = lo + u * width;
    uv[p + 1] = uv[p + 1] * vRepeat + vOffset;
  }
}

/**
 * Pick a marking profile for a baked road edge. Keeps the choice in one place so
 * the streamer and the traffic system agree about what a road looks like.
 * @param {{w:number,lanes:number,o:number,c:string}} edge
 */
export function markingForEdge(edge) {
  if (edge.c === 'service' || edge.w < 5) return MARKINGS.none;
  if (edge.lanes >= 4 || edge.w >= 12) return MARKINGS.lane4;
  if (edge.o !== 0) return MARKINGS.none;          // one-way: no centre line
  return edge.c === 'primary' || edge.c === 'secondary' ? MARKINGS.lane2solid : MARKINGS.lane2;
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
function patch(material, tag, fn) {
  const tags = material.userData.veranoTags || (material.userData.veranoTags = []);
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
  vec2 veranoPlanarUv = ( modelMatrix * vec4( transformed, 1.0 ) ).xz * uPlanarScale;
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
  normal = normalize( tbn * mapN );`);
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
  mat3 veranoTbn = mat3(
    normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz ),
    normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz ),
    normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
  normal = normalize( veranoTbn * mapN );`);
  });
}

// ---------------------------------------------------------------- registry
export class MaterialRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.anisotropy=8]  pass renderer.capabilities.getMaxAnisotropy()
   * @param {number} [opts.seed=1337]     changes every texture; keep it fixed in the game
   */
  constructor(opts = {}) {
    const t0 = performance.now();
    this.anisotropy = opts.anisotropy ?? 8;
    this.seed = opts.seed ?? 1337;
    this._materials = new Map();
    this._textures = [];
    this._bytes = 0;
    this.time = { value: 0 };

    this._buildSurfaceArray();
    this._buildGround();
    this._buildMarkings();
    this._buildWater();
    this._buildGlassAndMetal();

    this.generationMs = performance.now() - t0;
  }

  // -------------------------------------------------------------- book-keeping
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
    surface.paintAlbedo(albedoCanvas.getContext('2d'), A, mulberry32(seed));
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
    flipRows(px, D, D);      // DataTexture has flipY off; CanvasTexture has it on
    const normal = new THREE.DataTexture(px, D, D, THREE.RGBAFormat);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.minFilter = THREE.LinearMipmapLinearFilter;
    normal.magFilter = THREE.LinearFilter;
    normal.generateMipmaps = true;
    normal.needsUpdate = true;
    this._track(normal, D, D);
    return { albedo, normal, packedRough: !!rough };
  }

  _groundMaterial(key, surface, extra = {}) {
    const maps = this._groundMaps(key, surface);
    const m = new THREE.MeshStandardMaterial({
      map: maps.albedo,
      normalMap: maps.normal,
      normalScale: new THREE.Vector2(1, 1),
      roughness: surface.roughness ?? 1,
      metalness: 0.0,
      ...extra,
    });
    applyPlanarUV(m, 1 / (extra.tileMetres ?? surface.tile));
    if (maps.packedRough) applyPackedRoughness(m);
    delete m.tileMetres;
    return this._put(key, m);
  }

  _buildGround() {
    this._groundMaterial('road', asphaltSurface);
    this._groundMaterial('sidewalk', sidewalkSurface);
    this._groundMaterial('parkingLot', parkingSurface);
    this._groundMaterial('grass', grassSurface);
    this._groundMaterial('dirt', dirtSurface);
    this._groundMaterial('sand', sandSurface);

    // Kerbs are vertical faces as much as horizontal ones, so they keep mesh UVs
    // and a plain repeat instead of the world-planar patch.
    const maps = this._groundMaps('concrete', concreteSurface);
    maps.albedo.repeat.set(1 / concreteSurface.tile, 1 / concreteSurface.tile);
    maps.normal.repeat.copy(maps.albedo.repeat);
    const kerb = new THREE.MeshStandardMaterial({
      map: maps.albedo, normalMap: maps.normal, color: 0xd8d4cb,
      roughness: 1, metalness: 0,
    });
    applyPackedRoughness(kerb);
    this._put('kerb', kerb);

    const painted = kerb.clone();
    painted.color.setHex(0xe8b53a);       // faded yellow kerb paint over concrete
    painted.roughness = 0.86;
    applyPackedRoughness(painted);
    this._put('kerbPainted', painted);

    const concrete = kerb.clone();
    concrete.color.setHex(0xc4c0b6);
    applyPackedRoughness(concrete);
    this._put('concrete', concrete);

    // The district's land pad: bare urban ground between roads and footprints.
    const land = this._materials.get('dirt').clone();
    land.color.setHex(0x9fa08c);
    applyPlanarUV(land, 1 / 7);
    applyPackedRoughness(land);
    this._put('land', land);
  }

  // -------------------------------------------------------------- markings
  _buildMarkings() {
    const canvas = paintMarkingAtlas(mulberry32(this.seed + 4001));
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.ClampToEdgeWrapping;     // columns must not bleed into each other
    t.wrapT = THREE.RepeatWrapping;          // ...but the profile repeats along the road
    t.colorSpace = THREE.SRGBColorSpace;
    this._track(t, canvas.width, canvas.height);
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
      const ad = ac.getContext('2d').getImageData(0, 0, A, A).data;
      copyFlipped(ad, albedoData, i * A * A * 4, A, A);

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
      map: this._stub, normalMap: this._stub, roughnessMap: this._stub,
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
    const px = sobelNormalRough(luminanceField(hc, D), null, D, 1.4);
    flipRows(px, D, D);
    const normal = new THREE.DataTexture(px, D, D, THREE.RGBAFormat);
    normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
    normal.minFilter = THREE.LinearMipmapLinearFilter;
    normal.generateMipmaps = true;
    normal.needsUpdate = true;
    this._track(normal, D, D);

    // Verano Bay is shallow Gulf water over sand: green, not navy, and it is the
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
    const px = sobelNormalRough(luminanceField(hc, D), luminanceField(rc, D), D, 0.6);
    flipRows(px, D, D);
    const grime = new THREE.DataTexture(px, D, D, THREE.RGBAFormat);
    grime.wrapS = grime.wrapT = THREE.RepeatWrapping;
    grime.minFilter = THREE.LinearMipmapLinearFilter;
    grime.generateMipmaps = true;
    grime.needsUpdate = true;
    grime.repeat.set(0.5, 0.5);
    this._track(grime, D, D);

    // Two glazing options on purpose. `glassTinted` is opaque and therefore
    // mergeable and sortable-free; use it for anything that ships in a chunk.
    const storefront = new THREE.MeshStandardMaterial({
      color: 0xa9c2bd, normalMap: grime, normalScale: new THREE.Vector2(0.35, 0.35),
      roughness: 1, metalness: 0.02, transparent: true, opacity: 0.32,
      envMapIntensity: 2.0, side: THREE.DoubleSide,
    });
    applyPackedRoughness(storefront);
    this._put('glassStorefront', storefront);

    const tinted = new THREE.MeshStandardMaterial({
      color: 0x1d262b, normalMap: grime, normalScale: new THREE.Vector2(0.35, 0.35),
      roughness: 1, metalness: 0.12, envMapIntensity: 2.4,
    });
    applyPackedRoughness(tinted);
    this._put('glassTinted', tinted);

    const mc = makeCanvas(D);
    const mg = mc.getContext('2d');
    mg.fillStyle = '#c8c8c8'; mg.fillRect(0, 0, D, D);
    drawField(mg, D, 32, fbm(32, 4, 3, rand), greyField(0.72, 1.0), 0.5, 'multiply');
    speckle(mg, D, 900, rand, (r) => `rgba(${150 + r * 70},${146 + r * 66},${140 + r * 62},${0.1 + r * 0.3})`, 2.2);
    const metalAlbedo = new THREE.CanvasTexture(mc);
    metalAlbedo.wrapS = metalAlbedo.wrapT = THREE.RepeatWrapping;
    metalAlbedo.colorSpace = THREE.SRGBColorSpace;
    metalAlbedo.repeat.set(2, 2);
    this._track(metalAlbedo, D, D);

    this._put('metalPainted', new THREE.MeshStandardMaterial({
      map: metalAlbedo, color: 0x2c3a34, roughness: 0.42, metalness: 0.55, envMapIntensity: 1.2,
    }));
    this._put('metalGalvanised', new THREE.MeshStandardMaterial({
      map: metalAlbedo, color: 0x9aa0a2, roughness: 0.52, metalness: 0.9, envMapIntensity: 1.2,
    }));
    this._put('metalAnodised', new THREE.MeshStandardMaterial({
      map: metalAlbedo, color: 0x6e7276, roughness: 0.28, metalness: 0.92, envMapIntensity: 1.4,
    }));
  }

  // -------------------------------------------------------------- public API
  /** Any material by registry key. Throws rather than silently returning grey. */
  get(key) {
    const m = this._materials.get(key);
    if (!m) throw new Error(`no material "${key}" — have: ${[...this._materials.keys()].join(', ')}`);
    return m;
  }

  /** Every key currently realised, for a lab page or an audit. */
  keys() { return [...this._materials.keys()]; }

  /**
   * Drop-in for StreamingWorld's `opts.materials`. `building` is the same merged
   * material at both LODs — the far LOD keeps the texture so a block does not
   * change colour when it swaps.
   */
  streamingMaterials() {
    const merged = this.buildingMerged();
    return {
      building: [merged, merged],
      road: this.get('road'),
      land: this.get('land'),
      water: this.get('water'),
      markings: this.get('roadMarkings'),
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
