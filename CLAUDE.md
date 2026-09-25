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
- **The budget gate is PRECISE on a clean box and noisy only on a dirty one, and
  the difference is the whole argument.** Three runs of identical code with no
  browsers and no orphaned servers alive:

      p95   852,605   851,671   852,605     spread    934  (0.11%)
      p50   705,037   705,037   705,153     spread    116
      min   562,399   562,399   562,399     spread      0
      frames    89        89        89

  A spread of 934 resolves a ~1,900-triangle change. The "~20k of run-to-run
  noise" below was measured while other agents' browsers were alive, and it is a
  statement about CONTENTION, not about the gate. Clean the box and the gate
  becomes a usable instrument.

  This cost a wrong conclusion. A WARN at 851,836 was explained away as sampling
  noise on the strength of that 20k figure, with an arithmetic ledger showing the
  round was deterministically −222 triangles. The ledger was right about the
  DELTA and wrong about the BASELINE, and the WARN was real the whole time: the
  tree reads 852,605 against an 830,000 warn, over by 22,605 (2.7%). **Before
  explaining a gate reading away, clean the box and run it three times.** It
  takes twenty minutes and it is the difference between a measurement and an
  argument.
- **The budget gate's triangle "p95" is the 3rd-highest of 51 frames on a LOADED
  box (89 frames, 5th-highest, when clean).** The drive
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

- **Before attributing a gate's triangle delta to the build, run `tri-breakdown`
  on BOTH builds at a FIXED camera.** If the two are triangle-identical there,
  no source change can explain the gate's delta and reading the diff is wasted
  time. This test is eight minutes and it should be step one. I spent a whole
  round on `daynight-sweep`'s -9,024 (noon, golden, dusk) / -4,512 (night) and
  got the attribution wrong FOUR times before running it. The answer, HEAD
  against the baseline artifact's own commit `e916078`, both at the default
  camera:

                      noon              night
      colour pass   288,121 = 288,121   288,185 = 288,185
      engine        468,403 = 468,403   483,907 = 483,907
      shadow pass   180,282 = 180,282   195,722 = 195,722
      draw calls        135 vs 131          138 vs 134

  Identical to the unit, in every column, at both hours. The +4 draw calls are
  the body-shell split at 0 triangles - and because four independent numbers
  agree exactly, the test also proves the two runs held the SAME resident set,
  so it validates itself. Whatever the sweep measured, it was not the code.

  The four wrong attributions, because each was plausible and each cost hours:

  1. *"It is structural, because the delta is IDENTICAL at every hour."* The
     sweep does ONE `page.goto` and loops the four times of day on that single
     load, so residency is fixed within a run and every hour carries it.
     Structure predicts a constant too. Both hypotheses predict the observation.
  2. *"Then it is residency."* Also unshown at the time.
  3. *"Residency is refuted, because two re-runs came back byte-identical."*
     INVALID, and this is the subtle one. Two re-runs at HEAD on one box prove
     HEAD is self-consistent. They say nothing about whether HEAD's resident set
     matches a run made at a different commit on a differently-loaded box, which
     is the only comparison the artifact actually offers. `streaming.js` budgets
     uploads against the WALL CLOCK (`while (performance.now() < deadline)` on a
     3 ms slice), so how much geometry lands per frame depends on how fast the box
     was feeling - see the same warning in `hero-shots`' `settleFrames`.
  4. *"A 2:1 day-to-night split cannot be residency, because residency is one
     offset shared by all four hours."* ALSO INVALID. Residency is one set of
     missing OBJECTS across the hours; its triangle COST is not one number,
     because `renderer.info` counts an object once in the colour pass and again
     in every shadow map that contains it, and which maps those are changes with
     the hour. A far chunk can sit inside the sun's shadow frustum at noon and
     inside no point light's at night, which is a 2:1 cost from one unchanged
     residency difference. The split was never evidence of anything.

  So the delta is in what was resident or in frame when each run fired, and the
  committed baseline predates the residency fields, so it cannot be separated
  further than that. `daynight-sweep` now persists `chunks`, `lodNear`, `lodFar`
  and the parked pool's `pool`/`filled`/`shells`/`perShell`/`trianglesDrawn`, so
  the next two artifacts can settle it in one line. The gate IS deterministic on
  a clean box - three runs, triangle column byte-identical at all four hours
  (764,720 / 786,849 / 786,066 / 788,697) - and that is worth knowing; it is just
  not what decides whether a delta against an older artifact is structural.

