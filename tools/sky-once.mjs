// Is the sky delivered once, and what does it actually put on a surface?
//
// daynight.js runs a HemisphereLight at the preset's skyLux AND sky.js builds a
// PMREM from the same dome that scene.environment delivers again. Whether that
// is a double count, and of what, is not a thing to reason about from the source:
// it is three measurements, and this tool takes all three.
//
//   1. A LIGHT METER IN THE FRAME. Three albedo-1, specular-0 patches - one
//      facing up, one facing down, one vertical - parked in front of the camera.
//      A Lambertian surface of albedo 1 under irradiance E has radiance E/pi, so
//      reading the patch out of the HDR scene target and multiplying by pi is a
//      lux meter. Each light path is then switched off in turn, which splits that
//      lux between sun, HemisphereLight and PMREM in ABSOLUTE UNITS rather than
//      in shares of a frame.
//
//      It is self-tested: with the environment and the sun off, the up-facing
//      patch must read skyLux * luminance(skyColor) exactly, because that is what
//      three.js's HemisphereLight puts on an up-facing normal by construction. An
//      instrument that cannot reproduce a number the shader computes in closed
//      form is not measuring what it claims to.
//
//   2. THE DOME'S OWN INTEGRALS. The same cosine-weighted integral sky.js uses
//      for skyLux, taken over the upper hemisphere (sky), the lower hemisphere
//      (the lit ground plane the dome draws below the horizon) and the hemisphere
//      about a horizontal normal (a wall). This is what the PMREM is built FROM,
//      so it is the ceiling on what the PMREM can deliver, independent of any
//      rendering.
//
//   3. REGION ISOLATION at the hero camera, read out of the HDR scene target and
//      therefore in linear nits - not out of a screenshot, where ACES has already
//      compressed the highlights and a ratio of 8-bit values is not a ratio of
//      light.
//
// Everything is measured on a settled scene with traffic and pedestrians frozen,
// and a noise floor is taken first: two identical readbacks, no toggle between
// them. Any difference below that floor is not a measurement.
//
//   SKY_ONCE_TIMES=noon,golden,dusk,night  SKY_ONCE_TAG=before node tools/sky-once.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const TIMES = (process.env.SKY_ONCE_TIMES ?? 'noon,golden,dusk,night').split(',');
const TAG = process.env.SKY_ONCE_TAG ?? 'now';
const SHOT = process.env.SKY_ONCE_SHOT ?? 'corridor';
fs.mkdirSync('docs', { recursive: true });

// The two regions the round-7 lighting critic's isolation used, in 1600x900
// screenshot pixels with y down. Scaled to the HDR target inside the page.
const REGIONS = {
  wall:   [120, 120, 120, 60],
  ground: [250, 800, 120, 40],
  // Two BIG ground samples, added for the ground-albedo round. src/sky.js's
  // uGroundAlbedo is the reflectance of the street the dome stands on, and a
  // 120x40 box of one surface cannot say what that is: the district's ground is
  // clay pavers on the plaza and asphalt on the carriageway, and the two are a
  // long way apart in both luminance and hue. Placed by looking at
  // docs/shots/skyonce-meter-*.png rather than by guessing at coordinates.
  plaza:  [0, 700, 1000, 200],
  road:   [1340, 575, 240, 32],
};

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

const placed = await page.evaluate(placeCamera, SHOTS[SHOT]);
console.log(describe(SHOT, placed));
await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });

// Wait for the streaming COUNT to hold still, not for a fixed number of seconds.
// A fixed wait measured half-loaded districts and gave 26.5% on one run and 53.7%
// on the next - see tools/sun-share.mjs and the ledger.
await page.waitForFunction(() => {
  const w = __district.world.report();
  const prev = window.__settleProbe;
  const same = prev && prev.n === w.chunksLoaded && prev.m === w.meshes;
  window.__settleProbe = { n: w.chunksLoaded, m: w.meshes, still: same ? (prev.still ?? 0) + 1 : 0 };
  return window.__settleProbe.still >= 4;
}, null, { timeout: 240000, polling: 2000 });
const settled = await page.evaluate(() => {
  const w = __district.world.report();
  return { chunks: w.chunksLoaded, meshes: w.meshes, queued: w.queued ?? 0 };
});
console.log(`streaming settled: ${settled.chunks} chunks, ${settled.meshes} meshes, queue ${settled.queued}`);
await page.waitForTimeout(4000);

