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
  metalChrome: new THREE.MeshStandardMaterial({ color: 0xd8dce0, roughness: 0.14, metalness: 1.0 }),
};
// bindMaterials keys off material.name, exactly as it will in the district.
MAT.ground.name = 'ground';
MAT.concrete.name = 'building';
MAT.painted.name = 'metalPainted';
// 'glass*' is zero in weather.js's SURFACE_WETTING: a mirror probe has no
// microstructure for water to fill, and darkening it would corrupt the readout.
MAT.metalChrome.name = 'glassProbe';

// The one shader patch in this lab, and worth the space it takes to explain.
//
// three's GGX peak is D = 1/(pi * roughness^4). A metal at roughness 0.14 under
// the noon preset's 100,000 lux sun reaches ~4e7 nits. The HDR target is
// half-float, ceiling 65,504, so the highlight lands as Inf and then NaN — and
// post.js's bloom is a 9-tap gaussian run four times at half resolution, which
// turns ONE NaN texel into a 52-pixel BLACK SQUARE in the final frame. Measured
// here before this clamp: 1 Inf and 761 NaN texels at noon, three black squares
// on screen; after it, zero.
//
// The clamp belongs in post.js's bright pass, where it would cover every metal,
// wet road and headlight in the district instead of three spheres in a lab. It
// is here because that file has another owner.
MAT.metalChrome.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    '#include <opaque_fragment>\n  gl_FragColor.rgb = clamp(gl_FragColor.rgb, vec3(0.0), vec3(6.0e4));');
};

// The plane has to reach PAST the far plane. At 3 km across its edge sits at
// 1.5 km, inside the 1.8 km far plane, and shows up as a bright arc where fully
// fogged ground meets fully fogged sky at slightly different height terms.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), MAT.ground);
ground.name = 'ground';
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Everything below is laid out down local -Z, and the whole group swings to the
// current preset's azimuth whenever the time of day changes. Aerial perspective
// is only worth looking at when the thing receding and the thing lighting it are
// in the same frame, and swinging the set rather than the sun keeps the three
// times of day framed identically so they can be compared.
const avenue = new THREE.Group();
scene.add(avenue);

// Camera yaw whose forward vector, -(sin yaw, 0, cos yaw), is the sun's
// horizontal direction (cos az, 0, sin az). Offset off the azimuth itself,
// because dead-on the pow(dot, 6) inscatter lobe in post.js fills the frame and
// everything nearer than 200 m blows out — true of looking into a sunset, and
// useless for judging anything else.
let viewYaw = 0;
function orient(azimuth) {
  viewYaw = Math.atan2(-Math.cos(azimuth), -Math.sin(azimuth)) + 0.40;
  avenue.rotation.y = viewYaw;
  setShot(shotName);
}

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
blocks.name = 'blocks';
avenue.add(blocks);

// Kerbside clutter, low and close, so the rain has something to sit against and
// the near field has a scale reference the eye already knows.
const posts = boxField(MAT.painted, 56, (i, p, s) => {
  const side = i % 2 ? 1 : -1;
  const z = -8 - Math.pow(i / 56, 1.6) * 260;
  p.set(side * (8.5 + rnd() * 0.6), 1.5, z);
  s.set(0.22, 3.0, 0.22);
});
posts.name = 'posts';
avenue.add(posts);

// Chrome spheres: the only honest test of the PMREM environment map. If the sky
// is not in the IBL these are flat grey; if the IBL is an sRGB colour they are
// black at a 1/78000 stop.
//
const spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 16), MAT.metalChrome, 3);
{
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion();
  const at = [[-5.0, 1.7, -13, 1.7], [5.4, 1.25, -19, 1.25], [-1.6, 2.2, -34, 2.2]];
  at.forEach(([x, y, z, r], i) => {
    mtx.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(r, r, r));
    spheres.setMatrixAt(i, mtx);
  });
  spheres.instanceMatrix.needsUpdate = true;
  // No shadow caster. At dusk daynight.js puts the sun 3 degrees up and its
  // ortho shadow camera therefore looks almost horizontally at a horizontal
  // ground plane; a small round caster on that plane lands as a hard black
  // rectangle of shadow acne. Shadows are not this lab's subject.
  spheres.castShadow = false;
  spheres.frustumCulled = false;

}
spheres.name = 'spheres';
avenue.add(spheres);

