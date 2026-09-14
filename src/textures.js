// UNUSED. Nothing in src/ or district/ imports this file — it is referenced only
// from comments in signage.js and materials.js. Whatever ships the asphalt,
// pavement and facade surfaces, it is not this.
//
// Recorded here because I claimed the opposite in a commit: that its fifteen
// unseeded draws were "painting the grime, the cracks and the LIT WINDOWS on
// every page load" and were why two runs of identical code differed most at
// night. They cannot have been. The file is dead, the seeding below changes no
// pixel, and the real cause of that residual is still open.
//
// Kept and seeded anyway rather than deleted: deleting a file on the strength of
// "grep found no importer" is a bigger claim than this session has earned, and
// if it is ever wired up it should be deterministic from the first frame.
// Every texture in this project is drawn into a canvas at runtime. No image
// files, no downloads. These generators are the seed of the Phase 2 material
// library; they are cached by key so a district can reuse a few dozen atlases.

import * as THREE from '../vendor/three.module.min.js';
import { rng, hash32 } from './facades.js';

const cache = new Map();
function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}
function tex(c, repeat = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// The stream every generator in this file draws from. Re-seeded FROM THE MEMO
// KEY before each build, so a texture is a pure function of its key and two page
// loads paint the same grime, the same cracks and the same lit windows.
//
// Fifteen unseeded draws lived here, and they were the largest remaining source
// of non-determinism after traffic and pedestrians were seeded. Two runs of
// identical code still differed on 0.365% of bytes at corridor-noon and 7.786%
// at fivepoints-night; the night figures are the larger ones because
// `isLit = night && random() < lit` re-rolls WHICH WINDOWS ARE ON on every load.
//
// Every generator here goes through memo() and every noiseCanvas() call sits
// inside one, so seeding here covers the file. If a builder is ever added that
// bypasses memo, it will draw from whichever key was seeded last -- so add it
// through memo, or give it its own stream.
let _r = rng(hash32('tex', 'boot'));

function memo(key, fn) {
  if (!cache.has(key)) {
    _r = rng(hash32('tex', key));
    cache.set(key, fn());
  }
  return cache.get(key);
}

// Value noise: cheap, seedable, and good enough for grain and grime.
function noiseCanvas(size, scale, contrast = 1) {
  const [c, g] = canvas(size);
  const img = g.createImageData(size, size);
  const grid = Math.max(2, Math.floor(size / scale));
  const rnd = new Float32Array(grid * grid);
  for (let i = 0; i < rnd.length; i++) rnd[i] = _r();
  const at = (x, y) => rnd[(y % grid) * grid + (x % grid)];
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, freq = grid / size;
      for (let o = 0; o < 4; o++) {
        const fx = x * freq, fy = y * freq;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = smooth(fx - x0), ty = smooth(fy - y0);
        const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        v += amp * ((a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty);
        amp *= 0.5; freq *= 2;
      }
      v = Math.min(1, Math.max(0, (v - 0.5) * contrast + 0.5));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// --- Asphalt: aggregate speckle, tar seams, tyre-polished wheel tracks.
export function asphalt() {
  return memo('asphalt', () => {
    const S = 512, [c, g] = canvas(S);
    g.fillStyle = '#3a3d42'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 26000; i++) {
      const v = 30 + _r() * 80;
      g.fillStyle = `rgba(${v},${v + 2},${v + 5},${0.15 + _r() * 0.5})`;
      g.fillRect(_r() * S, _r() * S, 1 + _r() * 2.2, 1 + _r() * 2.2);
    }
    g.globalAlpha = 0.35;
    g.drawImage(noiseCanvas(S, 48, 1.5), 0, 0, S, S);
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(20,20,22,0.55)'; g.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      let y = _r() * S;
      g.moveTo(0, y);
      for (let x = 0; x <= S; x += 32) { y += (_r() - 0.5) * 14; g.lineTo(x, y); }
      g.stroke();
    }
    return c;
  });
}

// --- Roughness map for wet road: puddles are smooth, dry patches are rough.
export function wetRoughness() {
  return memo('wetRough', () => {
    const S = 512, [c, g] = canvas(S);
    g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, S, S);
    g.globalAlpha = 0.9;
    g.drawImage(noiseCanvas(S, 26, 2.6), 0, 0, S, S);
    g.globalAlpha = 1;
    // Dark = smooth = mirror-like puddles.
    for (let i = 0; i < 22; i++) {
      const x = _r() * S, y = _r() * S, r = 18 + _r() * 70;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(10,10,10,0.95)');
      grad.addColorStop(0.7, 'rgba(40,40,40,0.5)');
      grad.addColorStop(1, 'rgba(200,200,200,0)');
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(x, y, r, r * (0.4 + _r() * 0.5), _r() * 3, 0, 7); g.fill();
    }
    return c;
  });
}

