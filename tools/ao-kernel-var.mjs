// WHY THE SSAO ESTIMATOR IS NOISY, WORKED OUT WITHOUT A BROWSER.
//
// tools/ao-noise.mjs --live measures the grain in the shipped build; it cannot
// say which part of the kernel produces it. This file holds the geometry fixed,
// holds the occluder fixed, and sweeps ONLY the per-pixel rotation angle -- the
// one thing that actually differs between two adjacent pixels in AO_FRAG. What
// comes back is how much of the estimator's answer is the surface and how much
// is which angle the hash happened to hand that pixel.
//
// The test case is a 90-degree concave corner, whose true occlusion over a
// uniform hemisphere is exactly 0.5, at a range of surface tilts -- 0 degrees is
// a wall square to the camera, 80 degrees is pavement seen from standing height.
//
//   node tools/ao-kernel-var.mjs
//   node tools/ao-kernel-var.mjs --selftest
//
// RESULT, and it is the root cause of both halves of the r8 defect:
//
//   tilt   kernel             mean     sd across rotation
//     0    legacy 12         0.5000   0.0833
//    15    legacy 12         0.4198   0.0662
//    35    legacy 12         0.4476   0.0905
//    60    legacy 12         0.4519   0.0841
//    80    legacy 12         0.4084   0.0900
//     *    spiral 12         0.5000   0.0573
//     *    spiral 32         0.5000   0.0202
//
// TWO SEPARATE FAULTS, and each explains one of the two complaints.
//
// THE BIAS. The legacy kernel reads a corner as 0.41 to 0.45 occluded when it is
// 0.50 occluded, and by how much depends on WHICH WAY THE SURFACE FACES -- the
// same corner reads 0.4198 on a wall and 0.4084 on pavement. An estimator that
// under-reports by 10-18% needs its contrast bought back somewhere, and the
// exponent is where it was bought: pow(ao, 8.5). That exponent is the darkness.
//
// THE VARIANCE. Rotating the kernel moves its answer by 0.066 to 0.090, which is
// 0.8 to 1.1 of a whole sample quantum -- the estimate swings by a full sample
// from one pixel to the next for no reason but the hash. Multiply that by the
// exponent's slope and it is the dither. The spiral is unbiased at every tilt
// and swings 0.0202 at 32 samples, 4.5x less.
//
// The fold is why. The legacy set is twelve vectors in an arbitrary space turned
// about the VIEW axis and then reflected onto whichever side of the surface they
// land on; the reflection is a discontinuous function of the rotation, so the set
// a pixel actually gets jumps rather than turns, and it jumps hardest where the
// normal is oblique -- which is every junction in the frame. Measured in the
// build, straight out of the kernel: the flat pier face carries 0.91 of 255 of
// grain and the junction band beside it carries 27.2.
//
// WHAT THIS FILE CANNOT SETTLE: a half-space occluder is insensitive to sample
// LENGTH, so kernel 1 and kernel 2 are identical here by construction. Only the
// live sweep can separate those two.
// How much does each kernel's answer depend on the per-pixel rotation alone?
// Geometry fixed, occluder fixed, only the rotation angle varies -- which is
// exactly what changes from one pixel to the next in the shipped shader.
const LEG = [
  [0.5381, 0.1856, 0.4319], [0.1379, 0.2486, 0.4430], [0.3371, 0.5679, 0.0057],
  [-0.6999, -0.0451, 0.0019], [0.0689, -0.1598, 0.8547], [0.0560, 0.0069, 0.1843],
  [-0.0146, 0.1402, 0.0762], [0.0100, -0.1924, 0.0344], [-0.3577, -0.5301, 0.4358],
  [-0.3169, 0.1063, 0.0158], [0.0103, -0.5869, 0.0046], [-0.0897, -0.4940, 0.3287],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const L = Math.hypot(...a); return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A concave corner: the surface has normal n, and a wall stands on it whose
// inward normal is w. A sample is occluded when it is on the far side of that
// wall, i.e. dot(sample, w) < 0, at any length.
function occLegacy(n, w, theta) {
  const ca = Math.cos(theta), sa = Math.sin(theta);
  let hit = 0;
  for (const k of LEG) {
    let rk = [k[0] * ca - k[1] * sa, k[0] * sa + k[1] * ca, k[2]];
    if (dot(rk, n) < 0) rk = [-rk[0], -rk[1], -rk[2]];
    if (dot(rk, w) < 0) hit++;
  }
  return hit / LEG.length;
}
// `uniform` switches the elevation from a COSINE hemisphere (z = sqrt(1-u),
// disk radius sqrt(u)) to one UNIFORM IN SOLID ANGLE (z = 1-u, disk radius
// sqrt(u(2-u))). That is src/post.js aoKernel 3, and it exists because the
// round that measured the cosine spiral halving the window reveal named this
// variant as the thing to try next and did not try it: a cosine hemisphere
// weights toward the normal, and a reveal's occluders are at grazing angles.
function occSpiral(n, w, theta, N, decor, uniform) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t = norm(cross(up, n)), b = cross(n, t);
  const ca = Math.cos(theta), sa = Math.sin(theta);
  const t2 = [t[0] * ca + b[0] * sa, t[1] * ca + b[1] * sa, t[2] * ca + b[2] * sa];
  const b2 = [-t[0] * sa + b[0] * ca, -t[1] * sa + b[1] * ca, -t[2] * sa + b[2] * ca];
  let hit = 0;
  for (let i = 0; i < N; i++) {
    const fi = i + 0.5, u = fi / N, ang = fi * 2.39996323;
    const rr = uniform ? Math.sqrt(Math.max(0, u * (2 - u))) : Math.sqrt(u);
    const z = uniform ? 1 - u : Math.sqrt(Math.max(0, 1 - u));
    const len = 0.12 + (1 - 0.12) * (decor ? (fi * 0.6180339887) % 1 : u);
    const v = [0, 1, 2].map((j) => (t2[j] * Math.cos(ang) * rr + b2[j] * Math.sin(ang) * rr + n[j] * z) * len);
    if (dot(v, w) < 0) hit++;
  }
  return hit / N;
}
const stats = (a) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return { mean: m, sd: Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) };
};
const TH = Array.from({ length: 720 }, (_, i) => (i / 720) * 2 * Math.PI);


