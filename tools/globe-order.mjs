// #136, IN THE DISTRICT: is a street lamp's globe brighter than what its own light lights?
//
// A blind reviewer measured a warm disc on the corridor's right facade at night carrying about 29x
// the light of the lamp that makes it, and three more things a lamp lights brighter than itself. The
// mechanism is two numbers that were never tied together: the LightPool places a 900 cd PointLight at
// each outer globe, and the globe is an emissive mesh at 1.76 nits. This probe asks the question per
// pixel, at the hero cameras, without a mask:
//
//   ON     the frame as it ships
//   OFF    the same frame with the LightPool's ten lights at intensity 0 (kept VISIBLE, so the shader's
//          light count does not change and nothing recompiles between the two reads)
//   LIT    ON - OFF, per pixel: exactly what the street lamps' light adds, and nothing else
//
// and divides LIT by the globe's own luminance, read back off the material. A pixel over 1 is a
// surface a lamp lights brighter than the lamp's own globe. Every globe in the district is the same
// material, so one luminance serves every lamp in frame. The ratio is a ratio of two radiances in
// ONE frame of the HDR scene target, so it does not depend on the exposure, the tonemap or the hour;
// and because a globe's luminance is a single number the ratio is LINEAR in it: the level at which
// the globe would equal a pixel is the current level times that pixel's ratio.
//
//   node tools/globe-order.mjs                                   corridor + fivepoints at night
//   GO_SHOTS=corridor GO_TIMES=night,dusk node tools/globe-order.mjs
//   GO_LEVELS=0.000447,0.01 node tools/globe-order.mjs           re-measure at globe levels (fractions
//                                                                of physical) on the same page load
//   node tools/globe-order.mjs --selftest                        the pure half, offline
//
// Output: docs/globe-order.json, and per camera, hour and level docs/shots/globeord-<shot>-<tod>-<i>.png
// (the ratio map: black under 0.1, grey to white 0.1 -> 1, red to yellow 1 -> 100) beside the frame.
//
// WHAT IT CANNOT SEE, stated: only the ten lamps the pool has promoted light anything, so "the
// brightest surface a lamp lights" is over those ten; and LIT includes every pool light's
// contribution to a pixel, so a pixel two lamps light is compared with ONE globe — which is the
// comparison a viewer makes, since every globe is the same luminance.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { luma, triangleArea, physicalLuminance, radialProfile, footprint, quantilesOf } from './globe-math.mjs';

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const SELFTEST = IS_MAIN && process.argv.includes('--selftest');

/** The ratio map's colour: black under 0.1, grey 0.1 -> 1, red -> yellow 1 -> 100. */
export function ratioColour(q) {
  if (!(q >= 0.1)) return [0, 0, 0];
  if (q < 1) { const v = Math.round(40 + 160 * Math.log10(q / 0.1)); return [v, v, v]; }
  const t = Math.min(1, Math.log10(q) / 2);
  return [255, Math.round(255 * t), 0];
}

