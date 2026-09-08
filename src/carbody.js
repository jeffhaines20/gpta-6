// Procedural car bodies.
//
// Everything here is generated in code: there are no model files in this project
// and there never will be. The player's car is a lofted shell rather than a stack
// of boxes, because "red box with four cylinders" was the single most-named defect
// across two rounds of blind critique.
//
// The construction, in one paragraph. A car's *side view* is the shape that reads —
// bonnet, greenhouse, boot, wheel arches. So the body is authored as one closed 2D
// silhouette in the (z, y) plane and lofted across X. Each silhouette point carries
// its own half-width, so the loft is not a prism: the roof is narrower than the
// sills (tumblehome), and the nose and tail draw in (plan-view taper). The loft's
// two end caps ARE the flanks of the car, and because the widths vary they come out
// curved, not flat. Rings near each flank are inset along the 2D normal so every
// edge - roof rail, bonnet shut, bumper, arch lip - carries a real chamfer instead
// of a hard 90 degrees. Wheel arches are concave notches in the silhouette whose
// depth fades to zero on the inboard rings, which is what turns a full-width slot
// into a wheel well with a floor pan between the two sides.
//
// Draw calls, which is the other hard constraint (warn 200 / fail 320 district-wide):
//   1. body      - paint, plastic trim, chrome, grille, lamps, plate, mirrors
//   2. glazing   - windscreen, side glass, backlight
//   3. wheels    - ONE InstancedMesh of four, tyre and rim in one geometry
// The body is one material for eight different surface finishes because roughness,
// metalness and emission are read from two 16x1 palette textures indexed by UV.
// That is the whole trick: a vertex "is chrome" by pointing its UV at texel 2.
//
// Traffic reuses the same generator at a much coarser setting and folds glass and
// wheels into the body geometry with vertex colours, so 60 cars stay ONE
// InstancedMesh - see buildTrafficCarGeometry.

import * as THREE from '../vendor/three.module.min.js';

// ---------------------------------------------------------------- palette
// Index -> surface finish. UV.x = (index + 0.5) / 16 on every vertex.
export const SURFACE = {
  paint: 0, trim: 1, chrome: 2, grille: 3,
  headlight: 4, taillight: 5, indicator: 6, plate: 7,
  tyre: 8, rim: 9, glassy: 10, matte: 11,
  // 12 and 13 are the TRAFFIC car's own grille and rim finishes. They exist so
  // that fixing the ambient fleet cannot touch the player's car, which two blind
  // reviewers independently measured as the best asset in the frame - one of
  // them scored its wheel against real photographs and it passes on all four
  // measures at 21.6 px, two thirds the size of the ambient wheel that fails.
  // The palette texture has always been 16 texels wide with 12 in use, so these
  // cost nothing: no draw call, no triangle, no texture.
  meshCoarse: 12, rimCoarse: 13,
};

//                 roughness metalness  emissive (sRGB bytes)
const PALETTE = [
  [0.26, 0.60, [0, 0, 0]],          // 0  paint: flake base under clearcoat. Not 1.0:
                                    //    a fully metallic paint has no diffuse term
                                    //    at all and goes black under street lamps.
  [0.68, 0.06, [0, 0, 0]],          // 1  trim: unpainted bumper / rocker plastic
  [0.16, 1.00, [0, 0, 0]],          // 2  chrome
  [0.50, 0.55, [0, 0, 0]],          // 3  grille mesh
  [0.07, 0.03, [255, 247, 228]],    // 4  headlight lens
  [0.11, 0.03, [186, 20, 10]],      // 5  tail lens (dimmer than a headlamp)
  [0.11, 0.03, [255, 122, 14]],     // 6  indicator lens
  [0.42, 0.00, [0, 0, 0]],          // 7  number plate
  [0.94, 0.00, [0, 0, 0]],          // 8  tyre rubber
  [0.34, 0.72, [0, 0, 0]],          // 9  alloy rim
  [0.06, 0.86, [0, 0, 0]],          // 10 glazing (traffic cars, mirror faces)
  [0.86, 0.00, [0, 0, 0]],          // 11 matte black (mirror stalks, wells)
  // 12 traffic grille. NOT slot 3's 0.50/0.55. A near-black albedo at metalness
  // 0.55 has no diffuse term worth the name (0.45 x 0.006) and an F0 of 0.021,
  // so it responds to neither sun nor street lamp: the round-1 grille measured
  // luma 2.47 at night sitting directly under its own lit headlamps, and 9.9 at
  // noon, DARKER than the shadow the car casts (16.4). A grille is a shadowed
  // mesh, not a mirror - mostly diffuse, and rough.
  [0.66, 0.08, [0, 0, 0]],
  // 13 traffic alloy. Slot 9's 0.34/0.72 is a semi-mirror: with no diffuse floor
  // it renders whatever the environment hands each facet, which on the round-1
  // relief is a dark street for most of the rim and the sun for one facet of the
  // hub. That is the bimodal "hole plus a speck" the second review measured -
  // hubPeak 5.2 to 27.9 against 1.6-2.3 in real photographs, over a bright
  // fraction of 0.5% against 8-29%. Round 1 tested this lever at NOON on the OLD
  // FLAT DISC and recorded that it moved rimTyre the wrong way; that finding does
  // not transfer to a relief measured at dusk and night, and re-testing it is
  // where most of this round's wheel move came from.
  [0.42, 0.45, [0, 0, 0]],
];
const PAL_W = 16;

/** UV.x that selects a SURFACE index from the palette textures. */
export function paletteU(index) { return (index + 0.5) / PAL_W; }

let _packTex = null, _emisTex = null;

// roughnessMap reads .g and metalnessMap reads .b, so one texture serves both.
function packTexture() {
  if (_packTex) return _packTex;
  const data = new Uint8Array(PAL_W * 4);
  for (let i = 0; i < PAL_W; i++) {
    const p = PALETTE[i] ?? PALETTE[0];
    data[i * 4 + 0] = 255;
    data[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(p[0], 0, 1) * 255);
    data[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(p[1], 0, 1) * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, PAL_W, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  _packTex = t;
  return t;
}

function emissiveTexture() {
  if (_emisTex) return _emisTex;
  const data = new Uint8Array(PAL_W * 4);
  for (let i = 0; i < PAL_W; i++) {
    const e = (PALETTE[i] ?? PALETTE[0])[2];
    data[i * 4 + 0] = e[0]; data[i * 4 + 1] = e[1]; data[i * 4 + 2] = e[2];
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, PAL_W, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _emisTex = t;
  return t;
}

/**
 * The one material every painted / trimmed / lit surface of a car shares.
 * Colour comes from the vertex colour attribute; finish and emission come from
 * the palette textures. That is what keeps a car with chrome, matte plastic,
 * glass-clear lenses and glowing tail lights down to a single draw call.
 */
export function carSurfaceMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1, metalness: 1,          // the maps are the authority
    roughnessMap: packTexture(),
    metalnessMap: packTexture(),
    emissiveMap: emissiveTexture(),
    emissive: 0x000000,
    emissiveIntensity: 1,
    envMapIntensity: opts.envMapIntensity ?? 1.5,
  });
  return m;
}

/**
 * Emissive level for a lamp lens, in the renderer's linear radiance units.
 *
 * Emission has to be divided by the camera stop, because this project's exposure
 * spans 1/78000 at noon to 1/1.15 at night. A constant emissive is either
 * invisible at dusk or a supernova at night; a constant DISPLAYED value is a
 * blown-out lens at both, which is what a headlight actually looks like.
 */
export function lampEmissive(on, exposure = 1 / 660, display = 2.6) {
  return on ? Math.min(6000, display / Math.max(exposure, 1e-6)) : 0;
}

/** Dark, strongly reflective glazing. Opaque on purpose: no sorting, no cost. */
export function carGlassMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: opts.color ?? 0x0a0e14,
    roughness: 0.045, metalness: 0.88,
    envMapIntensity: opts.envMapIntensity ?? 2.6,
  });
}

