// THE GATE FOR BACKLOG #145: a leaf's cut-out edge resolves to a partial pixel, the way a polygon edge
// does, and nothing else the coverage could touch moves. See tools/leaf-cover.html for the scene.
//
//   node tools/leaf-cover.mjs              one oak and a bench through weldBucket and the real PostStack
//   node tools/leaf-cover.mjs --selftest   prove the verdict on known-bad summaries, no browser
//   node tools/leaf-cover.mjs --district   the same arms at the hero cameras, one page load (a probe)
//
// WHAT IS ASSERTED, in the order that makes each check mean something:
//   the thing happened   every arm's switch reached the material, the bucket carries both groups and the
//                        custom depth material, and the crown has steps to read
//   the defect is live   the alpha-tested arm's cut edges are steps (the KNOWN-BAD), on the lit frame
//                        and on the coverage pass, every run
//   the fix              the shipped arm's edges carry partial pixels, on both
//   the price is zero    the leaves cover what they covered (the centring), the split moves no pixel,
//                        the sun's map is the build-before's byte for byte, and the bench welded into
//                        the same mesh keeps #114's tag
//   and why each is so   three's own ramp erodes the crown, and three's own depth material moves the map
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';
import { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } from './hero-cams.mjs';
import { readPNG } from './png.mjs';
import { edgeStats, lumaPlanes, formatEdge } from './leaf-edge.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

/**
 * The reviewers' boxes, x0,y0,x1,y1, and controls placed on the same frames: a polygon edge that
 * MSAA resolves, which is what an anti-aliased edge reads in this instrument in this frame.
 */
export const BOXES = {
  corridor: [
    { name: 'canopy A (rev.)', box: [640, 240, 760, 320] },
    { name: 'canopy B (rev.)', box: [470, 130, 800, 240] },
    // CONTROLS: a signal mast and a pole against the sky, polygon edges the 4 samples already resolve.
    { name: 'mast (control)', box: [840, 440, 900, 500] },
    { name: 'pole (control)', box: [1050, 300, 1075, 345] },
  ],
  fivepoints: [
    { name: 'canopy (rev.)', box: [600, 330, 760, 420] },
  ],
};

/**
 * Boxes read off the SCENE TARGET, x,y,w,h, for the bark: the reviewers' limb boxes and the sunlit
 * surfaces they compared them with, in exposed linear light, so a light arm can say which term carries
 * the limb.
 */
export const HDR_BOXES = {
  corridor: [
    { name: 'limb A', box: [292, 328, 10, 8] },
    { name: 'limb B', box: [262, 350, 8, 8] },
    { name: 'limb R', box: [1440, 40, 12, 30] },
    { name: 'brick', box: [100, 282, 80, 14] },
    { name: 'sky', box: [560, 40, 40, 30] },
  ],
};

/**
 * THE DISTRICT PROBE: the arms on ONE page load at the hero cameras, switched at runtime on the one
 * coverage material (furniture.setFoliageCoverage), with the frame, renderStats, the sun's map and
 * the scene target's tags read back per arm.
 *
 *   test      the alpha test, as before #145 (the KNOWN-BAD: a cut edge is a step)
 *   centred   alpha to coverage with the ramp centred on the test
 *   rim       centred, and the bark fringe faded off the faces that look at the camera (shipped)
 *   three     three's own coverage, smoothstep( test, test + fwidth, a ): 0 AT the test
 *   depth05   rim, with the cut-zone buckets' custom depth material taken off, so three's shadow
 *             pass cuts them at its forced 0.5 (the trap foliageDepthMaterial exists for)
 *   merged    test, with every bucket on the ONE shared material and no groups: the pre-#145 draw,
 *             for the draw-call price and to show the split itself moves no pixel
 *   test2     test again: the noise floor of every comparison
 *   nosun, nohemi, nobounce, noenv   the alpha-tested build with one light term taken out, for the
 *             limbs: which term makes them pale, read at HDR_BOXES in exposed linear light
 */
