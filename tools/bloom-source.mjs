// What the bloom is MADE OF, by where its light came from (BACKLOG #118).
//
// The night bright-pass threshold was set for the emitters - "at night everything that blooms is an
// emitter" (src/daynight.js) - and a blind reviewer then measured a lamp-lit number plate glowing
// 12-14 px onto the bodywork. That is a statement about the bright pass's INPUT, and every lit
// material already writes the share of its radiance that is emitted into the scene target's alpha
// (#114, src/post.js EMIT_TAG). So the question is answerable exactly, per pixel, without a mask:
// of the energy the bright pass hands the blur, how much was emitted, how much was merely lit, and
// how much came from something that writes no tag at all.
//
//   node tools/bloom-source.mjs                 # corridor + fivepoints, at dusk, night and noon
//   BS_TIMES=night BS_SHOTS=corridor node tools/bloom-source.mjs
//   node tools/bloom-source.mjs --selftest      # offline, no browser
//
// Output: docs/bloom-source.json, and per camera and hour docs/shots/bloomsrc-<shot>-<tod>.png -
// R the emitted energy, G the lit, B the untagged, each on one log scale - beside the frame itself
// as bloomsrc-<shot>-<tod>-frame.png.
//
// THREE CLASSES, NOT TWO. The tag is -(1 + share) and only OPAQUE lit materials write it. A lit
// surface writes share 0 and decodes as "lit"; a MeshBasicMaterial, the sky, anything transparent
// writes 1 or 0 and decodes as "untagged" - and a lamp head drawn with a basic material IS an
// emitter that carries no tag. Lumping untagged in with lit would make "weight the bright pass by
// the share" look like it removes the lamp heads' bloom, or not, depending on a material choice.
//
// THE BRIGHT PASS IS RE-RUN HERE, so the tool carries a second copy of a shader formula - the
// recurring defect in this repo - and it is checked against the GPU on every run rather than
// trusted: the pass samples the scene at half resolution, which with a linear filter is exactly
// the mean of a 2x2 block, so emulating that block and summing gives the bright target's own
// luminance to half-float precision. The run refuses a frame where the two disagree.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const SELFTEST = IS_MAIN && process.argv.includes('--selftest');

// ---------------------------------------------------------------------- the pure half
// In tools/bloom-math.mjs, so tools/bloom-lit.html imports the same definitions; passed into the
// district page below as SOURCE (Function.prototype.toString) because that page has no import map.
import { halfToFloat, tagOf, brightShareOf, brightEnergy, splitEnergy, classify, emulateHalfRes, priceLitBars, quantiles, blobs } from './bloom-math.mjs';
export { halfToFloat, tagOf, brightShareOf, brightEnergy, splitEnergy, classify, emulateHalfRes, priceLitBars, quantiles, blobs };

