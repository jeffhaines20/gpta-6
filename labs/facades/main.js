// Facade lab: eight buildings, one per recipe, built through exactly the path the
// streamer will use — pickRecipe -> buildingStyle -> appendBuilding into shared
// arrays -> one merged geometry per material. The HUD reports the numbers the
// budget gate cares about, because a facade system that looks right and costs 500
// draw calls has not solved the problem.

import * as THREE from '../../vendor/three.module.min.js';
import { TimeOfDay } from '../../src/daynight.js';
import { PostStack } from '../../src/post.js';
import {
  RECIPES, RECIPE_NAMES, generateFacadeLibrary, facadeMaterial, trimMaterial,
  trimMaps, trimCell, TRIM, buildingStyle, buffers, appendBuilding, box,
  setAllFacadeTimes,
} from '../../src/facades.js';

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
const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.5, 2500);

// ------------------------------------------------------------------ footprints
// Hand-authored parcels in the shapes OSM actually produces: rectangles, a
// chamfered corner block, an L, and a notched tower plate. Each carries the same
// fields as a district.json building so the recipe picker runs for real.

function rect(w, d) {
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
}
function chamfer(w, d, c) {
  return [[-w / 2 + c, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2 + c]];
}
function ell(w, d, cw, cd) {
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2 - cd], [-w / 2 + cw, d / 2 - cd],
          [-w / 2 + cw, d / 2], [-w / 2, d / 2]];
}
function notched(w, d, n) {
  return [[-w / 2, -d / 2 + n], [-w / 2 + n, -d / 2 + n], [-w / 2 + n, -d / 2], [w / 2 - n, -d / 2],
          [w / 2 - n, -d / 2 + n], [w / 2, -d / 2 + n], [w / 2, d / 2 - n], [w / 2 - n, d / 2 - n],
          [w / 2 - n, d / 2], [-w / 2 + n, d / 2], [-w / 2 + n, d / 2 - n], [-w / 2, d / 2 - n]];
}

// zone / kind tags copied from the vocabulary in data/district.json.
const LOT = [
  { ring: rect(23, 13),          h: 7.8,  z: 'commercial',  k: 'retail'     },
  { ring: ell(13, 10, 5, 3),     h: 3.4,  z: 'residential', k: 'house'      },
  { ring: chamfer(19, 15, 4),    h: 15.2, z: 'commercial',  k: 'commercial' },
  { ring: rect(25, 17),          h: 25.2, z: 'commercial',  k: 'office'     },
  { ring: notched(21, 21, 3.5),  h: 56.7, z: 'residential', k: 'apartments' },
  { ring: rect(31, 22),          h: 15.0, z: 'parking',     k: 'parking'    },
  { ring: rect(35, 19),          h: 9.2,  z: 'industrial',  k: 'warehouse'  },
  { ring: chamfer(21, 14, 3),    h: 11.4, z: 'commercial',  k: 'commercial' },
];

// Lay them along +X against a common street line at z = 0, so every ground floor
// faces the camera and the storefront recesses are visible. Gaps are uneven on
// purpose: a downtown block is party walls interrupted by the occasional lot.
const GAPS = [1, 8, 1, 6, 12, 6, 8];
let cursor = 0;
const lots = LOT.map((l, i) => {
  let x0 = Infinity, x1 = -Infinity, z1 = -Infinity, area = 0;
  for (const [x, z] of l.ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z > z1) z1 = z;
  }
  for (let a = 0, j = l.ring.length - 1; a < l.ring.length; j = a++) {
    area += (l.ring[j][0] + l.ring[a][0]) * (l.ring[j][1] - l.ring[a][1]);
  }
  const ox = cursor - x0, oz = -z1;             // front face on the street line
  cursor += (x1 - x0) + (GAPS[i] ?? 0);
  return {
    p: l.ring.map(([x, z]) => [+(x + ox).toFixed(2), +(z + oz).toFixed(2)]),
    h: l.h, z: l.z, k: l.k, a: Math.round(Math.abs(area / 2)), d: 1,
  };
});
const rowLength = cursor;

