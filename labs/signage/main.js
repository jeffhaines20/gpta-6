// Signage lab: a twelve-storefront street elevation plus a rack of every street
// sign, built through exactly the path the streamer will use — buildingStyle ->
// appendBuilding for the shell, then signPlanFor -> appendBuildingSignage into
// two shared buffers, merged into one mesh per material.
//
// The numbers in the HUD are the ones that decide whether this ships: how many
// draw calls the whole street costs, how many textures are bound, and how long
// the atlases took to generate. A signage system that looks right and costs a
// draw call per sign has not solved the problem it exists to solve.

import * as THREE from '../../vendor/three.module.min.js';
import { TimeOfDay } from '../../src/daynight.js';
import { PostStack } from '../../src/post.js';
import {
  generateFacadeLibrary, facadeMaterial, trimMaterial, trimCell, TRIM,
  buildingStyle, buffers as facadeBuffers, appendBuilding, box,
  setAllFacadeTimes, RECIPE_NAMES,
} from '../../src/facades.js';
import {
  generateSignageLibrary, signMaterial, streetSignMaterial, setSignageTime,
  buffers as signBuffers, appendBuildingSignage, signPlanFor,
  streetBladeAssembly, regulatorySign, parkingSign, wideSign, planStreetSignage,
  districtSignageBuffers,
  shopAtlas, streetAtlas, BUSINESSES, REG_SIGNS, TALL_SIGNS, WIDE_SIGNS,
} from '../../src/signage.js';

const errors = [];
window.__errors = errors;
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.4, 2000);

// The invented street names come from the bake. Fetching a local static JSON is
// the same thing district/main.js does; nothing here reaches the network.
let district = null;
try {
  district = await (await fetch('../../data/district.json')).json();
} catch (err) {
  errors.push('district.json unavailable: ' + err.message);
}
const streetNames = district ? [...new Set(Object.values(district.streetNames))] : undefined;

// ------------------------------------------------------------------ the block
// Twelve parcels on a party-wall street line, in the shapes and sizes the bake
// actually produces downtown. Widths are uneven so tenancy splitting has
// something to do: a 22 m frontage is two shops, a 9 m frontage is one.
const LOTS = [
  { w: 16, d: 14, h: 8.4,  k: 'retail',     gap: 0 },
  { w: 22, d: 17, h: 12.6, k: 'commercial', gap: 0 },
  { w: 11, d: 13, h: 7.6,  k: 'restaurant', gap: 0 },
  { w: 19, d: 16, h: 15.4, k: 'commercial', gap: 3.5 },
  { w: 13, d: 12, h: 7.9,  k: 'retail',     gap: 0 },
  { w: 26, d: 18, h: 11.2, k: 'commercial', gap: 0 },
  { w: 10, d: 12, h: 6.8,  k: 'retail',     gap: 2.2 },
  { w: 17, d: 15, h: 13.8, k: 'commercial', gap: 0 },
  { w: 21, d: 16, h: 9.6,  k: 'retail',     gap: 0 },
  { w: 12, d: 13, h: 7.2,  k: 'restaurant', gap: 3.0 },
  { w: 24, d: 17, h: 16.5, k: 'commercial', gap: 0 },
  { w: 15, d: 14, h: 8.8,  k: 'retail',     gap: 0 },
];

let cursor = 0;
const lots = LOTS.map((l) => {
  cursor += l.gap;
  const x0 = cursor, x1 = cursor + l.w;
  cursor = x1;
  // Front edge on the street line at z = 0; the parcel runs back into -z. A tiny
  // chamfer on one rear corner keeps the ring from being a perfect rectangle,
  // which is what the real footprints look like.
  const p = [[x0, 0], [x1, 0], [x1, -l.d + 1.4], [x1 - 1.4, -l.d], [x0, -l.d]];
  return { p, h: l.h, z: 'commercial', k: l.k, a: Math.round(l.w * l.d), d: 1 };
});
const rowLength = cursor;

