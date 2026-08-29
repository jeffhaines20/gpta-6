// VISUAL BAR CHECK — one street corner, dusk, after rain.
// Everything here is generated in code: no image files, no model files.
// The question this scene exists to answer is not "does it run" but
// "is procedural-only capable of a look worth shipping".

import * as THREE from '../vendor/three.module.js';
import { asphalt, wetRoughness, sidewalk, facade, facadeEmissive, tex, noiseCanvas } from '../src/textures.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // the single biggest "AAA look" lever
renderer.toneMappingExposure = 1.35;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 900);

// ------------------------------------------------------------------ sky + IBL
// A procedural gradient sky doubles as the environment map. Without an env map
// every metal and every wet surface reads as flat plastic.
function buildSky() {
  const geo = new THREE.SphereGeometry(500, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x1a2f4e) },
      mid: { value: new THREE.Color(0x6b6a86) },
      hor: { value: new THREE.Color(0xd98d5a) },
      sunDir: { value: new THREE.Vector3(-0.62, 0.13, -0.77).normalize() },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `
      varying vec3 vP; uniform vec3 top, mid, hor, sunDir;
      void main(){
        vec3 d = normalize(vP);
        float h = clamp(d.y*0.5+0.5, 0.0, 1.0);
        vec3 c = mix(hor, mid, smoothstep(0.48, 0.66, h));
        c = mix(c, top, smoothstep(0.6, 0.95, h));
        // Sun glow smeared along the horizon, the way dusk actually looks.
        float s = max(dot(d, normalize(sunDir)), 0.0);
        c += vec3(1.0,0.62,0.32) * pow(s, 22.0) * 1.5;
        c += vec3(1.0,0.55,0.30) * pow(s, 4.0) * 0.22;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}
const sky = buildSky();
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envScene = new THREE.Scene();
envScene.add(buildSky());
scene.environment = pmrem.fromScene(envScene, 0.04).texture;
scene.environmentIntensity = 1.25;
scene.fog = new THREE.FogExp2(0x5a5f78, 0.0075);

// ------------------------------------------------------------------ lighting
const sunDir = new THREE.Vector3(-0.62, 0.13, -0.77).normalize();
const sun = new THREE.DirectionalLight(0xffb066, 3.4);
sun.position.copy(sunDir).multiplyScalar(90);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const S = 60;
Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 260 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0x9fb4dc, 0x3d3730, 1.5));

// ------------------------------------------------------------------ materials
const roadMat = new THREE.MeshStandardMaterial({
  map: tex(asphalt(), 14),
  roughnessMap: tex(wetRoughness(), 7, false),
  roughness: 0.92, metalness: 0.8, color: 0xa6a9b2,
});
const walkMat = new THREE.MeshStandardMaterial({
  map: tex(sidewalk(), 8), roughness: 0.82, metalness: 0.06,
});
const kerbMat = new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.85 });
const concrete = new THREE.MeshStandardMaterial({ color: 0x6d6a64, roughness: 0.9 });

// ------------------------------------------------------------------ ground
const road = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), roadMat);
road.rotation.x = -Math.PI / 2;
road.receiveShadow = true;
scene.add(road);

// A cross intersection: two sidewalk quadrants + kerbs.
const ROAD_HALF = 9;
const WALK = 6.0;            // sidewalk width
const BUILD_LINE = ROAD_HALF + WALK;
function quadrant(sx, sz) {
  const g = new THREE.Group();
  const L = 130;
  // Two sidewalk strips meeting at the corner, not one giant slab.
  const mkWalk = (rx, ry) => {
    const m = walkMat.clone();
    m.map = walkMat.map.clone(); m.map.needsUpdate = true;
    m.map.repeat.set(rx, ry);
    return m;
  };
  const a = new THREE.Mesh(new THREE.BoxGeometry(WALK, 0.24, L), mkWalk(WALK / 3.5, L / 3.5));
  a.position.set(sx * (ROAD_HALF + WALK / 2), 0.12, sz * (L / 2));
  const b = new THREE.Mesh(new THREE.BoxGeometry(L, 0.24, WALK), mkWalk(L / 3.5, WALK / 3.5));
  b.position.set(sx * (L / 2), 0.12, sz * (ROAD_HALF + WALK / 2));
  a.receiveShadow = b.receiveShadow = true; a.castShadow = b.castShadow = true;
  g.add(a, b);
  const kA = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.30, L), kerbMat);
  kA.position.set(sx * (ROAD_HALF + 0.25), 0.15, sz * (L / 2));
  const kB = new THREE.Mesh(new THREE.BoxGeometry(L, 0.30, 0.5), kerbMat);
  kB.position.set(sx * (L / 2), 0.15, sz * (ROAD_HALF + 0.25));
  kA.receiveShadow = kB.receiveShadow = kA.castShadow = kB.castShadow = true;
  g.add(kA, kB);
  return g;
}
for (const [sx, sz] of [[1,1],[-1,1],[1,-1],[-1,-1]]) scene.add(quadrant(sx, sz));

// Road markings, drawn as thin emissive-free planes just above the asphalt.
function paint(w, l, x, z, rot = 0, color = 0xd9d3bc, op = 0.85) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, l),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, transparent: true, opacity: op })
  );
  m.rotation.x = -Math.PI / 2; m.rotation.z = rot;
  m.position.set(x, 0.015, z);
  scene.add(m);
}
for (let i = 1; i < 14; i++) {
  paint(0.28, 3.2, 0, ROAD_HALF + 4 + i * 8);
  paint(0.28, 3.2, 0, -(ROAD_HALF + 4 + i * 8));
  paint(3.2, 0.28, ROAD_HALF + 4 + i * 8, 0);
  paint(3.2, 0.28, -(ROAD_HALF + 4 + i * 8), 0);
}
// Zebra crossings.
for (let i = -5; i <= 5; i++) {
  paint(0.62, 5.0, i * 1.5, ROAD_HALF + 3.0, 0, 0xe6e0cc, 0.9);
  paint(5.0, 0.62, ROAD_HALF + 3.0, i * 1.5, 0, 0xe6e0cc, 0.9);
}

// ------------------------------------------------------------------ buildings
const facadeVariants = [
  { key: 'a', cols: 7, rows: 9, lit: 0.30, hue: 28, sat: 12, light: 40 },
  { key: 'b', cols: 5, rows: 7, lit: 0.42, hue: 20, sat: 18, light: 33 },
  { key: 'c', cols: 8, rows: 11, lit: 0.24, hue: 205, sat: 8, light: 44 },
  { key: 'd', cols: 6, rows: 8, lit: 0.38, hue: 36, sat: 22, light: 47 },
];
const facadeMats = facadeVariants.map((v) => {
  const map = tex(facade(v), 1);
  const emissive = tex(facadeEmissive(v), 1);
  return new THREE.MeshStandardMaterial({
    map, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 1.25,
    roughness: 0.62, metalness: 0.12,
  });
});

function building(x, z, w, d, floors, variantIdx) {
  const h = floors * 3.4;
  const g = new THREE.Group();
  const mat = facadeMats[variantIdx % facadeMats.length];
  // Facade UVs are scaled per-face so windows stay the same real-world size on
  // every building instead of stretching with the box.
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const perFace = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [fw, fh] = perFace[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * (fw / 14), uv.getY(k) * (fh / 14));
    }
  }
  uv.needsUpdate = true;
  const body = new THREE.Mesh(geo, mat);
  body.position.y = h / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // Ground-floor retail: darker plinth + a warm shopfront that spills light.
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w, 4.2, d), concrete);
  plinth.position.y = 2.1;
  plinth.castShadow = plinth.receiveShadow = true;
  g.add(plinth);
  // Storefront: a recessed band of warm glass panels along the street faces.
  const shopHue = 0.06 + Math.random() * 0.09;
  const shopMat = new THREE.MeshStandardMaterial({
    color: 0x0a0806, emissive: new THREE.Color().setHSL(shopHue, 0.62, 0.52),
    emissiveIntensity: 0.85, roughness: 0.25, metalness: 0.1,
  });
  const mullion = new THREE.MeshStandardMaterial({ color: 0x1b1a18, roughness: 0.7 });
  for (const [axis, span, off] of [['x', w, d / 2], ['z', d, w / 2]]) {
    const n = Math.max(3, Math.round(span / 2.0));
    for (let i = 0; i < n; i++) {
      const pw = span / n * 0.52;
      const t = (i + 0.5) / n * span - span / 2;
      const pane = new THREE.Mesh(new THREE.BoxGeometry(
        axis === 'x' ? pw : 0.18, 2.5, axis === 'x' ? 0.18 : pw), shopMat);
      pane.position.set(axis === 'x' ? t : off + 0.2, 1.85, axis === 'x' ? off + 0.2 : t);
      g.add(pane);
      const pane2 = pane.clone();
      pane2.position.set(axis === 'x' ? t : -off - 0.2, 1.85, axis === 'x' ? -off - 0.2 : t);
      g.add(pane2);
    }
    // Awning / fascia over the shopfront catches the light and adds depth.
    const fas = new THREE.Mesh(new THREE.BoxGeometry(
      axis === 'x' ? span + 0.5 : 0.5, 0.75, axis === 'x' ? 0.5 : span + 0.5), mullion);
    fas.position.set(axis === 'x' ? 0 : off + 0.35, 3.55, axis === 'x' ? off + 0.35 : 0);
    fas.castShadow = true; g.add(fas);
    const fas2 = fas.clone();
    fas2.position.set(axis === 'x' ? 0 : -off - 0.35, 3.55, axis === 'x' ? -off - 0.35 : 0);
    g.add(fas2);
  }

  // Roof parapet + a rooftop unit or two: silhouettes are what read at distance.
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.7, d + 0.6), concrete);
  cap.position.y = h + 0.35; cap.castShadow = true; g.add(cap);
  for (let i = 0; i < 2; i++) {
    const bw = 1.6 + Math.random() * 2.4;
    const u = new THREE.Mesh(new THREE.BoxGeometry(bw, 1.2 + Math.random() * 1.4, bw), concrete);
    u.position.set((Math.random() - 0.5) * (w - bw), h + 1.3, (Math.random() - 0.5) * (d - bw));
    u.castShadow = true; g.add(u);
  }
  g.position.set(x, 0, z);
  return g;
}

const rand = (a, b) => a + Math.random() * (b - a);
let vi = 0;
for (const [sx, sz] of [[1,1],[-1,1],[1,-1],[-1,-1]]) {
  // A row of buildings along each street frontage of the quadrant.
  let cursor = BUILD_LINE;
  for (let i = 0; i < 5; i++) {
    const w = rand(9, 17), d = rand(12, 20);
    scene.add(building(sx * (BUILD_LINE + d / 2), sz * (cursor + w / 2), d, w, Math.round(rand(4, 16)), vi++));
    cursor += w + rand(0.6, 2.2);
  }
  cursor = BUILD_LINE;
  for (let i = 0; i < 5; i++) {
    const w = rand(9, 17), d = rand(12, 20);
    scene.add(building(sx * (cursor + w / 2), sz * (BUILD_LINE + d / 2), w, d, Math.round(rand(4, 16)), vi++));
    cursor += w + rand(0.6, 2.2);
  }
}

// ------------------------------------------------------------------ street kit
const metalDark = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.45, metalness: 0.8 });

function lampPost(x, z, flip) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 8.2, 10), metalDark);
  pole.position.y = 4.1; pole.castShadow = true; g.add(pole);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 2.6, 8), metalDark);
  arm.rotation.z = Math.PI / 2; arm.position.set(flip * 1.3, 8.0, 0); arm.castShadow = true; g.add(arm);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.44),
    new THREE.MeshStandardMaterial({ color: 0x1e2126, emissive: 0xffd9a0, emissiveIntensity: 2.6, roughness: 0.4 }));
  head.position.set(flip * 2.5, 7.86, 0); g.add(head);
  const l = new THREE.PointLight(0xffc98a, 520, 34, 2);
  l.position.set(flip * 2.5, 7.5, 0);
  g.add(l);
  g.position.set(x, 0.22, z);
  return g;
}
for (const [x, z, f] of [[-10.4, 22, 1], [-10.4, -16, 1], [10.4, 14, -1], [10.4, -26, -1],
                          [24, 10.4, 1], [-20, 10.4, 1], [16, -10.4, -1], [-30, -10.4, -1]]) {
  scene.add(lampPost(x, z, f));
}

function trafficLight(x, z, rot) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 6.2, 10), metalDark);
  pole.position.y = 3.1; pole.castShadow = true; g.add(pole);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 4.4, 8), metalDark);
  arm.rotation.z = Math.PI / 2; arm.position.set(2.2, 6.0, 0); arm.castShadow = true; g.add(arm);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.44, 1.2, 0.36), metalDark);
  box.position.set(4.1, 5.4, 0); box.castShadow = true; g.add(box);
  const lamps = [[0.38, 0xff2b1e], [0.0, 0xffb020], [-0.38, 0x2bff6a]];
  const on = Math.floor(Math.random() * 3);
  lamps.forEach(([dy, col], i) => {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8),
      new THREE.MeshStandardMaterial({ color: i === on ? col : 0x14161a, emissive: i === on ? col : 0x000000, emissiveIntensity: 3.2 }));
    b.position.set(4.1 - 0.2, 5.4 + dy, 0);
    g.add(b);
    if (i === on) { const pl = new THREE.PointLight(col, 90, 14, 2); pl.position.set(3.7, 5.4 + dy, 0); g.add(pl); }
  });
  g.position.set(x, 0.22, z); g.rotation.y = rot;
  return g;
}
scene.add(trafficLight(-10.3, 10.3, Math.PI));
scene.add(trafficLight(10.3, -10.3, 0));

// Bollards, hydrant, bins — small props break up the sidewalk silhouette.
for (let i = 0; i < 14; i++) {
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.95, 8), metalDark);
  const along = 12 + i * 3.4;
  b.position.set(-10.9, 0.72, along % 2 ? along : -along);
  b.castShadow = true; scene.add(b);
}
const hydrant = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.85, 10),
  new THREE.MeshStandardMaterial({ color: 0xb8352c, roughness: 0.55, metalness: 0.2 }));
hydrant.position.set(10.9, 0.67, 15.5); hydrant.castShadow = true; scene.add(hydrant);

// ------------------------------------------------------------------ cars
function parkedCar(x, z, rot, hue) {
  const g = new THREE.Group();
  const paintMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue, 0.42, 0.34), roughness: 0.28, metalness: 0.65,
  });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d141c, roughness: 0.08, metalness: 0.9 });
  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.66, 4.4), paintMat);
  lower.position.y = 0.62; g.add(lower);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.22, 1.5), paintMat);
  hood.position.set(0, 0.95, 1.35); g.add(hood);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.62, 2.2), glass);
  cabin.position.set(0, 1.2, -0.2); g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.12, 1.8), paintMat);
  roof.position.set(0, 1.5, -0.3); g.add(roof);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.16, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x3a0d0a, emissive: 0xff2a18, emissiveIntensity: 2.2 }));
  tail.position.set(0, 0.85, -2.2); g.add(tail);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xc2c6cc, roughness: 0.25, metalness: 0.9 });
  for (const [wx, wz] of [[-0.92, 1.4], [0.92, 1.4], [-0.92, -1.45], [0.92, -1.45]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.26, 16), tyre);
    t.rotation.z = Math.PI / 2; t.position.set(wx, 0.37, wz); g.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.28, 10), rim);
    r.rotation.z = Math.PI / 2; r.position.set(wx, 0.37, wz); g.add(r);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}
scene.add(parkedCar(-6.2, 19, 0, 0.02));
scene.add(parkedCar(-6.2, 27.5, 0, 0.58));
scene.add(parkedCar(6.2, -17, Math.PI, 0.12));
scene.add(parkedCar(6.4, 24, Math.PI, 0.95));
scene.add(parkedCar(-20, -6.3, Math.PI / 2, 0.45));

// ------------------------------------------------------------------ camera
// Framed like a trailer shot: low, long lens, looking down the street.
camera.position.set(5.2, 4.4, 25);
camera.lookAt(-1.0, 9.0, -48);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let frames = 0;
function loop() {
  requestAnimationFrame(loop);
  renderer.render(scene, camera);
  frames++;
}
loop();

window.__visual = {
  get frames() { return frames; },
  scene, camera, renderer,
  setView(p, t, fov) {
    camera.position.set(...p);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.lookAt(...t);
  },
  stats: () => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
  }),
};
