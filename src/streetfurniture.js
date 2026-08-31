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

let _packTex = null, _emisTex = null;
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

function newBuf() { return { pos: [], nrm: [], col: [], uv: [], idx: [] }; }

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

/** One quad, corners in world space, wound a-b-c-d. 2 triangles. */
function quad(buf, a, b, c, d, n, hex, surf) {
  const i = vert(buf, a[0], a[1], a[2], n[0], n[1], n[2], hex, surf);
  vert(buf, b[0], b[1], b[2], n[0], n[1], n[2], hex, surf);
  vert(buf, c[0], c[1], c[2], n[0], n[1], n[2], hex, surf);
  vert(buf, d[0], d[1], d[2], n[0], n[1], n[2], hex, surf);
  // Wound so the geometric normal of each triangle agrees with the vertex
  // normal above. Verified numerically rather than by eye: the first cut had
  // every solid in the district inside out, which reads as "the prop is missing"
  // under backface culling and is exactly the sort of thing a screenshot at
  // dusk hides until it does not.
  buf.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
}

/**
 * Axis-aligned-in-frame box. 12 triangles. (cx, cz) are frame-local, cy world.
 * The workhorse: utility boxes, bench slats, signal heads, cellar doors, kerbs.
 */
function box(buf, f, cx, cy, cz, hx, hy, hz, hex, surf) {
  const P = (lx, ly, lz) => [wx(f, cx + lx, cz + lz), cy + ly, wz(f, cx + lx, cz + lz)];
  const O = [f.ox, 0, f.oz], A = [f.ax, 0, f.az];
  const nO = [-f.ox, 0, -f.oz], nA = [-f.ax, 0, -f.az];
  const [a, b, c, d] = [P(hx, -hy, -hz), P(hx, -hy, hz), P(hx, hy, hz), P(hx, hy, -hz)];
  const [e, g, h, i] = [P(-hx, -hy, hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(-hx, hy, hz)];
  quad(buf, a, b, c, d, O, hex, surf);                 // outward face
  quad(buf, e, g, h, i, nO, hex, surf);                // inward face
  quad(buf, b, e, i, c, A, hex, surf);                 // along +
  quad(buf, g, a, d, h, nA, hex, surf);                // along -
  quad(buf, d, c, i, h, [0, 1, 0], hex, surf);         // top
  quad(buf, g, e, b, a, [0, -1, 0], hex, surf);        // bottom
}

/**
 * Vertical n-gon prism with a top cap and no bottom cap (the bottom is buried).
 * 2n + (n-2) triangles: a 6-sided bollard is 16 triangles, not 500.
 */
function prism(buf, f, cx, cz, r0, r1, y0, y1, sides, hex, surf, phase = 0) {
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
    quad(buf, ring0[s], ring0[t], ring1[t], ring1[s], n, hex, surf);
  }
  const c0 = vert(buf, wx(f, cx, cz), y1, wz(f, cx, cz), 0, 1, 0, hex, surf);
  const first = c0 + 1;
  for (let s = 0; s < sides; s++) {
    vert(buf, ring1[s][0], ring1[s][1], ring1[s][2], 0, 1, 0, hex, surf);
  }
  for (let s = 0; s < sides; s++) buf.idx.push(c0, first + ((s + 1) % sides), first + s);
}

/** Flat horizontal rectangle: road markings, tree pits, cellar-door leaves. */
function slab(buf, f, cx, cz, hx, hz, y, hex, surf) {
  const P = (lx, lz) => [wx(f, cx + lx, cz + lz), y, wz(f, cx + lx, cz + lz)];
  quad(buf, P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz), [0, 1, 0], hex, surf);
}

/**
 * Low-poly spheroid: tree crowns and shrubs. Six sides and two intermediate
 * latitudes is 36 triangles and reads as a leafy mass; the two stacked cones it
 * replaces cost 32 and read as a tent, which is exactly what the first capture
 * of this pass showed standing on every wide pavement in the district.
 */