// ---------------------------------------------------------------------- selftest
if (SELFTEST) {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  };
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  const { emitShareFromAlpha } = await import('../src/post.js');

  check('half: 1.0, -1.0, -2.0, Inf and NaN decode',
    halfToFloat(0x3c00) === 1 && halfToFloat(0xbc00) === -1 && halfToFloat(0xc000) === -2 &&
    halfToFloat(0x7c00) === Infinity && Number.isNaN(halfToFloat(0x7e00)));
  // The decode is the composite's, and src/post.js exports it, so the two are compared rather
  // than assumed; -1 here is "untagged", which the composite folds into share 0.
  const alphas = [-1, -1.5, -2, 1, 0, -0.25, -2.5, NaN];
  const agree = alphas.every((a) => (tagOf(a) < 0 ? 0 : tagOf(a)) === emitShareFromAlpha(a));
  check('tagOf agrees with src/post.js emitShareFromAlpha on every alpha, untagged folded to 0', agree,
    alphas.map((a) => `${a}:${tagOf(a)}`).join(' '));
  check('...and keeps untagged APART from a tagged share 0, which the composite does not need to',
    tagOf(-1) === 0 && tagOf(1) === -1 && tagOf(0) === -1);

  const P = { exposure: 1, threshold: 0.118, softKnee: 0.6 };
  const T = P.threshold;
  const atTwoT = brightEnergy(2 * T, 2 * T, 2 * T, 1, T, 0.6);
  check('at twice the threshold the pass hands on exactly one threshold of luminance',
    near(atTwoT.energy, T, 1e-4), `${atTwoT.energy.toFixed(6)} against ${T}`);
  const atT = brightEnergy(T, T, T, 1, T, 0.6);
  check('AT the threshold the knee hands on 0.15 of it, which is the soft term and not zero',
    near(atT.energy, 0.15 * T, 1e-3), `${atT.energy.toFixed(6)} against ${(0.15 * T).toFixed(6)}`);
  check('below threshold minus knee nothing at all',
    brightEnergy(T * 0.39, T * 0.39, T * 0.39, 1, T, 0.6).energy === 0);
  const nanE = brightEnergy(NaN, 0, 0, 1, T, 0.6).energy;
  check('a NaN channel is 60,000 in the pass, as in the shader, not dropped',
    nanE > 12000, `energy ${nanE.toFixed(1)}`);

  // Four pixels, one per class plus a dark one, rows bottom-up as a readback is.
  const v = 2 * T;
  const img = Float32Array.from([
    v, v, v, -2,      // tagged, share 1: emitted
    v, v, v, -1,      // tagged, share 0: lit
    v, v, v, 1,       // untagged
    0.01, 0.01, 0.01, -1,
  ]);
  const c = classify(img, 2, 2, P);
  check('one emitter, one lit, one untagged pixel land in their own classes and nowhere else',
    near(c.sum.emitted, T, 1e-4) && near(c.sum.lit, T, 1e-4) && near(c.sum.untagged, T, 1e-4),
    JSON.stringify(c.sum));
  check('...and the classes sum to the total, so nothing is double-counted or lost',
    near(c.sum.emitted + c.sum.lit + c.sum.untagged, c.sum.total, 1e-12) && c.pixels.contributing === 3);
  // KNOWN-BAD: a decode that reads the share the wrong way round puts the emitter in "lit".
  const inverted = classify(Float32Array.from([v, v, v, -1 - 0]), 1, 1, P);   // share 0
  check('KNOWN-BAD: a share-0 pixel is lit, so a decode that inverted the share would be caught here',
    inverted.sum.lit > 0 && inverted.sum.emitted === 0);
  const half = Float32Array.from([
    v, v, v, 1,   0, 0, 0, 1,
    v, v, v, 1,   0, 0, 0, 1,
  ]);
  const hr = emulateHalfRes(half, 2, 2, P);
  const want = brightEnergy(v / 2, v / 2, v / 2, 1, T, 0.6).energy;
  check('the half-res emulation takes the 2x2 MEAN first and the formula second',
    hr.bw === 1 && hr.bh === 1 && near(hr.sum, want, 1e-9), `${hr.sum.toFixed(6)} against ${want.toFixed(6)}`);
  const plane = Float32Array.from([1, 1, 0, 0, 0, 0, 0, 3, 0]);   // bottom row first
  const bl = blobs(plane, 3, 3, 0.5);
  check('blobs: two components, the brighter first, boxes in top-down screen rows',
    bl.count === 2 && bl.top[0].energy === 3 && bl.top[0].box.join() === '1,0,1,0' &&
    bl.top[1].area === 2 && bl.top[1].box.join() === '0,2,1,2', JSON.stringify(bl.top.map((b) => b.box)));
  const q = quantiles([1, 2, 3, 4]);
  check('quantiles: p50 of 1..4 is the third sample (floor index), max 4', q.p50 === 3 && q.max === 4);

  // THE SPLIT (#118). One texel at twice the threshold, by tag, against a lit bar far above it.
  const BIG = 100 * T;
  const sp = (a, tl) => splitEnergy(v, v, v, a, 1, T, tl, 0.6);
  check('split: an emitted texel keeps its bloom whatever the lit bar is',
    near(sp(-2, BIG).energy, T, 1e-4) && sp(-2, BIG).lit === 0, JSON.stringify(sp(-2, BIG)));
  check('split: a LIT texel gives none under a bar above it, and all of it at the old bar',
    sp(-1, BIG).energy === 0 && near(sp(-1, T).energy, T, 1e-4) && near(sp(-1, T).lit, T, 1e-4));
  check('split: an UNTAGGED texel is tested whole against the threshold, as before',
    near(sp(1, BIG).energy, T, 1e-4) && sp(1, BIG).lit === 0);
  // Non-linear, and the reason x1 is priced as its own row: half a texel's light at the bar is the
  // knee's 0.15 twice over, where the whole texel was a full threshold.
  const halfShare = sp(-1.5, T).energy;
  check('split: at EQUAL bars a half-share texel hands on 0.3 T, not the unsplit T - the split is not linear',
    near(halfShare, 0.3 * T, 1e-3), `${(halfShare / T).toFixed(4)} T`);
  const quad = Float32Array.from([
    v, v, v, -2,   v, v, v, -1,
    v, v, v, 1,    0, 0, 0, -1,
  ]);
  const on = emulateHalfRes(quad, 2, 2, { ...P, thresholdLit: BIG });
  check('half-res emulation, split ON: each texel first, the mean second - (T + 0 + T + 0) / 4',
    on.on && near(on.sum, 0.5 * T, 1e-4), `${(on.sum / T).toFixed(4)} T`);
  const bars = priceLitBars(quad, 2, 2, P, [T, 4 * T, Infinity]);
  check('pricing: lit energy never rises as the bar rises, and is zero at Infinity',
    bars[0].lit >= bars[1].lit && bars[1].lit >= bars[2].lit && bars[2].lit === 0 && bars[0].lit > 0,
    bars.map((b) => b.lit.toFixed(4)).join(' > '));

  const failed = checks.filter((x) => !x.ok).length;
  const CHECK_COUNT = 19;
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nBLOOM SOURCE SELFTEST: ${failed || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
    `${counted ? '' : ` (expected ${CHECK_COUNT})`}, ${failed} failed`);
  process.exit(failed || !counted ? 1 : 0);
}

