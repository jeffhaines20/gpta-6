// The two blind reviews of the round-1 car pass, as a repeatable battery.
//
// Both reviews measured the CORRIDOR HERO FRAME, not tools/car-probe.mjs's
// framing, and that matters: car-probe stands off the car's tail quarter down
// one lane, which gives a wheel 38 px tall and EIGHT PIXELS WIDE. The tool warns
// about that itself, and its own numbers show why - at that width the "tyre"
// annulus is mostly road and arch, so the front wheel reads hubFrac 0 and the
// rear reads 92.8 on the same geometry in the same frame. The corridor camera
// sees the same cars at a quarter angle, 34x24 px and 62x52 px, and that is
// where both reviewers' numbers and their real-photograph baselines live. This
// file measures THERE, so a before/after is comparable to what was said.
//
//   node tools/car-frames.mjs --selftest
//   node tools/car-frames.mjs r2base                 # one build
//   node tools/car-frames.mjs r2base r2after         # before/after
//   node tools/car-frames.mjs --control r2base       # is my frame the reviewers' frame?
//
// SUBJECTS are taken verbatim from the second reviewer's vprobe2.mjs, which
// established that the parked cars occupy identical pixels in both arms (the
// |A-B| map shows the silhouette as a hairline only). The grille box is the
// intersection of what the two reviewers reported independently: (25,806)-(155,834)
// and x 0-172, y 805-845.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  readPNG, wheelMetrics, flankMetrics, edgeMetrics, hubMetrics, noseMetrics, median, sampler,
} from './car-metrics.mjs';

const SHOTS = 'docs/shots';

export const SUBJ = {
  'corridor/nearleft': {
    box: [8, 590, 500, 862],
    wheelRear: { cx: 460, cy: 716, up: [0, 23], fore: [17 * 0.849, -17 * 0.528] },
    wheelFront: { cx: 313, cy: 805, up: [0, 31], fore: [26 * 0.849, -26 * 0.528] },
    flank: [[374, 722], [420, 706], [423, 738], [377, 754]],
    deck: [[110, 750], [258, 709], [273, 748], [125, 789]],
    shoulder: [372, 694, 424, 706], sill: [372, 744, 424, 756],
    // The grille aperture, and the two references the second review judged it
    // against: an adjacent BODY panel (the bonnet) and the SHADOW the car casts.
    // "Darker than the shadow under its own car" is the floor a grille has to
    // clear, and it is a floor rather than a taste because it does not depend on
    // the hour, the exposure or the car's paint.
    // Corners INCLUSIVE. noseMetrics walks u,v over [0,1] inclusive, so a quad
    // written as the reviewers' half-open box (25,806)-(155,834) samples one row
    // and one column of BODYWORK outside the aperture. The self-test below caught
    // it as sd 23.97 on a synthetic grille painted dead flat, which is a 24-luma
    // reading of a surface whose true spread is zero - and on the real frames it
    // would have diluted exactly the number this round is judged on.
    grille: [[25, 806], [154, 806], [154, 833], [25, 833]],
    // TWO references, both measured in this frame, because the single one the
    // second review quoted ("darker than the shadow under the car, 16.4") is
    // hard to place: a band under the car mixes deep contact shadow, tyres and
    // sunlit road, and reads sd 24-28 over a 30-luma mean. So:
    //   valance - the unpainted plastic bumper DIRECTLY BELOW the aperture. Same
    //             car, same shade, same orientation, same material family, and
    //             flat to sd 0.46. This is the honest local reference.
    //   shadow  - the p25 of a ground band under the car, kept because it is the
    //             floor the review actually named. Reported, not calibrated on.
    valance: [[40, 850], [140, 850], [140, 861], [40, 861]],
    shadow: [[200, 852], [400, 852], [400, 862], [200, 862]],
  },
  'corridor/right': {
    box: [1018, 566, 1240, 686],
    wheelRear: { cx: 1077, cy: 636, up: [0, 17], fore: [12 * 0.942, 12 * 0.334] },
    wheelFront: { cx: 1031, cy: 620, up: [0, 16], fore: [9 * 0.942, 9 * 0.334] },
    flank: [[1042, 606], [1062, 609], [1062, 632], [1042, 629]],
    deck: [[1102, 618], [1206, 622], [1206, 630], [1102, 626]],
    shoulder: [1040, 604, 1064, 612], sill: [1040, 628, 1064, 636],
  },
};

