// Where does the corridor have LIVE OAKS and where does it have PALMS?
//
// The district plants a palm at every one of its 276 tree stations. The claim
// under test is that this is right at the bayfront and at Five Points and wrong
// on Main St east, which is a live-oak tunnel. That is a claim about POSITION,
// so it needs a census over position, not three frames.
//
// Two halves, because one of them is not trustworthy on its own:
//
//   --sheets   tiles the reprojected facade views into contact sheets in
//              corridor order, both walls of a station side by side, so the
//              species can be read BY EYE over a stratified sample. An oak and
//              a palm are not close at 320 px; a colour detector and a human
//              disagreeing is the detector losing.
//
//   --measure  computes canopy metrics off every view and prints them against
//              the corridor coordinate. Validated against the eye labels with
//              --score; a discriminator that cannot reproduce the eye census is
//              reported as failing rather than believed.
//
// THE CORRIDOR COORDINATE. `s` is arc length in metres along data/district.json
// meta.route, from the marina. Every station is projected onto the polyline, so
// "x = 340" on the Main St east leg and "x = 54" on the Pineapple leg are one
// ordered axis instead of two coordinates that do not compare.
//
// Reference is REFERENCE (binding constraint 1). Nothing here is traced,
// sampled or colour-picked into a shipped asset: the output is a count, and the
// sheets are a viewing aid that never leaves this directory.
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from './png.mjs';
import { writePNG } from './crop.mjs';

const IN = 'reference/sarasota/mapillary';
const VIEWS = path.join(IN, 'views');
const OUT = 'docs/shots';
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// ---------------------------------------------------------------- corridor s
const route = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route;
const cum = [0];
for (let i = 0; i + 1 < route.length; i++) {
  cum.push(cum[i] + Math.hypot(route[i + 1].x - route[i].x, route[i + 1].z - route[i].z));
}
/** Arc length along the route of the nearest point to (x, z), plus that distance. */
function corridorS(x, z) {
  let best = { s: 0, off: Infinity, leg: 0 };
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i], b = route[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, pz = a.z + dz * t;
    const off = Math.hypot(x - px, z - pz);
    if (off < best.off) best = { s: cum[i] + t * Math.hypot(dx, dz), off, leg: i };
  }
  return best;
}
const LEG = route.slice(0, -1).map((r, i) => `${r.name} -> ${route[i + 1].name}`);

const index = JSON.parse(fs.readFileSync(path.join(IN, 'index.json'), 'utf8'));
const stations = index.images
  .filter((p) => p.isPano)
  .map((p) => ({ ...p, ...corridorS(p.x, p.z) }))
  .filter((p) => fs.existsSync(path.join(VIEWS, `${p.id}-L.png`)))
  .sort((a, b) => a.s - b.s);

/** Thin the station list so consecutive picks are at least `gap` metres apart. */
function thin(list, gap) {
  const out = [];
  for (const p of list) if (!out.length || p.s - out[out.length - 1].s >= gap) out.push(p);
  return out;
}
// --from/--to clip the census to a stretch of corridor, so the transition can be
// sampled at 10 m without rendering 120 sheets of the parts already settled.
const S0 = Number(arg('from', -1e9)), S1 = Number(arg('to', 1e9));
const inRange = (p) => p.s >= S0 && p.s <= S1;

// ------------------------------------------------------------------ sheeting
// Box-filter downscale. A nearest-neighbour shrink of a canopy aliases into
// something that looks like a different tree, which is the one thing this tool
// must not do.
function shrink(img, tw, th) {
  const { width: w, height: h, channels: c, data } = img;
  const out = new Uint8Array(tw * th * 3);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * h) / th), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * w) / tw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / tw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * c;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * tw + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

