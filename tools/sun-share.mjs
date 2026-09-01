// How much of the light on the ground is the SUN?
//
// tools/sun-sweep.mjs swept the dusk sun through 360 degrees and found the ground
// occlusion barely moves: 1.99 to 3.55 mean delta, 15% to 33% of ground pixels,
// with the AUTHORED azimuth already second-best. So "the sun is near-axial with
// the camera and that is why shadows are invisible" - the round-5 dusk critic's
// hypothesis, the sky agent's independent reading, and my own plan - is wrong.
// Something else caps how dark a cast shadow on the ground can get.
//
// The candidate is the preset's own photometry. Illuminance on a HORIZONTAL
// surface from a directional source is E * sin(elevation). Dusk authors
// sunLux 1200 at elevation 0.055 rad, so the sun puts 1200 * sin(3.15 deg) = 66
// lux on the road while the sky puts ~900. If that arithmetic describes the
// render, the sun owns about 7% of the ground and a cast shadow physically
// cannot remove more than that - no azimuth, no shadow-map setting and no amount
// of critique can make it legible.
//
// So this measures the render's actual split rather than trusting the arithmetic:
// the same frame with the sun's shadow off, and with the sun itself off, over the
// ground band and over the vertical band. Both toggles are single values.
//
// Two controls, because the first version of this probe reported that the shadow
// removed 400% of the light the sun put down - an impossible number that came
// from comparing frames with traffic and pedestrians moving between them:
//   - traffic and pedestrians are set to zero, so the only thing that differs
//     between paired captures is the toggle;
//   - a NOISE FLOOR is measured first, by capturing the same untouched frame
//     twice. Any delta below that floor is not a measurement.
// The clipped fraction is reported too: a band sitting at 213/255 is saturated,
// and a toggle that changes nothing there has proved nothing.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TOD = process.env.SHARE_TOD ?? 'dusk';
// Elevations to probe, in radians. The authored value first, so the baseline is
// the shipping preset and everything after it is a comparison against it.
const ELEVS = (process.env.SHARE_ELEVS ?? '').split(',').filter(Boolean).map(Number);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

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
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
// Nothing may move between paired captures.
await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });
await page.waitForTimeout(14000);

const lum = (d, i, c) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
// Row 560 down is road and pavement at this framing; rows 300-460 are the facade
// band above the parked cars and below the cornices. Split because a low sun puts
// its light on VERTICAL surfaces, and a measurement that only looks at the road
// would call a correctly-lit street dark.
function bands(file) {
  const img = readPNG(file), W = img.width, H = img.height, c = img.channels;
  const acc = (y0, y1) => {
    let s = 0, n = 0, clip = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
      const v = lum(img.data, (y * W + x) * c, c);
      s += v; n++; if (v > 250) clip++;
    }
    return { mean: s / n, clip: (clip / n) * 100 };
  };
  const g = acc(560, H), f = acc(300, 460);
  return { ground: g.mean, groundClip: g.clip, facade: f.mean, facadeClip: f.clip };
}

async function shot(tag) {
  const f = `${OUT}/share-${TOD}-${tag}.png`;
  await page.screenshot({ path: f, timeout: 180000 });
  return { f, ...bands(f) };
}
const SET = {
  base:     () => {},
  noshadow: () => __district.scene.traverse((o) => { if (o.isDirectionalLight && o.shadow) o.shadow.intensity = 0; }),
  nosun:    () => __district.scene.traverse((o) => { if (o.isDirectionalLight) o.intensity = 0; }),
};
const RESET = () => __district.scene.traverse((o) => {
  if (o.isDirectionalLight) { if (o.shadow) o.shadow.intensity = 1; }
});

