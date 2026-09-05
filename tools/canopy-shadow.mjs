// DO THE TREES CAST SHADOWS ON THE GROUND?
//
// Two blind reviewers reported that the canopy contributes nothing to the light,
// one of them citing a canopy-density A/B that moved 30.87% of the canopy pixels
// and 0.15% of a hand-picked ground box. That is suggestive and not decisive: the
// ground box was picked by eye, and an earlier round's hand-picked "open sun" box
// turned out to be in building shadow. So nothing here is picked by eye.
//
//   1. WHERE THE TREES ARE is read out of the shipped geometry. Every static
//      prop shares one material and one palette; a vertex's uv.x selects the
//      palette column and column 6 is foliage (src/streetfurniture.js `S`), so
//      the canopy is exactly the prop vertices with floor(uv.x*16) === 6, welded
//      buckets and all.
//   2. WHERE ITS SHADOW MUST LAND is those vertices dropped along the SUN'S OWN
//      ray (read off the DirectionalLight, not off the preset) onto the ground.
//      A pixel joins the mask only if the camera really sees GROUND down it, and
//      that is settled by a render: every mesh is repainted white if it is ground
//      and black if it is not, the scene is drawn once into an offscreen target
//      with no post stack, and the buffer is read back. A pixel showing a parked
//      car, a trunk, a bin or a facade never enters a mask.
//   3. THE CONTROL is built the same way from a world-space grid of ground
//      points at least CONTROL_GAP metres from every canopy shadow point.
//   4. THE A/B TOGGLES THE CANOPY'S CASTING ALONE. Prop buckets are welded, so
//      per-mesh castShadow cannot separate a tree from a bin. Instead the shared
//      material's alphaMap is swapped for the duration of the SHADOW PASS ONLY,
//      for a copy of the stencil whose foliage column is fully transparent:
//      alphaTest discards every foliage fragment in the depth pass and nothing
//      else moves. The colour pass never sees the swap, so both arms draw a
//      bit-identical canopy and the only difference is what the canopy put in
//      the shadow map. The inverse stencil (everything BUT foliage killed) is
//      the third arm and the instrument's self-test: a probe that cannot tell
//      those two apart is measuring nothing.
//   5. THE SHADOW MAP ITSELF IS READ BACK over the canopy's own texels, so "the
//      canopy is in the depth buffer" is a fact about texels rather than an
//      inference from pixels.
//
// Two times of day, per binding constraint 3.
//
// WHAT IT FOUND, 2026-09-05, so a later reader does not have to re-run it to
// know which way the answer went. The canopy DOES cast, and it dapples:
//
//   fivepoints, NOON, sun 75.6 deg. The foliage darkens 6,681 of 406,542 visible
//   ground pixels by a mean 72.1/255 (worst 147). Inside the derived footprint
//   60.5% of pixels move, mean |d| 43.6, against a noise floor of 0.216 and an
//   open-ground control of 0.045. Ground luma 71.1 with the canopy casting and
//   114.8 without; LOCAL SD 20.53 against 14.90, i.e. the shadow carries 38%
//   more small-scale contrast than the pavement it lands on. That is dapple.
//
//   fivepoints, GOLDEN, sun 7.9 deg. The foliage darkens ZERO ground pixels. Not
//   because it fails to cast - it is 75.2% in the sun and it does write the
//   shadow map - but because the shadow is thrown 54 m toward bearing 224 deg
//   while the lens points 358: 1,482 of 1,642 ground shadow points fall outside
//   the frame, and the ground they would land on is already dark. The whole
//   shadow pass takes a mean 40.4/255 off this ground and leaves only 13.7% of
//   it sunlit. Forcing the sun's azimuth to 178 deg so the shadows fall straight
//   down the street changes the answer by 65 pixels: at 7.9 deg the street is
//   90.7% building-shadowed and a second shadow on shadowed ground is nothing.
//
//   So the reviewers' ground box was right and their diagnosis was wrong. Their
//   box, (620,560)-(960,760), reads mean |d| 0.057 under this toggle - the
//   canopy really does contribute nothing THERE. (0,600)-(360,760), 360 px to
//   its left, reads 5.54 with a max of 147.
//
//   AND THE DISTRICT IS NOT AN OAK STREET. The census is 160 sabal + 135 queen
//   palms + 12 live oaks. "Dappled oak shade on brick" is rare here by design,
//   not by defect: src/streetfurniture.js says so and explains why.
//
// Usage: node tools/canopy-shadow.mjs [--shot fivepoints|corridor] [--tod noon,golden]
//                                     [--tag x] [--range 70] [--gap 3]
//                                     [--azimuth DEG]  force the sun's bearing
//                                     [--aim-oak]      look where the nearest
//                                                      live oak's shadow lands
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import { writePNG } from './crop.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SHOT = arg('shot', 'fivepoints');
const TODS = arg('tod', 'noon,golden').split(',');
const TAG = arg('tag', 'canopy');
const RANGE = Number(arg('range', 70));        // metres of ground the probe judges
const CONTROL_GAP = Number(arg('gap', 3));     // metres a control point must clear a canopy shadow
// Measurement hook, not authoring: district/main.js exposes setSunAzimuth so a
// harness can find out where the light has to stand for occlusion to be visible
// at all. Used here to ask whether golden hour's null is about the SUN'S HEIGHT
// or about the direction it happens to throw a shadow relative to the hero lens.
const AZ = argv.includes('--azimuth') ? Number(arg('azimuth', '')) : null;
// Aim the lens where the nearest LIVE OAK's shadow actually lands, instead of
// down the street. The hero framings are hero framings; this one exists to test
// the reviewers' specific claim - dappled oak shade on brick - at the one place
// in the district where it can be seen at all. The camera does not move (it is
// still the clearance-checked hero position), only the direction it looks.
const AIM_OAK = argv.includes('--aim-oak');
fs.mkdirSync(OUT, { recursive: true });

