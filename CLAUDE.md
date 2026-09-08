# Working on this repo

A browser GTA-style open world of downtown Sarasota. Three.js from a committed
minified `vendor/` build, no build step, no npm dependencies but Playwright.
`district/` is the app, `src/` the engine, `tools/` the measurement harness.

Everything below is here because it went wrong at least once. Each rule cost
hours; several cost a whole review round.

## Before you start

```
node tools/check-base.mjs        # is this tree the one being shipped?
```

Worktrees here have twice been created from `main` rather than from the working
branch, and `main` is missing an entire session of work — one such tree was
**125 commits behind**. A builder that does not check will fix a build nobody
runs, and its before/after captures will look completely convincing, because
every frame in them is internally consistent. One builder caught this and reset;
the next did not, and its round was discarded.

## Measurement

**A claim without a number is not a result.** This is the whole method here. The
commit log is a measurement log, and a commit that says "looks better" is worth
less than one that says what moved and by how much.

- **Every new metric needs a `--selftest` that fails on known-bad input.** Two
  probes in this project had bugs their own self-tests caught; both would
  otherwise have produced confident, wrong conclusions.
- **`readPNG` returns `channels`, which is 3 for these screenshots, not 4.** A
  hardcoded 4-byte stride misaligns every sample and reads NaN in the bottom
  quarter — and NaN fails every `>` comparison silently, so the bad rows report
  *no difference*. The most dangerous shape a measurement bug can take is the
  one whose wrong answer is reassuring. `tools/arm-diff.mjs` throws on a
  non-finite difference for exactly this reason.
- **Prefer exposure-invariant metrics.** Exposure stops change between builds, so
  a raw R−B is not comparable across them. Ratios inside one frame — shade÷sun,
  sky÷ground, (R−B)/luma on the same material — survive it. A luma-thresholded
  "shaded" mask reselects its own sample when the frame gets brighter and will
  report a real change as zero.
- **Check your sampling can resolve what you assert.** A round once "confirmed" a
  traffic fix from a capture running 29 frames in 40 s — dt 1.38 s, during which
  a car moves 12 m past a 2.5 m threshold. A prop 46 m out is ~2 pixels of
  ground contact; if the metric cannot see it, say so instead of quoting it.
- **Isolate one term at a time.** A round reverted the wrong lever because it
  never isolated, then found roughness carried 99% of the move it was chasing.
- **A probe that measures the OPPORTUNITY does not measure the FIX.** A HUD probe
  counted `ctx.font` assignments — 3.00 a frame, every one building an identical
  string — and its own self-test warned in as many words that "a build that
  hoisted the constants but still assigned every frame would look fixed". The
  hoist landed, the probe read 3.00 before and 3.00 after, correctly, and it was
  used to check the fix anyway. Before quoting a number as evidence a change
  worked, say out loud which quantity the change alters and check the instrument
  moves when that quantity does.
- **When two instruments disagree, the tie-break is the one that isolates a
  single operation at high repetition.** V8's heap sampling profiler reported
  0.0 B/iter for both a rebuilt template literal and a hoisted constant. A timing
  loop at 5,000,000 repetitions read 11.14 ns against 0.98 ns. Stopping at the
  first would have concluded V8 constant-folds the template and the change is a
  no-op. It does not, and it is not.
- **Measure coverage of emitted geometry by CONNECTIVITY, not by vertex
  proximity.** Fabric, glass and any ruled surface carries vertices only at its
  two rails. A 2.70 m awning has vertices at s=6.15 and s=8.85 and nothing in
  between, so a proximity merge read 0.49 m of cloth on a wall carrying 5.40 and
  reported no overlap with anything. No threshold rescues it: the interior gap of
  one awning (2.46 m) is eight times the real gap between two (0.30 m). Connected
  components cannot merge two pieces that share no vertices, or split one that
  does.

## Numbers that are not what they look like

- **The budget gate's triangle count carries ~20k of run-to-run noise** from
  traffic and crowd placement — measured at 20,649 and 23,242 spread within an
  *unchanged* configuration. It cannot resolve a 1,000-triangle margin against
  the 830,000 warn. Price changes with a deterministic offline count
  (`tools/frontage-stats.mjs`, `tools/tri-breakdown.mjs`).
- **The budget gate's triangle "p95" is the 3rd-highest of 51 frames.** The drive
  samples 51 times in 53.5 s — dt 1.05 s — over a quantity that swings from
  563,766 to 868,617, a range of 41% of its own p50. A near-maximum over 51
  coarse samples is not a tail statistic: which frames land in the top three
  depends on where the drive was when the sampler fired, and the count tracks
  resident chunks (NEAR 16-17, FAR 54-73) rather than anything a diff changed.
  `tools/tri-ledger.mjs` prints the rank a percentile actually selects alongside
  the deterministic ledger, so a round can price itself before arguing with the
  gate. **Price first, run the gate second.** One round lost four hours to a
  same-box baseline for a WARN that arithmetic disposed of in minutes.