async function district() {
  const port = Number(arg('port', 8252));
  const times = arg('times', 'noon,dusk,night').split(',');
  const shots = arg('shots', 'corridor,fivepoints').split(',');
  const arms = arg('arms', 'test,centred,rim,three,depth05,merged,test2').split(',');
  const outDir = arg('out', 'docs/shots/leaf-cover');
  fs.mkdirSync(outDir, { recursive: true });
  await ensureServer(port);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/district/?traffic=0`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__district && window.__district.frames > 5, null, { timeout: 900000 });
  await page.addStyleTag({ content: '#attr{display:none!important} #hud,.pv-hud{display:none!important}' });
  const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
  console.log(`cloud deck: ${froze ? `frozen at ${froze.atSeconds}s` : 'NOT FROZEN'}`);
  await page.evaluate(() => __district.setPedestrians(0));
  await settleFrames(page, FRAME_SETTLE, 'pedestrians 0');

  // The in-page half: arm switching and the readbacks, installed once.
  await page.evaluate(() => {
    const D = __district, F = D.furniture, R = D.renderer, P = D.post;
    const saved = F.propMeshes.map((m) => ({ m, material: m.material, groups: m.geometry.groups.slice(), depth: m.customDepthMaterial }));
    const restore = () => {
      for (const s of saved) {
        s.m.material = s.material;
        s.m.geometry.groups.length = 0;
        for (const g of s.groups) s.m.geometry.addGroup(g.start, g.count, g.materialIndex);
        s.m.customDepthMaterial = s.depth;
      }
    };
    const hashOf = (buf) => {
      let h = 2166136261;
      for (let i = 0; i < buf.length; i += 1) { h ^= buf[i]; h = Math.imul(h, 16777619) >>> 0; }
      return h.toString(16);
    };
    const half = (h) => {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      if (e === 0) return s * 2 ** -14 * (f / 1024);
      if (e === 31) return f ? NaN : s * Infinity;
      return s * 2 ** (e - 15) * (1 + f / 1024);
    };
    window.__leafCover = {
      coverageBuckets: F.coverageBuckets,
      buckets: F.propMeshes.length,
      setArm(arm) {
        restore();
        // The LIGHT arms, for the bark: each takes one term out of the light on the alpha-tested build.
        // Visibility, not intensity, because TimeOfDay.follow() re-derives the bounce every frame.
        const T = D.tod;
        T.sun.visible = arm !== 'nosun';
        T.hemi.visible = arm !== 'nohemi';
        T.bounce.visible = arm !== 'nobounce';
        // Saved per use and restored on the next arm, never cached: apply() moves it with the hour.
        if (this._envSaved !== undefined) { D.scene.environmentIntensity = this._envSaved; this._envSaved = undefined; }
        if (arm === 'noenv') { this._envSaved = D.scene.environmentIntensity; D.scene.environmentIntensity = 0; }
        const light = ['nosun', 'nohemi', 'nobounce', 'noenv'].includes(arm);
        const mode = (arm === 'depth05' || arm === 'rim') ? 'centred' : (arm === 'merged' || arm === 'test2' || light) ? 'test' : arm;
        // The rim is its own term: on in the shipped arm and the depth arm only.
        const got = F.setFoliageCoverage(mode, arm === 'rim' || arm === 'depth05');
        if (arm === 'depth05') for (const s of saved) s.m.customDepthMaterial = undefined;
        if (arm === 'merged') {
          for (const s of saved) { s.m.material = F.propMat; s.m.geometry.groups.length = 0; s.m.customDepthMaterial = undefined; }
        }
        return { arm, mode: got, a2c: F.foliageMat.alphaToCoverage, rim: F.foliageMat.userData.rim,
          depthCustom: saved.filter((s) => s.m.customDepthMaterial).length,
          grouped: saved.filter((s) => s.m.geometry.groups.length).length };
      },
      shadow(keep) {
        const map = D.tod.sun.shadow.map;
        if (!map) return null;
        const w = map.width, h = map.height, buf = new Uint8Array(w * h * 4);
        R.readRenderTargetPixels(map, 0, 0, w, h, buf);
        let diff = null;
        if (this._shadowRef) {
          diff = 0;
          for (let i = 0; i < buf.length; i += 4) {
            if (buf[i] !== this._shadowRef[i] || buf[i + 1] !== this._shadowRef[i + 1]
              || buf[i + 2] !== this._shadowRef[i + 2] || buf[i + 3] !== this._shadowRef[i + 3]) diff++;
          }
        }
        if (keep) this._shadowRef = buf;
        return { w, h, hash: hashOf(buf), diffTexels: diff };
      },
      // The scene target, resolved: alpha (the #114 tag) and exposed luma, per pixel.
      scene(keep) {
        const rt = P.hdr, w = rt.width, h = rt.height, raw = new Uint16Array(w * h * 4);
        R.readRenderTargetPixels(rt, 0, 0, w, h, raw);
        const exp = P.params.exposure, T = P.params.bloomThreshold, TL = P.params.bloomThresholdLit ?? 0;
        const tagged = new Uint8Array(w * h), lum = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const r = half(raw[i * 4]), g = half(raw[i * 4 + 1]), b = half(raw[i * 4 + 2]), a = half(raw[i * 4 + 3]);
          const share = -a - 1;
          tagged[i] = share >= -0.01 && share <= 1.01 ? 1 : 0;
          lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) * exp;
        }
        let out = { w, h, exposure: exp, threshold: T, thresholdLit: TL, tagged: tagged.reduce((x, y) => x + y, 0) };
        if (this._sceneRef) {
          const ref = this._sceneRef;
          let lost = 0, gained = 0, lostOverEmitter = 0, lostOverLit = 0, worst = 0;
          for (let i = 0; i < w * h; i++) {
            if (ref.tagged[i] && !tagged[i]) {
              lost++;
              if (lum[i] > T) lostOverEmitter++;
              if (lum[i] > TL && TL > 0) lostOverLit++;
              worst = Math.max(worst, lum[i]);
            } else if (!ref.tagged[i] && tagged[i]) gained++;
          }
          out = { ...out, lost, gained, lostOverEmitter, lostOverLit, worstLostLum: worst };
        }
        if (keep) this._sceneRef = { tagged, lum };
        return out;
      },
      stats: () => D.renderStats(),
      // Mean EXPOSED linear RGB of the scene target over boxes given x,y,w,h in screen pixels (top-down).
      hdrBoxes(boxes) {
        const rt = P.hdr, w = rt.width, h = rt.height, raw = new Uint16Array(w * h * 4);
        R.readRenderTargetPixels(rt, 0, 0, w, h, raw);
        const exp = P.params.exposure, sx = w / innerWidth, sy = h / innerHeight;
        return boxes.map(({ name, box: [x, y, bw, bh] }) => {
          let r = 0, g = 0, b = 0, n = 0;
          for (let yy = Math.floor(y * sy); yy < Math.floor((y + bh) * sy); yy++) {
            for (let xx = Math.floor(x * sx); xx < Math.floor((x + bw) * sx); xx++) {
              const i = ((h - 1 - yy) * w + xx) * 4;
              r += half(raw[i]); g += half(raw[i + 1]); b += half(raw[i + 2]); n++;
            }
          }
          r *= exp / n; g *= exp / n; b *= exp / n;
          return { name, n, rgb: [r, g, b], luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
        });
      },
    };
  });

  const results = [];
  for (const name of shots) {
    const cfg = HERO_FRAMINGS.find((s) => s.name === name);
    if (!cfg) throw new Error(`no hero framing "${name}"`);
    const placed = await placeHeroCam(page, cfg);
    console.log(`${name}: camera at (${placed.x}, ${placed.z})`);
    await settleFrames(page, FRAME_SETTLE, `camera ${name}`);
    for (const tod of times) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await settleFrames(page, FRAME_SETTLE, `tod ${tod}`);
      let ref = null;
      for (const arm of arms) {
        // The light arms exist for the limb boxes; a framing without any has nothing for them to read.
        if (['nosun', 'nohemi', 'nobounce', 'noenv'].includes(arm) && !HDR_BOXES[name]) continue;
        const set = await page.evaluate((a) => __leafCover.setArm(a), arm);
        const f0 = await page.evaluate(() => __district.frames);
        await page.waitForFunction((f) => __district.frames > f + 4, f0, { timeout: 600000, polling: 100 });
        const keep = arm === 'test';
        const shadow = await page.evaluate((k) => __leafCover.shadow(k), keep);
        const scene = await page.evaluate((k) => __leafCover.scene(k), keep);
        const stats = await page.evaluate(() => __leafCover.stats());
        const hdr = HDR_BOXES[name] ? await page.evaluate((b) => __leafCover.hdrBoxes(b), HDR_BOXES[name]) : [];
        // A light arm is read off the scene target alone: its frame would only cost a screenshot.
        const lightArm = ['nosun', 'nohemi', 'nobounce', 'noenv'].includes(arm);
        const file = path.join(outDir, `${name}-${tod}-${arm}.png`);
        if (!lightArm) await page.screenshot({ path: file, timeout: Number(process.env.LEAF_SHOT_TIMEOUT ?? 1200000) });
        const img = lightArm ? null : readPNG(file);
        const planes = img ? lumaPlanes(img) : null;
        const edges = planes ? (BOXES[name] ?? []).map((b) => ({ ...b, s: edgeStats(planes, b.box) })) : [];
        let diff = null;
        if (ref && img) {
          // WHERE a moved pixel is: beside an edge of the reference frame (a 5 x 5 neighbourhood whose
          // luma spans over 40 of 255 levels) or out on a flat surface, where nothing the coverage does
          // to an edge should reach.
          const W = img.width, H = img.height, ch = img.channels;
          const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          let n = 0, big = 0, flat = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = (y * W + x) * ch;
            let d = 0;
            for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(img.data[i + c] - ref.data[i + c]));
            if (d > 0) n++;
            if (d <= 2) continue;
            big++;
            let lo = 255, hi = 0;
            for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) {
              for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
                const v = lum(ref.data, (yy * W + xx) * ch); if (v < lo) lo = v; if (v > hi) hi = v;
              }
            }
            if (hi - lo <= 40) flat++;
          }
          diff = { anyPx: n, over2: big, over2Flat: flat };
        }
        if (keep && img) ref = img;
        const row = { name, tod, arm, set, frames: f0, stats, shadow, scene, diff, hdr, edges: edges.map((e) => ({ name: e.name, box: e.box, ...e.s })) };
        results.push(row);
        console.log(`  ${tod} ${arm.padEnd(8)} mode ${set.mode} a2c ${set.a2c} depthCustom ${set.depthCustom} grouped ${set.grouped}  ` +
          `calls ${stats.calls} scene ${stats.sceneCalls} tris ${stats.triangles}  ` +
          `shadow ${shadow ? `${shadow.hash} diff ${shadow.diffTexels}` : 'none'}  ` +
          `tags ${scene.tagged}${scene.lost !== undefined ? ` lost ${scene.lost} gained ${scene.gained} lost>emitterBar ${scene.lostOverEmitter} (worst ${scene.worstLostLum.toFixed(4)} vs bar ${scene.threshold} / lit ${scene.thresholdLit})` : ''}  ` +
          `${diff ? `frame diff ${diff.anyPx} px (${diff.over2} > 2 levels, ${diff.over2Flat} of them off any edge)` : ''}`);
        for (const e of edges) console.log(formatEdge(`    ${e.name}`, e.box, e.s));
        if (hdr.length) console.log('    exposed HDR  ' + hdr.map((x) => `${x.name} ${x.luma.toFixed(4)} (${x.rgb.map((v) => v.toFixed(3)).join(',')})`).join('  '));
      }
    }
  }
  const outFile = path.join(outDir, 'leaf-cover-district.json');
  fs.writeFileSync(outFile, JSON.stringify({ coverageBuckets: await page.evaluate(() => __leafCover.coverageBuckets),
    buckets: await page.evaluate(() => __leafCover.buckets), errors, results }, null, 1));
  console.log(`wrote ${outFile}; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await browser.close();
}

