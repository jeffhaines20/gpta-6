// WHICH TERM MAKES THE SKY THE COLOUR IT IS?
//
// A blind review measured golden hour's sky as "a noon sky with the exposure
// lifted": zenith 162,189,211, horizon 228,231,231, and across 225,000 px of it
// the warmest single pixel at R-B +10 against dusk's +71. src/sky.js's scatter()
// has four additive terms and any of them could be responsible, so guessing costs
// a round. This switches them off one at a time and re-reads the dome's own
// integrals - the same ones the PMREM is built from and the same ones the
// plausibility gate judges - so the answer is a number per term rather than an
// argument about the shader.
//
// It runs against labs/sky, not the district: the quantity being measured is the
// LUT and its probe read-back, both of which are the same object in either page,
// and labs/sky loads in a second where the district takes a minute of streaming.
//
//   node tools/sky-terms.mjs                    all four hours, every arm
//   SKYT_PORT=8133 SKYT_TIMES=golden node tools/sky-terms.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const TIMES = (process.env.SKYT_TIMES ?? 'noon,golden,dusk,night').split(',').map((s) => s.trim());
const PORT = Number(process.env.SKYT_PORT ?? 8133);
const TAG = process.env.SKYT_TAG ?? 'skyterms';
if (PORT === 8123) throw new Error('SKYT_PORT 8123 belongs to the main tree; pick another');

// Each arm is a set of writes onto the live Sky before refresh({force:true}).
// `null` restores the shipped values, which are captured on the first arm.
const ARMS = {
  base:    {},
  // Multiple scattering off entirely. Whatever is left is single Rayleigh + Mie.
  noMS:    { msBoost: [0, 0] },
  // Rayleigh MS only / Mie MS only, because the two carry different spectra:
  // uBetaR is 5.7:1 blue-over-red and uBetaM is grey.
  msRayOnly: { msBoost: [0.115, 0] },
  msMieOnly: { msBoost: [0, 0.030] },
  // The MS tint swing off, so what is left of the MS colour is beta * transport.
  noTint:  { msAniso: 0, flatTint: true },
  // The whitening sweep. uMsBetaR mixes uBetaR toward its own luminance, so every
  // row here must report the SAME skyLux, zenithNits and horizonNits as `base`
  // to the digit; anything else means the mix is not luminance-preserving and the
  // change is moving photometry it has no business moving.
  whiten00: { msWhiten: 0 },
  whiten40: { msWhiten: 0.4 },
  whiten70: { msWhiten: 0.7 },
  whiten85: { msWhiten: 0.85 },
  whiten100: { msWhiten: 1.0 },
  // THE DIRECTIONAL SCOPE of that whitening: how much of it survives at the
  // anti-solar point. anti100 is the isotropic behaviour it shipped with, so it
  // must reproduce `whiten85` row for row - that equality is the proof the new
  // uniform is wired to the right place and does nothing at its old value. Same
  // luminance assertion as the whiten arms: the rescale is per texel, so the
  // beta this hands it cannot move photometry.
  anti100: { msWhitenAnti: 1.0 },
  anti50:  { msWhitenAnti: 0.5 },
  anti25:  { msWhitenAnti: 0.25 },
  anti00:  { msWhitenAnti: 0.0 },
};

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/labs/sky/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__lab && window.__lab.ready', null, { timeout: 90000 });

