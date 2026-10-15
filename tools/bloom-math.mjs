// The bright pass's arithmetic in JS, with no node imports, so the district probe
// (tools/bloom-source.mjs) and the gate page (tools/bloom-lit.html) run ONE definition.
//
// It is a second copy of a shader formula - src/post.js BRIGHT_FRAG and brightSplit - which is the
// recurring defect in this repo, so neither caller trusts it: both compare it against the GPU's own
// bright target on every run, and refuse a frame where the two disagree.

/** IEEE half to number. */
export function halfToFloat(v) {
  const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
  if (e === 0) return s * f * 5.9604644775390625e-8;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** The composite's decode of the #114 tag: share in [0,1], or -1 for UNTAGGED. */
export function tagOf(a) {
  const t = -a - 1;
  return t >= 0 && t <= 1 ? t : -1;
}

/**
 * The BRIGHT PASS's decode of the same tag, which is not the composite's: tolerant by 0.01 and
 * clamped, because a lit texel sits exactly on share 0 and a linear-filtered fetch that picks up
 * 1e-7 of a neighbour would otherwise flip it to untagged (src/post.js brightSplit). -1 for untagged.
 */
export function brightShareOf(a) {
  const t = -a - 1;
  return t >= -0.01 && t <= 1.01 ? Math.min(1, Math.max(0, t)) : -1;
}

/**
 * src/post.js BRIGHT_FRAG for one sample: sanitize, exposed luminance, soft knee, contrib.
 * Returns the EXPOSED luminance the pass hands the blur, which is lum * contrib.
 */
export function brightEnergy(r, g, b, exposure, threshold, softKnee) {
  const clean = (x) => (x <= 60000 ? Math.max(x, 0) : 60000);   // NaN fails <= and lands on 60000, as there
  const c0 = clean(r), c1 = clean(g), c2 = clean(b);
  const lum = (0.2126 * c0 + 0.7152 * c1 + 0.0722 * c2) * exposure;
  const knee = threshold * softKnee + 1e-5;
  let soft = Math.min(Math.max(lum - threshold + knee, 0), 2 * knee);
  soft = soft * soft / (4 * knee);
  const contrib = Math.max(soft, lum - threshold) / Math.max(lum, 1e-5);
  return { lum, energy: lum * contrib };
}

/**
 * Classify a full-resolution RGBA float image. `px` is a Float32Array of w*h*4, rows bottom-up as
 * readRenderTargetPixels returns them. Returns the energy split and the per-pixel planes the map
 * and the blob pass need.
 */
export function classify(px, w, h, P, opts = {}) {
  const n = w * h;
  const eEmit = new Float32Array(n), eLit = new Float32Array(n), eUn = new Float32Array(n);
  const lumOf = new Float32Array(n), shareOf = new Float32Array(n);
  let sumEmit = 0, sumLit = 0, sumUn = 0;
  let nEmitter = 0, nLit = 0, nUn = 0, nContrib = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const { lum, energy } = brightEnergy(px[k], px[k + 1], px[k + 2], P.exposure, P.threshold, P.softKnee);
    const s = tagOf(px[k + 3]);
    lumOf[i] = lum; shareOf[i] = s;
    if (s < 0) { nUn++; eUn[i] = energy; sumUn += energy; }
    else {
      if (s >= 0.5) nEmitter++; else nLit++;
      eEmit[i] = energy * s; eLit[i] = energy * (1 - s);
      sumEmit += energy * s; sumLit += energy * (1 - s);
    }
    if (energy > 0) nContrib++;
  }
  return { n, eEmit, eLit, eUn, lumOf, shareOf,
    sum: { emitted: sumEmit, lit: sumLit, untagged: sumUn, total: sumEmit + sumLit + sumUn },
    pixels: { emitterTagged: nEmitter, litTagged: nLit, untagged: nUn, contributing: nContrib } };
}

/**
 * src/post.js brightSplit for one scene texel (#118): the emitted part c*share against the
 * threshold, the lit part c*(1-share) against thresholdLit, an untagged texel whole against the
 * threshold. Returns the exposed luminance it hands on, and the lit part of that on its own.
 */
