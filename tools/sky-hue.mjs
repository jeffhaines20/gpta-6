// Does the sky dome rotate hue with ELEVATION, and does that reach the ground?
//
// Three blind critics independently reported the same defect: the whole frame
// sits in one narrow hue band, with no measurable difference between up-facing,
// street-facing and recessed surfaces. The chain behind that is
//   flat-hue dome -> warm PMREM -> warm ambient on every normal
// and the only number that settles whether a change fixed it is the hue of the
// dome as a function of elevation, plus the hue of the irradiance it delivers to
// an up-facing normal.
//
// Two modes, because the two questions need different instruments:
//
//   node tools/sky-hue.mjs                 (browser)
//     Opens the sky lab, and for each preset reads the 256x128 scattering LUT
//     back in PHYSICAL NITS - upstream of tone mapping, bloom and the frame's
//     limited 0-25 deg view of the sky. Reports mean radiance per elevation band
//     and per azimuth sector relative to the sun, and then integrates
//     L cos(theta) dw over the upper hemisphere: that integral IS what the PMREM
//     hands a flat up-facing surface, so its chroma is the ambient's chroma.
//
//   node tools/sky-hue.mjs --frames a.png b.png ...      (no browser)
//     The rendered-frame measurement, in 8-bit sRGB, over the exact sample
//     windows the review that raised this used: a 300 px wide slice of open sky
//     banded by height, plus one box per surface class. Same windows before and
//     after, or the comparison means nothing — so the frames must come from the
//     SAME shot of tools/hero-shots.mjs (`fivepoints`, 1600x900), and its camera
//     placement log must report the same `back` and clearance in both runs.
//
// Two things this has already been caught out by, both worth repeating:
//   - the LUT numbers are byte-identical across runs, because the integral is
//     deterministic. That is NOT evidence the harness skipped: check the artefact
//     mtime and the reported generationMs, which do move.
//   - the sky slice at dusk is roughly half CLOUD DECK, which is lit warm. Its
//     R-B therefore cannot go negative however cool the clear dome gets, and the
//     clear-sky number has to be read off the LUT probe instead.
import fs from 'node:fs';
import { readPNG, meanRect } from './png.mjs';

// Sky slice from the hero `fivepoints` framing, 1600x900. x 600-900 is the open
// wedge between the two blocks; the lowest band deliberately includes the roof
// line, because that is where the review's number came from.
const SKY_X = [600, 900];
const SKY_BANDS = [['zenith', 0, 60], ['upper', 60, 160], ['mid', 160, 280],
  ['lower', 280, 380], ['horizon', 380, 450]];
// Surface classes in the same `fivepoints` framing, because the finding was not
// "the sky is too warm" — it was that a sidewalk, a wall and a recess all came
// back the same hue. Each rectangle was checked against the frame before it was
// used: SIDEWALK is unbroken pavement with no lamp pool and no vehicle in it, and
// it is the same box the review's "sidewalk L 133.2, R-B +25.0" came from.
const SIDEWALK = [880, 605, 1080, 705];
const SURFACES = [
  ['pavement (up-facing)', 880, 605, 1080, 705],
  ['asphalt (up-facing)', 300, 640, 560, 760],
  ['facade, sun side', 1180, 150, 1420, 330],
  ['facade, far side', 60, 120, 330, 420],
  ['recess under awning', 1200, 470, 1320, 620],
];

const ELEV_BANDS = [[80, 90], [60, 80], [40, 60], [25, 40], [12, 25], [4, 12], [0, 4]];

function rb(m) { return { R: +m.r.toFixed(1), G: +m.g.toFixed(1), B: +m.b.toFixed(1), RmB: +(m.r - m.b).toFixed(1) }; }

function frameReport(file) {
  const img = readPNG(file);
  const bands = SKY_BANDS.map(([name, y0, y1]) => {
    const m = meanRect(img, SKY_X[0], y0, SKY_X[1], y1);
    return { band: name, y: `${y0}-${y1}`, ...rb(m) };
  });
  const s = meanRect(img, SIDEWALK[0], SIDEWALK[1], SIDEWALK[2], SIDEWALK[3]);
  const whole = meanRect(img, 0, 0, img.width, img.height);
  const lum = (m) => +(0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b).toFixed(1);
  return {
    file,
    mtime: fs.statSync(file).mtime.toISOString(),
    skySlice: bands,
    sidewalk: { ...rb(s), L: lum(s) },
    wholeFrame: { ...rb(whole), L: lum(whole) },
    surfaces: SURFACES.map(([name, x0, y0, x1, y1]) => {
      const m = meanRect(img, x0, y0, x1, y1);
      return { name, ...rb(m), L: lum(m) };
    }),
  };
}

if (process.argv.includes('--frames')) {
  const files = process.argv.slice(process.argv.indexOf('--frames') + 1);
  const out = files.filter((f) => fs.existsSync(f)).map(frameReport);
  for (const r of out) {
    console.log(`\n=== ${r.file}   (written ${r.mtime}) ===`);
    for (const b of r.skySlice) {
      console.log(`  ${b.band.padEnd(8)} y ${b.y.padEnd(8)} R ${String(b.R).padStart(6)}  G ${String(b.G).padStart(6)}` +
        `  B ${String(b.B).padStart(6)}   R-B ${b.RmB > 0 ? '+' : ''}${b.RmB}`);
    }
    for (const s2 of [...r.surfaces, { name: 'WHOLE FRAME', ...r.wholeFrame }]) {
      console.log(`  ${s2.name.padEnd(22)} L ${String(s2.L).padStart(6)}   R ${String(s2.R).padStart(6)}` +
        `  G ${String(s2.G).padStart(6)}  B ${String(s2.B).padStart(6)}` +
        `   R-B ${s2.RmB > 0 ? '+' : ''}${s2.RmB}`);
    }
  }
  const tag = process.env.SKY_HUE_TAG ?? 'frames';
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(`docs/sky-hue-${tag}.json`, JSON.stringify(out, null, 1));
  console.log(`\nwrote docs/sky-hue-${tag}.json`);
  process.exit(0);
}

