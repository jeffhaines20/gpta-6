// The whitebox measurement is BIMODAL, and one capture cannot see that.
//
// Ten consecutive captures of the same box on the same build put eight at
// 0.1012-0.1023 and two at 0.2430, the outliers carrying an intermittent
// additive block of about 2,890 px at (137,349)-(216,402). It fires with the old
// glass material too, so it is not the glazing, and it predates the glazing work
// entirely. Every single-capture measurement anyone has taken of that box has a
// one-in-five chance of being one of the outliers, which is how a 23.2% reading
// once got attributed to a builder's working tree.
//
// So: capture N times in ONE page session, classify, and - when an outlier turns
// up - say WHERE it differs from the modal frame rather than only that it does.
// Connected components of the signed difference against the modal frame give the
// block its own bounding box, area and sign, which is what tells an additive
// overlay from a geometry pop.
//
//   node tools/whitebox-repeat.mjs                 # 12 captures, golden
//   WR_N=20 WR_TIME=noon node tools/whitebox-repeat.mjs
//   WR_GAP=250 node tools/whitebox-repeat.mjs      # tighter capture spacing
//   WR_TARGETS=1 node tools/whitebox-repeat.mjs    # also read the post targets back
//   WR_RELOAD=1 node tools/whitebox-repeat.mjs     # one fresh page session per capture
//
// WHAT IT FOUND, so the next person does not re-run the search. The outliers are
// not a sampling artefact and not a streaming race: they are the NaN block
// described in src/post.js's sanitize(), seeded by however many +Inf channels a
// frame happens to carry. This probe's WR_TARGETS readback is what found it -
// blurB carrying 675 non-finite texels inside the box while the bright pass
// carried 1. On the fixed build ten consecutive captures span 0.1084-0.1087,
// against the 14.2 points the block used to add. It is kept because it is the
// instrument that would catch the next one: a bimodal box, a per-pass
// non-finite count, and a signed difference that names WHERE two frames differ.
//
// WR_TARGETS additionally reads the post chain's own intermediate targets back
// once per capture - the HDR scene target, the bright pass, both blur halves and
// both AO halves - inside the suspect box. If the block is in the frame but in
// none of them, the frame the screenshot captured is not the frame the post
// chain produced, and the defect is downstream of every pass in post.js.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const TIME = process.env.WR_TIME ?? 'golden';
const N = Number(process.env.WR_N ?? 12);
const GAP = Number(process.env.WR_GAP ?? 1500);
const BOX = (process.env.WR_BOX ?? '110,320,320,410').split(',').map(Number);
const TAG = process.env.WR_TAG ?? 'rpt';
const WANT_TARGETS = process.env.WR_TARGETS === '1';
const SETTLE = Number(process.env.WR_SETTLE ?? 20000);
const OUT = process.env.WR_OUTDIR ?? 'docs/shots/repeat';
// One page session per capture. Fourteen captures inside a SINGLE session put
// the box inside 1.2 points end to end, so whatever the outliers are, they are
// not per-frame noise; the next thing to vary is the session itself, and this
// varies it - full reload, fresh context, fresh streaming build, fresh texture
// generation - while keeping one browser process.
const RELOAD = process.env.WR_RELOAD === '1';

fs.mkdirSync(OUT, { recursive: true });

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
async function boot() {
  await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
  await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
  await page.evaluate((t) => __district.setTimeOfDay(t), TIME);
  // The whitebox camera, verbatim from tools/whitebox-probe.mjs.
  await page.evaluate(() => {
    const r = __district.district.meta.route;
    const a = r[2], b = r[4];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    __district.placeAt(a.x - (dx / len) * 16, a.z - (dz / len) * 16);
    __district.setAutopilot(() => {});
    __district.freeCam([a.x - (dx / len) * 16, 2.4, a.z - (dz / len) * 16],
      [a.x + (dx / len) * 260, 16, a.z + (dz / len) * 260], 55);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  });
  await page.waitForTimeout(SETTLE);
  await installPick();
  if (WANT_TARGETS) await installTargets();
}