const rows = [];
// Capture the same untouched frame twice. Whatever this reads is the floor below
// which no delta in this probe means anything.
async function noiseFloor() {
  const a = await shot('noise-a');
  await page.waitForTimeout(1600);
  const b = await shot('noise-b');
  const f = { ground: Math.abs(b.ground - a.ground), facade: Math.abs(b.facade - a.facade) };
  console.log(`noise floor (same frame twice): ground ${f.ground.toFixed(2)}, facade ${f.facade.toFixed(2)}`);
  return f;
}

async function measure(label, floor) {
  const out = {};
  for (const [k, fn] of Object.entries(SET)) {
    if (k !== 'base') await page.evaluate(`(${fn.toString()})()`);
    await page.waitForTimeout(1600);
    out[k] = await shot(`${label}-${k}`);
    if (k === 'noshadow') { await page.evaluate(`(${RESET.toString()})()`); await page.waitForTimeout(900); }
    if (k === 'nosun') { await page.evaluate((t) => __district.setTimeOfDay(t), TOD); await page.waitForTimeout(6000); }
  }
  // The first version of this probe compared base against nosun and called the
  // result "what the sun puts on the ground". It reported the shadow removing
  // 666% of it. The frames were right and the subtraction was wrong: at this
  // camera the visible road is ALREADY in shadow, so switching the sun off
  // changes nothing there, and the sun's real contribution only appears once the
  // shadow is lifted. The unoccluded frame is the reference, not the authored one.
  //
  //   potential = noshadow - nosun   the sun's full contribution, nothing blocking
  //   blocked   = noshadow - base    how much of that the geometry actually takes
  const potG = out.noshadow.ground - out.nosun.ground;
  const potF = out.noshadow.facade - out.nosun.facade;
  const r = {
    label,
    ground: +out.base.ground.toFixed(1),
    sunPotentialOnGround: +potG.toFixed(1),
    blockedOnGround: +(out.noshadow.ground - out.base.ground).toFixed(1),
    sunPotentialOnFacade: +potF.toFixed(1),
    blockedOnFacade: +(out.noshadow.facade - out.base.facade).toFixed(1),
  };
  // The headline: of the light that would reach the road, how much is the sun's -
  // and how much of the sun's share the geometry is currently blocking. A shadow
  // can never be more legible than the first number allows.
  r.sunSharePct = +((potG / (out.noshadow.ground || 1e-6)) * 100).toFixed(1);
  r.blockedPct = +((r.blockedOnGround / (potG || 1e-6)) * 100).toFixed(1);
  r.groundClipPct = +out.base.groundClip.toFixed(1);
  // Say so out loud rather than letting a saturated band read as "no effect".
  r.trustworthy = potG > Math.max(floor.ground * 3, 0.2) && out.base.groundClip < 5;
  rows.push(r);
  console.log(`${label.padEnd(14)} ground ${String(r.ground).padStart(6)} ` +
    `(${String(r.groundClipPct).padStart(4)}% clipped)  ` +
    `sun could put down ${String(r.sunPotentialOnGround).padStart(6)} = ` +
    `${String(r.sunSharePct).padStart(5)}% of the road  |  geometry blocks ` +
    `${String(r.blockedOnGround).padStart(5)} = ${r.blockedPct}% of it  |  ` +
    `facade: sun ${r.sunPotentialOnFacade}, blocked ${r.blockedOnFacade}` +
    (r.trustworthy ? '' : '   <- BELOW NOISE FLOOR or SATURATED, not a measurement'));
  return r;
}

const floor = await noiseFloor();
await measure(`authored`, floor);
for (const e of ELEVS) {
  await page.evaluate(([t, el]) => __district.setSunElevation(t, el), [TOD, e]);
  await page.waitForTimeout(9000);
  await measure(`elev-${((e * 180) / Math.PI).toFixed(1)}deg`, floor);
}
fs.writeFileSync(`docs/sun-share-${TOD}.json`, JSON.stringify({ tod: TOD, noiseFloor: floor, rows }, null, 1));
console.log(`\nwrote docs/sun-share-${TOD}.json`);
await browser.close();
