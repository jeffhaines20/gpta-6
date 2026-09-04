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
// The probe: compare the sky's captured view direction against the camera's own
// quaternion, which chase.update/lookAt writes directly and is never stale. Any
// window where those disagree is a frame in which the sky is drawn for one
// camera and the geometry for another.
//
// THREE arms, because the two causes are separable and a probe that can only see
// one of them will call a half fix a whole one:
//
//   turn  - chase.update() live, the camera yawing a KNOWN amount per frame.
//           Both causes are in play, and the expected reading is not "nonzero",
//           it is exactly one frame of turn. Run FIRST: freeCam() below replaces
//           chase.update with a no-op and there is no way back.
//   jump  - freeCam() to a new heading and poll. chase.update is dead by now, so
//           this arm isolates the stale-matrixWorld cause on its own, at a full
//           30 deg where a one-frame error is unmistakable.
//   stale - the opposite-reading check, and the only one that can fail a null
//           result. With the fix in place, the camera half of Sky.update is
//           replaced page-side by its own pre-fix body - the one that reads
//           camera.matrixWorld without refreshing it - and the jump arm is run
//           again. If the probe cannot make the lag come back on demand, the
//           probe is not measuring anything and its zero means nothing. The
//           patched function counts its own calls so "the toggle took" is
//           asserted rather than assumed.
//
// What is read matters as much as when. The sky's captured rotation is available
// two ways: Sky._camRotation, an intermediate, and the uRayMatrix uniform the
// dome vertex shader actually builds every view ray from. Both are reported. A
// fix that refreshed the intermediate but never reached the uniform would read
// as a pass on the first and a failure on the second.
//
// Same question for weather, whose only use of the camera is camera.position for
// the rain volume centre and the splash centre - and the splash centre is snapped
// to a 2 m grid before it is used, which is the number the lag has to beat to
// matter.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT = arg('--out', 'docs/lamp-viewlag.json');
const LABEL = arg('--label', '');
// Skip the stale arm on a build that has not been fixed yet: there is nothing to
// un-fix, and the jump arm is already showing the lag.
const WANT_STALE = !argv.includes('--no-stale');