// ---------------------------------------------------------------------------
// SELFTEST
// ---------------------------------------------------------------------------
// The claim this file makes is "the legacy kernel is biased and rotation-noisy
// and the spiral is not". A harness that could not tell those apart would make
// the claim just as confidently, so each half is asserted against a case whose
// answer is known independently of the kernels under test.
if (process.argv.includes('--selftest')) {
  const fails = [];
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fails.push(m); };
  const n = norm([Math.sin(0.6), 0, Math.cos(0.6)]);
  let w = norm(cross(n, [0, 1, 0]));
  if (dot(w, [1, 0, 0]) < 0) w = w.map((x) => -x);

  // GROUND TRUTH. A very large spiral is a numerical integrator for this
  // geometry, and a 90-degree corner occludes exactly half the hemisphere.
  const big = stats(TH.slice(0, 8).map((t) => occSpiral(n, w, t, 20000, false)));
  ok(Math.abs(big.mean - 0.5) < 0.005, `20000 samples integrate the corner to ${big.mean.toFixed(4)}, which must be 0.5`);
  ok(big.sd < 0.005, `and barely move with rotation: sd ${big.sd.toFixed(5)}`);

  // KNOWN BAD 1, a biased kernel: a narrow fan rather than a hemisphere, and
  // NOT rotated with the pixel. The first version of this case rotated with
  // theta and read 0.5000 -- a fan that turns through every azimuth averages to
  // an unbiased answer over a full turn, so it tested nothing. It is the fixed
  // fan that is biased, and the bias test has to catch that one.
  const oneSided = () => {
    const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const t = norm(cross(up, n)), b = cross(n, t);
    let hit = 0;
    for (let i = 0; i < 32; i++) {
      const a = 0.3 + (i / 32) * 0.4;
      const v = [0, 1, 2].map((j) => t[j] * Math.cos(a) * 0.9 + b[j] * Math.sin(a) * 0.9 + n[j] * 0.4);
      if (dot(v, w) < 0) hit++;
    }
    return hit / 32;
  };
  const bad = stats(TH.map(oneSided));
  ok(Math.abs(bad.mean - 0.5) > 0.15, `a one-sided fan reads ${bad.mean.toFixed(4)}, and the bias test catches it`);

  // KNOWN BAD 2, a rotation-noisy kernel. One sample: its answer is 0 or 1
  // depending only on the angle, so the swing must approach its own quantum.
  const one = stats(TH.map((t) => occSpiral(n, w, t, 1, false)));
  ok(one.sd > 0.3, `a single-sample kernel swings ${one.sd.toFixed(3)} with rotation, and the variance test catches it`);

  // AND THE POSITIVE CONTROL: the two claims this file actually makes.
  const leg = stats(TH.map((t) => occLegacy(n, w, t)));
  const sp = stats(TH.map((t) => occSpiral(n, w, t, 32, false)));
  ok(leg.mean < 0.47, `legacy 12 under-reports the corner: ${leg.mean.toFixed(4)}`);
  ok(Math.abs(sp.mean - 0.5) < 0.01, `spiral 32 does not: ${sp.mean.toFixed(4)}`);
  ok(leg.sd > 3 * sp.sd, `legacy swings ${leg.sd.toFixed(4)} against the spiral's ${sp.sd.toFixed(4)}`);
  // AND THE UNIFORM-SOLID-ANGLE VARIANT, WHICH THIS GEOMETRY CANNOT TEST.
  //
  // A 90-degree corner is blind to the elevation distribution, for the same
  // reason the header says it is blind to sample LENGTH: with w perpendicular to
  // n, dot(v, w) has no component along n at all, so moving samples up and down
  // the normal cannot change a single hit. The first draft of this test asserted
  // that a DELIBERATELY BROKEN elevation (z = 1-u kept, disk radius left at
  // sqrt(u), so z^2 + r^2 is not 1 and the vectors are not on the hemisphere)
  // would be caught here. It reads 0.5000 with sd 0.0202 -- identical to the
  // correct kernel to four decimals -- and the assertion was wrong, not the
  // kernel.
  //
  // A TILTED WALL SEPARATES THEM, and has an exact answer. The occluded set
  // {v.n > 0, v.w < 0} is a lune of dihedral angle pi - phi, where phi is the
  // angle between n and w, so its UNIFORM-SOLID-ANGLE fraction of the hemisphere
  // is exactly (pi - phi)/pi. At phi = 90 degrees that is 0.5 for every
  // weighting, which is why the corner above tests nothing here; at 60 degrees
  // it is 2/3 for a uniform-solid-angle kernel and something else for a cosine
  // one, because a cosine kernel is not measuring that quantity.
  const phi = Math.PI / 3;
  const nt = [0, 0, 1];
  const wt = [Math.sin(phi), 0, Math.cos(phi)].map((x) => -x);   // angle(n, w) = phi
  const truth = (Math.PI - phi) / Math.PI;
  const un = stats(TH.map((t) => occSpiral(nt, wt, t, 4096, true, true)));
  const cos = stats(TH.map((t) => occSpiral(nt, wt, t, 4096, true, false)));
  ok(Math.abs(un.mean - truth) < 0.02,
    `at a ${(180 * phi / Math.PI).toFixed(0)}-degree wall the uniform-solid-angle spiral reads ` +
    `${un.mean.toFixed(4)} against the exact ${truth.toFixed(4)}`);
  ok(Math.abs(cos.mean - truth) > 0.02,
    `and the cosine spiral reads ${cos.mean.toFixed(4)}, which is the difference this variant exists to make`);
  // The 90-degree case still has to agree, or the new elevation has broken the
  // one number the rest of this file is built on.
  const un90 = stats(TH.map((t) => occSpiral(n, w, t, 32, true, true)));
  ok(Math.abs(un90.mean - 0.5) < 0.01, `and it still reads ${un90.mean.toFixed(4)} on the 90-degree corner`);

  console.log(fails.length ? `\nSELFTEST FAILED (${fails.length})` : '\nSELFTEST PASSED');
  process.exit(fails.length ? 1 : 0);
}

