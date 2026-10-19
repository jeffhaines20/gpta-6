// THE GATE FOR THE NUMBER PLATE'S FACE (src/carbody.js PLATE) AND THE LAMPS' FACES (LAMP_U).
// See tools/car-detail.html.
//
//   node tools/car-detail.mjs              build the plates, render them, check both
//   node tools/car-detail.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// The plate was blank — "a uniform field with no characters", in both arms of the cabin's blind
// review — and the wrong shape: 0.46-0.49 m by 0.13 m, a European plate, where a US plate is 12 x 6
// in. Two halves, and the gate checks both where each can be measured:
//
//   OFFLINE, off the built buffers: every fleet shell and the player's car carries a plate of
//   exactly 0.3048 x 0.1524 m, flat, whose uv.y runs 0 at its foot to 1 at its head (the face's own
//   coordinate), and no body vertex stands behind it inside its outline. And the player's door
//   mirrors show their glass to the back of the car and none of it to the side (#133): the first
//   build laid the mirror on its side, so a camera beside the car saw 144 cm2 of glass and one
//   behind it 33 cm2, most of that a face buried in the housing.
//
//   IN THE PAGE, through the real instanced material, from behind at street height:
//     the face is there      most of the near plate changes, and some of it becomes ink
//     and nowhere else       no pixel off the plate moves by more than 2 levels
//     filtered               at 16 m, where a font pixel is a third of a screen pixel, the plate
//                            integrates to the same face as near, and no pixel reaches the full
//                            darkness of a stroke — the signature of a sampled-not-filtered font
//     per car                a second instance carries different characters
//     on the player too      the player's car has the face (its plate is on its own build)
//
//   THE LAMPS, on a white car, against a census of photographed lamps (BACKLOG, "the lamps by day"):
//     by day                 the flat lamp is a white field (the before-arm, measured as the defect)
//                            and the face sits inside the photographed band against its own paint
//     with structure         p90/p50 and the share over twice the median, both inside the census's
//     a tail with an insert  a dark red lens a tenth of the paint, its reverse insert the bright part
//     and nowhere else       nothing off the lamps moves
//     at night               the lit headlamp is not put out, and the reverse insert stays dark
//                            while the red round it glows
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';
import { buildTrafficCarGeometry, buildPlayerCar, SHAPES, SURFACE, paletteU } from '../src/carbody.js';

/**
 * A US plate is 12 x 6 inches, WRITTEN OUT HERE rather than imported: comparing the build against
 * the module's own PLATE constant would let a wrong constant move the plate and the expectation
 * together and agree with itself (CLAUDE.md, the shunt-fit ladder).
 */
const US_PLATE = { w: 12 * 0.0254, h: 6 * 0.0254 };

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/car-detail.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 23;
/** The render order: [which face, its value] per tile, rows top to bottom (see car-detail.html). */
export const PLANNED = [...Array(4)].flatMap(() => [['plate', 0], ['plate', 1]])
  .concat([...Array(5)].flatMap(() => [['lamp', 0], ['lamp', 1]]));

/** The plate off each built buffer: its extent, its uv.y, and anything standing behind it. */
export function plateGeometry() {
  const one = (name, geo) => {
    const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
    const u = paletteU(SURFACE.plate);
    const pl = [];
    for (let i = 0; i < pos.count; i++) if (Math.abs(uv.getX(i) - u) < 1e-4) pl.push([pos.getX(i), pos.getY(i), pos.getZ(i), uv.getY(i)]);
    if (!pl.length) return { name, verts: 0 };
    const xs = pl.map((p) => p[0]), ys = pl.map((p) => p[1]), zs = pl.map((p) => p[2]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const zPlate = Math.min(...zs), zSpread = Math.max(...zs) - zPlate;
    // uv.y must be the face's own vertical: 0 on the lowest corners, 1 on the highest.
    const vOk = pl.every((p) => Math.abs(p[3] - (p[1] - y0) / (y1 - y0)) < 1e-6);
    let behind = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(uv.getX(i) - u) < 1e-4) continue;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x > x0 && x < x1 && y > y0 && y < y1 && z < zPlate) behind++;
    }
    return { name, verts: pl.length, w: x1 - x0, h: y1 - y0, zSpread, vOk, behind, cx: (x0 + x1) / 2 };
  };
  const out = ['coupe', 'saloon', 'wagon'].map((s) => one(s, buildTrafficCarGeometry({ groundY: 0, shape: SHAPES[s] })));
  out.push(one('player', buildPlayerCar().bodyMesh.geometry));
  return out;
}