// ---------------------------------------------------------------- geometry helpers
// A tiny accumulator. Three's BufferGeometryUtils lives in examples/jsm, which is
// not vendored, so merging is done here rather than pulling in a dependency.
class Builder {
  constructor() { this.pos = []; this.col = []; this.uv = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  vert(x, y, z, c, pal) {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(paletteU(pal), 0.5);
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const _c = new THREE.Color();
function col(hex) { return new THREE.Color().setHex(hex); }

// ---------------------------------------------------------------- the shape
// All dimensions are metres in the vehicle's local frame: +Z forward, +X right,
// origin at the physics body centre. src/vehicle.js puts the wheel anchors at
// y = -0.10 and the resting suspension length at ~0.257 m, so the tyres' contact
// patch sits at y = -0.717. Nothing here may move any of that; this is skin.
export const CAR = {
  hw: 0.95,            // max half-width (1.90 m across the hips)
  halfLen: 2.24,
  planTaper: 0.075,    // how much the nose and tail draw in, in plan view
  tumble: 0.205,       // how much narrower the roof is than the sills
  belt: 0.30,          // beltline: tumblehome starts here
  roofY: 0.716,
  sill: -0.525,        // underbody
  ground: -0.717,      // where the tyres meet the road at rest
  edge: 0.085,         // chamfer radius on every silhouette edge
  archR: 0.445,
  archCy: -0.334,      // arch circle centre height
  frontAxleZ: 1.32,
  rearAxleZ: -1.30,
  wheelR: 0.36,
  tyreHalfW: 0.112,
  rimR: 0.252,
};

/**
 * Half-width of the body at a silhouette point. Two effects, both essential to
 * the read: the greenhouse narrows above the beltline, and the extremities draw
 * in toward the bumpers. A car whose plan view is a rectangle looks like a bus.
 */
function halfWidth(z, y, P = CAR) {
  const t = Math.min(1, Math.abs(z) / P.halfLen);
  const plan = 1 - P.planTaper * t * t * t;
  const ty = THREE.MathUtils.clamp((y - P.belt) / (P.roofY - P.belt), 0, 1);
  // The fractional exponent puts a fast narrowing right above the beltline,
  // which is what reads as a shoulder crease rather than a soft dome.
  const tumble = 1 - P.tumble * Math.pow(ty, 0.6);
  return P.hw * plan * tumble;
}

/**
 * The closed side silhouette, front bumper -> bonnet -> screen -> roof -> boot ->
 * tail -> underside (with the two wheel arches) -> back to the bumper.
 *
 * Each point carries:
 *   z, y   position in the silhouette plane
 *   y0     the same point with the wheel arch flattened away (inboard rings)
 *   w      half-width at this point
 *   crown  how much the surface domes toward the centreline (bonnet, roof, boot)
 *   pal    SURFACE index
 *   dark   true -> unpainted plastic colour rather than body colour
 */
function silhouette(P = CAR, detail = {}) {
  const archSegments = detail.archSegments ?? 11;
  const decimate = detail.decimate ?? false;
  const pts = [];
  const add = (z, y, o = {}) => {
    pts.push({
      z, y, y0: o.y0 ?? y,
      w: (o.w ?? halfWidth(z, y, P)) * (o.wMul ?? 1),
      crown: o.crown ?? 0,
      pal: o.pal ?? SURFACE.paint,
      dark: o.dark ?? false,
      tag: o.tag ?? null,
    });
  };
  const S = P.sill;

  // --- nose: valance, bumper, grille aperture, then up over the bonnet. The
  // aperture is a real 40 mm step in the silhouette, because a "recessed" panel
  // pushed inward from a flush surface is simply inside the solid and invisible.
  add(2.10, -0.545, { pal: SURFACE.trim, dark: true, tag: 'valance' });
  add(2.205, -0.415, { pal: SURFACE.trim, dark: true });
  add(2.246, -0.272, { pal: SURFACE.trim, dark: true });
  add(2.206, -0.244, { pal: SURFACE.trim, dark: true, tag: 'grilleLo' });
  add(2.212, -0.115);
  add(2.198, 0.004, { tag: 'grilleHi' });
  add(2.240, 0.028);
  add(2.214, 0.062, { tag: 'lampLo' });
  add(2.150, 0.135);
  add(2.062, 0.192, { tag: 'lampHi' });
  add(1.930, 0.228, { crown: 0.020, tag: 'bonnetFront' });
  add(1.560, 0.256, { crown: 0.030 });
  add(1.120, 0.274, { crown: 0.032 });
  add(0.780, 0.286, { crown: 0.024 });
  add(0.690, 0.300, { crown: 0.012, tag: 'cowl' });

  // --- greenhouse. halfWidth() collapses the body onto the roof from here up,
  // so the A-pillar base is where the flank turns into the screen.
  add(0.640, 0.336, { tag: 'screenLo' });
  add(0.390, 0.482, { crown: 0.010 });
  add(0.130, 0.618, { crown: 0.014 });
  add(-0.095, 0.694, { crown: 0.016, tag: 'screenHi' });
  add(-0.380, 0.7145, { crown: 0.026 });
  add(-0.760, 0.7125, { crown: 0.026 });
  add(-1.080, 0.684, { crown: 0.022, tag: 'backlightHi' });
  add(-1.320, 0.588, { crown: 0.014 });
  add(-1.545, 0.452, { crown: 0.010 });
  add(-1.700, 0.352, { tag: 'backlightLo' });

  // --- boot deck and tail.
  add(-1.752, 0.316, { crown: 0.012, tag: 'bootFront' });
  add(-1.880, 0.300, { crown: 0.016 });
  add(-2.076, 0.290, { crown: 0.014 });
  add(-2.152, 0.302);
  add(-2.190, 0.268, { tag: 'bootLip' });
  add(-2.238, 0.140);
  add(-2.254, 0.052, { tag: 'tailHi' });
  add(-2.256, -0.010);
  add(-2.250, -0.072, { tag: 'tailLo' });
  add(-2.234, -0.172);
  add(-2.212, -0.300, { pal: SURFACE.trim, dark: true, tag: 'plateHi' });
  add(-2.150, -0.430, { pal: SURFACE.trim, dark: true, tag: 'plateLo' });
  add(-2.060, -0.530, { pal: SURFACE.trim, dark: true });

  // --- underside, rear to front, with an arch notched into it at each axle.
  const arch = (zc) => {
    const cosMax = THREE.MathUtils.clamp((S - P.archCy) / P.archR, -1, 1);
    const thMax = Math.acos(cosMax);
    const n = archSegments;
    for (let i = 0; i <= n; i++) {
      const th = -thMax + (2 * thMax * i) / n;
      const z = zc + P.archR * Math.sin(th);
      const y = P.archCy + P.archR * Math.cos(th);
      // The lip is the widest part of the body: fenders flare a little over the
      // wheels, which is most of what separates a car from a shoebox in plan.
      add(z, y, { y0: S, wMul: 1.008 + 0.012 * Math.cos(th), tag: 'arch' });
    }
  };
  add(-1.860, S, { pal: SURFACE.trim, dark: true });
  arch(P.rearAxleZ);
  add(-0.640, S, { pal: SURFACE.trim, dark: true, tag: 'rocker' });
  add(0.000, -0.534, { pal: SURFACE.trim, dark: true, tag: 'rocker' });
  add(0.640, S, { pal: SURFACE.trim, dark: true, tag: 'rocker' });
  arch(P.frontAxleZ);
  add(1.880, S, { pal: SURFACE.trim, dark: true });

  // Traffic runs the same silhouette at half the point count. Tagged points are
  // structural (they anchor lamps, glass and the plate) and are never dropped;
  // the ones between them only carry curvature nobody resolves at 40 m.
  let out = pts;
  if (decimate) {
    let n = 0;
    out = pts.filter((p) => (p.tag ? true : (n++ % 2 === 0)));
  }

  // Author it counter-clockwise in (z, y) whichever way it came out, so the
  // winding below is deterministic.
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    area += a.z * b.y - b.z * a.y;
  }
  if (area < 0) out.reverse();
  return out;
}

// Outward 2D normals of the silhouette, used to inset the chamfer rings and to
// float overlay panels (lamps, grille, plate) a few millimetres proud of the skin.
function silhouetteNormals(pts) {
  const n = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i - 1 + pts.length) % pts.length];
    const q = pts[(i + 1) % pts.length];
    // CCW contour: outward normal of a tangent (tz, ty) is (ty, -tz).
    const tz = q.z - p.z, ty = q.y - p.y;
    const len = Math.hypot(tz, ty) || 1;
    n.push({ z: ty / len, y: -tz / len });
  }
  return n;
}

