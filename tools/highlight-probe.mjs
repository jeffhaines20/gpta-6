// What the post chain actually RECEIVES at the top of its range.
//
// The blown-pane diagnosis is stated in radiance ("GGX returns about 1e6 cd/m2"),
// but post.js never sees 1e6: the scene target is HalfFloatType, so anything past
// 65,504 is stored saturated (or Inf), and sanitize() then pins every channel
// past 60,000 onto one number. Both the MAGNITUDE and the CHROMA of a return
// that far above the ceiling are gone before the composite runs, so whether a
// highlight rolloff can do anything at all is a question about the radiance
// DISTRIBUTION, not about the curve.
//
// So this renders the same camera into a FloatType target - no half-float
// saturation, no tonemap - and reports the true radiance behind every bright
// region, alongside what the shipped HalfFloat + sanitize() path leaves of it.
//
//   node tools/highlight-probe.mjs                    # golden, corridor/whitebox camera
//   HP_TIME=night node tools/highlight-probe.mjs
//   HP_TIME=golden HP_CAM=sun node tools/highlight-probe.mjs   # point at the sun
//
// Output: docs/highlight-probe-<time>-<cam>.json
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const TIME = process.env.HP_TIME ?? 'golden';
const CAM = process.env.HP_CAM ?? 'corridor';
const SETTLE = Number(process.env.HP_SETTLE ?? 20000);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TIME);

// Same camera as tools/whitebox-probe.mjs, so the numbers land on the frame the
// reviewers and that probe looked at rather than on a new view of it.
await page.evaluate((cam) => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  __district.placeAt(a.x - (dx / len) * 16, a.z - (dz / len) * 16);
  __district.setAutopilot(() => {});
  const eye = [a.x - (dx / len) * 16, 2.4, a.z - (dz / len) * 16];
  let target = [a.x + (dx / len) * 260, 16, a.z + (dz / len) * 260];
  if (cam === 'sun') {
    // Look straight at the sun disc, wherever daynight put it.
    const s = __district.tod.sun ?? null;
    const d = __district.postParams().sunDirection;
    target = [eye[0] + d.x * 400, eye[1] + d.y * 400, eye[2] + d.z * 400];
    void s;
  }
  __district.freeCam(eye, target, 55);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
}, CAM);
await page.waitForTimeout(SETTLE);