## `onBeforeCompile` hands you UNRESOLVED includes

A shader injection aimed at `radiance += getIBLRadiance( ... );` threw
"IBL radiance line not found" on every car material and the page never rendered a
frame. The string is in the vendored three exactly once, and grepping for it is how
the target was chosen — but it lives inside the `lights_fragment_maps` CHUNK, and
`onBeforeCompile` gives you the material's shader with its `#include` directives
still unexpanded. `patchLensFalloff`'s existing injection works because
`vec3 totalEmissiveRadiance = emissive;` is top-level in `meshphysical`; this was
not.

**Grep the vendored bundle to find the mechanism, then target a string that is
top-level in the material's own shader.** `#include <lights_fragment_maps>` is such
a string, and `radiance` is in scope between it and `lights_fragment_end` where
`RE_IndirectSpecular( radiance, … )` consumes it — so the injection goes
immediately after the include, under the same `#if defined( RE_IndirectSpecular )`
guard three declares the variable under.

Two things made this cheap instead of expensive, and both are the rule:

- **The injection asserted its own seam.** Without `if (!shader.fragmentShader
  .includes(SEAM)) throw`, the replace would have silently matched nothing, the
  page would have rendered perfectly, and a ten-frame sweep would have concluded
  with beautifully consistent numbers that the lever does nothing. That is the
  same failure `proveArmsDiffer` exists for, arriving through the shader instead
  of the uniforms.
- **A two-frame smoke test ran before the ten-frame sweep.** Ten frames is an hour
  on SwiftShader; two is ten minutes. Check that a new lever reaches the pixels
  before you spend the hour measuring it.

And when adding a uniform or an injection to a material that sets
`customProgramCacheKey`, **bump the key**. Three will otherwise hand back the
previously compiled program and the change does nothing — a failure the seam
assertion cannot see, because the assertion runs on a compile that never happens.

## The sky was still moving inside a "one page load" pair

`hero-shots` exists so that every arm comes off ONE page load, ONE camera and ONE
settled district. Geometry, materials, streaming, traffic and crowd are pinned. The
sky was not: `sky.js` advected the cloud deck off `performance.now()` under a comment
saying "5.5 m/s at 2.2 km over a 34 km tile is 0.00016 UV per second: the deck moves,
but a capture taken 20 s later than another is still the same sky."

That arithmetic is correct and the harness is not 20 s. Headless capture through
SwiftShader is **minutes per frame**, so two arms of an A/B are a hundred times
further apart than the comment assumed.

All three blind reviewers in one round independently reported it, and none could
resolve it: 36.9% of the noon pair's difference energy and 79.9% of the night's lay
above the car band; 56.5% of the off-car noon energy was sky. Each offered the same
two readings — a second term shipped in the pair, or an unseeded/time-driven cloud
field caught in two states — and each said the PNGs could not tell them apart.

**A scrambled capture order settles it, and it was an accident worth keeping.** The
five arms were shot in the order ge0, ge5, ge1, ge2, ge3 so the go/no-go pair came
first, which left capture order disagreeing with the swept value. Mean |d| over the
sky band against both:

    with CAPTURE distance    r = 0.9674
    with SWEPT-VALUE distance r = 0.0295

