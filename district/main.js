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
import { Pedestrians } from '../src/pedestrians.js';
import { PursuitUnits } from '../src/pursuit.js';
import { StreetFurniture } from '../src/streetfurniture.js';
import { LightPool } from '../src/lightpool.js';
import { Player } from '../src/player.js';
import { Character } from '../src/character.js';
import { LocomotionFSM, STATE } from '../src/animfsm.js';
import { TimeOfDay, PRESETS } from '../src/daynight.js';
import { PostStack } from '../src/post.js';
import { LoadingScreen } from '../src/loading.js';
import { Sky, SKY_PRESETS } from '../src/sky.js';
import { Weather } from '../src/weather.js';
import {
  generateSignageLibrary, districtSignageBuffers, signMaterial, streetSignMaterial,
  setSignageTime,
} from '../src/signage.js';
import { buildingStyle } from '../src/facades.js';
import { buildPlayerCar } from '../src/carbody.js';
import { HUD } from '../src/hud.js';
import { WantedSystem, bindPursuit, CRIMES, STATES } from '../src/wanted.js';
import { createAudio } from '../src/audio.js';

const canvas = document.getElementById('c');
// antialias: false, deliberately. The flag configures multisampling on the
// DEFAULT framebuffer, and the scene is never drawn there - PostStack renders it
// into an offscreen HDR target and the only thing that reaches the default
// framebuffer is a fullscreen triangle, which has no interior edges to resolve.
// The request had therefore been inert for this build's whole life while looking,
// in this line, exactly like working anti-aliasing. Anti-aliasing now lives in
// src/post.js where the scene actually is; asking for it here as well would only
// allocate a multisampled backbuffer nothing renders into.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
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

const loading = new LoadingScreen({ title: 'SARASOTA' });
let district, world, tod, post, sky, weather;
let signageRoot = null, signageStats = null, hud2 = null;
let hudEnabled = true;
let loadReport = null;

