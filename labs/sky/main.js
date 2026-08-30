// Sky + weather lab. The point of this page is not to look at a sky in
// isolation: it is to prove that the dome, the aerial perspective and the rain
// survive the REAL pipeline — TimeOfDay's photometric presets, PostStack's
// linear-HDR composite and its 1/78000 … 1/2.2 camera stops. A dome that emits
// an sRGB colour looks fine on its own and is black behind that pipeline, so the
// lab wires the production classes rather than a stand-in.
//
// The ground plane and boxes exist for depth: aerial perspective is only
// legible against something that recedes, and the razor-sharp world edge the
// Phase 1 critic measured is exactly what a bare horizon hides.

import * as THREE from '../../vendor/three.module.min.js';
import { TimeOfDay } from '../../src/daynight.js';
import { PostStack } from '../../src/post.js';
import { Sky, PLAUSIBLE_SKY } from '../../src/sky.js';
import { Weather, WEATHER_STATES, wetSurfaceParams } from '../../src/weather.js';

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
const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.4, 1800);

// ---------------------------------------------------------------- reference set
// One material per surface class, shared by every instance of it — the same rule
// the district runs under, so the draw-call count on screen is the real one.
const MAT = {
  ground: new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 0.92, metalness: 0.0 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x8d8a83, roughness: 0.85, metalness: 0.0 }),
  painted: new THREE.MeshStandardMaterial({ color: 0x2e4c63, roughness: 0.55, metalness: 0.05 }),
  metalChrome: new THREE.MeshStandardMaterial({ color: 0xd8dce0, roughness: 0.12, metalness: 1.0 }),
};
// bindMaterials keys off material.name, exactly as it will in the district.
MAT.ground.name = 'ground';
MAT.concrete.name = 'building';
MAT.painted.name = 'metalPainted';
MAT.metalChrome.name = 'metalGalvanised';

// The plane has to reach PAST the far plane. At 3 km across its edge sits at
// 1.5 km, inside the 1.8 km far plane, and shows up as a bright arc where fully
// fogged ground meets fully fogged sky at slightly different height terms.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), MAT.ground);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Everything below is laid out down local -Z and then swung so the avenue runs
// along the dusk sun's azimuth: aerial perspective is only worth looking at when
// the thing receding and the thing lighting it are in the same frame.
const SUN_AZIMUTH = 2.72;                       // daynight.js PRESETS.dusk
// Camera yaw whose forward vector, -(sin yaw, 0, cos yaw), is the sun's
// horizontal direction (cos az, 0, sin az).
const VIEW_YAW = Math.atan2(-Math.cos(SUN_AZIMUTH), -Math.sin(SUN_AZIMUTH));
const avenue = new THREE.Group();
avenue.rotation.y = VIEW_YAW;
scene.add(avenue);

// Two instanced fields of boxes marching to the far plane. Heights and spacing
// grow with distance so the row at 900 m still subtends something.
function boxField(material, count, place) {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, count);
  m.castShadow = true;
  m.receiveShadow = true;
  const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    place(i, p, s);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399) % Math.PI);
    m.setMatrixAt(i, mtx.compose(p, q, s));
  }
  m.instanceMatrix.needsUpdate = true;
  m.frustumCulled = false;
  return m;
}

// A rough deterministic hash: the lab must look the same in every screenshot.
const rnd = (() => { let a = 20260830; return () => ((a = Math.imul(a ^ (a >>> 15), 2246822507)) >>> 0) / 4294967296; })();

// Blocks in two ranks either side of a clear corridor, marching to 1.4 km. The
// depth cue that matters is the SAME object at many distances, so width and
// height are drawn from one distribution at every range.
const ROWS = 34, PER_ROW = 4;
const blocks = boxField(MAT.concrete, ROWS * PER_ROW, (i, p, s) => {
  const row = Math.floor(i / PER_ROW), col = i % PER_ROW;
  const z = -26 - Math.pow(row / (ROWS - 1), 1.85) * 1380;
  const side = col < PER_ROW / 2 ? -1 : 1;
  const rank = col % (PER_ROW / 2);
  const w = 8 + rnd() * 14, d = 9 + rnd() * 16;
  const h = 7 + rnd() * rnd() * 52;
  p.set(side * (13 + rank * 22 + rnd() * 6), h / 2, z + (rnd() - 0.5) * 14);
  s.set(w, h, d);
});
avenue.add(blocks);

// Kerbside clutter, low and close, so the rain has something to sit against and
// the near field has a scale reference the eye already knows.
const posts = boxField(MAT.painted, 56, (i, p, s) => {
  const side = i % 2 ? 1 : -1;
  const z = -8 - Math.pow(i / 56, 1.6) * 260;
  p.set(side * (8.5 + rnd() * 0.6), 1.5, z);
  s.set(0.22, 3.0, 0.22);
});
avenue.add(posts);

