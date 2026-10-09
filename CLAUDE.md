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

## A geometry price is not a frame price: x2.00 for anything the sun can see

Every price this project has quoted is a GEOMETRY count: 157 doors are +3,780
triangles, the awning round saved 5,562, a traffic car is 1,050, the fleet is
+1,560. The budget gate reads `renderer.info`, which counts an object once in the
colour pass and **again in every shadow map that contains it** — `src/post.js`
takes `info.autoReset` itself precisely so that it does.

`tools/shadow-bill.mjs` measures the factor per subsystem by turning a subsystem's
casters off and asking the renderer what it stopped drawing. **At DUSK** — the page's
boot preset, which is what a run with no `SB_TOD` measures — default camera:

    subsystem                  drawn      shadow    x bill   fwd/back apart
    pedestrians                77,176     77,042    x2.00     3.5%
    vehicles                   68,484     68,484    x2.00     0.0%   <- both car pools
    signage                    46,260     46,701    x2.01    34%     <- weak
    facade trim (near LOD)     15,708     15,233    x1.97     0.0%
    street furniture + trees  140,417     38,776    x1.28     1.7%
    facade (near LOD)           9,962      2,834    x1.28   453%     <- weak
    roads, kerbs, spill, sky        —          0    x1.00    no casters
    WHOLE FRAME               485,390    224,824    x1.463

**So a triangle added to the crowd, EITHER car pool, the signage or the facade trim
costs exactly two in the gate's number.** Street furniture is x1.28 because much
of it — distant oaks — lies outside the sun's shadow frustum, and the non-casting
rows are free. The whole-frame x1.463 is the content-weighted average and is the
wrong number to price a change with; use the row.

**Three rows moved since the first printing of this table and none of the moves was
a rendering change.** Worth separating, because each would otherwise read as one:

- `vehicles` 36,984 -> 68,484 and `street furniture + trees` 171,917 -> 140,417 are
  the SAME 31,500 triangles changing bucket. The parked pool's three shell meshes
  were unnamed, `tri-buckets` walks up to the first named ancestor, and they were
  inheriting `furniture`. See "An unnamed mesh is invisible" below — this is that
  section's second instance, in the sibling of the module it was written about.
- `pedestrians` 83,952 -> 77,176 is #74's far-tier packing, which is exactly the
  -8.1% that section claims. The table predates it.
- The old header said **noon and the run was dusk.** `shadow-bill` and
  `tri-breakdown` both recorded `tod: process.env.*_TOD ?? 'default'`, and
  'default' is not an hour — it is the absence of a flag. `TimeOfDay`'s constructor
  calls `apply('dusk')`, so every run made without the flag is dusk at sunLux 1,200
  and 0.055 rad of elevation. Both tools now read `presetName` back off the page and
  record it, which is the only version of this that cannot be mislabelled later.
  The hour is not a detail in this table: the section below on `daynight-sweep` turns
  on a subsystem's shadow factor CHANGING with the hour.

The relabelling reconciles against the old table to 0.5%, and that reconciliation is
also the evidence the old run was dusk:

    predicted, from the OLD table minus the parked cars at the x2.00 just measured
      drawn   171,917 - 31,500 = 140,417      measured 140,417   exact
      shadow   70,467 - 31,500 =  38,967      measured  38,776   -0.5%
      x                           x1.278      measured  x1.276

38,967 sits inside that row's own forward/backward spread of 38,456..39,096. A
cross-HOUR comparison could not land inside a 1.7% window — the sun's azimuth and
elevation decide which chunks are in the frustum — so the old run was measured at
the same boot preset its header misnamed. The `drawn` figures were byte-identical
between the two sessions (171,917 and 36,984 both times), which is separately what
says the two runs held the same resident set; `drawn` does not depend on the hour,
so that agreement alone could not have told us.

**And `facade (near LOD)` at x1.28 should not be leaned on**: its two sweep
directions read -3,584 and 9,252, 453% of its own figure. The `unnamed` row is worse
and reads a structurally impossible **x-77.02** on 48 triangles, because turning
casters off cannot increase what is drawn. The tool's "worst row" line picks by
absolute magnitude and so names signage at 15,667 rather than either of these; read
the fwd/back column on every row you intend to quote, not just the flagged one.

This is most of why #52's session ledger of ~+2,600 would not reconcile with
~+24,000 of gate: the ledger was in the wrong units. Done in the right ones it
closes to 87%:

    buildings, resident 5x5 NEAR window   +2,436 x~2      +4,800
    signage, resident share of +6,362     +2,602 x2.01    +5,230
    traffic fleet, +52 a car x 30         +1,560 x2.00    +3,120
    crowd near tier, seed against seed      +533 x2.00    +1,066
    night spill meshes, no casters        +2,788 x1.00    +2,788
                                                        -------
                                                         +17,004
    measured structurally by gate-align                  +19,582

**And the other half is that a district-wide price is not a per-frame price.**
`frontage-stats` prices the whole district; only the resident chunks are in the
frame, and the worst 5x5 NEAR window on the route is 137,885 of 337,148 — 40.9%.
A change spread over all 523 footprints reaches the frame at four tenths of its
district figure, and then doubles. Say which of the three numbers you mean.

### Seven versions of that tool, and what each wrong one looked like

Worth writing down because every wrong version printed a plausible table and its
own cross-check is the only thing that stopped it.

1. **The colour pass by walking the SCENE GRAPH.** Street furniture walks 398,010
   against 171,917 submitted, so every denominator was wrong; the summed shadow
   disagreed with the total by 184% and the tool refused.
2. **Colour and counter read on DIFFERENT frames** while the district grew between
   them: the counter went 700,120 -> 762,717 over a two-minute sweep, 8.94%,
   because `streaming.js` budgets uploads against the wall clock and a 20 s settle
   is not the streamer's quiet. Refused at 64%.
3. **A settle on the streamer's own quiet** fixed the drift in the colour pass to
   exactly 0 and the control still read 62.7%, because the hooks and the caster
   list were installed BEFORE the settle: one stale traverse, two symptoms — the
   hooked colour froze while the engine's climbed past it, and the casters added
   during the settle were never toggled.
4. **Re-hooking every read** got it to 66.5% and no further. The hooked walk still
   came in 115,990 short of what the renderer drew, because the streamer swaps
   meshes even once the COUNTER has gone quiet: a quiet counter means the triangle
   total is stable, not that the mesh set is.
5. **The fix was to stop using the hooked walk as the denominator at all.**
   `castShadow` does not change the colour pass, so with every caster off the
   ENGINE'S OWN COUNTER is the colour pass — one instrument on both sides of the
   ratio, and it reproduces to 0.24% across three runs (491,016 / 492,166 /
   491,351). Using the hooked figure had inflated the whole-frame ratio to
   x1.93-2.05 where it is x1.47.

**And the obvious cross-check was circular.** The forward sweep's per-bucket diffs
add up to `base - allOff` BY CONSTRUCTION, so comparing the sum with the total is
the same quantity twice — the trap this file already records under the shunt-fit
ladder. What is independent is a second PROTOCOL: re-measuring the biggest bucket
with a standalone four-read ABBA gave 83,952 against the sweep's 83,639, 0.4%
apart. That is the check worth keeping, and the per-row forward/backward spread is
what says which rows the drift beat — signage's two readings are 34% apart and its
x2.01 should not be leaned on.

## The budget gate's p95 is comparable WITHIN a session, and the spread across sessions is 17,173

This is the correction that matters most for anything the gate is asked to arbitrate,
and it was found by trying to confirm a change the gate should have been able to see.
The packed far tier removes a deterministic 14,784 triangles from the gate's own units
at a high-occupancy frame. Three runs:

    run                              samples   distance   triangle p95
    baseline, earlier session          89       3,112 m      852,605
    today, packing ON                  95       3,300 m      869,561
    today, packing OFF (control)       87       2,272 m      869,778

**Two different builds, back to back on one box, differ by 217. The same billing
measured in two different sessions differs by 17,173.** The gate is dominated by
session state, not by the build.

The mechanism is visible in the same table: **the drive does not traverse the same
course twice.** It runs a fixed number of frames, so how far it gets depends on how
much sim time each frame carried, and the distance driven over one nominal 2,654 m
route came out at 2,272, 3,112 and 3,300 m — a spread of 45%. The sampler therefore
fires at different arc positions, and `tools/gate-align.mjs` refuses both pairs:
21.1% of the same-box arms register against each other, 6.3% of the cross-session
pair. The earlier clean-box triple that measured a spread of 934 had `frames 89 89
89` — it was three runs that happened to share a cadence, inside one session, and
**934 is a within-session figure, not the gate's precision.**

Two consequences to carry:

- **The WARN is real and its MAGNITUDE is not a stable number.** 852,605 against an
  830,000 warn is over by 22,605; the same billing today reads 869,778, over by
  39,778. Both are over. Neither figure is the tree's triangle count in any sense
  that survives a session boundary.
- **Do not ask the gate to confirm a change under ~20,000 across sessions.** Price it
  offline (`crowd-bill`, `frontage-stats`, `tri-breakdown`), convert to the gate's
  units with the subsystem's own multiplier (`shadow-bill`), and assert the result
  where it is deterministic. The packing's saving is asserted by `crowd-bill` offline
  and by `boot-check` on the live page precisely because the gate cannot see it.

And a smaller trap, paid for in a seven-minute run: **`drive-through` writes to a
fixed path and ignores `--json`.** Passing one silently overwrote the committed
baseline artifact with the new run — recoverable from git, and only because the
overwrite was noticed. Copy the artifact out after the run; do not expect a flag.

## Hiding an instance is not the same as not paying for it

`src/pedestrians.js` hid a near-held pedestrian's far-tier instance with a
zero-scale matrix, under a comment saying "the far tier must not draw it a second
time". That is visually correct and it is a different statement from "the far tier
must not BILL it a second time": an InstancedMesh submits every instance below
`count`, `count` was fixed at the population size, and both tiers set `castShadow`,
so each near-held ped cost 616 triangles of nothing in the colour pass and 616 more
in the sun's shadow map.

    far tier            96 slots      85 slots
    drawing nothing     6,776 tris    0
    crowd total         83,952        77,176      -8.1%

The lever is worth taking because of WHERE it lands, not how big it is. Replayed
along the budget gate's own drive, the frame its p95 selects holds twelve near peds,
so the saving there is 7,392 geometry and x2.00 of that in the gate's number —
14,784 of the 22,605 the tree is over its warn. Far-tier waste over the top tenth of
frames is saturated at 7,392 while its median over all frames is 1,848: a reduction
that only moved the median could not touch a near-maximum statistic at all.

**Swap-remove, not compaction, and the reason is the colour.** Matrices are
rewritten every frame, so moving them is free; `instanceColor` is written once per
spawn, so a compaction that renumbered every slot each frame would have added a
per-frame upload that did not exist. A swap touches two peds and only when near
membership changes. And the reconcile is ONE pass over the population after the near
tier is chosen, not hooks on every transition — a scattered set of enter/leave hooks
is how a packed array quietly stops being a permutation.

**The defect a packed array invites is not a misplaced body, it is a misdressed
one.** A swap that carries the index and not the colour draws every body in exactly
the right place wearing somebody else's shirt, which reads as art direction rather
than as a bug. `crowd-bill` checks the colour at each drawn slot against the ped
that slot holds, and `mutation-sweep`'s `far-colour` is that mutation; nothing else
in the list sees it.

**And `far-pack` is the mutation to remember.** It reverts the packing, and NOTHING
VISIBLE CHANGES — every body is drawn in the right place with the right pose, and
the far tier simply goes back to submitting an invisible instance per near-held ped.
No screenshot and no pose assertion can see it. Only a bill can, which is why the
bill is a committed tool and on the offline list.

`crowd-bill`'s old check `hiddenInRange === nearLive` was a statement about the
unpacked behaviour and correctly failed. It was REPLACED rather than deleted,
because it was carrying something the replacement needs: it exercised `hiddenAt`'s
POSITIVE case. Without that, "nothing inside the drawn range is invisible" passes
for the most flattering possible reason — a predicate that never says "hidden"
reports no waste whatever the code does. A near-held ped's own far slot sits outside
the prefix and is written with the zero scale, so that is the known-hidden instance
the check now uses.

**Three tools indexed far instances by pedestrian number and all three had to move
with it**, which is the recurring shape here. `reaction-test` caught the change
itself, failing 5 of 148 with "the drawn torso is on its side" reading 0.0 degrees —
those five checks exist to assert the DRAWN pose rather than the module's own
bookkeeping, and an indexing change is exactly what they notice. `ground-shade` had
four addresses to move, including the read-back that PROVES its arm took: leave that
one behind and the arm blanks one body and reads another's scale as evidence it
worked. `ped-near` was correct by luck — it writes a pose directly and never calls
`update()`, so the permutation was still the identity.

And one trap in the sweep itself: `runGate` built `tools/${name}.mjs`, so adding
`crowd-bill --selftest` to its list produced a file called
`"crowd-bill --selftest.mjs"`. That is an ENOENT, ENOENT exits non-zero, and
non-zero is how the sweep spells "caught" — so every mutation in the table would
have reported itself caught by a gate that never ran.

## An unnamed mesh is invisible to every instrument that buckets by name

`tri-breakdown` reported an `unnamed` row of 31,548 triangles, 9.4% of the colour
pass, in four draws — and #52 spent a round hunting 19,582 triangles with that row
sitting in the table the whole time. It was the traffic fleet: 30 instances at
1,050 across three shell meshes. `traffic.js` named `glow` and never named its
siblings, so `/car|vehicle|traffic/` missed them.

The fix is one line, and the check that it is only a relabelling is that **the
colour-pass total does not move**: vehicles 2 draws / 2,592 -> 5 / 34,092,
unnamed 4 / 31,548 -> 1 / 48, total 336,115 both times.

`tools/tri-buckets.mjs` is now the single definition of the buckets, with its own
self-test, because `shadow-bill` needs the same ones and copying the regexes into
a second `page.evaluate` is the recurring shape of defect here. Name a mesh when
you add it; an instrument that cannot attribute a tenth of its own number should
at least say what it could not attribute, which that tool now does.

### It happened again in the sibling pool, and the second one did not announce itself

`src/traffic.js` got that fix. **`src/streetfurniture.js`'s parked pool did not, and
its three shell meshes carried 31,500 triangles into the WRONG BUCKET for every
round since.** Same module family, same three-shell split, same missing line —
patching one and leaving its siblings, again.

**It was harder to see than the first one, and the reason is worth keeping.**
`bucketOf` walks UP to the first named ancestor, and the parked meshes hang under
`furniture`, so they did not land in `unnamed` — they landed in `street furniture +
trees`. The `unnamed` row ANNOUNCES itself: the table prints "a row here is geometry
no subsystem claimed", which is what eventually got the fleet looked at. A real
bucket with a real name says nothing at all. So the first instance cost a round of
hunting and got fixed; the second was never looked for.

Dated, because the two windows are different and only one of them is long:

    the pool has been unnamed since           2026-08-31  c109275
    the first instrument that buckets by name  2026-09-06  b7f677b  tri-breakdown
    the first per-subsystem x factor           2026-09-29  8247135  shadow-bill
    found                                      2026-10-01

So **25 days of every `tri-breakdown` reading mis-attributing 31,500 triangles**, and
2 days of the x factor being wrong — the table it was wrong in is two days old. The
attribution error is the long one and the pricing error is the expensive one.

    bucket                     before      after    delta
    street furniture + trees  171,917    140,417  -31,500
    vehicles                   36,984     68,484  +31,500
    11 of 15 rows byte-identical; the other two are roads -136 and kerbs -160

**The price, not just the label, was wrong.** Street furniture bills at x1.28 — much
of it distant oaks outside the sun's shadow frustum — and vehicles at x2.00, which
is measured at **fwd/back 68,484/68,484, 0.0% apart, the tightest row in the table**.
The old table's furniture row read x1.41 (it had the parked cars in it), so 31,500
triangles of parked car priced off that row come to 44,415 of the gate's units where
they bill at 63,000: an **18,585 error, larger than the 17,173 cross-session gate
spread** and the same order as the 22,605 the tree is over its warn. A round pricing
a parked-car change off the furniture row quotes 0.705 of the true cost — the real
figure is 42% above what it says — and the error is in the flattering direction.

**The relabelling check is the same one and it needs stating more carefully than
last time.** "The colour-pass total does not move" was exactly true for the fleet
(336,115 both times) and is NOT true here: 345,006 -> 344,710, −296. The −296 is
`roads` −136 and `kerbs` −160, both STREAMED chunk rows, and `streaming.js` budgets
uploads against the wall clock — the residency confound this file records twice
elsewhere. What a relabelling actually promises is that **the moved pair sums to zero
and every row a rename cannot reach is identical**, which is what the table above
says. A third run reproduced 140,417 and 68,484 exactly while the total moved again,
which is the same statement from the other side.

**The gate that would have caught it is in `boot-check`, not in `tri-buckets`.**
tri-buckets' self-test already asserted the inheritance rule — "an unnamed mesh
inherits the nearest named ancestor" — and was correct; the rule is not the defect.
It has no scene, so it cannot see a pool that forgets to name itself. `boot-check`
now walks **both car pools' own mesh handles** and asserts every one buckets as
`vehicles`. Taking the handles from the modules matters: searching the graph for
`/car/` to check that cars are named `/car/` is circular, and searching for
geometries of 1,050 triangles hardcodes a number any change to the car breaks. And
it asserts three things first — both pools reachable, every mesh attached to the
scene, triangles actually drawn — because without them "every car mesh is a vehicle"
passes over an empty list for the most flattering possible reason.

## The drive IS a registered pair, and the p95 subtraction overstated the growth

Both `drive-through` artifacts carry `x`, `z`, `near` and `far` **per sample**, so
the comparison this project could not make was available all along. The two runs
drive the same 2,654 m course and every sample in one lands a **median of 0.10 m**
from a sample in the other (p95 0.41, max 0.54). Matching by position instead of
by percentile holds camera, route and resident set fixed:

    p95 subtraction, 828,184 -> 852,605                +24,421
    matched position, 86 pairs, p50                    +19,978
    and residency held too (same near/far), 81 pairs   +19,582   <- structural
    misregistration error a typical pair can hide          69

4,839 of that delta was the sampler. `tools/gate-align.mjs` does this, reports
whether a claim clears its own misregistration bound rather than assuming it, and
refuses a pair that does not register. It also prints what index pairing would
have said, because index pairing on runs of 92 and 89 samples compares different
ground — the same defect as pairing hero-shots frames by index rather than by name.