function sheets(gap, cols, rows, tw, th, tag) {
  const picks = thin(stations.filter(inRange), gap);
  const per = (cols * rows) / 2;                 // two walls per station
  const sheetsN = Math.ceil(picks.length / per);
  const W = cols * tw, H = rows * th;
  fs.mkdirSync(OUT, { recursive: true });
  for (let s = 0; s < sheetsN; s++) {
    const buf = new Uint8Array(W * H * 3).fill(24);
    const here = picks.slice(s * per, (s + 1) * per);
    here.forEach((p, k) => {
      ['L', 'R'].forEach((side, j) => {
        const slot = k * 2 + j;
        const cx = (slot % cols) * tw, cy = Math.floor(slot / cols) * th;
        const file = path.join(VIEWS, `${p.id}-${side}.png`);
        if (!fs.existsSync(file)) return;
        const px = shrink(readPNG(file), tw - 2, th - 2);
        for (let y = 0; y < th - 2; y++) {
          for (let x = 0; x < tw - 2; x++) {
            const si = (y * (tw - 2) + x) * 3, di = ((cy + y + 1) * W + cx + x + 1) * 3;
            buf[di] = px[si]; buf[di + 1] = px[si + 1]; buf[di + 2] = px[si + 2];
          }
        }
      });
      console.log(`  sheet ${s} slot ${k * 2}/${k * 2 + 1}  s=${p.s.toFixed(0).padStart(4)} m  `
        + `(${p.x.toFixed(0)}, ${p.z.toFixed(0)})  ${p.id}  L,R   [${LEG[p.leg]}]`);
    });
    const f = path.join(OUT, `oak-ref-${tag}-${String(s).padStart(2, '0')}.png`);
    writePNG(f, W, H, buf);
    console.log(`${f}   ${here.length} stations, ${here.length * 2} views\n`);
  }
  console.log(`${picks.length} stations at >=${gap} m spacing over ${cum[cum.length - 1].toFixed(0)} m of corridor`);
}

// ----------------------------------------------------------------- measuring
//
// FOLIAGE. Green-dominant, and deliberately loose on saturation: a live oak in
// this set reads olive to grey-green and a bleached one is barely green at all,
// so a tight hue window measures the palms and misses the thing under test.
//
// WOOD vs SKY inside the canopy. This is the discriminator that actually
// separates the two species, and it is a structural fact rather than a colour
// one: the not-leaf pixels INSIDE an oak's crown are its limbs — a dense pale
// grey web — while the not-frond pixels inside a palm's crown are SKY. Sky here
// is bright and blue-dominant and a limb is neither, so the split is safe even
// where the greens are not.
//
// THE FIRST CUT OF THIS TEST WAS WRONG AND THE NUMBERS IT PRODUCED WERE ABSURD:
// it asked for g - max(r, b) >= 8, i.e. green-DOMINANT, and reported 0.5% of a
// frame that is visibly half canopy as foliage. Sampled, rather than reasoned
// about: the oak canopy in this set reads (88,82,57), (45,48,2), (124,109,53),
// (119,121,56) — OLIVE, with red equal to or ABOVE green and blue far below
// both. Green-dominant is what a saturated palm frond is; it is not what a live
// oak in Florida sun is, and the detector was measuring the wrong tree.
//
// So the test is green-over-BLUE, with the threshold scaled by the pixel's own
// brightness (a sunlit leaf and a shaded one are the same hue at very different
// exposures), a cap on how warm it may be so terracotta and brick stay out, and
// b < g so sky cannot enter.
const isFoliage = (r, g, b) => {
  const mx = Math.max(r, g, b);
  if (mx < 20) return false;                       // black: no colour to read
  if (b >= g) return false;                        // sky, neutral, cool stone
  if (r > g + 30) return false;                    // terracotta, brick, skin
  return g - b >= 0.16 * mx + 5;
};
const isSky = (r, g, b) => b > r + 12 && b > 90 && b >= g;
const isBright = (r, g, b) => Math.min(r, g, b) > 190;   // blown highlight / cloud