// Is the camera actually looking at the district?
//
// One run of this tool put the corridor camera - at the same coordinates, with
// the same 89 chunks and 264 meshes settled, reporting the same 3.2 m of
// clearance as every other run - inside a building: the whole frame was a brick
// facade at arm's length, and every number that run produced was a measurement of
// the inside of a wall. Nothing in placeCamera() is nondeterministic and a second
// run reproduced the correct frame, so the guard is on the RESULT rather than on
// the inputs. The sky dome's own radiance is known from sky.audit(), so if no
// pixel in the top band of the frame comes within a factor of four of it, the
// camera is not looking at the street and the run is worthless. Loudly, not
// quietly: the failure mode this exists for produced entirely plausible numbers.
async function skyIsVisible(page) {
  return page.evaluate(() => {
    const a = __district.sky.audit();
    const top = window.__skyOnce.readBox(0, 0, 1600, 140);
    const ref = Math.max(a.horizonNits ?? 0, a.zenithNits ?? 0);
    return { maxNits: +top.max.toFixed(3), refNits: +ref.toFixed(3),
      ok: top.max > 0.25 * ref, ratio: +(top.max / Math.max(1e-9, ref)).toFixed(3) };
  });
}

// --------------------------------------------------------------- in-page probe
// Installed once; every measurement below is a call into it. Kept in one string
// so the page keeps its state (probe meshes, saved light values) between calls.
await page.evaluate(() => {
  const D = __district;
  // Half-float decode. THREE is not on window here, so DataUtils is out of reach
  // and this is ten lines rather than a dependency.
  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  // Mean linear RGB over a screenshot-space box, read out of the HDR scene
  // target. y is flipped: readRenderTargetPixels counts from the bottom.
  function readBox(x, y, w, h, target) {
    const rt = target === 'bloom' ? D.post.blurB : D.post.hdr;
    const sx = rt.width / 1600, sy = rt.height / 900;
    const X = Math.round(x * sx), W = Math.max(1, Math.round(w * sx));
    const H = Math.max(1, Math.round(h * sy));
    const Y = Math.round(rt.height - (y + h) * sy);
    const buf = new Uint16Array(W * H * 4);
    D.renderer.readRenderTargetPixels(rt, X, Math.max(0, Y), W, H, buf);
    let r = 0, g = 0, b = 0, n = 0, bad = 0, max = 0;
    for (let i = 0; i < W * H; i++) {
      const R = half(buf[i * 4]), G = half(buf[i * 4 + 1]), B = half(buf[i * 4 + 2]);
      if (!isFinite(R) || !isFinite(G) || !isFinite(B)) { bad++; continue; }
      r += R; g += G; b += B; n++;
      const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      if (y > max) max = y;
    }
    return n ? { r: r / n, g: g / n, b: b / n, y: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, max, n, bad }
             : { r: 0, g: 0, b: 0, y: 0, max: 0, n: 0, bad };
  }

  window.__skyOnce = { readBox, half, lum };
});

// Guard the settled scene before anything is measured off it, and retry the
// placement once before giving up: a re-placed camera on a settled district is
// deterministic (verified - the same coordinates and the same 3.2 m of clearance
// early and late), so a retry costs seconds and an unnoticed wall costs the run.
let vis = await skyIsVisible(page);
if (!vis.ok) {
  console.log(`sky not visible from the camera (${JSON.stringify(vis)}) - re-placing`);
  const again = await page.evaluate(placeCamera, SHOTS[SHOT]);
  console.log(describe(SHOT, again));
  await page.waitForTimeout(4000);
  vis = await skyIsVisible(page);
}
console.log(`sky visible from the camera: ${JSON.stringify(vis)}`);
if (!vis.ok) {
  console.error('ABORT: the camera is not looking at the district. Every number this ' +
    'run would produce would be a measurement of the inside of a building.');
  await browser.close();
  process.exit(2);
}

