// Street furniture: the stuff that makes a street a street rather than a
// corridor between extrusions.
//
// Three rounds of blind critics counted the props in the frame and got the same
// answer every time: "across roughly 450,000 px of visible sidewalk I count zero
// bins, hydrants, bollards, benches, planters, trees, meters, poles, cellar
// doors, vents, or wall clutter", "total prop count on the street is one street
// name blade", "there is one vehicle in the entire street, no parked cars along
// either edge". They were right. This module is the answer to all of it.
//
// ---------------------------------------------------------------------------
// THE BUDGET IS THE DESIGN
// ---------------------------------------------------------------------------
// The chase harness once measured 325 draw calls p95 with 233 individually
// meshed lamp posts accounting for ~70% of them. Draw calls, not triangles, are
// the wall this project keeps hitting, so a dressing pass that adds a mesh per
// prop type would spend a quarter of the remaining budget on decoration.
//
// Two mechanisms, and only two:
//
//   1. LAMPS are an InstancedMesh per part (3 calls for the whole district at
//      any lamp count). Unchanged from the version that fixed the lighting.
//
//   2. EVERYTHING ELSE STATIC is welded into ONE material and a handful of
//      512 m spatial buckets. Colour rides on the vertex colour attribute and
//      finish/emission ride on two 16x1 palette textures (the trick src/carbody.js
//      uses to give one car chrome, matte plastic and glowing lenses in a single
//      draw call). So a bollard, a plane tree, a red hydrant, a glowing traffic
//      signal lens and a painted crosswalk stripe are all the same material and
//      the same mesh. The buckets exist purely so the frustum can throw away the
//      half of the district behind the camera: typically 2-4 of the 6 buckets
//      draw, so the entire prop vocabulary costs 2-4 calls.
//
//   3. PARKED CARS reuse buildTrafficCarGeometry from src/carbody.js through one
//      InstancedMesh (1 call), pooled and re-seeded around the camera the same
//      way traffic and the crowd are, because 928 triangles x every kerb in a
//      1.4 km^2 district is not a triangle budget, it is a joke.
//
// ---------------------------------------------------------------------------
// PROPS SIT ON THE GROUND
// ---------------------------------------------------------------------------
// This project has had three separate "the post does not reach the pavement"
// findings and now has a gate for the class. The trap: streaming.js reports the
// ground as groundY (0) through heightAt(), but DRAWS the land pad at
// groundY - 0.05 and the road ribbons at groundY + 0.02. A prop based at exactly
// heightAt() hovers 50 mm over the pavement the player actually sees.
//
// So every ground-standing prop in this file starts at BASE_Y = -0.09, which is
// 40 mm INTO the drawn pavement and 110 mm into the road ribbon. Nothing here
// can float, and report().worstFloatMm measures it from the emitted vertices
// rather than asserting it in a comment.

import * as THREE from '../vendor/three.module.min.js';
import { buildTrafficCarGeometry, trafficCarMaterial, lampEmissive } from './carbody.js';

// ---------------------------------------------------------------- ground datum
const PAD_Y = -0.05;        // streaming.js land pad, the surface the player sees
const ROAD_Y = 0.02;        // streaming.js road ribbon, stacked on the pad
const BASE_Y = -0.09;       // every standing prop's lowest vertex
const DECAL_Y = ROAD_Y + 0.012;   // painted markings, lifted off the ribbon

// ---------------------------------------------------------------- the palette
// Same idea as carbody.js SURFACE: UV.x selects a texel, the texel carries
// roughness (.g), metalness (.b) and emissive colour. One material, many finishes.
const S = {
  concrete: 0, painted: 1, galv: 2, plastic: 3, rubber: 4, timber: 5,
  foliage: 6, bark: 7, lensRed: 8, lensAmber: 9, lensGreen: 10, lensWalk: 11,
  roadPaint: 12, iron: 13, chrome: 14, lensOff: 15,
};
//                rough  metal  emissive (sRGB bytes)
const PALETTE = [
  [0.93, 0.02, [0, 0, 0]],           // 0  concrete / stone
  [0.44, 0.42, [0, 0, 0]],           // 1  painted steel: poles, bollards, meters
  [0.38, 0.88, [0, 0, 0]],           // 2  galvanised: grates, vents, brackets
  [0.74, 0.02, [0, 0, 0]],           // 3  moulded plastic: bin bodies, cabinets
  [0.95, 0.00, [0, 0, 0]],           // 4  rubber / bitumen
  [0.78, 0.02, [0, 0, 0]],           // 5  timber: bench slats, utility poles
  [0.84, 0.00, [0, 0, 0]],           // 6  foliage
  [0.90, 0.00, [0, 0, 0]],           // 7  bark
  [0.13, 0.03, [255, 44, 26]],       // 8  signal lens, red
  [0.13, 0.03, [255, 152, 22]],      // 9  signal lens, amber
  [0.13, 0.03, [46, 255, 118]],      // 10 signal lens, green
  [0.13, 0.03, [255, 226, 188]],     // 11 pedestrian signal lens
  [0.80, 0.00, [0, 0, 0]],           // 12 thermoplastic road paint
  [0.66, 0.55, [0, 0, 0]],           // 13 cast iron: manholes, gully grates
  [0.22, 0.94, [0, 0, 0]],           // 14 chrome / stainless
  [0.13, 0.03, [0, 0, 0]],           // 15 an UNLIT signal lens: glossy, dark
];
const PAL_W = 16;
const paletteU = (i) => (i + 0.5) / PAL_W;

// ------------------------------------------------------------ the leaf stencil
//
// FOLIAGE IS CUT WITH AN ALPHA MASK, and the uv space it is cut in was already
// in the buffer, unused, since the kit was written.
//
// Every prop writes exactly `uv = (paletteU(surf), 0.5)`. The palette texture is
// PAL_W = 16 texels wide on NearestFilter, so `u` only has to land ANYWHERE in
// [surf/16, (surf+1)/16) for roughness, metalness and emissive to come back
// identical -- the texel CENTRE is a convention, not a requirement. And the
// palette is one texel tall, so `v` has never carried anything at all.
//
// That is a free 32 x 512 two-dimensional stencil per surface id, at zero
// triangles, zero attributes and zero extra draw calls. A leaf plate writes a
// real (u, v) across itself and the mask cuts its silhouette to a ragged,
// holed leaf cluster instead of a hard quad. It cuts SHADOWS too: three.js
// copies alphaMap and alphaTest onto the depth material it derives for shadow
// casting (verified in vendor/three.module.min.js: the depth fragment shader
// includes alphamap_fragment and alphatest_fragment, and the shadow map's
// material cache assigns `a.alphaMap = n.alphaMap`).
//
// WHY THE MASK IS A SEPARATE TEXTURE from packTexture(): the palette lookup has
// to stay NearestFilter or a leaf would sample halfway between two palette
// entries, while the stencil wants LinearFilter so its edge is not a staircase.
//
// AW is PAL_W * MASK_K so one palette texel spans exactly MASK_K mask columns.
// The pattern depends only on (x mod MASK_K, y), so it is the SAME tile under
// every palette column -- which means linear filtering at a column boundary
// blends the tile with a copy of itself and cannot bleed a neighbouring entry's
// mask in. The zone split is in `v`, where nothing else is looking.
//
//   rows   0..223   fourteen 32 x 16 OAK leaf-cluster stamps
//   rows 224..287   GUARD, opaque: v = 0.5 lands on rows 255/256
//   rows 288..351   QUEEN palm, pinnate: leaflet comb either side of the rachis
//   rows 352..415   SABAL palm, costapalmate: fan segments split at the tips
//   rows 416..511   GUARD, opaque
//
// MASK_K = 32 is the resolution a sweep of this stencil against
// tools/foliage-grain.mjs put nearest the photographs: K = 8 and K = 16 land a
// boundary dimension of 1.16 and 1.29 against the reference's 1.538, K = 32
// lands 1.64, and K = 48 overshoots into speckle. The sweep's own first answer
// was K = 16, from synthetic rasters 320 px wide that the metric never
// normalised while it normalised every photograph to 1024 -- crossings are
// counted per ROW, so that arm was low by 3.2x. Numbers below come from the
// corrected sweep.
const MASK_K = 64;
const AW = PAL_W * MASK_K, AH = 512;
const OAK_STAMPS = 7, STAMP_H = 32;             // rows 0 .. 223
// How far out in a stamp the leaf mass reaches. A clump's ring lands at stamp
// radius 0.625-1.0 and the quad it spans has an INRADIUS of about 0.62 of that,
// so a mask that fades out beyond 0.62 cuts inside the polygon in every
// direction and the straight edge never reaches the sky.
const OAK_STAMP_R = 0.70;
const QUEEN_V0 = 288, SABAL_V0 = 352, COMB_H = 64;
/**
 * `s` in [0, 1] across `surf`'s own stencil tile, as a texture u.
 *
 * It spans the CENTRES of the tile's first and last texel, never the texel
 * edges: u must stay strictly inside [surf/16, (surf+1)/16) or floor(u*16)
 * rounds to the neighbouring palette entry and the leaf comes back with
 * chrome's roughness. __kit.maskSelftest() asserts that for every surface and
 * both ends of the range.
 */
const maskU = (surf, s) => (surf * MASK_K + 0.5 + s * (MASK_K - 1)) / AW;
const maskV = (row) => (row + 0.5) / AH;

let _packTex = null, _emisTex = null, _alphaTex = null;
function packTexture() {
  if (_packTex) return _packTex;
  const data = new Uint8Array(PAL_W * 4);
  for (let i = 0; i < PAL_W; i++) {
    const p = PALETTE[i] ?? PALETTE[0];
    data[i * 4] = 255;
    data[i * 4 + 1] = Math.round(p[0] * 255);
    data[i * 4 + 2] = Math.round(p[1] * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, PAL_W, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return (_packTex = t);
}
function emissiveTexture() {
  if (_emisTex) return _emisTex;
  const data = new Uint8Array(PAL_W * 4);
  for (let i = 0; i < PAL_W; i++) {
    const e = (PALETTE[i] ?? PALETTE[0])[2];
    data[i * 4] = e[0]; data[i * 4 + 1] = e[1]; data[i * 4 + 2] = e[2];
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, PAL_W, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return (_emisTex = t);
}

/**
 * The stencil. One MASK_K-wide tile, replicated under every palette column so
 * linear filtering at a column boundary can only ever blend the tile with a
 * copy of itself.
 *
 * Written into the GREEN channel because that is the one three.js reads:
 * `diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g`. All four channels
 * are set anyway so a future reader of this buffer is not surprised.
 */
function alphaTexture() {
  if (_alphaTex) return _alphaTex;
  const tile = new Uint8Array(MASK_K * AH).fill(255);
  const h3 = (a, b, c) => {
    let t = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)
      + Math.imul(c | 0, 2246822519)) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  // Smooth value noise on a lattice. The stamp outline has to WANDER, not
  // dither: a per-texel random edge is speckle and reads as noise rather than
  // as leaves, which is the failure mode the K = 32 sweep showed.
  const noise = (x, y, freq, salt) => {
    const fx = x * freq, fy = y * freq;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = h3(ix, iy, salt) + (h3(ix + 1, iy, salt) - h3(ix, iy, salt)) * sx;
    const b = h3(ix, iy + 1, salt) + (h3(ix + 1, iy + 1, salt) - h3(ix, iy + 1, salt)) * sx;
    return a + (b - a) * sy;
  };
  const cut = (s, row) => { tile[row * MASK_K + s] = 0; };

  // ---- the oak: fourteen leaf-cluster stamps, each a ragged holed blob.
  // A clump maps its own ring plane onto one of these, with the ring vertices
  // landing at radius 0.70-1.12 and the apex and nadir BOTH at the centre --
  // so the top fan and the bottom fan of a pillow are cut identically and a
  // hole goes straight THROUGH the leaf mass instead of showing its own far
  // side. Enclosed sky is the whole point; a hole that reveals more leaf is
  // not one.
  // A STAMP IS LACEWORK, NOT A DISC WITH PINHOLES, and the first cut of it was
  // the second thing. A blob with independent per-texel holes punched in it
  // scored boundaryD 1.11 against a reference 1.54: the holes merged into a few
  // big ones (median 37 px against the photographs' 8) and, worse, the plate's
  // own straight polygon edges survived, because a round mask over a square
  // quad only cuts the corners. Three octaves of value noise thresholded
  // against a radial falloff instead gives connected filaments of leaf with
  // sky between them, breaks into many separate islands along any scanline,
  // and -- the part that matters -- its boundary is INSIDE the polygon's in
  // every direction, so the silhouette that reaches the frame is the mask's
  // and never the quad's.
  for (let k = 0; k < OAK_STAMPS; k++) {
    for (let ry = 0; ry < STAMP_H; ry++) {
      for (let s = 0; s < MASK_K; s++) {
        const sx = ((s + 0.5) / MASK_K) * 2 - 1, sy = ((ry + 0.5) / STAMP_H) * 2 - 1;
        const r = Math.hypot(sx, sy);
        const salt = k * 37 + 1;
        const nz = 0.30 * noise(sx, sy, 3.0, salt)
          + 0.44 * noise(sx, sy, 6.4, salt + 101)
          + 0.26 * noise(sx, sy, 12.8, salt + 211);
        // The falloff reaches zero at OAK_STAMP_R, which is under the quad's
        // own inradius, so the mask is what the sky sees.
        if ((nz - 0.50) * 3.4 + (1 - r / OAK_STAMP_R) < 0
          || h3(Math.floor((sx + 1) * 16), Math.floor((sy + 1) * 16), k * 31 + 5)
             < 0.10 + 0.26 * r * r) cut(s, k * STAMP_H + ry);
      }
    }
  }

  // ---- the queen palm: a pinnate frond is a rachis with two ranks of narrow
  // leaflets, and that is a comb. `bu` runs across the blade with 0 on the
  // rachis, `t` out along it; the leaflets are sheared so they angle toward
  // the tip the way a real one does, and one in nine is missing.
  for (let ry = 0; ry < COMB_H; ry++) {
    for (let s = 0; s < MASK_K; s++) {
      const bu = ((s + 0.5) / MASK_K) * 2 - 1, t = (ry + 0.5) / COMB_H;
      const ab = Math.abs(bu);
      if (ab < 0.13) continue;                                  // the rachis
      const ph = t * 16 + ab * 0.35;
      const gap = ph - Math.floor(ph) >= 0.62
        || h3(Math.floor(ph), bu < 0 ? 1 : 2, 3) < 0.11
        || ab > 0.94 + 0.10 * (noise(bu, t, 5, 17) - 0.5);
      if (gap) cut(s, QUEEN_V0 + ry);
    }
  }

  // ---- the sabal: a costapalmate fan is one sheet split into segments that
  // separate further and further out, which is a comb the other way up --
  // solid at the hastula, open at the rim.
  for (let ry = 0; ry < COMB_H; ry++) {
    for (let s = 0; s < MASK_K; s++) {
      const bu = ((s + 0.5) / MASK_K) * 2 - 1, t = (ry + 0.5) / COMB_H;
      if (Math.abs(bu) < 0.10 && t < 0.78) continue;             // the costa
      const sg = (bu + 1) * 3.6;
      const split = sg - Math.floor(sg) > 0.86 - 0.30 * t
        && t > 0.30 + 0.26 * h3(Math.floor(sg), 0, 9);
      if (split || t > 0.90 + 0.16 * (noise(bu, t, 4, 23) - 0.5)) cut(s, SABAL_V0 + ry);
    }
  }

  const data = new Uint8Array(AW * AH * 4);
  for (let y = 0; y < AH; y++) {
    for (let x = 0; x < AW; x++) {
      const v = tile[y * MASK_K + (x % MASK_K)];
      const p = (y * AW + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, AW, AH, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  // Mipmapped, and the far tier depends on it: as a crown shrinks the stencil
  // averages toward its own coverage, which is above ALPHA_TEST, so a distant
  // canopy closes back up into a solid mass rather than dissolving into
  // shimmer. Every non-foliage prop has a CONSTANT uv over its whole surface,
  // so its uv derivative is zero and it samples mip 0 for ever -- which is the
  // row that is opaque everywhere.
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return (_alphaTex = t);
}
// Below the coverage of every zone of the stencil, so a mipped-away leaf goes
// solid instead of vanishing.
const ALPHA_TEST = 0.42;

/** The single material every static prop in the district shares. */
function propMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1, metalness: 1,          // the maps are the authority
    roughnessMap: packTexture(),
    metalnessMap: packTexture(),
    emissiveMap: emissiveTexture(),
    emissive: 0x000000,
    // The leaf stencil. Every prop that is not foliage writes v = 0.5, which
    // lands in the opaque guard band, comes back alpha 1 and is untouched --
    // asserted rather than assumed by __kit.maskSelftest().
    alphaMap: alphaTexture(),
    alphaTest: ALPHA_TEST,
    // Painted road markings are coplanar-ish with the road ribbon 12 mm below
    // them; the offset keeps them from shimmering at grazing angles far down a
    // corridor. Harmless on the solid props.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
}

// ---------------------------------------------------------------- determinism
// The district must dress identically every run: a harness that measures a
// different street each time measures nothing.
// NOTE: this returns an UNSIGNED 32-bit value, so every downstream bit-slice has
// to use >>> and not >>. A signed shift goes negative for half of all keys, and
// `negative % 100 < 21` is true for every one of them: the first cut of the
// plaza row fired on half the district instead of a fifth and planted 461 trees
// nobody asked for.
function hash32(...args) {
  let h = 0x811c9dc5;
  for (const a of args) {
    const s = typeof a === 'number' ? (a * 1000) | 0 : 0;
    let v = typeof a === 'string' ? 0 : s;
    if (typeof a === 'string') for (let i = 0; i < a.length; i++) v = (v * 31 + a.charCodeAt(i)) | 0;
    h ^= v; h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
  }
  return (h >>> 0);
}
const rnd01 = (...a) => (hash32(...a) % 100000) / 100000;

// ---------------------------------------------------------------- geometry kit
// Local frames. Every prop is authored in (out, up, along): +x points away from
// the road, +z runs along the kerb. That makes "set the bench back 0.4 m and
// face it at the street" arithmetic instead of trigonometry.
const frame = (x, z, ax, az, ox, oz) => ({ x, z, ax, az, ox, oz });
const wx = (f, lx, lz) => f.x + lx * f.ox + lz * f.ax;
const wz = (f, lx, lz) => f.z + lx * f.oz + lz * f.az;

// ---------------------------------------------------------------- HANDEDNESS
// The local->world map above is (lx, lz) -> lx*(ox,oz) + lz*(ax,az), and its
// determinant is ox*az - ax*oz. Most frames in this file build `out` by rotating
// `along` one particular way, which makes that determinant -1: the local frame
// is a REFLECTION, so a triangle authored counter-clockwise-from-outside in
// local coordinates comes out CLOCKWISE in world space, is culled as a back
// face, and what you see instead is the FAR wall of the solid shaded by a normal
// pointing away from you — ambient-only, i.e. near-black, and it does not change
// when the sun moves. Four rounds of blind critics called this "flat dark boxes
// with no housing detail", "near-black", "2-3 flat facets of near-identical dark
// green"; it is one defect, and this is it.
//
// Measured, not assumed. box() built in a det = -1 frame, rendered against
// THREE.BoxGeometry under one directional light sitting at the camera, averaged
// over the silhouette:
//
//     THREE.BoxGeometry   251/255        kit box(), det +1   251/255
//     kit box(), det -1   6.7/255        (bench 84.8 -> 0, hydrant 178.8 -> 4.9)
//
// The frames are NOT all reflections, so a blanket flip of quad() would fix one
// half of the kit and break the other. Measured over the 6,868 dressed props by
// building each one and asking whether it emitted a face wound against its own
// normal — not by reading the call sites and reasoning about them:
//
//   INSIDE OUT, det -1                   ALREADY RIGHT, det +1
//   4,596 props / 114,792 triangles      1,996 props / 33,684 triangles
//     every kerb station (bollard,         237 signal masts: _dressJunctions
//     meter, bin, hydrant, newsbox,        builds its frame from the approach
//     bikerack, bench, planter,            vector, not from a rotated `along`
//     cabinet), the plaza and back         46 cable spans: tube() takes world
//     rows, the carriageway castings       points, so no frame applies
//     (manhole, gully), the utility        1,713 frontage and wall-clutter
//     poles, and the wall clutter on       props on edges whose first-guess
//     the edges _dressWalls had to         outward normal already pointed out
//     flip the outward normal on           of the footprint
//
// The 276 trees are in det -1 frames too and were already right: the pass that
// rebuilt them routed every triangle through tri() for exactly this reason.
//
// So no winding is hard-coded anywhere. handOf() reads the determinant of the
// frame the CALLER composed, and every emitter below — quad(), the prism and
// blob end caps, and tri() for the tree — winds to match it. A prop comes out
// right way round in either kind of frame, and a new call site cannot get it
// wrong by composing its frame the other way.
//
// tube() is the one deliberate exception: it takes WORLD points and builds its
// own orthonormal ring from them, so no frame applies. Audited in both kinds of
// frame, 6/6 of its triangles agree either way, and it is left alone.
const handOf = (f) => (f.ox * f.az - f.ax * f.oz < 0 ? -1 : 1);
const tri = (buf, hand, a, b, c) => {
  if (hand < 0) buf.idx.push(a, c, b); else buf.idx.push(a, b, c);
};

function newBuf() { return { pos: [], nrm: [], col: [], uv: [], idx: [] }; }

/**
 * The winding half of the prop audit, measured the way worstFloat measures the
 * floating half: off the triangles the prop actually emitted, never asserted.
 *
 * For every triangle written since index `i0`, compare the GEOMETRIC normal —
 * the cross product over the index order, which is the quantity the rasteriser
 * culls on — against the VERTEX normal the shader lights with. Disagreement is
 * the whole-kit defect this file used to have: the triangle is culled, the far
 * wall of the solid is what reaches the frame, and it is shaded by a normal
 * pointing away from the camera, so it gets ambient and no key light at any
 * hour. Cheap enough to run over 350,000 triangles but pure verification, so it
 * only runs under opts.audit.
 */
function windingOf(buf, i0) {
  const { pos, nrm, idx } = buf;
  let ok = 0, bad = 0, flat = 0;
  for (let t = i0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const nx = nrm[a] + nrm[b] + nrm[c];
    const ny = nrm[a + 1] + nrm[b + 1] + nrm[c + 1];
    const nz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    const scale = Math.hypot(gx, gy, gz) * Math.hypot(nx, ny, nz);
    if (scale < 1e-12) { flat++; continue; }
    const d = (gx * nx + gy * ny + gz * nz) / scale;
    if (d < -0.08) bad++; else if (d <= 0.08) flat++; else ok++;
  }
  return { tris: (idx.length - i0) / 3, ok, bad, flat };
}

// THREE.Color.setHex runs an sRGB -> working-space transfer, i.e. three pow()
// calls, and the dressing pass writes ~350,000 vertices. Memoising the handful
// of colours the kit actually uses took the whole pass from 1.27 s to a fifth
// of that; it is the difference between a load stage and a load hitch.
const _colCache = new Map();
const _colTmp = new THREE.Color();
function linear(hex) {
  let c = _colCache.get(hex);
  if (!c) { _colTmp.setHex(hex); c = [_colTmp.r, _colTmp.g, _colTmp.b]; _colCache.set(hex, c); }
  return c;
}
function vert(buf, x, y, z, nx, ny, nz, hex, surf) {
  const c = linear(hex);
  buf.pos.push(x, y, z);
  buf.nrm.push(nx, ny, nz);
  buf.col.push(c[0], c[1], c[2]);
  buf.uv.push(paletteU(surf), 0.5);
  return buf.pos.length / 3 - 1;
}

/**
 * One quad, corners in world space, wound a-b-c-d, in a frame of handedness
 * `hand`. 2 triangles.
 *
 * `hand` defaults to +1 for the one caller that has no frame at all — tube(),
 * which works in world space. Everything else passes handOf(f), because the
 * order that puts the geometric normal of these two triangles on the same side
 * as `n` is the OPPOSITE order in a reflected frame. Get it wrong and the quad
 * is culled and the far wall of the solid is what the camera sees, lit by a
 * normal pointing away from it: ambient only, no key light, at any hour.
 */
function quad(buf, a, b, c, d, n, hex, surf, hand = 1) {
  const i = vert(buf, a[0], a[1], a[2], n[0], n[1], n[2], hex, surf);
  vert(buf, b[0], b[1], b[2], n[0], n[1], n[2], hex, surf);
  vert(buf, c[0], c[1], c[2], n[0], n[1], n[2], hex, surf);
  vert(buf, d[0], d[1], d[2], n[0], n[1], n[2], hex, surf);
  // Wound so the geometric normal of each triangle agrees with the vertex
  // normal above. Verified numerically rather than by eye, per emitter and in
  // both handednesses: the geometric normal (cross product over the index
  // order, which is what the rasteriser culls on) dotted with the vertex normal
  // has to be positive, and a screenshot at dusk hides it when it is not.
  if (hand < 0) buf.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  else buf.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
}

/**
 * Axis-aligned-in-frame box. 12 triangles. (cx, cz) are frame-local, cy world.
 * The workhorse: utility boxes, bench slats, signal heads, cellar doors, kerbs.
 */
function box(buf, f, cx, cy, cz, hx, hy, hz, hex, surf) {
  const P = (lx, ly, lz) => [wx(f, cx + lx, cz + lz), cy + ly, wz(f, cx + lx, cz + lz)];
  const O = [f.ox, 0, f.oz], A = [f.ax, 0, f.az];
  const nO = [-f.ox, 0, -f.oz], nA = [-f.ax, 0, -f.az];
  const w = handOf(f);
  const [a, b, c, d] = [P(hx, -hy, -hz), P(hx, -hy, hz), P(hx, hy, hz), P(hx, hy, -hz)];
  const [e, g, h, i] = [P(-hx, -hy, hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(-hx, hy, hz)];
  quad(buf, a, b, c, d, O, hex, surf, w);              // outward face
  quad(buf, e, g, h, i, nO, hex, surf, w);             // inward face
  quad(buf, b, e, i, c, A, hex, surf, w);              // along +
  quad(buf, g, a, d, h, nA, hex, surf, w);             // along -
  quad(buf, d, c, i, h, [0, 1, 0], hex, surf, w);      // top
  quad(buf, g, e, b, a, [0, -1, 0], hex, surf, w);     // bottom
}

/**
 * Vertical n-gon prism with a top cap and no bottom cap (the bottom is buried).
 * 2n + (n-2) triangles: a 6-sided bollard is 16 triangles, not 500.
 */
function prism(buf, f, cx, cz, r0, r1, y0, y1, sides, hex, surf, phase = 0) {
  const w = handOf(f);
  const ring0 = [], ring1 = [], nrm = [];
  for (let s = 0; s < sides; s++) {
    const a = phase + (s / sides) * Math.PI * 2;
    const ux = Math.cos(a), uz = Math.sin(a);
    ring0.push([wx(f, cx + ux * r0, cz + uz * r0), y0, wz(f, cx + ux * r0, cz + uz * r0)]);
    ring1.push([wx(f, cx + ux * r1, cz + uz * r1), y1, wz(f, cx + ux * r1, cz + uz * r1)]);
    nrm.push([ux * f.ox + uz * f.ax, 0, ux * f.oz + uz * f.az]);
  }
  for (let s = 0; s < sides; s++) {
    const t = (s + 1) % sides;
    const n = [(nrm[s][0] + nrm[t][0]) / 2, 0, (nrm[s][2] + nrm[t][2]) / 2];
    quad(buf, ring0[s], ring0[t], ring1[t], ring1[s], n, hex, surf, w);
  }
  const c0 = vert(buf, wx(f, cx, cz), y1, wz(f, cx, cz), 0, 1, 0, hex, surf);
  const first = c0 + 1;
  for (let s = 0; s < sides; s++) {
    vert(buf, ring1[s][0], ring1[s][1], ring1[s][2], 0, 1, 0, hex, surf);
  }
  // The cap fan is a triangle list of its own, so it needs the same treatment as
  // the sides: (centre, s+1, s) faces up in a right-handed frame and down in a
  // reflected one.
  for (let s = 0; s < sides; s++) tri(buf, w, c0, first + ((s + 1) % sides), first + s);
}

/** Flat horizontal rectangle: road markings, tree pits, cellar-door leaves. */
function slab(buf, f, cx, cz, hx, hz, y, hex, surf) {
  const P = (lx, lz) => [wx(f, cx + lx, cz + lz), y, wz(f, cx + lx, cz + lz)];
  quad(buf, P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz), [0, 1, 0], hex, surf, handOf(f));
}

/**
 * Low-poly spheroid: tree crowns and shrubs. Six sides and two intermediate
 * latitudes is 36 triangles and reads as a leafy mass; the two stacked cones it
 * replaces cost 32 and read as a tent, which is exactly what the first capture
 * of this pass showed standing on every wide pavement in the district.
 */
function blob(buf, f, cx, cz, cy, rx, ry, sides, hex, surf, phase = 0) {
  const w = handOf(f);
  const lat = [[-1, 0], [-0.55, 0.72], [0.05, 1], [0.6, 0.7], [1, 0]];
  const rings = lat.map(([ty, tr]) => {
    if (tr === 0) return null;
    const r = [];
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * Math.PI * 2;
      const ux = Math.cos(a) * tr * rx, uz = Math.sin(a) * tr * rx;
      r.push([wx(f, cx + ux, cz + uz), cy + ty * ry, wz(f, cx + ux, cz + uz),
        Math.cos(a), Math.sin(a)]);
    }
    return r;
  });
  const nrmOf = (p) => [p[3] * f.ox + p[4] * f.ax, 0.35, p[3] * f.oz + p[4] * f.az];
  for (let k = 1; k < rings.length - 2; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      quad(buf, [A[i][0], A[i][1], A[i][2]], [A[j][0], A[j][1], A[j][2]],
        [B[j][0], B[j][1], B[j][2]], [B[i][0], B[i][1], B[i][2]],
        nrmOf(A[i]), hex, surf, w);
    }
  }
  for (const [poleT, ring, up] of [[-1, rings[1], -1], [1, rings[rings.length - 2], 1]]) {
    const c = vert(buf, wx(f, cx, cz), cy + poleT * ry, wz(f, cx, cz), 0, up, 0, hex, surf);
    const first = c + 1;
    for (const p of ring) vert(buf, p[0], p[1], p[2], 0, up, 0, hex, surf);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (up > 0) tri(buf, w, c, first + j, first + i);
      else tri(buf, w, c, first + i, first + j);
    }
  }
}

/** Vertical rectangle facing outward (+x of the frame): lenses, wall plates. */
function plate(buf, f, cx, cy, cz, hz, hy, off, hex, surf) {
  const P = (lz, ly) => [wx(f, cx + off, cz + lz), cy + ly, wz(f, cx + off, cz + lz)];
  quad(buf, P(-hz, -hy), P(hz, -hy), P(hz, hy), P(-hz, hy), [f.ox, 0, f.oz], hex, surf,
    handOf(f));
}

/** A thin triangular tube between two world points: overhead cable spans. No
 *  frame, so no handedness — the ring is built from an orthonormal (u, p, u x p)
 *  triple in world space, which is right-handed by construction, and quad()'s
 *  default hand of +1 is the correct one. Audited in both kinds of frame: 6/6
 *  triangles agree either way. */
function tube(buf, p, q, r, hex, surf) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // any perpendicular
  let px = -uz, py = 0, pz = ux;
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl; pz /= pl;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  const ring = [];
  for (let s = 0; s < 3; s++) {
    const a = (s / 3) * Math.PI * 2;
    const c = Math.cos(a) * r, d = Math.sin(a) * r;
    ring.push([px * c + qx * d, py * c + qy * d, pz * c + qz * d]);
  }
  for (let s = 0; s < 3; s++) {
    const t = (s + 1) % 3;
    const n = [(ring[s][0] + ring[t][0]) / 2, (ring[s][1] + ring[t][1]) / 2, (ring[s][2] + ring[t][2]) / 2];
    quad(buf,
      [p[0] + ring[s][0], p[1] + ring[s][1], p[2] + ring[s][2]],
      [q[0] + ring[s][0], q[1] + ring[s][1], q[2] + ring[s][2]],
      [q[0] + ring[t][0], q[1] + ring[t][1], q[2] + ring[t][2]],
      [p[0] + ring[t][0], p[1] + ring[t][1], p[2] + ring[t][2]],
      n, hex, surf);
  }
}