// Lateral rings, outermost flank first. f scales the point's own half-width, dx is
// an absolute inset from it, `in` is the silhouette inset (the chamfer), and
// `arch` fades the wheel-arch notch away toward the centreline so the underbody
// closes into a floor pan instead of a full-width slot.
function ringPlan(P, quality) {
  const R = P.edge;
  // The inboard rings exist only to carry `crown`, which domes the bonnet, roof
  // and boot. Their spacing is chosen so the parabola crown*(1 - (x/w)^2) is
  // sampled EVENLY (0, .26, .39, .54, .77, .93, 1) — evenly spaced x instead
  // banded the bonnet visibly under a low sun.
  const outer = [
    { f: 1, dx: 0, in: R, arch: 1 },
    { f: 1, dx: -0.134 * R, in: 0.50 * R, arch: 1 },
    { f: 1, dx: -0.50 * R, in: 0.134 * R, arch: 1 },
    { f: 1, dx: -R, in: 0, arch: 1 },
    { f: 0.86, dx: 0, in: 0, arch: 1 },
    { f: 0.78, dx: 0, in: 0, arch: 1 },
    { f: 0.68, dx: 0, in: 0, arch: 1 },
    { f: 0.48, dx: 0, in: 0, arch: 0 },
    { f: 0.26, dx: 0, in: 0, arch: 0 },
  ];
  // Traffic: one chamfer facet instead of a rounded quarter, and no floor pan —
  // 60 instances make every ring cost 60x, and nobody sees under a traffic car.
  const coarse = [
    { f: 1, dx: 0, in: R, arch: 1 },
    { f: 1, dx: -R, in: 0, arch: 1 },
    { f: 0.60, dx: 0, in: 0, arch: 0.45 },
  ];
  const half = quality === 'coarse' ? coarse : outer;
  // Rings must march monotonically in x, so the -X flank runs outermost-first and
  // the +X flank runs innermost-first. Getting this backwards turns the shell
  // inside out in a way that only shows up as inverted normals under a low sun.
  const rings = [];
  for (let i = 0; i < half.length; i++) rings.push({ ...half[i], side: -1 });
  rings.push({ f: 0, dx: 0, in: 0, arch: 0, side: 1 });          // centreline
  for (let i = half.length - 1; i >= 0; i--) rings.push({ ...half[i], side: 1 });
  return rings;
}

function ringVertex(pt, nrm, ring) {
  const arched = pt.y0 + (pt.y - pt.y0) * ring.arch;
  const z = pt.z - nrm.z * ring.in;
  let y = arched - nrm.y * ring.in;
  const x = ring.side * Math.max(0, pt.w * ring.f + ring.dx);
  // Crown domes the horizontal panels toward the centreline. Zero at the flank,
  // full on the centre ring, so bonnet, roof and boot are not flat plates.
  if (pt.crown) y += pt.crown * (1 - (x / (pt.w || 1)) ** 2);
  return { x, y, z };
}

// Ear-clip the flank polygon once; both flanks reuse the index list.
// Deliberately unguarded: if the silhouette is ever edited into a self-
// intersecting shape, an exception with a stack is far more useful than a car
// silently rendered with no sides.
function triangulate(poly2d) {
  return THREE.ShapeUtils.triangulateShape(poly2d.map((p) => new THREE.Vector2(p.z, p.y)), []);
}

/**
 * Appends the body shell to `b`. Returns the flank triangulation
 * { faces, capPoly, ringCount, pointCount }, which the caller needs to place
 * side glass and flank trim exactly on the (curved) flank surface.
 */
function buildShell(b, pts, P, paintCol, trimCol, quality) {
  const nrm = silhouetteNormals(pts);
  const rings = ringPlan(P, quality);
  const N = pts.length, K = rings.length;
  const base = b.count;

  for (let k = 0; k < K; k++) {
    for (let i = 0; i < N; i++) {
      const v = ringVertex(pts[i], nrm[i], rings[k]);
      b.vert(v.x, v.y, v.z, pts[i].dark ? trimCol : paintCol, pts[i].pal);
    }
  }
  const at = (i, k) => base + k * N + i;
  for (let k = 0; k < K - 1; k++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      // Winding derived once: (ring direction) x (silhouette direction) is outward.
      b.tri(at(i, k), at(i, k + 1), at(j, k));
      b.tri(at(i, k + 1), at(j, k + 1), at(j, k));
    }
  }

  // Flanks. The chamfer ring is inset, so the cap polygon is the inset silhouette.
  const capPoly = pts.map((p, i) => {
    const v = ringVertex(p, nrm[i], rings[K - 1]);
    return { z: v.z, y: v.y, x: v.x };
  });
  const faces = triangulate(capPoly);
  const cross = (t) => {
    const a = capPoly[t[0]], c = capPoly[t[1]], d = capPoly[t[2]];
    return (c.z - a.z) * (d.y - a.y) - (c.y - a.y) * (d.z - a.z);
  };
  for (const t of faces) {
    // +X flank wants normal_x > 0, which is a clockwise triangle in (z, y).
    const cw = cross(t) < 0;
    if (cw) b.tri(at(t[0], K - 1), at(t[1], K - 1), at(t[2], K - 1));
    else b.tri(at(t[0], K - 1), at(t[2], K - 1), at(t[1], K - 1));
    if (cw) b.tri(at(t[0], 0), at(t[2], 0), at(t[1], 0));
    else b.tri(at(t[0], 0), at(t[1], 0), at(t[2], 0));
  }

  return { faces, capPoly, ringCount: K, pointCount: N };
}

/**
 * Where the flank surface actually is at an interior point of the silhouette.
 * The flank is a triangulated polygon whose vertices carry per-point widths, so
 * its x is the barycentric blend of the three corners — not halfWidth(z, y),
 * which would put the side glass inside the door.
 */
function flankX(capPoly, faces, z, y) {
  for (const t of faces) {
    const a = capPoly[t[0]], b2 = capPoly[t[1]], c2 = capPoly[t[2]];
    const d = (b2.y - c2.y) * (a.z - c2.z) + (c2.z - b2.z) * (a.y - c2.y);
    if (Math.abs(d) < 1e-12) continue;
    const w0 = ((b2.y - c2.y) * (z - c2.z) + (c2.z - b2.z) * (y - c2.y)) / d;
    const w1 = ((c2.y - a.y) * (z - c2.z) + (a.z - c2.z) * (y - c2.y)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) {
      return w0 * a.x + w1 * b2.x + w2 * c2.x;
    }
  }
  return halfWidth(z, y);
}

// A panel floated on the swept surface between two silhouette points: headlamps,
// grille, tail lamps, number plate. Follows the body exactly, so it never floats.
//
// `colour` may be a FUNCTION (row, lastRow) -> THREE.Color, which is how the
// grille gets a slat in it for nothing. Two blind reviewers measured the round-1
// grille at stdev 0.42 and 0.46 luma over 3,600-6,900 px - dead flat, and flatter
// than every other surface on the car (the bonnet reads 13.3). A band's rows are
// already there; giving them different colours costs no triangles at all, and
// vertex colour interpolates, so three rows dark/light/dark arrive as a lit slat
// with soft edges rather than as a painted stripe.
function overlayBand(b, pts, nrm, i0, i1, u0, u1, off, pal, colour, nu = 4) {
  const colAt = typeof colour === 'function' ? colour : () => colour;
  // Always sweep u upward. Mirroring a band by passing u0 > u1 reverses the quad
  // winding and back-faces the whole panel, which is how the car shipped its
  // first render with exactly one headlamp.
  if (u1 < u0) { const t = u0; u0 = u1; u1 = t; }
  const rows = [];
  for (let i = i0; i <= i1; i++) {
    const p = pts[i], n = nrm[i];
    const row = [];
    for (let s = 0; s <= nu; s++) {
      const u = u0 + ((u1 - u0) * s) / nu;
      const x = u * p.w;
      // + off is proud of the skin, along the silhouette's outward normal.
      const y = p.y + n.y * off + (p.crown ? p.crown * (1 - u * u) : 0);
      const z = p.z + n.z * off;
      row.push(b.vert(x, y, z, colAt(i - i0, i1 - i0), pal));
    }
    rows.push(row);
  }
  for (let r = 0; r < rows.length - 1; r++) {
    for (let s = 0; s < nu; s++) {
      b.quad(rows[r][s], rows[r][s + 1], rows[r + 1][s + 1], rows[r + 1][s]);
    }
  }
}

