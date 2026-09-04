// A bench for looking at ONE tree, on the material the district actually draws
// with.
//
// This is tools/oak-look.mjs's bench -- same pad, same road ribbon, same
// shopfront stand-ins at the clearance the placement test guarantees, same
// cameras, same three suns -- with two differences, both of which the leaf
// stencil forced:
//
//   1. THE MESH USES __kit.propMaterial(), not a lookalike. oak-look.mjs builds
//      its own MeshStandardMaterial with roughness 0.88 hard-coded. That was a
//      fair copy while the shipped material was only a palette lookup; it is
//      not one now that the material carries an alphaMap, because a bench with
//      no alphaMap draws the foliage UNCUT and would report a change the page
//      does not show. This is the harness/page disagreement the ledger already
//      paid for once, on a lampless district that reported 294 trees.
//
//   2. THE GEOMETRY CARRIES ITS uv. oak-look.mjs uploads position, normal and
//      colour only, so the stencil would have nothing to address even if the
//      material had it.
//
//   node tools/tree-look.mjs --species oak  --view up
//   node tools/tree-look.mjs --species palm --view palmup --sun dusk
//
// Views: row (street eye down a kerb), up (under an oak, looking up),
// palmup (the same idea framed for a crown that is 4 m across and 10 m up,
// which the shared 'up' camera puts 6% of a frame's worth of), tunnel, close.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const VIEW = arg('view', 'row');
const SPECIES = arg('species', 'oak');
const SUN = arg('sun', 'golden');
const TAG = arg('tag', `${SPECIES}-${VIEW}-${SUN}`);

fs.mkdirSync('docs/shots', { recursive: true });
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });

const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:#000}</style>
<canvas id="c"></canvas>
<script type="module">
import * as THREE from '/vendor/three.module.min.js';
import { __kit } from '/src/streetfurniture.js';
const P = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
const route = await (await fetch('/data/district.json')).json();
__kit.setOakRoute(route.meta.route);

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = P.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(P.sky);
const hemi = new THREE.HemisphereLight(P.sky, 0x6b6152, P.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dd, P.sunI);
sun.position.set(P.sunX, P.sunY, P.sunZ);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const cam = sun.shadow.camera;
cam.left = -30; cam.right = 30; cam.top = 30; cam.bottom = -30; cam.far = 160;
scene.add(sun);

const pad = new THREE.Mesh(new THREE.PlaneGeometry(320, 200),
  new THREE.MeshStandardMaterial({ color: 0x8d867c, roughness: 0.95 }));
pad.rotation.x = -Math.PI / 2; pad.position.set(P.at.x, -0.05, P.at.z); pad.receiveShadow = true;
scene.add(pad);
const road = new THREE.Mesh(new THREE.PlaneGeometry(320, 14),
  new THREE.MeshStandardMaterial({ color: 0x3b3a38, roughness: 0.92 }));
road.rotation.x = -Math.PI / 2; road.position.set(P.at.x, 0.02, P.at.z); road.receiveShadow = true;
scene.add(road);

// The shopfront stand-in, at the 2.6 m the kerb placement test guarantees
// behind a tree that sits 3.9 m off the road edge, and 6.8 m tall, which is
// what the re-massed building 29 stands at behind the measured tunnel.
const wallGeo = new THREE.BoxGeometry(320, 6.8, 0.4);
const wallMat = new THREE.MeshStandardMaterial({ color: 0xc9bda9, roughness: 0.9 });
for (const s of [-1, 1]) {
  const w = new THREE.Mesh(wallGeo, wallMat);
  w.position.set(P.at.x, 3.4, P.at.z + s * (7 + 3.9 + 2.6));
  w.castShadow = true; w.receiveShadow = true;
  scene.add(w);
}

const buf = __kit.newBuf();
const KERB = 7 + 3.9;
const rows = P.view === 'tunnel' ? [1, -1] : [1];
let n = 0;
for (const side of rows) {
  for (let i = 0; i < P.count; i++) {
    const x = P.at.x + (i - (P.count - 1) / 2) * P.gap + (side < 0 ? P.gap / 2 : 0);
    const z = P.at.z + side * KERB;
    // out = away from the road, along = down the kerb; the street runs along
    // world X here, so the +z kerb composes a det -1 frame and the -z kerb a
    // det +1 one, the same pair the district's kerb stations compose.
    // (No backticks anywhere in this page. It is one template literal and a
    // backtick in a comment terminates it -- three times in this repo.)
    const f = __kit.frame(x, z, 1, 0, 0, side);
    const key = P.seed + i * 977 + (side < 0 ? 40507 : 0);
    __kit.props.tree(buf, f, key);
    __kit.props.treeDetail(buf, f, key);
    n++;
  }
}
const g = new THREE.BufferGeometry();
g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
g.setIndex(buf.idx);
const mesh = new THREE.Mesh(g, __kit.propMaterial());
mesh.castShadow = true; mesh.receiveShadow = true;
scene.add(mesh);