**Two confounds it exposed, both of which read as growth.** The crowd's geometry
is IDENTICAL between the two commits, mesh for mesh, 59,136 as built and 86,208
at capacity — `tri-breakdown`'s +11,280 on the pedestrians row is the spawn-point
fix (#66) putting the default camera on a populated street, and replaying each
artifact's own course offline through the crowd the near tier differs by +533 on
the mean with identical p25/p50/p75/max. And a fixed-camera `tri-breakdown` pair
across those commits is **not** a controlled pair: roads went 12 draws to 3 and
ground zones 11 to 2, so the two runs held different resident sets, and 31,548 of
its apparent delta is the fleet existing on the plain page at all.

## The daynight-sweep delta was near-tier pedestrians, and the 2:1 split was the shadow pass

CLAUDE.md spent a long section on `daynight-sweep` losing **9,024 triangles at
noon, golden and dusk and 4,512 at night** and concluded only that "the delta is
in what was resident or in frame when each run fired". The quantity is now named.
Two runs of UNCHANGED code at HEAD, same camera, same hour, differ by exactly
4,512 in the pedestrians row with every other row byte-identical to the unit —
furniture 171,917, signage 46,260, vehicles 34,092, roads 1,171 — and the total
moves by exactly that.

`src/pedestrians.js`'s near tier costs **2,256 triangles a ped**, which is its own
documented figure. 4,512 is two peds. 9,024 is two peds billed twice, which is
what daylight does: the sun's shadow map contains them and at night it does not.
So both numbers are the same two pedestrians standing inside 24 m of the camera in
one run and not the other, and the 2:1 split that looked like evidence of
structure is the factor of two above.

## Two saturations stacked, and the finding blamed the one it could see

`FLOORLESS_CAP` clipped: `Math.min(raw, cap)`. So a floorless crime charged the same from the
severity at which the raw product reached the cap to the top of its range, and #90 was filed as
"the cap flattens everything above one star" with a table of flat fractions per crime. Replacing
the clip with a soft knee — `cap - (cap/2)^2 / raw` above `k = cap/2`, linear below, C1 at the
join with no constant to tune — fixes that, and the pair the finding named separates x13.3:

    22 vs 88 km/h into a civilian car   clip 0.9854 / 1.0000   0.0146 apart
                                        knee 0.7463 / 0.9400   0.1937 apart

**And it does not flatten any less above 44.5 km/h, because the second saturation is upstream and
no shape of cap can reach it.** `crimeScale` is `severity / majorSeverity`, and `severityFor`
clamps severity at 1 once the delta-v reaches `killDv` — the right rule for DAMAGE, since one
impact cannot cost more than the whole car — so the scale itself reads **8.333 at 50, 60, 80, 110
and 140 km/h**. Isolating one term at a time, which is the only way this decomposes:

    a wall           the knee bends at 20.5 km/h   the clip flattened from 28.5   the SCALE is flat from 44.5
    a civilian car   the knee bends at 16.5 km/h   the clip flattened from 22.5   the SCALE is flat from 44.5

So the knee recovers the band between the cap and the scale's own ceiling, and the finding's
headline example at 88 km/h sits in the region only `severityFor` can reach. Split out as #93
rather than fixed here, because a crime scale that does not inherit a damage-bounded quantity
moves every `crimeScale` number in four gates.

**I measured the wrong thing first, and the wrong answer was the instrument.** The first probe
counted what fraction of each crime's severity range was "flat" by stepping the range and
comparing successive charges at four decimal places. The knee is strictly monotonic, so it is
never flat — the figures it printed (53%, 47%, 57%) were the resolution of `toFixed(4)`, and
`evading` came out MORE flat under the knee than under the clip, which is impossible. A metric
whose answer is its own quantisation reads as a result. The honest statements are the two that
need no epsilon: **how many ties there are** (0 of 20,000 steps for the knee, 16,000 for the clip)
and **how far apart two named severities land**.

**One gameplay consequence, worth separating from the fix.** A knee is asymptotic, so a single
110 km/h write-off into a building charges 0.9000 and reads **0 stars** where the clip charged
exactly 1.0000 and read 1. Keeping it is the argument that `propertyDamage` has no `min` — which
the table says means "not on its own enough to make you wanted" — and a ceiling set AT the lowest
floor granted precisely the star the missing floor denies. It is not immunity: two building hits
are a star. But it is a change a player can feel, so `damage-test`'s "a write-off is worth a star
where a scrape is not" was restated rather than quietly re-tuned, and the alternative is recorded
in the backlog.

**And the cap was covering for a missing guard.** `opts.scale` had no validation at all. A NaN
scale made `heat` NaN and the meter then never rose again — `NaN >= 1` is false, so the player was
immune for the rest of the session with the HUD reading 0 stars and nothing in the console, which
is this file's "non-finite delta-v, and the immortality it buys" arriving through the other door.
A scale of −1 charged 0. `Infinity` survived only because the clip clamped it, so the knee would
have inherited that one too. Both are charged at the table value now, counted in
`stats.badScales`, and have two mutation rows rather than one: a finite check alone does not cover
the sign, which is this file's "guard the DIRECTION as well as the magnitude".

## A module's player argument can be a WHITELIST, and a field it does not name is dropped in silence

`src/wanted.js` does `player = this._sanitize(player)` at the top of `update`, and `_sanitize`
copies a fixed list of keys into one reused object. Adding `player.holdSeconds` to both hosts and to
`bindPursuit`'s pass-through was not enough: the field never reached `_watchBust`, which read
`undefined` and fell back to `BUST_HOLD_S`. **An arrest 508 m from the nearest road took 4.0 s
instead of 72.7**, and nothing errored.

**What caught it was the counter added in the same commit for exactly this.** The fallback is the
flattering one — a shorter arrest, not immunity — so `stats.bustNoWalk` counts the frames the clock
ran without the host saying how far the officer had to come, and both shipped hosts wire it, so a
non-zero count is a wire that has come loose. It read 1 and that was the whole diagnosis.

**And then I nearly misdiagnosed it.** A probe logging `player === session._wantedPlayer` inside
`_watchBust` printed `false`, which sent me grepping for a second caller of `update` that does not
exist. The object identity was worth being suspicious of and the reason was wrong: `_sanitize` is a
COPY, not a different source. `Object.keys(player)` would have said so in one line, because the
whitelist's own key list is the answer.

Two rules: **when a field you just added does not arrive, print the keys of the object that
arrived**, not its identity. And **a whitelist is a contract, so declare the field there** rather
than working around it — the sanitiser is also where the non-finite guard belongs, and
`Math.max(FLOOR, NaN)` is NaN, `bustFor < NaN` is false, so a NaN walk would have fired the arrest
on the first frame of the hold. That is this file's "non-finite delta-v, and the immortality it
buys" arriving as its exact opposite.

### And the arm that tests it was a dirty tree for the arms after it, for the second time in one session

The section above this one records a browser arm that drove 42 m through a crowd and broke six
checks in three later arms. Two hours later, the arm for THIS change set four stars, got the player
arrested, respawned the car and aborted the running mission — and broke five checks in the run-over
and garage arms below it. Same shape, same file, same session, after writing the lesson down.

The rule that actually holds, rather than "be careful": **an arm that cannot avoid perturbing the
page goes where there is nothing left to perturb.** This one is last in the file now, and it still
restores the page afterwards, because "nothing runs after it" is a fact about today's file order and
not a property of the arm.

Two more things that version got wrong, both of which printed a number over a build that works:

- **It chose its remote spot by distance from the SPAWN.** 84 m out on sixteen bearings, first
  clear one wins — and that point was **3.0 m from a road**, so the ordinary 28 m reach arrested it
  in 4 s and the arm reported "0 units held". The quantity it needed was distance from the ROAD
  NETWORK, which is the same confusion as measuring a pedestrian against "the nearest centreline"
  rather than the carriageway they are beside, one section up. `__district.roadDistance` is the
  router's own projection, so the gate and the game agree about where the roads are.
- **Appending it to the end of the file put it after the summary**, where its checks would have
  printed below `BOOT: PASS`. That is `mission-test`'s snapshot defect — a gate printing FAIL lines
  under its own PASS line — reached by text position rather than by a stale accumulator. The
  verdict block is not the end of a gate file; the last ARM is.

## Isolate the whole chain before blaming the end of it, and the threshold that classifies is part of the instrument

#104 reported knockdowns at 1.33-2.17 per km "on the carriageway" and read it as the crowd standing
in the road. Four quantities, each measured against the code's OWN definition rather than a second
copy, over 3 seeds and 9.99 km with `peds.hit` hooked so the subject is read on the frame of impact:

    0 of 57    struck pedestrians were inside ANY carriageway   by _onCarriageway, the module's own
    max 1.32   of a 1.30 m bound ACROSS the car's axis          BODY_RADIUS + PERSON.bodyRadius
    0 of 2012  lane points put the car's CENTRE on the pavement the router, offline and instant
    36 of 36   street knockdowns had the car's BODY over the kerb, p50 0.82 m PAST it

**Three of the four candidates are clean and the fourth is the whole of it.** The crowd, the contact
test and the router each took one measurement to exonerate, and the one that was left — the
follower leaving its own lane — is what `reaction-test`'s own section had already concluded in a
sentence. So the round's value was not a new defect; it was splitting "the car is off the road" into
router and controller, which nothing had separated.

**And the classifier was the reason it read as a crowd defect.** The entry called a knockdown "on
the carriageway" when the CAR was under 4.5 m from a centreline. The half widths in the sample run
**1.40 to 3.50 m**, so 4.5 m is on the pavement of every road in it. A threshold picked rather than
read off the geometry, applied to the wrong body — and it inverted the conclusion. This file already
says a check comparing against an absolute number needs the sweep a measurement does; the same is
true of a number that only CLASSIFIES, and there the error is silent because the classifier never
fails.

Two instrument errors on the way, both of which printed zeros:

- **The first probe joined `lastHit.id` against `positions().i`** — a person id against a slot index
  — found nothing, and printed 0.00 on every carriageway column. Both sides zero, in the reassuring
  direction. Hooking `peds.hit` gives the slot AND the frame, and the probe now THROWS if it cannot
  find the subject.
- **`nearestOn` returns the nearest centreline, which at a junction is a different road's.** The
  first reading had peds at 1.40-1.50 m from "a" centreline and looked like a crowd standing in the
  lane; measured against the carriageway the ped is actually beside, it is 0 of 57. **A distance to
  the nearest X is not a distance to the X the subject belongs to.**

## The flat case a reviewer isolates is often the one case where the floor wins

#103 reported that "every pedestrian strike up to 59 km/h is the same one star" and isolated a
SINGLE victim at 23.7 / 43.5 / 51.7 / 58.8 km/h, reading heat exactly 1.0000 and 1 star at every one.
Every number is right. The ladder nobody had looked at:

    km/h    scale     raw   strikes to 2*   heat after 2 strikes
    10     0.0049  0.0099        >60              1.010
    23.7   0.0169  0.0337         31              1.034
    43.5   0.0962  0.1923          7              1.192
    58.8   0.3335  0.6671          3              1.667
    76.7   1.0009  2.0018          1              4.004   pedestrianKilled, min 2

**The flatness is the FIRST strike only.** `reportCrime` does `max(heat + delta, c.min)`, so at heat
0 the floor REPLACES the charge; from heat 1 it is a floor and the severity accumulates on top. A
sweep that varies the SPEED and holds the strike count at one is a sweep that only ever samples the
replaced case — this file's "isolate one term at a time" with the wrong term held fixed.

Three things to carry, and the third is the one that cost a correction:

- **Vary the repetition as well as the magnitude.** The quantity a player reads is "how many of
  these before the police escalate", and it moves 31 to 1 over this range while the thing the
  reporter measured does not move at all.
- **The input's monotonicity is not the output's.** `damage-test` already asserted `pedCrimeScale` is
  monotonic in speed. Nothing asserted that a faster strike is WORSE, which is a different sentence
  and the one a player would file a bug about. `wanted-test` §f3 is that gate now.
- **Derive the boundary, do not name it.** My first version of the KNOWN-BADs said "below the
  fatality switch the charge is always under the floor", and the gate caught it on its first run:
  67.7 km/h is below the switch at 76.7 and charges 1.2334 against a floor of 1. The boundary is
  where `c.heat * scale` overtakes `min` — scale 0.500, scanned off the module at **64.5 km/h** —
  and the reporter's band stops at 58.8, just under it. src/wanted.js's own comment had already said
  "every scale under 0.5 comes back out as one star".

**And the obvious lever was measured and refused by construction.** `max(heat, c.min) + delta` does
make the first strike graduate — 1.034 / 1.192 / 1.382 / 1.667 where today all four are 1.0000 — and
it over-charges at the top *because the table was built to make the two meet there*:
`pedestrianKilled`'s `min` is 2 and its charge AT the fatality switch is 2.0018 by design, so lifting
one by the other makes one kill four stars where the table says two. It is kept as a mutation row
with that reasoning in its own `why`, which is what stops the next round re-deriving it.

### A gate that already priced a refusal is the thing to grep for before filing it again

The same finding's second half — `reckless` is in the crime table and nothing files it — I nearly
filed as this file's "A system that is never switched on is not a feature". It is the opposite.
`damage-test` counts the orphans, prints all nine, pins the count, and says in as many words: "The
remaining nine are a **priced refusal**, not an oversight: the systems that would file them do not
exist... and reckless driving, **which has no speed limit to break**. The count is pinned so adding a
crime without a reporter is visible in the diff."

So the reviewer's observation was exact, their diagnosis was answered three months ago, and the
correction cost one `grep` for the crime's name across `tools/` — which is also where the pin lives.
**Before filing a dead feature, grep the gates for its name, not just the source.** A refusal that
has a number and a check is a decision; one that has neither is the defect.

## A saturation that costs nothing is not a defect, and the one place it costs is the one nobody looked at

#93 was filed off a correct reading: `crimeScale` is `severity / majorSeverity` and `severityFor`
clamps severity at 1 at `killDv`, so the scale saturates at **8.333 from 44.5 km/h** and a 50, an
88 and a 140 km/h collision are one offence to `src/wanted.js`. The entry's lever was a scale that
does not inherit a damage-bounded quantity, and it priced itself honestly: "every number in
damage-test, wanted-test §24, crash-test and boot-check's run-over arm moves".

**That price was the whole answer and I read it as a cost rather than as a result.** A change whose
only measurable effect is on gates is a change with no gameplay effect, and the sweep says so
flatly — unclamped against shipped, stars over one to six impacts:

       50 km/h  scale   8.33 ->   11.07   012345  against  012345
       80 km/h  scale   8.33 ->   28.68   012345  against  012345
      140 km/h  scale   8.33 ->   88.27   012345  against  012345
      180 km/h  scale   8.33 ->  146.05   012345  against  012345

Byte-identical at every speed. The reason is #90's own fix: `civilianCollision` is floorless,
`FLOORLESS_CAP` is 1, and the soft knee asymptotes at the cap — so a **x17.5 larger scale buys
0.06 of a star.** The second saturation that #90 could not reach is doing the work the clamp was
being blamed for.

**And the one crime where it is NOT invisible is the one the entry never named.** `policeProperty`
has a floor and no cap, so it is the single row the scale reaches linearly: 180 km/h goes
**10.0 -> 175.3 of heat**, five stars from one ram with the meter saturated for the rest of the
session. So unclamping would have moved nothing where the entry said it would and broken the one
place it was not looking.

**AND THAT ROW HAS NEVER BEEN PLAYED, which a round-10 playtester established while I was writing
this.** `tools/playtest.mjs`'s contact pass iterates the traffic fleet and the crowd and NOT the
pursuit units, so `policeProperty`, `roadblockRun`, `officerAssault` and `officerDown` — the four
highest-heat entries in the crime table — cannot be filed in the harness at all. They tried: 3 seeds
x 120 s steering at the nearest `enemy` blip at four stars gave closest approaches of 16.26 / 22.27
/ 21.30 m and **0 police-kind damage records** against 10,401-10,991 wall records. `district/main.js`
does have that pass, so it is an instrument gap and not a missing feature.

The conclusion above stands — the 175.3 is arithmetic off the crime table, not a play measurement —
but **the sentence "it would break the one place it was not looking" rests on a branch nothing has
exercised**, and that is worth knowing before anybody leans on it again. Saying which of your own
claims sits on untested ground is cheaper than having somebody else find out.

Three things to carry:

- **Measure what a saturation COSTS before fixing it.** "The scale is flat above 44.5 km/h" and
  "the player cannot tell" are both true here. The first is a property of one function; the second
  is the property anyone cares about, and it needs the downstream ladder, not the scale.
- **A cap downstream of a saturation hides it, and that is the common case here, not the rare
  one.** Two of this file's sections are already about stacked saturations. The rule that falls
  out: when a quantity is flat, follow it to the thing a player reads before calling the flatness
  a defect.
- **Ask which rows have a floor and no cap.** They are where an unbounded scale lands, and there
  was exactly one. A sweep over SPEED alone would have missed it; the sweep has to be over the
  crime table too.

Closed by measurement rather than by a patch, with the sweep committed as `wanted-test` §f2 so the
next round does not re-derive it.

## Six sites read one nominal car length, and the price quoted for all six was one site's

#56's last open half was per-shell `CAR_LENGTH` in `src/traffic.js`. The module builds three shell
geometries and then compared every gap against a single `CAR_LENGTH = 4.4`. The fix measures each
shell's z extent **off the buffer the module has just built** — 4.493 / 4.635 / 4.689 — rather than
carrying a table, so an overhang change in `src/carbody.js` cannot drift it, and `tools/car-shapes.mjs`
reads the same quantity the same way off the same buffers: the two agree by construction instead of
by a number typed in twice.

**The backlog's 0.289 m was the right number for one site and the wrong one for another, and they
differ by x3.1.** The two subtractions are not the same shape:

    _gapAhead      `best` is centre to centre, so a WHOLE LEADER stands between them   0.289 m
    _playerGap     `along` is centre to centre, so HALF of each body does              0.094 m

and the player's half is `PLAYER_HALF_L`, not a pool shell, because the player's car is not a
traffic shell. So the coupe gives 4.493/2 + 2.15 = 4.396 against the 4.4 it replaces — **four
millimetres** — and the shipped nominal was very nearly exactly right at that site all along.
Quoting the car-to-car figure for both overstated the player-following case x3.1, and
`traffic-selftest` §10 asserts the two numbers APART for that reason rather than asserting one
length.

**The seeded-stream perturbation the deferral was about was measured, and it is the opposite of
the one this file already records.** The leader-term change took the building check from 0 of
215,960 car-frames to 342, because cars that brake take different `_chooseNext` draws and drive
edges the old sequence never reached. This change moves a threshold by centimetres and does not
change which edges anyone drives:

    car-frames        215,965 -> 215,959
    inside a building       0 -> 0
    overlap pair-frames     0 -> 0
    closest approach      4.1 -> 3.93 m

**So "it perturbs a seeded stream" is a reason to measure, not a reason to defer.** The deferral
was three rounds old and cost more than the measurement did.

And one gate caught one of my own defects while I wrote it: `traffic-selftest`'s rig has a check
that the rig car carries every field a spawned car has, and the rig's `place()` was handing out a
car with no `body`. Without `body`, `other.t < EXIT_CLEAR_NEEDED - CAR_LENGTH + other.body` is
`< NaN`, which is false, which is "the junction is clear" — the silent-NaN shape this file records
under `arm-diff`, arriving through a test rig. A generic "the rig builds what the module builds"
check found a defect nothing specific to this change was looking for.

## You cannot ask a local optimiser for a global optimum, and three mechanisms looked like one symptom

#89 closed the arrest stalemate by letting a unit stop where it "cannot get closer", written as
`near.d <= bestApproach(target)` — the minimum over all 935 edges, exactly. `_chooseNext` is a
greedy descent on the distance from an option's **far endpoint** to the target; `bestApproach`
minimises an edge's **closest approach**. They are different functions, so the minimising edge is
one no unit will ever drive, and at those spots the condition is unsatisfiable by any unit:

    the router reaches a minimising edge     319 of 516 clear spots 30-140 m off a road
    it never does                            197 of 516   38%
    where it does not, the closest edge it CAN reach is
      p50 31.71 m further than the network's own, p90 153.97, max 190.02

**`reachRadius` is 28 m, so no tolerance of the form `best + reach` rescues even half of that**,
which is what killed the candidate fix drafted before the measurement. The fix is the QUANTITY:
"this unit cannot get closer" is a property of its own option set. The guard stays global, because
"can the roads reach the player at all" genuinely is one. **Two questions, two quantities, and the
same expression had been answering both.**

    admission                        arrested       p50      newly   lost
    global, `near.d <= best`         45 of 107    16.5 s         -      -
    local                           100 of 107    25.0 s        55      0
    local AND the walk is clear     101 of 107    25.5 s        56      0
    the officer can walk the line   101 of 107                         <- the ceiling

**Measure the CEILING separately, before the fix, or a coverage number means nothing.**
`_footPathClear` from the stop point is clear at 101 of those 107 spots and that is not a defect —
a player with a building between them is not being held by anybody. Without it, "100 of 107" is a
number with no scale; with it, the fix is within one spot of everything available.

**Three mechanisms, one symptom, and the two small ones would each have survived a fix for the
big one.** Where the minimum sits at an edge's far ENDPOINT, the clamp fires on the one frame that
also triggers the reroute, which clears the flag — 730 and 1,460 unit-frames on a minimising edge
with the approach clause true in 1 and 2 of them. The reroute's own comment said the unit
"re-holds on the new edge at t = 0", which is TRUE inside the reach, where the admission is a
radius both edges satisfy, and was false outside it: this file's "a guard can be right about what
it demands and silent about the case next door", arriving as a comment rather than as a check.

### "True in exact arithmetic" is not "bit-identical", and a few ULPs decided whether an arrest was possible

`bestApproach`'s comment said **NO EPSILON, BY CONSTRUCTION**: both numbers come out of
`_closestOn` on the same target, and its `d` does not depend on `forward` — only its `t` does.
The first two sentences are true. The conclusion is not: `_closestOn` REVERSES the point list for
a backward unit, so every segment vector is negated and the projection fraction is recomputed from
the other endpoint. The identical real number arrives through a different pair of roundings.

    88 targets x 935 edges = 82,280 pairs
      forward and backward `d` differ        186 pairs   0.23%,  worst 2.274e-13 m
      on a MINIMISING edge, backward > best    5 of 89   5.6%

So on 5.6% of minimising pairs a unit driving that edge BACKWARD failed `near.d <= best` by a few
ULPs and could never stop. The tolerance is measured — 1e-6 m is 4.4 million times the noise and
500,000 times below the module's shortest length — and the old claim is corrected in place rather
than deleted, because the next person to write "by construction" about a float comparison should
find this.

### When one host works and another does not, run the SAME input through both before believing the hosts differ

#108 was filed as "the two hosts disagree about how sticky a long arrest hold is", off a real
observation: `boot-check` latched the right clock at 57.4 m and advanced it 0.145 s over 103
frames, while `arrest-band` arrested at 37 to 186 m through `playtest`. Every candidate cause in
the entry was wrong, and one `Session` disposed of it:

    boot-check's spot, run through tools/playtest.mjs   busts 0, held on 0 of 480 steps
    arrest-band's 60 m row, same harness                busts 1, held on 17 of 31 steps

**The hosts agree. The SPOT differs**, and 57.8 against 59.2 m of road distance is not the
variable — local topology is. The entry's recommendation ("make the hold sticky once armed") was
aimed at the wrong flag: of 363 stopped unit-frames at that spot, `held` equalled the foot-path
test in 363, with 0 stopped-and-not-held. `u.stopped` was the variable the whole time.

**And the first probe after that confounded two columns and came back inverted.** It measured the
GAP between the best and second-best edge approach, on a story about near-ties: the two spots that
never arrested had a mean gap of **0.50 m** against **15.68 m** for the eight that did — the
opposite of the hypothesis. Their mean road distance also differed, 63.3 m against 49.8, so with
ten spots neither column could be named: an arrested spot sat at 67.9 m and a failing one at 54.6,
which is the ranking the distance story needs and does not get. A candidate fix was already
drafted on the tie premise. The measurement that settled it removed the physics altogether and
walked `_chooseNext` directly — no sim, no seeds, 516 spots inside two minutes. **When a sim probe
cannot separate two columns, ask whether the question needs the sim at all.**

### A term whose coverage effect is one spot in 107, kept for a reason that is not coverage

Requiring the officer's walk in the ADMISSION and not only in the hold buys exactly one spot of
107 and moves the median arrest by 0 — by this file's own standard ("a row nothing can tell apart
is not evidence of coverage") that is a term to delete. It is kept, and the argument is a cue
rather than a number: without it **27% of stopped unit-frames are a police car that has pulled up
with no officer able to reach the player** (stop 63.7% against held 46.8%), and a unit stopping is
the only signal this game gives that an arrest is beginning. A build where that signal means
nothing a quarter of the time lies to the player. With the term the two states coincide at 50.9%
and 50.9%, by construction — so `pursuit-test` asserts the COINCIDENCE, labelled as true by
construction, and `mutation-sweep`'s `arrest-walk-admission` is what gives the assertion teeth.
**State which kind of argument a term is kept on**; "it is 1 of 107 and here is why that is not
the point" is a decision, and leaving the number out would have made it look like coverage.

### And the bound that caught the move is the one the gate had already restated once

`pursuit-test`'s "a holding unit is inside the reach OR at the closest the network gets" failed at
a worst excess of **82.949 m against a 1.400 m bound** on the first run after the admission went
local. That is the gate doing its job twice over: the check had been restated once already, from
`holdRadius` to `reachRadius` to `max(reach, bestApproach)`, each time in the commit that moved
it. The third restatement is the same bound PER UNIT — and it is computed from `data/district.json`
by the gate's own `approachTo`/`optionsTo` rather than by the module whose rule it is judging,
because asserting `_localBest`'s condition with `_localBest` is the self-validation this file
records under the shunt-fit ladder. The dead-end frames, where the bound is correctly infinite,
are counted and printed rather than silently admitted.

## A module that clamps dt cannot be driven by one big step, and the wrong answer was a motionless number

Measuring #97's ladder needed one wall strike, then the type refractory stepped out, then another.
The probe did it as `w.update(C.refractory + 0.01, player)` — one 2.51 s call — and got this:

    hits   heat after the hit   heat after the wait   stars
      1               0.9000                0.9000       0
      2               0.9000                0.9000       0
      6               0.9000                0.9000       0

and a table reading **11 hits to one star where the answer is 2.** `WantedSystem.update` opens with
`clamp(dt, 0, this.maxDt)` and a comment saying why — "one 900 ms hitch must not hand the player
most of an escape" — so a 2.51 s call advances the module's clock by 0.25 s, the refractory never
expires, and every second `reportCrime` comes back `applied: false, reason: 'refractory'`. Stepping
the same 2.6 s in 0.1 s slices gives 0.9000 -> 1.7820 -> 2.6820 and the right ladder.

**The tell was a number that did not move.** Heat identical before and after a 2.51 s wait, with an
idle bleed that should have taken something off it — three readings of 0.9000 in a column that
cannot be constant. This file's rule is that the most dangerous shape a measurement bug can take is
the one whose wrong answer is reassuring; this is the variant where the wrong answer is *inert*, and
inert is just as easy to read as "stable".

It is the mirror of this file's "a model integrated at the game's dt is measured at the harness's".
There the harness's big step changed the answer by integrating coarsely. Here the MODULE defends
itself against a big step, correctly, and the harness's step size silently stops time instead.
**Check whether the thing you are driving clamps its own dt before choosing a step size, and prefer
the slice the game uses.**

### And the reaching knee is refused by arithmetic, which the quantisation artefact found first

#97's obvious fix is to let `floorlessCharge` REACH `FLOORLESS_CAP` rather than asymptote to it, so
that one write-off earns the star the cap denies. The family that is identity below the knee, C1
there with slope 1, and equal to the cap at the top of the crime's own range is
`k + (cap-k)(1 - (1-u)^p)` with `p = (rawMax-k)/(cap-k)`. It works and it is not a fix:

    crime              rawMax-k  cap-k  mean slope   p    slope over the top tenth
    propertyDamage        2.000   0.50     0.2500  4.00               2.50e-4
    civilianCollision     3.667   0.50     0.1364  7.33               6.33e-8
    brandish              4.500   0.50     0.1111  9.00               1.11e-9

**A curve that compresses 2.0 to 4.5 of input into 0.5 of output while starting at slope 1 must end
far flatter than its mean slope.** That is the clip's flatness #90 removed, in a smooth wrapper, and
no choice of shape escapes it — the input range being several times the available output range is
the whole of it. The lever that reaches a star while staying ordered is a BIGGER CAP, and the crimes
want different ones (1.127 and 1.068), so one shared constant cannot deliver it.

**And my monotonicity scan announced this before I understood it.** It stepped the curve 20,000
times and reported three of five crimes NON-MONOTONE, which is impossible for a strictly increasing
function — consecutive samples were coming out bit-equal because the curve is numerically flat up
there. I was about to go looking for a bug in the scan. **When a scan says a provably monotone
function is not, the resolution it lost is the finding**: ask what quantity went below the
instrument rather than what is wrong with the instrument.

### A cap that answers a question about one crime is derived from another crime's floor

`FLOORLESS_CAP` is `min(every floor in the table)`, which is `hitAndRun.min` = 1, and one star is
heat >= 1. So **"can a single property-damage offence make a player wanted" is answered by the floor
on leaving the scene**, and the two coinciding is a fact about the table rather than a decision
anybody took. The comment above it says the rule is that a floorless crime "may not out-charge the
lowest floor" — which permits equality, and equality is exactly the star. The shipped asymptote
denies it.

Worth keeping as a shape rather than as this instance: **when a constant is derived as an extremum
over a table, check what it is being asked to decide.** `min(floors)` is the right answer to "what
must a floorless crime not exceed" and an accident as an answer to "how many stars is a write-off",
and one expression was doing both.

## An arm's own setup can spend the margin the arm needs, and the symptom names the wire

`boot-check`'s run-over arm stages a body 14 m straight ahead, kills it where it stands so it
cannot walk off, and drives at it blind on `steer: 0`. It was flaky **1 run in 3**, and the failing
run read exactly like a broken feature:

    run 2   body 14.3 m from the car before the move   36.1 m driven, "travelCap", 0 run-overs
    run 3   body 11.5 m                                14.4 m driven, "ranOver",  8 run-overs

    FAIL the arm actually drove over a body, so both sides are not zero   0 -> 0 run-overs
    FAIL a run-over reaches the crime path at all                         []
    FAIL and its scale comes from the speed, not a literal 1              none
    ... and three more, two of them in the GARAGE arm below it

**The arm's own knockdown spends half of its margin**, which is a real defect and — see the
correction below — is NOT established as the cause. `peds.hit(..., { speed: 3, kill: true })` is
fatal by declaration, so the speed only decides how far the casualty slides — `throwDistance` is
`v^2 / (2 mu g)` — and the arm slid it ACROSS its own axis, deliberately, so a slide could not
carry the body out of the run-up. 3 m/s is **0.695 m across a 1.30 m contact window**
(`BODY_RADIUS` 0.95 plus the person's 0.35, which is the across-axis bound CLAUDE.md #104 measured
at max 1.32 over 57 strikes):

    kill at 3.0 m/s   slides 0.6950 m   0.605 m of lateral margin left   47% of the window
    kill at 1.0 m/s   slides 0.0772 m   1.223 m                          94%
    kill at 0.5 m/s   slides 0.0193 m   1.281 m                          99%

**53% of the arm's lateral budget was spent before the car had moved**, leaving 0.605 m for every
other source of drift over a blind 14 m run. It is now 0.5 m/s, which keeps 99% of the window and
is still a real slide rather than a zero, so the direction arithmetic stays meaningful.

**And the missing number is the one that separates the two diagnoses.** `0 run-overs` cannot tell
"the car passed 1.8 m to the side" from "the car drove over it and the wire is broken", and those
send a round to opposite places. The arm now measures the PERPENDICULAR miss against the axis it
placed the car on — `(fz, -fx)` is the right-hand normal of the placement heading, so it needs no
steering-sign convention — prints it beside the contact window, and asserts it. A miss outside the
window is a geometry failure in the arm; a miss inside it with no run-over is the wire.

The general shape, and this file already has it from the other side ("an arm that perturbs the page
is a dirty tree for every arm after it"): **price an arm's own staging against the tolerance the
arm depends on.** The staging here was written to solve a real problem — an earlier version slid
the body 55 m BEYOND the run-up at 30 m/s, three runs, three zeros — and the fix for that spent
half the budget of the next thing.

### And the new diagnostic refuted the fix it was added to confirm, on its first run

The paragraph above originally read "the arm's own knockdown was the cause". The miss diagnostic's
own first run says otherwise:

    the drive ended on "travelCap" after 35.2 m of a 14 m run
    closest 14.38 m, perpendicular miss 0.483 m against a 1.30 m contact window

**0.483 m is comfortably inside the window and `closest` never fell below 14.38 m on a body placed
14 m ahead** — which is the car not having approached at all. No slide explains that, so the slide
was half the margin and not the cause, and the smaller slide is a correct change that may fix
nothing. Say which of the two a measurement establishes.

**And the diagnostic was wrong in the way the file already warns about.** Both `closest` and the
first version of the lateral miss index `positions()` by SLOT, and the comment twenty lines below
them says why that is not the body: a slot is recycled once its casualty clears, after which the
index is somebody else standing somewhere else. So two numbers that cannot both be about one
subject — 14.38 m away and 0.483 m to the side — is exactly the signature of a slot-indexed probe,
and this file records the identical error in #104's first probe, which joined a person id against
a slot index and printed 0.00 on every column.

### Version 2 took the SAME slot lookup once and called it a fixed point

"Measured against a point instead — the body's position taken once, after the kill" is what this
section said next, and it is the same defect with a timestamp on it. That run reported

    overs 0 -> 8, ended on "ranOver" after 14.4 m      every wire check passing
    against the body's own position: 1.203 m along, 11.05 m to the side

and **a body 11 m to the side cannot be run over eight times.** Taking a slot lookup once does not
make it a point; it makes it a point about whoever held the slot at that instant.

**The answer needed no lookup at all.** The arm places the car 14 m back along `approach` FROM
`spot`, so `spot` IS the body's position by construction, and the kill slides it 0.0193 m — two
centimetres, 1.5% of the contact window. Three versions to arrive at the coordinate the arm had
typed in itself.

So the rule, which is the one general thing here: **when a module renumbers its slots, take the
geometry from what YOU placed, not from what the module reports at an index.** `positions()[].i` is
a slot, `src/pedestrians.js` packs its far tier with swap-remove, and the comment on `closest`
twenty lines below both probes had said the index is not the body the whole time.

With the point right, the three failures `0 run-overs` was lumping together come apart, and they
want three different fixes:

    the car never reached it             `nearestAlong` above the 2.50 m nose reach
    it reached it and passed to one side  `sideMiss` outside the 1.30 m window
    it went over it and nothing charged   the wire, which is every check below

Both bounds are read off the geometry rather than picked: along the axis the nose is
`HALF_EXTENT.z` 2.15 m ahead of the centre, so contact begins at 2.15 + the person's 0.35; across
it the bound is `BODY_RADIUS` 0.95 + 0.35 = 1.30, which is what #104 measured at max 1.32 over 57
strikes.

**And the second check is an agreement rather than a bound, which is what makes it catch an
instrument as well as a build.** "A run-over happened exactly when the car passed within the
contact window" fails in both directions and they mean opposite things: geometry says contact and
the counter says none is a broken WIRE; the counter says contact and the geometry says it passed
11 m away is a broken INSTRUMENT. Both of this probe's wrong versions would have been caught by it
on their first run, and the bound-shaped checks they shipped with were not.

### And a check that could only ever pass on another arm's crime

The five further failures were one check and a cascade. `boot-check`'s garage arm clears the wanted
level, breaks the car with one `dv: 7.5` wall impact, and asserted `stars > 0` — "breaking the car
charges a crime", the host's impact-to-crime wire. **#97's ladder, measured in a different file in
the same round, says that is unreachable.** `dv 7.5` into a wall files `propertyDamage`, which the
table gives no floor, and `FLOORLESS_CAP`'s soft knee holds one such offence strictly under one
heat:

    severity 0.2729   scale 2.2743   raw 0.6823   charged 0.6336   ->   0 stars

Two hits would be 1.2402 and one star. One cannot be anything but zero. So from that
`clearWanted` the star count after the impact is **always** 0, and the check had been passing on
heat left behind by an earlier arm: the run-over arm charges `pedestrianHit`, which arms a scene,
and the garage arm's own teleport then LEAVES that scene — filing `hitAndRun`, whose floor is 1. On
a run where the run-over arm hit nobody, there was no scene to leave, the star count read 0, and a
check about a wall impact failed because of a pedestrian two arms earlier.

The arm's own comment said it must not "silently be measuring the refusal again". It was silently
measuring a different arm's pedestrian.

Three things to carry:

- **Assert the quantity the wire produces, not a quantity downstream of a threshold.** Heat is what
  an impact charges; stars is heat past a cap that a single floorless crime cannot reach. The check
  reads `heat > 0` now and splits into two, because "the impact charged something" and "the clear
  worked" are two statements and one bound was covering both.
- **A measurement round pays for itself in other files.** Nothing was wrong with the garage arm's
  code; what changed is that #97's ladder told me what one property-damage offence can charge, and
  that falsified a check in a gate I was not looking at. **When you measure a ceiling, grep the
  gates for assertions that sit above it.**
- **Intermittent in one arm, failing in another: look for the state one passes to the next.** Of
  the six failures, four were one arm's missed drive and two were a later arm reading the heat that
  drive would have left. Neither arm was wrong about its own subject.

### It was a RESPAWN, and five theories died before anybody logged the path

The cause of the flakiness is none of the above. The track — x, z, speed and yaw per frame, which
cost four lines and should have been the FIRST thing added:

    frame 1-3   (-341.8, 73.9)   0 km/h    yaw 3.14     placed, at rest, pointing at the body
    frame 4     (-327.8, 63.3)   3.9       yaw 0        jumped 17.6 m and turned 180 degrees
    then        x pinned at -327.8, z climbing to 107.3, 14.5 km/h, yaw 0 throughout
    damage impacts across the drive   1 -> 0

`district.meta.spawn` is **(-327.84, 63.3), "Bayfront @ Main St"**. So the car was RESPAWNED three
frames into the arm's own drive: `respawnCar` zeroes the wreck clock, repairs, teleports to the
nearest road and leaves yaw at 0, after which the car drove perfectly straight along its NEW
heading — 14.5 km/h, in a straight line, nowhere near its body. Every number the arm then reported
was correct about a car that had been moved out from under it.

**A COUNTER GOING DOWN IS THE MODEL BEING REPLACED, NOT A MEASUREMENT.** `impacts 1 -> 0` is the
one reading in all of this that could not be anything else, and it was sitting in the same line as
the track. A monotone counter that decreases means the subject was swapped; nothing else does that.

**And the five theories that died first were each individually defensible**, which is the part
worth keeping:

    the knockdown's own slide, 0.695 m of a 1.30 m window   REAL waste, not the cause
    residual velocity at placement                          placeAt zeroes both, read-back exact
    a steering pull from asymmetric damage                   health 1.000 entering the arm
    the body having moved                                    slot reads 0.4 m from placement
    an obstruction the clearance check stepped over          0 of 576 headings refused at 0.5 m

Two of those produced real fixes that are still worth having — a swept clearance test whose step
sat exactly ON the "under twice the test radius" bound, and a knockdown spending half the arm's
lateral margin — and neither moved the failure. The other three took one reading each to kill.

**Log the trajectory before refining the model of the trajectory.** I built three increasingly
careful derived bounds — slide arithmetic against the contact window, a sub-stepped clearance
check, a fixed-point geometry in the car's own frame — on a premise nobody had tested, which was
that the car drives along its heading. Position and yaw per frame would have shown the teleport on
the first run, and it is cheaper than any of the three.

### And a counter cannot tell you WHOSE body it counted

With the respawn gone the drive works, and one run of three still ran over the wrong pedestrian:
`overs` rose, `impacts` went 0 -> 8, the record read a perfect
`{kmh: 14.5, crime: "pedestrianHit", scale: 0.0074}` — and the arm's own casualty was lying
**10.9 m further on**, with the car's lateral miss against it reading 0.009 m. The car had gone
astray, hit somebody else 3 m in, and every check below passed about a body the arm never staged.

**Neither the counter nor the crime can distinguish them, because it is the same crime either
way.** `pedRunOvers` is a count and `lastRunOver` described the offence without naming its subject,
so "the wire works" and "the wire works on the body I placed" were the same reading.

`dynStats.lastRunOver` carries `victim` now — the index `Pedestrians.positions()` reports as `i`
and `Pedestrians.hit()` takes, so a caller that staged a subject compares directly rather than
joining across two id spaces, which is the mistake #104's first probe made in the other direction.
The arm asserts the victim is its own.

**The general rule: when an arm stages a subject, the record it reads has to name one.** A count
plus a classification is not an identification, and the gap only shows up on the runs where the arm
goes wrong — which are exactly the runs whose output you are trying to trust.

**And naming it was wrong first, because there are TWO id spaces and the record carried both.**
The first version compared against `r.id` and read **"ran over #326, staged #14"**, three runs of
three, while the geometry in the line above it put the car **0.01 m** off its own body's axis. Both
cannot be true — and the arithmetic settles it with no second run: **the crowd is 90 pedestrians,
so #326 is not an index into it.** `ped.id` is `++_nextId` at spawn and climbs past the crowd size
as slots recycle; `r.index` is the slot, which is what `positions()` reports as `i` and what
`hit()` takes. The contact record had carried both all along and I took the wrong one, under a
comment asserting it was the other.

**An index larger than the population it indexes is not an index into that population**, and that
is the cheapest possible disproof of an id-space assumption — cheaper than any run. This file
already records the same two spaces being joined the other way round in #104's first probe, which
printed 0.00 on every column; the record now names them `victim` (the slot) and `victimId` (the
person) so the next reader cannot pick blind.

**CLOSED, and deterministic rather than merely green.** Three runs on a clean box:

    run 1   rc 0   BOOT: PASS — 88 checks in 323 s
    run 2   rc 0   BOOT: PASS — 88 checks in 327 s
    run 3   rc 0   BOOT: PASS — 88 checks in 326 s
    all three: ran over #14 staged #14, 2.822 m along, 0.010 m to the side

81 -> 88 checks over the round. The arm went from passing 2 runs in 3 for reasons that had nothing
to do with what it measures, to passing 3 of 3 with every diagnostic byte-identical — and the
checks that now hold it are a respawn count, an identity and an agreement, none of which existed
when it was flaky.

**So a browser arm that DRIVES has to own the car's wreck state.** The arm calls `repairCar()`
before staging anything and asserts it was handed a repaired, un-wrecked car with no wreck clock
running; and it records `respawns` across the drive and fails on a change FIRST, above every other
check, because when that fires it explains all of them. A wreck clock left ticking by an earlier
arm is otherwise a 17.6 m teleport that reports itself as "0 run-overs" — the feature looking
broken because the harness moved the subject.

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

  **RESTATED: 934 is a WITHIN-SESSION figure.** Note `frames 89 89 89` — those three
  runs shared a cadence, and the drive does not traverse the same course twice. The
  same billing measured in another session read 869,778 over 87 samples and 2,272 m,
  against this triple's 3,112 m: a p95 spread of 17,173. See "The budget gate's p95
  is comparable WITHIN a session" above before using 934 for anything. The "~20k of
  run-to-run noise" below was measured while other agents' browsers were alive and is
  a statement about CONTENTION; clean the box and the gate becomes precise *for the
  rest of that session*, which is not the same as comparable against an artifact from
  a different one.

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

## Nine ways a path follower reports everything nominal while driving into a wall

Every one of these was found by tracing, every one produced a controller whose own numbers
looked fine, and together they are the whole cost of getting `src/roadpath.js` from "two of
three circuits, wrecked" to "three of three, undamaged". They are listed because the shape
recurs: the instrument says nominal because the instrument is computed from the same wrong
quantity the controller is acting on.

**The course:**

1. **A gap in the path.** `nearestOn` projects onto an edge at some fraction along it while
   `route` can only start from an endpoint vertex, so prepending the projection inserted a
   75 m straight segment. An arc-length look-ahead then aimed at the far side of it, reported
   a heading error of **0.00**, and drove 78 km/h across a city block for four seconds.
   Off-line went 25 → 75 m with the error at zero the whole way.
2. **Per-leg routing doubles back at every join.** Leg N walks up to the waypoint's
   projection and leg N+1 walks from that projection back to whichever vertex its own
   Dijkstra chose — often the one leg N came from. The course read `(21,-9) (21,-8) (17,-8)
   (20,-11)`: forward, back 4 m, forward again. Chaining the legs through the graph fixed the
   reversal and opened a **158 m gap**, because the previous leg still ended at its
   projection. Route the whole thing as **one edge list** and densify once; continuity is
   then a property of the construction, not something to patch at the seams.
3. **A ring's seam is the one corner nothing smooths.** `smooth()` pins its endpoints, and on
   a closed tour the seam *is* the endpoint. A clean lap finished 0.6 m from where it started
   with a heading error of 1.59 rad — 91° — had to turn a right angle from a standstill, and
   clipped the corner. And because that impact leaves asymmetric damage and therefore a
   steering pull, the contacts for the rest of the lap went from 22 to 5,300: one unsmoothed
   corner degrades the whole drive.
4. **A closed curve is divided evenly, not walked at a fixed step.** Walking a ring at a
   fixed spacing leaves a remainder, and the remainder is a reverse spur. Dropping it "when
   it is within half a spacing of the start" is a threshold, and thresholds miss: the point
   landed **2.10 m from the start against a 2.00 m threshold**, and that 2.10 m reversal was
   the course's tightest corner at 2.43 m of radius on a course whose next tightest was 6.14.
   Choose the point count from the ring's own length instead.
5. **Look for the road inside the building before blaming the driver.** 14 of 935 edges carry
   a car-sized obstruction on their own centreline and 7 have their centreline *inside* a
   footprint; all are 2.8 m `service` alleys, the worst 36 m long with 23 of 24 samples
   inside. No follower can steer out of a road that is inside a building; only the router can.

**The controller:**

6. **Progress is a local projection, not the nearest point in a window.** A windowed *global*
   nearest-point search is monotonic and still teleports: wherever a route passes near
   itself, a point 180 m further on can be nearer than the one the car is on. Traced at
   77 km/h — `i` 615 → 661 in one step, heading error 0.00 → +1.543 rad, 22.4 m off the line.
   Step forward only past segments the car is beyond in the along-path direction.
7. **A radial look-ahead aims backwards.** Cutting a corner stops the index advancing; once
   the car is far enough from that stuck point, the radial test *selects it*. Measure the
   look-ahead in **arc length**, which cannot select a point behind the index it starts from.
8. **Pure pursuit's command is zero at 180° as well as at 0°.** `2·sin(α)/d` cannot tell
   "pointing at it" from "pointing exactly away from it". With the aim point behind, the
   steering came out at −0.03 and the car drove away in a straight line for four hundred
   seconds with its heading error reading −3.14 throughout. Cap the sine at a quarter turn:
   past that there is nothing to compute and the tightest turn available is the answer.
9. **The corner the car is IN is a speed ceiling too.** A forward-looking limiter is blind to
   the turn being negotiated, so once the apex is behind the index the scan sees the straight
   beyond and the target jumps. Traced: crawling into a 7.5 m junction at 9 km/h with the
   target at 8, and one step later the target read 54, then 79. It floored the throttle at
   full lock, reached 39.5 km/h in 2.5 s and hit the building on the outside of the turn —
   the single impact that wrecked the car on an otherwise clean lap. `cornerSpeed()` of the
   radius the steering is currently asking for is the missing term.

**And a scan whose length depends on the current speed is a feedback loop.** Slowing shortens
it, the corner leaves it, the target jumps up, the car accelerates, the corner reappears. The
throttle chattered 0 → 1 → 0.66 → 0.81 → 0 through every bend. Scan from the *maximum* speed,
so the limit is a function of position alone.

## Do not derive a vehicle's envelope from a model it is not

`src/roadpath.js`'s first cornering model took `grip = 1.15` and `gravity = 19.6` out of
`vehicle.js`'s friction circle and Ackermann bicycle geometry out of a textbook. Measured by
holding a steer input and a speed until the radius settles:

                        derived      measured
    lateral ceiling     22.54        16.2 m/s2
    R_min at 50 km/h     6.2         12.4 m
    R_min at full lock   4.3         10.6 m at 20 km/h, and it GROWS with speed
    braking             12.40        11.0 m/s2

**A safety factor masked half of it.** 0.55 × 22.54 = 12.40, which sits just under the real
16.2, so the *speed* ceilings came out roughly right by accident. The steering figure was not
masked, and it was the one that mattered: the controller asked for 0.37 of lock where the car
needed 0.64, and drifted 8 m wide of a 38 m bend at 78 km/h with its own numbers reading
nominal.

**The response turned out to be exactly linear, which is what makes the measurement a model
rather than a table.** Radius × steer input is constant at a given speed — within 2% across
inputs from 0.1 to 0.4 — so that constant *is* the radius at full lock, and it is linear in
speed: `R_min(v) = 8.446 + 0.2826·v`, fitting to **0.1%** at every speed from 20 to 80 km/h.
The steer input for a wanted radius is then the exact inversion, `steer = R_min(v)/R`, and the
whole understeer factor comes out in the wash instead of needing a fudge.

A measured constant that nothing re-derives is a magic number waiting for the car to change
under it, so `roadpath-test` re-measures all four against `vehicle.js` and fails if they move.

## An impossible corner needs a crawl speed, not a standstill

116 of this district's 851 course points turn tighter than 12 m of radius, because a graph
junction is a point and a right-angle turn across it reads as 2 m. A radius under the car's
standstill minimum of 8.45 m cannot be followed at any speed, so both ceilings return zero —
and a target of zero means the car stops dead and never reaches the corner at all, which is
worse than cutting it. A real driver in an alley too tight for their turning circle creeps
round and clips the kerb.

The floor is 2.2 m/s, which is `damage.js`'s FMVSS free threshold, so a contact taken at the
floor speed is free **by construction**. That is what makes it a derivation and not a fudge:
the finished drive's 264 contacts are all at one 8.3 m corner against a 8.9 m minimum, at a
worst charged delta-v of 1.425 m/s, and they cost exactly nothing.

## A model integrated at the game's dt is measured at the harness's

The pedestrian throw distance is `v^2 / (2 mu g)` — a real reconstruction figure, checked
against published data at three speeds. The slide that realises it was written as a plain Euler
step, which carries the whole step at the ENTRY speed. Measured against a closed form of
9.534 m at 40 km/h:

    dt 1/120   9.580 m   +0.5%        dt 1/6   10.479 m    +9.9%
    dt 1/60    9.627 m   +1.0%        dt 1/2   12.510 m   +31.2%
                                      dt 1     15.748 m   +65.2%

1% at 60 Hz is why nobody would ever see it. **The harness does not run at 60 Hz.** Headless
capture here is under one frame a second, and `district/main.js` clamps dt to 0.05, so every
live capture of a knockdown threw the body up to 65% further than the model says — and so did
any frame hitch in the game. The instrument that checks the model was changing the answer.

Constant deceleration has a closed form, so there was nothing to approximate:
`ds = v*h - a*h^2/2` with `v' = v - a*h` is exact for any `h`, and exact piecewise, which is
what lets it be sub-stepped. It now reads 9.534 m at every step size from 1/120 s to 1 s, and
the gate asserts that spread is under 0.1% and re-runs the sampled form in the test file so a
regression to it cannot pass.

**Sub-step any swept test against geometry, and size the step by the subject, not by dt.** The
slide's wall test samples the DESTINATION, so at a 1 s frame it was testing a point 11 m away
and could jump a whole shopfront.

**And size it from the ENTRY speed, not from the step's length.** Sub-steps cut evenly in TIME
are not even in distance — under constant deceleration the first is up to twice the average — so
a count derived from the whole step's distance bounds the mean and not the maximum. Measured
gaps between consecutive wall tests: 0.5073 m at a 1 s frame and 0.5911 m at 5 s, against a
claimed 0.3. The thinnest blocked band in this district is 0.670 m, so it held by 12% and by
luck. Taking `n = ceil(v_entry * h / step)` bounds every sub-step, and the same measurement then
reads 0.2857 and 0.2983.

**The real bound is twice the margin the test uses.** A destination test with a 0.28 m margin
can only notice a wall while the step is under 0.56 m; 0.3 m is chosen under that, and the gate
now asserts the relation rather than the number.

## Measure the rare case AT THE CAP, because that is the one a player goes to look at

A rammed traffic car is knocked off its lane by up to 4.5 m. Placing every car of three 30-car
fleets at that cap in 16 directions, **11 of 1,440 placements (0.8%) landed inside a building,
the worst 2.15 m in.** At the dv the collision pass actually produces most often — 8 m/s, a
2.84 m push — it was 0 of 30. So the defect exists only at the cap, the cap is a 72 km/h ram,
and a 72 km/h ram is precisely the crash a player stops the car and walks back to look at. A
sweep that only exercises the common case would have shipped it.

The fix is a fit at the publish site, not in `hit()`: that is where the offset is applied, so
it is the only place the drawn car and the collision pass cannot disagree.

**Two things I got wrong writing that down, both found by blind review.** The cap is a 63 km/h
ram, not the 72 I wrote: the cap engages at `dv = sqrt(2 a d)` = 9.95 m/s, and converting that
to a closing speed has to use the same `pairDv` the code uses (e = 0.15, dv = 0.575 c), not
dv/2. Three different conversions were live at once — the code's, the commit message's and the
gate comment's. **Use the one the code uses, everywhere.**

And "the two counts validate each other — 11 bad placements, 11 fits" is not a validation: the
fit fires on `!clearAt(destination)` and the bad sweep counts `resolveCircle(destination)`, the
same predicate at the same point on a bit-identical fleet, so the equality cannot fail.
Collapsing the fit ladder to `[0]` — every blocked shunt becoming no shunt at all — leaves both
counts reading 11. **A self-validation that closes over the same quantity twice validates
nothing.** What the fit owes is the LONGEST clear offset, so the check is that the rung above
the one chosen is genuinely blocked.

## Three reviewers, 40 findings, and the ones that cost the most

A round that shipped with 65 passing checks went to three blind reviewers — one on the physics,
one mutating the modules to see which checks had teeth, one on integration. The gate caught 15
of 27 mutations and **missed 12**. What the misses had in common is worth more than the list:

- **A module's own bookkeeping is not a measurement of the module.** Every section read
  `down.travelled`, the field the slide increments itself. A mutation that advanced the BODY by
  a third of each step while still adding the full step to `travelled` threw the body 3.18 m
  instead of 9.53 and passed all 65 checks. The position was printed and never asserted.
- **A gate that cannot see the render cannot see the feature.** Five mutations — the fall
  transform disabled, the fall angle negated, a fixed fall axis, the throw reversed, the drawn
  car written from its un-shunted lane position — were invisible offline and all caught by the
  browser gate. Both modules build their InstancedMeshes against a `{ add() {} }` scene and
  never touch a GL context, so **`getMatrixAt` works in node**: the same assertions moved
  offline cost 295 ms against twelve minutes, which is the difference between a check that runs
  per edit and one that runs once a round.
- **A control that the system quietly repairs is not a control.** The "empty ground" arm nulled
  a pedestrian slot and compared against it — and the refill pass fills a freed slot on the
  **next frame**, so the control was "the same ground with a fresh pedestrian standing on it".
  It agreed with the test arm to 0.17 m, which read as a small effect rather than as no control.
- **A section can measure nothing while printing a number.** The gridlock arm put a car "in the
  state the rule watches" with `car.holds = [car.edge]` — `holds` holds junction VERTEX ids,
  `car.edge` is an EDGE index, and the module clears it next update. 0 frames in the state, both
  arms reading 0.02 s against a 20 s limit, and the known-bad check under them was
  `1.2 + 10 * 0.25 > 0`.
- **The thing a feature is exempted from needs a bound.** That exemption let a car be pinned
  indefinitely by repeated 1.01 m/s nudges, and the anti-gridlock rule then deleted the innocent
  cars queued behind it: 9 deletions in 240 s against 0 in the control. The module's own
  derivation says "no car is stationary longer than stuckLimitS" and the new code made that
  false without restating it.
- **Guard the DIRECTION as well as the magnitude.** `Math.hypot(NaN, NaN) || 1` is 1, so a NaN
  direction sailed past a guard on the delta-v and produced a car drawn at (NaN, NaN) that could
  never despawn — `NaN > radius` is false — and never recover. A ZERO direction was worse: the
  fall axis became the zero vector, `setFromAxisAngle` returned the identity, and the casualty
  stood bolt upright for 45 s while `isDown()` said otherwise.

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
### Waiting on a PID is wrong when a shell loop supplies the PIDs

CLAUDE.md already says "never wait on a log string — wait on the process (`wait $PID`, or poll
`kill -0 $PID`)". That is right and it is not enough. Running three mutation rows as

    for r in tint-invert tint-slotless tint-off; do node tools/mutation-sweep.mjs --only $r; done

and then waiting on `pgrep -f "[m]utation-sweep.mjs --only"` captures **the row that happens to be
running when the watcher starts**. That row exits, the watcher reports the sweep finished, and the
loop immediately spawns the next one. The watcher is now watching a dead pid and the sweep is live.

**And the failure mode is the dangerous one.** `git status` at that moment read
`M src/carbody.js`, which is a sweep mid-row doing exactly its job — and it is indistinguishable
from a sweep that died and left a mutation behind. One is "wait"; the other is "restore". This file
already records what happens if you guess wrong in either direction: `git add -A` during a sweep
committed a reverted soft knee to HEAD and left `git status` reading clean, and `git checkout --`
during a sweep reverted the mutation mid-gate and the row reported MISSED for a reason that had
nothing to do with the row.

Two rules:

- **Wait on the thing that OWNS the work, not on its current child.** For a shell loop that is the
  loop's own pid; the children are an implementation detail of it. Waiting on the loop AND then on
  "no child alive" covers both, and the second clause alone does not, because a loop between
  iterations has no child.
- **Before deciding whether a dirty tree is a crash or a sweep, check for a live owner.**
  `pgrep -af mutation-sweep` answers it in one command and the lock file does not — the lock
  survives a kill, so a stale lock and a live sweep look the same.

It cost nothing this time only because the check ran before the commit. The same mistake one step
earlier in the session reported DONE after the last row of a five-row loop, which looked correct
and was luck.

**And the rule got its first real use when the CONTAINER restarted mid-row.** The tree came back
carrying ` M src/mission.js` and a lock file timestamped a minute earlier — the ambiguous state
exactly. `pgrep -af mutation-sweep` returned only the two shells running the pgrep itself (the
self-match trap, harmless here), so there was no owner, so it was a crash and not a sweep, so
restore was right. The diff was then read before restoring and was precisely the `stage-clock-unit`
mutation. **Check the owner, then read the diff, then restore** — in that order, and the lock tells
you nothing because it survives a kill.

### Stopping a task does not stop its child, and `pgrep` matches a zombie for ever

A triple was launched as `until ! pgrep -f "[b]oot-check.mjs"; do sleep 15; done; <three runs>`,
after an earlier triple had been stopped mid-run to free the box. It spent **roughly 55 of its 60
minutes in the wait**, got 26 bytes into run 1 (`BOOT CHECK / dom in 0.4 s`) and was killed at its
background limit — and the kill notice reads "the work took too long", which is the one thing that
did not happen.

What is OBSERVED: no live `boot-check` process by the time I looked, and a
`1497 [http-server] <defunct>` still in the process table. What that implies: **stopping the task
killed the shell and left its `node` child**, and a child whose parent is gone and is not reaped
stays in the table as a zombie — **with its argv intact, so `pgrep -f` keeps matching it.** A wait
written as "no process matches this name" then cannot exit, however finished the work is.

This file already records the self-match trap, where the waiting shell finds its own command line.
This is the sibling and the bracket trick does not help with it: the pattern is right, the match is
real, and the process is dead.

Three rules, and the third is the cheap one:

- **A wait loop and the work it guards must not share one background budget.** The task's time
  limit then covers both, and a wait that blocks is indistinguishable from work that is slow. Clear
  the box, CHECK it, and launch the work as its own task.
- **After stopping a task, kill what it started, by name, and then look at the table.** `pkill -f`
  on the tool and on its server, then `pgrep -af` to read what is left — which is how the defunct
  entry above was found at all.
- **Prefer a positive condition to a negative one.** "Wait until the output file says PASS or FAIL"
  cannot be satisfied by a corpse; "wait until nothing matches" can be blocked by one for ever.

- Headless capture runs through SwiftShader well under 1 fps. Budget minutes per
  frame, and never report frame rate as a performance result.
- `blind-compare` refuses to build a pair set carrying under 8% facade-band
  signal, because two arms of the same build is a failure that looks like data.

## Do not edit the tree a reviewer is measuring

A blind playtester reported, mid-round: *"Same arm gave 6 crimes/1 star earlier and 9 crimes/2
stars now, with knockdowns and distance byte-identical. Let me check determinism."* The
observation was exact and the instinct was right, and the harness is fine — the same arm run
three times in one process and three times in three processes gives crimes 4, stars 5, heat
5.9900, knockdowns 1, distance 187.0707951521316, byte-identical every time.

It was me. Two commits landed in `/home/user/gpta-6` while that agent was reading it: the crime
scale, then `hitAndRun`. Both change what an offence COSTS and neither touches the physics, which
is exactly the signature they described — the charge moved and the collision did not.

The reviewer lost time on it and very nearly filed a determinism bug against a deterministic
harness. **Give a reviewer a tree nothing else is writing to.** Copy the checkout, or brief them
against a commit and have them check it out; a mutation reviewer already needs its own tree to
mutate, so say so for the playtester too. And note the shape: their two runs disagreed in the
quantity I had changed and agreed in every quantity I had not, which is a diff arriving
underneath a measurement, not noise. A round that reads "the numbers moved and nothing I did
moved them" should check `git log` on the tree before it checks the module.

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

## The offline gates cannot see the page, and for three commits the page did not load

`fab3e2d` added one line to `district/main.js`:

    if (peds && furnitureProps) peds.setProps(furnitureProps);

inside the top-level `await loading` block, which is evaluated before the module's
later declarations exist. `peds` is a module-level `let`, so that read came out of
the temporal dead zone as `ReferenceError: Cannot access 'peds' before
initialization`, init aborted, `window.__district` was never assigned, and the
district rendered **nothing at all**. Three commits shipped on top of it.

All fifteen offline gates were green the whole time, because **not one of them loads
`district/main.js`** — they import `src/` modules directly and assert numbers. The
browser gates would have caught it in their first ten seconds, and they cost twelve
to twenty minutes each, so a round that changes a module and runs the offline list is
a round that does not know whether the game still starts.

`tools/boot-check.mjs` is that missing gate and it is **nineteen seconds**: no
`pageerror`, no failing request, `window.__district` exists, `frames` ADVANCES
(a page that assembles and then throws inside its render loop leaves the global
behind with the counter stuck), the renderer drew triangles, and the crowd, the
fleet and the mission board all report themselves alive. **Run it after any change
to `district/` or `src/`.** It found a second defect on its first run, below.

## A marker rule produced the defect it did not forbid, twice

Both of this project's mission markers have been wrong, and both times a GATE RULE put
them there.

`shakedown`'s second marker sat 0.35 m from the spawn, inside its own 30 m reach
radius by a factor of eighty, because an older rule required every marker within 5 m
of a baked route waypoint and waypoint 1 IS the spawn. Then `ambush` was given a
marker at (-471, 205) to satisfy a newer rule — a stage with a clock needs somewhere
to go, earned honestly by a playtester measuring 156.3 s of a 249.4 s run with a blank
HUD. (-471, 205) is the exact position of `drop`'s reach trigger, radius 28 m, 0.0 m
away. So a player following the HUD shakes the tail standing on the drop, `drop` fires
and is satisfied in the same breath, and the flagship mission's final objective —
"DELIVER THE PARCEL TO THE MARINA" — is the active stage for **0.033 s**. Two frames at
60 Hz. The delivery leg of the delivery mission did not exist.

Each rule was right about what it demanded and silent about the consequence. So the
check to write is not another rule about where a marker may sit; it is the property
that breaks: **walking from a stage's marker must not already satisfy the NEXT stage's
reach trigger.** That is the exact failure and it needs no invented margin — the radius
is a number the mission itself declares, where a minimum leg length would be a number
somebody picked. Print the ratio beside it so an author can see that 322.5 m against
28 m is x11.5 and that 29 m would pass while being absurd, and skip edges whose source
has no marker, because there the player's position on entry is unconstrained and there
is nothing to assert.

**And check which way a marker points, not just where it is.** The old one pointed at
the handover while the player was wanted, which instructs them to bring a police tail
to it — the one thing a courier would not do. The fix reads better as fiction as well
as measuring better.

Two smaller things this cost, both of them my own:

- **A probe that hardcodes the value it is testing cannot see the fix.** The first
  version of the before/after read `(-471,205)` as a literal, so it measured the old
  arm no matter what the source said, and reported the defect unchanged after the fix.
  Read the quantity from the module.
- **`git checkout -- file` on an UNCOMMITTED file reverts your own work with the test
  mutation.** Verifying the new check bit meant planting the defect by hand; undoing it
  that way threw away the fix too. Commit first, or keep the edit in a patch.

### And that is exactly how `mutation-sweep --selftest` deleted a module mid-write

The paragraph above was already here. `mutation-sweep`'s `restore()` is
`git checkout -- <file>`; its selftest mutates `src/damage.js` and restores it that way. Run
against a tree carrying an **uncommitted** `src/damage.js`, it reverted a new class and its
composer — an hour of work, with git holding no copy to give back, recovered only because the
whole file was still in the session transcript.

**The tool already had the right refusal, twenty lines below the branch that needed it.** The
sweep path exits 2 on a dirty tree with a four-line explanation. The `--selftest` path instead
*recorded a failed check* reading "the selftest itself needs a clean tree to prove anything —
commit first", and then went on to mutate and check out anyway. So:

- **A warning is not a guard.** The selftest printed the correct diagnosis, as a FAIL line among
  fourteen, after it had already destroyed the thing it was warning about. A check that reports a
  precondition it does not enforce is strictly worse than no check: it reads as coverage.
- **A guard on one of two entry points reads as a guard.** This is the repo's recurring shape —
  patching one tool and leaving its siblings — and here the two siblings were two branches of one
  `if` in one file, forty lines apart. `grep` for the thing the guard protects (`restore`,
  `git checkout`) rather than for the guard.

The refusal is hoisted above both branches now, before the lock and before any write. And the
operational rule, which no guard replaces: **commit before running any tool that restores by
`git checkout`.** The gate list is cheap; losing an uncommitted module is not.

### And the other direction: `git add -A` while a sweep is running COMMITS the mutation

The sibling of the above, found an hour later and worse, because it ships. A sweep was running in
the background with `knee-clip` applied — `floorlessCharge` reverted to `Math.min(raw, cap)` —
when a commit went in for something else. `git add -A` staged the mutation, the commit carried it,
and `git status` then read clean because the sweep's `restore()` had nothing left to undo. The
soft knee was gone from HEAD and the tree looked immaculate.

What made it hard to see is that **every symptom pointed somewhere else.** The next sweep reported
`knee-clip` and `knee-point` STALE — correctly, because their `find` string was no longer in the
file — and a stale row reads as "the code moved under the row", which is a thing that had genuinely
happened twice that afternoon. The gates were all green, because a reverted knee is a working clip
and only the two arms that assert the CURVE could tell.

Three rules, and the third is the one that would have caught it alone:

- **Never run a sweep in the background.** One at a time, in the foreground, and read its last
  line. The lock stops a second SWEEP; it does not stop a commit, an editor, or a `git checkout`.
- **Never `git checkout --` a file to undo something while a sweep holds the lock.** That reverts
  the sweep's mutation mid-gate, and the row then reports MISSED for a reason that has nothing to
  do with the row. One row was lost to exactly this before the committed one was noticed.
- **After any sweep, `git diff HEAD` before you commit anything.** Not `git status` — the tree can
  be clean against the index and wrong against your intent. The diff is four seconds and it is the
  only thing that would have shown a `return Math.min(raw, cap);` where a two-branch knee belongs.

## A partial lead from a killed round is still the round's result

Three review rounds in a row have now been killed part-way by session rate limits, and
every one of them got something out first.

**The limit was ACCOUNT-WIDE, not the reviewers' cost.** I inferred from three
consecutive deaths that two Opus playtesters were too expensive to run and said the
next round should use fewer or cheaper agents. Wrong: the owner had other sessions
running against the same budget. A round that under-provisions its reviewers on the
strength of that inference gets weaker reviews for no reason, so the rule is the usual
one — a correlation over three samples is not a cause, and the cheapest way to tell
was to ask. The two most recent last lines were "the
final authored objective of the flagship mission shows for 0.300 s" and "routing drove
into a wall", and both were worth a commit:

- The first was real and its number was out by 10x — I measure 0.033 s, not 0.300.
  **Reproduce before quoting.** A reviewer's observation is much stronger than their
  arithmetic, which this file already says about their diagnosis.
- The second was real in a different place than it sounded. The routes are clear: over
  397 routes and 37,605 route points, 4 routes touch one point where a 0.95 m body
  circle does not fit, worst correction 0.109 m, which is inside the free-contact class
  the crawl floor derives. What was broken was `RoadGraph.stats.isolated`, which read
  `district.verts.length - out.size` and so reported 1,496 isolated endpoints where the
  truth is 13 — the adjacency keys on edge ENDPOINTS and 1,483 of this district's 2,159
  vertices are interior points of road polylines that can never appear in it. The
  network is 98.5% one component; the statistic said 31%.

So do not treat a killed round as a round that produced nothing, and do not fill the
gap with your own reading of the module either — chase the lead the player left.

## A system that is never switched on is not a feature

Three of these in one round, all found by playing rather than by measuring:

- **The missions could not be started.** Both authored missions worked, both passed
  their gate stage by stage, and the only door into either was
  `window.__district.startMission(id)` from the browser console — whose own comment
  says it is named "so a harness can start, drive and audit a mission". 347 gate
  checks were green over a first mission nobody could reach.
- **The fleet was never created.** `setTraffic` was reachable only from
  `__district`, so the shipped page had 96 pedestrians, 30 parked cars and nothing
  moving. Both playtesters reported on traffic behaviour in detail — "a median
  36 km/h, 90th 52, max 64" — because `tools/playtest.mjs` builds a 30-car fleet in
  its constructor. Neither had any way to know the page does not.
- **`shakedown`'s second marker was 0.35 m from the spawn**, inside its own 30 m
  reach radius by a factor of eighty, so two of its three objective lines could
  never be read. It was there because `mission-test` REQUIRED every marker to be
  within 5 m of one of the nine baked route waypoints, and waypoint 1 *is* the
  spawn. The gate did not miss that defect, it demanded it.

The shape is the same every time: the module is right, its gate asserts the module,
and nothing asserts that the game reaches it. **When a feature lands, write down how
a player gets to it, and then check that path from the outside.**

### And the harness had no police, so "I escaped" was never evidence

The same shape one level deeper, and it invalidated a whole class of playtest finding.
`tools/playtest.mjs` built no pursuit layer at all, so `_evaluateContact` had nothing to
evaluate. Measured: five stars, engine off, never moving —

    units 6/0        six units requested, ZERO reporting a position
    4* -> 0 in 87 s  the level bled away while the player sat still

Both playtesters reported in detail on evading the police, against a game with no police
in it. `wanted.clear()` and `damage.repair()` had existed since their modules did with the
tests and two console hooks as their only callers, so there was no way to lose.

**And the pursuit could not stop, which made any "a unit is holding you" rule
unsatisfiable.** Greedy road-graph pursuit drives its edge at 22 m/s for ever. Against a
stationary target, 400 s, two spots, three seeds:

    longest contiguous hold   4.3 m  0.8 s    20 m  5.4 s
                              8.6 m  1.7 s    30 m 10.7 s
                             12 m    2.8 s    45 m 13.8 s
    minimum distance reached  0.1 m

Touching the player constantly and holding him never. A bust rule written against that,
gated with hand-placed units, would have shipped and never fired. `PursuitUnits.HOLD_R`
clamps a unit at its edge's closest approach; toggling it to 0 in one process is
byte-identical at 70 km/h and within noise at 40, so the hold costs the chase nothing.

**Two defects in that hold, both of which read as the police being unreliable rather than
as broken code.** The tell was `stats.bustHolds` against `stats.busts` — armed 21 times in
80 s, fired 0:

- The condition `u.t <= near.t` was a strict ratchet, and **a stationary player is not
  stationary**: the plan's target is the live position and a braked car settles by
  sub-millimetre amounts. Any backwards drift failed it and the unit left for good. `held`
  was true for exactly TWO frames at a time. Once sticky, six variants of one scenario all
  bust at 16 s with the clock armed once.
- Two arms of that scenario 0.2 m apart — coasting against braked — disagreed about whether
  the player was ever caught, because the greedy router is chaotic in the target position.
  **"Sometimes it works" is what a broken conjunction looks like from outside.**

A third guard went in on a plausible wrong diagnosis (a held unit rerouting at its edge's
end) and `mutation-sweep` reverted it and came back MISSED. It was redundant once the hold
was sticky — bit-identical, same bust times, same hold durations — so the guard was deleted
and the row with it. **A row nothing can tell apart is not evidence of coverage.**

### A guard can be right about what it demands and silent about the case next door

`mission-test` has asserted, for as long as pickups have existed, that **the spawn is outside every
pickup radius** — "a mission you are standing in is not a mission you chose". It passed. It is also
only about FRAME ONE, and the defect is on the way out:

    spawn to shakedown's pickup                        30.0 m   outside its r12, inside its r48 notice
    driving to the FLAGSHIP's pickup passes            2.0 m    from shakedown's r12 pickup
    so shakedown starts at                             t 13.8 s  24 km/h, 11.56 m from the ring
    and the player arrives at the flagship on          shakedown's FINAL stage, pointing 539 m back

The route-crossing number took one `roads.path` call and 0.1 s to compute, and nothing had ever
computed it. This is the same shape as `facades.js` refusing awnings over a LOTTED bay — right
about what it demanded, and so much of the problem that nobody looked at the unlotted half — and as
`geom-audit` asking for ONE street direction where the build unions two. **When a check is about a
moment, ask what the same quantity does over the rest of the player's path**, and make the geometry
a printed number rather than an unexamined fact: `mission-test` now routes the spawn to each pickup
and prints how close it passes to every other.

**The fix was derived rather than picked, and the derivation was already in the repo twice.**
`src/damage.js`'s garage refuses a moving car "so the garage is somewhere a player stops rather
than something they drive through on the way past", and `district/main.js` builds it with
`radius: OFFER_RADIUS_M` and `stopMs: SCENE_STOP_MS` — src/mission.js's radius and src/wanted.js's
stopped threshold, already crossing between the three modules. A mission pickup is the same shape
as a garage zone, so it takes the same threshold from the same source and there is no new constant.

Three things worth separating:

- **A LEVEL, not a dwell, and the garage argues the opposite for itself.** The garage holds you for
  `holdS` because the repair takes time; taking a job does not, so the stop IS the whole deliberate
  act. That also keeps `offerAt` a pure function of position, which is what lets the HUD still NAME
  an offer the player is driving through — the moment it most needs something to say.
- **A level a player cannot see is only fair with a cue**, and `composeGarage`'s "stop here" was the
  precedent to copy, down to the `ownSubtitle`. The mutation that matters is not the gate being
  removed but the cue falling back to the notice branch: that prints "Easy money. … — 0 m" at the
  pickup, where the distance IS 0, so the refusal reads as an ARRIVAL. A missing instruction that
  looks like a confirmation is the worst shape it can take.
- **The required argument has no permissive default.** `pickupAt(x, z, speed)` throws on a missing
  or non-finite speed rather than defaulting to 0, because a 0 default would make any host that
  forgets it silently keep the drive-through behaviour — the "a guard whose default is the
  permissive case" trap this file already records twice. It is BEHAVIOUR-PRESERVING for both shipped
  hosts, so only the throw checks can see it, which is why `pickup-speed-default` is a row.

**And the browser arm for the host wire printed a number and measured the wrong one, twice.** Both
errors accused a build that works, which is the dangerous direction — a probe that says FAIL sends a
round to change working code:

- **`missionReport().mission` IS NOT "a mission is running".** `MissionRunner` keeps the mission
  reference after it ends and moves the OUTCOME, so the arm read `marlin-street` as its before-state
  AND its after-state and reported the refused drive-by as having started a mission. The quantity
  under test is `missionBoard().starts`, which the host increments only when a pickup fires. This is
  "quote the signal the code reads" arriving as a field that outlives the thing it names.
- **The arm ran after another arm had ended a mission**, and `ended` sits above `offer` in
  BAND_ORDER, so the offer line could not show whatever it said. The band read "MISSION ABORTED /
  Marlin Street — you were arrested" — a correct band for a page carrying a 6 s end-of-mission hold,
  and nothing at all about the pickup. **A band assertion is a statement about PRECEDENCE as well as
  about text**, so an arm that reads the band has to own the top of it: this one moved above the
  first thing in the file that starts a mission, and leaves its own mission RUNNING rather than
  aborting, because `district/main.js` clears the hold when a pickup fires and an abort would have
  handed the next arm the hold this one tripped over.

The tell for both was in the same line of output: the arm's own before-state and after-state were
byte-identical strings naming an arrest nothing in the arm had caused.

**And fixing those two produced a third, which is the one worth the most: an arm that perturbs the
page is a dirty tree for every arm after it.** The corrected arm teleported the car into the pickup
at x8 the stop threshold and braked. Two things went wrong at once and the second was invisible:

- **`setControls` from outside the page is overwritten every frame.** The page reads its own input
  after the caller writes, so 40 frames of `brake: 1` took 8.01 m/s to 6.88 — which reads as a car
  that will not stop and is a harness that is not driving it. `setAutopilot` is the hook, and the
  wedged-car arm two sections down was already using it, with a comment. Patching one arm and not
  its sibling, again.
- **So the car travelled 42 m, left the ring, and struck a pedestrian** — which charged a crime,
  put a `status` notice over the band, and spent `chargeVictim`'s 20 s window on an id the run-over
  arm needs. boot-check went from 3 failures to 9, **six of them in three later arms this one had
  disturbed**, and every one of those six read as a defect in the feature that arm tests. The same
  shape is already in this file from the other side: a run-over arm finding "56 run-overs and every
  one a REPEAT" because an earlier arm had parked on a populated street.

Two rules out of it. **Give a browser arm the smallest input that proves what it is for**: this one
needs to know whether the host passes a speed at all, so x2 the threshold does it, and x2 is also
under src/damage.js's 2.2 m/s free-contact threshold — 0.45 m of travel, nothing touched. HOW BIG
the margin is belongs offline, where it costs nothing. And **assert the arm left the page alone**,
rather than hoping: travel under 2 m and 0 stars is a check now, because the failure it catches
does not appear in this arm's own output.

**And the three checks it falsified were restated in the same commit, which cost nothing because
the old arm became the new control.** `playtest --selftest` §5b read "driving into the marker starts
the job" and was correct about the behaviour it was written for. `driveTo` leaves the car rolling at
37 km/h, so the identical call is now the negative arm, and the positive one is 0.90 s of brake —
a brake curve, not a dwell, which is the number that says the rule is a level.

### A disjunction is not a widening unless its two halves are disjoint, and the flakiness is what said so

#89's fix lets a pursuit unit clamp at the NETWORK's closest approach to the player rather than only
inside `reachRadius`, so a player 38 to 136 m off a road can be arrested instead of sitting in a
stalemate. The claim for it — written into the commit, the module comment and the backlog — was
"identical to today's behaviour at every distance the game already arrests at, and only longer
beyond it". The first version wrote that as

    near.d <= this.reachRadius || near.d <= best

and **that sentence was false.** Where the network DOES get inside 28 m, `near.d <= best` admits
every edge at or below the best approach, so units clamp on edges they used to drive past and the
hold arrives SOONER than before. Inside the reach the change was not a no-op at all.

**Nothing offline could see it and the browser gate saw it as flakiness.** `boot-check` went from
3 of 3 passing at HEAD to passing about half the time, always the same six checks in two arms that
had nothing to do with the pursuit: the garage's wanted-refusal arm parks a four-star car 12 m from
a road and was being arrested mid-dwell, reading `[law] BUSTED IN — 4 s / drive` where it expects
`[garage] GARAGE / not while they are looking`.

Three things to carry, and the second is the one that nearly cost the round:

- **Intermittent is a measurement, not noise.** Five runs of my tree gave PASS, FAIL(6), PASS,
  FAIL(6), PASS; three runs at HEAD gave PASS, PASS, PASS at 347-367 s — **slower** than my failing
  runs at 272-283 s. So duration was not the cause and contention was not the cause, and the only
  remaining explanation was my own diff. This file already says to clean the box and run three
  times; the half that matters here is **run the BASELINE three times too**, because "it fails
  sometimes" and "it fails sometimes more than it used to" are different facts.
- **I almost restated the gate instead of fixing the code.** The failing arms genuinely do park a
  wanted car and assume it will not be arrested, so "my change removed the immunity they relied on,
  restate them" is a coherent story and it is wrong: those arms sit INSIDE the reach, where the
  derivation promised nothing would move. A gate that starts failing after a change whose own
  claim is "nothing moves here" is evidence against the claim, not against the gate.
- **The guard is the derivation, so it goes in the condition.** `best > this.reachRadius &&
  near.d <= best` makes the two halves disjoint by construction: inside the reach nothing moved,
  outside it the floor is the only term that applies. `arrest-band` still reports "no stalemate
  row" with the same arrest times, and `pursuit-test`'s four-band isolation table is unchanged — so
  the guard costs nothing where the fix was aimed, which is what says it is a guard and not a
  retreat.

### A host rule is a rule no offline gate can reach

`district/main.js` is imported by nothing offline, so every rule that lives there is a rule
`mutation-sweep` cannot test. The fix is to MOVE it, not to write a browser check:
`VictimWindow` moved into `src/wanted.js` for this reason and `DamageModel.runOverCrime`
followed. What is left in the host is one wire per rule, and `boot-check` owns those.

Writing the mutation is what finds the misplacement. `runover-scale` was drafted against
`district/main.js`, which is how the run-over charge turned out to be three decisions in
the call site — which crime, what scale, and nothing tying either to the module's own
threshold — with a literal `scale: 1` that charged a 2 km/h roll over a body exactly what a
76 km/h one cost.

**And three versions of the browser arm for the remaining wire each printed a number and
measured nothing:**

1. Teleported the car onto the body at rest: 1 body down, 0 run-overs. `peds.runOver`
   refuses below `PED_FREE_MS`, so a car PLACED on a casualty rolls over nobody.
2. Crept at 1.6 m/s: cleared 0.33 m of the body, still 0 run-overs. 1.6 is under 2.2.
3. Took `positions()[0]`: 56 run-overs and **every one a REPEAT** — `pedRepeats` 0 -> 56
   with the charge still null — because `chargeVictim`'s 20 s per-victim window had been
   spent on that id by an earlier arm's car parked on a populated street. The subject is
   chosen for distance from the car now, over 60 m, outside any radius the contact pass can
   reach.

Each read as the wire being broken. The arm asserts it drove over the body at all before
asserting anything about the charge, because both sides of "the scale is not 1" are zero
when nothing happened.

### Two holds were counting rendered frames instead of simulated time

`wreckWatch` ran once per RENDERED frame from the HUD block, so under `?timeScale=40` a
four-second wreck hold took 160 s of simulated time. Found by a browser arm that advanced
34 s of sim across 17 frames and saw 0.85 s of fade. `damage.update(dt)`'s own comment two
lines away already stated the rule — "the damage clock runs on simulated time, like
everything else in this loop, so a fire burns at the same rate under `?timeScale` as it does
at 1" — and the holds were the two things in the frame that did not. No committed baseline
moved: `drive-through` is the only tool that raises `timeScale` and it drives with
`setBodyCollision(false)`, so nothing wrecks during it.

**And then I wrote a third one into the same block, in the commit that added it, having read
this section while writing its comment.** The garage's dwell went in beside `composeBand` rather
than beside `bustWatch` and `wreckWatch`, which are two screens up inside the `timeScale` loop and
carry a comment explaining why they are there. Same file, same defect, same round.

Two things about it are worth more than the fix:

- **`tools/playtest.mjs` HAD IT RIGHT, so no offline gate disagreed with the page.** The harness
  advances it in its own per-DT loop beside `_bustWatch(DT)` and `_wreckWatch(DT)`, and its
  comment says why in as many words. So the harness and the page differed in exactly the quantity
  no gate was comparing, and every end-to-end playtest number was correct about a wire the page
  does not have. A gate that reproduces the host rather than reading it cannot see the host being
  wrong.
- **The check has to be a RATE, not an outcome.** "The car got repaired" is true either way at
  `timeScale` 1. `boot-check` reads the dwell against `simTime` across a dozen frames at
  `timeScale` 8 — the hold completes in 4.0 s of sim where one step per rendered frame would have
  delivered 0.5 s — and prints the second figure beside the first as the known-bad. That
  assertion is only possible BECAUSE the dwell is in the sim loop, so the arm measures the fix
  rather than benefiting from it.

The general rule: **when you add a clock to the host, count the clocks already there and put
yours where they are.** There were two, both commented, both correct, and the comment was the
thing being copied.

### A derived constant beats a picked one, and the floor is measurable

`BUST_HOLD_S` needed a dwell time, and the honest floor is what a driver who is NOT caught
spends below the stop threshold. `src/vehicle.js` on flat ground, full brake to rest then
immediately full throttle:

    entry km/h            20    40    60    80   110
    under 1.0 m/s       0.32  0.30  0.28  0.30  0.32
    under 2.2 m/s       0.68  0.67  0.65  0.67  0.67
    with a 2 s pause    2.67 s

Flat in the entry speed, because the last 2.2 m/s of a braking curve does not depend on
where the braking started. So anything under 0.68 s busts a player for using the brake. The
VALUE is `WRECK_HOLD_S` — the same beat, "the game has taken over and is about to hand the
car back" — and `district/main.js` reads the constant rather than keeping its own 4, so a
retune moves both. **A wall-clock threshold still needs the sweep a measurement needs.**

## A change that perturbs a seeded sequence exposes content nothing has tested

Making the player's car a leader in `traffic.js`'s car-following term took
`traffic-selftest`'s building check from **0 of 215,960 car-frames inside a building
to 342, worst 0.31 m**. Nothing about the lane rule had changed. Cars that brake take
different `_chooseNext` draws, so the fleet drives a different set of edges — and some
of those edges were ones the old sequence never reached, where the lane offset had
been wrong all along. A playtester had found the same thing from the outside in the
same round and rated it low confidence: *"2 of 567 traffic samples were inside a
building, worst depth 0.25 m ... may be a junction pinch or may be my sampling."* It
was neither.

**A regression that appears in a module you did not touch is evidence about coverage,
not about your change.** Before reverting, ask what the change moved through the seeded
stream, and check whether the newly-visited cases were ever right. Here the answer was
the same defect `roadpath.js` had had for the route's lane one commit earlier: a nominal
road width against footprints that encroach up to 0.45 m into the drawn carriageway.
Both are fitted against the blockers now.

The same round found `traffic-selftest` building its `Traffic` with no `clearAt` at all,
so the gate measuring cars-inside-buildings was measuring a configuration the game never
runs. **A gate that constructs the subject itself has to construct it the way the game
does**, and the cheap proof is that the fix changed its reading.

## A barrier that refuses all power is the dead end you already shipped

Two of this round's findings were the same defect in different clothes. A wrecked car
had no engine power and no repair but a console call, so **60 s of full throttle and
60 s of full reverse both gave 0 km/h** and the session was over. Then the first
version of the world fence cut the throttle outside the district — and stranded the car
in exactly the same way, 786 m out with no way home.

Then the *second* version stranded it again, more subtly: the brake ramped with DEPTH,
so at 70 m out it sat at 1.0 whether the car was leaving or coming home, and thirty
seconds of full throttle pointing at town moved it **0.1 m**.

**Make the refusal directional and put the brake on the velocity.** Out is refused at
both ends of the throttle, home is allowed at both, and the brake only applies while the
car is actually travelling outward. Measured: 180 s of full throttle at the fence stops
the car 61.3 m out at 0 km/h, turning round drives home at 140 km/h, and reverse from
20 m out with the nose still outward comes home at 27 km/h.

And the fence is the **road network's own extent** plus 60 m, not `meta.bounds`: the
declared bounds are ±716.95 by ±500.94 while the roads run x −862..814 and z −524..719,
so a fence at the declared bounds would cut off real driveable street — worse than no
fence at all. Check what a bounds field actually bounds before fencing with it.

## A threshold that holds at one value and fails at every other is a coincidence

`route-drive` asserted `Math.abs(seam) < 0.5` on the tour's closing corner and had
been green since the tour existed. Measured across the offset it is run at:

    offset 0   67.4 deg      offset 2   53.6      offset 6   -67.5
    offset 1   67.9          offset 3   14.0  <- the only value this gate runs at

The tour closes ON a junction, where the road itself turns about 70 degrees, so the
assertion held at one offset and would have failed at every other — on geometry
nobody was worried about. The swing came from `offsetRight` taking a ONE-SIDED
tangent at a ring's first and last point; with that fixed the seam reads the
junction's own turn at every offset from 2 m up.

**A check that compares against an absolute number needs the same sweep a
measurement does.** The replacement compares the seam's turn with the worst turn
ELSEWHERE on the same course — one frame of reference, which survives a change of
offset — plus a separate reversal test. Both are printed with the course's own worst
turn beside them.

The same shape in a TIMING bound. `mission-test` asserted `us < 5` on a 200,000
iteration microbenchmark, and unchanged code on one idle box measures 4.861,
4.953, 5.111, 5.133, 5.366 and 5.690 us — the bound sits *inside* its own
measurement spread, so the gate failed about half the time and read "1 of 88"
with nothing wrong. I first assumed contention from a headless browser and was
wrong; it reproduced on an idle box three times running, which is the thing to
check before explaining a reading away.

A microsecond figure is a statement about the MACHINE. The claim was "well under a
frame", so the bound is now the fraction it means — 1% of a 16,700 us frame, which
the measurements are 29 to 34x inside — and the property the bound was really
guarding is asserted directly instead, because no wall-clock number can see it:
**cost must not scale with the mission's total stage count.** 4 stages against 404
in one process, x1.07 against a x2 bound, where a linear scan would be x101. That
comparison is a ratio of the SAME operation inside one process, so box speed
cancels; a ratio against a different kind of work does not — a calibration kernel
measured 20.91, 22.53 and 20.00 ns on this box, a 12% spread of its own, and
dividing one noisy timing by another is worse than either.

Note which way the numbers move: the absolute bound got 33x looser and the gate
got stronger. `mutation-sweep`'s `stage-scan` is the proof — behaviour-preserving,
linear in the mission's size, caught at x7.89 while passing the absolute bound at
7.043 us. The old `us < 5` would have caught it on THIS box and passed it on one
1.5x faster.

## Gates

`check-syntax`, `geom-audit`, `golden-trace`, `physics-test`, `daynight-sweep`,
`budget` (`drive-through --traffic`), `leaf-mask`, `wanted-test`, `mission-test`,
`damage-test`, `blocker-test`, `crash-test`, `roadpath-test`, `route-drive`,
`reaction-test`, `sim-determinism`, `traffic-selftest`, `hud-cue`, `pursuit-test`,
`car-shapes`, `crowd-bill --selftest`, `tri-buckets --selftest`, `gate-align --selftest`,
`mutation-sweep --selftest`, `playtest --selftest`, `car-shapes --selftest`,
`arrest-band --selftest`, `paint-census`,
`glass-census` (needs a browser to decode the reference JPEGs; about 20 s),
`paint-tone` (the same, about 2.4 s), `car-pixel` (the same, about 1.4 s).
The offline ones together take under a minute.

`paint-tone` is cheap enough to be on `mutation-sweep`'s offline list despite launching a
browser — 2.4 s a run, which over ~124 rows is about five minutes of sweep, against the
hour and a half the rest of the list costs. (It was written down as "about 1 s" from a
`date +%s` that rounded; a blind reviewer timed it properly. Time a tool with a clock
that can resolve it.) It is there because `paint-census` cannot see a tone RATIO that is
wrong while still reaching both anchors — the `tone-ratio` row is exactly that mutation and `paint-tone`
is the only thing that catches it. Its `--grid` mode writes a view of any region of any
reference frame labelled in that image's OWN pixel numbers, which is how a box gets placed;
`--crop` then draws the placed boxes over the image so somebody else can check one.

`shadow-bill` needs a browser and takes about seven minutes; it is how a change is
priced in the units the gate reads, and its header records five wrong versions.
`crowd-bill` asserts that the two pedestrian tiers are a PARTITION — no ped drawn
twice, none drawn nowhere — which is the invariant any change to the tier split has
to keep, and it prints the far tier's invisible submissions beside it.
`tri-buckets` is the one definition of the subsystem buckets that `tri-breakdown`
and `shadow-bill` both inject. `gate-align` and `mutation-sweep` are comparators
rather than gates, but their self-tests belong on the list because both are
load-bearing for what a round is allowed to claim.

`hud-cue` is the only gate that looks at what `src/hud.js` DRAWS. Everything else over
that module tests pure functions — `composeBand`'s seven tenants, the marker styles, the
layout arithmetic — so a panel could stop drawing entirely and the whole list would stay
green. Its band ladder now reads the tenant list off `composeBand`'s own signature with a
regex, because a tenant added to the function and not to the ladder sits ABOVE everything
the ladder walks and is invisible to it — which is how `law` went untested for a round. It runs the real HUD against a recording 2D context and asserts the rectangles.
Two things to know before writing another check in it: **the HUD dirty-flags its panels,
so a settled value is not redrawn** — sampling one late frame reads an empty list however
well the thing works, and the first version of that probe read zero at every input while
the code was correct; and **the last pass drawn is up to `eps * exp(rate*dt)` short of the
target**, because `update()` damps first and tests after, which is 0.82 px where the naive
0.69 px bound fails. `boot-check` needs a browser and
takes **about five and a half minutes** — it was twenty seconds, then about a minute once the
busted flow and the run-over wire went in, 209 s with the wedged-car cue and 319 s with the
garage. Every one of those is a host rule nothing offline imports, and the expensive ones are
expensive because they have to let a DWELL run: `district/main.js` clamps dt to 0.05 and
`stepFixed` caps at 16 substeps of 1/120, so the PHYSICS advances at most **0.133 s of sim per
rendered frame however long the frame takes**, and `setTimeScale` cannot buy more than that. A
four-second dwell is thirty frames minimum of physics, and headless is under one frame a second.
Budget for it, bound such an arm on the STATE rather than the wall clock, and report which of the
two ended the run.

**A dwell that is NOT in the physics does scale with `timeScale`, and that distinction is the
cheap version of the arm.** The clamp above is on `stepFixed`'s substeps, not on the sim loop:
`for (let s = 0; s < timeScale; s++)` runs the whole body — `damage.update(dt)`, `bustWatch`,
`wreckWatch`, the garage — `timeScale` times at the clamped dt. So a four-second hold that lives
in that loop completes in ten frames at `timeScale` 8 rather than eighty at 1x, and the garage
arm costs a dozen frames for that reason. Two consequences worth keeping apart: a gate waiting on
a HOLD can raise the scale and should, and a gate waiting on the CAR TO TRAVEL cannot, because
0.133 s a frame is where the substep cap bites. The wedged-car arm is the second kind and the
garage arm is the first.

Run it whenever `district/` or `src/` changed, because it is the only gate that loads the game. `damage-live` takes about twelve minutes and
`ped-audit` about fifteen. Run the ones your change can touch before claiming done.

### A gate printed three FAIL lines and said PASS, and the sweep called it a missed mutation

`mission-test` had `const failed = checks.filter((c) => !c.ok)` a hundred and thirty lines above
its last section — a SNAPSHOT of an array that was still growing. A section added below it printed
all nine of its checks in the listing and not one of them reached the exit code. With the garage
moved onto a mission pickup point the gate printed

    FAIL and the harness repairs the car where the page does  109.3037 m apart
    FAIL a player parked in the garage is not standing in any mission zone  -24.0 m
    FAIL and the clearance is at least a garage wide  -24.0 m against 24 m

and then `MISSION: PASS — 121 checks`, rc 0.

**This is not covered by "read the exit codes rather than the last lines".** The exit code was 0
and the last line said PASS; the only disagreement was between the listing and the summary, four
lines apart. Three things to carry:

- **Never snapshot the accumulator. Count where you report.** Every other gate in `tools/` computes
  `failed` immediately before printing it, which is why only this one was wrong — and it was wrong
  because the new section was inserted at the `=== CHECKS` anchor, which sits AFTER the snapshot.
  A grep over the fifteen gates comparing the line of the snapshot with the line of the last
  `check(` call finds this in one command and found nothing else.
- **`mutation-sweep` read both halves and compared neither, so it reported the flattering one.**
  `runGate` already collected `rc` AND the printed FAIL lines. A row came back MISSED, which sends
  a round out to write a check — and the check was already there, failing. It now reports
  `rc === 0 && failed.length > 0` as a BROKEN GATE and stops the sweep, because a gate whose exit
  code does not follow its own checks cannot be trusted about any row.
- **The arm for it is an integration arm, and it needs a control.** Two mutations at once in two
  files — the real defect in `district/main.js` AND the accounting broken in the gate itself — and
  the control is the same defect with the accounting intact. Measured: rc 1 with 3 FAIL lines and
  `broken false`, against rc 0 with the SAME 3 FAIL lines and `broken true`. Without the control
  the arm would pass for a sweep that called everything broken.

The row that found this is `garage-on-marker`, and it was written in the same round as the check it
caught — which is the condition under which this file's four other unfailable checks were written
too. A row that comes back MISSED against a check you believe you wrote is worth half an hour
before it is worth a second check.

### A check's DETAIL string is evaluated eagerly, so an unguarded read there crashes the gate

`mission-test` §12 asks whether a stage's objective carries a countdown. The objective is a STRING
for a stage with no number and an OBJECT for a stage with one, and the whole point of the section
is a stage moving between those shapes — so the one thing it had to survive is the wrong shape.

It did not. `mutation-sweep`'s `stage-clock` row reverts the shape to a string, and the gate threw
`Cannot read properties of undefined (reading 'toFixed')` after printing **0 FAIL lines**. The read
was `nearly.objective.distance.toFixed(3)` inside a `check(...)` call's DETAIL argument — which
JavaScript evaluates before `check` is ever entered, so the crash beat every assertion in the
section. The row came back **"caught by mission-test(threw)"** and the gate said nothing at all
about why.

That is this file's own `ped-audit` lesson arriving through a new door, and the door is worth
naming: **a detail string is not inside the check.** `check(name, cond, detail)` evaluates all
three arguments first. A condition can be written defensively and still be preceded by a detail
that dies.

Reading every number through one accessor fixed it — `num(o)` returns the figure or null, `unitOf`
and `shape` do the same for the other two reads — and the two rows are now caught by CHECKS: six
FAIL lines for the dropped branch and three for the dropped unit, zero throws, with the detail
reading `"LOSE THEM — 240 m"`, which is the defect in the player's own words.

**A gate asked about a shape has to survive the wrong shape and NAME it.** The difference is not
academic: a throw sends a round to debug the gate, and a FAIL line sends it to fix the code.

**A tool that throws is not a tool that passes, and nobody notices which.**
`ped-audit` handled a build with no contact-blob mesh in its per-mesh loop —
`if (!m) { meshes[k] = null; continue; }`, with a comment saying exactly why — and
then summed `m.crowdTris` over those same values twelve lines later. It had thrown
`Cannot read properties of null` on every run since commit `0687a53` removed that
mesh, through every round since, and the failure surfaced only when a later round
ran the whole gate list. A guard on the producer is not a guard on the consumer.
Run the list, and read the exit codes rather than the last lines.

**A gate is never loosened silently.** If a change moves a threshold, restate the
threshold *in the same commit*, with the derivation. One commit shipped a
transfer-function change while leaving two fog ceilings unrestated, which
loosened a gate without saying so.

## A module with no gate, and `--browser` scoring catches it did not earn

Two findings from one blind mutation reviewer, and the second one invalidates evidence.

**`src/pursuit.js` had no gate at all, and nine of ten mutations against it were MISSED.**
`grep -rn "from '../src/pursuit.js'" tools/*.mjs` returned ONE line, and `sim-determinism` only
checks the filename appears in a list. What the misses had in common is the point: every one was a
GEOMETRIC defect that left the module's own reports and the harness's star counts looking exactly
right. An off-by-one in `_closestOn`'s segment walk makes the hold impossible on the **414
two-point edges of 935** — nearly half the district — and is nearly harmless on a multi-point one,
so it needs the whole network walked rather than a sample. One bracket moved makes a held unit held
for ever: 100% of frames reporting held while the player fled, worst distance 331.9 m, the fleet
driving 3,056 m instead of 9,170, and a single-frame position jump of **19.59 m**. Neither errors.

`tools/pursuit-test.mjs` is that gate. **Write the gate when you write the module**, and the cheap
test for whether you did is `grep` for its importers.

**And `mutation-sweep --browser` was a silent no-op in every tree but one.** `boot-check` defaults
to `BOOT_PORT ?? 8123` and **8123 belongs to the main tree** — this file says so two sections up —
while `runGate` passed no port. So a sweep from a worktree had `ensureServer` find a foreign
document root and THROW, and a throw exits non-zero, and non-zero is how that tool spells "caught".
Every `[browser]` row came back caught whatever it mutated. The reviewer proved it by planting a row
that was literally the same program, `const WRECK_HOLD_S = BUST_HOLD_S` to `= 4.0` on a tree where
BUST_HOLD_S is 4.0. It is the Captures trap again, in the one tool it had never been patched in —
**patching one tool and leaving its siblings is the recurring shape of defect in this repo**, and
that sentence was already written down here.

Two fixes, both needed: a port derived from the tree's own path, and **`--browser` now runs
`boot-check` at HEAD FIRST and refuses the sweep if the control is red**. A gate that already fails
cannot distinguish anything — boot-check was red for three commits, and while it was, every browser
row was noise that read as signal.

### Four of my own checks could not fail, and the pattern is always the same

All four were written in the same round as the code they guard, which is the condition under which
this happens:

- **`§24`'s `firstBite` thresholded on a constant computed in the test file**, not on the module's
  cap, so it printed "wall 29, car 23" whatever the cap was — the reviewer swept it at 0, 0.15, 1
  and 4, where the truths are 7/7, 13/11, 29/23 and null/43. Self-validation closing over the same
  quantity twice, inside the arm whose own comment claims it "says the fix is not cosmetic".
- **A one-sided bound where the quantity lands exactly on the limit.** `heat <= cap` passes for a
  cap that clamps too low; `=== cap` is one token and says the whole thing. It immediately found a
  second rule — `evading` reads 0 because it is REFUSED without a wanted level — so two rules got
  two checks instead of one bound loose enough to cover both.
- **A priority ladder that asserted the LABEL and not the LINE.** Transposing two tenants in `pick`
  alone, leaving the `from` ternary untouched, failed 0 of its checks: the band read "STOP AT THE
  SCENE — 73 m" while `from` still said "fence".
- **A level where a delta was meant.** `respawns > 0` after an earlier arm in the same page load had
  already made it 2.

And the other half of the same shape: **a new field that no gate feeds.** The bust countdown is the
one objective in this game measured in SECONDS, and both render paths default to metres, so a
dropped `unit` mislabels it silently — "3 m" for a 3 s countdown, then "2 s" for a 2 m distance once
the dirty key stopped carrying it, wrong for a full second at each end of every arrest.

### Quote the signal the code reads

`BUST_HOLD_S`'s floor was derived from "contiguous seconds under 2.2 m/s" off the car's RAW speed.
`_watchBust` tests the SMOOTHED `playerVel` against 1.0 m/s. Both rows, measured by feeding
vehicle.js's own positions to the module:

    smoothed under 1.0, which the clock reads   0.20 0.17 0.12 0.17 0.17
    raw speed under 2.2, which it does not      0.68 0.67 0.65 0.67 0.67

The floor is 0.20 s, so 4.0 s is **x20.0** of it and not x5.9. Conservative — it understated the
margin — and still the shape this file already records as "a probe that measures the OPPORTUNITY
does not measure the FIX".

**And a tolerance has to be measured, not guessed.** The displacement check in `pursuit-test`
failed at 1e-6 because `_pointOn` walks a polyline summing segment lengths and comes out 28.8
microns over `speed * dt`. 1 mm is 34x the measured noise and 19,590x below the 19.59 m jump the
mutation produces, so there is no value in between for the bound to be wrong at. A bound with
nothing between the noise and the signal is the only kind worth writing down.

## The quarter-light was not deleted the second time either

A blind reviewer opened the #56 car pair and reported, within seconds and before measuring,
that **two of four visible cars had no side windows at all** in the newer arm — "body-coloured
sheet metal with no window", a cabin **1.20-1.37x brighter than the car's own paint**, no frame,
no beltline break, only a 43x4 px dark sliver surviving. They then measured it hard: glazed
pixel counts halving (3403 -> 1562), cabin-band mean |d| 23.53 against 7.69 on the lower body,
and two other cars **bit-identical to 0.00** as internal controls. They explicitly considered
and argued against the shell explanation.

CLAUDE.md already had a section called "A fixed box over moved geometry is not a measurement of
the material", about three reviewers filing a deleted quarter-light on this same car that was
the body shell moving under their box. So the first question was whether this was that again.

**It was not, and neither was it a deleted window. Three measurements, all offline:**

1. **The glass is in every shell, identically.** Counted off the built buffer by palette index:
   20 glass triangles in all three, 4 of them side-facing, side area within 5.4%, glass z span
   2.354 / 2.354 / 2.358 m.
2. **The pane did not move, so no box mis-landed.** The +x side pane occupies y [1.072, 1.317]
   and z [-1.420, 0.500] in all three shells. The 580 mm of `breakZ` travel that moved the
   quarter-light last time does not reach this pane at all.
3. **Sampling the pane's OWN projection confirms the reviewer's reading anyway.** Projecting
   each shell's pane through each arm's own camera and rasterising it — car-probe's rule, the
   subject found in each arm rather than a box drawn once — glass luma over the door skin
   beside it, at noon:

       car         shells=1        shells=3     pane normal tilt from vertical
       (184,-420)  coupe  0.967    coupe 0.967  18.78 deg -> 18.78    control, identical to 3 dp
       (190,-420)  coupe  0.914    wagon 1.121  18.78 -> 19.45  (+0.67)
       (196,-420)  coupe  0.985   saloon 1.311  18.78 -> 25.57  (+6.79)

**The mechanism is the pane's SHADING NORMAL, not its existence.** The pane is a non-planar
quad and the greenhouse tumblehome differs per shell, so its vertex normals tilt skyward by
+0.67 degrees on the wagon and +6.79 on the saloon while every vertex POSITION stays put. A
pane tilted further skyward catches more sky at noon. **The brightening ranks exactly with the
tilt change** — coupe zero, wagon small, saloon large — which is what makes this a mechanism
rather than a story.

A wrong intermediate diagnosis, kept because it was the obvious one: *"`computeVertexNormals`
is averaging the pane's corners with the rear screen across the pillar."* Measured, the pane's
four vertices are touched by **2, 2, 1 and 1 faces** — only its own two triangles. Nothing
outside the pane reaches them. The normals differ because the QUAD ITSELF is warped
differently, not because of smoothing.

**And the finding underneath is worse than the one reported, and it is in BOTH arms.** At noon
the before-arm glass reads **0.914 to 0.985 of the door skin beside it** — 1.5% to 8.6% darker
than the painted panel. The windows do not read as windows in the build the reviewer preferred
either; the shells take two of three from "barely darker" to "frankly brighter", which is what
made it visible. At dusk the same panes read 0.681-0.953, and #54 records the opposite extreme
at night (glass/paint 0.0225 in linear light). The glazing is wrong at both ends of the day and
only noon makes it look like a missing mesh.

**Three things to carry from this:**

- **A reviewer's observation survived a better instrument and their diagnosis did not**, which
  is the rule this file already states. Both halves mattered: the geometry-following sample
  reproduced the brightening they saw, so "they used a bad box" would have been the wrong
  dismissal — and the buffer count disposed of "the mesh is gone" in one command.
- **The cheapest decisive test was offline and took seconds.** Counting glass triangles per
  shell needs no browser, no capture and no argument. Reach for the buffer before the pixels
  when the question is "is this geometry there".
- **"Two other cars are bit-identical" is a strong control and it is not a shell control.**
  Those two hash to `coupe`, which is byte-identical to no shape at all, so they are the
  unchanged arm standing inside the changed frame. That is exactly what made the reviewer's
  numbers trustworthy, and it is worth building into any future pair deliberately.

## One material, two panes, opposite errors — and each round only ever saw one of them

#92 says "the side glass is within 8.6% of the paint at noon" and quotes 0.914-1.043. `carbody.js`'s
slot-10 comment, from an earlier round, records the windscreen and backlight at 0.035-0.075 and
says "the hole is smaller, not closed". Both are about the same material. They are thirteen times
apart and nobody had put them side by side.

Measured in one frame on the shipped build with `tools/car-pane.mjs`, against a target of
0.137-0.333 measured off the reference photographs (`tools/glass-census.mjs`):

    pane          noon              night             against the target
    windscreen    0.0201 / 0.0167   0.0039 / 0.0037   5 to 10x TOO DARK
    backlight     0.0321 / 0.0320   0.0061 / 0.0043   5x TOO DARK

**So the backlog's framing was upside down for two of the three panes.** The round that wrote the
`carbody.js` comment was chasing a window that was too DARK and measured the windscreen. The round
that filed #92 was chasing one that was too BRIGHT and measured the SIDE pane through a
geometry-following projection. Each was right about its own pane and each wrote its number down as
though it were "the glazing".

Three things to carry:

- **A number needs its SUBJECT in the sentence, not just its value.** "The glazing reads 0.95 of
  the paint" and "the glazing reads 0.07 of the paint" are both true of this build. Neither is
  usable without "which pane, measured how". Every row in the table above names its pane and its
  paint reference for that reason.
- **Two measurements of "the same thing" that disagree by 13x are not noise, they are two
  different things.** The instinct to reconcile them by picking one is the wrong one; the useful
  move is to find what distinguishes the subjects, which here is the pane and the method.
- **It rules the material out, and that is the isolation #92 asked for.** Every pane shares
  palette slot 10, so a material change moves them together and cannot close a 5-10x deficit and a
  5.6x excess at the same time. Off the built buffer the windscreen and backlight normals sit
  62.3 deg from horizontal and the side pane's 21.8 deg, and the shading normals track the face
  normals to 0.4 deg on the coupe — so there is no smoothing artefact to blame either, and the
  remaining candidates are what each pane REFLECTS and how the side pane is sampled.

And a trap in the tool that would have produced a fourth wrong number: `car-pane`'s
`r1QuarterControl` reads 0.357 in a 1-shell frame and 1.350 in a 3-shell one, and it is a
NEGATIVE CONTROL — the box lands on glass in one and on body panel in the other, which is this
file's own "a fixed box over moved geometry" section. Its 1.350 is a painted panel. Reading it as
a glass measurement would have "confirmed" #92's figure from a box that is not on glass at all.

### And when the third pane was finally measured, the 13x disagreement was ONE STATISTIC

Putting the side pane in the same frame as the other two, and re-measuring the real cars in the
same statistic `car-pane` reports, at noon:

                        med/paint    modulation (p95/p50)   ceiling (p95/paint)
    real cars          0.137-0.333        1.56 - 2.25           0.257 - 0.583
    shipped side glass    0.2506             5.295                 1.327
    shipped windscreen    0.0201             1.276                 0.026
    shipped backlight     0.0321             1.195                 0.038

**The side pane's MEDIAN is 0.2506, inside the band real cars occupy.** The 0.914-1.043 everyone
had been quoting is its BRIGHT END — at a modulation of 5.295 its p95 is 1.327 of the paint. Both
numbers are true of one pane. They are a floor and a ceiling, which is the distinction
`car-pane`'s own header was written to enforce and which the backlog entry had collapsed.

So the whole thing restates, and neither remaining defect is the one that was filed:

- the side pane's CEILING runs away — 1.327 against a real 0.257-0.583, brighter than the body it
  is set in, which is what reviewers saw and called "sheet metal with no window". Its median is fine.
- the windscreen and backlight are too dark AND too flat — 0.02-0.03 at a modulation of 1.2-1.28
  against a real 1.56-2.25. A dark panel, not a window.

**A window is not "dark", it is dark with a BOUNDED amount of life in it**, and the shipped panes
miss that band on both sides. Three numbers per pane, not one.

Two method notes, both of which cost a wrong bound first:

- **The two instruments have to report the SAME statistic or they cannot be compared.** The census
  reported a p90-p10 spread and `car-pane` a p95/p50 ratio, so "real glass varies a lot" and "the
  shipped pane varies 5.3x" could not be put side by side at all — which is how a 13x disagreement
  survived two rounds. Adding `modulation` to the census is what collapsed it.
- **And the bound on that statistic was guessed and failed on its own data.** "A real window is
  several times brighter at its top", `modulation > 1.8`, written from the census's own
  observation that one window spans 0% to 56% of its paint. Measured: 1.56, 1.75, 2.25 — two of
  three under it. The measured range is more useful than the guess precisely because it is bounded
  at BOTH ends, and that is what makes "too flat" a finding rather than a feeling.

### The two sweeps that answer it were already captured, and no round had read them this way

`docs/shots` carried both: `ga*` scales the glazing albedo at fixed metalness, `ge*` scales the
glazing's own environment gain. Neither needed a new capture — ten minutes of `car-pane` against
frames that had been sitting there, against a question nobody had the reference band to ask.

**The albedo is nearly exhausted.** Windscreen median/paint at noon: x1 0.0167, x0.33 0.0145,
x0.14 0.0135, **x0.00 0.0127**. Zeroing the albedo entirely moves it by 0.0040, so 76% of the pane
is already the environment reflection. Reaching the 0.164 target on diffuse alone needs about x37
— a linear albedo near 0.19, a frosted panel. `carbody.js`'s own comment had predicted exactly
this case and written down what it would mean: "no albedo setting fixes it".

**The environment gain is the lever and it reaches the band.**

    carGlassEnv      0       1       2       3       5
    windscreen    0.0167  0.0368  0.0619  0.0916  0.1616     target median 0.164
    backlight     0.0320  0.0728  0.1217  0.1767  0.2946     target band 0.137-0.333
    modulation     1.207   1.257   1.284   1.275   1.269     real glass 1.56-2.25

**And the same table says the lever only fixes half the defect.** The modulation does not move:
1.207 to 1.269 across a gain that multiplies the median nearly tenfold. A gain scales the whole
pane, so it turns a flat dark pane into a flat brighter one. The floor is reachable and the LIFE
is not, and that needs structure in what the pane reflects rather than more of it — which is where
`carbody.js` had already arrived from the other direction, "the lit shopfronts reaching the
environment, which a sky-only PMREM cannot carry".

**The round that built this knob had already found all of that, and shipped 2 anyway, because it
had no TARGET.** Its own comment reads "if modulation does not move across a 6x range of the
environment term then the pane has nothing to reflect and the defect is in the environment, not in
the glass — which is a finding, and the round closes on it rather than trying a fifth knob". That
is correct and it is the same conclusion reached here. What it could not do was choose the LEVEL:
nothing said what a real window reads, so 2 and 5 were indistinguishable and 2 shipped. The census
is that missing number, and it says 2 leaves the windscreen at 0.0619 against a 0.137 floor.

**So the constant is 5 now and it is DERIVED, with a gate that re-derives it.** `glass-census`
carries the swept table as recorded data and asserts that the shipped value is one whose measured
windscreen lands inside the photographed band. That is not circular — the two inputs are
independent measurements and the constant falls out of them — and reverting it to 2 fails the
check. A measured constant that nothing re-derives is a magic number waiting for the car to change
under it; this one has the derivation and the gate in the same commit.

**And then I made the pane-naming mistake again, one level down, inside the correction for it.**
I wrote that this left a tension — "three panes, one uniform knob", the side pane's ceiling of
1.327 running away so a gain big enough for the windscreen would push it out of band. That compared
a pane seen at a GRAZING angle against a reference measured FACE-ON. Measuring a real windscreen
off its normal dissolves it:

    ceiling (p95/paint)       real side glass, face-on     0.257 - 0.583
                              real windscreen, off-normal    >= 3.538
                              shipped side pane, grazing        1.327

A real windscreen off-normal in midday sun is MIRROR-BRIGHT — 29% of its glass box clipped at 255
while its own sunlit white bonnet clips 0%, so over much of its area it is at least as bright as
the brightest paint on the car. The shipped side pane's ceiling is well UNDER what a real pane
reaches at that geometry. **Every shipped pane is too dark at every geometry with a matched
reference, and the uniform gain is the right lever after all.**

So the rule earns a third statement in three sections, because knowing it did not stop me:
**a ratio needs its geometry quoted beside it, not just its pane.** Face-on and grazing are
different subjects on the same pane of the same car.

**And that windscreen has no median to give.** There is no box on it that does not clip — three
placements read 5%, 29% and 29% — so `glass-census` REFUSES the row and asserts the clipping
ASYMMETRY instead: the glass clips where its own bonnet does not. That bounds the direction without
inventing a precision the sensor cannot deliver, which is a better outcome than a number from a
clipped box. A subject that resists the instrument is a result; the dropped Chevy Tahoe in the same
file is the other half of that, where three placements read 0.006, 0.005 and 0.002 at modulations
of 7.4, 7.3 and 11.3 and every one straddled a pillar or a shut line. Left in, its 0.002 would have
widened the band by two orders of magnitude on the strength of a bad box.

## `setHSL`'s colour space is the WORKING one, so an HSL lightness here is a LINEAR albedo

Three rounds authored a car's paint lightness as if it were an sRGB level. It is not.
`Color.setHSL(h, s, l, colorSpace = ColorManagement.workingColorSpace)` defaults to the working
space, which this build runs as `srgb-linear`. `setHex`/`set`/`setStyle` default to sRGB and DO
convert — `new Color().setHex(0x808080).r` is 0.2159 — while `setHSL(0, 0, 0.5).r` is exactly 0.5.
`src/facades.js` passes `THREE.SRGBColorSpace` explicitly where it wants the other behaviour,
which is the tell that somebody once knew.

The consequence was the whole of #1's second half. `l = 0.34 + r * 0.26` reads like "mid-tone to
light", and as a LINEAR albedo it is 0.34 to 0.60 — a span of x1.77 where a real white car over a
real black one is about x17. Both fleets were a single mid grey and no round had noticed, because
in sRGB terms 0.34..0.60 looks like a reasonable spread.

**Check which constructor a colour came through before reading a number off it.** The two differ by
a factor of 2.3 at mid grey and by 10x near black, which is exactly where a black car lives.

## One frame is not one measurement: a within-frame ratio needs one LIGHT and one PANEL too

`glass-census` takes glass over the paint beside it ON THE SAME CAR, so the illumination and the
orientation cancel for free. Carrying that method across to two DIFFERENT cars does not work, and
the size of the error is the finding:

    white car / black car, linear luma, same frame, same parked row, rear face of each
      open midday sun     0.5303 / 0.0313    x16.9
      deep building shade 0.1693 / 0.0895    x1.89      the same measurement, x9.0 apart

Nothing about the cars differs. What differs is the light the two rows stand in.

**And the explanation I attached to that was overreach, which a blind reviewer caught.** I wrote
that a camera pipeline LIFTS shadows, that a lift compresses a ratio toward 1, and that a dim
row's reading is therefore a FLOOR. The selftest proved the lift and the prose generalised from
it. Run the other curves through the same encode -> curve -> EOTF chain:

    a true ratio of 16 reads
      identity              16.00
      lift  ^(1/1.3)         8.99     compresses
      lift  ^(1/2)           4.33     compresses
      TOE   ^1.15           22.57     EXPANDS
      TOE   ^1.3            30.97     EXPANDS
      S-curve, smoothstep   66.69     EXPANDS, x4.2
      additive glare +0.002 linear   15.10    compresses
      additive glare +0.01  linear   12.36    compresses

A contrast S-curve on the encoded value is exactly what a consumer pipeline applies, and it runs
the wrong way. **So the tone-curve leg bounds nothing in either direction.** What survives is the
ADDITIVE leg — veiling glare, clearcoat sheen and ambient fill add a floor to both subjects and
so lift the dark one proportionally more — and that compresses, by 5-23% at plausible magnitudes.
That is the one direction a photographed car-to-car ratio can be claimed to err in.

What makes x16.9 believable is therefore not a bound argued from a curve nobody has
characterised. It is that an **independent source agrees**: published white automotive paint is
0.75-0.85 and black 0.04-0.06, a ratio of x12.5 to x21. Two lines of evidence landing on ~16 is
the argument. `paint-tone --selftest` now proves BOTH curve directions, so the one-sided claim
cannot be made again from that file.

The general rule, and this is the third time this file has had to write a version of it:
**a selftest that proves one case does not license a sentence about every case.** The arm was
correct; the paragraph above it was not.

Two more rows were tried and thrown away, and both printed plausible numbers:

- **A bonnet against a flank.** A bonnet sees the whole sky and a flank does not, so the ratio is
  a measurement of the sky.
- **A sunlit car against a shaded one in the same frame.** x1.84, and it was reading the shade.
  The dark car also turned out to be dark BRONZE rather than black, which is the second half of
  the same mistake — a family assigned from a thumbnail. It is kept in the tool, labelled
  REJECTED with both reasons, because "the subject resisted the instrument" is a result.

So the rule is three constraints, not one: **same frame** (one exposure), **same row** (one sun and
one surround), **same panel** (one orientation and one incidence). And `--crop` writes the boxes
over the image, because four of the six boxes in that file were moved at least once after their
p10/p90 spread announced that they straddled a shut line, a taillight or the edge of a shadow.

## I wrote a mechanism, never checked the caller, and it reached four places

The paint-slot tint confines `instanceColor` to palette slot 0. The lamp spill carries a per-car
BRIGHTNESS on `instanceColor` rather than a colour, so that multiply has to survive. I wrote down
why it does: every vertex `buildCarGlowGeometry` emits is on SURFACE.paint, so slot 0 staying
tinted is what keeps the headlamp pools working.

The first half is true. The second half is not the reason, and one `grep` says so:

    grep -n patchLensFalloff src/carbody.js
      620   function patchLensFalloff(m) {
      700     return patchLensFalloff(m);        <- inside carSurfaceMaterial, the only caller

`carGlowMaterial()` returns a bare `MeshBasicMaterial`. The injection is not in that program at
all, so three's stock `color_vertex` carries the instance colour through whatever slot the
vertices are on. The spill is immune because its material was never a candidate.

**It had been written into four places by the time a blind reviewer checked the caller**: the
shipped comment in `src/carbody.js`, a gate's own message in `tools/paint-census.mjs` ("every
vertex of the lamp spill is on the paint slot, **so** its per-car brightness survives" — a true
premise with a false consequent), and the `why` strings of two `mutation-sweep` rows. Four places
a later round would have read it as established, and the gate message was the worst of them
because a check that states a false reason reads as coverage for it.

Three things to carry:

- **A mechanism is a claim about the CALL GRAPH, and the call graph is greppable.** "This material
  carries the injection" took one command to check and I checked the geometry instead, because
  the geometry was the thing I had just changed.
- **Both checks were worth keeping and they say different things.** That the glow material is not
  the patched one is why the spill works TODAY; that its geometry is entirely slot 0 is what would
  keep it working IF that material were ever moved onto the patched one. The second is a
  conditional and is now labelled as one.
- **A negative needs its positive.** "The glow material does not carry the injection" passes for
  any material at all — three gives every `Material` a no-op `onBeforeCompile`, so a test looking
  only for the uniform's absence reads ok on something that was never a candidate. The check
  measures both materials the same way and asserts the car surface material DOES carry it.

### And the check that nothing in the repo could fail

Three more of my own, from the same reviewer, and the pattern is this file's standing one — all
were written in the same round as the code they guard:

- **`0.60 < WHITE_L && 0.66 < WHITE_L && 0.34 > BLACK_L && 0.26 > BLACK_L`**, where `WHITE_L` and
  `BLACK_L` are two `const`s ten lines above in the same file. Four literals against two
  constants: **it cannot fail for any edit to any source file in the repo**, and it was being
  counted among that gate's checks. It is arithmetic about a build that no longer exists, so it
  is printed as arithmetic now and the check count went down by one. A gate's count is only worth
  something if every row in it can fail.
- **A KNOWN-BAD that tested one of the two fleets it named.** The condition read `OLD.traffic`
  while the message said "the range this replaced" and the detail printed both fleets' figures —
  and the parked pool's old range CLEARS that floor, so the floor alone never established the
  defect for that fleet. Half a case guarded, reading as a guard, which this file already records
  under `facades.js`'s awnings. The fix is two checks, one naming each fleet, with the second
  saying out loud that the floor does not catch it and which check does.
- **A check whose answer is guaranteed by the function under test.** `movedChrom === 0` over
  `recolour`, whose chromatic branch has no legacy ternary in it at all. It can only fail if
  somebody adds one. Kept at that strength and labelled, because a future round that gives the
  chromatic lightness its own before-arm has to come here and restate it.

### And a mutation nothing catches, measured rather than assumed

The same reviewer planted `mix(color.xyz, vColor.xyz, …)` for `mix(vColor.xyz, color.xyz, …)`.
That inverts the whole rule — `instanceColor` then reaches every slot EXCEPT the paint, so every
car renders at its authored grey and the plate, lamps, rims and tyres carry the body colour,
which is #1 upside down. It passes **all three of `paint-census`'s source regexes** (the seam
throw is there, `floor( uv.x * 16.0 )` is there, the cache key is bumped), **all 70 of
`boot-check`** (which reads the uniform's own getter and never samples a pixel) and all 65 of
`traffic-selftest`.

It is caught now, by a check that asserts the RULE rather than the string: the instance-tinted
colour is the mix's first argument and the authored one its second, because the weight is 1 where
the authored colour must win. Stated that way so it is not a regex fitted to one mutation.

**And the gap underneath it is wider than the row and is still open.** Nothing anywhere samples a
PIXEL of a car: `boot-check` reads the uniform's own getter and `paint-tone`'s render section
reads committed PNGs, which a mutated source cannot reach. The rendered version is max-over-median
across one car's own pixels with the fleet forced near-black — the lamp is 0.95 absolute over a
body at 0.047 under the correct rule, and the body is the brightest thing on the car under the
inverted one. **A row kept in the table with its gap written into its own `why` is worth more than
a row deleted**: it is the difference between a gap somebody measured and a gap nobody looked for.

## Two defects that each make the other worse have to ship in one commit

#1 ("the plate reaches x0.41 of a real one") and "the fleet has no white or black cars" were filed
as separate entries and were one entry. `instanceColor` multiplies every vertex of an instance, so
the plate carried the body's tone; widening the tone range to reach black therefore makes the plate
*worse*, not better:

    plate rendered, against a real plate's ~0.80     fleet tone span
    before                   0.212 .. 0.482          x2.27
    tone widened alone       0.023 .. 0.636          x27.30     x0.029 at the dark end
    tint confined alone      0.7317 on every car     x2.27      correct plates, grey cars
    both                     0.7317 on every car     x27.30     x0.915

Shipping either half alone would have been a round that measured an improvement in one number and
a regression in the other, and the regression is the one a player sees. **Before taking a lever,
ask what else reads the quantity it moves** — here the answer was "every non-painted surface on the
car", and it was already written down in both modules' own comments as the reason the fleet had to
be grey.

**Two consequences of a x17 albedo range that the round did not price, both from a blind review.**

- **The palette's paint slot is metalness 0.60, so these albedos are not reflectances.** Three's
  physical BRDF splits an albedo `a` into `diffuse = a * 0.40` and `F0 = 0.04 * 0.40 + a * 0.60`.
  So the photographic target of 0.047 ships as 0.0188 of diffuse, 2.5x darker than the number it
  was derived from, and 0.800 ships as 0.320 of diffuse with an F0 of 0.496 — a white car is a
  polished reflector rather than a white panel. **And F0 crosses the plain dielectric 0.04 at
  exactly a = 0.040**, so an albedo under that gives the darkest cars LESS clearcoat sheen than a
  sheet of glass. The first table ran to 0.032 and put the bottom 27% of the black range there.
  The floor is the crossing now, and the lever for the rest is the METALNESS — do not reach for
  the lightness, which would be compensating a BRDF term with an albedo term.
- **Every paint-denominated ratio in the record is now incomparable, and nothing said so.**
  Replaying the shipped fleet against the old rule, car for car: the range is x0.08 to x2.14 and
  **17 of 30 cars move by more than 2x** (8 darker, 9 brighter). `tools/car-pane.mjs` measures
  glass over the paint ON THE SAME CAR at fixed boxes over captured frames, and every figure in
  this file's glazing sections is one of those ratios — side glass 0.2506, modulation 5.295,
  ceiling 1.327, windscreen 0.0201, backlight 0.0321. The denominator just moved for most of the
  fleet. No GATE breaks (`glass-census` measures photographs and recorded sweep data), but a
  re-capture at the same camera cannot be compared with those numbers. **When a change moves a
  quantity other people's numbers are divided by, say which numbers it retires.**

And the escape was free, because the slot was already in the geometry: `paletteU(i)` is
`(i + 0.5) / 16`, so `floor( uv.x * 16 )` IS the palette slot, in the vertex shader, taken from the
same number the material reads roughness with. **A rule beats a list** — "instanceColor applies to
the paint slot and to nothing else" cannot fall out of step with a slot somebody adds later, which
a `Set` of slot indices can and which is this repo's recurring shape of defect.

**Two things that rule has to be checked against, and the second is the one that could have passed
for nothing.** `src/traffic.js` writes `setColorAt(i, setScalar(f))` on the lamp-spill mesh to
carry a per-car BRIGHTNESS rather than a colour, and that only keeps working because every vertex
`buildCarGlowGeometry` emits is on slot 0 — a vertex of it on any other slot would silently stop
responding to its own headlamps. And a rule confining the tint to slot 0 does NOTHING if the car is
entirely slot 0, so the gate asserts both: the spill is 100% slot 0, and 59.2% of a traffic car is
not.

## Scramble a blind pair PER HOUR, and let the reviewer recover the assignment from the data

A pair handed to a blind critic as `armA`/`armB` leaks its direction the moment the critic guesses
that A is always the before. Assigning them **differently at each hour** removes that: the critic
has to answer per hour, and whether their two answers agree is then information rather than
bookkeeping.

It worked. The critic preferred one arm at noon and the other at dusk, from the images alone,
before any number — and those two turned out to be the same build. Then they recovered the
assignment from the data, using the one quantity no confound can fake:

    on a car whose paint is BYTE-IDENTICAL between the arms, the number plate moves
      noon   0.0841 -> 0.2272   x2.70      its paint moved x1.00
      dusk   0.0583 -> 0.1315   x2.26      its paint moved x1.00

A brightness change, an exposure change, a different hour or a mis-registered pair all move the
plate and the paint the SAME way. Only a de-tint moves them apart. They then cross-checked on a
wholly independent quantity — a grey car's boot lid, after/before **0.652 at noon and 0.656 at
dusk, 0.6% apart across two hours**.

**Build the byte-identical control into the pair deliberately.** This file already says so about
the #56 car pair ("two other cars are bit-identical is a strong control"), where it was an
accident. Here it was not: the chromatic lightness was deliberately left alone, so a chromatic car
in frame had to come back byte-identical — and that single number says the arms are registered to
the pixel, the exposure and the light are the same, and the term that was meant to stay still did.
Every other number in the pair is unreadable without it.

And the other half of a good blind brief is saying what NOT to file. This one listed the 0.5 s of
sim between the arms, the byte-identical `triangles`/`chunks`/`lodNear`/`lodFar`/`drawCalls` in
the audits, and that the HUD is hidden on purpose — so the critic spent none of its round on a
pedestrian that had walked.

## Two bounds that are numerically coincident are one coin toss

`boot-check`'s wedged-car arm runs at most 400 frames, breaks when `stuckFor` reaches 4.0 s, and
had a 240 s wall-clock net. Through SwiftShader a frame is about 0.6 s, so **400 frames IS 240 s**:
the two bounds were the same bound, and which one fired was decided by how fast the box felt. It
fired the clock at `stuckFor 3.80` against a 4.0 threshold — 5% short — and the gate failed.

Three runs on one tree gave 2, 6 and 2 failures in three different arms, which is what contention
looks like from outside and is why this file says to clean the box and run three times. What made
it diagnosable in ONE run instead was that the arm **reports which bound ended it**: "ended on
'wall clock'" is a budget, "ended on 'stuck'" is the state. That line is why the failure did not
read as a behaviour change in a round that had just touched the car.

The net is 420 s now — 400 frames at 1.05 s each, which is a slow box rather than a hung one — and
on a healthy box the loop still exits on the state and costs nothing extra: the same run went
435 s against 441 and 448 for the failing ones. **A safety net has to sit above what the real
budget costs on a bad day, or it is not a net, it is a second budget.**

## A glass-over-paint ratio is 1/TONE of a material property, and it always was

Every glazing figure this project has ever quoted is glass divided by the paint on the SAME car:
the census band 0.137-0.333, the `ge` sweep's 0.0167..0.1616, #92's 0.914-1.043, #54's 0.0225 at
night. That makes the car's paint tone the DENOMINATOR, and the vendored shader says the numerator
does not carry it:

    material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor );

`vColor` — and so `instanceColor` — reaches `diffuseColor` and nothing else. The glazing is palette
slot 10 at **metalness 0.00**, so its specular response is a fixed 0.04 and the environment
reflection it returns is independent of the car's paint; this file already records that reflection
as 76% of the pane at extra 1, and more at 5. The paint slot is metalness 0.60, so its box scales
with the tone in full. **glass/paint ∝ 1/tone.**

Three things follow, and the first two were true before anybody noticed:

- **The census band is a LIGHT-CAR band.** All six of its subjects are white or silver — there is
  no other kind in the file. 0.137-0.333 is what a window reads on a light car; the same window on
  a black one reads several times higher, and that is correct rather than a defect. `glass-census`
  asserts the subject families now, so a dark subject cannot be added without restating the band.
- **The shipped `uGlassEnvExtra = 5` compared like against like by luck.** Its sweep's subject
  bonnet reads **0.4760** in linear light (mean sRGB 174,180,190), measured back off the committed
  frames — a light car. So matching its windscreen to a light-car band was the right comparison and
  the constant stands. The qualifier was simply never written down.
- **It became load-bearing the moment the fleet got black cars.** The tone table moved 17 of 30
  cars by more than 2x and put 41.9% of the fleet at 0.040-0.080. A blind playtester measured the
  consequence exactly — glass over paint going **0.137 -> 1.76 at noon on a car that became
  black** — and read it as the glazing having been made conspicuous. The glazing did not move. Its
  denominator did. Their observation was right and their diagnosis was not, which is this file's
  standing rule arriving on a number I had handed them.

