# Milestone 3 — where M1 and M2 stand, and what M3 builds

Written 2026-09-25, 381 commits after `MILESTONE-2.md`. Companion documents:
[`MILESTONE-1.md`](MILESTONE-1.md), [`MILESTONE-2.md`](MILESTONE-2.md),
[`MILESTONE-REVIEW.md`](MILESTONE-REVIEW.md), ledger [`PROGRESS.md`](PROGRESS.md).

---

## 1. M1 — shipped, and its own document carries the correction

Every acceptance line was met:

| Requirement | State |
|---|---|
| Materials wired into the streamed LOD | 18 materials, 20 textures / 34 array layers, 28.7 MB. One shared surface-array material covers every building via per-vertex `aLayer` + `color`, so the district's whole wall and roof variety costs the same single draw call per chunk that flat grey did. |
| Facade system wired into the streamed LOD | 7 recipes, near LOD only, grouped by recipe: a chunk costs *(recipes present) + 1* draw calls. |
| Budget thresholds re-derived and logged | Draw calls 260/400 → **200/320**, triangles 900k/1.8M → **400k/900k**. Both *tightened*. |
| Lit windows at night | Per-window lit/unlit/blinds with colour-temperature variation, emissive generated in the same pass as albedo. |
| Bloom + height fog | HDR half-float target, soft-knee bright pass, 4 separable blurs at half res, depth-based height fog, sun-direction inscatter, ACES, ordered dither. 6 passes. |

M1's own header records that the document overstated one thing: the numbers
reproduce to within 4% and only the **timing** metric was unstable. Beyond the
line it also landed the chase harness, sky and weather, on-foot mode, the loading
screen, zone ground surfaces and authored corridor massing.

## 2. M2 — shipped, and three of its claims were false until a reviewer round

Delivered: **traffic AI** — Intelligent Driver Model following (9.6% of car-frames
actively braking for a leader), one-vehicle-at-a-time junction reservation held
until the car is clear along its *new* edge (32.7% of car-frames queued),
dead-end routing that U-turns instead of despawning. Plus **signage** (217 signed
buildings, 888 tenancies, 1,390 shop signs, 859 street signs, +8 draw calls
district-wide) and the **HUD** (minimap on the real baked road graph, speedo,
gear, wanted stars, health, weapon slot, zero WebGL draw calls).

What `MILESTONE-REVIEW.md` had to correct, and it is the most useful thing in the
M2 record:

- The **overlap criterion was not met** when M2 claimed it. "14.6% at 30 cars,
  −59%" compared a *chase-harness* number against a *drive-through* baseline.
  Like-for-like the traffic AI measured **26.7% against the stub's 27.0%** —
  indistinguishable. It is met now, at **7.1% median over N=5, −74%**, but only
  after a junction reservation **leak** was found and fixed.
- **"Same-edge overlaps: 0 — eliminated" was refuted at 7.** The classifier tested
  `overlapNearJunction` first and only classified the single worst pair per frame,
  so a same-edge overlap within 13 m of a junction was silently rebucketed.
- The gate FAIL and a 64.3% overlap were blamed on junction capacity and HUD
  garbage. **Both diagnoses were wrong**; it was the leak.

The disproof was sitting in M2's own committed evidence — `junctionsHeld: 139`
against `alive: 59` — and nobody read it.

Audio (`src/audio.js`, 126 steady-state WebAudio nodes, 4-oscillator engine bank)
and the wanted system (`src/wanted.js`, 0–5 stars, 83 checks at 0.55 µs/update)
were built and verified at M2 but deliberately left unintegrated, as M3 systems.

## 3. What has actually happened since — and the part worth saying plainly

`MILESTONE-2.md` §7 named five things for M3. **Four are done. The fifth has not
been started.**

