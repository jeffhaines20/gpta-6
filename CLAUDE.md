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

## Numbers that are not what they look like

- **The budget gate's triangle count carries ~20k of run-to-run noise** from
  traffic and crowd placement — measured at 20,649 and 23,242 spread within an
  *unchanged* configuration. It cannot resolve a 1,000-triangle margin against
  the 830,000 warn. Price changes with a deterministic offline count
  (`tools/frontage-stats.mjs`, `tools/tri-breakdown.mjs`).
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
- **A "last radius still over 0.05" is a threshold crossing, and on a rippled
  profile it reads the ripple.** The pedestrian halo extinction moved 4.4 → 4.6
  bw on a change whose profile was LOWER at every radius out to 2.9 bw, because
  both arms dip under 0.05 at 3.4 bw and both come back over it at 3.9 bw. The
  level readings at 1, 3 and 6 body widths are the trustworthy statement; the
  crossing is decided by 0.006 of ripple.

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
- Headless capture runs through SwiftShader well under 1 fps. Budget minutes per
  frame, and never report frame rate as a performance result.
- `blind-compare` refuses to build a pair set carrying under 8% facade-band
  signal, because two arms of the same build is a failure that looks like data.

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

## Committing

Write what you measured, including what did not work and what you got wrong on
the way. Several of the most useful comments in this codebase are records of a
wrong turn — they are what stops the next person taking it.