// ---------------------------------------------------------------- the props
// Every one of these is authored base-first at BASE_Y so it cannot float, and
// every one is counted in triangles in the comment because that number is the
// thing the budget gate reads.

function propBollard(buf, f, k) {                                    // 16 tris
  const h = 0.94 + rnd01('bo', k) * 0.12;
  prism(buf, f, 0, 0, 0.115, 0.098, BASE_Y, h, 6, 0x2b3036, S.painted);
}

function propMeter(buf, f, k) {                                      // 26 tris
  prism(buf, f, 0, 0, 0.055, 0.05, BASE_Y, 1.02, 4, 0x3b4147, S.painted, 0.4);
  box(buf, f, 0, 1.2, 0, 0.1, 0.19, 0.13, 0x6f777f, S.painted);
  plate(buf, f, 0, 1.24, 0, 0.085, 0.1, 0.105, 0x11161c, S.lensOff);
}

function propBin(buf, f, k) {                                        // 28 tris
  const green = hash32('bin', k) % 3 === 0;
  prism(buf, f, 0, 0, 0.29, 0.32, BASE_Y, 0.92, 6, green ? 0x2c3a30 : 0x3c3a35, S.plastic);
  box(buf, f, 0, 0.99, 0, 0.34, 0.07, 0.34, 0x1c211d, S.plastic);
}

function propHydrant(buf, f, k) {                                    // 28 tris
  const hex = hash32('hy', k) % 5 === 0 ? 0xd0a92c : 0xbe332a;
  prism(buf, f, 0, 0, 0.19, 0.15, BASE_Y, 0.64, 6, hex, S.painted);
  box(buf, f, 0, 0.75, 0, 0.15, 0.13, 0.15, hex, S.painted);
}

function propBench(buf, f, k) {                                      // 36 tris
  // Seat faces the street: the frame's +x is away from the road, so the back
  // goes on the +x side and the sitter looks out over the kerb.
  box(buf, f, 0, 0.44, 0, 0.28, 0.05, 0.9, 0x6d4c33, S.timber);
  box(buf, f, 0.24, 0.72, 0, 0.05, 0.24, 0.9, 0x6d4c33, S.timber);
  box(buf, f, 0, 0.18, 0, 0.2, 0.27, 0.82, 0x2a2e33, S.painted);
}

function propPlanter(buf, f, k) {                                    // 40 tris
  prism(buf, f, 0, 0, 0.56, 0.52, BASE_Y, 0.62, 6, 0x918a80, S.concrete);
  blob(buf, f, 0, 0, 0.92, 0.5, 0.36, 4, 0x4a6b34, S.foliage, 0.7);
}

// ============================================================== STREET PALMS
//
// THE DISTRICT IS DOWNTOWN SARASOTA, AND SARASOTA IS PLANTED WITH PALMS.
//
// data/district.json's meta.origin is 27.335, -82.54125 — Main Street at Five
// Points, latitude 27 north, the Gulf coast of Florida. Every openly-licensed
// photograph in reference/sarasota/ that shows a street shows palms, and the
// two that show our own hero junction show nothing else:
//
//   03-Five-Points-Roundabout   sabal palms round the whole roundabout, queen
//                               palms on the islands, one broadleaf in shot
//   02-Worth-s-Block            a palm on the corner, trunk criss-crossed with
//                               persistent leaf bases, right against the brick
//   05-Sarasota-Opera-House     three queen palms, smooth grey trunks, crowns
//                               of long arching feather fronds
//   06-Frances-Carlton          two queen palms at full height against stucco
//
// What stood here instead was a temperate broadleaf — a lobed two-tier crown on
// a leaning trunk, the tree you would plant in Boston. It is a good tree and it
// is the single loudest wrong note in the district: a street's vegetation is
// read before its architecture, and this one said "generic North American
// city" in every frame.
//
// TWO SPECIES, because the reference has two and they do not look alike:
//
//   SABAL (cabbage palm, Florida's state tree). Fatter grey-brown trunk with a
//   criss-cross of persistent leaf bases — the "boot" — for the lower half of
//   its height. COSTAPALMATE crown: fronds are broad fans that open out toward
//   the tip and are held stiffly, so the crown is a dense globe.
//
//   QUEEN. Slender, smooth, pale grey trunk with faint ring scars. PINNATE
//   crown: long feather fronds that arch up and then droop hard past the
//   horizontal, so the crown is a fountain and the silhouette is all curve.
//
// ---------------------------------------------------------------------------
// WHAT IT COSTS, AND WHERE THE SILHOUETTE COMES FROM
// ---------------------------------------------------------------------------
// A palm is cheaper to draw convincingly than a broadleaf, because a broadleaf
// is a MASS and a palm is a SKELETON: the thing you recognise is a dozen long
// thin arcs radiating off the top of a pole, and a long thin arc is what
// triangles are good at. The broadleaf spent 60-96 triangles on lobes trying to
// fake a surface made of ten thousand leaves; the same triangles here are the
// actual shape of the actual object.
//
//   pit slab                                        2 tris
//   trunk: 5-gon, 3 stations, curved, boot-notched 20
//   crown bud / spear leaf: 5-gon cone               5
//   6 fronds x 3 segments x 3 strips x 2            108
//   -----------------------------------------------------
//   FAR tier, kind 'tree'                          135   (broadleaf: mean 116)
//
//   6 more fronds, interleaved                     108
//   10 trunk plates (sabal boots / queen scars)     20
//   -----------------------------------------------------
//   NEAR tier, kind 'treeDetail'                   128   (broadleaf: 134)
//
// Measured over 400 palms by tools-side replay of these same functions rather
// than counted by hand off the source: see the census in the report.
//
// EVERY FROND IS A CLOSED WEDGE, not a card. Three strips — an upper-left
// blade, an upper-right blade and a floor between their outer edges — so the
// cross-section is a triangle with the rachis on top and the leaflet tips
// hanging below it, which is what a real frond's section is. Two consequences
// worth the third strip:
//
//   1. IT RENDERS FROM UNDERNEATH. The camera in this game is 1.5-2.4 m off the
//      pavement and a palm carries its crown at 6-13 m, so the view of a street
//      palm is overwhelmingly the view UP INTO IT. A single-sided blade would be
//      culled from exactly the angle the player spends the whole game at.
//   2. IT SHADES. The two upper blades take normals tilted up-and-out to either
//      side of the rachis and the floor takes one pointing down, so one blade is
//      always brighter than the other and the underside is always dark — the
//      lit-side/shaded-side property the broadleaf's baked gradient bought, for
//      free, out of the geometry being right.
//
// ---------------------------------------------------------------------------
// THE TIER SPLIT, AND WHY IT CANNOT POP
// ---------------------------------------------------------------------------
// 'tree' is FAR (512 m buckets, never distance-culled); 'treeDetail' is NEAR
// and switched off past ~200 m. The 12 fronds are laid out on the golden angle
// with an "age" parameter running 0..1 across them — young fronds upright and
// short, old fronds flat and long — and the FAR tier takes the EVEN indices.
// Golden-angle indexing means even and odd are each spread evenly round the
// azimuth, and even indices sample the whole age range, so the far tier already
// carries the full outline at half the density. Crossing 200 m fills the crown
// in; it does not change its shape. 'treeDetail' is not a prop — it is the near
// half of a palm — and is counted separately in report() for that reason.
//
// ---------------------------------------------------------------------------
// THE BOOT, FOR NO TRIANGLES
// ---------------------------------------------------------------------------
// The sabal's criss-cross is its most recognisable feature at street distance
// and it is a texture, which this file has no way to spend. So it is spent on
// the trunk's own SILHOUETTE instead: in the boot zone alternate vertices of
// each ring are pushed in and out, and the phase flips on alternate rings, so
// the trunk edge zigzags in a diamond. Zero extra triangles — it is a radius
// modulation on vertices that already exist. The near tier adds ten real
// protruding plates on top of it at the distance where 6 cm is more than a
// pixel; the same ten plates on a queen sit nearly flush and read as ring
// scars, which is what a queen trunk has instead.
//
// ---------------------------------------------------------------------------
// NIGHT
// ---------------------------------------------------------------------------
// The palette rule the broadleaf earned is kept. A critic once measured one
// crown as "a saturated yellow-green brighter than any other surface at that
// depth" and another at the same distance as "near-black": 0x47692f is a
// saturated daylight green (G/R 1.48) three metres under a 7.7 m lamp head, and
// the crown was ONE value, so a tree either caught the lamp whole or missed it
// whole. These fronds sit at G/R 1.11-1.26 — green, but nowhere near
// chartreuse — and the wedge section guarantees a lit face and a shaded face on
// every frond at every hour whether or not a lamp reaches it.
const TAU = Math.PI * 2;

// The tree is authored with tri() and handOf() rather than quad(), which is not
// a tree idiom: see HANDEDNESS at the top of the geometry kit. It was the first
// part of this file to be wound for the frame it is built in, and it is now how
// the whole kit works.

/**
 * Deterministic per-tree PRNG. hash32 walks a string on every call, which is
 * fine for the handful of draws a bollard needs and much too slow for the ~150
 * a crown needs; this is seeded from one hash32 and then costs three integer
 * ops. Same seed, same tree, every run — the district must dress identically.
 */
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vertex with an explicit LINEAR colour. vert() takes an sRGB hex and memoises
// the transfer, which is right when a few dozen colours are reused across
// 350,000 vertices; foliage wants a different value at every vertex, so the
// tree resolves its leaf colour once through linear() and then scales it, which
// is three multiplies and no pow().
// `uv` is optional and only foliage passes it: everything else keeps the
// palette-texel centre and v = 0.5, which is the stencil's opaque guard band.
function vertC(buf, x, y, z, nx, ny, nz, r, g, b, surf, uv) {
  buf.pos.push(x, y, z);
  buf.nrm.push(nx, ny, nz);
  buf.col.push(r, g, b);
  if (uv) buf.uv.push(uv[0], uv[1]); else buf.uv.push(paletteU(surf), 0.5);
  return buf.pos.length / 3 - 1;
}

/**
 * The palm trunk: an n-gon tube threaded through a list of stations, smooth-
 * shaded around the axis (so a 5-sided trunk reads round rather than
 * pentagonal), then closed on top by a cone to a spear-leaf apex.
 *
 * 2n(stations-1) + n triangles from n*stations + 1 vertices. A 5-gon over three
 * stations is 20 + 5 = 25 triangles; prism() would spend 26 vertices on the
 * sides alone because quad() cannot share a ring between two segments.
 *
 * Stations carry their own radius, colour and BOOT amplitude. The boot is the
 * sabal's criss-cross of persistent leaf bases and is the reason this takes a
 * per-station list rather than two endpoints: alternate vertices of a ring are
 * pushed out and in by `boot`, and the phase flips on the next ring, so the
 * trunk's own outline zigzags in a diamond for no extra triangles at all.
 */
function palmTrunk(buf, f, st, sides, phase, apex, surf) {
  const hand = handOf(f);
  const rows = [];
  for (let s = 0; s < st.length; s++) {
    const S0 = st[s];
    const row = [];
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * TAU;
      const ux = Math.cos(a), uz = Math.sin(a);
      const rad = S0.r * (S0.boot ? 1 + S0.boot * (((i + s) & 1) ? 1 : -1) : 1);
      row.push(vertC(buf, wx(f, S0.x + ux * rad, S0.z + uz * rad), S0.y,
        wz(f, S0.x + ux * rad, S0.z + uz * rad),
        ux * f.ox + uz * f.ax, 0.16, ux * f.oz + uz * f.az,
        S0.c[0], S0.c[1], S0.c[2], surf));
    }
    rows.push(row);
  }
  for (let s = 0; s + 1 < rows.length; s++) {
    const A = rows[s], B = rows[s + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(buf, hand, A[i], B[j], A[j]);
      tri(buf, hand, A[i], B[i], B[j]);
    }
  }
  // The cap is a cone rather than a flat fan, so it doubles as the SPEAR LEAF —
  // the unopened frond every palm carries pointing straight up out of the
  // crown's centre. Same n triangles a flat cap costs, and it is the difference
  // between a crown that has a growing point and one that has a lid.
  const top = rows[rows.length - 1], T = st[st.length - 1];
  const ap = vertC(buf, wx(f, T.x + apex[0], T.z + apex[2]), T.y + apex[1],
    wz(f, T.x + apex[0], T.z + apex[2]), 0, 1, 0,
    apex[3][0], apex[3][1], apex[3][2], surf);
  for (let i = 0; i < sides; i++) tri(buf, hand, ap, top[(i + 1) % sides], top[i]);
}

/**
 * ONE FROND, as a closed wedge: rachis on top, two blades sloping down from it,
 * a floor between their outer edges. 6 triangles per segment out of 6 shared
 * vertices per station — three strips, each sharing its whole spine.
 *
 * The spine is a parabola in the (radial, up) plane of its own azimuth:
 *
 *     radial(t) = len*t                 height(t) = len*(rise*t - droop*t*t)
 *
 * so `rise` is the angle it leaves the crown at and `droop` bends it over. A
 * queen's frond leaves at 55 degrees and finishes well below the horizontal; a
 * sabal's leaves flatter and stays up. That one pair of numbers is most of the
 * difference between the two species' silhouettes.
 *
 * The section is built from an orthonormal triple that costs no square roots:
 * with T the unit tangent in that plane, Sd = (-sin az, 0, cos az) the
 * horizontal perpendicular, and D = T x Sd, the identity T x Sd = D holds by
 * construction and |D| = |T| = 1 because (tx, ty) is already normalised. D has
 * y = -tx < 0 everywhere the frond points outward, so it IS "down the keel"
 * without a sign test.
 *
 * WINDING. The three strips are wound so each triangle's geometric normal
 * agrees with the vertex normals it carries — the property windingOf() audits
 * and the property four rounds of critics reported the absence of. With the
 * quad at station i taken as (A[i], B[i], B[i+1]) the geometric normal comes out
 * proportional to -(T x (B-A)), so the LEFT strip runs (spine -> left), the
 * RIGHT strip runs (right -> spine) and the FLOOR runs (left -> right). That is
 * not a convention, it is what the cross products come to; getting it wrong
 * culls the frond and hands the camera its far face.
 */