- **Check the fleet size before pricing anything per-car.** Three rounds argued
  over a +6,300-triangle body detail on an assumed 90-car fleet. The gate's own
  output says `"traffic": {"fleet": 30}`. The real figure was +1,560, and the
  decision that had been deferred twice for not fitting had always fitted.
- **`chunk stall ms` is unusable while anything else runs on the box.** The same
  code has measured 7.1, 24.1, 7.9, 68.5 and 11.6 ms depending only on how many
  headless browsers were alive. It is a max, not a percentile.
- The gate's own "headroom %" column is measured against the FAIL line, not the
  WARN line, so it reads comfortable while the warn line is close.
- **`ao-sweep`'s subject is whichever pavement slot qualifies first, and it is not
  the same slot twice.** Two runs of one unchanged configuration — same camera,
  same tod, same `--peds 96` — picked a 24.4 px body 9 m out and a 7.9 px body
  35 m out, and every absolute number moved with it: foot 0.794 against 0.437,
  reveal 0.199 against 0.130. Neither was wrong; they measured different
  subjects, and the 7.9 px one could not resolve what it was asked. `--slot X,Z`
  pins it, and a sweep meant to be compared with an earlier one must pass the
  earlier one's slot. The same caution applies to its facade pick, which chose
  `retailStrip@12.7m` in some runs and `midOffice@24.6m` in others.
- **An absolute luma band is not comparable between builds, and the direction it
  lies in is flattering.** `muddyPct` counted pixels in [30,60]. A pure exposure
  change with ZERO content change walks the population across it: 20.12 at −0.5
  stops, 40.13 at +1. The tool's own report contained a live instance — a bay
  where `muddyPct` fell 6.11 → 3.89, reading as a legibility win, in a frame that
  had got 6.6× brighter. Ratios of percentiles taken in LINEAR light are exactly
  invariant under an exposure change, because there it is a pure scale: the same
  bay measured 8.3325 at every stop from −0.5 to +1, drift 0.00%. The same ratio
  on the sRGB-ENCODED values drifts 20%, because the OETF is not a scale — so
  "take a ratio" is not enough on its own, it has to be a ratio in linear light.
  Exact only while nothing clips; report the clipped fraction beside it.
- **A "last radius still over 0.05" is a threshold crossing, and on a rippled
  profile it reads the ripple.** The pedestrian halo extinction moved 4.4 → 4.6
  bw on a change whose profile was LOWER at every radius out to 2.9 bw, because
  both arms dip under 0.05 at 3.4 bw and both come back over it at 3.9 bw. The
  level readings at 1, 3 and 6 body widths are the trustworthy statement; the
  crossing is decided by 0.006 of ripple.

## An audit that walks less than the build cannot fail

`geom-audit` asked `streetDirFor` for ONE street direction and took `facingEdges`'
cone around it. `appendBuilding` asks `streetDirsFor` and UNIONS the cones,
because a corner site fronts two streets and one direction can only ever admit
one of them. So every prop check in that file — roof units, fire escapes, sign
blanks, awning arms, street doors — was blind to the second elevation of every
corner site in the district, and had been for as long as corner sites existed.

It passed the whole time. That was luck, not evidence.

**When a tool replays the build, it must replay the build's own selection, and
the cheap proof is that its counts match.** After the fix the audit's numbers
agreed with two independent censuses to the unit — 157 doors, 450 sign awnings —
where before it had reported 133 and 375. A count that disagrees with the build
by 15% is the audit telling you it is looking somewhere else.

The same trap has a second mouth: a guard that covers half a case reads as a
guard. `facades.js` refused to emit awnings over a LOTTED bay, which is exactly
right and covered so much of the problem that nobody looked at the unlotted half,
where both kits rolled their own dice over the same wall for 275 m.

## Captures

- **Never reuse an HTTP server you did not start for this tree.** `ensureServer`
  writes a token into the tree and reads it back before reusing a live server,
  and throws on a foreign document root. Port **8123 belongs to the main tree**;
  give any other tree its own port. A four-hour blind review round was spent
  comparing a build against itself because a worktree capture silently reused
  the main tree's server. It had happened once before and been patched in one
  tool, leaving the trap armed everywhere else.
- **Never wait on a log string.** Wait on the process (`wait $PID`, or poll
  `kill -0 $PID`). Five polling loops in one session waited hours for an `EXIT`
  line that a *successful* run never prints.
