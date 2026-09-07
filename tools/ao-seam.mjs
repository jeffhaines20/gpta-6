// HOW FAR ACROSS FLAT STONE DOES THE SEAM REACH, IN METRES?
//
// tools/ao-noise.mjs answers "how dark" (trough) and "how many columns are under
// half" (dark50). Neither answers the observation that actually names this
// defect, which a blind reviewer put like this:
//
//   "the left flank spans 13-18 px of flat stone with no geometry under it
//    before reaching the minimum. There is nothing there to occlude."
//
// A pixel count cannot be argued with or designed against, because it is not a
// property of the district: the same 0.3 m of masonry is 18 px at 30 m and 90 px
// at 6 m. What can be argued with is the reach in METRES ALONG THE SURFACE, and
// that is what this file measures -- occlusion read straight off post.aoBlurRT,
// the surface read by raycasting the scene the camera is actually looking at,
// and the two joined column by column.
//
// ---------------------------------------------------------------------------
// WHY OCCLUSION AND NOT LUMA
// ---------------------------------------------------------------------------
// Same argument as tools/ao-sweep.mjs. aoBlurRT is the AO term itself, before
// exposure, the tone curve and bloom, so a number off it survives the next
// lighting merge. ao-noise reads the composited frame on purpose -- it is
// measuring what a viewer sees -- and the two are complementary: if the reach
// falls here and the trough does not move there, the change did nothing.
//
// ---------------------------------------------------------------------------
// THE THREE HEADLINE NUMBERS
// ---------------------------------------------------------------------------
//   troughOcc    occlusion of the darkest column in the window.
//   shoulderOcc  occlusion of the flat stone the seam is cut into: the 20th
//                percentile of the columns in the window. Not the mean, which
//                the seam itself drags down, and not the minimum, which is one
//                pixel of whatever is brightest.
//   reachM       how far the seam extends onto flat stone. Walk out from the
//                trough column, AWAY from the depth step, to the last column
//                still above shoulder + REACH_FRAC of (trough - shoulder), and
//                report the distance in metres between the two surface points
//                the camera's rays land on. Also reported in px, so it can be
//                set beside the reviewer's own 13-18.
//
// REACHM IS DEFINED AGAINST THE PROFILE'S OWN SHOULDER AND TROUGH, which is the
// whole reason it can be compared across builds that differ in contrast. A test
// on an ABSOLUTE occlusion level ("still above 0.2") answers a different
// question every time the exponent or the radius moves, and would report a pure
// gain change as a reach change. --selftest asserts exactly this: the same
// profile scaled by 2 in contrast must read the SAME reach, and an
// absolute-threshold reading of it must not.
//
// AND THE DEPTH STEP IS FOUND, NOT ASSUMED. The window is scanned for the column
// pair with the largest view-space z jump; that is the junction. "Away from the
// step" means the side of the trough that continues onto the same surface, and
// the reach is only ever measured on columns whose ray hit within `--flatTol`
// metres of the plane fitted through the flat side. A column that has fallen off
// onto other geometry is not flat stone and does not count as reach.
//
//   node tools/ao-seam.mjs --selftest
//   node tools/ao-seam.mjs --port 8191 --cam fivepoints --tod noon
//   node tools/ao-seam.mjs --port 8191 --cam corridor --arms "base,rf:aoOccFalloff=0.25"
import { readPNG } from './png.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// The reviewer's own windows, widened enough that the flat stone on both sides
// of the seam is inside the frame the profile is normalised against.
export const WINDOWS = {
  fivepoints: { x0: 1140, x1: 1240, y0: 470, y1: 600 },
  corridor: { x0: 1230, x1: 1320, y0: 480, y1: 600 },
};
const REACH_FRAC = 0.10;

// ---------------------------------------------------------------------------
// THE PROFILE ANALYSIS, pure so it can be selftested without a browser
// ---------------------------------------------------------------------------
/**
 * @param {number[]} occ      occlusion per column, left to right
 * @param {number[]|null} px  metres-along-surface coordinate per column, or null
 * @param {number[]|null} flat  1 if the column's ray hit the flat plane, else 0
 * @param {number} stepIdx    index of the column pair holding the depth step
 */
