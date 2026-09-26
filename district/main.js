// Phase 1b district probe: real baked geometry, chunk streaming, the Phase 1
// vehicle driving on it unchanged, stub traffic, and a time-of-day sweep.
//
// Map data © OpenStreetMap contributors (ODbL). All names are invented.

import * as THREE from '../vendor/three.module.min.js';
import { Input } from '../src/input.js';
import { Vehicle, BODY_SAMPLES, BODY_RADIUS, BODY_ENCLOSING } from '../src/vehicle.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel, IMPACT, dynamicContact } from '../src/damage.js';
import { RoadGraph, followPath } from '../src/roadpath.js';
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
  setSignageTime, spillMaterial, soffitMaterial, setSpillScale, setSoffitScale, spillScaleOf,
} from '../src/signage.js';
import { buildingStyle } from '../src/facades.js';
import { buildPlayerCar, setTrafficRimScale, setTrafficTyreScale, setTrafficHubScale,
  setTrafficLampAlbedo, setGlassAlbedo, setGlassEnv, glassEnv, setCarLensArm, setShellNames, shellNames,
  carLensArm, setFrontLensScale, frontLensScale, frontLensLuma,
  setLensFinish, lensFinish,
  setLensProfile, lensProfile,
  setGlassFinish, glassFinish } from '../src/carbody.js';