// The probe meshes need real THREE constructors, which the district page does not
// expose. It exposes instances, though, and every constructor is reachable from
// one: post.quad is a Mesh with a BufferGeometry, and any street material is a
// MeshStandardMaterial. That is enough to clone a material and build a plane from
// raw attributes without importing anything.
const meterInstalled = await page.evaluate(() => {
  const D = __district;
  const quad = D.post.quad;
  const Mesh = quad.constructor;
  const BufferGeometry = quad.geometry.constructor;
  const BufferAttribute = quad.geometry.getAttribute('position').constructor;
  // A MeshStandardMaterial from the district, cloned so nothing shared is touched.
  let src = null;
  D.scene.traverse((o) => { if (!src && o.isMesh && o.material && o.material.isMeshStandardMaterial) src = o.material; });
  if (!src) return { ok: false, why: 'no MeshStandardMaterial found in the scene' };
  const mk = (nx, ny, nz) => {
    const m = src.clone();
    m.map = null; m.normalMap = null; m.roughnessMap = null; m.metalnessMap = null;
    m.aoMap = null; m.emissiveMap = null; m.alphaMap = null; m.bumpMap = null;
    m.color.setRGB(1, 1, 1);
    m.emissive.setRGB(0, 0, 0);
    m.roughness = 1; m.metalness = 0;
    if ('specularIntensity' in m) m.specularIntensity = 0;
    m.transparent = false; m.opacity = 1;
    m.needsUpdate = true;
    // 1.6 m square in the plane perpendicular to (nx, ny, nz).
    const n = [nx, ny, nz];
    let t = Math.abs(ny) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const u = norm(cross(t, n)), v = norm(cross(n, u));
    const S = 0.45;
    const pos = [], nor = [], uv = [];
    const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [a, b] of corner) {
      pos.push(u[0] * a * S + v[0] * b * S, u[1] * a * S + v[1] * b * S, u[2] * a * S + v[2] * b * S);
      nor.push(nx, ny, nz);
      uv.push((a + 1) / 2, (b + 1) / 2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new Mesh(g, m);
    mesh.castShadow = false;
    mesh.receiveShadow = false;      // the meter reads the UNOCCLUDED sun
    mesh.frustumCulled = false;
    mesh.renderOrder = 999;
    // Hidden by default. A 1.6 m patch 2.6 m from the lens covers a third of the
    // frame, and the first run of this tool had the up-facing patch sitting
    // exactly over the ground region it was also trying to measure - the region
    // split came back identical to the patch's own, which is how it was caught.
    mesh.visible = false;
    return mesh;
  };
  const cam = D.camera;
  // Camera basis in world space, read off its matrix.
  const e = cam.matrixWorld.elements;
  const right = { x: e[0], y: e[1], z: e[2] };
  const up = { x: e[4], y: e[5], z: e[6] };
  const back = { x: e[8], y: e[9], z: e[10] };
  const p = cam.position;
  const at = (dr, du, df) => ({
    x: p.x + right.x * dr + up.x * du - back.x * df,
    y: p.y + right.y * dr + up.y * du - back.y * df,
    z: p.z + right.z * dr + up.z * du - back.z * df,
  });
  const camAz = Math.atan2(-back.z, -back.x);
  // FILL: a vertical patch whose normal points back down the lens - the geometry
  // of the facade on the camera's own side of the street.
  const fillAz = camAz + Math.PI;
  // KEY: a vertical surface turned as far toward the sun as this camera can read.
  //
  // A wall facing the sun square-on has its back to a camera the sun is 120 deg
  // off, so there is no such patch to read; the key normal is the fill normal
  // rotated toward the sun and CLAMPED. The clamp is 55 deg and it is a
  // measurement limit, not a taste one. A MeshStandardMaterial keeps its
  // dielectric lobe (F0 = 0.04) and Schlick's (1 - cos(theta))^5 takes that to
  // 0.34 at 78 deg, so a patch read near edge-on stops being a diffuse meter: at
  // 78 deg this probe read the sun at 24,083 lux where the arithmetic says 14,350
  // and read the HemisphereLight 26.8% BELOW a value the shader computes in
  // closed form. At 55 deg the Fresnel term is 0.054 and the same self-test comes
  // back exact. Measured off the DirectionalLight's own direction, not off the
  // preset table, so the two cannot disagree.
  let sun = null;
  D.scene.traverse((o) => { if (o.isDirectionalLight) sun = o; });
  const sd = { x: sun.position.x - sun.target.position.x, y: sun.position.y - sun.target.position.y,
    z: sun.position.z - sun.target.position.z };
  const sunAz = Math.atan2(sd.z, sd.x);
  const sunEl = Math.asin(sd.y / Math.hypot(sd.x, sd.y, sd.z));
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const LIM = (55 * Math.PI) / 180;
  const keyAz = fillAz + Math.max(-LIM, Math.min(LIM, wrap(sunAz - fillAz)));
  const probes = {
    up:   { mesh: mk(0, 1, 0),  pos: at(-1.05, -0.62, 2.4) },
    down: { mesh: mk(0, -1, 0), pos: at(1.05, 0.62, 2.4) },
    fill: { mesh: mk(Math.cos(fillAz), 0, Math.sin(fillAz)), pos: at(-1.05, 0.62, 2.4) },
    key:  { mesh: mk(Math.cos(keyAz), 0, Math.sin(keyAz)), pos: at(1.05, -0.62, 2.4) },
  };
  for (const k of Object.keys(probes)) {
    const q = probes[k];
    q.mesh.position.set(q.pos.x, q.pos.y, q.pos.z);
    q.mesh.updateMatrixWorld(true);
    D.scene.add(q.mesh);
  }
  window.__meter = { probes, camAz, fillAz, keyAz, sunAz, sunEl,
    keyCos: Math.cos(keyAz - sunAz) * Math.cos(sunEl) };
  return { ok: true, camAzDeg: +((camAz * 180) / Math.PI).toFixed(1),
    sunAzDeg: +((sunAz * 180) / Math.PI).toFixed(1), sunElDeg: +((sunEl * 180) / Math.PI).toFixed(2),
    keyAzDeg: +((keyAz * 180) / Math.PI).toFixed(1),
    keyBeamFraction: +(Math.cos(keyAz - sunAz) * Math.cos(sunEl)).toFixed(3) };
});
console.log('light meter installed:', JSON.stringify(meterInstalled));
if (!meterInstalled.ok) { await browser.close(); process.exit(1); }

// Where each patch lands on screen, so the readback knows which pixels are it.
await page.waitForTimeout(1200);
const meterBoxes = await page.evaluate(() => {
  const D = __district, cam = D.camera;
  const out = {};
  for (const [k, q] of Object.entries(window.__meter.probes)) {
    const v = q.mesh.position.clone().project(cam);
    const x = (v.x * 0.5 + 0.5) * 1600, y = (1 - (v.y * 0.5 + 0.5)) * 900;
    out[k] = [Math.round(x - 6), Math.round(y - 6), 12, 12];
  }
  return out;
});
console.log('meter boxes:', JSON.stringify(meterBoxes));
const setMeterVisible = (on) => page.evaluate((v) => {
  for (const q of Object.values(window.__meter.probes)) q.mesh.visible = v;
}, on);
// Looked at, not just reduced to a number: the first version of this tool put a
// patch over the region it was measuring and the numbers still looked plausible.
await setMeterVisible(true);
await page.waitForTimeout(900);
fs.mkdirSync('docs/shots', { recursive: true });
await page.screenshot({ path: `docs/shots/skyonce-meter-${TAG}.png`, timeout: 120000 });
await setMeterVisible(false);

// ------------------------------------------------------------------ measurement
const VARIANTS = ['base', 'nosun', 'nohemi', 'noenv', 'hemionly', 'envonly'];

// Set the three light paths, then WAIT FOR RENDERED FRAMES, not for milliseconds.
//
// The first working version of this tool waited 700 ms. On SwiftShader with a
// settled district that is sometimes less than one frame, and the readback then
// returned the PREVIOUS variant's render target: `base` came back byte-identical
// to `envonly`, which made the sun's contribution negative. A negative
// contribution from switching a light ON is the incoherent number that exposed
// it. It also re-asserts the values every frame while it waits, because
// tod.apply() and sky.refresh() both rewrite intensity and environmentIntensity
// and either can land between the set and the read.
const MASK = { base: [1, 1, 1], nosun: [0, 1, 1], nohemi: [1, 0, 1], noenv: [1, 1, 0],
  hemionly: [0, 1, 0], envonly: [0, 0, 1] };

async function setLights(v) {
  await page.evaluate(([variant, on]) => {
    const D = __district;
    if (!window.__saved) {
      let sun = null, hemi = null;
      D.scene.traverse((o) => {
        if (o.isDirectionalLight) sun = o;
        if (o.isHemisphereLight) hemi = o;
      });
      window.__saved = { sun, hemi, sunI: sun.intensity, hemiI: hemi.intensity,
        env: D.scene.environmentIntensity };
    }
    window.__variant = { name: variant, on };
    clearInterval(window.__hold);
    const apply = () => {
      const s = window.__saved, m = window.__variant.on;
      s.sun.intensity = s.sunI * m[0];
      s.hemi.intensity = s.hemiI * m[1];
      D.scene.environmentIntensity = s.env * m[2];
    };
    apply();
    window.__hold = setInterval(apply, 16);
  }, [v, MASK[v]]);
  // Six rendered frames after the state was asserted, whatever that takes.
  const start = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 6, start, { timeout: 120000, polling: 100 });
  return page.evaluate(() => {
    const s = window.__saved;
    return { sun: +s.sun.intensity.toFixed(2), hemi: +s.hemi.intensity.toFixed(2),
      env: +__district.scene.environmentIntensity.toFixed(3) };
  });
}