// Street lamps. Without local light a night frame has nothing to be dark
// against, and the aerial perspective is then the only thing on screen — which
// says more about the fog than about the sky. Candela, per daynight.js, which
// switches them with the preset and audits them against PLAUSIBLE.lampCandela.
const LAMP_CANDELA = 700;      // low end of daynight.js PLAUSIBLE.lampCandela
const lamps = [];
for (let i = 0; i < 4; i++) {
  const side = i % 2 ? 1 : -1;
  const z = -26 - Math.floor(i / 2) * 44;
  const light = new THREE.PointLight(0xffd6a0, LAMP_CANDELA, 40, 2);
  light.position.set(side * 6.4, 6.2, z);
  avenue.add(light);
  lamps.push(light);
}

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
// ---------------------------------------------------------------- output encode
// post.js's composite is a RawShaderMaterial, so three appends no
// <colorspace_fragment> to it, and renderer.outputColorSpace only drives that
// chunk. The pass therefore writes LINEAR values into an 8-bit buffer the
// browser reads as sRGB, and every frame the project renders through PostStack
// comes out roughly a 2.2 gamma too dark. Measured here at noon: a ground pixel
// carrying 4,192 nits should encode to sRGB 63 and lands at 18.
//
// This lab patches the missing OETF back in so the sky can be judged against
// what the pipeline is meant to produce rather than against the bug. It is a
// LAB-LOCAL patch on another module's material, the HUD says so on every frame,
// and `g` toggles it. The one-line fix belongs in post.js's COMPOSITE_FRAG.
const OETF_PATCH = `
  // linear -> sRGB, applied before the ordered dither so the dither is one 8-bit
  // step in the space it is actually quantised in.
  color = mix(color * 12.92,
              1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
              step(vec3(0.0031308), color));
`;
let encodePatched = false;
function setOutputEncode(on) {
  if (!post || on === encodePatched) return;
  const f = post.compositeMat;
  const anchor = '  float d = fract(dot(gl_FragCoord.xy';
  f.fragmentShader = on
    ? f.fragmentShader.replace(anchor, OETF_PATCH + anchor)
    : f.fragmentShader.replace(OETF_PATCH, '');
  f.needsUpdate = true;
  encodePatched = on;
}
setOutputEncode(true);

// setSky() is daynight.js's own hook: it stops the flat background override and
// hands the dome the time of day, the env map and the fog terms on every apply().
for (const l of lamps) tod.registerLamp(l, LAMP_CANDELA);
tod.setSky(sky, weather);
weather.bindMaterials(MAT);

// One measured regeneration, after everything is warm, for the report.
const refreshFullMs = sky.refresh({ force: true, environment: true, sync: true });
const refreshLutMs = sky.refresh({ force: true, environment: false, sync: false });

// ---------------------------------------------------------------------- camera
// Two framings. Street is the one that matters — eye height is where the razor
// horizon used to be — and elevated shows the haze stratifying over the blocks.
const SHOTS = {
  street:   { eye: [0, 2.1, 16], pitch: 0.105 },
  elevated: { eye: [0, 46, 96],  pitch: -0.075 },
};
let shotName = 'street';
let yaw = 0, pitch = SHOTS.street.pitch, dist = 1;
const eye = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
function setShot(name) {
  shotName = name;
  const sh = SHOTS[name] ?? SHOTS.street;
  eye.set(...sh.eye).applyAxisAngle(UP, viewYaw);
  eye.y = sh.eye[1];
  pitch = sh.pitch;
  yaw = viewYaw;
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
const hidden = {};
let timeName = 'dusk';
let weatherName = 'clear';
let snap = false;

function setTime(name) {
  timeName = name;
  tod.apply(name);            // this calls into sky.setTimeOfDay + refresh + applyToPost
  orient(tod.preset.azimuth); // at night that azimuth is the moon's
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
  if (e.key === 'g') setOutputEncode(!encodePatched);
});

// ------------------------------------------------------------------ reporting
// Draw calls are read from PostStack.stats.sceneCalls, not renderer.info: after
// the composite blit renderer.info describes a 1-triangle fullscreen pass.
let sceneCalls = 0, sceneTris = 0, worstFrameMs = 0, frames = 0;

// One-shot, on demand: a full read-back of the HDR target is a GPU sync and has
// no business in a frame. It exists because a single non-finite pixel is
// invisible until bloom turns it into a black square 2,700 pixels across.
function scanHDR() {
  if (!post) return null;
  const rt = post.hdr, w = rt.width, h = rt.height;
  const buf = new Uint16Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const half = THREE.DataUtils.fromHalfFloat;
  let nan = 0, inf = 0, max = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const v = half(buf[i * 4 + c]);
      if (Number.isNaN(v)) nan++;
      else if (!Number.isFinite(v)) inf++;
      else if (v > max) max = v;
    }
  }
  return { width: w, height: h, nan, inf, maxNits: Math.round(max) };
}

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
    outputEncodePatched: encodePatched,
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
output encode   ${encodePatched ? 'LAB PATCH — post.js writes linear into an sRGB buffer' : 'post.js as-is (linear, ~2.2 gamma dark)'}

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
  for (const [name, on] of Object.entries(hidden)) {
    const o = scene.getObjectByName(name);
    if (o) o.visible = !on;
  }
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
setShot('street');
setTime('dusk');
weather.set('clear', { immediate: true });
updateHud();
document.getElementById('load').remove();
requestAnimationFrame(frame);

window.__lab = {
  ready: true, stats, setTime, setWeather, setShot, hidden, scanHDR, setOutputEncode,
  snapWeather(name) { snap = true; setWeather(name); snap = false; },
  look(y, p) { yaw = y; pitch = p; },
  resetWorst() { worstFrameMs = 0; frames = 0; },
  renderer, scene, camera, tod, post, sky, weather, THREE,
  states: WEATHER_STATES,
};