// An AMBIENT car at Five Points, and the name matters because I got it wrong
// first. The second review scored the PLAYER's car against real photographs and
// found it passes on all four measures at 21.6 px, and the first review reported
// the red car at Five Points as pixel-identical between the round-1 arms. I put
// a 21.6 px disc at the coordinates the first review used for that car and
// treated it as the player-car control - and its numbers moved sharply between
// my own two arms (rimTyre 2.779 -> 1.637, hubPeak 6.91 -> 2.10), which a car
// this round cannot reach would not do. So it is an ambient car, and it is kept
// as a SECOND SCENE for the traffic-wheel change, not as a control.
//
// The real control that the player's car is untouched is deterministic and
// offline: buildPlayerCar's three geometries hash byte-identical before and
// after (bodyMesh 2808 t, glassMesh 84 t, wheelMesh 648 t), and palette texels
// 0-11 are unchanged - the round's two new finishes are slots 12 and 13, which
// only buildTrafficCarGeometry names.
export const HERO = {
  'fivepoints/ambient': { wheel: { cx: 1079, cy: 623, up: [0, 10.8], fore: [10.8, 0] } },
};

// Real photographs, same metric, as the anchor. From the second review.
export const PHOTO = [
  ['REAL Mustang    29x10 px', 0.958, 0.542, 1.67, 28.6],
  ['REAL parked SUV 28x14 px', 1.015, 0.312, 1.60, 7.9],
  ['hero/player car 21.6 px ', 1.052, 0.378, 1.53, 8.3],   // measured by the reviewer, not here
];

const bandMed = (p, [x0, y0, x1, y1]) => {
  const s = sampler(p); const v = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const L = s.luma(x, y); if (L !== null) v.push(L); }
  return median(v);
};

export function measureFrame(file, s) {
  const p = readPNG(file);
  const wm = (w) => ({ ...wheelMetrics(p, w.cx, w.cy, w.up, w.fore), ...hubMetrics(p, w.cx, w.cy, w.up, w.fore) });
  const out = {
    wr: wm(s.wheelRear), wf: wm(s.wheelFront),
    flank: flankMetrics(p, s.flank), deck: flankMetrics(p, s.deck),
    edge: edgeMetrics(p, s.box),
    bodyFade: +(bandMed(p, s.shoulder) / Math.max(1e-6, bandMed(p, s.sill))).toFixed(3),
  };
  if (s.grille) {
    out.grille = noseMetrics(p, s.grille, s.deck, s.valance);   // vsShadow == vs VALANCE here
    out.grilleGround = noseMetrics(p, s.grille, s.deck, s.shadow).vsShadow;
  }
  return out;
}