| M2's plan for M3 | State today |
|---|---|
| 1. Resolve the stall gate | **still WARN.** 10.5 ms against an 8 ms warn (16 fail). Attributed and structurally improved; the verdict is unresolved, and the metric is unusable while anything else runs on the box — the same code has read 7.1, 24.1, 7.9, 68.5 and 11.6 ms depending only on how many headless browsers were alive. |
| 2. Integrate audio and the wanted system | **done.** `WantedSystem` constructed at boot; the audio graph builds on first gesture and is reachable headlessly. |
| 3. Fix the three critic-confirmed geometry defects | **done** — 99 of 519 buildings faced the wrong street; the parapet sign panel rendered mirrored; and the kerb round then found three more, including **half the district's kerbs back-facing**, which no number had reported. |
| 4. AO / contact shadows | **done.** SSAO at full resolution, 0.6 m radius at exponent 8.5, plus an AO floor of 0.04; pedestrian grounding fixed (the cause was the radius, not the shadow path); the AO seam closed as a priced refusal rather than a fix. |
| 5. **Mission scripting + the Marlin Street mission** | **STARTED.** `src/mission.js` is the engine, `src/missions.js` authors Marlin Street on the district's own baked route, `tools/mission-test.mjs` is the gate (51 checks, 16 of them known-bad graphs) and `tools/mission-live.mjs` confirms the wiring reaches a real page (11 checks). See §5. |

Those 381 commits went almost entirely into **visual fidelity that was never on
the M3 line**: Main Street photographic reference matching, facades and implied
doors, trees, kerbs and gutter pans, sidewalk props, shopfront lighting, the sky's
anti-solar whitening, exposure-invariant metrics, and roughly ten measured rounds
on cars. That work is real, gated and documented. It is not M3.

### Gates today

| Gate | Result |
|---|---|
| `check-syntax` | PASS — 173 modules parse |
| `geom-audit` | PASS — every prop reaches its host surface; 157 doors / 450 sign awnings, agreeing with two independent censuses |
| `golden-trace` | PASS — 30 samples within ±0.25 m / ±0.5 km/h |
| `physics-test` | PASS — 10 checks |
| `leaf-mask` | PASS |
| `daynight-sweep` | PASS — photometry held, all four hours inside the plausible envelope |
| **`budget`** | **WARN.** triangles **852,605** against an 830,000 warn — over by 22,605 (2.7%); chunk stall **10.5 ms** against 8. Draw calls 241/275 PASS. Heap −22 MB PASS. |

The gate's own "headroom %" column reads 53.9% on triangles because it is measured
against the FAIL line, not the WARN line. The WARN is real: it was explained away
once as sampling noise and that was wrong — on a clean box the gate's p95 spread
is 934, which resolves a ~1,900-triangle change.

## 4. What M3 will build

M3 is the milestone that makes this a game rather than a city.

1. **Mission scripting, and the Marlin Street mission end to end.** A small
   declarative layer — objectives, triggers, world state, success and fail
   conditions, checkpoints — over the systems that already exist: `wanted.js` has
   the star escalation and last-known-position search, `pursuit.js` drives police
   units, `traffic.js` has junction reservations to yield into, and the HUD
   already renders objectives and prompts. This is the acceptance criterion and
   nothing else in this list substitutes for it.
2. **Close the two budget WARNs before the milestone ships.** Triangles are 22,605
   over and the growth is unaccounted; price it with the deterministic offline
   bill first (`tri-ledger`, `frontage-stats`, `tri-breakdown`) and run the gate
   three times on a clean box second. The stall needs the same clean-box N=5.