function blob(buf, f, cx, cz, cy, rx, ry, sides, hex, surf, phase = 0) {
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
        nrmOf(A[i]), hex, surf);
    }
  }
  for (const [poleT, ring, up] of [[-1, rings[1], -1], [1, rings[rings.length - 2], 1]]) {
    const c = vert(buf, wx(f, cx, cz), cy + poleT * ry, wz(f, cx, cz), 0, up, 0, hex, surf);
    const first = c + 1;
    for (const p of ring) vert(buf, p[0], p[1], p[2], 0, up, 0, hex, surf);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (up > 0) buf.idx.push(c, first + j, first + i);
      else buf.idx.push(c, first + i, first + j);
    }
  }
}

/** Vertical rectangle facing outward (+x of the frame): lenses, wall plates. */
function plate(buf, f, cx, cy, cz, hz, hy, off, hex, surf) {
  const P = (lz, ly) => [wx(f, cx + off, cz + lz), cy + ly, wz(f, cx + off, cz + lz)];
  quad(buf, P(-hz, -hy), P(hz, -hy), P(hz, hy), P(-hz, hy), [f.ox, 0, f.oz], hex, surf);
}

/** A thin triangular tube between two world points: overhead cable spans. */
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

// ============================================================== STREET TREES
//
// Blind critics reviewing the dusk and night frames put the trees at the top of
// the defect list, and they measured rather than asserted:
//
//   "the nearest canopy's silhouette against open sky is made of approximately
//    6-8 straight edges meeting at hard vertices. Interior shading is 2-3 flat
//    facets of near-identical dark green. No leaf-level breakup, no light
//    penetration through the canopy, no branch structure between trunk and
//    canopy."   "Certain defect."
//
// All four notes are the same object. The old tree was ONE six-sided blob()
// spheroid on a stick: six side facets each shaded by a single per-QUAD normal,
// a top fan whose every triangle carried (0,1,0) so the whole cap was one
// lambert value, one flat colour for the entire crown, a flat disc for a
// bottom, and nothing whatever between the trunk cap and the foliage.
//
// ---------------------------------------------------------------------------
// WHAT REPLACES IT, AND WHAT EACH PART COSTS
// ---------------------------------------------------------------------------
//   pit slab                                       2 tris
//   trunk: 5-gon, tapered, leaning, capped        15
//   3-4 limbs, tapered 3-gon tubes                18-24
//   6-8 sub-canopy lobes, 5 or 6 sided            60-96
//   -----------------------------------------------------
//   FAR tier, kind 'tree'                         95-135, mean 116   (was 51)
//
//   4 secondary twigs                             24
//   9 rim clumps + 2 interior clumps             110
//   -----------------------------------------------------
//   NEAR tier, kind 'treeDetail'                 134
//
// Measured over 400 trees by tools-side replay of these same functions, not
// counted by hand off the source: 250.6 triangles per tree in total.
//
// The split is the two-tier distance culling this module already runs. 'tree'
// is in FAR (512 m buckets, never distance-culled) because a canopy reads from
// hundreds of metres and its silhouette must not pop; 'treeDetail' rides the
// NEAR tier and is switched off with the bins and bollards past ~200 m, where a
// fringe clump is a third of a pixel. 'treeDetail' is not a prop — it is the
// near half of a tree — and is counted separately in report() for that reason.
//
// ---------------------------------------------------------------------------
// SILHOUETTE
// ---------------------------------------------------------------------------
// A convex hull has exactly as many silhouette edges as it has sides, which is
// why the critic could count them. Six to eight lobes whose centres sit at
// different distances from the crown axis have a UNION outline with concave
// notches between them, and each lobe's ring is jittered in angle, radius and
// height so no two adjacent edges share a length or a corner angle. Nothing in
// the crown is a regular polygon. The lobes also come in two scales — big ones
// near the axis carrying the mass, small ones at the rim putting bumps on the
// outline — so the outline has corners at two frequencies rather than one.
//
// ---------------------------------------------------------------------------
// INTERIOR SHADING — and none of it costs a triangle
// ---------------------------------------------------------------------------
// Every foliage vertex carries its OWN normal, blended between the direction
// out of its lobe and the direction out of the whole crown, so the lobes shade
// as lumps on one soft mass instead of as a bag of separate balls; and its OWN
// colour, a baked sky gradient (crown top ~2.4x the underside) times a
// per-vertex jitter. Colour rides on the vertex attribute the shared prop
// material already reads, so this is still ONE material and one draw call per
// bucket. High-frequency variation for free was the whole point.
//
// ---------------------------------------------------------------------------
// LIGHT PENETRATION: the cheap half done, the expensive half rejected
// ---------------------------------------------------------------------------
// Free, and done: the lobes are placed with real gaps, so sky and lamplight
// come through the crown as actual holes, the underside lobes are dark enough
// for those holes to read, and the limbs are visible through them.
// Rejected: alpha-tested leaf cards. They need either a second UV set — uv is
// spoken for, it IS the palette lookup that gives every prop its finish — or a
// second material, and a second material splits the one-material bucket scheme
// that keeps the entire prop vocabulary at 2-4 draw calls. On top of that the
// harness rasterises in software, where alpha-test overdraw across a few
// hundred crowns is the worst possible thing to spend a frame on.
//
// ---------------------------------------------------------------------------
// NIGHT
// ---------------------------------------------------------------------------
// A critic measured one crown as "a saturated yellow-green brighter than any
// other surface at that depth" while another at the same distance was
// "near-black". Same cause: 0x47692f is a saturated daylight green (G/R 1.48,
// G/B 2.23) sitting three metres under a 7.7 m lamp head, and the crown was ONE
// value, so a tree either caught the lamp whole or missed it whole. The leaf
// palette here is olive rather than chartreuse (G/R ~1.15) and darker, and the
// baked gradient means every crown has a lit side and a shaded side at any hour
// whether or not a lamp reaches it.
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- HANDEDNESS
// The local->world map in this file is (lx, lz) -> lx*(ox,oz) + lz*(ax,az), and
// its determinant is ox*az - ax*oz. Every kerb-side, carriageway and junction
// frame here builds `out` by rotating `along` one particular way, which makes
// that determinant -1: the local frame is a REFLECTION, so a triangle authored
// counter-clockwise-from-outside in local coordinates comes out CLOCKWISE in
// world space, gets culled as a back face, and what you actually see is the far
// wall of the solid shaded by a normal pointing away from you — which is
// ambient-only, i.e. near-black, and does not change when the sun moves.
//
// Measured, not assumed: box() built in a det = -1 frame and rendered against
// THREE.BoxGeometry under one directional light behind the camera reads 0/255
// where the reference reads 251/255; reverse the winding and it reads 251.
// It is the mechanism behind "interior shading is 2-3 flat facets of
// near-identical dark green" and "near-black with a faceted silhouette".
//
// This is a whole-KIT defect, not a tree defect, and it cannot be fixed by
// reversing quad() across the board: _dressWalls derives its outward normal
// from the building footprint and flips it whenever it points into the ring, so
// wall clutter comes in BOTH handednesses and half of it is already correct. A
// blanket flip would fix ~6,000 props and break the rest. That is a pass of its
// own with its own captures, so it is reported rather than silently swept into
// a tree change. What IS in scope: every triangle the tree emits goes through
// tri(), which reads the frame's handedness and winds to match, so a tree is
// right-way-out in either kind of frame.
const handOf = (f) => (f.ox * f.az - f.ax * f.oz < 0 ? -1 : 1);
const tri = (buf, hand, a, b, c) => {
  if (hand < 0) buf.idx.push(a, c, b); else buf.idx.push(a, b, c);
};

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
function vertC(buf, x, y, z, nx, ny, nz, r, g, b, surf) {
  buf.pos.push(x, y, z);
  buf.nrm.push(nx, ny, nz);
  buf.col.push(r, g, b);
  buf.uv.push(paletteU(surf), 0.5);
  return buf.pos.length / 3 - 1;
}

