// Where does the sun have to stand for its own occlusion to be visible?
//
// Round 5's dusk critic asked for one change: "make the sun's occlusion visible
// on the ground planes - and if the sun is currently near-axial with the camera,
// move its azimuth 40-70 degrees off the street's centreline so that it can be."
// It explicitly declined to claim shadows were not rendering. It was right to:
// the corridor camera's view heading is -16.0 deg and the dusk sun sits at
// 155.8 deg, so the sun is 171.8 deg off the lens - almost exactly behind it.
// Every shadow in that frame falls directly away from the camera and hides
// behind its own caster. Nothing is broken; the light is standing in the one
// place where its effect cannot be photographed.
//
// This measures that instead of assuming it. At each azimuth the same camera is
// rendered twice, differing ONLY in sun.shadow.intensity (a uniform - no shader
// recompile, no traversal, no second system disturbed), and the frames are
// differenced. The delta IS the occlusion: how much light the geometry takes out
// of the picture. An azimuth where the delta is near zero is one where shadows
// are real and invisible.
//
// The point is not to find a flattering angle. It is to establish that the
// instrument can produce BOTH readings before anything is authored from it.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
const TOD = process.env.SWEEP_TOD ?? 'dusk';
const SHOT = process.env.SWEEP_SHOT ?? 'corridor';
const KEEP = process.env.SWEEP_KEEP === '1';
fs.mkdirSync(OUT, { recursive: true });

const cfg = SHOTS[SHOT];
if (!cfg) throw new Error(`unknown shot: ${SHOT}`);

const BASE = { dusk: 2.72, noon: 0.6, night: 4.1 }[TOD];
const STEPS = Number(process.env.SWEEP_STEPS ?? 12);
const azimuths = [];
for (let i = 0; i < STEPS; i++) azimuths.push((BASE + (i * 2 * Math.PI) / STEPS) % (2 * Math.PI));

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

const placed = await page.evaluate(placeCamera, cfg);
await page.waitForTimeout(12000);

const deg = (r) => (r * 180) / Math.PI;
const wrap = (d) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
const headingDeg = placed.headingDeg;
console.log(describe(SHOT, placed) + `, ${TOD}\n`);

// Luminance difference between the shadowed and unshadowed render, per pixel.
// Reported over the whole frame and over the lower band, which is where the
// ground planes the critic asked about actually are.
function diff(aFile, bFile) {
  const A = readPNG(aFile), B = readPNG(bFile);
  const W = A.width, H = A.height, ca = A.channels, cb = B.channels;
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  let all = 0, allN = 0, low = 0, lowN = 0, lowHit = 0, peak = 0;
  const rows = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let rs = 0;
    for (let x = 0; x < W; x++) {
      // B is the unshadowed render, so d >= 0 is light the geometry removed.
      const d = lum(B.data, (y * W + x) * cb) - lum(A.data, (y * W + x) * ca);
      rs += d; all += d; allN++;
      if (d > peak) peak = d;
      if (y >= H / 2) { low += d; lowN++; if (d > 4) lowHit++; }
    }
    rows[y] = rs / W;
  }
  // The row where occlusion is strongest says whether it landed on the ground
  // (high row index) or only on distant facades (near the horizon).
  let bestRow = 0;
  for (let y = 0; y < H; y++) if (rows[y] > rows[bestRow]) bestRow = y;
  return {
    meanAll: +(all / allN).toFixed(2),
    meanGround: +(low / lowN).toFixed(2),
    groundFrac: +((lowHit / lowN) * 100).toFixed(1),
    peak: +peak.toFixed(0),
    peakRow: bestRow,
  };
}

const rows = [];
for (const az of azimuths) {
  await page.evaluate(([t, a]) => __district.setSunAzimuth(t, a), [TOD, az]);
  await page.waitForTimeout(9000);
  const shad = `${OUT}/sweep-${TOD}-${SHOT}-${Math.round(deg(az))}.png`;
  const flat = `${OUT}/sweep-${TOD}-${SHOT}-${Math.round(deg(az))}-noshadow.png`;
  await page.screenshot({ path: shad, timeout: 180000 });
  // The ONLY thing that changes: the sun's shadow term. Not the light, not the
  // sky, not the exposure - so the difference cannot be anything else.
  await page.evaluate(() => { __district.scene.traverse((o) => {
    if (o.isDirectionalLight && o.shadow) o.shadow.intensity = 0; }); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: flat, timeout: 180000 });
  await page.evaluate(() => { __district.scene.traverse((o) => {
    if (o.isDirectionalLight && o.shadow) o.shadow.intensity = 1; }); });
  await page.waitForTimeout(1200);

  const d = diff(shad, flat);
  const off = Math.abs(wrap(deg(az) - headingDeg));
  rows.push({ azimuthDeg: +deg(az).toFixed(1), offAxisDeg: +off.toFixed(1), ...d });
  console.log(`az ${deg(az).toFixed(0).padStart(4)} deg  ${off.toFixed(0).padStart(3)} deg off lens   ` +
    `occlusion: frame ${String(d.meanAll).padStart(6)}  ground ${String(d.meanGround).padStart(6)}  ` +
    `${String(d.groundFrac).padStart(5)}% of ground pixels  peak ${String(d.peak).padStart(3)} at row ${d.peakRow}`);
  if (!KEEP) fs.rmSync(flat, { force: true });
}

const best = rows.reduce((a, b) => (b.meanGround > a.meanGround ? b : a));
const worst = rows.reduce((a, b) => (b.meanGround < a.meanGround ? b : a));
console.log(`\nstrongest occlusion: az ${best.azimuthDeg} deg (${best.offAxisDeg} off lens), ` +
  `ground delta ${best.meanGround}, ${best.groundFrac}% of ground pixels`);
console.log(`weakest occlusion:   az ${worst.azimuthDeg} deg (${worst.offAxisDeg} off lens), ` +
  `ground delta ${worst.meanGround}, ${worst.groundFrac}% of ground pixels`);
console.log(`authored azimuth is ${deg(BASE).toFixed(1)} deg; ratio best/authored = ` +
  `${(best.meanGround / (rows[0].meanGround || 1e-6)).toFixed(1)}x`);
fs.writeFileSync(`docs/sun-sweep-${TOD}-${SHOT}.json`,
  JSON.stringify({ shot: SHOT, tod: TOD, headingDeg: +headingDeg.toFixed(1),
    authoredAzimuthDeg: +deg(BASE).toFixed(1), rows }, null, 1));
console.log(`wrote docs/sun-sweep-${TOD}-${SHOT}.json`);
await browser.close();
