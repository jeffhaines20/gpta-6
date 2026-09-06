// The two before/after tables this round is judged on, from one place, so the
// commit message and the JSON cannot disagree.
//
//   node tools/warmth-tables.mjs <beforeTag> <afterTag>
//
// Every column is a ratio taken inside ONE frame, for the reason in
// tools/warmth-probe.mjs's header: noon's stop moved between the two builds the
// review compared, so no absolute byte quantity survives that comparison. The
// one exception is the ground-plane R-B row, which is in the review's own units
// and is quoted at GOLDEN only, where the stop is 1/9,649 on every build in this
// table.
import fs from 'node:fs';
import { readPNG } from './png.mjs';
import { unDisplay } from './critic-metrics.mjs';
import { meanLinear, armSplit, lightMasks, bandSplit, overFraction } from './warmth-probe.mjs';

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const BANDS = {
  corridor: { brickwalk: [1240, 620, 360, 270], carriageway: [500, 700, 620, 190] },
  fivepoints: { brickwalk: [1240, 620, 360, 260], carriageway: [520, 700, 600, 190] },
};
const GROUND = { fivepoints: [60, 640, 1440, 260], corridor: [60, 660, 1440, 240] };
const SKY_REVIEW = { corridor: [270, 95, 80, 60], fivepoints: [300, 40, 120, 80] };
const SKY_CLEAN = { corridor: [160, 220, 80, 40], fivepoints: [700, 20, 200, 60] };
const LIT_GROUND = { corridor: [1330, 690, 120, 70], fivepoints: [760, 700, 140, 100] };
// The camera stop each capture was taken at, so a byte can be turned back into
// nits. Read from the audits rather than assumed; asserted below.
const STOP = { noon: 22100, golden: 9649 };

const F = (v, w = 8) => String(v).padStart(w);
const nits = (img, rect, tod) => {
  const m = meanLinear(img, rect);
  return { L: +luma(m.r, m.g, m.b).toFixed(1), nits: Math.round(luma(m.R, m.G, m.B) * STOP[tod]) };
};

const [BEFORE, AFTER] = process.argv.slice(2);
if (!BEFORE || !AFTER) { console.error('usage: warmth-tables.mjs <beforeTag> <afterTag>'); process.exit(2); }
const has = (t, a, f, d) => fs.existsSync(`docs/shots/${t}-${a ? a + '-' : ''}${f}-${d}.png`);
const load = (t, a, f, d) => readPNG(`docs/shots/${t}-${a ? a + '-' : ''}${f}-${d}.png`);

const out = { before: BEFORE, after: AFTER, rows: [] };

console.log('DEFECT 1 — open shade against the sun, at golden hour.');
console.log('  R/B of scene-linear radiance. fill/sun > 1 is the reported defect.\n');
console.log('  framing/tod    band          arm   fill/sun  fillRB  sunRB | shadeRB   sunRB    dRB   sun%');
for (const framing of ['corridor', 'fivepoints']) {
  for (const tod of ['golden', 'noon']) {
    for (const tag of [BEFORE, AFTER]) {
      if (!has(tag, null, framing, tod) || !has(tag, 'nosun', framing, tod)) continue;
      const base = load(tag, null, framing, tod);
      const nosun = load(tag, 'nosun', framing, tod);
      const masks = has(tag, 'noshadow', framing, tod)
        ? lightMasks(base, nosun, load(tag, 'noshadow', framing, tod)) : null;
      for (const [bn, rect] of Object.entries(BANDS[framing])) {
        const a = armSplit(base, nosun, rect);
        const b = masks ? bandSplit(base, masks, rect) : null;
        const dash = (v) => (v === null || v === undefined ? '     --' : v);
        console.log(`  ${(framing + ' ' + tod).padEnd(16)}${bn.padEnd(13)} ${tag.padEnd(4)}` +
          `${F(dash(a.fillOverSun))}${F(a.fillRB)}${F(dash(a.sunRB))} |` +
          (b ? `${F(b.shadeRB)}${F(dash(b.sunRB))}${F(dash(b.deltaRB))}${F(b.sunPct, 6)}` +
            (b.thinSunPopulation ? `  (only ${b.sunN} sunlit px)` : '') : ''));
        out.rows.push({ tag, framing, tod, band: bn, arm: a, inFrame: b });
      }
    }
  }
}