// =========================================================== in-page probe
async function installProbe() {
  const THREE = await import('/vendor/three.module.min.js');
  const F = __district.furniture;
  const sun = __district.tod.sun;
  const PAL_W = 16;

  // ---- 1. the canopy, out of the shipped buffers.
  function canopyPoints(maxDist) {
    const cam = __district.camera, out = [];
    for (const m of F.propMeshes) {
      if (!m.visible) continue;
      const g = m.geometry;
      const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
      if (!pos || !uv) continue;
      for (let i = 0; i < pos.count; i++) {
        if (Math.floor(uv.getX(i) * PAL_W) !== 6) continue;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (maxDist && Math.hypot(x - cam.position.x, z - cam.position.z) > maxDist) continue;
        out.push([x, y, z]);
      }
    }
    return out;
  }

  const sunDir = () => sun.position.clone().sub(sun.target.position).normalize();

  // ---- 2/3. masks. A pixel joins a mask only if the camera really sees the
  // GROUND down it. That is settled by a render, not by a guess: every mesh is
  // temporarily repainted white if it is ground and black if it is not, the
  // scene is drawn once into an offscreen target with no post stack, and the
  // buffer is read back. A pixel showing a parked car, a trunk, a kerbside bin
  // or a facade is black and never enters a mask.
  //
  // Ground is the land pad (streaming.js _buildWater), the road ribbons and the
  // zone polygons - the three surfaces a tree shadow can land on in this build.
  const W0 = __district.renderer.domElement.width, H0 = __district.renderer.domElement.height;
  const idRT = new THREE.WebGLRenderTarget(W0, H0,
    { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true });
  const WHITE = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const BLACK = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const wmat = __district.world.materials ?? {};
  const landMat = wmat.ground ?? wmat.land;
  const isGround = (o) => /:(road|zone:)/.test(o.name || '')
    || (landMat && o.material === landMat);

  function groundBuffer() {
    const saved = [];
    __district.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      saved.push([o, o.material]);
      o.material = isGround(o) ? WHITE : BLACK;
    });
    const r = __district.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(idRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(__district.scene, __district.camera);
    const buf = new Uint8Array(W0 * H0 * 4);
    r.readRenderTargetPixels(idRT, 0, 0, W0, H0, buf);
    r.setRenderTarget(prevTarget);
    for (const [o, m] of saved) o.material = m;
    let g = 0;
    const bits = new Uint8Array(Math.ceil((W0 * H0) / 8));
    for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) {
      // readRenderTargetPixels is bottom-up; index the bitset top-down so the
      // harness can address it in screenshot coordinates.
      if (buf[((H0 - 1 - y) * W0 + x) * 4] <= 128) continue;
      g++;
      const k = y * W0 + x;
      bits[k >> 3] |= 1 << (k & 7);
    }
    let bin = '';
    for (let i = 0; i < bits.length; i += 4096) {
      bin += String.fromCharCode.apply(null, bits.subarray(i, Math.min(bits.length, i + 4096)));
    }
    return { buf, groundPx: g, bits64: btoa(bin) };
  }

  // Project world points, keep the ones whose pixel is ground.
  function verifiedMask(worldPts, gb) {
    const cam = __district.camera;
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const v = new THREE.Vector3();
    const px = [];
    let tested = 0, onGround = 0, offscreen = 0;
    for (const p of worldPts) {
      v.set(p[0], p[1], p[2]).project(cam);
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) { offscreen++; continue; }
      const sx = Math.round((v.x * 0.5 + 0.5) * W0);
      const sy = Math.round((1 - (v.y * 0.5 + 0.5)) * H0);
      if (sx < 0 || sy < 0 || sx >= W0 || sy >= H0) { offscreen++; continue; }
      tested++;
      // readRenderTargetPixels is bottom-up; the projection above is top-down.
      const i = ((H0 - 1 - sy) * W0 + sx) * 4;
      if (gb.buf[i] > 128) { onGround++; px.push([sx, sy]); }
    }
    return { px, W: W0, H: H0, tested, hitGround: onGround, occluded: tested - onGround, offscreen };
  }

  // ---- 4. the shadow-pass stencil swap.
  const mat = F.propMat;
  const shipped = mat.alphaMap;
  const AW = shipped.image.width, AH = shipped.image.height, K = AW / PAL_W;
  function variant(mode) {
    const src = shipped.image.data, data = new Uint8Array(src.length);
    data.set(src);
    for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
      const col = Math.floor(x / K);
      if (mode === 'nofoliage' ? col !== 6 : col === 6) continue;
      const i = (y * AW + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0; data[i + 3] = 255;
    }
    const t = new THREE.DataTexture(data, AW, AH, shipped.format);
    t.magFilter = shipped.magFilter; t.minFilter = shipped.minFilter;
    t.generateMipmaps = shipped.generateMipmaps;
    t.wrapS = shipped.wrapS; t.wrapT = shipped.wrapT;
    t.needsUpdate = true;
    return t;
  }
  const VAR = { shipped, nofoliage: variant('nofoliage'), foliageonly: variant('foliageonly') };

  const sm = __district.renderer.shadowMap;
  if (!sm.__patched) {
    const orig = sm.render.bind(sm);
    sm.render = function (lights, scene, camera) {
      const want = window.__canopyArm ?? 'shipped';
      if (want !== 'shipped') mat.alphaMap = VAR[want];
      try { return orig(lights, scene, camera); } finally { mat.alphaMap = shipped; }
    };
    sm.__patched = true;
  }

  // ---- 5. the shadow map, read back over a rectangle of texels.
  //
  // three.js packs depth into RGBA; the unpack is the shader's own dot product.
  function shadowRect(worldPts) {
    const s = sun.shadow;
    s.updateMatrices(sun);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, inside = 0;
    const p = new THREE.Vector3();
    for (const q of worldPts) {
      p.set(q[0], q[1], q[2]);
      p.applyMatrix4(s.camera.matrixWorldInverse).applyMatrix4(s.camera.projectionMatrix);
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z < -1 || p.z > 1) continue;
      inside++;
      const u = (p.x * 0.5 + 0.5) * s.mapSize.x, v = (p.y * 0.5 + 0.5) * s.mapSize.y;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    return { u0, u1, v0, v1, inside, total: worldPts.length,
      mapSize: s.mapSize.x, metresPerTexel: (s.camera.right - s.camera.left) / s.mapSize.x };
  }
  function readShadow(x0, y0, w, h) {
    const s = sun.shadow;
    if (!s.map) return null;
    const buf = new Uint8Array(w * h * 4);
    __district.renderer.readRenderTargetPixels(s.map, x0, y0, w, h, buf);
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      out[i] = buf[i * 4] / 255 + buf[i * 4 + 1] / 65025
        + buf[i * 4 + 2] / 16581375 + buf[i * 4 + 3] / 4228250625;
    }
    return Array.from(out);
  }

  // ---- is the canopy ITSELF in the sun? Marched against the baked footprints
  // and heights, which constraint 10 makes authoritative, rather than inferred
  // from pixels. A canopy standing in a building's shadow has no light to take
  // off the ground however well it is rendered.
  function canopySunOcclusion(pts, step, reach) {
    const D = __district.district, d = sunDir();
    const inRing = (ring, x, z) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    let lit = 0, shaded = 0;
    for (const p of pts) {
      let blocked = false;
      for (let t = step; t <= reach && !blocked; t += step) {
        const x = p[0] + d.x * t, y = p[1] + d.y * t, z = p[2] + d.z * t;
        const c = D.chunks[__district.world.keyOf(x, z)];
        if (!c) continue;
        for (const bi of c.buildings) {
          const b = D.buildings[bi];
          if (b.h <= y) continue;
          if (inRing(b.p, x, z)) { blocked = true; break; }
        }
      }
      if (blocked) shaded++; else lit++;
    }
    return { sampled: pts.length, lit, shaded, litFraction: pts.length ? lit / pts.length : 0 };
  }

  // Cluster canopy vertices into trees and pick the live oaks out of them. An
  // oak's foliage starts at the fork (1.75-3.2 m) and its crown is wider than it
  // is tall; a sabal or queen palm's foliage sits metres up a bare trunk. Those
  // two facts separate the species without a second copy of the placement rule.
  function trees(maxDist) {
    const cam = __district.camera, cells = new Map();
    for (const p of canopyPoints(maxDist)) {
      const k = `${Math.round(p[0] / 3)},${Math.round(p[2] / 3)}`;
      let c = cells.get(k);
      if (!c) cells.set(k, (c = { n: 0, sx: 0, sz: 0, lo: 1e9, hi: -1e9, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 }));
      c.n++; c.sx += p[0]; c.sz += p[2];
      c.lo = Math.min(c.lo, p[1]); c.hi = Math.max(c.hi, p[1]);
      c.x0 = Math.min(c.x0, p[0]); c.x1 = Math.max(c.x1, p[0]);
      c.z0 = Math.min(c.z0, p[2]); c.z1 = Math.max(c.z1, p[2]);
    }
    // Merge cells that touch, so one crown is one tree.
    const keys = [...cells.keys()], parent = new Map(keys.map((k) => [k, k]));
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    for (const k of keys) {
      const [a, b] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const n = `${a + dx},${b + dz}`;
        if (cells.has(n)) { const ra = find(k), rb = find(n); if (ra !== rb) parent.set(ra, rb); }
      }
    }
    const merged = new Map();
    for (const k of keys) {
      const r = find(k), c = cells.get(k);
      let t = merged.get(r);
      if (!t) merged.set(r, (t = { n: 0, sx: 0, sz: 0, lo: 1e9, hi: -1e9, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 }));
      t.n += c.n; t.sx += c.sx; t.sz += c.sz;
      t.lo = Math.min(t.lo, c.lo); t.hi = Math.max(t.hi, c.hi);
      t.x0 = Math.min(t.x0, c.x0); t.x1 = Math.max(t.x1, c.x1);
      t.z0 = Math.min(t.z0, c.z0); t.z1 = Math.max(t.z1, c.z1);
    }
    return [...merged.values()].map((t) => ({
      x: t.sx / t.n, z: t.sz / t.n, verts: t.n,
      foliageLowY: t.lo, foliageTopY: t.hi,
      widthM: Math.max(t.x1 - t.x0, t.z1 - t.z0),
      dist: Math.hypot(t.sx / t.n - cam.position.x, t.sz / t.n - cam.position.z),
      // A live oak: crown starting at the fork, and wider than it is tall.
      oak: t.lo < 4.6 && Math.max(t.x1 - t.x0, t.z1 - t.z0) > (t.hi - t.lo) * 1.15
        && Math.max(t.x1 - t.x0, t.z1 - t.z0) > 8,
    })).filter((t) => t.verts > 120).sort((a, b) => a.dist - b.dist);
  }

  // Point the lens at where a tree's shadow lands, without moving the camera.
  function aimAtShadowOf(t) {
    const cam = __district.camera, d = sunDir();
    const y = (t.foliageLowY + t.foliageTopY) / 2;
    const k = d.y > 0.02 ? (y - 0.02) / d.y : 0;
    const tx = t.x - d.x * k, tz = t.z - d.z * k;
    __district.freeCam([cam.position.x, cam.position.y, cam.position.z], [tx, 0.4, tz], cam.fov);
    return { tree: { x: +t.x.toFixed(1), z: +t.z.toFixed(1), widthM: +t.widthM.toFixed(1),
      foliageLowY: +t.foliageLowY.toFixed(1), foliageTopY: +t.foliageTopY.toFixed(1), oak: t.oak, dist: +t.dist.toFixed(0) },
      aimedAt: { x: +tx.toFixed(1), z: +tz.toFixed(1) }, throwM: +Math.hypot(t.x - tx, t.z - tz).toFixed(1) };
  }

  window.__canopy = {
    canopyPoints, verifiedMask, groundBuffer, shadowRect, readShadow, canopySunOcclusion,
    trees, aimAtShadowOf,
    setArm: (a) => { window.__canopyArm = a; },
    sun: () => { const d = sunDir(); return { x: d.x, y: d.y, z: d.z,
      elevationDeg: (Math.asin(d.y) * 180) / Math.PI,
      azimuthDeg: (Math.atan2(d.z, d.x) * 180) / Math.PI }; },
    // Drop canopy points onto the ground along the sun ray.
    dropToGround: (pts, groundY) => {
      const d = sunDir(), out = [];
      if (d.y <= 0.02) return out;
      for (const p of pts) {
        const t = (p[1] - groundY) / d.y;
        out.push([p[0] - d.x * t, groundY, p[2] - d.z * t]);
      }
      return out;
    },
    info: () => {
      const s = sun.shadow;
      return { mapSize: s.mapSize.x, extentM: s.camera.right - s.camera.left,
        metresPerTexel: (s.camera.right - s.camera.left) / s.mapSize.x,
        bias: s.bias, normalBias: s.normalBias, radius: s.radius,
        type: __district.renderer.shadowMap.type,
        format: s.map ? s.map.texture.format : null,
        camera: { near: s.camera.near, far: s.camera.far } };
    },
    // Proof the arms differ, so an A/B cannot be secretly identical.
    variantDiff: () => {
      const a = VAR.shipped.image.data, b = VAR.nofoliage.image.data, c = VAR.foliageonly.image.data;
      let ab = 0, ac = 0;
      for (let i = 1; i < a.length; i += 4) { if (a[i] !== b[i]) ab++; if (a[i] !== c[i]) ac++; }
      return { texels: a.length / 4, shippedVsNoFoliage: ab, shippedVsFoliageOnly: ac };
    },
  };
  return window.__canopy.info();
}

