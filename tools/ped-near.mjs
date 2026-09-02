// Near-field pedestrian quality, measured on ONE deterministic subject.
//
// tools/ped-audit.mjs ruled out winding, material response and per-instance
// colour, and ruled IN the near-field silhouette: in the corridor hero frame the
// nearest ped stands 8.18 m from the lens and is 265 px tall in a 900 px frame,
// and the mesh serving that pixel size is the same one authored for the far
// pavement - 6-sided limb capsules, an 8-sided torso and a 7x5 sphere head.
//
// This file is the before/after instrument for that finding. It cannot compare
// two browser runs directly, because the crowd is random and a different ped in a
// different pose is a different measurement. So it BUILDS ITS OWN SUBJECT:
//
//   * the crowd's update() is replaced with a no-op, so nothing moves;
//   * every slot is hidden and slot 0 is overwritten with a fixed ped - fixed
//     position, yaw, gait phase, height, build and palette - and posed once
//     through the real _writePose(), so the geometry under test is the shipping
//     geometry driven by the shipping rig;
//   * the camera is placed at a fixed offset and yaw about that ped.
//
// Every number below is therefore comparable across runs and across commits.
// Metrics, all confined to boxes derived from the subject's own joint positions
// read back out of the instance matrices:
//
//   silhouettePx  mask pixels the ped paints           - how big the subject is
//   headPx        mask pixels inside the head box      - a coarse sphere's
//                 silhouette is an inscribed polygon, so it is MISSING area
//   footPx        mask pixels inside the ankle box     - is there a foot at all
//   creaseMedian  mean over rows of the MEDIAN |L(x-2) - 2L(x) + L(x+2)| across
//                 the middle of the shank - a facet boundary on an interpolated
//                 capsule is a kink in luminance, and this is the size of a
//                 typical one. The per-row MAX is reported beside it: a median
//                 that falls while the max stays put means the facets went and
//                 an edge did not.
//
// A NOISE FLOOR is measured first by capturing the same untouched frame twice.
//
// The SILHOUETTE half of the claim is measured by tools/silhouette.mjs, run over
// the captures this file writes:
//
//   node tools/silhouette.mjs docs/shots/near-dusk-farLOD.png \
//        docs/shots/near-dusk-farLOD-noped.png 731 204 869 285
//
// It is a separate file because the box matters: run over the whole head BOX it
// reads 1.404 -> 1.366 and discriminates nothing, because that box includes the
// shoulders and it ends up measuring the outline of the torso. Restricted to the
// crown - rows 204-285 here - the same code reads 0.438 -> 0.320 RMS and 0.939
// -> 0.597 p95, consistently across three window choices. Confirm what is IN the
// sample before believing what comes out of it.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import { writePNG } from './crop.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TOD = process.env.NEAR_TOD ?? 'dusk';
const TAG = process.env.NEAR_TAG ?? 'near';
// Camera stand-off. 3.4 m is a third-person shoulder camera's distance to
// somebody the player has walked up to; 8.2 m is where the corridor hero frame
// puts its nearest ped.
const DIST = Number(process.env.NEAR_DIST ?? 3.4);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message, '\n', (e.stack || '').split('\n').slice(0, 4).join('\n')));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate(() => __district.setTraffic(0));
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);

// --- where the crowd stands relative to the hero camera, before anything is
// frozen. This is the context the near-field claim rests on.
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
const spread = await page.evaluate(() => {
  const P = __district.pedestrians();
  const cam = __district.camera;
  cam.updateMatrixWorld();
  const V = Object.getPrototypeOf(cam.position).constructor;
  const fwd = new V(); cam.getWorldDirection(fwd);
  const d = [];
  for (const p of P.peds) {
    if (!p) continue;
    const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
    if (dx * fwd.x + dz * fwd.z <= 0) continue;
    d.push(Math.hypot(dx, dz));
  }
  d.sort((a, b) => a - b);
  const px = (dist) => {
    // Height in pixels of a 1.72 m figure at `dist` metres: 900 px over the
    // vertical field of view.
    const f = 900 / (2 * Math.tan((__district.camera.fov * Math.PI) / 360));
    return Math.round((1.72 / dist) * f);
  };
  const under = (m) => d.filter((x) => x <= m).length;
  return {
    inFrontOfLens: d.length,
    nearest: d.slice(0, 6).map((x) => +x.toFixed(1)),
    pixelHeightOfNearest: d.length ? px(d[0]) : null,
    within: { '10m': under(10), '15m': under(15), '20m': under(20),
      '25m': under(25), '30m': under(30), '40m': under(40) },
    pixelHeightAt: { '8m': px(8), '15m': px(15), '24m': px(24), '40m': px(40) },
  };
});
console.log(`\ncrowd in front of the corridor hero lens: ${spread.inFrontOfLens}`);
console.log(`  nearest (m): ${spread.nearest.join(', ')}  -> nearest is ${spread.pixelHeightOfNearest} px tall`);
console.log(`  within: ${JSON.stringify(spread.within)}`);
console.log(`  a 1.72 m figure is this tall in px: ${JSON.stringify(spread.pixelHeightAt)}`);