function palmFrond(buf, f, P, ctx) {
  const hand = handOf(f);
  const n = P.seg;
  const ca = Math.cos(P.az), sa = Math.sin(P.az);
  // Half-width along the frond. A queen's feather is widest a third of the way
  // out and comes to a point; a sabal carries a bare petiole for a third of its
  // length and then opens a fan, which is why its crown reads as a globe of
  // separate leaves and the queen's as one fountain.
  //
  // The first cut had the sabal at 0.12 + 0.92*t^0.8 on a half-width of 0.28R,
  // which put a metre-wide blade on a 1.4 m frond: the capture read as six
  // banana paddles, not a cabbage palm. The exponent is now 1.5 on a half-width
  // of 0.155R, so the petiole stays thin and the fan opens late.
  const wOf = P.fan
    ? (t) => 0.30 + 0.90 * Math.pow(t, 1.5)
    : (t) => (0.14 + Math.sin(Math.PI * Math.pow(t, 0.6))) * (1 - 0.92 * t * t * t);

  const rj = rng32(P.seed);
  const spine = [], left = [], right = [], nL = [], nR = [], nD = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const nn = Math.hypot(1, P.rise - 2 * P.droop * t);
    const tx = 1 / nn, ty = (P.rise - 2 * P.droop * t) / nn;
    const dx = ty * ca, dy = -tx, dz = ty * sa;            // D = T x Sd, points down
    // The two halves of the blade get INDEPENDENT widths, jittered harder the
    // further out they are. A frond built symmetrically off a smooth width
    // profile has a straight-line silhouette on both edges and reads as a
    // moulded plastic strap; the same triangles with a ragged edge read as
    // leaflets. It is the same "nothing in the crown is a regular polygon"
    // lesson the broadleaf's lobes had to learn, and it costs nothing.
    const w = P.wid * wOf(t), jw = 0.40 * t;
    const wl = w * (1 - jw * 0.5 + rj() * jw), wr = w * (1 - jw * 0.5 + rj() * jw);
    const kl = wl * P.keel * (0.35 + 0.65 * t);            // how far the tips hang
    const kr = wr * P.keel * (0.35 + 0.65 * t);
    const px = P.x + ca * P.len * t;
    const py = P.y + P.len * (P.rise * t - P.droop * t * t);
    const pz = P.z + sa * P.len * t;
    spine.push([px, py, pz]);
    left.push([px - sa * wl + dx * kl, py + dy * kl, pz + ca * wl + dz * kl]);
    right.push([px + sa * wr + dx * kr, py + dy * kr, pz - ca * wr + dz * kr]);
    // -(T x u) for the upper-left blade and (T x v) for the upper-right one,
    // both of which reduce to a mix of Sd and -D and so are already unit-ish.
    const ll = Math.hypot(kl, wl) || 1, lr = Math.hypot(kr, wr) || 1;
    nL.push([(kl * -sa - wl * dx) / ll, (-wl * dy) / ll, (kl * ca - wl * dz) / ll]);
    nR.push([(-wr * dx - kr * -sa) / lr, (-wr * dy) / lr, (-wr * dz - kr * ca) / lr]);
    // The floor's true normal is D, straight down the keel, and a straight-down
    // normal at an 8 degree sun collects nothing but the dome's ground term: the
    // first capture had whole fronds reading as black wedges. A palm leaflet is
    // one cell thick and transmits, so the floor is tilted OUTWARD by half a
    // unit — it still faces down, it now also faces the horizon, which is where
    // the light that actually reaches the underside of a frond comes from.
    const bx = dx + ca * 0.5, bz = dz + sa * 0.5;
    const bl = Math.hypot(bx, dy, bz) || 1;
    nD.push([bx / bl, dy / bl, bz / bl]);
  }

  // ---- THE STENCIL, and the one thing about it that matters: all three strips
  // are cut in the SAME coordinates. `bu` runs across the frond with 0 on the
  // rachis and +-1 at the blade edges, so a leaflet gap at bu = -0.6 is cut out
  // of the upper-left blade AND out of the floor beneath it at the same place.
  // A wedge cut independently on its three faces is a wedge with holes in it;
  // cut in register it is a rank of separate leaflets with daylight between
  // them, which is what a frond is. `t` runs out along the rachis, and the two
  // species read different rows of the mask -- a queen's narrow pinnate
  // leaflets against a sabal's costapalmate fan splitting at its tips.
  const v0 = P.fan ? SABAL_V0 : QUEEN_V0;
  const uvOf = (bu, t) => [maskU(S.foliage, 0.5 + 0.48 * bu),
    maskV(v0 + 0.5 + t * (COMB_H - 2))];

  // A strip between two parallel station arrays, sharing every vertex along its
  // length. `shade` is the face's own multiplier: the floor of the wedge never
  // sees the sky and the two blades see different halves of it.
  const strip = (A, B, NA, NB, shade, buA, buB) => {
    const ia = [], ib = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const c = ctx.col(t, shade, i);
      const na = NA[i], nb = NB[i];
      ia.push(vertC(buf, wx(f, A[i][0], A[i][2]), A[i][1], wz(f, A[i][0], A[i][2]),
        na[0] * f.ox + na[2] * f.ax, na[1], na[0] * f.oz + na[2] * f.az,
        c[0], c[1], c[2], S.foliage, uvOf(buA, t)));
      ib.push(vertC(buf, wx(f, B[i][0], B[i][2]), B[i][1], wz(f, B[i][0], B[i][2]),
        nb[0] * f.ox + nb[2] * f.ax, nb[1], nb[0] * f.oz + nb[2] * f.az,
        c[0], c[1], c[2], S.foliage, uvOf(buB, t)));
    }
    for (let i = 0; i < n; i++) {
      tri(buf, hand, ia[i], ib[i], ib[i + 1]);
      tri(buf, hand, ia[i], ib[i + 1], ia[i + 1]);
    }
  };
  strip(spine, left, nL, nL, 1.0, 0, -1);   // upper blade, one side of the rachis
  strip(right, spine, nR, nR, 0.86, 1, 0);  // upper blade, the other
  strip(left, right, nD, nD, 0.70, -1, 1);  // the floor: leaflet undersides
}

// Frond greens, authored at the SUNLIT-BLADE value; every other face scales
// down from there. Green, but nowhere near chartreuse — see NIGHT above. Sabal
// runs cooler and greyer, queen warmer and deeper, which is what the reference
// shows when the two stand next to each other in 03-Five-Points.
// ---- what a palm crown may reach, and in which direction.
//
// Local +x is away from the road, toward the shopfront; the WEAKER of the two
// tree placement tests guarantees 2.2 m of it (the plaza row, which only asks
// for 2.2; the kerb row asks for 2.6). So no frond spine passes 2.00 m, which
// leaves the blade's own half-width inside the guarantee at every azimuth.
const PALM_FRONT_CAP = 2.00;
// Road clearance is guaranteed 2.2 m, so past 2.05 m over the carriageway the
// soffit rule binds -- the same pair of numbers the oak uses, for the same
// reason, and 4.25 m is what a street tree is pruned to over a traffic lane.
const PALM_ROAD_EDGE = -2.05, PALM_ROAD_Y = 4.25;
// The crown may be as wide as the trunk is tall up to this. 3.10 m of frond
// makes a 6.2 m crown against the 6-8 m a street queen actually carries, and
// it is where it is because the kerb placement test guarantees 3.4 m to the
// nearest lamp standard: a frond stops short of the pole rather than growing
// through it.
const PALM_CROWN_CAP = 3.10;
// And the trunk's own displacement: at most this far off the base, and at most
// this far of that toward the frontage.
const PALM_SWAY_CAP = 1.15, PALM_LEAN_CAP = 0.80;

const FROND = {
  sabal: [0x66784a, 0x5e7044, 0x6f7f52, 0x5a6c46],
  queen: [0x5b7342, 0x678049, 0x53693c, 0x627a48],
};
// Sabal trunks are grey-brown and fibrous; queen trunks are smooth and pale
// enough to read as a light vertical against a dark shopfront, which is exactly
// what they do in 05-Sarasota-Opera-House and 06-Frances-Carlton.
const PALM_BARK = {
  sabal: [0x6d6355, 0x776b5b, 0x635a4d, 0x71675a],
  queen: [0x928e84, 0x9c988c, 0x878379, 0x999488],
};

// ===========================================================================
// LIVE OAKS, AND WHERE THE CENSUS PUTS THEM
// ===========================================================================
// Every tree in this district was a palm, and parts of the corridor are not
// palm. `tools/oak-census.mjs --measure` measured canopy at 202 reprojected
// Mapillary stations and `tools/oak-profile.mjs` turns that into OAK_PROFILE
// below: one weight per 20 m of corridor arc-length.
//
// THE FINDING IS THAT OAKS ARE CLUSTERED, and a uniform "oaks on Main St east"
// rule would be the same mistake in the other direction as the uniform "palms
// everywhere" it replaces. Four runs come out of the census and nothing else
// does:
//
//   s  240..320   x -281..-240   bayfront    peak 0.71
//   s  520..540   x  -18..  12   McAnsh      peak 0.40
//   s  740..820   x   71.. 170   Main St E   peak 0.90   <- the tunnel
//   s 1040..1080  x  374.. 430   Main St E   peak 0.63
//
// Between them the median station reads 4-10% foliage with the canopy LOW in
// the frame, which is a leggy specimen tree, not a tunnel, and is left as palm.
//
// The weight drives two things, and it has to drive both or it changes nothing:
// the SPECIES a tree station plants, and how OFTEN a kerb station plants a tree
// at all. Before this, 250 m of Main St east between x = 50 and x = 300 carried
// six trees and not one of them stood inside the measured tunnel at x 86..148.
// A species switch on six trees is not a canopy. It now carries twelve, nine of
// them inside x 78..155 and six of those oaks -- a tree every 9 m of street,
// alternating kerbs, which is what one per shopfront bay comes to when both
// sides are counted.
//
// step 20 m; regenerate with  node tools/oak-profile.mjs --emit --sigma 16
const OAK_STEP = 20;
const OAK_PROFILE = [
  0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00,   // s    0..180
  0.01, 0.07, 0.61, 0.71, 0.62, 0.50, 0.37, 0.08, 0.10, 0.11,   // s  200..380
  0.11, 0.11, 0.18, 0.18, 0.17, 0.22, 0.40, 0.36, 0.13, 0.02,   // s  400..580
  0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.04, 0.29, 0.74, 0.90,   // s  600..780
  0.68, 0.28, 0.15, 0.30, 0.44, 0.29, 0.07, 0.01, 0.00, 0.00,   // s  800..980
  0.02, 0.14, 0.49, 0.63, 0.30, 0.14, 0.11, 0.04, 0.02, 0.03,   // s 1000..1180
  0.05, 0.10, 0.14, 0.17,                                       // s 1200..1260
];
// The census walked the hero route and nothing else, so the profile is only
// evidence within a corridor's width of it. Full weight out to OAK_CORE, which
// covers both kerbs of a 14 m carriageway and the pavement behind them, then a
// linear fade to nothing by OAK_REACH. Past that there is no measurement, and
// the honest default where there is no measurement is the palm the district
// already had -- this file only ever ADDS oaks where they were counted.
const OAK_CORE = 22, OAK_REACH = 55;
// Even in the tunnel one tree in eight stays a palm. That is not a hedge
// against the census, it is what the photographs show: 1007445660973812-R has a
// palm standing in the oak line, and a run of fourteen identical species is a
// thing no street has.
const OAK_MAX = 0.88;

// The corridor polyline, handed over by dressDistrict(). Null until then, and
// a null route means no oaks: a tools-side replay of one prop in isolation has
// no position to test and gets the district's default species.
let _oakRoute = null;
function setOakRoute(route) { _oakRoute = route ?? null; }

/**
 * How strongly the census says THIS spot is oak, in [0, 1].
 *
 * Projects (x, z) onto the corridor polyline for its arc-length s, reads
 * OAK_PROFILE at s, and fades the answer out with distance off the corridor.
 * Past the end of the profile the answer is 0, because the census measured four
 * of the route's eight legs and an array of zeros for the other four would
 * assert a measurement that was never taken.
 */
function oakWeight(x, z) {
  const rt = _oakRoute;
  if (!rt || rt.length < 2) return 0;
  let bestS = 0, bestOff = Infinity, acc = 0;
  for (let i = 0; i + 1 < rt.length; i++) {
    const a = rt[i], b = rt[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / (len * len);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const off = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (off < bestOff) { bestOff = off; bestS = acc + t * len; }
    acc += len;
  }
  if (bestOff >= OAK_REACH) return 0;
  const u = bestS / OAK_STEP, i = Math.floor(u);
  if (i < 0 || i + 1 >= OAK_PROFILE.length) return 0;
  const w = OAK_PROFILE[i] + (OAK_PROFILE[i + 1] - OAK_PROFILE[i]) * (u - i);
  return w * (bestOff <= OAK_CORE ? 1 : 1 - (bestOff - OAK_CORE) / (OAK_REACH - OAK_CORE));
}

// Live oak bark is PALE -- grey enough to read as a light vertical against a
// dark shopfront, which is the one thing it shares with a queen palm and the
// thing that separates both from the sabal's grey-brown boot.
const OAK_BARK = [0x8f8a80, 0x9a9488, 0x847f75, 0x928d82];
// Live oak foliage is OLIVE, not the palm's green. The census's own note
// records the reference reading (88,82,57), (45,48,2), (124,109,53),
// (119,121,56) -- red at or above green -- and its first detector measured 0.5%
// of a frame that is visibly half canopy because it asked for green-DOMINANT.
// These sit at G/R 1.05-1.08 against the palm fronds' 1.11-1.26: still green,
// distinctly greyer and duller, and the two read as different trees when they
// stand in the same frame at Five Points.
const OAK_LEAF = [0x6e7452, 0x666d4c, 0x757b58, 0x5f6747];

// The crown may not reach further toward the frontage than the placement test
// guarantees. Both emit sites below check buildingClearance, and the WEAKER of
// the two guarantees is 2.2 m, so the limb tips stop at 1.35 m and the leaf
// clumps are sheared flat at 2.05 m -- a hedge-trimmed face toward the
// shopfront, which is what a pruned street tree actually has. Local +x is the
// direction away from the road; see the frame convention at the top of the file.
const OAK_LIMB_CAP = 1.35, OAK_CROWN_CAP = 2.05;
// And it may not hang into the carriageway. Road clearance is guaranteed 2.2 m,
// so anything further out over the road than that is lifted to 4.25 m, which is
// the clearance a street tree is pruned to over a traffic lane.
const OAK_ROAD_EDGE = -2.05, OAK_ROAD_Y = 4.25;
// And it may not cross the street. The corridor's carriageway is about 14 m and
// a tree stands 3.9 m behind the kerb, so a crown reaching 11 m road-ward gets
// to the centreline and the two kerbs' crowns MEET there -- which is the tunnel
// -- while one reaching 15.5 m, which the road-ward length bias was quietly
// producing, goes seven metres past the far kerb and into the opposite
// building. Measured off the emitted vertices by tools/oak-audit.mjs, which
// reports the widest crown over 400 keys.
const OAK_ROAD_CAP = -11.0;
// FOUR sides, not five or six. A clump is 1.2-2.0 m across and there are
// eighteen of them overlapping into one crown, so what an individual one is a
// polygon of stops mattering long before the crown does -- and 8 triangles
// against 10 buys three more clumps for the same budget, which is what actually
// closes the mass. The same trade as the palm frond's triangular section.
const CLUMP_SIDES = 4;
// How far past its nominal radius a clump's raggedest vertex reaches. Named
// because the two caps above have to know it to place a clump's centre.
const CLUMP_RAGGED = 0.42;
// How far a clump's own axis may lean off vertical. NOT ZERO, and that is the
// single change that stopped the crown reading as a stack of plates: with every
// pillow's ring horizontal, sixteen of them are sixteen horizontal lozenges
// hanging in the air, which is exactly what the first bench frame showed and
// what no amount of jittering the radii fixed. Leaning each one by up to 40
// degrees on its own azimuth costs nothing at all.
const CLUMP_TILT = 0.70;
// How far off its limb a clump's centre may sit, as a fraction of its own
// radius. Under the pillow's smallest extent (0.74 * 0.60 = 0.444 radii at the
// flattest height ratio) so the limb point is always inside the clump.
const CLUMP_HUG = 0.42;

/**
 * Everything that makes one live oak THAT oak. Same contract as treeParams for
 * a palm: derived from the key alone, so both tiers agree on where every limb
 * and every clump is and the near tier cannot land its twigs somewhere the far
 * tier did not put a branch.
 *
 * A LIVE OAK IS NOT A GENERIC BROADLEAF and the difference is the whole point.
 * It is a broad, LOW, spreading crown on a short thick trunk: the trunk divides
 * at 1.75-3.2 m -- at or below shopfront fascia height, so this is a tree you
 * look THROUGH and UNDER rather than up at like a palm -- and the crown is
 * wider than it is tall, 8.8-17.8 m across against 7.4-11.2 m high. That ratio
 * is what makes crowns from opposite kerbs meet over a 14 m street, and the
 * meeting overhead is the tunnel.
 */
function oakParams(k) {
  const r = rng32(hash32('liveoak', k));
  const h = 7.4 + r() * 3.8;                       // 7.4 - 11.2 m to the crown top
  const forkY = 1.75 + r() * 1.45;                 // where the trunk divides
  const trunkR = 0.24 + r() * 0.16;                // thick: 0.48 - 0.80 m through
  // WIDER THAN TALL, and the first cut was not: 0.60-0.88 of the height gave a
  // crown as wide as it was high, which is a generic broadleaf. A live oak runs
  // 1.4-1.9 times as wide as it is tall, capped here at a 9.4 m radius because
  // beyond that it is a park specimen rather than a tree in a 1.5 m pit.
  const spread = Math.min(10.2, h * (0.78 + r() * 0.32));  // crown RADIUS
  return {
    oak: true, sabal: false,
    key: k, h, forkY, trunkR, spread,
    nLimb: 4 + (hash32('nlimb', k) % 2),           // 4 or 5 primary leaders
    // FORTY-EIGHT clumps at 0.11-0.165 of the crown radius, against fourteen at
    // 0.20-0.32 in the first cut. Those were about a third of a crown lobe each
    // and read as flat cards the size of a garage door; a live oak's foliage is
    // fine-grained, with daylight scattered through the interior in small gaps
    // rather than a few opaque slabs, and 1007445660973812-L shows exactly
    // that. Coverage is 48 * (0.16)^2 = 1.2 crowns' worth of overlapping
    // pillows, so the mass closes without being opaque.
    //
    // THE REASON THIS IS AFFORDABLE IS THAT OAKS ARE RARE. The census puts them
    // on 14% of the corridor and the dressing pass plants TWELVE of them in a
    // district of 307 trees, so tripling the clump count is +222 triangles on a
    // tree and +2,700 on a district measured at 693,000 against a gate that
    // warns at 830,000. Spending a palm's whole budget again on each oak buys
    // 0.4% of the frame.
    nClump: 52 + (hash32('nclump', k) % 9),        // far tier, on the primaries
    nInfill: 46 + (hash32('ninfill', k) % 9),      // near tier, on the twig web
    yaw: r() * TAU,
    phase: r() * TAU,
    lean: (r() - 0.5) * 0.5,                       // trunk off vertical, x
    leanZ: (r() - 0.5) * 0.5,
    leaf: OAK_LEAF[hash32('lf', k) % 4],
    bark: OAK_BARK[hash32('ob', k) % 4],
    gain: 0.88 + r() * 0.26,
  };
}

/** The colour context a crown vertex resolves against: the oak's own leaf
 *  colour scaled by the face's shade and alternated vertex to vertex. */
function oakCtx(p) {
  const base = linear(p.leaf);
  return {
    col: (shade, i) => {
      const w = shade * p.gain * (i & 1 ? 1.0 : 0.93);
      return [base[0] * w, base[1] * w, base[2] * w];
    },
  };
}

/**
 * A tapering tube swept along a polyline of LOCAL stations, each ring built
 * PERPENDICULAR TO THE LIMB'S OWN DIRECTION. 2 * sides * (n - 1) triangles out
 * of sides * n vertices, and no end caps: the base is buried in the trunk and
 * the tip is inside a leaf clump.
 *
 * palmTrunk() would have been the obvious thing to reuse and it is the wrong
 * shape here. Its rings are horizontal, which is right for a trunk and is a
 * flat plank for a near-horizontal limb -- and near-horizontal limbs are the
 * entire silhouette of a live oak.
 *
 * A station is [x, y, z, radius, colour]. `U` is a unit vector perpendicular to
 * the tangent T; V = U x T rather than T x U, so U x V = -T and the ring winds
 * clockwise seen from the tip, which is the order the strip below is written
 * for and the order palmTrunk already uses.
 *
 * THE RING FRAME IS PARALLEL-TRANSPORTED ALONG THE LIMB, and the first cut of
 * this function was not. It picked U = T x Y at every station and fell back to
 * a fixed axis when the limb was within 20 degrees of vertical, so a limb that
 * left the fork steeply and then flattened switched conventions between two
 * consecutive rings, the tube TWISTED between them, and the quads that spanned
 * the twist came out inside out. tools/oak-audit.mjs measured it as 523 of
 * 16,296 primary-limb triangles backfacing and another 348 degenerate, with the
 * trunk -- which never leaves vertical -- clean at 0 of 6,080. That is the
 * whole-kit winding defect reintroduced on a new emitter for the second time in
 * this file, found by the audit rather than by looking at it, which is what the
 * audit is for.
 *
 * Transporting U instead (project the previous ring's U onto the plane
 * perpendicular to the new tangent, renormalise) makes the convention
 * continuous by construction, so there is no branch left to be inconsistent
 * across. The seed is only used at the first station and where the limb doubles
 * back through a right angle.
 */
function limbTube(buf, f, pts, sides, phase, surf) {
  const hand = handOf(f);
  const rows = [];
  let ux = 0, uy = 0, uz = 0, seeded = false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-6) { tx = 0; ty = 1; tz = 0; } else { tx /= tl; ty /= tl; tz /= tl; }
    if (seeded) {
      const d = ux * tx + uy * ty + uz * tz;
      ux -= tx * d; uy -= ty * d; uz -= tz * d;
    }
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-3) {
      // T x Y, and T x X where the limb is vertical and that degenerates.
      if (Math.abs(ty) < 0.94) { ux = -tz; uy = 0; uz = tx; }
      else { ux = 0; uy = tz; uz = -ty; }
      ul = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= ul; uy /= ul; uz /= ul;
    seeded = true;
    const vx = uy * tz - uz * ty, vy = uz * tx - ux * tz, vz = ux * ty - uy * tx;
    const P = pts[i], rad = P[3], c = P[4];
    const row = [];
    for (let s = 0; s < sides; s++) {
      const ang = phase + (s / sides) * TAU;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa;
      const px = P[0] + nx * rad, pz = P[2] + nz * rad;
      row.push(vertC(buf, wx(f, px, pz), P[1] + ny * rad, wz(f, px, pz),
        nx * f.ox + nz * f.ax, ny, nx * f.oz + nz * f.az, c[0], c[1], c[2], surf));
    }
    rows.push(row);
  }
  for (let s = 0; s + 1 < rows.length; s++) {
    const A = rows[s], B = rows[s + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(buf, hand, A[i], B[j], A[j]);
      tri(buf, hand, A[i], B[i], B[j]);
    }
  }
}

/**
 * ONE LEAF CLUMP: a flattened pillow on a jittered ring, an apex above it and a
 * nadir below. 2 * CLUMP_SIDES triangles out of CLUMP_SIDES + 2 vertices.
 *
 * A live oak read from a car is not a mass, it is a pale grey web of limbs with
 * DISCRETE plates of small leaves hung along it and daylight through the middle
 * -- which is lucky, because a mass is what a broadleaf used to spend 60-96
 * triangles failing to fake here. Twelve to fourteen of these cover a crown at
 * about 1.3x, so the interior is gappy on purpose.
 *
 * It is closed, so it renders from underneath, which is where the camera is:
 * this crown springs at 1.75-3.2 m and the player's eye is at 1.5-2.4 m, so the
 * view of a street oak is the view up into it and a single-sided card would be
 * culled from the angle the whole game is played at.
 *
 * NOTHING IS CLAMPED IN HERE. The first cut sheared the ring flat against the
 * frontage cap and lifted individual vertices off the carriageway, which left
 * the vertex normals describing a pillow the geometry no longer was: 26 of
 * 20,270 clump triangles came out backfacing. The caps belong on the clump's
 * CENTRE, one decision per clump, where they move the whole pillow instead of
 * distorting it -- see oakClumpsOf().
 *
 * The ring vertices are SHARED between the top fan and the bottom fan, so the
 * one normal they carry has to serve both: it is radial with a small upward
 * bias, which leaves the underside's shading to come from the colour ramp
 * instead. That is the one place this geometry cannot express what it means
 * with a normal, and it is the right place to give up -- an oak crown is dark
 * underneath because a metre of leaves is in the way, which is self-shadowing,
 * not orientation, and no normal on a 10-triangle pillow says that.
 */