import { HUD } from '../src/hud.js';
import { MissionRunner, OUTCOMES } from '../src/mission.js';
import { MISSIONS } from '../src/missions.js';
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
    const _boot = new URLSearchParams(location.search);
    // ?lens=0 is the round-4 car pass turned OFF: flat lens emission and a dark
    // parked tail lens, i.e. exactly the build this round replaces. Read here,
    // before any car geometry or car material exists, because the lens falloff
    // is a uniform every car material picks up at compile time and the parked
    // reflector level is read the first time the pool's exposure is applied.
    // Same mechanism and same argument as ?kerbs=0, ?nospill=1 and ?rim=K: the
    // alternative is two trees, which is how this project has twice compared a
    // build against itself.
    if (_boot.has('lens')) {
      const k = Number(_boot.get('lens'));
      console.log('car lens arm', JSON.stringify(setCarLensArm(Number.isFinite(k) ? k : 0)));
    }
    // ?front=K is the round-5 FRONT reflector, read at the same point and for the
    // same reason: the retro palette's texels are baked the first time the parked
    // pool asks for the texture. ?front=0 is round 4 exactly.
    if (_boot.has('front')) {
      const k = Number(_boot.get('front'));
      console.log('car front lens', JSON.stringify(setFrontLensScale(Number.isFinite(k) ? k : 1)));
    }
    // ?shells=1 IS THE PRE-SHELL BUILD, and it is the only one of this round's
    // four car changes that no runtime lever can reach: a slot's shell is chosen
    // when the pool BUILDS, from its own hash modulo the shell count, and the
    // matrices are written per shell thereafter. Read here, before either pool
    // exists, for the same reason ?lens= and ?front= are.
    //
    // It is not an approximation of the before-arm. SHAPES.coupe is `{}`,
    // buildTrafficCarGeometry falls back to CAR on an empty shape object, and
    // tools/car-shapes.mjs asserts the coupe is byte-identical to no shape at
    // all - so at 1 the modulus collapses to 0 for every slot and both pools
    // emit exactly the geometry the reviewers judged. The alternative was a
    // second checkout on a second port: 1.8 GB of docs/ on a box with 9.3 GB
    // free, and the setup that cost this project a four-hour round comparing a
    // build against itself.
    if (_boot.has('shells')) {
      const k = Number(_boot.get('shells'));
      console.log('car shells', JSON.stringify(setShellNames(Number.isFinite(k) ? k : 3)));
    }
    // Constructing the world builds the material registry and facade library.
    // ?kerbs=0 streams the district with no kerb, gutter pan or parking lane, so
    // a before/after capture is ONE build on ONE port with one thing different.
    // The alternative is two trees, which is exactly how two rounds in this
    // project came back with both arms photographing the same commit.
    world = new StreamingWorld(scene, district, {
      nearRadius: 2, farRadius: 5, budgetMs: 3,
      kerbs: _boot.get('kerbs') !== '0',
      // ?frontage=lazy restores the pre-fix behaviour - every building's street
      // elevations computed on first touch, inside a timed chunk slice - so the
      // before/after for that change is one build on one port with one thing
      // different. Default (primed in the constructor) is the shipped path.
      frontage: _boot.get('frontage') === 'lazy' ? 'lazy' : 'primed',
    });
  })
  .add('atmosphere', async () => {
    sky = new Sky(renderer, scene);
    weather = new Weather(scene);
    weather.bindMaterials(world.registry);
  })
  .add('signage', async () => {
    generateSignageLibrary({ streetNames: Object.values(district.streetNames ?? {}) });
    // ?nospill=1 and ?nosoffit=1 build the district WITHOUT issue #45's two
    // terms, so their TRIANGLE cost can be priced from one build on one port --
    // the same reason ?nofrontage=1 exists, and the same four-hour review round
    // it exists to prevent. For the LOOK, use setSpillScale/setSoffitScale
    // instead: those turn each term off with every triangle still in the scene,
    // which is what makes the four measurement arms one page load rather than
    // four.
    const _sq = new URLSearchParams(location.search);
    const { buckets, street, spill, glow, stats } = districtSignageBuffers(district, {
      spill: !_sq.has('nospill'),
      soffit: !_sq.has('nosoffit'),
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
    // Issue #45: the pavement pools and the awning-soffit glow. One mesh each,
    // one draw call each, and neither casts or receives a shadow -- they are not
    // surfaces, they are light lying on one. Two meshes rather than one because
    // the two terms carry independent runtime levels; see soffitMaterial.
    //
    // Neither is culled: its bounding sphere is the whole district, which is
    // fine, because frustum culling 1,428 and 1,360 triangles saves nothing
    // worth a per-bucket mesh set. They are in the transparent queue because
    // depthWrite is off.
    for (const [buf, mat, name] of [[spill, spillMaterial, 'shopSpill'],
      [glow, soffitMaterial, 'shopSoffitGlow']]) {
      if (!buf) continue;
      const pm = meshOf(buf, mat({ time: 'dusk' }));
      if (!pm) continue;
      pm.name = name;
      pm.castShadow = false; pm.receiveShadow = false;
      pm.renderOrder = 1;
      signageRoot.add(pm);
    }
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
  // ?rim=K darkens (or brightens) the traffic/parked alloy at boot, so a capture
  // harness that must not be edited - hero-shots is a gate - can still sweep the
  // one number three rounds have now argued about, from one build on one port.
  // Same mechanism and same argument as ?kerbs=0 and ?nospill=1 above.
  const _rim = Number(new URLSearchParams(location.search).get('rim'));
  if (Number.isFinite(_rim) && _rim > 0) {
    console.log('car rim scale', JSON.stringify(forEachParkedGeometry((g) => setTrafficRimScale(g, _rim))));
    window.__rimScale = _rim;
  }
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

// ------------------------------------------------------------------ missions
//
// The runner is pure state and never touches the game: it emits INTENTS and this
// block is the only place that executes them. See src/mission.js for why - a mission
// layer that calls into the engine cannot be driven offline, and mission code is
// almost entirely branching, which is the code that rots unseen.
const mission = new MissionRunner();
const missionLog = [];
mission.on('stage', (e) => {
  missionLog.push(e.to ? `${e.from} -> ${e.to} (${e.why})` : `${e.from} -> [${e.outcome}] (${e.why})`);
  if (missionLog.length > 24) missionLog.shift();
});
mission.on('intent', (i) => {
  // EVERY INTENT THIS BLOCK CANNOT HONOUR IS RECORDED, not ignored. A mission that
  // declares `stinger: 'chase'` against a host with no audio graph should say so in
  // the audit rather than look like it worked - the same argument wantedReport()'s
  // `notHonoured` makes about setUnitGoal and setSpawnBand.
  if (typeof i.setWanted === 'number') wanted.setStars(i.setWanted, `mission:${i.stage}`);
  if (i.stinger) {
    if (audio && audio.available && audio.stinger) audio.stinger(i.stinger);
    else missionUnhonoured.add(`stinger:${i.stinger}`);
  }
  if (i.hudFlash) missionUnhonoured.add('hudFlash');
});
const missionUnhonoured = new Set();

/**
 * The snapshot the runner reads. Plain numbers only.
 *
 * `health` IS THE CAR'S, and that is a deliberate reading of what the authored missions
 * mean. Every `healthBelow 0.2 -> failed` in src/missions.js sits on a stage the player
 * spends in a car — `ambush`, `drop`, `dropHot` — and what fails those stages is the car
 * being wrecked, not the driver being hurt. There is no player-body damage model, so on
 * foot this reads 1; a mission that wants to fail on the driver's condition will need a
 * second field and a source for it, and should not quietly borrow this one.
 *
 * This field was a hard-coded 1 for the whole of the round that authored those missions,
 * and the comment here said so: "every `healthBelow` trigger in every mission is INERT
 * ... they will start firing the day a damage model feeds this field". This is that day.
 * report().constantFields is the instrument that would say if it stopped varying again.
 */
function missionSnapshot() {
  return {
    px: focusX, pz: focusZ,
    inVehicle: mode === 'car',
    speed: mode === 'car' ? vehicle.speed : 0,
    health: mode === 'car' ? damage.health : 1,
    wantedStars: wanted.stars,
    wantedState: wanted.state,
  };
}
let focusX = 0, focusZ = 0;

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

// --------------------------------------------------------------- collision
/**
 * WALL SEGMENTS FOR EVERYTHING THAT MOVES. One index, built once, 3,950 segments.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT HAD TO GO. `refreshFootColliders` built the
 * axis-aligned BOUNDING BOX of each nearby footprint ring and handed those to
 * player.js. That is cheap and it hangs invisible walls over every notch of every
 * L-shaped building in the district. Measured (tools/blocker-test.mjs gates all
 * three figures): the area inside some footprint's box but outside every polygon is
 * 142,932 m2, 30.9% of all box area; sampling every 2 m along every road centreline,
 * a car-sized circle cannot fit at 64 of 24,517 points with the real segments and
 * 1,806 with the boxes — the boxes block 28 times as much street. 161 of 523
 * buildings carry more than a quarter of their box as nothing at all, and the worst
 * single one is 6,329 m2 of phantom. Anyone walking this district has been colliding
 * with it the whole time.
 */
const blockers = new BlockerIndex(district);

/**
 * Vehicle damage. See src/damage.js: the input is delta-v along the contact normal
 * and the thresholds are the FMVSS 581 bumper standard, the IIHS low-speed series and
 * the NCAP full-frontal barrier.
 */
const damage = new DamageModel();
vehicle.blockers = blockers;
vehicle.damage = damage;

/**
 * The road graph, for routing. Built with the wall index so it refuses the 11 `service` edges
 * whose own centreline a car cannot pass — see src/roadpath.js.
 *
 * Costs 9.3 ms once at load, and a whole-route path is 18.7 ms, so a route is recomputed only
 * when the destination changes or the player has strayed far enough that the old one is no
 * longer a route from where they are.
 */
const roads = new RoadGraph(district, { blockers, carRadius: BODY_RADIUS });
let routeLine = null, routeTo = null, routeFrom = null;
const ROUTE_RESTALE = 60;      // metres of drift before the line is replanned
/**
 * Feed src/hud.js's route line.
 *
 * IT HAS NEVER HAD A SOURCE. `setRoute()` and the cyan Path2D it builds have been in hud.js
 * since it was written, alongside `objective`, `subtitle` and `waypoint` — and the mission
 * round found those three unfed too. This is the last of the four, and it is the one that
 * needed something to exist first: a line to the marker is only useful if it follows the
 * streets, and until src/roadpath.js there was no way to ask for that.
 */
function routeToMarker(wp) {
  if (!wp) { routeLine = null; routeTo = null; return null; }
  const movedTo = !routeTo || Math.hypot(wp.x - routeTo.x, wp.z - routeTo.z) > 2;
  const strayed = !routeFrom || Math.hypot(focusX - routeFrom.x, focusZ - routeFrom.z) > ROUTE_RESTALE;
  if (movedTo || strayed || !routeLine) {
    const p = roads.path(focusX, focusZ, wp.x, wp.z, { spacing: 8, offset: 0, smoothPasses: 1 });
    routeLine = p ? p.points : null;
    routeTo = { x: wp.x, z: wp.z };
    routeFrom = { x: focusX, z: focusZ };
  }
  return routeLine;
}
let damageCrimes = 0, damageIgnored = 0;
/** Carried from the sim substeps to the HUD feed, which runs once per rendered frame. */
let hudHitPending = 0;
/**
 * src/audio.js has no crash voice. Counted rather than silently skipped, for the same
 * reason the mission layer records an unhonoured `stinger` intent instead of ignoring
 * it: a missing sound should appear in the audit, not look like it played.
 */
let audioImpactsWanted = 0;

/**
 * Impacts against things that MOVE: traffic cars, pedestrians, pursuit units.
 *
 * WHY THIS IS HERE AND NOT IN src/vehicle.js. The vehicle owns its body and the static
 * index; it does not know what a traffic car is, and src/traffic.js and
 * src/pedestrians.js are both other owners' files. main.js already owns both
 * lifecycles, so the collection happens here and the arithmetic happens in
 * src/damage.js's dynamicContact(), which is pure and gated offline.
 *
 * ONE CONTACT PER FRAME, THE WORST ONE, for the reason src/vehicle.js gives about its
 * five samples: driving into a queue of stopped traffic touches three cars in one frame
 * and that is one crash, not three.
 *
 * WHAT REACTS AND WHAT STILL DOES NOT. A struck pedestrian is knocked down and thrown
 * (`peds.hit`, thrown the distance accident reconstruction says: 9.5 m at 40 km/h) and a
 * rammed traffic car is displaced off its lane, yawed out of line and stopped for a few
 * seconds (`traffic.hit`). A rammed POLICE car still does not react: src/pursuit.js holds
 * its units as an edge parameter and an instance matrix with no per-unit state to shunt,
 * so `dynStats.policeHits` counts them and nothing moves. Counted rather than hidden.
 *
 * MASSES. 1,400 kg for a car, the same as the player's, which makes a head-on between
 * equals the barrier test. 80 kg for a person. Radii are the collision radius of the
 * other body: 0.95 m for a car, matching BODY_RADIUS, and 0.35 m for a person, which is
 * a shoulder width.
 */
const OTHER_CAR = { bodyRadius: 0.95, bodyMass: 1400 };
const PERSON = { bodyRadius: 0.35, bodyMass: 80 };
const dynStats = { tested: 0, contacts: 0, frames: 0, pedHits: 0, carHits: 0, policeHits: 0,
  pedKnockdowns: 0, pedFatal: 0, carShunts: 0 };
function dynamicImpacts() {
  if (mode !== 'car') return;
  dynStats.frames++;
  const fwd = _dynFwd.set(0, 0, 1).applyQuaternion(vehicle.quaternion);
  const right = _dynRight.set(1, 0, 0).applyQuaternion(vehicle.quaternion);
  const base = {
    carX: vehicle.position.x, carZ: vehicle.position.z,
    fwdX: fwd.x, fwdZ: fwd.z, rightX: right.x, rightZ: right.z,
    carVX: vehicle.velocity.x, carVZ: vehicle.velocity.z,
    carMass: vehicle.mass, samples: BODY_SAMPLES, carRadius: BODY_RADIUS,
    restitution: vehicle.wallRestitution,
  };
  let worst = null, worstKind = null;

  // --- traffic. `_lastPositions` is held for the frame by src/traffic.js precisely so
  // a consumer can classify overlaps; its entries carry x, z, v and yaw.
  const cars = traffic && traffic._lastPositions ? traffic._lastPositions : null;
  if (cars) {
    for (const c of cars) {
      const dx = c.x - base.carX, dz = c.z - base.carZ;
      // One distance test rules out almost every car. BODY_ENCLOSING is the radius of
      // the whole body from its centre, so nothing inside the collider can be missed.
      if (dx * dx + dz * dz > (BODY_ENCLOSING + OTHER_CAR.bodyRadius) ** 2) continue;
      dynStats.tested++;
      // The traffic car's velocity: speed along its own heading. `v` is m/s, `yaw` is
      // only carried for the nearest few cars, so fall back to stationary — which
      // OVERSTATES the closing speed for a car moving away and understates nothing.
      const cy = typeof c.yaw === 'number' ? c.yaw : null;
      const hit = dynamicContact({ ...base, ...OTHER_CAR,
        bodyX: c.x, bodyZ: c.z,
        bodyVX: cy === null ? 0 : Math.sin(cy) * (c.v ?? 0),
        bodyVZ: cy === null ? 0 : Math.cos(cy) * (c.v ?? 0) });
      if (hit && (!worst || hit.dv > worst.dv)) {
        worst = hit; worstKind = IMPACT.vehicle;
        worst.carId = c.id; worst.pedIndex = -1;
      }
    }
  }
  // --- pedestrians.
  const people = peds ? peds.positions() : null;
  if (people) {
    for (const p of people) {
      // A body already on the ground is not a fresh crime and not a fresh knockdown. Without
      // this, driving over a casualty reports `pedestrianKilled` once a second for as long as
      // the car sits on them.
      if (p.down) continue;
      const dx = p.x - base.carX, dz = p.z - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + PERSON.bodyRadius) ** 2) continue;
      dynStats.tested++;
      const hit = dynamicContact({ ...base, ...PERSON, bodyX: p.x, bodyZ: p.z });
      if (hit && (!worst || hit.dv > worst.dv)) {
        worst = hit; worstKind = IMPACT.pedestrian;
        // `p.i` is the crowd slot. positions() used to filter and throw the index away, so this
        // pass could tell that a pedestrian had been struck and not WHICH one.
        worst.pedIndex = p.i; worst.carId = null;
      }
    }
  }
  /**
   * --- pursuit units. Ramming a police car is a different crime and a worse one.
   *
   * READ OUT OF THE INSTANCE MATRIX, and that is deliberate rather than a shortcut.
   * src/pursuit.js's `units` hold `{edge, forward, t, len}` — a position along an edge —
   * and the world position is computed inside its update loop, written straight into
   * `mesh.instanceMatrix`, and never stored. So the matrix IS the only record of where
   * those cars are, and it is also exactly what is on screen, which is the right thing
   * to collide with. A hidden unit is `makeScale(0,0,0)`, whose translation is (0,0,0)
   * and whose scale row is zero, so the scale is what distinguishes it — testing the
   * position alone would collide with every despawned unit at the world origin.
   */
  if (pursuit && pursuit.mesh && pursuit.mesh.visible) {
    const a = pursuit.mesh.instanceMatrix.array;
    for (let i = 0; i < pursuit.count; i++) {
      const o = i * 16;
      if (a[o] === 0 && a[o + 5] === 0 && a[o + 10] === 0) continue;   // hidden
      const ux = a[o + 12], uz = a[o + 14];
      const dx = ux - base.carX, dz = uz - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + OTHER_CAR.bodyRadius) ** 2) continue;
      dynStats.tested++;
      const hit = dynamicContact({ ...base, ...OTHER_CAR, bodyX: ux, bodyZ: uz });
      if (hit && (!worst || hit.dv > worst.dv)) {
        // src/pursuit.js has no per-unit state to shunt — its cars are an edge parameter and an
        // instance matrix — so a rammed police car still does not react. Counted, not hidden.
        worst = hit; worstKind = IMPACT.police;
        worst.carId = null; worst.pedIndex = -1;
      }
    }
  }
  if (!worst) return;
  dynStats.contacts++;
  if (worstKind === IMPACT.pedestrian) dynStats.pedHits++;
  else if (worstKind === IMPACT.police) dynStats.policeHits++;
  else dynStats.carHits++;

  /**
   * THE OTHER PARTY REACTS. This is what the damage round left out and said so: the player's car
   * took the damage, the crime was reported, the player was pushed off — and the traffic car
   * drove on and the pedestrian kept walking. Live-measured at the time: three pedestrian strikes
   * at 60 km/h, health 1 -> 1, two stars, and nothing visibly happened to the people.
   *
   * Both reactions live in their own module (`peds.hit`, `traffic.hit`) because the state belongs
   * to whoever owns the crowd and the fleet; this block only says WHO was hit and HOW HARD. The
   * direction handed over is the player car's own direction of travel, because that is the way a
   * struck body or a shunted car goes.
   */
  const travel = Math.hypot(vehicle.velocity.x, vehicle.velocity.z) || 1;
  const tx = vehicle.velocity.x / travel, tz = vehicle.velocity.z / travel;
  if (worstKind === IMPACT.pedestrian && worst.pedIndex >= 0) {
    const r = peds.hit(worst.pedIndex, { speed: vehicle.speed, dirX: tx, dirZ: tz });
    if (r) { dynStats.pedKnockdowns++; if (r.fatal) dynStats.pedFatal++; }
  } else if (worstKind === IMPACT.vehicle && worst.carId != null) {
    const r = traffic.hit(worst.carId, { dv: worst.dv, dirX: tx, dirZ: tz, kind: 'vehicle' });
    if (r) dynStats.carShunts++;
  }

  // Push the player's car out, and take the impulse. A pedestrian does not push a car
  // around, so the separation is only applied for the car-mass bodies.
  if (worstKind !== IMPACT.pedestrian) {
    vehicle.position.x += worst.nx * worst.depth;
    vehicle.position.z += worst.nz * worst.depth;
    const j = worst.dv * (OTHER_CAR.bodyMass / (vehicle.mass + OTHER_CAR.bodyMass)) * vehicle.mass;
    vehicle.applyImpulseAt(
      _dynImp.set(worst.nx * j, 0, worst.nz * j),
      _dynOff.set(worst.dirX * right.x + worst.dirZ * fwd.x, 0,
        worst.dirX * right.z + worst.dirZ * fwd.z));
  }
  const rec = damage.impact({ dv: worst.dv, kind: worstKind,
    dirX: worst.dirX, dirZ: worst.dirZ, speed: vehicle.speed });
  // A pedestrian is a crime at any speed even though it costs the car nothing, so the
  // crime is taken from the record whether or not the impact was applied to health.
  if (rec.crime) {
    const r = wanted.reportCrime(rec.crime, { at: { x: vehicle.position.x, z: vehicle.position.z } });
    if (r.applied) damageCrimes++; else damageIgnored++;
  }
  if (rec.applied) hudHitPending = Math.max(hudHitPending, rec.severity);
}
const _dynFwd = new THREE.Vector3(), _dynRight = new THREE.Vector3();
const _dynImp = new THREE.Vector3(), _dynOff = new THREE.Vector3();