// ------------------------------------------------------------------ the subject
// One ped, fixed in every respect, posed by the real rig. Placed on the pavement
// beside the hero camera so it stands on real ground with real surroundings.
const SUBJECT = await page.evaluate((dist) => {
  const P = __district.pedestrians();
  P.update = () => {};                        // nothing moves from here on
  for (let i = 0; i < P.count; i++) { P._shown[i] = 1; P._hide(i); P.peds[i] = null; }

  // Stand it where the crowd already walks: the pavement point nearest the hero
  // camera that a live ped was occupying, rounded so it is stable.
  const cam = __district.camera;
  const V = Object.getPrototypeOf(cam.position).constructor;
  const fwd = new V(); cam.getWorldDirection(fwd);
  const px = Math.round(cam.position.x + fwd.x * 12);
  const pz = Math.round(cam.position.z + fwd.z * 12);

  const ped = {
    id: 1, edge: 0, side: 0, forward: true, walk: null, node: 0,
    x: px, z: pz, yaw: 0.9,
    v: 1.35, phase: 1.15, stuck: 0, turned: false, lateral: 0,
    // A LIGHT-clothed member of the population, deliberately.
    //
    // The first subject wore the palette's navy shirt and charcoal trousers, and
    // at dusk those measure 1-10 out of 255: the crease metric was differencing
    // black against black and reading quantisation noise. These three are all
    // straight out of SKIN/SHIRT/PANTS in src/pedestrians.js - a real ped, not a
    // test material - and they carry enough light for a shading measurement.
    skin: 0xefc9a6, shirt: 0xd9d3c6, pants: 0x6b6152, bare: false,
    hscale: 1.02, build: 1.0, desired: 1.35, laneJitter: 0.5,
  };
  const legLen = 0.838 * ped.hscale;
  ped.stride = legLen * 1.52 * (0.86 + 0.14 * (ped.v / 1.35));
  P.peds[0] = ped;
  P._writeColors(0, ped);
  P._writePose(0, ped, legLen);
  P.aliveCount = 1;
  for (const m of [P.shadows, P.torsos, P.heads, P.limbs]) m.instanceMatrix.needsUpdate = true;
  if (P.nearLimbs) for (const m of [P.nearTorsos, P.nearHeads, P.nearLimbs]) m.instanceMatrix.needsUpdate = true;
  for (const m of [P.torsos, P.heads, P.limbs]) if (m.instanceColor) m.instanceColor.needsUpdate = true;

  const g = __district.world.heightAt(ped.x, ped.z);
  // Three-quarter front view from the ped's left: the angle that shows a limb
  // break, a shoulder and a jawline all at once, which is the view a mannequin
  // fails at.
  const a = ped.yaw + 2.35;
  __district.freeCam([ped.x + Math.sin(a) * dist, g + 1.42, ped.z + Math.cos(a) * dist],
    [ped.x, g + 0.95, ped.z], 40);
  return { x: ped.x, z: ped.z, ground: +g.toFixed(2), yaw: ped.yaw, dist };
}, DIST);
console.log(`\nsubject at (${SUBJECT.x}, ${SUBJECT.z}), ground ${SUBJECT.ground}, ` +
  `camera ${SUBJECT.dist} m off at 3/4 front`);
await page.waitForTimeout(2500);

