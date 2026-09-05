// Does the leaf stencil cut the leaves and NOTHING ELSE?
//
// src/streetfurniture.js now hangs an alphaMap on the one material every static
// prop in the district shares, and addresses it through the uv channel that has
// carried a constant (paletteU(surf), 0.5) since the kit was written. That is
// 6,832 props riding on an assumption -- "u anywhere inside a palette texel
// resolves to the same palette entry, and v = 0.5 is opaque" -- and an
// assumption on that many props is a gate, not a comment.
//
// So this asserts the things that assumption is made of, off the SAME helpers
// the emitters address the texture with rather than a second copy of the
// arithmetic:
//
//   1. GUARD.     Every palette texel, sampled the way a non-foliage prop
//                 samples it -- u = paletteU(surf), v = 0.5, bilinear over the
//                 four texels that actually contribute -- comes back 255. If
//                 this fails, alphaTest nicks benches and bins.
//   2. COLUMN.    Every u the foliage emitters can write still floors to its
//                 own palette entry, at both ends of the range and after the
//                 float rounding the GPU will do. If this fails a leaf comes
//                 back with the neighbouring entry's roughness.
//   3. IN USE.    Read the uv of every vertex of a real oak and a real palm out
//                 of the emitted buffer and check 1 and 2 against what was
//                 ACTUALLY written, not against what the helpers can write.
//                 Also reports how many vertices are cut, by zone.
//
//                 THIS CHECK WAS WIDENED ON PURPOSE, and the change is the
//                 point rather than a detail. It used to read: a vertex that
//                 leaves v = 0.5 must address the FOLIAGE column, full stop.
//                 That was the right assertion while foliage was the only
//                 surface the stencil cut. The limb tubes are now cut too --
//                 the bark zone at rows 448..511 frays a tube's silhouette,
//                 which is a thing no amount of geometry could reach -- so
//                 bark vertices leave v = 0.5 by design and the old form
//                 reported 10,038 of them as misaddressed.
//
//                 The property being protected has NOT been relaxed. It was
//                 never "only foliage may be cut"; it was "a vertex that leaves
//                 the guard band still lands in the palette column it asked
//                 for", because a leaf that drifts one texel comes back with
//                 chrome's roughness. That is now stated per ZONE: a v inside
//                 the oak or palm zones must carry the foliage column, a v
//                 inside the bark zone must carry the bark column, and a v
//                 anywhere else must be the opaque guard. It is a strictly
//                 stronger statement than the old one -- the old check could
//                 not have caught a bark vertex landing in the SABAL zone, and
//                 this one does.
//   3b. OTHER.    Every prop kind that is NOT a tree, built into a scratch
//                 buffer and checked vertex by vertex. alphaTest can only
//                 discard, so a prop sampling alpha 1.0 everywhere draws
//                 exactly the pixels it drew before the stencil existed --
//                 which is a stronger statement than a screenshot diff, and it
//                 covers all seventeen kinds rather than the handful a frame
//                 happens to contain. Unchanged by the bark round: bark is only
//                 written by the two tree kinds, and the PALM trunk -- a
//                 separate emitter, palmTrunk, which the fringe does not touch
//                 -- still writes v = 0.5 and is checked as guard under 3.
//   4. COVERAGE.  The duty of each zone -- what fraction of a stamp survives --
//                 because a mask that cuts 80% of every plate is a skeleton and
//                 the frame is the last place you want to discover that.
//
//   node tools/leaf-mask.mjs
//   node tools/leaf-mask.mjs --png     also writes docs/shots/tree3-mask.png
//   node tools/leaf-mask.mjs --break   corrupt the guard row and the atlas
//                                      addressing on purpose; every check that
//                                      can fail must fail, or it is inert
import fs from 'node:fs';
import { __kit } from '../src/streetfurniture.js';
import { writePNG } from './crop.mjs';

const has = (k) => process.argv.includes(`--${k}`);
const BREAK = has('break');
const K = __kit;
const tex = K.alphaTexture();
const data = tex.image.data;
const { AW, AH, MASK_K, PAL_W, ALPHA_TEST } = K;

