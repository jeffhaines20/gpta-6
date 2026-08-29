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
import { PursuitUnits } from '../src/pursuit.js';
import { StreetFurniture } from '../src/streetfurniture.js';
import { LightPool } from '../src/lightpool.js';
import { TimeOfDay, PRESETS } from '../src/daynight.js';
import { PostStack } from '../src/post.js';

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
const post = new PostStack(renderer, scene, camera);
tod.attachPost(post);

// Street lamps: instanced geometry plus a nearest-N light pool.
//
// The chase harness measured 233 individually-meshed posts as ~70% of all draw
// calls, and 233 simultaneous PointLights would be a per-fragment loop of 233 on
// real hardware. Geometry is instanced (3 draw calls total) and only the nearest
// LIGHT_POOL_SIZE emitters are ever real lights.
const furniture = new StreetFurniture(scene, { max: 400 });
const lightPool = new LightPool(scene, { size: 10, maxDistance: 130 });
{
  const arterials = district.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.r <= 6 && e.n)
    .slice(0, 240);
  let placed = 0;
  for (const { e } of arterials) {
    for (let k = 0; k < e.v.length - 1 && placed < 320; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 30);
      for (let s = 1; s <= n && placed < 320; s++) {
        const f = s / (n + 1);
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        const side = s % 2 ? 1 : -1;
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        const off = (e.w / 2 + 1.4) * side;
        // Point the arm back over the roadway.
        const yaw = Math.atan2(-nx * side, -nz * side);
        const head = furniture.addLamp(x + nx * off, z + nz * off, yaw);
        if (head) lightPool.addEmitter(head.x, head.y, head.z, 900, 0xffc98a, 46);
        placed++;
      }
    }
  }
  furniture.commit();
  console.log(`placed ${placed} street lamps (${furniture.report().drawCalls} draw calls, pool ${lightPool.size})`);
}
tod.setFurniture(furniture, lightPool);

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

let pursuit = null;
// Risk 5 chase harness: max traffic + active pursuit + streaming churn, run
// against the budget gate long before the mission exists.
function setPursuit(n) {
  if (pursuit) { scene.remove(pursuit.mesh); scene.remove(pursuit.bars); pursuit = null; }
  if (n > 0) pursuit = new PursuitUnits(scene, district, { count: n });
  return !!pursuit;
}

let traffic = null;
function setTraffic(on) {
  if (on && !traffic) {
    traffic = new TrafficStub(scene, district, { count: typeof on === 'number' ? on : 30 });
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
  // Read the post stack's snapshot, never renderer.info directly: after the
  // composite blit renderer.info describes a 1-triangle fullscreen pass.
  const r = { calls: post.stats.totalCalls, triangles: post.stats.sceneTriangles };
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
    if (pursuit) pursuit.update(dt, vehicle.position);
    simTime += dt;
  }
  tod.follow(vehicle.position);
  lightPool.update(camera.position, tod.preset.lampsOn ? 1 : 0);

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

  post.render();
  if (metrics.recording) sample(dt);
  metrics.frames++;

  const w = world.report();
  hud.textContent =
    `${district.meta.city}  ·  ${PRESETS[tod.presetName].label}  ·  ${(vehicle.speed * 3.6).toFixed(0)} km/h\n` +
    `chunks ${w.chunksLoaded} (near ${w.lodNear} / far ${w.lodFar})  draw ${post.stats.totalCalls}  ` +
    `tris ${(post.stats.sceneTriangles / 1000).toFixed(1)}k  post ${post.stats.passes}\n` +
    `loads ${w.loads}  unloads ${w.unloads}  worst chunk build ${w.worstBuildMs.toFixed(1)}ms` +
    (traffic ? `  ·  traffic ${traffic.report().alive}` : '') +
    (pursuit ? `  ·  PURSUIT ${pursuit.report().active}` : '');

  input.endFrame();
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  post.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();
requestAnimationFrame(animate);

// ------------------------------------------------------------------ test hooks
window.__district = {
  district, world, vehicle, traffic: () => traffic, tod, post, renderer, scene, camera, chase, metrics,
  furniture, lightPool,
  get frames() { return metrics.frames; },
  setTraffic,
  setPursuit,
  pursuitReport: () => (pursuit ? pursuit.report() : null),
  setTimeOfDay: (n) => tod.apply(n),
  audit: () => tod.audit(),
  placeAt,
  renderStats: () => ({ calls: post.stats.totalCalls, sceneCalls: post.stats.sceneCalls,
    postPasses: post.stats.passes, triangles: post.stats.sceneTriangles }),
  worldReport: () => world.report(),
  trafficReport: () => (traffic ? traffic.report() : null),
  startRecording() { metrics.recording = true; metrics.samples.length = 0; world.stats.worstBuildMs = 0; },
  stopRecording() { metrics.recording = false; return metrics.samples; },
  setAutopilot(fn) { autopilot = fn; },
  setTimeScale(n) { timeScale = Math.max(1, n | 0); },
  get simTime() { return simTime; },
  setWeather: (w) => tod.setWeather(w),
  postParams: () => post.params,
  freeCam(pos, target, fov) {
    autopilot = () => {};
    camera.position.set(...pos);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.lookAt(...target);
    chase.update = () => {};
  },
};
hud.textContent = 'ready';