export function analyseProfile(occ, px, flat, stepIdx, frac = REACH_FRAC) {
  const n = occ.length;
  if (n < 5) throw new Error('analyseProfile: window too narrow');
  const sorted = occ.slice().sort((a, b) => a - b);
  const shoulder = sorted[Math.max(0, Math.round(0.20 * (n - 1)))];
  let tIdx = 0;
  for (let i = 0; i < n; i++) if (occ[i] > occ[tIdx]) tIdx = i;
  const trough = occ[tIdx];
  const rise = trough - shoulder;
  // Which way is "away from the step"? The step sits between stepIdx and
  // stepIdx+1; the flat side is whichever side of the TROUGH does not cross it.
  const dir = tIdx <= stepIdx ? -1 : +1;
  const level = shoulder + frac * rise;
  let last = tIdx;
  for (let i = tIdx + dir; i >= 0 && i < n; i += dir) {
    if (flat && !flat[i]) break;              // fell off the flat plane
    if (occ[i] <= level) break;
    last = i;
  }
  const reachPx = Math.abs(last - tIdx);
  const reachM = px ? Math.abs(px[last] - px[tIdx]) : null;
  if (!Number.isFinite(trough) || !Number.isFinite(shoulder)) throw new Error('analyseProfile: non-finite');
  return { troughOcc: trough, shoulderOcc: shoulder, rise, troughIdx: tIdx, lastIdx: last,
    reachPx, reachM, dir, level };
}