function metrics(file) {
  const img = readPNG(file);
  const { width: w, height: h, channels: c, data } = img;
  const fol = new Uint8Array(w * h);
  let nF = 0, nTop = 0;
  const topRows = Math.floor(h * 0.4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      if (isFoliage(data[i], data[i + 1], data[i + 2])) {
        fol[y * w + x] = 1; nF++; if (y < topRows) nTop++;
      }
    }
  }
  // Per-column canopy extent: the band between the highest and lowest foliage
  // pixel in that column, for columns that carry enough of it to be a canopy
  // rather than a leaf on a bush.
  let region = 0, wood = 0, sky = 0, bright = 0, cols = 0, lowSum = 0;
  for (let x = 0; x < w; x++) {
    let top = -1, bot = -1, n = 0;
    for (let y = 0; y < h; y++) if (fol[y * w + x]) { if (top < 0) top = y; bot = y; n++; }
    if (n < 10) continue;
    cols++; lowSum += bot / h;
    for (let y = top; y <= bot; y++) {
      region++;
      if (fol[y * w + x]) continue;
      const i = (y * w + x) * c;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (isBright(r, g, b)) bright++;
      else if (isSky(r, g, b)) sky++;
      else wood++;
    }
  }
  const gaps = sky + wood + bright;
  return {
    foliage: nF / (w * h),
    upper: nTop / (topRows * w),
    colFrac: cols / w,
    lowMedian: cols ? lowSum / cols : 0,
    regionFrac: region / (w * h),
    fill: region ? (region - gaps) / region : 0,
    woodShare: (wood + sky) ? wood / (wood + sky) : 0,
    woodFrac: region ? wood / region : 0,
  };
}

/**
 * The opposite-reading test, made lookable-at. Writes the frame with every
 * foliage pixel forced to magenta, so a mask that is selecting the sky, the
 * stucco or nothing at all is visible rather than inferred from a number. A
 * null result from a detector nobody has watched work is worth nothing — this
 * repo has paid for that lesson once already with a visibility toggle that was
 * affecting zero meshes.
 */
function maskDump(id, side) {
  const f = path.join(VIEWS, `${id}-${side}.png`);
  const img = readPNG(f);
  const { width: w, height: h, channels: c, data } = img;
  const rgb = new Uint8Array(w * h * 3);
  let n = 0;
  for (let i = 0, o = 0; o < rgb.length; i += c, o += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (isFoliage(r, g, b)) { rgb[o] = 255; rgb[o + 1] = 0; rgb[o + 2] = 255; n++; }
    else { rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b; }
  }
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, `oak-mask-${id}-${side}.png`);
  writePNG(out, w, h, rgb);
  console.log(`${out}   foliage ${(100 * n / (w * h)).toFixed(1)}%`);
}

// ------------------------------------------------------------------- the CLI
if (has('mask')) {
  const spec = arg('mask', '');
  const [id, side] = spec.split('-');
  maskDump(id, side || 'L');
} else if (has('sheets')) {
  sheets(Number(arg('gap', 28)), 4, 3, 320, 240, arg('tag', 'a'));
} else if (has('measure')) {
  const rows = [];
  for (const p of stations) {
    for (const side of ['L', 'R']) {
      const f = path.join(VIEWS, `${p.id}-${side}.png`);
      if (!fs.existsSync(f)) continue;
      rows.push({ id: p.id, side, s: p.s, x: p.x, z: p.z, leg: p.leg, ...metrics(f) });
    }
  }
  const out = arg('out', 'docs/oak-census.json');
  fs.writeFileSync(out, JSON.stringify({
    generated: new Date().toISOString().slice(0, 10),
    note: 'Canopy metrics off reprojected Mapillary panoramas. Reference only.',
    legs: LEG, rows,
  }, null, 1));
  console.log(`${rows.length} views measured -> ${out}`);
} else {
  console.log('usage: node tools/oak-census.mjs --sheets [--gap 28] [--tag a]');
  console.log('       node tools/oak-census.mjs --measure [--out docs/oak-census.json]');
}