// --- joint positions, read back out of the instance matrices, projected to
//     pixels. Every metric box below is derived from these, so no box is a guess.
const boxes = await page.evaluate(() => {
  const P = __district.pedestrians();
  // Read the joints off the FAR tier, whose slot layout is fixed and known:
  // 8 bones per ped, [thighL, shankL, thighR, shankR, upperL, foreL, upperR,
  // foreR]. Forcing the far tier first means one box definition serves both
  // measurements, which is the point - the boxes must not move between them.
  if (P.setNearLod) {
    P.setNearLod(0);
    if (P._assignNearLod) P._assignNearLod(P.peds[0].x, P.peds[0].z);
    P._writePose(0, P.peds[0], 0.838 * P.peds[0].hscale);
    if (P._syncNearCounts) P._syncNearCounts();
  }
  const cam = __district.camera;
  cam.updateMatrixWorld();
  const V = Object.getPrototypeOf(cam.position).constructor;
  const M = new (Object.getPrototypeOf(P._m).constructor)();
  const at = (mesh, slot) => { mesh.getMatrixAt(slot, M);
    return new V(M.elements[12], M.elements[13], M.elements[14]); };
  const proj = (v) => { const q = v.clone().project(cam);
    return { x: (q.x * 0.5 + 0.5) * 1600, y: (-q.y * 0.5 + 0.5) * 900 }; };
  const head = at(P.heads, 0);
  const hipL = at(P.limbs, 0);
  const kneeL = at(P.limbs, 1);
  const kneeR = at(P.limbs, 3);
  // Ankle from the shank's own matrix: a bone's far end is pivot - LIMB_BASE *
  // (its second basis column), because that column is the rotated Y axis times
  // the y scale, and the y scale IS len / LIMB_BASE. No bone length needed.
  const shankMid = (() => {
    P.limbs.getMatrixAt(1, M);
    const e = M.elements;
    const kx = e[12], ky = e[13], kz = e[14];
    const ax = kx - 0.5 * e[4], ay = ky - 0.5 * e[5], az = kz - 0.5 * e[6];
    const lerp = (t) => [kx + (ax - kx) * t, ky + (ay - ky) * t, kz + (az - kz) * t];
    const A = lerp(0.30), B = lerp(0.70);
    return { ax: A[0], ay: A[1], az: A[2], bx: B[0], by: B[1], bz: B[2] };
  })();
  const ped = P.peds[0];
  const g = __district.world.heightAt(ped.x, ped.z);
  const rect = (c, halfW, halfH) => {
    const p = proj(c);
    return { x0: Math.round(p.x - halfW), y0: Math.round(p.y - halfH),
      x1: Math.round(p.x + halfW), y1: Math.round(p.y + halfH) };
  };
  // Pixels per metre at the subject's depth, so the boxes are metric.
  const f = 900 / (2 * Math.tan((cam.fov * Math.PI) / 360));
  const depth = cam.position.distanceTo(new V(ped.x, g + 1, ped.z));
  const ppm = f / depth;
  return {
    ppm: +ppm.toFixed(1),
    whole: rect(new V(ped.x, g + 0.9, ped.z), 0.62 * ppm, 1.06 * ppm),
    head: rect(head, 0.19 * ppm, 0.22 * ppm),
    // Crease band: the middle 40% of the LEFT SHANK.
    //
    // It was the thigh on the first pass and that was a bad sample. The near
    // tier hangs a HAND at thigh height - which is where a hand hangs - so the
    // box picked up a skin-on-trouser silhouette edge and the metric read 10.56
    // -> 19.67 with a p90 of 46.78: the number moved the wrong way because the
    // sample had changed, not because the shading had. The shank between 30% and
    // 70% of knee-to-ankle is bare shaft in BOTH tiers: no hand, no shoe, no
    // pelvis, and clear of the near tier's own joint-occlusion vertex shading,
    // which lives in the top 14% and bottom 10% of a bone.
    shank: (() => {
      const a = new V(shankMid.ax, shankMid.ay, shankMid.az);
      const b = new V(shankMid.bx, shankMid.by, shankMid.bz);
      const pa = proj(a), pb = proj(b), mid = proj(a.clone().add(b).multiplyScalar(0.5));
      return { x0: Math.round(mid.x - 0.075 * ppm), x1: Math.round(mid.x + 0.075 * ppm),
        y0: Math.round(Math.min(pa.y, pb.y)), y1: Math.round(Math.max(pa.y, pb.y)) };
    })(),
    // Ankle box: where a shoe would be if there were one.
    foot: rect(new V(ped.x, g + 0.06, ped.z), 0.55 * ppm, 0.20 * ppm),
    kneeR: proj(kneeR),
  };
});
for (const b of Object.values(boxes)) {
  if (!b || b.x0 === undefined) continue;
  b.x0 = Math.max(0, b.x0); b.y0 = Math.max(0, b.y0);
  b.x1 = Math.min(1600, b.x1); b.y1 = Math.min(900, b.y1);
}
console.log('metric boxes (px):', JSON.stringify(boxes));

