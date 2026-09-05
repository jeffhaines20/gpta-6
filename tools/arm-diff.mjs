// Band-by-band difference between two captures of the same camera.
//
// The question this answers is "did the change reach the frame at all", which
// is not the same as "is the frame better" and is worth asking first. A blind
// review round in this session spent four hours judging a pair that turned out
// to be the same build twice; the pair could have been disqualified in seconds.
//
// Reads p.channels rather than assuming RGBA. Playwright writes 3-channel PNGs
// for opaque screenshots, and a probe that hardcodes a 4-byte stride misaligns
// every sample past the first pixel and runs off the end of the buffer in the
// bottom quarter. The undefined reads become NaN, NaN fails every > comparison
// silently, and the affected bands report "no difference" -- which is the single
// most dangerous way for a measurement tool to be wrong, because the wrong
// answer is the reassuring one. That is exactly what happened to the first
// version of this, and the numbers it produced were quoted before being caught.
//
//   node tools/arm-diff.mjs A.png B.png [more pairs...]
//   node tools/arm-diff.mjs --selftest
import { readPNG } from './png.mjs';

const BANDS = [['upper', 0, 0.35], ['facade', 0.35, 0.72], ['ground', 0.72, 1]];

export function diffBands(A, B) {
  if (A.width !== B.width || A.height !== B.height) throw new Error('size mismatch');
  if (A.channels !== B.channels) throw new Error('channel mismatch');
  const W = A.width, H = A.height, C = A.channels;
  return BANDS.map(([tag, f0, f1]) => {
    const y0 = (H * f0) | 0, y1 = (H * f1) | 0;
    let n = 0, sum = 0, max = 0, over4 = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(A.data[i + c] - B.data[i + c]);
        // A non-finite difference means the stride is wrong. Throwing is the
        // whole point: the failure this tool exists to avoid is a silent zero.
        if (!Number.isFinite(d)) throw new Error(`non-finite difference at ${x},${y},${c} — stride wrong?`);
        sum += d; if (d > max) max = d; if (d > 4) over4++; n++;
      }
    }
    return { band: tag, mean: +(sum / n).toFixed(3), max, over4Pct: +(100 * over4 / n).toFixed(2) };
  });
}

function selftest() {
  const mk = (C, fill) => ({
    width: 8, height: 8, channels: C,
    data: Uint8Array.from({ length: 8 * 8 * C }, (_, i) => fill(i)),
  });
  let fail = 0;
  // Identical inputs must read exactly zero, on 3 and on 4 channels alike.
  for (const C of [3, 4]) {
    const a = mk(C, (i) => i % 251);
    const r = diffBands(a, mk(C, (i) => i % 251));
    const ok = r.every((b) => b.mean === 0 && b.max === 0 && b.over4Pct === 0);
    console.log(`  ${C}ch identical      : ${ok ? 'zero everywhere' : 'NONZERO — wrong'}`);
    if (!ok) fail++;
  }
  // A known constant offset must be reported as that offset, not as zero. A
  // 3-channel pair read with a 4-byte stride would report neither.
  const a = mk(3, () => 100), b = mk(3, () => 110);
  const r = diffBands(a, b);
  const ok = r.every((x) => x.mean === 10 && x.max === 10 && x.over4Pct === 100);
  console.log(`  3ch +10 offset     : ${ok ? 'mean 10, 100% over 4' : 'WRONG — ' + JSON.stringify(r)}`);
  if (!ok) fail++;
  // Mismatched channel counts must throw rather than silently compare.
  let threw = false;
  try { diffBands(mk(3, () => 1), mk(4, () => 1)); } catch { threw = true; }
  console.log(`  channel mismatch   : ${threw ? 'throws' : 'SILENTLY COMPARED — wrong'}`);
  if (!threw) fail++;
  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) process.exit(selftest() ? 1 : 0);
for (let i = 0; i + 1 < args.length; i += 2) {
  const rows = diffBands(readPNG(args[i]), readPNG(args[i + 1]));
  console.log(`${args[i].split('/').pop()} vs ${args[i + 1].split('/').pop()}`);
  for (const r of rows) {
    console.log(`  ${r.band.padEnd(7)} mean ${String(r.mean).padStart(7)}   max ${String(r.max).padStart(3)}   >4 ${String(r.over4Pct).padStart(6)}%`);
  }
}