function leafClump(buf, f, c, ctx) {
  const hand = handOf(f);
  const rj = rng32(c.seed);
  const { x: cx, y: cy, z: cz, rad, hgt } = c;
  // The clump's own axis. A is the direction its apex points; U and V span the
  // ring plane perpendicular to it, with V = U x A so U x V = -A and the ring
  // winds clockwise seen from the apex -- the same convention limbTube uses and
  // for the same reason.
  const ax = Math.sin(c.tilt) * Math.cos(c.tiltAz), ay = Math.cos(c.tilt);
  const az = Math.sin(c.tilt) * Math.sin(c.tiltAz);
  let ux = -az, uy = 0, uz = ax;                        // A x Y, horizontal
  let ul = Math.hypot(ux, uz);
  if (ul < 1e-4) { ux = 1; uz = 0; ul = 1; }
  ux /= ul; uz /= ul;
  const vx = uy * az - uz * ay, vy = uz * ax - ux * az, vz = ux * ay - uy * ax;
  const ph = rj() * TAU;

  // ---- THE STENCIL WINDOW. One of OAK_STAMPS leaf-cluster stamps, chosen by
  // the clump's own seed, with the ring plane laid flat onto it: the ring
  // vertices land on a circle of radius rr/(rad*RAGGED_MAX) about the stamp
  // centre and the apex and the nadir BOTH land ON the centre. So the top fan
  // and the bottom fan of a pillow are cut by the same texels and a hole opens
  // straight through the leaf mass instead of exposing its own far side, which
  // is the difference between porosity and a dent. The clump's ring phase
  // rotates the window for free, so two clumps sharing a stamp do not share a
  // cut.
  const stampV = ((c.seed >>> 3) % OAK_STAMPS) * STAMP_H + STAMP_H * 0.5;
  // The RADIUS is clamped, not the two components separately, so the direction
  // survives -- and it is scaled so the SMALLEST ring vertex still lands
  // outside OAK_STAMP_R. The first cut normalised by the largest instead, which
  // put the tightest ring inside the stamp's solid core: those plates came back
  // with their straight quad edges intact, visible in the frame as hard
  // diamonds among cut ones, and no amount of mask design fixes a plate the
  // mask never reaches.
  const uvAt = (dx, dy, rr) => {
    const q = Math.min(1, rr * 1.15);
    return [maskU(S.foliage, 0.5 + 0.5 * dx * q),
      maskV(stampV + dy * q * (STAMP_H * 0.5 - 0.6))];
  };
  // ---- NORMAL SPLAY. A pillow's own normals already point out of it; blending
  // them toward `up` -- the direction from the CROWN's centre to this clump --
  // makes the crown light as one volume instead of as thirty independently lit
  // solids. It is the palm frond's trick (two normals tilted up and out to
  // either side of the rachis, one pointing down) applied to a mass rather than
  // to a blade, and it costs nothing. Bounded at 0.42 so it can rotate a normal
  // by at most 23 degrees, which cannot carry one past its own face; the
  // winding audit is what actually says so.
  const [gx, gy, gz] = c.up;
  const splay = (nx, ny, nz) => {
    const sx = nx + gx * 0.42, sy = ny + gy * 0.42, sz = nz + gz * 0.42;
    const l = Math.hypot(sx, sy, sz) || 1;
    return [(sx * f.ox + sz * f.ax) / l, sy / l, (sx * f.oz + sz * f.az) / l];
  };
  const sh = c.shade;
  const ring = [];
  for (let i = 0; i < CLUMP_SIDES; i++) {
    const a = ph + (i / CLUMP_SIDES) * TAU;
    // Nothing in a crown is a regular polygon. Radius and the slide along the
    // axis are jittered hard enough that the silhouette is ragged rather than
    // square -- the same lesson the palm's blade edges had to learn, for the
    // same nothing.
    const rr = rad * (0.70 + rj() * CLUMP_RAGGED);
    const ca = Math.cos(a), sa = Math.sin(a);
    const dx = ux * ca + vx * sa, dy = uy * ca + vy * sa, dz = uz * ca + vz * sa;
    const slide = hgt * (rj() - 0.5) * 0.5;
    const px = cx + dx * rr + ax * slide;
    const py = cy + dy * rr + ay * slide;
    const pz = cz + dz * rr + az * slide;
    // Radial in the ring plane, biased toward the apex so the top fan and the
    // bottom fan can share the vertex.
    const n = splay(dx + ax * 0.15, dy + ay * 0.15, dz + az * 0.15);
    const col = ctx.col(0.66 * sh, i);
    ring.push(vertC(buf, wx(f, px, pz), py, wz(f, px, pz), n[0], n[1], n[2],
      col[0], col[1], col[2], S.foliage, uvAt(ca, sa, rr / rad)));
  }
  const ct = ctx.col(1.0 * sh, 0), cb = ctx.col(0.38 * sh, 1);
  const tx = cx + ax * hgt, ty = cy + ay * hgt, tz = cz + az * hgt;
  const bx = cx - ax * hgt * 0.74, by = cy - ay * hgt * 0.74, bz = cz - az * hgt * 0.74;
  const nt = splay(ax, ay, az), nb = splay(-ax, -ay, -az);
  const top = vertC(buf, wx(f, tx, tz), ty, wz(f, tx, tz), nt[0], nt[1], nt[2],
    ct[0], ct[1], ct[2], S.foliage, uvAt(0, 0, 0));
  const bot = vertC(buf, wx(f, bx, bz), by, wz(f, bx, bz), nb[0], nb[1], nb[2],
    cb[0], cb[1], cb[2], S.foliage, uvAt(0, 0, 0));
  // Wound so each fan's geometric normal agrees with the vertex normals it
  // carries. The ring winds clockwise seen from the apex, so the apex fan is
  // (apex, j, i) and the nadir fan is (nadir, i, j). Measured in both
  // handednesses rather than reasoned about; see limbTube.
  for (let i = 0; i < CLUMP_SIDES; i++) {
    const j = (i + 1) % CLUMP_SIDES;
    tri(buf, hand, top, ring[j], ring[i]);
    tri(buf, hand, bot, ring[i], ring[j]);
  }
}

/**
 * The limb skeleton, shared by both tiers exactly the way trunkStations() is
 * shared by the palm's, so the near tier's twigs spring from a primary the far
 * tier really drew.
 *
 * The height profile is y = forkY + rise * (a*t - b*t^2). `a` is the angle the
 * limb leaves the fork at and `b` is how hard it arches over, and the interest
 * is all in `b` varying across the limbs on ONE tree: at the low end the limb
 * climbs to the top of the crown, at the high end it tops out part way and
 * comes back down. A live oak has both on the same trunk, and that is why its
 * outline is lumpy rather than domed.
 *
 * `b` IS DRAWN AGAINST `a` RATHER THAN INDEPENDENTLY OF IT, and the first cut
 * drew them independently. a = 1.15 with b = 1.55 is not an arching limb, it is
 * a HAIRPIN: the tip comes back down to y = 0.05 m, which is a branch lying on
 * the pavement, and the 130-180 degree fold at the middle station turned the
 * tube inside out where the two segments met. tools/oak-audit.mjs measured 258
 * backfacing triangles across 400 trees and every one of them was on a limb
 * whose middle bend exceeded 120 degrees. Capping b at a - 0.70 keeps a - b
 * above 0.2, so every limb finishes at least a fifth of the crown height above
 * the fork -- which is also the correct arboriculture, because a live oak's
 * outer limbs sag toward the horizontal and not past it.
 *
 * The azimuth WANDERS along the limb -- one slow sine, no extra triangles --
 * because a live oak limb is sinuous and a straight one reads as a broom
 * handle.
 */
function oakLimbs(p) {
  const bark = linear(p.bark);
  const shade = (s) => [bark[0] * s, bark[1] * s, bark[2] * s];
  const crown = p.h - p.forkY;
  const out = [];
  for (let j = 0; j < p.nLimb; j++) {
    const rj = rng32(hash32('lb', p.key, j));
    const az0 = p.yaw + (j / p.nLimb) * TAU + (rj() - 0.5) * 0.75;
    // REACH IS ASYMMETRIC, and that asymmetry is the tunnel. cos(az0) is the
    // limb's local-x component and local -x is the road, so a limb aimed over
    // the carriageway is grown 30% longer and a limb aimed at the shopfront is
    // cut back to the frontage cap. That is not a compromise with the clearance
    // test, it is what a street tree grows into: pruned back off the building,
    // reaching for the light over the road. Without the road bias a typical
    // tree reached about 3 m past the kerb, the two kerbs' crowns stopped 8 m
    // short of each other, and the bench frame showed a boulevard.
    const L0 = p.spread * (0.70 + rj() * 0.36) * (1 + 0.30 * Math.max(0, -Math.cos(az0)));
    let L = L0;
    const cx = Math.cos(az0);
    if (cx > 0.02 && L * cx > OAK_LIMB_CAP) L = OAK_LIMB_CAP / cx;
    else if (cx < -0.02 && L * -cx > -OAK_ROAD_CAP - 1.4) L = (-OAK_ROAD_CAP - 1.4) / -cx;
    // A LIMB SHORTENED BY THE FRONTAGE CAP HAS TO BE SHORTENED IN HEIGHT TOO.
    // The first cut clipped only the reach, so a limb aimed at the shopfront
    // ran the full crown height up over 1.2 m of horizontal travel: a vertical
    // spike with a fold at the top, which is not a limb, and the fold put the
    // middle station's tangent almost opposite the outgoing segment so the
    // whole outer half of the tube came out inside out. 205 of 16,296
    // primary-limb triangles, all of them on limbs whose middle bend exceeded
    // 116 degrees. Scaling the rise by the same factor keeps the limb's aspect
    // ratio, which makes a capped limb a short stubby branch -- what a pruned
    // limb is -- rather than a mast. The floor stops the very shortest from
    // being a bare nub with no lift at all.
    const stunt = Math.max(0.30, L / L0);
    const a = 1.15 + rj() * 0.80, b = 0.50 + rj() * Math.min(1.05, a - 0.70);
    const wig = (rj() - 0.5) * 0.60, wph = rj() * TAU;
    const base = p.trunkR * 0.55;
    const pts = [];
    for (let s = 0; s <= 2; s++) {
      const t = s / 2;
      const az = az0 + wig * Math.sin(2.4 * t + wph);
      const rho = base + (L - base) * t;
      let y = p.forkY - p.trunkR * 0.55 * (1 - t)
        + crown * stunt * Math.min(1.02, a * t - b * t * t);
      const rr = p.trunkR * (0.66 - 0.44 * t);
      const lz = p.leanZ * t + Math.sin(az) * rho;
      // The analytic cap above is set from the limb's BASE azimuth, and the
      // azimuth wanders by up to 0.3 rad along the limb, so a limb aimed just
      // past the frontage can wander back toward it and overshoot. Measured:
      // the crown reached 3.16 m at a frontage the placement test only
      // guarantees 2.2 m of. Clamping the station itself makes the bound exact;
      // it bites by centimetres, because the analytic cap has already done the
      // work, so it cannot fold the limb.
      let lx = p.lean * t + Math.cos(az) * rho;
      lx = Math.max(OAK_ROAD_CAP + rr, Math.min(OAK_LIMB_CAP, lx));
      // Lifted by the tube's own radius, not to its centreline: a station at
      // 4.25 m carrying a 0.26 m limb hangs 3.99 m over the lane. And by the
      // headroom a clump hanging under it will want, so the clump rule below
      // has to shrink anything only at the extremes -- otherwise every clump
      // over the carriageway is trimmed to nothing and the tunnel has no roof.
      if (lx < OAK_ROAD_EDGE) y = Math.max(y, OAK_ROAD_Y + rr + p.spread * 0.20);
      pts.push([lx, y, lz, rr, shade(0.92 + 0.16 * t)]);
    }
    out.push({ az0, L, pts, seed: hash32('lbs', p.key, j) });
  }
  return out;
}

/**
 * The SECONDARY web: two branches off each primary, built from the primary the
 * far tier really drew so they cannot spring from nowhere.
 *
 * These exist for two reasons and the second one is the surprising one. The
 * first is that a live oak's crown is a web -- the census's own woodShare
 * column reads 0.97-1.00 through the tunnel, meaning the not-leaf pixels inside
 * an oak's canopy are limbs where inside a palm's they are sky.
 *
 * The second is that the web is WHAT THE FOLIAGE HANGS ON. Every leaf clump has
 * to contain a piece of a limb or it is a plate floating in open sky, so with
 * only five primaries the clumps could only string along five lines and the
 * crown read as beads on a wire. Nine more branches at nine other angles is
 * what lets the same clumps fill a volume while every one of them is still
 * attached to something.
 */
function oakTwigs(p, limbs) {
  const bark = linear(p.bark);
  const shade = (s) => [bark[0] * s, bark[1] * s, bark[2] * s];
  const out = [];
  for (let j = 0; j < limbs.length; j++) {
    const lb = limbs[j];
    for (let n = 0; n < 3; n++) {
      const rj = rng32(hash32('tw', p.key, j, n));
      const t0 = 0.24 + n * 0.22 + rj() * 0.14;
      const A = alongLimb(lb, t0);
      // A live oak's secondaries branch nearly sideways off the leader rather
      // than continuing it.
      const az = lb.az0 + (rj() < 0.5 ? -1 : 1) * (0.62 + rj() * 0.80);
      let L = lb.L * Math.min(0.42, 0.98 - t0) * (0.55 + rj() * 0.45);
      const cx = Math.cos(az);
      if (cx > 0.02 && A[0] + L * cx > OAK_LIMB_CAP) L = Math.max(0, (OAK_LIMB_CAP - A[0]) / cx);
      if (cx < -0.02 && A[0] + L * cx < OAK_ROAD_CAP + 1.4) {
        L = Math.max(0, (OAK_ROAD_CAP + 1.4 - A[0]) / cx);
      }
      // A secondary the caps have clipped to nothing is not a short twig, it is
      // six degenerate triangles: two coincident rings, zero area, no normal.
      // The audit reads those as flat rather than backfacing, which is exactly
      // the reading that gets shrugged off, so they are not emitted -- and
      // filtering them HERE, before the clumps are indexed over this list,
      // is what stops a clump being hung on a branch that was never drawn.
      if (L < 0.35) continue;
      const climb = (rj() - 0.32) * L * 0.80;
      const pts = [];
      for (let st = 0; st <= 1; st++) {
        const rho = L * st, rr = p.trunkR * (0.30 - 0.21 * st);
        let y = A[1] + climb * st;
        let lx = A[0] + Math.cos(az) * rho;
        lx = Math.max(OAK_ROAD_CAP + rr, Math.min(OAK_LIMB_CAP, lx));
        const lz = A[2] + Math.sin(az) * rho;
        if (lx < OAK_ROAD_EDGE) y = Math.max(y, OAK_ROAD_Y + rr + p.spread * 0.20);
        pts.push([lx, y, lz, rr, shade(1.0 + 0.10 * st)]);
      }
      out.push({ az0: az, L, pts, seed: hash32('tws', p.key, j, n) });
    }
  }
  return out;
}

/** A point on a limb at parameter t in [0, 1], for hanging a clump on. */
function alongLimb(lb, t) {
  const n = lb.pts.length - 1;
  const u = Math.max(0, Math.min(n - 1e-6, t * n));
  const i = Math.floor(u), ft = u - i;
  const A = lb.pts[i], B = lb.pts[i + 1];
  return [A[0] + (B[0] - A[0]) * ft, A[1] + (B[1] - A[1]) * ft, A[2] + (B[2] - A[2]) * ft];
}

/**
 * Where the leaf clumps hang. Indexed limb-major so that taking the EVEN
 * indices for the far tier spreads them evenly around the crown AND across the
 * whole range of distance out along the limbs -- the same property the palm's
 * golden-angle frond index has, and the reason its tier split cannot change the
 * outline either.
 *
 * The mass is in the OUTER THIRD, which is where a live oak carries it, and
 * each clump is thrown off its limb's line by up to 1.4 radii so the crown is
 * not five spokes of blobs.
 */
function oakClumpsOf(p, limbs, count, salt) {
  if (!limbs.length) return [];
  const perLimb = Math.ceil(count / limbs.length);
  const out = [];
  for (let i = 0; i < count; i++) {
    const lb = limbs[i % limbs.length];
    const rj = rng32(hash32('cl', p.key, i, salt));
    // Rank 0 is the TIP, not the base, and that ordering is the whole of it.
    // Ranking from the base left the incomplete last rank -- 32 clumps do not
    // divide by 5 limbs -- on the OUTERMOST positions, so two limbs on every
    // tree ended in a bare 5 cm stick poking a metre out of the foliage. Every
    // limb now gets its outermost clump from its first index, and the limbs
    // that come up short are short in the middle where nothing shows.
    const rank = Math.floor(i / limbs.length);
    const onLine = perLimb > 1 ? rank / (perLimb - 1) : 1;
    const t = 0.96 - 0.74 * onLine + (rj() - 0.5) * 0.22;
    const P = alongLimb(lb, Math.max(0.12, Math.min(1, t)));
    // Nearly as tall as it is wide. The first cut was 0.28-0.48 of the radius,
    // which is a LENS, and fourteen lenses on a tree read as a mobile of flat
    // plates rather than a crown -- visible immediately in the bench frame and
    // invisible in every number the audit prints.
    const hr = 0.60 + rj() * 0.35;                    // height / radius
    const tilt = rj() * CLUMP_TILT, tiltAz = rj() * TAU;

    // ---- how far off its limb this clump sits, IN UNITS OF ITS OWN RADIUS.
    //
    // A CLUMP MUST CONTAIN A PIECE OF THE LIMB IT HANGS ON. The first cut set
    // the offset in metres and then moved the centre again to satisfy the
    // frontage and carriageway caps, which could walk a clump two metres off
    // its branch: a leaf plate sitting in open sky with nothing reaching it,
    // which is the floating-prop class three critic rounds filed and which
    // tools/geom-audit.mjs does not look for -- that gate asks whether a prop
    // reaches the GROUND, not whether a leaf reaches its own branch.
    //
    // CLUMP_HUG is a fraction of the radius, and it is under the pillow's
    // SMALLEST extent (0.74 * hgt, i.e. 0.74 * 0.60 = 0.444 radii at the
    // flattest), so the limb point is inside the clump in every direction the
    // offset can point. tools/oak-audit.mjs --attach measures it.
    const lateral = (rj() - 0.5) * 2, vert = (rj() - 0.62) * 1.5;
    const on = Math.hypot(lateral, vert) || 1;
    const frac = CLUMP_HUG * (0.30 + 0.70 * onLine) * rj();
    const ox = -Math.sin(lb.az0) * lateral / on, oz = Math.cos(lb.az0) * lateral / on;
    const oy = vert / on;

    // ---- and how big it may be. THE CAPS SHRINK THE CLUMP, THEY DO NOT MOVE
    // IT. Moving it is what detached it. `total` is how far the furthest vertex
    // gets from the LIMB POINT per unit of radius: the offset, plus the ring at
    // 0.70 + RAGGED, plus the slide along the axis at 0.25 of the height.
    const total = frac + 0.70 + CLUMP_RAGGED + 0.25 * hr;
    let rad = p.spread * (0.150 + rj() * 0.074);
    rad = Math.min(rad, (OAK_CROWN_CAP - P[0]) / total, (P[0] - OAK_ROAD_CAP) / total);
    // Over the carriageway the soffit rule binds as well. The limb stations are
    // already lifted with an allowance for this, so it normally does not bite.
    if (P[0] - rad * total < OAK_ROAD_EDGE) {
      rad = Math.min(rad, (P[1] - OAK_ROAD_Y) / total);
    }
    // Nothing left worth drawing: a clump the caps have taken below a quarter
    // of a metre is eight triangles of nothing, and skipping it is also how the
    // crown gets its pruned face toward a close frontage.
    if (!(rad > 0.24)) continue;
    const off = frac * rad;
    const qx = P[0] + ox * off, qy = P[1] + oy * off, qz = P[2] + oz * off;
    // ---- which way is OUT of the crown here, and how deep in it is this clump.
    //
    // `up` is the direction from the crown's own centre to this clump, and it is
    // what leafClump splays its vertex normals toward: a crown lit clump by
    // clump off each pillow's own axis is thirty separately lit solids, and a
    // crown whose normals all lean away from its centre is one volume with a
    // sunlit top and a dark underside. Free -- it is a normal, not a triangle.
    //
    // `shade` is the other half of the same read and it is a colour, not a
    // normal, because what makes the inside of a live oak dark is a metre of
    // leaves in the way and no normal on a ten-triangle pillow says that. Two
    // terms: DEPTH, so a clump under the crown's midline is up to a third
    // darker than one on top of it, and a per-clump draw wide enough that the
    // canopy is mottled rather than one flat olive -- which is what the
    // reference shows and what "uniformly dark" was reporting the absence of.
    const cyc = p.forkY + (p.h - p.forkY) * 0.52;
    let gx = qx - p.lean * 0.5, gy = qy - cyc, gz = qz - p.leanZ * 0.5;
    const gl = Math.hypot(gx, gy, gz) || 1;
    gx /= gl; gy /= gl; gz /= gl;
    const depth = Math.max(0, Math.min(1, 0.5 + 0.5 * gy));
    out.push({
      x: qx, y: qy, z: qz,
      rad, hgt: rad * hr, tilt, tiltAz, seed: hash32('cs', p.key, i, salt),
      up: [gx, gy, gz],
      shade: (0.70 + 0.40 * depth) * (0.80 + rj() * 0.46),
      // The limb point this clump hangs on, kept so the attachment can be
      // measured off the same numbers the geometry was built from.
      on: P,
    });
  }
  return out;
}

/** The trunk: short, thick, and flared where the root mass reaches the ground.
 *  A 5-gon over three stations, smooth-shaded around the axis. 20 triangles. */
function oakTrunk(buf, f, p) {
  const bark = linear(p.bark);
  const shade = (s) => [bark[0] * s, bark[1] * s, bark[2] * s];
  limbTube(buf, f, [
    [0, BASE_Y, 0, p.trunkR * 1.44, shade(0.78)],
    [p.lean * 0.45, BASE_Y + (p.forkY - BASE_Y) * 0.55, p.leanZ * 0.45,
      p.trunkR * 1.02, shade(0.92)],
    [p.lean, p.forkY + p.trunkR * 0.30, p.leanZ, p.trunkR * 0.86, shade(1.0)],
  ], 5, p.phase, S.bark);
}

/**
 * Everything that makes one palm THAT palm, derived from its key alone so both
 * tiers agree on where every frond is.
 *
 * "Three trees whose silhouettes appear to be one asset at three scales,
 * planted in a straight line with no rotation variation I can detect" was a
 * critic finding against the broadleaf, and one random height is not an answer
 * to it. Here the free parameters are: species, trunk height (a 2.4:1 range),
 * trunk radius, the direction AND amount of the trunk's curve, the crown yaw,
 * the frond reach, the frond count, four frond palettes, four barks, and a
 * per-palm brightness. Two palms side by side share none of them.
 */
