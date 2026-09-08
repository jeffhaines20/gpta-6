// Business identity, wordmarks and street signage — every mark drawn at load.
//
// Four things drive the decisions in this file.
//
// 1. A commercial street is the densest sign environment in the district: twelve
//    storefronts, each carrying a fascia wordmark, an awning valance and often a
//    projecting blade, plus the street blades and regulatory signs at the corner.
//    One material per sign is forty-plus draw calls for a single block, against a
//    district worst case of 116. So every sign here lives in one of two ATLASES
//    and every helper appends into caller-owned buffers, exactly as facades.js
//    does — a chunk's shop signage merges into ONE mesh, and the whole district's
//    street signage into one more.
//
// 2. Two atlases, not one, because the two halves want different granularity.
//    Shop signs are near-LOD, per-chunk content. Street signage is sparse and
//    district-wide and wants to be a single merged mesh with no per-chunk
//    duplication — the same call streetfurniture.js makes for lamp posts. Sharing
//    one atlas would force street signs to be rebuilt per chunk or shop signs to
//    be district-wide; splitting costs one extra texture and saves both.
//
// 3. Albedo, emissive and roughness/metalness are drawn in ONE pass over one
//    coordinate space, for the reason src/textures.js records: recovering an
//    emissive mask afterwards with getImageData cost 2,219 ms for a single
//    1024 px texture. Neon here is not a post-process — the tube is drawn to the
//    albedo as cold glass and to the emissive as lit gas in adjacent statements,
//    so they cannot drift apart.
//
// 4. Typography, not typefaces. A browser is not guaranteed any particular font,
//    so none of the ten wordmark styles depends on one. Variety comes from
//    weight, tracking, case, horizontal condensation, colour, backing plate and
//    border — all of which are ours — over generic families that always resolve.
//
// Every business name, mark and colourway below is invented. Street names come
// from data/district.json, which tools/bake/fictionalize.mjs already replaced.

import * as THREE from '../vendor/three.module.min.js';
import {
  hash32, rng, seedOf, edgesOf, facingEdges, TRIM, box, awningFrame,
  AWNING_SEGS, awningProfile, lotPlanFor,
  buildingStyle as facadeStyle,
} from './facades.js';

// facades.js owns hash32/rng/seedOf/edgesOf and this module imports rather than
// reimplements them on purpose. A building's business must be derived from the
// same seed as its facade recipe, and a sign must land on the same edge the
// storefront did; two copies of "which edge faces the street" is precisely the
// bug that puts a wordmark on a blank party wall.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// How far a post is set INTO the pavement.
//
// streaming.js reports ground as `groundY` (0) through heightAt(), but the pad
// the player actually sees is drawn at `groundY - 0.05` so the road ribbons at
// +0.02 and the zone polygons at +0.012 can stack on top of it without
// z-fighting. A post based at exactly y = 0 therefore hovers 50 mm over the
// pavement it is standing on — 5.4 px at ten metres, and the "post that does not
// reach the ground" three critics reported. A real post is set in the paving, so
// these now start below it: that spans the 50 mm pad offset and the 20 mm road
// ribbon in one number and does not depend on either staying put.
const GROUND_EMBED = 0.08;

// ------------------------------------------------------------------- branding
//
// Hand-authored, one line per business. `w` is the wordmark style, `h` the brand
// hue, `m` the abstract mark and `a` the awning colourway — all art decisions, so
// they are written down rather than sampled. The first 24 names are the pool
// tools/bake/fictionalize.mjs already bakes into the district; the last 8 extend
// it so a long street can run without a repeat.

export const BUSINESSES = [
  { n: 'Corvid Coffee',          s: 'COFFEE',  t: 'cafe',       w: 'enamelBar',      h: 20,  m: 'wings',     a: 0 },
  { n: 'Halcyon Books',          s: 'BOOKS',   t: 'books',      w: 'slabPlate',      h: 206, m: 'ringSeg',   a: 1 },
  { n: 'The Brass Cleat',        s: 'BAR',     t: 'bar',        w: 'neonScript',     h: 38,  m: 'ringSeg',   a: 7 },
  { n: 'Verano Optical',         s: 'OPTICAL', t: 'optical',    w: 'sansPanel',      h: 196, m: 'ringSeg',   a: 2 },
  { n: 'Mira Loma Cantina',      s: 'CANTINA', t: 'restaurant', w: 'neonBlock',      h: 348, m: 'chevrons',  a: 2 },
  { n: 'Bright & Sons Hardware', s: 'HDWE',    t: 'hardware',   w: 'boardPaint',     h: 30,  m: 'hexNut',    a: 3 },
  { n: 'Nautilus Records',       s: 'RECORDS', t: 'records',    w: 'vitrolite',      h: 268, m: 'waves',     a: 4 },
  { n: 'Fennel & Rye',           s: 'GROCER',  t: 'grocer',     w: 'slabPlate',      h: 96,  m: 'lattice',   a: 5 },
  { n: 'Aster Dry Cleaning',     s: 'CLEANER', t: 'laundry',    w: 'enamelBar',      h: 212, m: 'monogram',  a: 1 },
  { n: 'Puerto Azul Grill',      s: 'GRILL',   t: 'grill',      w: 'neonScript',     h: 210, m: 'waves',     a: 2 },
  { n: 'Lumen Camera',           s: 'CAMERA',  t: 'camera',     w: 'channelLetters', h: 46,  m: 'ringSeg',   a: 7 },
  { n: 'The Salt Room',          s: 'SPA',     t: 'spa',        w: 'sansPanel',      h: 172, m: 'arcSun',    a: 9 },
  { n: 'Ravenswood Tailors',     s: 'TAILOR',  t: 'tailor',     w: 'gildedGlass',    h: 348, m: 'monogram',  a: 2 },
  { n: 'Dockside Pharmacy',      s: 'RX',      t: 'pharmacy',   w: 'channelLetters', h: 142, m: 'crossbars', a: 6 },
  { n: 'Tessellate Tile Co.',    s: 'TILE',    t: 'tile',       w: 'vitrolite',      h: 186, m: 'lattice',   a: 2 },
  { n: 'Gilder Bank',            s: 'BANK',    t: 'bank',       w: 'gildedGlass',    h: 44,  m: 'monogram',  a: 7 },
  { n: 'Marrow & Vine',          s: 'WINE',    t: 'wine',       w: 'slabPlate',      h: 340, m: 'lattice',   a: 8 },
  { n: 'Kestrel Cycles',         s: 'CYCLES',  t: 'cycles',     w: 'boardPaint',     h: 88,  m: 'chevrons',  a: 5 },
  { n: 'Pomelo Bakery',          s: 'BAKERY',  t: 'bakery',     w: 'vitrolite',      h: 40,  m: 'arcSun',    a: 3 },
  { n: 'Sable Street Barbers',   s: 'BARBER',  t: 'barber',     w: 'enamelBar',      h: 214, m: 'barsUp',    a: 1 },
  { n: 'Vantage Realty',         s: 'REALTY',  t: 'realty',     w: 'sansPanel',      h: 222, m: 'chevrons',  a: 1 },
  { n: 'Wildcat Arcade',         s: 'ARCADE',  t: 'arcade',     w: 'neonBlock',      h: 292, m: 'barsUp',    a: 4 },
  { n: 'Orchid Lane Florist',    s: 'FLORIST', t: 'florist',    w: 'slabPlate',      h: 316, m: 'arcSun',    a: 8 },
  { n: 'Cassava',                s: 'MARKET',  t: 'market',     w: 'channelLetters', h: 64,  m: 'monogram',  a: 5 },
  { n: 'Larkspur Diner',         s: 'DINER',   t: 'diner',      w: 'neonScript',     h: 200, m: 'waves',     a: 2 },
  { n: 'Meridian Hi-Fi',         s: 'HI-FI',   t: 'hifi',       w: 'stencilSteel',   h: 8,   m: 'barsUp',    a: 0 },
  { n: 'Fathom Dive Supply',     s: 'DIVE',    t: 'dive',       w: 'enamelBar',      h: 190, m: 'waves',     a: 2 },
  { n: 'Nine Palms Motel',       s: 'MOTEL',   t: 'motel',      w: 'neonBlock',      h: 168, m: 'arcSun',    a: 9 },
  { n: 'Quarrow Electric',       s: 'ELECTRIC',t: 'electric',   w: 'stencilSteel',   h: 52,  m: 'chevrons',  a: 3 },
  { n: 'Tinsmith Deli',          s: 'DELI',    t: 'deli',       w: 'boardPaint',     h: 14,  m: 'crossbars', a: 0 },
  { n: 'Isolde & Poole',         s: 'I&P',     t: 'law',        w: 'gildedGlass',    h: 226, m: 'monogram',  a: 1 },
  { n: 'Verano Wash House',      s: 'WASH',    t: 'laundromat', w: 'sansPanel',      h: 156, m: 'lattice',   a: 6 },
];

/** Which wordmark styles put light into the emissive channel. */
export const LIT_STYLES = new Set(['neonScript', 'neonBlock', 'channelLetters']);

// Emissive intensity per time of day, in the same linear units daynight.js hands
// the lights. The three values are far apart because exposure is: dusk renders at
// 1/330 and night at 1/2.2, a 150x difference, so a sign that reads at night is
// invisible at dusk unless the emissive scales with it. Shop signs sit above the
// bloom threshold at both hours (0.85 at dusk, 0.55 at night) because a neon tube
// that does not bloom does not look like neon.
// golden: the SAME tube as dusk. These two hours are forty minutes apart and a
// neon transformer does not know which one it is; what changes is the camera, and
// 430 at golden's 1/4,239 stop renders at 0.10 in exposed units against dusk's
// 0.48 at 1/900. Lit, warm, and plainly subordinate to a 34,470 lux sun - which is
// exactly what a shop sign looks like before sunset. Note this is the one place in
// this table where the physical reading and the graded one agree, so it is taken.
export const SIGN_EMISSIVE = { noon: 0, golden: 430, dusk: 430, night: 7.4 };

// Street signs are retroreflective, not emissive: they return headlight light
// along the axis it arrived on. A constant dim glow is the standard cheat and it
// is deliberately kept BELOW the bloom threshold — a stop sign that blooms reads
// as a lamp, which is worse than one that reads as slightly self-lit.
// golden is 0 for the reason noon is: the constant glow stands in for headlight
// return, and a sign facing a 34,470 lux sun is being lit for real. Leaving it on
// would double-count the one hour of the cycle where the cheat is least needed.
export const STREET_EMISSIVE = { noon: 0, golden: 0, dusk: 150, night: 1.15 };

export const TIMES = ['noon', 'golden', 'dusk', 'night'];

// -------------------------------------------------------------- shelf packing
//
// A shelf (strip) packer, not a tree: every request here comes from a run of
// identically-sized cells, and for that input a shelf packer wastes only the tail
// of each row — measured utilisation is reported by generateSignageLibrary(). The
// atlas WIDTH is fixed and the HEIGHT falls out of the packing, rounded up to 64,
// so adding a business or a street name cannot silently overflow the texture.
//
// Every cell is allocated with `pad` texels of gutter on all four sides, and the
// gutter is filled with the cell's own backing colour before its content is
// drawn. That is what makes mip bleeding harmless: at the level where a 448 px
// wordmark is four texels wide, what bleeds into it is its own plate colour
// rather than the neighbouring shop's.

class ShelfPacker {
  constructor(width, pad) {
    this.W = width; this.pad = pad;
    this.x = 0; this.y = 0; this.shelfH = 0;
    this.rects = new Map();
    this.used = 0;
  }
  // Close the current shelf. Callers break between runs of different cell sizes:
  // letting a 192 px blade land on the tail of a 48 px valance shelf raises that
  // whole shelf to 192 and wastes 2048x144 texels. Measured: 70% utilisation
  // without the breaks, 77% with, and 2240 px of atlas height instead of 2048.
  newShelf() {
    if (this.x === 0) return;
    this.y += this.shelfH; this.x = 0; this.shelfH = 0;
  }
  add(key, w, h) {
    const aw = w + this.pad * 2, ah = h + this.pad * 2;
    if (this.x + aw > this.W) { this.y += this.shelfH; this.x = 0; this.shelfH = 0; }
    const r = { x: this.x + this.pad, y: this.y + this.pad, w, h };
    this.x += aw;
    if (ah > this.shelfH) this.shelfH = ah;
    this.rects.set(key, r);
    this.used += w * h;
    return r;
  }
  get height() { return this.y + this.shelfH; }
  finish(round = 64) {
    const h = Math.ceil(this.height / round) * round;
    this.H = h;
    this.utilisation = this.used / (this.W * h);
    return h;
  }
}

/**
 * UV sub-rect for a packed cell, in the convention every helper here and in
 * facades.js uses: [u0,v0,u1,v1] with v0 at the BOTTOM of the cell. Canvas rows
 * run top-down and CanvasTexture uploads with flipY, so v is inverted.
 *
 * A half-texel inset stops mip 0 from sampling the gutter at the exact edge; the
 * gutter itself handles every level below that.
 */
function uvOf(r, W, H) {
  const i = 0.5;
  return [
    (r.x + i) / W, 1 - (r.y + r.h - i) / H,
    (r.x + r.w - i) / W, 1 - (r.y + i) / H,
  ];
}

// ------------------------------------------------------- atlas layout & addressing
//
// Two atlases, each a fixed width with the height falling out of the packing.
// Cells are packed in runs of one size, a shelf break between runs, four texels
// of gutter around every cell. Measured utilisation is 77.5% and 75.6%; the
// remainder is the tail of each shelf and is reported by generateSignageLibrary
// so a future cell-size change cannot quietly waste half a texture.
//
// SHOP ATLAS — 2048 x 1664 as configured (13.6 MB albedo)
//
//   band      cell       n    per shelf   shelves   world size
//   fascia    400x100    32   5           7         ~5.0 x 1.25 m storefront plate
//   valance   400x44     32   5           7         ~3.0 x 0.34 m awning valance
//   blade     104x176    32   18          2         ~0.75 x 1.28 m projecting sign
//   mark       56x56     32   32          1         logo, for glass and valance ends
//   stripe    104x104    10   18          1  }      awning canopy fabric
//   misc       32x32      4   (same shelf)   }      plate edges and returns
//
// STREET ATLAS — 1024 x 1088 as configured (4.5 MB albedo)
//
//   street    248x32     84   4           21        ~1.55 x 0.235 m name blade
//   reg       128x128     4   } 8 on one shelf      0.76 m octagon / disc / triangle
//   tall       96x128     4   }                     0.52 x 0.70 m parking, speed
//   wide      224x64      4   4           1         1.05 x 0.30 m one-way, wayfinding
//   misc       32x32      4   4           1         sign backs, post bands
//
// ADDRESSING. A cell is named "<kind>:<key>" — an index for the per-business shop
// bands, a sign name for the street bands. shopRect(kind, key) and
// streetRect(kind, key) turn that into [u0, v0, u1, v1], the quad-UV convention
// facades.js uses (v0 at the BOTTOM of the cell; canvas rows run top-down and
// CanvasTexture uploads flipped). streetNameRect(name) resolves an invented street
// name straight to its blade. Every geometry helper below takes one of those rects
// and nothing else, so a sign's identity and its geometry never have to agree
// about anything but four floats.
//
// Emissive is half resolution and roughness/metalness a quarter: a glow and a
// material mask carry no high-frequency detail worth paying for. Total across both
// atlases including mips: 30.2 MB for every sign the district will ever show.