// The opposite side of the street. Deliberately low-rise (6-9 m), both because
// that is what faces a downtown high street and because the elevation camera has
// to see over it to the main row.
const FACING_Z = 30;
const FACING = [
  { w: 18, d: 12, h: 7.4,  k: 'retail',     gap: 6 },
  { w: 24, d: 13, h: 8.8,  k: 'commercial', gap: 0 },
  { w: 13, d: 11, h: 6.6,  k: 'restaurant', gap: 4 },
  { w: 20, d: 12, h: 8.6,  k: 'retail',     gap: 0 },
  { w: 16, d: 12, h: 7.0,  k: 'retail',     gap: 3 },
  { w: 22, d: 13, h: 8.9,  k: 'commercial', gap: 0 },
  { w: 15, d: 11, h: 6.9,  k: 'retail',     gap: 5 },
];
let fcursor = 14;
const facingLots = FACING.map((l) => {
  fcursor += l.gap;
  const x0 = fcursor, x1 = fcursor + l.w;
  fcursor = x1;
  // Wound so the front edge faces -z, back into the street.
  const p = [[x1, FACING_Z], [x0, FACING_Z], [x0, FACING_Z + l.d],
             [x1 - 1.4, FACING_Z + l.d], [x1, FACING_Z + l.d - 1.4]];
  return { p, h: l.h, z: 'commercial', k: l.k, a: Math.round(l.w * l.d), d: 1 };
});

// ---------------------------------------------------------------- generation
const genFacade = generateFacadeLibrary();
const tSign0 = performance.now();
const genSign = generateSignageLibrary({ streetNames });
const signMs = performance.now() - tSign0;

const facadeMats = {};
for (const n of RECIPE_NAMES) facadeMats[n] = facadeMaterial(n, { time: 'night' });
const trimMat = trimMaterial();
const shopSignMat = signMaterial({ time: 'night' });
const streetSignMat = streetSignMaterial({ time: 'night', names: streetNames });

// -------------------------------------------------------------- build the row
const wallBufs = {};
const trimBuf = facadeBuffers();
const signBuf = signBuffers();
const streetBuf = signBuffers();
const picked = [];
const emitters = [];

const tBuild0 = performance.now();
let tenantCount = 0, signCount = 0;
function addBuilding(b, street, record) {
  const style = buildingStyle(b);
  // The facade kit's own awnings carry no name, and two layers of cloth on one
  // bay reads as a bug. signage.js owns awnings from here.
  style.awnings = false;
  const wall = (wallBufs[style.recipe] ??= facadeBuffers());
  appendBuilding(b.p, b.h, style, wall, trimBuf, { street });

  const plan = signPlanFor(b, style, { street });
  const res = appendBuildingSignage(b, style, signBuf, trimBuf, { street, plan });
  tenantCount += plan.tenants.length;
  signCount += res.signs;
  emitters.push(...res.emitters);
  if (record) {
    picked.push({
      recipe: style.recipe, h: b.h, tenants: plan.tenants.map((t) => t.biz.n),
      parapet: plan.parapet ? plan.parapet.biz.n : null,
    });
  }
}
for (const b of lots) addBuilding(b, [0, 1], true);
for (const b of facingLots) addBuilding(b, [0, -1], false);
const buildMs = performance.now() - tBuild0;

// ------------------------------------------------------- street signage panel
// One of everything the street atlas holds, laid out as two staggered rows on
// the near kerb so the whole set frames in a single head-on shot at 15 m, where
// a 0.76 m stop face is ~95 px and its legend is actually readable. One long row
// would push the camera back until nothing on it could be read.
const RACK_X = 6;
const ROW_A = 9.4, ROW_B = 5.4;
const rackNames = (streetNames ?? []).slice();
const pickName = (i) => rackNames.length ? rackNames[(i * 11 + 3) % rackNames.length] : 'Marlin Street';

let ax = RACK_X;
const stepA = (fn, step) => { fn(ax); ax += step; };
stepA((x) => streetBladeAssembly(x, ROW_A, 0, [pickName(0), pickName(1)], streetBuf, trimBuf), 3.7);
for (const k of REG_SIGNS) stepA((x) => regulatorySign(x, ROW_A, 0, k, streetBuf, trimBuf), 1.75);
for (const k of TALL_SIGNS) stepA((x) => parkingSign(x, ROW_A, 0, k, streetBuf, trimBuf), 1.4);