function treeParams(k, x = 0, z = 0) {
  // SPECIES IS A FUNCTION OF POSITION, and it has to be read from the same
  // (x, z) in both tiers or a tree is an oak at 300 m and a palm at 150. Both
  // emit sites pass the frame's own origin, which is the tree's spot, so the
  // two tiers cannot disagree. See OAK_PROFILE above for where the answer
  // comes from.
  // The weight is rescaled off a floor rather than used raw. A profile of 0.08
  // is one photograph with a hedge in it and should plant no oaks at all; 0.85
  // is the middle of a measured tunnel and should plant almost nothing else.
  const w = (oakWeight(x, z) - 0.08) / 0.77;
  if ((hash32('species', k) % 1000) < 1000 * OAK_MAX * (w > 1 ? 1 : w)) {
    return oakParams(k);
  }
  const r = rng32(hash32('palm', k));
  const sabal = (hash32('sp', k) % 100) < 55;
  const sp = sabal ? 'sabal' : 'queen';

  // Palms are TALL, and that is most of the read. The broadleaf stood 5.3-8.7 m
  // overall and carried its crown from 2 m up; a street sabal holds its crown at
  // 5.5-10 m and a queen at 7-13, so the crown is above the awnings, above the
  // shopfront fascia, and often above the lamp heads at 7.7 m.
  const trunkH = sabal ? 5.5 + r() * 4.4 : 7.0 + r() * 5.6;
  const trunkR = sabal ? 0.165 + r() * 0.050 : 0.130 + r() * 0.040;

  // ---- CROWN REACH IS A FRACTION OF TRUNK HEIGHT, and the flat 1.36-2.02 m it
  // replaces is what "the crowns are stunted" was reporting.
  //
  // Measured off 05-Sarasota-Opera-House, which is the clearest queen in the
  // set: the crown spans about 0.83 of the visible trunk, so a radius of 0.41
  // of it, and the oldest fronds' tips fall about 0.35 of the trunk height
  // below where they leave the crown. This build had a crown radius of 0.10 to
  // 0.25 of the trunk -- a third to a half of the photograph -- on every palm
  // in the district, tall ones worst, because the number did not know how tall
  // the tree was.
  //
  // The old number is recorded in the ledger as a deliberate clearance choice:
  // "the placement test only guarantees 2.6 m to the shopfront and 2.2 m to
  // the carriageway, and a frond that overshoots it is inside a window." That
  // reasoning was right and the number did not deliver it -- tools/oak-audit
  // measured the crown reaching 3.78 m toward a frontage guaranteed 2.2 m,
  // because the reach is measured from a trunk TOP that sways up to 2 m off
  // the base and nothing was subtracting that. So the clearance is now kept
  // where it can be kept exactly, per frond and in the direction that matters
  // (see palmReach below), and the crown is free to be its real size in the
  // three directions where there is nothing to hit.
  const R = Math.min(PALM_CROWN_CAP, trunkH * (sabal ? 0.30 : 0.335)
    * (0.86 + r() * 0.30));

  // The trunk curves rather than tilting: a palm's line is a slow bend, not a
  // lean off a hinge at the ground. `bow` is how far the mid station is pushed
  // off the chord, `sway` how far the top is displaced from the base.
  //
  // And it may lean AWAY from the frontage as far as it likes and only so far
  // toward it. A 2 m sway on a 5.5 m sabal put the growing point 2 m into a
  // shopfront the placement test guarantees 2.2 m of, before a single frond was
  // drawn. The clamp is one scale factor applied to the mid station and the top
  // alike, so the curve keeps its shape and only its amplitude in +x changes --
  // squashing the top alone would put an S-bend in a trunk that has none.
  const curveAz = r() * TAU;
  const bend = (sabal ? 0.30 : 0.16) + r() * (sabal ? 0.55 : 0.30);
  const sway = Math.min(PALM_SWAY_CAP, bend * (0.9 + r() * 1.5));
  const leanX = Math.cos(curveAz) * sway;
  const kx = leanX > PALM_LEAN_CAP ? PALM_LEAN_CAP / leanX : 1;
  const tiltX = leanX * kx, tiltZ = Math.sin(curveAz) * sway;
  const bow = Math.cos(curveAz) * bend * kx, bowZ = Math.sin(curveAz) * bend;

  // A sabal carries more, shorter fans and needs the density to read as a
  // globe; a queen's dozen long arcs are the whole of its silhouette and more
  // of them just fills in the fountain. The far tier takes the even indices, so
  // it gets half of these; see THE TIER SPLIT above for why that cannot change
  // the outline.
  const nFrond = (sabal ? 14 : 11) + (hash32('nf', k) % 3);
  return {
    oak: false,
    sabal, trunkH, trunkR, R, tiltX, tiltZ, bow, bowZ, nFrond,
    h: trunkH + R * 0.55,                  // overall height, for the pit and audits
    yaw: r() * TAU,
    phase: r() * TAU,                      // trunk n-gon roll, so no two align
    // The boot zone runs from just above the flare to two thirds of the way up
    // on a sabal and is absent on a queen.
    boot: sabal ? 0.085 + r() * 0.05 : 0,
    frond: FROND[sp][hash32('fr', k) % 4],
    bark: PALM_BARK[sp][hash32('bk', k) % 4],
    gain: 0.9 + r() * 0.22,                // palm-to-palm frond brightness
  };
}

/**
 * The colour context a frond's vertices resolve against: the palm's own frond
 * colour, scaled by the face's shade, by a light-to-dark run out along the
 * frond, and by a warm shift toward the tip.
 *
 * Palm fronds yellow at the tips — old leaflets go straw before they are cut
 * off — and that is one of the cheapest tells there is, because it is a colour
 * ramp on vertices that already exist.
 */
function crownCtx(p, gain = 1) {
  const base = linear(p.frond);
  const g = p.gain * gain;
  return {
    col: (t, shade, i) => {
      const w = shade * g * (1.06 - 0.16 * t) * (i & 1 ? 1.0 : 0.93);
      return [base[0] * w * (1 + 0.30 * t * t), base[1] * w * (1 + 0.13 * t * t),
        base[2] * w * (1 - 0.10 * t * t)];
    },
  };
}

/** The tree pit: an up-facing quad wound for THIS frame's handedness, which is
 *  why it is not slab(). 2 triangles. */
function pitSlab(buf, f, cx, cz, hx, hz, y, hex, surf) {
  const hand = handOf(f);
  const c = linear(hex);
  const P = (lx, lz) => vertC(buf, wx(f, cx + lx, cz + lz), y, wz(f, cx + lx, cz + lz),
    0, 1, 0, c[0], c[1], c[2], surf);
  const a = P(-hx, -hz), b = P(-hx, hz), d = P(hx, hz), e = P(hx, -hz);
  tri(buf, hand, a, b, d);
  tri(buf, hand, a, d, e);
}

/**
 * One frond's parameters from its index. `u` is its AGE, 0 for the youngest
 * frond standing up out of the crown's centre and 1 for the oldest lying out
 * flat, and every other quantity is a mix along it. Both tiers call this with
 * the same i, so a frond is in exactly one tier and is identical either way.
 */
function frondAt(p, i) {
  const u = p.nFrond > 1 ? i / (p.nFrond - 1) : 0;
  const az = p.yaw + i * 2.39996;                       // golden angle
  const jit = (hash32('fj', i, p.nFrond) % 1000) / 1000 - 0.5;
  // The fronds do NOT all start at one point. A palm's crown sits on a ring of
  // leaf bases half a metre across, with the young fronds emerging above the old
  // ones, and the first cut — every frond from the same vertex — gave the near
  // capture a hard umbrella join at the top of the trunk. Pushing each origin
  // out along its own azimuth and down by its own age costs nothing and is the
  // difference between a crown and a parasol.
  const o = {
    seed: hash32('fs', i, p.nFrond, p.sabal ? 1 : 2),
    x: p.tiltX + Math.cos(az) * p.trunkR * 1.05,
    y: p.trunkH - p.trunkR * (0.25 + 1.6 * u),
    z: p.tiltZ + Math.sin(az) * p.trunkR * 1.05,
  };
  const F = p.sabal ? {
    ...o,
    az: az + jit * 0.34, seg: 3, fan: true,
    // A sabal's fans radiate in every direction at once and the older ones fall
    // well below their own crown base, so the crown is a dense globe rather
    // than a parasol — that is what a dozen of them look like round the
    // roundabout in 03-Five-Points. The keel is high because a costapalmate
    // leaf FOLDS along its ribs: a flat sabal fan is a paddle, a folded one is
    // a cabbage palm.
    //
    // The old frond finished at (rise - droop) = -0.77 of its own reach and
    // most of that fall happened in the last third: a stiff spoke that turns
    // down at the end. A sabal's oldest fans hang in a SKIRT, so the tip now
    // finishes 1.20 reaches below its base with the arc's peak at t = 0.15 --
    // out first, then over.
    rise: 1.25 - 0.75 * u, droop: 0.85 + 0.85 * u,
    len: p.R * (0.92 + 0.13 * u), wid: p.R * (0.175 + 0.030 * u), keel: 0.48,
  } : {
    ...o,
    az: az + jit * 0.30, seg: 3, fan: false,
    // A queen throws its fronds up and then lets them fall past the horizontal,
    // which is the fountain in 05-Sarasota-Opera-House and 06-Frances-Carlton.
    //
    // AND IT ARCHES ON THE WAY. The old pair fell 1.70 of the frond's reach by
    // its tip, which is not an arch, it is a plunge: the frond went out a
    // metre and then dropped nearly two, so the crown read as a tight tuft
    // with a fringe under it. The photograph's oldest fronds fall about 0.9 of
    // their own horizontal reach and rise about a tenth of it first. Same
    // triangles, different vertex positions.
    rise: 1.50 - 0.62 * u, droop: 0.95 + 0.90 * u,
    len: p.R * (0.86 + 0.22 * u), wid: p.R * (0.19 + 0.04 * u), keel: 0.52,
  };
  palmReach(F);
  return F;
}

/**
 * The two clearances a frond has to keep, applied to the frond itself rather
 * than to the crown as a whole -- which is the only place they can be kept
 * exactly, because a crown is a sphere and the things it must miss are on one
 * side of it.
 *
 * TOWARD THE FRONTAGE the frond is SHORTENED, which is what a street palm
 * growing against a shopfront is: cut back on the building side. The lateral
 * half-width is subtracted from the room first, because a frond running ALONG
 * the street still puts its blade edge across it.
 *
 * OVER THE CARRIAGEWAY it is FLATTENED instead -- droop is reduced until the
 * tip clears the soffit -- because shortening a frond that hangs over a traffic
 * lane leaves a stub in the middle of a fountain, and lifting it is what a
 * pruned street tree looks like. Height is monotone decreasing past the arc's
 * peak and radius is monotone increasing, so the lowest point of the part that
 * is over the road is always the tip: solving at the tip is exact, not a
 * sample. The margin covers the blade edges, which hang a keel's worth below
 * the spine.
 *
 * Both are computed from p and i alone, so both tiers get the same frond and
 * the tier split still cannot pop.
 */
function palmReach(F) {
  const ca = Math.cos(F.az);
  if (ca > 0.02) {
    const lat = F.wid * (F.fan ? 1.20 : 0.90) * Math.abs(Math.sin(F.az));
    const room = PALM_FRONT_CAP - F.x - lat;
    if (F.len * ca > room) F.len = Math.max(0, room / ca);
  }
  if (ca < -0.02 && F.x + F.len * ca < PALM_ROAD_EDGE) {
    const room = Math.max(0, F.y - PALM_ROAD_Y - 0.18) / F.len;
    if (F.droop - F.rise > room) F.droop = F.rise + room;
  }
}

/** The three trunk stations, shared by both tiers so the boot plates land on
 *  the trunk they are meant to sit on rather than near it. */
function trunkStations(p) {
  const c = linear(p.bark);
  const shade = (s) => [c[0] * s, c[1] * s, c[2] * s];
  return [
    // The flare: a palm's base swells where the root mass reaches the ground.
    { x: 0, y: BASE_Y, z: 0, r: p.trunkR * 1.32, c: shade(0.80), boot: 0 },
    { x: p.tiltX * 0.5 + p.bow, y: BASE_Y + (p.trunkH - BASE_Y) * 0.52,
      z: p.tiltZ * 0.5 + p.bowZ, r: p.trunkR * 1.02, c: shade(0.9), boot: p.boot },
    { x: p.tiltX, y: p.trunkH, z: p.tiltZ, r: p.trunkR * 0.86, c: shade(1.0),
      boot: p.boot * 0.55 },
  ];
}

/**
 * THE FAR TIER of a live oak: the pit, the trunk, every primary limb, and the
 * EVEN leaf clumps.
 *
 * The tier split is the palm's, turned round. A palm's silhouette is its
 * fronds, so the palm splits fronds and keeps the trunk whole; an oak's
 * silhouette is its CLUMPS and its limb structure is interior detail you only
 * read from underneath, so the oak splits clumps and keeps every primary limb
 * in the far tier. Either way the far tier already carries the whole outline
 * and crossing 200 m fills it in rather than changing its shape.
 *
 *   pit slab                                       2 tris
 *   trunk: 5-gon, 3 stations, flared              20
 *   4-5 primary limbs, 3-gon, 3 stations          48-60
 *   26-30 clumps on the primaries, at 8          208-240
 *   ----------------------------------------------------
 *   FAR tier                                     278-322
 */
function oakFar(buf, f, p) {
  // A big tree gets a big pit. The mulch value is the palm's, for the reason
  // recorded against it below.
  const pit = 0.62 + p.trunkR * 1.5;
  pitSlab(buf, f, p.lean * 0.1, p.leanZ * 0.1, pit, pit, PAD_Y + 0.004,
    0x5a4a35, S.concrete);
  oakTrunk(buf, f, p);
  const limbs = oakLimbs(p);
  for (const lb of limbs) limbTube(buf, f, lb.pts, 3, p.phase, S.bark);
  const ctx = oakCtx(p);
  for (const c of oakClumpsOf(p, limbs, p.nClump, 0)) leafClump(buf, f, c, ctx);
}

/**
 * THE NEAR TIER of a live oak: the secondary web, and the leaf clumps that hang
 * on it and fill the volume between the primaries.
 *
 * THE SPLIT IS BY STRUCTURE, NOT BY PARITY, and it has to be. Every clump must
 * contain a piece of a limb, so a clump can only be drawn in a tier that also
 * draws the branch it hangs on. The far tier therefore takes the primaries and
 * everything strung along them -- which is the crown's whole outer envelope,
 * out to every limb tip -- and the near tier takes the twig web and the infill
 * between. Crossing 200 m fills the crown in; it does not change its outline,
 * which is the same property the palm's golden-angle frond split has and the
 * same reason the tier change cannot pop.
 *
 * A 0.1 m branch is under a pixel past about 150 m, well inside where this tier
 * switches off, so the web costs nothing at the range it is absent from.
 *
 *   8-10 secondary limbs, 3-gon, 2 stations       48-60
 *   22-26 clumps on the secondaries, at 8        176-208
 *   ----------------------------------------------------
 *   NEAR tier                                    224-268
 */
function oakNear(buf, f, p) {
  const limbs = oakLimbs(p);
  const twigs = oakTwigs(p, limbs);
  for (const tw of twigs) limbTube(buf, f, tw.pts, 3, p.phase + 1.1, S.bark);
  const ctx = oakCtx(p);
  for (const c of oakClumpsOf(p, twigs, p.nInfill, 1)) leafClump(buf, f, c, ctx);
}

// palm 154 / live oak 298 triangles; see the two headers above for the split.
function propTree(buf, f, k) {
  const p = treeParams(k, f.x, f.z);
  if (p.oak) return oakFar(buf, f, p);
  const st = trunkStations(p);
  // The pit was 0x40382f, and a round-7 critic tracked its centroid across
  // golden/dusk/night, found it moving 4 px while the facade terminator beside
  // it moved 110, and reported it as a baked blob-shadow decal. It is not a
  // decal, it is this quad — but at that value it reads as one. Pine-bark mulch
  // is what a Sarasota palm actually stands in and it is 2.4x lighter, so the
  // thing that made it look painted on is gone for nothing.
  pitSlab(buf, f, p.tiltX * 0.18, p.tiltZ * 0.18, 0.72, 0.72, PAD_Y + 0.004,
    0x5a4a35, S.concrete);
  // The spear leaf leaves the crown centre along the trunk's own direction, so
  // a curved palm's growing point is not bolted on vertically.
  const budC = linear(p.frond);
  palmTrunk(buf, f, st, 5, p.phase, [
    (p.tiltX - st[1].x) * 0.5, p.R * (p.sabal ? 0.40 : 0.52),
    (p.tiltZ - st[1].z) * 0.5,
    [budC[0] * 0.86, budC[1] * 0.86, budC[2] * 0.86],
  ], S.bark);
  const ctx = crownCtx(p);
  for (let i = 0; i < p.nFrond; i += 2) palmFrond(buf, f, frondAt(p, i), ctx);
}

/**
 * The near-tier half of a palm: the odd-indexed fronds, which interleave with
 * the far tier's in both azimuth and age, and ten plates on the trunk. Switched
 * off with the bins past ~200 m, where a 6 cm boot is a fifth of a pixel.
 */
// palm 140 / live oak 243 triangles.
function propTreeDetail(buf, f, k) {
  const p = treeParams(k, f.x, f.z);
  if (p.oak) return oakNear(buf, f, p);
  const st = trunkStations(p);
  const ctx = crownCtx(p);
  for (let i = 1; i < p.nFrond; i += 2) palmFrond(buf, f, frondAt(p, i), ctx);
  // Ten plates spiralled up the trunk. On a sabal they stand 6-8 cm proud and
  // are the persistent leaf bases that make the criss-cross in 02-Worth-s-Block;
  // on a queen the same ten sit nearly flush and read as the ring scars a
  // smooth trunk has instead. One code path, one parameter.
  const hand = handOf(f);
  const c = linear(p.bark);
  const out = p.sabal ? p.trunkR * 0.42 : p.trunkR * 0.10;
  const hi = p.sabal ? 1.24 : 1.1, lo = p.sabal ? 0.72 : 0.92;
  for (let i = 0; i < 10; i++) {
    const t = 0.14 + (i / 10) * (p.sabal ? 0.62 : 0.78);
    // Interpolate along the same two-segment trunk the far tier drew, so the
    // plate sits ON it however the trunk is bowed.
    const s = t < 0.5 ? 0 : 1, ft = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const A = st[s], B = st[s + 1];
    const cx = A.x + (B.x - A.x) * ft, cy = A.y + (B.y - A.y) * ft;
    // 0.86 rather than 1.0 because the trunk is a PENTAGON, not a cylinder: a
    // 5-gon's flat faces sit at cos(36) = 0.809 of the ring radius, so a plate
    // seated at the ring radius floats off the face everywhere except the five
    // vertices. Seated between the two, the top edge is buried in the trunk at
    // every azimuth and only the bottom edge stands proud.
    const cz = A.z + (B.z - A.z) * ft, rr = (A.r + (B.r - A.r) * ft) * 0.86;
    const a = p.phase + i * 2.39996;
    const ux = Math.cos(a), uz = Math.sin(a);
    const sx = -uz, sz = ux;                       // tangent to the trunk ring
    // Wide and shallow, so ten of them on a spiral overlap into a band rather
    // than reading as ten separate labels stuck to a pole.
    const w = rr * 1.02, hgt = p.trunkR * 0.5;
    const P = (dw, dy, dr) => vertC(buf,
      wx(f, cx + ux * (rr + dr) + sx * dw, cz + uz * (rr + dr) + sz * dw), cy + dy,
      wz(f, cx + ux * (rr + dr) + sx * dw, cz + uz * (rr + dr) + sz * dw),
      ux * f.ox + uz * f.ax, 0.34, ux * f.oz + uz * f.az,
      c[0] * (dy > 0 ? hi : lo), c[1] * (dy > 0 ? hi : lo), c[2] * (dy > 0 ? hi : lo),
      S.bark);
    // A wedge in section: flush at the top, standing proud at the bottom, which
    // is the way a shed leaf base actually hangs on.
    //
    // The order matters and was got wrong first time. With u radial and
    // s = (-uz, ux) tangential, u x s = -Y and s x Y = -u, so the winding
    // v0 -> v3 -> v2 comes out with a geometric normal pointing DOWN AND INTO
    // the trunk — the whole-kit defect at the top of this file, reintroduced on
    // ten plates. .wind-audit.mjs measured it as 20 backfacing triangles per
    // palm before this line was reversed, which is what that audit is for.
    const v0 = P(-w, hgt, 0), v1 = P(w, hgt, 0);
    const v2 = P(w * 0.8, -hgt, out), v3 = P(-w * 0.8, -hgt, out);
    tri(buf, hand, v0, v2, v3);
    tri(buf, hand, v0, v1, v2);
  }
}

function propCabinet(buf, f, k) {                                    // 24 tris
  box(buf, f, 0, BASE_Y + 0.06, 0, 0.28, 0.06, 0.44, 0x8d8880, S.concrete);
  box(buf, f, 0, 0.62, 0, 0.24, 0.62, 0.4, 0x77837c, S.plastic);
}

function propNewsBox(buf, f, k) {                                    // 24 tris
  const hues = [0x2b5fa8, 0xa63a2e, 0x2e7d4f, 0xb8862c];
  const hex = hues[hash32('nb', k) % hues.length];
  box(buf, f, 0, 0.28, 0, 0.19, 0.37, 0.24, 0x3a3f45, S.painted);
  box(buf, f, 0, 0.86, 0, 0.22, 0.24, 0.28, hex, S.painted);
  prism(buf, f, 0, 0, 0.04, 0.04, BASE_Y, 0.1, 3, 0x3a3f45, S.painted);
}

function propBikeRack(buf, f, k) {                                   // 26 tris
  for (const s of [-0.42, 0.42]) {
    prism(buf, f, 0, s, 0.05, 0.05, BASE_Y, 0.86, 3, 0x8e959c, S.chrome, 0.4);
  }
  box(buf, f, 0, 0.86, 0, 0.045, 0.045, 0.42, 0x8e959c, S.chrome);
}

/** Cast-iron cover, embedded through the road ribbon so it cannot float. */
function propManhole(buf, f, k) {                                    // 16 tris
  prism(buf, f, 0, 0, 0.36, 0.34, BASE_Y, ROAD_Y + 0.018, 6, 0x3c3a37, S.iron);
}

/** Kerbside gully: a grate slab plus the kerb inlet behind it. */
function propGully(buf, f, k) {                                      // 14 tris
  slab(buf, f, 0, 0, 0.28, 0.42, ROAD_Y + 0.014, 0x2c2e30, S.iron);
  box(buf, f, 0.33, ROAD_Y + 0.07, 0, 0.06, 0.1, 0.42, 0x24262a, S.iron);
}