// ---------------------------------------------------------------- generation
const gen = generateFacadeLibrary();

// One material per recipe, one for all trim. Both factories are memoised, so this
// is the total material count no matter how many buildings are placed.
const facadeMats = {};
for (const n of RECIPE_NAMES) facadeMats[n] = facadeMaterial(n, { time: 'night' });
const trimMat = trimMaterial();

// -------------------------------------------------------------- build the row
const wallBufs = {};
const trimBuf = buffers();
const picked = [];

const tBuild0 = performance.now();
for (const b of lots) {
  const style = buildingStyle(b);
  picked.push({ recipe: style.recipe, h: b.h, floors: style.floors, k: b.k });
  const wall = (wallBufs[style.recipe] ??= buffers());
  appendBuilding(b.p, b.h, style, wall, trimBuf, { street: [0, 1] });
}
const buildMs = performance.now() - tBuild0;

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
scene.add(city);

// -------------------------------------------------------- ground and furniture
// Street, kerb and lamp posts all come out of the same trim atlas as the kit and
// append into one buffer, so the whole environment costs a single draw call and
// no texture of its own.
const envBuf = buffers();
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
const X0 = -80, X1 = rowLength + 80;
groundPlane(envBuf, X0, X1, -60, 7.4, -0.02, TRIM.concrete, 5);      // sidewalk
groundPlane(envBuf, X0, X1, 7.4, 46, -0.14, TRIM.asphalt, 6);        // carriageway
const kerbArgs = { cell: TRIM.concrete, col: envBuf.col, tint: [1, 1, 1] };
box((X0 + X1) / 2, -0.07, 7.4, X1 - X0, 0.16, 0.34,
  envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, kerbArgs);

// ------------------------------------------------------------------ lighting
const tod = new TimeOfDay(scene, renderer);
const lampArgs = { cell: TRIM.metalDark, col: envBuf.col, tint: [1, 1, 1] };
for (let i = 0; i < 7; i++) {
  const x = 10 + (rowLength / 6.5) * i;
  box(x, 4.1, 8.6, 0.2, 8.2, 0.2, envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, lampArgs);
  box(x - 0.55, 8.1, 8.6, 1.3, 0.16, 0.16, envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, lampArgs);
  box(x - 1.1, 7.86, 8.6, 0.6, 0.34, 0.44, envBuf.pos, envBuf.nrm, envBuf.uv, envBuf.idx, lampArgs);
  const light = new THREE.PointLight(0xffd2a0, 0, 44, 2);
  light.position.set(x - 1.1, 7.6, 8.6);
  scene.add(light);
  tod.registerLamp(light, 900);
}
const env = new THREE.Mesh(toGeometry(envBuf), trimMat);
env.receiveShadow = true;
env.castShadow = true;
env.name = 'street';
scene.add(env);

// ------------------------------------------------------------------- camera
// Three framings: down the row (the one that shows depth and lit windows),
// straight elevation (for judging the texture itself), and a close 3/4 on the
// deco block and the tower (for judging reveals, cornices and storefronts).
const SHOTS = [
  { pos: [-40, 17, 52], look: [rowLength * 0.44, 20, -10], fov: 44 },
  { pos: [rowLength / 2, 28, 205], look: [rowLength / 2, 22, 0], fov: 40 },
  { pos: [32, 6.5, 31], look: [76, 13, -3], fov: 40 },
];
let shot = 0, yaw = 0, pitch = 0, dist = 1;
function applyShot() {
  const s = SHOTS[shot];
  const look = new THREE.Vector3(...s.look);
  const off = new THREE.Vector3(...s.pos).sub(look);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta += yaw; sph.phi = THREE.MathUtils.clamp(sph.phi + pitch, 0.12, 1.54);
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
  applyShot();
});
canvas.addEventListener('wheel', (e) => {
  dist = THREE.MathUtils.clamp(dist * (1 + Math.sign(e.deltaY) * 0.09), 0.25, 4);
  applyShot();
  e.preventDefault();
}, { passive: false });