let bx = RACK_X + 1.1;
const stepB = (fn, step) => { fn(bx); bx += step; };
// The back row is mounted higher so row A does not eat its legends.
for (const k of WIDE_SIGNS) {
  stepB((x) => wideSign(x, ROW_B, 0, k, streetBuf, trimBuf, { y: 3.35 }), 2.15);
}
// A second run of blades so several invented street names read at once.
for (let i = 0; i < 2; i++) {
  stepB((x) => streetBladeAssembly(x, ROW_B, 0, [pickName(i + 2), pickName(i + 7)],
    streetBuf, trimBuf, { height: 4.0 }), 3.3);
}
const rackEnd = Math.max(ax, bx);

// A corner of real street signage in the middle of the block, so the hero shot
// shows signs in context rather than only on a demo rack.
streetBladeAssembly(rowLength * 0.62, 10.0, Math.PI * 0.5, [pickName(4), pickName(5)],
  streetBuf, trimBuf);
regulatorySign(rowLength * 0.62 + 3.2, 10.0, Math.PI, 'stop', streetBuf, trimBuf);
wideSign(rowLength * 0.62 - 3.4, 10.0, Math.PI, 'oneWayRight', streetBuf, trimBuf);
parkingSign(rowLength * 0.30, 10.0, Math.PI, 'parking', streetBuf, trimBuf);
parkingSign(rowLength * 0.84, 10.0, Math.PI, 'noParking', streetBuf, trimBuf);

// The planner run against the real baked graph. Nothing here is drawn — the
// point is to prove the plan comes out of district.json with sane counts before
// the streamer wires it in.
const streetPlan = district ? planStreetSignage(district) : null;

// What signage actually costs the district, measured rather than asserted. Both
// integration routes are built for real against data/district.json so the number
// in the HUD is a count of meshes that exist, not an estimate.
function districtCost() {
  if (!district) return null;
  // Route A — signage merged into each near chunk. Costs one draw call per
  // resident near chunk that holds a signed building, and the streamer keeps a
  // 5x5 window of chunks at LOD0, so the worst case is the busiest such window.
  const t0 = performance.now();
  const signed = new Set();
  district.buildings.forEach((b, i) => {
    const style = buildingStyle(b);
    if (!style.storefront) return;
    const plan = signPlanFor(b, style, {});
    if (plan.tenants.length || plan.parapet) signed.add(i);
  });
  const chunksWithSigns = new Set();
  for (const [key, ch] of Object.entries(district.chunks)) {
    if (ch.buildings.some((i) => signed.has(i))) chunksWithSigns.add(key);
  }
  let worst = 0;
  for (const key of Object.keys(district.chunks)) {
    const [cx, cz] = key.split(',').map(Number);
    let n = 0;
    for (let i = cx - 2; i <= cx + 2; i++) {
      for (let j = cz - 2; j <= cz + 2; j++) if (chunksWithSigns.has(`${i},${j}`)) n++;
    }
    if (n > worst) worst = n;
  }
  const perChunkMs = performance.now() - t0;

  // Route B — the whole district in a few spatial buckets, built once at load.
  const dist = districtSignageBuffers(district, { streetPlan });
  return {
    scanMs: +perChunkMs.toFixed(1),
    signedBuildings: dist.stats.signedBuildings, tenancies: dist.stats.tenancies,
    chunks: chunksWithSigns.size, totalChunks: Object.keys(district.chunks).length,
    perChunkWorstCalls: worst + 1,
    ...dist.stats,
  };
}
const cost = districtCost();

// -------------------------------------------------------- ground and lighting
const envBuf = facadeBuffers();
function groundPlane(buf, x0, x1, z0, z1, y, cell, step) {
  const c = trimCell(cell);
  const nx = Math.max(1, Math.round((x1 - x0) / step));
  const nz = Math.max(1, Math.round((z1 - z0) / step));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const ax = x0 + ((x1 - x0) * i) / nx, bx = x0 + ((x1 - x0) * (i + 1)) / nx;
      const az = z0 + ((z1 - z0) * j) / nz, bz = z0 + ((z1 - z0) * (j + 1)) / nz;
      const v = buf.pos.length / 3;
      buf.pos.push(ax, y, bz, bx, y, bz, bx, y, az, ax, y, az);
      for (let k = 0; k < 4; k++) { buf.nrm.push(0, 1, 0); buf.col.push(1, 1, 1); }
      buf.uv.push(c.u0, c.v0, c.u1, c.v0, c.u1, c.v1, c.u0, c.v1);
      buf.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
  }
}
const X0 = -30, X1 = Math.max(rowLength, rackEnd) + 30;
groundPlane(envBuf, X0, X1, -40, 10.4, -0.02, TRIM.concrete, 5);
groundPlane(envBuf, X0, X1, 10.4, 27.4, -0.16, TRIM.asphalt, 8);
groundPlane(envBuf, X0, X1, 27.4, 90, -0.02, TRIM.concrete, 5);
for (const kz of [10.4, 27.4]) {
  box((X0 + X1) / 2, -0.09, kz, X1 - X0, 0.16, 0.34,
    envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx,
    { cell: TRIM.concrete, col: envBuf.col, tint: [1, 1, 1] });
}