await loading
  .add('reading district', async () => {
    district = await (await fetch('../data/district.json')).json();
  })
  .add('generating materials', async () => {
    // Constructing the world builds the material registry and facade library.
    // ?kerbs=0 streams the district with no kerb, gutter pan or parking lane, so
    // a before/after capture is ONE build on ONE port with one thing different.
    // The alternative is two trees, which is exactly how two rounds in this
    // project came back with both arms photographing the same commit.
    world = new StreamingWorld(scene, district, {
      nearRadius: 2, farRadius: 5, budgetMs: 3,
      kerbs: new URLSearchParams(location.search).get('kerbs') !== '0',
    });
  })
  .add('atmosphere', async () => {
    sky = new Sky(renderer, scene);
    weather = new Weather(scene);
    weather.bindMaterials(world.registry);
  })
  .add('signage', async () => {
    generateSignageLibrary({ streetNames: Object.values(district.streetNames ?? {}) });
    const { buckets, street, stats } = districtSignageBuffers(district, {
      styleOf: (b) => world._capStyle(buildingStyle(b), b),
      streetDirFor: (b) => world._streetDirFor(b),
      // Both, so signage selects the same elevations the facade kit built on.
      // Passing only the primary put shopfront bays on a corner site's second
      // street with no awning or fascia above them.
      streetDirsFor: (b) => world._streetDirsFor(b),
    });
    signageRoot = new THREE.Group();
    signageRoot.name = 'signage';
    const meshOf = (buf, mat) => {
      if (!buf.pos.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
      if (buf.col && buf.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
      g.setIndex(buf.idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true; m.receiveShadow = true;
      return m;
    };
    for (const bk of buckets) {
      const m = meshOf(bk.sign, signMaterial({ time: 'dusk' }));
      if (m) signageRoot.add(m);
    }
    const sm = meshOf(street, streetSignMaterial({ time: 'dusk' }));
    if (sm) signageRoot.add(sm);
    scene.add(signageRoot);
    signageStats = stats;
  })
  .add('hud', async () => {
    // DOM + 2D canvas overlay: zero WebGL draw calls, so it costs nothing against
    // the budget the rest of this file is fighting for.
    hud2 = new HUD({ district, zoomMetres: 220 });
    // The debug text overlay is redundant once the real HUD is up.
    hud.style.display = 'none';
  })
  .add('lighting', async () => {
    tod = new TimeOfDay(scene, renderer);
    tod.setWorld(world);
    post = new PostStack(renderer, scene, camera);
    tod.attachPost(post);
    tod.setSky(sky, weather);
  })
  .run()
  .then((r) => { loadReport = r; });

// Street lamps: instanced geometry plus a nearest-N light pool.
//
// The chase harness measured 233 individually-meshed posts as ~70% of all draw
// calls, and 233 simultaneous PointLights would be a per-fragment loop of 233 on
// real hardware. Geometry is instanced (3 draw calls total) and only the nearest
// LIGHT_POOL_SIZE emitters are ever real lights.
// 2026-08-30: lamp coverage raised from 233. "~1000" was the estimate; the
// number actually placed is 543, and the two files now quote that. The
// estimate was high because the loop places Math.floor(len / 26) lamps per
// POLYLINE SEGMENT, and 1141 of the district's 1476 drivable segments are
// shorter than 26 m and so get none - re-derive it with the loop below
// against data/district.json rather than trusting either figure.
//
// Two blind night critics independently made "there is no street lighting" their
// single highest-leverage note. Measured, they were right, and not in the way the
// audit suggested: the pool reported 233 emitters with 7 active, so the system
// looked healthy. Disabling EVERY point light changed 0.5% of pixels (mean
// |diff| 0.085/255) - the lamps were lighting nothing.
//
// Cause: the district carries 44,110 m of street centreline, so 233 lamps is one
// every 189 m against a real-world 25-30 m, and because the loop alternates sides
// each pavement got one every ~380 m. The nearest emitter to the night camera
// measured 132.7 m away against a 46 m falloff cutoff and the pool's own 130 m
// maxDistance - every lamp in the district was outside its own radius AND outside
// the selection range. Four caps compounded to produce that: a named-edge filter,
// slice(0, 240), placed < 320, and max: 400.
//
// Lamps cost 3 draw calls at any count (they are InstancedMeshes) and the pool
// still promotes only 10 emitters to real lights, so the price of this is
// triangles and nothing else.
const furniture = new StreetFurniture(scene, { max: 1200 });
const lightPool = new LightPool(scene, { size: 10, maxDistance: 130 });
{
  // Every drivable edge, not just the named ones, and no slice: an unnamed
  // service street is still a street the player drives down at night.
  const arterials = district.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.r <= 6);
  let placed = 0;
  for (const { e } of arterials) {
    for (let k = 0; k < e.v.length - 1 && placed < 1100; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 26);
      for (let s = 1; s <= n && placed < 1100; s++) {
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
  console.log(`placed ${placed} street lamps (pool ${lightPool.size})`);

  // ---- everything else on the street.
  //
  // Three rounds of blind critics counted the props in the frame and reached the
  // same verdict every time: "across roughly 450,000 px of visible sidewalk I
  // count zero bins, hydrants, bollards, benches, planters, trees, meters,
  // poles, cellar doors, vents, or wall clutter"; "total prop count on the
  // street is one street-name blade"; "there is one vehicle in the entire
  // street, no parked cars along either edge".
  //
  // src/streetfurniture.js dresses the whole district in ONE pass here, at load,
  // and deliberately not per chunk: the chunk-build stall is the tightest budget
  // in the project (median 11.8 ms against a warn at 8) and placement work on
  // the streamer's critical path is the worst possible place to spend it. The
  // streamer never learns this module exists.
  //
  // The cost is bounded by construction. Every static prop in the district — the
  // signals, the kerb vocabulary, the trees, the wall clutter, the road castings
  // and the overhead spans — shares ONE material and is welded into spatial
  // buckets on two tiers: tall things that read from far away in 512 m cells,
  // small things that do not in 224 m cells that switch off past 200 m. So the
  // frustum throws away most of the district and sixteen prop types cost 9-11
  // measured draw calls between them rather than one apiece. Parked cars are
  // src/carbody.js's traffic-car geometry through a single InstancedMesh, pooled
  // around the camera the way traffic and the crowd already are.
  //
  // Measured at the corridor hero camera by hiding each system in turn:
  // props +11 calls / +67.1k triangles, parked cars +1 call / +27.8k.
  // ?nofrontage=1 dresses the district WITHOUT the shopfront row, so a capture
  // harness can shoot the before and the after arm from ONE build on ONE port.
  // The alternative is two builds in two trees, which is exactly how a four-hour
  // review round in this project was spent comparing a build with itself.
  // ?shadowreach=N caps how far a prop bucket may be and still be submitted to
  // the shadow pass; 1e6 restores the old behaviour of every visible bucket
  // casting. It exists so the claim "nothing that could have cast stops casting"
  // can be DIFFED rather than argued -- tools/arm-diff.mjs against the two arms
  // of one build.
  const _q = new URLSearchParams(location.search);
  furniture.dressDistrict(district, {
    shopFrontage: !_q.has('nofrontage'),
    ...(_q.has('shadowreach') ? { shadowReach: Number(_q.get('shadowreach')) } : {}),
  });
  // The pool is 30 cars and always will be — it is one InstancedMesh and its
  // cost does not move with the number. What DID move is which thirty slots it
  // picks. A second critic reported "zero parked vehicles along roughly 1,400 px
  // of kerb" against a placement pass that reported 1,540 slots, and both were
  // true: measured at this corridor camera the pool's nearest car was 106 m away
  // and its farthest 277 m, because the plan cleared 24 m at each end of every
  // POLYLINE SEGMENT (not every block) and the pool then filled itself in chunk
  // order rather than distance order. src/streetfurniture.js fixes both; the
  // same thirty cars now sit between 10 m and 76 m of this camera.
  furniture.buildParkedCars({ count: 30 });
  // The pool follows the camera and the signal lenses track the camera stop.
  // src/streetfurniture.js runs its own rAF for this rather than asking for a
  // slot in the render loop, so the whole system is two calls from here.
  furniture.bindView(camera, { exposure: () => post.params.exposure });
  console.log('street furniture', JSON.stringify(furniture.report()));
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

// The visual shell only. src/carbody.js reads the suspension state back out of
// the Vehicle to place its wheels and touches nothing else: the collision body,
// the wheel anchors and the spring rates are src/vehicle.js's alone, and
// tools/golden-trace.mjs gates that they stay that way.
//
// It replaces a box + a smaller box + four cylinders, which every blind critic
// across two review rounds named as one of the loudest defects in the frame. It
// is also CHEAPER: 3 draw calls where the boxes were 7.
const carMesh = buildPlayerCar({ paint: 0x9e2b20 });
scene.add(carMesh.group);
console.log('player car', JSON.stringify(carMesh.report()));

let pursuit = null;
// Risk 5 chase harness: max traffic + active pursuit + streaming churn, run
// against the budget gate long before the mission exists.
//
// This is the MANUAL path and it still wins outright: a harness that asks for
// eight cars gets eight cars whatever the wanted level says. `pursuitManual`
// below is what keeps the two owners off each other.
let pursuitManual = false;
function setPursuit(n) {
  if (pursuit) { scene.remove(pursuit.mesh); scene.remove(pursuit.bars); pursuit = null; }
  if (n > 0) pursuit = new PursuitUnits(scene, district, { count: n });
  pursuitManual = !!pursuit;
  return !!pursuit;
}

// ------------------------------------------------------------ wanted level
// src/wanted.js is the DECISION layer and nothing else: no three.js import, no
// mesh, no light, no clock of its own. Constructing it therefore touches neither
// the scene graph nor the frame, which is why it can be built here at load and
// left running — at zero stars `_syncUnits()` wants zero units, emits nothing,
// and the whole update is a handful of arithmetic on numbers it already owns.
//
// A fresh load renders exactly the frame it rendered before this file imported
// the module. The police only become real when a crime is reported.
const wanted = new WantedSystem();

// The bridge between the two owners' files.
//
// `bindPursuit` is duck-typed on purpose (see its header): it calls whatever the
// pursuit layer happens to implement and skips the rest. src/pursuit.js as it
// stands implements NONE of that vocabulary — it is the Phase 1b load harness,
// with a fixed fleet, plain `speed`/`giveUpRadius` fields and one shared target.
// So the shim lives here, in the file that already owns the pursuit lifecycle,
// rather than in either module: pursuit.js and wanted.js are both other owners'
// files and neither needs to learn about the other.
//
// Two things the shim deliberately does NOT pretend to support, because
// PursuitUnits cannot do them and a recorder that nothing reads would only hide
// that: `setUnitGoal` (it drives every car greedily at ONE target, so the
// per-unit intercept and search-ring roles are not honoured) and `setSpawnBand`
// (its spawn distance is hard-coded 70–260 m). Both are reported by
// wantedReport().notHonoured so the gap is visible rather than silent. What IS
// honoured is the part that matters most: fleet size, convergence target,
// speed multiplier and give-up radius.
const PURSUIT_CAPACITY = 8;              // == WantedSystem maxUnits, so the mesh never resizes
const PURSUIT_BASE_SPEED = 22;           // src/pursuit.js default, quoted so the multiplier means something
const _pursuitMat = new THREE.Matrix4();
const _pursuitVec = new THREE.Vector3();

const pursuitBridge = {
  ids: [],                               // ids[i] is the wanted unit holding pursuit slot i
  target: { x: 0, z: 0 },                // where the fleet is being asked to converge
  speedMul: 0,
  giveUp: 0,
  posPool: [],                           // reused, so reporting positions allocates nothing per frame
  posOut: [],

  // Build the fleet the first time a unit is actually wanted, and only then. The
  // InstancedMesh is allocated once at full capacity and the live count is
  // masked, so escalating from one star to five costs no geometry rebuild.
  _fleet(n) {
    if (pursuitManual) return;
    if (n <= 0) {
      // Parked, not destroyed: the InstancedMesh and its geometry are kept so a
      // second chase costs no rebuild. `visible` is what takes it out of the
      // render list entirely - an InstancedMesh left visible at count 0 still
      // costs a draw call - and it is also the flag the frame loop reads to skip
      // updating a fleet that is not in play.
      if (pursuit) {
        pursuit.mesh.visible = false; pursuit.bars.visible = false;
        pursuit.count = 0; pursuit.mesh.count = 0; pursuit.bars.count = 0;
      }
      return;
    }
    if (!pursuit) {
      pursuit = new PursuitUnits(scene, district, { count: PURSUIT_CAPACITY });
      if (this.giveUp > 0) pursuit.giveUpRadius = this.giveUp;
      if (this.speedMul > 0) pursuit.speed = PURSUIT_BASE_SPEED * this.speedMul;
    }
    pursuit.mesh.visible = true;
    pursuit.bars.visible = true;
    // Both counts, and they are different things: PursuitUnits.count is how many
    // slots it drives, InstancedMesh.count is how many it draws. Leaving the
    // second at capacity would draw the untouched slots at their identity
    // matrix - a row of cars parked at the world origin.
    pursuit.count = n;
    pursuit.mesh.count = n;
    pursuit.bars.count = n;
    for (let i = n; i < PURSUIT_CAPACITY; i++) pursuit.units[i] = null;
  },

  spawnUnit(id) {
    this.ids.push(id);
    this._fleet(this.ids.length);
  },

  releaseUnit(id) {
    const k = this.ids.indexOf(id);
    if (k < 0) return;
    this.ids.splice(k, 1);
    // Keep car and id aligned by index. Removing the released car's slot and
    // pushing a hole onto the end means every surviving car keeps its own
    // position and its own id; nothing teleports.
    if (pursuit && !pursuitManual) { pursuit.units.splice(k, 1); pursuit.units.push(null); }
    this._fleet(this.ids.length);
  },

  setUnitCount(n) { this._fleet(Math.min(n, PURSUIT_CAPACITY)); },
  setTarget(x, z) { this.target.x = x; this.target.z = z; },
  setSpeedMultiplier(m) {
    this.speedMul = m;
    if (pursuit && !pursuitManual && m > 0) pursuit.speed = PURSUIT_BASE_SPEED * m;
  },
  setGiveUpRadius(r) {
    this.giveUp = r;
    if (pursuit && !pursuitManual && r > 0) pursuit.giveUpRadius = r;
  },

  // Positions back in. This is what lets the police actually SEE the player:
  // with no `seen` flag from the host, src/wanted.js decides contact purely by
  // unit proximity, so a fleet that never reports where it is can never hold a
  // wanted level and every chase would decay on its own.
  //
  // PursuitUnits keeps a car's position only in its instance matrix, so that is
  // where it is read from - the same route src/audio.js takes for the sirens.
  // Empty slots are skipped: their matrix is the scale-zero hide matrix, whose
  // translation is the world origin, and reporting that would put a phantom
  // officer at 0,0 holding contact forever.
  getUnitPositions() {
    const out = this.posOut;
    out.length = 0;
    if (!pursuit || pursuitManual) return out;
    const n = Math.min(this.ids.length, pursuit.count);
    for (let i = 0; i < n; i++) {
      if (!pursuit.units[i]) continue;
      pursuit.mesh.getMatrixAt(i, _pursuitMat);
      _pursuitVec.setFromMatrixPosition(_pursuitMat);
      const slot = this.posPool[i] ?? (this.posPool[i] = { id: 0, x: 0, z: 0 });
      slot.id = this.ids[i]; slot.x = _pursuitVec.x; slot.z = _pursuitVec.z;
      out.push(slot);
    }
    return out;
  },
};

const wantedBridge = bindPursuit(wanted, pursuitBridge, { baseSpeed: PURSUIT_BASE_SPEED });
// Reused, so the per-frame police update allocates nothing at all.
const _wantedPlayer = { x: 0, z: 0 };

// ------------------------------------------------------------------- audio
// Nothing is built until the player's first gesture, and that is a stronger rule
// than it looks.
//
// Every browser constructs an AudioContext suspended and Chrome logs a warning
// for one created before a gesture, so the usual shape - build at load, resume
// later - starts a page with a console warning and a graph that cannot be heard.
// Constructing inside the gesture instead means a headless capture, which never
// generates one, creates NO AudioContext, no nodes, no THREE.AudioListener and
// no camera child: there is nothing for it to differ by. `audio` stays null and
// every call site below is already guarded, so the frame loop skips it whole.
//
// src/audio.js is safe either way - it no-ops when there is no AudioContext and
// counts, rather than logs, anything asked of it while suspended - but not
// building it at all is the only version with provably zero cost.
let audio = null;
let audioTod = null, audioRain = -1, audioWet = -1;
let audioSirens = false;

function initAudio(opts = {}) {
  if (audio) return audio;
  audio = createAudio({ timeOfDay: tod.presetName, ...opts });
  if (audio.available) {
    // Positional sirens follow the camera through three's own listener, so the
    // pose is the one the renderer already computed. This is also the only thing
    // in this block that touches an Object3D, which is why it happens here and
    // not at load: before the first gesture the camera has no children.
    audio.attachListener(camera);
    pushAudioEnvironment(0);
  }
  return audio;
}

// Time of day and weather are pushed only when they actually change: a
// setTargetAtTime on every bed every frame is param traffic for nothing.
function pushAudioEnvironment(fade = 1.6) {
  if (!audio || !audio.available) return;
  const name = tod.presetName;
  if (name !== audioTod) {
    audioTod = name;
    // The module throws rather than silently crossfading the wrong bed. Correct
    // for it; fatal for a frame loop, so the mixer loses a bed and the game
    // keeps running.
    try { audio.setTimeOfDay(name, fade); } catch (e) { console.warn('audio:', e.message); }
  }
  // weather.rain is the rain MESH; the scalar lives on the active preset.
  const rain = weather.current?.rain ?? 0;
  const wet = weather.wetness ?? 0;
  if (rain !== audioRain || Math.abs(wet - audioWet) > 0.01) {
    audioRain = rain; audioWet = wet;
    audio.setWeather({ rain, wetness: wet }, fade);
  }
}

// One listener, removed the moment it fires. `resume()` never throws and never
// rejects, so nothing here needs a catch; a browser that refuses leaves the game
// exactly as it was.
function onFirstGesture() {
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    removeEventListener(ev, onFirstGesture, true);
  }
  initAudio();
  if (audio.available) audio.resume();
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(ev, onFirstGesture, true);
}

// ------------------------------------------------------------------ on foot
// The player controller, character and animation state machine share one owner
// (FEASIBILITY.md 8b): feel is a joint property of controller, camera and
// animation, and splitting them produces three half-tunings.
const player = new Player();
const character = new Character();
scene.add(character.root);
const fsm = new LocomotionFSM();

let mode = 'car';                 // 'car' | 'foot'
let enterCooldown = 0;
const ENTER_RANGE = 3.6;
const ENTER_TIME = 0.45;

// The car is a moving obstacle while on foot.
const carCollider = { x: 0, z: 0, y: 0, hx: 1.25, hy: 1.5, hz: 2.4 };
// Buildings near the player, refreshed only when the player changes chunk:
// rebuilding this from the district every frame is pointless work.
let footColliders = [];
let footColliderKey = '';
function refreshFootColliders(pos) {
  const key = world.keyOf(pos.x, pos.z);
  if (key === footColliderKey) return;
  footColliderKey = key;
  footColliders = [];
  const [cx, cz] = key.split(',').map(Number);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = district.chunks[`${cx + dx},${cz + dz}`];
      if (!c) continue;
      for (const bi of c.buildings) {
        const b = district.buildings[bi];
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of b.p) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        footColliders.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, y: 0,
          hx: (x1 - x0) / 2, hy: b.h, hz: (z1 - z0) / 2 });
      }
    }
  }
}