async function readAll(boxes, target) {
  return page.evaluate(([bx, t]) => {
    const out = {};
    for (const [k, b] of Object.entries(bx)) out[k] = window.__skyOnce.readBox(b[0], b[1], b[2], b[3], t);
    return out;
  }, [boxes, target ?? null]);
}

async function domeIntegrals() {
  return page.evaluate(() => {
    const sky = __district.sky;
    const W = sky.lutWidth, H = sky.lutHeight;
    const buf = new Uint16Array(W * H * 4);
    __district.renderer.readRenderTargetPixels(sky.lut, 0, 0, W, H, buf);
    const half = window.__skyOnce.half;
    const L = (i) => [half(buf[i * 4]), half(buf[i * 4 + 1]), half(buf[i * 4 + 2])];
    const lumv = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const dPhi = (Math.PI * 2) / W, dTheta = Math.PI / H;
    const sunAz = Math.atan2(sky.sunDirection.z, sky.sunDirection.x);
    // Same convention as sky.js's _readback: y is elevation from -pi/2 to +pi/2,
    // x is azimuth in atan2(z, x). E = int L cos(zenith) dw, and for elevation e
    // that is L * sin(e) * cos(e) de dphi.
    const acc = { up: [0, 0, 0], down: [0, 0, 0], wallSun: [0, 0, 0], wallCam: [0, 0, 0], wallKey: [0, 0, 0] };
    let eUp = 0, eDown = 0, eWallSun = 0, eWallCam = 0, eWallKey = 0;
    // The two wall normals the light meter actually has patches on, so the
    // integral and the render can be compared on the same surface. The first
    // version of this read a field that had been renamed, got undefined, and
    // reported eWallCam as 0 for a wall that is plainly lit - a NaN wearing a
    // plausible number.
    const camAz = window.__meter.fillAz;
    const keyAz = window.__meter.keyAzCurrent ?? window.__meter.keyAz;
    for (let y = 0; y < H; y++) {
      const el = ((y + 0.5) / H - 0.5) * Math.PI;
      const se = Math.sin(el), ce = Math.cos(el);
      for (let x = 0; x < W; x++) {
        const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
        const c = L(y * W + x);
        if (!isFinite(c[0])) continue;
        const l = lumv(c);
        const dw = ce * dTheta * dPhi;                    // solid angle
        if (se > 0) { const w = se * dw; eUp += l * w; for (let k = 0; k < 3; k++) acc.up[k] += c[k] * w; }
        else { const w = -se * dw; eDown += l * w; for (let k = 0; k < 3; k++) acc.down[k] += c[k] * w; }
        const dS = ce * Math.cos(phi - sunAz), dC = ce * Math.cos(phi - camAz);
        const dK = ce * Math.cos(phi - keyAz);
        if (dS > 0) { const w = dS * dw; eWallSun += l * w; for (let k = 0; k < 3; k++) acc.wallSun[k] += c[k] * w; }
        if (dC > 0) { const w = dC * dw; eWallCam += l * w; for (let k = 0; k < 3; k++) acc.wallCam[k] += c[k] * w; }
        if (dK > 0) { const w = dK * dw; eWallKey += l * w; for (let k = 0; k < 3; k++) acc.wallKey[k] += c[k] * w; }
      }
    }
    const a = sky.audit();
    return {
      eUp: +eUp.toFixed(3), eDown: +eDown.toFixed(3),
      eWallSun: +eWallSun.toFixed(3), eWallCam: +eWallCam.toFixed(3), eWallKey: +eWallKey.toFixed(3),
      upRGB: acc.up.map((v) => +v.toFixed(2)), downRGB: acc.down.map((v) => +v.toFixed(2)),
      skyLuxFromAudit: a.skyLux, sunLuxFromAudit: a.sunLux,
      zenithNits: a.zenithNits, horizonNits: a.horizonNits,
    };
  });
}

