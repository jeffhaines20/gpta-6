// Present two capture sets to a reviewer WITHOUT telling them which is which.
//
// WHY. Every review round this project has run has handed critics a "before" and
// an "after" and asked whether the after is better. That question contains its
// own answer: a reviewer who knows which frame is the new one is being asked to
// ratify a change, not to judge it. This ledger already records four separate
// occasions where a confident reading turned out to be an artifact of how the
// question was posed - a leg-median that hid a bimodal split, a colour detector
// believed over the eye, an A/B whose two arms were secretly identical, and a
// target that was three-quarters crop rectangle. Blinding is cheap insurance
// against the same shape of error in the one measurement that has no instrument:
// whether it LOOKS better.
//
//   node tools/blind-compare.mjs m3base m3after          # build the blind set
//   node tools/blind-compare.mjs --reveal                # decode after judging
//
// Frames are matched by the part of the name after the tag, so `m3base-corridor
// -golden.png` pairs with `m3after-corridor-golden.png`. A pair with no partner
// is reported and skipped rather than silently dropped - a missing after-frame
// is exactly the kind of thing that would otherwise read as "no change".
//
// Assignment is a keyed hash of the pair name, so it is deterministic and
// reproducible, but it is NOT alternating: a reviewer who works out that A is
// always the new one has learned nothing, and one who notices A/B/A/B has
// learned everything.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readPNG } from './png.mjs';
import { diffBands } from './arm-diff.mjs';

const argVal = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const SHOTS = 'docs/shots';
const OUT = path.join(SHOTS, 'blind');
// The key lives OUTSIDE the directory handed to reviewers.
//
// It used to sit in OUT, dot-prefixed on the theory that a glob would not pick
// it up. A glob does not; a reviewer surveying the directory does. One read it
// in its opening `cat` of the folder alongside the tools, before it knew what
// the file was, and disclosed that its review had to be treated as sighted
// rather than blind -- an honest report that still cost the round one of three
// independent verdicts. A blind set is not blind if the answer is in the room.
//
// AND IT IS NAMED FOR ITS ARMS, because a fixed name destroys the last one.
//
// This ran as blind-key.json for every round, so building a new set silently
// overwrote the previous round's key - and a key that is gone means a review
// that can never be decoded again. It was caught on the round that would have
// destroyed the 2026-09-08 "final vs cars" key: git reported a DELETION of a
// tracked file at a path this tool had just rewritten, which is the only reason
// anyone looked. Nothing warned.
//
// --reveal with no arguments now reads the newest key, so the common case is
// unchanged; --reveal <left> <right> names one.
const keyPath = (l, r) => path.join(path.dirname(OUT), `blind-key-${l}-${r}.json`);
const args = process.argv.slice(2);

if (args[0] === '--reveal') {
  const named = args.filter((a) => !a.startsWith('--'));
  let KEY;
  if (named.length === 2) {
    KEY = keyPath(named[0], named[1]);
  } else {
    // Newest by mtime, and the legacy fixed name is a candidate so old sets
    // still decode.
    const dir = path.dirname(OUT);
    const cands = fs.readdirSync(dir)
      .filter((f) => /^blind-key(-.*)?\.json$/.test(f))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!cands.length) { console.error(`no blind key beside ${OUT}`); process.exit(2); }
    KEY = cands[0].f;
    if (cands.length > 1) {
      console.log(`${cands.length} keys present; reading the newest: ${path.basename(KEY)}`);
      console.log(`  (name both arms to pick another: --reveal <left> <right>)\n`);
    }
  }
  if (!fs.existsSync(KEY)) { console.error(`no key at ${KEY}`); process.exit(2); }
  const k = JSON.parse(fs.readFileSync(KEY, 'utf8'));
  console.log(`blind set built ${k.generated}   ${k.left} (left) vs ${k.right} (right)\n`);
  for (const p of k.pairs) {
    console.log(`  ${p.id.padEnd(28)}  A = ${p.A.padEnd(8)}  B = ${p.B}`);
  }
  console.log(`\n${k.pairs.length} pairs. A is "${k.left}" in `
    + `${k.pairs.filter((p) => p.A === k.left).length} of them.`);
  process.exit(0);
}

const [LEFT, RIGHT] = args.filter((a) => !a.startsWith('--'));
if (!LEFT || !RIGHT) {
  console.error('usage: blind-compare.mjs <tagA> <tagB>   |   blind-compare.mjs --reveal');
  process.exit(2);
}