// ---------------------------------------------------------------------------------- the gate

/** The crown on the page's fixed camera, x0,y0,x1,y1: sky above and round it, the trunk below. */
export const CROWN = [190, 50, 550, 250];
/** The trunk between the crown and the bench, x0,y0,x1,y1, where the bark fringe's holes show. */
export const TRUNK = [296, 268, 334, 318];
/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 16;

/**
 * HOLES INSIDE A TUBE, off the coverage pass: per row of `box`, the uncovered pixels strictly between
 * the leftmost and the rightmost covered one. A tube is solid across itself, so every one of them is
 * background seen through the bark.
 */
export function tubeGaps(cov, w, box) {
  const [x0, y0, x1, y1] = box;
  let gaps = 0, solid = 0, rows = 0;
  for (let y = y0; y < y1; y++) {
    let L = -1, R = -1;
    for (let x = x0; x < x1; x++) if (cov[y * w + x] >= 0.5) { if (L < 0) L = x; R = x; }
    if (L < 0 || R - L < 2) continue;
    rows++;
    for (let x = L; x <= R; x++) { if (cov[y * w + x] >= 0.5) solid++; else gaps++; }
  }
  return { rows, gaps, solid, gapFrac: gaps + solid ? gaps / (gaps + solid) : null };
}