// Chrome spheres: the only honest test of the PMREM environment map. If the sky
// is not in the IBL these are flat grey; if the IBL is an sRGB colour they are
// black at a 1/78000 stop.
const spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 16), MAT.metalChrome, 3);
{
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
  const at = [[-5.0, 1.7, -13, 1.7], [5.4, 1.25, -19, 1.25], [-1.6, 2.2, -34, 2.2]];
  at.forEach(([x, y, z, r], i) => {
    mtx.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(r, r, r));
    spheres.setMatrixAt(i, mtx);
  });
  spheres.instanceMatrix.needsUpdate = true;
  spheres.castShadow = true;
  spheres.frustumCulled = false;
}
avenue.add(spheres);

// ------------------------------------------------------------------- systems
const t0 = performance.now();
const sky = new Sky(renderer, scene);
const skyMs = performance.now() - t0;

const t1 = performance.now();
const weather = new Weather(scene, { sky, groundY: 0.01 });
const weatherMs = performance.now() - t1;

const tod = new TimeOfDay(scene, renderer);
let post = null;
try {
  post = new PostStack(renderer, scene, camera);
  tod.attachPost(post);
} catch (err) {
  errors.push('PostStack unavailable: ' + err.message);
}
// setSky() is daynight.js's own hook: it stops the flat background override and
// hands the dome the time of day, the env map and the fog terms on every apply().
tod.setSky(sky, weather);
weather.bindMaterials(MAT);

// One measured regeneration, after everything is warm, for the report.
const refreshFullMs = sky.refresh({ force: true, environment: true, sync: true });
const refreshLutMs = sky.refresh({ force: true, environment: false, sync: false });

// ---------------------------------------------------------------------- camera
// Two framings. Street is the one that matters — eye height is where the razor
// horizon used to be — and elevated shows the haze stratifying over the blocks.
const SHOTS = {
  street:   { eye: [0, 1.75, 14], pitch: 0.055 },
  elevated: { eye: [0, 46, 90],   pitch: -0.10 },
};
let shotName = 'street';
let yaw = VIEW_YAW, pitch = SHOTS.street.pitch, dist = 1;
const eye = new THREE.Vector3();
function setShot(name) {
  shotName = name;
  const sh = SHOTS[name] ?? SHOTS.street;
  eye.set(...sh.eye).applyAxisAngle(new THREE.Vector3(0, 1, 0), VIEW_YAW);
  eye.y = sh.eye[1];
  pitch = sh.pitch;
  yaw = VIEW_YAW;
}
function applyCamera() {
  camera.position.copy(eye).multiplyScalar(dist);
  camera.position.y = eye.y * (shotName === 'street' ? 1 : dist);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
}
setShot('street');

let drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; });
window.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  yaw -= (e.clientX - drag[0]) * 0.004;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - drag[1]) * 0.003, -0.5, 1.2);
  drag = [e.clientX, e.clientY];
});
canvas.addEventListener('wheel', (e) => {
  dist = THREE.MathUtils.clamp(dist + Math.sign(e.deltaY) * 0.12, 0.2, 3);
  e.preventDefault();
}, { passive: false });

// ------------------------------------------------------------------- controls
let timeName = 'dusk';
let weatherName = 'clear';
let snap = false;

function setTime(name) {
  timeName = name;
  tod.apply(name);            // this calls into sky.setTimeOfDay + refresh + applyToPost
}
function setWeather(name) {
  weatherName = name;
  weather.set(name, snap ? { immediate: true } : { seconds: 6 });
}
window.addEventListener('keydown', (e) => {
  if (e.key === '1') setTime('noon');
  if (e.key === '2') setTime('dusk');
  if (e.key === '3') setTime('night');
  if (e.key === 'q') setWeather('clear');
  if (e.key === 'w') setWeather('lightRain');
  if (e.key === 'e') setWeather('heavyRain');
  if (e.key === '4') setShot('street');
  if (e.key === '5') setShot('elevated');
  if (e.key === '0') { snap = !snap; }
});

// ------------------------------------------------------------------ reporting
// Draw calls are read from PostStack.stats.sceneCalls, not renderer.info: after
// the composite blit renderer.info describes a 1-triangle fullscreen pass.
let sceneCalls = 0, sceneTris = 0, worstFrameMs = 0, frames = 0;

