// What is actually wrong with the pedestrians in the near field?
//
// Blind critics keep reporting the crowd as the weakest thing in the frame at
// close range. Four hypotheses were handed over, and this file exists to rule
// each one IN OR OUT with a number rather than by reading the source:
//
//   1. polycount / LOD    - how many triangles is a ped, and how many pixels
//                           tall is the nearest one in the frame a critic saw?
//   2. face winding       - src/streetfurniture.js shipped 4,596 props whose far
//                           wall was wound backwards. Same class of defect here?
//                           Measured by rendering the crowd FrontSide vs
//                           DoubleSide: if the winding is right, front faces
//                           already cover every silhouette pixel and the delta is
//                           the noise floor. The POSITIVE CONTROL is a deliberate
//                           index flip, which must produce a large delta or this
//                           probe cannot see winding at all.
//   3. material response  - is the crowd lit by the sun / env / hemi, or is it
//                           ambient-only? One toggle each, pixels differenced.
//   4. pose at rest       - a T-pose or a frozen mid-stride reads as broken
//                           whatever the mesh is. Reported as joint angles.
//
// Plus the one hypothesis nobody listed: is the per-instance COLOUR reaching the
// fragment shader at all? Toggling material.vertexColors is a one-line probe.
//
// Method follows tools/sun-share.mjs, which is this project's template for a
// paired-capture measurement:
//   * nothing may move between paired frames - traffic is off and the crowd's
//     update() is replaced with a no-op, so every instance matrix is frozen;
//   * a NOISE FLOOR is measured first by capturing the same untouched frame
//     twice. Any delta below that floor is not a measurement;
//   * every delta is confined to a PEDESTRIAN MASK, derived by hiding the crowd
//     and differencing - so a change in the sky or the pavement cannot be read as
//     a change in the people.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TOD = process.env.PED_TOD ?? 'dusk';
const TAG = process.env.PED_TAG ?? 'pedaudit';
const CLOSE_M = Number(process.env.PED_CLOSE_M ?? 2.8);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

// The crowd must be the only thing in the frame that can differ between paired
// captures, so traffic goes to zero and stays there.
await page.evaluate(() => __district.setTraffic(0));
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);

// --- the frame the critics actually saw: the corridor hero camera, verbatim
// from tools/hero-shots.mjs (wpA 2, wpB 4, back 34, height 2.4, fov 55).
await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([a.x - (dx / len) * 34, 2.4, a.z - (dz / len) * 34],
    [a.x + (dx / len) * 260, 16, a.z + (dz / len) * 260], 55);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
});
await page.waitForTimeout(16000);

// ------------------------------------------------------------------ scene facts
const facts = await page.evaluate(() => {
  const P = __district.pedestrians();
  const cam = __district.camera;
  cam.updateMatrixWorld();
  const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const meshes = {};
  for (const k of ['shadows', 'torsos', 'heads', 'limbs']) {
    const m = P[k];
    meshes[k] = {
      geoTris: tri(m.geometry),
      instances: m.count,
      crowdTris: tri(m.geometry) * m.count,
      material: m.material.type,
      vertexColors: !!m.material.vertexColors,
      instanceColorSet: !!m.instanceColor,
      color: m.material.color ? m.material.color.getHexString() : null,
      envMapIntensity: m.material.envMapIntensity,
      roughness: m.material.roughness, metalness: m.material.metalness,
      castShadow: m.castShadow, receiveShadow: m.receiveShadow,
      side: m.material.side,
    };
  }
  // Nearest ped IN FRONT of the camera, and how big it is on screen. The pixel
  // height is the number that decides whether polycount can even be the fault.
  const fwd = new (Object.getPrototypeOf(cam.position).constructor)();
  cam.getWorldDirection(fwd);
  let best = null;
  for (const p of P.peds) {
    if (!p) continue;
    const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
    const d = Math.hypot(dx, dz);
    if (dx * fwd.x + dz * fwd.z <= 0) continue;         // behind the lens
    if (!best || d < best.d) best = { d, p };
  }
  let onScreen = null;
  if (best) {
    const g = __district.world.heightAt(best.p.x, best.p.z);
    const V = Object.getPrototypeOf(cam.position).constructor;
    const proj = (y) => {
      const v = new V(best.p.x, y, best.p.z).project(cam);
      return { x: (v.x * 0.5 + 0.5) * 1600, y: (-v.y * 0.5 + 0.5) * 900 };
    };
    const foot = proj(g - 0.05), head = proj(g + 1.72);
    onScreen = {
      distM: +best.d.toFixed(2),
      footPx: { x: Math.round(foot.x), y: Math.round(foot.y) },
      headPx: { x: Math.round(head.x), y: Math.round(head.y) },
      pixelHeight: Math.round(foot.y - head.y),
      speedMs: +best.p.v.toFixed(2),
    };
  }
  const dists = P.peds.filter(Boolean)
    .map((p) => Math.hypot(p.x - cam.position.x, p.z - cam.position.z)).sort((a, b) => a - b);
  return {
    alive: P.aliveCount, count: P.count,
    meshes,
    crowdTrisTotal: Object.values(meshes).reduce((s, m) => s + m.crowdTris, 0),
    nearest: onScreen,
    nearestFive: dists.slice(0, 5).map((d) => +d.toFixed(1)),
    envIntensity: __district.scene.environmentIntensity,
    sceneTriangles: __district.renderStats().triangles,
    sceneCalls: __district.renderStats().sceneCalls,
  };
});
console.log('\n--- SCENE FACTS (corridor hero camera, ' + TOD + ') ---');
console.log(JSON.stringify(facts, null, 1));