console.log('occlusion of a 90-degree concave corner, as the per-pixel rotation sweeps');
console.log('normal tilt   kernel            mean     sd across rotation   sd/quantum');
for (const tilt of [0, 15, 35, 60, 80]) {
  const r = (tilt * Math.PI) / 180;
  // Surface normal tilted away from the view axis by `tilt`.
  const n = norm([Math.sin(r), 0, Math.cos(r)]);
  // Wall rising from the surface, perpendicular to n, its inward normal in the
  // plane containing n and +y.
  let w = norm(cross(n, [0, 1, 0]));
  if (dot(w, [1, 0, 0]) < 0) w = w.map((x) => -x);
  const rows = [
    ['legacy 12', TH.map((t) => occLegacy(n, w, t)), 1 / 12],
    ['spiral 12', TH.map((t) => occSpiral(n, w, t, 12, false)), 1 / 12],
    ['spiral 32', TH.map((t) => occSpiral(n, w, t, 32, false)), 1 / 32],
    ['spiral 32 decor', TH.map((t) => occSpiral(n, w, t, 32, true)), 1 / 32],
    ['spiral 32 uniform', TH.map((t) => occSpiral(n, w, t, 32, true, true)), 1 / 32],
    ['spiral 12 uniform', TH.map((t) => occSpiral(n, w, t, 12, true, true)), 1 / 12],
  ];
  for (const [name, vals, q] of rows) {
    const s = stats(vals);
    console.log(`  ${String(tilt).padStart(3)} deg    ${name.padEnd(18)} ${s.mean.toFixed(4)}   ${s.sd.toFixed(4)}            ${(s.sd / q).toFixed(2)}`);
  }
}