// --break bends the texture, not the checks: it paints a hole through the guard
// band at the column a bench samples. If check 1 still passes after that, it is
// not looking at anything.
if (BREAK) {
  for (let y = 250; y < 262; y++) {
    for (let x = 0; x < AW; x++) {
      const p = (y * AW + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = 0;
    }
  }
}

/** The texel the GPU would blend, for a LinearFilter sample at (u, v). */
function sample(u, v) {
  const fx = u * AW - 0.5, fy = v * AH - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const at = (x, y) => {
    const cx = Math.max(0, Math.min(AW - 1, x)), cy = Math.max(0, Math.min(AH - 1, y));
    return data[(cy * AW + cx) * 4 + 1] / 255;               // three reads .g
  };
  const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
  const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
  return a + (b - a) * ty;
}

let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log(`  FAIL  ${msg}`); } };

// ---- 1. the guard band, for every palette entry
console.log(`atlas ${AW} x ${AH}, ${MASK_K} mask columns per palette texel, `
  + `alphaTest ${ALPHA_TEST}`);
let worstGuard = 1;
for (let s = 0; s < PAL_W; s++) {
  const a = sample(K.paletteU(s), 0.5);
  worstGuard = Math.min(worstGuard, a);
  check(a >= 0.999, `palette entry ${s} at v=0.5 samples alpha ${a.toFixed(4)}, not 1`);
}
console.log(`1. GUARD    worst alpha at (paletteU(surf), 0.5) over ${PAL_W} entries: `
  + `${worstGuard.toFixed(4)}   ${worstGuard >= 0.999 ? 'opaque' : 'CUT'}`);

// ---- 2. the addressable range stays inside its own palette texel
let worstMargin = 1;
for (let s = 0; s < PAL_W; s++) {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const u = K.maskU(s, t);
    check(Math.floor(u * PAL_W) === s,
      `maskU(${s}, ${t}) = ${u} floors to palette ${Math.floor(u * PAL_W)}`);
    worstMargin = Math.min(worstMargin, Math.min(u * PAL_W - s, s + 1 - u * PAL_W));
  }
}
console.log(`2. COLUMN   every maskU stays in its own texel; worst margin `
  + `${(worstMargin * PAL_W).toFixed(3)} mask columns of ${MASK_K}`);

// ---- 3. what the emitters actually wrote
//
// Which zone a v falls in, and which palette column that zone is cut for. A v
// that is not in any zone must be the guard band, and is checked as opaque.
// Written off the kit's own row constants so it cannot drift from the atlas.
const ZONES = [
  ['oak', 0, K.OAK_STAMPS * K.STAMP_H, K.S.foliage],
  ['queen', K.QUEEN_V0, K.QUEEN_V0 + K.COMB_H, K.S.foliage],
  ['sabal', K.SABAL_V0, K.SABAL_V0 + K.COMB_H, K.S.foliage],
  ['bark', K.BARK_V0, K.BARK_V0 + K.BARK_H, K.S.bark],
];
const zoneOf = (v) => {
  const row = v * K.AH - 0.5;
  for (const [name, y0, y1, surf] of ZONES) {
    if (row >= y0 - 0.5 && row <= y1 - 0.5) return { name, surf };
  }
  return null;
};
K.setOakRoute(JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route);
const rows = [];
for (const [name, at] of [['oak', [118, -170]], ['palm', [0, 400]]]) {
  const f = K.frame(at[0], at[1], 0, 1, -1, 0);
  let n = 0, foliage = 0, off = 0, cutOpaque = 0, minA = 1, sumA = 0;
  let barkN = 0, barkMin = 1, barkSum = 0;
  for (let k = 0; k < 240; k++) {
    const key = k * 977 + 13;
    const p = K.treeParams(key, at[0], at[1]);
    if (p.oak !== (name === 'oak')) continue;
    n++;
    const buf = K.newBuf();
    K.props.tree(buf, f, key);
    K.props.treeDetail(buf, f, key);
    for (let i = 0; i < buf.uv.length; i += 2) {
      const u = buf.uv[i], v = buf.uv[i + 1];
      const col = Math.floor(u * PAL_W);
      // Every vertex must still resolve to the palette entry it asked for, and
      // the entry it must resolve to is the one its ZONE belongs to. `zoneOf`
      // is the whole widening: it names the zone a v falls in, and the surface
      // that zone is cut for.
      const z = zoneOf(v);
      if (z === null) { if (sample(u, v) < 0.999) off++; continue; }
      if (col !== z.surf) off++;
      const a = sample(u, v);
      if (z.surf === K.S.bark) {
        barkN++; barkMin = Math.min(barkMin, a); barkSum += a;
      } else {
        foliage++;
        minA = Math.min(minA, a); sumA += a;
        if (a >= 0.999) cutOpaque++;
      }
    }
    if (n >= 40) break;
  }
  check(off === 0, `${name}: ${off} vertices address the wrong palette column or a cut guard`);
  rows.push([name, n, foliage, off, minA, sumA / Math.max(1, foliage),
    cutOpaque / Math.max(1, foliage), barkN, barkMin, barkSum / Math.max(1, barkN)]);
}
console.log('3. IN USE   tier buffers read back, uv by uv');
for (const [name, n, foliage, off, minA, meanA, opaque, bn, bmin, bmean] of rows) {
  console.log(`     ${name.padEnd(5)} ${n} trees   ${foliage} foliage vertices   `
    + `${off} misaddressed   alpha at those uv: min ${minA.toFixed(3)} `
    + `mean ${meanA.toFixed(3)}   ${(100 * opaque).toFixed(0)}% land on solid mask`);
  console.log(`           ${String(bn).padStart(6)} bark vertices  `
    + (bn ? `alpha min ${bmin.toFixed(3)} mean ${bmean.toFixed(3)}`
      : 'none - this emitter writes no fringe'));
}

