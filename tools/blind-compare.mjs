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
const KEY = path.join(path.dirname(OUT), 'blind-key.json');
const args = process.argv.slice(2);

if (args[0] === '--reveal') {
  if (!fs.existsSync(KEY)) { console.error(`no blind set at ${OUT}`); process.exit(2); }
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
const order = [...matched].sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
const swapSet = new Set(order.slice(0, Math.floor(order.length / 2)));

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
    const bands = diffBands(a, b);
    const best = bands.reduce((m, r) => (r.over4Pct > m.over4Pct ? r : m));
    if (best.over4Pct < MIN_SIGNAL) {
      degenerate.push({ id: suffix, pct: best.over4Pct, band: best.band });
    }
  }
}
if (degenerate.length && !args.includes('--force')) {
  console.error(`REFUSING to build a blind set: ${degenerate.length} of ${matched.length} pairs carry`);
  console.error(`almost no signal in ANY band (under ${MIN_SIGNAL}% of samples differing by >4/255).`);
  for (const d of degenerate) console.error(`    ${d.id.padEnd(28)} ${d.pct}%  (best band: ${d.band})`);
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
  const swap = swapSet.has(suffix);
  const A = swap ? RIGHT : LEFT, B = swap ? LEFT : RIGHT;
  fs.copyFileSync(path.join(SHOTS, (swap ? R : L).get(suffix)), path.join(OUT, `${id}--A.png`));
  fs.copyFileSync(path.join(SHOTS, (swap ? L : R).get(suffix)), path.join(OUT, `${id}--B.png`));
  pairs.push({ id, A, B });
}

fs.writeFileSync(KEY, JSON.stringify({
  generated: new Date().toISOString(), left: LEFT, right: RIGHT, salt,
  unpairedLeft: onlyL, unpairedRight: onlyR, pairs,
}, null, 1));

console.log(`${pairs.length} blind pairs in ${OUT}`);
console.log(`A is "${LEFT}" in ${pairs.filter((p) => p.A === LEFT).length} of ${pairs.length}`);
console.log(`\nGive a reviewer the ${OUT} directory and NOT this terminal. Decode with --reveal.`);