// ------------------------------------------------------------------ LUT probe
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const TIMES = (process.env.SKY_HUE_TIMES ?? 'noon,dusk,night').split(',');
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/labs/sky/', { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__lab && window.__lab.ready, { timeout: 180000 });

const results = [];
for (const t of TIMES) {
  await page.evaluate((tt) => window.__lab.setTime(tt), t);
  await page.waitForTimeout(4000);
  const r = await page.evaluate((bands) => {
    const L = window.__lab, THREE = L.THREE, sky = L.sky;
    const W = sky.lutWidth, H = sky.lutHeight;
    const buf = new Uint16Array(W * H * 4);
    L.renderer.readRenderTargetPixels(sky.lut, 0, 0, W, H, buf);
    const half = THREE.DataUtils.fromHalfFloat;
    const sunAz = Math.atan2(sky.sunDirection.z, sky.sunDirection.x);

    // Elevation bands x azimuth sector. Sectors are relative to the sun so the
    // numbers stay comparable across presets with different sun azimuths.
    const acc = {};
    const key = (b, s) => `${b}|${s}`;
    const add = (b, s, r, g, bl, w) => {
      const k = key(b, s);
      acc[k] = acc[k] || [0, 0, 0, 0];
      acc[k][0] += r * w; acc[k][1] += g * w; acc[k][2] += bl * w; acc[k][3] += w;
    };
    // Up-facing irradiance: integral of L cos(theta) dw over the upper hemisphere.
    let E = [0, 0, 0];
    // Hemispherical illuminance for cross-checking against sky.audit().skyLux.
    for (let y = 0; y < H; y++) {
      const theta = ((y + 0.5) / H - 0.5) * Math.PI;      // matches LUT_FRAG
      const elev = (theta * 180) / Math.PI;
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = half(buf[i]), g = half(buf[i + 1]), b = half(buf[i + 2]);
        const phi = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
        let d = phi - sunAz;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const ad = Math.abs(d) * 180 / Math.PI;
        const sector = ad < 45 ? 'solar' : ad > 135 ? 'anti' : 'cross';
        for (const [lo, hi] of bands) {
          if (elev >= lo && elev < hi) { add(`${lo}-${hi}`, sector, r, g, b, cosT); add(`${lo}-${hi}`, 'all', r, g, b, cosT); }
        }
        if (sinT > 0) {
          // dw = cos(theta) dtheta dphi, and the cosine-weighted projection adds
          // another sin(theta) for an up-facing normal.
          const solid = cosT * (Math.PI / H) * (2 * Math.PI / W);
          E[0] += r * sinT * solid; E[1] += g * sinT * solid; E[2] += b * sinT * solid;
        }
      }
    }
    const out = {};
    for (const k of Object.keys(acc)) {
      const [r, g, b, w] = acc[k];
      out[k] = [r / w, g / w, b / w];
    }
    return { preset: sky.presetName, bands: out, upIrradiance: E, audit: sky.audit() };
  }, ELEV_BANDS);
  r.time = t;
  results.push(r);

  console.log(`\n=== ${t.toUpperCase()}  (sky preset ${r.preset}) ===`);
  console.log(`  zenith ${r.audit.zenithNits} nits, horizon ${r.audit.horizonNits} nits, ` +
    `skyLux ${r.audit.skyLux}, midSkyExposed ${r.audit.midSkyExposed ?? '-'}, ` +
    `implausible ${JSON.stringify(r.audit.implausible)}`);
  console.log('  elev band     ALL  (R,G,B nits, chroma (R-B)/(R+B))      SOLAR chroma  CROSS chroma   ANTI chroma');
  for (const [lo, hi] of ELEV_BANDS) {
    const k = `${lo}-${hi}`;
    const a = r.bands[`${k}|all`];
    const ch = (v) => (v ? ((v[0] - v[2]) / Math.max(v[0] + v[2], 1e-9)) : NaN);
    const f = (n, w = 9) => String(+n.toPrecision(3)).padStart(w);
    console.log(`  ${k.padEnd(8)} ${f(a[0])}${f(a[1])}${f(a[2])}   ${ch(a).toFixed(3).padStart(7)}` +
      `        ${ch(r.bands[`${k}|solar`]).toFixed(3).padStart(7)}` +
      `       ${ch(r.bands[`${k}|cross`]).toFixed(3).padStart(7)}` +
      `       ${ch(r.bands[`${k}|anti`]).toFixed(3).padStart(7)}`);
  }
  const E = r.upIrradiance;
  console.log(`  up-facing irradiance from the dome (lux-ish, per channel): ` +
    `${E.map((v) => +v.toPrecision(4)).join(', ')}   chroma ${((E[0] - E[2]) / (E[0] + E[2])).toFixed(3)}`);
  console.log(`  sky generation: total ${r.audit.generationMs} ms  phases ${JSON.stringify(r.audit.generationMsByPhase)}`);
}

await browser.close();
const tag = process.env.SKY_HUE_TAG ?? 'lut';
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(`docs/sky-hue-${tag}.json`, JSON.stringify({ results, errors }, null, 1));
console.log(`\nwrote docs/sky-hue-${tag}.json` + (errors.length ? `  ERRORS: ${errors.join(' | ')}` : ''));