// The car is a moving obstacle while on foot.
const carCollider = { x: 0, z: 0, y: 0, hx: 1.25, hy: 1.5, hz: 2.4 };
/**
 * The on-foot collider list is now just the CAR. Every building wall reaches
 * src/player.js as a segment index instead, which is why this list no longer has a
 * building loop in it at all: see the BlockerIndex note above for the 142,932 m2 of
 * phantom wall the old bounding boxes hung over this district, and player.js's own
 * comment for what it replaced.
 */
const footColliders = [carCollider];

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
    // And whether a shunted car would be knocked through a shopfront. src/traffic.js fits the
    // offset to what is clear at the publish site; without this hook it does not fit at all,
    // which put 0.8% of worst-case shunts inside a building.
    traffic.clearAt = (x, z, r) => !blockers.resolveCircle(x, z, r);
    // A fleet spawned AFTER boot has to pick up ?rim= too, or a capture with
    // HERO_TRAFFIC set would have swept the parked cars and left the moving ones
    // on the old alloy - two different rims in one frame, which is worse than
    // either and would read as noise.
    if (window.__rimScale) forEachTrafficGeometry((g) => setTrafficRimScale(g, window.__rimScale));
  }
  else if (!on && traffic) {
    // EVERY shell, not just the first. Removing traffic.mesh alone left two
    // invisible InstancedMeshes and two geometries on the GPU, which is the
    // same defect the glow-mesh comment below records - setTraffic(0) has to
    // take away everything setTraffic(n) put there.
    for (const m of (traffic.meshes ?? [traffic.mesh])) scene.remove(m);
    for (const g of (traffic.geometries ?? [traffic.mesh.geometry])) g.dispose();
    if (traffic.material) traffic.material.dispose();
    // The lamp-spill mesh is a SECOND object in the scene and a second geometry
    // on the GPU. Removing only the body mesh left an invisible additive mesh
    // behind that setTraffic(0) was supposed to have taken away - and because it
    // is invisible by day, a harness that switches traffic off at noon would
    // have found nothing wrong until it captured at dusk.
    if (traffic.glow) {
      scene.remove(traffic.glow);
      traffic.glow.geometry.dispose();
      traffic.glow.material.dispose();
    }
    traffic = null;
  }
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
      player.update(dt, input, chase.yaw, world, footColliders, blockers);
    }
    vehicle.stepFixed(dt, world);
    // The damage clock runs on simulated time, like everything else in this loop, so
    // a fire burns at the same rate under ?timeScale as it does at 1.
    damage.update(dt);
    // IMPACTS BECOME CRIMES HERE, and this is the first thing in the project that has
    // ever called reportCrime. src/damage.js classifies the contact — it knows the
    // delta-v and what was hit — and src/wanted.js owns the refractory that stops a
    // bumper grinding along a wall from being a five-star felony, which is the same
    // defect damage.js guards against on the health side with its own.
    if (vehicle.pendingImpact) {
      const hit = vehicle.pendingImpact;
      vehicle.pendingImpact = null;              // consumed once, never twice
      hudHitPending = Math.max(hudHitPending, hit.severity);
      if (hit.crime) {
        const r = wanted.reportCrime(hit.crime, { at: { x: vehicle.position.x, z: vehicle.position.z } });
        if (r.applied) damageCrimes++; else damageIgnored++;
      }
      if (audio && audio.available && audio.stinger && hit.severity >= damage.majorSeverity) {
        audioImpactsWanted++;
      }
    }
    world.update(mode === 'foot' ? player.position : vehicle.position);
    if (traffic) traffic.update(dt, vehicle.position);
    // Peds follow whatever the camera is actually near, not the parked car:
    // on foot the crowd has to be around the player or the pavement is empty
    // exactly where it is most visible.
    if (peds) peds.update(dt, mode === 'foot' ? player.position : vehicle.position);
    // AFTER both have moved, so the positions tested are the ones on screen. Testing
    // before they move measures last frame's crowd against this frame's car, which at
    // 60 km/h is 28 cm of error and, worse, is a different error every frame.
    dynamicImpacts();
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

  // The mission tick. After `focus` is known and before the HUD is fed, so an
  // objective that changes this frame is drawn this frame rather than one late.
  focusX = focus.x; focusZ = focus.z;
  const missionHud = mission.mission ? (mission.update(dt, missionSnapshot()), mission.hud()) : null;
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
      // src/hud.js has carried objective, subtitle, markers and waypoint since it was
      // written and nothing ever fed them. MissionRunner.hud() returns exactly those
      // names, so this is the whole of the presentation wiring.
      //
      // The mission's objective takes the band only while one is running; the enter-
      // vehicle prompt keeps it otherwise, so the two never fight over one line.
      objective: missionHud ? missionHud.objective : null,
      subtitle: missionHud ? missionHud.subtitle : null,
      waypoint: missionHud && missionHud.waypoint ? missionHud.waypoint : null,
      // src/hud.js has drawn a health bar, a damage vignette and a low-health pulse
      // since it was written, against a `health` that was hard-coded to 1 and a
      // `damage` that nothing ever raised. Both now have a source. On foot the bar
      // reads full, for the reason missionSnapshot() gives.
      health: mode === 'car' ? damage.health : 1,
      damage: mode === 'car' ? damage.smoke : 0,
      // The route line, on the streets rather than as the crow flies. See routeToMarker().
      route: routeToMarker(missionHud ? missionHud.waypoint : null),
    });
    // One flash per applied impact, scaled by how much of the car it cost. hud.js
    // decays it at `damageDecay` per second, so this is a hit and not a state.
    if (hudHitPending > 0) { hud2.flashDamage(Math.min(1, 0.25 + hudHitPending * 2)); hudHitPending = 0; }
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

