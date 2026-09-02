// Do objects touch the ground? A paired-capture instrument for ground contact.
//
// Built for the round-6 finding that cars, bins, posts, planters and pedestrians
// sit ON the street rather than in it: the sun's shadow pass works (long mast
// shadows cross the crosswalk) and is selectively empty. So this measures the
// specific boxes the critics named, in the two hero framings, at three times of
// day, and it is written to be run twice - once before a change, once after -
// with tools/contact-diff.mjs subtracting the pair.
//
// Three controls, each earned by a failure recorded in PROGRESS.md:
//   - traffic and pedestrians are frozen to zero, because anything that moves
//     between paired captures shows up as the change under test;
//   - a NOISE FLOOR is measured first, by capturing one untouched frame twice.
//     Any per-box delta below that floor is not a measurement;
//   - the framing comes from tools/framing.mjs. Three harnesses have copied the
//     constants and left the clearance loop behind, and measured from inside
//     building 67.
//
// Every prediction box is stated here in image coordinates so the acceptance
// test is fixed before the change, not chosen afterwards from whatever moved.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
// Captures are named contact-<tag>-... . The tag alone is not enough: a first run
// with CONTACT_TAG=after silently overwrote four committed docs/shots/after-*.png
// belonging to an unrelated change, which is the image equivalent of `git add -A`.
const TAG = process.env.CONTACT_TAG ?? 'run';
const TIMES = (process.env.CONTACT_TIMES ?? 'golden,dusk,night').split(',');

// The round-6 critics' falsifiable predictions, verbatim as boxes. `want` says
// which direction a correct change moves the box; `control` boxes must NOT move.
export const BOXES = {
  corridor: [
    { name: 'red-car',        x: 660,  y: 535,  w: 280, h: 105, want: 'darker', note: 'car body + the tarmac under it' },
    { name: 'red-car-ground', x: 660,  y: 600,  w: 280, h: 70,  want: 'darker', note: 'road at the tyre contact points' },
    { name: 'trash-can',      x: 1250, y: 578,  w: 75,  h: 82,  want: 'darker', note: 'bin and the tile joint beneath it' },
    { name: 'sidewalk-left',  x: 0,    y: 620,  w: 500, h: 280, want: 'darker', note: 'three bollards and a bin' },
    // Named for what the round-6 critics reported here - "long sharp signal-mast
    // shadows crossing the crosswalk" - and kept under that name because it is the
    // claim under test. It did not survive: capturing this frame with
    // shadow.intensity = 0 moves both boxes by 0.00 of 255, so what is there is the
    // crossing's white bars over dark aggregate, not a cast shadow. Still controls,
    // just not for the reason they were written: whatever the boxes hold, a change
    // that turns them into mud has broken the crossing.
    { name: 'mast-shadow-a',  x: 680,  y: 670,  w: 120, h: 130, control: true,  note: 'reported as a mast shadow; measured to be the zebra crossing' },
    { name: 'mast-shadow-b',  x: 860,  y: 655,  w: 80,  h: 145, control: true,  note: 'reported as a mast shadow; measured to be the zebra crossing' },
    { name: 'sky',            x: 950,  y: 40,   w: 500, h: 150, control: true,  note: 'nothing here may change' },
    { name: 'window-glow',    x: 60,   y: 300,  w: 420, h: 240, control: true,  note: 'night mullion spill' },
  ],
  fivepoints: [
    { name: 'green-car',      x: 1040, y: 600,  w: 105, h: 45,  want: 'darker' },
    { name: 'mailbox',        x: 219,  y: 585,  w: 35,  h: 61,  want: 'darker' },
    { name: 'player',         x: 455,  y: 780,  w: 105, h: 120, want: 'darker' },
    { name: 'lamp-pool',      x: 810,  y: 535,  w: 210, h: 195, control: true,  note: 'night lamp pools - must survive' },
    { name: 'storefront',     x: 1180, y: 380,  w: 380, h: 300, control: true,  note: 'night storefront spill' },
    { name: 'sky',            x: 600,  y: 30,   w: 400, h: 120, control: true },
  ],
};

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** Per-box statistics for one capture. Crushed and clipped are reported for every
 *  box because a shadow that solves contact by crushing the frame has not solved it. */