// A lab-local sky. src/sky.js belongs to another builder and is still queued, so
// rather than depend on it — or ship a screenshot that is half black rectangle —
// this is a 2 px gradient strip per hour on an inverted sphere. The scales are
// in the same linear units the post stack tonemaps, which is why they differ by
// four orders of magnitude: exposure runs 1/78000 at noon and 1/2.2 at night.
const SKY = {
  noon:  { stops: ['#3f7fd0', '#7ba9e0', '#b8cfee', '#dfe6ee'], scale: 42000 },
  dusk:  { stops: ['#233a6b', '#4a5a92', '#a06a72', '#e8925a'], scale: 620 },
  night: { stops: ['#0a0f1c', '#131c33', '#2b2a44', '#6b4a38'], scale: 8 },
};
const skyTex = {};
for (const [name, def] of Object.entries(SKY)) {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  def.stops.forEach((col, i) => grad.addColorStop(i / (def.stops.length - 1), col));
  g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  skyTex[name] = t;
}
const skyMat = new THREE.MeshBasicMaterial({ map: skyTex.night, side: THREE.BackSide, fog: false });
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1200, 24, 16), skyMat);
skyDome.renderOrder = -2;
scene.add(skyDome);

const tod = new TimeOfDay(scene, renderer);
const lampArgs = { cell: TRIM.metalDark, col: envBuf.col, tint: [1, 1, 1] };
for (let i = 0; i < 8; i++) {
  const x = 8 + (X1 - X0 - 60) / 7 * i;
  box(x, 4.1, 11.6, 0.2, 8.2, 0.2, envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, lampArgs);
  box(x - 0.6, 8.1, 11.6, 1.4, 0.16, 0.16, envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, lampArgs);
  box(x - 1.2, 7.86, 11.6, 0.6, 0.34, 0.44, envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, lampArgs);
  const light = new THREE.PointLight(0xffd2a0, 0, 46, 2);
  light.position.set(x - 1.2, 7.6, 11.6);
  scene.add(light);
  tod.registerLamp(light, 950);
}

// Lit signs are emitters too. daynight.js calls 40-600 cd plausible for a shop,
// and appendBuildingSignage returns exactly that list — a handful of the nearest
// are wired up here so the neon spills onto the pavement instead of floating.
const NEON_LIGHTS = 8;
emitters.sort((a, b) => a.x - b.x);
for (let i = 0; i < Math.min(NEON_LIGHTS, emitters.length); i++) {
  const em = emitters[Math.floor((i + 0.5) * emitters.length / NEON_LIGHTS)];
  const col = new THREE.Color().setHSL(em.hue / 360, 0.75, 0.6, THREE.SRGBColorSpace);
  const l = new THREE.PointLight(col, 0, 16, 2);
  l.position.set(em.x, em.y, em.z);
  scene.add(l);
  tod.registerLamp(l, em.candela);
}

// ------------------------------------------------------------------- meshing
function toGeometry(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  return g;
}

const city = new THREE.Group();
for (const [name, buf] of Object.entries(wallBufs)) {
  const m = new THREE.Mesh(toGeometry(buf), facadeMats[name]);
  m.castShadow = m.receiveShadow = true;
  m.name = `walls:${name}`;
  city.add(m);
}
const trimMesh = new THREE.Mesh(toGeometry(trimBuf), trimMat);
trimMesh.castShadow = trimMesh.receiveShadow = true;
trimMesh.name = 'trim';
city.add(trimMesh);

const signMesh = new THREE.Mesh(toGeometry(signBuf), shopSignMat);
signMesh.castShadow = signMesh.receiveShadow = true;
signMesh.name = 'signage:shop';
city.add(signMesh);

