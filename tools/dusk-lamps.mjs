// #142: WOULD A PHOTOCELL HAVE LIT THESE LAMPS AT THE DUSK PRESET, AND WHAT IS EACH THING IN THE FRAME
// THAT EMITS?
//
// #136's blind reviewer measured the dusk lamp globes at 0.59-0.79 of the sky ring round them, with
// (R-B)/L 0.83-1.22 against the sky's 0.17-0.37 — an orange ball rather than a lit frosted globe — and
// found the frame contradicting itself on the prior question: corridor's "low lamp" dark at dusk while
// fivepoints' "wall lamp" glints. This probe asks both questions on the live page, one page load per
// framing, every number off the HDR scene target (linear radiance, before the AO, the bloom and the
// tonemap), so a ratio inside one frame does not depend on the exposure.
//
// FOUR STATES of one settled frame, nothing moving between them (traffic=0, no crowd, clouds frozen):
//
//   A  as the page ships
//   B  the LightPool's lights at intensity 0, kept VISIBLE so nothing recompiles (globe-order's rule)
//   C  the globes' emissive at 0, the pool as shipped
//   D  both: what "the street lamps are off" draws, short of the parked cars' retroreflector
//
// and from them:
//
//   THE METER   an albedo-1, specular-free (MeshPhysicalMaterial, specularIntensity 0), unshadowed
//               patch facing up, 2.4 m in front of the lens: a Lambertian surface of albedo 1 under E
//               lux has radiance E/pi, so pi times its radiance is the horizontal illuminance — the
//               quantity a photocontrol and UN R48's headlamp sensor are both specified against. Read
//               in A, B and with the sun's intensity at 0, which splits it into lamps, sun and sky.
//   THE GLOBES  every street-lamp globe in frame, both of each lamp's, off the module's own LAMP_GLOBES
//               and each lamp's instance matrix: its CORE (inside 0.7 of its projected radius, where the
//               emitted share of the pixel is the material's own emitted luminance to 10% — so the pixel
//               IS that globe and not something in front of it) against a RING of SKY 1.4-2.2 radii out,
//               sky by the composite's own rule (depth >= 0.999999, src/post.js). Luminance ratio and
//               warmth (R-B)/luma, with the emissive on (A) and off (C) on the SAME pixels.
//   THE POOL    what the pool's ten lights add (A - B), per pixel, against what is there without them,
//               and its brightest components — the specular glints on glass and paint.
//   EMITTERS    every pixel whose emitted part (the #114 tag's share x luminance) is visible, as
//               connected components, each identified by a raycast at its peak.
//   THE BOXES   the reviewer's two lamps, corridor [1025,405,1100,465] and fivepoints [1095,230,1205,315]
//               in the 1600x900 hero frame: the peak pixel, identified by a raycast, and the box's mean in
//               each of the four states, which says what switches it.
//
//   node tools/dusk-lamps.mjs                      corridor and fivepoints, dusk and night
//   DL_SHOTS=corridor DL_TIMES=dusk node tools/dusk-lamps.mjs
//   DL_PORT=8283 DL_OUT=/abs/dir                   port, and where the frame captures go
//   node tools/dusk-lamps.mjs --selftest           the pure half on synthetic planes, with known-bads
//
// Output: docs/dusk-lamps-<tag>.json (numbers only), and the A-state frame per (shot, hour) in DL_OUT.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const SELFTEST = IS_MAIN && process.argv.includes('--selftest');

// ---------------------------------------------------------------- the pure half
// Every function here is self-contained (no module scope), because the page runs them as SOURCE.

