// WHAT DOES THE SUN'S SHADOW BIAS COST, IN CONTACT AND IN ACNE, AT EACH HOUR? — BACKLOG #141's probe.
//
//   node tools/shadow-bias.mjs --selftest
//   node tools/shadow-bias.mjs --port 8251 --cam fivepoints --tods noon,golden,dusk,night \
//        --arms shipped,b0n0.06,b0n0.12 [--tag sb] [--ref 40] [--composite shipped,b0n0.12]
//
// #138's blind review saw "the road under all three cars reads sunlit, so the cars look lifted", and
// #141 put a mechanism under it: `bias` is in NORMALISED depth, so the shipped -0.0006 is 0.54 m
// along the light ray at every hour, and with `normalBias` 0.06 a receiver is unshadowed by anything
// closer to it than 0.54 sin(elevation) + 0.06 metres VERTICALLY. At noon that is 0.58 m, and a car's
// floor — which is what three's PCF pass puts in the map, because it draws a FrontSide material's back
// faces — is 0.192 m up. This probe measures that in the page, and then measures what every
// candidate setting costs.
//
// ---------------------------------------------------------------------------------------------------
// THE QUANTITY: A SHADOW FACTOR, READ OUT OF THE HDR SCENE TARGET, NOT A LUMA
// ---------------------------------------------------------------------------------------------------
// Every arm renders inside ONE page.evaluate (prop-ground's argument: requestAnimationFrame cannot fire
// inside a task, so the crowd, the traffic, the streamer and the clouds are bit-identical across arms)
// and reads post.hdr back — the scene's linear radiance BEFORE the AO, the bloom and the tone curve,
// which is what isolates the shadow term from #138's AO leak. Two control arms are rendered first:
//
//   noShadow   sun.shadow.intensity = 0     the sun reaches every surface it faces
//   noSun      sun.intensity = 0            everything but the sun's direct beam
//
// so at every pixel f = (L - L_noSun) / (L_noShadow - L_noSun) is the fraction of the sun's direct
// light that arrives: 1 lit, 0 in shadow. It is a ratio of three renders of ONE frame, so the exposure
// stop, the albedo, the sky and the lamps all cancel, and it is undefined — null, not 0 or 1 — where
// the sun contributes too little of the pixel to measure (`--minShare`, default 0.25 by day).
//
// ---------------------------------------------------------------------------------------------------
// THE TRUTH: A REFERENCE MAP EIGHT TIMES FINER
// ---------------------------------------------------------------------------------------------------
// "Lit" and "shadowed" need a reference that is neither the shipped bias nor the candidate. The `ref`
// arm puts a 4096 map over a +-`--ref` m box (0.0195 m a texel at 40, 6x finer than the shipped
// 0.1172) round a point 18 m in front of the camera, with a bias sized for ITS texel (0.01 m along the
// ray, 0.02 m normal). `ref2` halves the box again so the reference's own convergence is a printed
// number rather than an assumption. Pixels outside the reference box are excluded from every count
// that reads it, by a world-position pass rather than by guessing.
//
// ---------------------------------------------------------------------------------------------------
// WHAT IS COUNTED
// ---------------------------------------------------------------------------------------------------
//   CONTACT   per car (the player's, which is the "red car" at fivepoints, and the two nearest parked
//             cars in frame): f on the ROAD UNDER THE BODY that the camera can see between the sill
//             and the ground, against the reference's f at the same points. Per pedestrian (the four
//             nearest in frame): f along the ground running away from the sun from the body, the
//             first 0.30 m past it.
//   ACNE      per group of SURFACE (car, ped, facade, furniture, ground — tools/tri-buckets.mjs's
//             buckets, the one definition), over sun-facing pixels inside the reference box:
//               acne   lit in the reference (f_ref >= 0.9) and more than half shadowed in the arm
//               leak   shadowed in the reference (f_ref <= 0.1) and more than half lit in the arm
//             A coarse map gets both wrong near every shadow edge whatever its bias, so the number to
//             read is how an arm MOVES them against the shipped arm, which carries the same map.
//
// The census and the reductions are pure functions exported below and exercised by --selftest on
// inputs whose right answer is known, including the ones that must NOT read as a result: an empty
// group, a pixel the sun does not reach, a pixel outside the reference box.
import fs from 'node:fs';
import { PRESETS } from '../src/daynight.js';
import { bucketSource } from './tri-buckets.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

// ----------------------------------------------------------------------------------- the pure half

/** three's `shadow.bias` for a bias of `metres` along the ray, against an ortho camera near..far. */
export function biasFor(metres, near, far) { return -metres / (far - near); }

/** The vertical distance under which nothing can shadow a horizontal receiver: b sin(el) + nb. */
export function verticalTolerance(biasMetres, normalBias, elevation) {
  return biasMetres * Math.sin(elevation) + normalBias;
}

/**
 * An arm's name to the setting it applies. Named arms are controls; `bXnY` is a bias of X metres along
 * the ray with a normalBias of Y metres; `eTnY` is a bias SET FROM THE HOUR so the vertical tolerance
 * is T metres with a normalBias of Y: b = (T - Y) / sin(elevation), the "constant set from the preset's
 * elevation" candidate. Throws on anything else, because a typo that silently measured the shipped
 * arm twice would read as "this lever does nothing".
 */
export function parseArm(name, elevation) {
  if (['shipped', 'noShadow', 'noSun', 'ref', 'ref2', 'repeat', 'noContact'].includes(name)) return { name, kind: name };
  let m = /^b([0-9.]+)n([0-9.]+)$/.exec(name);
  if (m) return { name, kind: 'bias', b: Number(m[1]), nb: Number(m[2]) };
  // ROUND 2 (#141's awning acne): a lever applied to ONE family of materials on top of the shipped
  // light. `r` is a RECEIVER-side extra normal offset (the material's own lookup into the sun's map is
  // pushed X metres further along its normal than normalBias does); `c` is a CASTER-side offset (the
  // family's geometry is drawn into the map X metres along its own normals, so a back sheet lying on
  // a front sheet stands X behind it). `s` is the shop signage (signMaterial and the street signs),
  // `t` the facade trim.
  // `k` and `l` are the same two sides SLOPE-SCALED, X in shadow-map texels: `k` widens the receiver's
  // offset to X texels times the sine of its angle to the sun (less normalBias, never below it), `l`
  // pushes the caster's depth X texels times the tangent of ITS angle further along the sun's ray, so
  // its silhouette in the map does not move — which is what `c` gives up, since moving a face along
  // its normal moves its edge.
  m = /^([rckl])([st])([0-9.]+)$/.exec(name);
  if (m) return { name, kind: 'sheet', mode: m[1], who: m[2], x: Number(m[3]) };
  // `q`: on a page that casts the family with src/sheetshadow.js's material, the cosine its push stops
  // growing at (SHEET_COS), so the clamp can be swept one term at a time like K.
  m = /^q([st])([0-9.]+)$/.exec(name);
  if (m) return { name, kind: 'sheet', mode: 'q', who: m[1], x: Number(m[2]) };
  // `a+b`: levers together, each parsed as itself (a bias part and sheet parts, or two sheet parts).
  if (name.includes('+')) return { name, kind: 'combo', parts: name.split('+').map((p) => parseArm(p, elevation)) };
  m = /^e([0-9.]+)n([0-9.]+)$/.exec(name);
  if (m) {
    const T = Number(m[1]), nb = Number(m[2]);
    if (!(elevation > 0)) throw new Error(`arm ${name} needs a positive sun elevation, got ${elevation}`);
    return { name, kind: 'bias', b: Math.max(0, T - nb) / Math.sin(elevation), nb, tolerance: T };
  }
  throw new Error(`unknown arm "${name}" (named: shipped noShadow noSun ref ref2; or bXnY; or eTnY; or rsX rtX csX ctX ksX ktX lsX ltX)`);
}

/** The fraction of the sun's direct light reaching a pixel, or null where it cannot be read. */
export function shadowFactor(L, Lns, L0, minShare = 0.25) {
  if (![L, Lns, L0].every(Number.isFinite)) return null;
  const sun = Lns - L0;
  if (!(Lns > 0) || !(sun > 0) || sun / Lns < minShare) return null;
  return (L - L0) / sun;
}

/** Mean of the non-null entries, and how many there were. Empty is null, never 0. */
export function meanOf(vals) {
  let s = 0, n = 0;
  for (const v of vals) if (v !== null && Number.isFinite(v)) { s += v; n++; }
  return { mean: n ? s / n : null, n };
}

/**
 * THE CENSUS, as a pure function of per-pixel arrays, so the page and the selftest run the same code.
 * It closes over nothing and uses no arrow functions, because it is stringified into the page.
 *
 *   group    Uint8Array, the pixel's surface group (index into GROUPS)
 *   inRef    Uint8Array, 1 where the pixel lies inside the reference map's box
 *   L0, Lns  the noSun and noShadow renders;  Lref the reference;  Lbase the shipped arm;  L the arm
 *   minShare the sun's share of the unshadowed pixel below which f is not read
 *   nGroups  how many groups
 *
 * Returns per group: n (readable pixels), meanF, acne (f_ref >= 0.9, f <= 0.5), leak (f_ref <= 0.1,
 * f >= 0.5), and against the shipped arm: darker / lighter by more than 0.3 of f. Rates are counts
 * here; the caller divides, and a group with n = 0 has no rate at all.
 */
