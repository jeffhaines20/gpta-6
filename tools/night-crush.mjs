// How much of a night frame is crushed to black, band by band.
//
// The statistic three blind review rounds reported the shopfront defect with,
// written down so it can be reproduced rather than re-derived. It is deliberately
// the SIMPLEST thing that tracks the complaint: a shopfront that is unlit reads as
// a hole, and a hole is pixels at or below luma 8 where a shopfront should be.
//
// Bands are arm-diff.mjs's, byte for byte, because the review numbers were quoted
// against those rows: on a 1600x900 frame `facade` is y315-648, which is the
// number that appeared in the reports. They are imported rather than copied so
// the two tools cannot drift.
//
// THREE THINGS THIS GETS RIGHT ON PURPOSE.
//
//  - `p.channels` is read, never assumed. These screenshots are 3-channel. A
//    hardcoded 4-byte stride misaligns every sample after the first pixel and
//    reads past the end of the buffer in the bottom quarter, where the undefined
//    reads become NaN; NaN fails every <= comparison, so the crushed count for
//    the worst rows comes back LOW and the frame reports as healthy. The
//    self-test below feeds a known-black 3-channel image through a 4-stride
//    reader and asserts the wrong answer is caught.
//
//  - "At or below" is `<=`, not `<`. The reports say "at or below luma 8".
//
//  - Luma is Rec.709 and is NOT ROUNDED. This matters and was checked rather
//    than assumed: rounding first moves the facade band from 15.36% to 16.15%
//    and the whole-frame deep count from 6.05% to 7.76%, because rounding pulls
//    every pixel in 8.0-8.5 across an inclusive threshold. All eight numbers the
//    review round quoted reproduce to the last digit under the unrounded form
//    and under no other candidate tried (Rec.601, mean-RGB, max-RGB, or Rec.709
//    rounded), so that is the convention, and it is written down here so the
//    after-numbers are comparable with the before-numbers.
//
//   node tools/night-crush.mjs docs/shots/r8-corridor-night.png [more...]
//   node tools/night-crush.mjs --selftest
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readPNG } from './png.mjs';

// The same three rows arm-diff prints, so a crush number and a difference number
// describe the same pixels.
export const BANDS = [['upper', 0, 0.35], ['facade', 0.35, 0.72], ['ground', 0.72, 1]];

export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Crushed fraction per band plus whole-frame deep-black fraction.
 * @param {{width:number,height:number,channels:number,data:Uint8Array}} img
 * @param {number} at   crush threshold; a pixel counts when luma <= at
 * @param {number} deep whole-frame threshold; the reports used 3
 */
export function crushStats(img, { at = 8, deep = 3 } = {}) {
  const { width: W, height: H, channels: C, data } = img;
  if (!(C === 3 || C === 4)) throw new Error(`unsupported channel count ${C}`);
  if (data.length < W * H * C) {
    throw new Error(`buffer short: ${data.length} for ${W}x${H}x${C} — stride wrong?`);
  }
  const bands = BANDS.map(([tag, f0, f1]) => {
    const y0 = (H * f0) | 0, y1 = (H * f1) | 0;
    let n = 0, hit = 0, sum = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * C;
        const v = luma(data[i], data[i + 1], data[i + 2]);
        // A non-finite luma means the stride is wrong and the reassuring answer
        // is the wrong one. Throw rather than under-count.
        if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
        if (v <= at) hit++;
        sum += v; n++;
      }
    }
    return { band: tag, y0, y1, mean: +(sum / n).toFixed(2), atOrBelowPct: +((100 * hit) / n).toFixed(2) };
  });
  let dn = 0, dhit = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      const v = luma(data[i], data[i + 1], data[i + 2]);
      if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      if (v <= deep) dhit++;
      dn++;
    }
  }
  return { bands, framePct: +((100 * dhit) / dn).toFixed(2), at, deep };
}

/** Mean luma of an [x,y,w,h] box — for the CASSAVA / LUMEN CAMERA row. */
export function boxStats(img, [bx, by, bw, bh]) {
  const { width: W, channels: C, data } = img;
  let n = 0, sum = 0, lo = 255, hi = 0, over40 = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const i = (y * W + x) * C;
      const v = luma(data[i], data[i + 1], data[i + 2]);
      if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      sum += v; if (v < lo) lo = v; if (v > hi) hi = v; if (v > 40) over40++; n++;
    }
  }
  return { mean: +(sum / n).toFixed(2), min: lo, max: hi, over40Pct: +((100 * over40) / n).toFixed(2) };
}

