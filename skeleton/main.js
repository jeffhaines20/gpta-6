import * as THREE from '../vendor/three.module.min.js';
import { Input } from '../src/input.js';
import { Player } from '../src/player.js';
import { Vehicle } from '../src/vehicle.js';
import { ChaseCamera } from '../src/camera.js';
import { FlatGround } from '../src/ground.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb4d8);
scene.fog = new THREE.Fog(0x8fb4d8, 60, 240);

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
const input = new Input(canvas);
const chase = new ChaseCamera(camera);
const ground = new FlatGround(0);

// ---------------------------------------------------------------- lighting
scene.add(new THREE.HemisphereLight(0xbdd7f5, 0x4a4a44, 1.5));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.position.set(30, 48, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const s = 45;
Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 140 });
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- test block
const groundMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x53565c, roughness: 0.95 })
);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// Lane stripes give a speed reference — you cannot tune a car you cannot feel.
const stripeGeo = new THREE.PlaneGeometry(0.35, 5);
const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd8d2b8, roughness: 0.8 });
const stripes = new THREE.InstancedMesh(stripeGeo, stripeMat, 160);
const m4 = new THREE.Matrix4();
let si = 0;
for (let i = -40; i < 40; i++) {
  for (const x of [-8, 8]) {
    m4.makeRotationX(-Math.PI / 2);
    m4.setPosition(x, 0.02, i * 10);
    stripes.setMatrixAt(si++, m4);
  }
}
stripes.count = si;
scene.add(stripes);

// Blocks: collision reference + something to judge motion against.
const colliders = [];
const blockMat = new THREE.MeshStandardMaterial({ color: 0x9a9186, roughness: 0.9 });
for (let i = 0; i < 26; i++) {
  const w = 6 + Math.random() * 10, h = 6 + Math.random() * 26, d = 6 + Math.random() * 10;
  const ang = (i / 26) * Math.PI * 2;
  const rad = 34 + Math.random() * 62;
  const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat);
  b.position.set(x, h / 2, z);
  b.castShadow = b.receiveShadow = true;
  scene.add(b);
  colliders.push({ x, z, y: 0, hx: w / 2, hy: h, hz: d / 2 });
}

// ---------------------------------------------------------------- actors
const player = new Player();
const vehicle = new Vehicle();
vehicle.position.set(6, 0.55, 4);

function buildCharacter() {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xc79a72, roughness: 0.7 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x2f4a63, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.85 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.5, 4, 10), cloth);
  torso.position.y = 1.2; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 12), skin);
  head.position.y = 1.72; g.add(head);

  const limbs = {};
  const mk = (name, mat, r, len, x, y) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat);
    mesh.position.y = -len / 2 - r * 0.5;
    pivot.add(mesh);
    g.add(pivot);
    limbs[name] = pivot;
  };
  mk('armL', cloth, 0.085, 0.44, -0.33, 1.44);
  mk('armR', cloth, 0.085, 0.44,  0.33, 1.44);
  mk('legL', dark, 0.105, 0.52, -0.13, 0.92);
  mk('legR', dark, 0.105, 0.52,  0.13, 0.92);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, limbs };
}
const char = buildCharacter();
scene.add(char.group);

function buildCar() {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xb4322c, roughness: 0.35, metalness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.12, metalness: 0.7 });

  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.62, 4.3), body);
  lower.position.y = 0.20; g.add(lower);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.56, 2.1), glass);
  cabin.position.set(0, 0.74, -0.15); g.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 1.7), body);
  roof.position.set(0, 1.03, -0.2); g.add(roof);

  const wheels = [];
  const tyre = new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.95 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.85 });
  for (let i = 0; i < 4; i++) {
    const wg = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18), tyre);
    t.rotation.z = Math.PI / 2; wg.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.28, 12), rim);
    r.rotation.z = Math.PI / 2; wg.add(r);
    g.add(wg); wheels.push(wg);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, wheels };
}
const car = buildCar();
scene.add(car.group);

// ---------------------------------------------------------------- state
let mode = 'foot';        // 'foot' | 'car'
let enterCooldown = 0;
const ENTER_RANGE = 3.4;

const hud = document.getElementById('hud');
const prompt = document.getElementById('prompt');