const enc = (v) => {
  const c = Math.max(0, Math.min(1, v));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
};
/** A coverage array (1 = leaf) as an RGB image the edge statistic reads: leaf black, sky white. */
function coverageImage(cov, w, h) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data[i * 3] = data[i * 3 + 1] = data[i * 3 + 2] = enc(1 - cov[i]);
  return { width: w, height: h, channels: 3, data };
}

/**
 * THE PAGE'S FRAMES REDUCED TO NUMBERS, the half a selftest can stand in for. Pure: no browser.
 * `frames[arm]` = { rgb: Uint8Array, cov: Float32Array, alpha: Float32Array }, `frames.id.rgb`.
 */
export function summarise(report, frames) {
  const { w, h } = report.size;
  const out = { size: report.size, cut: report.cut, total: report.total, shipped: report.shipped, arms: {} };
  // The ID pass, eroded: a pixel counts only if its four neighbours agree, because nothing else in it is
  // resolved and the scene pass's edges blend.
  const id = frames.id?.rgb;
  const kind = (i) => (!id ? null : id[i * 3] > 127 ? 'cut' : id[i * 3 + 1] > 127 ? 'opaque' : null);
  const inner = { cut: [], opaque: [] };
  if (id) {
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, k = kind(i);
      if (k && kind(i - 1) === k && kind(i + 1) === k && kind(i - w) === k && kind(i + w) === k) inner[k].push(i);
    }
  }
  out.pixels = { cut: inner.cut.length, opaque: inner.opaque.length };
  const tagged = (a) => a >= -2.01 && a <= -0.99;
  for (const [arm, fr] of Object.entries(frames)) {
    if (arm === 'id') continue;
    const lit = { width: w, height: h, channels: 3, data: fr.rgb };
    const e = edgeStats(lit, CROWN);
    const c = edgeStats(coverageImage(fr.cov, w, h), CROWN);
    let mass = 0, partial = 0;
    for (const v of fr.cov) { mass += v; if (v > 0.1 && v < 0.9) partial++; }
    const share = (list, pred) => (list.length ? list.filter((i) => pred(fr.alpha[i])).length / list.length : null);
    out.arms[arm] = {
      ...report.arms[arm],
      lit: { steps: e.steps, hardFrac: e.ok ? e.hardFrac : null, midShare: e.ok ? e.midShare : null },
      cov: { steps: c.steps, hardFrac: c.ok ? c.hardFrac : null, midShare: c.ok ? c.midShare : null, mass, partial },
      trunk: tubeGaps(fr.cov, w, TRUNK),
      tags: { opaqueTagged: share(inner.opaque, tagged), cutTagged: share(inner.cut, tagged),
        cutUntaggedFull: share(inner.cut, (a) => a >= 0.99 && a <= 1.01) },
    };
  }
  const a = frames.merged?.rgb, b = frames.test?.rgb;
  if (a && b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; out.mergedVsTestBytes = n; }
  return out;
}

