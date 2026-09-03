// The light pool's ranking rule, measured on the bench in a few milliseconds.
//
// The browser harnesses (lamp-ab, lamp-hysteresis) measure what the rule does to
// a real district and cost tens of minutes of software rendering to do it. This
// measures the rule itself, which is pure geometry, and so can assert the things
// a comment would otherwise just claim:
//
//   - every rank is EXACTLY d or EXACTLY d + maxDistance, so an emitter that can
//     light something visible always outranks one that cannot, and there is no
//     third magnitude in between. This is what went wrong before: an incumbent
//     also got a swapMargin discount, which combined with the tier flip into a
//     138 rank-metre swing and let a lamp 50 m BEHIND the camera outrank every
//     visible lamp beyond 42 m.
//   - the hysteresis band is exactly swapMargin metres wide, and `held` changes
//     nothing else.
//
// Negative control included: with swapMargin at 0 the band must vanish. A bench
// that cannot read a zero is not measuring the margin.
import * as THREE from '../vendor/three.module.min.js';
import { LightPool } from '../src/lightpool.js';

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(48, 1440 / 810, 0.2, 1400);
cam.position.set(0, 5, 0);
cam.lookAt(0, 5, -100);                       // looking down -z
cam.updateMatrixWorld();

const MAXD = 130;
const pool = new LightPool(scene, { size: 10, maxDistance: MAXD });
pool.setView(cam);
const probe = { x: 0, y: 5, z: 0, candela: 900, color: 0xffc98a, distance: 46 };
const fail = [];

// --- where does a lamp directly behind the camera stop counting as in view? ---
const leaves = (held) => {
  for (let z = 0; z < MAXD; z += 0.01) {
    probe.x = 0; probe.z = z;
    if (pool._rank(probe, z, held) >= MAXD) return +z.toFixed(2);
  }
  return null;
};
const band = (margin) => {
  pool.swapMargin = margin;
  const challenger = leaves(false), incumbent = leaves(true);
  return { margin, challenger, incumbent, bandM: +(incumbent - challenger).toFixed(2) };
};
const b8 = band(8), b0 = band(0);
pool.swapMargin = 8;
console.log(`margin 8: leaves view at ${b8.challenger} m as a challenger, ${b8.incumbent} m as an incumbent` +
  `  ->  band ${b8.bandM} m`);
console.log(`margin 0: leaves view at ${b0.challenger} m as a challenger, ${b0.incumbent} m as an incumbent` +
  `  ->  band ${b0.bandM} m   (negative control: must be 0)`);
if (Math.abs(b8.bandM - 8) > 0.02) fail.push(`band at margin 8 is ${b8.bandM} m, expected 8`);
if (b0.bandM !== 0) fail.push(`band at margin 0 is ${b0.bandM} m, expected 0 - the bench cannot read a zero`);

// --- no rank may land between the two tiers, held or not ---------------------
let checked = 0, offGrid = 0, tierFlips = 0, worstInView = 0, bestOutOfView = Infinity;
for (let z = -(MAXD - 1); z <= MAXD - 1; z += 0.31) {
  for (let x = -120; x <= 120; x += 3.7) {
    const d = Math.hypot(x, z);
    if (d >= MAXD) continue;
    probe.x = x; probe.z = z;
    const unheld = pool._rank(probe, d, false), heldR = pool._rank(probe, d, true);
    checked++;
    for (const r of [unheld, heldR]) {
      if (Math.abs(r - d) > 1e-9 && Math.abs(r - (d + MAXD)) > 1e-9) offGrid++;
      if (r < MAXD) worstInView = Math.max(worstInView, r);
      else bestOutOfView = Math.min(bestOutOfView, r);
    }
    if (unheld !== heldR) tierFlips++;
  }
}
console.log(`\n${checked} emitter positions:`);
console.log(`  ranks that are neither d nor d + maxDistance: ${offGrid}   (must be 0)`);
console.log(`  worst in-view rank ${worstInView.toFixed(3)} vs best out-of-view rank ${bestOutOfView.toFixed(3)}` +
  `   (in-view must always win)`);
console.log(`  positions where holding a slot changes the answer: ${tierFlips}` +
  '   - every one of them a tier flip inside the band');
if (offGrid) fail.push(`${offGrid} ranks landed off the two-tier grid`);
if (worstInView >= bestOutOfView) fail.push('an out-of-view emitter can outrank an in-view one');

console.log(fail.length ? `\nRANK BENCH: FAIL\n  ${fail.join('\n  ')}` : '\nRANK BENCH: PASS');
process.exit(fail.length ? 1 : 0);