/**
 * THE DOOR MIRRORS' GLASS, per side, off the player's BODY buffer: the only glazing-slot texels on
 * that material are mirror glass, because its panes are on their own `carGlassMaterial` (src/carbody.js
 * says so where it defines CAR_NO_CABIN). For each side, the glass's whole area and how much of it a
 * camera BESIDE the car (outboard, along +-x), BEHIND it (along -z) and AHEAD of it (along +z) sees,
 * each as the area projected on that direction. A triangle counts as glass only if all three corners
 * are on the slot, so a mixed one cannot leak in.
 */
export function mirrorGeometry() {
  const g = buildPlayerCar().bodyMesh.geometry;
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv'), idx = g.getIndex();
  const n = idx ? idx.count / 3 : pos.count / 3;
  const at = (t, k) => (idx ? idx.getX(3 * t + k) : 3 * t + k);
  const slot = (i) => Math.floor(uv.getX(i) * 16);
  const sides = { 1: { side: 1, tris: 0, area: 0, beside: 0, behind: 0, ahead: 0 },
    [-1]: { side: -1, tris: 0, area: 0, beside: 0, behind: 0, ahead: 0 } };
  for (let t = 0; t < n; t++) {
    const v = [0, 1, 2].map((k) => at(t, k));
    if (!v.every((i) => slot(i) === SURFACE.glassy)) continue;
    const [a, b, c] = v.map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    // Half the cross product: its length is the area and its direction the face normal (CCW = front).
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]].map((q) => q / 2);
    const s = sides[(a[0] + b[0] + c[0]) > 0 ? 1 : -1];
    s.tris++;
    s.area += Math.hypot(...cr);
    s.beside += Math.max(0, cr[0] * s.side);
    s.behind += Math.max(0, -cr[2]);
    s.ahead += Math.max(0, cr[2]);
  }
  return [sides[1], sides[-1]];
}

/**
 * THE FLEET'S DOOR MIRRORS, per shell and side, off each traffic shell's buffer. #133's review: "the
 * traffic cars' mirrors are plain cubes with no glass (only the player's car changed)". Unlike the
 * player's body, a traffic shell's glazing slot also carries its windows, so the mirror's glass is
 * isolated by WHERE it is: every corner outboard of 0.94 m, where the mirror housing runs 0.935 to
 * 1.045 and no shell's side glass reaches past 0.924 (measured 2026-10-19). Same projections as above.
 */
export function fleetMirrorGeometry() {
  const out = [];
  for (const shape of ['coupe', 'saloon', 'wagon']) {
    const g = buildTrafficCarGeometry({ groundY: 0, shape: SHAPES[shape] });
    const pos = g.getAttribute('position'), uv = g.getAttribute('uv'), idx = g.getIndex();
    const n = idx ? idx.count / 3 : pos.count / 3;
    const at = (t, k) => (idx ? idx.getX(3 * t + k) : 3 * t + k);
    const slot = (i) => Math.floor(uv.getX(i) * 16);
    const sides = { 1: { shape, side: 1, tris: 0, area: 0, beside: 0, behind: 0, ahead: 0 },
      [-1]: { shape, side: -1, tris: 0, area: 0, beside: 0, behind: 0, ahead: 0 } };
    for (let t = 0; t < n; t++) {
      const v = [0, 1, 2].map((k) => at(t, k));
      if (!v.every((i) => slot(i) === SURFACE.glassy && Math.abs(pos.getX(i)) >= 0.94)) continue;
      const [a, b, c] = v.map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]].map((q) => q / 2);
      const sd = sides[a[0] > 0 ? 1 : -1];
      sd.tris++;
      sd.area += Math.hypot(...cr);
      sd.beside += Math.max(0, cr[0] * sd.side);
      sd.behind += Math.max(0, -cr[2]);
      sd.ahead += Math.max(0, cr[2]);
    }
    out.push(sides[1], sides[-1]);
  }
  return out;
}

