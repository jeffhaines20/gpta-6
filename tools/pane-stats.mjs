// Statistics over a pane-audit capture: what the frame actually does INSIDE the
// glazing. Pixels are attributed to a material by the id pass and to a cell by
// the packed roughness/metalness texel, so "glass" is what the shader sampled as
// glass, not a rectangle someone drew on the frame by eye.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readPNG } from './png.mjs';

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

export function loadCapture(base) {
  const meta = JSON.parse(fs.readFileSync(`${base}.meta.json`, 'utf8'));
  const rm = new Uint8Array(fs.readFileSync(`${base}.rm.bin`));
  const em = new Uint8Array(fs.readFileSync(`${base}.em.bin`));
  const id = new Uint8Array(fs.readFileSync(`${base}.id.bin`));
  const png = readPNG(`${base}.png`);
  return { meta, rm, em, id, png, w: meta.w, h: meta.h };
}

// A glass texel is a smooth, metallic one. Both the old atlas (roughness 0.10-0.16,
// metalness 0.55) and any coated replacement land inside this window, and nothing
// else in the facade atlas comes close: the wall is 0.62-0.93 rough at metalness
// <= 0.35, the blinds 0.86, the parking deck 0.98.
const isGlassTexel = (g, b) => g < 96 && b > 100;
// The trim atlas addressed by its packed (roughness, metalness) signature. The
// glazing cell is the only smooth one in the low-metalness band: the mullion
// stock is (76,230), steel (97,235) and dark metal (112,217), all rougher or
// far more metallic, so "smooth and only somewhat metallic" picks out shopfront
// glass whatever coating it is currently authored with.
const isTrimGlass = (g, b) => g < 40 && b > 80 && b < 200;


export function classify(cap) {
  const { rm, id, w, h, meta } = cap;
  const nameOf = new Map(meta.ids.map(([n, i]) => [i, n]));
  const kind = new Uint8Array(w * h);   // 0 other, 1 facade glass, 2 facade wall, 3 trim glass, 4 deck void
  for (let i = 0; i < w * h; i++) {
    const n = nameOf.get(id[i * 4]) ?? '';
    const a = rm[i * 4], g = rm[i * 4 + 1], b = rm[i * 4 + 2];
    // The parking deck's void writes ao 0.15 and roughness 0.98, a signature no
    // other cell in the atlas shares; it is a hole, not glazing, and is counted
    // as neither wall nor glass.
    if (n.startsWith('facade:') && a < 60 && g > 240) kind[i] = 4;
    else if (n.startsWith('facade:')) kind[i] = isGlassTexel(g, b) ? 1 : 2;

    else if (n === 'trim' && isTrimGlass(g, b)) kind[i] = 3;

  }
  return { kind, nameOf };
}

// 4-connected components of one kind, each returned with its pixel list.
function components(kind, want, w, h, minArea) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (kind[i] !== want || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    const px = [];
    while (sp) {
      const p = stack[--sp];
      px.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && kind[p - 1] === want && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && kind[p + 1] === want && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && kind[p - w] === want && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && kind[p + w] === want && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (px.length >= minArea) out.push(px);
  }
  return out;
}

export function report(base, { minArea = 60, label = '' } = {}) {
  const cap = loadCapture(base);
  const { w, h, png, em } = cap;
  const { kind } = classify(cap);
  const ch = png.channels;
  const at = (i) => [png.data[i * ch], png.data[i * ch + 1], png.data[i * ch + 2]];

  const bulk = (want) => {
    const L = [], rgb = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (kind[i] !== want) continue;
      const [r, g, b] = at(i);
      L.push(luma(r, g, b)); rgb[0] += r; rgb[1] += g; rgb[2] += b; n++;
    }
    L.sort((a, b) => a - b);
    return { n, mean: mean(L), p5: pct(L, 0.05), p95: pct(L, 0.95),
      rgb: n ? rgb.map((v) => v / n) : [0, 0, 0] };
  };

  const panes = components(kind, 1, w, h, minArea);
  const paneStats = panes.map((px) => {
    let y0 = 1e9, y1 = -1e9;
    for (const p of px) { const y = (p / w) | 0; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const span = Math.max(1, y1 - y0 + 1);
    const L = [], top = [0, 0, 0, 0], bot = [0, 0, 0, 0];
    let emSum = 0;
    for (const p of px) {
      const y = (p / w) | 0;
      const [r, g, b] = at(p);
      L.push(luma(r, g, b));
      emSum += luma(em[p * 4], em[p * 4 + 1], em[p * 4 + 2]);
      const f = (y - y0) / span;
      const t = f < 1 / 3 ? top : (f >= 2 / 3 ? bot : null);
      if (t) { t[0] += r; t[1] += g; t[2] += b; t[3]++; }
    }
    L.sort((a, b) => a - b);
    return {
      area: px.length, y0, y1,
      mean: mean(L), p5: pct(L, 0.05), p95: pct(L, 0.95), spread: pct(L, 0.95) - pct(L, 0.05),
      top: top[3] ? [top[0] / top[3], top[1] / top[3], top[2] / top[3]] : null,
      bot: bot[3] ? [bot[0] / bot[3], bot[1] / bot[3], bot[2] / bot[3]] : null,
      em: emSum / px.length,
    };
  });
  const litCut = 12;
  const unlit = paneStats.filter((p) => p.em <= litCut);
  const lit = paneStats.filter((p) => p.em > litCut);
  const agg = (arr) => {
    const withTB = arr.filter((p) => p.top && p.bot);
    return {
      panes: arr.length,
      px: arr.reduce((s, p) => s + p.area, 0),
      meanL: mean(arr.map((p) => p.mean)),
      medSpread: arr.length ? arr.map((p) => p.spread).sort((a, b) => a - b)[arr.length >> 1] : 0,
      top: [0, 1, 2].map((c) => mean(withTB.map((p) => p.top[c]))),
      bot: [0, 1, 2].map((c) => mean(withTB.map((p) => p.bot[c]))),
    };
  };
  return {
    base: path.basename(base), label,
    glass: bulk(1), wall: bulk(2), trimGlass: bulk(3), deck: bulk(4),

    all: agg(paneStats), unlit: agg(unlit), lit: agg(lit),
  };
}