// What geometry is actually under a screen pixel, named. A screen-space overlay
// or a post artefact hits nothing; a facade panel that has not got its generated
// texture yet hits a mesh, and can be named by material, map state and colour.
async function installPick() {
  await page.evaluate(async () => {
    const THREE = await import('/vendor/three.module.min.js');
    const rc = new THREE.Raycaster();
    window.__wrPick = (px, py) => {
      const cam = __district.camera;
      const ndc = new THREE.Vector2((px / 1600) * 2 - 1, -(py / 900) * 2 + 1);
      rc.setFromCamera(ndc, cam);
      const hits = rc.intersectObject(__district.scene, true).filter((h) => h.object.visible);
      if (!hits.length) return { hit: null };
      const h = hits[0];
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      return {
        dist: +h.distance.toFixed(2),
        name: h.object.name || '(unnamed)',
        parent: h.object.parent ? (h.object.parent.name || '(unnamed)') : null,
        matName: m ? (m.name || m.type) : null,
        color: m && m.color ? m.color.getHexString() : null,
        emissive: m && m.emissive ? m.emissive.getHexString() : null,
        emissiveIntensity: m ? m.emissiveIntensity : null,
        map: m ? !!m.map : null,
        mapImage: m && m.map && m.map.image ? `${m.map.image.width}x${m.map.image.height}` : null,
        rough: m ? m.roughness : null, metal: m ? m.metalness : null,
        instanced: !!h.object.isInstancedMesh, instanceId: h.instanceId ?? null,
      };
    };
  });
}

// Read the post chain's own targets back inside a box, so an artefact can be
// attributed to the pass that carries it instead of to the pass that is easiest
// to blame. Half-float and byte targets both come back as plain numbers.
async function installTargets() {
  await page.evaluate(async () => {
    const THREE = await import('/vendor/three.module.min.js');
    window.__wrTargets = (x0, y0, x1, y1) => {
      const d = __district, r = d.renderer, p = d.post;
      const full = [p.hdr.width, p.hdr.height];
      const out = {};
      const read = (name, rt, scaleX, scaleY) => {
        if (!rt) { out[name] = null; return; }
        const sx = Math.max(0, Math.floor(x0 * scaleX)), sy0 = Math.floor(y0 * scaleY);
        const w = Math.max(1, Math.ceil((x1 - x0 + 1) * scaleX));
        const h = Math.max(1, Math.ceil((y1 - y0 + 1) * scaleY));
        // readRenderTargetPixels is bottom-up.
        const sy = Math.max(0, rt.height - sy0 - h);
        const half = rt.texture.type === THREE.HalfFloatType;
        const byte = rt.texture.type === THREE.UnsignedByteType;
        const buf = byte ? new Uint8Array(w * h * 4)
          : half ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
        try { r.readRenderTargetPixels(rt, sx, sy, w, h, buf); }
        catch (e) { out[name] = { error: e.message }; return; }
        const dec = half ? (v) => {
          const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
          if (e === 0) return s * f * 5.9604644775390625e-8;
          if (e === 31) return f ? NaN : s * Infinity;
          return s * Math.pow(2, e - 15) * (1 + f / 1024);
        } : (v) => v;
        let mx = -Infinity, sum = 0, n = 0, bad = 0;
        for (let i = 0; i < buf.length; i += 4) {
          const m = Math.max(dec(buf[i]), dec(buf[i + 1]), dec(buf[i + 2]));
          if (!Number.isFinite(m)) { bad++; continue; }
          if (m > mx) mx = m; sum += m; n++;
        }
        out[name] = { w, h, max: Number.isFinite(mx) ? +mx.toFixed(1) : null,
          mean: n ? +(sum / n).toFixed(1) : null, nonFinite: bad };
      };
      const sx = p.hdr.width / 1600, sy = p.hdr.height / 900;
      read('hdr', p.hdr, sx, sy);
      read('bright', p.brightRT, sx * p.bloomScale, sy * p.bloomScale);
      read('blurA', p.blurA, sx * p.bloomScale, sy * p.bloomScale);
      read('blurB', p.blurB, sx * p.bloomScale, sy * p.bloomScale);
      read('ao', p.aoRT, sx * 0.5, sy * 0.5);
      read('aoBlur', p.aoBlurRT, sx * 0.5, sy * 0.5);
      read('ldr', p.ldrRT, sx, sy);
      return { full, ...out };
    };
  });
}

const boxStat = (img) => {
  const { width: w, channels: c, data } = img;
  const [x0, y0, x1, y1] = BOX;
  let white = 0, n = 0, sum = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * w + x) * c;
    n++; sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) white++;
  }
  return { whiteFrac: +(white / n).toFixed(4), meanLuma: +(sum / n).toFixed(1) };
};

await boot();