/** The verdict as a pure function of the report, so the selftest can feed it known-bads. */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const num = (v) => (Number.isFinite(v) ? v : null);
  const G = Array.isArray(r.geometry) ? r.geometry : [];
  add('every fleet shell and the player\'s car carries a plate', G.length === 4 && G.every((g) => g.verts >= 4),
    G.map((g) => `${g.name} ${g.verts}`).join(', '));
  add('a US plate, 12 x 6 in, on every one of them, to a millimetre',
    G.length === 4 && G.every((g) => Math.abs(g.w - US_PLATE.w) < 1e-3 && Math.abs(g.h - US_PLATE.h) < 1e-3),
    G.map((g) => `${g.name} ${num(g.w)?.toFixed(4)} x ${num(g.h)?.toFixed(4)}`).join(', '));
  add('flat, centred, carrying its own vertical in uv.y, with no body standing behind it',
    G.length === 4 && G.every((g) => g.zSpread < 1e-6 && Math.abs(g.cx) < 1e-6 && g.vOk && g.behind === 0),
    G.map((g) => `${g.name} z-spread ${num(g.zSpread)?.toExponential(1)} v ${g.vOk} behind ${g.behind}`).join(', '));
  /**
   * #133. 0.9 of the glass toward the back allows a toe-in up to 26 degrees (the build's is 11.5); 5% to
   * the side refuses a toe the wrong way, which shows the outboard camera sin(toe) of the glass — 20% at
   * the build's own angle. And at least 100 cm2 a side, so a car with no mirror glass cannot pass.
   */
  const M = Array.isArray(r.mirrors) ? r.mirrors : [];
  const cm2 = (v) => (num(v) === null ? 'n/a' : (v * 1e4).toFixed(1));
  add('the player\'s door mirrors show their glass to the back of the car, and none of it to the side',
    M.length === 2 && M.every((m) => num(m.area) >= 0.01 && num(m.behind) >= 0.9 * m.area
      && num(m.beside) <= 0.05 * m.area && num(m.ahead) === 0),
    M.map((m) => `${m.side > 0 ? '+x' : '-x'}: ${cm2(m.area)} cm2, behind ${cm2(m.behind)}, beside ${cm2(m.beside)}, ahead ${cm2(m.ahead)}`).join('; '));
  // The fleet's: every shell, both sides, at least 50 cm2 (the pane is 9 x 6.4 cm), all of it to the back.
  const FM = Array.isArray(r.fleetMirrors) ? r.fleetMirrors : [];
  add('every fleet shell\'s door mirrors carry glass, and it faces the back of the car',
    FM.length === 6 && FM.every((m) => num(m.area) >= 0.005 && num(m.behind) >= 0.99 * m.area
      && num(m.beside) <= 0.01 * m.area && num(m.ahead) === 0),
    FM.map((m) => `${m.shape} ${m.side > 0 ? '+x' : '-x'} ${cm2(m.area)} cm2, behind ${cm2(m.behind)}`).join('; ') || 'none');

  add('the build ships the face ON', num(r.shipped) === 1, `shipped ${r.shipped}`);
  const rb = r.readback ?? [];
  add('every render\'s switch is what it asked for, read back off the material\'s own uniform',
    rb.length === PLANNED.length && PLANNED.every((k, i) => Array.isArray(rb[i]) && rb[i][0] === k[0] && rb[i][1] === k[1]),
    `${rb.length} of ${PLANNED.length} tiles`);

  const N = r.near ?? {}, F = r.far ?? {}, O = r.other ?? {}, P = r.player ?? {};
  const changed = (x) => (num(x.plateChanged) ?? 0) / Math.max(1, num(x.platePx) ?? 0);
  add('the face is there: most of the near plate changes, and some of it is ink',
    num(N.platePx) >= 120 && changed(N) >= 0.4 && num(N.inkFrac) >= 0.08 && num(N.inkFrac) <= 0.4,
    `${N.plateChanged} of ${N.platePx} px changed (${(100 * changed(N)).toFixed(1)}%), ink ${(100 * (num(N.inkFrac) ?? 0)).toFixed(1)}%`);
  const leaks = [N, F, O, P].map((x) => num(x.otherChanged2));
  add('and nowhere else: no pixel off the plate moves by more than 2 levels, in any row',
    leaks.every((v) => v === 0) && [N, F, O, P].every((x) => num(x.otherPx) > 0),
    `${leaks.join(' / ')} px; max ${[N, F, O, P].map((x) => x.otherMax).join(' / ')} levels`);
  const nearR = num(N.meanOn) !== null && num(N.meanOff) > 0 ? N.meanOn / N.meanOff : null;
  const farR = num(F.meanOn) !== null && num(F.meanOff) > 0 ? F.meanOn / F.meanOff : null;
  /**
   * FILTERED, TWO WAYS. At 16 m a font pixel is about a third of a screen pixel. A face that is
   * filtered integrates to the same ink there as near (0.779 of the blank against 0.761 near), and no
   * pixel can be a whole stroke (the darkest far pixel is 0.52 of the blank, where a near stroke is
   * 0.066). The first cut's edge could widen past a font pixel and inked bare plate at 15.6%: the far
   * plate read 0.551 against 0.761 near.
   */
  add('filtered: at 16 m the plate integrates to the same face as it does near',
    num(F.platePx) >= 8 && nearR !== null && farR !== null && Math.abs(farR - nearR) <= 0.1,
    `far ${farR?.toFixed(3)} of the blank against near ${nearR?.toFixed(3)}, over ${F.platePx} px`);
  add('and no far pixel reaches the darkness of a whole stroke',
    num(F.minOnRatio) !== null && F.minOnRatio >= 0.3 && num(N.minOnRatio) !== null && N.minOnRatio < 0.3,
    `darkest far px ${num(F.minOnRatio)?.toFixed(3)} of the blank; near strokes reach ${num(N.minOnRatio)?.toFixed(3)}`);
  const T = r.twoCars ?? {};
  add('per car: a second instance carries different characters on the same plate',
    num(T.shared) >= 120 && num(T.frac) >= 0.1, `${T.differ} of ${T.shared} px differ (${(100 * (num(T.frac) ?? 0)).toFixed(1)}%)`);
  add('the player\'s car has the face too', num(P.platePx) >= 120 && changed(P) >= 0.4,
    `${P.plateChanged} of ${P.platePx} px changed`);
  add('and the switch is back to the shipped state after the page is done with it', num(r.after) === num(r.shipped),
    `after ${r.after}`);

  // ---- THE LAMPS
  const LM = r.lamps ?? {};
  const H = LM.head ?? {}, TL = LM.tail ?? {}, HN = LM.headNight ?? {}, TN = LM.tailNight ?? {};
  const ho = H.on ?? {}, hf = H.off ?? {}, to = TL.on ?? {}, tf = TL.off ?? {};
  add('the build ships the lamps\' face ON', num(r.lampShipped) === 1, `shipped ${r.lampShipped}`);
  /**
   * THE BAND IS THE CENSUS'S, against the white car's own forward-facing paint beside and below the
   * lamp: headlamps on white cars 0.14-0.53 (0.14-0.17 in sun, 0.21-0.53 in shade), so 0.10-0.60 with
   * this page's light allowed for. The flat lamp is asserted to BE the defect in the same light — a
   * white field, over the paint — so the check cannot pass on a page where both read the same.
   */
  add('by day the flat headlamp is a white field, and the face sits in the photographed band',
    num(hf.overPaint) >= 1.0 && num(ho.overPaint) >= 0.10 && num(ho.overPaint) <= 0.60 && num(ho.lampPx) >= 200,
    `flat ${num(hf.overPaint)?.toFixed(3)} of the paint, face ${num(ho.overPaint)?.toFixed(3)} (census, white cars: 0.14-0.53)`);
  add('with the structure of a real one: p90/p50 and the share over twice the median inside the census',
    num(ho.p90p50) >= 1.7 && num(ho.p90p50) <= 6.0 && num(ho.over2x) >= 0.08 && num(ho.over2x) <= 0.35,
    `p90/p50 ${num(ho.p90p50)?.toFixed(2)} (census 1.7-5.0), over 2x ${(100 * (num(ho.over2x) ?? 0)).toFixed(1)}% (census 10-30%)`);
  /**
   * 0.05-0.14: the census measured white-car tails at 0.082 and 0.114, with bounds of 0.111 and
   * 0.127 where the paint clipped. The first draft allowed 0.20 and the selftest's known-bad said
   * why that was wrong: the flat tail this replaces reads 0.174 here, and a band that admits the
   * before-arm cannot tell the two apart.
   */
  add('a tail lamp is a dark red lens a tenth of the paint, its reverse insert the bright part',
    num(to.overPaint) >= 0.05 && num(to.overPaint) <= 0.14 && num(to.over2x) >= 0.05 && num(to.over2x) <= 0.35
      && num(tf.over2x) === 0,
    `face ${num(to.overPaint)?.toFixed(3)} of the paint (census, white cars: 0.08-0.11), insert ${(100 * (num(to.over2x) ?? 0)).toFixed(1)}% of the lens`);
  const lampLeaks = [H, TL, HN, TN].map((x) => num(x.otherChanged2));
  add('and nothing off the lamps moves, by day or night',
    lampLeaks.every((v) => v === 0) && [H, TL, HN, TN].every((x) => num(x.otherPx) > 0),
    `${lampLeaks.join(' / ')} px over 2 levels`);
  add('at night the lit headlamp is not put out', num(HN.on?.p50) >= 0.8 * (num(HN.off?.p50) ?? Infinity) && num(HN.off?.p50) > 0.3,
    `lit p50 ${num(HN.off?.p50)?.toFixed(3)} flat -> ${num(HN.on?.p50)?.toFixed(3)} face`);
  add('and the reverse insert stays dark while the red round it glows',
    num(TN.on?.under03x) >= 0.05 && num(TN.on?.under03x) <= 0.40 && num(TN.off?.under03x) < 0.02
      && num(TN.on?.p50) >= 0.8 * (num(TN.off?.p50) ?? Infinity),
    `dark share ${(100 * (num(TN.on?.under03x) ?? 0)).toFixed(1)}% (flat ${(100 * (num(TN.off?.under03x) ?? 0)).toFixed(1)}%), lit p50 ${num(TN.off?.p50)?.toFixed(3)} -> ${num(TN.on?.p50)?.toFixed(3)}`);
  const PH = LM.playerHead ?? {};
  /**
   * STRUCTURE ONLY, NOT THE BAND: this row is here for the FRAME (a lost CAR_FRAME_Y leaves the player's
   * lamps a uniform housing with no bowl or strip on them), and the player's car is dark red, where
   * the white-car band does not apply — its lamp reads 7.1x a self-shaded red fascia here, and the
   * census's one red car read 0.61 in sun. Its leak bound is 4 pixels, not 0, and measured: the
   * player's head band meets its amber indicator and its fascia at a shallow angle, and one MSAA sliver
   * no mask channel covers moves 15 levels; a real leak moves hundreds.
   */
  add('the player\'s headlamps carry the face too, in their own frame: structure where the flat lamp has none',
    num(PH.on?.lampPx) >= 200 && num(PH.on?.p90p50) >= 1.7 && num(PH.on?.over2x) >= 0.08 && num(PH.otherChanged2) <= 4,
    `p90/p50 ${num(PH.off?.p90p50)?.toFixed(2)} flat -> ${num(PH.on?.p90p50)?.toFixed(2)} face, over 2x ${(100 * (num(PH.on?.over2x) ?? 0)).toFixed(1)}%; ${PH.otherChanged2} px off the lamps moved`);
  add('and the lamps\' switch is back to the shipped state after the page', num(r.lampAfter) === num(r.lampShipped),
    `after ${r.lampAfter}`);
  return checks;
}

