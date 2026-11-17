// A CAR'S HEADLAMPS BY DAY, FROM THE FRONT, UNDER THE REAL LIGHT (#143). See tools/car-lamp.html.
//
//   node tools/car-lamp.mjs [--tod noon] [--cars traffic,parked,player] [--yaws front,back,side]
//                           [--views front,quarter] [--tone 0.80] [--ao 0|1] [--lamps 0|1]
//                           [--debug DIR] [--json FILE]
//   node tools/car-lamp.mjs --selftest     the measurement on synthetic frames with known answers, no browser
//
// Prints, per car, sun yaw and view, each headlamp's median against the same car's forward-facing paint
// beside and below it (the census's statistic, reference/sarasota/lamp-census.json) next to the
// reviewer's (a dark lamp pixel against the bonnet). --debug writes each frame and its mask as PNGs.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { measureLamps, CLASS, LIN } from './car-lamp-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_MAIN = !!process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split('/').pop());

export async function runPage(opts = {}) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const PORT = Number(opts.port ?? process.env.CAR_LAMP_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const keys = ['tod', 'cars', 'yaws', 'views', 'tone', 'dist', 'eye', 'ao', 'lamps', 'housing', 'w', 'h'];
    const qs = new URLSearchParams();
    for (const k of keys) if (opts[k] !== undefined && opts[k] !== null) qs.set(k, String(opts[k]));
    if (opts.debug) qs.set('debug', '1');
    await page.goto(`http://127.0.0.1:${PORT}/tools/car-lamp.html?${qs}`);
    await page.waitForFunction('window.__carLamp', null, { timeout: 900000 });
    const report = await page.evaluate(() => window.__carLamp);
    const frames = opts.debug ? await page.evaluate(() => window.__carLampFrames) : null;
    return { report, frames, errors };
  } finally {
    await browser.close();
  }
}


/**
 * THE SELFTEST: synthetic frames with known answers, through the SAME function the page runs. Each check
 * names the error it would catch, and the stride and the empty denominator are checked to THROW or to read
 * null, because a NaN here fails every comparison silently (CLAUDE.md, arm-diff).
 */