if (SELFTEST) {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  };
  // A unit square as two triangles, and a cube of side 2 (24 m^2): the area off a buffer.
  const sq = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  check('the area of a unit square, two triangles, is 1', Math.abs(triangleArea(sq).area - 1) < 1e-12,
    `${triangleArea(sq).area}`);
  const THREE = await import('../vendor/three.module.min.js');
  const box = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  const ba = triangleArea(box.attributes.position.array);
  check('a 2 m cube off three\'s own buffer: 24 m^2 in 12 triangles, centred, radius sqrt 3',
    Math.abs(ba.area - 24) < 1e-9 && ba.triangles === 12 && ba.centre.every((c) => Math.abs(c) < 1e-9) &&
      Math.abs(ba.radius - Math.sqrt(3)) < 1e-9, JSON.stringify(ba));
  // A fine sphere's S/4 is pi r^2 — Cauchy — so the "mean projected area" reads a real sphere right.
  const sph = new THREE.SphereGeometry(0.25, 96, 64).toNonIndexed();
  const sa = triangleArea(sph.attributes.position.array);
  check('a 96x64 sphere of r 0.25: S/4 within 0.1% of pi r^2', Math.abs(sa.area / 4 / (Math.PI * 0.0625) - 1) < 1e-3,
    `${(sa.area / 4).toFixed(5)} against ${(Math.PI * 0.0625).toFixed(5)}`);
  // pick: a merged pair of globes, the outer one alone.
  const pair = [...new THREE.SphereGeometry(0.25, 5, 3).translate(2.2, 7.7, 0).toNonIndexed().attributes.position.array,
    ...new THREE.SphereGeometry(0.22, 5, 3).translate(-1, 7.66, 0).toNonIndexed().attributes.position.array];
  const outer = triangleArea(pair, (x) => x > 0.6);
  check('pick keeps the outer globe of a merged pair: 20 triangles centred at x 2.2, radius 0.25',
    outer.triangles === 20 && Math.abs(outer.centre[0] - 2.2) < 1e-6 && Math.abs(outer.radius - 0.25) < 1e-6,
    JSON.stringify({ t: outer.triangles, c: outer.centre.map((v) => +v.toFixed(4)), r: +outer.radius.toFixed(4) }));
  // The flux identity: L * pi * S = 4 * pi * I.
  const I = 900, rgb = [1, 0.5841, 0.2542];
  const L = physicalLuminance(I, rgb, outer.area / 4);
  check('a globe at physicalLuminance radiates its light\'s flux: pi L S = 4 pi I luma(colour)',
    Math.abs(Math.PI * L * outer.area - 4 * Math.PI * I * luma(...rgb)) < 1e-6 * L, `L ${L.toFixed(1)} nits`);
  check('...and a zero area is not a luminance', Number.isNaN(physicalLuminance(I, rgb, 0)));
  // radialProfile / footprint on a synthetic Gaussian, rows bottom-up.
  const w = 101, h = 101, sig = 6, plane = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    plane[(h - 1 - y) * w + x] = 10 * Math.exp(-((x + 0.5 - 50.5) ** 2 + (y + 0.5 - 50.5) ** 2) / (2 * sig * sig));
  }
  const prof = radialProfile(plane, w, h, 50.5, 50.5, 40);
  const fp = footprint(prof, [1, 0.1, 100]);
  const want1 = sig * Math.sqrt(2 * Math.log(10)), want01 = sig * Math.sqrt(2 * Math.log(100));
  check('footprint of a sigma-6 Gaussian of peak 10: under 1 at ~12.9 px, under 0.1 at ~18.2, never over 100',
    Math.abs(fp[0] - want1) <= 1 && Math.abs(fp[1] - want01) <= 1 && fp[2] === null,
    `${fp.join(' / ')} against ${want1.toFixed(1)} / ${want01.toFixed(1)} / null`);
  // KNOWN-BAD: a profile read top-down where the plane is bottom-up puts an off-centre spot elsewhere.
  const spot = new Float32Array(w * h); spot[(h - 1 - 20) * w + 70] = 5;   // screen (70, 20)
  check('the profile reads rows bottom-up: a spot at SCREEN (70, 20) is at radius 0 about (70.5, 20.5)',
    radialProfile(spot, w, h, 70.5, 20.5, 2)[0] > 0 && radialProfile(spot, w, h, 70.5, 80.5, 2)[0] === 0);
  const tooShort = footprint([5, 4, 3, 2], [1]);
  check('a profile that never falls under a level within its length reads Infinity, not a radius',
    tooShort[0] === Infinity, `${tooShort}`);
  const q = quantilesOf([1, 2, 3, 4]);
  check('quantiles: p50 of 1..4 is the third sample (floor index), max 4, n 4', q.p50 === 3 && q.max === 4 && q.n === 4);
  check('the map: under 0.1 black, 1 is red, 100 and over yellow',
    ratioColour(0.05).join() === '0,0,0' && ratioColour(1).join() === '255,0,0' && ratioColour(1e4).join() === '255,255,0');
  const failed = checks.filter((x) => !x.ok).length;
  const CHECK_COUNT = 11;
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nGLOBE ORDER SELFTEST: ${failed || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
    `${counted ? '' : ` (expected ${CHECK_COUNT})`}, ${failed} failed`);
  process.exit(failed || !counted ? 1 : 0);
}