// ------------------------------------------------------------------ pixels
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
async function shot(tag) {
  const f = `${OUT}/${TAG}-${TOD}-${tag}.png`;
  await page.screenshot({ path: f, timeout: 180000 });
  return f;
}
// The mask pass hides the BODY only and leaves the contact blob in place, and it
// runs with AO and bloom off. Both matter: screen-space AO and a bloom halo both
// change pixels the body never covers, and the first run of this probe read a
// foot box that was 83% "pedestrian" because the ground under the ped changed
// when the ped was removed. A mask that includes the ground is not a silhouette.
// Re-pose the frozen subject. update() is a no-op from here on, so every step
// update() would have taken has to be taken by hand: choose the tier, assign the
// near slot, write the pose, then sync the near meshes' instance counts. Missing
// the assignment step is what made the first run of this harness report BYTE
// IDENTICAL numbers for both tiers - the near tier was never selected, so both
// arms measured the far mesh. Identical numbers mean something is not running.
const POSE = (lod) => {
  const P = __district.pedestrians();
  if (lod !== null && P.setNearLod) P.setNearLod(lod);
  const ped = P.peds[0];
  if (P._assignNearLod) P._assignNearLod(ped.x, ped.z);
  P._writePose(0, ped, 0.838 * ped.hscale);
  if (P._syncNearCounts) P._syncNearCounts();
  for (const m of [P.shadows, P.torsos, P.heads, P.limbs]) m.instanceMatrix.needsUpdate = true;
  if (P.nearLimbs) {
    for (const m of [P.nearTorsos, P.nearHeads, P.nearLimbs]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
  return { nearLive: P._nearLive ?? 0, nearSlot: P._nearSlot ? P._nearSlot[0] : -1 };
};
const pose = (lod) => page.evaluate(`(${POSE.toString()})(${lod})`);

const hidePed = () => { const P = __district.pedestrians();
  for (const m of [P.torsos, P.heads, P.limbs]) m.visible = false;
  if (P.nearLimbs) for (const m of [P.nearTorsos, P.nearHeads, P.nearLimbs]) m.visible = false; };
const showPed = () => { const P = __district.pedestrians();
  for (const m of [P.torsos, P.heads, P.limbs]) m.visible = true;
  if (P.nearLimbs) for (const m of [P.nearTorsos, P.nearHeads, P.nearLimbs]) m.visible = true; };

const cleanOn = () => { __district.post.params.aoEnabled = false;
  __district.post.params.bloomStrength = 0; };

function maskOf(withF, withoutF, box, thresh = 10) {
  const A = readPNG(withF), B = readPNG(withoutF);
  const m = new Uint8Array(A.width * A.height);
  let n = 0;
  for (let y = Math.max(0, box.y0); y < Math.min(A.height, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x < Math.min(A.width, box.x1); x++) {
      const ia = (y * A.width + x) * A.channels, ib = (y * A.width + x) * B.channels;
      // MAX CHANNEL, not luminance. The first version of this mask tested
      // luminance and punched holes straight through the subject wherever a navy
      // shirt happened to match the pink pavement behind it in value - and the
      // crease scan then ran off the edge of those holes and read the silhouette
      // as a crease, reporting 57.8 where the real figure is 10.6.
      const d = Math.max(Math.abs(A.data[ia] - B.data[ib]),
        Math.abs(A.data[ia + 1] - B.data[ib + 1]), Math.abs(A.data[ia + 2] - B.data[ib + 2]));
      if (d > thresh) { m[y * A.width + x] = 1; n++; }
    }
  }
  return { m, n, w: A.width, h: A.height };
}
// Write the mask out so it can be LOOKED at. A silhouette metric computed on a
// mask nobody has seen is the same mistake as a light-isolation test that
// disabled nothing.
function writeMask(file, mask, box) {
  const rgb = Buffer.alloc(mask.w * mask.h * 3);
  for (let i = 0; i < mask.m.length; i++) { const v = mask.m[i] ? 255 : 0; rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v; }
  for (const b of Object.values(box)) {
    if (!b || b.x0 === undefined) continue;
    for (let x = Math.max(0, b.x0); x < Math.min(mask.w, b.x1); x++) {
      for (const y of [b.y0, b.y1 - 1]) { if (y < 0 || y >= mask.h) continue;
        const i = (y * mask.w + x) * 3; rgb[i] = 255; rgb[i + 1] = 0; rgb[i + 2] = 0; }
    }
    for (let y = Math.max(0, b.y0); y < Math.min(mask.h, b.y1); y++) {
      for (const x of [b.x0, b.x1 - 1]) { if (x < 0 || x >= mask.w) continue;
        const i = (y * mask.w + x) * 3; rgb[i] = 255; rgb[i + 1] = 0; rgb[i + 2] = 0; }
    }
  }
  writePNG(file, mask.w, mask.h, rgb);
}
const inBox = (mask, box) => {
  let n = 0;
  for (let y = Math.max(0, box.y0); y < Math.min(mask.h, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x < Math.min(mask.w, box.x1); x++) if (mask.m[y * mask.w + x]) n++;
  }
  return n;
};
// Facet kink: for each row of the thigh band, the largest second difference of
// luminance along x, over pixels that are on the ped and 3 px clear of its edge.
function crease(file, mask, box) {
  const I = readPNG(file);
  const meds = [], maxes = [];
  for (let y = Math.max(0, box.y0); y < Math.min(I.height, box.y1); y++) {
    const vals = [];
    for (let x = Math.max(3, box.x0); x < Math.min(I.width - 3, box.x1); x++) {
      const on = (xx) => mask.m[y * mask.w + xx];
      if (!on(x - 3) || !on(x + 3) || !on(x)) continue;
      const a = lum(I.data, (y * I.width + x - 2) * I.channels);
      const b = lum(I.data, (y * I.width + x) * I.channels);
      const c = lum(I.data, (y * I.width + x + 2) * I.channels);
      vals.push(Math.abs(a - 2 * b + c));
    }
    if (vals.length < 8) continue;
    vals.sort((p, q) => p - q);
    meds.push(vals[vals.length >> 1]);
    maxes.push(vals[vals.length - 1]);
  }
  const mean = (a) => (a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : null);
  return { rows: meds.length, creaseMedian: mean(meds), creaseMax: mean(maxes) };
}

async function measure(label) {
  const withPed = await shot(label);
  await page.evaluate(`(${hidePed.toString()})()`);
  await page.waitForTimeout(1100);
  const without = await shot(`${label}-noped`);
  await page.evaluate(`(${showPed.toString()})()`);
  await page.waitForTimeout(1100);
  const mask = maskOf(withPed, without, boxes.whole);
  writeMask(`${OUT}/${TAG}-${TOD}-${label}-mask.png`, mask, boxes);
  const r = {
    label,
    silhouettePx: mask.n,
    headPx: inBox(mask, boxes.head),
    footPx: inBox(mask, boxes.foot),
    ...crease(withPed, mask, boxes.shank),
    file: withPed,
  };
  console.log(`${label.padEnd(10)} silhouette ${String(r.silhouettePx).padStart(6)} px  ` +
    `head ${String(r.headPx).padStart(5)} px  foot ${String(r.footPx).padStart(5)} px  ` +
    `shank crease median ${r.creaseMedian} / max ${r.creaseMax} over ${r.rows} rows`);
  return r;
}

// A "look at it" capture with the full post stack, before anything is disabled.
await shot('look');

// Metric captures run with AO and bloom off; see hidePed above.
await page.evaluate(`(${cleanOn.toString()})()`);
await page.waitForTimeout(1600);

// noise floor: the same untouched frame, twice, through the same pipeline.
const nA = await shot('noise-a');
await page.waitForTimeout(1200);
const nB = await shot('noise-b');
{
  const A = readPNG(nA), B = readPNG(nB);
  let d = 0, n = 0;
  for (let y = boxes.whole.y0; y < boxes.whole.y1; y++) {
    for (let x = boxes.whole.x0; x < boxes.whole.x1; x++) {
      const i = y * A.width + x;
      d += Math.abs(lum(A.data, i * A.channels) - lum(B.data, i * B.channels)); n++;
    }
  }
  console.log(`\nnoise floor over the subject box: mean |diff| ${(d / n).toFixed(3)} over ${n} px`);
}

const rows = [];
const hasNear = await page.evaluate(() => typeof __district.pedestrians().setNearLod === 'function');
if (hasNear) {
  const far = await pose(0);
  await page.waitForTimeout(1400);
  rows.push(await measure('farLOD'));
  const nr = await pose(-1);                          // -1 = restore the default pool
  await page.waitForTimeout(1400);
  rows.push(await measure('nearLOD'));
  console.log(`tier selection: farLOD arm nearLive ${far.nearLive}, ` +
    `nearLOD arm nearLive ${nr.nearLive} (subject holds near slot ${nr.nearSlot})`);
  if (nr.nearLive < 1) throw new Error('near tier never engaged - the two arms are the same mesh');
} else {
  console.log('(this build has no near LOD - measuring the single tier it does have)');
  rows.push(await measure('single'));
}

// --- the rest pose. A ped held up by a crowd stands still; if THAT reads as a
//     T-pose or a frozen mid-stride the mesh quality is beside the point.
await page.evaluate(() => { const p = __district.pedestrians().peds[0]; p.v = 0; p.phase = 0; });
await pose(null);
await page.waitForTimeout(1400);
const restFile = await shot('rest');
console.log(`rest pose captured: ${restFile}`);

// --- look at it from more than one side. A silhouette metric taken from one
// angle can be satisfied by a mesh that is wrong from every other one, and the
// face is on the side these captures have not shown.
await page.evaluate(() => { const p = __district.pedestrians().peds[0]; p.v = 1.35; p.phase = 1.15; });
await pose(null);
const ANGLES = { front: 0.35, side: 1.45, back: 2.35 };
const orbit = (off) => page.evaluate((o) => {
  const P = __district.pedestrians();
  const ped = P.peds[0];
  const g = __district.world.heightAt(ped.x, ped.z);
  const a = ped.yaw + o;
  __district.freeCam([ped.x + Math.sin(a) * 3.4, g + 1.42, ped.z + Math.cos(a) * 3.4],
    [ped.x, g + 0.95, ped.z], 40);
}, off);
for (const [name, off] of Object.entries(ANGLES)) {
  await orbit(off);
  await page.waitForTimeout(1500);
  if (hasNear) { await pose(0); await page.waitForTimeout(1200); await shot(`far-${name}`); }
  await pose(hasNear ? -1 : null);
  await page.waitForTimeout(1200);
  await shot(`near-${name}`);
  console.log(`orbit ${name} captured`);
}
await orbit(2.35);
await page.waitForTimeout(1200);

// --- does the crowd respond to the SUN? At dusk it measured 0.01, but dusk puts
//     1.9% of the road's light on the sun (PROGRESS.md), so that reading needs a
//     positive control at a time of day where the sun is the light.
await page.evaluate(() => { const p = __district.pedestrians().peds[0]; p.v = 1.35; p.phase = 1.15; });
await pose(null);
await page.evaluate(() => __district.setTimeOfDay('noon'));
await page.waitForTimeout(9000);
const noonBase = await shot('noon-base');
await page.evaluate(() => __district.scene.traverse((o) => { if (o.isDirectionalLight) o.intensity = 0; }));
await page.waitForTimeout(1400);
const noonNoSun = await shot('noon-nosun');
{
  const A = readPNG(noonBase), B = readPNG(noonNoSun);
  // Re-derive the mask on the noon frame so the sun reading is confined to the ped.
  await page.evaluate(() => __district.setTimeOfDay('noon'));
  let d = 0, n = 0, changed = 0;
  for (let y = boxes.whole.y0; y < boxes.whole.y1; y++) {
    for (let x = boxes.whole.x0; x < boxes.whole.x1; x++) {
      const i = y * A.width + x;
      const v = Math.abs(lum(A.data, i * A.channels) - lum(B.data, i * B.channels));
      d += v; n++; if (v > 8) changed++;
    }
  }
  console.log(`\nSUN CONTROL at noon, over the subject box: mean |diff| ${(d / n).toFixed(2)}, ` +
    `${((changed / n) * 100).toFixed(1)}% of px changed when the sun is switched off`);
  rows.push({ label: 'noonSunControl', meanAbsDiff: +(d / n).toFixed(2),
    pctChanged: +((changed / n) * 100).toFixed(1) });
}

const lodReport = await page.evaluate(() => __district.pedestrianReport().nearLod);
console.log('\nnear-LOD accounting:', JSON.stringify(lodReport));
fs.writeFileSync(`docs/${TAG}-${TOD}.json`,
  JSON.stringify({ tod: TOD, subject: SUBJECT, spread, boxes, rows, lodReport }, null, 1));
console.log(`\nwrote docs/${TAG}-${TOD}.json`);
await browser.close();