// ---------------------------------------------------------------------------
// SELFTEST
// ---------------------------------------------------------------------------
if (has('selftest')) {
  const fails = [];
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };

  // A synthetic seam: flat stone at 0.05, a linear ramp 12 columns wide down to
  // a trough of 0.65 at the step, and different geometry beyond it.
  const N = 60, STEP = 40;
  const mk = (gain) => {
    const a = new Array(N).fill(0.05);
    for (let i = 0; i <= 12; i++) a[STEP - i] = 0.05 + gain * 0.60 * (1 - i / 13);
    for (let i = STEP + 1; i < N; i++) a[i] = 0.05;
    return a;
  };
  const xs = Array.from({ length: N }, (_, i) => i * 0.01);   // 1 cm per column
  const flat = Array.from({ length: N }, (_, i) => (i <= STEP ? 1 : 0));

  // THE EXPECTED ANSWER IS DERIVED, NOT OBSERVED. shoulder 0.05, trough 0.65,
  // rise 0.60, so the 10% level is 0.11; the ramp is 0.05 + 0.60*(1 - i/13),
  // which is above 0.11 while 1 - i/13 > 0.1, i.e. i <= 11. Eleven columns, not
  // the twelve the ramp is wide -- the first draft of this test asserted 12 and
  // the metric was right.
  const a1 = analyseProfile(mk(1), xs, flat, STEP);
  ok(a1.troughIdx === STEP, `trough found at the step column: ${a1.troughIdx}`);
  ok(a1.reachPx === 11, `a 12-column ramp crosses the 10% level at reachPx ${a1.reachPx}`);
  ok(Math.abs(a1.reachM - 0.11) < 1e-9, `and reachM ${a1.reachM.toFixed(4)} m at 1 cm per column`);

  // THE CONTRAST-INVARIANCE CLAIM, which is why this is a fraction of the
  // profile's own rise and not an absolute level.
  const a2 = analyseProfile(mk(2), xs, flat, STEP);
  ok(a2.reachPx === a1.reachPx, `doubling the contrast leaves reach at ${a2.reachPx}, not ${a1.reachPx}`);

  // KNOWN BAD: the absolute-threshold version of the same reading. It must
  // disagree, or the invariance above proves nothing.
  const absReach = (a, thr) => { let k = 0; while (a[STEP - k - 1] > thr && k < 30) k++; return k; };
  ok(absReach(mk(1), 0.20) !== absReach(mk(2), 0.20),
    `an absolute 0.20 threshold reads ${absReach(mk(1), 0.20)} then ${absReach(mk(2), 0.20)} on the same shape -- the metric this replaces`);

  // KNOWN BAD: no seam at all. A metric that measures from the window edge
  // rather than from the trough would report the whole window here.
  const flatOnly = analyseProfile(new Array(N).fill(0.05).map((v, i) => v + 1e-6 * i), xs, flat, STEP);
  ok(flatOnly.reachPx <= 1, `a profile with no seam reads reachPx ${flatOnly.reachPx}`);

  // KNOWN BAD: reach must stop where the surface stops. Same ramp, but the flat
  // mask says only 5 of those columns are on the plane.
  const flat5 = Array.from({ length: N }, (_, i) => (i > STEP - 6 && i <= STEP ? 1 : 0));
  const a3 = analyseProfile(mk(1), xs, flat5, STEP);
  ok(a3.reachPx === 5, `a 5-column flat mask clips the same ramp to ${a3.reachPx}`);

  // A ramp on the OTHER side of the step must be found too, or the tool only
  // works on the one seam it was written against.
  const b = new Array(N).fill(0.05);
  for (let i = 0; i <= 9; i++) b[STEP + 1 + i] = 0.05 + 0.60 * (1 - i / 10);
  const flatR = Array.from({ length: N }, (_, i) => (i > STEP ? 1 : 0));
  const a4 = analyseProfile(b, xs, flatR, STEP);
  // Same derivation on the other side: 0.05 + 0.60*(1 - i/10) > 0.11 while
  // i <= 8, so eight columns of a ten-column ramp.
  ok(a4.dir === +1 && a4.reachPx === 8, `a right-hand seam reads dir ${a4.dir} reach ${a4.reachPx}`);

  console.log(fails.length ? `\nSELFTEST FAILED (${fails.length})` : '\nSELFTEST PASSED');
  process.exit(fails.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// LIVE
// ---------------------------------------------------------------------------
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');
const fs = await import('node:fs');

const PORT = Number(arg('port', 8191));      // never 8123: that is the main tree
const TOD = arg('tod', 'noon');
const CAMNAME = arg('cam', 'fivepoints');
const TAG = arg('tag', 'aoseam');
const PEDS = Number(arg('peds', '0'));
const FLATTOL = Number(arg('flatTol', '0.06'));
const WIN = WINDOWS[CAMNAME];
if (!WIN) throw new Error(`unknown camera ${CAMNAME}`);
const W = 1600, H = 900;
const CAMS = {
  fivepoints: { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
  corridor: { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
};
const CAM = CAMS[CAMNAME];
const ARMS = (arg('arms', 'base') || 'base').split(',').map((spec) => {
  const [name, kv] = spec.split(':');
  const set = {};
  for (const pair of (kv || '').split(';').filter(Boolean)) {
    const [k, v] = pair.split('=');
    set[k] = Number(v);
  }
  return { name, set };
});

await ensureServer(PORT, 30000, { root: process.cwd() });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 300000 });
await page.addStyleTag({ content: '#attr{display:none!important} #hud,.pv-hud{display:none!important}' });
await page.evaluate(([t, n]) => {
  __district.setTraffic(0); __district.setPedestrians(n);
  __district.sky.cloudWind.set(0, 0);
  __district.setTimeOfDay(t);
}, [TOD, PEDS]);
await page.evaluate((c) => {
  const r = __district.district.meta.route, a = r[c.wpA], b = r[c.wpB];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = a.x - ux * c.back + -uz * c.side, pz = a.z - uz * c.back + ux * c.side;
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([px, c.height, pz], [a.x + ux * c.fwd, c.tgtY, a.z + uz * c.fwd], c.fov);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
}, CAM);

// ------------------------------------------------------------------ geometry
// One raycast per column, at the middle row of the window, against the scene the
// camera is looking at. Everything here is a property of the world and does not
// change between arms, so it is measured ONCE.
const geom = await page.evaluate(async ([win, ww, hh]) => {
  const THREE = await import('/vendor/three.module.min.js');
  const cam = __district.camera;
  cam.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  rc.far = 400;
  const y = Math.round((win.y0 + win.y1) / 2);
  const out = [];
  for (let x = win.x0; x <= win.x1; x++) {
    const ndc = new THREE.Vector2(((x + 0.5) / ww) * 2 - 1, -(((y + 0.5) / hh) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = rc.intersectObject(__district.scene, true);
    const h = hits.find((q) => q.object.visible && q.distance > 0.05);
    if (!h) { out.push(null); continue; }
    const p = h.point.clone();
    const v = p.clone().applyMatrix4(cam.matrixWorldInverse);
    out.push({ x, wx: p.x, wy: p.y, wz: p.z, vz: v.z, dist: h.distance,
      name: h.object.name || (h.object.geometry && h.object.geometry.type) || '?' });
  }
  return { y, cols: out, camPos: cam.position.toArray() };
}, [WIN, W, H]);

// The depth step: the adjacent column pair with the largest |dvz|. Found, not
// assumed -- see the header.
let stepIdx = 0, stepMag = -1;
for (let i = 0; i + 1 < geom.cols.length; i++) {
  const a = geom.cols[i], b = geom.cols[i + 1];
  if (!a || !b) continue;
  const d = Math.abs(a.vz - b.vz);
  if (d > stepMag) { stepMag = d; stepIdx = i; }
}
// Distance along the surface from the step, in metres, on each side. Measured
// between the actual 3D hit points, so a grazing wall is not read as if it were
// square to the camera.
const anchor = geom.cols[stepIdx] || geom.cols[0];
const along = geom.cols.map((c) => (c && anchor ? Math.hypot(c.wx - anchor.wx, c.wy - anchor.wy, c.wz - anchor.wz) * (c.x <= anchor.x ? -1 : 1) : null));

const readStrip = () => page.evaluate(([win, ww, hh]) => {
  const rt = __district.post.aoBlurRT, r = __district.renderer;
  const RW = rt.width, RH = rt.height;
  const x = Math.max(0, Math.round(win.x0 * RW / ww));
  const w = Math.min(RW - x, Math.round((win.x1 - win.x0 + 1) * RW / ww));
  const yTop = Math.round(win.y0 * RH / hh);
  const h = Math.min(RH - 1, Math.round((win.y1 - win.y0 + 1) * RH / hh));
  const yBot = Math.max(0, Math.min(RH - h, RH - (yTop + h)));
  const buf = new Uint8Array(w * h * 4);
  r.readRenderTargetPixels(rt, x, yBot, w, h, buf);
  // Column means, as OCCLUSION = 1 - ao/255.
  const col = new Array(w).fill(0);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) col[xx] += 1 - buf[(yy * w + xx) * 4] / 255;
  return { w, h, occ: col.map((v) => v / h) };
}, [WIN, W, H]);

const settle = async () => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 4, f0, { timeout: 900000, polling: 200 });
};
const applyArm = (set) => page.evaluate((st) => {
  const p = __district.postParams();
  if (!window.__aoDefaults) {
    const o = {}; for (const k in p) if (/^ao/.test(k)) o[k] = p[k];
    window.__aoDefaults = o;
  }
  Object.assign(p, window.__aoDefaults, st);
  p.aoEnabled = true;
  const out = {}; for (const k of Object.keys(window.__aoDefaults)) out[k] = p[k];
  return out;
}, set);