// One knob for the whole signage budget. Both atlas widths and every cell scale
// by it, so 0.5 quarters the VRAM in a single edit if the M1 real-hardware
// checkpoint says texture memory is the binding constraint rather than draw
// calls. Cell widths are chosen to divide their atlas without a horizontal tail:
// five 400 px fascias and eighteen 104 px blades each fill 2048, four 248 px
// street blades fill 1024.
export const ATLAS_SCALE = 1;

const sc = (n) => Math.round(n * ATLAS_SCALE);
const cell = (w, h) => [sc(w), sc(h)];
const SHOP_W = sc(2048), STREET_W = sc(1024), PAD = Math.max(2, sc(4));
const CELL = {
  fascia: cell(400, 100), valance: cell(400, 44), blade: cell(104, 176),
  mark: cell(56, 56), stripe: cell(104, 104), misc: cell(32, 32),
};
const SCELL = {
  blade: cell(248, 32), reg: cell(128, 128), tall: cell(96, 128),
  wide: cell(224, 64), misc: cell(32, 32),
};

const STRIPES = 10;
const MISC = ['plateEdge', 'steel', 'darkVinyl', 'whiteEnamel'];
const SMISC = ['bladeBack', 'signBack', 'postBand', 'darkVinyl'];
export const REG_SIGNS = ['stop', 'doNotEnter', 'yield', 'noLeft'];
export const TALL_SIGNS = ['parking', 'noParking', 'speed25', 'speed35'];
export const WIDE_SIGNS = ['oneWayLeft', 'oneWayRight', 'wayfind', 'addressPlate'];