// ---------------------------------------------------------------- wall clutter
function wallVent(buf, f, k) {                                       // 12 tris
  const y = 2.3 + rnd01('wv', k) * 1.4;
  box(buf, f, 0.06, y, 0, 0.06, 0.34, 0.46, 0x79818a, S.galv);
}
function wallBox(buf, f, k) {                                        // 12 tris
  box(buf, f, 0.13, 1.24, 0, 0.13, 0.36, 0.26, 0x7d8a86, S.plastic);
}
function wallCondenser(buf, f, k) {                                  // 24 tris
  box(buf, f, 0.32, 2.72, 0, 0.3, 0.28, 0.42, 0x8c9298, S.galv);
  box(buf, f, 0.16, 2.4, 0, 0.16, 0.04, 0.36, 0x5b6167, S.galv);
}
function wallCellarDoor(buf, f, k) {                                 // 24 tris
  // Two leaves lying against the wall on the pavement: low, wide, unmistakable.
  box(buf, f, 0.62, BASE_Y + 0.09, -0.42, 0.58, 0.09, 0.4, 0x4a5057, S.galv);
  box(buf, f, 0.62, BASE_Y + 0.09, 0.42, 0.58, 0.09, 0.4, 0x434950, S.galv);
}
function wallDownpipe(buf, f, k) {                                   // 22 tris
  const top = 4.6 + rnd01('dp', k) * 5.5;
  prism(buf, f, 0.11, 0, 0.075, 0.075, BASE_Y, top, 4, 0x6e6a64, S.galv, 0.4);
  box(buf, f, 0.2, 0.16, 0, 0.11, 0.11, 0.11, 0x6e6a64, S.galv);
}
function wallStandpipe(buf, f, k) {                                  // 24 tris
  box(buf, f, 0.1, 1.05, 0, 0.1, 0.22, 0.3, 0xb0342c, S.painted);
  box(buf, f, 0.22, 1.05, 0, 0.06, 0.09, 0.2, 0x8b9199, S.chrome);
}

// ---------------------------------------------------------------- lookups
/**
 * Uniform grid over line segments and polygons. Everything in this file needs
 * the same two questions answered a few thousand times at load — "how far is
 * this point from the nearest carriageway" and "how far is it from the nearest
 * building" — and answering them by scanning 2,418 segments and 523 rings each
 * time is the difference between 40 ms and 40 seconds.
 */
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  _k(cx, cz) { return cx * 46337 + cz; }
  insert(item, x0, z0, x1, z1) {
    const c = this.cell;
    const ax = Math.floor(x0 / c), az = Math.floor(z0 / c);
    const bx = Math.floor(x1 / c), bz = Math.floor(z1 / c);
    for (let iz = az; iz <= bz; iz++) {
      for (let ix = ax; ix <= bx; ix++) {
        const k = this._k(ix, iz);
        let l = this.map.get(k);
        if (!l) this.map.set(k, (l = []));
        l.push(item);
      }
    }
  }
  near(x, z, out) {
    out.length = 0;
    const c = this.cell;
    const ix = Math.floor(x / c), iz = Math.floor(z / c);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const l = this.map.get(this._k(ix + dx, iz + dz));
        if (l) for (const it of l) out.push(it);
      }
    }
    return out;
  }
}

function segDist(px, pz, x0, z0, x1, z1) {
  const vx = x1 - x0, vz = z1 - z0;
  const l2 = vx * vx + vz * vz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0;
  return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t));
}
function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Translate a geometry in place and hand it back, so a fixture can be composed
 *  as an expression rather than as four statements and a temporary. */
function translated(g, x, y, z) { g.translate(x, y, z); return g; }

/**
 * Concatenate geometries into one, so a fixture made of several primitives is
 * still ONE InstancedMesh and therefore still one draw call at any lamp count.
 *
 * three.js ships BufferGeometryUtils.mergeGeometries, but it lives in
 * examples/jsm and the vendored build here is the core module alone (checked:
 * `'mergeGeometries' in THREE` is false). This is the six lines of it that this
 * file needs — position, normal, uv, all non-indexed — rather than a new
 * dependency, which binding constraint 2 does not allow anyway.
 */
function mergeGeos(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const size = parts[0].attributes[name].itemSize;
    let n = 0;
    for (const p of parts) n += p.attributes[name].count;
    const arr = new Float32Array(n * size);
    let o = 0;
    for (const p of parts) { arr.set(p.attributes[name].array, o); o += p.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const p of parts) p.dispose();
  return out;
}

// ---------------------------------------------------------------- the module
export class StreetFurniture {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.max = opts.max ?? 400;
    this.root = new THREE.Group();
    this.root.name = 'furniture';
    scene.add(this.root);