const listing = fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png'));
const suffixes = (tag) => new Map(
  listing.filter((f) => f.startsWith(`${tag}-`)).map((f) => [f.slice(tag.length + 1), f]),
);
const L = suffixes(LEFT), R = suffixes(RIGHT);
if (!L.size) { console.error(`no frames tagged ${LEFT}-* in ${SHOTS}`); process.exit(2); }
if (!R.size) { console.error(`no frames tagged ${RIGHT}-* in ${SHOTS}`); process.exit(2); }

// Report the asymmetry rather than quietly intersecting. A frame that exists on
// one side only is either a capture that failed or a camera that moved, and both
// are things the round needs to know about before anyone judges anything.
const onlyL = [...L.keys()].filter((k) => !R.has(k));
const onlyR = [...R.keys()].filter((k) => !L.has(k));
for (const k of onlyL) console.error(`  UNPAIRED: ${LEFT}-${k} has no ${RIGHT} counterpart`);
for (const k of onlyR) console.error(`  UNPAIRED: ${RIGHT}-${k} has no ${LEFT} counterpart`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// One salt per build, so rebuilding the same two tags reshuffles. A reviewer who
// saw the previous round's set cannot carry over an assignment they inferred.
const salt = createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12);
const rank = (id) => createHash('sha256').update(salt + id).digest('hex');

// BALANCED, not independently flipped. Six independent coin flips land 5-1 or
// worse about a fifth of the time, and on a set this small a lopsided split is
// itself a tell - a reviewer who notices that five of six A-frames share a look
// has been handed the answer. Ordering the pairs by a keyed hash and swapping
// the first half gives an exactly even split whose per-pair assignment is still
// unpredictable. The first build of this file flipped independently and came out
// 5-1, which is what prompted the change.
const matched = [...L.keys()].filter((k) => R.has(k)).sort();
// PAIRS THAT ARE VIEWS OF ONE FRAME MUST GET ONE ASSIGNMENT.
//
// Assignment is a keyed hash of the PAIR NAME, deliberately so: a reviewer who
// works out that A is always the new arm has learned nothing, and one who
// notices A/B/A/B has learned everything. That is right when the pairs are
// independent. It is WRONG when some of them are crops of the others, and this
// round found out how wrong.
//
// A nine-pair set of three corridor heroes plus x2 and x4 magnifications of each
// went out with `corridor-noon--A` and `rear-noon--A` cut from DIFFERENT builds,
// and the dusk hero assigned opposite to noon and night. All three reviewers
// caught it, independently, and each reconstructed the true parentage the same
// way: crop.mjs magnifies by nearest-neighbour replication, so a crop matches
// its parent frame BIT-EXACTLY at the right origin and scale, and 0.000 against
// one arm with 2-3 counts against the other is not ambiguous. One reported it
// had first written the opposite answer to the parked-lamp question off
// `rear-night--A` and caught itself; another said "a reviewer judging from the
// crops alone would have got half the answers backwards while the data looked
// perfectly strong". That is CLAUDE.md's index-versus-name pairing trap wearing
// a new coat, and it cost three reviewers a large part of their round.
//
// --group <token> puts every pair whose id CONTAINS that token into one
// assignment, so all three views of the dusk frame agree. The hash is then taken
// over the group name rather than the pair name, which keeps the property the
// randomisation is for: nothing about a group's assignment can be predicted from
// another group's.
const GROUPS = (argVal('group', '') || '').split(',').map((g) => g.trim()).filter(Boolean);
const groupOf = (id) => GROUPS.find((g) => id.includes(g)) ?? null;
if (GROUPS.length) {
  const ungrouped = matched.map((f) => f.replace(/\.png$/, '')).filter((id) => !groupOf(id));
  if (ungrouped.length) {
    console.error(`--group named ${GROUPS.join(', ')} but these pairs match none of them:`);
    for (const id of ungrouped) console.error(`    ${id}`);
    console.error('Every pair must fall in a group, or the set is half-grouped and half-not,');
    console.error('which is the failure --group exists to prevent.');
    process.exit(2);
  }
  const byGroup = {};
  for (const f of matched) {
    const g = groupOf(f.replace(/\.png$/, ''));
    (byGroup[g] ??= []).push(f.replace(/\.png$/, ''));
  }
  for (const [g, ids] of Object.entries(byGroup)) {
    console.log(`group ${g}: ${ids.length} pair(s) share one assignment — ${ids.join(', ')}`);
  }
}
// What the balance is struck over: groups when grouping, pairs otherwise.
const units = GROUPS.length ? [...GROUPS] : [...matched];