3. **The car line is CLOSED, at the level the architecture allows.** Three blind
   reviewers judged the closing pair and all three said **improved, not markedly** -
   the same verdict as the round before. The line stops here, and it stops with a
   number for what is missing rather than a shrug:

   - **The level is now right, checked against photographs for the first time.** A
     reviewer found six resolvable real cars in the repo's own reprojected Mapillary
     spheres. Before this round the windscreen sat at 0.0167 of its own paint, which
     is the level of *heavily privacy-tinted SUV glass*; windscreens are never
     privacy-tinted. Shipped it sits at 0.0619, between clear side glass (0.0298) and
     a clear rear screen with a lit cabin (0.11-0.13). `docs/measurements/car-glass-photo-anchor.json`.
   - **The content is not, and the gap is measured.** After removing a fitted
     quadratic, every render pane sits at the level of *smooth painted sheet metal in
     its own frame* (0.41-1.61 q-steps against the bonnet's 0.26). Real car glass
     clears that floor by 4-10x (2.74-4.04 q) and its residual contains headrests,
     parcel shelves and heated-rear-screen elements; the render's contains ordered
     dither. `docs/measurements/car-glass-content-anchor.json`.
   - **No gain can close that**, because `scene.environment` is
     `pmrem.fromEquirectangular(this.lut.texture)` - the sky LUT alone, no buildings,
     no street, no cars. The next lever is a reflection probe, and it is a different
     order of cost from everything shipped so far.
   - **Night is untouched and cannot be fixed this way.** The pane goes 0.0037 ->
     0.0103 of its paint; both are a hole, `skyLux` is 0.15, and every night number
     sits at encoded bytes 5-7. Issue #54 stays open.
   - **One cost, stated.** The gain makes the noon pane bluer (linear B/R 4.31 ->
     5.38) because what it amplifies is bluer than what the pane was. Issue #36 now
     has a number: the pane reads 5.38 against the bluest *measurable* sky at 3.09.

4. **The remaining open visual items, in priority order**: glass reads blue at
   noon (#36), the traffic-car greenhouse at night (#54), `aoKernel` 3 parked for
   a reviewer (#48), and shell variety past the three that shipped (#56).

**Recommendation.** Stop the visual rounds after the glazing one and spend the
next block on item 1. M3's acceptance is gameplay, and there is currently none of
it; every round spent on a 40-pixel car is a round not spent on the thing the
milestone is named for.

---

## 5. Mission scripting, as it now stands

**The engine.** `src/mission.js` is pure state in the `wanted.js` idiom: no THREE, no
DOM, no `Math.random`, a fixed-dt `update()` over plain numbers, and side effects
declared as data (`onEnter: { setWanted: 2, stinger: 'chase' }`) emitted as intents
for `district/main.js` to execute. 13 trigger kinds including `all`/`any` composites
that nest. `hud()` returns `src/hud.js`'s own field names — `objective`, `subtitle`
and `waypoint` had existed since the HUD was written and were never fed.

**Three guards against the quiet failure**, which is the only kind that matters in a
branching layer:

1. `defineMission()` refuses, at load, a `goto` naming no stage, a stage nothing can
   reach, a stage nothing can leave, a mission with no path to `passed`, duplicate
   ids, a composite whose sub-trigger carries an edge, and a typo four levels deep.
   It reports every fault in one pass.
2. A trigger reading an absent snapshot field is **false forever**, so every trigger
   declares what it reads and the runner checks the first snapshot against the union
   and throws with the missing names.
3. `report().constantFields` names numeric fields that never varied. `health` is a
   stub in this build — nothing accumulates damage — so every `healthBelow` trigger
   is **inert**, and the audit says so rather than the mission looking generous.

**The gate.** 51 offline checks, of which 16 are known-bad graphs the validator must
refuse; `update()` costs 0.653 µs, 0.0038% of a 60 fps frame. Coverage is the headline
assertion: four scripted paths must between them enter every authored stage.

    clean        -> passed at  20.1s   toCar > eastbound > ambush > drop
    interrupted  -> passed at  33.8s   toCar > eastbound > backToCar > ambush > drop
    hot          -> passed at 241.1s   toCar > eastbound > ambush > dropHot
    wrecked      -> failed at   1.1s   toCar > eastbound > ambush

**The live wiring**, 11 checks, because the offline gate says nothing about whether
`main.js` ticks the runner: the frame loop ticks it (elapsed 0.983 s), the snapshot
carries every field, the HUD receives `DRIVE TO THE BAYFRONT MARKER @ (-328, 63)`, the
markers complete the mission, and **an `onEnter` intent reaches the wanted system in
the live game** — `stage ambush, stars 2`. No page errors.

**What the round found in its own design.** `ambush` declares `setWanted: 2` and waits
for `evaded`; the runner was emitting the intent and then evaluating `evaded` in the
*same* update against a snapshot still reading zero stars, so the chase was skipped
and the mission slid ambush→drop on one frame. The coverage walk caught it as
"clean → passed at t=1.1s". An intent now ends the transition chain for that frame,
which is general rather than specific to that mission.

## 6. Damage, and the collision that had to exist first

**There was no body collision anywhere in the project.** The car drove through
buildings. `src/vehicle.js` casts four wheel rays at the ground and nothing else, and
`main.js`'s own comment said "the collision body ... is `src/vehicle.js`'s alone" — there
was no collision body. A damage model with no impacts is a number that never changes, so
this round is three modules and four gates.

**`src/damage.js`** — impacts in, health and degradation out, pure state in the
`wanted.js` idiom. The input is **delta-v along the contact normal, not speed**, and that
one decision is the module: 60 km/h along a wall at 5 degrees of incidence is 1.45 m/s of
normal delta-v, the same car square-on is 16.7, and a model fed `speed` cannot tell a
scuff from a write-off. The thresholds are anchored to published crash tests:

| | | | |
|---|---|---|---|
| 2.2 m/s | 8 km/h | FMVSS Part 581 bumper standard | severity 0 |
| 4.17 | 15 km/h | IIHS low-speed series | 0.067 |
| 13.9 | 50 km/h | NCAP full-frontal rigid barrier | 1.000 |

Severity goes as delta-v **squared**, because crush energy does — which is what makes the
middle anchor a *prediction* rather than a third knob. The model puts 15 km/h at 0.0666
against a reference that says cosmetic-to-moderate. A linear-in-delta-v model with the
same endpoints says 0.167, two and a half times as much, and would make city driving feel
made of glass. The mass ratio then falls out for free: an 80 kg pedestrian changes a
1400 kg car's velocity by 5.4%, so there is no pedestrian special case, and a head-on
between equals at 100 km/h closing **is** the 50 km/h barrier test, to 0.08%.

Degradation is directional on purpose. Engine power comes off FRONT damage, not overall
health, so a car reversed into things four times still pulls — the gate measures the
counterfactual at 0.845 to make that concrete. Steering pull comes off the left/right
asymmetry, capped at a quarter of the steering authority. Fire latches at 12% health and
drains it: 2.05 s of "get out now".

**`src/blockers.js`** — 3,950 wall segments in a uniform grid, which are the *build's*
own edges. `facades.js`'s `minLen` filter and its winding-derived outward normal, with
the gate importing the real `edgesOf` and comparing building by building, edge by edge,
normal by normal: 3950 = 3950, zero endpoint disagreements, zero normal disagreements,
`ringArea` bit-identical over all 523 rings.

Why segments and not the bounding boxes `main.js` had been using on foot since collision
existed — the area inside some footprint's box and outside every polygon is **142,932 m²**,
30.9% of all box area, 21,588 m² of it on the carriageway. Sampled every 2 m along every
road centreline, a car-sized circle cannot fit at **64 of 24,517** points with the real
segments and **1,806** with the boxes. The box hangs 28 times as much invisible wall
across the streets.

**Five collider samples, because two leaves a 950 mm hole in the middle of the car.**
"A circle at each end" is the obvious choice and it is catastrophic: with the end circles
reaching the nose and tail, the deepest point between them is 0.95 m from the axis — the
whole half-width — and a wall is a line with no thickness. Worst side notch by count:
n=2 950 mm, n=3 213, n=4 88, **n=5 49**, n=7 21. The nose corners sit 0.394 m outside the
collider, which is stated rather than discovered later: it is a rounded car.

**The result.** Incidence sweep at 60 km/h, charged delta-v against the analytic
prediction `speed·sin(incidence)·(1+e)`:

     incidence  contacts   charged dv  predicted    health  applied  below-thresh
        3°         1533     1.000 m/s   1.003 m/s   1.0000       0          1533
        6°         1948     2.000       2.003       1.0000       0          1948
       10°         2112     3.327       3.328       0.9669       1          2111
       15°         2191     4.962       4.961       0.8950       1          2188
       25°         2241     8.106       8.100       0.6445       2          2238
       40°         1816    12.309      12.320       0.1966       3          1813
       90°            1    19.156      19.167       0.0000       1             0

Three decimal places at every angle. A 6-degree scrape holding against the wall for 1,948
consecutive contact steps costs nothing and leaves the car doing 60.0 km/h; any *one* of
those steps charged on speed writes the car off.

**What the gates caught**, because all four were worth their runtime:

- **The resolver never terminated.** Pushing a circle to exactly `r` from a wall leaves it
  a few times 1e-17 short of clear in floating point, so the next pass finds a 1e-17
  penetration and pushes by 1e-17 — 37 real road contacts burning all 32 iterations of a
  raised budget with the depth unchanged after the first, and a non-null contact returned
  for a 0.0000 m correction, which would have charged an impact every frame for a car
  parked next to a wall. A 1 µm epsilon takes the worst count to 1.
- **The contact offset was the sample centre, not the circle surface.** The samples lie on
  the body axis, so every lever arm had zero lateral component: every crash in the
  district was filed as pure front or pure rear, `steerPull` could never leave zero, and a
  40 km/h clip at 17 degrees imparted 0.0016 rad/s of yaw instead of 0.883. The position
  was correct throughout, which is why nothing else could see it.
- **The speed handed to the damage model was the post-collision speed.** A 15 km/h wall
  hit reported 2.3 km/h. `damage.js` reads that field only for the pedestrian fatality
  line, so it would have quietly moved a published 45 km/h threshold to near 250.
- **`MissionRunner.report()` threw on a runner that had never started a mission** —
  `_range` was created in `start()` and read in `report()`. That is `main.js`'s state from
  page load; 51 offline checks passed for three rounds without ever asking a fresh runner
  what it was doing.
- **A check whose two sides are both zero is not a check.** The speed sweep launched every
  arm from 160 m back for 1,400 steps; at 10 km/h that covers 32 m, so four of five arms
  never touched the wall, read 0.000 charged delta-v, predicted 0.000 damage, agreed, and
  passed. Every arm now asserts that the thing it measures happened.

**The live wiring**, because none of the above says `main.js` uses any of it:

    index live in the page              3,950 segments, 523 buildings
    mission snapshot health             1 -> 0.5381 after a 30 km/h charge
    runner constantFields               [] — `health` is no longer inert
    an impact becomes a crime           heat 0 -> 0.3, propertyDamage; first
                                        reportCrime call this project has made
    a 4 km/h nudge                      not a crime, heat stays 0
    HUD health bar                      disp.health 1.0000 -> 0.0000
    HUD damage overlay                  disp.damage 0.0000 -> 1.0000
    a real drive into a real building   112 s of wall clock, 1 contact,
                                        charged dv 16.331407347186495 m/s at
                                        localZ 2.1499 (the nose, which is
                                        BODY_SAMPLES[4] + BODY_RADIUS exactly),
                                        regions front 1.0, health -> 0
    the same drive, run twice           charged dv identical to the last digit
    a pedestrian struck at 60 km/h      3 hits, health 1 -> 1, heat 0 -> 2,
                                        stars 2 — a two-star crime that does
                                        not dent the car, which is the mass
                                        ratio and not a special case

**Cost.** `step()` is 2.49 µs with collision off, 2.14 µs on open road — the early-out is
one grid lookup, so it is not measurably dearer than off — and 8.76 µs while in contact,
0.105% of wall clock at 120 Hz. `damage.update()` is 20 ns.

**What this does NOT do, stated plainly.** The traffic car is not displaced and the
pedestrian is not knocked down: `src/traffic.js` runs its fleet on the road graph and
`src/pedestrians.js` runs its crowd on the pavement graph, and neither has a notion of
being hit. So the player's car takes the damage, the crime is reported, the player is
pushed off — and the other party drives or walks on. That is visibly wrong and it is a
separate round in two other owners' files. `src/audio.js` has no crash voice; the impacts
that would have played one are counted in `damageReport().impactSoundsWanted` rather than
silently skipped. There is no visible deformation and no player-body damage model.

### Gates after this round

| Gate | Result |
|---|---|
| `damage-test` | PASS — 101 checks, of which 20 are known-bad input |
| `blocker-test` | PASS — 46 checks |
| `crash-test` | PASS — 76 checks |
| `damage-live` | PASS — 26 checks in a live page, no page errors |
| `wanted-test` | PASS — 97 checks |
| `sim-determinism` | PASS |
| `traffic-selftest` | PASS — 22 checks |
| `mission-test` | PASS — 55 checks |
| `golden-trace` | PASS — 30 samples, and the crash gate asserts bit-identity with collision off |
| `physics-test` | PASS — 10 checks |
| `check-syntax` | PASS — 183 modules |

**Next, in order.** Traffic and pedestrian reaction — the other half of every collision,
and it lives in two other owners' files. Then a crash voice in `audio.js`, then more
missions, which are now data rather than code. The two budget WARNs still stand between
this and a shippable milestone.