export function fmt(r) {
  const c = (a) => `(${a.map((v) => Math.round(v)).join(',')})`;
  const line = [];
  line.push(`${r.base}`);
  line.push(`  facade glass  ${String(r.glass.n).padStart(7)} px  mean ${f1(r.glass.mean).padStart(6)}  p5-p95 ${f1(r.glass.p5)}-${f1(r.glass.p95)}  rgb ${c(r.glass.rgb)}`);
  line.push(`  facade wall   ${String(r.wall.n).padStart(7)} px  mean ${f1(r.wall.mean).padStart(6)}  p5-p95 ${f1(r.wall.p5)}-${f1(r.wall.p95)}  rgb ${c(r.wall.rgb)}`);
  line.push(`  shopfront gl. ${String(r.trimGlass.n).padStart(7)} px  mean ${f1(r.trimGlass.mean).padStart(6)}  p5-p95 ${f1(r.trimGlass.p5)}-${f1(r.trimGlass.p95)}  rgb ${c(r.trimGlass.rgb)}`);
  line.push(`  deck void     ${String(r.deck.n).padStart(7)} px  mean ${f1(r.deck.mean).padStart(6)}  p5-p95 ${f1(r.deck.p5)}-${f1(r.deck.p95)}  rgb ${c(r.deck.rgb)}`);

  for (const k of ['all', 'unlit', 'lit']) {
    const a = r[k];
    if (!a.panes) { line.push(`  ${k.padEnd(5)} panes 0`); continue; }
    line.push(`  ${k.padEnd(5)} panes ${String(a.panes).padStart(4)}  ${String(a.px).padStart(7)} px  mean ${f1(a.meanL).padStart(6)}` +
      `  median in-pane p5-p95 spread ${f1(a.medSpread).padStart(5)}  top ${c(a.top)}  bottom ${c(a.bot)}`);
  }
  return line.join('\n');
}

// Overlay: what is IN the sample region, so a constant is never tuned for a
// region nobody looked at.
export function overlay(base, out) {
  const cap = loadCapture(base);
  const { w, h, png } = cap;
  const { kind } = classify(cap);
  const ch = png.channels;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = kind[i];
      let r = png.data[i * ch], g = png.data[i * ch + 1], b = png.data[i * ch + 2];
      if (k === 0) { r = (r * 0.25) | 0; g = (g * 0.25) | 0; b = (b * 0.25) | 0; }
      else if (k === 2) { r = Math.min(255, (r * 0.4 + 40) | 0); g = (g * 0.4) | 0; b = (b * 0.4) | 0; }
      else if (k === 3) { r = (r * 0.5) | 0; g = Math.min(255, (g * 0.5 + 60) | 0); b = (b * 0.5) | 0; }
      else if (k === 4) { r = (r * 0.5) | 0; g = (g * 0.5) | 0; b = Math.min(255, (b * 0.5 + 80) | 0); }

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

// A/B over the pixels BOTH captures agree about. The classification itself moves
// when a material's roughness moves — the warehouse clerestory only became glass
// when it was given a coating — so a straight before/after of two differently
// sized masks compares two different sets of pixels. This compares one set.
export function pair(a, b, want = 1) {
  const A = loadCapture(a), B = loadCapture(b);
  const ka = classify(A).kind, kb = classify(B).kind;
  const { w, h } = A;
  const out = {};
  for (const [name, cap, kind] of [['before', A, ka], ['after', B, kb]]) {
    const ch = cap.png.channels;
    const L = [], rgb = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (ka[i] !== want || kb[i] !== want) continue;
      const r = cap.png.data[i * ch], g = cap.png.data[i * ch + 1], bl = cap.png.data[i * ch + 2];
      L.push(luma(r, g, bl)); rgb[0] += r; rgb[1] += g; rgb[2] += bl; n++;
    }
    L.sort((x, y) => x - y);
    out[name] = { n, mean: mean(L), p5: pct(L, 0.05), p95: pct(L, 0.95), rgb: rgb.map((v) => v / (n || 1)) };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {

  const args = process.argv.slice(2);
  for (const a of args) {
    if (a.startsWith('--overlay=')) { console.log('overlay ->', overlay(a.slice(10), `${a.slice(10)}.mask.png`)); continue; }
    if (a.startsWith('--pair=')) {
      const [x, y] = a.slice(7).split(',');
      const names = { 1: 'facade glass', 2: 'facade wall', 3: 'shopfront glass', 4: 'deck void' };
      for (const k of [1, 2, 3, 4]) {
        const p = pair(x, y, k);
        if (!p.before.n) continue;
        const c = (v) => `(${v.map((q) => Math.round(q)).join(',')})`;
        console.log(`${names[k].padEnd(16)} ${String(p.before.n).padStart(7)} shared px   ` +
          `mean ${f1(p.before.mean)} -> ${f1(p.after.mean)}   ` +
          `p5-p95 ${f1(p.before.p5)}-${f1(p.before.p95)} -> ${f1(p.after.p5)}-${f1(p.after.p95)}   ` +
          `rgb ${c(p.before.rgb)} -> ${c(p.after.rgb)}`);
      }
      continue;
    }

    console.log(fmt(report(a)));
  }
}