/** THE VERDICT, as a pure function of the summary. Every read goes through an accessor (CLAUDE.md:
 *  a check's arguments are evaluated before the check runs, so an absent number must FAIL, not throw). */
export function verdict(sm) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const A = sm?.arms ?? {};
  const g = (arm, ...path) => { let v = A[arm]; for (const k of path) v = v?.[k]; return fin(v); };
  const f = (v, d = 3) => (v === null ? 'absent' : v.toFixed(d));
  const want = { merged: ['test', false, false, 1, null], test: ['test', false, false, 2, 'foliageDepth'],
    centred: ['centred', true, false, 2, 'foliageDepth'], three: ['three', true, false, 2, 'foliageDepth'],
    rim: ['centred', true, true, 2, 'foliageDepth'], depth05: ['centred', true, true, 2, null] };
  const armsOk = Object.entries(want).every(([k, [mode, a2c, rim, groups, depth]]) => A[k] && A[k].mode === mode
    && A[k].a2c === a2c && A[k].rim === rim && (groups === 1 ? A[k].materials?.length === 1 : A[k].groups === groups)
    && (A[k].customDepth ?? null) === depth);
  add('every arm\'s switch reached the material, read back off the mesh', armsOk,
    Object.keys(want).map((k) => `${k} ${A[k]?.mode}/${A[k]?.a2c}/${A[k]?.rim}/${A[k]?.groups}/${A[k]?.customDepth}`).join(', '));
  add('the module ships the coverage centred, with the rim, read off the material as the district builds it',
    sm?.shipped?.mode === 'centred' && sm?.shipped?.rim === true && sm?.shipped?.a2c === true,
    `mode ${sm?.shipped?.mode}, rim ${sm?.shipped?.rim}, alphaToCoverage ${sm?.shipped?.a2c}`);
  const cut = fin(sm?.cut), total = fin(sm?.total);
  add('the bucket is a real one: cut-zone and opaque triangles in one mesh, and steps to read',
    cut > 0 && total > cut && g('test', 'lit', 'steps') >= 1000 && fin(sm?.pixels?.opaque) >= 200 && fin(sm?.pixels?.cut) >= 2000,
    `${cut} of ${total} triangles cut-zone; ${g('test', 'lit', 'steps')} steps; ${sm?.pixels?.opaque} bench and ${sm?.pixels?.cut} leaf px`);
  add('THE DEFECT IS LIVE: alpha-tested, the crown\'s edges are steps (the known-bad)',
    g('test', 'lit', 'hardFrac') >= 0.8 && g('test', 'cov', 'hardFrac') >= 0.8,
    `hardFrac ${f(g('test', 'lit', 'hardFrac'))} lit, ${f(g('test', 'cov', 'hardFrac'))} coverage`);
  const dLit = (g('test', 'lit', 'hardFrac') ?? NaN) - (g('centred', 'lit', 'hardFrac') ?? NaN);
  const dCov = (g('test', 'cov', 'hardFrac') ?? NaN) - (g('centred', 'cov', 'hardFrac') ?? NaN);
  add('THE FIX: with coverage the crown\'s edges carry partial pixels, lit and in the coverage pass',
    dLit >= 0.15 && dCov >= 0.15 && g('centred', 'cov', 'midShare') >= 2 * (g('test', 'cov', 'midShare') ?? Infinity),
    `hardFrac ${f(g('centred', 'lit', 'hardFrac'))} lit / ${f(g('centred', 'cov', 'hardFrac'))} coverage; ` +
    `midShare ${f(g('test', 'cov', 'midShare'))} -> ${f(g('centred', 'cov', 'midShare'))}`);
  add('and the partial pixels are real coverage: the pass holds at least twice as many',
    g('centred', 'cov', 'partial') >= 2 * (g('test', 'cov', 'partial') ?? Infinity),
    `${g('test', 'cov', 'partial')} -> ${g('centred', 'cov', 'partial')} px between 0.1 and 0.9 covered`);
  const mT = g('test', 'cov', 'mass'), mC = g('centred', 'cov', 'mass'), m3 = g('three', 'cov', 'mass');
  add('the leaves cover what they covered: the ramp is centred on the test',
    mT > 0 && mC !== null && Math.abs(mC - mT) <= 0.01 * mT, `${f(mT, 1)} -> ${f(mC, 1)} px of leaf (${f(mT ? (mC / mT - 1) * 100 : null, 2)}%)`);
  add('KNOWN-BAD for the centring: three\'s own ramp, 0 at the test, erodes the crown',
    mT > 0 && m3 !== null && m3 <= 0.97 * mT, `${f(m3, 1)} px, ${f(mT ? (m3 / mT - 1) * 100 : null, 2)}%`);
  add('the split moves no pixel: one material and no groups draws the alpha-tested arm byte for byte',
    sm?.mergedVsTestBytes === 0, `${sm?.mergedVsTestBytes} bytes differ`);
  add('the sun\'s map is the build-before\'s byte for byte under the coverage',
    ['test', 'centred', 'three', 'rim'].every((k) => g(k, 'shadowDiff') === 0),
    'texels differing from the one-material map: ' + ['test', 'centred', 'three', 'rim'].map((k) => `${k} ${g(k, 'shadowDiff')}`).join(', '));
  add('KNOWN-BAD for the depth material: three\'s own cuts the coverage material\'s map at 0.5',
    g('depth05', 'shadowDiff') >= 200, `${g('depth05', 'shadowDiff')} texels move`);
  add('the bench welded into the same mesh keeps #114\'s tag in every arm',
    ['merged', 'test', 'centred', 'three', 'rim'].every((k) => g(k, 'tags', 'opaqueTagged') >= 0.99),
    ['merged', 'test', 'centred', 'three', 'rim'].map((k) => `${k} ${f(g(k, 'tags', 'opaqueTagged'))}`).join(', '));
  const gT = g('test', 'trunk', 'gapFrac'), gC = g('centred', 'trunk', 'gapFrac'), gR = g('rim', 'trunk', 'gapFrac');
  add('KNOWN-BAD for the bark: without the rim the trunk is a lattice, the background showing through it',
    gT >= 0.05 && gC >= 0.05, `${f(gT)} of the trunk's span uncovered alpha-tested, ${f(gC)} with coverage alone`);
  add('THE RIM: with the fringe faded off the faces that look at the camera, the trunk is solid across itself',
    gR !== null && gR <= 0.01 && g('rim', 'trunk', 'rows') >= 30,
    `${f(gR)} uncovered over ${g('rim', 'trunk', 'rows')} rows (${g('rim', 'trunk', 'gaps')} px)`);
  add('and the rim leaves the crown\'s edges as the coverage drew them',
    g('rim', 'cov', 'hardFrac') !== null && Math.abs(g('rim', 'cov', 'hardFrac') - (g('centred', 'cov', 'hardFrac') ?? NaN)) <= 0.03,
    `coverage hardFrac ${f(g('centred', 'cov', 'hardFrac'))} -> ${f(g('rim', 'cov', 'hardFrac'))}`);
  add('the mechanism: the leaves are tagged under the test and untagged under the coverage, which is not OPAQUE',
    g('test', 'tags', 'cutTagged') >= 0.99 && g('rim', 'tags', 'cutUntaggedFull') >= 0.9,
    `tagged ${f(g('test', 'tags', 'cutTagged'))} under the test; alpha 1 on ${f(g('rim', 'tags', 'cutUntaggedFull'))} under the coverage`);
  return checks;
}