/** IEEE half to float. */
export function halfToFloat(v) {
  const sg = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
  if (e === 0) return sg * f * 5.9604644775390625e-8;
  if (e === 31) return f ? NaN : sg * Infinity;
  return sg * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Rec. 709 luminance, three's working space. */
export function lumaOf(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** The composite's decode of the #114 tag: alpha -(1 + share) on an emitting lit pixel, else 0. */
export function shareOf(a) {
  const t = -a - 1;
  return t >= 0 && t <= 1 ? t : 0;
}

/** (R - B) / luma of a mean RGB, null where the luma is not positive. */
export function warmthOf(rgb) {
  const L = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return L > 0 ? (rgb[0] - rgb[2]) / L : null;
}

/**
 * A globe's core against its ring of sky. Planes are TOP-DOWN rows, `on`/`off` RGB (3 floats a pixel),
 * `share` and `depth` one float a pixel. `g` is { sx, sy, r } in pixels (y down) and `Lemit` the globe
 * material's emitted luminance in state `on`. A core pixel is inside coreFrac x r AND carries the
 * material's emitted luminance to `tol` (globe-order's test: a pixel the globe only partly covers reads
 * under it, another emitter standing in the disc reads over it). A ring pixel is between ringIn and
 * ringOut radii AND is sky by the composite's own depth rule. Non-finite pixels are counted and left out
 * of both — a NaN in a mean fails every comparison silently (CLAUDE.md, arm-diff).
 */
export function globeRead(planes, W, H, g, Lemit, opts = {}) {
  const coreFrac = opts.coreFrac ?? 0.7, ringIn = opts.ringIn ?? 1.4, ringOut = opts.ringOut ?? 2.2;
  const skyDepth = opts.skyDepth ?? 0.999999, tol = opts.tol ?? 0.1;
  const { on, off, share, depth } = planes;
  const out = { core: 0, coreOn: [0, 0, 0], coreOff: [0, 0, 0], ring: 0, ringN: 0, ringRGB: [0, 0, 0],
    ringOff: [0, 0, 0], nonFinite: 0 };
  const R = ringOut * g.r;
  const x0 = Math.max(0, Math.floor(g.sx - R - 1)), x1 = Math.min(W - 1, Math.ceil(g.sx + R + 1));
  const y0 = Math.max(0, Math.floor(g.sy - R - 1)), y1 = Math.min(H - 1, Math.ceil(g.sy + R + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - g.sx, y + 0.5 - g.sy);
      const inCore = d <= coreFrac * g.r, inRing = d >= ringIn * g.r && d <= ringOut * g.r;
      if (!inCore && !inRing) continue;
      const i = y * W + x, k = 3 * i;
      const a = [on[k], on[k + 1], on[k + 2]], b = [off[k], off[k + 1], off[k + 2]];
      if (![...a, ...b, share[i], depth[i]].every(Number.isFinite)) { out.nonFinite++; continue; }
      const L = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      if (inCore) {
        if (Math.abs(share[i] * L - Lemit) > tol * Lemit + 0.002 * L) continue;
        out.core++;
        for (let c = 0; c < 3; c++) { out.coreOn[c] += a[c]; out.coreOff[c] += b[c]; }
      } else {
        out.ringN++;
        if (!(depth[i] >= skyDepth)) continue;
        out.ring++;
        for (let c = 0; c < 3; c++) { out.ringRGB[c] += a[c]; out.ringOff[c] += b[c]; }
      }
    }
  }
  for (let c = 0; c < 3; c++) {
    if (out.core) { out.coreOn[c] /= out.core; out.coreOff[c] /= out.core; }
    if (out.ring) { out.ringRGB[c] /= out.ring; out.ringOff[c] /= out.ring; }
  }
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const w = (v) => { const L = lum(v); return L > 0 ? (v[0] - v[2]) / L : null; };
  // A ratio needs both sides: a globe with no core pixel or no sky in its ring is REFUSED, not read.
  const ok = out.core > 0 && out.ring >= (opts.minRing ?? 6);
  out.onOverSky = ok ? lum(out.coreOn) / lum(out.ringRGB) : null;
  out.offOverSky = ok ? lum(out.coreOff) / lum(out.ringOff) : null;
  out.warmthOn = out.core ? w(out.coreOn) : null;
  out.warmthOff = out.core ? w(out.coreOff) : null;
  out.warmthSky = out.ring ? w(out.ringRGB) : null;
  out.refused = ok ? null : (out.core ? `ring holds ${out.ring} sky px of ${out.ringN}` : 'no core pixel carries the globe');
  return out;
}

/**
 * 4-connected components of `mask` (Uint8Array, top-down), with `value` (Float32Array) giving each
 * component's peak and sum. Returned largest peak first; `peakAt` is [x, y] in pixels, y down.
 */
export function componentsOf(mask, value, W, H) {
  const lab = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = comps.length;
    const c = { area: 0, box: [W, H, -1, -1], peak: -Infinity, peakAt: [0, 0], sum: 0 };
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % W, y = (j / W) | 0;
      c.area++; c.sum += value[j];
      if (value[j] > c.peak) { c.peak = value[j]; c.peakAt = [x, y]; }
      if (x < c.box[0]) c.box[0] = x; if (y < c.box[1]) c.box[1] = y;
      if (x > c.box[2]) c.box[2] = x; if (y > c.box[3]) c.box[3] = y;
      if (x > 0 && mask[j - 1] && lab[j - 1] < 0) { lab[j - 1] = id; stack.push(j - 1); }
      if (x < W - 1 && mask[j + 1] && lab[j + 1] < 0) { lab[j + 1] = id; stack.push(j + 1); }
      if (y > 0 && mask[j - W] && lab[j - W] < 0) { lab[j - W] = id; stack.push(j - W); }
      if (y < H - 1 && mask[j + W] && lab[j + W] < 0) { lab[j + W] = id; stack.push(j + W); }
    }
    comps.push(c);
  }
  comps.sort((a, b) => b.peak - a.peak);
  return comps;
}

/** Mean of a luminance plane over a box [x0, y0, x1, y1] inclusive, non-finite counted and skipped. */
export function boxMean(plane, W, H, box) {
  let s = 0, n = 0, bad = 0, peak = -Infinity, peakAt = null;
  for (let y = Math.max(0, box[1]); y <= Math.min(H - 1, box[3]); y++) {
    for (let x = Math.max(0, box[0]); x <= Math.min(W - 1, box[2]); x++) {
      const v = plane[y * W + x];
      if (!Number.isFinite(v)) { bad++; continue; }
      s += v; n++;
      if (v > peak) { peak = v; peakAt = [x, y]; }
    }
  }
  return { mean: n ? s / n : null, n, bad, peak: n ? peak : null, peakAt };
}