console.log('\n  The shipped fill, read off the frame rather than off an arm: the ground');
console.log('  plane at golden, in the review\'s own units and stop-comparable there.\n');
console.log('  framing/tod       tag     R-B      R/B        L');
const ground = [];
for (const framing of ['corridor', 'fivepoints']) {
  for (const tod of ['golden', 'noon']) {
    for (const tag of [BEFORE, AFTER]) {
      if (!has(tag, null, framing, tod)) continue;
      const g = meanLinear(load(tag, null, framing, tod), GROUND[framing]);
      const row = { tag, framing, tod, rMinusB: +(g.r - g.b).toFixed(1),
        rb: +(g.R / g.B).toFixed(3), L: +luma(g.r, g.g, g.b).toFixed(1) };
      ground.push(row);
      console.log(`  ${(framing + ' ' + tod).padEnd(18)}${tag.padEnd(6)}${F(row.rMinusB)}${F(row.rb)}${F(row.L)}`);
    }
  }
}
out.groundPlane = ground;

console.log('\n\nDEFECT 2 — headroom above ground albedo at noon.\n');
console.log('  framing/tod       tag   reviewSky  cleanSky  litGround  clean/gnd  >230%  maxByte');
const head = [];
for (const framing of ['corridor', 'fivepoints']) {
  for (const tod of ['noon', 'golden']) {
    for (const tag of [BEFORE, AFTER]) {
      if (!has(tag, null, framing, tod)) continue;
      const img = load(tag, null, framing, tod);
      const r = nits(img, SKY_REVIEW[framing], tod);
      const c = nits(img, SKY_CLEAN[framing], tod);
      const g = nits(img, LIT_GROUND[framing], tod);
      let maxb = 0;
      for (let i = 0; i < img.width * img.height * img.channels; i++) {
        if (img.data[i] > maxb) maxb = img.data[i];
      }
      const row = { tag, framing, tod, reviewSkyNits: r.nits, cleanSkyNits: c.nits,
        litGroundNits: g.nits, cleanOverGround: +(c.nits / g.nits).toFixed(3),
        reviewOverGround: +(r.nits / g.nits).toFixed(3),
        over230Pct: +overFraction(img, 230).toFixed(3), maxChannelByte: maxb };
      head.push(row);
      console.log(`  ${(framing + ' ' + tod).padEnd(18)}${tag.padEnd(5)}${F(r.nits)}${F(c.nits)}${F(g.nits)}` +
        `${F(row.cleanOverGround)}${F(row.over230Pct)}${F(maxb, 8)}`);
    }
  }
}
out.headroom = head;

// The ceiling every one of those maxByte values lands on, predicted from the
// chain rather than read off the frame: sanitize() clamps the half-float scene
// target at 60,000 nits, and where that lands in bytes is set by the stop.
const aces = (x) => Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const roll = (x, K = 0.5, C = 8.0) => { const S = C - K, t = Math.max(x - K, 0); return Math.min(x, K) + (S * t) / (S + t); };
const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toByte = (n, e) => Math.round(255 * srgb(aces(roll(n * e))));
console.log('\n  Predicted brightest reachable byte, from sanitize()\'s 60,000-nit half-float');
console.log('  ceiling through exposure -> rolloff -> ACES -> sRGB:');
out.ceiling = {};
for (const [t, e] of Object.entries(STOP)) {
  out.ceiling[t] = toByte(60000, 1 / e);
  console.log(`    ${t.padEnd(7)} 1/${e}  ->  byte ${out.ceiling[t]}`);
}
void unDisplay;

fs.mkdirSync('docs/measurements', { recursive: true });
fs.writeFileSync(`docs/measurements/warmth-tables-${BEFORE}-${AFTER}.json`, JSON.stringify(out, null, 1));
console.log(`\nwrote docs/measurements/warmth-tables-${BEFORE}-${AFTER}.json`);