// A polygon laid ON the flank: each corner's x comes from the flank surface, so
// the panel curves with the door instead of cutting through it. Side glass, door
// shuts, the swage line, the handle.
function flankPanel(b, capPoly, faces, poly, side, off, pal, colour) {
  const ids = poly.map(([z, y]) =>
    b.vert(side * (flankX(capPoly, faces, z, y) + off), y, z, colour, pal));
  const faces2 = triangulate(poly.map(([z, y]) => ({ z, y })));
  const cross = (t) => {
    const a = poly[t[0]], c = poly[t[1]], d = poly[t[2]];
    return (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
  };
  for (const t of faces2) {
    const cw = cross(t) < 0;
    if ((side > 0) === cw) b.tri(ids[t[0]], ids[t[1]], ids[t[2]]);
    else b.tri(ids[t[0]], ids[t[2]], ids[t[1]]);
  }
}

// Axis-aligned box, optionally yawed. Mirror stalks and housings, exhaust tips.
function boxAt(b, cx, cy, cz, hx, hy, hz, colour, pal, yaw = 0) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  const v = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * hx, pz = sz * hz;
    v.push(b.vert(cx + px * c - pz * s, cy + sy * hy, cz + px * s + pz * c, colour, pal));
  }
  // index = (sx+1)/2*4 + (sy+1)/2*2 + (sz+1)/2, faces wound outward.
  const q = (a, b2, c2, d) => b.quad(v[a], v[b2], v[c2], v[d]);
  q(1, 5, 7, 3);   // +z
  q(4, 0, 2, 6);   // -z
  q(5, 4, 6, 7);   // +x
  q(0, 1, 3, 2);   // -x
  q(2, 3, 7, 6);   // +y
  q(0, 4, 5, 1);   // -y
}

// ---------------------------------------------------------------- wheels
/**
 * One tyre and one rim in one geometry, axis along +X so a wheel is positioned
 * with rotY(steer) * rotX(spin) and nothing else. Symmetric front-to-back so the
 * same geometry serves both sides without a mirrored (winding-flipping) scale.
 *
 * The rim face is a five-lobed relief rather than a disc with holes: the lobe is
 * both a depth and a brightness, so spokes read at any distance for 160 triangles
 * and no cut geometry.
 */
export function buildWheelGeometry(opts = {}) {
  const P = CAR;
  const seg = opts.segments ?? 18;
  const spokes = opts.spokes ?? 5;
  const R = P.wheelR, HW = P.tyreHalfW, RR = P.rimR;
  const b = new Builder();
  const rubber = col(opts.tyreColor ?? 0x121417);
  const alloy = col(opts.rimColor ?? 0xd2d8de);
  const gap = col(opts.rimShadow ?? 0x1e2227);

  // Tyre: a revolved cross-section with a crowned tread and bulged sidewalls.
  const sec = [
    [-HW * 0.98, RR], [-HW * 1.02, RR + 0.045], [-HW * 1.0, RR + 0.085],
    [-HW * 0.92, RR + 0.112], [-HW * 0.76, R], [HW * 0.76, R],
    [HW * 0.92, RR + 0.112], [HW * 1.0, RR + 0.085], [HW * 1.02, RR + 0.045],
    [HW * 0.98, RR],
  ];
  const tyreRows = [];
  for (const [x, r] of sec) {
    const row = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      row.push(b.vert(x, Math.cos(a) * r, Math.sin(a) * r, rubber, SURFACE.tyre));
    }
    tyreRows.push(row);
  }
  for (let r = 0; r < tyreRows.length - 1; r++) {
    for (let s = 0; s < seg; s++) {
      const t = (s + 1) % seg;
      b.quad(tyreRows[r][s], tyreRows[r][t], tyreRows[r + 1][t], tyreRows[r + 1][s]);
    }
  }

  // Rim barrel, then a dished face at each end.
  const barrel = [-HW * 0.98, HW * 0.98].map((x) => {
    const row = [];
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      row.push(b.vert(x, Math.cos(a) * RR, Math.sin(a) * RR, gap, SURFACE.rim));
    }
    return row;
  });
  for (let s = 0; s < seg; s++) {
    const t = (s + 1) % seg;
    b.quad(barrel[0][s], barrel[0][t], barrel[1][t], barrel[1][s]);
  }

  //        radius   x out   dip     brightness at the lobe trough
  const face = [
    [0.000, HW * 1.00, 0.000, 1.0],
    [0.062, HW * 0.90, 0.010, 0.9],
    [0.130, HW * 0.86, 0.055, 0.0],
    [0.192, HW * 0.90, 0.050, 0.0],
    [RR, HW * 0.96, 0.000, 1.0],
  ];
  for (const sx of [-1, 1]) {
    const rows = [];
    for (const [r, xo, dip, lit] of face) {
      const row = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const lobe = 0.5 + 0.5 * Math.cos(spokes * a);
        const x = sx * (xo - dip * (1 - lobe));
        _c.copy(gap).lerp(alloy, Math.min(1, lit + (1 - lit) * lobe));
        row.push(b.vert(x, Math.cos(a) * r, Math.sin(a) * r, _c, SURFACE.rim));
      }
      rows.push(row);
    }
    for (let r = 0; r < rows.length - 1; r++) {
      for (let s = 0; s < seg; s++) {
        const t = (s + 1) % seg;
        if (sx > 0) b.quad(rows[r][s], rows[r][t], rows[r + 1][t], rows[r + 1][s]);
        else b.quad(rows[r][s], rows[r + 1][s], rows[r + 1][t], rows[r][t]);
      }
    }
  }
  return b.geometry();
}

// ---------------------------------------------------------------- player car
/**
 * The player's vehicle: three draw calls (body, glazing, four instanced wheels).
 *
 * The physics body is NOT represented here and must not be inferred from here.
 * src/vehicle.js owns the collision box, the wheel anchors and the suspension;
 * this only reads wheel positions back out to place the visual wheels.
 */