**So a glazing figure needs the car's TONE quoted beside it**, the way the last three sections of
this file established that it needs its PANE and its GEOMETRY. Three qualifiers now, all learned
the same way: a ratio was quoted as though it were a property of one surface when it is a property
of two.

Re-deriving the constant for the new fleet needs a capture whose subject tone is KNOWN, which
`__district.setCarTone` makes possible and which nothing does yet.

### And the direct measurement was refused, twice

The clean way to settle the band's tone dependence is a real BLACK car's glass over its own paint,
from the same photographs. Two subjects were tried and both are recorded as refusals rather than
quoted:

- **A black saloon in the sunlit lot** — the one whose boot lid gives the x16.9 paint ratio. The
  whole car is about 45 px wide, so its rear screen is roughly 25x8 and the screen/boot boundary is
  two or three pixels. No box on it is not straddling.
- **A black pickup, large and well resolved** — and in deep building shade, where its own paint
  boxes read p50 **0.0006 and 0.0048** against p10s of 0.0001. That is the JPEG's dark floor, not a
  measurement.

"The subject resisted the instrument" is a result, and the band's tone dependence stands on the
shader line and the subject list without it.

### And two tools here use two different box conventions

`paint-tone --sample` takes `x,y,w,h`; `car-pane`'s `PANES` are `[x0,y0,x1,y1]`. Feeding one to the
other turned a 128x56 box into 344x684 — 235,296 px of mostly road and sky. It announced itself,
because the p50 came back **0.0000** on a sunlit bonnet, which is the good case. Convert at the
boundary and check `n` against the box you meant.