// ---------------------------------------------------------------- the selftest
if (SELFTEST) {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  };
  // halfToFloat against known bit patterns.
  check('half: 0x3c00 is 1, 0xc000 is -2, 0x7bff is 65504, 0x0001 the smallest subnormal, 0x7e00 NaN',
    halfToFloat(0x3c00) === 1 && halfToFloat(0xc000) === -2 && halfToFloat(0x7bff) === 65504 &&
      Math.abs(halfToFloat(0x0001) - 5.960464477539063e-8) < 1e-20 && Number.isNaN(halfToFloat(0x7e00)));
  check('the tag: -1 is share 0, -1.25 is 0.25, -2 is 1, and +1 (sky, clear, basic) and -2.5 read 0',
    shareOf(-1) === 0 && shareOf(-1.25) === 0.25 && shareOf(-2) === 1 && shareOf(1) === 0 && shareOf(-2.5) === 0);
  check('warmth: a grey reads 0, pure red 1/0.2126, and a black pixel reads null rather than NaN',
    warmthOf([0.5, 0.5, 0.5]) === 0 && Math.abs(warmthOf([1, 0, 0]) - 1 / 0.2126) < 1e-12 && warmthOf([0, 0, 0]) === null);

  // A synthetic frame: a globe of radius 10 px at (50.5, 50.5), its core emitting Lemit plus a lit base;
  // a sky everywhere at depth 1 with a FACADE (depth 0.5, twice as bright) filling the right half of the
  // ring, and a NaN pixel in the ring. Rows top-down.
  const W = 101, H = 101, Lemit = 0.0675;
  const mk = () => ({ on: new Float32Array(W * H * 3), off: new Float32Array(W * H * 3),
    share: new Float32Array(W * H), depth: new Float32Array(W * H).fill(1) });
  const P = mk();
  const sky = [0.08, 0.09, 0.11], wall = [0.2, 0.18, 0.15], base = [0.05, 0.05, 0.05];
  const emitRGB = [Lemit * 1.0 / 0.7342, Lemit * 0.693 / 0.7342, Lemit * 0.352 / 0.7342];   // 0xffd9a0 at Lemit
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, k = 3 * i, d = Math.hypot(x + 0.5 - 50.5, y + 0.5 - 50.5);
    let on = sky, off = sky, sh = 0;
    if (d <= 10) {
      on = [base[0] + emitRGB[0], base[1] + emitRGB[1], base[2] + emitRGB[2]]; off = base;
      sh = Lemit / lumaOf(...on); P.depth[i] = 0.3;
    } else if (x > 55) { on = wall; off = wall; P.depth[i] = 0.5; }
    for (let c = 0; c < 3; c++) { P.on[k + c] = on[c]; P.off[k + c] = off[c]; }
    P.share[i] = sh;
  }
  P.on[3 * (38 * W + 38)] = NaN;   // inside the ring (17 px out, sky side)
  const g = { sx: 50.5, sy: 50.5, r: 10 };
  const r = globeRead(P, W, H, g, Lemit);
  const wantOn = lumaOf(base[0] + emitRGB[0], base[1] + emitRGB[1], base[2] + emitRGB[2]), wantSky = lumaOf(...sky);
  check('a globe reads its core against the SKY in its ring: the facade half is left out, so the ring is the sky',
    r.core > 100 && r.ring > 50 && Math.abs(r.onOverSky - wantOn / wantSky) < 1e-6,
    `core ${r.core} px, ring ${r.ring} of ${r.ringN}, on/sky ${r.onOverSky?.toFixed(4)} against ${(wantOn / wantSky).toFixed(4)}`);
  check('...with the emissive off on the SAME pixels, and the NaN pixel counted rather than averaged',
    Math.abs(r.offOverSky - lumaOf(...base) / wantSky) < 1e-6 && r.nonFinite === 1,
    `off/sky ${r.offOverSky?.toFixed(4)}, non-finite ${r.nonFinite}`);
  // KNOWN-BAD: a ring taken without the depth rule (skyDepth 0) averages the facade in and reads a ratio
  // that is not the sky's — the probe would report the globe darker against a wall than against the sky.
  const rBad = globeRead(P, W, H, g, Lemit, { skyDepth: 0 });
  check('KNOWN-BAD: without the composite\'s sky rule the ring takes the facade, and the ratio moves by over 20%',
    rBad.ring > r.ring && Math.abs(rBad.onOverSky / r.onOverSky - 1) > 0.2,
    `${rBad.onOverSky?.toFixed(4)} against ${r.onOverSky.toFixed(4)}`);
  // A globe hidden behind something nearer: the emitted share no longer matches Lemit, so no core pixel.
  const Q = mk();
  for (let i = 0; i < W * H; i++) { Q.on.set(sky, 3 * i); Q.off.set(sky, 3 * i); }
  const rHidden = globeRead(Q, W, H, g, Lemit);
  check('a globe whose disc carries no globe pixel is REFUSED, not read as 1.0 or 0',
    rHidden.core === 0 && rHidden.onOverSky === null && /no core pixel/.test(rHidden.refused), rHidden.refused);
  // A globe against a wall all round: a ring with no sky is refused.
  const Wl = mk();
  for (let i = 0; i < W * H; i++) { Wl.on.set(wall, 3 * i); Wl.off.set(wall, 3 * i); Wl.depth[i] = 0.5; }
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    if (Math.hypot(x + 0.5 - 50.5, y + 0.5 - 50.5) <= 10) { Wl.on.set(P.on.subarray(3 * i, 3 * i + 3), 3 * i); Wl.share[i] = P.share[i]; }
  }
  const rWall = globeRead(Wl, W, H, g, Lemit);
  check('a globe against a wall all round is refused: a ratio with no sky in it is not a sky ratio',
    rWall.core > 0 && rWall.onOverSky === null && /ring holds 0 sky/.test(rWall.refused), rWall.refused);
  // Warmth of the emitted globe: 0xffd9a0 over a grey base, against a blue-ish sky.
  check('warmth: the emitting core reads warm and the grey base 0, the sky negative',
    r.warmthOn > 0.3 && Math.abs(r.warmthOff) < 1e-9 && r.warmthSky < 0,
    `on ${r.warmthOn.toFixed(3)} off ${r.warmthOff.toFixed(3)} sky ${r.warmthSky.toFixed(3)}`);
  // KNOWN-BAD: the scene target reads back RGBA, four floats a pixel. Handed to globeRead unconverted, every
  // pixel after the first is misaligned, and the read must not come back looking like the right answer.
  const rgba = (src) => { const o = new Float32Array(W * H * 4); for (let i = 0; i < W * H; i++) o.set(src.subarray(3 * i, 3 * i + 3), 4 * i); return o; };
  const r4 = globeRead({ ...P, on: rgba(P.on), off: rgba(P.off) }, W, H, g, Lemit);
  check('KNOWN-BAD: an RGBA plane passed where RGB belongs loses the globe or reads a ratio over 20% off',
    r4.core < 0.5 * r.core || r4.onOverSky === null || Math.abs(r4.onOverSky / r.onOverSky - 1) > 0.2,
    `core ${r4.core} px against ${r.core}, on/sky ${r4.onOverSky === null ? 'refused' : r4.onOverSky.toFixed(4)}`);
  // Components: two blobs, the brighter first, boxes and peaks right; a diagonal touch is two components.
  const cw = 20, ch = 10, m = new Uint8Array(cw * ch), v = new Float32Array(cw * ch);
  for (const [x, y, val] of [[2, 2, 1], [3, 2, 2], [3, 3, 1], [10, 5, 5], [11, 6, 4]]) { m[y * cw + x] = 1; v[y * cw + x] = val; }
  const cs = componentsOf(m, v, cw, ch);
  check('components: 4-connected, brightest peak first, box and peak where they are',
    cs.length === 3 && cs[0].peak === 5 && cs[0].peakAt.join() === '10,5' && cs[0].area === 1 &&
      cs[2].area === 3 && cs[2].box.join() === '2,2,3,3' && cs[2].peakAt.join() === '3,2' && cs[2].sum === 4,
    JSON.stringify(cs.map((c) => [c.area, c.peak, c.box.join('/')])));
  const bm = boxMean(new Float32Array([1, 2, NaN, 4]), 2, 2, [0, 0, 1, 1]);
  check('a box mean skips a NaN and says so', bm.mean === 7 / 3 && bm.bad === 1 && bm.peak === 4 && bm.peakAt.join() === '1,1',
    JSON.stringify(bm));
  const failed = checks.filter((c) => !c.ok).length;
  const CHECK_COUNT = 12;
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nDUSK LAMPS SELFTEST: ${failed || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
    `${counted ? '' : ` (expected ${CHECK_COUNT})`}, ${failed} failed`);
  process.exit(failed || !counted ? 1 : 0);
}

