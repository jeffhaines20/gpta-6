// #145's district probe: what alpha to coverage does to the canopy, the sun's map and the scene
// target's tags, read off ONE page load with the arms switched at runtime.
//
//   node tools/leaf-cover.mjs --district [--port N] [--times noon,dusk,night] [--shots corridor,fivepoints]
//                                         [--out DIR]
//
// THE ARMS are src/streetfurniture.js's own switch, `furniture.setFoliageCoverage(mode)`, on the one
// coverage material every cut-zone triangle is drawn with:
//
//   test      the alpha test, as before #145 (the KNOWN-BAD: a cut edge is a step)
//   centred   alpha to coverage with the ramp centred on the test (shipped)
//   three     three's own coverage, `smoothstep( test, test + fwidth, a )`: 0 AT the test
//   depth05   centred, with the cut-zone buckets' custom depth material taken off, so three's
//             shadow pass cuts them at its forced 0.5 (the trap foliageDepthMaterial exists for)
//   merged    test, with every bucket put back on the ONE shared material and no groups: the
//             pre-#145 draw, for the draw-call price and to show the split itself moves no pixel
//   test2     test again: the noise floor of every comparison below
//
// Per arm it records the frame (a PNG in --out), renderStats, a hash of the sun's shadow map and
// how many texels differ from the `test` arm's map, and at every hour the scene target's alpha and
// luma: which pixels #114's tag stops covering and whether any of them is over the emitter's bloom
// bar, which is where an untagged pixel is judged at dusk and night (src/post.js brightSplit).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
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
  ],
  fivepoints: [
    { name: 'canopy (rev.)', box: [600, 330, 760, 420] },
  ],
};

async function district() {
  const port = Number(arg('port', 8252));
  const times = arg('times', 'noon,dusk,night').split(',');
  const shots = arg('shots', 'corridor,fivepoints').split(',');
  const arms = arg('arms', 'test,centred,three,depth05,merged,test2').split(',');
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
        const mode = arm === 'depth05' ? 'centred' : (arm === 'merged' || arm === 'test2') ? 'test' : arm;
        const got = F.setFoliageCoverage(mode);
        if (arm === 'depth05') for (const s of saved) s.m.customDepthMaterial = undefined;
        if (arm === 'merged') {
          for (const s of saved) { s.m.material = F.propMat; s.m.geometry.groups.length = 0; s.m.customDepthMaterial = undefined; }
        }
        return { arm, mode: got, a2c: F.foliageMat.alphaToCoverage,
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
        const set = await page.evaluate((a) => __leafCover.setArm(a), arm);
        const f0 = await page.evaluate(() => __district.frames);
        await page.waitForFunction((f) => __district.frames > f + 4, f0, { timeout: 600000, polling: 100 });
        const keep = arm === 'test';
        const shadow = await page.evaluate((k) => __leafCover.shadow(k), keep);
        const scene = await page.evaluate((k) => __leafCover.scene(k), keep);
        const stats = await page.evaluate(() => __leafCover.stats());
        const file = path.join(outDir, `${name}-${tod}-${arm}.png`);
        await page.screenshot({ path: file, timeout: 180000 });
        const img = readPNG(file);
        const planes = lumaPlanes(img);
        const edges = (BOXES[name] ?? []).map((b) => ({ ...b, s: edgeStats(planes, b.box) }));
        let diff = null;
        if (ref) {
          let n = 0, big = 0;
          for (let i = 0; i < img.data.length; i += img.channels) {
            let d = 0;
            for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(img.data[i + c] - ref.data[i + c]));
            if (d > 0) n++;
            if (d > 2) big++;
          }
          diff = { anyPx: n, over2: big };
        }
        if (keep) ref = img;
        const row = { name, tod, arm, set, frames: f0, stats, shadow, scene, diff, edges: edges.map((e) => ({ name: e.name, box: e.box, ...e.s })) };
        results.push(row);
        console.log(`  ${tod} ${arm.padEnd(8)} mode ${set.mode} a2c ${set.a2c} depthCustom ${set.depthCustom} grouped ${set.grouped}  ` +
          `calls ${stats.calls} scene ${stats.sceneCalls} tris ${stats.triangles}  ` +
          `shadow ${shadow ? `${shadow.hash} diff ${shadow.diffTexels}` : 'none'}  ` +
          `tags ${scene.tagged}${scene.lost !== undefined ? ` lost ${scene.lost} gained ${scene.gained} lost>emitterBar ${scene.lostOverEmitter} (worst ${scene.worstLostLum.toFixed(4)} vs bar ${scene.threshold} / lit ${scene.thresholdLit})` : ''}  ` +
          `${diff ? `frame diff ${diff.anyPx} px (${diff.over2} > 2 levels)` : ''}`);
        for (const e of edges) console.log(formatEdge(`    ${e.name}`, e.box, e.s));
      }
    }
  }
  const outFile = path.join(outDir, 'leaf-cover-district.json');
  fs.writeFileSync(outFile, JSON.stringify({ coverageBuckets: await page.evaluate(() => __leafCover.coverageBuckets),
    buckets: await page.evaluate(() => __leafCover.buckets), errors, results }, null, 1));
  console.log(`wrote ${outFile}; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await browser.close();
}

const IS_MAIN = process.argv[1] && process.argv[1].endsWith('leaf-cover.mjs');
if (IS_MAIN && has('district')) await district();