export function splitEnergy(r, g, b, a, exposure, threshold, thresholdLit, softKnee) {
  const s = brightShareOf(a);
  if (s < 0) return { energy: brightEnergy(r, g, b, exposure, threshold, softKnee).energy, lit: 0 };
  const clean = (x) => (x <= 60000 ? Math.max(x, 0) : 60000);
  const c0 = clean(r), c1 = clean(g), c2 = clean(b);
  const e = brightEnergy(c0 * s, c1 * s, c2 * s, exposure, threshold, softKnee).energy;
  // Infinity is how a caller says "lit light never blooms"; through the formula it is Inf - Inf = NaN
  // (knee and threshold both infinite), which the selftest caught on its first run.
  const l = Number.isFinite(thresholdLit)
    ? brightEnergy(c0 * (1 - s), c1 * (1 - s), c2 * (1 - s), exposure, thresholdLit, softKnee).energy : 0;
  return { energy: e + l, lit: l };
}

/**
 * The bright pass as the GPU runs it, at half resolution. Off (thresholdLit <= 0): the mean of each
 * 2x2 block, then the formula. On: each texel split and tested on its own, then the mean - which is
 * what the shader's four centred fetches and the filter's own 0.5 weights come to at this scale.
 */
export function emulateHalfRes(px, w, h, P) {
  const bw = w >> 1, bh = h >> 1;
  const on = P.thresholdLit > 0;
  let sum = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let r = 0, g = 0, b = 0, e = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const k = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
        if (on) e += splitEnergy(px[k], px[k + 1], px[k + 2], px[k + 3], P.exposure, P.threshold, P.thresholdLit, P.softKnee).energy;
        else { r += px[k]; g += px[k + 1]; b += px[k + 2]; }
      }
      sum += on ? e / 4 : brightEnergy(r / 4, g / 4, b / 4, P.exposure, P.threshold, P.softKnee).energy;
    }
  }
  return { bw, bh, sum, on };
}

/**
 * What a lit-light bar WOULD leave, priced on one readback: for each candidate (in exposed units,
 * Infinity meaning lit light never blooms), the total the split pass hands on and its lit part.
 */
export function priceLitBars(px, w, h, P, bars) {
  const out = bars.map((t) => ({ thresholdLit: t, total: 0, lit: 0 }));
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    for (const o of out) {
      const v = splitEnergy(px[k], px[k + 1], px[k + 2], px[k + 3], P.exposure, P.threshold, o.thresholdLit, P.softKnee);
      o.total += v.energy; o.lit += v.lit;
    }
  }
  return out;
}

/** Exposed-luminance quantiles of a subset, for "do the two populations overlap". */
export function quantiles(vals, qs = [0.5, 0.9, 0.99, 0.999]) {
  if (!vals.length) return null;
  const a = Float64Array.from(vals).sort();
  const out = { n: a.length, max: a[a.length - 1] };
  for (const q of qs) out['p' + String(q * 100).replace('.', '_')] = a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return out;
}

/**
 * 4-connected components over the pixels where `plane` exceeds `floor`, ranked by energy. Screen
 * coordinates (top-down), so a box can be found in the frame PNG.
 */
export function blobs(plane, w, h, floor, top = 8, lumOf = null, shareOf = null) {
  const lab = new Int32Array(w * h).fill(-1);
  const out = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] >= 0 || !(plane[i] > floor)) continue;
    const id = out.length;
    let e = 0, area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, lumSum = 0, shareSum = 0;
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, yb = (j / w) | 0, y = h - 1 - yb;
      e += plane[j]; area++;
      if (lumOf) lumSum += lumOf[j];
      if (shareOf) shareSum += Math.max(0, shareOf[j]);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, yb > 0 ? j - w : -1, yb < h - 1 ? j + w : -1];
      for (const q of nb) if (q >= 0 && lab[q] < 0 && plane[q] > floor) { lab[q] = id; stack.push(q); }
    }
    out.push({ energy: e, area, box: [x0, y0, x1, y1],
      meanLum: lumOf ? lumSum / area : null, meanShare: shareOf ? shareSum / area : null });
  }
  out.sort((a, b) => b.energy - a.energy);
  return { count: out.length, top: out.slice(0, top) };
}