// --- Concrete sidewalk with expansion joints and staining.
export function sidewalk() {
  return memo('sidewalk', () => {
    const S = 512, [c, g] = canvas(S);
    g.fillStyle = '#9a978f'; g.fillRect(0, 0, S, S);
    g.globalAlpha = 0.45; g.drawImage(noiseCanvas(S, 40, 1.4), 0, 0, S, S); g.globalAlpha = 1;
    for (let i = 0; i < 9000; i++) {
      const v = 110 + _r() * 90;
      g.fillStyle = `rgba(${v},${v - 3},${v - 10},${0.1 + _r() * 0.25})`;
      g.fillRect(_r() * S, _r() * S, 1.5, 1.5);
    }
    g.strokeStyle = 'rgba(60,58,55,0.55)'; g.lineWidth = 2.5;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * S;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    // Dirt collecting along the joints — the detail that sells "real".
    g.strokeStyle = 'rgba(50,45,38,0.22)'; g.lineWidth = 7;
    for (let i = 0; i <= 4; i++) {
      const p = (i / 4) * S;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    return c;
  });
}

// --- Building facade atlas. One canvas holds a whole tower's window grid:
//     floors, mullions, spandrel panels, per-window lit/unlit state and blinds.
//
//     Albedo and emissive mask are produced in ONE pass. Deriving the mask
//     afterwards by scanning pixels cost 2088 ms per 1024px texture (a 1M-iteration
//     getImageData loop); drawing lit windows to a second context as we go is
//     effectively free and cannot drift out of sync with the albedo.
function buildFacade(opts) {
  const {
    cols = 6, rows = 8, lit = 0.35, hue = 32, sat = 8, light = 46,
    warm = '255,214,150', night = true,
  } = opts;
  const S = 1024;
  const [c, g] = canvas(S);      // albedo
  const [e, eg] = canvas(S);     // emissive mask
  const cw = S / cols, ch = S / rows;

  g.fillStyle = `hsl(${hue},${sat}%,${light}%)`; g.fillRect(0, 0, S, S);
  g.globalAlpha = 0.35; g.drawImage(noiseCanvas(S, 64, 1.3), 0, 0, S, S); g.globalAlpha = 1;
  eg.fillStyle = '#000'; eg.fillRect(0, 0, S, S);

  for (let r = 0; r < rows; r++) {
    g.fillStyle = `hsl(${hue},${sat}%,${light - 9}%)`;
    g.fillRect(0, r * ch + ch * 0.74, S, ch * 0.26);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, r * ch + ch * 0.72, S, 2);

    for (let cI = 0; cI < cols; cI++) {
      const x = cI * cw + cw * 0.16, y = r * ch + ch * 0.12;
      const w = cw * 0.68, h = ch * 0.58;
      const isLit = night && _r() < lit;

      if (isLit) {
        const a = 0.55 + _r() * 0.45;
        const gr = g.createLinearGradient(x, y, x, y + h);
        gr.addColorStop(0, `rgba(${warm},${a})`);
        gr.addColorStop(1, `rgba(${warm},${a * 0.55})`);
        g.fillStyle = gr;
        g.fillRect(x, y, w, h);
        const egr = eg.createLinearGradient(x, y, x, y + h);
        egr.addColorStop(0, `rgba(${warm},${a})`);
        egr.addColorStop(1, `rgba(${warm},${a * 0.55})`);
        eg.fillStyle = egr;
        eg.fillRect(x, y, w, h);
      } else {
        const gr = g.createLinearGradient(x, y, x, y + h);
        gr.addColorStop(0, 'rgba(96,122,145,0.92)');   // sky reflection at the top
        gr.addColorStop(0.55, 'rgba(38,50,62,0.95)');
        gr.addColorStop(1, 'rgba(22,28,36,0.95)');
        g.fillStyle = gr;
        g.fillRect(x, y, w, h);
      }

      // Blinds / occupancy variation, masked from the emissive too so a covered
      // window does not glow.
      if (_r() < 0.3) {
        const bh = h * (0.2 + _r() * 0.5);
        g.fillStyle = 'rgba(15,18,22,0.75)';
        g.fillRect(x, y, w, bh);
        if (isLit) { eg.fillStyle = 'rgba(0,0,0,0.75)'; eg.fillRect(x, y, w, bh); }
      }

      g.strokeStyle = `hsl(${hue},${sat}%,${light - 20}%)`; g.lineWidth = 3;
      g.strokeRect(x, y, w, h);
      g.fillStyle = `hsl(${hue},${sat}%,${light + 7}%)`;
      g.fillRect(x - 2, y + h, w + 4, 4);
    }
  }
  return { albedo: c, emissive: e };
}

function facadePair(opts = {}) {
  return memo('facadePair:' + (opts.key ?? 'f0'), () => buildFacade(opts));
}
export function facade(opts = {}) { return facadePair(opts).albedo; }
export function facadeEmissive(opts = {}) { return facadePair(opts).emissive; }

export { tex, noiseCanvas };
