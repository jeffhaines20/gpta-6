// Phase 1b district probe: real baked geometry, chunk streaming, the Phase 1
// vehicle driving on it unchanged, stub traffic, and a time-of-day sweep.
//
// Map data © OpenStreetMap contributors (ODbL). All names are invented.

import * as THREE from '../vendor/three.module.min.js';
import { Input } from '../src/input.js';
import { Vehicle } from '../src/vehicle.js';
import { ChaseCamera } from '../src/camera.js';
import { StreamingWorld } from '../src/streaming.js';
import { TrafficStub } from '../src/traffic.js';
import { TimeOfDay, PRESETS } from '../src/daynight.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.2, 1400);
const input = new Input(canvas);
const chase = new ChaseCamera(camera);
chase.mode = 'car';

const hud = document.getElementById('hud');
hud.textContent = 'loading district…';

const district = await (await fetch('../data/district.json')).json();
const world = new StreamingWorld(scene, district, { nearRadius: 2, farRadius: 5, budgetMs: 4 });
const tod = new TimeOfDay(scene, renderer);

// Street lamps along the main corridor, in candela. Registered with the
// time-of-day system so they switch with the cycle instead of being always-on.
const lampGeo = new THREE.CylinderGeometry(0.12, 0.16, 8, 8);
const lampMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.7 });
const headMat = new THREE.MeshStandardMaterial({ color: 0x1e2126, emissive: 0xffd9a0, emissiveIntensity: 2.2 });
const lampRoot = new THREE.Group();
scene.add(lampRoot);
{
  // Place lamps along the highest-rank named edges: the arterial corridor.
  const arterials = district.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.r <= 6 && e.n)
    .slice(0, 240);
  let placed = 0;
  for (const { e } of arterials) {
    for (let k = 0; k < e.v.length - 1 && placed < 260; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 30);
      for (let s = 1; s <= n && placed < 260; s++) {
        const f = s / (n + 1);
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        const off = (e.w / 2 + 1.4) * (s % 2 ? 1 : -1);
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        const g = new THREE.Group();
        const pole = new THREE.Mesh(lampGeo, lampMat);
        pole.position.y = 4; pole.castShadow = true; g.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.2, 0.4), headMat);
        head.position.y = 7.9; g.add(head);
        const light = new THREE.PointLight(0xffc98a, 0, 40, 2);
        light.position.y = 7.6;
        g.add(light);
        tod.registerLamp(light, 900);       // 900 cd ~= a 12 klm street lamp
        g.position.set(x + nx * off, 0, z + nz * off);
        lampRoot.add(g);
        placed++;
      }
    }
  }
  console.log(`placed ${placed} street lamps`);
}

// ------------------------------------------------------------------ vehicle
// The Phase 1 Vehicle, unmodified, driving on the streamed world through the
// same ground interface it used on the flat test block.
const vehicle = new Vehicle();
const ROUTE = district.meta.route ?? null;
function placeAt(x, z, yaw = 0) {
  vehicle.position.set(x, 0.55, z);
  vehicle.velocity.set(0, 0, 0);
  vehicle.angularVelocity.set(0, 0, 0);
  vehicle.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}
placeAt(district.meta.spawn?.x ?? 0, district.meta.spawn?.z ?? 0);

const carMesh = (() => {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xb03a2e, roughness: 0.3, metalness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x101820, roughness: 0.1, metalness: 0.85 });
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.62, 4.3), paint); b.position.y = 0.2; g.add(b);
  const c = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.56, 2.1), glass); c.position.set(0, 0.74, -0.15); g.add(c);
  const r = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 1.7), paint); r.position.set(0, 1.03, -0.2); g.add(r);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.95 });
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14), tyre);
    w.rotation.z = Math.PI / 2; g.add(w); wheels.push(w);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(g);
  return { group: g, wheels };
})();

let traffic = null;
function setTraffic(on) {
  if (on && !traffic) {
    traffic = new TrafficStub(scene, district, { count: 30 });
    // Let traffic ask the streamer whether a car's chunk is actually resident,
    // so "orphan" means something real rather than a distance guess.
    traffic.isChunkLoaded = (x, z) => world.loaded.has(world.keyOf(x, z));
  }
  else if (!on && traffic) { scene.remove(traffic.mesh); traffic.mesh.geometry.dispose(); traffic = null; }
  return !!traffic;
}

