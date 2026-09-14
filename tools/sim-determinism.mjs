// Are two runs of the simulation, from the same seed, the same world?
//
// This is the gate for the change that seeded src/traffic.js and
// src/pedestrians.js. Twenty-three unseeded Math.random() draws across those two
// files meant two page loads of ONE BUILD spawned different cars on different
// edges in different colours, with different people walking. Every populated A/B
// on this project was therefore comparing two different worlds: arms captured at
// the IDENTICAL frame number differed on 5.01% of pixels at noon, 27,745 of them
// brighter in the arm carrying strictly LESS emissive.
//
// No browser: the spawn and appearance paths are arithmetic over the district
// graph, so they can be stepped headlessly and compared exactly.
//
//   node tools/sim-determinism.mjs
//   node tools/sim-determinism.mjs --selftest
import fs from 'node:fs';

// Same no-op 2D context the other offline tools install, and for the same
// reason: signage/facade atlases paint at import and no position depends on a
// pixel.
if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1, height: 1 };
      return (t[k] = (...a) => {
        if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
        if (/^create(Linear|Radial|Conic)Gradient$|^createPattern$/.test(k)) return grad;
        if (k === 'getImageData') {
          const w = (a[2] | 0) || 1, h = (a[3] | 0) || 1;
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        return undefined;
      });
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }),
  };
}

const { rng, hash32 } = await import('../src/facades.js');

const args = process.argv.slice(2);

/**
 * Draw `n` values the way the sim does, from a seeded stream.
 * The point of the tool is the COMPARISON, so the generator is what is checked.
 */
function draws(seed, n) {
  const r = rng(hash32('traffic', seed));
  const out = [];
  for (let i = 0; i < n; i++) out.push(r());
  return out;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

if (args.includes('--selftest')) {
  let bad = 0;
  const say = (ok, w) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${w}`); };

  // 1. The generator is deterministic in its seed, and different seeds differ.
  say(same(draws(1, 64), draws(1, 64)), 'same seed -> identical 64-draw sequence');
  say(!same(draws(1, 64), draws(2, 64)), 'different seed -> different sequence');

  // 2. KNOWN-BAD INPUT. This is the check that would have caught the defect:
  //    a sequence built from Math.random() must NOT reproduce, and a test that
  //    passes for both is not testing anything.
  const mr = () => Array.from({ length: 64 }, () => Math.random());
  say(!same(mr(), mr()), 'Math.random() does NOT reproduce (the defect, reproduced)');

  // 3. The stream is not degenerate — a generator stuck on one value would pass
  //    check 1 perfectly while destroying the variety the sim needs.
  const d = draws(7, 4096);
  const uniq = new Set(d).size;
  say(uniq > 4000, `stream is not degenerate: ${uniq} distinct of 4096`);
  const mean = d.reduce((a, v) => a + v, 0) / d.length;
  say(Math.abs(mean - 0.5) < 0.02, `mean ${mean.toFixed(4)} is near 0.5`);
  say(Math.min(...d) >= 0 && Math.max(...d) < 1, 'every draw is in [0,1)');

  console.log(bad ? `\n${bad} SELFTEST FAILURE(S)` : '\nselftest ok');
  process.exit(bad ? 1 : 0);
}

// --------------------------------------------------------------- the real gate
// No unseeded draw may remain in either simulation file. This is a source check
// on purpose: it cannot be defeated by a run that happens to agree, and it is
// the thing that regresses -- one new Math.random() added later silently
// un-registers every future A/B, and nothing else would notice.
const files = ['src/traffic.js', 'src/pedestrians.js'];
let leaks = 0;
for (const f of files) {
  const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (/Math\.random\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hits.push(i + 1);
  });
  console.log(`${f.padEnd(22)} unseeded draws: ${hits.length}` +
    (hits.length ? `  at lines ${hits.join(', ')}` : ''));
  leaks += hits.length;
}
const seeded = files.map((f) =>
  /this\._r = rng\(hash32\(/.test(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')));
console.log(`seeded stream present: ${files.map((f, i) => `${f.split('/')[1]} ${seeded[i] ? 'yes' : 'NO'}`).join(', ')}`);

if (leaks || seeded.some((v) => !v)) {
  console.error(`\nSIM-DETERMINISM: FAIL — ${leaks} unseeded draw(s); a populated A/B cannot be registered`);
  process.exit(1);
}
console.log('\nSIM-DETERMINISM: PASS — both simulations draw from a seeded stream');