// THE PARKED POOL IS THREE GEOMETRIES NOW, AND A LEVER THAT EDITS ONE IS WORSE
// THAN A LEVER THAT EDITS NONE.
//
// setTrafficRimScale and its siblings rewrite VERTEX COLOURS in place. They were
// written when the pool was one InstancedMesh over one geometry and were called
// as `fn(furniture.parked.mesh.geometry, k)`. With body shells that reaches
// shell 0 alone, so a sweep would repaint a third of the kerb and report a
// number taken over all of it - a confound inside the very A/B that exists to
// isolate. This applies the lever to every shell and returns the SUM of the
// vertices touched, so a caller that expects 100 rim vertices a car and gets a
// THE MOVING FLEET IS THREE GEOMETRIES TOO. Same argument as
// forEachParkedGeometry: these levers rewrite vertex colours in place, and a
// call through traffic.mesh.geometry reaches shell 0 alone - a sweep that
// repaints a third of the fleet and reports over all of it.
function forEachTrafficGeometry(fn) {
  if (!traffic) return null;
  const geos = traffic.geometries ?? [traffic.mesh.geometry];
  // THE LEVERS RETURN A NUMBER, NOT AN OBJECT, and the first cut of this assumed
  // the opposite. setTrafficTyreScale and its siblings `return idx.length`, so
  // `{...each[0]}` spread a number - which is `{}` - and `r.verticesTouched` was
  // undefined, summing to 0. The arm proof duly printed
  // {"shells":3,"verticesTouched":0,"perShell":[null,null,null]} for every one of
  // them: a key that looks like a measurement, reports nothing, and would have
  // hashed three genuinely different tyre arms to the same value in
  // proveArmsDiffer. Handle both shapes rather than assume either.
  const val = (r) => (typeof r === 'number' ? r
    : (r && typeof r.verticesTouched === 'number' ? r.verticesTouched : null));
  const each = geos.map((g) => fn(g));
  const per = each.map(val);
  const total = per.reduce((t, v) => t + (v ?? 0), 0);
  const head = (each[0] && typeof each[0] === 'object') ? each[0] : {};
  return { ...head, shells: geos.length, verticesTouched: total, perShell: per };
}

