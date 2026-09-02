// How POLYGONAL is a silhouette, in pixels?
//
// The near-field complaint about the crowd is a silhouette complaint, and the
// shading metrics in tools/ped-near.mjs cannot carry it on their own: at dusk a
// pedestrian's trousers measure 1-10 out of 255, so a second-difference read
// across a limb is differencing black against black. The silhouette does not
// have that problem - it is the boundary between the ped and whatever is behind
// it, and it is exactly what a coarse lathe geometry gets wrong.
//
// The measurement: take the ped mask (frame with the body, minus the frame
// without it, max channel), walk the left and right boundary of a region down
// the rows, and fit a quadratic to a +/-5 row window about each row. A smooth
// ovoid IS locally quadratic, so it fits and the residual is sub-pixel. An
// N-gon is straight runs meeting at corners: the straight runs fit perfectly and
// every corner throws a residual of several pixels. So
//
//     boundaryRms  = RMS of that residual, in pixels
//     boundaryP95  = its 95th percentile, which is the corners
//
// are a direct reading of how many corners the outline has and how sharp they
// are, with no dependence on how much light is falling on the subject.
//
// Usage: node tools/silhouette.mjs <with.png> <without.png> x0 y0 x1 y1
import { readPNG } from './png.mjs';

export function maskOf(withFile, withoutFile, box, thresh = 10) {
  const A = readPNG(withFile), B = readPNG(withoutFile);
  const m = new Uint8Array(A.width * A.height);
  let n = 0;
  for (let y = Math.max(0, box.y0); y < Math.min(A.height, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x < Math.min(A.width, box.x1); x++) {
      const ia = (y * A.width + x) * A.channels, ib = (y * A.width + x) * B.channels;
      const d = Math.max(Math.abs(A.data[ia] - B.data[ib]),
        Math.abs(A.data[ia + 1] - B.data[ib + 1]), Math.abs(A.data[ia + 2] - B.data[ib + 2]));
      if (d > thresh) { m[y * A.width + x] = 1; n++; }
    }
  }
  return { m, n, w: A.width, h: A.height };
}

// Quadratic least squares over a window, evaluated at its centre. Closed form,
// because the window is symmetric about 0: the fit at the centre is
// (3*(3n^2+3n-1)*S0 - 15*S2) / ((2n-1)(2n+1)(2n+3)) with n = half width... which
// is easy to get wrong, so this solves the 3x3 normal equations directly.
function fitCentre(ys, xs) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i], x = xs[i], y2 = y * y;
    s0 += 1; s1 += y; s2 += y2; s3 += y2 * y; s4 += y2 * y2;
    t0 += x; t1 += x * y; t2 += x * y2;
  }
  // [s0 s1 s2][c] = [t0]
  // [s1 s2 s3][b] = [t1]
  // [s2 s3 s4][a] = [t2]
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return null;
  const c = (t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)) / det;
  return c;                                    // value of the fit at y = 0
}

export function boundaryRoughness(mask, box, half = 5, minRun = 8) {
  const left = [], right = [], rows = [];
  for (let y = Math.max(0, box.y0); y < Math.min(mask.h, box.y1); y++) {
    let lo = -1, hi = -1, n = 0;
    for (let x = Math.max(0, box.x0); x < Math.min(mask.w, box.x1); x++) {
      if (!mask.m[y * mask.w + x]) continue;
      if (lo < 0) lo = x;
      hi = x; n++;
    }
    if (n < minRun) continue;
    rows.push(y); left.push(lo); right.push(hi);
  }
  const res = [];
  for (const side of [left, right]) {
    for (let i = half; i < rows.length - half; i++) {
      // the window must be contiguous in y, or the fit spans a gap
      if (rows[i + half] - rows[i - half] !== 2 * half) continue;
      const ys = [], xs = [];
      for (let k = -half; k <= half; k++) { ys.push(k); xs.push(side[i + k]); }
      const fit = fitCentre(ys, xs);
      if (fit === null) continue;
      res.push(Math.abs(side[i] - fit));
    }
  }
  res.sort((a, b) => a - b);
  const rms = res.length
    ? Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length) : null;
  return {
    samples: res.length,
    boundaryRms: rms === null ? null : +rms.toFixed(3),
    boundaryP95: res.length ? +res[Math.floor(res.length * 0.95)].toFixed(3) : null,
    rowsUsed: rows.length,
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/silhouette.mjs')) {
  const [a, b, x0, y0, x1, y1] = process.argv.slice(2);
  const box = { x0: +x0, y0: +y0, x1: +x1, y1: +y1 };
  const m = maskOf(a, b, box);
  console.log(a, JSON.stringify({ maskPx: m.n, ...boundaryRoughness(m, box) }));
}