function setShot(i) { shot = i; yaw = pitch = 0; dist = 1; applyShot(); }

// Draw calls are measured from a direct scene render with every mesh in frame,
// BEFORE the post stack takes over — renderer.info afterwards reports the last
// fullscreen pass and would flatter the number to 1.
setShot(1);
renderer.setSize(1600, 900, false);
renderer.render(scene, camera);
const scenePass = {
  calls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  meshes: (() => { let n = 0; scene.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
};

// The project's HDR chain owns tonemapping, and daynight.js hands it the exposure
// and bloom settings for the hour. Lit windows only read as emitters once bloom is
// in, so the lab uses it — but it belongs to another module, so a failure here
// falls back to rendering straight to the canvas rather than taking the lab down.
let post = null;
try {
  post = new PostStack(renderer, scene, camera);
  tod.attachPost(post);
} catch (err) {
  errors.push('PostStack unavailable: ' + err.message);
  post = null;
}

// ------------------------------------------------------------- time of day
let timeName = 'night';
function setTime(name) {
  timeName = name;
  tod.apply(name);
  setAllFacadeTimes(name);
  draw();
}
window.addEventListener('keydown', (e) => {
  if (e.key === '1') setTime('noon');
  if (e.key === '2') setTime('dusk');
  if (e.key === '3') setTime('night');
  if (e.key === '4') { setShot(0); draw(); }
  if (e.key === '5') { setShot(1); draw(); }
  if (e.key === '6') { setShot(2); draw(); }
  if (e.key === 'p' && post) { dropPost(); }
});

// ----------------------------------------------------------------- reporting
function stats() {
  const r = renderer.info;
  const mats = new Set(), texs = new Set();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    mats.add(o.material);
    for (const k of ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap']) {
      if (o.material[k]) texs.add(o.material[k]);
    }
  });
  return {
    genMs: gen.ms, perRecipeMs: gen.per, chunkBuildMs: +buildMs.toFixed(2),
    drawCalls: scenePass.calls, triangles: scenePass.triangles,
    meshes: scenePass.meshes,
    geometries: r.memory.geometries, textures: r.memory.textures,
    materials: mats.size, sceneTextures: texs.size,
    programs: renderer.info.programs?.length ?? 0,
    time: timeName, post: !!post,
    exposure: post ? post.params.exposure : renderer.toneMappingExposure,
    buildings: picked, errors,
  };
}

function updateHud() {
  const s = stats();
  const rec = picked.map((p, i) => `  ${i + 1} ${p.recipe.padEnd(13)} ${String(p.h).padStart(5)} m  ${p.floors}f`).join('\n');
  hud.textContent =
`FACADE LAB — ${RECIPE_NAMES.length} recipes, ${lots.length} buildings
generation    ${s.genMs.toFixed(1)} ms   (every texture, once)
kit geometry  ${s.chunkBuildMs} ms for ${lots.length} buildings
draw calls    ${s.drawCalls} for ${s.meshes} meshes   triangles ${s.triangles.toLocaleString()}
materials     ${s.materials}   textures ${s.textures}   programs ${s.programs}
time of day   ${s.time}  exposure 1/${Math.round(1 / s.exposure)}  post ${s.post ? 'on' : 'off'}
${rec}`;
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
  post = null;
  tod.post = null;
  tod.apply(timeName);
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
document.getElementById('load').remove();

// The lab is a static frame by design: nothing animates, so re-rendering every
// frame would only burn the software renderer's budget in this container.
window.__lab = {
  ready: true, stats, setTime, setShot: (i) => { setShot(i); draw(); },
  recipes: RECIPES, trimAtlas: () => trimMaps(),
  renderer, scene, camera, tod, THREE, draw,
};
draw();