## Two protocols agreeing is the only cross-check worth having, and round 10 got one for free

`tools/arrest-band.mjs` measured a stalemate — a stationary wanted player between 28 m and the
star's sight radius can neither be arrested nor escape — by PLACING one seed at nine distances
through the play harness. A blind playtester, briefed on the gameplay surface and told nothing
about it, measured the same thing by DRIVING five seeds to seven distances:

    off-road   arrested/5   escaped/5   stuck/5      mine, one seed
      2.7 m        5            0          0         8.0 m arrested
     20.7 m        5            0          0        22.9 m arrested
     32.6 m        0            0          5        37.8 m stuck
     80.6 m        0            0          5        97.3 m stuck
    128.2 m        0            5          0       185.9 m escaped

Different protocol, different seeds, different star level, same three bands with their edges on the
same two constants. That is the independent second protocol this file already demands for the
shadow bill, arriving because the round measured a thing and then asked somebody else to play it.

**And they measured the half I could not.** My probe reports busts and stars; they report what the
player SEES — the band objective is `null` for the whole 180 s, the escape clock resets 1-5 times
over 240 s and the best it ever reaches is **4.7 s of the 34 s needed**, and the only moving cue is
the star note cycling `SEEN -> EVADING 34s -> EVADING 33s -> SEEN`, 21 distinct states in 180 s. A
measurement of the mechanism and a measurement of the experience are different measurements.