export function stats(file, boxes) {
  const img = readPNG(file), W = img.width, H = img.height, c = img.channels;
  const out = {};
  const whole = { name: 'FRAME', x: 0, y: 0, w: W, h: H };
  for (const b of [whole, ...boxes]) {
    let s = 0, n = 0, crushed = 0, clipped = 0;
    const vals = [];
    for (let y = b.y; y < Math.min(H, b.y + b.h); y++) {
      for (let x = b.x; x < Math.min(W, b.x + b.w); x++) {
        const v = lum(img.data, (y * W + x) * c);
        s += v; n++; vals.push(v);
        if (v <= 6) crushed++;
        if (v > 250) clipped++;
      }
    }
    vals.sort((p, q) => p - q);
    out[b.name] = {
      mean: +(s / n).toFixed(3),
      p05: +vals[Math.floor(n * 0.05)].toFixed(1),
      p50: +vals[Math.floor(n * 0.5)].toFixed(1),
      crushedPct: +((crushed / n) * 100).toFixed(2),
      clippedPct: +((clipped / n) * 100).toFixed(2),
      px: n,
    };
  }
  return out;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/contact.mjs')) {
  await ensureServer();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
  // Nothing may move between paired captures. Three things move on their own:
  // traffic, the crowd, and the cloud deck, which drifts on wall-clock time and
  // was measured shifting the upper frame by 20+ luminance over the minutes one
  // of these runs takes.
  await page.evaluate(() => {
    __district.setTraffic(0);
    __district.setPedestrians(0);
    __district.sky.cloudWind.set(0, 0);
  });

  // Wait for STREAMING to stop, not for a clock. Chunks were still arriving two
  // minutes after placement (44 chunks/112 meshes at 20 s, 94/261 at settle) and
  // every near chunk that lands adds shadow casters, so a capture taken early is
  // a different scene from one taken late. world.report().queued is a cumulative
  // counter, not a live depth - the honest test is that the mesh count has
  // stopped changing.
  const settle = async () => {
    let last = -1, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) {
      const w = await page.evaluate(() => { const r = __district.worldReport(); return { l: r.loads, m: r.meshes }; });
      stable = (w.m === last) ? stable + 1 : 0;
      last = w.m;
      if (stable < 3) await page.waitForTimeout(2500);
    }
    return last;
  };

  const results = [];
  let floor = null;
  for (const [name, cfg] of Object.entries(SHOTS)) {
    const placed = await page.evaluate(placeCamera, cfg);
    console.log(describe(name, placed));
    const meshes = await settle();
    console.log(`  world settled at ${meshes} chunk meshes`);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await page.waitForTimeout(12000);
      const file = `${OUT}/contact-${TAG}-${name}-${tod}.png`;
      await page.screenshot({ path: file, timeout: 180000 });
      if (!floor) {
        // Same frame, twice, untouched. Below this, nothing this tool prints
        // about this pair of runs means anything.
        const f2 = `${OUT}/contact-${TAG}-noise.png`;
        await page.waitForTimeout(2500);
        await page.screenshot({ path: f2, timeout: 180000 });
        const a = stats(file, BOXES[name]), b = stats(f2, BOXES[name]);
        floor = {};
        for (const k of Object.keys(a)) floor[k] = +Math.abs(b[k].mean - a[k].mean).toFixed(3);
        console.log('noise floor (same frame twice):',
          Object.entries(floor).map(([k, v]) => `${k} ${v}`).join('  '));
      }
      const st = stats(file, BOXES[name]);
      const audit = await page.evaluate(() => {
        const r = __district.renderStats();
        let casters = 0, meshes = 0;
        __district.scene.traverse((o) => { if (o.isMesh) { meshes++; if (o.castShadow) casters++; } });
        return { draw: r.calls, sceneCalls: r.sceneCalls, tris: r.triangles, casters, meshes };
      });
      results.push({ shot: name, tod, file, stats: st, audit });
      console.log(`${name}/${tod}: draw ${audit.draw} tris ${audit.tris} casters ${audit.casters}/${audit.meshes}` +
        `  frame mean ${st.FRAME.mean} crushed ${st.FRAME.crushedPct}%`);
    }
  }
  fs.writeFileSync(`docs/contact-${TAG}.json`,
    JSON.stringify({ tag: TAG, noiseFloor: floor, boxes: BOXES, results, errors }, null, 1));
  console.log(`\nwrote docs/contact-${TAG}.json`);
  if (errors.length) console.log('PAGE ERRORS:', errors);
  await browser.close();
}