const result = await page.evaluate(async () => {
  const THREE = await import('/vendor/three.module.min.js');
  const d = __district, r = d.renderer, sc = d.scene, cam = d.camera;
  const size = r.getDrawingBufferSize(new THREE.Vector2());
  const W = size.x, H = size.y;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
  });
  const oldTarget = r.getRenderTarget();
  r.setRenderTarget(rt);
  r.clear();
  r.render(sc, cam);
  const buf = new Float32Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  r.setRenderTarget(oldTarget);
  rt.dispose();

  // Readback is bottom-up. Flip so y matches the screenshot / the reported boxes.
  const px = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) px.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);

  const exposure = d.postParams().exposure;
  const lum = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const maxc = (i) => Math.max(px[i], px[i + 1], px[i + 2]);

  // --- Frame-wide: how much of the frame is at or past the ceilings post cares
  // about, and how much of the top of the range survives them.
  const HALF_MAX = 65504, CEIL = 60000;
  const counts = { total: W * H, nan: 0, inf: 0, gtHalfMax: 0, gtCeil: 0, gt30k: 0, gt19k: 0, gt10k: 0 };
  // Log-spaced histogram of max-channel radiance.
  const bins = new Array(28).fill(0);
  let peak = 0, peakAt = null;
  for (let i = 0; i < px.length; i += 4) {
    const m = maxc(i);
    if (Number.isNaN(px[i]) || Number.isNaN(px[i + 1]) || Number.isNaN(px[i + 2])) counts.nan++;
    else if (!Number.isFinite(m)) counts.inf++;
    if (!(m > 0)) { bins[0]++; continue; }
    if (m > HALF_MAX) counts.gtHalfMax++;
    if (m > CEIL) counts.gtCeil++;
    if (m > 30000) counts.gt30k++;
    if (m > 19000) counts.gt19k++;
    if (m > 10000) counts.gt10k++;
    if (Number.isFinite(m) && m > peak) { peak = m; peakAt = (i / 4) | 0; }
    const b = Math.min(27, Math.max(0, Math.round(Math.log2(m) + 4)));
    bins[b]++;
  }
  if (peakAt !== null) peakAt = { x: peakAt % W, y: (peakAt / W) | 0 };

  // --- Connected components of "would be at or past sanitize's ceiling".
  // These are the regions where post loses BOTH magnitude and chroma, so they
  // are exactly the regions a composite-side rolloff cannot tell apart.
  const label = new Int32Array(W * H).fill(-1);
  const regions = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (label[s] !== -1) continue;
    const m0 = maxc(s * 4);
    if (!(m0 > CEIL) && Number.isFinite(m0)) { label[s] = -2; continue; }
    const id = regions.length;
    const reg = { id, n: 0, x0: W, y0: H, x1: 0, y1: 0, peak: 0, sumL: 0,
      sumR: 0, sumG: 0, sumB: 0, finiteMax: 0 };
    stack.length = 0; stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0, i = p * 4;
      reg.n++;
      if (x < reg.x0) reg.x0 = x; if (x > reg.x1) reg.x1 = x;
      if (y < reg.y0) reg.y0 = y; if (y > reg.y1) reg.y1 = y;
      const m = maxc(i);
      if (Number.isFinite(m)) { if (m > reg.finiteMax) reg.finiteMax = m; }
      reg.sumR += Math.min(px[i], 1e9) || 0; reg.sumG += Math.min(px[i + 1], 1e9) || 0;
      reg.sumB += Math.min(px[i + 2], 1e9) || 0;
      const L = lum(i); if (Number.isFinite(L)) reg.sumL += L;
      const nb = [];
      if (x > 0) nb.push(p - 1); if (x < W - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - W); if (y < H - 1) nb.push(p + W);
      for (const q of nb) {
        if (label[q] !== -1) continue;
        const mq = maxc(q * 4);
        if (mq > CEIL || !Number.isFinite(mq)) { label[q] = id; stack.push(q); }
        else label[q] = -2;
      }
    }
    regions.push(reg);
  }
  regions.sort((a, b) => b.n - a.n);
  const top = regions.slice(0, 14).map((g) => ({
    n: g.n, box: [g.x0, g.y0, g.x1, g.y1], w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1,
    finiteMax: Math.round(g.finiteMax),
    meanRGB: [g.sumR / g.n, g.sumG / g.n, g.sumB / g.n].map((v) => Math.round(v)),
    br: +(g.sumB / Math.max(1e-9, g.sumR)).toFixed(3),
  }));

  // --- Named rects, if the caller gave any.
  const rectStat = (x0, y0, x1, y1) => {
    let n = 0, mn = Infinity, mx = 0, sum = 0, ceil = 0, sat = 0;
    let sr = 0, sg = 0, sb = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4; const m = maxc(i);
      n++; sr += px[i]; sg += px[i + 1]; sb += px[i + 2];
      if (Number.isFinite(m)) { if (m < mn) mn = m; if (m > mx) mx = m; sum += m; } else sat++;
      if (!(m <= 60000)) ceil++;
    }
    return { n, min: Math.round(mn), max: Math.round(mx), mean: Math.round(sum / Math.max(1, n - sat)),
      atCeilFrac: +(ceil / n).toFixed(4), nonFinite: sat,
      meanRGB: [sr / n, sg / n, sb / n].map((v) => Math.round(v)) };
  };

  return {
    W, H, exposure,
    // The exposed value of the two ceilings, which is what the tonemap sees.
    ceilExposed: +(60000 * exposure).toFixed(3),
    halfMaxExposed: +(65504 * exposure).toFixed(3),
    counts, bins, peak: Number.isFinite(peak) ? Math.round(peak) : peak, peakAt,
    topCeilRegions: top,
    // The whitebox box, and the two panes inside it, measured in radiance.
    box: rectStat(110, 320, 320, 410),
    paneL: rectStat(238, 347, 287, 377),
    paneR: rectStat(300, 347, 349, 377),
  };
});

const out = { time: TIME, cam: CAM, ...result, pageErrors: errors };
const file = `docs/highlight-probe-${TIME}-${CAM}.json`;
fs.writeFileSync(file, JSON.stringify(out, null, 1));
await page.screenshot({ path: `docs/shots/hp-${TIME}-${CAM}.png` });
console.log(JSON.stringify(out, null, 1));
console.log('wrote', file);
await browser.close();