// ---------------------------------------------------------------- selftest
function selftest() {
  const fail = [];
  const ok = (n, c, d) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); if (!c) fail.push(n); };
  // THE POINT OF THIS FILE IS THAT ITS RECTANGLES LAND ON THE RIGHT THINGS, so
  // the self-test is a synthetic FRAME with a known car painted into the
  // reviewers' coordinates, and the battery must read back what was painted.
  const W = 1600, H = 900, ch = 3;
  const data = new Uint8Array(W * H * ch).fill(52);        // road
  const put = (x, y, v) => { const i = ((y | 0) * W + (x | 0)) * ch; data[i] = data[i + 1] = data[i + 2] = v; };
  const rect = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, v); };
  rect(0, 560, 520, 870, 120);                              // the near-left car body
  rect(150, 848, 430, 858, 16);                             // its shadow
  rect(40, 850, 140, 862, 16);                              // valance strip, same value
  rect(25, 806, 155, 834, 10);                              // a ROUND-1 grille: flat, luma 10
  // NOTE the fixture paints the reviewers' HALF-OPEN box and the subject above
  // samples the INCLUSIVE one, on purpose: if the two ever drift apart again this
  // test fails rather than quietly averaging in the fascia.
  const img = { width: W, height: H, channels: ch, data };
  const s = SUBJ['corridor/nearleft'];
  const n = noseMetrics(img, s.grille, s.deck, s.shadow);
  ok('the grille rect lands on the painted aperture', Math.abs(n.medL - 10) < 0.5, `medL=${n.medL}`);
  ok('the shadow rect lands on the painted shadow', Math.abs(n.shadowMed - 16) < 0.5, `${n.shadowMed}`);
  ok('the paint rect lands on the painted body', Math.abs(n.paintMed - 120) < 0.5, `${n.paintMed}`);
  ok('a flat round-1 grille is reported as flat', n.flatSd < 0.01, `sd=${n.flatSd}`);
  ok('...and as darker than the car own shadow', n.vsShadow < 1, `vsShadow=${n.vsShadow}`);
  // KNOWN-BAD: shift the aperture by 40 px and the battery must NOT keep
  // reporting the aperture. A rect that is not checked is a rect that measures
  // the background, which is the failure car-probe's --overlay pass exists for.
  const moved = { ...s, grille: s.grille.map(([x, y]) => [x, y + 40]) };
  const n2 = noseMetrics(img, moved.grille, moved.deck, moved.shadow);
  ok('a 40 px misplacement changes the answer (rects are not self-confirming)',
    Math.abs(n2.medL - n.medL) > 50, `${n.medL} -> ${n2.medL}`);
  // And a grille WITH a slat must separate from the flat one on the same rect.
  const d2 = Uint8Array.from(data);
  for (let y = 806; y < 834; y++) for (let x = 25; x < 155; x++) {
    const v = (y >= 816 && y < 824) ? 74 : 22;
    const i = (y * W + x) * ch; d2[i] = d2[i + 1] = d2[i + 2] = v;
  }
  const n3 = noseMetrics({ width: W, height: H, channels: ch, data: d2 }, s.grille, s.deck, s.shadow);
  ok('a slatted grille reads a large sd and clears the shadow',
    n3.flatSd > 15 && n3.vsShadow > 1, `sd=${n3.flatSd} vsShadow=${n3.vsShadow}`);
  console.log(fail.length ? `\nSELFTEST FAILED: ${fail.join(', ')}` : '\nSELFTEST OK');
  return fail.length === 0;
}
// ENTRY GUARD, for the third time in this file set. tools/car-probe.mjs had no
// guard, so importing its metrics launched a browser and the second blind
// reviewer copied 150 lines to escape it. tools/car-metrics.mjs then ran its own
// self-test whenever ANY tool was invoked with --selftest. And this file printed
// a usage error and exited on import. The pattern is always the same: a module
// that does its work at load time cannot be reused, and every reuse becomes a
// fork.
const DIRECT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (DIRECT && process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

// ---------------------------------------------------------------- report
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (DIRECT) {
const TODS = (process.env.CF_TIMES ?? 'noon,golden,dusk,night').split(',');

if (process.argv.includes('--control')) {
  // IS MY FRAME THE REVIEWERS' FRAME? Their coordinates were read off the blind
  // set, which was shot from a different tree on a different day. If the parked
  // cars are not in the same pixels here, every rectangle above is measuring
  // something else and the whole battery is void. Compare the round-1 arm of the
  // blind set against my own capture of the same build.
  const KEY = JSON.parse(fs.readFileSync(`${SHOTS}/blind-key.json`, 'utf8'));
  const armOf = (id) => (KEY.pairs.find((p) => p.id === id) ?? {});
  for (const tod of TODS) {
    const pair = armOf(`corridor-${tod}`);
    const arm = pair.A === 'cars' ? 'A' : 'B';              // 'cars' is the round-1 build
    const ref = `${SHOTS}/blind/corridor-${tod}--${arm}.png`;
    const mine = `${SHOTS}/${args[0]}-corridor-${tod}.png`;
    if (!fs.existsSync(ref) || !fs.existsSync(mine)) { console.log(`${tod}: missing ${fs.existsSync(ref) ? mine : ref}`); continue; }
    const a = measureFrame(ref, SUBJ['corridor/nearleft']);
    const b = measureFrame(mine, SUBJ['corridor/nearleft']);
    console.log(`${tod.padEnd(7)} grille medL  blind-set ${String(a.grille.medL).padStart(7)}   mine ${String(b.grille.medL).padStart(7)}`
      + `   |  flatSd ${String(a.grille.flatSd).padStart(6)} vs ${String(b.grille.flatSd).padStart(6)}`
      + `   |  wheel rimTyre ${String(a.wf.rimTyre).padStart(6)} vs ${String(b.wf.rimTyre).padStart(6)}`);
  }
  process.exit(0);
}

if (!args.length) { console.error('usage: car-frames.mjs <tag> [tag2]  |  --selftest  |  --control <tag>'); process.exit(2); }

console.log('REAL-PHOTOGRAPH ANCHOR (same metrics)');
console.log('  subject                     rimTyre  rimCoV  hubPeak  hubFrac');
for (const [n, rt, cv, hp, hf] of PHOTO) {
  console.log(`  ${n}  ${String(rt).padStart(7)} ${String(cv).padStart(7)} ${String(hp).padStart(8)} ${String(hf).padStart(7)}%`);
}

for (const key of Object.keys(SUBJ)) {
  const s = SUBJ[key];
  console.log(`\n=== ${key} ===`);
  for (const tod of TODS) {
    const rows = args.map((tag) => {
      const f = `${SHOTS}/${tag}-corridor-${tod}.png`;
      return fs.existsSync(f) ? [tag, measureFrame(f, s)] : [tag, null];
    });
    for (const [tag, m] of rows) {
      if (!m) { console.log(`  ${tod.padEnd(7)} ${tag.padEnd(8)} (no frame)`); continue; }
      console.log(`  ${tod.padEnd(7)} ${tag.padEnd(8)} wheelR rimTyre ${String(m.wr.rimTyre).padStart(6)} `
        + `CoV ${String(m.wr.rimCoV).padStart(5)} peak ${String(m.wr.hubPeak).padStart(6)} frac ${String(m.wr.hubFrac).padStart(5)}%  |  `
        + `wheelF rimTyre ${String(m.wf.rimTyre).padStart(6)} frac ${String(m.wf.hubFrac).padStart(5)}%  |  `
        + `vGrad ${String(m.flank.vGrad).padStart(6)} fade ${String(m.bodyFade).padStart(6)} spec ${String(m.flank.spec).padStart(5)} edges ${String(m.edge.edges).padStart(6)}`);
      if (m.grille) {
        console.log(`  ${''.padEnd(7)} ${''.padEnd(8)} GRILLE mean ${String(m.grille.meanL).padStart(6)} sd ${String(m.grille.flatSd).padStart(6)} `
          + `p95-p5 ${String(m.grille.flatP95P5).padStart(5)}  vsPaint ${String(m.grille.vsPaint).padStart(6)} `
          + `vsValance ${String(m.grille.vsShadow).padStart(6)} vsGround ${String(m.grilleGround).padStart(6)}  `
          + `[bonnet ${m.grille.paintMed} valance ${m.grille.shadowMed}]`);
      }
    }
  }
}
}