The pair with the LARGEST value difference and the smallest capture separation
(ge0 vs ge5, adjacent) moved the sky least, 1.296; the pair with a smaller value
difference and the largest separation (ge0 vs ge3) moved it most, 3.298.

`__district.freezeClouds()` pins the deck, and `hero-shots` calls it before any arm
is shot unless `HERO_CLOUDS=live`. **Every arm pair this harness produced before that
carried a sky offset proportional to how far apart its arms were captured** — small
in the car band, and the largest single component of several pairs' whole-frame
difference. When re-reading an old pair, discount whole-frame and sky-band numbers
accordingly; the car-band and control-box numbers stand.

The general rule: **when a tool claims a registered pair, enumerate every clock the
scene reads.** Frames, streamer quiet, traffic and crowd were all pinned here, and
the one unpinned clock produced more difference than the term under test.

## A fixed box over moved geometry is not a measurement of the material

Three blind reviewers independently reported that a car's rear quarter light had
been deleted and replaced with painted metal. Their box read 0.2751 of the paint
below it in one arm and 1.3499 in the other, with internal modulation collapsing
4.576 → 1.081. I reproduced it, believed it, wrote it into `src/carbody.js` as a
shipped-material regression, and committed it.

It was the BODY SHELL. The same box, with the material held at its old value and
only the shell changed:

    coupe,  metalness 0.86     0.2751   modulation 4.576
    saloon, metalness 0.86     1.3680   modulation 1.081      material unchanged
    saloon, metalness 0.00     1.3499   modulation 1.081

The saloon's roofline break is 0.2 m forward of the coupe's, so the quarter light
moved and the box did not: it lands on glass in one shell and on body panel in the
other. The material change then moved it 1.368 → 1.350, **down** by 1.3%.

The tell was in the reviewers' own reports. One of them had hit the same fault on a
different box earlier in its round, caught it, and wrote the rule down — *"a box
that is valid for one arm's geometry is not automatically valid for the other's
when the geometry is what changed"* — and then had it again on this box. Another
flagged the consequence without being able to resolve it: *"in that case the newer
build has also lost a body variant and a quarter-light, which is worth checking
against the diff."* Nobody checked, including me.

**When an arm changes geometry, no fixed box measures a material.** Either hold the
geometry and sweep the material alone, or find the subject in each arm before
sampling it. And when three reviewers agree on a number, that agreement is evidence
they used the same box, not evidence the box is right — they were handed it.

## The budget gate's autopilot drives through a third of the city

`drive-through` steers in a straight line at route waypoints 75 to 512 m apart. Measured
against the wall index, **829 m of that 2,528 m course is inside a building — 32.8%**,
with individual legs at 59%, 50% and 47%. That was free until body collision existed. With
walls solid the car is wrecked 10.6 s in at 89 km/h and 55 degrees of incidence, after
which it has no engine power and the drive's own stuck-nudge teleports it round the rest of
the route once every 2.65 s. The gate still finishes and still prints numbers, and they are
numbers about a different traversal than every committed baseline.

`__district.setBodyCollision(false)` and the gate says so in its output. `src/roadpath.js`
is the real fix — Dijkstra on the graph `traffic.js` already walks, 0 of 851 points blocked
even for the full car body — and it is not the gate's course yet, because changing what a
gate measures needs a fresh baseline and the triangle WARN is unresolved.

**Look for the road inside the building before blaming the driver.** 14 of 935 edges carry
a car-sized obstruction on their own centreline and 7 have their centreline INSIDE a
footprint; every one is class `service`, a 2.8 m alley, and the worst is 36 m long with 23
of its 24 samples inside a building. The router excludes 11 of them, 1.2% of the network
and 317 m. No follower can steer out of a road that is inside a building.

## Five ways a path follower reports everything nominal while driving into a wall

Every one of these was found by tracing, and every one produced a controller whose own
numbers looked fine. They are listed because the shape recurs.