const rows = [];
for (const tod of TIMES) {
  for (const [arm, cfg] of Object.entries(ARMS)) {
    const r = await page.evaluate(async ({ tod: t, cfg: c }) => {
      const sky = __lab.sky;
      __lab.setTime(t);
      // Restore the shipped values every arm, so arms cannot accumulate.
      if (!window.__shipped) {
        window.__shipped = { msBoost: [sky.msBoost.x, sky.msBoost.y], msAniso: sky.msAniso,
                             msWhiten: sky.msWhiten, msWhitenAnti: sky.msWhitenAnti };
      }
      sky.msBoost.set(window.__shipped.msBoost[0], window.__shipped.msBoost[1]);
      sky.msAniso = window.__shipped.msAniso;
      sky.msWhiten = window.__shipped.msWhiten;
      sky.msWhitenAnti = window.__shipped.msWhitenAnti;
      if (c.msBoost) sky.msBoost.set(c.msBoost[0], c.msBoost[1]);
      if (c.msAniso !== undefined) sky.msAniso = c.msAniso;
      if (c.msWhiten !== undefined) sky.msWhiten = c.msWhiten;
      if (c.msWhitenAnti !== undefined) sky.msWhitenAnti = c.msWhitenAnti;
      // The tint arm flattens uMsWarm/uMsCool, which _pushUniforms rewrites on
      // every refresh. Wrapping _pushUniforms rather than writing after it is
      // what makes the flattening survive the refresh that renders the LUT - and
      // it needs no measurement-only option in the shipped file.
      const origPush = sky._pushUniforms;
      if (c.flatTint) {
        sky._pushUniforms = function patched() {
          origPush.call(this);
          this._uniforms.uMsWarm.value.set(1, 1, 1);
          this._uniforms.uMsCool.value.set(1, 1, 1);
        };
      }
      // environment:false - the PMREM is 108-181 ms and nothing here reads it.
      sky.refresh({ force: true, environment: false });
      sky._pushUniforms = origPush;
      const a = sky.audit();
      // Per-channel integrals off the SAME probe read-back the audit uses, so the
      // chroma scalars below have their RGB shown next to them rather than being
      // taken on trust.
      const W = sky.probeWidth, H = sky.probeHeight, rgb = sky._probeRGB;
      const up = [0, 0, 0], down = [0, 0, 0];
      const dPhi = (Math.PI * 2) / W, dTheta = Math.PI / H;
      for (let y = 0; y < H; y++) {
        const theta = ((y + 0.5) / H - 0.5) * Math.PI;
        const w = Math.sin(Math.abs(theta)) * Math.cos(theta) * dTheta * dPhi;
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const t2 = y >= (H >> 1) ? up : down;
          for (let k = 0; k < 3; k++) t2[k] += rgb[i + k] * Math.abs(w);
        }
      }
      const rb = (c2) => +((c2[0] - c2[2]) / Math.max(c2[0] + c2[2], 1e-9)).toFixed(3);
      return {
        skyLux: +a.skyLux.toFixed(0),
        zenithNits: +a.zenithNits.toFixed(1), horizonNits: +a.horizonNits.toFixed(1),
        zenithChroma: a.zenithChroma, horizonChroma: a.horizonChroma, ambientChroma: a.ambientChroma,
        upRGB: up.map((v) => +v.toFixed(0)), upChroma: rb(up),
        downRGB: down.map((v) => +v.toFixed(0)), downChroma: rb(down),
        groundBounce: a.groundBounce,
        msAniso: a.msAniso, msWhiten: a.msWhiten,
        implausible: a.implausible,
      };
    }, { tod, cfg });
    rows.push({ tod, arm, ...r });
    console.log(`${tod.padEnd(7)} ${arm.padEnd(10)} skyLux ${String(r.skyLux).padStart(6)}  ` +
      `zen ${String(r.zenithNits).padStart(7)} (${r.zenithChroma})  hor ${String(r.horizonNits).padStart(7)} (${r.horizonChroma})  ` +
      `ambient chroma ${r.ambientChroma}  up ${r.upRGB.join('/')}`);
  }
}
// THE LUMINANCE-PRESERVATION ASSERTION. The whitening arms may only move hue, so
// every whiten row must reproduce base's photometry exactly. A tool that reports
// a hue sweep without checking this is how a "purely chromatic" change ships
// having quietly re-lit the district.
const drift = [];
for (const tod of TIMES) {
  const base = rows.find((r) => r.tod === tod && r.arm === 'base');
  // The `anti` arms are held to the same bar as the `whiten` ones: the rescale in
  // scatter() is per texel, so scoping the whitening by DIRECTION is no more
  // allowed to move photometry than scoping it by elevation was.
  for (const r of rows.filter((x) => x.tod === tod && (x.arm.startsWith('whiten') || x.arm.startsWith('anti')))) {
    for (const k of ['skyLux', 'zenithNits', 'horizonNits']) {
      const rel = Math.abs(r[k] - base[k]) / Math.max(1e-9, Math.abs(base[k]));
      if (rel > 0.002) drift.push(`${tod}/${r.arm}: ${k} ${r[k]} vs base ${base[k]} (${(rel * 100).toFixed(2)}%)`);
    }
    if (r.msWhiten && r.msWhiten.luminanceError > 1e-6) {
      drift.push(`${tod}/${r.arm}: uMsBetaR luminance error ${r.msWhiten.luminanceError}`);
    }
  }
}
console.log(drift.length
  ? `\nLUMINANCE DRIFT (the whitening is NOT purely chromatic):\n  ${drift.join('\n  ')}`
  : '\nLUMINANCE HELD: every whitening arm reproduces base skyLux/zenith/horizon within 0.2%.');
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(`docs/${TAG}.json`, JSON.stringify({ rows, drift, errors }, null, 1));
console.log(`\nwrote docs/${TAG}.json`);
if (errors.length) console.error('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