// A wide capture of the hero frame with the crowd where the critics saw it.
await page.screenshot({ path: `${OUT}/${TAG}-hero-${TOD}.png`, timeout: 180000 });

// ------------------------------------------------------------------ close-up
// Move to the nearest ped and stand CLOSE_M metres off it, at eye height. This
// is the near field the critique is about; the hero frame above says how far the
// nearest ped normally is, and this says what it looks like when it is near.
const framing = await page.evaluate((closeM) => {
  const P = __district.pedestrians();
  const cam = __district.camera;
  const alive = P.peds.filter(Boolean);
  if (!alive.length) return null;
  // Pick a ped with clear pavement around it: the one furthest from its
  // neighbours, so the close-up is of a person and not of a scrum.
  let best = null;
  for (const p of alive) {
    let near = Infinity;
    for (const q of alive) if (q !== p) near = Math.min(near, Math.hypot(q.x - p.x, q.z - p.z));
    const d = Math.hypot(p.x - cam.position.x, p.z - cam.position.z);
    const score = Math.min(near, 6) - d * 0.02;
    if (!best || score > best.score) best = { score, p, near, d };
  }
  const p = best.p;
  const g = __district.world.heightAt(p.x, p.z);
  // Stand off the ped's LEFT-FRONT quarter so the silhouette shows a limb break
  // rather than a head-on capsule.
  const a = p.yaw + 2.4;
  const cx = p.x + Math.sin(a) * closeM, cz = p.z + Math.cos(a) * closeM;
  __district.freeCam([cx, g + 1.45, cz], [p.x, g + 1.0, p.z], 42);
  return { x: +p.x.toFixed(1), z: +p.z.toFixed(1), yaw: +p.yaw.toFixed(2),
    v: +p.v.toFixed(2), nearestNeighbourM: +best.near.toFixed(1),
    camDistM: closeM, ground: +g.toFixed(2) };
}, CLOSE_M);
console.log('\nclose-up on ped', JSON.stringify(framing));
await page.waitForTimeout(4000);

// Freeze the crowd. Nothing may move between paired captures - this is the
// control the first version of sun-share.mjs did not have, and its absence made
// that probe report an impossible number.
await page.evaluate(() => {
  const P = __district.pedestrians();
  P.update = () => {};
});
await page.waitForTimeout(1500);