// ------------------------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('CAR-DETAIL SELFTEST');
  const g = (name) => ({ name, verts: 4, w: 0.3048, h: 0.1524, zSpread: 0, vOk: true, behind: 0, cx: 0 });
  const row = (px, changed, inkFrac, meanOn, minOnRatio) => ({ platePx: px, plateChanged: changed, inkFrac, offMed: 0.602,
    meanOff: 0.602, meanOn, minOnRatio, otherPx: 141980, otherChanged2: 0, otherMax: 0 });
  /** A REAL REPORT, from a passing run of the page at noon. */
  const good = {
    geometry: ['coupe', 'saloon', 'wagon', 'player'].map(g),
    // Measured off the build that fixed #133: 139.8 cm2 a side, 137.1 of it toward the back.
    mirrors: [1, -1].map((side) => ({ side, tris: 2, area: 0.01398, behind: 0.01371, beside: 0, ahead: 0 })),
    // The fleet's, measured off the build that gave them glass: 57.6 cm2 a mirror, all of it to the back.
    fleetMirrors: ['coupe', 'saloon', 'wagon'].flatMap((shape) => [1, -1].map((side) =>
      ({ shape, side, tris: 2, area: 0.00576, behind: 0.00576, beside: 0, ahead: 0 }))),
    shipped: 1, readback: PLANNED.map((k) => [...k]), after: 1,
    near: row(230, 158, 0.174, 0.4581, 0.066), far: row(21, 20, 0, 0.4690, 0.522),
    other: row(230, 145, 0.152, 0.4708, 0.044), player: row(230, 158, 0.174, 0.4581, 0.066),
    twoCars: { shared: 230, differ: 62, frac: 0.2696 },
    lampShipped: 1, lampAfter: 1,
    lamps: {
      head: { off: { lampPx: 683, overPaint: 1.510, p90p50: 3.13, over2x: 0.300, under03x: 0, p50: 0.0580 },
        on: { lampPx: 683, overPaint: 0.150, p90p50: 4.04, over2x: 0.286, under03x: 0.034, p50: 0.0058 },
        otherPx: 138026, otherChanged2: 0, otherMax: 0 },
      tail: { off: { lampPx: 626, overPaint: 0.174, p90p50: 1.09, over2x: 0, under03x: 0, p50: 0.0416 },
        on: { lampPx: 626, overPaint: 0.096, p90p50: 2.04, over2x: 0.101, under03x: 0, p50: 0.0229 },
        otherPx: 138088, otherChanged2: 0, otherMax: 0 },
      headNight: { off: { lampPx: 683, p50: 0.9485, under03x: 0 }, on: { lampPx: 683, p50: 0.9485, under03x: 0 },
        otherPx: 138026, otherChanged2: 0, otherMax: 0 },
      tailNight: { off: { lampPx: 626, p50: 0.2483, under03x: 0 }, on: { lampPx: 626, p50: 0.2420, under03x: 0.168 },
        otherPx: 138088, otherChanged2: 0, otherMax: 0 },
      playerHead: { off: { lampPx: 640, p90p50: 1.98, over2x: 0.1, overPaint: 9.0 }, on: { lampPx: 640, p90p50: 2.59, over2x: 0.298, overPaint: 7.11 },
        otherPx: 138000, otherChanged2: 0, otherMax: 0 },
    },
  };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  say(failing(good).length === 0, 'a real passing report passes every check', failing(good).join(' | '));
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT && failing({}).length > 0,
    'including on an EMPTY report, which fails rather than throws', `${failing({}).length} failed`);
  for (const [what, fn, needle] of [
    // The plate as it shipped, measured: 0.46 x 0.13 on the coupe.
    ['a European plate', (c) => { c.geometry[0].w = 0.4620; c.geometry[0].h = 0.1300; }, '12 x 6 in'],
    ['the player\'s plate left on the old band', (c) => { c.geometry[3].zSpread = 0.063; c.geometry[3].vOk = false; }, 'flat, centred'],
    ['a plate buried in its bumper', (c) => { c.geometry[1].behind = 6; }, 'flat, centred'],
    ['a shell with no plate', (c) => { c.geometry[2].verts = 0; }, 'carries a plate'],
    // The mirror as it shipped before #133, measured off that build: the whole slab, 349.1 cm2 a side.
    ['a door mirror laid on its side, its glass on the outboard face', (c) => {
      c.mirrors = [1, -1].map((side) => ({ side, tris: 12, area: 0.03491, behind: 0.00334, beside: 0.01442, ahead: 0.00334 })); }, 'door mirrors'],
    ['a mirror toed the wrong way, showing sin(toe) of its glass to the side', (c) => {
      c.mirrors[0].beside = 0.199 * c.mirrors[0].area; }, 'door mirrors'],
    ['a car with no mirror glass at all', (c) => { c.mirrors = c.mirrors.map((m) => ({ ...m, tris: 0, area: 0, behind: 0 })); }, 'door mirrors'],
    ['one mirror missing', (c) => { c.mirrors = c.mirrors.slice(0, 1); }, 'door mirrors'],
    // The fleet's mirrors as they shipped before: plain boxes, no glazing outboard of the body at all.
    ['the fleet\'s mirrors plain boxes with no glass, as shipped before', (c) => {
      c.fleetMirrors = c.fleetMirrors.map((m) => ({ ...m, tris: 0, area: 0, behind: 0 })); }, 'fleet shell'],
    ['one shell\'s mirror glass on the FRONT of its housing', (c) => {
      Object.assign(c.fleetMirrors[2], { behind: 0, ahead: c.fleetMirrors[2].area }); }, 'fleet shell'],
    ['the face shipped off', (c) => { c.shipped = 0; c.after = 0; }, 'ships the face ON'],
    ['a switch that never reaches the material', (c) => { c.readback[1] = ['plate', 0]; }, 'switch is what it asked for'],
    ['a lamp switch that never reaches the material', (c) => { c.readback[9] = ['lamp', 0]; }, 'switch is what it asked for'],
    // The lamps. The flat lamp as shipped before, measured: 1.51 of the paint.
    ['the lamps\' face shipped off', (c) => { c.lampShipped = 0; c.lampAfter = 0; }, 'lamps\' face ON'],
    ['a face still a white field', (c) => { c.lamps.head.on.overPaint = 1.51; }, 'white field'],
    ['a page where the flat lamp is not the defect', (c) => { c.lamps.head.off.overPaint = 0.4; }, 'white field'],
    ['a dark lamp with nothing in it', (c) => { Object.assign(c.lamps.head.on, { p90p50: 1.1, over2x: 0.01 }); }, 'structure of a real one'],
    ['a tail with no insert', (c) => { c.lamps.tail.on.over2x = 0; }, 'reverse insert the bright part'],
    ['a tail as bright as before', (c) => { c.lamps.tail.on.overPaint = 0.174; }, 'a tenth of the paint'],
    ['a face drawn over the whole car', (c) => { c.lamps.head.otherChanged2 = 4000; }, 'nothing off the lamps'],
    ['a face that puts the lit lamps out', (c) => { c.lamps.headNight.on.p50 = 0.2; }, 'not put out'],
    ['a reverse insert that glows red', (c) => { c.lamps.tailNight.on.under03x = 0; }, 'stays dark'],
    ['the page leaving the lamps changed', (c) => { c.lampAfter = 0; }, 'lamps\' switch is back'],
    ['the player\'s lamps read in the wrong frame: a housing with nothing on it', (c) => {
      Object.assign(c.lamps.playerHead.on, { p90p50: 1.15, over2x: 0.0 }); }, 'player\'s headlamps'],
    ['a blank plate', (c) => { c.near.plateChanged = 0; c.near.inkFrac = 0; }, 'the face is there'],
    ['a face painted over the whole car', (c) => { c.near.otherChanged2 = 9000; c.near.otherMax = 140; }, 'nowhere else'],
    // Measured: the first cut's edge, two font pixels wide at distance.
    ['a filter biased to ink at distance', (c) => { c.far.meanOn = 0.551 * 0.602; }, 'integrates to the same face'],
    ['a font sampled rather than filtered', (c) => { c.far.minOnRatio = 0.07; }, 'darkness of a whole stroke'],
    ['every car the same plate', (c) => { c.twoCars.differ = 0; c.twoCars.frac = 0; }, 'different characters'],
    ['the player\'s plate blank', (c) => { c.player.plateChanged = 0; }, 'player\'s car has the face'],
    ['the page leaving the switch changed', (c) => { c.after = 0; }, 'back to the shipped state'],
  ]) {
    const r = bad(fn);
    say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | '));
  }
  // And the geometry checks read the REAL builders, so they are run here too: a selftest that only
  // fed the verdict invented numbers would pass on a build whose plate had already regressed.
  const real = plateGeometry(), realMirrors = mirrorGeometry(), realFleet = fleetMirrorGeometry();
  const geo = verdict({ ...good, geometry: real, mirrors: realMirrors, fleetMirrors: realFleet }).slice(0, 5);
  say(geo.length === 5 && geo.every((c) => c.ok), 'the shipped builders pass the five geometry checks, the plates and both cars\' mirrors',
    geo.filter((c) => !c.ok).map((c) => c.detail).join(' | '));
  console.log(`\nCAR-DETAIL SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

// ----------------------------------------------------------------------------------- the gate
const geometry = plateGeometry();
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.env.CAR_DETAIL_PORT ?? treePort(ROOT));
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1000, height: 2740 } });
const logs = [];
page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
await page.goto(`http://127.0.0.1:${PORT}/tools/car-detail.html`);
let report = null, err = null;
try {
  await page.waitForFunction('window.__carDetail', null, { timeout: 90000 });
  report = await page.evaluate(() => window.__carDetail);
} catch (e) { err = e.message; }
await browser.close();
if (!report || report.error) {
  console.error(`the page did not publish a report: ${report ? report.error : err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
report.geometry = geometry;
report.mirrors = mirrorGeometry();
report.fleetMirrors = fleetMirrorGeometry();
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

console.log(`CAR-DETAIL — the number plate, built and drawn (${report.tod})\n`);
console.log('  plate      w x h (m)          flat   uv.y   behind');
for (const g of geometry) {
  console.log(`  ${g.name.padEnd(9)} ${g.w?.toFixed(4)} x ${g.h?.toFixed(4)}   ${g.zSpread < 1e-6 ? 'yes ' : 'NO  '}   ${g.vOk ? 'yes' : 'NO '}    ${g.behind}`);
}
console.log('\n  row      plate px  changed   ink     mean on/blank   darkest on/blank');
for (const k of ['near', 'far', 'other', 'player']) {
  const x = report[k];
  console.log(`  ${k.padEnd(8)} ${String(x.platePx).padStart(8)}  ${String(x.plateChanged).padStart(7)}   ${(100 * x.inkFrac).toFixed(1).padStart(5)}%` +
    `   ${(x.meanOn / x.meanOff).toFixed(3).padStart(10)}       ${x.minOnRatio?.toFixed(3)}`);
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nCAR-DETAIL: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` + (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