if (IS_MAIN && !SELFTEST) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } = await import('./hero-cams.mjs');
  const { writePNG } = await import('./crop.mjs');

  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const TIMES = (process.env.GO_TIMES ?? 'night').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY = (process.env.GO_SHOTS ?? 'corridor,fivepoints').split(',').map((s) => s.trim()).filter(Boolean);
  const shots = HERO_FRAMINGS.filter((s) => ONLY.includes(s.name));
  if (shots.length !== ONLY.length) throw new Error(`GO_SHOTS names no such framing: ${ONLY}`);
  // Levels as fractions of the PHYSICAL luminance; empty means "measure the level the build ships".
  const LEVELS = (process.env.GO_LEVELS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (LEVELS.some((v) => !(v > 0))) throw new Error(`GO_LEVELS must be positive fractions: ${process.env.GO_LEVELS}`);
  const N = Number(process.env.GO_FRAMES ?? 3);
  // Candidate levels priced off every read, and an optional dump of the planes (Float32, top-down rows).
  const CANDIDATES = [1 / 600, 1 / 300, 1 / 150, 1 / 100, 1 / 60, 1 / 40, 1 / 20, 1 / 10, 1 / 5, 1];
  const DUMP = process.env.GO_DUMP ?? null;
  const TAG = process.env.GO_TAG ?? 'globeord';
  const PORT = Number(process.env.GO_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // traffic=0 and no crowd: the ON and OFF reads are two frames, and nothing may move between them.
  await page.goto(`http://127.0.0.1:${PORT}/district/?traffic=0`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 300000 });
  await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
  await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
  await page.evaluate(() => __district.setPedestrians(0));

  const FNS = [luma, triangleArea, physicalLuminance, radialProfile, footprint, quantilesOf, ratioColour];
  const SRC = `(() => {\n${FNS.map((f) => `const ${f.name} = ${f.toString()};`).join('\n')}\n` +
    `return { ${FNS.map((f) => f.name).join(', ')} };\n})()`;

  const runs = [];
  for (const s of shots) {
    const placed = await placeHeroCam(page, s);
    console.log(`${s.name}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ${placed.clearance} m clear`);
    await settleFrames(page, FRAME_SETTLE, `camera ${s.name}`);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await settleFrames(page, FRAME_SETTLE, `tod ${tod}`);
      const levels = LEVELS.length ? LEVELS : [null];
      for (const [li, level] of levels.entries()) {
        const r = await page.evaluate(async ({ src, level, n, cand, wantDump }) => {
          const M = eval(src);   // eslint-disable-line no-eval
          const d = __district, p = d.post, R = d.renderer, lp = d.lightPool, fur = d.furniture, cam = d.camera;
          const waitFrames = (k) => new Promise((res) => {
            const f0 = d.frames;
            const tick = () => (d.frames >= f0 + k ? res(d.frames) : setTimeout(tick, 100));
            tick();
          });
          const head = fur.headMat;
          const Color = head.emissive.constructor;
          // The outer globe off the head mesh's own buffer: every triangle on the +x side of the post.
          const geo = fur.heads.geometry;
          const g = M.triangleArea(geo.attributes.position.array, (x) => x > 0);
          const e0 = lp.emitters[0];
          const lc = new Color(e0.color);
          const Lphys = M.physicalLuminance(e0.candela, [lc.r, lc.g, lc.b], g.area / 4);
          const lumE = M.luma(head.emissive.r, head.emissive.g, head.emissive.b);
          const before = head.emissiveIntensity;
          if (level !== null) head.emissiveIntensity = level * Lphys / lumE;
          const Lemit = lumE * head.emissiveIntensity;
          const pp = d.postParams();
          const readHalf = (rt) => {
            const w = rt.width, h = rt.height;
            const raw = new Uint16Array(w * h * 4);
            R.readRenderTargetPixels(rt, 0, 0, w, h, raw);
            return { w, h, raw };
          };
          const h2f = (v) => {
            const sg = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
            if (e === 0) return sg * f * 5.9604644775390625e-8;
            if (e === 31) return f ? NaN : sg * Infinity;
            return sg * Math.pow(2, e - 15) * (1 + f / 1024);
          };
          const lumPlane = (t) => {
            const out = new Float32Array(t.w * t.h), tag = new Float32Array(t.w * t.h);
            for (let i = 0; i < out.length; i++) {
              const k = i * 4;
              out[i] = M.luma(h2f(t.raw[k]), h2f(t.raw[k + 1]), h2f(t.raw[k + 2]));
              tag[i] = h2f(t.raw[k + 3]);
            }
            return { out, tag };
          };
          await waitFrames(n);
          const onT = readHalf(p.hdr);
          const bloomT = readHalf(p.blurB);
          const poolOn = lp.lights.filter((l) => l.visible && l.intensity > 0).length;
          lp.enabled = false;
          for (const l of lp.lights) l.intensity = 0;
          await waitFrames(n);
          const offT = readHalf(p.hdr);
          lp.enabled = true;
          await waitFrames(1);
          const W = onT.w, H = onT.h;
          const on = lumPlane(onT), off = lumPlane(offT);
          const lit = new Float32Array(W * H), ratio = new Float32Array(W * H);
          for (let i = 0; i < W * H; i++) {
            lit[i] = Math.max(0, on.out[i] - off.out[i]);
            ratio[i] = lit[i] / Lemit;
          }
          // The bloom the composite adds, in exposed luminance, at FULL resolution (nearest half-res texel).
          const bw = bloomT.w, bh = bloomT.h;
          const bloom = new Float32Array(W * H);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = ((Math.min(bh - 1, y >> 1)) * bw + Math.min(bw - 1, x >> 1)) * 4;
            bloom[y * W + x] = M.luma(h2f(bloomT.raw[k]), h2f(bloomT.raw[k + 1]), h2f(bloomT.raw[k + 2])) * pp.bloomStrength * pp.exposure;
          }
          // The globes in frame: every emitter projected, its CORE (inside 0.6 of its projected radius)
          // read where the emitted part of the pixel is at least 0.9 of the material's own luminance —
          // which is what says the pixel IS that globe and not something in front of it.
          cam.updateMatrixWorld();
          const V3 = cam.position.constructor;
          const tanH = Math.tan((cam.fov * Math.PI / 180) / 2);
          const globes = [];
          for (const [ei, em] of lp.emitters.entries()) {
            const v = new V3(em.x, em.y, em.z);
            const vv = v.clone().applyMatrix4(cam.matrixWorldInverse);
            const depth = -vv.z;
            if (!(depth > 0.5)) continue;
            const ndc = v.clone().project(cam);
            if (Math.abs(ndc.x) > 1.05 || Math.abs(ndc.y) > 1.05) continue;
            const sx = (ndc.x + 1) / 2 * W, sy = (1 - ndc.y) / 2 * H;
            const rpx = g.radius * (H / 2) / (tanH * depth);
            const rc = Math.max(0.75, 0.6 * rpx);
            let nCore = 0, sumOn = 0, sumEmit = 0, sumLit = 0, peakOn = 0;
            for (let y = Math.floor(sy - rc); y <= Math.ceil(sy + rc); y++) {
              for (let x = Math.floor(sx - rc); x <= Math.ceil(sx + rc); x++) {
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                if (Math.hypot(x + 0.5 - sx, y + 0.5 - sy) > rc) continue;
                const i = (H - 1 - y) * W + x;
                const t = -on.tag[i] - 1;
                const share = t >= 0 && t <= 1 ? t : 0;
                // The emitted part IS the material's luminance, within the tag's half-float step: under it
                // is a pixel the globe only partly covers, over it another emitter standing in the disc.
                // Measured at corridor/dusk before this read both ways: a far globe's disc held a lit
                // window, whose 7.9 nits of emission passed a one-sided test and was reported as the globe.
                if (Math.abs(share * on.out[i] - Lemit) > 0.1 * Lemit + 0.002 * on.out[i]) continue;
                nCore++; sumOn += on.out[i]; sumEmit += share * on.out[i]; sumLit += lit[i];
                peakOn = Math.max(peakOn, on.out[i]);
              }
            }
            if (!nCore) continue;
            const prof = M.radialProfile(bloom, W, H, sx, sy, 60);
            globes.push({ i: ei, x: +em.x.toFixed(2), z: +em.z.toFixed(2), sx: +sx.toFixed(1), sy: +sy.toFixed(1),
              depth: +depth.toFixed(1), rpx: +rpx.toFixed(2), core: nCore,
              meanOn: sumOn / nCore, meanEmit: sumEmit / nCore, meanLit: sumLit / nCore, peakOn,
              bloomPeak: prof[0], footprint: M.footprint(prof, [1, 0.1, 0.01]) });
          }
          globes.sort((a, b) => a.depth - b.depth);
          // The ratio population: every pixel the lamps add at least a tenth of a globe's luminance to.
          const pop = [];
          let over1 = 0, over2 = 0, over10 = 0;
          for (let i = 0; i < W * H; i++) {
            const q = ratio[i];
            if (q >= 0.1) pop.push(q);
            if (q > 1) over1++; if (q > 2) over2++; if (q > 10) over10++;
          }
          // Components of ratio > 1, as boxes in screen rows, so they can be found in the frame.
          const lab = new Int32Array(W * H).fill(-1);
          const comps = [];
          const stack = [];
          for (let i = 0; i < W * H; i++) {
            if (lab[i] >= 0 || !(ratio[i] > 1)) continue;
            const id = comps.length;
            let area = 0, mx = 0, sum = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sumLit = 0;
            lab[i] = id; stack.push(i);
            while (stack.length) {
              const j = stack.pop();
              const x = j % W, yb = (j / W) | 0, y = H - 1 - yb;
              area++; sum += ratio[j]; mx = Math.max(mx, ratio[j]); sumLit += lit[j];
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              for (const q of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, yb > 0 ? j - W : -1, yb < H - 1 ? j + W : -1]) {
                if (q >= 0 && lab[q] < 0 && ratio[q] > 1) { lab[q] = id; stack.push(q); }
              }
            }
            comps.push({ area, max: mx, mean: sum / area, meanLitNits: sumLit / area, box: [x0, y0, x1, y1] });
          }
          comps.sort((a, b) => b.max * Math.sqrt(b.area) - a.max * Math.sqrt(a.area));
          // AT A CANDIDATE LEVEL, from the same two reads: the ratio is linear in the globe's luminance, so
          // the pixels a globe at level L would still be outshone by are the ones whose lamp light exceeds
          // L x physical. No re-render, and so no second residency or second camera to register.
          const candidates = cand.map((c) => {
            const bar = c * Lphys;
            let n = 0, worst = 0;
            for (let i = 0; i < W * H; i++) { if (lit[i] > bar) n++; if (lit[i] > worst) worst = lit[i]; }
            return { level: c, globeNits: bar, pixelsOver: n, worstRatio: worst / bar };
          });
          // The planes themselves, top-down rows, when a dump was asked for.
          let dump = null;
          if (wantDump) {
            const topDown = (src) => {
              const o = new Float32Array(W * H);
              for (let y = 0; y < H; y++) o.set(src.subarray((H - 1 - y) * W, (H - y) * W), y * W);
              return o;
            };
            const b64 = (f) => {
              const u8 = new Uint8Array(f.buffer);
              let bin = '';
              for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
              return btoa(bin);
            };
            dump = { lit: b64(topDown(lit)), on: b64(topDown(on.out)), tag: b64(topDown(on.tag)), bloom: b64(topDown(bloom)) };
          }
          // The map, top-down rows.
          const rgb = new Uint8Array(W * H * 3);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const c = M.ratioColour(ratio[(H - 1 - y) * W + x]);
            const o = (y * W + x) * 3;
            rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
          }
          let bin = '';
          for (let i = 0; i < rgb.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
          const restored = before;
          if (level !== null) head.emissiveIntensity = restored;
          return {
            w: W, h: H, poolOn, exposure: pp.exposure, bloomStrength: pp.bloomStrength,
            globe: { triangles: g.triangles, area: g.area, meanArea: g.area / 4, radius: g.radius, centre: g.centre },
            light: { candela: e0.candela, color: e0.color, lumColour: M.luma(lc.r, lc.g, lc.b), reach: e0.distance },
            Lphys, Lemit, level: Lemit / Lphys, emissiveIntensity: Lemit / lumE,
            globes, ratio: M.quantilesOf(pop), over1, over2, over10, comps: comps.slice(0, 16), candidates, dump,
            map: btoa(bin),
          };
        }, { src: SRC, level, n: N, cand: CANDIDATES, wantDump: !!DUMP });
        const mapPath = `docs/shots/${TAG}-${s.name}-${tod}-${li}.png`;
        writePNG(mapPath, r.w, r.h, Buffer.from(r.map, 'base64'));
        delete r.map;
        if (r.dump) {
          fs.mkdirSync(DUMP, { recursive: true });
          for (const [k, v] of Object.entries(r.dump)) fs.writeFileSync(`${DUMP}/${TAG}-${s.name}-${tod}-${li}-${k}.f32`, Buffer.from(v, 'base64'));
        }
        delete r.dump;
        let frameErr = null;
        try { await page.screenshot({ path: `docs/shots/${TAG}-${s.name}-${tod}-${li}-frame.png`, timeout: 180000 }); }
        catch (e) { frameErr = e.message.split('\n')[0]; }
        console.log(`\n${s.name}/${tod} level ${r.level.toExponential(3)} of physical (globe ${r.Lemit.toFixed(3)} nits, ` +
          `physical ${r.Lphys.toFixed(1)}; emissiveIntensity ${r.emissiveIntensity.toFixed(3)}), pool lights on ${r.poolOn}`);
        console.log(`  outer globe off the buffer: ${r.globe.triangles} triangles, S ${r.globe.area.toFixed(5)} m2, ` +
          `S/4 ${r.globe.meanArea.toFixed(5)} m2, radius ${r.globe.radius.toFixed(4)} m; light ${r.light.candela} cd ` +
          `x luma ${r.light.lumColour.toFixed(4)}`);
        const Q = r.ratio;
        if (Q) console.log(`  lamp light over the globe's luminance, ${Q.n} px over 0.1: p50 ${Q.p50.toFixed(3)} ` +
          `p90 ${Q.p90.toFixed(3)} p99 ${Q.p99.toFixed(3)} p99.9 ${Q.p99_9.toFixed(3)} max ${Q.max.toFixed(2)}`);
        console.log(`  pixels a lamp lights BRIGHTER than its globe: ${r.over1} (x2: ${r.over2}, x10: ${r.over10})`);
        for (const c of r.comps.slice(0, 10)) {
          console.log(`    box ${c.box.join(',').padEnd(20)} ${String(c.area).padStart(6)} px  max x${c.max.toFixed(2).padStart(7)}` +
            `  mean x${c.mean.toFixed(2).padStart(6)}  lamp light ${c.meanLitNits.toFixed(2)} nits`);
        }
        console.log(`  globes in frame (${r.globes.length}), nearest first:`);
        console.log('  at a candidate level (fraction of physical): pixels a lamp lights brighter than its globe, worst ratio');
        for (const c of r.candidates) {
          console.log(`    1/${(1 / c.level).toFixed(0).padEnd(5)} globe ${c.globeNits.toFixed(1).padStart(7)} nits  ${String(c.pixelsOver).padStart(6)} px  worst x${c.worstRatio.toFixed(2)}`);
        }
        for (const gl of r.globes.slice(0, 10)) {
          console.log(`    #${String(gl.i).padEnd(5)} at (${gl.sx}, ${gl.sy}) ${String(gl.depth).padStart(6)} m  r ${gl.rpx} px  core ${gl.core}` +
            `  emit ${gl.meanEmit.toFixed(3)} on ${gl.meanOn.toFixed(3)} lit ${gl.meanLit.toFixed(3)} nits` +
            `  bloom peak ${gl.bloomPeak === null ? '-' : gl.bloomPeak.toFixed(3)} exposed, under 1/0.1/0.01 at ${gl.footprint.join('/')} px`);
        }
        runs.push({ shot: s.name, tod, level, placed, frameErr, ...r });
        fs.writeFileSync(`docs/${TAG}.json`, JSON.stringify({ runs, pageErrors: errors, partial: true }, null, 1));
      }
    }
  }
  fs.writeFileSync(`docs/${TAG}.json`, JSON.stringify({ runs, pageErrors: errors, partial: false }, null, 1));
  console.log(`\nwrote docs/${TAG}.json`);
  await browser.close();
  if (errors.length) { console.log('page errors:', errors.slice(0, 5)); process.exit(1); }
}