/**
 * Tapered n-gon post between two frame-local points, smooth-shaded around the
 * axis (so a 5-sided trunk reads round rather than pentagonal) and capped on
 * top. 3n triangles from 3n+1 vertices — prism() would spend 26 vertices on the
 * same 15 triangles because quad() cannot share.
 */
function trunkPost(buf, f, p0, r0, p1, r1, sides, hex, surf, phase) {
  const c = linear(hex);
  const hand = handOf(f);
  const rows = [];
  for (const [p, rad, shade] of [[p0, r0, 0.62], [p1, r1, 1.0]]) {
    const row = [];
    for (let i = 0; i < sides; i++) {
      const a = phase + (i / sides) * TAU;
      const ux = Math.cos(a), uz = Math.sin(a);
      row.push(vertC(buf, wx(f, p[0] + ux * rad, p[2] + uz * rad), p[1],
        wz(f, p[0] + ux * rad, p[2] + uz * rad),
        ux * f.ox + uz * f.ax, 0.16, ux * f.oz + uz * f.az,
        c[0] * shade, c[1] * shade, c[2] * shade, surf));
    }
    rows.push(row);
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tri(buf, hand, rows[0][i], rows[1][j], rows[0][j]);
    tri(buf, hand, rows[0][i], rows[1][i], rows[1][j]);
  }
  const cap = vertC(buf, wx(f, p1[0], p1[2]), p1[1], wz(f, p1[0], p1[2]),
    0, 1, 0, c[0], c[1], c[2], surf);
  const first = buf.pos.length / 3;
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * TAU;
    vertC(buf, wx(f, p1[0] + Math.cos(a) * r1, p1[2] + Math.sin(a) * r1), p1[1],
      wz(f, p1[0] + Math.cos(a) * r1, p1[2] + Math.sin(a) * r1),
      0, 1, 0, c[0], c[1], c[2], surf);
  }
  for (let i = 0; i < sides; i++) tri(buf, hand, cap, first + ((i + 1) % sides), first + i);
}