// ---------------------------------------------------------------------- the run
if (IS_MAIN && !SELFTEST) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  const { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } = await import('./hero-cams.mjs');
  const { writePNG } = await import('./crop.mjs');

  const TIMES = (process.env.BS_TIMES ?? 'dusk,night,noon').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY = (process.env.BS_SHOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const shots = ONLY.length ? HERO_FRAMINGS.filter((s) => ONLY.includes(s.name)) : HERO_FRAMINGS;
  if (ONLY.length && shots.length !== ONLY.length) throw new Error(`BS_SHOTS names no such framing: ${ONLY}`);
  const PORT = Number(process.env.BS_PORT ?? 8123);
  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
  await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
  await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds() : null));

  // ONE EXPRESSION, not a run of declarations: a `const` made inside eval stays inside the eval, so
  // the first version's `eval(src)` left every name undefined in the page and threw on the first
  // call - after nine minutes of settling. The IIFE keeps the functions in one scope, so they can
  // call each other by name, and returns them.
  const FNS = [halfToFloat, tagOf, brightShareOf, brightEnergy, splitEnergy, classify, emulateHalfRes, priceLitBars, quantiles, blobs];
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
      const framePath = `docs/shots/bloomsrc-${s.name}-${tod}-frame.png`;
      // One more frame so the targets hold this hour's render, then read before anything else runs.
      const r = await page.evaluate(async (src) => {
        const { halfToFloat, classify, emulateHalfRes, priceLitBars, quantiles, blobs } = eval(src);   // eslint-disable-line no-eval
        const d = __district, p = d.post, R = d.renderer;
        const pp = d.postParams();
        const P = { exposure: pp.exposure, threshold: pp.bloomThreshold, softKnee: p.params.bloomSoftKnee,
          thresholdLit: p.params.bloomThresholdLit ?? 0 };
        const readHalf = (rt) => {
          const w = rt.width, h = rt.height;
          const raw = new Uint16Array(w * h * 4);
          R.readRenderTargetPixels(rt, 0, 0, w, h, raw);
          const f = new Float32Array(w * h * 4);
          for (let i = 0; i < f.length; i++) f[i] = halfToFloat(raw[i]);
          return { w, h, f };
        };
        const hdr = readHalf(p.hdr);
        const bright = readHalf(p.brightRT);
        const c = classify(hdr.f, hdr.w, hdr.h, P);
        const emu = emulateHalfRes(hdr.f, hdr.w, hdr.h, P);
        // Candidate bars for LIT light, as multiples of the hour's own threshold. x1 is the split at
        // today's bar, which is NOT today's pass (the split is non-linear); Infinity is "lit light
        // never blooms", i.e. the bright pass weighted by the emitted share.
        const MULTS = [1, 2, 4, 8, 16, 32, Infinity];
        const priced = priceLitBars(hdr.f, hdr.w, hdr.h, P, MULTS.map((m) => m * P.threshold))
          .map((o, i) => ({ mult: Number.isFinite(MULTS[i]) ? MULTS[i] : 'inf',
            thresholdLit: Number.isFinite(o.thresholdLit) ? o.thresholdLit : 'inf', total: o.total, lit: o.lit }));
        let gpu = 0;
        for (let i = 0; i < bright.w * bright.h; i++) {
          const k = i * 4;
          gpu += (0.2126 * bright.f[k] + 0.7152 * bright.f[k + 1] + 0.0722 * bright.f[k + 2]) * P.exposure;
        }
        // Populations: exposed luminance of the pixels the pass actually takes, per class.
        const em = [], li = [], un = [], emAll = [], liAll = [];
        for (let i = 0; i < c.n; i++) {
          const L = c.lumOf[i], sh = c.shareOf[i];
          const takes = c.eEmit[i] + c.eLit[i] + c.eUn[i] > 0;
          if (sh >= 0.9) { emAll.push(L); if (takes) em.push(L); }
          else if (sh >= 0 && sh <= 0.1) { liAll.push(L); if (takes) li.push(L); }
          else if (sh < 0 && takes) un.push(L);
        }
        // The map: one log scale for all three planes, 1e-3 to 10 exposed, top-down rows.
        const W = hdr.w, H = hdr.h;
        const rgb = new Uint8Array(W * H * 3);
        const enc = (e) => (e > 1e-3 ? Math.min(255, Math.round(255 * Math.log10(e / 1e-3) / 4)) : 0);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (H - 1 - y) * W + x, o = (y * W + x) * 3;
            rgb[o] = enc(c.eEmit[i]); rgb[o + 1] = enc(c.eLit[i]); rgb[o + 2] = enc(c.eUn[i]);
          }
        }
        let bin = '';
        for (let i = 0; i < rgb.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
        return {
          P, bloomStrength: pp.bloomStrength, w: W, h: H,
          sum: c.sum, pixels: c.pixels,
          crossCheck: { emulated: emu.sum, gpu, ratio: gpu / Math.max(emu.sum, 1e-12), bw: bright.w, bh: bright.h, splitPath: emu.on },
          priced,
          lumTaken: { emitter: quantiles(em), lit: quantiles(li), untagged: quantiles(un) },
          lumAll: { emitter: quantiles(emAll), lit: quantiles(liAll) },
          blobs: {
            emitted: blobs(c.eEmit, W, H, 1e-3, 8, c.lumOf, c.shareOf),
            lit: blobs(c.eLit, W, H, 1e-3, 8, c.lumOf, c.shareOf),
            untagged: blobs(c.eUn, W, H, 1e-3, 8, c.lumOf, c.shareOf),
          },
          map: btoa(bin),
        };
      }, SRC);
      // BOUNDED AND NON-FATAL (CLAUDE.md, Captures): the first version used the 30 s default, threw on a
      // loaded box at corridor/dusk, and took the night readings already printed down with it. The frame
      // is a picture for a human; the readback above is the measurement, and it is already taken.
      let frameErr = null;
      try { await page.screenshot({ path: framePath, timeout: 180000 }); } catch (e) { frameErr = e.message.split('\n')[0]; }
      if (frameErr) console.log(`  frame NOT written: ${frameErr}`);
      const mapPath = `docs/shots/bloomsrc-${s.name}-${tod}.png`;
      writePNG(mapPath, r.w, r.h, Buffer.from(r.map, 'base64'));
      delete r.map;
      const T = r.sum.total || 1;
      const pct = (x) => (100 * x / T).toFixed(1) + '%';
      console.log(`${s.name}/${tod}: threshold ${r.P.threshold} exposed, strength ${r.bloomStrength}, ` +
        `exposure 1/${(1 / r.P.exposure).toFixed(0)}`);
      console.log(`  bloom source energy ${r.sum.total.toFixed(1)}: emitted ${pct(r.sum.emitted)}, ` +
        `LIT ${pct(r.sum.lit)}, untagged ${pct(r.sum.untagged)}  (pixels taken ${r.pixels.contributing})`);
      console.log(`  cross-check against the GPU bright target: emulated ${r.crossCheck.emulated.toFixed(2)} ` +
        `gpu ${r.crossCheck.gpu.toFixed(2)}  ratio ${r.crossCheck.ratio.toFixed(4)}`);
      console.log(`  lit-light bar, priced on this readback (today's pass hands on ${r.sum.total.toFixed(1)}):`);
      for (const o of r.priced) {
        console.log(`    x${String(o.mult).padEnd(4)} ${String(typeof o.thresholdLit === 'number' ? o.thresholdLit.toFixed(3) : o.thresholdLit).padStart(8)}` +
          `  total ${o.total.toFixed(1).padStart(9)}  of which lit ${o.lit.toFixed(1).padStart(9)}  (${pct(o.lit)} of today's)`);
      }
      for (const k of ['emitter', 'lit', 'untagged']) {
        const qv = r.lumTaken[k];
        if (qv) console.log(`  ${k.padEnd(8)} taken n ${String(qv.n).padStart(7)}  p50 ${qv.p50.toFixed(3)}  ` +
          `p90 ${qv.p90.toFixed(3)}  p99 ${qv.p99.toFixed(3)}  max ${qv.max.toFixed(1)}`);
      }
      for (const k of ['emitted', 'lit', 'untagged']) {
        const b = r.blobs[k];
        console.log(`  top ${k} sources (${b.count} regions):`);
        for (const x of b.top.slice(0, 5)) {
          console.log(`    E ${x.energy.toFixed(2).padStart(9)}  ${String(x.area).padStart(6)} px  box ${x.box.join(',')}` +
            `  mean lum ${x.meanLum.toFixed(3)}  share ${x.meanShare.toFixed(2)}`);
        }
      }
      runs.push({ shot: s.name, tod, placed, frameErr, ...r });
      // Written after EVERY frame, so a crash later in the run keeps what was measured before it.
      fs.writeFileSync('docs/bloom-source.json', JSON.stringify({ runs, pageErrors: errors, partial: true }, null, 1));
    }
  }
  const bad = runs.filter((x) => !(Math.abs(x.crossCheck.ratio - 1) < 0.02));
  fs.writeFileSync('docs/bloom-source.json', JSON.stringify({ runs, pageErrors: errors, partial: false }, null, 1));
  console.log('\nwrote docs/bloom-source.json');
  await browser.close();
  if (bad.length) {
    console.log(`REFUSED: ${bad.length} frame(s) where the emulated bright pass and the GPU's disagree by over 2%: ` +
      bad.map((x) => `${x.shot}/${x.tod} ${x.crossCheck.ratio.toFixed(4)}`).join(', '));
    process.exit(1);
  }
  if (errors.length) { console.log('page errors:', errors.slice(0, 5)); process.exit(1); }
}