1. **A gap in the path.** `nearestOn` projects onto an edge at some fraction along it while
   `route` can only start from an endpoint vertex, so prepending the projection inserted a
   75 m straight segment. An arc-length look-ahead then aimed at the far side of it,
   reported a heading error of **0.00**, and drove 78 km/h across a city block for four
   seconds. Off-line distance went 25 → 75 m with the error at zero the whole way.
2. **A radial look-ahead aims backwards.** The aim was "the first point at least a
   look-ahead away, searched from the current index". Cutting a corner stops the index
   advancing; once the car is far enough from that stuck point, the radial test *selects
   it*. Traced: at 73.67 s the car aims correctly at a point ahead; one second later the
   aim is 11 m behind it and the error is −2.29 rad. It turned round, ran 109 m back up the
   street and hit a building. Progress must be the closest point in a forward-only window,
   and the aim must be measured in **arc length**, which cannot select a point behind.
3. **Curvature over three points reads the resampling, not the road.** A resample leaves
   short segments at its joins; a three-point window on one reads arc 0.6 m over 1.57 rad
   and reports a **0.38 m** corner. The tell was that corner smoothing changed nothing —
   0.45 m at 0, 1, 2, 3 and 4 passes, and smoothing cannot fail to round a real corner. The
   wrong number was worse than wrong, it was *actionable*: 0.38 m is not steerable at any
   speed, so the limiter demanded a standstill at every junction and the drive was carried
   by 136 stuck-nudges. Measure curvature over a **fixed arc**.
4. **A fixed-arc window still needs two segments.** If the first segment alone exceeds the
   window, the end heading is read off the same segment as the start and the turn is exactly
   zero — a 10 m square made entirely of right angles reported a minimum radius of
   *Infinity*.
5. **Grip is not the only corner ceiling.** `vehicle.js` scales steering authority down with
   speed, so the minimum turning radius *grows*: 4.3 m at rest, 6.2 m at 40 km/h. A 6 m
   junction at 40 km/h is geometrically impossible and no grip helps. Symptom: full steering
   lock, a 1.39 rad heading error, off-line climbing 1.9 → 8.2 m, throttle at 0.35.

**Fewer contacts is not better driving.** An intermediate reading of 187 contacts looked
better than the 1,654 that replaced it and was worse: the 187 was measured while the
limiter demanded 0 km/h at every junction, so the car crawled and 136 nudges carried it.

**Localise before tuning.** Identical impacts at 50, 65 and 79 km/h — same three junctions,
delta-v within 3% — is not a speed problem, and three afternoons of throttle tuning would
not have found it. Clearance from the finished course to the nearest wall is a minimum of
1.92 m and a median of 11.23 m, with not one point of 737 within 1.5 m: so every remaining
contact comes from the follower's 26.79 m excursions and nothing from the course.

## A check whose two sides are both zero is not a check

`crash-test`'s speed sweep launched every arm from 160 m back and ran 1,400 fixed
steps. At 10 km/h that covers 32 m, so four of the five arms never touched the wall.
Each read a charged delta-v of 0.000, predicted `severityFor(0.000)` = 0.000 damage,
found they agreed, and **passed**. The table printed five neat rows and two of them
were measurements.

The same shape in the same file's scrape arm: `yaw -0.10` into a wall that runs along
x is 84 degrees of incidence, not 6 — a solid crash labelled a scrape, which then
"confirmed" that scrapes are expensive. `blocker-test` made the identical mistake in
its own contact-impulse section on the same afternoon, passing `vx: 20` against a
normal of `(-1, 0)` and calling it a 5-degree graze.

**Every arm has to assert that the thing it is measuring HAPPENED.** `contacts > 0`,
`applied > 0`, a non-zero denominator. And when an arm's geometry is an angle, print
the angle you actually built, not the one you meant: the incidence sweep only became
trustworthy when the charged delta-v was printed beside
`speed * sin(incidence) * (1 + e)` at every angle from 3 to 90 degrees.