The brief is what made it independent: it named the systems and the method and said what NOT to
file, and it did not mention the band. **Do not tell a playtester what you already found** — a
confirmation from somebody who was looking for it is worth much less than one from somebody who was
not.

## A finding whose own numbers refute a simpler version of itself

Round 10's second playtester reversed four of its own readings and recorded both versions. Three of
the four are the same shape and it is worth naming, because each wrong version printed a clean table:

- **A straight-line throttle sweep measured POSITION, not speed.** Testing whether motion defeats
  the arrest, the first arm held a throttle and read 0 of 3 arrested at every value — because the
  car had driven 259 m away, out of the pursuit's reach entirely. The second circled on FULL LOCK
  and read 3 of 3 at every value — because full lock caps the car at 1.5-2.5 km/h, under the
  threshold. Only the third, steering from the car's own `R_min(v)` so the circle is 25 m and the
  speed is the variable, isolates it: **2.8 km/h arrested 3 of 3, and 4.8 km/h and up 0 of 3.**
- **A fence sweep at full lock read "no forward angle escapes".** The lock was the confound; with
  the wheel straight, 135 degrees of nose-off covers 135.2 m. The real finding is narrower and
  more useful: nothing forward works until the nose is past 90 degrees, and you cannot get the nose
  past 90 degrees by driving forward.
