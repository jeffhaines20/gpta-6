// IS THE "EDGE" A BOUNDARY OR IS IT NOISE?
//
// tools/prop-ground.mjs reports `edge`, the steepest 0.05 m step on the shadow
// side of a prop, as the answer to "no umbra edge". Narrowing the AO blur makes
// that number go up -- and an unfiltered SSAO buffer is NOISY, so a narrower
// blur would ALSO make it go up if the tool were measuring nothing but grain.
// Those two have to be told apart before an arm is chosen, or the round ships a
// sharpening that is really a dither.
//
// The discriminator is free and already in the JSON. The same ray runs out to
// 2.5 m across OPEN PAVING, 1.8-2.5 m from the prop, where no contact term of
// any kind reaches. Whatever step-to-step movement lives out there is grain plus
// scene texture and nothing else. So:
//
//   signal  the steepest step inside 1.2 m of the base   (prop-ground's `edge`)
//   grain   the MEAN |step| over 1.8-2.5 m of the same ray, same arm
//
// An arm that sharpens a real boundary raises signal and leaves grain alone. An
// arm that is only removing the blur raises both, together, in proportion.
//
//   node tools/prop-ground-noise.mjs docs/r6hero-fivepoints-noon.json
//   node tools/prop-ground-noise.mjs --selftest
import fs from 'node:fs';

/** Mean absolute step between consecutive samples whose distance is in [d0,d1].
 *  Nulls break the chain rather than being interpolated across. */
export function meanStep(vals, ds, d0, d1) {
  let s = 0, n = 0;
  for (let i = 1; i < vals.length; i++) {
    if (ds[i] < d0 || ds[i] > d1) continue;
    if (vals[i] === null || vals[i - 1] === null) continue;
    s += Math.abs(vals[i] - vals[i - 1]); n++;
  }
  return n ? s / n : null;
}

function selftest() {
  let fail = 0;
  const say = (name, ok, extra = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++;
  };
  const ds = []; for (let d = 0; d <= 2.5001; d += 0.05) ds.push(+d.toFixed(2));

  // KNOWN-BAD 1: a perfectly smooth ray must read 0 grain. If this reports
  // anything, every grain number below is an artefact of the reducer.
  say('smooth ray has zero grain', meanStep(ds.map(() => 100), ds, 1.8, 2.5) === 0);

  // KNOWN-BAD 2: a ramp is NOT noise. A steady slope of 2 per step must read 2,
  // not 0 and not something larger -- otherwise a shaded gradient across the
  // open band would be scored as grain and would mask a real one.
  const ramp = ds.map((d) => 100 + 40 * d);
  const g = meanStep(ramp, ds, 1.8, 2.5);
  say('a steady ramp reads its own slope', Math.abs(g - 2) < 1e-9, `got ${g}`);

  // KNOWN-GOOD: alternating +-10 grain reads 20 per step.
  const noisy = ds.map((d, i) => 100 + (i % 2 ? 10 : -10));
  say('alternating grain is detected', Math.abs(meanStep(noisy, ds, 1.8, 2.5) - 20) < 1e-9,
    `got ${meanStep(noisy, ds, 1.8, 2.5)}`);

  // KNOWN-BAD 3: the band must be respected. Grain confined to 0-1 m must not
  // show up in a 1.8-2.5 m read, or contact darkening would be counted as noise.
  const nearOnly = ds.map((d, i) => (d < 1.0 ? 100 + (i % 2 ? 30 : -30) : 100));
  say('grain outside the band is ignored', meanStep(nearOnly, ds, 1.8, 2.5) === 0,
    `got ${meanStep(nearOnly, ds, 1.8, 2.5)}`);

  // KNOWN-BAD 4: nulls must break the chain, not be silently bridged.
  say('a fully null band is null, not 0', meanStep(ds.map(() => null), ds, 1.8, 2.5) === null);

  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nselftest passed');
  process.exit(fail ? 1 : 0);
}
if (process.argv.includes('--selftest')) selftest();

for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const arms = Object.keys(j.results).filter((n) => j.results[n].rays && !j.results[n].error);
  const nsub = j.results[arms[0]].rays.length;
  console.log(`\n### ${f}`);
  for (let i = 0; i < nsub; i++) {
    const s0 = j.results[arms[0]].rays[i];
    if (!s0.resolved) continue;                 // unresolved props cannot support this
    console.log(`\n${s0.kind}@${s0.dist} m  (${s0.pxPerM} px/m)`);
    console.log('  arm'.padEnd(26) + 'signal'.padStart(9) + 'grain'.padStart(9) + 'signal/grain'.padStart(14));
    for (const n of arms) {
      const r = j.results[n].rays[i];
      const { ds, away } = r;
      let sig = 0;
      for (let k = 1; k < away.length; k++) {
        if (ds[k] > 1.2) break;
        if (away[k] === null || away[k - 1] === null) continue;
        sig = Math.max(sig, Math.abs(away[k] - away[k - 1]));
      }
      const gr = meanStep(away, ds, 1.8, 2.5);
      console.log('  ' + n.padEnd(24) + sig.toFixed(2).padStart(9)
        + (gr === null ? '-' : gr.toFixed(2)).padStart(9)
        + (gr ? (sig / gr).toFixed(2) : '-').padStart(14));
    }
  }
}