function stats() {
  return {
    drawCalls: sceneCalls,
    triangles: sceneTris,
    skyDrawCalls: 1,
    weatherDrawCalls: weather.report().drawCalls,
    postPasses: post ? post.stats.passes : 0,
    generationMs: { sky: +skyMs.toFixed(1), weather: +weatherMs.toFixed(1),
                    total: +(skyMs + weatherMs).toFixed(1) },
    refreshMs: { fullWithEnvSync: +refreshFullMs.toFixed(2), lutOnlyAsync: +refreshLutMs.toFixed(2) },
    worstFrameMs: +worstFrameMs.toFixed(2),
    frames,
    time: timeName, weather: weatherName, shot: shotName,
    sky: sky.audit(),
    weatherReport: weather.report(),
    wetSurface: wetSurfaceParams(weather.wetness),
    tod: tod.audit(),
    errors,
  };
}

function updateHud() {
  const s = stats();
  const a = s.sky, w = s.weatherReport;
  const env = PLAUSIBLE_SKY[timeName];
  const f = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(3));
  const bad = [...a.implausible, ...s.tod.implausible];
  hud.textContent =
`SKY + WEATHER LAB          ${timeName} / ${weatherName} / ${shotName}
generation      sky ${s.generationMs.sky} ms   weather ${s.generationMs.weather} ms
regeneration    ${s.refreshMs.fullWithEnvSync} ms full + PMREM   ${s.refreshMs.lutOnlyAsync} ms LUT only
draw calls      ${s.drawCalls}  (sky 1 · rain ${s.weatherDrawCalls} · post ${s.postPasses})   tris ${s.triangles.toLocaleString()}
exposure        1/${Math.round(1 / s.tod.exposure)}          worst frame ${s.worstFrameMs} ms

zenith          ${f(a.zenithNits)} nits      plausible ${env.zenithNits.join('–')}
horizon         ${f(a.horizonNits)} nits      plausible ${env.horizonNits.join('–')}
sky illuminance ${f(a.skyLux)} lux       plausible ${env.skyLux.join('–')}
sun (direct)    ${f(a.sunLux)} lux       daynight ${s.tod.sunLux} lux
fog colour      ${a.fogColorNits.map(f).join('  ')} nits
inscatter       ${a.fogInscatterNits.map(f).join('  ')} nits
fog density     ${a.fogDensity}/m  (${a.artisticMultiplier}× physical)  falloff ${a.fogHeightFalloff}

rain            ${(w.rainIntensity * 100).toFixed(0)}%  ${w.liveDrops.toLocaleString()} drops · ${w.liveSplashes} splashes
wetness         ${w.wetness.toFixed(2)}  →  roughness ×${s.wetSurface.roughnessScale.toFixed(2)}  albedo ×${s.wetSurface.albedoScale.toFixed(2)}
overcast        ${w.overcast.toFixed(2)}   turbidity ${w.turbidity}   fog boost ${w.fogBoost.toFixed(2)}
${bad.length ? 'IMPLAUSIBLE     ' + bad.join('\n                ') : 'plausibility    all inside envelope'}${errors.length ? '\nERRORS          ' + errors.join('\n') : ''}`;
}

// --------------------------------------------------------------------- frame
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (post) post.setSize(w, h);
  applyCamera();
}
window.addEventListener('resize', resize);

let last = performance.now();
let hudTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  // rAF hands back the timestamp of the frame it is servicing, which on the very
  // first call predates the module-scope `last` and yields a NEGATIVE dt — enough
  // to drive the weather transition parameter below zero and leave the machine
  // permanently "in transition".
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  const tick = performance.now();

  applyCamera();
  tod.follow(camera.position);
  weather.update(dt, camera);
  // daynight.js owns wetness and the fog boost as far as its own audit is
  // concerned; the sky owns the fog colour and density. Both are pushed every
  // frame on purpose — it is the ordering that used to be wrong, not the values.
  tod.setWeather({ wetness: weather.wetness, fogBoost: weather.current.fogBoost });
  sky.update(camera);

  if (post) {
    try { post.render(); } catch (err) { errors.push('post.render: ' + err.message); post = null; }
  } else {
    renderer.render(scene, camera);
  }
  if (post) { sceneCalls = post.stats.sceneCalls; sceneTris = post.stats.sceneTriangles; }
  else { sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles; }

  const ms = performance.now() - tick;
  frames++;
  if (frames > 4) worstFrameMs = Math.max(worstFrameMs, ms);   // skip shader compiles
  hudTimer += dt;
  if (hudTimer > 0.25) { hudTimer = 0; updateHud(); }
}

resize();
setTime('dusk');
weather.set('clear', { immediate: true });
updateHud();
document.getElementById('load').remove();
requestAnimationFrame(frame);

window.__lab = {
  ready: true, stats, setTime, setWeather, setShot,
  snapWeather(name) { snap = true; setWeather(name); snap = false; },
  look(y, p) { yaw = y; pitch = p; },
  resetWorst() { worstFrameMs = 0; frames = 0; },
  renderer, scene, camera, tod, post, sky, weather, THREE,
  states: WEATHER_STATES,
};