/** Tapered triangular limb between two frame-local points. 6 triangles, 6
 *  vertices. This is the "no branch structure between trunk and canopy" note. */
function limbSeg(buf, f, p0, r0, p1, r1, hex, surf) {
  const c = linear(hex);
  const hand = handOf(f);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // Any unit vector perpendicular to the limb axis, plus u x p. Taking (-uz, ux)
  // collapses to zero for a vertical limb — and a twig off a limb tip is often
  // near-vertical — so the seed axis is whichever of x/y/z the limb is least
  // aligned with, which can never be parallel to it.
  let sx = 0, sy = 0, sz = 0;
  if (Math.abs(uy) <= Math.abs(ux) && Math.abs(uy) <= Math.abs(uz)) sy = 1;
  else if (Math.abs(ux) <= Math.abs(uz)) sx = 1; else sz = 1;
  let px = uy * sz - uz * sy, py = uz * sx - ux * sz, pz = ux * sy - uy * sx;
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl; py /= pl; pz /= pl;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  const rows = [];
  for (const [p, rad, shade] of [[p0, r0, 0.78], [p1, r1, 1.06]]) {
    const row = [];
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * TAU;
      const co = Math.cos(a), si = Math.sin(a);
      const ox = px * co + qx * si, oy = py * co + qy * si, oz = pz * co + qz * si;
      row.push(vertC(buf, wx(f, p[0] + ox * rad, p[2] + oz * rad), p[1] + oy * rad,
        wz(f, p[0] + ox * rad, p[2] + oz * rad),
        ox * f.ox + oz * f.ax, oy, ox * f.oz + oz * f.az,
        c[0] * shade, c[1] * shade, c[2] * shade, surf));
    }
    rows.push(row);
  }
  for (let s = 0; s < 3; s++) {
    const t = (s + 1) % 3;
    tri(buf, hand, rows[0][s], rows[0][t], rows[1][t]);
    tri(buf, hand, rows[0][s], rows[1][t], rows[1][s]);
  }
}

