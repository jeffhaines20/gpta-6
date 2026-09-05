// What IS the white rectangle on the corridor tower?
//
// Four critics reported it in an earlier round; sanitize-probe.mjs tested the
// NaN/Inf-guard hypothesis and REFUTED it (0% of the box is the guard). It has
// been unexplained since, and two independent blind reviewers have now picked it
// as the single defect that loses a before/after pair.
//
// It is achromatic, flat, hard-edged, axis-aligned, present at golden hour and
// absent at dusk and night, and - the decisive observation - its top edge has
// ZERO SLOPE across a span where the facade's own string course drops four
// pixels. It ignores perspective, so it is screen-space, and it paints over a
// pier and a spandrel that are geometrically in FRONT of the glass, so it is
// additive.
//
// That is the signature of BLOOM: the pass downsamples, and a mip block that
// saturates comes back up as a hard-edged rectangle rather than a soft halo.
// This turns bloom off and on at one camera in one page session and measures the
// box, so the only difference between the two frames is the uniform.
//
//   node tools/whitebox-probe.mjs
//   WB_TIME=dusk node tools/whitebox-probe.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const TIME = process.env.WB_TIME ?? 'golden';
// The box the reviewers reported, on the 1600x900 corridor hero framing.
const BOX = (process.env.WB_BOX ?? '110,320,320,410').split(',').map(Number);

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TIME);

// The corridor hero camera, taken from the same place hero-shots.mjs takes it so
// the frame is the one the reviewers looked at rather than a new view of it.
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
await page.waitForTimeout(Number(process.env.WB_SETTLE ?? 20000));

const stat = (file) => {
  const img = readPNG(file);
  const { width: w, channels: c, data } = img;
  const [x0, y0, x1, y1] = BOX;
  let white = 0, n = 0, sum = 0;
  // Hard-edge count along the top of the box: how many columns step from
  // not-white to white in a single pixel. A soft halo steps over many.
  let hardCols = 0, cols = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * c;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      n++; sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (r > 250 && g > 250 && b > 250) white++;
    }
  }
  for (let x = x0; x <= x1; x++) {
    let prev = null, stepped = false;
    for (let y = y0; y <= y1; y++) {
      const i = (y * w + x) * c;
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (prev !== null && prev < 200 && l > 250) stepped = true;
      prev = l;
    }
    cols++; if (stepped) hardCols++;
  }
  return { whiteFrac: +(white / n).toFixed(4), meanLuma: +(sum / n).toFixed(1),
    hardStepCols: hardCols, cols };
};

const shot = async (tag, strength) => {
  await page.evaluate((s) => { __district.postParams().bloomStrength = s; }, strength);
  await page.waitForTimeout(1500);
  const f = `docs/shots/whitebox-${tag}-${TIME}.png`;
  await page.screenshot({ path: f });
  return { file: f, ...stat(f) };
};

const before = await page.evaluate(() => __district.postParams().bloomStrength);
const on = await shot('bloom-on', before);
const off = await shot('bloom-off', 0);
await page.evaluate((s) => { __district.postParams().bloomStrength = s; }, before);

const verdict = off.whiteFrac < on.whiteFrac * 0.4
  ? `CONFIRMED - bloom is the white rectangle (${(on.whiteFrac * 100).toFixed(1)}% -> ${(off.whiteFrac * 100).toFixed(1)}% white with it off)`
  : (on.whiteFrac < 0.02
    ? 'MOOT - the box is not white in this build at this time of day'
    : `REFUTED - the box stays ${(off.whiteFrac * 100).toFixed(1)}% white with bloom off, so it is geometry or material`);

const out = { time: TIME, box: BOX, bloomStrength: before, bloomOn: on, bloomOff: off, verdict, pageErrors: errors };
fs.writeFileSync(`docs/whitebox-probe-${TIME}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