// ---------------------------------------------------------------- the browser half
if (IS_MAIN && !SELFTEST) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } = await import('./hero-cams.mjs');

  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const TIMES = (process.env.DL_TIMES ?? 'dusk,night').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY = (process.env.DL_SHOTS ?? 'corridor,fivepoints').split(',').map((s) => s.trim()).filter(Boolean);
  const shots = HERO_FRAMINGS.filter((s) => ONLY.includes(s.name));
  if (shots.length !== ONLY.length) throw new Error(`DL_SHOTS names no such framing: ${ONLY}`);
  const N = Number(process.env.DL_FRAMES ?? 3);
  const TAG = process.env.DL_TAG ?? 'base';
  const OUT = process.env.DL_OUT ?? null;
  const PORT = Number(process.env.DL_PORT ?? treePort(ROOT));
  // The reviewer's boxes, in the 1600x900 hero frame (BACKLOG #136's review, #142).
  const BOXES = { corridor: { lowLamp: [1025, 405, 1100, 465] }, fivepoints: { wallLamp: [1095, 230, 1205, 315] } };
  const FNS = [halfToFloat, lumaOf, shareOf, warmthOf, globeRead, componentsOf, boxMean];
  const SRC = `(() => {\n${FNS.map((f) => `const ${f.name} = ${f.toString()};`).join('\n')}\n` +
    `return { ${FNS.map((f) => f.name).join(', ')} };\n})()`;
  await ensureServer(PORT, 20000, { root: ROOT });
  const errors = [];
  const runs = [];
  const jsonPath = `docs/dusk-lamps-${TAG}.json`;
  for (const s of shots) {
    const browser = await chromium.launch(launchOptions());
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/district/?traffic=0`, { waitUntil: 'networkidle' });
    await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 600000 });
    await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
    const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
    console.log(`${s.name}: cloud deck ${froze ? `frozen at ${froze.t ?? froze.atSeconds ?? 20}s` : 'NOT FROZEN'}`);
    await page.evaluate(() => __district.setPedestrians(0));
    const placed = await placeHeroCam(page, s);
    console.log(`${s.name}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ${placed.clearance} m clear`);
    await settleFrames(page, FRAME_SETTLE, `camera ${s.name}`);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await settleFrames(page, FRAME_SETTLE, `tod ${tod}`);
      const r = await page.evaluate(async ({ src, n, boxes }) => {
        const M = eval(src);   // eslint-disable-line no-eval
        const THREE = await import('/vendor/three.module.min.js');
        const SF = await import('/src/streetfurniture.js');
        const d = __district, p = d.post, R = d.renderer, lp = d.lightPool, fur = d.furniture, cam = d.camera;
        const waitFrames = (k) => new Promise((res) => {
          const f0 = d.frames;
          const tick = () => (d.frames >= f0 + k ? res(d.frames) : setTimeout(tick, 100));
          tick();
        });
        const W = p.hdr.width, H = p.hdr.height;
        // Read the scene target as top-down planes: RGB (3 a pixel), luminance, and the tag's share.
        const readState = () => {
          const raw = new Uint16Array(W * H * 4);
          R.readRenderTargetPixels(p.hdr, 0, 0, W, H, raw);
          const rgb = new Float32Array(W * H * 3), lum = new Float32Array(W * H), share = new Float32Array(W * H);
          for (let yb = 0; yb < H; yb++) {
            const y = H - 1 - yb;
            for (let x = 0; x < W; x++) {
              const k = (yb * W + x) * 4, i = y * W + x;
              const r0 = M.halfToFloat(raw[k]), g0 = M.halfToFloat(raw[k + 1]), b0 = M.halfToFloat(raw[k + 2]);
              rgb[3 * i] = r0; rgb[3 * i + 1] = g0; rgb[3 * i + 2] = b0;
              lum[i] = M.lumaOf(r0, g0, b0);
              share[i] = M.shareOf(M.halfToFloat(raw[k + 3]));
            }
          }
          return { rgb, lum, share };
        };
        // The depth buffer, through a pass that samples the scene target's depth texture (the composite's
        // own source for "is this sky"), into a float target.
        const readDepth = () => {
          const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });
          const mat = new THREE.ShaderMaterial({
            uniforms: { tD: { value: p.hdr.depthTexture } },
            vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: 'uniform sampler2D tD; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tD, vUv).r, 0.0, 0.0, 1.0); }',
            depthTest: false, depthWrite: false,
          });
          const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
          const sc = new THREE.Scene(); sc.add(quad);
          const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
          const prev = R.getRenderTarget();
          R.setRenderTarget(rt); R.render(sc, oc); R.setRenderTarget(prev);
          const f = new Float32Array(W * H * 4);
          R.readRenderTargetPixels(rt, 0, 0, W, H, f);
          rt.dispose(); mat.dispose(); quad.geometry.dispose();
          const depth = new Float32Array(W * H);
          for (let yb = 0; yb < H; yb++) for (let x = 0; x < W; x++) depth[(H - 1 - yb) * W + x] = f[(yb * W + x) * 4];
          return depth;
        };
        // THE METER: an albedo-1, specular-free, unshadowed patch facing up, 2.4 m ahead of the lens.
        const mm = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, specularIntensity: 0 });
        const S = 0.45;
        const meter = new THREE.Mesh(new THREE.PlaneGeometry(2 * S, 2 * S).rotateX(-Math.PI / 2), mm);
        meter.castShadow = false; meter.receiveShadow = false; meter.frustumCulled = false; meter.renderOrder = 999;
        cam.updateMatrixWorld();
        const e = cam.matrixWorld.elements;
        const right = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]], back = [e[8], e[9], e[10]];
        const at = (dr, du, df) => [0, 1, 2].map((c) => cam.position.getComponent(c) + right[c] * dr + up[c] * du - back[c] * df);
        meter.position.fromArray(at(-1.05, -0.62, 2.4));
        meter.visible = false;
        d.scene.add(meter);
        meter.updateMatrixWorld(true);
        // Its inner 40% on screen, so no edge pixel is read.
        const corners = [[-S, -S], [S, -S], [S, S], [-S, S]].map(([u, v]) =>
          new THREE.Vector3(meter.position.x + u * 0.4, meter.position.y, meter.position.z + v * 0.4).project(cam));
        const mbox = [Math.ceil(Math.min(...corners.map((c) => (c.x + 1) / 2 * W))), Math.ceil(Math.min(...corners.map((c) => (1 - c.y) / 2 * H))),
          Math.floor(Math.max(...corners.map((c) => (c.x + 1) / 2 * W))), Math.floor(Math.max(...corners.map((c) => (1 - c.y) / 2 * H)))];
        const readMeter = async () => {
          meter.visible = true;
          await waitFrames(n);
          const st = readState();
          meter.visible = false;
          const b = M.boxMean(st.lum, W, H, mbox);
          return { lux: b.mean === null ? null : Math.PI * b.mean, n: b.n, bad: b.bad };
        };
        const head = fur.headMat;
        const lumE = M.lumaOf(head.emissive.r, head.emissive.g, head.emissive.b);
        const shippedEI = head.emissiveIntensity;
        const Lemit = lumE * shippedEI;
        const poolOff = () => { lp.enabled = false; for (const l of lp.lights) l.intensity = 0; };
        const poolOn = () => { lp.enabled = true; };
        const pp = d.postParams();
        const exposure = pp.exposure;
        const sunI = d.tod.sun.intensity;

        // ---- the four states, and the meter in three
        await waitFrames(n);
        const A = readState();
        const depth = readDepth();
        const poolLit = lp.lights.filter((l) => l.visible && l.intensity > 0).length;
        const mA = await readMeter();
        poolOff();
        await waitFrames(n);
        const B = readState();
        const mB = await readMeter();
        d.tod.sun.intensity = 0;
        const mBnoSun = await readMeter();
        d.tod.sun.intensity = sunI;
        poolOn();
        head.emissiveIntensity = 0;
        await waitFrames(n);
        const C = readState();
        poolOff();
        await waitFrames(n);
        const D = readState();
        poolOn();
        head.emissiveIntensity = shippedEI;
        await waitFrames(n);
        d.scene.remove(meter); mm.dispose(); meter.geometry.dispose();

        // ---- the meter, split
        const sunColLuma = M.lumaOf(d.tod.sun.color.r, d.tod.sun.color.g, d.tod.sun.color.b);
        const el = d.tod.preset.elevation;
        const meterOut = {
          box: mbox, total: mA.lux, noPool: mB.lux, sky: mBnoSun.lux,
          pool: mA.lux - mB.lux, sun: mB.lux - mBnoSun.lux,
          sunClosedForm: sunI * sunColLuma * Math.max(0, Math.sin(el)),
          skyDelivery: d.tod.skyDelivery ? d.tod.skyDelivery() : null,
          px: mA.n, bad: mA.bad + mB.bad + mBnoSun.bad,
        };

        // ---- every globe in frame, both of each lamp's
        cam.updateMatrixWorld();
        const tanH = Math.tan((cam.fov * Math.PI / 180) / 2);
        const im = new THREE.Matrix4(), wv = new THREE.Vector3(), vv = new THREE.Vector3();
        const globes = [];
        for (let li = 0; li < fur.count; li++) {
          fur.heads.getMatrixAt(li, im);
          for (const [gi, G] of SF.LAMP_GLOBES.entries()) {
            wv.set(G.x, G.y, G.z).applyMatrix4(im);
            vv.copy(wv).applyMatrix4(cam.matrixWorldInverse);
            const dep = -vv.z;
            if (!(dep > 0.5)) continue;
            const ndc = wv.clone().project(cam);
            if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
            const sx = (ndc.x + 1) / 2 * W, sy = (1 - ndc.y) / 2 * H;
            const rpx = G.r * (H / 2) / (tanH * dep);
            if (rpx < 1.2) continue;
            const g = M.globeRead({ on: A.rgb, off: C.rgb, share: A.share, depth }, W, H, { sx, sy, r: rpx }, Lemit);
            globes.push({ lamp: li, globe: gi === 0 ? 'outer' : 'inner', world: [+wv.x.toFixed(2), +wv.y.toFixed(2), +wv.z.toFixed(2)],
              sx: +sx.toFixed(1), sy: +sy.toFixed(1), depth: +dep.toFixed(1), rpx: +rpx.toFixed(2), ...g });
          }
        }
        globes.sort((a, b) => a.depth - b.depth);

        // ---- raycast identity, for a pixel
        const rc = new THREE.Raycaster();
        const domeObj = d.sky && d.sky.dome;
        const visibleChain = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
        const namedOf = (o) => { for (let q = o; q; q = q.parent) if (q.name) return q.name; return '<unnamed>'; };
        const identify = (px, py) => {
          // a globe first, analytically: the cards are degenerate until the shader draws them
          for (const g of globes) {
            if (Math.hypot(px + 0.5 - g.sx, py + 0.5 - g.sy) <= g.rpx) return { what: `street lamp globe (${g.globe}) of lamp ${g.lamp}`, depth: g.depth };
          }
          rc.setFromCamera(new THREE.Vector2((px + 0.5) / W * 2 - 1, 1 - (py + 0.5) / H * 2), cam);
          let hits = [];
          try { hits = rc.intersectObject(d.scene, true); } catch (err) { return { what: `raycast threw: ${err.message}` }; }
          hits = hits.filter((h) => h.object !== domeObj && visibleChain(h.object) && h.object !== meter);
          if (!hits.length) return { what: 'nothing (sky)' };
          const h = hits[0], o = h.object, mt = Array.isArray(o.material) ? o.material[0] : o.material;
          return {
            what: namedOf(o), object: o.name || o.type, material: mt ? `${mt.type}${mt.name ? ' ' + mt.name : ''}` : null,
            emissive: mt && mt.emissive ? `#${mt.emissive.getHexString()} x${(+mt.emissiveIntensity || 0).toFixed(3)}` : null,
            roughness: mt && mt.roughness !== undefined ? +mt.roughness.toFixed(3) : null,
            instance: h.instanceId ?? null, dist: +h.distance.toFixed(2),
            point: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
          };
        };

        // ---- the pool: what its lights add, and its brightest pieces
        const litP = new Float32Array(W * H), litRel = new Float32Array(W * H);
        let poolSum = 0, frameSum = 0, rel05 = 0, rel25 = 0, rel100 = 0, nonFinite = 0;
        for (let i = 0; i < W * H; i++) {
          const a = A.lum[i], b = B.lum[i];
          if (!Number.isFinite(a) || !Number.isFinite(b)) { nonFinite++; continue; }
          const l = Math.max(0, a - b);
          litP[i] = l; litRel[i] = b > 0 ? l / b : (l > 0 ? Infinity : 0);
          poolSum += l; frameSum += a;
          if (litRel[i] > 0.05) rel05++; if (litRel[i] > 0.25) rel25++; if (litRel[i] > 1) rel100++;
        }
        const glintMask = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) glintMask[i] = litP[i] * exposure >= 0.01 && litRel[i] >= 0.25 ? 1 : 0;
        const glints = M.componentsOf(glintMask, litP, W, H).slice(0, 12).map((c) => ({
          area: c.area, box: c.box, peakNits: +c.peak.toFixed(3), peakExposed: +(c.peak * exposure).toFixed(4),
          peakOverBase: +(c.peak / Math.max(1e-9, B.lum[c.peakAt[1] * W + c.peakAt[0]])).toFixed(2),
          at: c.peakAt, id: identify(c.peakAt[0], c.peakAt[1]),
        }));
        const pool = { lights: poolLit, addsToFrame: frameSum > 0 ? poolSum / frameSum : null,
          pxOver5pct: rel05, pxOver25pct: rel25, pxOver100pct: rel100, nonFinite, glints };

        // ---- emitters, by the tag
        const emitted = new Float32Array(W * H), emitMask = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) {
          const v = A.share[i] * A.lum[i];
          emitted[i] = Number.isFinite(v) ? v : 0;
          emitMask[i] = emitted[i] * exposure >= 0.01 ? 1 : 0;
        }
        const eComps = M.componentsOf(emitMask, emitted, W, H);
        const emitters = eComps.slice(0, 24).map((c) => {
          const i = c.peakAt[1] * W + c.peakAt[0];
          return { area: c.area, box: c.box, peakNits: +c.peak.toFixed(3), peakExposed: +(c.peak * exposure).toFixed(4),
            // what the peak pixel reads with the globes' emissive off, and with the pool off: a globe goes in C,
            // something the pool lights goes in B, anything else (a window, a sign, a car lamp) stays.
            cOverA: +(C.lum[i] / A.lum[i]).toFixed(3), bOverA: +(B.lum[i] / A.lum[i]).toFixed(3),
            at: c.peakAt, id: identify(c.peakAt[0], c.peakAt[1]) };
        });

        // ---- the reviewer's boxes
        const boxOut = {};
        for (const [name, box] of Object.entries(boxes)) {
          const bx = box.map((v, j) => Math.round(v * (j % 2 === 0 ? W / 1600 : H / 900)));
          const a = M.boxMean(A.lum, W, H, bx), b = M.boxMean(B.lum, W, H, bx), c = M.boxMean(C.lum, W, H, bx), dd = M.boxMean(D.lum, W, H, bx);
          const em = M.boxMean(emitted, W, H, bx);
          boxOut[name] = { box: bx, meanA: a.mean, meanB: b.mean, meanC: c.mean, meanD: dd.mean,
            peakA: a.peak, peakAt: a.peakAt, peakExposed: a.peak * exposure, peakB: B.lum[a.peakAt[1] * W + a.peakAt[0]],
            peakC: C.lum[a.peakAt[1] * W + a.peakAt[0]], peakD: D.lum[a.peakAt[1] * W + a.peakAt[0]],
            peakShare: A.share[a.peakAt[1] * W + a.peakAt[0]], emittedPeak: em.peak, emittedPeakAt: em.peakAt,
            id: identify(a.peakAt[0], a.peakAt[1]), idEmitted: em.peak > 0 ? identify(em.peakAt[0], em.peakAt[1]) : null };
        }

        // ---- the frame's luminance in each state, and its sky
        const stat = (pl) => { let s = 0, k = 0; for (let i = 0; i < W * H; i++) if (Number.isFinite(pl[i])) { s += pl[i]; k++; } return s / k; };
        let skyN = 0, skyS = 0;
        for (let i = 0; i < W * H; i++) if (depth[i] >= 0.999999 && Number.isFinite(A.lum[i])) { skyN++; skyS += A.lum[i]; }
        return {
          w: W, h: H, exposure, preset: d.tod.presetName, lampsOn: !!d.tod.preset.lampsOn,
          streetLampsOn: d.tod.streetLampsOn ?? null, photocell: d.tod.photocellLux ? d.tod.photocellLux() : null,
          globeLit: !!fur._lit, globe: { emissiveIntensity: shippedEI, Lemit, lumEmissive: lumE, color: `#${head.color.getHexString()}`,
            emissive: `#${head.emissive.getHexString()}`, report: fur.globeReport ? fur.globeReport() : null },
          meter: meterOut, globes, pool, emitters, boxes: boxOut,
          frameMean: { A: stat(A.lum), B: stat(B.lum), C: stat(C.lum), D: stat(D.lum) },
          sky: { px: skyN, meanNits: skyN ? skyS / skyN : null },
        };
      }, { src: SRC, n: N, boxes: BOXES[s.name] ?? {} });
      let frameErr = null;
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        try { await page.screenshot({ path: `${OUT}/dusklamps-${TAG}-${s.name}-${tod}.png`, timeout: 180000 }); }
        catch (e) { frameErr = e.message.split('\n')[0]; }
      }
      // ---- the report
      const m = r.meter;
      console.log(`\n=== ${s.name} / ${tod}: exposure 1/${(1 / r.exposure).toFixed(0)}, lampsOn ${r.lampsOn}, ` +
        `street lamps ${r.streetLampsOn ?? '(no photocell)'}, globe lit ${r.globeLit}, pool lights on ${r.pool.lights}`);
      console.log(`  METER (horizontal, up-facing, unshadowed, ${m.px} px): total ${m.total?.toFixed(2)} lux = ` +
        `pool ${m.pool?.toFixed(2)} + sun ${m.sun?.toFixed(2)} (closed form ${m.sunClosedForm.toFixed(2)}) + sky ${m.sky?.toFixed(2)}; ` +
        `the module's skyDelivery ${m.skyDelivery ? m.skyDelivery.totalLux : '-'} lux` +
        (r.photocell !== null ? `; the module's photocell ${JSON.stringify(r.photocell)}` : ''));
      console.log(`  globe: base ${r.globe.color}, emissive ${r.globe.emissive} x${r.globe.emissiveIntensity.toFixed(3)} ` +
        `= ${r.globe.Lemit.toFixed(3)} nits, ${(r.globe.Lemit * r.exposure).toFixed(4)} exposed`);
      const read = r.globes.filter((g) => g.onOverSky !== null);
      console.log(`  globes in frame ${r.globes.length}, read against sky ${read.length}:`);
      for (const g of r.globes.slice(0, 14)) {
        console.log(`    lamp ${String(g.lamp).padStart(4)} ${g.globe.padEnd(5)} (${g.sx},${g.sy}) ${String(g.depth).padStart(5)} m r ${g.rpx} px` +
          `  core ${g.core} ring ${g.ring}/${g.ringN}` +
          (g.onOverSky === null ? `  REFUSED: ${g.refused}` :
            `  on/sky ${g.onOverSky.toFixed(3)} off/sky ${g.offOverSky.toFixed(3)}  warmth on ${g.warmthOn.toFixed(3)} ` +
            `off ${g.warmthOff.toFixed(3)} sky ${g.warmthSky.toFixed(3)}`));
      }
      console.log(`  POOL: adds ${(100 * r.pool.addsToFrame).toFixed(2)}% of the frame's luminance; pixels it lifts >5% ${r.pool.pxOver5pct}, ` +
        `>25% ${r.pool.pxOver25pct}, >100% ${r.pool.pxOver100pct}; brightest pieces:`);
      for (const c of r.pool.glints.slice(0, 8)) {
        console.log(`    box ${c.box.join(',').padEnd(19)} ${String(c.area).padStart(6)} px  peak ${c.peakNits} nits (${c.peakExposed} exposed), ` +
          `x${c.peakOverBase} over the pool-off pixel  ${JSON.stringify(c.id)}`);
      }
      console.log('  EMITTERS by the tag (emitted part >= 0.01 exposed), brightest first:');
      for (const c of r.emitters.slice(0, 14)) {
        console.log(`    box ${c.box.join(',').padEnd(19)} ${String(c.area).padStart(6)} px  peak ${c.peakNits} nits (${c.peakExposed} exposed)` +
          `  globe-off x${c.cOverA} pool-off x${c.bOverA}  ${JSON.stringify(c.id)}`);
      }
      for (const [name, b] of Object.entries(r.boxes)) {
        console.log(`  BOX ${name} ${b.box.join(',')}: mean A ${b.meanA?.toFixed(3)} B ${b.meanB?.toFixed(3)} C ${b.meanC?.toFixed(3)} D ${b.meanD?.toFixed(3)}; ` +
          `peak ${b.peakA?.toFixed(3)} nits (${b.peakExposed?.toFixed(4)} exposed) at ${b.peakAt}, pool off ${b.peakB?.toFixed(3)}, ` +
          `globe off ${b.peakC?.toFixed(3)}, both ${b.peakD?.toFixed(3)}, emitted share ${b.peakShare?.toFixed(3)}`);
        console.log(`    the peak is ${JSON.stringify(b.id)}`);
        if (b.idEmitted) console.log(`    its brightest EMITTED pixel ${b.emittedPeak?.toFixed(3)} nits at ${b.emittedPeakAt}: ${JSON.stringify(b.idEmitted)}`);
      }
      console.log(`  frame mean nits A ${r.frameMean.A.toFixed(3)} B ${r.frameMean.B.toFixed(3)} C ${r.frameMean.C.toFixed(3)} D ${r.frameMean.D.toFixed(3)}; ` +
        `sky ${r.sky.px} px at ${r.sky.meanNits?.toFixed(2)} nits`);
      runs.push({ shot: s.name, tod, placed, frameErr, ...r });
      fs.writeFileSync(jsonPath, JSON.stringify({ tag: TAG, runs, pageErrors: errors, partial: true }, null, 1));
    }
    await browser.close();
  }
  fs.writeFileSync(jsonPath, JSON.stringify({ tag: TAG, runs, pageErrors: errors, partial: false }, null, 1));
  console.log(`\nwrote ${jsonPath}`);
  if (errors.length) { console.log('page errors:', errors.slice(0, 5)); process.exit(1); }
}