export function census(group, inRef, L0, Lns, Lref, Lbase, L, minShare, nGroups) {
  var out = [];
  for (var g = 0; g < nGroups; g++) {
    out.push({ n: 0, sumF: 0, refLit: 0, refDark: 0, acne: 0, leak: 0, darker: 0, lighter: 0, darkSum: 0, partial: 0 });
  }
  for (var i = 0; i < group.length; i++) {
    if (!inRef[i]) continue;
    var gi = group[i];
    if (gi >= nGroups) continue;
    var sun = Lns[i] - L0[i];
    if (!(Lns[i] > 0) || !(sun > 0) || sun / Lns[i] < minShare) continue;
    var f = (L[i] - L0[i]) / sun, fr = (Lref[i] - L0[i]) / sun, fb = (Lbase[i] - L0[i]) / sun;
    if (!(f === f) || !(fr === fr) || !(fb === fb)) continue;
    var o = out[gi];
    o.n++; o.sumF += f;
    // ROUND 2: acne on a sheet is PARTIAL — the reviewer's awning stripes were valances 4-13% darker,
    // which `f <= 0.5` never counts. So the census also carries how much of the reference's light a
    // lit pixel lost (darkSum, a mean once divided by refLit) and how many lost more than 0.15 of it.
    if (fr >= 0.9) {
      o.refLit++; if (f <= 0.5) o.acne++;
      if (fr - f > 0) o.darkSum += fr - f;
      if (f < fr - 0.15) o.partial++;
    }
    if (fr <= 0.1) { o.refDark++; if (f >= 0.5) o.leak++; }
    if (f < fb - 0.3) o.darker++;
    if (f > fb + 0.3) o.lighter++;
  }
  return out;
}
export const censusSource = census.toString();

/** The surface groups the census reports, from tools/tri-buckets.mjs's buckets. */
// 'signage' was inside 'furniture' in round 1; it is its own group now because the shop signage's
// awnings are where the acne a reviewer saw lives. Appended, so every other index is round 1's.
export const GROUPS = ['background', 'car', 'ped', 'facade', 'furniture', 'ground', 'sky', 'other', 'signage', 'trim'];
export function groupOfBucket(b) {
  if (b === 'vehicles') return 1;
  if (b === 'pedestrians') return 2;
  if (b === 'facade (near LOD)') return 3;
  // The facade TRIM apart from the walls since round 2: the facade kit's own awnings live in it.
  if (b === 'facade trim (near LOD)') return 9;
  if (b === 'signage') return 8;
  if (b === 'street furniture + trees' || b === 'street lamps') return 4;
  // 'other: district' is the streamer's LAND PAD and its water, the two unnamed children of its root:
  // the pad is the pavement every pedestrian stands on (src/pedestrians.js places soles against it).
  if (b === 'roads' || b === 'kerbs (near LOD)' || b === 'ground zones' || b === 'buildings (far LOD)' ||
    b === 'other: district') return 5;
  if (b === 'sky dome') return 6;
  return 7;
}
export const groupSource = groupOfBucket.toString();

/** A census row as rates, with every rate null where its denominator is empty. */
export function rates(o) {
  const r = (a, b) => (b > 0 ? a / b : null);
  return { n: o.n, meanF: r(o.sumF, o.n), acne: r(o.acne, o.refLit), leak: r(o.leak, o.refDark),
    darker: r(o.darker, o.n), lighter: r(o.lighter, o.n), refLit: o.refLit, refDark: o.refDark,
    dark: r(o.darkSum, o.refLit), partial: r(o.partial, o.refLit) };
}

/**
 * THE REVIEWER'S STRIPE STATISTIC (#141's blind review, 2026-11-03): the standard deviation, over a
 * box, of L / box5(L), where box5 is the 5x5 mean round each pixel — a high-pass that is a RATIO,
 * so a uniform change of exposure cancels and only structure finer than five pixels survives. The
 * awning acne is a 4 px stripe, so it lands in this band; the fabric's own stripes, at tens of
 * pixels, mostly do not. The reviewer read it as x2.66 and x3.11 between the arms.
 *
 *   L     luma, row 0 the top of the screen, any monotone encoding (the reviewer's was the PNG's)
 *   box   [x0, y0, x1, y1], inclusive-exclusive, in the frame's own pixels
 *
 * Pixels whose 5x5 window leaves the frame are skipped. Returns { n, std } or null where nothing
 * could be read, never 0, because a box off the frame must not read as "no stripes".
 *
 *   mask  optional, one entry per pixel: a pixel counts only when its WHOLE 5x5 window is in the
 *         mask. The full box reads x1.0 between round 1's arms in all three of the reviewer's boxes
 *         (0.95, 0.93, 0.99), because the box holds lettering, shut lines and the canopy's own
 *         edges, whose high-pass dwarfs a 4-13% stripe; on the fabric alone the same frames read
 *         x2.09. So the reviewer's number is a fabric number, and the probe reports both.
 */
export function stripeEnergy(L, W, H, box, mask) {
  var x0 = Math.max(2, box[0]), y0 = Math.max(2, box[1]), x1 = Math.min(W - 2, box[2]), y1 = Math.min(H - 2, box[3]);
  var n = 0, s = 0, s2 = 0;
  for (var y = y0; y < y1; y++) {
    for (var x = x0; x < x1; x++) {
      if (mask) {
        var inside = true;
        for (var my = -2; my <= 2 && inside; my++) for (var mx = -2; mx <= 2; mx++) if (!mask[(y + my) * W + x + mx]) { inside = false; break; }
        if (!inside) continue;
      }
      var m = 0;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) m += L[(y + dy) * W + x + dx];
      m /= 25;
      if (!(m > 0)) continue;
      var r = L[y * W + x] / m;
      if (!(r === r)) continue;
      n++; s += r; s2 += r * r;
    }
  }
  if (n < 2) return null;
  var mu = s / n;
  return { n: n, std: Math.sqrt(Math.max(0, s2 / n - mu * mu)) };
}
export const stripeSource = stripeEnergy.toString();

/**
 * The reviewer's boxes, in the hero frames' own 1600 x 900 pixels, by framing: three awnings at noon
 * where the stripe energy read x2.66 (Tinsmith Deli, corridor; Marrow & Vine, fivepoints) and x3.11
 * (Corvid Coffee's yellow canopy, fivepoints). `--boxes name:x0,y0,x1,y1;...` replaces them.
 */
export const BOXES = {
  corridor: { tinsmith: [1200, 425, 1450, 470] },
  fivepoints: { marrowVine: [1100, 355, 1290, 425], corv: [1290, 420, 1380, 475] },
};