const streetMesh = new THREE.Mesh(toGeometry(streetBuf), streetSignMat);
streetMesh.castShadow = streetMesh.receiveShadow = true;
streetMesh.name = 'signage:street';
city.add(streetMesh);

const env = new THREE.Mesh(toGeometry(envBuf), trimMat);
env.receiveShadow = env.castShadow = true;
env.name = 'street';
city.add(env);
scene.add(city);

// -------------------------------------------------------------------- camera
const rackMid = (RACK_X + rackEnd) / 2;
// The row recedes to the LEFT in shot 0 on purpose: the HUD lives in the top-left
// corner, so the near storefronts — the ones whose wordmarks have to be legible —
// belong on the right where nothing covers them.
const SHOTS = [
  { pos: [rowLength * 0.90, 5.0, 16.5], look: [rowLength * 0.02, 3.4, 14], fov: 54 },
  // Elevated just enough to clear the facing row (9.4 m max) at z = 30, and long
  // enough in the lens that all twelve frontages fit a letterboxed frame — which
  // is the shape an elevation actually wants.
  { pos: [rowLength / 2, 24, 150], look: [rowLength / 2, 7, 0], fov: 26 },
  { pos: [rackMid, 2.9, ROW_A + 15], look: [rackMid, 2.5, ROW_A - 1], fov: 46 },
  { pos: [81, 4.2, 16.5], look: [52, 5.2, -2], fov: 44 },
];
let shot = 0, yaw = 0, pitch = 0, dist = 1;
function applyShot() {
  const s = SHOTS[shot];
  const look = new THREE.Vector3(...s.look);
  const off = new THREE.Vector3(...s.pos).sub(look);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta += yaw; sph.phi = THREE.MathUtils.clamp(sph.phi + pitch, 0.12, 1.55);
  sph.radius *= dist;
  camera.position.copy(look).add(new THREE.Vector3().setFromSpherical(sph));
  camera.fov = s.fov;
  camera.lookAt(look);
  camera.updateProjectionMatrix();
}
let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; });
window.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  yaw -= (e.clientX - drag[0]) * 0.005;
  pitch -= (e.clientY - drag[1]) * 0.004;
  drag = [e.clientX, e.clientY];
  applyShot(); draw();
});
canvas.addEventListener('wheel', (e) => {
  dist = THREE.MathUtils.clamp(dist * (1 + Math.sign(e.deltaY) * 0.09), 0.2, 4);
  applyShot(); draw();
  e.preventDefault();
}, { passive: false });
function setShot(i) { shot = i; yaw = pitch = 0; dist = 1; applyShot(); }