## Instrument the iteration count of anything iterative

`resolveCircle` pushes a circle out of a wall and repeats for the corner case. It
reported correctly resolved contacts and ran its **entire** iteration budget on every
call: pushing a circle to exactly `r` from a wall leaves it, in floating point, a few
times 1e-17 short of clear, so the next pass finds a penetration of 1e-17, pushes by
1e-17, and never terminates. Measured on the real road network with the budget raised
to 32: 37 contacts at 32 iterations with the depth unchanged after the first, and a
non-null contact returned for a correction of 0.0000 m — which would have charged the
damage model an impact every frame for a car parked next to a wall.

A 1 micrometre epsilon, required for a penetration to count and added again to the
push, took the worst count to **1**. Nothing else about the module's behaviour
changed, which is the point: from the outside a non-terminating resolver and a
converged one are identical. The two checks that pin it are the residual ones —
resolving a resolved position must report clear, and must never leave the subject
inside the geometry.

## Size a circle-set collider by the notch it leaves, and measure the notch

"A circle at each end" is the obvious body collider for a car and it is catastrophic.
For a 1.9 x 4.3 m body with the end circles placed to reach the nose and tail
(centres +/-1.2, r 0.95), the deepest point of the gap between them is 0.95 m from the
axis — the entire half-width. A wall here is a line segment with no thickness, so it
slots into the gap and the car drives through its own midships. Worst side notch
against circle count:

    n=2   950 mm      n=4    88 mm      n=6   31 mm
    n=3   213 mm      n=5    49 mm      n=7   21 mm

Five samples is 49 mm and 600 lookups a second, which costs nothing measurable. The
gate builds a thin pier whose near corner sits 0.25 m inside the body at midships:
five samples correct 0.250 m, two samples do not see it at all.

State what the shape gets wrong, too. A circle centred on the axis cannot reach a
square corner, so the nose and tail corners sit 0.394 m outside the collider. That is
a real approximation with a number on it, not a defect to be surprised by later.

## The contact point is on the surface, not at the sample centre

Body collision resolved correctly and the car stopped at the wall every time, so the
thing that was wrong was invisible: the impulse and the damage were charged at the
sample CENTRE. The samples lie on the body axis, so every lever arm had zero lateral
component. The consequences, none of which touch the position:

- every crash in the district was filed as pure front or pure rear damage
- the left/right asymmetry that drives a steering pull could never be non-zero
- a 40 km/h clip at 17 degrees imparted 0.0016 rad/s of yaw instead of 0.883

**A bounding-box collider is a bounding box of a POLYGON.** The same round found
`refreshFootColliders` had been handing player.js the axis-aligned bbox of each
building footprint since collision existed. Inside some box and outside every polygon:
142,932 m2, 30.9% of all box area, 21,588 m2 of it on the carriageway. Sampled every
2 m along every road centreline, a body-sized circle cannot fit at 64 of 24,517 points
with the real wall segments and 1,806 with the boxes.

## Do not reason from a truncated diagnostic

A monitor printed `tail -20` of a 30-line rejection list. Every line in the tail
said the same thing, so the list looked uniform, and an hour went into
reproducing geometry offline to explain why *all thirty* cars had failed. Four of
them had not: the lines that said something different were the ten the tail cut
off. The instrument was right, the filter was right, the geometry was right, and
the only broken thing was the window I was reading them through.

The tell was available and ignored: an earlier view of the same file showed two
different messages, and the later view showed one. A diagnostic that becomes MORE
uniform after a fix is either a fix that worked or a view that shrank.

**Count the lines against the population before drawing a conclusion from them.**
30 slots, 30 rejects, 20 lines shown — the arithmetic does not close, and that is
visible before any theory is required. `sort | uniq -c` over the reason field
takes one command and would have shown two reasons where I had seen one.

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