const order = [...units].sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
const swapSet = new Set(order.slice(0, Math.floor(order.length / 2)));

const ROI = (() => {
  const v = argVal('roi', null);
  if (!v) return null;
  const q = v.split(',').map(Number);
  if (q.length !== 4 || q.some((n) => !Number.isFinite(n))) {
    throw new Error(`--roi wants x0,y0,x1,y1; got "${v}"`);
  }
  return q;
})();
/**
 * The same >4/255 fraction diffBands reports, over a stated rectangle.
 *
 * Throws on a non-finite difference for the reason arm-diff does: readPNG
 * returns channels 3 for these screenshots, and a hardcoded 4-byte stride reads
 * NaN in the bottom quarter - where NaN fails every comparison silently and the
 * bad rows report NO DIFFERENCE. The most dangerous shape a measurement bug can
 * take is the one whose wrong answer is reassuring.
 */
function roiOver4(A, B, [x0, y0, x1, y1]) {
  if (A.width !== B.width || A.height !== B.height) throw new Error('size mismatch');
  if (A.channels !== B.channels) throw new Error('channel mismatch');
  const C = A.channels;
  const ax0 = Math.max(0, x0 | 0), ay0 = Math.max(0, y0 | 0);
  const ax1 = Math.min(A.width, x1 | 0), ay1 = Math.min(A.height, y1 | 0);
  // A SET CAN MIX FULL FRAMES AND CROPS, and the region is stated in the full
  // frame's coordinates. Against a crop it clamps to nothing, and that is not an
  // error: the crop IS the subject, so its bands already look at the car and the
  // region has nothing to add. Returning null drops it from the candidates
  // instead of throwing and killing a set that is otherwise fine. Throwing here
  // cost a run - the first version died on a 984x544 crop in a set whose full
  // frames the region was written for.
  if (ax1 <= ax0 || ay1 <= ay0) return null;
  let n = 0, over4 = 0;
  for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) {
    const i = (y * A.width + x) * C;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.data[i + c] - B.data[i + c]);
      if (!Number.isFinite(d)) throw new Error(`non-finite difference at ${x},${y} — wrong stride`);
      n++; if (d > 4) over4++;
    }
  }
  return +(100 * over4 / n).toFixed(2);
}

