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

const SHOTS = 'docs/shots';
const OUT = path.join(SHOTS, 'blind');
const KEY = path.join(OUT, '.key.json');       // dot-prefixed: not picked up by a glob
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