// ------------------------------------------------------------------- canvases
const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// One layer set: albedo at full resolution, emissive at half and
// roughness/metalness at a quarter, all sharing ONE coordinate space via a
// context transform. A glow and a material mask carry no high-frequency detail,
// and the transform means every draw below is written once in atlas pixels.
function layers(W, H) {
  const mk = (s) => {
    const c = canvas(Math.round(W * s), Math.round(H * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    return { c, g, s };
  };
  return { W, H, al: mk(1), em: mk(0.5), rm: mk(0.25) };
}

// three.js samples roughnessMap.g and metalnessMap.b, so one texture serves both
// and red is left free for anyone who wires up aoMap.
const rmColor = (rough, metal, ao = 1) =>
  `rgb(${Math.round(ao * 255)},${Math.round(clamp01(rough) * 255)},${Math.round(clamp01(metal) * 255)})`;

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

// ------------------------------------------------------------------ lettering
//
// Everything typographic is built from these three, because the only guarantee a
// browser makes is that a generic family resolves to something. Sizing, tracking
// and condensation are ours, so a style reads the same whether "Georgia" is
// present or falls back to the platform serif.

function trackedWidth(g, text, track) {
  let w = 0;
  for (const ch of text) w += g.measureText(ch).width + track;
  return Math.max(0, w - track);
}

/**
 * Fit one line into a box. Condense BEFORE shrinking: a signwriter fills the
 * plate and squeezes the letters, and shrinking first leaves a sign floating in
 * an empty field, which is the single strongest "procedural" tell.
 */
function fitLine(g, text, maxW, maxH, font, trackEm, minScaleX = 0.66) {
  for (let size = Math.floor(maxH); size > 5; size--) {
    g.font = font(size);
    const track = trackEm * size;
    const w = trackedWidth(g, text, track);
    if (w <= maxW) return { size, track, scaleX: 1, width: w };
    if (w * minScaleX <= maxW) return { size, track, scaleX: maxW / w, width: maxW };
  }
  g.font = font(6);
  return { size: 6, track: 0, scaleX: 1, width: trackedWidth(g, text, 0) };
}

/**
 * Draw a tracked, optionally condensed line. `align` is -1 left, 0 centre,
 * 1 right about x. Returns the drawn width so callers can rule under it.
 */
function drawTracked(g, text, x, y, fit, align, mode = 'fill') {
  const w = trackedWidth(g, text, fit.track) * fit.scaleX;
  const start = align < 0 ? x : align > 0 ? x - w : x - w / 2;
  g.save();
  g.translate(start, y);
  g.scale(fit.scaleX, 1);
  let cx = 0;
  for (const ch of text) {
    if (mode !== 'stroke') g.fillText(ch, cx, 0);
    if (mode !== 'fill') g.strokeText(ch, cx, 0);
    cx += g.measureText(ch).width + fit.track;
  }
  g.restore();
  return w;
}

const FONT = {
  serif: (w) => (s) => `${w} ${s}px Georgia, "Times New Roman", serif`,
  sans: (w) => (s) => `${w} ${s}px "Helvetica Neue", Arial, sans-serif`,
  impact: () => (s) => `${s}px Impact, "Arial Black", sans-serif`,
  mono: (w) => (s) => `${w} ${s}px "Courier New", monospace`,
  italicSerif: (w) => (s) => `italic ${w} ${s}px Georgia, "Times New Roman", serif`,
};

// Upper-cases and spaces a name for a plate that wants monumental caps.
const caps = (s) => s.toUpperCase();

// ------------------------------------------------------------------ logo marks
//
// Abstract geometry only — chevrons, waves, monograms, lattices. These are
// primitives, not references: nothing here is or resembles an existing mark.

function drawMark(g, kind, x, y, size, fg, bg, r) {
  g.save();
  g.translate(x, y);
  const S = size;
  g.lineCap = 'butt';
  if (bg) { g.fillStyle = bg; g.beginPath(); g.arc(0, 0, S * 0.5, 0, 7); g.fill(); }
  g.fillStyle = fg; g.strokeStyle = fg;
  switch (kind) {
    case 'chevrons':
      g.lineWidth = S * 0.11;
      for (let i = 0; i < 3; i++) {
        const o = (i - 1) * S * 0.19;
        g.beginPath();
        g.moveTo(-S * 0.26, o + S * 0.12); g.lineTo(0, o - S * 0.12); g.lineTo(S * 0.26, o + S * 0.12);
        g.stroke();
      }
      break;
    case 'waves':
      g.lineWidth = S * 0.085;
      for (let i = 0; i < 3; i++) {
        const o = (i - 1) * S * 0.2;
        g.beginPath();
        g.moveTo(-S * 0.3, o);
        g.bezierCurveTo(-S * 0.14, o - S * 0.16, S * 0.02, o + S * 0.16, S * 0.3, o);
        g.stroke();
      }
      break;
    case 'wings':
      g.lineWidth = S * 0.09;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(0, S * 0.2);
        g.quadraticCurveTo(s * S * 0.16, -S * 0.06, s * S * 0.32, -S * 0.24);
        g.stroke();
      }
      g.beginPath(); g.arc(0, S * 0.24, S * 0.07, 0, 7); g.fill();
      break;
    case 'ringSeg':
      g.lineWidth = S * 0.11;
      g.beginPath(); g.arc(0, 0, S * 0.29, 0.5, 5.1); g.stroke();
      g.beginPath(); g.arc(0, 0, S * 0.13, 0, 7); g.fill();
      break;
    case 'lattice':
      g.lineWidth = S * 0.055;
      for (let i = -2; i <= 2; i++) {
        g.beginPath(); g.moveTo(i * S * 0.14 - S * 0.16, -S * 0.3); g.lineTo(i * S * 0.14 + S * 0.16, S * 0.3); g.stroke();
        g.beginPath(); g.moveTo(i * S * 0.14 + S * 0.16, -S * 0.3); g.lineTo(i * S * 0.14 - S * 0.16, S * 0.3); g.stroke();
      }
      break;
    case 'arcSun':
      g.lineWidth = S * 0.07;
      g.beginPath(); g.arc(0, S * 0.14, S * 0.2, Math.PI, 0); g.fill();
      for (let i = 0; i < 7; i++) {
        const a = Math.PI + (i + 0.5) * (Math.PI / 7);
        g.beginPath();
        g.moveTo(Math.cos(a) * S * 0.25, S * 0.14 + Math.sin(a) * S * 0.25);
        g.lineTo(Math.cos(a) * S * 0.36, S * 0.14 + Math.sin(a) * S * 0.36);
        g.stroke();
      }
      break;
    case 'crossbars':
      g.fillRect(-S * 0.32, -S * 0.08, S * 0.64, S * 0.16);
      g.fillRect(-S * 0.08, -S * 0.32, S * 0.16, S * 0.64);
      break;
    case 'barsUp':
      for (let i = 0; i < 4; i++) {
        const hh = S * (0.12 + i * 0.11);
        g.fillRect(-S * 0.3 + i * S * 0.16, S * 0.28 - hh, S * 0.1, hh);
      }
      break;
    case 'hexNut': {
      g.lineWidth = S * 0.09;
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.52;
        const px = Math.cos(a) * S * 0.32, py = Math.sin(a) * S * 0.32;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath(); g.stroke();
      g.beginPath(); g.arc(0, 0, S * 0.13, 0, 7); g.stroke();
      break;
    }
    default: {   // monogram: the initials in a rule box
      g.lineWidth = S * 0.06;
      g.strokeRect(-S * 0.34, -S * 0.34, S * 0.68, S * 0.68);
      g.font = `bold ${Math.round(S * 0.44)}px Georgia, serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(r.letters, 0, S * 0.03);
    }
  }
  g.restore();
}

function initialsOf(name) {
  const words = name.replace(/[^A-Za-z& ]/g, '').split(/\s+/).filter((w) => w && w.length > 1 && w !== 'The');
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

// ------------------------------------------------------------ wordmark styles
//
// Ten authored recipes. Each fills a rect on all three layers and takes the same
// arguments, so fascia / valance / blade / parapet all route through one switch.
// `lit` is true where the style puts light into the emissive channel.

function plateFill(L, x, y, w, h, colour, rough, metal) {
  const p = PAD;
  // The gutter is filled with the plate colour, not left transparent: this is
  // what makes coarse mips degrade to "the sign's own colour" instead of "the
  // neighbouring shop's wordmark".
  L.al.g.fillStyle = colour;
  L.al.g.fillRect(x - p, y - p, w + p * 2, h + p * 2);
  L.rm.g.fillStyle = rmColor(rough, metal);
  L.rm.g.fillRect(x - p, y - p, w + p * 2, h + p * 2);
  L.em.g.fillStyle = '#000';
  L.em.g.fillRect(x - p, y - p, w + p * 2, h + p * 2);
}

// A soft, slightly uneven wash so a plate is never a flat fill. Named for what
// it is, not for src/weather.js, which is a different thing entirely.
function patina(g, x, y, w, h, r, strength = 0.06) {
  for (let i = 0; i < 22; i++) {
    const a = strength * (0.3 + r() * 0.7);
    g.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
    g.fillRect(x + r() * w, y + r() * h * 0.9, 6 + r() * (w * 0.25), 2 + r() * (h * 0.2));
  }
  const grad = g.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.16)');
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
}

// Glass tube: pale unlit trace on the albedo, saturated core plus halo on the
// emissive. Both are written here, in one function, so a change to one is a
// change to the other.
function tube(L, drawPath, hue, width, glow = 10) {
  const a = L.al.g, e = L.em.g;
  a.save(); e.save();
  a.lineCap = e.lineCap = 'round';
  a.lineJoin = e.lineJoin = 'round';
  // Unlit gas is a pale grey-green glass, not the lit colour.
  a.strokeStyle = hsl(hue, 18, 78, 0.85); a.lineWidth = width;
  drawPath(a);
  a.strokeStyle = 'rgba(255,255,255,0.35)'; a.lineWidth = width * 0.35;
  drawPath(a);
  e.shadowColor = hsl(hue, 95, 60); e.shadowBlur = glow;
  e.strokeStyle = hsl(hue, 92, 52); e.lineWidth = width * 1.15;
  drawPath(e);
  e.shadowBlur = 0;
  e.strokeStyle = hsl(hue, 70, 88); e.lineWidth = width * 0.4;
  drawPath(e);
  a.restore(); e.restore();
}

function drawWordmark(L, x, y, w, h, biz, r, opts = {}) {
  const g = L.al.g, e = L.em.g;
  const hue = biz.h;
  const text = opts.text ?? biz.n;
  const style = opts.style ?? biz.w;
  const pad = Math.max(6, h * 0.13);
  const boxW = w - pad * 2, boxH = h - pad * 2;
  const letters = initialsOf(biz.n) || 'PV';
  const markArgs = { letters };
  g.save(); e.save();
  g.textBaseline = 'middle'; e.textBaseline = 'middle';
  g.textAlign = 'left'; e.textAlign = 'left';

  switch (style) {
    // -- Porcelain enamel bar: saturated ground, hairline inner keyline, wide
    //    tracked caps. The bread-and-butter mid-century shopfront sign.
    case 'enamelBar': {
      plateFill(L, x, y, w, h, hsl(hue, 46, 32), 0.34, 0.06);
      g.strokeStyle = hsl(hue, 30, 88, 0.85); g.lineWidth = Math.max(1.5, h * 0.022);
      g.strokeRect(x + pad * 0.6, y + pad * 0.6, w - pad * 1.2, h - pad * 1.2);
      const t = caps(text);
      const fit = fitLine(g, t, boxW - h * 0.9, boxH * 0.62, FONT.sans(700), 0.13);
      g.font = FONT.sans(700)(fit.size);
      g.fillStyle = '#f7f4ec';
      drawTracked(g, t, x + w / 2 + h * 0.36, y + h * 0.5, fit, 0);
      drawMark(g, biz.m, x + pad + h * 0.3, y + h * 0.5, h * 0.62, hsl(hue, 28, 86), null, markArgs);
      patina(g, x, y, w, h, r, 0.05);
      break;
    }

    // -- Painted slab plate: ivory ground, serif caps, rules above and below.
    //    The oldest sign on the street and the one that reads best in daylight.
    case 'slabPlate': {
      plateFill(L, x, y, w, h, `hsl(${hue},14%,88%)`, 0.62, 0.0);
      const ink = hsl(hue, 52, 22);
      const t = caps(text);
      const fit = fitLine(g, t, boxW, boxH * 0.58, FONT.serif(700), 0.16);
      g.font = FONT.serif(700)(fit.size);
      g.fillStyle = ink;
      const tw = drawTracked(g, t, x + w / 2, y + h * 0.47, fit, 0);
      g.fillStyle = ink;
      g.fillRect(x + w / 2 - tw / 2 - 8, y + h * 0.76, tw + 16, Math.max(1.5, h * 0.018));
      g.fillRect(x + w / 2 - tw / 2 - 8, y + h * 0.18, tw + 16, Math.max(1.5, h * 0.018));
      drawMark(g, biz.m, x + w / 2, y + h * 0.9, h * 0.2, ink, null, markArgs);
      patina(g, x, y, w, h, r, 0.09);
      break;
    }

    // -- Painted timber board: visible grain, condensed caps, hard drop shadow.
    case 'boardPaint': {
      plateFill(L, x, y, w, h, hsl(hue, 24, 26), 0.84, 0.0);
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      for (let i = 0; i < 34; i++) {
        g.strokeStyle = `rgba(255,255,255,${(0.02 + r() * 0.045).toFixed(3)})`;
        g.lineWidth = 0.6 + r() * 1.6;
        const yy = y + r() * h;
        g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy + (r() - 0.5) * 4); g.stroke();
      }
      g.restore();
      const t = caps(text);
      const fit = fitLine(g, t, boxW, boxH * 0.66, FONT.impact(), 0.05, 0.6);
      g.font = FONT.impact()(fit.size);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      drawTracked(g, t, x + w / 2 + 3, y + h * 0.53 + 3, fit, 0);
      g.fillStyle = `hsl(${(hue + 40) % 360},58%,84%)`;
      drawTracked(g, t, x + w / 2, y + h * 0.5, fit, 0);
      patina(g, x, y, w, h, r, 0.12);
      break;
    }

    // -- Internally-lit channel letters on a dark raceway. Lit at night, and the
    //    unlit albedo is a saturated plastic face, not a glow.
    case 'channelLetters': {
      plateFill(L, x, y, w, h, `hsl(${hue},8%,13%)`, 0.42, 0.28);
      const t = caps(text);
      const fit = fitLine(g, t, boxW, boxH * 0.7, FONT.sans(800), 0.07, 0.62);
      g.font = FONT.sans(800)(fit.size);
      e.font = FONT.sans(800)(fit.size);
      // Returns: a dark offset copy gives the letters depth without geometry.
      g.fillStyle = 'rgba(0,0,0,0.75)';
      drawTracked(g, t, x + w / 2 + fit.size * 0.05, y + h * 0.53 + fit.size * 0.05, fit, 0);
      g.fillStyle = hsl(hue, 78, 58);
      drawTracked(g, t, x + w / 2, y + h * 0.5, fit, 0);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = Math.max(1, fit.size * 0.03);
      drawTracked(g, t, x + w / 2, y + h * 0.5, fit, 0, 'stroke');
      e.shadowColor = hsl(hue, 92, 62); e.shadowBlur = 9;
      e.fillStyle = hsl(hue, 88, 66);
      drawTracked(e, t, x + w / 2, y + h * 0.5, fit, 0);
      e.shadowBlur = 0;
      e.fillStyle = hsl(hue, 40, 92);
      e.font = FONT.sans(800)(fit.size);
      drawTracked(e, t, x + w / 2, y + h * 0.5, fit, 0);
      break;
    }

    // -- Neon script on a near-black panel, with a second tube rule underneath.
    case 'neonScript': {
      plateFill(L, x, y, w, h, '#0d0e12', 0.3, 0.12);
      g.strokeStyle = 'rgba(150,160,175,0.35)'; g.lineWidth = Math.max(1, h * 0.02);
      g.strokeRect(x + 3, y + 3, w - 6, h - 6);
      const fit = fitLine(g, text, boxW * 0.94, boxH * 0.62, FONT.italicSerif(700), 0.04, 0.7);
      const stroke = Math.max(2.2, fit.size * 0.085);
      const path = (ctx) => {
        ctx.save();
        ctx.font = FONT.italicSerif(700)(fit.size);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = stroke;
        ctx.translate(x + w / 2, y + h * 0.46);
        ctx.scale(fit.scaleX, 1);
        ctx.strokeText(text, 0, 0);
        ctx.restore();
      };
      tube(L, path, hue, stroke, 11);
      const rule = (ctx) => {
        ctx.beginPath();
        ctx.moveTo(x + w * 0.2, y + h * 0.82); ctx.lineTo(x + w * 0.8, y + h * 0.82);
        ctx.stroke();
      };
      tube(L, rule, (hue + 150) % 360, Math.max(2, h * 0.035), 8);
      break;
    }

    // -- Neon block caps outlined by a double tube, the loudest sign on the row.
    case 'neonBlock': {
      plateFill(L, x, y, w, h, '#101017', 0.32, 0.1);
      const t = caps(text);
      const fit = fitLine(g, t, boxW * 0.92, boxH * 0.62, FONT.sans(800), 0.1, 0.62);
      const stroke = Math.max(2.4, fit.size * 0.1);
      const path = (ctx) => {
        ctx.save(); ctx.font = FONT.sans(800)(fit.size);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineWidth = stroke;
        ctx.translate(x + w / 2 - (trackedWidth(ctx, t, fit.track) * fit.scaleX) / 2, y + h * 0.46);
        ctx.scale(fit.scaleX, 1);
        let cx = 0;
        for (const ch of t) { ctx.strokeText(ch, cx, 0); cx += ctx.measureText(ch).width + fit.track; }
        ctx.restore();
      };
      tube(L, path, hue, stroke, 12);
      const frame = (ctx) => { ctx.strokeRect(x + h * 0.13, y + h * 0.11, w - h * 0.26, h - h * 0.22); };
      tube(L, frame, (hue + 40) % 360, Math.max(2, h * 0.03), 8);
      break;
    }

    // -- Gilded glass: gold leaf on a deep panel, hairline outline, small caps.
    //    Metal 0.8, because gold leaf really is metal and reads wrong at 0.
    case 'gildedGlass': {
      plateFill(L, x, y, w, h, hsl(hue, 38, 14), 0.26, 0.2);
      const t = text.toUpperCase();
      const fit = fitLine(g, t, boxW * 0.9, boxH * 0.5, FONT.serif(400), 0.24);
      g.font = FONT.serif(400)(fit.size);
      const grad = g.createLinearGradient(x, y + h * 0.3, x, y + h * 0.72);
      grad.addColorStop(0, '#f6e3a8'); grad.addColorStop(0.5, '#d6ad4e'); grad.addColorStop(1, '#f2dfa0');
      g.fillStyle = grad;
      g.strokeStyle = 'rgba(30,22,8,0.65)'; g.lineWidth = Math.max(1, fit.size * 0.035);
      drawTracked(g, t, x + w / 2, y + h * 0.5, fit, 0, 'both');
      L.rm.g.fillStyle = rmColor(0.3, 0.8);
      L.rm.g.fillRect(x + w * 0.2, y + h * 0.34, w * 0.6, h * 0.32);
      // Rule-and-diamond ornament: period-correct and entirely generic.
      g.strokeStyle = '#c9a34e'; g.lineWidth = Math.max(1, h * 0.014);
      for (const yy of [y + h * 0.22, y + h * 0.79]) {
        g.beginPath(); g.moveTo(x + w * 0.16, yy); g.lineTo(x + w * 0.84, yy); g.stroke();
        g.save(); g.translate(x + w / 2, yy); g.rotate(Math.PI / 4);
        g.fillStyle = '#c9a34e'; g.fillRect(-h * 0.035, -h * 0.035, h * 0.07, h * 0.07); g.restore();
      }
      break;
    }

    // -- Brushed steel plate, stencilled caps, visible fixings. Trade counters.
    case 'stencilSteel': {
      plateFill(L, x, y, w, h, '#8f959c', 0.4, 0.86);
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      for (let i = 0; i < 90; i++) {
        const v = 130 + r() * 90;
        g.strokeStyle = `rgba(${v | 0},${(v + 4) | 0},${(v + 10) | 0},0.22)`;
        g.lineWidth = 0.5 + r() * 1.2;
        const yy = y + r() * h;
        g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
      }
      g.restore();
      const t = caps(text);
      const fit = fitLine(g, t, boxW * 0.86, boxH * 0.56, FONT.sans(700), 0.2, 0.7);
      g.font = FONT.sans(700)(fit.size);
      g.fillStyle = hsl(hue, 55, 24);
      drawTracked(g, t, x + w / 2, y + h * 0.5, fit, 0);
      // Stencil bridges: thin plate-coloured bars broken across the letters.
      g.fillStyle = 'rgba(150,156,164,0.9)';
      g.fillRect(x + w * 0.1, y + h * 0.44, w * 0.8, Math.max(1.4, h * 0.022));
      for (const s of [-1, 1]) {
        for (const c of [0.06, 0.94]) {
          g.fillStyle = 'rgba(60,64,70,0.75)';
          g.beginPath(); g.arc(x + w * c, y + h * (0.5 + s * 0.34), h * 0.045, 0, 7); g.fill();
        }
      }
      break;
    }

    // -- Deco vitrolite: two colour fields split by a chevron band, mixed case.
    case 'vitrolite': {
      plateFill(L, x, y, w, h, hsl(hue, 30, 20), 0.24, 0.05);
      g.fillStyle = hsl((hue + 24) % 360, 34, 30);
      g.fillRect(x, y, w, h * 0.5);
      g.fillStyle = hsl(hue, 42, 62);
      for (let i = 0; i < 9; i++) {
        g.save(); g.translate(x + w * (0.06 + i * 0.107), y + h * 0.5); g.rotate(Math.PI / 4);
        g.fillRect(-h * 0.05, -h * 0.05, h * 0.1, h * 0.1); g.restore();
      }
      const fit = fitLine(g, text, boxW * 0.92, boxH * 0.5, FONT.serif(400), 0.1);
      g.font = FONT.serif(400)(fit.size);
      g.fillStyle = '#f2ece0';
      drawTracked(g, text, x + w / 2, y + h * 0.74, fit, 0);
      drawMark(g, biz.m, x + w * 0.5, y + h * 0.24, h * 0.34, hsl(hue, 46, 78), null, markArgs);
      patina(g, x, y, w, h, r, 0.07);
      break;
    }

    // -- Flat contemporary sans on a light panel, with a single accent rule.
    default: {
      plateFill(L, x, y, w, h, '#e9eaec', 0.5, 0.0);
      g.fillStyle = hsl(hue, 58, 44);
      g.fillRect(x, y + h * 0.82, w, h * 0.18);
      const fit = fitLine(g, text, boxW * 0.9, boxH * 0.52, FONT.sans(400), 0.09);
      g.font = FONT.sans(400)(fit.size);
      g.fillStyle = '#22262c';
      drawTracked(g, text, x + w * 0.5, y + h * 0.44, fit, 0);
      drawMark(g, biz.m, x + w * 0.5, y + h * 0.16, h * 0.2, hsl(hue, 58, 44), null, markArgs);
      patina(g, x, y, w, h, r, 0.04);
    }
  }
  g.restore(); e.restore();
}

// ------------------------------------------------------ valance / blade / mark

function drawValance(L, x, y, w, h, biz, r) {
  const g = L.al.g;
  const dark = biz.a % 2 === 0;
  // The valance is the hem of the awning it hangs off, so it takes the AWNING's
  // colourway, not the business's brand hue. It used to take biz.h while the
  // awning fabric is chosen by biz.a — two independent numbers — so a green
  // canopy could and did finish in a purple hem. Found by looking at a 2.6x crop
  // of the Five Points hero frame after the fabric was recoloured: one shopfront
  // wearing two unrelated colours and reading as two objects.
  const hue = STRIPE_HUES[biz.a % STRIPE_HUES.length];
  plateFill(L, x, y, w, h, dark ? hsl(hue, 40, 26) : '#efe9dd', 0.9, 0.0);
  g.save();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  const t = caps(biz.n);
  const fit = fitLine(g, t, w * 0.78, h * 0.62, FONT.sans(700), 0.14, 0.6);
  g.font = FONT.sans(700)(fit.size);
  g.fillStyle = dark ? '#f4efe4' : hsl(hue, 52, 26);
  drawTracked(g, t, x + w / 2, y + h * 0.52, fit, 0);
  // Scalloped lower edge, printed rather than cut. A composite-erased scallop
  // would punch a transparent hole through a SHARED atlas, taking the gutter and
  // whatever is packed behind it with it; a contrasting band reads the same at
  // the distance a valance is ever seen from.
  const scallops = 14;
  g.fillStyle = dark ? hsl(hue, 30, 16) : hsl(hue, 34, 60);
  g.fillRect(x, y + h * 0.84, w, h * 0.16);
  for (let i = 0; i <= scallops; i++) {
    g.beginPath();
    g.arc(x + (w / scallops) * (i + 0.5), y + h * 0.84, h * 0.15, 0, Math.PI);
    g.fill();
  }
  patina(g, x, y, w, h, r, 0.07);
  g.restore();
}

function drawBlade(L, x, y, w, h, biz, r) {
  const g = L.al.g, e = L.em.g;
  const lit = LIT_STYLES.has(biz.w);
  plateFill(L, x, y, w, h, lit ? '#0e0f14' : hsl(biz.h, 34, 24), lit ? 0.3 : 0.45, 0.24);
  g.save(); e.save();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.strokeStyle = lit ? 'rgba(160,170,185,0.4)' : hsl(biz.h, 20, 78, 0.7);
  g.lineWidth = 2;
  g.strokeRect(x + 4, y + 4, w - 8, h - 8);
  drawMark(g, biz.m, x + w / 2, y + h * 0.26, w * 0.56,
    lit ? hsl(biz.h, 24, 84) : '#efe7d6', null, { letters: initialsOf(biz.n) || 'PV' });

  // The short form runs vertically: a blade is 0.75 m wide and a full name at
  // that width is unreadable from a car, whereas one stacked word is not.
  const t = caps(biz.s);
  const fit = fitLine(g, t, h * 0.42, w * 0.44, FONT.sans(700), 0.16, 0.62);
  const drawVertical = (ctx, fill) => {
    ctx.save();
    ctx.translate(x + w / 2, y + h * 0.68);
    ctx.rotate(-Math.PI / 2);
    ctx.font = FONT.sans(700)(fit.size);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = fill;
    drawTracked(ctx, t, 0, 0, fit, 0);
    ctx.restore();
  };
  drawVertical(g, lit ? hsl(biz.h, 30, 86) : '#f2ead8');
  if (lit) {
    e.shadowColor = hsl(biz.h, 92, 60); e.shadowBlur = 8;
    drawVertical(e, hsl(biz.h, 86, 62));
    e.shadowBlur = 0;
    drawVertical(e, hsl(biz.h, 40, 92));
    e.strokeStyle = hsl(biz.h, 88, 58); e.lineWidth = 3;
    e.strokeRect(x + 4, y + 4, w - 8, h - 8);
  }
  patina(g, x, y, w, h, r, lit ? 0.03 : 0.08);
  g.restore(); e.restore();
}

function drawMarkCell(L, x, y, size, biz) {
  plateFill(L, x, y, size, size, hsl(biz.h, 44, 30), 0.4, 0.1);
  drawMark(L.al.g, biz.m, x + size / 2, y + size / 2, size * 0.82, '#f4eee0', null,
    { letters: initialsOf(biz.n) || 'PV' });
}

// Awning fabric. Bars run across the cell's u axis so they map down-slope on the
// canopy — the direction real awning stripes run.
// Ten colourways, reweighted off the reference. What was here ran 20, 206, 348,
// 30, 268, 96, 142, 44, 292, 168 — a hue wheel with blue, purple and magenta in
// it, which is a generic set and reads as one. reference/sarasota/
// 02-Worth-s-Block has two SATURATED GOLD canopies over its shopfronts and
// 01-S.H.-Kress has a deep green-teal one; the awnings on a Gulf-coast main
// street are gold, amber, burgundy, forest green and the odd teal, because that
// is what does not look filthy after one summer of sun and afternoon rain.
// Eight of these are warm or green now and two are cool, instead of the other
// way round.
const STRIPE_HUES = [42, 36, 12, 356, 152, 28, 20, 48, 186, 96];
function drawStripe(L, x, y, size, i, r) {
  const g = L.al.g;
  const hue = STRIPE_HUES[i % STRIPE_HUES.length];
  // Gold has to be SATURATED to read as gold. At the flat s 48 / l 38 this used
  // for every hue, hue 42 comes out a dark olive — the exact colour the brief
  // means when it says our awnings are not the ones in the photographs. Warm
  // hues get a higher stop; the cool ones keep the darker one, which is what a
  // green or teal canvas actually looks like.
  const warm = hue < 70 || hue > 330;
  const barS = warm ? 58 : 44, barL = warm ? 45 : 32;
  const light = i % 3 === 0 ? '#f2ece1' : i % 3 === 1 ? '#e8e4d6' : hsl(hue, 22, 88);
  plateFill(L, x, y, size, size, light, 0.92, 0.0);
  // Three authored rhythms: even wide bands, a narrow triple, and a wide band
  // split by a hairline. Regular alternation on every awning on a street is the
  // single most obvious procedural tell.
  const rhythm = i % 3 === 0 ? [1, 1] : i % 3 === 1 ? [1.6, 0.34, 0.2, 0.34] : [2.2, 0.28];
  const unit = size / rhythm.reduce((a, b) => a + b, 0) / 2;
  let cx = x, k = 0;
  while (cx < x + size) {
    const wSeg = rhythm[k % rhythm.length] * unit;
    if (k % 2 === 0) {
      g.fillStyle = hsl(hue, barS, barL);
      g.fillRect(cx, y, Math.min(wSeg, x + size - cx), size);
    }
    cx += wSeg; k++;
  }
  // Slight sag/shading so the fabric is not a flat print.
  const grad = g.createLinearGradient(x, y, x, y + size);
  grad.addColorStop(0, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0.20)');
  g.fillStyle = grad; g.fillRect(x, y, size, size);
  patina(g, x, y, size, size, r, 0.05);
}

function drawMisc(L, key, x, y, size) {
  const map = {
    plateEdge: ['#2a2d33', 0.45, 0.4],
    steel: ['#9aa0a8', 0.38, 0.9],
    darkVinyl: ['#15171b', 0.6, 0.05],
    whiteEnamel: ['#eceae4', 0.35, 0.05],
    bladeBack: ['#6d7568', 0.55, 0.35],
    signBack: ['#9ba2a8', 0.45, 0.75],
    postBand: ['#4a4f56', 0.5, 0.6],
  };
  const [c, ro, me] = map[key] ?? map.plateEdge;
  plateFill(L, x, y, size, size, c, ro, me);
}

// -------------------------------------------------------------- street signage
//
// Street blades condense hard on purpose. "North Osprey Point Road" in 240 px is
// not a failure to plan — it is what a real blade does: the direction becomes a
// prefix glyph, the type becomes a suffix, and the body condenses to fill.

const SUFFIX = [
  [/\s+Boulevard$/, 'BLVD'], [/\s+Avenue$/, 'AVE'], [/\s+Street$/, 'ST'],
  [/\s+Row$/, 'ROW'], [/\s+Road$/, 'RD'], [/\s+Lane$/, 'LN'],
  [/\s+Drive$/, 'DR'], [/\s+Court$/, 'CT'], [/\s+Way$/, 'WAY'], [/\s+Parkway$/, 'PKWY'],
];
export function splitStreetName(name) {
  let body = name, prefix = '', suffix = '';
  const p = body.match(/^(North|South|East|West)\s+/);
  if (p) { prefix = p[1][0]; body = body.slice(p[0].length); }
  for (const [re, s] of SUFFIX) {
    if (re.test(body)) { suffix = s; body = body.replace(re, ''); break; }
  }
  return { prefix, body, suffix };
}

// Three municipal colourways, assigned by name hash. Real cities colour blades by
// district; one colour everywhere is flatter than the world it sits in.
const BLADE_PLATES = [
  { bg: '#1d5237', fg: '#f2f4ef' },   // Sarasota municipal green
  { bg: '#1b4256', fg: '#eef4f6' },   // bayfront teal
  { bg: '#4d2028', fg: '#f4ece6' },   // historic core maroon
];

function drawStreetBlade(L, x, y, w, h, name) {
  const g = L.al.g, e = L.em.g;
  const plate = BLADE_PLATES[hash32('plate', name) % BLADE_PLATES.length];
  plateFill(L, x, y, w, h, plate.bg, 0.44, 0.12);
  const { prefix, body, suffix } = splitStreetName(name);
  g.save(); e.save();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.strokeStyle = plate.fg; g.lineWidth = 1.5;
  g.strokeRect(x + 3, y + 3, w - 6, h - 6);

  let left = x + 7, right = x + w - 7;
  g.fillStyle = plate.fg;
  if (prefix) {
    g.font = FONT.sans(700)(Math.round(h * 0.42));
    g.fillText(prefix, left, y + h * 0.38);
    left += g.measureText(prefix).width + 4;
  }
  if (suffix) {
    g.font = FONT.sans(700)(Math.round(h * 0.42));
    const sw = g.measureText(suffix).width;
    g.fillText(suffix, right - sw, y + h * 0.38);
    right -= sw + 5;
  }
  const t = caps(body);
  const fit = fitLine(g, t, right - left, h * 0.72, FONT.sans(700), 0.05, 0.55);
  g.font = FONT.sans(700)(fit.size);
  g.fillStyle = plate.fg;
  drawTracked(g, t, (left + right) / 2, y + h * 0.53, fit, 0);
  // Retroreflective sheeting: the whole plate returns a little light, the legend
  // rather more, which is why a blade reads white-on-dark in headlights.
  e.fillStyle = 'rgba(70,80,74,1)';
  e.fillRect(x, y, w, h);
  e.font = FONT.sans(700)(fit.size);
  e.textBaseline = 'middle'; e.textAlign = 'left';
  e.fillStyle = 'rgba(226,232,224,1)';
  drawTracked(e, t, (left + right) / 2, y + h * 0.53, fit, 0);
  g.restore(); e.restore();
}

// Regulatory faces. These are traffic-control shapes, which are public-domain by
// nature and carry no brand: an octagon that says STOP, a red annulus, a white
// triangle. Nothing here is anyone's mark.
function drawRegulatory(L, key, x, y, w, h) {
  const g = L.al.g, e = L.em.g;
  const cx = x + w / 2, cy = y + h / 2;
  plateFill(L, x, y, w, h, '#0c0d10', 0.42, 0.5);
  g.save(); e.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  e.textAlign = 'center'; e.textBaseline = 'middle';

  const poly = (ctx, n, rad, rot) => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  };

  switch (key) {
    case 'stop':
      for (const ctx of [g, e]) {
        ctx.fillStyle = ctx === g ? '#a8161d' : '#5c0d11';
        poly(ctx, 8, w * 0.47, Math.PI / 8); ctx.fill();
        ctx.strokeStyle = ctx === g ? '#f0eee9' : '#8a8580'; ctx.lineWidth = w * 0.035;
        poly(ctx, 8, w * 0.40, Math.PI / 8); ctx.stroke();
        ctx.font = FONT.sans(700)(Math.round(w * 0.27));
        ctx.fillStyle = ctx === g ? '#f5f2ec' : '#d8d4cc';
        ctx.save(); ctx.translate(cx, cy); ctx.scale(0.94, 1);
        ctx.fillText('STOP', 0, w * 0.015); ctx.restore();
      }
      break;
    case 'doNotEnter':
      for (const ctx of [g, e]) {
        ctx.fillStyle = ctx === g ? '#a8161d' : '#5c0d11';
        ctx.beginPath(); ctx.arc(cx, cy, w * 0.46, 0, 7); ctx.fill();
        ctx.fillStyle = ctx === g ? '#f2efe9' : '#cfcbc4';
        ctx.fillRect(cx - w * 0.32, cy - w * 0.085, w * 0.64, w * 0.17);
      }
      g.font = FONT.sans(700)(Math.round(w * 0.1));
      g.fillStyle = '#f2efe9';
      g.fillText('DO NOT ENTER', cx, cy + w * 0.3);
      break;
    case 'yield':
      for (const ctx of [g, e]) {
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.46, cy - h * 0.34); ctx.lineTo(cx + w * 0.46, cy - h * 0.34);
        ctx.lineTo(cx, cy + h * 0.44); ctx.closePath();
        ctx.fillStyle = ctx === g ? '#a8161d' : '#5c0d11'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.34, cy - h * 0.27); ctx.lineTo(cx + w * 0.34, cy - h * 0.27);
        ctx.lineTo(cx, cy + h * 0.31); ctx.closePath();
        ctx.fillStyle = ctx === g ? '#f2efe9' : '#cbc7c0'; ctx.fill();
        ctx.font = FONT.sans(700)(Math.round(w * 0.17));
        ctx.fillStyle = ctx === g ? '#a8161d' : '#6a5c58';
        ctx.fillText('YIELD', cx, cy - h * 0.1);
      }
      break;
    default:   // noLeft: red annulus with a slash over a left arrow
      for (const ctx of [g, e]) {
        ctx.fillStyle = ctx === g ? '#f2efe9' : '#c9c5be';
        ctx.beginPath(); ctx.arc(cx, cy, w * 0.46, 0, 7); ctx.fill();
        ctx.strokeStyle = ctx === g ? '#a8161d' : '#5c0d11'; ctx.lineWidth = w * 0.08;
        ctx.beginPath(); ctx.arc(cx, cy, w * 0.41, 0, 7); ctx.stroke();
        ctx.fillStyle = ctx === g ? '#15171b' : '#2a2c30';
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.28, cy + w * 0.02); ctx.lineTo(cx - w * 0.08, cy - w * 0.16);
        ctx.lineTo(cx - w * 0.08, cy - w * 0.05); ctx.lineTo(cx + w * 0.2, cy - w * 0.05);
        ctx.lineTo(cx + w * 0.2, cy + w * 0.22); ctx.lineTo(cx + w * 0.06, cy + w * 0.22);
        ctx.lineTo(cx + w * 0.06, cy + w * 0.09); ctx.lineTo(cx - w * 0.08, cy + w * 0.09);
        ctx.lineTo(cx - w * 0.08, cy + w * 0.2); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = ctx === g ? '#a8161d' : '#5c0d11'; ctx.lineWidth = w * 0.075;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.3, cy - w * 0.3); ctx.lineTo(cx + w * 0.3, cy + w * 0.3); ctx.stroke();
      }
  }
  g.restore(); e.restore();
}

function drawTallSign(L, key, x, y, w, h) {
  const g = L.al.g, e = L.em.g;
  const cx = x + w / 2;
  plateFill(L, x, y, w, h, '#eeece6', 0.44, 0.5);
  // Both layers get the SAME artwork, the emissive in muted sheeting values.
  // Filling the emissive with one flat colour instead — the obvious shortcut —
  // washes the legend out at night, which is the opposite of what retroreflective
  // sheeting does: the legend returns light too, just in its own colour.
  const PAL = {
    white:  ['#eeece6', 'rgb(196,201,196)'],
    green:  ['#14532b', 'rgb(38,74,48)'],
    red:    ['#a8161d', 'rgb(92,26,28)'],
    ink:    ['#15171b', 'rgb(34,37,40)'],
  };
  for (const [ci, ctx] of [[0, g], [1, e]]) {
    const c = (k) => PAL[k][ci];
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (ci === 1) { ctx.fillStyle = c('white'); ctx.fillRect(x, y, w, h); }
    const border = (colour) => {
      ctx.strokeStyle = colour; ctx.lineWidth = Math.max(2, w * 0.035);
      ctx.strokeRect(x + w * 0.05, y + h * 0.04, w * 0.9, h * 0.92);
    };
    if (key === 'parking') {
      border(c('green'));
      ctx.fillStyle = c('green');
      ctx.font = FONT.sans(700)(Math.round(h * 0.36));
      ctx.fillText('P', cx, y + h * 0.29);
      ctx.font = FONT.sans(700)(Math.round(h * 0.115));
      ctx.fillText('2 HOUR', cx, y + h * 0.56);
      ctx.fillText('8A - 6P', cx, y + h * 0.69);
      ctx.fillText('MON - SAT', cx, y + h * 0.82);
    } else if (key === 'noParking') {
      border(c('red'));
      ctx.strokeStyle = c('red'); ctx.lineWidth = Math.max(2, w * 0.06);
      ctx.beginPath(); ctx.arc(cx, y + h * 0.33, w * 0.29, 0, 7); ctx.stroke();
      ctx.fillStyle = c('red');
      ctx.font = FONT.sans(700)(Math.round(h * 0.28));
      ctx.fillText('P', cx, y + h * 0.33);
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.23, y + h * 0.22); ctx.lineTo(cx + w * 0.23, y + h * 0.44);
      ctx.stroke();
      ctx.font = FONT.sans(700)(Math.round(h * 0.115));
      ctx.fillStyle = c('ink');
      ctx.fillText('NO PARKING', cx, y + h * 0.68);
      ctx.fillText('ANY TIME', cx, y + h * 0.81);
    } else {
      const limit = key === 'speed25' ? '25' : '35';
      border(c('ink'));
      ctx.fillStyle = c('ink');
      ctx.font = FONT.sans(700)(Math.round(h * 0.125));
      ctx.fillText('SPEED', cx, y + h * 0.18);
      ctx.fillText('LIMIT', cx, y + h * 0.32);
      ctx.font = FONT.sans(700)(Math.round(h * 0.4));
      ctx.fillText(limit, cx, y + h * 0.64);
    }
    ctx.restore();
  }
}

function drawWideSign(L, key, x, y, w, h) {
  const g = L.al.g, e = L.em.g;
  const cy = y + h / 2;
  g.save(); e.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (key === 'oneWayLeft' || key === 'oneWayRight') {
    // The legend sits INSIDE the arrow shaft rather than under it. A one-way
    // plate is 1.05 m wide in world and read at speed; two stacked elements
    // halve the height of both and neither survives the distance.
    const dir = key === 'oneWayLeft' ? -1 : 1;
    plateFill(L, x, y, w, h, '#15171b', 0.44, 0.5);
    const arrow = (ctx, fill) => {
      const shaftH = h * 0.56, headW = w * 0.2;
      const tipX = x + w * (dir > 0 ? 0.94 : 0.06);
      const baseX = x + w * (dir > 0 ? 0.06 : 0.94);
      const neckX = tipX - dir * headW;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(baseX, cy - shaftH / 2);
      ctx.lineTo(neckX, cy - shaftH / 2);
      ctx.lineTo(neckX, cy - shaftH * 0.92);
      ctx.lineTo(tipX, cy);
      ctx.lineTo(neckX, cy + shaftH * 0.92);
      ctx.lineTo(neckX, cy + shaftH / 2);
      ctx.lineTo(baseX, cy + shaftH / 2);
      ctx.closePath(); ctx.fill();
    };
    arrow(g, '#f2efe9');
    g.font = FONT.sans(700)(Math.round(h * 0.34));
    g.fillStyle = '#15171b';
    g.textBaseline = 'middle';
    g.fillText('ONE WAY', x + w * (dir > 0 ? 0.42 : 0.58), cy + h * 0.02);
    e.fillStyle = 'rgba(36,40,40,1)'; e.fillRect(x, y, w, h);
    arrow(e, 'rgba(210,216,210,1)');
    e.font = FONT.sans(700)(Math.round(h * 0.34));
    e.fillStyle = 'rgba(40,44,44,1)'; e.textAlign = 'center'; e.textBaseline = 'middle';
    e.fillText('ONE WAY', x + w * (dir > 0 ? 0.42 : 0.58), cy + h * 0.02);
  } else if (key === 'wayfind') {
    plateFill(L, x, y, w, h, '#1b4256', 0.46, 0.4);
    for (const [ci, ctx] of [[0, g], [1, e]]) {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (ci === 1) { ctx.fillStyle = 'rgb(42,54,62)'; ctx.fillRect(x, y, w, h); }
      ctx.fillStyle = ci ? 'rgb(190,200,202)' : '#eef4f6';
      ctx.font = FONT.sans(700)(Math.round(h * 0.3));
      ctx.fillText('VERANO BAY', x + w * 0.44, cy - h * 0.16);
      ctx.font = FONT.sans(400)(Math.round(h * 0.2));
      ctx.fillText('MARINA  1/4 MI', x + w * 0.44, cy + h * 0.22);
      ctx.beginPath();
      ctx.moveTo(x + w * 0.92, cy);
      ctx.lineTo(x + w * 0.82, cy - h * 0.22); ctx.lineTo(x + w * 0.82, cy + h * 0.22);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  } else {
    plateFill(L, x, y, w, h, '#20242a', 0.5, 0.2);
    for (const [ci, ctx] of [[0, g], [1, e]]) {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (ci === 1) { ctx.fillStyle = 'rgb(26,30,34)'; ctx.fillRect(x, y, w, h); }
      ctx.fillStyle = ci ? 'rgb(186,182,170)' : '#e8e4d8';
      ctx.font = FONT.sans(700)(Math.round(h * 0.44));
      ctx.fillText('1200 - 1298', x + w * 0.5, cy);
      ctx.restore();
    }
  }
  g.restore(); e.restore();
}

// ------------------------------------------------------------- atlas building

function buildShopAtlas() {
  const p = new ShelfPacker(SHOP_W, PAD);
  const n = BUSINESSES.length;
  for (let i = 0; i < n; i++) p.add(`fascia:${i}`, ...CELL.fascia);
  p.newShelf();
  for (let i = 0; i < n; i++) p.add(`valance:${i}`, ...CELL.valance);
  p.newShelf();
  for (let i = 0; i < n; i++) p.add(`blade:${i}`, ...CELL.blade);
  p.newShelf();
  for (let i = 0; i < n; i++) p.add(`mark:${i}`, ...CELL.mark);
  p.newShelf();
  // The misc swatches are 32 px and ride in the tail of the stripe shelf: ten
  // stripes leave eight free slots there, and a dedicated shelf for four
  // 32 px squares would cost 40 px of atlas for 4096 texels of content.
  for (let i = 0; i < STRIPES; i++) p.add(`stripe:${i}`, ...CELL.stripe);
  for (const k of MISC) p.add(`misc:${k}`, ...CELL.misc);
  const H = p.finish();

  const L = layers(SHOP_W, H);
  // A dark ground everywhere, so any texel a helper misses reads as shadow
  // rather than as white, which is the difference between a subtle gap and a
  // glowing rectangle floating on a wall.
  L.al.g.fillStyle = '#101216'; L.al.g.fillRect(0, 0, SHOP_W, H);
  L.em.g.fillStyle = '#000'; L.em.g.fillRect(0, 0, SHOP_W, H);
  L.rm.g.fillStyle = rmColor(0.6, 0.0); L.rm.g.fillRect(0, 0, SHOP_W, H);

  for (let i = 0; i < n; i++) {
    const biz = BUSINESSES[i];
    const r = rng(hash32('sign', biz.n));
    let c = p.rects.get(`fascia:${i}`);
    drawWordmark(L, c.x, c.y, c.w, c.h, biz, r);
    c = p.rects.get(`valance:${i}`);
    drawValance(L, c.x, c.y, c.w, c.h, biz, r);
    c = p.rects.get(`blade:${i}`);
    drawBlade(L, c.x, c.y, c.w, c.h, biz, r);
    c = p.rects.get(`mark:${i}`);
    drawMarkCell(L, c.x, c.y, c.w, biz);
  }
  for (let i = 0; i < STRIPES; i++) {
    const c = p.rects.get(`stripe:${i}`);
    drawStripe(L, c.x, c.y, c.w, i, rng(hash32('stripe', i)));
  }
  for (const k of MISC) {
    const c = p.rects.get(`misc:${k}`);
    drawMisc(L, k, c.x, c.y, c.w);
  }
  return { L, packer: p, W: SHOP_W, H };
}

function buildStreetAtlas(streetNames) {
  const names = streetNames.slice();
  const p = new ShelfPacker(STREET_W, PAD);
  for (let i = 0; i < names.length; i++) p.add(`street:${i}`, ...SCELL.blade);
  p.newShelf();
  // reg and tall are the same cell height, so they share a shelf; breaking
  // between them would cost a whole 136 px row for four signs.
  for (const k of REG_SIGNS) p.add(`reg:${k}`, ...SCELL.reg);
  for (const k of TALL_SIGNS) p.add(`reg:${k}`, ...SCELL.tall);
  p.newShelf();
  for (const k of WIDE_SIGNS) p.add(`reg:${k}`, ...SCELL.wide);
  p.newShelf();
  for (const k of SMISC) p.add(`misc:${k}`, ...SCELL.misc);
  const H = p.finish();

  const L = layers(STREET_W, H);
  L.al.g.fillStyle = '#14161a'; L.al.g.fillRect(0, 0, STREET_W, H);
  L.em.g.fillStyle = '#000'; L.em.g.fillRect(0, 0, STREET_W, H);
  L.rm.g.fillStyle = rmColor(0.5, 0.4); L.rm.g.fillRect(0, 0, STREET_W, H);

  names.forEach((name, i) => {
    const c = p.rects.get(`street:${i}`);
    drawStreetBlade(L, c.x, c.y, c.w, c.h, name);
  });
  for (const k of REG_SIGNS) { const c = p.rects.get(`reg:${k}`); drawRegulatory(L, k, c.x, c.y, c.w, c.h); }
  for (const k of TALL_SIGNS) { const c = p.rects.get(`reg:${k}`); drawTallSign(L, k, c.x, c.y, c.w, c.h); }
  for (const k of WIDE_SIGNS) { const c = p.rects.get(`reg:${k}`); drawWideSign(L, k, c.x, c.y, c.w, c.h); }
  for (const k of SMISC) { const c = p.rects.get(`misc:${k}`); drawMisc(L, k, c.x, c.y, c.w); }
  return { L, packer: p, W: STREET_W, H, names };
}

// ------------------------------------------------------------------- textures

function toTexture(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  // Atlases must never wrap: a sub-rect that samples past its own edge picks up
  // whichever shop happens to be packed next to it.
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Names baked into the street atlas. Callers pass district.json's streetNames. */
let streetNameList = null;

/**
 * The shop atlas: every business wordmark, valance, blade, mark and awning
 * fabric in the district, in one texture set.
 *
 * @returns {{map, emissiveMap, rmMap, rects: Map, W:number, H:number, util:number}}
 */
export function shopAtlas() {
  return memo('atlas:shop', () => {
    const a = buildShopAtlas();
    return {
      map: toTexture(a.L.al.c, true),
      emissiveMap: toTexture(a.L.em.c, true),
      rmMap: toTexture(a.L.rm.c, false),
      rects: a.packer.rects, W: a.W, H: a.H, util: a.packer.utilisation,
      canvases: a.L,
    };
  });
}

/**
 * The street atlas: one blade per invented street name plus the regulatory set.
 *
 * @param {string[]} [names]  invented street names; only read on first call
 */
export function streetAtlas(names) {
  if (names && !streetNameList) streetNameList = dedupe(names);
  return memo('atlas:street', () => {
    const a = buildStreetAtlas(streetNameList ?? FALLBACK_STREETS);
    return {
      map: toTexture(a.L.al.c, true),
      emissiveMap: toTexture(a.L.em.c, true),
      rmMap: toTexture(a.L.rm.c, false),
      rects: a.packer.rects, W: a.W, H: a.H, util: a.packer.utilisation,
      names: a.names, index: new Map(a.names.map((n, i) => [n, i])),
      canvases: a.L,
    };
  });
}

function dedupe(list) {
  return [...new Set(list)].sort();
}

// Used when nobody hands us district.json - the lab and the unit path both work
// standalone. Real downtown Sarasota streets, matching what the bake now emits.
const FALLBACK_STREETS = [
  'Main Street', 'North Gulfstream Avenue', 'South Pineapple Avenue', 'Ringling Boulevard',
  'North Lemon Avenue', 'North Palm Avenue', 'Cocoanut Avenue', 'Central Avenue',
  'Bayfront Drive', 'Mound Street', 'Orange Avenue', 'Osprey Avenue',
];

// ------------------------------------------------------------------ materials

/**
 * The single material every shop sign in the district shares. Memoised, so a
 * street of forty storefronts cannot produce more than one.
 */
export function signMaterial({ time = 'night' } = {}) {
  const m = memo('mat:sign', () => {
    const a = shopAtlas();
    return new THREE.MeshStandardMaterial({
      map: a.map, emissiveMap: a.emissiveMap,
      roughnessMap: a.rmMap, metalnessMap: a.rmMap,
      roughness: 1, metalness: 1,
      emissive: 0xffffff, emissiveIntensity: 0,
      vertexColors: true,
    });
  });
  setSignageTime(time);
  return m;
}

/** The single material for all street and regulatory signage. */
export function streetSignMaterial({ time = 'night', names } = {}) {
  const m = memo('mat:street', () => {
    const a = streetAtlas(names);
    return new THREE.MeshStandardMaterial({
      map: a.map, emissiveMap: a.emissiveMap,
      roughnessMap: a.rmMap, metalnessMap: a.rmMap,
      roughness: 1, metalness: 1,
      emissive: 0xffffff, emissiveIntensity: 0,
      vertexColors: true,
    });
  });
  setSignageTime(time);
  return m;
}

/**
 * Push a time of day into both signage materials. Cheap: rescale only.
 *
 * Throws on an hour this file has no entry for. The `?? 0` this replaces meant a
 * new time of day silently switched every sign in the district off - a defect
 * that looks like a content bug at the far end of a render, not like a missing
 * table row. Adding the 'golden' preset is what made that reachable.
 */
export function setSignageTime(time) {
  if (!(time in SIGN_EMISSIVE) || !(time in STREET_EMISSIVE)) {
    throw new Error(`signage has no emissive level for time of day: ${time}`);
  }
  const s = cache.get('mat:sign');
  if (s) { s.emissiveIntensity = SIGN_EMISSIVE[time]; s.needsUpdate = true; }
  const t = cache.get('mat:street');
  if (t) { t.emissiveIntensity = STREET_EMISSIVE[time]; t.needsUpdate = true; }
}

/**
 * Generate everything up front behind the loading screen and report the cost.
 * With 100% procedural assets, texture generation is a startup budget that has to
 * be profiled like any other.
 *
 * @param {{streetNames?: string[]}} opts  values of district.json's streetNames
 */
export function generateSignageLibrary({ streetNames } = {}) {
  const t0 = performance.now();
  const shop = shopAtlas();
  const tShop = performance.now();
  const street = streetAtlas(streetNames);
  const t1 = performance.now();
  const mb = (w, h) => +((w * h * 4) / 1048576).toFixed(2);
  return {
    ms: +(t1 - t0).toFixed(1),
    shopMs: +(tShop - t0).toFixed(1),
    streetMs: +(t1 - tShop).toFixed(1),
    shop: { w: shop.W, h: shop.H, cells: shop.rects.size, util: +(shop.util * 100).toFixed(1) },
    street: { w: street.W, h: street.H, cells: street.rects.size, util: +(street.util * 100).toFixed(1),
              names: street.names.length },
    businesses: BUSINESSES.length,
    // Albedo full res, emissive half (a quarter of the texels), rm quarter (a
    // sixteenth) — a glow and a material mask carry no high-frequency detail
    // worth paying for. x4/3 for the mip chain. This is the whole district's
    // signage: every wordmark, awning, blade and street sign it will ever show.
    vramMB: +((mb(shop.W, shop.H) + mb(street.W, street.H)) * 1.3125 * (4 / 3)).toFixed(1),
  };
}

// ----------------------------------------------------------- UV sub-rect API
//
// Addressing: every sign is one packed cell, and a cell is addressed by
// "<kind>:<index>" for shop cells or "<kind>:<key>" for street cells. rectOf()
// turns that into the [u0,v0,u1,v1] quad UVs every geometry helper below takes.

/** UV rect for a shop-atlas cell. kind: fascia | valance | blade | mark | stripe | misc */
export function shopRect(kind, key) {
  const a = shopAtlas();
  const r = a.rects.get(`${kind}:${key}`);
  if (!r) throw new Error(`signage: no shop cell ${kind}:${key}`);
  return uvOf(r, a.W, a.H);
}

/** UV rect for a street-atlas cell. kind: street | reg | misc */
export function streetRect(kind, key) {
  const a = streetAtlas();
  const r = a.rects.get(`${kind}:${key}`);
  if (!r) throw new Error(`signage: no street cell ${kind}:${key}`);
  return uvOf(r, a.W, a.H);
}

/** UV rect for a named street's blade; falls back to the first blade. */
export function streetNameRect(name) {
  const a = streetAtlas();
  const i = a.index.has(name) ? a.index.get(name) : 0;
  return streetRect('street', i);
}

/** Is a street name present in the baked atlas? */
export function hasStreetName(name) { return streetAtlas().index.has(name); }

// ------------------------------------------------------------ geometry helpers
//
// Same calling convention as facades.js and geom.js: (shape args..., pos, nrm,
// uv, idx, opts). Nothing here builds a Mesh, a Material or a BufferGeometry, so
// the streamer can merge a whole chunk's signage into one geometry.
//
// Buffers always carry `col`: the signage materials declare vertexColors, and a
// geometry with the attribute missing renders black. buffers() below returns the
// right shape.

/** An empty buffer bundle in the shape every helper here appends into. */
export function buffers() {
  return { pos: [], nrm: [], uv: [], idx: [], col: [] };
}

// A local copy of facades.js's winding-corrected quad, because facades does not
// export it. The correction is not optional: OSM gives both ring windings (168 of
// the district's 523 footprints wind the other way) and a sign on the wrong side
// of a wall is invisible rather than obviously broken.
function quad(pos, nrm, uv, idx, a, b, c, d, n, uvq, col, tint) {
  let ua = [uvq[0], uvq[1]], ub = [uvq[2], uvq[1]];
  const uc = [uvq[2], uvq[3]];
  let ud = [uvq[0], uvq[3]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const gx = e1[1] * e2[2] - e1[2] * e2[1];
  const gy = e1[2] * e2[0] - e1[0] * e2[2];
  const gz = e1[0] * e2[1] - e1[1] * e2[0];
  if (gx * n[0] + gy * n[1] + gz * n[2] < 0) {
    const tp = b; b = d; d = tp;
    const tu = ub; ub = ud; ud = tu;
  }
  const v = pos.length / 3;
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  for (let i = 0; i < 4; i++) nrm.push(n[0], n[1], n[2]);
  uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1], ud[0], ud[1]);
  idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  const t = tint ?? [1, 1, 1];
  if (col) for (let i = 0; i < 4; i++) col.push(t[0], t[1], t[2]);
}

/**
 * A flat sign panel in world space, given its centre, a right vector, an up
 * vector and a size. The primitive every other helper here is built from.
 *
 * @param {number[]} c   centre [x,y,z]
 * @param {number[]} rt  unit right vector [x,y,z]
 * @param {number[]} up  unit up vector [x,y,z]
 * @param {number} w     width along rt, metres
 * @param {number} h     height along up, metres
 * @param {number[]} rect  UV sub-rect [u0,v0,u1,v1] from shopRect/streetRect
 */
export function signPanel(c, rt, up, w, h, rect, pos, nrm, uv, idx, opts = {}) {
  const hw = w / 2, hh = h / 2;
  const n = opts.normal ?? [
    rt[1] * up[2] - rt[2] * up[1],
    rt[2] * up[0] - rt[0] * up[2],
    rt[0] * up[1] - rt[1] * up[0],
  ];
  const P = (sx, sy) => [
    c[0] + rt[0] * sx * hw + up[0] * sy * hh,
    c[1] + rt[1] * sx * hw + up[1] * sy * hh,
    c[2] + rt[2] * sx * hw + up[2] * sy * hh,
  ];
  const q = opts.mirror ? [rect[2], rect[1], rect[0], rect[3]] : rect;
  quad(pos, nrm, uv, idx, P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), n, q, opts.col, opts.tint);
  if (opts.doubleSided) {
    // The BACK of a sign is blank aluminium, not the artwork again.
    //
    // This used to sample the FRONT rect with u0/u1 swapped, so standing behind a
    // stop sign showed a red octagon reading "POTS", and behind a shopfront blade
    // showed its wordmark reversed. A blind critic caught both in one frame. The
    // atlas has carried `signBack` and `bladeBack` cells since it was authored -
    // the comment at the top of this file lists them as "sign backs" - they were
    // simply never wired to the face that needs them.
    //
    // Callers that genuinely want art on both sides (a hanging blade read from
    // either side of a street) pass backRect explicitly.
    // The default back is the FRONT's own rect, not the u-swapped one.
    //
    // Swapping u looks like the right way to turn artwork around and is exactly
    // backwards. The back face's positions already run the other way, so its u
    // axis already points along the back viewer's right; swapping the rect on top
    // of that reverses it again and mirrors the lettering. tools/sign-orient.mjs
    // measures both: with the old default one face of every double-sided panel
    // read `mir`, with this one both read `fwd`.
    //
    // Callers that want a genuinely blank back still pass backRect (postSign
    // passes signBack, streetBladeAssembly passes bladeBack) -- the shop atlas
    // has no back cell, and a shop blade really is lettered on both faces.
    const back = opts.backRect ?? q;
    quad(pos, nrm, uv, idx, P(1, -1), P(-1, -1), P(-1, 1), P(1, 1),
      [-n[0], -n[1], -n[2]], back, opts.col, opts.tint);
  }
}

/**
 * An axis-aligned box whose six faces all sample one atlas rect — sign returns,
 * plate edges, post bands. facades.js has the same helper against the trim atlas;
 * this one takes an explicit UV rect because the atlas differs.
 */
export function signBox(cx, cy, cz, sx, sy, sz, rect, pos, nrm, uv, idx, opts = {}) {
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  quad(pos, nrm, uv, idx, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], rect, col, t);
  quad(pos, nrm, uv, idx, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], rect, col, t);
  quad(pos, nrm, uv, idx, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], rect, col, t);
  quad(pos, nrm, uv, idx, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], rect, col, t);
  quad(pos, nrm, uv, idx, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], rect, col, t);
  quad(pos, nrm, uv, idx, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], rect, col, t);
}

/**
 * A wordmark plate mounted flat on a wall edge, with returns so it reads as a
 * board rather than a decal. The workhorse for storefront fascias and for the
 * face of a parapet sign blank.
 *
 * @param {Object} e   an edge from facades.js edgesOf()
 * @param {number} s0  start distance along the edge, metres
 * @param {number} s1  end distance
 * @param {number} y0  bottom height
 * @param {number} y1  top height
 */
// Lay text out the way it is read from the street, not the way the ring winds.
//
// facades.js edgesOf() flips the NORMAL by ring winding so it always points
// outward, but leaves the TANGENT following ring order:
//     const flip = ringArea(ring) > 0 ? -1 : 1;
//     tx: dx / len,           tz: dz / len,
//     nx: (dz / len) * flip,  nz: (-dx / len) * flip,
// So (tangent, outward normal) is right-handed on one winding and left-handed on
// the other, and any text emitted along +t runs BACKWARDS on the reversed set -
// 168 of this district's 523 footprints, 32% of every shopfront name.
//
// quad()'s winding correction hid the cause and made it worse: its comment says
// it exists because "a sign on the wrong side of a wall is invisible rather than
// obviously broken", and it duly fixed the VISIBILITY. It does not touch
// ORIENTATION, so the corrected face renders mirrored instead of missing. A blind
// critic read "Verano Wash House" reversed off a hero frame, two rounds after the
// same symptom was fixed on street signs - that earlier fix routed through
// postSign, which builds its own basis and never had the bug.
//
// cross is exactly +/-1 here (t and n are unit and perpendicular), so this is a
// sign test, not a tolerance. A district probe counts 36 edges at +1 and 47 at -1,
// which is the winding split made visible.
//
// The DIRECTION of the test was established by rendering it both ways, not by
// derivation - I reasoned my way to `cross > 0` first and it was backwards. Three
// earlier attempts also missed because they patched fasciaPlate and bladeSign,
// while the reversed name a critic actually read off the frame was drawn by the
// awning VALANCE. Four wrong guesses; the probe that enumerated which emitter
// carries which business took two minutes and would have saved all of them.
export function orientRect(e, rect) {
  const cross = e.tx * e.nz - e.tz * e.nx;
  return cross < 0 ? [rect[2], rect[1], rect[0], rect[3]] : rect;
}

export function fasciaPlate(e, s0, s1, y0, y1, rect, pos, nrm, uv, idx, opts = {}) {
  const out = opts.out ?? 0.06, thick = opts.thick ?? 0.09;
  const edgeRect = opts.edgeRect ?? shopRect('misc', 'plateEdge');
  const col = opts.col, t = opts.tint;
  const face = out + thick;
  const P = (s, o) => [e.a[0] + e.tx * s + e.nx * o, e.a[1] + e.tz * s + e.nz * o];
  const f0 = P(s0, face), f1 = P(s1, face);
  const b0 = P(s0, out), b1 = P(s1, out);
  const n = [e.nx, 0, e.nz];
  quad(pos, nrm, uv, idx,
    [f0[0], y0, f0[1]], [f1[0], y0, f1[1]], [f1[0], y1, f1[1]], [f0[0], y1, f0[1]],
    n, orientRect(e, rect), col, t);
  // Returns. Small, but without them a fascia is a sticker at a glancing angle.
  quad(pos, nrm, uv, idx,
    [b0[0], y1, b0[1]], [b1[0], y1, b1[1]], [f1[0], y1, f1[1]], [f0[0], y1, f0[1]],
    [0, 1, 0], edgeRect, col, t);
  quad(pos, nrm, uv, idx,
    [f0[0], y0, f0[1]], [f1[0], y0, f1[1]], [b1[0], y0, b1[1]], [b0[0], y0, b0[1]],
    [0, -1, 0], edgeRect, col, t);
  quad(pos, nrm, uv, idx,
    [b0[0], y0, b0[1]], [f0[0], y0, f0[1]], [f0[0], y1, f0[1]], [b0[0], y1, b0[1]],
    [-e.tx, 0, -e.tz], edgeRect, col, t);
  quad(pos, nrm, uv, idx,
    [f1[0], y0, f1[1]], [b1[0], y0, b1[1]], [b1[0], y1, b1[1]], [f1[0], y1, f1[1]],
    [e.tx, 0, e.tz], edgeRect, col, t);
}

/**
 * Sign hardware — posts, arms, brackets. Where it lands is the whole integration
 * decision in one function.
 *
 * With a `trim` bundle it goes into the facades trim atlas, which the chunk mesh
 * already binds, so hardware is free. With `trim` null it goes into the signage
 * buffer against this module's own metal swatch, so a signage mesh is completely
 * self-contained — which is what lets the whole district's signage be eight
 * merged meshes instead of one per resident chunk. See districtSignageBuffers().
 */
function hardware(sign, trim, rect, cx, cy, cz, sx, sy, sz, tint) {
  if (trim) {
    box(cx, cy, cz, sx, sy, sz, trim.pos, trim.nrm, trim.uv, trim.idx,
      { cell: TRIM.metalDark, col: trim.col, tint: [1, 1, 1] });
  } else {
    signBox(cx, cy, cz, sx, sy, sz, rect, sign.pos, sign.nrm, sign.uv, sign.idx,
      { col: sign.col, tint });
  }
}

/**
 * A projecting double-sided blade sign with its bracket. Pass a `trim` bundle and
 * the bracket costs nothing — it is painted metal and the trim atlas already has
 * painted metal. Pass null and it rides in the signage mesh; see hardware().
 *
 * @param {Object} e    edge from edgesOf()
 * @param {number} s    distance along the edge
 * @param {number} yTop top of the panel
 */
export function bladeSign(e, s, yTop, w, h, rect, sign, trim, opts = {}) {
  const gap = opts.gap ?? 0.28;
  const cx = e.a[0] + e.tx * s, cz = e.a[1] + e.tz * s;
  const px = cx + e.nx * (gap + w / 2), pz = cz + e.nz * (gap + w / 2);
  signPanel([px, yTop - h / 2, pz], [e.nx, 0, e.nz], [0, 1, 0], w, h, orientRect(e, rect),
    sign.pos, sign.nrm, sign.uv, sign.idx,
    { col: sign.col, tint: opts.tint, doubleSided: true, normal: [-e.tx, 0, -e.tz] });
  // Arm out from the wall plus a wall plate, both as thin boxes.
  const hw = shopRect('misc', 'plateEdge');
  const armLen = gap + w;
  hardware(sign, trim, hw, cx + e.nx * armLen * 0.5, yTop + 0.08, cz + e.nz * armLen * 0.5,
    Math.abs(e.nx) * armLen + 0.05, 0.05, Math.abs(e.nz) * armLen + 0.05, opts.tint);
  hardware(sign, trim, hw, cx + e.nx * 0.06, yTop - h * 0.5, cz + e.nz * 0.06,
    Math.abs(e.tx) * 0.09 + Math.abs(e.nx) * 0.12, h + 0.2,
    Math.abs(e.tz) * 0.09 + Math.abs(e.nz) * 0.12, opts.tint);
}

/**
 * A striped fabric awning with a lettered valance. signage.js owns awnings
 * rather than facades.js so the fabric can carry a wordmark: facades' awnings()
 * maps one flat trim cell over the whole canopy, which is right for a plain
 * shade and wrong for a shop's identity.
 *
 * Stripes run down-slope because the canopy quad maps v from the front bar to
 * the wall, and the stripe swatch varies along u.
 *
 * @param {Object} e   edge from edgesOf()
 * @param {number} s0  bay start along the edge
 * @param {number} s1  bay end
 * @param {number} head  storefront head height
 */
export function awning(e, s0, s1, head, stripeRect, valanceRect, sign, trim, opts = {}) {
  const out = opts.project ?? 1.3, drop = opts.drop ?? 0.5, val = opts.valance ?? 0.34;
  const col = sign.col, t = opts.tint;
  const P = (s, o) => [e.a[0] + e.tx * s + e.nx * o, e.a[1] + e.tz * s + e.nz * o];
  const a0 = P(s0, 0.02), a1 = P(s1, 0.02);
  const f0 = P(s0, out), f1 = P(s1, out);
  const yTop = head + 0.34, yFront = yTop - drop;

  // The barrel section, from facades.js so the two awning kits cannot drift —
  // the same reason awningFrame() lives there. See THE AWNING SECTION for why
  // this is a quarter circle and not a rake.
  const st = [];
  for (let k = 0; k <= AWNING_SEGS; k++) {
    const s = k / AWNING_SEGS;
    const { o, dy } = awningProfile(s, out, drop);
    const a = s * Math.PI * 0.5;
    const nx = e.nx * Math.sin(a), ny = Math.cos(a), nz = e.nz * Math.sin(a);
    const nl = Math.hypot(nx, ny, nz) || 1;
    st.push({
      p0: P(s0, 0.02 + o), p1: P(s1, 0.02 + o),
      y: yTop - dy, n: [nx / nl, ny / nl, nz / nl], s,
    });
  }
  // Canopy: v runs front -> wall so the stripes read down the slope, and each
  // hoop takes the slice of the stripe swatch its own arc length covers.
  const sr = (A, B) => [stripeRect[0], stripeRect[3] + (stripeRect[1] - stripeRect[3]) * (1 - A.s),
    stripeRect[2], stripeRect[3] + (stripeRect[1] - stripeRect[3]) * (1 - B.s)];
  for (let k = 0; k < AWNING_SEGS; k++) {
    const A = st[k], B = st[k + 1];
    const nm = [(A.n[0] + B.n[0]) / 2, (A.n[1] + B.n[1]) / 2, (A.n[2] + B.n[2]) / 2];
    quad(sign.pos, sign.nrm, sign.uv, sign.idx,
      [B.p0[0], B.y, B.p0[1]], [B.p1[0], B.y, B.p1[1]],
      [A.p1[0], A.y, A.p1[1]], [A.p0[0], A.y, A.p0[1]],
      nm, sr(B, A), col, t);
    quad(sign.pos, sign.nrm, sign.uv, sign.idx,
      [A.p0[0], A.y, A.p0[1]], [A.p1[0], A.y, A.p1[1]],
      [B.p1[0], B.y, B.p1[1]], [B.p0[0], B.y, B.p0[1]],
      [-nm[0], -nm[1], -nm[2]], sr(A, B), col, t);
  }
  // Valance, both faces, carrying the name. THE valance is the third text-on-edge
  // emitter and the one that actually produced the reversed "Verano Wash House" a
  // critic found - fasciaPlate and bladeSign were fixed first and neither draws it.
  // Both faces derive from one winding-oriented rect so the front reads from the
  // street and the back reads from the far pavement.
  const vFront = orientRect(e, valanceRect);
  // Same rect on both faces. The swap this used to do was meant to make "the
  // back read from the far pavement" and did the opposite: the back quad's
  // positions already run the other way round, so it was mirroring an already
  // mirrored mapping. sign-orient's census caught it as a group sitting at
  // exactly 50% mirrored -- one good face and one bad on every awning.
  const vBack = vFront;
  quad(sign.pos, sign.nrm, sign.uv, sign.idx,
    [f0[0], yFront - val, f0[1]], [f1[0], yFront - val, f1[1]],
    [f1[0], yFront, f1[1]], [f0[0], yFront, f0[1]],
    [e.nx, 0, e.nz], vFront, col, t);
  quad(sign.pos, sign.nrm, sign.uv, sign.idx,
    [f1[0], yFront - val, f1[1]], [f0[0], yFront - val, f0[1]],
    [f0[0], yFront, f0[1]], [f1[0], yFront, f1[1]],
    [-e.nx, 0, -e.nz], vBack, col, t);
  // Side cheeks. A straight quad from the wall head to the leading edge is the
  // CHORD of the barrel and the fabric bulges above it, so a flat gusset would
  // leave a crescent of open air down each side of every awning.
  const side = (which, sx, sz) => {
    const base = which ? a1 : a0, front = which ? f1 : f0;
    for (let k = 0; k < AWNING_SEGS; k++) {
      const A = st[k], B = st[k + 1];
      const pa = which ? A.p1 : A.p0, pb = which ? B.p1 : B.p0;
      const lo = (u) => [base[0] + (front[0] - base[0]) * u,
        (head + 0.02) + ((yFront - val) - (head + 0.02)) * u,
        base[1] + (front[1] - base[1]) * u];
      quad(sign.pos, sign.nrm, sign.uv, sign.idx,
        lo(A.s), [pa[0], A.y, pa[1]], [pb[0], B.y, pb[1]], lo(B.s),
        [sx, 0, sz], sr(A, B), col, t);
    }
  };
  side(0, -e.tx, -e.tz);
  side(1, e.tx, e.tz);
  // Frame. facades.js owns the recipe so the two awning kits cannot drift: a
  // front bar under the leading edge and rafters raking down to it from the wall.
  // What was here was a single LEVEL box at yTop-0.14 running the full
  // projection, which on a canopy that drops 0.5 m over 1.3 m sits 0.385 m ABOVE
  // the fabric at the leading edge and carries nothing — the bar visible over
  // the top of every awning in the district, and the reason the canopies read as
  // unsupported.
  if (trim) {
    awningFrame([a0[0], a0[1]], [a1[0], a1[1]], [f0[0], f0[1]], [f1[0], f1[1]],
      yTop, yFront, out, trim.pos, trim.nrm, trim.uv, trim.idx,
      { col: trim.col, tint: [1, 1, 1] });
  } else {
    awningFrame([a0[0], a0[1]], [a1[0], a1[1]], [f0[0], f0[1]], [f1[0], f1[1]],
      yTop, yFront, out, sign.pos, sign.nrm, sign.uv, sign.idx,
      { uvRect: shopRect('misc', 'plateEdge'), col: sign.col, tint: t });
  }
}

/**
 * A sign face on a post: the shape everything on a pavement uses. The post goes
 * into the trim buffer.
 *
 * @param {number} x,z   post position
 * @param {number} yaw   facing, radians; the face normal is (sin, 0, cos)
 * @param {number} yMid  centre height of the face
 */
export function postSign(x, z, yaw, yMid, w, h, rect, sign, trim, opts = {}) {
  const nx = Math.sin(yaw), nz = Math.cos(yaw);
  const rt = [nz, 0, -nx];
  const off = opts.offset ?? 0;
  // Stand the face off the post. A zero-thickness quad through the post's axis
  // puts the post's front half IN FRONT of the sign, which reads as a dark bar
  // straight down the middle of every plate — and it is exactly how a sign is
  // really mounted: bolted to the front of the channel, pole visible behind.
  const stand = opts.standoff ?? 0.06;
  const c = [x + rt[0] * off + nx * stand, yMid, z + rt[2] * off + nz * stand];
  signPanel(c, rt, [0, 1, 0], w, h, rect, sign.pos, sign.nrm, sign.uv, sign.idx,
    { col: sign.col, tint: opts.tint, doubleSided: opts.doubleSided !== false,
      backRect: opts.backRect ?? streetRect('misc', 'signBack'),
      normal: [nx, 0, nz] });
  if (opts.post !== false) {
    const top = opts.postTop ?? yMid + h / 2;
    hardware(sign, trim, streetRect('misc', 'postBand'),
      x, (top - GROUND_EMBED) / 2, z, 0.075, top + GROUND_EMBED, 0.075, opts.tint);
  }
}

/**
 * A street-name blade assembly: one post carrying up to two blades at right
 * angles, the way a corner is actually signed.
 *
 * @param {string[]} names  one or two invented street names
 */
export function streetBladeAssembly(x, z, yaw, names, sign, trim, opts = {}) {
  const y = opts.height ?? 3.15;
  const w = opts.width ?? 1.55, h = opts.bladeHeight ?? 0.235;
  names.slice(0, 2).forEach((name, i) => {
    const a = yaw + i * Math.PI / 2;
    // post: false — the assembly carries ONE pole for both blades, below.
    postSign(x, z, a, y - i * (h + 0.07), w, h, streetNameRect(name), sign, null,
      { doubleSided: true, offset: 0, post: false, tint: opts.tint,
        backRect: streetRect('misc', 'bladeBack') });
  });
  hardware(sign, trim, streetRect('misc', 'postBand'),
    x, (y + 0.3 - GROUND_EMBED) / 2, z, 0.085, y + 0.3 + GROUND_EMBED, 0.085, opts.tint);
}

/** A regulatory face (stop / do-not-enter / yield / no-left-turn) on a post. */
export function regulatorySign(x, z, yaw, key, sign, trim, opts = {}) {
  const size = opts.size ?? 0.76;
  postSign(x, z, yaw, opts.height ?? 2.32, size, size, streetRect('reg', key), sign, trim,
    { doubleSided: true, postTop: (opts.height ?? 2.32) + size / 2, tint: opts.tint });
}

/** A portrait regulatory sign: parking, no-parking, speed limit. */
export function parkingSign(x, z, yaw, key, sign, trim, opts = {}) {
  const w = opts.width ?? 0.52, h = opts.height ?? 0.70;
  postSign(x, z, yaw, opts.y ?? 2.25, w, h, streetRect('reg', key), sign, trim,
    { doubleSided: true, postTop: (opts.y ?? 2.25) + h / 2, tint: opts.tint });
}

/** A one-way arrow or wayfinding plate. `key` is one of WIDE_SIGNS. */
export function wideSign(x, z, yaw, key, sign, trim, opts = {}) {
  const w = opts.width ?? 1.05, h = opts.height ?? 0.3;
  postSign(x, z, yaw, opts.y ?? 2.5, w, h, streetRect('reg', key), sign, trim,
    { doubleSided: true, postTop: (opts.y ?? 2.5) + h / 2, tint: opts.tint });
}

// --------------------------------------------------------- business assignment
//
// Deterministic and stable across sessions, because the seed comes from the
// footprint's own geometry (facades.js seedOf) rather than from an array index —
// a rebake that reorders buildings must not reshuffle the whole high street.
//
// A building is not one shop. A 40 m frontage in a downtown block is four or five
// tenancies, so the street edge is split into TENANCIES of about nine metres and
// each gets its own business. This is the single biggest difference between a
// street that reads as a city and one that reads as a row of labelled boxes.

const TENANCY_M = 9.0, TENANCY_MIN = 5.5, TENANCY_MAX = 15.0;

// A LOT IS A TENANCY, AND THERE ARE NOW TWO KINDS OF LOT.
//
// facades.js cuts a long frontage into lots and this module hangs each lot's
// NAME on that lot's fascia. Two independent subdivisions of the same wall - a
// 9 m tenancy here and an 8.4 m lot there - would put every third sign across a
// party pier, which is worse than not splitting the wall at all. So when the
// facade kit has a lot plan for an edge, it IS the tenancy plan; TENANCY_M only
// still governs frontages too short to have been lotted.
//
// What differs between the two kinds is not read here and must not be assumed
// here. A PROPERTY lot (buildingStyle `lots`) carries its own wall colour,
// parapet step, shopfront head and texture phase for the full height of the
// building. A GROUND tenancy (buildingStyle `groundLots`, which is how a tower
// gets a row of shops under a single tower) carries its own recess depth, door,
// fascia colour, awning and after-dark state and NOTHING above the fascia: one
// colour, one parapet, one head on the whole elevation. Everything this module
// reads off a lot - s0, s1, head, fasciaY, awning, doorSpan - is per-tenancy in
// both, which is exactly why signage needed no branch for the tower case; if a
// future consumer here starts reading `parapetH` or `tint`, it does.
function tenanciesOn(e, lots) {
  if (!lots || !lots.length) {
    const n = Math.max(1, Math.round(e.len / TENANCY_M));
    const width = e.len / n;
    if (width < TENANCY_MIN && n > 1) return [];
    const out = [];
    for (let i = 0; i < n; i++) {
      const s0 = i * width + 0.25, s1 = (i + 1) * width - 0.25;
      out.push({ s0, s1: s0 + Math.min(s1 - s0, TENANCY_MAX), lot: null });
    }
    return out;
  }
  return lots.map((L) => ({
    // Inside the party piers, which are 0.44 m wide and centred on the boundary.
    s0: L.s0 + 0.3, s1: L.s1 - 0.3, lot: L,
  })).filter((t) => t.s1 - t.s0 > 1.2);
}

/**
 * The business occupying a given tenancy slot of a building.
 *
 * @param {Object} b     a district.json building
 * @param {number} slot  tenancy index, 0 for the anchor
 * @returns {Object} an entry of BUSINESSES, with `index` added
 */
export function businessFor(b, slot = 0) {
  const i = hash32('biz', seedOf(b), slot) % BUSINESSES.length;
  return { ...BUSINESSES[i], index: i };
}

/**
 * The full deterministic signage plan for one building.
 *
 * @param {Object} b      district.json building ({p, h, a, z, k})
 * @param {Object} style  the facades.js buildingStyle for the same building
 * @param {{street?: number[], streets?: number[][]}} opts  street direction(s), as
 *   passed to appendBuilding. `streets` carries every elevation the building
 *   fronts; `street` is the primary alone and is kept for callers that have only
 *   that.
 * @returns {{tenants: Array, parapet: Object|null, edges: Array}}
 */
export function signPlanFor(b, style, opts = {}) {
  const ring = b.p;
  // MUST agree with appendBuilding's edge selection, or a corner building gets
  // shopfront bays on an elevation with no awning, no fascia and no blade sign.
  //
  // That is not hypothetical: when streetDirsFor gave the facade kit both of a
  // corner site's streets, this function was left selecting against the primary
  // alone, and two blind reviewers independently found the result -- the Five
  // Points hero building kept its glazing and lost its MARROW & VINE awning.
  // One of them measured it as absent rather than illegible: zero teal pixels in
  // the awning footprint at golden and at night, against 12,776 in the other arm.
  //
  // The union and the cap are duplicated from facades.js appendBuilding rather
  // than shared, because the two modules do not otherwise depend on each other;
  // if either changes, change both. The rule: each direction contributes at most
  // `faces` edges, and a multi-street building is capped one above that.
  //
  // tools/frontage-stats.mjs --selftest now asserts the two agree over the whole
  // district - every edge appendBuilding cuts shopfront bays into is an edge
  // this function puts tenancies on, and the reverse - so the next change to
  // either can be caught by a tool instead of by a blind reviewer. It caught
  // nothing when the tower ground floor went in, which is the point: the tower
  // population reaches this function through `style.storefront` alone and needs
  // no edge-selection change at all.
  const dirs = opts.streets?.length ? opts.streets : (opts.street ? [opts.street] : null);
  const faces = opts.faces ?? 2;
  let edges;
  if (dirs) {
    const seen = new Map();
    for (const d of dirs) {
      for (const e of facingEdges(ring, d[0], d[1], { minLen: 4, max: faces })) {
        if (!seen.has(e.i)) seen.set(e.i, e);
      }
    }
    edges = [...seen.values()].sort((a, b2) => b2.len - a.len)
      .slice(0, dirs.length > 1 ? faces + 1 : faces);
  } else {
    edges = edgesOf(ring, { minLen: 4, longest: faces });
  }
  const plan = { tenants: [], parapet: null, edges };
  // `storefront` is the whole gate, and it is what admitted towers: buildingStyle
  // gives a commercial-zone bayTower a shopfront for the first time, so 25 towers
  // arrive here with tenancies, fascias, awnings and after-dark states without a
  // line changing below this one. A tower's head is lower than a shop's - 3.34 m
  // against 4.00, because bayTower's first floor sits at 4.06 and a 4.00 m head
  // would delete the window band above it (facades.js headCapFor) - and every
  // placement here is already relative to `t.head`.
  if (!style?.storefront || !edges.length) return plan;

  const head = style.storefront.head;
  const r = rng(hash32('signplan', style.seed ?? seedOf(b)));
  const lotPlan = lotPlanFor(ring, style, b.h ?? 6, edges);
  let slot = 0;
  for (const e of edges) {
    const lots = lotPlan.get(e.i)?.lots;
    for (const t of tenanciesOn(e, lots)) {
      const span = t.s1 - t.s0;
      const biz = businessFor(b, slot);
      // A tenant either awns or plates its fascia, never both: an awning at
      // 1.3 m projection hides the wall behind it, which is exactly why the
      // valance exists. Choosing one keeps the name readable either way.
      // On a lotted frontage the awning is decided in the LOT PLAN, because the
      // facade kit reads the same flag to decide it must not emit an awning of
      // its own over that bay. Two kits guessing separately is two layers of
      // cloth on one shopfront.
      // Drawn either way, used only when there is no lot to ask. Keeping the
      // draw unconditional is what stops `blade` below from landing on a
      // different number on a lotted frontage than on an unlotted one.
      const aw = opts.awnings !== false ? r() : 1;
      const awn = opts.awnings !== false && span > 2.4 &&
        (t.lot ? t.lot.awning : aw < 0.48);
      const blade = r() < 0.38;
      plan.tenants.push({
        e, s0: t.s0, s1: t.s1, mid: (t.s0 + t.s1) / 2, span, biz, slot,
        awning: awn, fascia: !awn, blade,
        head: t.lot?.head ?? head,
        // The lot this tenancy occupies, or null on an unlotted frontage.
        // streetfurniture.js needs `doorSpan` off it: shopfront furniture that
        // blocks the door the same plan just cut is worse than no furniture.
        lot: t.lot ?? null,
        // The band the facade kit built over this shopfront, so the name lands
        // ON the fascia instead of over the display window under it.
        fasciaY: t.lot?.fasciaY ?? null,
        lit: LIT_STYLES.has(biz.w),
      });
      slot++;
    }
  }
  if (style.signBlank && plan.tenants.length) {
    // The parapet blank belongs to the anchor tenant — the widest one, which is
    // the shop whose name a driver is meant to read from two blocks away.
    let best = plan.tenants[0];
    for (const t of plan.tenants) if (t.span > best.span) best = t;
    plan.parapet = { biz: best.biz };
  }
  return plan;
}

/**
 * Append every sign a building carries. Mirrors facades.js appendBuilding: takes
 * the two caller-owned buffer bundles it writes into and allocates nothing.
 *
 * Integration: set `style.awnings = false` before calling facades.js
 * appendBuilding, then call this. signage.js emits the awnings itself so the
 * fabric can carry a valance wordmark; leaving both on puts two layers of cloth
 * on the same bay. Pass `{ awnings: false }` here to opt out entirely.
 *
 * @param {Object} b      district.json building
 * @param {Object} style  facades.js buildingStyle result
 * @param {Object} sign   buffer bundle for the signage material
 * @param {Object} trim   buffer bundle for the facades trim material, for posts
 *                        and brackets; null keeps that hardware in `sign`
 * @returns {{signs:number, emitters:Array}}  emitters are lit-sign positions for
 *          a LightPool, in the candela range daynight.js calls plausible for shops
 */
export function appendBuildingSignage(b, style, sign, trim, opts = {}) {
  const plan = opts.plan ?? signPlanFor(b, style, opts);
  const emitters = [];
  let signs = 0;
  const h = b.h ?? 6;
  const tint = opts.tint;

  for (const t of plan.tenants) {
    const e = t.e;
    const bizI = t.biz.index;
    if (t.awning) {
      awning(e, t.s0, t.s1, t.head, shopRect('stripe', t.biz.a % STRIPES),
        shopRect('valance', bizI), sign, trim, { tint });
      signs++;
    }
    if (t.fascia) {
      // On a LOTTED shopfront the facade kit has already built the lintel band
      // this name belongs on, and its height is the lot's, not the building's -
      // so the plate steps with the fascia instead of running level past it.
      // Without one, the band sits on the transom above the display window,
      // where a real fascia goes: placing it above `head` would push it into the
      // first-floor window band on every recipe whose floor height is under four
      // metres.
      const y1 = t.fasciaY
        ? Math.min(t.fasciaY[1] - 0.07, h - 0.15)
        : Math.min(t.head - 0.06, h - 0.15);
      const y0 = t.fasciaY
        ? Math.max(t.fasciaY[0] + 0.07, y1 - 1.0)
        : y1 - Math.min(1.0, (y1 - 0.9) * 0.4 + 0.62);
      // A lotted fascia is a REAL band whose depth the facade kit chose, so the
      // plate only has to fit inside it; the 0.42 m floor is for the free-floating
      // case, where a shallow plate would read as a smear on the transom.
      if (y1 - y0 > (t.fasciaY ? 0.24 : 0.42)) {
        const w = Math.min(t.span - 0.5, 6.2);
        const c = t.mid;
        fasciaPlate(e, c - w / 2, c + w / 2, y0, y1, shopRect('fascia', bizI),
          sign.pos, sign.nrm, sign.uv, sign.idx, { col: sign.col, tint });
        signs++;
        if (t.lit) {
          emitters.push({
            x: e.a[0] + e.tx * c + e.nx * 0.6, y: (y0 + y1) / 2,
            z: e.a[1] + e.tz * c + e.nz * 0.6,
            candela: 140, hue: t.biz.h,
          });
        }
      }
    }
    if (t.blade) {
      const yTop = Math.min(h - 0.35, t.head + 2.35);
      const bh = Math.min(1.3, yTop - t.head - 0.25);
      if (bh > 0.55) {
        bladeSign(e, t.mid, yTop, bh * 0.6, bh, shopRect('blade', bizI), sign, trim, { tint });
        signs++;
        if (t.lit) {
          emitters.push({
            x: e.a[0] + e.tx * t.mid + e.nx * 0.9, y: yTop - bh / 2,
            z: e.a[1] + e.tz * t.mid + e.nz * 0.9,
            candela: 90, hue: t.biz.h,
          });
        }
      }
    }
  }

  if (plan.parapet) {
    // facades.js signBlank picks its edge with exactly this call and centres a
    // box of this width on it. Re-deriving it here rather than being told keeps
    // the two in step without widening the appendBuilding signature.
    const e = edgesOf(b.p, { minLen: 6, longest: 1 })[0];
    if (e) {
      const bh = style.parapet?.height ?? 0;
      const y = h + bh;
      const w = Math.min(9, e.len * 0.62);
      const thick = 0.22;
      const cs = e.len / 2;
      const yc = y + 1.9 / 2 + 0.25;
      const rect = shopRect('fascia', plan.parapet.biz.index);
      // orientRect, for the same winding reason fasciaPlate needs it. Both faces
      // of this pair take the SAME oriented rect: rt and the normal both carry s,
      // so the s cancels out of dot(rt, viewerRight) and the two faces always
      // read the same way as each other. Which way was decided by the ring
      // winding alone, so every parapet sign on a footprint wound one way was
      // mirrored on BOTH faces and could not be read from any angle. 84 of 156
      // panels district-wide, before this line.
      for (const s of [1, -1]) {
        const off = 0.1 + s * (thick / 2 + 0.012);
        const c = [e.a[0] + e.tx * cs + e.nx * off, yc, e.a[1] + e.tz * cs + e.nz * off];
        signPanel(c, [e.tx * s, 0, e.tz * s], [0, 1, 0], w * 0.96, 1.5, orientRect(e, rect),
          sign.pos, sign.nrm, sign.uv, sign.idx,
          { col: sign.col, tint, normal: [e.nx * s, 0, e.nz * s] });
      }
      // Legs of its own, down to the roof slab.
      //
      // These two panels are the faces of the blank facades.js signBlank() puts
      // on the parapet — but that blank is near-LOD kit and this mesh is
      // district-wide and never streamed, so past the LOD0 radius the building
      // becomes a bare bounding box and the panels are left standing on nothing
      // 1.6 m above its roof. Measured on the Five Points frame: 68% of
      // in-frustum signage vertices sit over a LOD1 chunk and 17% over a chunk
      // with no building loaded at all. A sign that carries its own legs is
      // upright at every LOD. They are inboard of signBlank's legs so the two
      // sets never z-fight where both are drawn.
      const legBottom = h, legTop = y + 0.55;
      if (legTop > legBottom) {
        for (const s of [1, -1]) {
          const lx = e.a[0] + e.tx * (cs + s * w * 0.30) + e.nx * 0.1;
          const lz = e.a[1] + e.tz * (cs + s * w * 0.30) + e.nz * 0.1;
          hardware(sign, trim, shopRect('misc', 'plateEdge'),
            lx, (legBottom + legTop) / 2, lz, 0.11, legTop - legBottom, 0.11, tint);
        }
      }
      signs += 2;
      if (LIT_STYLES.has(plan.parapet.biz.w)) {
        emitters.push({
          x: e.a[0] + e.tx * cs + e.nx * 0.8, y: yc,
          z: e.a[1] + e.tz * cs + e.nz * 0.8, candela: 220, hue: plan.parapet.biz.h,
        });
      }
    }
  }
  return { signs, emitters };
}

// ------------------------------------------------------------ street planning
//
// Where street signage goes, derived from the baked road graph. Junctions get
// name blades; minor approaches to a major road get a stop sign; one-way edges
// get an arrow at their head. It is a plan, not a mesh: the caller decides how
// much of it to build and into which buffers.

/**
 * @param {Object} district  parsed data/district.json
 * @param {{maxAssemblies?:number, maxSigns?:number}} opts
 * @returns {{blades:Array, stops:Array, oneWays:Array, parking:Array}}
 */
export function planStreetSignage(district, opts = {}) {
  const maxA = opts.maxAssemblies ?? 140;
  const maxS = opts.maxSigns ?? 260;
  const verts = district.verts, edges = district.edges;
  const RANK = { primary: 4, secondary: 3, tertiary: 2, residential: 1, service: 0 };

  // vertex -> [{edge, endIndex}] for every edge that terminates there. Interior
  // polyline vertices are ignored: a blade belongs at a corner, not mid-block.
  const at = new Map();
  edges.forEach((e, ei) => {
    for (const end of [0, e.v.length - 1]) {
      const v = e.v[end];
      if (!at.has(v)) at.set(v, []);
      at.get(v).push({ ei, end });
    }
  });

  const blades = [], stops = [], oneWays = [], parking = [];
  const dirOf = (e, end) => {
    // Inward direction of travel at this end of the polyline.
    const a = end === 0 ? e.v[0] : e.v[e.v.length - 1];
    const b = end === 0 ? e.v[1] : e.v[e.v.length - 2];
    const pa = verts[a], pb = verts[b];
    const dx = pb.x - pa.x, dz = pb.z - pa.z;
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };

  const keys = [...at.keys()].sort((a, b) => a - b);   // stable order, not Map order
  for (const v of keys) {
    const inc = at.get(v);
    if (inc.length < 3) continue;
    const names = [];
    let widest = 0, best = null;
    for (const { ei, end } of inc) {
      const e = edges[ei];
      if (e.n && !names.includes(e.n)) names.push(e.n);
      if (e.w > widest) { widest = e.w; best = { e, end }; }
    }
    if (names.length < 2 || !best) continue;
    if (blades.length >= maxA) break;
    const p = verts[v];
    const [dx, dz] = dirOf(best.e, best.end);
    // Set the pole back on the corner, off the carriageway of both approaches.
    const off = (widest / 2 + 1.6) * 0.707;   // diagonal, so both approaches clear
    const yaw = Math.atan2(dx, dz);
    blades.push({
      x: p.x + (dx - dz) * off, z: p.z + (dz + dx) * off,
      yaw, names: names.slice(0, 2), vertex: v,
    });

    // Stop signs face the driver arriving on the minor road, so they are placed
    // on the approach and turned back along it.
    const ranks = inc.map(({ ei }) => RANK[edges[ei].c] ?? 0);
    const top = Math.max(...ranks);
    for (const { ei, end } of inc) {
      if (stops.length >= maxS) break;
      const e = edges[ei];
      if ((RANK[e.c] ?? 0) >= top) continue;
      const [ax, az] = dirOf(e, end);
      const back = e.w / 2 + 1.3;
      stops.push({
        x: p.x + ax * (back + 1.4) + az * back, z: p.z + az * (back + 1.4) - ax * back,
        yaw: Math.atan2(-ax, -az), edge: ei,
      });
    }
  }

  // One-way plates face across the street at the head of the edge. The bake
  // stores `o` as a flag, not a sign, so the arrow direction comes from the
  // geometry: mount on the right kerb and the travel direction runs left-to-right
  // across the plate; mount on the left and it runs the other way. Alternating
  // the kerb by hash uses both arrow cells and avoids a street of identical posts.
  edges.forEach((e, ei) => {
    if (!e.o || oneWays.length >= maxS) return;
    const p = verts[e.v[0]];
    const [dx, dz] = dirOf(e, 0);
    const off = e.w / 2 + 1.3;
    const right = hash32('ow', ei) % 2 === 0;
    oneWays.push({
      x: p.x + (right ? dz : -dz) * off, z: p.z + (right ? -dx : dx) * off,
      yaw: right ? Math.atan2(-dz, dx) : Math.atan2(dz, -dx), edge: ei,
      key: right ? 'oneWayRight' : 'oneWayLeft',
    });
  });

  // Parking control along commercial frontage, spaced so a block reads signed
  // without becoming a picket fence.
  const spacing = opts.parkingEveryM ?? 46;
  for (let ei = 0; ei < edges.length && parking.length < maxS; ei++) {
    const e = edges[ei];
    if (!e.n || (RANK[e.c] ?? 0) < 2) continue;
    let acc = spacing * 0.5;
    for (let i = 1; i < e.v.length; i++) {
      const a = verts[e.v[i - 1]], b = verts[e.v[i]];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      let t = acc;
      while (t < len && parking.length < maxS) {
        const ux = dx / len, uz = dz / len;
        const off = e.w / 2 + 1.1;
        parking.push({
          x: a.x + ux * t + uz * off, z: a.z + uz * t - ux * off,
          yaw: Math.atan2(-uz, ux),
          key: hash32('park', ei, t | 0) % 3 === 0 ? 'noParking' : 'parking',
        });
        t += spacing;
      }
      acc = Math.max(0, t - len);
    }
  }
  return { blades, stops, oneWays, parking };
}

/**
 * Every sign in the district, bucketed into a handful of spatial cells.
 *
 * This is the recommended integration and the reason hardware() exists. Signage
 * is 73k triangles for the WHOLE district on two shared textures — 18% of the
 * triangle warn threshold, re-measured 2026-08-30, up from 49k when the awnings
 * gained real frames; the "~19k" this comment used to claim predated the shop
 * atlas growing — so streaming it per chunk buys nothing and costs a draw call
 * for every resident near chunk. Measured on data/district.json: the busiest 5x5
 * near-chunk window holds 25 chunks with signed buildings, so the per-chunk
 * route costs +26 draw calls, while seven 512 m buckets plus one district-wide
 * street mesh cost +8 and never touch the chunk build budget.
 *
 * Buckets exist at all so frustum culling still has something to work with; one
 * mesh for the district would be one draw call but never cullable.
 *
 * KNOWN LIMIT, measured on the Five Points dusk frame: this mesh set is built
 * once and never streamed, while the buildings under it are. Of 1798 in-frustum
 * signage vertices sampled, 1224 (68%) sat over a chunk at LOD1 — a bounding-box
 * extrusion with no parapet, storefront or sign blank — and 302 (17%) over a
 * chunk with no building loaded at all, at 610-812 m. Signs there outlive their
 * host. The fix is per-chunk buckets shown only at LOD0, which the draw-call
 * arithmetic above prices at about +26; until that is affordable, every sign is
 * built to stand on its OWN hardware (awning frames, parapet legs, posts that
 * reach the pavement) so it is at least upright at every LOD.
 *
 * Pass `trim` bundles per bucket only if you intend to mesh hardware against the
 * facades trim atlas as well; the default keeps everything in the signage mesh.
 *
 * @param {Object} district  parsed data/district.json
 * @param {{bucketM?:number, styleOf?:Function, streetPlan?:Object,
 *          streetDirFor?:Function}} opts  streetDirFor(b) -> [dx,dz], the same
 *          street direction the streamer passes to appendBuilding
 * @returns {{buckets:Array, street:Object, stats:Object}}
 */
export function districtSignageBuffers(district, opts = {}) {
  const bucketM = opts.bucketM ?? 512;
  const styleOf = opts.styleOf ?? defaultStyleOf;
  const t0 = performance.now();
  const buckets = new Map();
  const bucketFor = (x, z) => {
    const key = `${Math.floor(x / bucketM)},${Math.floor(z / bucketM)}`;
    if (!buckets.has(key)) buckets.set(key, { key, sign: buffers(), signs: 0, emitters: [] });
    return buckets.get(key);
  };

  let signed = 0, tenancies = 0;
  for (const b of district.buildings) {
    const style = styleOf(b);
    if (!style || !style.storefront) continue;
    const plan = signPlanFor(b, style,
      { street: opts.streetDirFor?.(b), streets: opts.streetDirsFor?.(b) });
    if (!plan.tenants.length && !plan.parapet) continue;
    const bk = bucketFor(b.p[0][0], b.p[0][1]);
    const res = appendBuildingSignage(b, style, bk.sign, null, { plan });
    bk.signs += res.signs;
    bk.emitters.push(...res.emitters);
    signed++; tenancies += plan.tenants.length;
  }

  // Street signage stays one mesh: it is sparse, district-wide and 9k triangles,
  // exactly the case streetfurniture.js already answers this way for lamp posts.
  const street = buffers();
  const plan = opts.streetPlan ?? planStreetSignage(district, opts);
  const sres = appendStreetSignage(plan, street, null, opts);

  const tri = (buf) => buf.idx.length / 3;
  let shopTris = 0;
  for (const bk of buckets.values()) shopTris += tri(bk.sign);
  return {
    buckets: [...buckets.values()],
    street,
    stats: {
      ms: +(performance.now() - t0).toFixed(1),
      signedBuildings: signed, tenancies,
      buckets: buckets.size, bucketM,
      shopSigns: [...buckets.values()].reduce((a, b) => a + b.signs, 0),
      streetSigns: sres.signs,
      shopTriangles: shopTris, streetTriangles: tri(street),
      drawCalls: buckets.size + 1,
    },
  };
}

function defaultStyleOf(b) {
  // Imported lazily through the module's own facades dependency so callers that
  // already computed a style (the streamer does) can inject theirs instead.
  return facadeStyle(b);
}

/**
 * Build a whole street-signage plan into one pair of buffers. The result is
 * intended as a SINGLE district-wide merged mesh, not per-chunk content: there
 * are a few hundred posts across the district, they are static, and one merged
 * mesh costs one draw call where per-chunk copies would cost one per resident
 * chunk. streetfurniture.js makes the same call for lamp posts.
 */
export function appendStreetSignage(plan, sign, trim, opts = {}) {
  let n = 0;
  for (const b of plan.blades) {
    // Only names the atlas actually baked: streetNameRect falls back to cell 0,
    // and a blade confidently labelled with the wrong street is worse than none.
    const names = b.names.filter((nm) => hasStreetName(nm));
    if (!names.length) continue;
    streetBladeAssembly(b.x, b.z, b.yaw, names, sign, trim, opts);
    n += Math.min(2, names.length);
  }
  for (const s of plan.stops) { regulatorySign(s.x, s.z, s.yaw, 'stop', sign, trim, opts); n++; }
  for (const o of plan.oneWays) { wideSign(o.x, o.z, o.yaw, o.key, sign, trim, opts); n++; }
  for (const p of plan.parking) { parkingSign(p.x, p.z, p.yaw, p.key, sign, trim, opts); n++; }
  return { signs: n };
}