// ------------------------------------------------------------------------------------- selftest
function selftest() {
  let fail = 0, n = 0;
  const say = (name, ok, extra = '') => {
    n++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++;
  };
  console.log('SHADOW-BIAS SELFTEST');
  // The arithmetic the backlog quotes, re-derived from the presets rather than typed in.
  const b0 = 0.0006 * 899;
  const tol = (k) => verticalTolerance(b0, 0.06, PRESETS[k].elevation);
  say('the shipped bias is 0.54 m along the ray', Math.abs(b0 - 0.5394) < 1e-9, `${b0.toFixed(4)} m`);
  say('and its vertical tolerance is 0.58 m at noon, 0.48 night, 0.14 golden, 0.09 dusk',
    Math.abs(tol('noon') - 0.5825) < 5e-4 && Math.abs(tol('night') - 0.4825) < 5e-4 &&
    Math.abs(tol('golden') - 0.1351) < 5e-4 && Math.abs(tol('dusk') - 0.0896) < 5e-4,
    ['noon', 'night', 'golden', 'dusk'].map((k) => `${k} ${tol(k).toFixed(4)}`).join(', '));
  say('biasFor inverts the normalisation', Math.abs(biasFor(b0, 1, 900) + 0.0006) < 1e-12);

  // Arms.
  const a = parseArm('b0n0.12', 1.32);
  say('bXnY parses', a.kind === 'bias' && a.b === 0 && a.nb === 0.12);
  const e = parseArm('e0.10n0.06', PRESETS.noon.elevation);
  say('eTnY sets the bias from the hour so the tolerance is T',
    Math.abs(verticalTolerance(e.b, e.nb, PRESETS.noon.elevation) - 0.10) < 1e-12 &&
    Math.abs(verticalTolerance(parseArm('e0.10n0.06', PRESETS.dusk.elevation).b, 0.06, PRESETS.dusk.elevation) - 0.10) < 1e-12,
    `noon b ${e.b.toFixed(4)} m, dusk b ${parseArm('e0.10n0.06', PRESETS.dusk.elevation).b.toFixed(4)} m`);
  let threw = false;
  try { parseArm('b0.1', 1); } catch { threw = true; }
  say('KNOWN-BAD: a malformed arm throws rather than measuring the shipped one again', threw);

  // The shadow factor.
  say('f is 1 where the arm reads the unshadowed sun', shadowFactor(10, 10, 2) === 1);
  say('f is 0 where the arm reads only the sky', shadowFactor(2, 10, 2) === 0);
  say('KNOWN-BAD: a pixel the sun does not reach is null, not 0 or 1',
    shadowFactor(2, 2, 2) === null && shadowFactor(5, 10.1, 10) === null);
  say('KNOWN-BAD: a non-finite read is null', shadowFactor(NaN, 10, 2) === null);
  say('an empty mean is null, not 0', meanOf([null, null]).mean === null && meanOf([]).n === 0);

  // The census, on a synthetic frame whose answers are known.
  const N = 12;
  const group = new Uint8Array([1, 1, 1, 1, 2, 2, 5, 5, 5, 3, 3, 0]);
  const inRef = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]);
  const L0 = new Float32Array(N).fill(1), Lns = new Float32Array(N).fill(11);
  const Lref = new Float32Array([11, 11, 1, 1, 11, 11, 1, 1, 11, 11, 1, 11]);
  const Lbase = Lref.slice();
  // The arm: one car pixel lit in the reference goes dark (acne), one ground pixel shadowed in the
  // reference comes up lit (leak), and pixel 10 is acne-shaped but OUTSIDE the reference box.
  const L = Lref.slice(); L[0] = 1; L[7] = 11; L[10] = 11;
  const c = census(group, inRef, L0, Lns, Lref, Lbase, L, 0.25, GROUPS.length);
  say('the census finds the acne in the group it is in', c[1].acne === 1 && c[1].refLit === 2,
    `car acne ${c[1].acne}/${c[1].refLit}`);
  say('and the leak in its own', c[5].leak === 1 && c[5].refDark === 2, `ground leak ${c[5].leak}/${c[5].refDark}`);
  say('and nothing in a group the arm did not move', c[2].acne === 0 && c[2].leak === 0 && c[3].acne === 0);
  say('KNOWN-BAD: a pixel outside the reference box is not counted', c[3].n === 1, `facade n ${c[3].n}`);
  say('against the shipped arm: one darker, one lighter', c[1].darker === 1 && c[5].lighter === 1);
  const same = census(group, inRef, L0, Lns, Lref, Lbase, Lbase, 0.25, GROUPS.length);
  say('KNOWN-BAD: the shipped arm against itself moves nothing',
    same.every((o) => o.acne === 0 && o.leak === 0 && o.darker === 0 && o.lighter === 0));
  // A pixel whose sun share is under the floor must not be read at all.
  const dim = census(group, inRef, L0, new Float32Array(N).fill(1.2), Lref, Lbase, L, 0.25, GROUPS.length);
  say('KNOWN-BAD: a frame the sun barely reaches reads no pixels, not perfect contact',
    dim.every((o) => o.n === 0));
  const rr = rates({ n: 0, sumF: 0, refLit: 0, refDark: 0, acne: 0, leak: 0, darker: 0, lighter: 0 });
  say('an empty group has null rates, not 0%', rr.meanF === null && rr.acne === null && rr.leak === null);
  const inj = new Function(`return (${censusSource})`)();
  const c2 = inj(group, inRef, L0, Lns, Lref, Lbase, L, 0.25, GROUPS.length);
  say('the stringified census behaves like the original', JSON.stringify(c2) === JSON.stringify(c));
  say('and closes over nothing', !/=>/.test(censusSource) && !/\b(import|require)\b/.test(censusSource));
  const gi = new Function(`return (${groupSource})`)();
  say('the group map: a parked car is a car, a road is ground, a lamp is furniture, the land pad is ground',
    gi('vehicles') === 1 && gi('roads') === 5 && gi('street lamps') === 4 && gi('pedestrians') === 2 &&
    gi('other: district') === 5);
  say('and a shop sign is signage, apart from the furniture it sat in for round 1',
    gi('signage') === 8 && GROUPS[8] === 'signage' && gi('street furniture + trees') === 4);

  // ROUND 2: partial acne, which `f <= 0.5` cannot see.
  {
    const g2 = new Uint8Array([8, 8, 8]), in2 = new Uint8Array([1, 1, 1]);
    const z = new Float32Array(3).fill(1), ns = new Float32Array(3).fill(11);
    const ref = new Float32Array([11, 11, 11]);
    const arm = new Float32Array([8, 11, 11]);         // one lit pixel at f 0.7: 0.3 of its sun lost
    const c3 = census(g2, in2, z, ns, ref, ref, arm, 0.25, GROUPS.length);
    say('KNOWN-BAD: a lit pixel at f 0.7 is no acne by the 0.5 threshold and IS partial acne',
      c3[8].acne === 0 && c3[8].partial === 1 && Math.abs(c3[8].darkSum - 0.3) < 1e-6,
      `acne ${c3[8].acne}, partial ${c3[8].partial}, darkSum ${c3[8].darkSum.toFixed(3)}`);
    const c4 = census(g2, in2, z, ns, ref, ref, ref, 0.25, GROUPS.length);
    say('and the reference against itself loses nothing', c4[8].partial === 0 && c4[8].darkSum === 0);
    const rr2 = rates(c3[8]);
    say('the rates carry it as a mean over the lit pixels', Math.abs(rr2.dark - 0.1) < 1e-6 && Math.abs(rr2.partial - 1 / 3) < 1e-9,
      `dark ${rr2.dark?.toFixed(3)}, partial ${rr2.partial?.toFixed(3)}`);
  }

  // ROUND 2: the stripe statistic on frames whose answer is known.
  {
    const W = 40, H = 20, box = [5, 5, 35, 15];
    const flat = new Float32Array(W * H).fill(100);
    const st = new Float32Array(W * H), ramp = new Float32Array(W * H), wide = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      st[y * W + x] = 100 * (1 + 0.1 * Math.sin(2 * Math.PI * (x + y) / 4));        // 4 px, diagonal
      ramp[y * W + x] = 50 + 2 * x;                                                    // a smooth gradient
      wide[y * W + x] = 100 * (1 + 0.1 * Math.sin(2 * Math.PI * x / 40));            // a 40 px band
    }
    const eF = stripeEnergy(flat, W, H, box), eS = stripeEnergy(st, W, H, box);
    const eR = stripeEnergy(ramp, W, H, box), eW = stripeEnergy(wide, W, H, box);
    const st3 = st.map((v) => v * 3);
    say('a flat box has no stripe energy', eF && eF.std < 1e-6, `${eF?.std}`);
    say('a 4 px diagonal stripe of +-10% reads it', eS && eS.std > 0.05, `${eS?.std.toFixed(4)}`);
    say('a smooth ramp and a 40 px band read far less than the 4 px stripe',
      eR.std < eS.std / 10 && eW.std < eS.std / 5, `ramp ${eR.std.toFixed(4)}, 40 px ${eW.std.toFixed(4)}`);
    say('it is a ratio: three times the exposure reads the same', Math.abs(stripeEnergy(st3, W, H, box).std - eS.std) < 1e-6);
    say('KNOWN-BAD: a box off the frame reads null, not "no stripes"', stripeEnergy(st, W, H, [100, 100, 120, 120]) === null);
    const inj2 = new Function(`return (${stripeSource})`)();
    say('the stringified statistic behaves like the original', Math.abs(inj2(st, W, H, box).std - eS.std) < 1e-12);
    say('the reviewer\'s boxes are on the frame', Object.values(BOXES).every((bx) => Object.values(bx).every(
      (b) => b[0] >= 0 && b[2] <= 1600 && b[1] >= 0 && b[3] <= 900 && b[2] > b[0] && b[3] > b[1])));
    // The mask: fabric carrying the 4 px stripe, with a hard dark LETTER in the middle of it that is
    // not fabric. Over the whole box the letter's edges swamp the stripe; inside the mask they do not,
    // and a pixel whose window merely TOUCHES the letter is out as well.
    const lettered = st.slice(), plain = flat.slice(), mask = new Uint8Array(W * H).fill(1);
    for (let y = 8; y < 12; y++) for (let x = 18; x < 22; x++) { lettered[y * W + x] = 10; plain[y * W + x] = 10; mask[y * W + x] = 0; }
    const fullL = stripeEnergy(lettered, W, H, box), fullP = stripeEnergy(plain, W, H, box);
    const mL = stripeEnergy(lettered, W, H, box, mask), mP = stripeEnergy(plain, W, H, box, mask);
    say('KNOWN-BAD: over the full box a letter hides the stripe — lettered over plain reads under x2',
      fullL.std / fullP.std < 2, `x${(fullL.std / fullP.std).toFixed(2)}`);
    say('inside the fabric mask the stripe reads as itself and the plain fabric as nothing',
      Math.abs(mL.std - eS.std) < 0.25 * eS.std && mP.std < 1e-6, `stripe ${mL.std.toFixed(4)} against ${eS.std.toFixed(4)}, plain ${mP.std}`);
    let touching = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
      let all = true;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!mask[(y + dy) * W + x + dx]) all = false;
      if (all) touching++;
    }
    say('a pixel counts only when its whole window is fabric', mL.n === touching && mL.n === 30 * 10 - 8 * 8,
      `n ${mL.n}, expected ${30 * 10 - 8 * 8}`);
    say('KNOWN-BAD: an empty mask reads null, not "no stripes"', stripeEnergy(st, W, H, box, new Uint8Array(W * H)) === null);
    say('and the stringified statistic takes the mask the same way', Math.abs(inj2(lettered, W, H, box, mask).std - mL.std) < 1e-12);
  }
  for (const [nm, want] of [['rs0.1', ['r', 's', 0.1]], ['ct0.06', ['c', 't', 0.06]], ['ks2', ['k', 's', 2]], ['lt1.5', ['l', 't', 1.5]],
    ['qs0.15', ['q', 's', 0.15]]]) {
    const q = parseArm(nm, 1);
    const side = { r: 'receiver', c: 'caster', k: 'slope-scaled receiver', l: 'slope-scaled caster', q: 'clamp' }[want[0]];
    say(`${nm} parses as a ${side} lever on the ${want[1] === 's' ? 'signage' : 'trim'}`,
      q.kind === 'sheet' && q.mode === want[0] && q.who === want[1] && q.x === want[2]);
  }
  {
    const q = parseArm('rs0.06+ct0.03', 1);
    say('a combo parses into its parts, each as itself', q.kind === 'combo' && q.parts.length === 2
      && q.parts[0].mode === 'r' && q.parts[0].who === 's' && q.parts[1].mode === 'c' && q.parts[1].who === 't');
    let threw = false;
    try { parseArm('rs0.06+zz1', 1); } catch { threw = true; }
    say('KNOWN-BAD: a combo with a malformed part throws rather than dropping it', threw);
  }
  console.log(`\nSHADOW-BIAS SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${n} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (IS_MAIN && has('selftest')) selftest();

// ------------------------------------------------------------------------------------ the page half

/**
 * Everything that runs in the page for ONE hour: the subjects' sample sets, the classification pass,
 * and every arm, inside one task. Self-contained (page.evaluate serialises it).
 */
async function measureInPage(args) {
  const { armSpecs, refHalf, minShare, bucketSrc, censusSrc, groupSrc, nGroups, compositeArms, wantShots, mapArms,
    boxes, stripeSrc } = args;
  const THREE = await import('/vendor/three.module.min.js');
  const D = window.__district, scene = D.scene, cam = D.camera, r = D.renderer, post = D.post;
  const sun = D.tod.sun, sc = sun.shadow.camera;
  const bucketOf = new Function(`return (${bucketSrc})`)();
  const censusFn = new Function(`return (${censusSrc})`)();
  const groupOf = new Function(`return (${groupSrc})`)();
  const stripeOf = new Function(`return (${stripeSrc})`)();
  const t0 = performance.now();
  scene.updateMatrixWorld(true);
  cam.updateMatrixWorld();
  const W = post.hdr.width, H = post.hdr.height;
  const gl = r.getContext();

  // ---------------------------------------------------------------- half floats, by table
  const HALF = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    HALF[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 0x1f ? (f ? NaN : s * Infinity)
      : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  const u16 = new Uint16Array(W * H * 4);
  /** Linear luma of the HDR scene target, row 0 = the TOP of the screen. */
  const readHDR = () => {
    r.readRenderTargetPixels(post.hdr, 0, 0, W, H, u16);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4, dst = y * W;
      for (let x = 0; x < W; x++) {
        const i = src + x * 4;
        out[dst + x] = 0.2126 * HALF[u16[i]] + 0.7152 * HALF[u16[i + 1]] + 0.0722 * HALF[u16[i + 2]];
      }
    }
    return out;
  };
  const u8 = new Uint8Array(W * H * 4);
  const SRGB = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; SRGB[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  /** The composited frame, sRGB-decoded luma: what the viewer sees, AO and tone curve included.
   *  `enc` is the same frame's luma on the ENCODED bytes, which is what a reviewer reading a PNG
   *  computes, and what the stripe statistic is taken on. */
  const readLDR = () => {
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    const out = new Float32Array(W * H), enc = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4, dst = y * W;
      for (let x = 0; x < W; x++) {
        const i = src + x * 4;
        out[dst + x] = 0.2126 * SRGB[u8[i]] + 0.7152 * SRGB[u8[i + 1]] + 0.0722 * SRGB[u8[i + 2]];
        enc[dst + x] = 0.2126 * u8[i] + 0.7152 * u8[i + 1] + 0.0722 * u8[i + 2];
      }
    }
    out.enc = enc;
    return out;
  };
  const pngOf = () => {
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); const im = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) im.data.set(u8.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    ctx.putImageData(im, 0, 0);
    return cv.toDataURL('image/png');
  };

  // ---------------------------------------------------------------- the scene, by group
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
  const depthWrites = (o) => (Array.isArray(o.material) ? o.material : [o.material]).some((m) => m && m.depthWrite !== false);
  // The class pass writes a BUCKET index (1-based; 0 is nothing drawn), so the pixels can be counted
  // per bucket as well as per group: a group that swallowed a surface nobody meant it to is visible.
  const bucketNames = [];
  const bucketIdx = new Map(meshes.map((m) => {
    const b = bucketOf(m);
    let i = bucketNames.indexOf(b);
    if (i < 0) { bucketNames.push(b); i = bucketNames.length - 1; }
    return [m, i + 1];
  }));
  const grp = new Map(meshes.map((m) => [m, groupOf(bucketOf(m))]));
  const camPos = cam.position.clone();
  const v3 = new THREE.Vector3();
  const project = (x, y, z) => {
    v3.set(x, y, z).project(cam);
    return { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H, z: v3.z };
  };
  const sunDir = D.tod.sunDirection(new THREE.Vector3());
  const elevation = Math.asin(Math.max(-1, Math.min(1, sunDir.y)));
  const hs = Math.hypot(sunDir.x, sunDir.z) || 1;
  const toSun = { x: sunDir.x / hs, z: sunDir.z / hs };

  // ---------------------------------------------------------------- classification + world position
  // Every mesh drawn once more with a material that writes its world position and its group, so a
  // pixel can be counted as a car, a wall or the road, tested against the reference box, and placed
  // under a car or beside a pedestrian WITHOUT A SINGLE RAYCAST: the subjects below are chosen from
  // the pixels the camera actually sees, which is also the visibility test. Decals (depthWrite off)
  // are hidden for this pass: they are not a surface anything stands on.
  const posRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, samples: 0 });
  const vs = `varying vec3 vW; varying vec2 vUv; void main() { vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    vec4 w = modelMatrix * p; vW = w.xyz; vUv = uv; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const fs_ = `uniform float cat; varying vec3 vW; varying vec2 vUv;
    #ifdef USE_AT
      uniform sampler2D aMap; uniform float aTest;
    #endif
    void main() {
    #ifdef USE_AT
      if (texture2D(aMap, vUv).g < aTest) discard;
    #endif
      gl_FragColor = vec4(vW, cat); }`;
  const classMats = new Map();
  const classMat = (gi, src) => {
    const at = !!(src && src.alphaMap && src.alphaTest > 0);
    const key = `${gi}:${src ? src.side : 0}:${at ? src.alphaMap.uuid + src.alphaTest : ''}`;
    if (!classMats.has(key)) {
      classMats.set(key, new THREE.ShaderMaterial({
        uniforms: { cat: { value: gi }, aMap: { value: at ? src.alphaMap : null }, aTest: { value: at ? src.alphaTest : 0 } },
        defines: at ? { USE_AT: '' } : {}, vertexShader: vs, fragmentShader: fs_, side: src ? src.side : THREE.FrontSide,
      }));
    }
    return classMats.get(key);
  };
  const saved = [];
  for (const m of meshes) {
    saved.push([m, m.material, m.visible]);
    if (!depthWrites(m)) { m.visible = false; continue; }
    const gi = bucketIdx.get(m);
    m.material = Array.isArray(m.material) ? m.material.map((x) => classMat(gi, x)) : classMat(gi, m.material);
  }
  const bg = scene.background; scene.background = null;
  const fog = scene.fog; scene.fog = null;
  const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
  r.setClearColor(0x000000, 0);
  r.setRenderTarget(posRT); r.clear(); r.render(scene, cam); r.setRenderTarget(null);
  r.setClearColor(prevClear, prevAlpha);
  for (const [m, mat, vis] of saved) { m.material = mat; m.visible = vis; }
  scene.background = bg; scene.fog = fog;
  for (const m of classMats.values()) m.dispose();
  const P = new Float32Array(W * H * 4);
  {
    const f32 = new Float32Array(W * H * 4);
    r.readRenderTargetPixels(posRT, 0, 0, W, H, f32);
    for (let y = 0; y < H; y++) P.set(f32.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  }
  posRT.dispose();
  const group = new Uint8Array(W * H);
  const groupCount = new Array(nGroups).fill(0);
  const bucketPx = new Array(bucketNames.length).fill(0);
  for (let k = 0; k < W * H; k++) {
    const bi = Math.round(P[k * 4 + 3]);
    const g = bi >= 1 && bi <= bucketNames.length ? groupOf(bucketNames[bi - 1]) : 0;
    group[k] = g >= 0 && g < nGroups ? g : 0;
    groupCount[group[k]]++;
    if (bi >= 1 && bi <= bucketNames.length) bucketPx[bi - 1]++;
  }
  // GROUND THE CAMERA SEES CLEANLY: a ground pixel whose four neighbours are ground too, so the
  // HDR target's MSAA resolve cannot have blended a sill or a shoe into it.
  const cleanGround = (k) => {
    if (group[k] !== 5) return false;
    const x = k % W, y = (k - x) / W;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    return group[k - 1] === 5 && group[k + 1] === 5 && group[k - W] === 5 && group[k + W] === 5;
  };

  // ---------------------------------------------------------------- the reference box
  // Round a ground point 18 m in front of the camera, in the light's own lateral axes.
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const fl = Math.hypot(fwd.x, fwd.z) || 1;
  const F = (() => {
    // The ground pixel nearest the screen point 18 m ahead at ground height, read off the position
    // pass rather than raycast.
    const gx = camPos.x + (fwd.x / fl) * 18, gz = camPos.z + (fwd.z / fl) * 18;
    let best = null, bd = Infinity;
    for (let k = 0; k < W * H; k += 7) {
      if (group[k] !== 5) continue;
      const d = Math.hypot(P[k * 4] - gx, P[k * 4 + 2] - gz);
      if (d < bd) { bd = d; best = k; }
    }
    return best === null ? new THREE.Vector3(gx, 0, gz) : new THREE.Vector3(gx, P[best * 4 + 1], gz);
  })();
  const LX = new THREE.Vector3(sunDir.z, 0, -sunDir.x).normalize();
  const LY = new THREE.Vector3().crossVectors(sunDir, LX);
  const inRef = new Uint8Array(W * H), inRef2 = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const g = group[k];
    if (g === 0 || g === 6) continue;
    const dx = P[k * 4] - F.x, dy = P[k * 4 + 1] - F.y, dz = P[k * 4 + 2] - F.z;
    const a = Math.abs(dx * LX.x + dy * LX.y + dz * LX.z), b = Math.abs(dx * LY.x + dy * LY.y + dz * LY.z);
    if (a < refHalf - 1 && b < refHalf - 1) inRef[k] = 1;
    if (a < refHalf / 2 - 1 && b < refHalf / 2 - 1) inRef2[k] = 1;
  }

  // ---------------------------------------------------------------- subjects, from the pixels
  const subjects = [];
  const tmp = new THREE.Vector3();
  // A car: its world matrix and the height of its contact patch and underbody in its own frame. The
  // player's car is authored in CAR's frame (ground -0.717, underbody -0.525); a pooled car's geometry
  // is translated so its contact patch is its bounding box's floor.
  const carSubject = (name, wm, groundLocal, underLocal) => {
    const inv = new THREE.Matrix4().copy(wm).invert();
    const c = new THREE.Vector3(0, groundLocal, 0).applyMatrix4(wm);
    const q = project(c.x, c.y, c.z);
    if (q.z > 1 || q.x < 0 || q.x > W || q.y < 0 || q.y > H) return null;
    // A screen window round the car: its eight footprint corners, 7 m out, projected.
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const sx of [-7, 7]) for (const sz of [-7, 7]) for (const sy of [groundLocal, groundLocal + 1.6]) {
      const p = new THREE.Vector3(sx, sy, sz).applyMatrix4(wm); const pp = project(p.x, p.y, p.z);
      if (pp.z > 1) continue;
      x0 = Math.min(x0, pp.x); x1 = Math.max(x1, pp.x); y0 = Math.min(y0, pp.y); y1 = Math.max(y1, pp.y);
    }
    x0 = Math.max(1, Math.floor(x0)); x1 = Math.min(W - 2, Math.ceil(x1)); y0 = Math.max(1, Math.floor(y0)); y1 = Math.min(H - 2, Math.ceil(y1));
    const under = [], band = [], ring = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * W + x;
        if (!cleanGround(k)) continue;
        tmp.set(P[k * 4], P[k * 4 + 1], P[k * 4 + 2]);
        const gy = tmp.y;
        tmp.applyMatrix4(inv);
        const lx = tmp.x, lz = tmp.z, ly = tmp.y;
        if (Math.abs(ly - groundLocal) > 0.12) continue;        // a kerb top or a pavement, not the road it stands on
        const ax = Math.abs(lx), az = Math.abs(lz);
        if (ax <= 0.85 && az <= 0.85) under.push({ k, lx });
        else if ((ax >= 1.0 && ax <= 2.2 && az <= 2.3) || (ax <= 1.0 && az >= 2.35 && az <= 3.5)) band.push(k);
        else { const rr = Math.hypot(lx, lz); if (rr >= 3.5 && rr <= 6.0) ring.push(k); }
        void gy;
      }
    }
    return { kind: 'car', name, x: +c.x.toFixed(2), z: +c.z.toFixed(2), groundY: +c.y.toFixed(3),
      underbodyM: +(underLocal - groundLocal).toFixed(3), dist: +Math.hypot(c.x - camPos.x, c.z - camPos.z).toFixed(1),
      screen: [Math.round(q.x), Math.round(q.y)], under, band, ring };
  };
  if (D.car && D.car.group) {
    D.car.group.updateMatrixWorld(true);
    const s = carSubject('player', D.car.group.matrixWorld, -0.717, -0.525);
    if (s) subjects.push(s);
  }
  const parked = D.furniture && D.furniture.parked;
  if (parked && parked.meshes) {
    const cand = [];
    const mtx = new THREE.Matrix4(), pos = new THREE.Vector3();
    for (const m of parked.meshes) {
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      m.updateMatrixWorld(true);
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, mtx);
        if (Math.abs(mtx.elements[0]) + Math.abs(mtx.elements[2]) < 1e-6) continue;
        const wm = new THREE.Matrix4().multiplyMatrices(m.matrixWorld, mtx);
        pos.setFromMatrixPosition(wm);
        const qq = project(pos.x, pos.y, pos.z);
        if (qq.z > 1 || qq.x < 40 || qq.x > W - 40 || qq.y < 40 || qq.y > H - 20) continue;
        cand.push({ d: Math.hypot(pos.x - camPos.x, pos.z - camPos.z), wm, m, bb, i });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    // The underbody is CAR.sill, 0.192 m over the contact patch, in every shell: SHAPES varies the
    // width, the roof and the overhangs, never the sill (tools/shadow-floor reads it off the buffer).
    for (const c of cand.slice(0, 2)) {
      const s = carSubject(`parked#${c.i}:${c.m.name}`, c.wm, c.bb.min.y, c.bb.min.y + 0.192);
      if (s) subjects.push(s);
    }
  }
  // Pedestrians: the four nearest in frame, standing. The ground pixels in a 0.16 m corridor running
  // away from the sun from the body's centre, binned by distance.
  const peds = (D.pedestrianPositions ? D.pedestrianPositions() : []).filter((p) => !p.down);
  const pc = [];
  for (const p of peds) {
    const q = project(p.x, 0, p.z);
    if (q.z > 1 || q.x < 40 || q.x > W - 40 || q.y < 40 || q.y > H - 10) continue;
    pc.push({ ...p, d: Math.hypot(p.x - camPos.x, p.z - camPos.z) });
  }
  pc.sort((a, b) => a.d - b.d);
  for (const p of pc.slice(0, 4)) {
    const bins = new Map();
    let winGround = 0;
    // Its screen window: 1.6 m round it.
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const sx of [-1.6, 1.6]) for (const sz of [-1.6, 1.6]) for (const sy of [-1, 2]) {
      const pp = project(p.x + sx, sy, p.z + sz); if (pp.z > 1) continue;
      x0 = Math.min(x0, pp.x); x1 = Math.max(x1, pp.x); y0 = Math.min(y0, pp.y); y1 = Math.max(y1, pp.y);
    }
    x0 = Math.max(1, Math.floor(x0)); x1 = Math.min(W - 2, Math.ceil(x1)); y0 = Math.max(1, Math.floor(y0)); y1 = Math.min(H - 2, Math.ceil(y1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * W + x;
        if (!cleanGround(k)) continue;
        winGround++;
        const dx = P[k * 4] - p.x, dz = P[k * 4 + 2] - p.z;
        const along = -(dx * toSun.x + dz * toSun.z), across = Math.abs(-dx * toSun.z + dz * toSun.x);
        if (across > 0.08 || along < 0.05 || along > 1.55) continue;
        const b = Math.round(along / 0.05) * 0.05;
        const key = +b.toFixed(2);
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(k);
      }
    }
    const ray = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([d, pts]) => ({ d, pts }));
    const q = project(p.x, 0, p.z);
    const a = project(p.x, 0, p.z), b = project(p.x + 0.5, 0, p.z + 0.5);
    subjects.push({ kind: 'ped', name: `ped#${p.i}`, x: p.x, z: p.z, dist: +p.d.toFixed(1), winGround,
      screen: [Math.round(q.x), Math.round(q.y)], ray, pxPerM: +(Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(0.5, 0.5)).toFixed(1) });
  }

  // ---------------------------------------------------------------- ROUND 2: the sheet levers
  // Installed ONCE per page and reused by every hour, because a second wrap would declare the uniform
  // twice and fail to compile (src/materials.js's patch() says the same). Each family gets one
  // receiver uniform (an extra normal offset in its own shadow lookup) and one caster uniform (its
  // geometry drawn into the map along its own normals); both 0 is the shipped program exactly, and
  // the `repeat` arm checks that against `shipped` every run.
  const fams = { s: 'signage', t: 'facade trim (near LOD)' };
  if (!window.__sheetLever) {
    const u0 = () => ({ s: { value: 0 }, t: { value: 0 } });
    const lev = { r: u0(), c: u0(), k: u0(), l: u0(), texel: { value: 0 }, nb: { value: 0 }, mats: { s: 0, t: 0 }, meshes: { s: 0, t: 0 },
      shipped: { s: null, t: null }, shippedK: { s: null, t: null }, shippedCos: { s: null, t: null } };
    const SEAM = 'directionalLightShadows[ i ].shadowNormalBias';
    const chunk = THREE.ShaderChunk.shadowmap_vertex;
    if (!chunk.includes(SEAM)) throw new Error('shadowmap_vertex has no shadowNormalBias seam: the receiver lever would measure nothing');
    const patched = new Set();
    const depthMats = {};
    for (const who of ['s', 't']) {
      const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      dm.onBeforeCompile = (shader) => {
        if (!shader.vertexShader.includes('#include <begin_vertex>')) throw new Error('depth material has no begin_vertex seam');
        if (!shader.vertexShader.includes('#include <project_vertex>')) throw new Error('depth material has no project_vertex seam');
        shader.uniforms.uCasterOff = lev.c[who];
        shader.uniforms.uCasterK = lev.l[who];
        shader.uniforms.uSheetTexel = lev.texel;
        shader.uniforms.uSheetNBc = lev.nb;
        // `l`: in the light's own view space the ray is -z, so pushing mvPosition.z is a depth offset
        // that leaves the face's (u, v) — its silhouette in the map — exactly where it was. It pushes
        // only what the receiver's own normalBias does not already cover, K texels of slope less
        // normalBias / cos, so a face within ~15 degrees of the light is not moved at all; and the
        // angle is clamped where the sun lights a quarter of its beam (cos 0.25), past which acne is
        // not visible and a tangent would only grow.
        shader.vertexShader = 'uniform float uCasterOff;\nuniform float uCasterK;\nuniform float uSheetTexel;\nuniform float uSheetNBc;\n' + shader.vertexShader
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed += normalize( normal ) * uCasterOff;')
          .replace('#include <project_vertex>', ['#include <project_vertex>',
            '\tif ( uCasterK > 0.0 ) {',
            '\t\tvec3 sheetN = normalize( mat3( modelViewMatrix ) * normal );',
            '\t\tfloat sheetC = clamp( abs( sheetN.z ), 0.25, 1.0 );',
            '\t\tmvPosition.z -= max( 0.0, uCasterK * uSheetTexel * sqrt( 1.0 - sheetC * sheetC ) / sheetC - uSheetNBc / sheetC );',
            '\t\tgl_Position = projectionMatrix * mvPosition;',
            '\t}'].join('\n'));
      };
      dm.customProgramCacheKey = () => `casterOff:${who}`;
      depthMats[who] = dm;
    }
    scene.traverse((m) => {
      if (!m.isMesh || m.isInstancedMesh) return;
      const b = bucketOf(m);
      const who = b === fams.s ? 's' : b === fams.t ? 't' : null;
      if (!who) return;
      // A mesh the page already casts with src/sheetshadow.js's material keeps it: the `shipped` arm has
      // to be the shipped program, not this file's transcription of it. Its K is what an `l` arm on that
      // family sets (`ls0` is round 1's map on the same page), and a `c` arm on it is refused below.
      const shipped = m.customDepthMaterial && m.customDepthMaterial.userData && m.customDepthMaterial.userData.sheet;
      if (m.castShadow && shipped) {
        lev.shipped[who] = shipped.uniforms; lev.shippedK[who] = shipped.uniforms.uSheetK.value;
        lev.shippedCos[who] = shipped.uniforms.uSheetCos.value; lev.meshes[who]++;
      }
      else if (m.castShadow) { m.customDepthMaterial = depthMats[who]; lev.meshes[who]++; }
      if (!m.receiveShadow) return;
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
        if (!mat || !mat.isMeshStandardMaterial || patched.has(mat)) continue;
        patched.add(mat);
        const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
        mat.onBeforeCompile = (shader, rr) => {
          if (prev) prev.call(mat, shader, rr);
          if (!shader.vertexShader.includes('#include <shadowmap_vertex>')) throw new Error('no shadowmap_vertex include to patch');
          shader.uniforms.uSheetNB = lev.r[who];
          shader.uniforms.uSheetK = lev.k[who];
          shader.uniforms.uSheetTexel = lev.texel;
          // `k`: the sun's direction is the depth row of the shadow matrix, which IS in the vertex
          // shader, where the light's own direction uniform is not.
          const fn = ['uniform float uSheetNB;', 'uniform float uSheetK;', 'uniform float uSheetTexel;',
            'float sheetNormalBias( float nb, vec3 n, mat4 M ) {',
            '\tvec3 ld = normalize( vec3( M[ 0 ][ 2 ], M[ 1 ][ 2 ], M[ 2 ][ 2 ] ) );',
            '\tfloat c = clamp( abs( dot( normalize( n ), ld ) ), 0.0, 1.0 );',
            '\treturn nb + uSheetNB + max( 0.0, uSheetK * uSheetTexel * sqrt( 1.0 - c * c ) - nb );',
            '}', ''].join('\n');
          shader.vertexShader = fn + shader.vertexShader.replace('#include <shadowmap_vertex>',
            chunk.split(SEAM).join(`sheetNormalBias( ${SEAM}, shadowWorldNormal, directionalShadowMatrix[ i ] )`));
        };
        mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|sheetNB:${who}`;
        mat.needsUpdate = true;
        lev.mats[who]++;
      }
    });
    window.__sheetLever = lev;
  }
  const lever = window.__sheetLever;

  // ---------------------------------------------------------------- the arms
  const keep = {
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, intensity: sun.intensity,
    shadowIntensity: sun.shadow.intensity, mapSize: sun.shadow.mapSize.x,
    box: [sc.left, sc.right, sc.top, sc.bottom], pos: sun.position.clone(), tgt: sun.target.position.clone(),
    contact: D.carContact ? D.carContact.mesh.visible : null,
  };
  const span = sc.far - sc.near;
  const setMap = (size, half, centre) => {
    if (sun.shadow.mapSize.x !== size) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(size, size);
    }
    Object.assign(sc, { left: -half, right: half, top: half, bottom: -half });
    sc.updateProjectionMatrix();
    sun.target.position.copy(centre); sun.position.copy(centre).addScaledVector(sunDir, 400);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  };
  const reset = () => {
    sun.shadow.bias = keep.bias; sun.shadow.normalBias = keep.normalBias;
    sun.intensity = keep.intensity; sun.shadow.intensity = keep.shadowIntensity;
    if (sun.shadow.mapSize.x !== keep.mapSize) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(keep.mapSize, keep.mapSize);
    }
    Object.assign(sc, { left: keep.box[0], right: keep.box[1], top: keep.box[2], bottom: keep.box[3] });
    sc.updateProjectionMatrix();
    sun.position.copy(keep.pos); sun.target.position.copy(keep.tgt);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    if (D.carContact) D.carContact.mesh.visible = keep.contact;
    for (const who of ['s', 't']) for (const md of ['r', 'c', 'k', 'l']) lever[md][who].value = 0;
    for (const who of ['s', 't']) {
      const sh = lever.shipped[who];
      if (!sh) continue;
      sh.uSheetK.value = lever.shippedK[who];
      sh.uSheetCos.value = lever.shippedCos[who];
      sh.uSheetMap.value = keep.mapSize;
      sh.uSheetNB.value = keep.normalBias;
    }
    // The slope-scaled levers are in texels of the SHIPPED map; no arm moves the map and a sheet lever
    // together, since the references never carry one.
    lever.texel.value = (keep.box[1] - keep.box[0]) / keep.mapSize;
    lever.nb.value = keep.normalBias;
  };
  // THE REFERENCES CARRY THE SHIPPED SHEET RULE AT THEIR OWN MAP. A reference with no push has sheet
  // acne of its own — its 0.01 m bias and 0.02 normalBias are under its own kernel's reach on a grazing
  // valance — which flatters every arm measured against it (the same arms read 4-6 points cleaner
  // against it than against a pushed reference). So under ref and ref2 the page's own sheet material
  // reads the reference's map size and normalBias: the same rule, six and twelve times finer.
  const refSheets = () => {
    for (const who of ['s', 't']) {
      const sh = lever.shipped[who];
      if (!sh) continue;
      sh.uSheetMap.value = sun.shadow.mapSize.x;
      sh.uSheetNB.value = sun.shadow.normalBias;
    }
  };
  const setSheet = (p) => {
    const sh = lever.shipped[p.who];
    if (sh && p.mode === 'l') { sh.uSheetK.value = p.x; return; }
    if (p.mode === 'q') {
      if (!sh) throw new Error(`arm ${p.name}: the page does not cast that family with the shipped sheet depth`);
      sh.uSheetCos.value = p.x; return;
    }
    if (sh && p.mode === 'c') throw new Error(`arm ${p.name}: the page casts that family with the shipped sheet depth, which has no normal offset`);
    lever[p.mode][p.who].value = p.x;
  };
  const apply = (spec) => {
    reset();
    if (spec.kind === 'noShadow') sun.shadow.intensity = 0;
    else if (spec.kind === 'noSun') sun.intensity = 0;
    // The footprint under every car (src/carcontact.js) hidden: what the road under a car reads
    // with the lamps' shadow taken away. It multiplies L, L_noSun and L_noShadow alike, so the
    // shadow factor f cannot see it and the luma ratios are what this arm is for.
    else if (spec.kind === 'noContact') { if (D.carContact) D.carContact.mesh.visible = false; }
    else if (spec.kind === 'ref') { setMap(4096, refHalf, F); sun.shadow.bias = -0.01 / span; sun.shadow.normalBias = 0.02; refSheets(); }
    else if (spec.kind === 'ref2') { setMap(4096, refHalf / 2, F); sun.shadow.bias = -0.005 / span; sun.shadow.normalBias = 0.01; refSheets(); }
    else if (spec.kind === 'bias') { sun.shadow.bias = -spec.b / span; sun.shadow.normalBias = spec.nb; }
    else if (spec.kind === 'sheet') setSheet(spec);
    else if (spec.kind === 'combo') {
      for (const p of spec.parts) {
        if (p.kind === 'sheet') setSheet(p);
        else if (p.kind === 'bias') { sun.shadow.bias = -p.b / span; sun.shadow.normalBias = p.nb; }
        else throw new Error(`a combo takes bias and sheet parts, not ${p.kind}`);
      }
    }
    sun.shadow.needsUpdate = true;
  };
  const renderArm = (composite) => {
    if (composite) { post.render(); return { hdr: readHDR(), ldr: readLDR() }; }
    r.setRenderTarget(post.hdr); r.clear(); r.render(scene, cam); r.setRenderTarget(null);
    return { hdr: readHDR(), ldr: null };
  };

  const L = {};
  const ldr = {};
  const stripes = {};
  const timings = {};
  const shots = {};
  const order = ['noShadow', 'noSun', 'shipped', 'ref', 'ref2'];
  for (const s of armSpecs) if (!order.includes(s.name)) order.push(s.name);
  order.push('repeat');
  const specOf = (n) => (n === 'repeat' ? { name: 'repeat', kind: 'shipped' } : armSpecs.find((s) => s.name === n) ?? { name: n, kind: n });
  const results = {};
  for (const name of order) {
    const spec = specOf(name);
    const ta = performance.now();
    apply(spec);
    const comp = compositeArms.includes(name);
    const out = renderArm(comp);
    timings[name] = +((performance.now() - ta) / 1000).toFixed(1);
    L[name] = out.hdr;
    if (out.ldr) ldr[name] = out.ldr;
    if (comp && wantShots) shots[name] = pngOf();
    results[name] = {
      config: { bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, mapSize: sun.shadow.mapSize.x,
        half: sc.right, biasMetres: +(-sun.shadow.bias * span).toFixed(4) },
    };
    // Free what is no longer needed: arms past the controls only need their own frame for the census.
    if (!['noShadow', 'noSun', 'shipped', 'ref', 'ref2'].includes(name)) {
      results[name].census = censusFn(group, inRef, L.noSun, L.noShadow, L.ref, L.shipped, L[name], minShare, nGroups);
    }
  }
  reset();
  sun.shadow.needsUpdate = true;
  // The stripe statistic, once every arm is in: three masks over the reviewer's boxes. `full` is the
  // reviewer's statistic as stated; `fabric` keeps pixels of the shop signage or the facade trim that
  // face the sun; `flat` keeps those of them whose own 5x5 neighbourhood is flat in the UNSHADOWED
  // composited frame (L/box5(L) within 4% of 1), so lettering and shut lines are out and what is left
  // can only gain structure from the shadow.
  if (boxes && ldr.noShadow) {
    const fab = new Uint8Array(W * H), flat = new Uint8Array(W * H);
    const E = ldr.noShadow.enc;
    for (let k = 0; k < W * H; k++) {
      if (group[k] !== 8 && group[k] !== 9) continue;
      const L0 = L.noSun[k], Lns = L.noShadow[k], sunPart = Lns - L0;
      if (Lns > 0 && sunPart > 0 && sunPart / Lns >= minShare) fab[k] = 1;
    }
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
      const k = y * W + x;
      if (!fab[k]) continue;
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m += E[(y + dy) * W + x + dx];
      m /= 25;
      if (m > 0 && Math.abs(E[k] / m - 1) < 0.04) flat[k] = 1;
    }
    for (const name of Object.keys(ldr)) {
      const enc = ldr[name].enc;
      stripes[name] = {};
      for (const [bn, bx] of Object.entries(boxes)) {
        const read = (mask) => { const e = stripeOf(enc, W, H, bx, mask); return e ? { std: +e.std.toFixed(5), n: e.n } : null; };
        // The box's mean encoded luma beside it, so a lever that darkened the whole canopy cannot pass
        // for one that removed the stripes.
        let sm = 0, sn = 0;
        for (let y = bx[1]; y < bx[3]; y++) for (let x = bx[0]; x < bx[2]; x++) { sm += enc[y * W + x]; sn++; }
        stripes[name][bn] = { full: read(null), fabric: read(fab), flat: read(flat), mean: +(sm / sn).toFixed(2) };
      }
    }
  }
  results.shipped.census = censusFn(group, inRef, L.noSun, L.noShadow, L.ref, L.shipped, L.shipped, minShare, nGroups);
  // ref against ref2 inside ref2's box: the reference's own convergence.
  results.ref2.census = censusFn(group, inRef2, L.noSun, L.noShadow, L.ref, L.ref, L.ref2, minShare, nGroups);
  // Registration: the shipped arm rendered again, last.
  let regMax = 0;
  for (let i = 0; i < W * H; i++) { const d = Math.abs(L.repeat[i] - L.shipped[i]) / Math.max(1e-6, L.shipped[i]); if (d > regMax && L.shipped[i] > 1e-3) regMax = d; }

  // ---------------------------------------------------------------- maps: where the census counted
  // Grey is the arm's own HDR frame through a plain exposure curve; BLUE is acne (lit in the reference,
  // half shadowed or worse in the arm), RED is leak (shadowed in the reference, half lit or more in the
  // arm), both only where the census reads; pixels outside the reference box are dimmed.
  const maps = {};
  const expo = D.post.params.exposure;
  for (const name of mapArms) {
    if (!L[name]) continue;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); const im = ctx.createImageData(W, H);
    const A = L[name];
    for (let k = 0; k < W * H; k++) {
      let v = 255 * (1 - Math.exp(-A[k] * expo * 4));
      if (!inRef[k]) v *= 0.35;
      let rr = v, gg = v, bb = v;
      const L0 = L.noSun[k], Lns = L.noShadow[k], sun = Lns - L0;
      if (inRef[k] && Lns > 0 && sun > 0 && sun / Lns >= minShare) {
        const f = (A[k] - L0) / sun, fr = (L.ref[k] - L0) / sun;
        // Round 2 marks PARTIAL acne, lit in the reference and losing over 0.15 of it, since that is
        // what a sheet's stripes are; leak as before.
        if (fr >= 0.9 && f < fr - 0.15) { rr = 30; gg = 60; bb = 255; }
        else if (fr <= 0.1 && f >= 0.5) { rr = 255; gg = 40; bb = 30; }
      }
      im.data[k * 4] = rr; im.data[k * 4 + 1] = gg; im.data[k * 4 + 2] = bb; im.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    maps[name] = cv.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- the subjects, per arm
  const fAt = (name, k) => {
    const L0 = L.noSun[k], Lns = L.noShadow[k], v = L[name][k];
    const s = Lns - L0;
    if (!(Lns > 0) || !(s > 0) || s / Lns < minShare) return null;
    return (v - L0) / s;
  };
  const meanF = (name, ks) => { let s = 0, n = 0; for (const k of ks) { const f = fAt(name, k); if (f !== null) { s += f; n++; } } return n ? s / n : null; };
  const meanL = (arr, ks) => { let s = 0, n = 0; for (const k of ks) { const v = arr[k]; if (Number.isFinite(v)) { s += v; n++; } } return n ? s / n : null; };
  const subjectsOut = subjects.map((s) => {
    const row = { kind: s.kind, name: s.name, dist: s.dist, screen: s.screen, winGround: s.winGround };
    if (s.kind === 'car') {
      Object.assign(row, { underbodyM: s.underbodyM, nUnder: s.under.length, nBand: s.band.length, nRing: s.ring.length });
      const uk = s.under.map((u) => u.k);
      // The band split by what the REFERENCE says: shadowed band and lit ring, so "the car's own
      // shadow" and "open road" are read off the truth rather than off a geometry guess.
      const bandDark = s.band.filter((k) => { const f = fAt('ref', k); return f !== null && f <= 0.1; });
      const ringLit = s.ring.filter((k) => { const f = fAt('ref', k); return f !== null && f >= 0.95; });
      row.nBandDark = bandDark.length; row.nRingLit = ringLit.length;
      row.arms = {};
      for (const name of order) {
        row.arms[name] = {
          fUnder: meanF(name, uk), fBandDark: meanF(name, bandDark), fRingLit: meanF(name, ringLit),
          lUnderOverRing: (() => { const a = meanL(L[name], uk), b = meanL(L[name], ringLit); return a !== null && b ? a / b : null; })(),
          lUnderOverBand: (() => { const a = meanL(L[name], uk), b = meanL(L[name], bandDark); return a !== null && b ? a / b : null; })(),
          ldrUnderOverRing: ldr[name] ? (() => { const a = meanL(ldr[name], uk), b = meanL(ldr[name], ringLit); return a !== null && b ? a / b : null; })() : null,
          ldrUnderOverBand: ldr[name] ? (() => { const a = meanL(ldr[name], uk), b = meanL(ldr[name], bandDark); return a !== null && b ? a / b : null; })() : null,
          // The whole ring, whatever lights it: at night the moon is under a tenth of the light on the
          // road, f cannot be read, and what the road under a car reads against the road round it is
          // the whole question.
          lUnderOverRingAll: (() => { const a = meanL(L[name], uk), b = meanL(L[name], s.ring); return a !== null && b ? a / b : null; })(),
          ldrUnderOverRingAll: ldr[name] ? (() => { const a = meanL(ldr[name], uk), b = meanL(ldr[name], s.ring); return a !== null && b ? a / b : null; })() : null,
        };
      }
      // Under the car, row by row inward from the visible sill, so a partial shadow is located.
      row.underByDepth = {};
      for (const name of ['shipped', 'ref', ...armSpecs.map((a) => a.name)]) {
        const byLx = new Map();
        for (const u of s.under) {
          const f = fAt(name, u.k); if (f === null) continue;
          const key = +(Math.round(u.lx * 10) / 10).toFixed(1);
          const e = byLx.get(key) ?? [0, 0]; e[0] += f; e[1]++; byLx.set(key, e);
        }
        row.underByDepth[name] = [...byLx.entries()].sort((a, b) => a[0] - b[0]).map(([lx, [sum, n]]) => [lx, +(sum / n).toFixed(3), n]);
      }
    } else {
      row.pxPerM = s.pxPerM;
      row.ds = s.ray.map((q) => q.d);
      row.arms = {};
      for (const name of order) row.arms[name] = s.ray.map((q) => { const m = meanF(name, q.pts); return m === null ? null : +m.toFixed(3); });
    }
    return row;
  });
  return {
    W, H, elevationDeg: +(elevation * 180 / Math.PI).toFixed(2), refHalf, minShare,
    F: [+F.x.toFixed(1), +F.y.toFixed(2), +F.z.toFixed(1)],
    groupCount, inRefCount: inRef.reduce((a, b) => a + b, 0), inRef2Count: inRef2.reduce((a, b) => a + b, 0),
    buckets: bucketNames.map((b, i) => ({ bucket: b, group: groupOf(b), px: bucketPx[i] })).filter((b) => b.px > 0)
      .sort((a, b) => b.px - a.px),
    registration: { maxRelDiff: regMax }, timings, subjects: subjectsOut, stripes,
    sheetLever: { mats: lever.mats, meshes: lever.meshes, shippedK: lever.shippedK },
    census: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { config: v.config, census: v.census ?? null }])),
    shots, maps, seconds: +((performance.now() - t0) / 1000).toFixed(1),
  };
}

// ------------------------------------------------------------------------------------ the live half
if (IS_MAIN && !has('selftest')) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  const { HERO_FRAMINGS, placeHeroCam, settleFrames } = await import('./hero-cams.mjs');
  const PORT = Number(arg('port', 0));
  if (!PORT || PORT === 8123) { console.error('--port is required and may not be 8123 (the main tree)'); process.exit(2); }
  const CAM = arg('cam', 'fivepoints');
  const TODS = arg('tods', 'noon').split(',');
  const ARMS = arg('arms', 'shipped').split(',').filter(Boolean);
  const TAG = arg('tag', 'shadowbias');
  const REF = Number(arg('ref', 40));
  const COMPOSITE = arg('composite', 'shipped').split(',').filter(Boolean);
  const SHOTS = has('shots');
  const MAPS = arg('maps', '').split(',').filter(Boolean);
  // Where the frames, maps and the JSON go. docs/ by default, like every capture tool here; a sweep
  // run for a round's own reading belongs in a scratch directory, not in the repo.
  const OUT = arg('out', 'docs');
  fs.mkdirSync(`${OUT}/shots`, { recursive: true });
  const SETTLE = Number(arg('settle', 6));
  // ROUND 2: --stripes measures the reviewer's stripe statistic in the reviewer's boxes for this
  // framing (or --boxes name:x0,y0,x1,y1;...), and composites EVERY arm so each one has a frame.
  const STRIPES = has('stripes') || !!arg('boxes', null);
  const BOX = arg('boxes', null)
    ? Object.fromEntries(arg('boxes', '').split(';').filter(Boolean).map((t) => {
      const [nm, v] = t.split(':'); const b = v.split(',').map(Number);
      if (b.length !== 4 || !b.every(Number.isFinite)) { console.error(`bad --boxes entry ${t}`); process.exit(2); }
      return [nm, b];
    }))
    : (STRIPES ? BOXES[CAM] ?? null : null);
  if (STRIPES && !BOX) { console.error(`no stripe boxes for --cam ${CAM}; pass --boxes`); process.exit(2); }
  const framing = HERO_FRAMINGS.find((f) => f.name === CAM);
  if (!framing) { console.error(`unknown --cam ${CAM}`); process.exit(2); }
  for (const t of TODS) if (!PRESETS[t]) { console.error(`unknown tod ${t}`); process.exit(2); }

  const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
  console.log(`server: ${srv.started ? 'started' : 'reused'} :${srv.port} root=${srv.root}`);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 600000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
  const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
  console.log(`cloud deck: ${froze ? `frozen at ${froze.atSeconds}s` : 'NOT FROZEN'}`);
  const placed = await placeHeroCam(page, framing);
  console.log(`${CAM}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ${placed.clearance} m clear`);
  await settleFrames(page, 30, `camera ${CAM}`);

  const all = { tag: TAG, cam: CAM, port: PORT, placed, arms: ARMS, hours: {}, errors };
  for (const tod of TODS) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await settleFrames(page, SETTLE, `tod ${tod}`);
    const el = PRESETS[tod].elevation;
    const armSpecs = ARMS.filter((n) => !['shipped', 'noShadow', 'noSun', 'ref', 'ref2'].includes(n)).map((n) => parseArm(n, el));
    const contactNow = await page.evaluate(() => (__district.carContactReport ? __district.carContactReport() : null));
    console.log(`  car contact footprint: ${JSON.stringify(contactNow)}`);
    const minShare = Number(arg('minShare', tod === 'night' ? 0.10 : 0.25));
    const t0 = Date.now();
    const out = await page.evaluate(measureInPage, {
      armSpecs, refHalf: REF, minShare, bucketSrc: bucketSource, censusSrc: censusSource, groupSrc: groupSource,
      nGroups: GROUPS.length, wantShots: SHOTS, mapArms: MAPS,
      compositeArms: STRIPES ? ['noShadow', 'noSun', 'shipped', 'ref', 'ref2', ...ARMS, 'repeat'] : COMPOSITE,
      boxes: BOX, stripeSrc: stripeSource,
    });
    console.log(`\n=== ${CAM} / ${tod}  (sun ${out.elevationDeg} deg, ${((Date.now() - t0) / 1000).toFixed(0)} s, ` +
      `registration max rel diff ${out.registration.maxRelDiff.toExponential(2)})`);
    console.log(`  arm timings (s): ${Object.entries(out.timings).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  reference box +-${out.refHalf} m round (${out.F.join(', ')}): ${out.inRefCount} px inside, ref2 ${out.inRef2Count}`);
    console.log(`  pixels by group: ${GROUPS.map((g, i) => `${g} ${out.groupCount[i]}`).join(', ')}`);
    for (const [name, c] of Object.entries(out.census)) {
      const cfg = c.config;
      console.log(`  arm ${name.padEnd(12)} bias ${cfg.biasMetres} m  normalBias ${cfg.normalBias}  map ${cfg.mapSize} +-${cfg.half}` +
        (name.startsWith('b') || name.startsWith('e') || name === 'shipped' ? `  vertical tolerance ${verticalTolerance(cfg.biasMetres, cfg.normalBias, el).toFixed(3)} m` : ''));
    }
    // CONTACT
    for (const s of out.subjects) {
      if (s.kind === 'car') {
        console.log(`\n  ${s.name} at ${s.dist} m, screen ${s.screen}, underbody ${s.underbodyM} m: ` +
          `${s.nUnder} road points under the body seen, band ${s.nBand} (${s.nBandDark} dark in ref), ring ${s.nRing} (${s.nRingLit} lit in ref)`);
        console.log('    arm            f under  f band   f ring   L under/ring  L under/band  seen under/ring  seen under/band   L under/all ring  seen under/all ring');
        for (const [name, a] of Object.entries(s.arms)) {
          const f = (v, d = 3) => (v === null || v === undefined ? '   -   ' : v.toFixed(d).padStart(7));
          console.log(`    ${name.padEnd(13)} ${f(a.fUnder)}  ${f(a.fBandDark)}  ${f(a.fRingLit)}   ${f(a.lUnderOverRing, 4)}       ${f(a.lUnderOverBand, 4)}        ${f(a.ldrUnderOverRing, 4)}         ${f(a.ldrUnderOverBand, 4)}           ${f(a.lUnderOverRingAll, 4)}            ${f(a.ldrUnderOverRingAll, 4)}`);
        }
        console.log('    f under the body by lateral position in the car (lx m: f, n):');
        for (const [name, rows] of Object.entries(s.underByDepth)) {
          console.log(`      ${name.padEnd(12)} ${rows.map(([lx, f, n]) => `${lx}:${f}/${n}`).join('  ')}`);
        }
      } else {
        const idx = s.ds.map((d, i) => [d, i]).filter(([d]) => [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5].some((q) => Math.abs(q - d) < 1e-6));
        console.log(`\n  ${s.name} at ${s.dist} m (${s.pxPerM} px/m, ${s.winGround} clean ground px within 1.6 m), f along the ground away from the sun:`);
        console.log('    arm          ' + idx.map(([d]) => `${d.toFixed(2)}m`.padStart(7)).join(''));
        for (const [name, a] of Object.entries(s.arms)) console.log(`    ${name.padEnd(12)} ` + idx.map(([, i]) => String(a[i] ?? '-').padStart(7)).join(''));
      }
    }
    // ACNE / LEAK. The printed groups are round 1's five plus signage, which is where the awnings are.
    const PG = [1, 2, 3, 9, 4, 5, 8];
    console.log('\n  census over sun-facing pixels inside the reference box (acne: lit in ref, f<=0.5; leak: dark in ref, f>=0.5)');
    console.log('    arm            ' + PG.map((g) => GROUPS[g].padStart(26)).join(''));
    for (const [name, c] of Object.entries(out.census)) {
      if (!c.census) continue;
      const cells = PG.map((g) => {
        const rr = rates(c.census[g]);
        const p = (v) => (v === null ? '  -  ' : (100 * v).toFixed(1).padStart(5));
        return `${p(rr.acne)}/${p(rr.leak)} f${rr.meanF === null ? ' -  ' : rr.meanF.toFixed(2)} n${String(rr.n).padStart(6)}`.padStart(26);
      });
      console.log(`    ${name.padEnd(13)} ${cells.join('')}`);
    }
    console.log('  the same in pixels, acne/refLit  leak/refDark:');
    for (const [name, c] of Object.entries(out.census)) {
      if (!c.census) continue;
      const cells = PG.map((g) => {
        const o = c.census[g];
        return `${o.acne}/${o.refLit} ${o.leak}/${o.refDark}`.padStart(26);
      });
      const tot = PG.reduce((a, g) => a + c.census[g].acne + c.census[g].leak, 0);
      console.log(`    ${name.padEnd(13)} ${cells.join('')}   errors ${tot}`);
    }
    // ROUND 2: partial acne — how much of the reference's sun a LIT pixel loses, mean over the lit
    // pixels, and the share of them that lose more than 0.15 of it.
    console.log('  partial acne on lit pixels (mean sun lost x1000 / % losing over 0.15):');
    console.log('    arm            ' + PG.map((g) => GROUPS[g].padStart(16)).join(''));
    for (const [name, c] of Object.entries(out.census)) {
      if (!c.census) continue;
      const cells = PG.map((g) => {
        const rr = rates(c.census[g]);
        return (rr.dark === null ? '-' : `${(1000 * rr.dark).toFixed(1)} / ${(100 * rr.partial).toFixed(2)}%`).padStart(16);
      });
      console.log(`    ${name.padEnd(13)} ${cells.join('')}`);
    }
    if (out.stripes && Object.keys(out.stripes).length) {
      const names = Object.keys(out.stripes);
      const bn = Object.keys(out.stripes[names[0]] ?? {});
      // The BEFORE build's bias, when the run carries it, is the reviewer's own comparison: their
      // x2.66 and x3.11 were AFTER over BEFORE. The reference can carry legitimate structure of its
      // own (a crisper shadow edge across the box), so both ratios are printed.
      const refS = out.stripes.ref ?? {}, befS = out.stripes['b0.5394n0.06'] ?? null;
      console.log(`\n  STRIPE ENERGY, the reviewer's statistic (std of L/box5(L) on the composited frame's encoded luma),`);
      console.log(`  in the reviewer's boxes: over the FULL box, over the sun-facing FABRIC (signage or trim, whole`);
      console.log(`  5x5 window), and over the fabric that is FLAT in the unshadowed frame; x is against the`);
      console.log(`  4096-texel reference arm, which has no acne, b against the BEFORE build's bias (0.5394 m) when`);
      console.log(`  the run carries it, and the box's mean luma is last`);
      for (const b of bn) {
        console.log(`    ${b}`);
        console.log(`      arm              ${['full', 'fabric', 'flat'].map((m) => m.padStart(31)).join('')}     L`);
        for (const name of names) {
          const e = out.stripes[name][b];
          if (!e) { console.log(`      ${name.padEnd(16)} -`); continue; }
          const cells = ['full', 'fabric', 'flat'].map((m) => {
            const v = e[m], r = refS[b]?.[m], bb = befS?.[b]?.[m];
            if (!v) return '-'.padStart(31);
            const x = r && r.std > 0 ? (v.std / r.std).toFixed(2) : '-';
            const xb = bb && bb.std > 0 ? ` b${(v.std / bb.std).toFixed(2)}` : '';
            return `${v.std.toFixed(4)} x${x}${xb} n${v.n}`.padStart(31);
          });
          console.log(`      ${name.padEnd(16)} ${cells.join('')}  ${String(e.mean).padStart(6)}`);
        }
      }
      console.log(`  sheet lever installed on: ${JSON.stringify(out.sheetLever)}`);
    }
    if (SHOTS) {
      for (const [name, url] of Object.entries(out.shots)) {
        const f = `${OUT}/shots/${TAG}-${CAM}-${tod}-${name}.png`;
        fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
        console.log(`  wrote ${f}`);
      }
    }
    for (const [name, url] of Object.entries(out.maps ?? {})) {
      const f = `${OUT}/shots/${TAG}-${CAM}-${tod}-map-${name}.png`;
      fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`  wrote ${f}`);
    }
    console.log(`  pixels by bucket: ${out.buckets.map((b) => `${b.bucket} [${GROUPS[b.group]}] ${b.px}`).join(', ')}`);
    delete out.shots; delete out.maps;
    all.hours[tod] = out;
  }
  fs.writeFileSync(`${OUT}/${TAG}-${CAM}.json`, JSON.stringify(all, null, 1));
  console.log(`\nwrote ${OUT}/${TAG}-${CAM}.json`);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  await browser.close();
}