// ================================================================== harness
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGEERROR', e.message); });
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

const placed = await page.evaluate(placeCamera, SHOTS[SHOT]);
console.log(describe(SHOT, placed));
await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });
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

const info = await page.evaluate(installProbe);
console.log('shadow map:', JSON.stringify(info));
const vdiff = await page.evaluate(() => window.__canopy.variantDiff());
console.log('stencil arms differ by:', JSON.stringify(vdiff));
if (!vdiff.shippedVsNoFoliage || !vdiff.shippedVsFoliageOnly) {
  throw new Error('the A/B arms carry identical stencils - the experiment would prove nothing');
}

const report = { shot: SHOT, placed, settled, shadowMap: info, variantDiff: vdiff, range: RANGE, times: {} };
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const W = 1600, H = 900;

for (const tod of TODS) {
  console.log(`\n=================== ${tod.toUpperCase()} · ${SHOT} ===================`);
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  if (AZ !== null) {
    const r = await page.evaluate(([t, a]) => __district.setSunAzimuth(t, a), [tod, (AZ * Math.PI) / 180]);
    console.log(`sun azimuth forced to ${AZ} deg (${JSON.stringify(r)})`);
  }
  if (AIM_OAK) {
    const aim = await page.evaluate((r) => {
      const ts = window.__canopy.trees(r);
      const oak = ts.find((t) => t.oak) ?? ts[0];
      if (!oak) return null;
      return { ...window.__canopy.aimAtShadowOf(oak),
        treesSeen: ts.length, oaksSeen: ts.filter((t) => t.oak).length };
    }, RANGE);
    console.log('aimed at the nearest oak\'s shadow:', JSON.stringify(aim));
    if (!aim) throw new Error('no tree found within range to aim at');
    report.aim = report.aim ?? {}; report.aim[tod] = aim;
  }
  await page.waitForTimeout(9000);

  const build = await page.evaluate(async ({ range, gap }) => {
    const C = window.__canopy;
    const sun = C.sun();
    const canopy = C.canopyPoints(range);
    const ground = C.dropToGround(canopy, 0.02);
    // Thin to a 0.35 m world grid: the vertex cloud is far denser than a pixel.
    const key = (p) => `${Math.round(p[0] / 0.35)},${Math.round(p[2] / 0.35)}`;
    const seen = new Set(), shadowPts = [];
    for (const p of ground) { const k = key(p); if (seen.has(k)) continue; seen.add(k); shadowPts.push(p); }
    const gb = C.groundBuffer();
    const shadowMask = C.verifiedMask(shadowPts, gb);

    // The control: a world grid of ground points in range, at least `gap` metres
    // from every canopy shadow point, verified the same way.
    const cam = __district.camera;
    const occupied = new Set();
    const g2 = (x, z) => `${Math.round(x / gap)},${Math.round(z / gap)}`;
    for (const p of shadowPts) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        occupied.add(g2(p[0] + dx * gap, p[2] + dz * gap));
      }
    }
    const ctrl = [];
    for (let dx = -range; dx <= range; dx += 0.7) {
      for (let dz = -range; dz <= range; dz += 0.7) {
        const x = cam.position.x + dx, z = cam.position.z + dz;
        if (Math.hypot(dx, dz) > range || Math.hypot(dx, dz) < 6) continue;
        if (occupied.has(g2(x, z))) continue;
        ctrl.push([x, 0.02, z]);
      }
    }
    const controlMask = C.verifiedMask(ctrl, gb);
    const rect = C.shadowRect(shadowPts);
    // Is the canopy itself standing in the sun? Subsampled to keep the march cheap.
    const sample = [];
    const stride = Math.max(1, Math.ceil(canopy.length / 500));
    for (let i = 0; i < canopy.length; i += stride) sample.push(canopy[i]);
    const canopyLit = C.canopySunOcclusion(sample, 2, 300);
    // How far the shadow is thrown, and which side of the lens it lands on.
    const d = C.sun();
    const fwd = new (cam.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion);
    let throwSum = 0, throwN = 0, behind = 0, ahead = 0;
    for (let i = 0; i < canopy.length; i++) {
      const h = canopy[i][1];
      if (h < 3) continue;
      throwSum += h * Math.sqrt(Math.max(0, 1 - d.y * d.y)) / Math.max(1e-3, d.y);
      throwN++;
    }
    for (const p of shadowPts) {
      const vx = p[0] - cam.position.x, vz = p[2] - cam.position.z;
      if (vx * fwd.x + vz * fwd.z < 0) behind++; else ahead++;
    }
    const geometry = { meanThrowM: throwN ? throwSum / throwN : 0,
      shadowPointsBehindCamera: behind, shadowPointsAhead: ahead,
      shadowBearingDeg: ((Math.atan2(-d.z, -d.x) * 180) / Math.PI + 360) % 360,
      cameraBearingDeg: ((Math.atan2(fwd.z, fwd.x) * 180) / Math.PI + 360) % 360 };
    return { sun, geometry, canopyLit, canopyVerts: canopy.length, shadowPts: shadowPts.length,
      groundPxInFrame: gb.groundPx, groundBits: gb.bits64,
      shadowMask: { ...shadowMask, px: shadowMask.px },
      controlMask: { ...controlMask, px: controlMask.px },
      rect };
  }, { range: RANGE, gap: CONTROL_GAP });

  console.log(`sun elevation ${build.sun.elevationDeg.toFixed(1)} deg, azimuth ${build.sun.azimuthDeg.toFixed(1)} deg`);
  console.log(`canopy vertices within ${RANGE} m: ${build.canopyVerts} -> ${build.shadowPts} ground shadow points`);
  console.log(`  shadow throw ${build.geometry.meanThrowM.toFixed(1)} m toward bearing ` +
    `${build.geometry.shadowBearingDeg.toFixed(0)} deg; the lens points ${build.geometry.cameraBearingDeg.toFixed(0)} deg. ` +
    `${build.geometry.shadowPointsBehindCamera} of ${build.shadowPts} shadow points land BEHIND the camera`);
  console.log(`  canopy in the sun: ${build.canopyLit.lit} of ${build.canopyLit.sampled} sampled canopy points ` +
    `(${(build.canopyLit.litFraction * 100).toFixed(1)}%) have an unobstructed line to the sun over the baked footprints`);
  console.log(`  ground pixels in frame (ID render): ${build.groundPxInFrame}`);
  console.log(`  shadow mask : ${build.shadowMask.hitGround} of ${build.shadowMask.tested} on-screen points verified as GROUND ` +
    `(${build.shadowMask.occluded} occluded, ${build.shadowMask.offscreen} off-frame)`);
  console.log(`  control mask: ${build.controlMask.hitGround} of ${build.controlMask.tested} verified as ground`);
  console.log(`  canopy shadow points inside the sun's shadow frustum: ${build.rect.inside}/${build.rect.total}, ` +
    `texel span u ${build.rect.u0.toFixed(0)}-${build.rect.u1.toFixed(0)}, v ${build.rect.v0.toFixed(0)}-${build.rect.v1.toFixed(0)}, ` +
    `${build.rect.metresPerTexel.toFixed(4)} m/texel`);

  const splat = (list, R) => {
    const m = new Uint8Array(W * H);
    for (const [px, py] of list) {
      const x = Math.round(px), y = Math.round(py);
      for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; m[yy * W + xx] = 1; } }
    }
    return m;
  };
  let measured = null, allShadow = null;
  const shadowM = splat(build.shadowMask.px, 2);
  const controlM0 = splat(build.controlMask.px, 2);
  // A control pixel must not touch the shadow mask.
  const grow = splat(build.shadowMask.px, 8);
  const controlM = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) controlM[i] = controlM0[i] && !grow[i] ? 1 : 0;
  const cnt = (m) => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n; };
  console.log(`  mask pixels: canopy-shadow ground ${cnt(shadowM)}, open ground control ${cnt(controlM)}`);

  // The ground itself, in screenshot coordinates, from the ID render.
  const gbits = Buffer.from(build.groundBits, 'base64');
  const groundM = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) groundM[i] = (gbits[i >> 3] >> (i & 7)) & 1;

  // ---- the three arms, plus a repeat of arm 1 for the noise floor.
  const shots = {};
  for (const arm of ['shipped', 'nofoliage', 'foliageonly', 'shipped', 'noshadow']) {
    if (arm === 'noshadow') {
      await page.evaluate(() => { __district.tod.sun.shadow.intensity = 0; });
    } else {
      await page.evaluate((a) => window.__canopy.setArm(a), arm);
    }
    await page.waitForTimeout(1500);
    const tagn = shots[arm] ? 'noise' : arm;
    const f = `${OUT}/${TAG}-${SHOT}-${tod}-${tagn}.png`;
    await page.screenshot({ path: f, timeout: 240000 });
    shots[tagn] = { file: f, img: readPNG(f) };
  }
  await page.evaluate(() => { window.__canopy.setArm('shipped'); __district.tod.sun.shadow.intensity = 1; });
  await page.waitForTimeout(1200);

  // ---- the shadow map itself, over the canopy's own texels.
  const smRead = {};
  if (Number.isFinite(build.rect.u0) && build.rect.inside > 50) {
    const x0 = Math.max(0, Math.floor(build.rect.u0)), y0 = Math.max(0, Math.floor(build.rect.v0));
    const w = Math.min(256, Math.max(8, Math.ceil(build.rect.u1 - build.rect.u0)));
    const h = Math.min(256, Math.max(8, Math.ceil(build.rect.v1 - build.rect.v0)));
    for (const arm of ['shipped', 'nofoliage']) {
      await page.evaluate((a) => window.__canopy.setArm(a), arm);
      await page.waitForTimeout(1200);
      const d = await page.evaluate(([x, y, ww, hh]) => window.__canopy.readShadow(x, y, ww, hh),
        [x0, y0, w, h]);
      let s = 0, n = 0;
      for (const v of d) { if (v >= 0.999) continue; s += v; n++; }
      smRead[arm] = { rect: [x0, y0, w, h], meanDepth: n ? s / n : null, writtenTexels: n, total: d.length, raw: d };
    }
    await page.evaluate(() => window.__canopy.setArm('shipped'));
    const a = smRead.shipped, b = smRead.nofoliage;
    let nearer = 0, cmp = 0, sumd = 0;
    for (let i = 0; i < a.raw.length; i++) {
      if (a.raw[i] >= 0.999 && b.raw[i] >= 0.999) continue;
      cmp++;
      const dd = b.raw[i] - a.raw[i];
      sumd += dd;
      if (dd > 1e-6) nearer++;
    }
    smRead.compare = { texelsCompared: cmp, texelsWhereCanopyIsNearerTheLight: nearer,
      pctNearer: cmp ? +((nearer / cmp) * 100).toFixed(2) : 0,
      meanDepthShift: cmp ? +(sumd / cmp).toFixed(6) : 0 };
    delete smRead.shipped.raw; delete smRead.nofoliage.raw;
    console.log(`  SHADOW MAP over the canopy's texels: ${cmp} texels compared, ` +
      `${smRead.compare.pctNearer}% are nearer the light with foliage in the depth pass ` +
      `(mean normalised depth shift ${smRead.compare.meanDepthShift})`);
  } else {
    console.log('  SHADOW MAP: canopy footprint not inside the sun frustum, skipped');
  }

  // ---- measurements.
  function stats(img, mask) {
    const c = img.channels, d = img.data;
    let s = 0, s2 = 0, n = 0, lsd = 0, ln = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      if (!mask[y * W + x]) continue;
      const v = lum(d, (y * W + x) * c);
      s += v; s2 += v * v; n++;
      // local contrast: SD of the 3x3 neighbourhood, which is what "dapple" is.
      let ls = 0, ls2 = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const u = lum(d, ((y + dy) * W + (x + dx)) * c); ls += u; ls2 += u * u;
      }
      lsd += Math.sqrt(Math.max(0, ls2 / 9 - (ls / 9) ** 2)); ln++;
    }
    return { mean: n ? +(s / n).toFixed(2) : 0, sd: n ? +Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)).toFixed(2) : 0,
      localSD: ln ? +(lsd / ln).toFixed(3) : 0, n };
  }
  function diff(a, b, mask) {
    const c = a.channels;
    let changed = 0, n = 0, sum = 0, signed = 0, maxAbs = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const i = (y * W + x) * c;
      const dv = lum(a.data, i) - lum(b.data, i);
      if (Math.abs(dv) > 2) changed++;
      sum += Math.abs(dv); signed += dv; n++;
      if (Math.abs(dv) > maxAbs) maxAbs = Math.abs(dv);
    }
    return { pctChanged: n ? +((changed / n) * 100).toFixed(2) : 0, meanAbs: n ? +(sum / n).toFixed(3) : 0,
      meanSigned: n ? +(signed / n).toFixed(3) : 0, maxAbs: +maxAbs.toFixed(0), n };
  }

  // ---- the footprint the RENDER shows, as opposed to the one the geometry
  // predicts: every visible ground pixel the foliage actually darkens. The
  // modelled mask above is a conservative sample of the canopy (vertices thinned
  // to a 0.35 m grid); this is the whole thing, and it is what decides whether a
  // viewer would see dapple at all.
  {
    const c0 = shots.shipped.img.channels;
    let n = 0, sum = 0, worst = 0;
    for (let i = 0; i < W * H; i++) {
      if (!groundM[i]) continue;
      const j = i * c0;
      const dark = lum(shots.nofoliage.img.data, j) - lum(shots.shipped.img.data, j);
      if (dark <= 4) continue;
      n++; sum += dark; if (dark > worst) worst = dark;
    }
    const gpx = cnt(groundM);
    measured = { groundPxInFrame: gpx, darkenedPx: n,
      pctOfVisibleGround: gpx ? +((n / gpx) * 100).toFixed(2) : 0,
      meanDarkening: n ? +(sum / n).toFixed(2) : 0, maxDarkening: +worst.toFixed(0),
      pctOfFrame: +((n / (W * H)) * 100).toFixed(3) };
    console.log(`  MEASURED footprint: the foliage darkens ${n} of ${gpx} visible ground pixels ` +
      `(${measured.pctOfVisibleGround}% of the ground, ${measured.pctOfFrame}% of the frame) ` +
      `by a mean ${measured.meanDarkening}/255, worst ${measured.maxDarkening}`);
  }

  {
    const c0 = shots.shipped.img.channels;
    let n = 0, sum = 0, lit = 0;
    for (let i = 0; i < W * H; i++) {
      if (!groundM[i]) continue;
      const j = i * c0;
      const d0 = lum(shots.noshadow.img.data, j) - lum(shots.shipped.img.data, j);
      n++; sum += d0; if (d0 > 4) lit++;
    }
    allShadow = { groundPx: n, meanRemoved: n ? +(sum / n).toFixed(2) : 0,
      pctGroundShadowedOver4: n ? +((lit / n) * 100).toFixed(2) : 0 };
    console.log(`  WHOLE shadow pass on the same ground: removes a mean ${allShadow.meanRemoved}/255, ` +
      `${allShadow.pctGroundShadowedOver4}% of visible ground darkened by more than 4`);
  }

  const m = {
    noiseFloor: diff(shots.shipped.img, shots.noise.img, shadowM),
    canopyShadowGround: diff(shots.shipped.img, shots.nofoliage.img, shadowM),
    openGroundControl: diff(shots.shipped.img, shots.nofoliage.img, controlM),
    selfTest_foliageOnlyVsNoFoliage: diff(shots.foliageonly.img, shots.nofoliage.img, shadowM),
    luma: {
      shadowGround_shipped: stats(shots.shipped.img, shadowM),
      shadowGround_nofoliage: stats(shots.nofoliage.img, shadowM),
      openGround_shipped: stats(shots.shipped.img, controlM),
      openGround_nofoliage: stats(shots.nofoliage.img, controlM),
    },
  };
  const f = (o) => `${o.pctChanged}% px changed, mean |d| ${o.meanAbs}, signed ${o.meanSigned}, max ${o.maxAbs}, n=${o.n}`;
  console.log(`  noise floor (shipped vs shipped)        : ${f(m.noiseFloor)}`);
  console.log(`  CANOPY SHADOW GROUND  shipped-nofoliage : ${f(m.canopyShadowGround)}`);
  console.log(`  OPEN GROUND CONTROL   shipped-nofoliage : ${f(m.openGroundControl)}`);
  console.log(`  self-test foliageonly vs nofoliage     : ${f(m.selfTest_foliageOnlyVsNoFoliage)}`);
  const L = m.luma;
  console.log(`  luma under canopy : shipped ${L.shadowGround_shipped.mean} (local SD ${L.shadowGround_shipped.localSD})` +
    `  ·  no-foliage ${L.shadowGround_nofoliage.mean} (local SD ${L.shadowGround_nofoliage.localSD})`);
  console.log(`  luma open ground  : shipped ${L.openGround_shipped.mean} (local SD ${L.openGround_shipped.localSD})` +
    `  ·  no-foliage ${L.openGround_nofoliage.mean} (local SD ${L.openGround_nofoliage.localSD})`);

  report.times[tod] = {
    sun: build.sun, geometry: build.geometry, canopyLit: build.canopyLit, canopyVerts: build.canopyVerts, shadowPoints: build.shadowPts,
    shadowMaskVerified: { hitGround: build.shadowMask.hitGround, tested: build.shadowMask.tested,
      occluded: build.shadowMask.occluded, offscreen: build.shadowMask.offscreen, px: cnt(shadowM) },
    controlMaskVerified: { hitGround: build.controlMask.hitGround, tested: build.controlMask.tested, px: cnt(controlM) },
    shadowFrustum: { inside: build.rect.inside, total: build.rect.total,
      texelSpanU: [+build.rect.u0.toFixed(0), +build.rect.u1.toFixed(0)],
      texelSpanV: [+build.rect.v0.toFixed(0), +build.rect.v1.toFixed(0)],
      metresPerTexel: +build.rect.metresPerTexel.toFixed(4) },
    shadowMapReadback: smRead.compare ?? null,
    measuredFootprint: measured,
    wholeShadowPassOnGround: allShadow,
    measure: m,
  };

  // ---- the mask, drawn over the frame it was derived from. The mask is the
  // claim, so it has to be lookable-at.
  const base = shots.shipped.img, c = base.channels;
  const ov = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const s = i * c;
    let r = base.data[s], g = base.data[s + 1], b = base.data[s + 2];
    if (shadowM[i]) { r = 255; g = Math.round(g * 0.25); b = Math.round(b * 0.25); }
    else if (controlM[i]) { r = Math.round(r * 0.25); g = Math.round(g * 0.3); b = 255; }
    ov[i * 3] = r; ov[i * 3 + 1] = g; ov[i * 3 + 2] = b;
  }
  writePNG(`${OUT}/${TAG}-${SHOT}-${tod}-masks.png`, W, H, ov);

  // The ground-ID render itself, so the mask's premise is checkable too.
  const gpng = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const s2 = i * c;
    const v = groundM[i] ? 255 : 0;
    gpng[i * 3] = Math.round(base.data[s2] * 0.35 + v * 0.65);
    gpng[i * 3 + 1] = Math.round(base.data[s2 + 1] * 0.35 + v * 0.65);
    gpng[i * 3 + 2] = Math.round(base.data[s2 + 2] * 0.35 + v * 0.65);
  }
  writePNG(`${OUT}/${TAG}-${SHOT}-${tod}-ground.png`, W, H, gpng);

  // ---- an amplified difference image: what the canopy took out of the ground.
  const dv = Buffer.alloc(W * H * 3);
  const nf = shots.nofoliage.img;
  for (let i = 0; i < W * H; i++) {
    const s = i * c;
    const d0 = lum(nf.data, s) - lum(base.data, s);       // positive = canopy darkened it
    const v = Math.max(0, Math.min(255, Math.round(d0 * 6)));
    dv[i * 3] = v; dv[i * 3 + 1] = v; dv[i * 3 + 2] = v;
  }
  writePNG(`${OUT}/${TAG}-${SHOT}-${tod}-removed6x.png`, W, H, dv);
}

fs.writeFileSync(`docs/${TAG}-shadow-${SHOT}.json`, JSON.stringify(report, null, 1));
console.log(`\nwrote docs/${TAG}-shadow-${SHOT}.json`);
if (errors.length) console.log('page errors:', errors);
await browser.close();