// --- pose of the ped at rest, straight out of the rig
const pose = await page.evaluate(() => {
  const P = __district.pedestrians();
  const cam = __district.camera;
  let best = null;
  for (const p of P.peds) {
    if (!p) continue;
    const d = Math.hypot(p.x - cam.position.x, p.z - cam.position.z);
    if (!best || d < best.d) best = { d, p };
  }
  if (!best) return null;
  const i = P.peds.indexOf(best.p);
  const M = new (Object.getPrototypeOf(P._m).constructor)();
  const out = {};
  const read = (mesh, slot) => {
    mesh.getMatrixAt(slot, M);
    const e = M.elements;
    // Determinant of the upper 3x3: negative means the instance mirrors the
    // geometry, which flips its winding. This is the streetfurniture defect.
    const det = e[0] * (e[5] * e[10] - e[6] * e[9])
      - e[4] * (e[1] * e[10] - e[2] * e[9])
      + e[8] * (e[1] * e[6] - e[2] * e[5]);
    return +det.toFixed(4);
  };
  out.slot = i;
  out.speedMs = +best.p.v.toFixed(3);
  out.torsoDet = read(P.torsos, i);
  out.headDet = read(P.heads, i);
  out.limbDets = [];
  for (let k = 0; k < 8; k++) out.limbDets.push(read(P.limbs, i * 8 + k));
  // Every determinant over the whole live crowd, so one mirrored instance cannot
  // hide behind a sample of one.
  let neg = 0, tot = 0;
  for (let j = 0; j < P.count; j++) {
    if (!P.peds[j]) continue;
    if (read(P.torsos, j) < 0) neg++;
    if (read(P.heads, j) < 0) neg++;
    tot += 2;
    for (let k = 0; k < 8; k++) { if (read(P.limbs, j * 8 + k) < 0) neg++; tot++; }
  }
  out.negativeDeterminantInstances = neg;
  out.instancesChecked = tot;
  return out;
});
console.log('pose / instance determinants:', JSON.stringify(pose));

// ------------------------------------------------------------------ pixels
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
async function shot(tag) {
  const f = `${OUT}/${TAG}-${TOD}-${tag}.png`;
  await page.screenshot({ path: f, timeout: 180000 });
  return f;
}
function imgOf(f) { return readPNG(f); }

// Restrict every reading to pixels the crowd actually paints.
function maskFrom(a, b, thresh = 8) {
  const A = imgOf(a), B = imgOf(b);
  const n = A.width * A.height;
  const m = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const ia = i * A.channels, ib = i * B.channels;
    if (Math.abs(lum(A.data, ia) - lum(B.data, ib)) > thresh) { m[i] = 1; count++; }
  }
  return { m, count, width: A.width, height: A.height };
}
function stats(file, mask, ref = null) {
  const I = imgOf(file);
  const R = ref ? imgOf(ref) : null;
  let r = 0, g = 0, b = 0, n = 0, diff = 0, changed = 0, clip = 0;
  for (let i = 0; i < mask.m.length; i++) {
    if (!mask.m[i]) continue;
    const ii = i * I.channels;
    r += I.data[ii]; g += I.data[ii + 1]; b += I.data[ii + 2]; n++;
    if (lum(I.data, ii) > 250) clip++;
    if (R) {
      const ir = i * R.channels;
      const d = Math.abs(lum(I.data, ii) - lum(R.data, ir));
      diff += d; if (d > 8) changed++;
    }
  }
  return {
    meanR: +(r / n).toFixed(1), meanG: +(g / n).toFixed(1), meanB: +(b / n).toFixed(1),
    meanLum: +((0.2126 * r + 0.7152 * g + 0.0722 * b) / n).toFixed(1),
    meanAbsDiff: R ? +(diff / n).toFixed(2) : null,
    pctChanged: R ? +((changed / n) * 100).toFixed(1) : null,
    clipPct: +((clip / n) * 100).toFixed(1),
    maskPx: n,
  };
}