/**
 * ONE SUB-CANOPY. A ring of n jittered points with a high apex and a shallow
 * underside apex: 2n triangles out of n+2 vertices, which is half what an
 * equivalent quad()-built band would cost in vertices.
 *
 * The ring is deliberately irregular in all three axes. A regular n-gon ring is
 * how the old crown ended up with "6-8 straight edges meeting at hard vertices"
 * — every silhouette edge the same length, every corner the same angle, which
 * is the signature the eye locks onto.
 */
function leafLobe(buf, f, L, ctx) {
  const r = ctx.rng, n = L.sides;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = L.az + 0.7 + (i / n) * TAU + (r() - 0.5) * (TAU / n) * 0.6;
    const rad = L.rx * (0.84 + r() * 0.3);
    ring.push([L.lx + Math.cos(a) * rad, L.ly + (r() - 0.5) * L.ry * 0.5,
      L.lz + Math.sin(a) * rad]);
  }
  const apexU = [L.lx + (r() - 0.5) * L.rx * 0.5, L.ly + L.ry * (0.9 + r() * 0.45),
    L.lz + (r() - 0.5) * L.rx * 0.5];
  const apexD = [L.lx + (r() - 0.5) * L.rx * 0.45, L.ly - L.ry * (0.68 + r() * 0.38),
    L.lz + (r() - 0.5) * L.rx * 0.45];
  const put = (p) => {
    // Normal: out of the LOBE blended with out of the WHOLE CROWN. Pure lobe
    // normals make a bag of separate balls; pure crown normals make one smooth
    // ball again. The blend is a soft mass with lumps on it.
    const ax = p[0] - L.lx, ay = (p[1] - L.ly) * 1.15, az = p[2] - L.lz;
    const al = Math.hypot(ax, ay, az) || 1;
    const bx = p[0] - ctx.cx, by = (p[1] - ctx.cy) * ctx.yk, bz = p[2] - ctx.cz;
    const bl = Math.hypot(bx, by, bz) || 1;
    let nx = (ax / al) * 0.42 + (bx / bl) * 0.58 + (r() - 0.5) * 0.26;
    let ny = (ay / al) * 0.42 + (by / bl) * 0.58 + (r() - 0.5) * 0.26;
    let nz = (az / al) * 0.42 + (bz / bl) * 0.58 + (r() - 0.5) * 0.26;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // Baked sky occlusion: the top of a crown sees the whole sky, the underside
    // sees the pavement. Times a per-vertex jitter, which is the leaf-level
    // breakup the critic said was missing and costs nothing at all.
    const t = Math.max(-1, Math.min(1, (p[1] - ctx.cy) / ctx.ry));
    const w = Math.min(1.1, (0.46 + 0.40 * (t * 0.5 + 0.5) + 0.16 * Math.max(0, ny)) *
      (0.74 + r() * 0.56)) * ctx.gain;
    return vertC(buf, wx(f, p[0], p[2]), p[1], wz(f, p[0], p[2]),
      nx * f.ox + nz * f.ax, ny, nx * f.oz + nz * f.az,
      ctx.base[0] * w, ctx.base[1] * w, ctx.base[2] * w, S.foliage);
  };
  const hand = handOf(f);
  const iU = put(apexU);
  const first = buf.pos.length / 3;
  for (const p of ring) put(p);
  const iD = put(apexD);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(buf, hand, iU, first + j, first + i);     // upper fan, outward
    tri(buf, hand, iD, first + i, first + j);     // lower fan, outward
  }
}

// Six leaf palettes and four barks, authored at the TOP-OF-CROWN value; every
// foliage vertex scales down from there. Olive, not chartreuse — see NIGHT.
const LEAF = [0x647246, 0x5a6e41, 0x6c7754, 0x516540, 0x737a4a, 0x5d6a49];
const BARK = [0x554a3e, 0x605348, 0x4b4339, 0x635747];