- **A repeated-impact arm read "buildings can never make you wanted".** It reversed 25 m between
  hits, about 40 s, and `idleBleed` at 0.09/s wins that race. It is the GAP that decides: two taps
  3.04 s apart are a star, 10.1 s apart are not.

In all three the first instrument varied something other than the intended term, and this file's
"isolate one term at a time" is the rule — but the operational version is sharper: **say out loud
which quantity your control holds fixed, and then measure that it held.** The circle arm is
trustworthy because it reports a 50 m position drift beside the speed.

## A frame counter is not an event counter, and one of them is 368x the other

`stats.runOvers` is incremented per PHYSICS FRAME in which the car overlaps a body. Over a 10 km
drive it read **3,684** — 368 per kilometre — while the number of distinct CHARGED run-overs on the
same drive was **0**. A round quoting the first as "run-overs" would be out by three orders of
magnitude and in the flattering direction for a severity claim and the damning direction for a
frequency one.

The playtester caught it by asking the other question — "how many were charged" — and the two
numbers could not both be about events. **When a counter and a charge disagree by orders of
magnitude, one of them is counting frames.** Name such a field for what it counts.

## `pkill -f PATTERN` matches the shell running it, exactly as `pgrep` does

This file's Captures section records the `pgrep -f` trap: the waiting shell has the pattern in its
own argv and finds itself for ever. A round-10 playtester hit the same trap through `pkill`, where
it is worse than a hang: `pkill -f "D4-flatout"` matched the shell running the very command that
contained that string, **killing it mid-heredoc so a scenario file was silently never written**, and
taking two sibling background jobs with it.

So the rule applies to the whole family and the consequence differs: `pgrep` spins, `pkill` kills
the thing asking. Use a pattern that cannot match itself — `pkill -f "[D]4-flatout"` — or a pid you
captured.

### And the bracket trick protects the PATTERN, not the rest of the command line

That is not enough, and I hit it in the same session as writing the section above. The command was

    pkill -f "[b]oot-check.mjs" ; python3 - <<'EOF'
    f = 'tools/boot-check.mjs'
    ...

The pattern is bracketed and cannot match itself. The HEREDOC two lines down contains the literal
`tools/boot-check.mjs`, that text is part of the same shell's command line, and `pkill -f` matches
the whole line — so it killed its own shell mid-heredoc. Exit 144, the python file was never
written, the edit never landed, and `git status` read clean, which is the most convincing possible
picture of a command that did nothing.

**The tell was that the tree was clean AND the target file still parsed.** A command that had run
and failed would have left something; one that had never run leaves exactly that.

So: **a `pkill -f` and any mention of its target in the same command are the same bug, however the
pattern is written.** Put the kill in a call of its own, or use a captured pid. (Splitting the
string in the script — `'tools/' + 'boot' + '-check.mjs'` — works and is worse, because the next
person to read it cannot see why.)

## When a reviewer is wrong

Blind reviewers here measure before judging and are usually right, but not
always, and their diagnosis is weaker than their observation. Two independently
reported that shade out-warmed the sun; both were reading a "sun" population
that was ~1% of the band, mostly gaps in the oak canopy. The observation was
real, the offered cause was not, and the actual cause was a wall term that
assumed the whole canyon wall was lit. **Reproduce the number, then test the
diagnosis separately.**

## Two modules claimed a fix in prose and neither made it, and the missing thing was the TARGET

`src/traffic.js` and `src/streetfurniture.js` each carry a paragraph saying the reference is
"overwhelmingly white, silver, grey and black with the occasional red or blue" and that a uniform
hue wheel "was a fairground". Both are right. Both then drew their chromatic third from a uniform
hue wheel. The achromatic half of each claim shipped and the chromatic half did not, in two
modules, for as long as the comment has existed.

**The code was not the gap. The TARGET was.** Neither comment named a distribution and neither
named a source, so there was nothing the draw could be measured against and no check could be
written. "Overwhelmingly white, silver and black" is a sentence; 65 vehicles over 11 panoramas is
a table. A prose claim about appearance is a claim nothing can fail.

So the work was a census, not a patch: `reference/sarasota/car-colour-census.json`, with its method
and its biases in the file, and `src/carpaint.js` as the one table both fleets draw from — one
module rather than two patches, because this pair has now had the same defect twice and the second
instance went 25 days because the first got a one-line fix and nobody looked next door.

Four things worth keeping about measuring from photographs:

- **A coarse instrument you can trust beats a fine one you cannot.** The first probe tried to
  estimate hue angles from pixel boxes picked by hand over 200 cars. Hand-transcribing 200 boxes
  introduces more error than it removes, and a box that lands on glass or shadow is silently wrong.
  Seven high-contrast families — white, silver, black, red, blue, beige, green — is something
  visual classification resolves reliably, and it is enough to answer the question the fix needed.
  **State what the instrument CANNOT do**: this one cannot resolve a hue angle, and the file says so.
- **Sample so the frames are disjoint, and say how.** Panoramas 14 m apart see the same parked
  cars. Greedy subsampling at 45 m plus "only count cars you can read confidently" — which in
  practice means within ~30 m — makes the two constraints do the same job, because the cars that
  recur between frames are the distant ones.
- **An absence needs a bound, not a zero.** 0 of 65 is not "green cars do not exist". The rule of
  three gives a 95% upper bound of 3/n = 4.6% of all cars, and that is the number the table is
  built under: green keeps 8% of the chromatic third (2.7% of all cars, under the bound) rather
  than being deleted. Deleting it would be over-fitting a sample of ten chromatic cars.
- **Do not move a figure your instrument cannot resolve.** The census reads 15.4% chromatic, but
  dark red and navy read as black in bright sun and only confident calls were counted — so that is
  a LOWER bound, and the authored 0.66 achromatic split was left exactly where it was. Changing it
  on the strength of a biased number would be the "a metric whose answer is its own quantisation"
  trap one section up, arriving as a gameplay change.

**And the gated quantity is the DRAW COUNT, not the colour.** `traffic.js` colours from the same
seeded stream `_chooseNext` draws from, so a third draw in the colour block moves every routing
decision after the first car — the perturbation this file already records as taking the building
check from 0 of 215,960 car-frames to 342. The family and the hue within it therefore both come out
of ONE draw: `paintFamily` uses the draw's position within the chosen family's weight interval as
the position within that family's hue range, which is still uniform and costs nothing.
`tools/paint-census.mjs` counts the `this._r()` calls **in the shipped source**, not in the copy of
the expression its own arm models, and `mutation-sweep`'s `paint-draw` adds a third draw to prove
that check has teeth.

## The fleet has no white cars and no black ones, and the reason it was frozen had expired

`src/carpaint.js` fixed which HUES the chromatic third draws. Nothing had looked at the other half
of the table. Both fleets pick an HSL lightness from a narrow mid band:

    src/traffic.js          l = 0.34 + r * 0.26          ->  0.34 .. 0.60
    src/streetfurniture.js  l = 0.26 + ((h*7)%1) * 0.4   ->  0.26 .. 0.66

A white car is L~0.85 and a black one L~0.15, so **neither fleet can draw either**. Against the
census — white 29.2%, silver 20.0%, black 35.4% — that is **64.6% of the real population with no
tone in either draw**, painted mid-grey instead. It is why every car in a frame reads as one tone.

**It was frozen on purpose and the reason was about a different round.** `streetfurniture.js` says
so: "LIGHTNESS IS DELIBERATELY UNCHANGED from the hue-wheel version it replaced ... The first cut
also widened the lightness range, which repainted the probe's own pinned subject and made vGrad,
spec and edges incomparable across the round: a confound I introduced into the very A/B I was
running." Correct, and a statement about that A/B rather than about what the range should be — the
third instance this file now records of **unfinished, not wrong**, after the glazing's gain at 2
and the hue wheel both modules claimed to have replaced. The shape is always the same: a round
scopes a change honestly, writes down why it stopped, and the note then reads as a decision.

**And it is entangled with #1, which is why neither should be fixed alone.** `instanceColor`
MULTIPLIES the vertex colour, so a light detail cannot exceed the car's own paint. Measured off the
buffer: the plate's vertex colour is 0.7317 and the instanceColor luma spans only 0.339 to 0.529,
giving x0.43 of a real plate on an achromatic car and x0.37 on a chromatic one — which reproduces
the x0.41 already recorded. Widening the tone range fixes the plate on a white car (x0.80,
essentially correct) and makes it strictly worse on a black one (x0.09). A real plate is
retroreflective white on every car, so the honest fix is both at once: widen the range AND give the
plate slot an escape from the multiply, which `ENV_GAIN_SLOTS` already proves is possible on this
material.

**Note which claim in the backlog was wrong and how.** It said "no vertex colour can raise it: body
panels are already authored 0.995". That is the PAINT slot's range (0.42-1.00); the plate's own
vertex colour is 0.7317 with headroom to 1.0. The entry named a real defect and the wrong binding
constraint, which is this file's standing rule about a reviewer's observation outliving their
diagnosis — arriving here from a backlog entry instead of a reviewer.

## A fix that moves one branch leaves the other reading the value it replaced

`src/carpaint.js` exists because two modules claimed the same fix in prose and neither made it.
The round that gave it an achromatic tone table — mine, this session — then did the same thing one
level down, in both modules, in the same commit.

    achromatic, from the census table   0.040 .. 0.870   x21.75
    chromatic, src/traffic.js           0.340 .. 0.600   x1.76
    chromatic, src/streetfurniture.js   0.260 .. 0.660   x2.54

**`traffic.js`'s chromatic band is byte-identical to the `0.34 + r * 0.26` the table replaced**, and
`git log -S` puts both `CHROMATIC_L` constants in `35b6267` — the commit that replaced it. They are
not chromatic decisions at all: each is its module's own legacy ACHROMATIC band, named and left
standing when the achromatic branch moved out from under it. Which is also why the two disagree,
and why nobody noticed they disagree: a constant that was correct in its old role reads as a
decision in its new one.

The section above this one says "the fleet has no white cars and no black ones ... a span of x1.77
where a real white car over a real black one is about x17". That sentence is still true of a third
of both fleets. **The fix shipped for 66% of the population and the defect's own number survived in
the other 34%, under a new name.**

Three things to carry:

- **When a branch is moved to a new source of truth, read what the SIBLING branch is still using.**
  One `grep` for the constant that was deleted finds this: the value does not disappear, it gets a
  name. `git log -S` on the old expression and the new constant lands on one commit.
- **Comparing the two numbers is what found it; looking at either would not.** x1.76 is not visibly
  wrong on its own — it is a plausible mid-tone band. Beside x21.75 it is a factor of twelve. So
  `paint-tone` now prints the span of both next to the achromatic span on every run.
- **It is recorded rather than tuned, because only the floor is derivable.** The BRDF crossing at
  `a = 0.040` applies to any car on this material, so the chromatic floor is six to eight times
  above a measured bound. The SHAPE is not available: the census resolves FAMILY and says so, not
  VALUE within a family, and a bright red at the white tone is pink rather than a light red, so the
  achromatic table cannot be reused. Lowering the floor alone would repaint a third of both fleets
  on a uniform distribution nobody measured — this file's own "do not move a figure your instrument
  cannot resolve", arriving as the obvious fix for a real defect.

## Two instrument errors in one probe, and both of them accused the shipped build

`tools/car-pixel.mjs` closes the gap this file recorded as open — "nothing anywhere samples a
PIXEL of a car" — and it took three versions, of which the first two printed a FAILING gate over
a build that is correct. Worth the space because that is the dangerous direction: a probe that
says PASS when it should fail wastes a round, and a probe that says FAIL when it should pass
sends a round to change working code.

**1. A rasterised triangle list is not a mask, because it has no depth test.** Projecting each
triangle through the camera and filling it marks the pixels of a paint triangle on the FAR side
of the car, so the lamp's pixels were in both masks. Measured: 4,474 px of paint, 1,770 of
non-paint and **6,363 dropped as ambiguous** — more pixels thrown away than either mask kept, and
what survived in `other` was the biased subset no paint triangle happened to project onto. Two of
twelve checks failed.

The fix is to RENDER the mask: a flat `MeshBasicMaterial` with `vertexColors` carrying the slot in
the red channel, through the same camera and the same depth buffer, with linear output and no tone
mapping so a vertex value `v` lands on byte `round(v*255)`. And it has to be a **non-instanced
Mesh**: `color_vertex` is `vColor = color; vColor.xyz *= instanceColor.xyz`, so a mask drawn
through the InstancedMesh would be modulated by the very quantity under test.

**2. A per-vertex mask is interpolated, and 9.9% of this car's triangles span two slots.** 104 of
1050 span slot 0 and slot 1, paint and trim. Byte quantisation puts the mask's rounding boundary
at 44.3% of the span — bytes 8..16 round at 11.5 — against the shader's `floor(uv.x * 16.0)`
crossing at 50%, so a ~6% sliver of each mixed triangle was classified as trim while being
rendered as tinted paint. **Slot 1 read x1.759 between the arms where every other slot read
x1.000 exactly**, and the gate called the shipped build broken.