- **`pgrep -f PATTERN` matches the waiting shell's own command line.** So
  `until ! pgrep -f "hero-shots"; do sleep 30; done` can never exit: the shell
  running it has "hero-shots" in its own argv and finds itself forever. Fourteen
  such loops were found alive in one session, two of them spinning for 2.8 hours
  after the thing they waited for had finished. The same trap gives a false
  "still busy" from a one-shot check. Wait on a PID you captured (`kill -0 $PID`),
  or if you must match by name, use a pattern that cannot match itself —
  `pgrep -f "[h]ero-shots"`.
- **A `cd` into a worktree persists into your next command, and the tree you then
  measure is not the one you think.** This has cost real work twice: once a
  CLAUDE.md edit written into an abandoned worktree, where the commit silently
  carried nothing, and once a capture reported as "0 frames produced" that was
  in fact producing frames correctly — the `ls docs/shots/` had run from the
  other tree. Both readings were plausible and both were about the wrong
  directory. Put an absolute `cd` at the top of any script that measures or
  writes, and prefer absolute paths in one-off checks.
- **A screenshot must be bounded AND non-fatal, and in a loop the catch is the
  half that matters.** `page.screenshot` inside the framing/time-of-day loop
  threw on a timeout and destroyed every frame after it, so an eight-frame arm
  came back with six and looked like a completed run with a short list rather
  than like a crash. And the two arms do NOT lose the same frames — the timeout
  is load-dependent, not per-framing, so the second arm of this very pair
  captured all eight while the first captured six. Asymmetric arms are the worse
  case: a pairing that matches by INDEX rather than by NAME will pair
  fivepoints-dusk against fivepoints-golden and every number after that is
  nonsense, while looking like a strong signal. `drive-through.mjs` had
  carried both halves for a while, and its own comment says hero-shots "already
  uses 180 s for the same reason" — true of the bound, false of the catch. Three
  other tools were still unguarded when this was found. Patching one tool and
  leaving its siblings is the recurring shape of defect in this repo.
- Headless capture runs through SwiftShader well under 1 fps. Budget minutes per
  frame, and never report frame rate as a performance result.
- `blind-compare` refuses to build a pair set carrying under 8% facade-band
  signal, because two arms of the same build is a failure that looks like data.

## Orchestrating builders

- **Do not remove a worktree you may still want to talk to.** Removing merged
  worktrees to reclaim disk also destroys the ability to resume the agent that
  owned one — its context goes with it, and a follow-up round has to be briefed
  from scratch. Reclaim disk when a line of work is finished, not when a round
  merges.
- **Hand a builder its predecessor's findings, not just the defect.** The rounds
  that went fastest here started from what the last one had already ruled out;
  the ones that went slowest re-derived it. A brief that says "this was tried,
  measured X, and was not shipped because Y" is worth more than one that says
  what to build.

## Gates

`check-syntax`, `geom-audit`, `golden-trace`, `physics-test`, `daynight-sweep`,
`budget` (`drive-through --traffic`), `leaf-mask`. Run the ones your change can
touch before claiming done.

**A gate is never loosened silently.** If a change moves a threshold, restate the
threshold *in the same commit*, with the derivation. One commit shipped a
transfer-function change while leaving two fog ceilings unrestated, which
loosened a gate without saying so.

## When a reviewer is wrong

Blind reviewers here measure before judging and are usually right, but not
always, and their diagnosis is weaker than their observation. Two independently
reported that shade out-warmed the sun; both were reading a "sun" population
that was ~1% of the band, mostly gaps in the oak canopy. The observation was
real, the offered cause was not, and the actual cause was a wall term that
assumed the whole canyon wall was lit. **Reproduce the number, then test the
diagnosis separately.**

## Pricing a change

**Count triangles by building the geometry and reading the buffer, never by
counting quads in your head.** Six quads, twelve triangles, 157 doors, 1,884 —
that arithmetic was confident, written down, and wrong by a factor of two. The
offline bill said +3,780, because `faceQ`/`jambQ`/`shelfQ` do not each emit the
one quad the estimate assumed. `tools/frontage-stats.mjs` and
`tools/tri-breakdown.mjs` are deterministic and take seconds; the budget gate
carries ~20k of noise and cannot arbitrate.

**Price a per-frame cost against the frame budget before calling it a win.** An
11× speedup on an operation that runs three times a frame is 30 ns, which is
0.0002% of a 60 fps frame. Keep the change if it is free and correct; do not
report it as performance. Saying "this is real and it does not matter" is a
result, and it stops the next person spending a day on it.

## Committing

Write what you measured, including what did not work and what you got wrong on
the way. Several of the most useful comments in this codebase are records of a
wrong turn — they are what stops the next person taking it.