// Which columns are flat stone on the seam's own surface? Fit the plane through
// the columns on the flat side well clear of the step, then keep the columns
// whose hit point is within flatTol of it.
function flatMask(dirGuess) {
  // Fitted from the 12 columns starting 4 clear of the step, on the given side.
  const idx = [];
  for (let k = 4; k < 16; k++) {
    const i = stepIdx + dirGuess * k;
    if (i >= 0 && i < geom.cols.length && geom.cols[i]) idx.push(i);
  }
  if (idx.length < 4) return geom.cols.map(() => 0);
  // Plane through the first, middle and last of them.
  const P = idx.map((i) => geom.cols[i]);
  const a = P[0], b = P[Math.floor(P.length / 2)], c = P[P.length - 1];
  const u = [b.wx - a.wx, b.wy - a.wy, b.wz - a.wz], v = [c.wx - a.wx, c.wy - a.wy, c.wz - a.wz];
  let nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(...nrm) || 1; nrm = nrm.map((q) => q / L);
  return geom.cols.map((q) => {
    if (!q) return 0;
    const d = Math.abs((q.wx - a.wx) * nrm[0] + (q.wy - a.wy) * nrm[1] + (q.wz - a.wz) * nrm[2]);
    return d < FLATTOL ? 1 : 0;
  });
}