// third of that finds out.
function forEachParkedGeometry(fn) {
  const p = furniture && furniture.parked;
  if (!p) return null;
  const geos = p.geometries ?? [p.mesh.geometry];
  // THE LEVERS RETURN A NUMBER, NOT AN OBJECT, and the first cut of this assumed
  // the opposite. setTrafficTyreScale and its siblings `return idx.length`, so
  // `{...each[0]}` spread a number - which is `{}` - and `r.verticesTouched` was
  // undefined, summing to 0. The arm proof duly printed
  // {"shells":3,"verticesTouched":0,"perShell":[null,null,null]} for every one of
  // them: a key that looks like a measurement, reports nothing, and would have
  // hashed three genuinely different tyre arms to the same value in
  // proveArmsDiffer. Handle both shapes rather than assume either.
  const val = (r) => (typeof r === 'number' ? r
    : (r && typeof r.verticesTouched === 'number' ? r.verticesTouched : null));
  const each = geos.map((g) => fn(g));
  const per = each.map(val);
  const total = per.reduce((t, v) => t + (v ?? 0), 0);
  const head = (each[0] && typeof each[0] === 'object') ? each[0] : {};
  return { ...head, shells: geos.length, verticesTouched: total, perShell: per };
}

// Freezing has to PUSH the drift as well as pin it, or the uniform keeps whatever
// the last frame wrote until the next refresh and the first frame after the freeze
// is still on the old sky.
function __districtSkyFreeze(atSeconds) {
  // The MODULE-level `sky`, not tod.sky. main.js declares `let ... sky ...` at the
  // top and hands it to the day/night controller with tod.setSky(sky, weather); the
  // controller does not re-expose it under that name, so `tod.sky` is undefined and
  // this whole hook would have returned null while looking like it worked.
  if (!sky) return null;
  const st = sky.freezeCloudDrift(atSeconds);
  sky._dirty = true;
  sky.refresh({ force: true, environment: false, sync: true });
  return { ...st, ...sky.cloudDriftState() };
}

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

  // ----------------------------------------------------------------- missions
  //
  // Named so a harness can start, drive and audit a mission without synthesising key
  // events, the same argument press()/release() make above.
  missions: () => Object.keys(MISSIONS),
  startMission(id) {
    const m = MISSIONS[id];
    if (!m) throw new Error(`no such mission "${id}"; have ${Object.keys(MISSIONS).join(', ')}`);
    missionUnhonoured.clear();
    missionLog.length = 0;
    return mission.start(m);
  },
  abortMission: (reason) => mission.abort(reason ?? 'aborted'),
  missionHud: () => mission.hud(),
  /**
   * The audit. `constantFields` is the part worth reading: a numeric field that never
   * moved is a trigger that could not fire. It listed `health` for the whole of the
   * round that authored these missions, because nothing produced damage; it should not
   * list it any more. `intentsNotHonoured` is the same honesty on the other side - an
   * intent this host cannot execute is listed rather than dropped.
   */
  missionReport: () => ({
    ...mission.report(),
    title: mission.mission ? mission.mission.title : null,
    log: missionLog.slice(),
    intentsNotHonoured: [...missionUnhonoured].sort(),
    snapshot: missionSnapshot(),
  }),

  // ------------------------------------------------------------------ damage
  //
  // The whole collision and damage layer, for a harness and for a reviewer driving the
  // page by hand. `crash()` is the one that matters: it is how you see a crash without
  // needing to steer into a building in a headless browser at under one frame a second.
  damage, blockers,
  damageReport: () => ({
    ...damage.report(),
    contacts: vehicle.contacts,
    lastContact: vehicle.lastContact,
    crimesReported: damageCrimes,
    crimesIgnored: damageIgnored,
    /** src/audio.js has no crash voice; this counts the ones it would have played. */
    impactSoundsWanted: audioImpactsWanted,
    index: blockers.report(),
    /**
     * Moving-body contacts, and what each one did. `pedKnockdowns`/`pedFatal` and `carShunts`
     * are reactions that actually happened; `policeHits` is the one kind that still has no
     * reaction, because src/pursuit.js has no per-unit state to shunt.
     */
    dynamic: { ...dynStats },
    crowd: peds ? { knockdowns: peds.stats.knockdowns, fatal: peds.stats.knockdownsFatal,
      recoveries: peds.stats.recoveries, worstSpeed: peds.stats.worstKnockdownSpeed } : null,
    fleet: traffic ? { shunts: traffic.stats.shunts, recoveries: traffic.stats.shuntRecoveries,
      stoppedFrames: traffic.stats.shuntStoppedFrames, worstDv: traffic.stats.worstShuntDv } : null,
  }),
  repairCar: () => { damage.repair(); vehicle.contacts = 0; vehicle.pendingImpact = null; return damage.report(); },
  /**
   * Turn body collision off, or back on.
   *
   * WHY THIS EXISTS, because a switch that disables a feature needs a better reason than
   * convenience. tools/drive-through.mjs — the budget gate — drives the district on an
   * autopilot that steers in a STRAIGHT LINE at route waypoints 75 to 512 m apart, and
   * 829 m of that 2,528 m course is inside a building: 32.8% of it. That was harmless
   * until this round. With walls solid the gate's car is wrecked 10.6 s in and the drive's
   * own stuck-nudge teleports it round the rest of the route, so the gate would be
   * sampling triangles over a completely different set of resident chunks than every
   * committed baseline it is compared against — and the triangle p95 is already a standing
   * unresolved WARN. Changing what a gate measures while trying to explain its reading is
   * how a round loses four hours.
   *
   * So the gate turns collision off and SAYS SO in its output. src/roadpath.js is the
   * actual fix — a course on the road graph, 0 of 851 points blocked even for the car body
   * — and it is not the gate's default yet because making it so needs a fresh baseline.
   */
  setBodyCollision(on) {
    vehicle.blockers = on ? blockers : null;
    return !!vehicle.blockers;
  },
  bodyCollision: () => !!vehicle.blockers,
  /**
   * Charge a synthetic impact, bypassing the geometry. Used to exercise the fail paths
   * and the HUD without driving: a headless page renders under one frame a second, so
   * crashing a car into a building on purpose costs minutes.
   *
   *   __district.crash(50)              50 km/h square-on into the front
   *   __district.crash(30, 'left')      30 km/h into the near side
   */
  crash(speedKmh = 40, where = 'front') {
    const dirs = { front: [0, 1], rear: [0, -1], left: [-1, 0], right: [1, 0],
      frontLeft: [-0.95, 2.15], frontRight: [0.95, 2.15] };
    const d = dirs[where] ?? dirs.front;
    const rec = damage.impact({ dv: (speedKmh / 3.6) * 1.15, kind: IMPACT.wall,
      dirX: d[0], dirZ: d[1], speed: speedKmh / 3.6 });
    if (rec.applied) vehicle.pendingImpact = rec;
    return rec;
  },
  /**
   * Knock down the nearest pedestrian, or shunt the nearest traffic car, at a given impact
   * speed. For the same reason __district.crash() exists: a headless page renders under one
   * frame a second, so hitting a specific pedestrian on purpose by driving costs minutes.
   */
  knockNearestPed(speedKmh = 40) {
    if (!peds) return null;
    let best = null, bestD = Infinity;
    for (const p of peds.positions()) {
      if (p.down) continue;
      const d = Math.hypot(p.x - focusX, p.z - focusZ);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return null;
    const fwd = _dynFwd.set(0, 0, 1).applyQuaternion(vehicle.quaternion);
    const r = peds.hit(best.i, { speed: speedKmh / 3.6, dirX: fwd.x, dirZ: fwd.z });
    // The direction is returned because a probe cannot check which way a body went over
    // without it, and which way it goes over is the whole kinematics of the thing.
    return r ? { ...r, distance: +bestD.toFixed(2), dirX: fwd.x, dirZ: fwd.z } : null;
  },
  shuntNearestCar(dv = 8) {
    if (!traffic || !traffic._lastPositions) return null;
    let best = null, bestD = Infinity;
    for (const c of traffic._lastPositions) {
      const d = Math.hypot(c.x - focusX, c.z - focusZ);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) return null;
    const fwd = _dynFwd.set(0, 0, 1).applyQuaternion(vehicle.quaternion);
    const r = traffic.hit(best.id, { dv, dirX: fwd.x, dirZ: fwd.z });
    return r ? { ...r, distance: +bestD.toFixed(2) } : null;
  },

  /** Is a circle of radius r at (x,z) clear of every building wall? */
  clearAt: (x, z, r = 0.95) => !blockers.resolveCircle(x, z, r),

  // -------------------------------------------------------------------- roads
  // The road graph and a route on it, so a harness can ask for a driveable course rather
  // than steering at a waypoint in a straight line — which, on this district, spends 32.8%
  // of its length inside a building.
  roads, followPath,
  routeTo: (x, z, opts) => roads.path(focusX, focusZ, x, z, { spacing: 8, offset: 0, ...opts }),
  routeLine: () => routeLine,
  tourRoute: (opts) => roads.tour(district.meta.route.slice(1), { spacing: 4, offset: 3, ...opts }),

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
  // Issue #45's A/B and its level sweep, in one session rather than one build
  // per candidate. 0 on both is the before arm with the geometry left in place,
  // and the two are separate so each term can be isolated on its own.
  setSpillScale: (k) => { setSpillScale(k); return spillScaleOf(); },
  // The car lamp spill's own A/B, and the same argument as the line above: 0 is
  // the arm round 3 replaces, 1 is the arm it ships, and BOTH ARMS COME OFF ONE
  // PAGE LOAD. Two builds on two trees is how this project has twice compared a
  // build against itself. Returns what was actually reached so a harness can
  // assert the arm it thinks it is photographing rather than trusting its own
  // call - tools/car-spill.mjs does assert it.
  // Traffic/parked ALLOY brightness, as one scalar over both fleets. 1 is the
  // build this lever was added to. See setTrafficRimScale for the measurement
  // that made it necessary: the rim has been tuned twice against a ratio whose
  // denominator is sunlit road. ?rim=K applies it at boot so a capture harness
  // that must not be modified (tools/hero-shots.mjs is a gate) can still sweep
  // it - the same mechanism as ?kerbs=0 and ?nospill=1.
  setCarRim: (k) => {
    const n = { traffic: 0, parked: 0 };
    n.traffic = forEachTrafficGeometry((g) => setTrafficRimScale(g, k));
    n.parked = forEachParkedGeometry((g) => setTrafficRimScale(g, k));
    return { scale: k, verticesTouched: n };
  },
  // The round-5 tyre lever, same mechanism and same argument as setCarRim: the
  // wheel has been tuned four times and the denominator of the one metric still
  // outside its band has never had a knob. verticesTouched is returned because a
  // lever that reaches nothing is how a round concludes "this does not work".
  setCarTyre: (k) => {
    const n = { traffic: 0, parked: 0 };
    n.traffic = forEachTrafficGeometry((g) => setTrafficTyreScale(g, k));
    n.parked = forEachParkedGeometry((g) => setTrafficTyreScale(g, k));
    return { scale: k, verticesTouched: n };
  },
  // The round-5 FRONT reflector level, independent of the rear one. 0 is
  // round 4 exactly - a zero headlight texel in the retro palette - so a sweep
  // that includes 0 carries its own before-arm off the same page load.
  // The hub-centre lever. One vertex a wheel, four a car; verticesTouched is
  // the assertion that it found them, since a lever that reaches nothing looks
  // exactly like a lever that does nothing.
  setCarHub: (k) => {
    const n = { traffic: 0, parked: 0 };
    n.traffic = forEachTrafficGeometry((g) => setTrafficHubScale(g, k));
    n.parked = forEachParkedGeometry((g) => setTrafficHubScale(g, k));
    return { scale: k, verticesTouched: n };
  },
  // The headlamp's ALBEDO, the third front-lens term.
  setCarLampAlbedo: (k) => {
    const n = { traffic: 0, parked: 0 };
    n.traffic = forEachTrafficGeometry((g) => setTrafficLampAlbedo(g, k));
    n.parked = forEachParkedGeometry((g) => setTrafficLampAlbedo(g, k));
    return { scale: k, verticesTouched: n };
  },
  // THE GLAZING'S ALBEDO, which is the axis the metalness knob could not separate.
  // Both pools, every shell. verticesTouched is the assertion that it found the
  // glass: a lever that reaches nothing is how a round concludes a term does not
  // matter, and this one was mis-concluded once already in the other direction.
  setCarGlassAlbedo: (k) => {
    const n = { traffic: 0, parked: 0 };
    n.traffic = forEachTrafficGeometry((g) => setGlassAlbedo(g, k));
    n.parked = forEachParkedGeometry((g) => setGlassAlbedo(g, k));
    return { scale: k, verticesTouched: n };
  },
  // HOW MUCH HARDER THE GLASS ANSWERS THE ENVIRONMENT than the paint beside it.
  // One uniform, shared by every car material, gated per slot by the pack
  // texture's alpha - so it reaches the glazing and nothing else. 0 is the build.
  //
  // This is the lever the albedo sweep proved was needed: no albedo setting moved
  // the pane's modulation off 1.14, which is the number that says whether anything
  // is REFLECTED in the window. A level knob cannot add content; a stronger
  // environment term can.
  // FREEZE THE CLOUD DECK, for any harness that shoots more than one arm.
  //
  // sky.js advected the cloud deck off performance.now() with a comment saying "a
  // capture taken 20 s later than another is still the same sky" - true arithmetic,
  // and the harness is not 20 s. Headless capture is minutes per frame, and all
  // three blind reviewers in the closing car round independently reported the sky as
  // a large fraction of the pair (36.9% of the noon difference energy, 79.9% of the
  // night, 56.5% of the off-car noon energy) with none of them able to tell from the
  // PNGs whether it was a second shipped term or a moving cloud field.
  //
  // It is the clouds, and a scrambled capture order proved it: mean sky |d| correlates
  // r = 0.9674 with how far apart two arms were CAPTURED and r = 0.0295 with how far
  // apart their gain values were.
  freezeClouds: (atSeconds = null) => __districtSkyFreeze(atSeconds),
  unfreezeClouds: () => (sky ? sky.unfreezeCloudDrift() : null),
  cloudDrift: () => (sky ? sky.cloudDriftState() : null),
  setCarGlassEnv: (k) => setGlassEnv(k),
  carGlassEnv: () => glassEnv(),
  setCarFrontLens: (k) => {
    const st = setFrontLensScale(k);
    // The texture is shared by the pool's material; the emissive SCALAR has not
    // moved, so nothing else has to be pushed. Read the pool's own level back
    // anyway, so the arm is asserted against the app rather than against the call.
    return { ...st, parkedEmissive: furniture && furniture.parked
      ? +furniture.parked.material.emissive.r.toFixed(2) : null };
  },
  carFrontLens: () => ({ scale: frontLensScale(), linearLuma: +frontLensLuma().toFixed(5) }),
  // The headlamp's SURFACE, independent of the emissive floor above: one is a
  // mirror that tracks the sky and the other a level that does not.
  setCarLensFinish: (r, m) => setLensFinish(r, m),
  carLensFinish: () => lensFinish(),
  // The round-4 lens/reflector arm at RUNTIME, so a harness can shoot both arms
  // from one page load with the fleet frozen where it stands. Returns what was
  // actually reached, so a tool asserts the arm it photographed rather than
  // trusting its own call - tools/car-spill.mjs makes the same point.
  setCarLens: (k) => {
    const st = setCarLensArm(k);
    // The parked pool caches its emissive against the camera stop, so the level
    // has to be pushed rather than waited for: its rAF only re-applies when the
    // EXPOSURE changes, and switching arms does not change the exposure.
    if (furniture && furniture._applyEmissive) furniture._applyEmissive();
    return { ...st, parkedEmissive: furniture && furniture.parked
      ? +furniture.parked.material.emissive.r.toFixed(2) : null };
  },
  carLens: () => carLensArm(),
  // THE LENS PROFILE, separately from the level. Two different ways to stop a
  // parked reflector reading as a lamp, and they are not the same change: the
  // level scales the whole lens, and the profile moves light OUT OF THE CORE and
  // into the rim without changing how much of it there is. A round that only has
  // the level has to trade the chromatic step against the saturated core; with
  // the profile it can hold the step and drop the peak. `on` false is arm 0's
  // identically-flat lens, kept so a sweep can bracket both ends.
  setCarLensProfile: (edge, pow, gain) => {
    const st = setLensProfile(true, edge, pow, gain);
    if (furniture && furniture._applyEmissive) furniture._applyEmissive();
    return st;
  },
  carLensProfile: () => lensProfile(),
  // The GLAZING's finish, separately from the headlamp's. Four bytes on the
  // shared 16x1 pack texture, so a sweep is a write and a needsUpdate - no
  // rebuild, no second port, no second tree, and every arm off one page load.
  setCarGlass: (rough, metal) => setGlassFinish(rough, metal),
  carGlass: () => glassFinish(),
  setCarSpill: (k) => {
    const player = carMesh.setSpillScale ? carMesh.setSpillScale(k) : null;
    const fleet = traffic && traffic.setSpillScale ? traffic.setSpillScale(k) : null;
    return { player, fleet,
      playerVisible: !!(carMesh.glowMesh && carMesh.glowMesh.visible),
      fleetVisible: !!(traffic && traffic.glow && traffic.glow.visible),
      fleetSlots: traffic ? traffic.glow.count : 0 };
  },
  setSoffitScale: (k) => { setSoffitScale(k); return spillScaleOf(); },
  spillScale: () => spillScaleOf(),
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
  // WHERE THE MOVING CARS ARE, so an audit can say how many of them are in the
  // picture rather than how many are alive. hero-shots has been asking for this
  // hook since the fleet round and getting `undefined`, so its trafficInFrustum
  // column has read null in every artifact - and "30 cars" was quoted as though
  // it were 30 cars in frame. It was 30 alive across the whole district; the
  // frame held none inside the 110 m glow radius.
  //
  // traffic.js already retains the array (this._lastPositions, written at the end
  // of every update), so this costs nothing and invents nothing: it is the same
  // objects the overlap test and the glow ranking read, in world space.
  trafficPositions: () => (traffic && traffic._lastPositions ? traffic._lastPositions : []),
  // WHICH SHELL SET THE POOLS ACTUALLY BUILT WITH. Returned so a capture asserts
  // the arm it photographed rather than trusting its own query string - the same
  // argument setCarLens's note makes, and the reason ?shells= is checkable at all.
  carShells: () => ({ shells: shellNames().length, names: shellNames().slice() }),
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