const YAW_A = 0, YAW_B = 30;            // degrees; a 30 deg jump is easy to see
const JUMP_M = 10;                      // metres, for the weather arm
const TURN_RAD = 0.02;                  // radians of yaw added per simulated step
const TURN_DEG = (TURN_RAD * 180) / Math.PI;

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
// The district streams for ~30 s. A short fixed wait measures a half-built one.
await page.waitForTimeout(30000);

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
  // What the SHADER gets, which is the only reading that can be wrong on its
  // own. uRayMatrix = R * projectionMatrixInverse, and the centre of the screen
  // - NDC (0,0) - maps through it to the camera's forward in world space.
  const rm = d.sky.domeMaterial.uniforms.uRayMatrix.value;
  const r = new T.Vector4(0, 0, 1, 1).applyMatrix4(rm);
  const rx = r.x / r.w, rz = r.z / r.w;
  const uniYaw = Math.atan2(rx, rz) * 180 / Math.PI;
  const wrap = (a) => ((a % 360) + 540) % 360 - 180;
  const c = d.weather.rainMaterial.uniforms.uCenter.value;
  const s = d.weather.splashMaterial.uniforms.uCenter.value;
  const snap = (v) => Math.round(v / 2) * 2;
  return {
    frames: d.frames,
    camYaw: +camYaw.toFixed(3), skyYaw: +skyYaw.toFixed(3), uniYaw: +uniYaw.toFixed(3),
    yawLagDeg: +Math.abs(wrap(camYaw - skyYaw)).toFixed(3),
    uniLagDeg: +Math.abs(wrap(camYaw - uniYaw)).toFixed(3),
    camPos: [+cam.position.x.toFixed(3), +cam.position.z.toFixed(3)],
    speedKmh: +(d.vehicle.speed * 3.6).toFixed(1),
    rainCentre: [+c.x.toFixed(2), +c.z.toFixed(2)],
    rainLagM: +Math.hypot(cam.position.x - c.x, cam.position.z - c.z).toFixed(3),
    splashCentre: [+s.x.toFixed(2), +s.z.toFixed(2)],
    // Does the lag survive the 2 m snap? This is the splash centre the CURRENT
    // camera position would have produced, against the one that is actually set.
    splashWouldBe: [snap(cam.position.x), snap(cam.position.z)],
    splashDiffers: snap(cam.position.x) !== s.x || snap(cam.position.z) !== s.z,
    splashGridM: 2,
    staleRan: d.sky.__staleRan ?? null,
  };
}`;

const P = await page.evaluate(() => {
  const r = __district.district.meta.route, a = r[2];
  return [a.x, 5.2, a.z];
});
// Returns the frame counter AT the instant of the jump, and every arm that jumps
// needs it.
//
// freeCam() mutates the camera BETWEEN frames, so the last completed frame - call
// it F - was drawn with the old heading in both the camera and the sky, and they
// agreed at the time. A poll landing after the jump but before frame F+1 still
// reads `frames === F`, sees the new camera against F's sky, and reports the full
// jump. That frame is a hole in the instrument, not a lag in the render: it read
// 30 deg on the FIXED build too, which is what exposed it. Only frames strictly
// after F were drawn with the new camera and can be judged.
const look = (pos, yawDeg) => page.evaluate(({ p, th }) => {
  __district.freeCam(p, [p[0] + Math.cos(th) * 300, p[1], p[2] + Math.sin(th) * 300], 48);
  return __district.frames;
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

// One sample per RENDERED frame. Polling is far faster than the software
// rasteriser, so several samples land inside the same frame and counting polls
// would count the same frame many times.
// `after` drops the frame that was already drawn when the jump happened - see
// look() above. The turn arm passes nothing: it moves the camera from inside the
// frame, through the autopilot hook, so every sample it takes describes a frame
// in which both values were written and there is no hole to close.
const byFrame = (samples, after = -Infinity) => {
  const m = new Map();
  for (const s of samples) if (s.frames > after && !m.has(s.frames)) m.set(s.frames, s);
  return [...m.values()].sort((a, b) => a.frames - b.frames);
};

const summarise = (frames, extra = {}) => {
  // Math.max of nothing is -Infinity, which reads as "no lag" and is the exact
  // shape of null result this probe exists to avoid.
  if (!frames.length) throw new Error(`no frames observed for arm ${JSON.stringify(extra)}`);
  return {
  ...extra,
  worstLagDeg: Math.max(...frames.map((s) => s.yawLagDeg)),
  worstUniformLagDeg: Math.max(...frames.map((s) => s.uniLagDeg)),
  framesObserved: frames.length,
  framesDisagreeing: frames.filter((s) => s.yawLagDeg > 0.5).length,
  uniformFramesDisagreeing: frames.filter((s) => s.uniLagDeg > 0.5).length,
  firstFrames: frames.slice(0, 6).map((s) => ({
    f: s.frames, cam: s.camYaw, sky: s.skyYaw, uni: s.uniYaw, lag: s.yawLagDeg, uniLag: s.uniLagDeg,
  })),
  };
};

// ---- arm 1: turn. chase.update() alive, a known yaw per frame -------------
//
// Must run before any freeCam(): freeCam replaces chase.update with a no-op.
const TURN_ON = `() => {
  const d = __district;
  d.chase.yaw = 0;
  d.__turnSteps = 0;
  d.setAutopilot(() => {
    // Parked, so ChaseCamera's auto-align (which only engages above 3 m/s)
    // cannot pull the yaw and the per-frame turn stays exactly what is set here.
    d.vehicle.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: true });
    d.chase.yaw += ${TURN_RAD};
    d.__turnSteps++;
  });
  return { armed: true, yaw: d.chase.yaw };
}`;
const turnArmed = await page.evaluate(`(${TURN_ON})()`);
await page.waitForTimeout(3000);
const turning = await poll(9000);
const turnFrames = byFrame(turning);
const turnSteps = await page.evaluate(() => __district.__turnSteps);
if (!turnArmed.armed || !(turnSteps > 0)) {
  throw new Error(`turn arm never ran: armed=${turnArmed.armed} steps=${turnSteps}`);
}
const turn = summarise(turnFrames, {
  degPerFrame: +TURN_DEG.toFixed(3),
  autopilotSteps: turnSteps,
  // The reading this arm predicts if the sky is one frame behind. Not "nonzero":
  // a number, so a wrong one is visible.
  expectedLagIfStaleDeg: +TURN_DEG.toFixed(3),
});
await page.evaluate(() => __district.setAutopilot(() => {}));

// ---- arm 1b: drive. the only arm that can see weather's ordering ---------
//
// The jump arm below cannot, and a null result from it would mean nothing.
// freeCam() writes camera.position DIRECTLY, and unlike matrixWorld a direct
// property write is authoritative the instant it happens - so with chase.update
// dead there is nothing for weather.update() to be stale against and it reads a
// clean zero on the broken build. weather's only exposure is the ordering cause,
// and the ordering cause needs chase.update() alive and the camera travelling.
//
// So: drive. Then the rain volume centre's lag can be compared against the
// distance the camera actually covered in that frame. One frame of travel is the
// reading the ordering bug predicts; anything else means something is wrong.
const DRIVE_ON = `() => {
  const d = __district;
  d.__driveSteps = 0;
  d.setAutopilot(() => {
    d.vehicle.setControls({ throttle: 1, brake: 0, steer: 0.12, handbrake: false });
    d.__driveSteps++;
  });
  return { armed: true };
}`;
const driveArmed = await page.evaluate(`(${DRIVE_ON})()`);
await page.waitForTimeout(6000);
const driving = await poll(10000);
const driveSteps = await page.evaluate(() => __district.__driveSteps);
if (!driveArmed.armed || !(driveSteps > 0)) {
  throw new Error(`drive arm never ran: armed=${driveArmed.armed} steps=${driveSteps}`);
}
const driveFrames = byFrame(driving);
// Per-frame camera travel, from consecutive sampled frames. Only consecutive
// frame indices are comparable; a gap means a frame went unsampled.
const driveRows = [];
for (let i = 1; i < driveFrames.length; i++) {
  const a = driveFrames[i - 1], b = driveFrames[i];
  if (b.frames !== a.frames + 1) continue;
  const travel = Math.hypot(b.camPos[0] - a.camPos[0], b.camPos[1] - a.camPos[1]);
  driveRows.push({
    f: b.frames,
    kmh: b.speedKmh,
    travelM: +travel.toFixed(3),
    rainLagM: b.rainLagM,
    // If the rain centre is exactly one frame behind, this is ~1.
    lagInFrames: travel > 0.05 ? +(b.rainLagM / travel).toFixed(3) : null,
    yawLagDeg: b.yawLagDeg,
    splashDiffers: b.splashDiffers,
  });
}
if (!driveRows.length) throw new Error('drive arm: no consecutive frame pairs sampled');
const rated = driveRows.filter((r) => r.lagInFrames !== null);
const drive = {
  autopilotSteps: driveSteps,
  framesObserved: driveFrames.length,
  framePairs: driveRows.length,
  topSpeedKmh: Math.max(...driveRows.map((r) => r.kmh)),
  medianTravelM: +[...driveRows.map((r) => r.travelM)].sort((a, b) => a - b)[driveRows.length >> 1].toFixed(3),
  worstRainLagM: Math.max(...driveRows.map((r) => r.rainLagM)),
  // The verdict number. ~1.0 means the rain volume is exactly one frame of
  // travel behind the camera; ~0 means it is not behind at all.
  medianLagInFrames: rated.length
    ? +[...rated.map((r) => r.lagInFrames)].sort((a, b) => a - b)[rated.length >> 1].toFixed(3)
    : null,
  worstSkyYawLagDeg: Math.max(...driveRows.map((r) => r.yawLagDeg)),
  splashFramesDiffering: driveRows.filter((r) => r.splashDiffers).length,
  rows: driveRows.slice(0, 10),
};
await page.evaluate(() => {
  __district.setAutopilot(() => {});
  __district.vehicle.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: true });
});
await page.waitForTimeout(3000);

// ---- arm 2: jump. one frame of rotation, or none? ------------------------
await look(P, YAW_A);
await page.waitForTimeout(4000);
const settledA = (await poll(400)).at(-1);
const atJump = await look(P, YAW_B);
const during = await poll(6000);
const settledB = during.at(-1);
const jumpFrames = byFrame(during, atJump);
const sky = summarise(jumpFrames, {
  jumpDeg: YAW_B - YAW_A,
  frameAtJump: atJump,
  framesBeforeExclusion: byFrame(during).length,
  settledLagBeforeDeg: settledA.yawLagDeg,
  settledLagAfterDeg: settledB.yawLagDeg,
  // Sanity, not a finding: at rest the uniform-derived heading and the camera's
  // own must be the same number. If they are not, the uniform is being read
  // wrong and every reading above it is noise.
  settledCamYaw: settledA.camYaw,
  settledUniformYaw: settledA.uniYaw,
});

// ---- arm 3: weather. one frame of travel, against a 2 m snap -------------
await page.waitForTimeout(1500);
const before = (await poll(300)).at(-1);
const wAtJump = await look([P[0] + JUMP_M, P[1], P[2]], YAW_B);
const moving = await poll(4000);
const wFrames = byFrame(moving, wAtJump);
if (!wFrames.length) throw new Error('weather arm observed no frames after the jump');
const weather = {
  jumpM: JUMP_M,
  frameAtJump: wAtJump,
  framesBeforeExclusion: byFrame(moving).length,
  settledLagBeforeM: before.rainLagM,
  settledLagAfterM: wFrames.at(-1).rainLagM,
  worstLagM: Math.max(...wFrames.map((s) => s.rainLagM)),
  framesDisagreeing: wFrames.filter((s) => s.rainLagM > 0.5).length,
  framesObserved: wFrames.length,
  // What the lag is worth at speed: one frame of travel. The splash centre is
  // snapped to a 2 m grid before use, so anything under that is not expressible.
  metresPerFrameAt100kmh: { at30fps: +(27.8 / 30).toFixed(2), at60fps: +(27.8 / 60).toFixed(2) },
  splashSnapGridM: 2,
  // The rain volume is a 13 m half-extent box re-centred on the camera, so the
  // lag is also worth stating as a fraction of the thing it displaces.
  rainVolumeHalfExtentM: 13,
  splashFramesDiffering: wFrames.filter((s) => s.splashDiffers).length,
  splashSettledDiffers: wFrames.at(-1).splashDiffers,
};

// ---- arm 4: the opposite reading ----------------------------------------
//
// Put the pre-fix camera code back, page-side, and check the probe still sees the
// bug. A null result from an instrument that cannot produce a positive one is not
// evidence of anything.
let stale = null;
if (WANT_STALE) {
  const BREAK = `() => {
    const s = __district.sky;
    if (typeof s.updateView !== 'function') {
      return { ok: false, why: 'Sky has no updateView - build is unfixed, nothing to un-fix' };
    }
    if (s.__origUpdateView) return { ok: false, why: 'already patched' };
    s.__origUpdateView = s.updateView;
    // The pre-fix body, verbatim apart from the counter: reads matrixWorld
    // without refreshing it first.
    s.updateView = function (camera) {
      const u = this.domeMaterial.uniforms;
      this._rayMatrix.copy(camera.projectionMatrixInverse);
      this._camRotation.extractRotation(camera.matrixWorld);
      this._rayMatrix.premultiply(this._camRotation);
      u.uRayMatrix.value.copy(this._rayMatrix);
      this.__staleRan++;
      return this;
    };
    s.__staleRan = 0;
    return { ok: true, swapped: s.updateView !== s.__origUpdateView };
  }`;
  const patch = await page.evaluate(`(${BREAK})()`);
  if (!patch.ok) {
    stale = { ran: false, why: patch.why };
  } else {
    if (!patch.swapped) throw new Error('stale arm: updateView was not replaced');
    await look(P, YAW_A);
    await page.waitForTimeout(4000);
    const sAtJump = await look(P, YAW_B);
    const staleDuring = await poll(6000);
    const staleFrames = byFrame(staleDuring, sAtJump);
    const ran = staleFrames.at(-1).staleRan;
    // THE assertion. A page-side switch passed as a string that Playwright
    // evaluates and throws away leaves both arms identical and both readings
    // clean. The patched function counts itself; if the count is zero the arm
    // never ran and the reading is discarded rather than reported.
    if (!(ran > 0)) throw new Error(`stale arm: patched updateView never ran (count ${ran})`);
    stale = summarise(staleFrames, {
      ran: true,
      patchedCalls: ran,
      jumpDeg: YAW_B - YAW_A,
      frameAtJump: sAtJump,
      settledLagAfterDeg: staleFrames.at(-1).yawLagDeg,
    });
  }
}

const out = { label: LABEL, turn, drive, sky, weather, stale, errors };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
await browser.close();
console.log(`=== TURN (chase.update live, ${TURN_DEG.toFixed(3)} deg of yaw per frame) ===`);
console.log(JSON.stringify(turn, null, 1));
console.log('\n=== JUMP (uRayMatrix rotation vs the camera quaternion) ===');
console.log(JSON.stringify(sky, null, 1));
console.log('\n=== DRIVE (chase.update live and the camera travelling) ===');
console.log(JSON.stringify(drive, null, 1));
console.log('\n=== WEATHER JUMP (rain volume centre vs camera position; see the note - this arm is blind to the ordering cause) ===');
console.log(JSON.stringify(weather, null, 1));
if (stale) {
  console.log('\n=== STALE (opposite-reading check: pre-fix camera code, page-side) ===');
  console.log(JSON.stringify(stale, null, 1));
}
console.log(sky.worstLagDeg > 0.5
  ? `\nSKY LAGS: worst ${sky.worstLagDeg} deg over ${sky.framesDisagreeing} frame(s) after a ${sky.jumpDeg} deg jump`
  : '\nSKY DOES NOT LAG - the probe saw no frame where the two disagreed');
console.log(turn.worstLagDeg > 0.5
  ? `TURN LAGS: worst ${turn.worstLagDeg} deg against ${turn.degPerFrame} deg of turn per frame`
  : `TURN DOES NOT LAG - ${turn.framesObserved} frames of live ${turn.degPerFrame} deg/frame yaw, none disagreeing`);
if (stale && stale.ran) {
  console.log(stale.worstLagDeg > 0.5
    ? `OPPOSITE READING OK: the un-fixed path still reads ${stale.worstLagDeg} deg (${stale.patchedCalls} patched calls)`
    : `PROBE SUSPECT: the un-fixed path read ${stale.worstLagDeg} deg - the instrument cannot see the bug`);
}
console.log(`wrote ${OUT}`);
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