function selftest() {
  let pass = 0, fail = 0;
  const say = (ok, msg, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}${detail ? `  ${detail}` : ''}`); };
  console.log('LEAF-COVER SELFTEST — the verdict on known-bad summaries\n');
  const arm = (mode, a2c, groups, depth, lit, cov, tags, shadowDiff) => ({ mode, a2c, groups,
    materials: groups === 1 ? ['prop'] : ['prop', 'foliageCoverage'], customDepth: depth, shadowDiff, lit, cov, tags });
  // A real run's numbers (2026-11-17), so the known-bads below are one edit from something that happened.
  const good = {
    size: { w: 640, h: 400 }, cut: 4096, total: 4132, pixels: { cut: 26000, opaque: 900 }, mergedVsTestBytes: 0,
    arms: {
      merged: arm('test', false, 1, null, { steps: 5236, hardFrac: 0.844, midShare: 0.080 },
        { steps: 6227, hardFrac: 0.866, midShare: 0.070, mass: 30056.8, partial: 1460 }, { opaqueTagged: 1, cutTagged: 1, cutUntaggedFull: 0 }, null),
      test: arm('test', false, 2, 'foliageDepth', { steps: 5236, hardFrac: 0.844, midShare: 0.080 },
        { steps: 6227, hardFrac: 0.866, midShare: 0.070, mass: 30056.8, partial: 1460 }, { opaqueTagged: 1, cutTagged: 1, cutUntaggedFull: 0 }, 0),
      centred: arm('centred', true, 2, 'foliageDepth', { steps: 3955, hardFrac: 0.605, midShare: 0.170 },
        { steps: 5126, hardFrac: 0.606, midShare: 0.176, mass: 30001.5, partial: 4188 }, { opaqueTagged: 1, cutTagged: 0, cutUntaggedFull: 0.97 }, 0),
      three: arm('three', true, 2, 'foliageDepth', { steps: 5312, hardFrac: 0.724, midShare: 0.132 },
        { steps: 6336, hardFrac: 0.693, midShare: 0.148, mass: 26931.0, partial: 4444 }, { opaqueTagged: 1, cutTagged: 0, cutUntaggedFull: 0.97 }, 0),
      depth05: arm('centred', true, 2, null, { steps: 3955, hardFrac: 0.605, midShare: 0.170 },
        { steps: 5126, hardFrac: 0.606, midShare: 0.176, mass: 30001.5, partial: 4188 }, { opaqueTagged: 1, cutTagged: 0, cutUntaggedFull: 0.97 }, 5022),
    },
  };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  say(failing(good).length === 0, 'a real passing summary passes every check', failing(good).join(' | '));
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT && failing({}).length === CHECK_COUNT,
    'an EMPTY summary fails every check rather than throwing', `${failing({}).length} failed`);
  const asTest = (c) => { for (const k of ['centred', 'three', 'depth05']) { c.arms[k].lit = { ...c.arms.test.lit }; c.arms[k].cov = { ...c.arms.test.cov }; } };
  for (const [what, fn, needle] of [
    ['the build before #145: every arm alpha-tested', asTest, 'THE FIX'],
    ['a coverage that never reached the pixels (the switch read back, the frame unmoved)', (c) => { c.arms.centred.lit = { ...c.arms.test.lit }; c.arms.centred.cov = { ...c.arms.test.cov }; }, 'THE FIX'],
    ['three\'s uncentred ramp shipped', (c) => { c.arms.centred.cov.mass = c.arms.three.cov.mass; }, 'cover what they covered'],
    ['a page whose test arm already has partial pixels, so the fix is measured on nothing', (c) => { c.arms.test.lit.hardFrac = 0.6; }, 'DEFECT IS LIVE'],
    ['the depth material dropped: the map moves under the coverage', (c) => { c.arms.centred.shadowDiff = 5022; }, 'sun\'s map'],
    ['a page whose arms cannot move the map at all', (c) => { c.arms.depth05.shadowDiff = 0; }, 'depth material'],
    ['the coverage on the shared material: the bench loses its tag', (c) => { c.arms.centred.tags.opaqueTagged = 0; }, 'keeps #114'],
    ['the split reorders or recolours a pixel', (c) => { c.mergedVsTestBytes = 12; }, 'moves no pixel'],
    ['a switch that never reached the material', (c) => { c.arms.centred.a2c = false; }, 'reached the material'],
    ['a bucket with no cut zone', (c) => { c.cut = 0; }, 'real one'],
    ['the bench out of frame', (c) => { c.pixels.opaque = 0; }, 'real one'],
    ['a mechanism that tags the leaves under the coverage too', (c) => { c.arms.centred.tags.cutUntaggedFull = 0; }, 'mechanism'],
  ]) {
    const r = bad(fn);
    say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | '));
  }
  console.log(`\nLEAF-COVER SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  return fail;
}