// ------------------------------------------------------------------ metrics
const metrics = {
  frames: 0, samples: [], recording: false,
  worstStallMs: 0, chunkLoads: 0, chunkUnloads: 0,
  heapStart: null, heapSamples: [],
};
function sample(dt) {
  const r = renderer.info.render;
  const w = world.report();
  metrics.samples.push({
    t: +simTime.toFixed(2),
    calls: r.calls, tris: r.triangles,
    chunks: w.chunksLoaded, near: w.lodNear, far: w.lodFar,
    loads: w.loads, unloads: w.unloads, swaps: w.lodSwaps,
    stall: +w.lastBuildMs.toFixed(2),
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    x: +vehicle.position.x.toFixed(1), z: +vehicle.position.z.toFixed(1),
    kmh: +(vehicle.speed * 3.6).toFixed(1),
  });
}

// ------------------------------------------------------------------ loop
let last = performance.now();
let autopilot = null;
let timeScale = 1;
let simTime = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;

  chase.handleMouse(input);

  if (!autopilot) {
    const axis = input.moveAxis();
    let throttle = 0, brake = 0;
    if (axis.y > 0) { if (vehicle.forwardSpeed < -0.5) brake = 1; else throttle = 1; }
    else if (axis.y < 0) { if (vehicle.forwardSpeed > 0.5) brake = 1; else throttle = -0.55; }
    vehicle.setControls({ throttle, brake, steer: -axis.x, handbrake: input.down('Space') });
  }

  // timeScale exists for the headless harness only: it advances sim + streaming
  // several times per rendered frame so a software renderer can still cover a
  // 2.6 km route. Every rate metric is reported against simulated time.
  for (let s = 0; s < timeScale; s++) {
    if (autopilot) autopilot(dt);
    vehicle.stepFixed(dt, world);
    world.update(vehicle.position);
    if (traffic) traffic.update(dt, vehicle.position);
    simTime += dt;
  }
  tod.follow(vehicle.position);

  const q = vehicle.quaternion;
  const carYaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
  chase.update(dt, vehicle.position, world, carYaw + Math.PI, vehicle.forwardSpeed > 3 ? 1.6 : 0);

  carMesh.group.position.copy(vehicle.position);
  carMesh.group.quaternion.copy(vehicle.quaternion);
  for (let i = 0; i < 4; i++) {
    const w = vehicle.wheels[i];
    carMesh.group.worldToLocal(carMesh.wheels[i].position.copy(w.worldPos));
    carMesh.wheels[i].rotation.set(0, 0, 0);
    carMesh.wheels[i].rotateY(w.steer ? vehicle.steer : 0);
    carMesh.wheels[i].rotateZ(Math.PI / 2);
    carMesh.wheels[i].rotateX(w.spinAngle);
  }

  renderer.render(scene, camera);
  if (metrics.recording) sample(dt);
  metrics.frames++;

  const w = world.report();
  hud.textContent =
    `${district.meta.city}  ·  ${PRESETS[tod.presetName].label}  ·  ${(vehicle.speed * 3.6).toFixed(0)} km/h\n` +
    `chunks ${w.chunksLoaded} (near ${w.lodNear} / far ${w.lodFar})  draw ${renderer.info.render.calls}  ` +
    `tris ${(renderer.info.render.triangles / 1000).toFixed(1)}k\n` +
    `loads ${w.loads}  unloads ${w.unloads}  worst chunk build ${w.worstBuildMs.toFixed(1)}ms` +
    (traffic ? `  ·  traffic ${traffic.report().alive}/30` : '');

  input.endFrame();
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
requestAnimationFrame(animate);

// ------------------------------------------------------------------ test hooks
window.__district = {
  district, world, vehicle, traffic: () => traffic, tod, renderer, scene, camera, chase, metrics,
  get frames() { return metrics.frames; },
  setTraffic,
  setTimeOfDay: (n) => tod.apply(n),
  audit: () => tod.audit(),
  placeAt,
  renderStats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
  worldReport: () => world.report(),
  trafficReport: () => (traffic ? traffic.report() : null),
  startRecording() { metrics.recording = true; metrics.samples.length = 0; world.stats.worstBuildMs = 0; },
  stopRecording() { metrics.recording = false; return metrics.samples; },
  setAutopilot(fn) { autopilot = fn; },
  setTimeScale(n) { timeScale = Math.max(1, n | 0); },
  get simTime() { return simTime; },
  freeCam(pos, target, fov) {
    autopilot = () => {};
    camera.position.set(...pos);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.lookAt(...target);
    chase.update = () => {};
  },
};
hud.textContent = 'ready';