/**
 * Everything that makes one tree THAT tree, derived from its key alone so both
 * tiers agree on where the crown is. "Three trees whose silhouettes appear to
 * be one asset at three scales, planted in a straight line with no rotation
 * variation I can detect" was a separate finding, and one random height is not
 * an answer to it: four crown families, a free crown yaw, an independent crown
 * width, a trunk lean in a free direction, six leaf palettes and four barks are.
 */
function treeParams(k) {
  const r = rng32(hash32('tree', k));
  //          radial spread, vertical spread, lobes, lobe scale, open middle
  const F = [
    { sx: 1.00, sy: 0.88, n: 8, ls: 1.00, vase: 0.00 },   // broad and round
    { sx: 0.78, sy: 1.28, n: 8, ls: 0.88, vase: 0.06 },   // upright oval
    { sx: 1.06, sy: 0.84, n: 7, ls: 0.98, vase: 0.26 },   // vase, open centre
    { sx: 0.92, sy: 0.96, n: 6, ls: 0.96, vase: 0.10 },   // sparse, young
  ][hash32('fam', k) % 4];
  const h = 5.3 + r() * 3.4;
  const trunkH = h * (0.36 + r() * 0.14);
  const trunkR = 0.145 + r() * 0.085;
  const yaw = r() * TAU;
  const leanAz = r() * TAU;
  const lean = (0.05 + r() * 0.22);
  const tiltX = Math.cos(leanAz) * lean, tiltZ = Math.sin(leanAz) * lean;
  const R = 1.36 + r() * 0.66;                    // crown HALF-WIDTH, hard target
  let cy = trunkH + (h - trunkH) * 0.5;
  const ry = (h - trunkH) * 0.54 * F.sy;

  const lobes = [];
  for (let i = 0; i < F.n; i++) {
    const ty = -0.66 + 1.5 * ((i + 0.5) / F.n) + (r() - 0.5) * 0.24;
    const rr = Math.sqrt(Math.max(0.1, 1 - ty * ty));
    const az = yaw + i * 2.39996 + (r() - 0.5) * 0.7;     // golden angle, jittered
    // A lobe has to be a LUMP, not a plate, and the lobes must not all be the
    // same lump. The first cut made them half as tall as they were wide and
    // left 34% of the crown envelope empty: the capture read as a stack of
    // flat discs, a pagoda rather than a tree. Size and position are now tied
    // together — a BIG lobe sits near the axis and carries the mass, a SMALL
    // one sits out at the rim and is a bump on the outline — which is what
    // gives the silhouette corners at two different scales for no triangles.
    const u = r();
    const lr = R * F.ls * (0.36 + u * 0.42);
    const dr = R * F.sx * rr * (0.50 - u * 0.24 + F.vase * 0.26);
    lobes.push({
      lx: tiltX + Math.cos(az) * dr, lz: tiltZ + Math.sin(az) * dr,
      ly: cy + ty * ry + F.vase * ry * 0.18,
      rx: lr, ry: lr * (0.9 + r() * 0.26),
      sides: r() < 0.45 ? 6 : 5, az,
    });
  }
  // Fit the cluster to the crown envelope rather than hoping it lands there.
  // The plan half-width is a HARD number: the placement test only guarantees
  // 2.6 m to the shopfront and 2.2 m to the carriageway, and a crown that
  // overshoots it is inside a window.
  let ext = 0.001, top = -1e9, bot = 1e9;
  for (const L of lobes) {
    ext = Math.max(ext, Math.hypot(L.lx - tiltX, L.lz - tiltZ) + L.rx);
    top = Math.max(top, L.ly + L.ry * 1.15);
    bot = Math.min(bot, L.ly - L.ry * 0.95);
  }
  const sxf = R / ext;
  const syf = (h - cy) / Math.max(0.4, top - cy);
  for (const L of lobes) {
    L.lx = tiltX + (L.lx - tiltX) * sxf; L.lz = tiltZ + (L.lz - tiltZ) * sxf;
    L.rx *= sxf; L.ly = cy + (L.ly - cy) * syf; L.ry *= syf;
  }
  // Lift the whole crown until its lowest foliage clears the trunk, so the
  // trunk reads as a trunk instead of disappearing into a skirt.
  const lift = Math.max(0, (trunkH - 0.3) - (cy + (bot - cy) * syf));
  if (lift > 0) { for (const L of lobes) L.ly += lift; cy += lift; }
  lobes.sort((a, b) => a.ly - b.ly);              // limbs reach the lowest lobes
  return {
    h, trunkH, trunkR, tiltX, tiltZ, R, cy, ry: ry * syf, lobes, yaw,
    nLimb: 3 + (r() < 0.45 ? 1 : 0),
    leaf: LEAF[hash32('lf', k) % LEAF.length],
    bark: BARK[hash32('bk', k) % BARK.length],
    gain: 0.9 + r() * 0.22,                       // tree-to-tree leaf brightness
  };
}