const caps = [];
for (let k = 0; k < N; k++) {
  if (RELOAD && k > 0) await boot();
  const file = `${OUT}/${TAG}-${TIME}-${String(k).padStart(2, '0')}.png`;
  const state = await page.evaluate(() => ({
    frames: __district.frames,
    render: __district.renderStats(),
    aa: __district.aaState(),
    canvas: [document.getElementById('c').width, document.getElementById('c').height,
      document.getElementById('c').clientWidth, document.getElementById('c').clientHeight],
    dpr: window.devicePixelRatio,
    world: (() => { const w = __district.world.report(); return { chunks: w.chunks ?? w.loaded, queue: w.queued ?? w.queue }; })(),
    traffic: (() => { const t = __district.trafficReport(); return t ? (t.cars ?? t.count ?? null) : null; })(),
    peds: (() => { const p = __district.pedestrianReport(); return p ? (p.count ?? p.alive ?? null) : null; })(),
    bloom: __district.postParams().bloomStrength,
    under: window.__wrPick ? window.__wrPick(176, 375) : null,
  }));
  const targets = WANT_TARGETS
    ? await page.evaluate((b) => window.__wrTargets(...b), BOX) : null;
  await page.screenshot({ path: file });
  const img = readPNG(file);
  caps.push({ k, file, ...boxStat(img), state, targets });
  process.stdout.write(`${k}:${caps[k].whiteFrac} `);
  if (k < N - 1) await page.waitForTimeout(GAP);
}
process.stdout.write('\n');

// --- Classify. The modal frame is the one closest to the median whiteFrac; every
// other frame is differenced against it.
const sorted = [...caps].sort((a, b) => a.whiteFrac - b.whiteFrac);
const median = sorted[Math.floor(sorted.length / 2)].whiteFrac;
const modal = caps.reduce((best, c) =>
  Math.abs(c.whiteFrac - median) < Math.abs(best.whiteFrac - median) ? c : best, caps[0]);
const ref = readPNG(modal.file);

// Connected components of a signed difference, so an additive overlay is told
// apart from a geometry pop by its sign and by whether it is one block or many.
function diffRegions(a, b, thresh = 24) {
  const { width: w, height: h, channels: c, data: da } = a;
  const db = b.data;
  const hit = new Uint8Array(w * h);
  let nPos = 0, nNeg = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * c;
    const dl = (0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2])
      - (0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2]);
    if (Math.abs(dl) > thresh) { hit[p] = dl > 0 ? 1 : 2; if (dl > 0) nPos++; else nNeg++; }
  }
  const seen = new Uint8Array(w * h);
  const regions = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!hit[s] || seen[s]) continue;
    const sign = hit[s];
    const reg = { n: 0, x0: w, y0: h, x1: 0, y1: 0, sign: sign === 1 ? '+' : '-', sumD: 0 };
    stack.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0, i = p * c;
      reg.n++;
      if (x < reg.x0) reg.x0 = x; if (x > reg.x1) reg.x1 = x;
      if (y < reg.y0) reg.y0 = y; if (y > reg.y1) reg.y1 = y;
      reg.sumD += (0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2])
        - (0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2]);
      const nb = [];
      if (x > 0) nb.push(p - 1); if (x < w - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - w); if (y < h - 1) nb.push(p + w);
      for (const q of nb) if (hit[q] === sign && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    regions.push(reg);
  }
  regions.sort((x, y) => y.n - x.n);
  return { nPos, nNeg, regions: regions.slice(0, 8).map((g) => ({
    n: g.n, box: [g.x0, g.y0, g.x1, g.y1], w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1,
    sign: g.sign, meanDelta: +(g.sumD / g.n).toFixed(1),
    fill: +(g.n / ((g.x1 - g.x0 + 1) * (g.y1 - g.y0 + 1))).toFixed(3) })) };
}

for (const c of caps) {
  if (c.file === modal.file) { c.diff = null; continue; }
  c.diff = diffRegions(ref, readPNG(c.file));
}

const wf = caps.map((c) => c.whiteFrac);
const spread = Math.max(...wf) - Math.min(...wf);
const outliers = caps.filter((c) => Math.abs(c.whiteFrac - median) > 0.02);
const verdict = spread > 0.02
  ? `BIMODAL REPRODUCED - ${outliers.length}/${N} captures off the mode by >2 points (spread ${(spread * 100).toFixed(2)} points)`
  : `NOT REPRODUCED in this session - all ${N} captures within ${(spread * 100).toFixed(2)} points`;

const out = { time: TIME, box: BOX, n: N, gapMs: GAP, whiteFracs: wf, median, spread: +spread.toFixed(4),
  modal: modal.file, verdict, captures: caps, pageErrors: errors };
fs.writeFileSync(`docs/whitebox-repeat-${TIME}-${TAG}.json`, JSON.stringify(out, null, 1));
console.log(verdict);
for (const c of caps) {
  const big = c.diff?.regions?.[0];
  console.log(` ${String(c.k).padStart(2)} wf=${c.whiteFrac} luma=${c.meanLuma} frames=${c.state.frames}` +
    (big ? `  biggest diff ${big.sign}${big.n}px ${JSON.stringify(big.box)} fill=${big.fill} d=${big.meanDelta}` : ''));
  if (c.targets) console.log('    targets', JSON.stringify(c.targets));
}
console.log('wrote', `docs/whitebox-repeat-${TIME}-${TAG}.json`);
await browser.close();