export function selftest() {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const W = 64, H = 48;
  const byteFor = (v) => { let b = 0; for (let i = 0; i < 256; i++) if (Math.abs(LIN[i] - v) < Math.abs(LIN[b] - v)) b = i; return b; };
  const frame = () => ({ rgb: new Uint8Array(W * H * 3), mask: new Uint8Array(W * H * 3) });
  const fill = (f, x0, y0, w, h, cls, v) => {
    const b = byteFor(v);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 3;
      f.mask[i] = cls; f.rgb[i] = f.rgb[i + 1] = f.rgb[i + 2] = b;
    }
  };
  // The base: a bonnet across the top, two 12 x 6 lamps at rows 12-17, forward paint from row 18 to 28.
  const base = (lampL = 0.2, lampR = 0.2, fascia = 0.4) => {
    const f = frame();
    fill(f, 2, 2, 60, 8, CLASS.bonnet, 0.6);
    fill(f, 2, 10, 60, 20, CLASS.fascia, fascia);
    fill(f, 8, 12, 12, 6, CLASS.head, lampL);
    fill(f, 44, 12, 12, 6, CLASS.head, lampR);
    return f;
  };
  const r0 = measureLamps(base().rgb, base().mask, W, H, 32);
  const want = LIN[byteFor(0.2)] / LIN[byteFor(0.4)];
  check('the census statistic reads the ratio the frame was built with',
    Math.abs(r0.lamps[0].overFascia - want) < 1e-12 && Math.abs(r0.lamps[1].overFascia - want) < 1e-12,
    `${r0.lamps[0].overFascia?.toFixed(6)} and ${r0.lamps[1].overFascia?.toFixed(6)} against ${want.toFixed(6)}`);
  check('only interior pixels: a 12 x 6 lamp reads its 10 x 4 inside', r0.lamps[0].n === 40 && r0.lamps[1].n === 40,
    `${r0.lamps[0].n} / ${r0.lamps[1].n}`);
  check('the bonnet is its own class, the reviewer\'s denominator', Math.abs(r0.bonnet.p50 - LIN[byteFor(0.6)]) < 1e-12,
    `${r0.bonnet.p50?.toFixed(4)}`);

  // An antialiased rim: the lamp's outermost ring carries the paint's colour while the mask says lamp. Read
  // as lamp it would lift the median; the interior rule must not see it.
  const fr = base();
  for (let x = 8; x < 20; x++) for (const y of [12, 17]) { const i = (y * W + x) * 3; fr.rgb[i] = fr.rgb[i + 1] = fr.rgb[i + 2] = 255; }
  for (let y = 12; y < 18; y++) for (const x of [8, 19]) { const i = (y * W + x) * 3; fr.rgb[i] = fr.rgb[i + 1] = fr.rgb[i + 2] = 255; }
  const rr = measureLamps(fr.rgb, fr.mask, W, H, 32);
  check('an edge carrying another surface\'s colour is not read as lamp', rr.lamps[0].p50 === r0.lamps[0].p50 && rr.lamps[0].p90 === r0.lamps[0].p90,
    `p90 ${rr.lamps[0].p90?.toFixed(4)} with a white rim against ${r0.lamps[0].p90?.toFixed(4)}`);

  // Paint far below the lamp, past one and a half of its height, is not the census's box. The known-bad half:
  // the same paint DOES move the whole-car fascia median, so the band reaches something and the box excludes it.
  const ff = base();
  fill(ff, 2, 30, 60, 16, CLASS.fascia, 0.9);
  const rf = measureLamps(ff.rgb, ff.mask, W, H, 32);
  check('paint past the census box does not reach the lamp\'s denominator, though the car\'s takes it in',
    rf.lamps[0].overFascia === r0.lamps[0].overFascia && rf.lamps[0].fascia.n === r0.lamps[0].fascia.n
      && rf.fasciaAll.n > r0.fasciaAll.n,
    `lamp/fascia ${rf.lamps[0].overFascia?.toFixed(4)} (was ${r0.lamps[0].overFascia?.toFixed(4)}) over ${rf.lamps[0].fascia.n} px, the car's paint ${r0.fasciaAll.n} -> ${rf.fasciaAll.n} px`);

  // Paint at the lamp's own tilt, beside it: read against the box, and paint at that tilt far off the
  // lamp's rows is not in it.
  const fs2 = base();
  fill(fs2, 21, 11, 10, 8, CLASS.nose, 0.25);     // beside the left lamp, in its rows
  fill(fs2, 2, 36, 60, 10, CLASS.nose, 0.9);      // the same class far below
  const rs2 = measureLamps(fs2.rgb, fs2.mask, W, H, 32);
  const wantB = LIN[byteFor(0.2)] / LIN[byteFor(0.25)];
  check('paint at the lamp\'s own tilt beside it is the second denominator, and its box is the lamp\'s rows',
    Math.abs(rs2.lamps[0].overBeside - wantB) < 1e-12 && rs2.lamps[1].beside.n === 0 && rs2.lamps[1].overBeside === null,
    `left ${rs2.lamps[0].overBeside?.toFixed(6)} against ${wantB.toFixed(6)} over ${rs2.lamps[0].beside.n} px; right ${rs2.lamps[1].beside.n} px`);

  // The two lamps apart, each against its own paint.
  const f2 = base(0.1, 0.3);
  const r2 = measureLamps(f2.rgb, f2.mask, W, H, 32);
  check('the two lamps are read apart', Math.abs(r2.lamps[0].p50 - LIN[byteFor(0.1)]) < 1e-12 && Math.abs(r2.lamps[1].p50 - LIN[byteFor(0.3)]) < 1e-12,
    `left ${r2.lamps[0].p50?.toFixed(4)}, right ${r2.lamps[1].p50?.toFixed(4)}`);

  // A lamp with no paint near it reads null, never Infinity or NaN.
  const fn = frame();
  fill(fn, 8, 12, 12, 6, CLASS.head, 0.2);
  const rn = measureLamps(fn.rgb, fn.mask, W, H, 32);
  check('a lamp with no forward paint near it reads null, not a number', rn.lamps[0].overFascia === null && rn.lamps[0].fascia.n === 0,
    `${rn.lamps[0].overFascia}`);

  // The stride: these frames are RGB, and an RGBA buffer must be refused rather than read misaligned.
  let threw = false;
  try { measureLamps(new Uint8Array(W * H * 4), new Uint8Array(W * H * 4), W, H, 32); } catch { threw = true; }
  check('a four-channel buffer is refused, not read with the wrong stride', threw);

  // The share over twice the median sees bright parts: a quarter of the lamp's inside at 3x.
  const fb = base();
  fill(fb, 9, 13, 10, 1, CLASS.head, 0.6);
  const rb = measureLamps(fb.rgb, fb.mask, W, H, 32);
  check('bright parts in a lamp are counted over twice its median', Math.abs(rb.lamps[0].over2x - 10 / 40) < 1e-12,
    `${(100 * rb.lamps[0].over2x).toFixed(1)}% against 25.0%`);

  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nCAR-LAMP SELFTEST: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` + (failed.length ? `, ${failed.length} failed` : ''));
  return failed.length;
}

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '  n/a');
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : '   n/a');

export function printReport(r) {
  console.log(`tod ${r.tod}  tone ${r.tone}  ao ${r.ao}  lampDetail ${r.lampDetail}  housing ${JSON.stringify(r.housing)}  sun elevation ${r.sun?.elevationDeg} deg  exposure ${r.light?.exposure}`);
  console.log(`lamp tilt off the buffers: ${JSON.stringify(r.lampTiltDeg)} degrees`);
  console.log('car      yaw    view     lamp    n     p05     p10     p50     p90  >2x   fascia p50   LAMP/FASCIA   beside p50   LAMP/BESIDE   bonnet p50   p10/bonnet  p50/bonnet');
  for (const run of r.runs) {
    for (const l of run.lamps) {
      if (!l.n) { console.log(`${run.car.padEnd(8)} ${run.yaw.padEnd(6)} ${run.view.padEnd(8)} ${l.side.padEnd(6)}  none`); continue; }
      const b = run.bonnet.p50;
      console.log(`${run.car.padEnd(8)} ${run.yaw.padEnd(6)} ${run.view.padEnd(8)} ${l.side.padEnd(6)} ${String(l.n).padStart(5)} ${f4(l.p05)} ${f4(l.p10)} ${f4(l.p50)} ${f4(l.p90)} ${(100 * l.over2x).toFixed(0).padStart(3)}%`
        + `   ${f4(l.fascia.p50)} (${String(l.fascia.n).padStart(4)})   ${f3(l.overFascia)}       ${f4(l.beside?.p50)} (${String(l.beside?.n ?? 0).padStart(4)})   ${f3(l.overBeside)}       ${f4(b)} (${String(run.bonnet.n).padStart(4)})   ${f3(b ? l.p10 / b : NaN)}      ${f3(b ? l.p50 / b : NaN)}`);
    }
  }
}

if (IS_MAIN && process.argv.includes('--selftest')) {
  process.exit(selftest() ? 1 : 0);
} else if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { console.error(`unexpected ${a}`); process.exit(2); }
    opt[a.slice(2)] = argv[i + 1];
    i++;
  }
  const known = new Set(['tod', 'cars', 'yaws', 'views', 'tone', 'dist', 'eye', 'ao', 'lamps', 'housing', 'w', 'h', 'debug', 'json', 'port']);
  for (const k of Object.keys(opt)) if (!known.has(k)) { console.error(`unknown flag --${k}`); process.exit(2); }
  const t0 = Date.now();
  const { report, frames, errors } = await runPage({ ...opt, debug: !!opt.debug });
  if (report.error) { console.error(report.error); process.exit(1); }
  if (errors.length) console.log('page errors:\n' + errors.join('\n'));
  printReport(report);
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(report, null, 1));
  if (frames && opt.debug) {
    const { writePNG } = await import('./crop.mjs');
    fs.mkdirSync(opt.debug, { recursive: true });
    const [W, H] = report.size;
    for (const [k, f] of Object.entries(frames)) {
      writePNG(path.join(opt.debug, `${k}.png`), W, H, Buffer.from(f.rgb, 'base64'));
      writePNG(path.join(opt.debug, `${k}-mask.png`), W, H, Buffer.from(f.mask, 'base64'));
    }
    console.log(`frames in ${opt.debug}`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