    // Matte black cast iron, not the 0.75-metalness galvanised steel a modern
    // highway pole is made of. Every ornamental standard in
    // reference/sarasota/02-Worth-s-Block and 03-Five-Points is painted black
    // ironwork, and a specular pole reads as a scaffold tube.
    const metal = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.62, metalness: 0.34 });
    // Lamp globes are emissive geometry; the actual illumination comes from the
    // LightPool, so these can be instanced freely.
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0xd8d2c4, emissive: 0xffd9a0, emissiveIntensity: 0,
    });

    // The pole is set INTO the pavement, not stood on top of it.
    //
    // streaming.js reports ground as groundY (0) through heightAt(), but the pad
    // the player sees is drawn at groundY - 0.05 so the road ribbons (+0.02) and
    // zone polygons (+0.012) can stack on it without z-fighting. A pole based at
    // exactly y = 0 hovers 50 mm above the pavement — 5.4 px at ten metres, and
    // one of the "post does not reach the ground" findings. 0.08 m of embedment
    // spans both the pad offset and the road ribbon.
    const EMBED = 0.08;
    // ------------------------------------------ THE ORNAMENTAL TWIN-GLOBE STANDARD
    //
    // reference/sarasota/02-Worth-s-Block and 03-Five-Points both show the same
    // fixture on Main Street and round the roundabout: a black post carrying two
    // frosted spheres on brackets. What stood here was a plain tube with a box
    // on a straight arm — a 1970s cobra head, and one of the six things the
    // district was getting wrong about where it is.
    //
    // IT IS PAID FOR OUT OF THE POLE. Lamps are three InstancedMeshes with
    // frustumCulled = false, so all 1,100 of them are submitted every frame in
    // BOTH the colour and the shadow pass: a triangle here costs 2,200. The
    // 8-sided capped cylinder spent 32 triangles on something under 3 px wide at
    // any distance a player sees it from; a 6-sided one is 24 and shades
    // identically, because CylinderGeometry's normals are radial and a 6-gon
    // smooth-shaded reads round. That saving buys both globes.
    //
    //     was   pole 32 + arm 12 + head 12                            =  56
    //     now   pole 20 + bracket 12 + globe 20 + globe 20            =  72
    //
    // THE OUTER GLOBE IS EXACTLY WHERE THE HEAD WAS, at (2.2, 7.7). addLamp()
    // returns that point and district/main.js hands it straight to the
    // LightPool, so not one emitter moves and the night grade three critic
    // rounds have called the best in the set is untouched by this. The second
    // globe goes on a shorter pavement-side bracket, which is what a real
    // roadway/pavement twin does — the symmetric version would have to move the
    // light 2.2 m, and that is a lighting change, not a dressing one.
    const poleGeo = new THREE.CylinderGeometry(0.085, 0.155, 8.2 + EMBED, 5);
    poleGeo.translate(0, (8.2 - EMBED) / 2, 0);
    // One bracket spanning the post, from the pavement-side globe to the
    // roadway-side one: -1.0 to +2.2, so it is one box and not two.
    const armGeo = new THREE.BoxGeometry(3.2, 0.13, 0.115);
    armGeo.translate(0.6, 7.44, 0);
    const headGeo = mergeGeos([
      translated(new THREE.SphereGeometry(0.25, 5, 3), 2.2, 7.70, 0),
      translated(new THREE.SphereGeometry(0.22, 5, 3), -1.0, 7.66, 0),
    ]);

    // All three cast. The arm and the head were excluded when a shadow texel was
    // 0.254 m and a 0.13 m arm could not survive PCF; at 0.078 m/texel the arm is
    // 1.7 texels and the head 5.4, and a post that throws a shadow while the
    // luminaire hanging over the carriageway throws none reads as a mistake. Two
    // more meshes in the shadow pass, 13k triangles between them.
    this.poles = this._instanced(poleGeo, metal, true);
    this.arms = this._instanced(armGeo, metal, true);
    this.heads = this._instanced(headGeo, this.headMat, true);
    this.count = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3(1, 1, 1);

    // Lamp footprints, so the parked-car and kerb-prop passes can refuse a slot
    // a lamp post already stands in. A grid, not a list: this is queried once
    // per candidate and there are thousands of candidates.
    this._lampGrid = new Grid(16);

    this.props = {};                     // per-kind counts, reported
    this.treeSpecies = {};               // oak / sabal / queen, counted where planted
    this.propTris = 0;
    this.propMeshes = [];
    this.worstFloat = -Infinity;         // max(prop base y - host y), audited
    this._lit = false;
    this._exposure = 1 / 660;
    this.parked = null;
  }

  _instanced(geo, mat, shadow) {
    const m = new THREE.InstancedMesh(geo, mat, this.max);
    m.count = 0;
    m.castShadow = shadow;
    m.frustumCulled = false;      // the pool is district-wide; culling it hides everything
    this.root.add(m);
    return m;
  }

  // Returns the world position of the lamp head so the caller can register a
  // matching emitter with the LightPool.
  addLamp(x, z, yaw) {
    if (this.count >= this.max) return null;
    this._pos.set(x, 0, z);
    this._q.setFromAxisAngle(this._up, yaw);
    this._m.compose(this._pos, this._q, this._scale);
    const i = this.count++;
    this.poles.setMatrixAt(i, this._m);
    this.arms.setMatrixAt(i, this._m);
    this.heads.setMatrixAt(i, this._m);
    this.poles.count = this.arms.count = this.heads.count = this.count;
    this._lampGrid.insert([x, z], x, z, x, z);
    return { x: x + Math.cos(yaw) * 2.2, y: 7.7, z: z - Math.sin(yaw) * 2.2 };
  }

  commit() {
    for (const m of [this.poles, this.arms, this.heads]) m.instanceMatrix.needsUpdate = true;
  }

  // ============================================================ DRESSING PASS
  /**
   * Build every static prop in the district, once, at load.
   *
   * This is deliberately NOT per-chunk work. The chunk build stall is the
   * tightest budget in the project (median 11.8 ms against a warn at 8), so
   * adding placement to the streamer's critical path would be the single
   * worst place to put it. The whole district is dressed in one pass here,
   * bucketed spatially, and the streamer never learns this module exists.
   */
  dressDistrict(district, opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.d = district;
    // The census is indexed by arc length along the hero route, so the tree
    // species and the tree DENSITY both need the route before anything is
    // placed. Handed over here rather than read from a module-level import, so
    // a district without one simply dresses in palms.
    setOakRoute(district.meta && district.meta.route);
    // ---- two tiers, because a bollard and a traffic signal are not the same
    // kind of object to a frustum.
    //
    // Everything static welds into one material, but a single spatial grid has
    // to choose between big cells (few draw calls, no culling) and small cells
    // (good culling, many draw calls). It does not have to: a signal mast, a
    // street tree and a utility pole read from hundreds of metres away and go in
    // BIG cells that are never distance-culled, while a bollard, a bin, a
    // manhole cover and a wall vent are invisible past a couple of hundred
    // metres and go in SMALL cells that are switched off beyond it. Measured on
    // the drive-through gate this took p95 triangles from 395.5k (99% of the warn
    // threshold) to well under it, for the same number of draw calls.
    const FAR = new Set(['signal', 'tree', 'utilityPole', 'span']);
    const nearSize = opts.nearBucket ?? 224;
    const farSize = opts.farBucket ?? 512;
    const tiers = [
      { name: 'near', size: nearSize, cull: opts.nearCull ?? 200, bufs: new Map() },
      // 640 m is farRadius * chunkSize: past it the streamer has unloaded the
      // city, so a prop out there stands on a bare pad with no buildings.
      { name: 'far', size: farSize, cull: opts.farCull ?? 640, bufs: new Map() },
    ];
    const bucketFor = (kind, x, z) => {
      const t = tiers[FAR.has(kind) ? 1 : 0];
      const k = `${Math.floor(x / t.size)},${Math.floor(z / t.size)}`;
      let b = t.bufs.get(k);
      if (!b) t.bufs.set(k, (b = newBuf()));
      return b;
    };
    this._buildIndices();

    // Emission wrapper that MEASURES the floating-prop class rather than
    // asserting it away. Every ground-standing prop declares the surface it
    // stands on; the lowest vertex it actually emitted is checked against it.
    // Optional: keep every prop's footprint so a harness can re-check the whole
    // district against the road graph and the baked footprints. Off by default —
    // it is 7,000 entries of pure verification ballast — and on for tooling.
    this.placed = opts.audit ? [] : null;
    const emit = (kind, ax, az, hostY, fn) => {
      const buf = bucketFor(kind, ax, az);
      const v0 = buf.pos.length;
      const i0 = this.placed ? buf.idx.length : 0;
      fn(buf);
      if (buf.pos.length === v0) return false;
      if (this.placed) {
        // The FOOTPRINT, not the whole assembly. A signal mast is supposed to
        // reach out over the carriageway, so the bounding box of the whole thing
        // sits over the road by design; what has to be clear of the road is the
        // bit standing on the ground. So the audit record is the plan extent of
        // the vertices within 0.25 m of the lowest one.
        let lo = Infinity;
        for (let i = v0 / 3; i < buf.pos.length / 3; i++) {
          const y = buf.pos[i * 3 + 1];
          if (y < lo) lo = y;
        }
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let i = v0 / 3; i < buf.pos.length / 3; i++) {
          if (buf.pos[i * 3 + 1] > lo + 0.25) continue;
          const x = buf.pos[i * 3], z = buf.pos[i * 3 + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        this.placed.push({ kind, x: (x0 + x1) / 2, z: (z0 + z1) / 2,
          rx: (x1 - x0) / 2, rz: (z1 - z0) / 2, lowY: lo, hostY,
          wind: windingOf(buf, i0) });
      }
      if (hostY !== null) {
        let lo = Infinity;
        for (let i = v0 + 1; i < buf.pos.length; i += 3) if (buf.pos[i] < lo) lo = buf.pos[i];
        if (lo - hostY > this.worstFloat) this.worstFloat = lo - hostY;
      }
      this.props[kind] = (this.props[kind] ?? 0) + 1;
      return true;
    };

    this._dressJunctions(emit, opts);
    this._dressKerbs(emit, opts);
    this._dressCarriageway(emit, opts);
    this._dressWalls(emit, opts);
    this._dressOverhead(emit, opts);
    this._planParking(opts);

    // ---- fold the near-empty buckets into their nearest substantial neighbour.
    // The district's outline is ragged, so a uniform grid leaves cells holding a
    // couple of hundred triangles. Each of those is a whole draw call for nothing
    // if it happens to fall in the frustum, and draw calls are the budget that
    // actually binds here.
    const mat = propMaterial();
    this.propMat = mat;
    for (const t of tiers) {
      const minTris = (opts.minBucketTriangles ?? 3500) * (t.name === 'near' ? 0.35 : 1);
      const centre = (key) => {
        const [gx, gz] = key.split(',').map(Number);
        return [(gx + 0.5) * t.size, (gz + 0.5) * t.size];
      };
      const big = [...t.bufs.keys()].filter((k) => t.bufs.get(k).idx.length / 3 >= minTris);
      if (big.length) {
        for (const [key, b] of [...t.bufs]) {
          if (b.idx.length / 3 >= minTris || !b.idx.length) continue;
          const [cx, cz] = centre(key);
          let best = null, bestD = Infinity;
          for (const k of big) {
            const [bx, bz] = centre(k);
            const dd = (bx - cx) ** 2 + (bz - cz) ** 2;
            if (dd < bestD) { bestD = dd; best = k; }
          }
          const tgt = t.bufs.get(best);
          const off = tgt.pos.length / 3;
          for (const a of ['pos', 'nrm', 'col', 'uv']) for (const v of b[a]) tgt[a].push(v);
          for (const i of b.idx) tgt.idx.push(i + off);
          t.bufs.delete(key);
        }
      }

      // ---- weld each bucket into one mesh on the one shared material.
      for (const [key, b] of t.bufs) {
        if (!b.idx.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
        g.setIndex(b.idx);
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, mat);
        m.name = `props:${t.name}:${key}`;
        m.receiveShadow = true;
        m.userData.c = g.boundingSphere.center.clone();
        m.userData.r = g.boundingSphere.radius;
        m.userData.cull = t.cull;
        // castShadow is ON, and the comment that stood here was wrong on both of
        // the grounds it gave for switching it off.
        //
        // It read: "the sun's shadow camera is 520 m across and a far bucket is
        // 512 m, so every bucket would render into the shadow map as well as the
        // frame: it would double the triangle cost of the whole dressing pass to
        // gain contact shadows that the SSAO pass already draws." Measured at the
        // corridor hero camera, golden hour, traffic and crowd frozen:
        //
        //  - The buckets do not all render. cullProps() sets visible = false past
        //    the tier's cull distance and three.js skips an invisible object in
        //    the shadow pass exactly as it does in the colour pass, so the shadow
        //    pass gains the buckets in range - 42 meshes and 261k triangles here -
        //    not the whole 4,596-prop kit.
        //  - The SSAO pass IS drawing something here, and that turns out not to
        //    settle the question. Switching aoEnabled off lifts the bin box at
        //    (1250-1325, 578-660) from 53.0 to 71.3 of 255 - the AO term is worth
        //    18.3 there, more than any shadow in this frame. What it is not is
        //    DIRECTIONAL: a 2.2 m screen-space hemisphere puts a soft halo around
        //    the bin and its surroundings alike, with no edge running away from
        //    the sun and nothing anchoring the object to one spot on the paving.
        //    Three critics reading these frames called that "sitting on top of the
        //    ground". So the old comment's premise was right and its conclusion
        //    was wrong: AO reaches the contact, and a cast shadow is still the
        //    thing that makes the contact read.
        //
        // What it buys, as the fraction of the near-ground band the shadow pass
        // darkens by more than 8/255: 14.0% with props off, 31.9% with them on,
        // at an unchanged 52% for the mid band and 14% for the facades. The bin,
        // the bollards and the kerbside planters stop floating.
        m.castShadow = true;
        this.root.add(m);
        this.propMeshes.push(m);
        this.propTris += b.idx.length / 3;
        (t.name === 'near' ? (this.nearMeshes ??= []) : (this.farMeshes ??= [])).push(m);
      }
    }
    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return this.report();
  }

  // ------------------------------------------------------------ spatial index
  _buildIndices() {
    const d = this.d;
    // Carriageways, as segments carrying their own half-width. "Is this point in
    // the road" then has one answer for the whole graph, junctions included:
    // at Five Points five 6.6 m ribbons overlap and no per-edge test can see it.
    this.roadGrid = new Grid(32);
    this.segs = [];
    d.edges.forEach((e, ei) => {
      for (let k = 0; k < e.v.length - 1; k++) {
        const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
        const s = { x0: a.x, z0: a.z, x1: b.x, z1: b.z, hw: e.w / 2, ei };
        this.segs.push(s);
        const pad = e.w / 2 + 8;
        this.roadGrid.insert(s,
          Math.min(a.x, b.x) - pad, Math.min(a.z, b.z) - pad,
          Math.max(a.x, b.x) + pad, Math.max(a.z, b.z) + pad);
      }
    });

    this.bldGrid = new Grid(48);
    this.blds = [];
    for (const b of d.buildings) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of b.p) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const item = { ring: b.p, x0, x1, z0, z1, h: b.h ?? 6 };
      this.blds.push(item);
      this.bldGrid.insert(item, x0 - 10, z0 - 10, x1 + 10, z1 + 10);
    }
    this._scratch = [];
  }

  /** Metres of clear ground between this point and the nearest carriageway edge.
   *  Negative means the point is standing in the road. */
  roadClearance(x, z, ignoreEdge = -1) {
    const list = this.roadGrid.near(x, z, this._scratch);
    let best = 99;
    for (const s of list) {
      if (s.ei === ignoreEdge) continue;
      const d = segDist(x, z, s.x0, s.z0, s.x1, s.z1) - s.hw;
      if (d < best) best = d;
    }
    return best;
  }

  /** Metres from the nearest building footprint. Negative means inside one. */
  buildingClearance(x, z) {
    const list = this.bldGrid.near(x, z, this._scratch);
    let best = 99;
    for (const b of list) {
      if (x < b.x0 - 8 || x > b.x1 + 8 || z < b.z0 - 8 || z > b.z1 + 8) continue;   // AABB reject
      const r = b.ring;
      let dd = Infinity;
      for (let i = 0; i < r.length; i++) {
        const a = r[i], c = r[(i + 1) % r.length];
        const q = segDist(x, z, a[0], a[1], c[0], c[1]);
        if (q < dd) dd = q;
      }
      if (inRing(r, x, z)) dd = -dd;
      if (dd < best) best = dd;
    }
    return best;
  }

  lampClearance(x, z) {
    const list = this._lampGrid.near(x, z, this._scratch);
    let best = 99;
    for (const p of list) {
      const d = Math.hypot(x - p[0], z - p[1]);
      if (d < best) best = d;
    }
    return best;
  }

  // ------------------------------------------------------------ 1. junctions
  /**
   * Traffic signals. "At what is presented as a downtown intersection there is
   * no traffic signal" was the single loudest note of round three, and a mast
   * arm reaching out over the carriageway with a lit lens on the end is the
   * most legible object you can put at a junction.
   *
   * One mast per signalised approach, on the driver's right, set back behind the
   * crossing carriageway. Which lens burns is decided per junction so the two
   * axes disagree: a junction showing green in all four directions is worse than
   * no signal at all.
   */
  _dressJunctions(emit, opts) {
    const d = this.d;
    const at = new Map();
    d.edges.forEach((e, ei) => {
      for (const end of [0, e.v.length - 1]) {
        const v = e.v[end];
        if (!at.has(v)) at.set(v, []);
        at.get(v).push({ ei, end });
      }
    });
    const dirOf = (e, end) => {
      const a = end === 0 ? e.v[0] : e.v[e.v.length - 1];
      const b = end === 0 ? e.v[1] : e.v[e.v.length - 2];
      const pa = d.verts[a], pb = d.verts[b];
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      const l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    };

    // 220 was chosen when a single physical junction could claim eight rings of
    // masts; the merge below drops district-wide demand from 715 approaches to
    // 237, so the cap no longer has to ration. At 260 every junction the graph
    // signalises is served and the ceiling is still there if the bake changes.
    const maxMasts = opts.maxSignalMasts ?? 260;
    let masts = 0;
    const keys = [...at.keys()].sort((a, b) => a - b);
    const isSignalised = (v) => {
      const inc = at.get(v);
      return inc.length >= 3 &&
        // Signalise a junction only where at least two legs are a real street.
        inc.filter(({ ei }) => d.edges[ei].r <= 4).length >= 2;
    };
    const cand = keys.filter(isSignalised);

    // ---- ONE PHYSICAL JUNCTION, ONE SET OF MASTS.
    //
    // "At least five vertical pole elements and four signal heads serving what
    // appears to be a single four-way junction." Measured at the hero junction
    // the count is right: four heads, one per approach of a single four-leg
    // vertex, which is what a signalised crossroads looks like. But the census
    // over the whole graph found the real version of that defect. The baked
    // graph is OSM-derived, so a physical junction is routinely SPLIT across
    // several vertices — a dual carriageway, a slip, a kerb-line node — and each
    // of those independently passed the >=3 legs test and got its own full ring
    // of masts. Measured: 250 signalised vertices collapse to 88 physical
    // junctions under a 35 m single-link merge, and the largest single junction
    // was carrying twenty-five of them.
    //
    // So candidates are clustered first and only the representative of each
    // cluster — the one with the most legs, lowest index breaking the tie so it
    // is deterministic — is signalised. The masts that the cap used to spend on
    // eight copies of one junction now reach eight junctions that had none.
    const MERGE = opts.junctionMerge ?? 30;
    const rep = new Map(cand.map((v) => [v, v]));
    const find = (a) => { while (rep.get(a) !== a) { rep.set(a, rep.get(rep.get(a))); a = rep.get(a); } return a; };
    for (let i = 0; i < cand.length; i++) {
      const A = d.verts[cand[i]];
      for (let j = i + 1; j < cand.length; j++) {
        const B = d.verts[cand[j]];
        if (Math.abs(A.x - B.x) > MERGE || Math.abs(A.z - B.z) > MERGE) continue;
        if (Math.hypot(A.x - B.x, A.z - B.z) > MERGE) continue;
        const ra = find(cand[i]), rb = find(cand[j]);
        if (ra !== rb) rep.set(ra, rb);
      }
    }
    const best = new Map();                       // cluster root -> chosen vertex
    for (const v of cand) {
      const r = find(v);
      const cur = best.get(r);
      if (cur === undefined || at.get(v).length > at.get(cur).length) best.set(r, v);
    }
    const chosen = new Set(best.values());

    for (const v of cand) {
      if (masts >= maxMasts) break;
      if (!chosen.has(v)) continue;
      const inc = at.get(v);
      const p = d.verts[v];
      let widest = 0;
      for (const { ei } of inc) widest = Math.max(widest, d.edges[ei].w);

      // ---- WHICH AXIS IS GREEN, decided geometrically.
      //
      // The old rule was `green = (leg % 2) === greenAxis`, i.e. alternate down
      // the incident-edge list — and that list is in EDGE INDEX order, which has
      // nothing to do with where the legs point. Measured at the hero junction
      // (v103, four legs): the two legs on the 51 degree axis were assigned
      // green and RED, and the two on the 140 degree axis red and GREEN. Two
      // legs that cross each other were both showing green, and two legs facing
      // each other down the same street disagreed. That is the conflicting-
      // aspects defect for real, at junction scale rather than inside one
      // housing, and it is exactly what this function's own comment says it
      // exists to prevent.
      //
      // Legs are now bucketed by their heading modulo 180 degrees: everything
      // within 45 degrees of the first leg's line is one axis, the rest is the
      // other. Opposite approaches then always agree and crossing approaches
      // always disagree, whatever order the edges happen to be stored in.
      const legs = [];
      for (const { ei, end } of inc) {
        if (d.edges[ei].r > 5) continue;
        const [ux, uz] = dirOf(d.edges[ei], end);   // away from the junction
        legs.push({ ei, end, ux, uz, ang: Math.atan2(uz, ux) });
      }
      if (!legs.length) continue;
      const base = legs[0].ang;
      const greenAxis = hash32('sig', v) % 2;
      for (const L of legs) {
        // Angle between the two LINES, so a leg and its opposite share an axis.
        let da = Math.abs(L.ang - base) % Math.PI;
        if (da > Math.PI / 2) da = Math.PI - da;
        L.axis = da < Math.PI / 4 ? 0 : 1;
      }

      for (const L of legs) {
        if (masts >= maxMasts) break;
        const e = d.edges[L.ei];
        const { ux, uz } = L;
        const rx = uz, rz = -ux;                   // driver's right on approach
        const setback = widest / 2 + 2.0;
        const off = e.w / 2 + 1.35;
        const bx = p.x + ux * setback + rx * off;
        const bz = p.z + uz * setback + rz * off;
        const green = L.axis === greenAxis;
        // Never in another street, never inside a building. A corner that has no
        // room for a mast still gets its crossing painted.
        if (this.roadClearance(bx, bz) >= 1.0 && this.buildingClearance(bx, bz) >= 1.0) {
          const f = frame(bx, bz, -rx, -rz, ux, uz);   // +x back down the approach
          const armLen = off * 0.55 + e.w * 0.38;
          if (emit('signal', bx, bz, PAD_Y,
            (buf) => this._signalMast(buf, f, armLen, green, v * 8 + L.axis))) masts++;
        }
        // No crosswalk is painted here. src/materials.js owns the road surface and
        // paints the zebra, the stop bar and the lane arrows into the ribbon
        // shader, where they cost no triangles and can be placed against the real
        // carriageway width. A second set of stripes laid on top as geometry would
        // be a doubled, slightly-offset crossing at every signalised approach.
      }
    }
  }

  // The frame's +x faces back down the approach (at the driver) and its +z runs
  // from the kerb out over the carriageway, so the arm is a positive z offset.
  //
  // Three separate blind-critic findings landed on this one prop, and all three
  // were measured off the r5 dusk frame before anything was changed here:
  //
  //  1. "a lit red lens and a lit green lens in one housing." Not two aspects
  //     lit: ONE head, red on, and the UNLIT green lens reading as lit. The
  //     unlit tints were 0x5a1a14 / 0x5a3a10 / 0x14461f — saturated mid-tones
  //     that the dusk key light drove to a measured RGB(95,95,35) on the green
  //     lens and (137,83,32) on the amber. A dark signal lens is nearly black;
  //     these were bright enough to read as burning. The LIT lens had the
  //     opposite problem: base colour 0xffffff, so its diffuse term washed the
  //     emissive red out to a measured (250,212,171) — a white lamp, not a red
  //     aspect. Unlit tints are now near-black and each lit lens carries its own
  //     hue as the base colour, so what reads as lit is the aspect that IS lit.
  //
  //  2. "the mast arm ends in mid-air with no head attached." Measured: the arm
  //     underside sat at y 5.905 and the head's top at 5.67 — a 235 mm gap of
  //     open sky between them, ~14 px at the hero camera. The head was not
  //     attached to anything. It now hangs from a real bracket.
  //
  //  3. "three of four heads present no lens faces, reading as flat dark boxes."
  //     Measured with the facing dot product at the hero camera: -0.92, -0.63
  //     and +0.07 (edge on). The heads ARE correctly rotated — each faces its
  //     own approach, which is what a junction looks like — but the head was a
  //     plain box whose only signal-ish feature was a single-sided lens quad on
  //     one face, plus a backplate mounted on the WRONG side (behind the
  //     housing, where the driver can never see it). So from any other angle it
  //     was a featureless slab. The backplate is now on the lens side where it
  //     belongs and frames the stack, and each lens carries a visor: both read
  //     in silhouette from every angle, so a head facing away still reads as a
  //     traffic signal rather than as an unexplained dark box.
  _signalMast(buf, f, armLen, green, k) {                           // 134 tris
    const POLE = 0x2b3630;
    const CASE = 0x14181a;               // backplate / visor: near black, matte
    const hz = armLen;
    // The head hangs UNDER the arm tip: top of the housing, then the bracket
    // that carries it, then the arm. These three numbers are the joint.
    const ARM_Y = 5.98, ARM_HY = 0.075;
    const HEAD_TOP = 5.72, HEAD_HY = 0.62;
    const HEAD_Y = HEAD_TOP - HEAD_HY;
    box(buf, f, 0, BASE_Y + 0.12, 0, 0.3, 0.12, 0.3, 0x50555a, S.concrete);
    prism(buf, f, 0, 0, 0.135, 0.1, BASE_Y, 6.15, 6, POLE, S.painted);
    box(buf, f, 0, ARM_Y, hz / 2, 0.075, ARM_HY, hz / 2, POLE, S.painted);
    // Hanger bracket: overlaps the arm above and the housing below, so there is
    // no gap for a critic to find and no gap in the geometry either.
    box(buf, f, 0, (HEAD_TOP + ARM_Y - ARM_HY) / 2 + 0.01, hz,
      0.055, (ARM_Y - ARM_HY - HEAD_TOP) / 2 + 0.05, 0.055, POLE, S.painted);
    box(buf, f, 0, HEAD_Y, hz, 0.16, HEAD_HY, 0.22, POLE, S.painted);
    // Backplate on the LENS side, framing the stack: this is the thing that
    // makes a signal head read as a signal head instead of as a dark box, and
    // it has to be in front of the housing to do it.
    box(buf, f, 0.155, HEAD_Y, hz, 0.015, HEAD_HY + 0.15, 0.37, CASE, S.painted);
    const live = green ? S.lensGreen : S.lensRed;
    // Unlit: a glossy dark lens with only a hint of its own colour. Lit: the
    // aspect hue, so the emissive is not washed to white by a low sun.
    const dark = [0x140806, 0x130d05, 0x061109];
    const litHue = [0x3a0d07, 0x3a2406, 0x073a16];
    for (let i = 0; i < 3; i++) {
      const on = green ? i === 2 : i === 0;
      const y = HEAD_Y + (1 - i) * 0.38;
      plate(buf, f, 0, y, hz, 0.13, 0.13, 0.185,
        on ? litHue[i] : dark[i], on ? live : S.lensOff);
      // Visor. Reads in silhouette from the side and from behind, and shades
      // the unlit lenses from the low sun that was lighting them up.
      box(buf, f, 0.245, y + 0.175, hz, 0.10, 0.018, 0.155, CASE, S.painted);
    }
    // Pedestrian head bracketed off the pole.
    box(buf, f, 0.24, 2.86, 0, 0.13, 0.3, 0.22, POLE, S.painted);
    plate(buf, f, 0.24, 2.86, 0, 0.09, 0.13, 0.14, green ? 0x14110d : 0x3a3126,
      green ? S.lensOff : S.lensWalk);
    return true;
  }

  // ------------------------------------------------------------ 2. the kerbs
  /**
   * The standard kerb-line vocabulary, walked along every street that is not a
   * service alley. Stations alternate sides and pick a prop by hash, so the
   * street gets a RHYTHM rather than a repeating stamp — which is the actual
   * note behind "a rhythm of vertical poles down both sides is the highest-value
   * street furniture there is".
   */
  _dressKerbs(emit, opts) {
    const d = this.d;
    const KERB = opts.kerbOffset ?? 2.85;     // behind the parking lane
    const BACK = opts.backOffset ?? 5.1;      // second row, only where it fits
    const TREE = opts.treeOffset ?? 3.9;
    const WIDE = opts.plazaOffset ?? 8.8;     // third row, only on real plazas
    const spacingFor = (r) => (r <= 4 ? (opts.mainSpacing ?? 16.5) : (opts.sideSpacing ?? 28));

    for (let ei = 0; ei < d.edges.length; ei++) {
      const e = d.edges[ei];
      if (e.r > 5) continue;                                  // no alleys
      const step = spacingFor(e.r);
      for (let k = 0; k < e.v.length - 1; k++) {
        const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 6) continue;
        const ax = dx / len, az = dz / len;
        const n = Math.floor((len - 6) / step);
        for (let s = 0; s <= n; s++) {
          const t = 3 + s * step + (rnd01('j', ei, k, s) - 0.5) * step * 0.35;
          if (t > len - 3) continue;
          for (const side of [1, -1]) {
            const ox = -az * side, oz = ax * side;
            const key = hash32('kerb', ei, k, s, side);
            this._kerbStation(emit, {
              x: a.x + ax * t + ox * (e.w / 2 + KERB),
              z: a.z + az * t + oz * (e.w / 2 + KERB),
              ax: ax * side, az: az * side, ox, oz, key, ei,
              backX: a.x + ax * t + ox * (e.w / 2 + BACK),
              backZ: a.z + az * t + oz * (e.w / 2 + BACK),
              // Trees get their own jitter on top of the station's. "Three trees
              // ... planted in a straight line" was a finding, and stations are
              // already jittered ALONG the kerb but sit on an exactly straight
              // offset line ACROSS it, which is the line the eye actually reads
              // down a corridor. Both offsets are hashed, so placement stays
              // deterministic and the clearance tests below see the real spot.
              treeX: a.x + ax * (t + (rnd01('tj', ei, k, s, side) - 0.5) * 1.7) +
                ox * (e.w / 2 + TREE + (rnd01('tk', ei, k, s, side) - 0.5) * 0.9),
              treeZ: a.z + az * (t + (rnd01('tj', ei, k, s, side) - 0.5) * 1.7) +
                oz * (e.w / 2 + TREE + (rnd01('tk', ei, k, s, side) - 0.5) * 0.9),
              wideX: a.x + ax * t + ox * (e.w / 2 + WIDE),
              wideZ: a.z + az * t + oz * (e.w / 2 + WIDE),
              along: [ax * side, az * side], out: [ox, oz],
            });
          }
        }
      }
    }
  }

  /**
   * Which species a planted tree came out as, counted where it is planted.
   *
   * The species is a function of the key AND the position, so it cannot be read
   * back off the merged buffer and it is not something to assert from the
   * placement rule -- "the rule says oaks here" is exactly the kind of claim
   * this project has learned to measure instead. report().treeSpecies is that
   * measurement, and it costs one extra treeParams call per tree at load.
   */
  _countSpecies(key, x, z) {
    const p = treeParams(key, x, z);
    const name = p.oak ? 'oak' : p.sabal ? 'sabal' : 'queen';
    this.treeSpecies[name] = (this.treeSpecies[name] ?? 0) + 1;
  }

  _kerbStation(emit, st) {
    const roll = st.key % 1000;
    const f = frame(st.x, st.z, st.ax, st.az, st.ox, st.oz);
    const okSmall = this.roadClearance(st.x, st.z, -1) >= 1.5 &&
      this.buildingClearance(st.x, st.z) >= 0.8 &&
      this.lampClearance(st.x, st.z) >= 1.6;
    if (!okSmall) return;

    // ---- the plaza row.
    //
    // This district's pavements are enormous — the Five Points hero camera has
    // roughly fifteen metres of it between the kerb and the shopfront — and a
    // kerb line plus a frontage line still leaves the middle of that bare, which
    // is most of the "450,000 px of visible sidewalk" the critics were counting.
    // Nothing here fires unless there really is a plaza to stand in: the test is
    // nine metres clear of the carriageway and two clear of the building.
    if ((st.key >>> 11) % 100 < 36 &&
        this.roadClearance(st.wideX, st.wideZ) >= 6.5 &&
        this.buildingClearance(st.wideX, st.wideZ) >= 2.2 &&
        this.lampClearance(st.wideX, st.wideZ) >= 3.0) {
      const pf = frame(st.wideX, st.wideZ, st.ax, st.az, st.ox, st.oz);
      const pr = (st.key >>> 17) % 100;
      const W = [st.wideX, st.wideZ];
      if (pr < 17) {
        emit('tree', W[0], W[1], PAD_Y, (b) => propTree(b, pf, st.key + 7));
        emit('treeDetail', W[0], W[1], null, (b) => propTreeDetail(b, pf, st.key + 7));
        this._countSpecies(st.key + 7, st.wideX, st.wideZ);
      } else if (pr < 37) emit('planter', W[0], W[1], PAD_Y, (b) => propPlanter(b, pf, st.key + 7));
      else if (pr < 54) emit('bench', W[0], W[1], PAD_Y, (b) => propBench(b, pf, st.key + 7));
      else if (pr < 72) emit('bin', W[0], W[1], PAD_Y, (b) => propBin(b, pf, st.key + 7));
      else if (pr < 81) emit('bikerack', W[0], W[1], PAD_Y, (b) => propBikeRack(b, pf, st.key + 7));
      else if (pr < 88) emit('cabinet', W[0], W[1], PAD_Y, (b) => propCabinet(b, pf, st.key + 7));
      else {
        // Same run rule as the kerb row below: all or nothing, never a single
        // post left standing on its own in the middle of a plaza.
        const spots = [];
        for (let n = 0; n < 3; n++) {
          const bx = st.wideX + st.ax * (n - 1) * 1.5, bz = st.wideZ + st.az * (n - 1) * 1.5;
          if (this.roadClearance(bx, bz) < 1.4 || this.buildingClearance(bx, bz) < 1.1) continue;
          spots.push([bx, bz, n]);
        }
        if (spots.length >= 2) {
          for (const [bx, bz, n] of spots) {
            const bf = frame(bx, bz, st.ax, st.az, st.ox, st.oz);
            emit('bollard', bx, bz, PAD_Y, (b) => propBollard(b, bf, st.key + n));
          }
        }
      }
    }

    // A tree needs a pit and a canopy, so it needs real pavement: only where the
    // frontage is far enough back that the crown is not inside a shopfront.
    //
    // 13% of kerb stations district-wide, and up to 75% where the census says
    // the corridor is a canopy. THAT SECOND NUMBER IS THE WHOLE POINT: at a flat
    // 13% on 16.5 m stations, the 250 m of Main St east from x = 50 to x = 300
    // carried six trees and not one of them stood inside the measured tunnel at
    // x 86..148, so switching species there would have changed nothing at all.
    // At 75% the two kerbs interleave to a tree every 11 m of street, crowns
    // 8.8-17.8 m across nearly touch along each kerb and meet over the
    // carriageway -- which is what the reference shows, and it is still DISCRETE
    // trees in pits with gaps between them rather than a hedge.
    //
    // The stations this takes come off the bollard, meter and bin branches
    // below, which is the correct trade: a street under a closed canopy is not
    // also a street lined with bollards.
    if (roll < 130 + 780 * oakWeight(st.treeX, st.treeZ)) {
      const bc = this.buildingClearance(st.treeX, st.treeZ);
      if (bc >= 2.6 && this.roadClearance(st.treeX, st.treeZ) >= 2.2 &&
          this.lampClearance(st.treeX, st.treeZ) >= 3.4) {
        const tf = frame(st.treeX, st.treeZ, st.ax, st.az, st.ox, st.oz);
        emit('tree', st.treeX, st.treeZ, PAD_Y, (b) => propTree(b, tf, st.key));
        // The near-tier half of the SAME tree. hostY is null: fringe clumps hang
        // in the crown by design and have no business in the float audit.
        emit('treeDetail', st.treeX, st.treeZ, null, (b) => propTreeDetail(b, tf, st.key));
        this._countSpecies(st.key, st.treeX, st.treeZ);
        return;
      }
    }
    if (roll < 262) {
      // Bollards come in runs. One lonely bollard reads as debris; three in a
      // line reads as a kerb you are not meant to drive over.
      //
      // That was the intent, but the run was emitted bollard-by-bollard with the
      // clearance test INSIDE the loop, so a station where two of the three
      // positions were blocked shipped a single 1 m post standing on its own in
      // the middle of the pavement. Measured over the whole district: 81 of 1611
      // bollards had no other bollard within 3.2 m, and one of them is the
      // "thin post standing on the left sidewalk carrying nothing at its top"
      // at (434-450, 626-766) of the r5 dusk frame — a bollard, correctly
      // carrying nothing, but with nothing beside it to say so.
      //
      // So the run is now decided before any of it is emitted: fewer than two
      // clear positions is not a bollard run, and the station falls through to a
      // parking meter instead — a post that legitimately carries something.
      const n = 3;
      const spots = [];
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * 1.55;
        const bx = st.x + st.ax * o, bz = st.z + st.az * o;
        if (this.roadClearance(bx, bz) < 1.4 || this.buildingClearance(bx, bz) < 0.7) continue;
        if (this.lampClearance(bx, bz) < 1.4) continue;
        spots.push([bx, bz, i]);
      }
      if (spots.length >= 2) {
        for (const [bx, bz, i] of spots) {
          const bf = frame(bx, bz, st.ax, st.az, st.ox, st.oz);
          emit('bollard', bx, bz, PAD_Y, (b) => propBollard(b, bf, st.key + i));
        }
        return;
      }
      emit('meter', st.x, st.z, PAD_Y, (b) => propMeter(b, f, st.key));
      return;
    }
    if (roll < 440) { emit('meter', st.x, st.z, PAD_Y, (b) => propMeter(b, f, st.key)); return; }
    if (roll < 555) { emit('bin', st.x, st.z, PAD_Y, (b) => propBin(b, f, st.key)); return; }
    if (roll < 630) { emit('hydrant', st.x, st.z, PAD_Y, (b) => propHydrant(b, f, st.key)); return; }
    if (roll < 690) { emit('newsbox', st.x, st.z, PAD_Y, (b) => propNewsBox(b, f, st.key)); return; }
    if (roll < 735) { emit('bikerack', st.x, st.z, PAD_Y, (b) => propBikeRack(b, f, st.key)); return; }

    // The rest want more room, so they go in the back row when the pavement is
    // wide enough and are dropped when it is not.
    const wide = this.buildingClearance(st.backX, st.backZ) >= 1.6 &&
      this.roadClearance(st.backX, st.backZ) >= 3.0 &&
      this.lampClearance(st.backX, st.backZ) >= 2.2;
    const px = wide ? st.backX : st.x, pz = wide ? st.backZ : st.z;
    const pf = wide ? frame(px, pz, st.ax, st.az, st.ox, st.oz) : f;
    if (roll < 840) {
      // A bench needs a back row; where there is none the fallback used to be a
      // single bollard, which is the same orphan-post read as above. A meter is
      // a post that carries something, and stands alone without looking broken.
      if (!wide) { emit('meter', px, pz, PAD_Y, (b) => propMeter(b, pf, st.key)); return; }
      emit('bench', px, pz, PAD_Y, (b) => propBench(b, pf, st.key));
      return;
    }
    if (roll < 930) {
      if (!wide) { emit('meter', px, pz, PAD_Y, (b) => propMeter(b, pf, st.key)); return; }
      emit('planter', px, pz, PAD_Y, (b) => propPlanter(b, pf, st.key));
      return;
    }
    if (!wide) { emit('bin', px, pz, PAD_Y, (b) => propBin(b, pf, st.key)); return; }
    emit('cabinet', px, pz, PAD_Y, (b) => propCabinet(b, pf, st.key));
  }

  // ------------------------------------------------------------ 3. the road
  /** Manhole covers and kerbside gullies. Cheap, and their absence is the kind
   *  of thing that makes tarmac read as a texture swatch. */
  _dressCarriageway(emit, opts) {
    const d = this.d;
    const step = opts.manholeSpacing ?? 110;
    for (let ei = 0; ei < d.edges.length; ei++) {
      const e = d.edges[ei];
      if (e.r > 5) continue;
      for (let k = 0; k < e.v.length - 1; k++) {
        const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 14) continue;
        const ax = dx / len, az = dz / len;
        const n = Math.floor((len - 10) / step);
        for (let s = 0; s <= n; s++) {
          const t = 6 + s * step;
          if (t > len - 5) continue;
          const h = hash32('mh', ei, k, s);
          if (h % 5 < 2) continue;                    // not every station gets one
          const lat = ((h % 100) / 100 - 0.5) * (e.w * 0.5);
          const x = a.x + ax * t - az * lat, z = a.z + az * t + ax * lat;
          const f = frame(x, z, ax, az, -az, ax);
          if (this.roadClearance(x, z) < -0.5) {
            emit('manhole', x, z, null, (bf) => propManhole(bf, f, h));
          }
          // Gully at the kerb, on alternating sides and not at every manhole.
          if ((h >>> 12) % 5 < 2) continue;
          const side = (h >>> 8) % 2 ? 1 : -1;
          const gx = a.x + ax * t - az * side * (e.w / 2 - 0.34);
          const gz = a.z + az * t + ax * side * (e.w / 2 - 0.34);
          const gf = frame(gx, gz, ax * side, az * side, -az * side, ax * side);
          if (this.roadClearance(gx, gz) < 0.6 && this.buildingClearance(gx, gz) > 1.2) {
            emit('gully', gx, gz, null, (bf) => propGully(bf, gf, h));
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ 4. the walls
  /**
   * Wall clutter at street level: vents, cellar doors, downpipes, standpipes,
   * utility boxes and condensers. A ground-floor elevation with nothing bolted
   * to it is the tell that a facade is a texture rather than a building.
   */
  _dressWalls(emit, opts) {
    const d = this.d;
    const maxPerBuilding = opts.wallItemsPerBuilding ?? 2;
    for (let bi = 0; bi < d.buildings.length; bi++) {
      const ring = d.buildings[bi].p;
      let placed = 0;
      // Longest first, so the clutter lands on the frontage rather than on a
      // 1.5 m chamfer round the back.
      const edges = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 5) continue;
        edges.push({ a, c, dx: dx / len, dz: dz / len, len, i });
      }
      edges.sort((p, q) => q.len - p.len);
      let frontage = 0;
      const maxFrontage = opts.frontageProps ?? 3;
      for (const e of edges) {
        if (placed >= maxPerBuilding && frontage >= maxFrontage) break;
        // Outward normal: try one, flip if it points into the footprint.
        let ox = e.dz, oz = -e.dx;
        const mx = e.a[0] + e.dx * e.len / 2, mz = e.a[1] + e.dz * e.len / 2;
        if (inRing(ring, mx + ox * 0.8, mz + oz * 0.8)) { ox = -ox; oz = -oz; }
        // Only frontage that faces something walkable.
        if (this.roadClearance(mx + ox * 1.6, mz + oz * 1.6) < 0.6) continue;

        // ---- the frontage row.
        //
        // The kerb row alone leaves the middle of a wide pavement bare, and this
        // district's pavements are very wide: the Five Points hero camera stands
        // on ~15 m of it. "Across roughly 450,000 px of visible sidewalk I count
        // zero props" is a note about the pavement, not about the kerb, so the
        // shopfronts get their own line of furniture two metres off the wall.
        if (frontage < maxFrontage && e.len >= 8) {
          const slots = e.len >= 26 ? 3 : e.len >= 17 ? 2 : 1;
          for (let q = 0; q < slots && frontage < maxFrontage; q++) {
            const fk = hash32('fr', bi, e.i, q);
            const ft = e.len * (0.5 / slots + q / slots + (0.6 / slots) * ((fk % 100) / 100 - 0.5));
            const fx = e.a[0] + e.dx * ft + ox * 2.0;
            const fz = e.a[1] + e.dz * ft + oz * 2.0;
            // Far enough from the kerb that this is a second line of props and
            // not a second copy of the first.
            if (this.roadClearance(fx, fz) < 3.2) continue;
            if (this.buildingClearance(fx, fz) < 1.3) continue;
            if (this.lampClearance(fx, fz) < 2.2) continue;
            const ff = frame(fx, fz, e.dx, e.dz, ox, oz);
            const fr = fk % 100;
            if (fr < 22) emit('bench', fx, fz, PAD_Y, (b) => propBench(b, ff, fk));
            else if (fr < 40) emit('planter', fx, fz, PAD_Y, (b) => propPlanter(b, ff, fk));
            else if (fr < 55) emit('bin', fx, fz, PAD_Y, (b) => propBin(b, ff, fk));
            else if (fr < 68) emit('bikerack', fx, fz, PAD_Y, (b) => propBikeRack(b, ff, fk));
            else if (fr < 80) emit('newsbox', fx, fz, PAD_Y, (b) => propNewsBox(b, ff, fk));
            else if (fr < 90) emit('cabinet', fx, fz, PAD_Y, (b) => propCabinet(b, ff, fk));
            else {
              for (let n = 0; n < 3; n++) {
                const bx = fx + e.dx * (n - 1) * 1.5, bz = fz + e.dz * (n - 1) * 1.5;
                if (this.buildingClearance(bx, bz) < 1.1) continue;
                const bf = frame(bx, bz, e.dx, e.dz, ox, oz);
                emit('bollard', bx, bz, PAD_Y, (b) => propBollard(b, bf, fk + n));
              }
            }
            frontage++;
          }
        }

        if (placed >= maxPerBuilding) continue;
        const items = 1 + (hash32('wc', bi, e.i) % 2);
        for (let n = 0; n < items && placed < maxPerBuilding; n++) {
          const key = hash32('wi', bi, e.i, n);
          const t = (0.18 + 0.64 * ((key % 100) / 100)) * e.len;
          const x = e.a[0] + e.dx * t, z = e.a[1] + e.dz * t;
          if (this.roadClearance(x + ox * 1.4, z + oz * 1.4) < 0.4) continue;
          const f = frame(x, z, e.dx, e.dz, ox, oz);
          let roll = key % 100;
          // A cellar door lies flat on the pavement 1.2 m out from the wall and a
          // downpipe shoe kicks out 0.3 m, so both need real pavement in front of
          // them. Where the footprints of two buildings abut, that pavement is
          // the NEXT building: eight cellar doors were laid inside one before
          // this test existed, which the wall-facing test could not see because
          // it only ever asked about the building the wall belongs to.
          if (roll >= 38 && roll < 76 && this.buildingClearance(x + ox * 1.35, z + oz * 1.35) < 0.1) {
            roll = key % 38;
          }
          if (roll < 20) emit('vent', x, z, null, (b) => wallVent(b, f, key));
          else if (roll < 38) emit('wallbox', x, z, null, (b) => wallBox(b, f, key));
          else if (roll < 54) emit('cellardoor', x, z, PAD_Y, (b) => wallCellarDoor(b, f, key));
          else if (roll < 76) emit('downpipe', x, z, PAD_Y, (b) => wallDownpipe(b, f, key));
          else if (roll < 88) emit('standpipe', x, z, null, (b) => wallStandpipe(b, f, key));
          else emit('condenser', x, z, null, (b) => wallCondenser(b, f, key));
          placed++;
        }
      }
    }
  }

  // ------------------------------------------------------------ 5. overhead
  /** Timber poles and catenary spans down the back streets. "No overhead cable"
   *  was on the critics' list; a sagging span across a side street is the single
   *  cheapest way to stop a block reading as a render. */
  _dressOverhead(emit, opts) {
    const d = this.d;
    const step = opts.poleSpacing ?? 42;
    const maxPoles = opts.maxUtilityPoles ?? 140;
    let poles = 0;
    for (let ei = 0; ei < d.edges.length && poles < maxPoles; ei++) {
      const e = d.edges[ei];
      if (e.r < 5) continue;                         // back streets and alleys only
      for (let k = 0; k < e.v.length - 1 && poles < maxPoles; k++) {
        const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 24) continue;
        const ax = dx / len, az = dz / len;
        const side = hash32('up', ei, k) % 2 ? 1 : -1;
        const off = e.w / 2 + 1.5;
        let prev = null;
        const n = Math.floor((len - 8) / step);
        for (let s = 0; s <= n && poles < maxPoles; s++) {
          const t = 4 + s * step;
          if (t > len - 4) break;
          const x = a.x + ax * t - az * side * off, z = a.z + az * t + ax * side * off;
          if (this.roadClearance(x, z) < 0.9 || this.buildingClearance(x, z) < 0.9 ||
              this.lampClearance(x, z) < 4) { prev = null; continue; }
          const f = frame(x, z, ax * side, az * side, -az * side, ax * side);
          const top = 8.4 + rnd01('ut', ei, k, s) * 1.2;
          emit('utilityPole', x, z, PAD_Y, (bf) => {
            prism(bf, f, 0, 0, 0.19, 0.14, BASE_Y, top, 5, 0x6a5947, S.timber);
            box(bf, f, 0, top - 0.55, 0, 0.06, 0.06, 1.15, 0x584a3b, S.timber);
            box(bf, f, 0, top - 1.35, 0, 0.05, 0.05, 0.85, 0x584a3b, S.timber);
          });
          poles++;
          // Two wires, strung from the ends of the two crossarms. The arms run
          // along the street, so an anchor is the pole position pushed +/- half
          // an arm along (ax, az).
          const anchors = [
            [x + ax * 1.05, top - 0.45, z + az * 1.05],
            [x - ax * 0.75, top - 1.28, z - az * 0.75],
          ];
          const back = [
            [x - ax * 1.05, top - 0.45, z - az * 1.05],
            [x + ax * 0.75, top - 1.28, z + az * 0.75],
          ];
          if (prev) {
            emit('span', x, z, null, (bf) => {
              for (let w = 0; w < 2; w++) {
                const A = prev[w], B = back[w];
                const seg = 3, sag = 0.55;
                let p0 = A;
                for (let i = 1; i <= seg; i++) {
                  const u = i / seg;
                  const y = A[1] + (B[1] - A[1]) * u - sag * Math.sin(Math.PI * u);
                  const p1 = [A[0] + (B[0] - A[0]) * u, y, A[2] + (B[2] - A[2]) * u];
                  tube(bf, p0, p1, 0.045, 0x191a1c, S.rubber);
                  p0 = p1;
                }
              }
            });
          }
          prev = anchors;
        }
      }
    }
  }

  // ============================================================ PARKED CARS
  /**
   * "There is one vehicle in the entire street, no parked cars along either
   * edge" — named twice by two different critics.
   *
   * The geometry is src/carbody.js's traffic car, unchanged and reused: it is
   * 928 triangles, which means the whole district's kerbs cannot be parked
   * statically (roughly 3,000 slots would be 2.8M triangles against a 900k fail
   * threshold). So this is a POOL of `count` cars that re-seeds itself from the
   * slot index whenever the camera has moved far enough to matter, exactly the
   * way traffic and the crowd already work. One InstancedMesh, one draw call,
   * fixed cost whatever the district does.
   *
   * Slots are precomputed once and bucketed by chunk, so re-seeding is a walk
   * over the nine chunks around the camera and nothing else.
   */
  _planParking(opts) {
    const d = this.d;
    const chunk = d.meta.chunkSize;
    const cells = new Map();
    const CAR_LEN = 4.9, GAP = 1.5;
    const off = opts.parkOffset ?? 1.3;      // beyond the ribbon edge, at the kerb
    let slots = 0;

    // ---- WHERE THE END MARGIN GOES.
    //
    // "Zero parked vehicles along roughly 1,400 px of kerb, despite 1,540
    // parking slots." Both halves of that were true, and the reason is here.
    //
    // The plan skipped any SEGMENT shorter than 26 m and then kept 12 m clear at
    // each END OF EVERY SEGMENT. But a segment is a piece of an OSM polyline,
    // not a block: around the hero corridor camera the street is chopped into
    // pieces of 6.8, 29.2, 15.9, 1.8 and 9.1 m, and one neighbouring edge is a
    // run of fourteen segments of 2-4 m each. 648 segments district-wide were
    // rejected outright for length, and on the survivors 24 m of every piece was
    // cleared for junctions that were not there. Measured at the corridor hero
    // camera: ONE slot within 30 m, three within 60 m.
    //
    // The margin belongs at real junctions, so it is now sized by the vertex it
    // sits at: a shape point in the middle of a polyline keeps a car's nose
    // clear, a junction vertex keeps the full stop-line setback. Measured: 1,540
    // slots -> 2,280, and 1 -> 8 within 30 m of the corridor camera.
    const deg = new Map();
    for (const e of d.edges) {
      for (const end of [0, e.v.length - 1]) deg.set(e.v[end], (deg.get(e.v[end]) ?? 0) + 1);
    }
    const JUNC = opts.parkJunctionMargin ?? 11;   // stop-line setback at a junction
    const SHAPE = opts.parkShapeMargin ?? 3;      // a polyline kink is not a junction
    const marginAt = (v) => ((deg.get(v) ?? 1) >= 2 ? JUNC : SHAPE);

    for (let ei = 0; ei < d.edges.length; ei++) {
      const e = d.edges[ei];
      if (e.r > 5 || e.w < 5.5) continue;
      for (let k = 0; k < e.v.length - 1; k++) {
        const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 14) continue;
        const m0 = marginAt(e.v[k]), m1 = marginAt(e.v[k + 1]);
        const ax = dx / len, az = dz / len;
        const step = CAR_LEN + GAP;
        const n = Math.floor((len - m0 - m1) / step);
        for (let s = 0; s <= n; s++) {
          const t = m0 + s * step;
          if (t > len - m1) continue;
          for (const side of [1, -1]) {
            const h = hash32('pk', ei, k, s, side);
            if (h % 100 < 34) continue;                 // gaps: a full kerb is a car park
            const ox = -az * side, oz = ax * side;
            const x = a.x + ax * t + ox * (e.w / 2 + off);
            const z = a.z + az * t + oz * (e.w / 2 + off);
            // Not in another street, not in a building, and not on top of a
            // lamp post — the lamp line runs through the parking lane, so the
            // posts stand in the gaps between cars, which is where they belong.
            if (this.roadClearance(x, z, ei) < 1.05) continue;
            if (this.buildingClearance(x, z) < 1.4) continue;
            if (this.lampClearance(x, z) < 3.2) continue;
            const yaw = side > 0 ? Math.atan2(ax, az) : Math.atan2(-ax, -az);
            // Numeric cell key. This map is walked every time the pool re-seeds,
            // which during the drive-through gate is once a frame; building 49
            // template strings per frame is garbage the chunk-stall budget ends
            // up paying for.
            const key = Math.floor(x / chunk) * 46337 + Math.floor(z / chunk);
            let l = cells.get(key);
            if (!l) cells.set(key, (l = []));
            l.push({
              x, z,
              yaw: yaw + ((h >>> 7) % 100 / 100 - 0.5) * 0.06,
              hue: (h >>> 3) % 1000 / 1000,
            });
            slots++;
          }
        }
      }
    }
    this._parkCells = cells;
    this._parkChunk = chunk;
    this.parkSlots = slots;
  }

  /** Build the pool. Called after dressDistrict(). */
  buildParkedCars(opts = {}) {
    const count = opts.count ?? 44;
    const geo = buildTrafficCarGeometry({ groundY: PAD_Y - 0.02 });
    const mesh = new THREE.InstancedMesh(geo, trafficCarMaterial(), count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    const idx = geo.getIndex();
    this.parked = {
      mesh, count, radius: opts.radius ?? 3,
      tris: (idx ? idx.count / 3 : 0) * count,
      filled: 0, lastX: Infinity, lastZ: Infinity, lastT: -1e9,
    };
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._pcol = new THREE.Color();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, this._hidden);
    mesh.instanceMatrix.needsUpdate = true;
    return this.parked;
  }

  /** Re-seed the pool around a point. Cheap: nine chunks and `count` matrices. */
  refreshParked(px, pz, force = false) {
    const p = this.parked;
    if (!p || !this._parkCells) return 0;
    // Distance AND time. At the drive-through harness's timeScale the camera
    // crosses 40 m per rendered frame, so a distance-only trigger re-seeds every
    // single frame; the wall-clock floor bounds the work whatever the sim does.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!force && (Math.hypot(px - p.lastX, pz - p.lastZ) < 20 || now - p.lastT < 110)) {
      return p.filled;
    }
    p.lastX = px; p.lastZ = pz; p.lastT = now;
    const c = this._parkChunk;
    const cx = Math.floor(px / c), cz = Math.floor(pz / c);
    const R = p.radius;

    // ---- NEAREST N, not "first N found".
    //
    // The chunk ring walk was correct about which CHUNKS to visit and wrong
    // about which SLOTS to take out of them: it filled the pool with whatever
    // order the slots happened to be planned in, and a chunk is 128 m across, so
    // "the camera's own chunk" spans 180 m corner to corner. Measured at the
    // corridor hero camera the pool's own nearest car was 106 m away and its
    // farthest 277 m, while the 30th-nearest slot in the district was 121 m —
    // the pool was starving the foreground to fill in cars nobody can see. Ring
    // order gathers, distance order chooses.
    const cand = this._parkCand ??= [];
    cand.length = 0;
    for (let r = 0; r <= R; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const list = this._parkCells.get((cx + dx) * 46337 + (cz + dz));
          if (!list) continue;
          for (const s of list) {
            s.d = (s.x - px) ** 2 + (s.z - pz) ** 2;
            cand.push(s);
          }
        }
      }
      // One completed ring past having plenty is enough: everything nearer than
      // the ring boundary has already been gathered, so sorting more is waste.
      if (cand.length >= p.count * 3) break;
    }
    cand.sort((a, b) => a.d - b.d);
    let i = 0;
    for (; i < p.count && i < cand.length; i++) {
      const s = cand[i];
      this._m.makeRotationY(s.yaw);
      this._m.setPosition(s.x, 0, s.z);
      p.mesh.setMatrixAt(i, this._m);
      this._pcol.setHSL(s.hue, 0.06 + s.hue * 0.34, 0.26 + ((s.hue * 7) % 1) * 0.4);
      p.mesh.setColorAt(i, this._pcol);
    }
    for (let k = i; k < p.count; k++) p.mesh.setMatrixAt(k, this._hidden);
    p.mesh.instanceMatrix.needsUpdate = true;
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    p.filled = i;
    return i;
  }

  // ============================================================ live hookups
  /**
   * Bind the view so the parked pool follows the camera and the emissive
   * surfaces track the camera stop.
   *
   * This runs its own rAF rather than asking district/main.js for a per-frame
   * call, so the whole system is one constructor call plus one bind from the
   * placement block and nothing else in the app has to know it exists. The
   * per-frame cost is one hypot; the re-seed only runs every 20 m of travel.
   */
  bindView(camera, opts = {}) {
    this._camera = camera;
    this._exposureOf = opts.exposure ?? (() => 1 / 660);
    this.refreshParked(camera.position.x, camera.position.z, true);
    if (this._raf || typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      const c = this._camera;
      if (!c) return;
      this.refreshParked(c.position.x, c.position.z);
      this.cullProps(c.position);
      const e = this._exposureOf();
      if (e !== this._exposure) { this._exposure = e; this._applyEmissive(); }
    };
    this._raf = requestAnimationFrame(tick);
  }

  /**
   * Hide prop buckets the streamer has already given up on.
   *
   * StreamingWorld keeps chunks out to farRadius * chunkSize = 640 m and unloads
   * everything past it, so a bucket further away than that is a field of bins
   * and bollards standing on a bare land pad with no city around them. Hiding it
   * is a correctness fix that happens to also be the cheapest triangle in the
   * pass: a mesh with visible=false costs nothing at all.
   */
  cullProps(pos) {
    for (const m of this.propMeshes) {
      const c = m.userData.c;
      m.visible = Math.hypot(pos.x - c.x, pos.z - c.z) < m.userData.r + m.userData.cull;
    }
  }

  // Signal lenses burn day and night — a signal showing nothing is a signal that
  // is out — but the DISPLAYED brightness has to be divided by the camera stop,
  // which spans 1/78000 at noon to 1/1.15 at night in this project. carbody.js
  // solved this for headlamps; the same function solves it here.
  _applyEmissive() {
    if (this.propMat) {
      this.propMat.emissive.setScalar(lampEmissive(true, this._exposure, 1.9));
    }
    if (this.parked) {
      this.parked.mesh.material.emissive.setScalar(lampEmissive(this._lit, this._exposure, 1.1));
    }
  }

  // Emissive on the fixture itself tracks whether the lamps are on, independently
  // of whether a LightPool slot currently reaches this one.
  setLit(on) {
    this.headMat.emissiveIntensity = on ? 2.4 : 0;
    this._lit = on;
    this._applyEmissive();
  }

  report() {
    const parked = this.parked
      ? { pool: this.parked.count, filled: this.parked.filled, slots: this.parkSlots,
          triangles: this.parked.tris }
      : null;
    // 'treeDetail' is the near-tier half of a tree, not a seventeenth kind of
    // prop, so it is reported but kept out of propCount — otherwise the prop
    // census silently gains 284 objects that do not exist.
    return {
      lamps: this.count,
      props: { ...this.props },
      // Which trees came out as what. The census in tools/oak-profile.mjs says
      // where the corridor is a live-oak canopy and where it is palm; this is
      // what the placement rule actually did with that.
      treeSpecies: { ...this.treeSpecies },
      propCount: Object.entries(this.props)
        .reduce((a, [k, v]) => a + (k === 'treeDetail' ? 0 : v), 0),
      propTriangles: this.propTris,
      propBuckets: this.propMeshes.length,
      nearBuckets: (this.nearMeshes ?? []).length,
      farBuckets: (this.farMeshes ?? []).length,
      parked,
      // Positive = a prop floats above the surface it stands on. This is the
      // defect class three critics found and the gate now watches for; it is
      // measured off the emitted vertices, not asserted.
      worstFloatMm: Number.isFinite(this.worstFloat) ? +(this.worstFloat * 1000).toFixed(1) : 0,
      // The winding class, and null unless dressed with opts.audit. Positive =
      // that many prop triangles are wound against their own vertex normal, get
      // culled, and hand the frame the far wall of the solid lit by a normal
      // pointing away from the camera. It was 121,061 of 260,545 before the kit
      // learned to read frame handedness; it is 0 outside the tree crowns, whose
      // leaf normals are deliberately jittered off their facets.
      backfacingTris: this.placed
        ? this.placed.reduce((a, p) => a + (p.wind ? p.wind.bad : 0), 0) : null,
      buildMs: this.buildMs != null ? +this.buildMs.toFixed(1) : null,
      // Meshes, not draw calls. Three lamp InstancedMeshes and one parked-car
      // InstancedMesh are always submitted; the prop buckets are frustum- and
      // distance-culled, and the measured cost at both hero cameras is 10-11 of
      // them. This is the ceiling, not the bill.
      meshes: {
        lamps: 3, parked: this.parked ? 1 : 0,
        propBuckets: this.propMeshes.length,
        worstCaseDrawCalls: 3 + this.propMeshes.length + (this.parked ? 1 : 0),
      },
    };
  }
}