const results = [];
const run = async (arm, label) => {
  const params = await applyArm(arm.set);
  await settle();
  const strip = await readStrip();
  const occ = strip.occ;
  // Guess the seam's flat side from the profile, then build the mask for it.
  let tIdx = 0; for (let i = 0; i < occ.length; i++) if (occ[i] > occ[tIdx]) tIdx = i;
  const dirGuess = tIdx <= stepIdx ? -1 : +1;
  const mask = flatMask(dirGuess);
  const a = analyseProfile(occ, along, mask, stepIdx);
  results.push({ label, arm: arm.name, params, ...a, occ });
  console.log(`  ${label.padEnd(18)} trough ${a.troughOcc.toFixed(4)}  shoulder ${a.shoulderOcc.toFixed(4)}  ` +
    `rise ${a.rise.toFixed(4)}  reach ${String(a.reachPx).padStart(3)} px = ${a.reachM === null ? '  ?  ' : a.reachM.toFixed(3)} m`);
};

console.log(`\ncam ${CAMNAME}, tod ${TOD}, peds ${PEDS}, window x${WIN.x0}-${WIN.x1} y${WIN.y0}-${WIN.y1}`);
console.log(`depth step at column x=${geom.cols[stepIdx] && geom.cols[stepIdx].x}, |dvz| ${stepMag.toFixed(3)} m, ` +
  `surface ${geom.cols[stepIdx] ? geom.cols[stepIdx].dist.toFixed(1) : '?'} m out`);
for (const arm of ARMS) await run(arm, arm.name);
await run(ARMS[0], '__repeat');

// THE REPEAT GUARD, the same one ao-sweep and ao-noise carry: the first arm
// measured again at the end. If the world moved, every difference above is
// suspect and the run is void.
const a0 = results[0], rp = results[results.length - 1];
const dTrough = Math.abs(a0.troughOcc - rp.troughOcc);
const dReach = Math.abs(a0.reachPx - rp.reachPx);
const isVoid = dTrough > 0.004 || dReach > 1;
console.log(`\nrepeat of ${a0.arm}: trough d=${(rp.troughOcc - a0.troughOcc).toFixed(5)}  reach d=${rp.reachPx - a0.reachPx} px`);
console.log(isVoid ? 'REPEAT DISAGREES -- THE SWEEP IS VOID.' : 'repeat agrees; the sweep stands.');

if (has('dump')) {
  console.log('\ncol  x     dist    vz      alongM   flat   ' + results.map((r) => r.label.slice(0, 8).padStart(8)).join(''));
  for (let i = 0; i < geom.cols.length; i++) {
    const c = geom.cols[i];
    console.log(`${String(i).padStart(3)} ${String(c ? c.x : '-').padStart(5)} ${(c ? c.dist : NaN).toFixed(2).padStart(7)} ` +
      `${(c ? c.vz : NaN).toFixed(2).padStart(8)} ${(along[i] === null ? NaN : along[i]).toFixed(3).padStart(8)}  ` +
      `${flatMask(results[0].dir)[i]}     ` + results.map((r) => r.occ[i].toFixed(4).padStart(8)).join(''));
  }
}

fs.writeFileSync(`docs/ao-seam-${TAG}.json`, JSON.stringify({
  cam: CAMNAME, tod: TOD, peds: PEDS, port: PORT, window: WIN, stepIdx, stepMag,
  stepX: geom.cols[stepIdx] && geom.cols[stepIdx].x, void: isVoid,
  geom: geom.cols, along, results,
}, null, 1));
console.log(`\nwrote docs/ao-seam-${TAG}.json`);
if (errs.length) console.log('PAGE ERRORS:', errs);
await browser.close();
process.exit(isVoid ? 1 : 0);
