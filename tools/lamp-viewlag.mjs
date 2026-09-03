// Who else in the frame is ranked against LAST frame's camera?
//
// The light pool was: it was called before chase.update() wrote this frame's
// camera transform. Two other per-frame systems take the camera in the same
// place in district/main.js's loop - sky.update(camera) and
// weather.update(dt, camera) - so the same question has to be asked of them
// rather than assumed away. This measures it instead of arguing about it.
//
// The sky is the interesting one, and it is stale for TWO independent reasons:
//   - it is called before chase.update(), like the pool was; and
//   - it reads camera.matrixWorld, which nothing refreshes until
//     WebGLRenderer.render() does, inside post.render(), at the END of the frame.
//     ChaseCamera writes camera.position and calls camera.lookAt(); neither
//     touches matrixWorld.
// So moving the call - the fix that worked for the pool - would NOT be enough
// here. sky.update() would also have to call camera.updateMatrixWorld() itself,
// the way LightPool.setView() now does.
//
// The probe: jump the camera to a new heading and then poll as fast as possible.
// The sky's captured rotation (Sky._camRotation, the thing that becomes the
// uRayMatrix uniform the dome shader builds every view ray from) is compared
// against the camera's own quaternion, which chase.update/lookAt writes directly
// and is never stale. Any window where those disagree is a frame in which the sky
// is drawn for one camera and the geometry for another.
//
// Same question for weather, whose only use of the camera is camera.position for
// the rain volume centre and the splash centre - and the splash centre is snapped
// to a 2 m grid before it is used, which is the number the lag has to beat to
// matter.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const YAW_A = 0, YAW_B = 30;            // degrees; a 30 deg jump is easy to see
const JUMP_M = 10;                      // metres, for the weather arm

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.evaluate(() => { __district.setHudEnabled(false); __district.setAutopilot(() => {}); });
await page.evaluate(() => __district.setTimeOfDay('dusk'));
// Rain on, so the weather uniforms are unambiguously live rather than parked.
await page.evaluate(() => __district.setWeather('heavyRain', { seconds: 0 }));
await page.waitForTimeout(9000);

const READ = `async () => {
  const T = await import('/vendor/three.module.min.js');
  const d = __district, cam = d.camera;
  // The camera's INTENDED forward, from the quaternion chase.update just wrote.
  // Not getWorldDirection(), which reads the very matrix under suspicion.
  const f = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const camYaw = Math.atan2(f.x, f.z) * 180 / Math.PI;
  // What the sky captured: third column of its rotation matrix is +Z, so the
  // forward it will build rays from is its negation.
  const e = d.sky._camRotation.elements;
  const skyYaw = Math.atan2(-e[8], -e[10]) * 180 / Math.PI;
  const wrap = (a) => ((a % 360) + 540) % 360 - 180;
  const c = d.weather.rainMaterial.uniforms.uCenter.value;
  const s = d.weather.splashMaterial.uniforms.uCenter.value;
  return {
    frames: d.frames,
    camYaw: +camYaw.toFixed(3), skyYaw: +skyYaw.toFixed(3),
    yawLagDeg: +Math.abs(wrap(camYaw - skyYaw)).toFixed(3),
    camPos: [+cam.position.x.toFixed(2), +cam.position.z.toFixed(2)],
    rainCentre: [+c.x.toFixed(2), +c.z.toFixed(2)],
    rainLagM: +Math.hypot(cam.position.x - c.x, cam.position.z - c.z).toFixed(3),
    splashCentre: [+s.x.toFixed(2), +s.z.toFixed(2)],
    splashGridM: 2,
  };
}`;

const P = await page.evaluate(() => {
  const r = __district.district.meta.route, a = r[2];
  return [a.x, 5.2, a.z];
});
const look = (pos, yawDeg) => page.evaluate(({ p, th }) => {
  __district.freeCam(p, [p[0] + Math.cos(th) * 300, p[1], p[2] + Math.sin(th) * 300], 48);
}, { p: pos, th: (yawDeg * Math.PI) / 180 });

async function poll(ms, everyMs = 20) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    out.push(await page.evaluate(`(${READ})()`));
    await page.waitForTimeout(everyMs);
  }
  return out;
}

// ---- sky: one frame of rotation, or none? --------------------------------
await look(P, YAW_A);
await page.waitForTimeout(4000);
const settledA = (await poll(400)).at(-1);
await look(P, YAW_B);
const during = await poll(6000);
const settledB = during.at(-1);

// Frames in which the sky's rotation did not agree with the camera's, and the
// worst disagreement seen. Samples are grouped by the rendered frame they fell
// in, so this counts FRAMES, not polls.
const byFrame = new Map();
for (const s of during) if (!byFrame.has(s.frames)) byFrame.set(s.frames, s);
const frames = [...byFrame.values()].sort((a, b) => a.frames - b.frames);
const laggedFrames = frames.filter((s) => s.yawLagDeg > 0.5);
const sky = {
  jumpDeg: YAW_B - YAW_A,
  settledLagBeforeDeg: settledA.yawLagDeg,
  settledLagAfterDeg: settledB.yawLagDeg,
  worstLagDeg: Math.max(...frames.map((s) => s.yawLagDeg)),
  framesObserved: frames.length,
  framesDisagreeing: laggedFrames.length,
  firstFrames: frames.slice(0, 6).map((s) => ({ f: s.frames, cam: s.camYaw, sky: s.skyYaw, lag: s.yawLagDeg })),
};

// ---- weather: one frame of travel, against a 2 m snap ---------------------
await page.waitForTimeout(1500);
const before = (await poll(300)).at(-1);
await look([P[0] + JUMP_M, P[1], P[2]], YAW_B);
const moving = await poll(4000);
const wByFrame = new Map();
for (const s of moving) if (!wByFrame.has(s.frames)) wByFrame.set(s.frames, s);
const wFrames = [...wByFrame.values()].sort((a, b) => a.frames - b.frames);
const weather = {
  jumpM: JUMP_M,
  settledLagBeforeM: before.rainLagM,
  settledLagAfterM: wFrames.at(-1).rainLagM,
  worstLagM: Math.max(...wFrames.map((s) => s.rainLagM)),
  framesDisagreeing: wFrames.filter((s) => s.rainLagM > 0.5).length,
  framesObserved: wFrames.length,
  // What the lag is worth at speed: one frame of travel. The splash centre is
  // snapped to a 2 m grid before use, so anything under that is not expressible.
  metresPerFrameAt100kmh: { at30fps: +(27.8 / 30).toFixed(2), at60fps: +(27.8 / 60).toFixed(2) },
  splashSnapGridM: 2,
};

fs.writeFileSync('docs/lamp-viewlag.json', JSON.stringify({ sky, weather, errors }, null, 1));
await browser.close();
console.log('=== SKY (uRayMatrix rotation vs the camera quaternion) ===');
console.log(JSON.stringify(sky, null, 1));
console.log('\n=== WEATHER (rain volume centre vs camera position) ===');
console.log(JSON.stringify(weather, null, 1));
console.log(sky.worstLagDeg > 0.5
  ? `\nSKY LAGS: worst ${sky.worstLagDeg} deg over ${sky.framesDisagreeing} frame(s) after a ${sky.jumpDeg} deg jump`
  : '\nSKY DOES NOT LAG - the probe saw no frame where the two disagreed');
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
