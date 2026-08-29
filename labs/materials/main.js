// Material lab: every material in the registry on a sphere and on a tiling pad,
// plus the street context the materials actually ship into — a merged road
// ribbon carrying lane paint through the marking atlas, sidewalks, kerbs, and
// building blocks drawn from ONE merged geometry with per-vertex layer + tint.
//
// Keys: 1/2/3 time of day · G/R/A camera · drag to orbit · wheel to zoom.

import * as THREE from '../../vendor/three.module.min.js';
import { TimeOfDay, PRESETS } from '../../src/daynight.js';
import {
  getMaterials, SURFACE_LAYERS, SURFACE_TINTS, MARKINGS,
  applyMarkingUV, surfaceTintRGB,
} from '../../src/materials.js';
import { ribbon, extrudeFootprint } from '../../src/geom.js';

const errBox = document.getElementById('err');
function fail(msg) {
  errBox.style.display = 'block';
  errBox.textContent += msg + '\n';
}
window.addEventListener('error', (e) => fail(`${e.message}\n  ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => fail('promise: ' + e.reason));

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.2, 3000);

const buildStart = performance.now();
const registry = getMaterials({ anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });

// ---------------------------------------------------------------- sky + IBL
// daynight.js owns the lights; the sky here exists so glass, metal and water
// have something to reflect. Radiance is in nits (skyLux / pi) so it sits in the
// same photometric system as the lights rather than fighting the exposure.
const pmrem = new THREE.PMREMGenerator(renderer);
const skyCache = new Map();

function skyEquirect(p, w = 512) {
  const h = w >> 1;
  const data = new Uint16Array(w * h * 4);
  const skyC = new THREE.Color(p.skyColor);
  const grdC = new THREE.Color(p.groundColor);
  const sunC = new THREE.Color(p.sunColor);
  const skyRad = p.skyLux / Math.PI;
  const grdRad = skyRad * 0.30;
  const sunRad = (Math.max(p.sunLux, 0.4) / Math.PI) * 6;
  const sx = Math.cos(p.azimuth) * Math.cos(p.elevation);
  const sy = Math.sin(p.elevation);
  const sz = Math.sin(p.azimuth) * Math.cos(p.elevation);
  const half = THREE.DataUtils.toHalfFloat;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const dy = Math.sin((v - 0.5) * Math.PI);
    const c = Math.sqrt(Math.max(0, 1 - dy * dy));
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w - 0.5) * Math.PI * 2;
      const dx = -Math.cos(phi) * c, dz = Math.sin(phi) * c;
      let r, g, b;
      if (dy >= 0) {
        const horizon = Math.pow(1 - dy, 3.0);          // brighter towards the rim
        const k = skyRad * (0.62 + 0.55 * horizon);
        r = skyC.r * k * (1 + horizon * 0.55);
        g = skyC.g * k * (1 + horizon * 0.35);
        b = skyC.b * k;
      } else {
        const k = grdRad * (1 - Math.min(1, -dy * 0.7));
        r = grdC.r * k; g = grdC.g * k; b = grdC.b * k;
      }
      const d = dx * sx + dy * sy + dz * sz;
      if (d > 0) {
        const blob = Math.pow(d, 900) * 6 + Math.pow(d, 24) * 0.35 + Math.pow(d, 4) * 0.05;
        r += sunC.r * sunRad * blob; g += sunC.g * sunRad * blob; b += sunC.b * sunRad * blob;
      }
      const i = (y * w + x) * 4;
      data[i] = half(r); data[i + 1] = half(g); data[i + 2] = half(b); data[i + 3] = half(1);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function skyFor(name) {
  if (!skyCache.has(name)) {
    const eq = skyEquirect(PRESETS[name]);
    skyCache.set(name, { background: eq, env: pmrem.fromEquirectangular(eq).texture });
  }
  return skyCache.get(name);
}

// ---------------------------------------------------------------- showcase list
// Every wall/roof family x tint pair is realised here, which is the worst case
// the district can reach: the streamer only instantiates the pairs it picks.
const cells = [];
const push = (key, label, group) => cells.push({ key, label, group, mat: registry.get(key) });

for (const [k, l] of [
  ['road', 'road asphalt + paint'], ['sidewalk', 'sidewalk'], ['concrete', 'concrete'],
  ['kerb', 'kerb'], ['kerbPainted', 'kerb painted'], ['parkingLot', 'parking bays'],
  ['grass', 'grass / park'], ['dirt', 'bare dirt'], ['sand', 'sand'], ['land', 'urban ground'],
]) push(k, l, 'ground');

for (const family of SURFACE_LAYERS) {
  for (const tint of Object.keys(SURFACE_TINTS[family])) {
    cells.push({
      key: `${family}:${tint}`, label: `${family} ${tint}`,
      group: family.startsWith('roof') ? 'roof' : 'wall',
      mat: registry.surface(family, tint),
    });
  }
}

for (const [k, l] of [
  ['water', 'bay water'], ['glassStorefront', 'glass storefront'], ['glassTinted', 'glass tinted'],
  ['metalPainted', 'metal painted'], ['metalGalvanised', 'metal galvanised'],
  ['metalAnodised', 'metal anodised'],
]) push(k, l, 'misc');

const mergedMat = registry.buildingMerged();

// ---------------------------------------------------------------- grid
const PAD = 4.2, PITCH = 5.0, COLS = 7;
const gridRoot = new THREE.Group();
scene.add(gridRoot);

// One pad geometry for every cell. UVs are in METRES, matching what
// extrudeFootprint emits for walls, so the wall families tile at their real size.
function padGeometry(size, uvScale = 1) {
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * size * uvScale, uv.getY(i) * size * uvScale);
  }
  uv.needsUpdate = true;
  return g;
}
const padGeo = padGeometry(PAD);
const sphereGeo = new THREE.SphereGeometry(0.95, 40, 28);
// Wall/roof materials read `uv` in metres; a sphere's 0..1 UV would show a
// single stretched texel, so the showcase sphere is re-UVed to metres too.
const sphereMeshUv = sphereGeo.clone();
{
  const uv = sphereMeshUv.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * 3);
  uv.needsUpdate = true;
}

const rows = Math.ceil((cells.length + 1) / COLS);
const gridW = (COLS - 1) * PITCH, gridD = (rows - 1) * PITCH;

const deck = new THREE.Mesh(
  new THREE.BoxGeometry(gridW + PITCH + 1.4, 0.5, gridD + PITCH + 1.4),
  registry.get('concrete'));
deck.position.set(0, -0.26, 0);
deck.receiveShadow = true;
gridRoot.add(deck);

const labelLayer = document.getElementById('labels');
const labels = [];
function addLabel(text, anchor, dim = false) {
  const el = document.createElement('div');
  el.className = 'lbl' + (dim ? ' dim' : '');
  el.textContent = text;
  labelLayer.appendChild(el);
  labels.push({ el, anchor });
}

cells.forEach((cell, i) => {
  const cx = (i % COLS) * PITCH - gridW / 2;
  const cz = Math.floor(i / COLS) * PITCH - gridD / 2;
  const planar = cell.group === 'ground';

  const pad = new THREE.Mesh(padGeo, cell.mat);
  pad.position.set(cx, 0.01, cz);
  pad.receiveShadow = true;
  gridRoot.add(pad);

  const ball = new THREE.Mesh(planar ? sphereGeo : sphereMeshUv, cell.mat);
  ball.position.set(cx, 1.25, cz);
  ball.castShadow = true;
  ball.receiveShadow = true;
  gridRoot.add(ball);

  addLabel(cell.label, new THREE.Vector3(cx, 2.5, cz));
});

// Last cell: the merged material driving four different layers off one geometry.
{
  const i = cells.length;
  const cx = (i % COLS) * PITCH - gridW / 2;
  const cz = Math.floor(i / COLS) * PITCH - gridD / 2;
  const quads = ['brick', 'stucco', 'roofTile', 'roofMembrane'];
  const pos = [], nrm = [], uv = [], idx = [], layer = [], col = [];
  quads.forEach((family, q) => {
    const ox = (q % 2 ? 0 : -1) * (PAD / 2), oz = (q < 2 ? -1 : 0) * (PAD / 2);
    const v = pos.length / 3;
    const s = PAD / 2;
    const tint = Object.keys(SURFACE_TINTS[family])[0];
    const rgb = surfaceTintRGB(family, tint);
    const li = SURFACE_LAYERS.indexOf(family);
    // Roof layers expect the 0.25 UV scale extrudeFootprint gives a roof.
    const k = family.startsWith('roof') ? 0.25 : 1;
    for (const [px, pz] of [[0, 0], [s, 0], [s, s], [0, s]]) {
      pos.push(cx + ox + px, 0.02, cz + oz + pz);
      nrm.push(0, 1, 0);
      uv.push((cx + ox + px) * k, (cz + oz + pz) * k);
      layer.push(li); col.push(rgb[0], rgb[1], rgb[2]);
    }
    idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, mergedMat);
  m.receiveShadow = true;
  gridRoot.add(m);
  addLabel('buildingMerged — 4 layers, 1 draw call', new THREE.Vector3(cx, 1.1, cz));
}

// ---------------------------------------------------------------- street context
const street = new THREE.Group();
street.position.set(0, 0, 140);
scene.add(street);

const V = (x, z) => ({ x, z });

// Roads and every junction feature go into ONE geometry with ONE material: the
// lane atlas is composited inside the road shader, so paint costs no extra call.
{
  const pos = [], nrm = [], uv = [], idx = [];
  const edges = [
    { pts: [V(-60, 0), V(60, 0)], w: 13.2, marking: MARKINGS.lane4 },
    { pts: [V(0, -46), V(0, -8)], w: 7.6, marking: MARKINGS.lane2 },
    { pts: [V(0, 8), V(0, 46)], w: 7.6, marking: MARKINGS.lane2solid },
  ];
  for (const e of edges) {
    const start = pos.length / 3;
    ribbon(e.pts, e.w, 0.02, pos, nrm, uv, idx);
    applyMarkingUV(uv, start, pos.length / 3 - start, e.marking, { vRepeat: 1 });
  }

  // Junction features are quads in the same buffer, lifted 2 cm. The asphalt
  // under them comes from the world-planar UV, so they blend into the road
  // exactly; only the paint is local to the quad.
  const feature = (cx, cz, alongX, alongLen, acrossLen, marking, flipU = false) => {
    const start = pos.length / 3;
    const ax = alongX ? 1 : 0, az = alongX ? 0 : 1;
    const bx = alongX ? 0 : 1, bz = alongX ? 1 : 0;
    const hl = alongLen / 2, hw = acrossLen / 2;
    for (const [sa, sb] of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
      pos.push(cx + ax * hl * sa + bx * hw * sb, 0.04, cz + az * hl * sa + bz * hw * sb);
      nrm.push(0, 1, 0);
      uv.push((sb + 1) / 2, (sa + 1) / 2);
    }
    idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
    applyMarkingUV(uv, start, 4, marking, { vRepeat: 1, flipU });
  };

  for (const s of [-1, 1]) {
    feature(s * 9.4, 0, true, 3.4, 13.2, MARKINGS.crosswalk);          // across the arterial
    feature(0, s * 11.0, false, 3.4, 7.6, MARKINGS.crosswalk);         // across the cross street
    feature(0, s * 14.5, false, 4.0, 7.6, MARKINGS.stopbar, s > 0);    // stop line
  }
  // Lane arrows on the westbound approach, one per 3.3 m lane.
  [[-3.3, MARKINGS.arrowThrough, false], [-6.6, MARKINGS.arrowTurn, false],
   [3.3, MARKINGS.arrowThrough, false], [6.6, MARKINGS.arrowTurn, true]]
    .forEach(([off, mk, flip]) => feature(-22, off, true, 7.0, 3.3, mk, flip));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const road = new THREE.Mesh(geo, registry.get('road'));
  road.receiveShadow = true;
  street.add(road);
}

// Kerbs and footways flanking the arterial.
{
  const kerbGeo = new THREE.BoxGeometry(120, 0.16, 0.4);
  const walkGeo = new THREE.BoxGeometry(120, 0.15, 5.4);
  for (const s of [-1, 1]) {
    const k = new THREE.Mesh(kerbGeo, registry.get('kerb'));
    k.position.set(0, 0.08, s * 6.8);
    k.castShadow = true; k.receiveShadow = true;
    street.add(k);
    const w = new THREE.Mesh(walkGeo, registry.get('sidewalk'));
    w.position.set(0, 0.075, s * 9.8);
    w.receiveShadow = true;
    street.add(w);
  }
  const verge = new THREE.Mesh(new THREE.BoxGeometry(120, 0.12, 12), registry.get('grass'));
  verge.position.set(0, 0.06, -19);
  verge.receiveShadow = true;
  street.add(verge);
  const lot = new THREE.Mesh(new THREE.BoxGeometry(46, 0.12, 22), registry.get('parkingLot'));
  lot.position.set(34, 0.06, 24);
  lot.receiveShadow = true;
  street.add(lot);
  const beach = new THREE.Mesh(new THREE.BoxGeometry(50, 0.12, 22), registry.get('sand'));
  beach.position.set(-34, 0.06, 24);
  beach.receiveShadow = true;
  street.add(beach);
}

// Building blocks: one merged geometry, mixed wall families, mixed roofs.
{
  const pos = [], nrm = [], uv = [], idx = [], layer = [], col = [];
  const blocks = [
    { x: -44, z: -30, w: 22, d: 16, h: 11, wall: ['stucco', 'cream'], roof: ['roofTile', 'clay'] },
    { x: -16, z: -32, w: 20, d: 14, h: 17, wall: ['brick', 'red'], roof: ['roofMembrane', 'grey'] },
    { x: 14, z: -31, w: 24, d: 15, h: 24, wall: ['panel', 'grey'], roof: ['roofGravel', 'grey'] },
    { x: 44, z: -30, w: 20, d: 16, h: 14, wall: ['terracotta', 'clay'], roof: ['roofMembrane', 'white'] },
    { x: -40, z: 26, w: 18, d: 12, h: 8, wall: ['block', 'seafoam'], roof: ['roofMembrane', 'white'] },
    { x: 6, z: 30, w: 26, d: 14, h: 9, wall: ['block', 'flamingo'], roof: ['roofTile', 'bleached'] },
  ];
  for (const b of blocks) {
    const ring = [
      [b.x - b.w / 2, b.z - b.d / 2], [b.x + b.w / 2, b.z - b.d / 2],
      [b.x + b.w / 2, b.z + b.d / 2], [b.x - b.w / 2, b.z + b.d / 2],
    ];
    const before = pos.length / 3;
    extrudeFootprint(ring, b.h, pos, nrm, uv, idx);
    const after = pos.length / 3;
    // extrudeFootprint appends walls first, then one roof vertex per ring point.
    const tag = (from, to, [family, tint]) => {
      const li = SURFACE_LAYERS.indexOf(family), rgb = surfaceTintRGB(family, tint);
      for (let v = from; v < to; v++) { layer.push(li); col.push(rgb[0], rgb[1], rgb[2]); }
    };
    tag(before, after - ring.length, b.wall);
    tag(after - ring.length, after, b.roof);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mergedMat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  street.add(mesh);
  addLabel('6 buildings · 5 wall families · 3 roofs · ONE draw call',
    new THREE.Vector3(0, 26, 140 - 31), true);
}

// Storefront glazing and street furniture, so glass and metal have context.
{
  const glass = new THREE.Mesh(new THREE.BoxGeometry(19, 4.2, 0.3), registry.get('glassStorefront'));
  glass.position.set(-16, 2.2, -24.8);
  street.add(glass);
  const tint = new THREE.Mesh(new THREE.BoxGeometry(23, 16, 0.3), registry.get('glassTinted'));
  tint.position.set(14, 12, -23.3);
  street.add(tint);
  const postGeo = new THREE.CylinderGeometry(0.11, 0.13, 7, 10);
  const armGeo = new THREE.BoxGeometry(0.5, 0.18, 1.9);
  for (let i = -2; i <= 2; i++) {
    const p = new THREE.Mesh(postGeo, registry.get('metalPainted'));
    p.position.set(i * 24 + 12, 3.5, 8.6);
    p.castShadow = true;
    street.add(p);
    const a = new THREE.Mesh(armGeo, registry.get('metalAnodised'));
    a.position.set(i * 24 + 12, 6.9, 7.7);
    a.castShadow = true;
    street.add(a);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(50, 0.12, 0.12), registry.get('metalGalvanised'));
  rail.position.set(-34, 1.0, 13.4);
  street.add(rail);
}

// The bay, and a board showing the raw marking atlas.
{
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), registry.get('water'));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.45, 140 + 420);
  scene.add(water);

  const atlasTex = registry.get('roadMarkings').map;
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 3),
    new THREE.MeshBasicMaterial({ map: atlasTex, transparent: true }));
  const backing = new THREE.Mesh(
    new THREE.PlaneGeometry(24.4, 3.4),
    new THREE.MeshBasicMaterial({ color: 0x2a2d31 }));
  board.position.set(0, 4.6, -0.02);
  backing.position.set(0, 4.6, -0.05);
  const holder = new THREE.Group();
  holder.add(backing, board);
  holder.position.set(0, 0, 42);
  street.add(holder);
  const names = ['none', 'lane2', 'lane2solid', 'lane4', 'crosswalk', 'stopbar', 'through', 'turn'];
  names.forEach((n, i) => addLabel(n,
    new THREE.Vector3((i + 0.5) * 3 - 12, 6.4, 140 + 42), true));
  addLabel('road-marking atlas — 8 columns x 256 px, wrapT repeats along the road',
    new THREE.Vector3(0, 7.2, 140 + 42));
}

// ---------------------------------------------------------------- lighting
const tod = new TimeOfDay(scene, renderer);
scene.environmentIntensity = 0.35;   // the hemisphere light already carries sky diffuse

let todName = 'dusk';
function setTod(name) {
  todName = name;
  tod.apply(name);
  const sky = skyFor(name);
  scene.background = sky.background;
  scene.environment = sky.env;
  updateHud();
}

// ---------------------------------------------------------------- camera
const VIEWS = {
  grid: { pos: [0, 17.5, 30], target: [0, 1.4, 0] },
  road: { pos: [-26, 9.5, 176], target: [4, 2.5, 132] },
  atlas: { pos: [0, 6.2, 196], target: [0, 5.0, 182] },
};
let view = 'grid';
const target = new THREE.Vector3();
function setView(name) {
  view = name;
  const v = VIEWS[name];
  camera.position.set(...v.pos);
  target.set(...v.target);
  camera.lookAt(target);
  updateHud();
}

// Minimal orbit so a human can inspect a seam without a dependency.
let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.x) * 0.005, dy = (e.clientY - drag.y) * 0.005;
  drag = { x: e.clientX, y: e.clientY };
  const off = camera.position.clone().sub(target);
  const r = off.length();
  let theta = Math.atan2(off.x, off.z) - dx;
  let phi = Math.min(1.5, Math.max(0.03, Math.acos(off.y / r) + dy));
  camera.position.set(
    target.x + r * Math.sin(phi) * Math.sin(theta),
    target.y + r * Math.cos(phi),
    target.z + r * Math.sin(phi) * Math.cos(theta));
  camera.lookAt(target);
});
addEventListener('wheel', (e) => {
  const off = camera.position.clone().sub(target);
  off.multiplyScalar(e.deltaY > 0 ? 1.1 : 0.9);
  camera.position.copy(target).add(off);
  camera.lookAt(target);
}, { passive: true });

addEventListener('keydown', (e) => {
  if (e.key === '1') setTod('noon');
  else if (e.key === '2') setTod('dusk');
  else if (e.key === '3') setTod('night');
  else if (e.key.toLowerCase() === 'g') setView('grid');
  else if (e.key.toLowerCase() === 'r') setView('road');
  else if (e.key.toLowerCase() === 'a') setView('atlas');
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- hud
const hudEl = document.getElementById('hud');
const subEl = document.getElementById('sub');
const report = registry.report();
const sceneBuildMs = performance.now() - buildStart;

function updateHud() {
  const p = PRESETS[todName];
  const r = renderer.info.render;
  hudEl.innerHTML = `
<b>${report.materials}</b> materials · <b>${report.textures}</b> textures
(<b>${report.textureLayers}</b> layers) · <b>${report.textureMemoryMB} MB</b> GPU<br>
generation <b>${report.generationMs} ms</b> · scene build ${sceneBuildMs.toFixed(0)} ms ·
programs ${renderer.info.programs ? renderer.info.programs.length : '?'}<br>
draw calls <b>${r.calls}</b> · triangles ${r.triangles.toLocaleString()}<br>
${p.label} — sun ${p.sunLux} lx · sky ${p.skyLux} lx · exposure 1/${Math.round(1 / p.exposure)}<br>
<span class="k">1</span>/<span class="k">2</span>/<span class="k">3</span> noon/dusk/night ·
<span class="k">G</span> grid · <span class="k">R</span> street · <span class="k">A</span> atlas ·
drag to orbit`;
  subEl.textContent = `${report.materials} shared materials · ${report.textureMemoryMB} MB · ${todName}`;
}

// ---------------------------------------------------------------- loop
const v3 = new THREE.Vector3();
let last = performance.now();
let frames = 0;

function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  registry.update(dt);
  tod.follow(target);

  for (const l of labels) {
    v3.copy(l.anchor).project(camera);
    const on = v3.z < 1 && Math.abs(v3.x) < 1.15 && Math.abs(v3.y) < 1.15;
    l.el.style.display = on ? 'block' : 'none';
    if (on) {
      l.el.style.left = `${(v3.x * 0.5 + 0.5) * innerWidth}px`;
      l.el.style.top = `${(-v3.y * 0.5 + 0.5) * innerHeight}px`;
    }
  }

  renderer.render(scene, camera);
  if (++frames % 12 === 0) updateHud();
  requestAnimationFrame(frame);
}

setView('grid');
setTod('dusk');
frame();

// Playwright hooks.
window.__lab = {
  report, setTod, setView,
  get stats() {
    return {
      ...report, tod: todName, view,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs.length,
      audit: tod.audit(),
    };
  },
  ready: true,
};