// ---- 3b. EVERY OTHER PROP KIND, not just the two that carry foliage.
//
// alphaTest can only do one thing -- discard a fragment -- so a prop whose
// every vertex samples alpha 1.0 renders exactly the pixels it rendered before
// the stencil existed. That is a stronger statement than a screenshot diff and
// it covers all nineteen kinds rather than the handful a frame happens to show.
{
  const f = K.frame(20, 20, 0, 1, -1, 0);
  const bad = [];
  let kinds = 0, verts = 0;
  for (const [kind, fn] of Object.entries(K.props)) {
    if (kind === 'tree' || kind === 'treeDetail') continue;
    kinds++;
    for (let k = 0; k < 24; k++) {
      const buf = K.newBuf();
      fn(buf, f, k * 313 + 7);
      for (let i = 0; i < buf.uv.length; i += 2) {
        verts++;
        if (sample(buf.uv[i], buf.uv[i + 1]) < 0.999) { bad.push(kind); break; }
      }
    }
  }
  check(bad.length === 0, `these prop kinds sample a cut texel: ${[...new Set(bad)].join(', ')}`);
  console.log(`3b. OTHER    ${kinds} non-foliage prop kinds, ${verts} vertices, `
    + `${bad.length ? [...new Set(bad)].join('/') + ' CUT' : 'all alpha 1.0 - untouched by alphaTest'}`);
}

// ---- 4. what each zone of the stencil actually keeps
const duty = (y0, y1) => {
  let on = 0, tot = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < MASK_K; x++) { tot++; if (data[(y * AW + x) * 4 + 1] > 127) on++; }
  }
  return on / tot;
};
const zones = [
  ['oak stamps', 0, K.OAK_STAMPS * K.STAMP_H],
  ['queen comb', K.QUEEN_V0, K.QUEEN_V0 + K.COMB_H],
  ['sabal comb', K.SABAL_V0, K.SABAL_V0 + K.COMB_H],
  ['bark fringe', K.BARK_V0, K.BARK_V0 + K.BARK_H],
];
console.log('4. COVERAGE fraction of each zone the stencil KEEPS (1 - duty)');
for (const [name, a, b] of zones) console.log(`     ${name.padEnd(12)} ${duty(a, b).toFixed(3)}`);

if (has('png')) {
  const w = MASK_K * 4, h = AH;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[(y * AW + (x % MASK_K)) * 4 + 1];
      const p = (y * w + x) * 3;
      rgb[p] = rgb[p + 1] = rgb[p + 2] = v;
    }
  }
  fs.mkdirSync('docs/shots', { recursive: true });
  writePNG('docs/shots/tree3-mask.png', w, h, rgb);
  console.log('wrote docs/shots/tree3-mask.png');
}

if (BREAK) {
  console.log(fail > 0
    ? `\nSELFTEST PASS - ${fail} checks fired on a deliberately holed guard band`
    : '\nSELFTEST FAIL - the guard band was cut and every check still passed');
  process.exit(fail > 0 ? 0 : 1);
}
console.log(fail === 0 ? '\nMASK PASS - the stencil cuts foliage and bark, and nothing else'
  : `\nMASK FAIL - ${fail} checks`);
process.exit(fail === 0 ? 0 : 1);