export function buildPlayerCar(opts = {}) {
  const P = CAR;
  const paint = col(opts.paint ?? 0x9e2b20);
  const trim = col(opts.trim ?? 0x24272b);
  const chrome = col(opts.chrome ?? 0xc9ced4);
  const lampCol = col(0xf2f4f6);
  const tailCol = col(0xb4241c);
  const amber = col(0xd8801e);
  const plate = col(0xdadfe2);
  const dark = col(0x0e1013);

  const b = new Builder();
  const pts = silhouette(P);
  const nrm = silhouetteNormals(pts);
  const shell = buildShell(b, pts, P, paint, trim, 'fine');
  const shellVerts = b.count;

  const tagIndex = (name) => pts.findIndex((p) => p.tag === name);
  const iLampLo = tagIndex('lampLo'), iLampHi = tagIndex('lampHi');
  const iGrilleLo = tagIndex('grilleLo'), iGrilleHi = tagIndex('grilleHi');
  const iTailHi = tagIndex('tailHi'), iTailLo = tagIndex('tailLo');
  const iPlateHi = tagIndex('plateHi'), iPlateLo = tagIndex('plateLo');
  const iScreenLo = tagIndex('screenLo'), iScreenHi = tagIndex('screenHi');
  const iBackHi = tagIndex('backlightHi'), iBackLo = tagIndex('backlightLo');

  // --- grille: dark mesh sitting in the aperture, under a chrome brow.
  if (iGrilleLo >= 0 && iGrilleHi > iGrilleLo) {
    overlayBand(b, pts, nrm, iGrilleLo, iGrilleHi, -0.62, 0.62, 0.010,
      SURFACE.grille, dark, 6);
    overlayBand(b, pts, nrm, iGrilleHi, iGrilleHi + 1, -0.66, 0.66, 0.016,
      SURFACE.chrome, chrome, 6);
  }
  // --- headlamps, wrapping into the corner, plus an amber indicator outboard.
  if (iLampLo >= 0 && iLampHi > iLampLo) {
    for (const s of [-1, 1]) {
      overlayBand(b, pts, nrm, iLampLo, iLampHi, s * 0.34, s * 0.82, 0.012,
        SURFACE.headlight, lampCol, 4);
      overlayBand(b, pts, nrm, iLampLo, iLampLo + 1, s * 0.62, s * 0.84, 0.018,
        SURFACE.indicator, amber, 2);
    }
  }
  // --- tail lamps: two lenses either side of a dark applique. The first pass ran
  // one lens right across and, blown out by the night exposure, it read as a
  // glowing wall rather than as lamps.
  if (iTailHi >= 0 && iTailLo > iTailHi) {
    for (const s of [-1, 1]) {
      overlayBand(b, pts, nrm, iTailHi, iTailLo, s * 0.34, s * 0.86, 0.012,
        SURFACE.taillight, tailCol, 5);
    }
    overlayBand(b, pts, nrm, iTailHi, iTailLo, -0.34, 0.34, 0.010,
      SURFACE.trim, trim, 3);
  }
  // --- number plate.
  if (iPlateHi >= 0 && iPlateLo > iPlateHi) {
    overlayBand(b, pts, nrm, iPlateHi, iPlateLo, -0.28, 0.28, 0.014,
      SURFACE.plate, plate, 2);
  }

  // --- glazing sits on its own material; build it into a second Builder.
  const gb = new Builder();
  const glassCol = col(0xffffff);
  if (iScreenLo >= 0 && iScreenHi > iScreenLo) {
    overlayBand(gb, pts, nrm, iScreenLo, iScreenHi, -0.85, 0.85, 0.014,
      SURFACE.glassy, glassCol, 6);
  }
  if (iBackHi >= 0 && iBackLo > iBackHi) {
    overlayBand(gb, pts, nrm, iBackHi, iBackLo, -0.85, 0.85, 0.014,
      SURFACE.glassy, glassCol, 6);
  }
  // Side glass is a polygon ON the flank, so its x comes from the flank
  // triangulation rather than from halfWidth(): the flank is piecewise linear and
  // the analytic width would bury the window inside the door.
  const doorGlass = [
    [0.430, 0.352], [0.150, 0.505], [-0.115, 0.608],
    [-0.600, 0.630], [-0.645, 0.352],
  ];
  const quarterGlass = [
    [-0.760, 0.352], [-0.725, 0.622], [-1.210, 0.588],
    [-1.430, 0.400], [-1.470, 0.352],
  ];
  for (const s of [-1, 1]) {
    flankPanel(gb, shell.capPoly, shell.faces, doorGlass, s, 0.016, SURFACE.glassy, glassCol);
    flankPanel(gb, shell.capPoly, shell.faces, quarterGlass, s, 0.016, SURFACE.glassy, glassCol);
  }

  // --- panel shuts along the bonnet and boot lid. A car is assembled from
  // pressings, and without the gaps between them a bonnet is just a dome.
  const iBonnet = tagIndex('bonnetFront'), iCowl = tagIndex('cowl');
  const iBootFront = tagIndex('bootFront'), iBootLip = tagIndex('bootLip');
  // Not black: a sub-pixel black line antialiases into a dashed stitch at a
  // grazing angle, which reads as an artifact rather than as a panel gap.
  const shutLine = col(0x1d2126);
  if (iBonnet >= 0 && iCowl > iBonnet) {
    for (const s of [-1, 1]) {
      overlayBand(b, pts, nrm, iBonnet, iCowl, s * 0.618, s * 0.646, 0.004,
        SURFACE.matte, shutLine, 1);
    }
  }
  if (iBootFront >= 0 && iBootLip > iBootFront) {
    for (const s of [-1, 1]) {
      overlayBand(b, pts, nrm, iBootFront, iBootLip, s * 0.688, s * 0.716, 0.004,
        SURFACE.matte, shutLine, 1);
    }
  }

  // --- flank detail. A door shut, a swage line and a handle are what separate a
  // moulded shape from a manufactured object; the flank is otherwise one smooth
  // surface with nothing on it for the eye to read scale against. All of it sits
  // ON the flank triangulation (flankPanel), a few millimetres proud, so it
  // follows the curvature instead of floating over it.
  const shut = col(0x1b1f24);
  const swage = paint.clone().multiplyScalar(0.42);
  const strip = (poly, side, off, pal, c) =>
    flankPanel(b, shell.capPoly, shell.faces, poly, side, off, pal, c);
  const vline = (z, y0, y1, w) => [[z - w, y0], [z + w, y0], [z + w, y1], [z - w, y1]];
  for (const s of [-1, 1]) {
    // Two-door proportions: the shut sits just behind the front arch and just
    // ahead of the rear one, matching the single long side window above it.
    strip(vline(0.880, -0.430, 0.262, 0.0075), s, 0.004, SURFACE.matte, shut);
    strip(vline(-0.718, -0.430, 0.338, 0.0075), s, 0.004, SURFACE.matte, shut);
    strip([[0.880, 0.020], [-0.700, 0.052], [-0.700, 0.070], [0.880, 0.038]],
      s, 0.005, SURFACE.paint, swage);
    strip([[-0.560, 0.176], [-0.430, 0.180], [-0.430, 0.206], [-0.560, 0.202]],
      s, 0.006, SURFACE.chrome, chrome);
  }

  // --- wing mirrors: stalk plus housing plus a reflective face.
  const mirrorZ = 0.47, mirrorY = 0.335;
  const flank = flankX(shell.capPoly, shell.faces, mirrorZ, mirrorY);
  for (const s of [-1, 1]) {
    boxAt(b, s * (flank + 0.055), mirrorY + 0.012, mirrorZ, 0.055, 0.022, 0.030,
      trim, SURFACE.matte);
    boxAt(b, s * (flank + 0.148), mirrorY + 0.034, mirrorZ - 0.015, 0.044, 0.058, 0.098,
      paint, SURFACE.paint, s * 0.16);
    boxAt(b, s * (flank + 0.190), mirrorY + 0.034, mirrorZ - 0.020, 0.006, 0.044, 0.082,
      dark, SURFACE.glassy, s * 0.16);
  }
  // --- twin exhausts under the rear valance. No interior is modelled: the
  // glazing is opaque by design (see carGlassMaterial), so anything behind it
  // would be triangles nobody can ever see.
  for (const s of [-1, 1]) {
    boxAt(b, s * 0.34, -0.470, -2.135, 0.052, 0.036, 0.075, chrome, SURFACE.chrome);
  }

  const bodyGeo = b.geometry();
  const glassGeo = gb.geometry();

  const bodyMat = carSurfaceMaterial({ envMapIntensity: opts.envMapIntensity ?? 1.8 });
  const glassMat = carGlassMaterial();

  const group = new THREE.Group();
  group.name = 'playerCar';
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  bodyMesh.castShadow = glassMesh.castShadow = true;
  bodyMesh.receiveShadow = glassMesh.receiveShadow = true;
  group.add(bodyMesh, glassMesh);

  const wheelGeo = buildWheelGeometry(opts);
  const wheelMesh = new THREE.InstancedMesh(wheelGeo, carSurfaceMaterial({ envMapIntensity: 1.1 }), 4);
  wheelMesh.castShadow = true;
  wheelMesh.receiveShadow = true;
  wheelMesh.frustumCulled = false;
  group.add(wheelMesh);

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  let lit = -1;

  const colourAttr = bodyGeo.getAttribute('color');
  const uvAttr = bodyGeo.getAttribute('uv');
  const paintU = paletteU(SURFACE.paint);
  const paintBase = Float32Array.from(colourAttr.array);   // for setPaint()

  const tris = (g) => (g.getIndex() ? g.getIndex().count : g.getAttribute('position').count) / 3;

  return {
    group, bodyMesh, glassMesh, wheelMesh,
    materials: { body: bodyMat, glass: glassMat, wheel: wheelMesh.material },

    /**
     * Place the four visual wheels from the vehicle's own suspension state.
     * Local position is derived, not measured: src/vehicle.js anchors a wheel at
     * (w.x, -0.10, w.z) and hangs it suspLen below that along the body's up axis.
     */
    updateWheels(vehicle) {
      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheels[i];
        _p.set(w.x, -0.10 - w.suspLen, w.z);
        _e.set(w.spinAngle, w.steer ? vehicle.steer : 0, 0);
        _q.setFromEuler(_e);
        _m.compose(_p, _q, _s);
        wheelMesh.setMatrixAt(i, _m);
      }
      wheelMesh.instanceMatrix.needsUpdate = true;
    },

    /**
     * Lamps on/off. Emission is authored in display units and divided by the
     * camera stop, so a headlight reads as a blown-out lens at dusk AND at night
     * rather than being invisible at one and a supernova at the other.
     */
    setLights(on, exposure = 1 / 660) {
      const want = lampEmissive(on, exposure, opts.lampDisplay ?? 2.6);
      if (want === lit) return;
      lit = want;
      bodyMat.emissive.setRGB(want, want, want);
    },

    /**
     * Repaint without rebuilding. Every painted vertex is RESCALED from its
     * authored colour rather than overwritten, so shaded details that were
     * derived from the paint - the swage crease at 42% - keep their relation to
     * it instead of flattening into the new body colour.
     */
    setPaint(hex) {
      const c = col(hex);
      const k = [c.r / (paint.r || 1e-4), c.g / (paint.g || 1e-4), c.b / (paint.b || 1e-4)];
      for (let i = 0; i < colourAttr.count; i++) {
        if (Math.abs(uvAttr.getX(i) - paintU) > 1e-4) continue;
        colourAttr.setXYZ(i, paintBase[i * 3] * k[0], paintBase[i * 3 + 1] * k[1],
          paintBase[i * 3 + 2] * k[2]);
      }
      colourAttr.needsUpdate = true;
      paint.copy(c);
    },

    report() {
      return {
        drawCalls: 3,
        triangles: tris(bodyGeo) + tris(glassGeo) + tris(wheelGeo) * 4,
        bodyTriangles: tris(bodyGeo),
        glassTriangles: tris(glassGeo),
        wheelTriangles: tris(wheelGeo),
        silhouettePoints: shell.pointCount,
        rings: shell.ringCount,
      };
    },

    dispose() {
      bodyGeo.dispose(); glassGeo.dispose(); wheelGeo.dispose();
      bodyMat.dispose(); glassMat.dispose(); wheelMesh.material.dispose();
    },
  };
}