const camera = new THREE.PerspectiveCamera(P.fov, innerWidth / innerHeight, 0.1, 500);
camera.position.set(P.cam[0], P.cam[1], P.cam[2]);
camera.lookAt(P.tgt[0], P.tgt[1], P.tgt[2]);
renderer.render(scene, camera);
let lo = Infinity, hi = -Infinity;
for (let i = 1; i < buf.pos.length; i += 3) { lo = Math.min(lo, buf.pos[i]); hi = Math.max(hi, buf.pos[i]); }
window.__look = { trees: n, triangles: buf.idx.length / 3, lowestY: lo, highestY: hi,
  cut: !!mesh.material.alphaMap,
  species: Array.from({ length: P.count }, (_, i) => {
    const q = __kit.treeParams(P.seed + i * 977, P.at.x + (i - (P.count - 1) / 2) * P.gap, P.at.z + KERB);
    return q.oak ? 'oak' : q.sabal ? 'sabal' : 'queen';
  }) };
</script>`;

const VIEWS = {
  row: { cam: [0, 2.2, -13], tgt: [0, 5.5, 10.9], fov: 58, count: 5, gap: 16.5 },
  up: { cam: [-3.5, 1.8, 6.0], tgt: [1.0, 9.0, 11.4], fov: 70, count: 3, gap: 16.5 },
  // A palm carries a 4 m crown at 6-13 m and the shared 'up' camera puts 6% of
  // a frame's worth of it on screen, which the grain metric refuses outright.
  // Same idea, framed for the subject: stand closer to the trunk and look up
  // the pole into the crown.
  palmup: { cam: [-1.2, 1.7, 7.4], tgt: [0.6, 9.6, 11.0], fov: 74, count: 3, gap: 16.5 },
  tunnel: { cam: [-34, 1.9, 3.5], tgt: [55, 5.2, 0], fov: 58, count: 8, gap: 16.5 },
  close: { cam: [-9, 2.0, -1], tgt: [0, 5.0, 10.9], fov: 58, count: 2, gap: 24 },
};
const SUNS = {
  golden: { sunX: -34, sunY: 11, sunZ: 16, sunI: 3.1, hemi: 0.75, sky: 0x9dbdd8, exposure: 1.0 },
  dusk: { sunX: -40, sunY: 3.4, sunZ: 6, sunI: 1.5, hemi: 0.55, sky: 0x6b7a92, exposure: 1.25 },
  noon: { sunX: -6, sunY: 40, sunZ: 9, sunI: 3.6, hemi: 0.95, sky: 0xa8c6dd, exposure: 0.92 },
};
const v = VIEWS[VIEW] ?? VIEWS.row;
// (118, -170) is the middle of the measured Main St east tunnel, where the oak
// profile peaks; (0, 400) is off the corridor, where every key is a palm.
const at = SPECIES === 'palm' ? { x: 0, z: 400 } : { x: 118, z: -170 };
const cfg = { ...v, ...(SUNS[SUN] ?? SUNS.golden), view: VIEW, at, seed: 7331,
  exposure: (SUNS[SUN] ?? SUNS.golden).exposure };
cfg.cam = [v.cam[0] + at.x, v.cam[1], v.cam[2] + at.z];
cfg.tgt = [v.tgt[0] + at.x, v.tgt[1], v.tgt[2] + at.z];

fs.writeFileSync('docs/shots/.tree-look.html', html);
const url = 'http://127.0.0.1:8123/docs/shots/.tree-look.html#'
  + encodeURIComponent(JSON.stringify(cfg));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__look', null, { timeout: 30000 });
const info = await page.evaluate(() => window.__look);
const file = `docs/shots/tree3-${TAG}.png`;
await page.screenshot({ path: file });
console.log(`${file}   ${JSON.stringify(info)}`);
await browser.close();