async function gate() {
  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const PORT = Number(process.env.LEAF_COVER_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const logs = [];
  page.on('console', (m) => { if (!/Failed to load resource|GPU stall due to ReadPixels/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/tools/leaf-cover.html`);
  let report = null, frames = null, err = null;
  try {
    await page.waitForFunction('window.__leafCover', null, { timeout: 300000 });
    report = await page.evaluate(() => window.__leafCover);
    if (report && !report.error) frames = await page.evaluate(() => window.__leafCoverFrames);
  } catch (e) { err = e.message; }
  await browser.close();
  if (!report || report.error) {
    console.error(`the page did not publish a report: ${report ? report.error : err}`);
    if (logs.length) console.error('console:\n' + logs.join('\n'));
    return 1;
  }
  const dec = {};
  for (const [arm, fr] of Object.entries(frames)) {
    dec[arm] = { rgb: new Uint8Array(Buffer.from(fr.rgb, 'base64')) };
    if (fr.cov) dec[arm].cov = new Float32Array(Buffer.from(fr.cov, 'base64').buffer.slice(0));
    if (fr.alpha) dec[arm].alpha = new Float32Array(Buffer.from(fr.alpha, 'base64').buffer.slice(0));
  }
  const sm = summarise(report, dec);
  if (has('json')) console.log(JSON.stringify(sm, null, 1));
  console.log(`LEAF-COVER — one live oak (key ${report.key}) and a bench, welded into one bucket, through the real PostStack\n`);
  console.log('  arm       lit: steps hardFrac midShare    coverage: steps hardFrac midShare   leaf px  partial   sun map');
  for (const [k, a] of Object.entries(sm.arms)) {
    const v = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '  -  ');
    console.log(`  ${k.padEnd(8)} ${String(a.lit.steps).padStart(10)}   ${v(a.lit.hardFrac)}   ${v(a.lit.midShare)}   ` +
      `${String(a.cov.steps).padStart(14)}   ${v(a.cov.hardFrac)}   ${v(a.cov.midShare)}   ${v(a.cov.mass, 1).padStart(8)} ${String(a.cov.partial).padStart(7)}   ` +
      `${a.shadowDiff === null || a.shadowDiff === undefined ? 'reference' : `${a.shadowDiff} texels`}`);
  }
  console.log('');
  const checks = verdict(sm);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
  console.log(`\nLEAF-COVER: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` + (failed.length ? `, ${failed.length} failed` : ''));
  return failed.length ? 1 : 0;
}

const IS_MAIN = process.argv[1] && process.argv[1].endsWith('leaf-cover.mjs');
if (IS_MAIN) {
  if (has('selftest')) process.exit(selftest() ? 1 : 0);
  else if (has('district')) await district();
  else process.exit(await gate());
}