// Draw calls are measured from a direct scene render, BEFORE the post stack runs
// — renderer.info afterwards describes the last fullscreen blit and would report
// 1, which is the trap PROGRESS.md records the chase harness falling into.
//
// The measurement camera is deliberately not one of the presentation shots: it
// frames the entire row AND the sign rack, so nothing is frustum-culled and the
// signage delta is the real cost rather than an artefact of what happens to be
// on screen.
renderer.setSize(1600, 1000, false);
const measureCam = new THREE.PerspectiveCamera(60, 1.6, 0.4, 2000);
measureCam.position.set(rowLength / 2, 90, 170);
measureCam.lookAt(rowLength / 2, 0, -10);
measureCam.updateProjectionMatrix();
const measure = () => {
  renderer.render(scene, measureCam);
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
};
const scenePass = {
  ...measure(),
  meshes: (() => { let n = 0; scene.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
};
signMesh.visible = streetMesh.visible = false;
const withoutSignage = measure();
signMesh.visible = streetMesh.visible = true;

let post = null;
try {
  post = new PostStack(renderer, scene, camera);
  tod.attachPost(post);
} catch (err) {
  errors.push('PostStack unavailable: ' + err.message);
  post = null;
}

// ---------------------------------------------------------------- time of day
let timeName = 'night';
function setTime(name) {
  timeName = name;
  tod.apply(name);
  setAllFacadeTimes(name);
  setSignageTime(name);
  skyMat.map = skyTex[name] ?? skyTex.night;
  skyMat.color.setScalar(SKY[name]?.scale ?? 1);
  skyMat.needsUpdate = true;
  draw();
}
window.addEventListener('keydown', (e) => {
  if (e.key === '1') setTime('noon');
  if (e.key === '2') setTime('dusk');
  if (e.key === '3') setTime('night');
  if (e.key >= '4' && e.key <= '7') { setShot(+e.key - 4); draw(); }
});

// ------------------------------------------------------------------ reporting
function stats() {
  const mats = new Set(), texs = new Set();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    mats.add(o.material);
    for (const k of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap']) {
      if (o.material[k]) texs.add(o.material[k]);
    }
  });
  const shop = shopAtlas(), street = streetAtlas();
  return {
    signGenMs: +signMs.toFixed(1), signGen: genSign,
    facadeGenMs: genFacade.ms,
    geometryMs: +buildMs.toFixed(2),
    drawCalls: scenePass.calls, triangles: scenePass.triangles, meshes: scenePass.meshes,
    signageDrawCalls: scenePass.calls - withoutSignage.calls,
    signageTriangles: scenePass.triangles - withoutSignage.triangles,
    materials: mats.size, sceneTextures: texs.size,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
    storefronts: lots.length, tenants: tenantCount, signs: signCount,
    emitters: emitters.length,
    businesses: BUSINESSES.length,
    shopAtlas: `${shop.W}x${shop.H} ${(shop.util * 100).toFixed(1)}% ${shop.rects.size} cells`,
    streetAtlas: `${street.W}x${street.H} ${(street.util * 100).toFixed(1)}% ${street.rects.size} cells`,
    streetNames: street.names.length,
    district: cost,
    plan: streetPlan ? {
      blades: streetPlan.blades.length, stops: streetPlan.stops.length,
      oneWays: streetPlan.oneWays.length, parking: streetPlan.parking.length,
    } : null,
    time: timeName, post: !!post,
    exposure: post ? post.params.exposure : renderer.toneMappingExposure,
    tenantList: picked, errors,
  };
}

function updateHud() {
  const s = stats();
  hud.textContent =
`SIGNAGE LAB — ${s.storefronts} storefronts · ${s.tenants} tenancies · ${s.signs} signs
atlas   shop   ${s.shopAtlas}
        street ${s.streetAtlas}
        ${s.signGenMs} ms · ${s.signGen.vramMB} MB · ${s.businesses} names · ${s.streetNames} streets
cost    signage ${s.signageDrawCalls} draw calls, ${s.signageTriangles.toLocaleString()} tris, 2 materials
        scene ${s.drawCalls} calls / ${s.triangles.toLocaleString()} tris / ${s.meshes} meshes
        ${s.sceneTextures} textures bound · ${s.programs} programs · ${s.geometryMs} ms geometry
plan    ${s.plan ? `${s.plan.blades} blades · ${s.plan.stops} stops · ${s.plan.oneWays} one-way · ${s.plan.parking} parking` : 'district.json unavailable'}
budget  ${s.district ? `${s.district.signedBuildings} signed buildings · ${s.district.tenancies} tenancies · ${s.district.chunks}/${s.district.totalChunks} chunks
        per-chunk route  +${s.district.perChunkWorstCalls} draw calls worst case (busiest 5x5 near window)
        district route   +${s.district.drawCalls} draw calls flat · ${(s.district.shopTriangles + s.district.streetTriangles).toLocaleString()} tris · ${s.district.ms} ms` : '—'}
time    ${s.time} · exposure 1/${Math.round(1 / s.exposure)} · post ${s.post ? 'on' : 'off'}${s.errors.length ? '\nERRORS  ' + s.errors.join('; ') : ''}`;
}

function draw() {
  if (post) {
    try { post.render(); } catch (err) { errors.push('post.render: ' + err.message); dropPost(); }
  } else {
    renderer.render(scene, camera);
  }
  updateHud();
}
function dropPost() {
  post = null; tod.post = null; tod.apply(timeName);
  renderer.render(scene, camera);
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (post) post.setSize(w, h);
  applyShot();
  draw();
}
window.addEventListener('resize', resize);

setShot(0);
setTime('night');
resize();
document.getElementById('load')?.remove();

// A static frame by design: nothing animates, so re-rendering every frame would
// only burn the software renderer's budget in this container.
window.__lab = {
  ready: true, stats, setTime, setShot: (i) => { setShot(i); draw(); },
  atlases: () => ({ shop: shopAtlas(), street: streetAtlas() }),
  renderer, scene, camera, tod, THREE, draw,
};
draw();