function toggleVehicle() {
  if (enterCooldown > 0 || fsm.locked) return false;
  if (mode === 'foot') {
    if (player.position.distanceTo(vehicle.position) > ENTER_RANGE) return false;
    fsm.lockTransition(STATE.ENTER_VEHICLE, ENTER_TIME);
    mode = 'car';
    chase.mode = 'car';
    enterCooldown = ENTER_TIME;
  } else {
    fsm.lockTransition(STATE.EXIT_VEHICLE, ENTER_TIME);
    mode = 'foot';
    chase.mode = 'foot';
    const side = new THREE.Vector3(-1, 0, 0).applyQuaternion(vehicle.quaternion);
    player.position.copy(vehicle.position).addScaledVector(side, 1.9);
    player.position.y = world.heightAt();
    player.velocity.set(0, 0, 0);
    player.yaw = Math.atan2(side.x, side.z);
    enterCooldown = ENTER_TIME;
  }
  return true;
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

// ------------------------------------------------------------------ crowd
// Pedestrians are ON BY DEFAULT, unlike traffic. "No pedestrians" was named by
// every blind critic across both review rounds, and a system that only appears
// when a harness passes a flag is not a system - the audit already caught two
// modules in this project that existed but were never imported by the live app.
// The whole crowd is four InstancedMeshes (src/pedestrians.js explains why), so
// switching it on costs a measured 4 scene draw calls whatever the population -
// 125 -> 129 on the hero corridor, against a gate that warns at 200. That fixed
// cost is the only reason it can be default-on at all.
//
// The radii are tighter than traffic's on purpose. Traffic spawns 90-340 m out because
// cars cross that in seconds; people walk, so a crowd seeded that far away never
// reaches the player and the pavement in front of the camera stays empty. These
// numbers keep the population concentrated in the block the player is actually
// standing in, which is where "living streets" has to be true.
const PED_OPTS = { despawnRadius: 125, spawnMin: 12, spawnMax: 90 };
let peds = null;
function setPedestrians(n) {
  if (peds) { peds.dispose(); peds = null; }
  if (n > 0) {
    peds = new Pedestrians(scene, district, { ...PED_OPTS, count: n, ground: world });
    // Same hook traffic uses: "orphan" then means a ped simulated in a chunk the
    // streamer has not loaded, rather than a guess from distance.
    peds.isChunkLoaded = (x, z) => world.loaded.has(world.keyOf(x, z));
  }
  return !!peds;
}
setPedestrians(96);

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
    stall: +w.sliceMs.toFixed(2),
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
  enterCooldown = Math.max(0, enterCooldown - dt);
  if (input.hit('KeyF')) toggleVehicle();

  if (!autopilot && mode === 'foot') {
    // On foot the vehicle idles on its springs rather than sinking.
    vehicle.setControls({ throttle: 0, brake: 1, steer: 0 });
  } else if (!autopilot) {
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
    if (mode === 'foot') {
      carCollider.x = vehicle.position.x; carCollider.z = vehicle.position.z;
      refreshFootColliders(player.position);
      player.update(dt, input, chase.yaw, world, [...footColliders, carCollider]);
    }
    vehicle.stepFixed(dt, world);
    world.update(mode === 'foot' ? player.position : vehicle.position);
    if (traffic) traffic.update(dt, vehicle.position);
    // Peds follow whatever the camera is actually near, not the parked car:
    // on foot the crowd has to be around the player or the pavement is empty
    // exactly where it is most visible.
    if (peds) peds.update(dt, mode === 'foot' ? player.position : vehicle.position);
    // The police decide, then the cars move. bindPursuit pushes this frame's plan
    // through the shim above; movement stays entirely with src/pursuit.js, driven
    // at the plan's target - the player while they are being seen, the last known
    // position once they are not, which is what puts the search state on the
    // street instead of only in the report.
    //
    // At zero stars this is arithmetic on numbers the module already owns: no
    // event, no unit, no allocation, and `pursuit` is still null.
    const wpos = mode === 'foot' ? player.position : vehicle.position;
    _wantedPlayer.x = wpos.x; _wantedPlayer.z = wpos.z;
    const plan = wantedBridge.update(dt, _wantedPlayer);
    // A parked fleet is skipped outright. PursuitUnits.update() ends by flagging
    // both instance matrices needsUpdate, so calling it on a hidden fleet with
    // nothing to drive would re-upload two buffers every frame for no cars.
    if (pursuit && pursuit.mesh.visible) {
      pursuit.update(dt, pursuitManual ? vehicle.position : plan.target);
    }
    simTime += dt;
  }
  const focus = mode === 'foot' ? player.position : vehicle.position;
  tod.follow(focus);
  // The sky's per-frame work is in two halves that want opposite ends of this
  // loop, so only one of them is here. This is the fog half: cloud drift and the
  // aerial-perspective params, which have to land before tod.normalisePostExposure()
  // three lines down. The camera half - the ray matrix the dome shader builds
  // every view ray from - is below, after chase.update().
  sky.updateFrame();
  weather.update(dt, camera);
  weather.applyToPost(post);
  weather.applyToSky(sky);
  // Runs last: the sky and weather both write fog terms as physical radiance, and
  // only after both have written can it be checked against the camera stop.
  tod.normalisePostExposure();

  // --- character
  fsm.update(dt, {
    speed: Math.hypot(player.velocity.x, player.velocity.z),
    grounded: player.grounded,
    verticalVelocity: player.velocity.y,
    inVehicle: mode === 'car',
    running: input.down('ShiftLeft') || input.down('ShiftRight'),
    sprinting: input.down('ShiftLeft') || input.down('ShiftRight'),
    wishLength: Math.hypot(input.moveAxis().x, input.moveAxis().y),
    turnRate: 0,
  });
  character.root.visible = mode === 'foot' || fsm.locked;
  if (mode === 'foot') {
    character.root.position.copy(player.position);
    character.root.rotation.y = player.yaw;
    character.applyPose(fsm.pose());
  } else if (fsm.locked) {
    character.root.position.copy(vehicle.position);
    character.applySeated();
  }

  const q = vehicle.quaternion;
  const carYaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
  if (mode === 'foot') chase.update(dt, player.position, world);
  else chase.update(dt, vehicle.position, world, carYaw + Math.PI, vehicle.forwardSpeed > 3 ? 1.6 : 0);

  // The camera half of the sky, for the same reason as the pool below and then
  // one more. chase.update() has just written this frame's camera transform, and
  // the dome is a fullscreen triangle whose every ray comes from uRayMatrix, so
  // running this before chase.update drew the whole sky for the previous frame's
  // heading: measured at the full 30 deg of a 30 deg jump, held for one rendered
  // frame, and at exactly one frame of turn under a steady yaw
  // (tools/lamp-viewlag.mjs). The player sees it as the sky sliding against the
  // buildings whenever the camera moves.
  //
  // Moving the call is only half of it - Sky.updateView() also has to refresh
  // camera.matrixWorld, which nothing else does until post.render() below. Its
  // comment has that argument.
  sky.updateView(camera);

  // AFTER chase.update, and with the camera itself rather than its position.
  //
  // The pool has ten slots for 543 emitters and used to choose by horizontal
  // distance alone, which spent six of them on lamps behind the corridor camera
  // at night - lighting nothing the player could see, while the lamps down the
  // street the player WAS looking at glowed with no pool of light under them
  // (their fixture geometry is emissive and drawn whatever the pool does). The
  // camera is what makes that judgement possible, so it is what gets handed over.
  //
  // Order matters twice. chase.update() is what writes this frame's camera
  // transform, so calling before it ranked against last frame's view - a lag the
  // player sees as the lit set trailing the turn. And post.render() is still
  // ahead of us, so the selection made here is the one that renders.
  lightPool.update(camera.position, tod.preset.lampsOn ? 1 : 0, camera);

  carMesh.group.position.copy(vehicle.position);
  carMesh.group.quaternion.copy(vehicle.quaternion);
  carMesh.updateWheels(vehicle);
  // Headlamps and tail lamps track the lamp schedule, divided by the camera stop
  // so a lens reads as blown out at dusk AND at night rather than at neither.
  carMesh.setLights(tod.preset.lampsOn, post.params.exposure);
  if (traffic) traffic.setLights(tod.preset.lampsOn, post.params.exposure);
  if (pursuit && pursuit.mesh.visible) pursuit.setLights(tod.preset.lampsOn, post.params.exposure);

  // Audio, only once the player has actually pressed something. Until then this
  // is a single null check per frame and there is no graph to drive.
  if (audio) {
    pushAudioEnvironment();
    // Sirens read positions out of the instance matrices, so a hidden fleet would
    // sound like eight cars parked at the world origin.
    const livePursuit = pursuit && pursuit.mesh.visible ? pursuit : null;
    audio.update(dt, {
      vehicle: mode === 'car' ? vehicle : null,
      pursuit: livePursuit,
      listenerPos: focus,
    });
    // updatePursuit is what moves a siren voice, and it only runs while there IS
    // a fleet - so the moment the last unit is released the voices would hold
    // their final wail forever. Measured: three voices still sounding after the
    // level was cleared. Silence them once, on the edge.
    if (livePursuit) audioSirens = true;
    else if (audioSirens) { audio.sirensOff(); audioSirens = false; }
  }

  post.render();
  if (metrics.recording) sample(dt);
  metrics.frames++;

  const w = world.report();
  const near = mode === 'foot' && player.position.distanceTo(vehicle.position) <= ENTER_RANGE;
  if (hud2 && hudEnabled) {
    const q = vehicle.quaternion;
    const heading = mode === 'foot'
      ? player.yaw
      : Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    hud2.update({
      dt,
      inVehicle: mode === 'car',
      vehicle: mode === 'car' ? vehicle : null,
      px: focus.x, pz: focus.z, heading,
      district: district.meta.city,
      prompt: near ? 'PRESS F TO ENTER VEHICLE' : null,
      // src/hud.js already draws the five stars, already animates the escalation
      // flash and already exposes setWanted(); the meter was simply never fed.
      // It flashes while the level is DRAINING - contact lost, a star about to
      // go - which is the genre's own tell that you are nearly clear.
      //
      // HUD._set() ignores a value that has not changed, so at zero stars this
      // is one comparison and no redraw: the status canvas stays exactly as
      // clean as it was before the meter had a source.
      wanted: wanted.stars,
      wantedFlash: wanted.state === STATES.SEARCH,
    });
  }
  hud.textContent =
    `${district.meta.city}  ·  ${PRESETS[tod.presetName].label}  ·  ` +
    (mode === 'car' ? `${(vehicle.speed * 3.6).toFixed(0)} km/h  [F] exit`
      : `ON FOOT ${fsm.state}${near ? '   [F] ENTER VEHICLE' : ''}`) + `\n` +
    `chunks ${w.chunksLoaded} (near ${w.lodNear} / far ${w.lodFar})  draw ${post.stats.totalCalls}  ` +
    `tris ${(post.stats.sceneTriangles / 1000).toFixed(1)}k  post ${post.stats.passes}\n` +
    `loads ${w.loads}  unloads ${w.unloads}  worst slice ${w.worstSliceMs.toFixed(1)}ms  queued ${w.queued}` +
    (traffic ? `  ·  traffic ${traffic.report().alive}` : '') +
    (peds ? `  ·  peds ${peds.aliveCount}` : '') +
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
  loadReport: () => loadReport,
  furniture, lightPool, car: carMesh,
  get frames() { return metrics.frames; },
  setTraffic,
  setPursuit,
  pedestrians: () => peds,
  setPedestrians,
  pedestrianReport: () => (peds ? peds.report() : null),
  pedestrianPositions: () => (peds ? peds.positions() : []),
  player, character, fsm, input,
  // Headless harnesses drive the game through these rather than synthesising key
  // events, which pointer-lock and focus rules make unreliable in a headless page.
  press: (code) => { input.keys.add(code); input.pressed.add(code); },
  release: (code) => input.keys.delete(code),
  get mode() { return mode; },
  toggleVehicle,
  setMode(m) { if (m !== mode) toggleVehicle(); },
  pursuitReport: () => (pursuit ? pursuit.report() : null),

  // ---------------------------------------------------------- wanted / police
  // The decision layer itself, so a tool can subscribe to its events, and the
  // crime vocabulary, so a tool does not have to hard-code the ids.
  wanted, CRIMES,
  /** Report a crime. This is the ONLY way the level ever rises by itself. */
  reportCrime: (id, opts) => wanted.reportCrime(id, opts),
  /** Mission scripting and harnesses: set the level with no crime behind it. */
  setWanted: (n) => wanted.setStars(n),
  clearWanted: (reason) => wanted.clear(reason ?? 'cleared'),
  wantedReport: () => ({
    ...wanted.report(),
    fleet: pursuit ? pursuit.report() : null,
    fleetVisible: !!(pursuit && pursuit.mesh.visible),
    manualPursuit: pursuitManual,
    boundIds: [...pursuitBridge.ids],
    // Honest about the seam: PursuitUnits drives every car at one shared target
    // and picks its own spawn distance, so these two parts of the plan reach it
    // and are dropped. Nothing else in the plan is.
    notHonoured: ['setUnitGoal', 'setSpawnBand'],
  }),

  // ------------------------------------------------------------------- audio
  // A getter, like traffic() and pedestrians(), because it is null until the
  // player's first gesture - or until a tool asks for it explicitly.
  audio: () => audio,
  /** Build the graph without a gesture. It stays SUSPENDED; resume() needs one. */
  initAudio: (opts) => { const a = initAudio(opts); return a.report(); },
  /** Build if needed and resume. Only a real gesture makes this reach 'running'. */
  resumeAudio: async () => { initAudio(); return audio.available ? audio.resume() : false; },
  audioReport: () => (audio ? audio.report() : null),
  setTimeOfDay: (n) => { const r = tod.apply(n); setSignageTime(n); return r; },
  signageStats: () => signageStats,
  // Isolation switch for the harnesses: the HUD is per-frame canvas work and a GC
  // pause it provokes lands inside whatever is running, including world.update().
  setHudEnabled: (on) => { if (hud2) { hud2.state.visible = on; hudEnabled = on; } },
  // So a tool can read what the wanted meter was actually fed, rather than
  // trusting that the call site passes it.
  hud: () => hud2,
  audit: () => tod.audit(),
  placeAt,
  renderStats: () => ({ calls: post.stats.totalCalls, sceneCalls: post.stats.drawCalls,
    postPasses: post.stats.passes, triangles: post.stats.sceneTriangles }),
  worldReport: () => world.report(),
  trafficReport: () => (traffic ? traffic.report() : null),
  startRecording() { metrics.recording = true; metrics.samples.length = 0; world.resetPeakStats(); },
  stopRecording() { metrics.recording = false; return metrics.samples; },
  setAutopilot(fn) { autopilot = fn; },
  setTimeScale(n) { timeScale = Math.max(1, n | 0); },
  get simTime() { return simTime; },
  sky, weather,
  setWeather: (name, opts) => weather.set(name, opts),
  setWeatherRaw: (w) => tod.setWeather(w),
  // Measurement hook, not gameplay. The sun's azimuth lives in TWO places that
  // must never disagree: daynight.js drives the DirectionalLight (and therefore
  // every cast shadow) and sky.js draws the disc, the gradient and the PMREM that
  // lights the walls. Moving one alone produces a frame whose shadows point away
  // from its own sunset. Harnesses sweep this to find out where the light has to
  // stand for occlusion to be visible at all.
  setSunAzimuth(name, rad) {
    PRESETS[name].azimuth = rad;
    SKY_PRESETS[name].sunAzimuth = name === 'night' ? rad + Math.PI : rad;
    if (name === 'night') SKY_PRESETS[name].moonAzimuth = rad;
    tod.apply(name);
    tod.follow(camera.position);
    return { azimuth: rad, skyAzimuth: SKY_PRESETS[name].sunAzimuth };
  },
  // Also a measurement hook. Note the two files deliberately DISAGREE about dusk's
  // elevation - daynight.js says 0.055 rad, sky.js says 0, and sky.js explains why
  // at length. This sets them equal, which is what a probe comparing elevations
  // wants: one variable, not two. It is not how a preset should be authored.
  setSunElevation(name, rad) {
    PRESETS[name].elevation = rad;
    SKY_PRESETS[name].sunElevation = name === 'night' ? -rad : rad;
    if (name === 'night') SKY_PRESETS[name].moonElevation = rad;
    tod.apply(name);
    tod.follow(camera.position);
    return { elevation: rad };
  },
  postParams: () => post.params,
  // Anti-aliasing A/B. Returns the state actually reached - samples read back
  // off the render target and the renderer's own context attribute - so a
  // harness can assert the arm it thinks it is measuring.
  setAA: (mode) => post.setAA(mode),
  aaState: () => post.aaState(),
  freeCam(pos, target, fov) {
    autopilot = () => {};
    camera.position.set(...pos);
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.lookAt(...target);
    chase.update = () => {};
  },
};
hud.textContent = 'ready';
loading.hide();
console.log('load report', JSON.stringify(loadReport));