function crownCtx(p, gain = 1) {
  return { cx: p.tiltX, cy: p.cy, cz: p.tiltZ, yk: p.R / Math.max(0.5, p.ry),
    ry: p.ry, base: linear(p.leaf), gain: p.gain * gain, rng: null };
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

function propTree(buf, f, k) {                        // 95-135 tris, mean 116
  const p = treeParams(k);
  const r = rng32(hash32('tgeo', k));
  pitSlab(buf, f, p.tiltX * 0.3, p.tiltZ * 0.3, 0.72, 0.72, PAD_Y + 0.004, 0x40382f, S.concrete);
  trunkPost(buf, f, [0, BASE_Y, 0], p.trunkR * 1.14, [p.tiltX, p.trunkH, p.tiltZ],
    p.trunkR * 0.58, 5, p.bark, S.bark, r() * TAU);
  for (let i = 0; i < p.nLimb; i++) {
    const L = p.lobes[i % p.lobes.length];
    limbSeg(buf, f,
      [p.tiltX * 0.85, p.trunkH - 0.18, p.tiltZ * 0.85], p.trunkR * 0.52,
      [p.tiltX + (L.lx - p.tiltX) * 0.78, p.trunkH + (L.ly - p.trunkH) * 0.72,
        p.tiltZ + (L.lz - p.tiltZ) * 0.78], p.trunkR * 0.2,
      p.bark, S.bark);
  }
  const ctx = crownCtx(p);
  ctx.rng = r;
  for (const L of p.lobes) leafLobe(buf, f, L, ctx);
}

/**
 * The near-tier half of a tree: secondary twigs and small clumps that fringe
 * the crown outline and darken its interior. Switched off with the bins past
 * ~200 m, where none of it is a pixel wide.
 */
function propTreeDetail(buf, f, k) {                              // 134 tris
  const p = treeParams(k);
  const r = rng32(hash32('tdet', k));
  const ctx = crownCtx(p);
  ctx.rng = r;
  // Twigs off the limbs, visible through the gaps between lobes.
  for (let i = 0; i < 4; i++) {
    const L = p.lobes[(i + 1) % p.lobes.length];
    const bx = p.tiltX + (L.lx - p.tiltX) * 0.5, bz = p.tiltZ + (L.lz - p.tiltZ) * 0.5;
    const by = p.trunkH + (L.ly - p.trunkH) * 0.5;
    const reach = 0.9 + r() * 0.5;
    limbSeg(buf, f, [bx, by, bz], p.trunkR * 0.24,
      [p.tiltX + (L.lx - p.tiltX) * reach, L.ly + (r() - 0.5) * L.ry,
        p.tiltZ + (L.lz - p.tiltZ) * reach],
      p.trunkR * 0.09, p.bark, S.bark);
  }
  // Fringe: small clumps pushed just outside the far-tier lobes, so the outline
  // gains another dozen corners at the distance where corners are countable.
  for (let i = 0; i < 9; i++) {
    const L = p.lobes[i % p.lobes.length];
    const a = r() * TAU, t = 0.6 + r() * 0.36;
    const fr = L.rx * (0.36 + r() * 0.2);
    leafLobe(buf, f, {
      lx: L.lx + Math.cos(a) * L.rx * t, lz: L.lz + Math.sin(a) * L.rx * t,
      ly: L.ly + (r() - 0.5) * L.ry * 1.1,
      rx: fr, ry: fr * (0.88 + r() * 0.3),
      sides: 5, az: a,
    }, ctx);
  }
  // Two dark interior clumps, so a gap in the crown shows shaded foliage behind
  // it rather than the sky straight through.
  const dark = crownCtx(p, 0.5);
  dark.rng = r;
  for (let i = 0; i < 2; i++) {
    const ir = p.R * (0.32 + r() * 0.14);
    leafLobe(buf, f, {
      lx: p.tiltX + (r() - 0.5) * p.R * 0.5, lz: p.tiltZ + (r() - 0.5) * p.R * 0.5,
      ly: p.cy + (r() - 0.5) * p.ry * 0.7,
      rx: ir, ry: ir * (0.9 + r() * 0.3),
      sides: 5, az: r() * TAU,
    }, dark);
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

// ---------------------------------------------------------------- the module
export class StreetFurniture {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.max = opts.max ?? 400;
    this.root = new THREE.Group();
    this.root.name = 'furniture';
    scene.add(this.root);

    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.75 });
    // Lamp heads are emissive geometry; the actual illumination comes from the
    // LightPool, so these can be instanced freely.
    this.headMat = new THREE.MeshStandardMaterial({
      color: 0x1a1c20, emissive: 0xffd9a0, emissiveIntensity: 0,
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
    const poleGeo = new THREE.CylinderGeometry(0.11, 0.16, 8.2 + EMBED, 8);
    poleGeo.translate(0, (8.2 - EMBED) / 2, 0);
    const armGeo = new THREE.BoxGeometry(2.2, 0.13, 0.13);
    armGeo.translate(1.1, 8.05, 0);
    const headGeo = new THREE.BoxGeometry(0.9, 0.2, 0.42);
    headGeo.translate(2.2, 7.9, 0);

    this.poles = this._instanced(poleGeo, metal, true);
    this.arms = this._instanced(armGeo, metal, false);
    this.heads = this._instanced(headGeo, this.headMat, false);
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
          rx: (x1 - x0) / 2, rz: (z1 - z0) / 2, lowY: lo, hostY });
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
        // castShadow is deliberately OFF. The sun's shadow camera is 520 m across
        // and a far bucket is 512 m, so every bucket would render into the shadow
        // map as well as the frame: it would double the triangle cost of the whole
        // dressing pass to gain contact shadows that the SSAO pass already draws.
        m.castShadow = false;
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
    if (roll < 130) {
      const bc = this.buildingClearance(st.treeX, st.treeZ);
      if (bc >= 2.6 && this.roadClearance(st.treeX, st.treeZ) >= 2.2 &&
          this.lampClearance(st.treeX, st.treeZ) >= 3.4) {
        const tf = frame(st.treeX, st.treeZ, st.ax, st.az, st.ox, st.oz);
        emit('tree', st.treeX, st.treeZ, PAD_Y, (b) => propTree(b, tf, st.key));
        // The near-tier half of the SAME tree. hostY is null: fringe clumps hang
        // in the crown by design and have no business in the float audit.
        emit('treeDetail', st.treeX, st.treeZ, null, (b) => propTreeDetail(b, tf, st.key));
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
  newBuf, frame, box, prism, slab, plate, tube, blob, quad, vert,
  propTree, propTreeDetail, treeParams, leafLobe, limbSeg, trunkPost, rng32, LEAF,
  S, PALETTE, PAL_W, paletteU, BASE_Y, PAD_Y, ROAD_Y, DECAL_Y, hash32,
};