function tryToggleVehicle() {
  if (enterCooldown > 0) return;
  if (mode === 'foot') {
    if (player.position.distanceTo(vehicle.position) > ENTER_RANGE) return;
    mode = 'car';
    chase.mode = 'car';
    char.group.visible = false;
    enterCooldown = 0.4;
  } else {
    mode = 'foot';
    chase.mode = 'foot';
    char.group.visible = true;
    const side = new THREE.Vector3(-1, 0, 0).applyQuaternion(vehicle.quaternion);
    player.position.copy(vehicle.position).addScaledVector(side, 1.75);
    player.position.y = ground.heightAt(player.position.x, player.position.z);
    player.velocity.set(0, 0, 0);
    enterCooldown = 0.4;
  }
}

// The car is a moving obstacle for the player, so its collider follows it.
const carCollider = { x: 0, z: 0, y: 0, hx: 1.2, hy: 1.4, hz: 2.3 };

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.033, (now - last) / 1000 || 0.016);
  last = now;

  chase.handleMouse(input);
  if (input.hit('KeyF')) tryToggleVehicle();
  enterCooldown = Math.max(0, enterCooldown - dt);

  if (mode === 'foot') {
    carCollider.x = vehicle.position.x;
    carCollider.z = vehicle.position.z;
    player.update(dt, input, chase.yaw, ground, [...colliders, carCollider]);
    // Idle the car so it settles on its springs instead of sinking.
    vehicle.setControls({ throttle: 0, brake: 1, steer: 0 });
    vehicle.stepFixed(dt, ground);
    chase.update(dt, player.position, ground);
  } else {
    const axis = input.moveAxis();
    const reversing = vehicle.forwardSpeed < 0.5;
    let throttle = 0, brake = 0;
    if (axis.y > 0) { if (vehicle.forwardSpeed < -0.5) brake = 1; else throttle = 1; }
    else if (axis.y < 0) { if (vehicle.forwardSpeed > 0.5) brake = 1; else throttle = -0.55; }
    vehicle.setControls({
      throttle, brake,
      steer: -axis.x * (reversing && throttle < 0 ? -1 : 1),
      handbrake: input.down('Space'),
    });
    vehicle.stepFixed(dt, ground);
    const carYaw = Math.atan2(
      2 * (vehicle.quaternion.w * vehicle.quaternion.y + vehicle.quaternion.x * vehicle.quaternion.z),
      1 - 2 * (vehicle.quaternion.y ** 2 + vehicle.quaternion.x ** 2)
    );
    // Only auto-align while actually moving forward, so the player keeps
    // free look when parked.
    const align = vehicle.forwardSpeed > 3 ? 1.6 : 0;
    chase.update(dt, vehicle.position, ground, carYaw + Math.PI, align);
  }

  // --- sync visuals
  char.group.position.copy(player.position);
  char.group.rotation.y = player.yaw;
  const swing = Math.sin(player.phase * 2.4) * 0.85 * player.moveAmount;
  char.limbs.legL.rotation.x = swing;
  char.limbs.legR.rotation.x = -swing;
  char.limbs.armL.rotation.x = -swing * 0.75;
  char.limbs.armR.rotation.x = swing * 0.75;

  car.group.position.copy(vehicle.position);
  car.group.quaternion.copy(vehicle.quaternion);
  for (let i = 0; i < 4; i++) {
    const w = vehicle.wheels[i];
    car.group.worldToLocal(car.wheels[i].position.copy(w.worldPos));
    car.wheels[i].rotation.set(0, 0, 0);
    car.wheels[i].rotateY(w.steer ? vehicle.steer : 0);
    car.wheels[i].rotateX(w.spinAngle);
  }

  const focus = mode === 'car' ? vehicle.position : player.position;
  sun.position.set(focus.x + 30, 48, focus.z + 18);
  sun.target.position.copy(focus);
  sun.target.updateMatrixWorld();

  const kmh = (vehicle.speed * 3.6).toFixed(0);
  hud.textContent = mode === 'car'
    ? `DRIVING   ${kmh} km/h   grounded ${vehicle.wheels.filter(w => w.contact).length}/4   [F] exit  [Space] handbrake`
    : `ON FOOT   [WASD] move  [Shift] run  [Space] jump  [F] enter vehicle`;

  const near = mode === 'foot' && player.position.distanceTo(vehicle.position) <= ENTER_RANGE;
  prompt.style.opacity = near ? '1' : '0';

  renderer.render(scene, camera);
  input.endFrame();
  frames++;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
let frames = 0;
requestAnimationFrame(animate);

// Test hooks — lets the headless harness drive the game without a real user.
window.__game = {
  get mode() { return mode; },
  get frames() { return frames; },
  player, vehicle, chase, input,
  press: (c) => { input.keys.add(c); input.pressed.add(c); },
  release: (c) => input.keys.delete(c),
  toggleVehicle: tryToggleVehicle,
};