// Re-aim the KEY patch at the new preset's sun. The patch's normal is baked into
// its geometry, so this rotates the mesh about Y; a rotation about Y leaves the
// normal's y component at 0, which is what the HemisphereLight self-test reads.
// Without this the key patch stays pointed at whatever sun was up when the meter
// was installed, and every preset after the first measures a key wall that is not
// facing its own sun.
async function aimKey() {
  return page.evaluate(() => {
    const M = window.__meter;
    let sun = null;
    __district.scene.traverse((o) => { if (o.isDirectionalLight) sun = o; });
    const sd = { x: sun.position.x - sun.target.position.x, y: sun.position.y - sun.target.position.y,
      z: sun.position.z - sun.target.position.z };
    const sunAz = Math.atan2(sd.z, sd.x);
    const sunEl = Math.asin(sd.y / Math.hypot(sd.x, sd.y, sd.z));
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const LIM = (55 * Math.PI) / 180;
    const keyAz = M.fillAz + Math.max(-LIM, Math.min(LIM, wrap(sunAz - M.fillAz)));
    // Rotating about +Y by theta maps an azimuth phi to phi - theta.
    M.probes.key.mesh.rotation.y = -(keyAz - M.keyAz);
    M.probes.key.mesh.updateMatrixWorld(true);
    M.keyAzCurrent = keyAz;
    const beam = Math.max(0, Math.cos(keyAz - sunAz)) * Math.cos(sunEl);
    return { sunAzDeg: +((sunAz * 180) / Math.PI).toFixed(1),
      sunElDeg: +((sunEl * 180) / Math.PI).toFixed(2),
      keyAzDeg: +((keyAz * 180) / Math.PI).toFixed(1),
      fillAzDeg: +((M.fillAz * 180) / Math.PI).toFixed(1),
      keyBeamFraction: +beam.toFixed(4) };
  });
}