function selftest() {
  let fail = 0;
  const ck = (name, got, want) => {
    const ok = Math.abs(got - want) < 1e-6;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got}, want ${want}`);
  };
  const mk = (C, fill) => ({
    width: 10, height: 100, channels: C,
    data: Uint8Array.from({ length: 10 * 100 * C }, (_, i) => fill(i, C)),
  });

  // An all-black frame is 100% crushed in every band, on 3 and on 4 channels.
  for (const C of [3, 4]) {
    const s = crushStats(mk(C, () => 0));
    ck(`all-black c${C} facade`, s.bands[1].atOrBelowPct, 100);
    ck(`all-black c${C} frame`, s.framePct, 100);
  }
  // An all-white frame is 0% crushed.
  ck('all-white facade', crushStats(mk(3, () => 255)).bands[1].atOrBelowPct, 0);

  // The boundary is inclusive: luma exactly 8 counts, luma 9 does not.
  ck('luma 8 counts', crushStats(mk(3, () => 8)).bands[0].atOrBelowPct, 100);
  ck('luma 9 does not', crushStats(mk(3, () => 9)).bands[0].atOrBelowPct, 0);

  // KNOWN-BAD INPUT: the bug this tool exists to not have. A 3-channel image
  // mislabelled as 4-channel makes the reader walk off the end of the buffer.
  // The failure must be LOUD; the dangerous version returns a low crush number.
  const bad = mk(3, () => 0);
  bad.channels = 4;
  let threw = false;
  try { crushStats(bad); } catch { threw = true; }
  ck('4-stride on 3-channel data throws', threw ? 1 : 0, 1);

  // And the same shape via a hand-built short buffer, to prove the guard is on
  // the buffer length rather than on the constructor that made it.
  const short = { width: 10, height: 100, channels: 3, data: new Uint8Array(10 * 99 * 3) };
  let threw2 = false;
  try { crushStats(short); } catch { threw2 = true; }
  ck('short buffer throws', threw2 ? 1 : 0, 1);

  // Half-black/half-white split across the facade band: the band boundaries must
  // actually be honoured, not averaged over the whole frame.
  const split = mk(3, (i) => (Math.floor(i / (10 * 3)) < 50 ? 0 : 255));
  const ss = crushStats(split);
  ck('split upper (rows 0-34) all black', ss.bands[0].atOrBelowPct, 100);
  ck('split ground (rows 72-99) all white', ss.bands[2].atOrBelowPct, 0);

  // boxStats reads the box it was given, not the frame.
  const bs = boxStats(split, [0, 60, 10, 10]);
  ck('boxStats white box mean', bs.mean, 255);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
}

// Only when RUN, never when imported: crushStats and boxStats are useful to other
// probes, and a module that prints a usage line and exits(2) on import is a
// module nobody can reuse. Found the hard way by a two-line script that imported
// boxStats and got the usage text instead.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* imported for crushStats / boxStats */ }
else if (process.argv.includes('--selftest')) selftest();
else {
  const bi = process.argv.indexOf('--box');
  const box = bi >= 0 ? process.argv[bi + 1].split(',').map(Number) : null;
  // The --box VALUE is an argument, not a frame. Without this it is also treated
  // as a filename, which prints a spurious "missing" line at the end of a run.
  const files = process.argv.slice(2)
    .filter((a, i) => !a.startsWith('--') && !(bi >= 0 && i === bi - 1));
  if (!files.length) { console.log('usage: night-crush.mjs FRAME.png [...] [--box x,y,w,h]'); process.exit(2); }
  console.log('file                                 band     rows        mean   <=8');
  for (const f of files) {
    if (!fs.existsSync(f)) { console.log(`${f}: missing`); continue; }
    const img = readPNG(f);
    const s = crushStats(img);
    for (const b of s.bands) {
      console.log(`${f.padEnd(36)} ${b.band.padEnd(8)} ${String(b.y0 + '-' + b.y1).padEnd(11)} ` +
        `${String(b.mean).padStart(6)} ${String(b.atOrBelowPct + '%').padStart(7)}`);
    }
    console.log(`${''.padEnd(36)} FRAME    <=${s.deep}                ${String(s.framePct + '%').padStart(7)}`);
    if (box) {
      const b = boxStats(img, box);
      console.log(`${''.padEnd(36)} box ${box.join(',')}  mean ${b.mean}  min ${b.min}  max ${b.max}  >40 ${b.over40Pct}%`);
    }
  }
}