// The variants. Each is applied to a clean baseline and then undone, so they do
// not compound.
const VAR = {
  hidepeds: () => { __district.pedestrians().root.visible = false; },
  showpeds: () => { __district.pedestrians().root.visible = true; },
  // Is the per-instance colour reaching the fragment shader? In this build
  // color_pars_fragment declares vColor only under USE_COLOR / USE_COLOR_ALPHA,
  // so USE_INSTANCING_COLOR alone writes a varying nobody reads.
  clothVC: () => { const P = __district.pedestrians();
    for (const m of [P.torsos.material, P.limbs.material]) { m.vertexColors = true; m.needsUpdate = true; } },
  clothVCoff: () => { const P = __district.pedestrians();
    for (const m of [P.torsos.material, P.limbs.material]) { m.vertexColors = false; m.needsUpdate = true; } },
  // Winding. DoubleSide can only differ from FrontSide where a front face is
  // MISSING - i.e. where the geometry is wound away from the camera.
  doubleSide: () => { const P = __district.pedestrians();
    for (const m of [P.torsos, P.heads, P.limbs]) { m.material.side = 2; m.material.needsUpdate = true; } },
  frontSide: () => { const P = __district.pedestrians();
    for (const m of [P.torsos, P.heads, P.limbs]) { m.material.side = 0; m.material.needsUpdate = true; } },
  // POSITIVE CONTROL: wind the crowd backwards on purpose. If this does not move
  // the pixels, the FrontSide/DoubleSide reading above proves nothing.
  flipWinding: () => { const P = __district.pedestrians();
    for (const m of [P.torsos, P.heads, P.limbs]) {
      const idx = m.geometry.index.array;
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      m.geometry.index.needsUpdate = true;
    } },
  nosun: () => __district.scene.traverse((o) => { if (o.isDirectionalLight) o.intensity = 0; }),
  noenv: () => { __district.scene.environmentIntensity = 0; },
  nohemi: () => __district.scene.traverse((o) => { if (o.isHemisphereLight) o.intensity = 0; }),
  nolamps: () => { __district.lightPool.enabled = false;
    __district.scene.traverse((o) => { if (o.isPointLight) { o.intensity = 0; o.visible = false; } }); },
};
const apply = async (name) => { await page.evaluate(`(${VAR[name].toString()})()`); await page.waitForTimeout(1400); };

// noise floor: the same untouched frame, twice.
const nA = await shot('noise-a');
await page.waitForTimeout(1400);
const nB = await shot('noise-b');

// the pedestrian mask
const base = await shot('base');
await apply('hidepeds');
const nop = await shot('nopeds');
await apply('showpeds');
const mask = maskFrom(base, nop, 8);
console.log(`\npedestrian mask: ${mask.count} px of ${mask.width * mask.height} ` +
  `(${((mask.count / (mask.width * mask.height)) * 100).toFixed(2)}% of frame)`);

const floor = stats(nB, mask, nA);
console.log(`noise floor over the mask: meanAbsDiff ${floor.meanAbsDiff}, ${floor.pctChanged}% of mask px`);
const baseStat = stats(base, mask);
console.log(`baseline over the mask: RGB ${baseStat.meanR}/${baseStat.meanG}/${baseStat.meanB} ` +
  `lum ${baseStat.meanLum}, ${baseStat.clipPct}% clipped`);

const rows = [];
async function probe(label, on, off) {
  await apply(on);
  const f = await shot(label);
  const s = stats(f, mask, base);
  if (off) await apply(off);
  const trust = s.meanAbsDiff > Math.max(floor.meanAbsDiff * 3, 0.5);
  rows.push({ label, ...s, aboveNoiseFloor: trust });
  console.log(`${label.padEnd(13)} meanAbsDiff ${String(s.meanAbsDiff).padStart(7)}  ` +
    `${String(s.pctChanged).padStart(5)}% of mask changed   RGB ${s.meanR}/${s.meanG}/${s.meanB}` +
    (trust ? '' : '   <- AT/BELOW NOISE FLOOR, not a measurement'));
  return s;
}

console.log('\n--- toggles, all differenced against the frozen baseline over the mask ---');
await probe('clothVC', 'clothVC', 'clothVCoff');
await probe('doubleSide', 'doubleSide', 'frontSide');
await probe('flipWinding', 'flipWinding', 'flipWinding');   // applied twice = restored
await probe('nosun', 'nosun', null);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.waitForTimeout(7000);
await probe('noenv', 'noenv', null);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.waitForTimeout(7000);
await probe('nohemi', 'nohemi', null);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.waitForTimeout(7000);
await probe('nolamps', 'nolamps', null);

fs.writeFileSync(`docs/${TAG}-${TOD}.json`,
  JSON.stringify({ tod: TOD, facts, framing, pose, mask: { px: mask.count },
    noiseFloor: floor, baseline: baseStat, rows }, null, 1));
console.log(`\nwrote docs/${TAG}-${TOD}.json`);
await browser.close();