// ---------------------------------------------------------------- traffic car
/**
 * One geometry containing body, glazing and four static wheels, for InstancedMesh.
 *
 * Traffic must stay a single draw call no matter how many cars are alive, so
 * everything folds into one material. Per-car paint arrives as InstancedMesh
 * colour, which MULTIPLIES the vertex colour — so body panels are authored white
 * (they take the instance's paint) and glass, tyres and lamps are authored dark
 * (they stay dark whatever the paint). The finish still varies per surface,
 * because roughness and metalness come from the palette texture, not the material.
 *
 * @param {object} opts
 * @param {number} [opts.groundY] y to put the contact patch at (default 0)
 * @returns {THREE.BufferGeometry}
 */
export function buildTrafficCarGeometry(opts = {}) {
  const P = CAR;
  const white = col(0xffffff);
  const trimC = col(0x3a3d42);
  const glassC = col(0x0d1015);
  const tyreC = col(0x0e1013);
  // Alloy and the shadow a spoke gap sits in. The first cut of the relief used
  // 0xc2c8ce over 0x24282e, and it made the wheel WORSE: the lobe averages the
  // two, so a near-black gap dropped the rim's mean albedo from the old flat
  // disc's 0.55 to about 0.45, and the recessed gap faces then self-shadowed on
  // top of that. Measured at the hero framing it took rimTyre from 1.20 to 0.87 -
  // the rim came out DARKER than the tyre. A spoke gap in daylight is a shadowed
  // recess, not a hole; these two average to 0.62.
  const rimC = col(0xd8dee5);           // alloy face
  // The spoke gap, and the one number in this file that has now been set twice
  // for opposite reasons. Round 1 tried 0x24282e, measured the rim coming out
  // DARKER than the tyre (rimTyre 1.20 -> 0.87), and lightened it to 0x656b73 to
  // pull the mean back up. That was the right response to the wrong cause: at
  // SURFACE.rim's metalness 0.72 there is no diffuse term, so the albedo barely
  // reaches the screen and lightening the gap mostly just flattened the pattern
  // out. With the traffic rim moved to its own mostly-diffuse slot the albedo is
  // what is actually rendered, and a dark gap is what makes the rim bimodal in
  // SPACE - which is what the photographs show and what hubFrac measures.
  // 0x3a4048 rather than the player car's 0x1e2227, because at seg 8 one dark
  // facet is an eighth of the ring and the hero's 18 segments spread it much finer.
  const rimGapC = col(0x3a4048);        // shadowed recess between spokes
  const lampC = col(0xd8dade);
  const tailC = col(0x8e1c16);
  // The aperture, and the slat across it. NOT one flat near-black rectangle:
  // both blind reviewers of round 1 measured that rectangle independently and
  // both put it top of the list. Numbers, on the corridor near car at noon:
  // mean luma 9.9-10.1, stdev 0.42-0.46 over 3,600-6,900 px, against a body
  // fascia at 107 in the build it replaced. It was darker than the car's own
  // tinted windscreen (48.9) and darker than the SHADOW the car casts (16.4),
  // and at 0.264 m2 projecting almost square-on it is the third largest surface
  // on the nose - 3.6x the projected area of all four rims together at that
  // angle, for 8 triangles. tools/car-surface.mjs is the offline probe that
  // prices area rather than triangles, and it exists because round 1 counted
  // only triangles and so had no way to notice this.
  // Anchored to trim (0x3a3d42 at 0.68/0.06), which is the unpainted-plastic
  // finish already on this car's bumper and valance and which no reviewer has
  // ever called a slab. The aperture averages a little above it and modulates
  // either side, so the grille reads as a darker, textured member of a family
  // the frame already contains rather than as a value picked in the abstract.
  // Set against a MEASURED reference in the same frame rather than picked. The
  // unpainted plastic valance directly below the grille - trim, 0x3a3d42 at
  // 0.68/0.06 - reads median 20.9 luma at noon, 13.8 golden, 21.1 dusk, 9.1
  // night on the corridor near car, and nobody has ever called it a slab. The
  // round-1 grille read 9.8 / 7.0 / 9.7 / 2.2 in the same frames: about HALF its
  // own bumper by day and a quarter of it at night, on a nose that is entirely in
  // shade at noon (the bonnet above it reads 168.7, the nose face 92.8). These
  // two colours average 0.90 of the valance's albedo in linear light and split
  // 0.22 / 1.58 either side of it, which puts the aperture's median next to its
  // bumper instead of under the shadow of its own car, and gives it a spread.
  const grilleDarkC = col(0x171a21);    // the recess: dark, but above the shadow floor
  const grilleSlatC = col(0x646b76);    // one lit slat across it
  // NO CHROME BROW, and this is a thing I built, measured and took out again.
  // buildPlayerCar puts a SURFACE.chrome brow along the top of its grille and the
  // traffic car had never had one, so the first cut of this round copied it: 2
  // triangles, u +/-0.56, on the silhouette segment between grilleHi and lampLo.
  // Measured on the corridor near car at noon, median luma per 2-px row over
  // x 40..140, it replaced a fascia band reading 115.7 / 105.1 / 92.7 / 81.9 /
  // 84.0 - a real gradient - with a DEAD FLAT 73.9 across all five rows. Darker
  // than what it covered and flatter than what it covered, which is the same
  // defect this round exists to remove, in miniature. The cause is the same too:
  // SURFACE.chrome is roughness 0.16 / metalness 1.00, a mirror, and a mirror on
  // a vertical panel pointed down a street reflects the street. The player car
  // gets away with it because its nose carries the undecimated silhouette and a
  // real bumper apex to catch light; this one is a flat wall.
  // The aperture's surround is instead the painted fascia either side of it,
  // which narrowing u from 0.60 to 0.52 put back.
  const plateC = col(0xdadfe2);
  const shutC = col(0x1d2126);
  // 0.42 of white, so after the instance colour multiplies it the crease arrives
  // as a shade of that car's own paint rather than as a grey stripe on it.
  const swageC = col(0xffffff).multiplyScalar(0.42);

  const b = new Builder();
  const pts = silhouette(P, { archSegments: 6, decimate: true });
  const nrm = silhouetteNormals(pts);
  const shell = buildShell(b, pts, P, white, trimC, 'coarse');

  const tagIndex = (name) => pts.findIndex((p) => p.tag === name);
  const iLampLo = tagIndex('lampLo'), iLampHi = tagIndex('lampHi');
  const iGrilleLo = tagIndex('grilleLo'), iGrilleHi = tagIndex('grilleHi');
  const iTailHi = tagIndex('tailHi'), iTailLo = tagIndex('tailLo');
  const iPlateHi = tagIndex('plateHi'), iPlateLo = tagIndex('plateLo');
  const iBootFront = tagIndex('bootFront'), iBootLip = tagIndex('bootLip');
  const iScreenLo = tagIndex('screenLo'), iScreenHi = tagIndex('screenHi');
  const iBackHi = tagIndex('backlightHi'), iBackLo = tagIndex('backlightLo');

  if (iLampLo >= 0 && iLampHi > iLampLo) {
    for (const s of [-1, 1]) {
      overlayBand(b, pts, nrm, iLampLo, iLampHi, s * 0.34, s * 0.86, 0.012,
        SURFACE.headlight, lampC, 1);
    }
  }
  // --- grille. Three fixes to the round-1 slab, two of them free.
  //
  //   1. It is no longer one colour. The band's three rows run dark / slat /
  //      dark, and because vertex colour interpolates that arrives as a lit
  //      horizontal bar with soft edges. Zero triangles: the rows were already
  //      there. This is what the reviewers' stdev measures.
  //   2. It is narrower - 0.52 of the half-width against 0.60 - so painted
  //      fascia shows either side of it instead of the aperture running out to
  //      the fenders with hard square corners and no surround.
  //   3. A chrome brow was tried and removed; see the "NO CHROME BROW" note above
  //      for what it measured.
  //
  // And it is on SURFACE.meshCoarse rather than slot 3, so none of this reaches
  // the player's car.
  if (iGrilleLo >= 0 && iGrilleHi > iGrilleLo) {
    overlayBand(b, pts, nrm, iGrilleLo, iGrilleHi, -0.52, 0.52, 0.010,
      SURFACE.meshCoarse,
      // A slat at mid height, dark above and below it. With three rows this is
      // exactly one bright row; with more it is a raised-cosine so the band does
      // not depend on the silhouette's decimation happening to give three.
      (r, n) => _c.copy(grilleDarkC).lerp(grilleSlatC,
        0.5 + 0.5 * Math.cos(2 * Math.PI * (r / Math.max(1, n) - 0.5))).clone(),
      2);
  }
  // --- tail lamps: two lenses either side of a dark applique, NOT one band right
  // across. That is not a preference; buildPlayerCar records the same mistake and
  // what it cost - "one lens ran right across and, blown out by the night
  // exposure, it read as a glowing wall rather than as lamps". The traffic car
  // still had the wall: a critic looking at the parked sedan called it "one flat
  // maroon rectangle - no lens, no housing, no division". 12 triangles.
  if (iTailHi >= 0 && iTailLo > iTailHi) {
    for (const s of [-1, 1]) {
      overlayBand(b, pts, nrm, iTailHi, iTailLo, s * 0.32, s * 0.88, 0.012,
        SURFACE.taillight, tailC, 2);
    }
    overlayBand(b, pts, nrm, iTailHi, iTailLo, -0.30, 0.30, 0.009,
      SURFACE.trim, trimC, 1);
  }
  // --- number plate. Two triangles, and it is the cheapest "this is a car" cue
  // on the whole body: a light rectangle low on a dark tail, exactly where every
  // photograph of a parked car has one.
  if (iPlateHi >= 0 && iPlateLo > iPlateHi) {
    overlayBand(b, pts, nrm, iPlateHi, iPlateLo, -0.26, 0.26, 0.014,
      SURFACE.plate, plateC, 1);
  }
  // --- NO boot shut. Round 1 built one as two dark strips running fore-and-aft
  // along the boot deck at x = +/-0.60, and the second blind review of that round
  // reported them, unprompted and from the frames alone, as "two wiper blades
  // lying on the boot lid, pivots visible at 10x" - and checked the car's
  // orientation against the night frame (white lamps one end, red lamps and
  // plate the other) before saying so. It was right: a real boot shut is a
  // CLOSED line around the lid, and two floating parallel bars in the middle of
  // a deck are what a wiper pair looks like. They also sat 0.28 m inboard of the
  // lid's actual edge. Removed rather than closed: 12 triangles, spent instead
  // on the wheel, where the same review found a measured 5-40x gap to the
  // player's car. The bonnet shut was already deliberately absent (edge-on from
  // a street camera, under a pixel), so the only shut lines left on the car are
  // the two vertical door shuts on the flank, which is the honest set at 90 px.
  if (iScreenLo >= 0 && iScreenHi > iScreenLo) {
    overlayBand(b, pts, nrm, iScreenLo, iScreenHi, -0.86, 0.86, 0.013,
      SURFACE.glassy, glassC, 2);
  }
  if (iBackHi >= 0 && iBackLo > iBackHi) {
    overlayBand(b, pts, nrm, iBackHi, iBackLo, -0.86, 0.86, 0.013,
      SURFACE.glassy, glassC, 2);
  }
  // Side glass as one band per flank: at traffic distance the pillar split is not
  // resolvable and a second polygon is not worth 60x its triangles. It still has
  // to ride the flank triangulation — the greenhouse narrows with height, so a
  // flat plane at a guessed x pokes out through the roof rail.
  const sideGlass = [[0.50, 0.355], [0.20, 0.520], [-1.16, 0.600], [-1.42, 0.355]];
  for (const s of [-1, 1]) {
    flankPanel(b, shell.capPoly, shell.faces, sideGlass, s, 0.014, SURFACE.glassy, glassC);
  }
  // --- flank detail: two door shuts and a swage line, 12 triangles for both
  // sides. The swage is the one that matters. The complaint was "a baked vertical
  // gradient - pale at the shoulder, near-black along the bottom third - which
  // reads as painted-on shading rather than as form catching light", and that
  // gradient is real: the paint is metallic enough to mirror an environment that
  // is bright sky above and dark ground below, over a flank with nothing on it to
  // interrupt the sweep. A horizontal line at the beltline breaks the sweep in
  // the one direction the gradient runs. Authored at 0.42 of the paint so it
  // arrives as a shade of whatever colour the instance is painted, the way
  // buildPlayerCar's swage does.
  const vline = (z, y0, y1, w) => [[z - w, y0], [z + w, y0], [z + w, y1], [z - w, y1]];
  for (const s of [-1, 1]) {
    flankPanel(b, shell.capPoly, shell.faces, vline(0.86, -0.42, 0.27, 0.018), s,
      0.004, SURFACE.matte, shutC);
    flankPanel(b, shell.capPoly, shell.faces, vline(-0.70, -0.42, 0.33, 0.018), s,
      0.004, SURFACE.matte, shutC);
    flankPanel(b, shell.capPoly, shell.faces,
      [[0.90, 0.014], [-0.72, 0.048], [-0.72, 0.076], [0.90, 0.042]], s,
      0.005, SURFACE.paint, swageC);
  }
  // --- wing mirrors. 24 triangles for the pair, and the only thing in this list
  // that changes the SILHOUETTE rather than the surface: a car with nothing
  // sticking out of it reads as a soap bar however well it is shaded.
  for (const s of [-1, 1]) {
    boxAt(b, s * 0.99, 0.318, 0.47, 0.055, 0.042, 0.035, trimC, SURFACE.trim);
  }

  // Static wheels. Traffic cars have no suspension to read, so they are baked in
  // at the ride height a loaded car settles to: the anchor at y = -0.10 less the
  // static spring deflection, mass*g/(4*k) = 1400*19.6/(4*42000) = 0.163 m off
  // the 0.42 m free length. Track and wheelbase match the player's WHEEL_LAYOUT
  // so a traffic car and the player's car are visibly the same class of object.
  //
  // WHAT THIS REPLACED, and why it was 64 triangles of nothing. The old wheel was
  // an 8-sided tyre ring with a flat rim disc at EACH face, every vertex one flat
  // colour. Two rounds of blind critique called it a "featureless black disc"
  // without either of them having been asked to look at the wheels. The triangles
  // were not the problem; they were being spent SYMMETRICALLY, on two faces of
  // which only one is ever visible. The inboard face of a wheel is behind its own
  // tyre and inside the arch from every exterior camera.
  //
  // So the inboard sidewall is deleted outright and the inboard end closed with
  // one flat cap at the tread radius, and the saving buys the outboard face
  // buildWheelGeometry's five-lobed relief - where the lobe is BOTH a depth and a
  // brightness, so spokes read without any cut geometry. 80 triangles a wheel
  // against 64: +64 per car, +5,760 across the 90 cars a frame can hold.
  // seg 8 / 4 spokes, NOT 10 / 5, and the reason is arithmetic rather than taste.
  // The wheel costs 8*seg triangles, so seg 8 is 64 a wheel - exactly what the
  // old flat-disc wheel cost - and the whole rebuild lands at zero. At seg 10 it
  // would be 80 a wheel, +64 a car, +5,760 across 90 cars, against a frame that
  // has 359 triangles of headroom. Measured at the hero framing the wheel is
  // 38 px tall and 8 px WIDE - a kerbside car is seen nearly end-on from the
  // carriageway - so neither the 8-gon's faceting nor the fifth spoke was ever
  // going to resolve. The relief still buys the rim/tyre step, which does.
  const seg = 8;               // even, because the lobes must alternate
  const SPOKES = 4;
  const staticSuspLen = 0.257;
  for (const [wx, wz] of [
    [-0.78, P.frontAxleZ], [0.78, P.frontAxleZ],
    [-0.80, P.rearAxleZ], [0.80, P.rearAxleZ],
  ]) {
    const wy = -0.10 - staticSuspLen;
    const HW = P.tyreHalfW, R = P.wheelR, RR = P.rimR;
    // Which way this wheel faces the street. Detail is spent on that side only,
    // and because the geometry is authored per wheel rather than instanced, the
    // left pair and the right pair each get their own outboard face for free.
    const out = wx < 0 ? -1 : 1;
    const ring = (xo, r, colour, pal) => {
      const row = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        row.push(b.vert(wx + out * xo, wy + Math.cos(a) * r, wz + Math.sin(a) * r, colour, pal));
      }
      return row;
    };
    // The relief ring: dip recesses the spoke GAPS and the same lobe drives the
    // colour, so a gap is both further in and darker. One term doing two jobs is
    // what makes five spokes legible at ten segments.
    const lobeRing = (xo, dip, r, lit) => {
      const row = [];
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const lobe = 0.5 + 0.5 * Math.cos(SPOKES * a);
        _c.copy(rimGapC).lerp(rimC, Math.min(1, lit + (1 - lit) * lobe));
        row.push(b.vert(wx + out * (xo - dip * (1 - lobe)),
          wy + Math.cos(a) * r, wz + Math.sin(a) * r, _c, SURFACE.rimCoarse));
      }
      return row;
    };
    // Rings run inboard -> outboard. For the +X wheels that is increasing world
    // x and the quad order below is outward; for the -X wheels it is decreasing,
    // so the quad is reversed. Getting this backwards inverts the normals in a
    // way that only shows up under a low sun, which is how the shell's own
    // winding note came to be written.
    const band = (r0, r1) => {
      for (let s = 0; s < seg; s++) {
        const t = (s + 1) % seg;
        if (out > 0) b.quad(r0[s], r0[t], r1[t], r1[s]);
        else b.quad(r0[s], r1[s], r1[t], r0[t]);
      }
    };
    // THE RIM FACE NEEDS THE OPPOSITE WINDING, and round 1 did not give it one.
    //
    // `band` above sweeps ALONG THE AXLE: its two rings differ in x, and its quad
    // order is correct for that. The rim face sweeps OUTWARD IN RADIUS at
    // constant-ish x, which is the opposite handedness, so the same quad order
    // faces the triangles inboard. The material is FrontSide, so inboard means
    // CULLED: the shipped round-1 wheel drew 8 of its 24 rim triangles - the hub
    // fan and nothing else. Every wheel, every car, all four corners.
    //
    // This is why two independent blind reviews measured the round-1 wheel as "a
    // hole plus a speck" and "only visible at 6x gain": the hole is the culled
    // spoke ring, and the speck is the hub fan, which is a 20 degree cone and so
    // always presents a facet at the mirror angle - hubPeak 27.9 against 1.6-2.3
    // in photographs. It also explains why the wheel got WORSE at dusk and night:
    // with no sun there is nothing for the cone to catch, and nothing else drawn.
    //
    // Nothing in this project could have caught it. The triangle count was right,
    // the colours were right, the palette was right. tools/car-surface.mjs
    // --selftest now carries a winding audit, because a geometry that is wrong
    // only in its index order is invisible to every metric that reads pixels.
    const faceBand = (r0, r1) => {
      for (let s = 0; s < seg; s++) {
        const t = (s + 1) % seg;
        if (out > 0) b.quad(r0[s], r1[s], r1[t], r0[t]);
        else b.quad(r0[s], r0[t], r1[t], r1[s]);
      }
    };
    const fan = (centre, r0, outward) => {
      for (let s = 0; s < seg; s++) {
        const t = (s + 1) % seg;
        if (outward) b.tri(centre, r0[s], r0[t]);
        else b.tri(centre, r0[t], r0[s]);
      }
    };
    const treadIn = ring(-HW, R, tyreC, SURFACE.tyre);
    const treadOut = ring(HW * 0.74, R, tyreC, SURFACE.tyre);
    const bead = ring(HW, RR, tyreC, SURFACE.tyre);
    band(treadIn, treadOut);                       // tread
    band(treadOut, bead);                          // outboard sidewall
    fan(b.vert(wx - out * HW, wy, wz, tyreC, SURFACE.tyre), treadIn, out < 0);
    // Outboard face: bright lip, a lobed spoke annulus, a FLAT bright hub disc.
    //
    // Round 1 built this as one lobed ring plus a hub CONE - a single centre
    // vertex at x = HW fanning out to a ring recessed 32 mm, which is a 20 degree
    // spike sticking out of the wheel. The second blind review measured what that
    // costs: hubPeak (p95 of the rim core over the tyre median) 5.2 to 27.9,
    // against 1.6-2.3 measured on real photographs of parked cars, over a bright
    // fraction of 0.5% where the photographs read 8-29%. In words: a dark hole
    // with one blown specular dot in it. A cone is the one shape guaranteed to
    // present some facet at the mirror angle whatever the sun is doing.
    //
    // The profile below is buildPlayerCar's, coarsened. That car is in the same
    // frames, on the same renderer, under the same light, and it PASSES all four
    // photograph measures at 21.6 px - two thirds the size of the ambient wheel
    // that fails - so the gap is an asset gap, not a resolution limit, and the
    // asset that closes it already exists in this file. Its shape is: bright hub
    // disc, dark lobed annulus, bright outer lip. Three things at three radii,
    // which is what gives a bright MINORITY rather than a bright disc or a hole.
    //
    // 40 triangles a wheel against 24, +64 a car; the deleted boot shut pays 12
    // of that back. Priced by building it, not by counting quads - the round-1
    // note in this file got that arithmetic wrong by a factor of two.
    const lip = lobeRing(HW, 0, RR, 1);
    // dip 0.008, not round 1's 0.032, and the reason is Nyquist. At seg 8 with 4
    // spokes the lobe is sampled exactly twice per period, so it is not a smooth
    // relief - it is a hard alternation, every quad spanning one dipped vertex
    // and one proud one. At a 32 mm dip that quad is twisted enough that its two
    // triangles disagree about which way they face, and the winding audit above
    // reports 8 of 32 still inward AFTER the handedness fix. It is also invisible:
    // 32 mm on a 0.72 m wheel at 34 px is 1.4 px of depth. The lobe's real work
    // here is the COLOUR, which reads at any size; the depth only has to be
    // enough to break the shading up under a low sun.
    const spoke = lobeRing(HW * 0.88, 0.008, RR * 0.66, 0);
    const hubR = lobeRing(HW * 0.99, 0, RR * 0.30, 1);
    faceBand(spoke, lip);
    faceBand(hubR, spoke);
    fan(b.vert(wx + out * HW * 0.99, wy, wz, rimC, SURFACE.rimCoarse), hubR, out > 0);
  }

  const g = b.geometry();
  g.translate(0, (opts.groundY ?? 0) - P.ground, 0);
  g.computeBoundingSphere();
  return g;
}

/** The material a traffic/pursuit InstancedMesh needs to read the palette. */
export function trafficCarMaterial(opts = {}) {
  const m = carSurfaceMaterial({ envMapIntensity: opts.envMapIntensity ?? 1.2 });
  m.color.setHex(opts.color ?? 0xffffff);
  return m;
}