// ---------------------------------------------------------- the degeneracy gate
//
// REFUSE TO SHIP A PAIR THAT IS THE SAME BUILD TWICE.
//
// This session sent three reviewers eight pairs and got back three independent
// reports that the arms were identical. They were right: a worktree capture had
// silently reused the main tree's HTTP server, so both arms rendered HEAD. Four
// hours of review, and the only reason it was caught is that all three reviewers
// measured before they formed an opinion. A tool that hands out frames should
// not depend on that.
//
// The test is the same one they ran. For each pair, the fraction of channel
// samples differing by more than 4 of 255 in the facade band -- the band a
// change to the buildings, the light or the materials has to move. Anything
// under MIN_SIGNAL is a pair with nothing in it to judge.
//
// The threshold is set from this session's own two arms, which bracket it
// unambiguously: the broken pair measured 2.83% and 3.76% on the facade band,
// and that was pedestrians and cloud phase; the correctly captured pair measured
// 34.79% and 31.27%. An order of magnitude apart, so 8% sits in empty space
// between them rather than being tuned to either.
//
// --force ships anyway, for the case where identical arms are the finding.
const MIN_SIGNAL = Number(argVal('min-signal', 8));
const degenerate = [];
if (!args.includes('--no-check')) {
  for (const suffix of matched) {
    const a = readPNG(path.join(SHOTS, L.get(suffix)));
    const b = readPNG(path.join(SHOTS, R.get(suffix)));
    // The BEST band, not the facade band.
    //
    // This gate exists to catch two arms of the same build, and it originally
    // read the facade band alone because that is where the round it was written
    // for did its work. That makes it wrong for any round whose change lives
    // somewhere else: a car round refused four of eight pairs at 2.97-3.25%
    // facade signal while the GROUND band of the same pairs carried 24.65%,
    // 12.8% and 8.49%. The arms differed enormously; they differed on the road.
    //
    // A pair with nothing in it to judge has nothing in ANY band, so taking the
    // maximum keeps the guard's real purpose and drops a false refusal that
    // would otherwise recur for every round that is not about facades.
    //
    // --roi x0,y0,x1,y1 ADDS A REGION, and it is not a loosened threshold.
    //
    // The bands are thirds of a 1600x900 frame, and a car is a small object in
    // one. Five rounds of car work measured 1.27% / 1.62% / 2.41% of the WHOLE
    // frame differing by >4/255 at dusk, night and noon, and 4.08% / 4.88% /
    // 6.69% in the best band - under the 8% line at every hour. Inside the near
    // parked car's own rectangle the same pairs carry 11.59% / 11.98% / 16.75%.
    // Every one of those numbers is true; they answer different questions, and
    // the gate's question is "is there anything here to judge", which for a car
    // round is asked of the car.
    //
    // So the region is a THIRD candidate alongside the bands and the maximum
    // still decides. MIN_SIGNAL is untouched at 8. A pair that is two arms of
    // one build has nothing in the region either, which is the property the
    // guard actually depends on.
    //
    // The refusal below prints the frame-wide figure beside the region's, so a
    // region that rescues a pair cannot hide how small the change is overall.
    const bands = diffBands(a, b);
    if (ROI) {
      const r = roiOver4(a, b, ROI);
      if (r !== null) bands.push({ band: `roi ${ROI.join(',')}`, over4Pct: r });
    }
    const best = bands.reduce((m, r) => (r.over4Pct > m.over4Pct ? r : m));
    if (best.over4Pct < MIN_SIGNAL) {
      degenerate.push({ id: suffix, pct: best.over4Pct, band: best.band });
    }
  }
}
if (degenerate.length && !args.includes('--force')) {
  console.error(`REFUSING to build a blind set: ${degenerate.length} of ${matched.length} pairs carry`);
  console.error(`almost no signal in ANY band (under ${MIN_SIGNAL}% of samples differing by >4/255).`);
  for (const d of degenerate) console.error(`    ${d.id.padEnd(28)} ${d.pct}%  (best of bands${ROI ? ' and roi' : ''}: ${d.band})`);
  console.error('\nThe usual cause is that both arms rendered the SAME BUILD -- a capture that');
  console.error('reused an HTTP server rooted in another tree, or a tag that was overwritten.');
  console.error('Check the two arms are what you think before spending a reviewer round on them:');
  console.error(`    node tools/arm-diff.mjs docs/shots/${LEFT}-<id>.png docs/shots/${RIGHT}-<id>.png`);
  console.error('\nPass --force if identical arms are genuinely the finding.');
  process.exit(1);
}
if (degenerate.length) console.log(`--force: shipping ${degenerate.length} pair(s) with little or no signal`);

const pairs = [];
for (const suffix of matched) {
  const id = suffix.replace(/\.png$/, '');
  // The ASSIGNMENT UNIT: the group when grouping, otherwise the pair itself.
  const swap = swapSet.has(GROUPS.length ? groupOf(id) : suffix);
  const A = swap ? RIGHT : LEFT, B = swap ? LEFT : RIGHT;
  fs.copyFileSync(path.join(SHOTS, (swap ? R : L).get(suffix)), path.join(OUT, `${id}--A.png`));
  fs.copyFileSync(path.join(SHOTS, (swap ? L : R).get(suffix)), path.join(OUT, `${id}--B.png`));
  pairs.push({ id, A, B });
}

const KEY = keyPath(LEFT, RIGHT);
if (fs.existsSync(KEY)) {
  console.log(`NOTE: overwriting an existing key for this exact arm pair at ${KEY}`);
}
fs.writeFileSync(KEY, JSON.stringify({
  generated: new Date().toISOString(), left: LEFT, right: RIGHT, salt,
  unpairedLeft: onlyL, unpairedRight: onlyR, pairs,
}, null, 1));

console.log(`${pairs.length} blind pairs in ${OUT}`);
console.log(`A is "${LEFT}" in ${pairs.filter((p) => p.A === LEFT).length} of ${pairs.length}`);
console.log(`\nGive a reviewer the ${OUT} directory and NOT this terminal. Decode with --reveal.`);