const results = [];
for (const tod of TIMES) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(9000);
  await page.evaluate(() => { window.__saved = null; });   // re-read the new preset's values
  const geom = await aimKey();
  console.log(`${tod}: sun ${geom.sunAzDeg} deg az / ${geom.sunElDeg} deg el, ` +
    `key wall aimed ${geom.keyAzDeg} deg (${geom.keyBeamFraction} of the beam), fill ${geom.fillAzDeg} deg`);

  const audit = await page.evaluate(() => __district.audit());
  const dome = await domeIntegrals();
  const skyVisible = await skyIsVisible(page);
  if (!skyVisible.ok) {
    console.error(`ABORT at ${tod}: the camera is not looking at the district ` +
      `(${JSON.stringify(skyVisible)})`);
    await browser.close();
    process.exit(2);
  }

  // Noise floor: the same untouched frame read twice, no toggle in between.
  await setLights('base');
  const n1 = await readAll({ ...meterBoxes, ...REGIONS });
  await page.waitForTimeout(1400);
  const n2 = await readAll({ ...meterBoxes, ...REGIONS });
  const floor = {};
  for (const k of Object.keys(n1)) floor[k] = Math.abs(n2[k].y - n1[k].y);

  // Two passes. The meter patches are a third of the frame across, so they are
  // hidden while the regions are read and shown while the meter is read.
  const reads = {}, state = {};
  for (const v of VARIANTS) {
    state[v] = await setLights(v);
    reads[v] = await readAll(REGIONS);
  }
  await setMeterVisible(true);
  for (const v of VARIANTS) {
    const st = await setLights(v);
    if (JSON.stringify(st) !== JSON.stringify(state[v])) state[v] = { pass1: state[v], pass2: st };
    Object.assign(reads[v], await readAll(meterBoxes));
  }
  // SELF-TEST, and it has to survive the change it is measuring.
  //
  // NOT informative at dusk or night, and the artifact says so rather than
  // quietly failing: this leaves the STREET LAMPS lit, and at night they are
  // 0.3 lux at the meter against 0.008 lux of hemisphere, so the reading is the
  // lamps. Disabling the pool here would make it informative - LightPool.update()
  // rewrites PointLight.intensity every frame, so it has to be the pool's own
  // enabled flag and not the intensities - and that is worth doing the next time
  // this tool is opened. What carries the night derivation instead is the closed
  // form (0.15 * luminance(0x35406b) = 0.008 lux) and the by-difference
  // isolation, which reads 0.0 against a 0.05 lux quantisation and agrees.
  //
  // On the committed build the meter proves itself by reading the
  // HemisphereLight's own closed form: three.js puts intensity *
  // luminance(skyColor) on an up-facing normal, exactly. Once that light is
  // switched off there is nothing to check against, so the test injects a known
  // intensity into it with the sun and the environment off and checks the same
  // identity. An instrument that cannot recover a number the shader computes in
  // closed form is not measuring what it claims to, whichever build it is on.
  await page.evaluate(() => {
    const s = window.__saved, D = __district;
    clearInterval(window.__hold);
    const I = D.tod.preset.skyLux;
    const hold = () => { s.sun.intensity = 0; s.hemi.intensity = I; D.scene.environmentIntensity = 0; };
    hold();
    window.__hold = setInterval(hold, 16);
  });
  const stExpect = await page.evaluate(() => {
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return { I: __district.tod.preset.skyLux, up: __district.tod.preset.skyLux * lum(window.__saved.hemi.color) };
  });
  const fSelf = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 6, fSelf, { timeout: 120000, polling: 100 });
  const stRead = await readAll({ up: meterBoxes.up });
  const selfTest = {
    injectedHemiIntensity: stExpect.I,
    expectedLux: +stExpect.up.toFixed(1),
    measuredLux: +(Math.PI * stRead.up.y).toFixed(1),
    errPct: +((((Math.PI * stRead.up.y) - stExpect.up) / Math.max(1e-9, stExpect.up)) * 100).toFixed(2),
  };
  console.log(`  meter self-test: injected ${selfTest.injectedHemiIntensity} -> expected ` +
    `${selfTest.expectedLux} lux, measured ${selfTest.measuredLux} (${selfTest.errPct}%)`);

  await setMeterVisible(false);
  await setLights('base');
  await page.evaluate(() => clearInterval(window.__hold));
  const bloomRead = await readAll(REGIONS, 'bloom');
  await page.screenshot({ path: `docs/shots/skyonce-${TAG}-${tod}.png`, timeout: 150000 });
  // A COUNTERFACTUAL, not a change: the same frame with the bloom veil removed.
  // The bright pass compares params.bloomThreshold against the scene target in
  // NITS while daynight.js authors that threshold in exposed units, so every
  // pixel passes and the composite adds bloomStrength x a blurred copy of the
  // whole frame. row.bloom measures that; this frame is what the district would
  // look like without it, captured so the claim can be looked at rather than
  // only computed. Nothing shipped is touched - bloomStrength is restored below.
  if (process.env.SKY_ONCE_NOBLOOM === '1') {
    await page.evaluate(() => { window.__bs = __district.post.params.bloomStrength;
      __district.post.params.bloomStrength = 0; });
    const f0 = await page.evaluate(() => __district.frames);
    await page.waitForFunction((f) => __district.frames > f + 4, f0, { timeout: 120000, polling: 100 });
    await page.screenshot({ path: `docs/shots/skyonce-${TAG}-${tod}-nobloom.png`, timeout: 150000 });
    await page.evaluate(() => { __district.post.params.bloomStrength = window.__bs; });
  }

  const E = (k, v) => Math.PI * reads[v][k].y;            // lux on the patch
  const row = {
    tod, geometry: geom, skyVisible,
    exposure: audit.exposure, exposureAsStop: audit.exposureAsStop,
    sunLux: audit.sunLux, skyLux: audit.skyLux,
    sunLuxDelivered: audit.sunLuxDelivered, skyLuxDelivered: audit.skyLuxDelivered,
    environmentIntensity: audit.environmentIntensity,
    // Present only once daynight.js reports it; null on a build that still
    // delivers the sky twice, which is itself the distinguishing fact.
    skyDelivery: audit.skyDelivery ?? null,
    implausible: audit.implausible,
    dome,
    meterSelfTest: selfTest,
    noiseFloor: Object.fromEntries(Object.entries(floor).map(([k, v]) => [k, +v.toFixed(4)])),
    // The intensity each variant's frame was actually rendered at, read back out
    // of the scene after the wait. Without this the tool cannot tell a light that
    // was off from a render target that had not been redrawn yet.
    stateWhenRead: state,
    // Illuminance in lux on each patch, per light path, from the light meter.
    meter: {},
    regions: {},
  };
  // What three.js's HemisphereLight puts on each of these normals in closed form.
  // The meter is only believable where it reproduces this: an instrument that
  // cannot recover a number the shader computes analytically is reading something
  // other than the patch, which is exactly the failure the first run had.
  const hemiExpected = await page.evaluate(() => {
    let h = null;
    __district.scene.traverse((o) => { if (o.isHemisphereLight) h = o; });
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const I = window.__saved ? window.__saved.hemiI : h.intensity;
    const sky = lum(h.color), gnd = lum(h.groundColor);
    const out = {};
    for (const [k, q] of Object.entries(window.__meter.probes)) {
      // three.js: irradiance = mix(groundColor, skyColor, 0.5 + 0.5 * dot(n, up)),
      // taken from the patch's own normal attribute rather than assumed.
      const n = q.mesh.geometry.getAttribute('normal');
      const w = 0.5 + 0.5 * n.getY(0);
      out[k] = I * (gnd + (sky - gnd) * w);
    }
    return out;
  });
  for (const k of ['up', 'down', 'fill', 'key']) {
    row.meter[k] = {
      total: +E(k, 'base').toFixed(1),
      sun: +(E(k, 'base') - E(k, 'nosun')).toFixed(1),
      hemi: +(E(k, 'base') - E(k, 'nohemi')).toFixed(1),
      env: +(E(k, 'base') - E(k, 'noenv')).toFixed(1),
      hemiAlone: +E(k, 'hemionly').toFixed(1),
      envAlone: +E(k, 'envonly').toFixed(1),
      hemiExpected: +hemiExpected[k].toFixed(1),
      // Null rather than a vast number when the HemisphereLight is off: the
      // closed form is 0 there, and a percentage error against 0 is not a
      // measurement. meterSelfTest below is the check that survives that.
      hemiErrPct: hemiExpected[k] > 1e-6
        ? +(((E(k, 'hemionly') - hemiExpected[k]) / hemiExpected[k]) * 100).toFixed(1) : null,
      floorLux: +(Math.PI * floor[k]).toFixed(2),
    };
  }
  for (const k of Object.keys(REGIONS)) {
    const t = reads.base[k].y;
    const c = reads.base[k];
    row.regions[k] = {
      nits: +t.toFixed(4),
      // LINEAR RGB, not just luminance. The round that added this was about HUE:
      // src/sky.js's uGroundAlbedo is a COLOUR standing in for the street below
      // the horizon, and a tool that records only how bright a region is cannot
      // say whether that colour is the street's.
      rgb: [+c.r.toFixed(4), +c.g.toFixed(4), +c.b.toFixed(4)],
      br: +(c.b / Math.max(1e-9, c.r)).toFixed(3),
      // EFFECTIVE ALBEDO, per channel, and it is a division rather than a
      // derivation: the up-facing meter patch is albedo 1 and Lambertian, so its
      // radiance IS E/pi in whatever colour the light arrives in. A region's
      // radiance divided by that patch's is therefore the region's reflectance,
      // with the illuminant's own hue already cancelled - which is exactly the
      // quantity uGroundAlbedo is.
      //
      // Only meaningful where the region sees the same light the patch does. The
      // patch has receiveShadow off and reads the UNOCCLUDED sun, so sunPct
      // beside it is not decoration: a region in building shadow reads a
      // reflectance far below its own and the low sunPct is how you know.
      albedo: ['r', 'g', 'b'].map((ch) => +(c[ch] / Math.max(1e-9, reads.base.up[ch])).toFixed(4)),
      albedoY: +(t / Math.max(1e-9, reads.base.up.y)).toFixed(4),
      // The same ratio with the SUN OFF in both numerator and denominator. A
      // region standing in a building's shadow is not lit by the same light the
      // unshadowed patch is, so the `base` ratio there is not a reflectance - but
      // sky-only, both see the same dome and the ratio is a reflectance again.
      // Where a region IS fully sunlit the two agree, which is the check.
      albedoNoSun: ['r', 'g', 'b'].map((ch) =>
        +(reads.nosun[k][ch] / Math.max(1e-9, reads.nosun.up[ch])).toFixed(4)),
      albedoYNoSun: +(reads.nosun[k].y / Math.max(1e-9, reads.nosun.up.y)).toFixed(4),
      sunPct: +(((t - reads.nosun[k].y) / t) * 100).toFixed(1),
      hemiPct: +(((t - reads.nohemi[k].y) / t) * 100).toFixed(1),
      envPct: +(((t - reads.noenv[k].y) / t) * 100).toFixed(1),
      floorPct: +((floor[k] / t) * 100).toFixed(2),
    };
  }
  // How much of the frame is BLOOM.
  //
  // post.js's bright pass compares params.bloomThreshold against the scene target,
  // which is in absolute nits - while daynight.js's golden preset derives that
  // threshold "in exposed units at 1/6,006", i.e. against radiance x exposure.
  // If the two disagree the bright pass passes the whole frame and the composite
  // adds bloomStrength x a blurred copy of it as a flat veil. That is a
  // measurement, not an argument: read the bloom target over the same boxes and
  // divide.
  row.bloom = {};
  for (const [k, v] of Object.entries(bloomRead)) {
    row.bloom[k] = { nits: +v.y.toFixed(2), ofScene: +(v.y / Math.max(1e-9, reads.base[k].y)).toFixed(3) };
  }
  row.bloomThreshold = await page.evaluate(() => __district.post.params.bloomThreshold);
  row.bloomStrength = await page.evaluate(() => __district.post.params.bloomStrength);

  // KEY:FILL, from the meter rather than from two pixel boxes.
  //
  // The critic measured it across a building's shadow edge on a facade verified to
  // be the same material. This is the same measurement with the last variable
  // removed: one material, one point in space, two orientations - so the ratio is
  // the LIGHTING's key:fill and nothing else's.
  // The sun term the key patch SHOULD be collecting: delivered direct normal
  // illuminance times the cosine of the angle between the wall's normal and the
  // beam. If the meter's measured sun term does not match this, the patch is not
  // facing where the arithmetic says it is.
  row.meter.key.sunExpected = +(audit.sunLuxDelivered * geom.keyBeamFraction).toFixed(1);
  const kf = row.meter.key.total / Math.max(1e-9, row.meter.fill.total);
  row.keyFill = { ratio: +kf.toFixed(3), stops: +Math.log2(kf).toFixed(2),
    keyLux: row.meter.key.total, fillLux: row.meter.fill.total };
  // The same ratio between the two pixel regions the round-7 isolation used, kept
  // so the two instruments can be compared.
  row.keyFillWallGround = {
    ratio: +(row.regions.wall.nits / row.regions.ground.nits).toFixed(3),
    stops: +Math.log2(row.regions.wall.nits / row.regions.ground.nits).toFixed(2),
  };
  results.push(row);
  console.log(`\n=== ${tod} ===`);
  console.log(JSON.stringify(row, null, 1));
}

fs.writeFileSync(`docs/sky-once-${TAG}.json`, JSON.stringify({
  tag: TAG, shot: SHOT, placed, settled, skyVisibleAtSettle: vis,
  meterBoxes, meterGeometry: meterInstalled, results, errors,
}, null, 1));
console.log(`\nwrote docs/sky-once-${TAG}.json`);
await browser.close();