**And the mixed triangles are not a defect, which took checking rather than assuming.**
`packTexture()` is `NearestFilter`, so the palette samples texel `floor(u * 16)` — the same
expression the tint's `step( 0.5, floor( uv.x * 16.0 ) )` branches on. The material boundary and
the tint boundary are therefore the SAME boundary by construction and not by coincidence: half
such a triangle is paint with the tint and half is trim without it, and the two halves agree to
the pixel. It is how this car gets a bumper line without a seam in the mesh. So they are
ambiguous to the INSTRUMENT and correct in the BUILD, which makes exclusion the right answer
rather than a smaller threshold — `toNonIndexed`, one flat colour per triangle, mixed ones
excluded and **counted in the report**, because a silent exclusion of a tenth of the subject is
the thing this file already has a section about.

The signal that separated instrument from build, both times, was that **every other slot read
exactly x1.000**. A contaminated mask does not produce six exact 1.000s and one outlier; a real
leak would move several. An instrument whose errors are localised is readable; one whose errors
are spread is not, which is why the per-slot table is printed in full rather than lumped.

### And a check that vanishes when the build is right

The worst-slot reduce was seeded `{ slot: null, r: 1 }`. Nothing beats that seed when every slot
reads exactly x1.000 — which is the correct build — so `worst.slot` stayed null, the separation
check was skipped by its own `!== null` guard, and the gate printed **11 checks where it has 12**.

A check that disappears on a pass is worse than one that fails, because the only thing a reader
has to notice it by is the count, and a count that moves with the result is not a count. It is
the mirror of this file's "a gate printed three FAIL lines and said PASS": there the listing and
the summary disagreed, here the summary quietly shrank. Both are caught by the same discipline —
**the number of checks is a property of the gate, not of the build** — and `car-pixel --selftest`
asserts `verdict(good).length === 12` for exactly that reason.

### The statistic is a ratio between two arms, per slot

Neither arm alone is a check, and this is the "a negative needs its positive" rule arriving for
the third time in this module's story. Near-black `instanceColor` must take the paint dark;
near-white must take it bright; and both must leave every other slot alone. A material that
ignores `instanceColor` entirely — the uniform forced to 0, or an injection that matched nothing —
**passes the near-black arm**, and the selftest has that as a row.

A ratio of the same pixels under two instance colours cancels the lighting, the exposure and the
camera, which is what lets a purpose-built page stand in for the district at all. The first
version instead asserted the max-over-median reading this file had sketched, and that reading was
dominated by a **specular highlight**: paint max 0.6766 against a lamp at 0.1401 with
`instanceColor` at 0.02, because the paint slot is metalness 0.60 and the lamps are not emissive
under this probe's lighting. A max is a statement about one pixel of one highlight. Per-slot
medians are a statement about the rule.

And **per slot rather than lumped**, because slot 1 is 827 px against 4,568 px of other non-paint
slots: a leak confined to the trim would be buried in a single pooled median, and the selftest
has that row too.

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

## An argument against a lever is not a price, and both of #106's candidates lost to the defect

#106 offered two ways to let a player hand a mission back and argued for one of them in prose:
"where you took it is not somewhere a player who wants out is standing". I added a third on the
same kind of argument — the GARAGE, because `mission-test` already gates it 24 m clear of every
mission zone and `composeGarage`'s "stop here" is the cue precedent the entry said the HUD lacked.
`tools/abort-cost.mjs` priced all of them in one unit, by DRIVING the shipped follower on the
shipped vehicle to each zone and stopping under `SCENE_STOP_MS`, which is the rule a pickup
already fires under — so the price includes the braking the player actually has to do:

    position in the job   back to own pickup   to the garage   wreck the car
    marlin-street  10%          8.0 s              13.3 s          13.4 s
                   50%         16.6                22.3            13.4
                  100%         43.1                37.9            13.4
    shakedown      10%          6.7                18.6            13.4
                   50%          4.2                26.9            13.4
                  100%         16.7                37.9            13.4

**A geometry lever is cheaper than wrecking your own car on 5 of 10 sampled positions and loses by
up to 24.5 s.** The wreck costs 13.4 s and is reachable from anywhere, so a lever that loses to it
does not remove the inversion it exists to remove. My own candidate was the worst of the three —
the garage wins 1 of 10, by 0.1 s, which is noise. A key is 0 s everywhere, and that is what chose
it.

**And the mechanism the entry said did not exist was already in the file.** It wrote "the HUD has
no precedent for a held-to-confirm input", which is true and was the wrong thing to look for:
`src/hud.js` has drawn a keyed `prompt` panel since it was written, documented as
`{key:'F', text:'ENTER VEHICLE'}`, fed exactly one string by the host. It is a SEPARATE band from
the objective and the subtitle, so the cue competes with neither the mission's objective nor the
stage's authored line — which a band tenant would have done, and "a live scene takes the objective
band" is a defect class this project has already removed. **Before deciding a feature needs a new
mechanism, grep the module for the one you are about to build.**

Two method notes, because the instrument was wrong twice before it was right:

- **"A real drive cannot beat a best-case one" is not a floor until you check it.** The first
  version integrated `pathSpeedLimit` in closed form and claimed exactly that. Against the shipped
  follower over the same eight routes it reads ABOVE a real drive on four of them and by up to 35%
  (x0.74, x0.86, x0.94, x0.95 against x1.02, x1.07, x1.12, x1.28). It is not a floor in either
  direction, it is a DIFFERENT QUANTITY — it accelerates from rest at `RESPONSE.accel` and caps at
  110 km/h where `followPath` caps at 22 m/s. The fix was to stop having two instruments: the
  follower and the vehicle are the game's own, so drive.
- **And its verdict could not fail.** It seeded the worst ratio at `Infinity` and printed "FLOOR
  HOLDS" when NOTHING ARRIVED — eight routes, eight timeouts at the cap, a reassuring answer on
  zero data. That is this file's "a check whose two sides are both zero is not a check" and
  `car-pixel`'s vanishing worst-slot check in one, and the fix is the same: count the arrivals and
  refuse a verdict without them.
- **A selftest's NAME can catch its own bound.** The braking check read "within the measured
  0.2 - 0.7 s band" while its bound said 2.0 and its measurement said 1.85 — the bound had been
  widened and the name left behind. The 0.2 s it named is `src/wanted.js`'s figure for how long a
  driver spends UNDER 1.0 m/s, which is not how long it takes to GET under it: this file's "quote
  the signal the code reads", arriving inside a check about braking. Derived off the car's own
  curve it is `(22 - 1) / 11.0` = 1.91 s against 1.85 measured.

### A guard justified as free, where the thing it leaned on runs once

Writing #106's rule I copied `pickupAt`'s discipline and made a non-finite speed THROW, with a
justification written into the comment: "`MissionRunner.update` already throws on a non-finite
snapshot `speed`, so a NaN that kills the page here would already have killed it there."

**The claim is false and the gate caught it on its first run.** That check sits behind
`if (!this._checkedSnapshot)` and runs on the FIRST FRAME ONLY. Measured: one `update` with
`speed: 5`, then the same snapshot with `speed: NaN`, does not throw. So the throw would have
added a new way for one bad physics frame to end the session — in a PRESENTATION path called every
frame of every running mission, for a value this file records as actually occurring
(`Math.hypot(NaN, NaN) || 1` sailing past a guard).

The split that holds is **by what can be TRANSIENT**, and it is worth keeping as a shape:

- a non-NUMBER argument is a WIRING error. It cannot come and go, it is caught on the first frame,
  and it is `pickupAt`'s case exactly. Throw.
- a number that is not finite is a PHYSICS value. Take the flattering fallback — here the abort is
  refused, so the player keeps a job they asked to drop — and SAY SO in the return so the host can
  count it. `stats.badScales` and `stats.bustNoWalk` are that shape, and `bustNoWalk` read 1 and
  was the whole diagnosis.
- a threshold like `stopMs` throws whatever it is, because nothing about it is transient and the
  obvious default is INVISIBLE: 1.0 is exactly the `SCENE_STOP_MS` both hosts pass, so an unwired
  host would behave identically and no gate anywhere could tell. "A guard whose default is the
  permissive case" with the permissive case being the CORRECT one, which is the shape that
  survives longest.

**And the gap the false claim exposed is now an instrument.** The throw's own message says a NaN
means "every distance trigger would never fire", which is as true on frame 2,000 as on frame 1 —
so `update` counts, per field, the frames a declared field arrived non-finite, and
`report().nonFinite` publishes it. A pure counter: no behaviour changes, because a throw on frame
2,000 would be this module's own clamp-dt argument upside down. A non-zero entry is the diagnosis
for a mission that dead-ended with every trigger reading false. The NaN is excluded from
`fieldRange` too, which would otherwise read min `-Infinity` for ever on exactly the run that
needs it.

**The counter only covers fields a TRIGGER declares, and the first version of its check broke the
wrong one.** It set `speed: NaN` on a rig whose only trigger is a `reach`, which needs `px`/`pz` —
so the counter correctly saw nothing, and the check crashed reading `fieldRange.speed[0]` of an
absent entry. That is this file's "a check's DETAIL string is evaluated eagerly" arriving in a
CONDITION instead, and the lesson is the same: read every number through an accessor. It is also
the right design, stated: a NaN in a field no predicate reads hides nothing.

### The verdict block is not the end of a gate file, and this time it ate 158 lines

This file already records the text-position version of `mission-test`'s snapshot defect — an arm
appended after the summary, "where its checks would have printed below `BOOT: PASS`". Appending
#106's arm to `tools/boot-check.mjs` was worse: `boot-check` ends with
`process.exit(fail ? 1 : 0)`, so **158 lines and twelve checks became unreachable code** and the
gate would have reported PASS at its previous count with nothing missing from its output.

`mission-test`'s version printed FAIL lines under its own PASS. This one prints nothing at all,
which is strictly harder to notice: the only evidence is a check COUNT that did not go up, and a
count is exactly what nobody reads. `grep -n 'process.exit' <gate>` before appending answers it in
one command, and the general rule stands restated — **the last ARM is the end of a gate file, not
the verdict.**

## A browser arm can read a field before its writer runs, and the tell is a right answer in a wrong wrapper

#106's arm read `abortReport().offer` as `null` and the prompt panel's `pv-on` as `false` while
the prompt's TEXT was already correct. Both of those are written by the HUD block, once per
rendered frame, and the arm read them after `startMission` without awaiting a frame — so it got
the state from a frame on which `abortOffer` had correctly returned null. The settle loop that
should have supplied one ran **0 iterations**, because the car was already stopped, and its own
line said so: "settled in 0 frames".

**The tell is the SHAPE of the wrongness.** A text that is right with a wrapper that is empty is
not a broken composer; it is two reads of different frames. One unconditional `await frame()`
after any state change, before reading anything the HUD writes.

And the same arm had three more of this file's own recorded defects, which is worth listing
because they arrived in one 150-line arm:

- **An object spread clobbered the measurement.** `{ ...cue(), ...d.abortReport() }` — both carry
  a `key`, and `abortReport()`'s is the KeyboardEvent code. The arm printed `"KeyQ"` and failed
  its own "the key is in its own box" check while the screen said `"Q"`. Namespace the two sources
  rather than merging them; a field of one silently shadowing a field of the other is not visible
  in the output.
- **An unguarded read in a CONDITION, not a detail string.** `hand.stopped.rep.offer.stopMs`
  threw and killed the gate after two of its twelve checks had printed. This file already records
  "a check's DETAIL string is evaluated eagerly"; the condition is the same hazard and the same
  fix — read every number through an accessor.
- **A clause that could not fail, in the FIRST check of the arm.** `!hand.carBefore.wrecked`,
  where `wreckReport()` publishes `wreckedNow`. `!undefined` is true for every build, and the
  printed detail said `wrecked undefined` in as many words. It was the check that exists to
  explain all the others when it fires.

### A band assertion needs the top of the band, or it needs the tenant

The same arm asserted the SCREEN after a successful abort and read **"BUSTED / released in 4 s"**
with 0 stars and heat 0.000. Both readings are correct: the abort worked (`outcome running ->
aborted`, `declined 0 -> 1`) and the page was carrying an earlier arm's four-second bust hold,
and `busted` is the TOP of `BAND_ORDER`.

This file already says "an arm that reads the band has to own the top of it". The half it was
missing is what to do when the arm CANNOT own the top — and this one cannot, because it is last
in a file whose earlier arms leave holds by design. **Publish the tenant's own output and assert
that.** `bandReport().endedLine` is the `ended` tenant exactly as `lastOfferLine` is the `offer`
tenant, and for the same stated reason. With it the check reads

    tenant {"objective":"MISSION ABORTED","subtitle":"Shakedown — you handed it back — …"}
    the screen said "BUSTED" / "released in 4 s" from "busted"

and both facts are in one line, which is strictly more than the screen could say.

## A field only ever ASSIGNED inside a branch holds the last value that branch produced

`lastOfferLine` is published for gates and was assigned only inside `if (!missionHud &&
!wreckLine)`. So while a mission ran it held whatever the last offer-less frame had composed: with
`shakedown` running and the car **0.34 m** from `marlin-street`'s pickup it read
`SHAKEDOWN / stop to start` — a job **332 m** away. Not player-visible, because the band is
`mission` then; entirely visible to any probe quoting it, which is the only reason the field
exists.

`null` is the honest value, because the pass did not run. **A stale reading is worse than a
missing one for the same reason `MissionRunner`'s surviving `mission` reference is**: a field that
outlives the thing it names reads as current, and this file already records a browser arm that
read that reference as "a mission is running" and reported a refused drive-by as having started
one. Second instance, same shape, different field. **When you publish a field for a gate, decide
what it says on the frames its writer does not run.**

## Patching one host and reading the other is how a divergence is found at all

Round 11's playtester read `district/main.js` and `tools/playtest.mjs` side by side and found
three places where a number from the harness is about a game the page is not running. Each is
this file's "a gate that reproduces the host rather than reading it cannot see the host being
wrong", and the first one retires earlier findings:

- **`look().blips` listed every job while a mission ran** and the page draws none —
  `updateOfferMarkers(!!missionHud)` empties `offerMarkers`. Measured mid-job: harness
  `["shakedown@43","garage@199","enemy@238","marlin-street@291"]` against page
  `ringsVisible 0 of 2`. So **any legibility claim made from `look().blips` during a mission is
  about a map that is not drawn**, and the blip the harness offered most loudly — the other job —
  is the one a player cannot see. The garage and the car survive, because the page posts those
  unconditionally.
- **The two offer gates differed on one case.** The page builds `wreckLine = mode === 'car' ?
  wreckState : null`; the harness gated on `!this.damage.wrecked` with no mode term. So ON FOOT
  during the four-second wreck hold the page runs the offer pass and node did not, and a pickup
  could fire on the page and not in the harness.

**And a filter added to match a host needs the check in both directions.** "No offer blips while
a mission runs" is satisfied by a filter that drops everything, so the gate asserts three things:
the offer blips GO, the garage SURVIVES, and they COME BACK when nothing is running.

## `_footPathClear` with no `clearAt` is 28 m straight through walls, and it reads as clear

Checking round 11's stalemate spot, my first probe built `PursuitUnits` directly and read the
officer's walk as clear on **1340 of 1340 spots**. The method opens `if (!this.clearAt) return
true`, and both shipped hosts assign it — `district/main.js`'s `wirePursuit` and
`tools/playtest.mjs`'s constructor, identically. This is this file's own `traffic-selftest` trap
("a gate that constructs the subject itself has to construct it the way the game does"), and the
cheap proof is the same one: with the predicate, **366 of 1309 in-reach spots (28.0%)** have a
blocked walk, which reproduces the 27% this file already records from the other direction.

**And the point the walk is tested FROM is not the network's best.** The hold tests the walk from
the UNIT's own stop point. At round 11's spot the network's best approach is 0.04 m with a clear
walk, and the unit's stop point is 24.8 m with a blocked one — so a probe that measures the
network's best answers a different question and exonerates the build. Both my probe and round 11's
guess made that substitution, in opposite directions.

    the NETWORK's best approach to (329.8, -92.2)   0.04 m, walk CLEAR, arrestSeconds 4.0
    seeds 0 and 11: the unit stops on edge 354     24.77 - 24.80 m, walk BLOCKED, held 0%
    seed 2:         a unit reaches edge 761        22.95 m, walk CLEAR, held true, BUST at 16 s

That is #108's recorded residual — "the router reaches a minimising edge 319 of 516; it never
does 197 of 516, 38%" — arriving **0.04 m from a road**, where nobody looked because #108's whole
frame was "a player far off a road cannot be arrested". **A residual measured in one regime is
not bounded in another.**

## `vehicle.speed` is three-dimensional, and two rules that say "planar" were reading it

`src/vehicle.js` has `get speed() { return this.velocity.length(); }`. `district/main.js`'s
`focusSpeedNow` returned that for the car and `Math.hypot(velocity.x, velocity.z)` for the player
on foot — two branches of one helper measuring different quantities — and `MissionBoard.pickupAt`
and `abortOffer` both document "the player's planar speed in m/s".

Measured rather than asserted, because "it includes the vertical" is not a magnitude. Worst
3D-minus-planar over 3 s of braking, and how many frames a planar-stopped car would be REFUSED on:

    placed at y=0.55, at rest (a teleport)   1.8199 m/s    12 of 360 frames   3.3%
    placed at y=0.55 with 2 m/s of planar    0.7395         3 of 348          0.9%
    settled, braking from 40 km/h            0.0002         0 of 244          0.0%
    settled, at rest (an ordinary park)      0.0000         0 of 360          0.0%

**So it never reached a player — 0 of 604 frames of ordinary driving and parking differ — and it
reached every browser arm that teleports, which is all of them.** "This is real and it does not
matter to the player" is the result; it costs instrument time rather than gameplay.

**And the instrument that found it then failed on it from the other side.** `boot-check`'s pickup
arm reported "braked to 1.261 m/s" and failed its own "the brake did it, not the frame budget"
check on a frame where the pickup had CORRECTLY fired — the planar speed was under 1.0 and 0.26 of
it was the suspension. The rule was right and the arm was quoting a different quantity. **An arm
has to read the signal the code reads**, which this file already says about a derivation and is
just as true of a check.

## When you hoist a local into a function, grep the identifier, not the declaration

Moving `focusSpeed` out of a block and into `focusSpeedNow()` left one of its two readers behind:
`stopped: focusSpeed < board.stopMs`, forty lines below the declaration that no longer existed.
`ReferenceError: focusSpeed is not defined`, three times, and **`check-syntax` cannot see it** —
a free variable parses perfectly. No offline gate loads `district/main.js`, so all nineteen stayed
green, and twelve of `boot-check`'s eighteen failures that run were cascade from the page throwing
in one branch.

That is commit `fab3e2d`'s story — the temporal dead zone that stopped the district rendering for
three commits — arriving through a different door, and `boot-check` is the gate that exists
because of it. It caught this **on line 4 of its first run**. The cheap habit is a grep for the
identifier before and after any hoist; the cheap verification is a free-variable check, which took
one line of node and would have found it without the browser.

## Four mutation rows went stale in one session, and `--selftest` is the only thing that says so

Running the full offline list at the end of this session found `mutation-sweep --selftest`
failing on **four of 158 rows finding no target**:

    bust-never    src/wanted.js    'if (this.bustFor < BUST_HOLD_S) return false;'
    hold-never    src/pursuit.js   the old single-clause admission
    hold-ratchet  src/pursuit.js   the same line
    hold-forever  src/pursuit.js   the same line

All four went stale **in this session's own earlier rounds**. #97's `holdSeconds` work replaced
`BUST_HOLD_S` with `this.bustNeeds` as the clock's bound; #108's fix replaced

    if (near.d <= this.reachRadius && (u.stopped || (wantT > near.t && u.t <= near.t))) {

with a three-clause admission carrying `_localBest` and the officer's walk. Neither commit was
wrong. Neither ran this selftest afterwards, and **a stale row is a defect nobody is testing
while the table still counts it** — the whole table reads as 158 rows of coverage.

It is the sibling of this file's own "a check that could only ever pass" family and it is worse in
one way: an unfailable CHECK at least runs, so a reader sees it in the listing. A stale ROW
produces no output at all until something asks, and the only thing that asks is a selftest nobody
is obliged to run.

**So: run `mutation-sweep --selftest` in the same commit as any change to a file the table
mutates.** It takes seconds, needs no browser, and is the only instrument that can see a row stop
matching. And repoint a stale row by its INTENT rather than its text — `hold-ratchet` means "drop
the `u.stopped ||` so the hold stops being sticky", which is a sentence that survives the
admission being rewritten, where the line it used to quote did not.

## A backlog heading that does not carry its status costs a round, and four of five were already fixed

Asked to keep going on the open issues, I picked the most alarming open heading — **#95, "4.8 km/h
of forward motion makes you permanently un-arrestable"** — read the entry, and started deriving a
fix. One `grep` for `_recedingFrom` stopped it: the fix had been in `src/wanted.js` for some time,
with the whole derivation in its comment, three speeds in `wanted-test`'s circling section and two
`mutation-sweep` rows (`bust-sign`, `bust-sign-default`). The ENTRY was stale, and a heading is all
a round reads before committing to a direction.

Auditing the rest of the open-looking headings against the source, **four of five were already
shipped**:

    #95   the bust reset needs moving AND RECEDING          gated, mutation-covered
    #99   a `status` tenant yields the headline             `status: true`, hud-cue's band ladder
    #101  a stage with a clock and no destination shows it  `unit: 's'`, mission-test §12, 2 rows
    #102  the fence line is signed on the nose              `noseOut ? 'reverse' : 'drive'`
    #105  the run-over charge is rare                       a priced refusal, re-argued
    #94   the chromatic third kept the pre-census band      a priced refusal, only the floor derivable
    #100  conscription + handing a job back                 fixed both halves, the second as #106
    #110  ambush's timeout is out of reach by parking        working as designed
    #111  seeking an arrest does not work                    working as designed

**And TWO of them changed meaning rather than status, because another entry's fix had landed
underneath them.** #110 reads as a trap only while `ambush`'s 240 s deadline is invisible — and
#101's fix put it on screen, which that entry was filed without checking ("LOSE THEM — 240 s",
walked through the real runner down to 60 s). #100's second half reads as open only until #106
shipped. **An entry can be stale about a NEIGHBOUR rather than about itself**, which is the whole
argument for auditing the list in one pass instead of the one heading you happened to pick up.

**This is the same shape as a stale `mutation-sweep` row and as `lastOfferLine` holding the last
value its branch produced**, both found earlier in the same session. A record that reads as open is
the same defect as a check that cannot fail: each presents as coverage of work that is not being
done, and each is silent until somebody asks. What differs is who pays — a stale row costs a defect
nobody tests, a stale entry costs a round re-deriving a fix that exists.

Two rules:

- **A heading carries its status**, so FIXED / MEASURED / REFUSED / A PRICED REFUSAL goes in the
  heading and not only in the body, and the original record is kept verbatim underneath rather than
  overwritten.
- **Grep for the fix's own symbol before starting.** One command, and it would have saved the first
  twenty minutes of this pass. A symbol being present is not a fix WORKING, so #95's entry is
  re-measured rather than asserted — the playtester's own circle protocol now arrests **3 of 3 at
  every speed from 2.8 to 19.9 km/h** where they measured 0 of 3 from 4.8 km/h up, with the drift
  column printed beside it to say the circle held rather than the car escaping.

### And the field the naming rule was written about still had the wrong name

This file's "a frame counter is not an event counter" section is about `stats.runOvers` reading
**3,684 over a 10 km drive against 0 charged run-overs**, and its rule is to "name such a field for
what it counts". Earlier in this same session I renamed three SIBLING counters — `pedHits`,
`carHits` and `policeHits` became `*HitFrames` — and left the original, in all three places it
lives:

    src/pedestrians.js    stats.runOvers       -> stats.runOverFrames
    district/main.js      dynStats.pedRunOvers -> dynStats.pedRunOverFrames
    tools/playtest.mjs    stats.runOvers       -> stats.runOverFrames

`runOver()` has no refractory of its own — it refuses below `PED_FREE_MS` and otherwise increments
on every call — so a host calling it once a frame while a casualty is under the wheels counts
frames, and all three hosts do. **Patching the siblings and leaving the original, on the very
lesson that records it.** `grep` for the field, not for the lesson: the complete reader list was
one `Grep` call (two gates, one selftest, four prose references) and renaming without it is how
`focusSpeed` broke the page earlier in this session.

Two of the selftest's own DETAIL strings also printed `${stats.runOverFrames} run-overs`, which is
the same defect in the output rather than in the field — a correct number under a wrong noun. They
read "contact frames" now.