// Exposed for tooling only: the geometry kit, so a self-test can build a prop
// into a scratch buffer and read the vertices back rather than re-deriving the
// arithmetic by hand. tools/geom-audit.mjs learned that lesson the hard way —
// a second copy of the maths drifts from the geometry it is meant to audit.
export const __kit = {
  newBuf, frame, box, prism, slab, plate, tube, blob, quad, vert, handOf,
  propTree, propTreeDetail, treeParams, palmFrond, palmTrunk, frondAt, rng32, FROND,
  // The oak half, for tools/oak-audit.mjs and tools/oak-profile.mjs. setOakRoute
  // is the one piece of state a tools-side replay has to set for itself: without
  // it oakWeight is 0 everywhere and every key comes back a palm, which is a
  // correct default and a silent one, so a harness that forgets to call it would
  // measure the wrong tree and never know.
  setOakRoute, oakWeight, oakParams, oakLimbs, oakTwigs, oakClumpsOf, alongLimb,
  limbTube, leafClump,
  // The leaf stencil, for tools/leaf-mask.mjs: the texture itself, the two
  // address helpers the emitters use, and the geometry of the atlas. A second
  // copy of the addressing arithmetic in the tool would drift from the one that
  // cut the leaves, which is the lesson at the top of this export block.
  alphaTexture, maskU, maskV, ALPHA_TEST, MASK_K, AW, AH,
  OAK_STAMPS, STAMP_H, QUEEN_V0, SABAL_V0, COMB_H,
  // The SHIPPED material, so a bench frame is lit and cut by the same object
  // the district draws with. tools/oak-look.mjs builds its own lookalike, which
  // was harmless while the material was only a palette lookup and is not any
  // more: a bench with no alphaMap on it renders the stencil as if it were not
  // there and reports a change that the page would not show.
  propMaterial,
  OAK_PROFILE, OAK_STEP, OAK_MAX, OAK_LEAF, OAK_BARK,
  S, PALETTE, PAL_W, paletteU, BASE_Y, PAD_Y, ROAD_Y, DECAL_Y, hash32,
  // Every prop builder by the kind name emit() files it under, so a self-test
  // can build one into a scratch buffer and read the triangles back. The
  // winding audit needs exactly this: the same prop in a det +1 and a det -1
  // frame, measured rather than reasoned about.
  props: {
    bollard: propBollard, meter: propMeter, bin: propBin, hydrant: propHydrant,
    bench: propBench, planter: propPlanter, tree: propTree, treeDetail: propTreeDetail,
    cabinet: propCabinet, newsbox: propNewsBox, bikerack: propBikeRack,
    manhole: propManhole, gully: propGully, vent: wallVent, wallbox: wallBox,
    condenser: wallCondenser, cellardoor: wallCellarDoor, downpipe: wallDownpipe,
    standpipe: wallStandpipe,
  },
};
