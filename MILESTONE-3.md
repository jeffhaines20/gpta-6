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

## 7. Driving: a road router and a finished path follower

**The budget gate's autopilot drove through a third of the city.** `drive-through` steers in a
straight line at route waypoints 75 to 512 m apart, and against the wall index **829 m of that
2,528 m course is inside a building — 32.8%**, with individual legs at 59%, 50% and 47%. Free
until §6 made walls solid; after it, the car is wrecked 10.6 s in at 89 km/h and 55° of
incidence and the drive's own stuck-nudge teleports it round the rest of the route once every
2.65 s. The gate would still print numbers, about a different traversal than every committed
baseline. `__district.setBodyCollision(false)` and the gate says so in its output.

**`src/roadpath.js`** is the fix: Dijkstra on the graph `traffic.js` already walks, with the
same one-way rule, resampled and followed by pure pursuit. The finished course is 3,272 m
against 2,528 m of straight line — a 1.29× detour — with **0 of 818 points blocked**, for a
0.95 m circle *and* for the full car body oriented along the path, and clearance to the nearest
wall of min 1.92 m / median 11.23 m.

**Seven roads are drawn inside buildings.** 14 of 935 edges carry a car-sized obstruction on
their own centreline and 7 have their centreline *inside* a footprint — all 2.8 m `service`
alleys, the worst 36 m long with 23 of its 24 samples inside. The router excludes 11 of them:
1.2% of the network, 317 m, nothing that looks like a street. A follower cannot steer out of a
road that is inside a building.

**The cornering model is measured, not derived, and the first one was wrong by 1.75×.** Taking
`grip` and `gravity` out of `vehicle.js`'s friction circle and Ackermann bicycle geometry out of
a textbook gives a lateral ceiling of 22.54 m/s² and a 4.3 m minimum radius. Measured by
holding a steer input and a speed until the radius settles: **16.2 m/s² and 10.6 m**, growing
to 14.7 m at 80 km/h. A safety factor of 0.55 masked half of it — 0.55 × 22.54 = 12.40, just
under the real 16.2, so the *speed* ceilings were roughly right by accident. The steering
figure was not masked, and it was the one that mattered.

The response turned out to be exactly linear, which is what makes the measurement a model
rather than a table: radius × steer is constant at a given speed to within 2%, so

    R_min(v) = 8.446 + 0.2826 · v        metres, v in m/s

fits to **0.1%** at every speed from 20 to 80 km/h, and `steer = R_min(v)/R` is the exact
inversion of the car's own steady-state response. `roadpath-test` re-measures all four
constants against `vehicle.js` and fails if the car changes under them.

**The drive:**

| | before | after |
|---|---|---|
| circuits | 2/3 | **3/3 in 793.5 s**, mean 44.5 km/h |
| health | 0.000 | **1.000** |
| applied impacts | 5 | **0** |
| stuck-nudges | 112 | **0** |
| body contacts | 1,654 | 264 |
| worst off the line | 26.79 m | **9.79 m** |
| worst charged delta-v | 30.93 m/s | **1.425 m/s** |

All 264 contacts are at one corner — path indices 561–563, where the course turns at 8.3 m of
radius and the car's minimum at that speed is 8.9 m. It scrapes for 0.73 s a lap at a worst
charged delta-v of 1.425 m/s, under `damage.js`'s 2.2 m/s free band, so it costs nothing and no
controller can fix it: `R_min` at a standstill is 8.446 m.

**Nine bugs, four in the course and five in the controller**, each of which produced a
controller reporting everything nominal. CLAUDE.md has all nine; the shape they share is that
the instrument reads nominal because it is computed from the same wrong quantity the controller
is acting on. The two most expensive: a windowed *global* nearest-point search teleports the
progress index 184 m wherever a route passes near itself (heading error 0.00 → 1.543 rad at
77 km/h), and pure pursuit's `2·sin(α)/d` is zero at 180° as well as at 0°, so a course that
doubled back left the car driving away in a straight line for four hundred seconds with its
error reading −3.14 throughout.

**The HUD route line now has a source**, which is the fourth and last of `hud.js`'s unfed
fields — `objective`, `subtitle` and `waypoint` were the other three, and this one needed a
router to exist first, because a line to a marker is only useful if it follows the streets.

### Gates after this round

| Gate | Result |
|---|---|
| `roadpath-test` | PASS — 75 checks, 9 of them known-bad input |
| `route-drive` | PASS — 19 checks, three arms (roads, straight, straight + no walls) |
| `damage-test` | PASS — 101 checks |
| `blocker-test` | PASS — 46 checks |
| `crash-test` | PASS — 76 checks |
| `damage-live` | PASS — live wiring, no page errors |
| `mission-test` | PASS — 55 checks |
| `wanted-test` | PASS — 97 checks |
| `golden-trace` / `physics-test` / `sim-determinism` / `traffic-selftest` | PASS |
| `check-syntax` | PASS — 186 modules |

**Next, in order.** Traffic and pedestrian reaction — the other half of every collision, and it
lives in two other owners' files. Then a crash voice in `audio.js`. Then more missions, which
are now data rather than code, and can use the router for turn-by-turn directions. The budget
gate can take the road course with `DRIVE_COURSE=roads` when someone is ready to re-baseline
it; until then the two WARNs stand between this and a shippable milestone.

## 8. The other party reacts

§6 shipped a collision that charged the player and left everyone else alone, and said so in the
source: *"the player's car takes the damage, the crime is reported, the player is pushed off —
and the other party drives or walks on."* The live measurement of that state is three
pedestrians struck at 60 km/h, health 1 → 1, two stars, and three people who kept walking. This
round is the half that was missing, in the two modules that own the crowd and the fleet.

**A struck pedestrian is thrown the distance accident reconstruction says**, not a distance
chosen by feel. `d = v² / (2 μ g)` with μ 0.66 for a clothed body on asphalt:

| speed | model | published |
|---|---|---|
| 30 km/h | 5.36 m | ~5 m (−7%) |
| 40 km/h | 9.53 m | ~10 m (−5%) |
| 50 km/h | 14.90 m | ~15 m (−1%) |

The linear rule of thumb people quote — a quarter to a third of the speed in km/h — agrees over
roughly 30–60 km/h and diverges at both ends, so a "2 m per 10 km/h" version of this is 20% out
at 30 and 33% out at 50. The data points are the anchor; the rule of thumb is not a second one.

**The throw distance was a function of the frame rate, which is the kind of defect a harness
hides.** The slide was first integrated with a plain Euler step, which carries the whole step at
the entry speed: 1.0% long at 60 Hz, 9.9% at 6 Hz, **65.2% at 1 Hz** — and headless capture here
runs under one frame a second, with dt clamped to 0.05 s. Every live capture of a knockdown, and
every frame hitch in the game, threw the body further than the model. Constant deceleration has
a closed form, so the step is now integrated exactly and sub-stepped at 0.3 m (a third of a body,
so the wall test cannot jump a shopfront): **9.534 m at every step size from 1/120 s to 1 s.**

**The fatality line is the crime line.** `damage.js`'s pedestrian threshold, 12.5 m/s = 45 km/h,
is the 50% point of the published speed-versus-fatality curve, and it is the same number that
decides `pedestrianHit` against `pedestrianKilled`. 44 km/h is a casualty who gets up at 4.4 s;
46 km/h is one who does not, and is cleared at 12 s.

**A rammed traffic car is knocked off its lane, spun out of line and stopped** — a 2.84 m push
and 0.48 rad of yaw at dv 8, unwinding over 2.2 s once it can pull away, driving on at 9.2 m/s
after 12 s. Two ways that goes wrong, both found by measurement:

- **A shunt applied at the matrix would move the drawn car and not the published one**, which is
  the phantom-bounding-box defect in motion: `district/main.js` reads the published positions for
  collision. The offset is applied *before* publication, and the live gate reads the instance
  matrix back and asserts the two agree to 1 mm.
- **A shunt can knock a car into a shopfront.** At the 4.5 m cap in 16 directions over three
  fleets, 11 of 1,440 placements (0.8%) landed inside a building, the worst 2.15 m in — 0 of 30
  at the dv the collision pass usually produces, so only the cap does it, and the cap is a
  72 km/h ram, which is the one crash a player walks back to look at. The offset is now fitted to
  what is clear at the publish site: 0 of 1,440, with exactly 11 offsets shortened.

**And a shunted car must not read as gridlocked** — which turned out to be half right, and the
half that was wrong cost more than the half that was right. `traffic.js` deletes a car immobile
past a 20 s limit while holding a junction. A single ram stops a car for at most 5 s, so it
cannot trip that rule by itself: "it would have despawned every rammed car" was not reachable,
and the section of the gate that claimed to prove it never entered the state it named. What the
exemption actually protects is a car that was ALREADY near the limit when it was hit.

And the exemption was unbounded. `stopS` is a max rather than an accumulator, so a blind review
pinned a car indefinitely with 215 nudges of `dv 1.01` over 300 s — and the rule then deleted the
innocent cars queued behind it instead: **9 gridlock deletions in a 240 s run against 0 in the
control, none of them the pinned car.** The module's own derivation ends "no car is stationary
longer than `stuckLimitS`", and the shunt was the first mechanism that could make that false; it
was loosened without being restated, which is the thing this repo has a rule about. The exemption
now expires after 10 s of accumulated shunt-stopped time — two full-length stops, the longest a
single collision can honestly justify — and a ram FREEZES the stuck counter rather than zeroing
it, because zeroing also forgave a car that was genuinely gridlocked before it was hit.

**A police car still does not react**, and that is counted rather than hidden: `src/pursuit.js`
holds its units as an edge parameter and an instance matrix with no per-unit state to shunt, so
`damageReport().dynamic.policeHits` records the hits and nothing moves.

**A casualty does not blink out in front of the camera.** A fatal body is cleared after 12 s,
which is right when nobody is watching and wrong when somebody is: the crowd is one
`InstancedMesh` with no per-instance opacity, so there is no fade available and the removal is a
body vanishing mid-shot. It now clears at 12 s only from beyond 35 m, with a 45 s hard cap so a
player parked on top of a casualty cannot hold that slot for ever. Measured: in shot, not cleared
within 20 s and freed by the cap at 45.0 s; from 200 m away, cleared at 12.0 s.

**The reaction is posed through one write, and the live gate checks it with a control.** Every
matrix a pedestrian pose produces goes through `_put()`, which premultiplies the fall transform
when there is one — so the knockdown needed no changes in the ten places a body is written, and
a pose added later cannot forget it. The live gate reads the instance matrices back out of the
page: torso tilt 0.0° → 90.0°, head Y 1.29 m → −0.05 m, and **0 of the other 63 bodies tipped**,
which is the control that says the transform is per-instance and not on the mesh.

It also caught something I had wrong. The drawn torso moved 20.62 m against a 21.45 m slide, and
I read the 0.83 m as an error before working out that it is the body rotating: the slide is the
ROOT's travel, and a body that has gone over lies with its torso centre about its own standing
height *behind* the root. That direction is a claim worth asserting rather than tolerating — a car
strikes a pedestrian below the centre of mass, the legs are accelerated forward, the upper body
lags, and the head trails. So the gate now asserts the shortfall is 0.4–1.4 m and that the torso's
up axis points against the direction of travel (measured −1.000): a fall composed the other way
would read 22.3 m and, in a screenshot, look like the body had been tipped over forwards.

**Priced — and the price was wrong twice before it was right.** The honest answer is that the
casualty cost is BELOW THE RESOLUTION of this measurement. The first version timed the quiet
crowd once, last, and read −0.5, 12.5 and 42.1 µs over three runs; a negative cost is not a cost.
I diagnosed ordering, ran the quiet arm twice back to back, got a consistent 35–73 µs, and wrote
"about 1.5–3 µs each" here. A blind review then interleaved the arms properly — six alternating
repetitions, both equally warm, minima compared — and got −14.3, +6.0 and −10.6 µs. The 35–73 was
still the ordering: the casualty arm ran first and warmed the paths, and comparing it against the
MINIMUM of two later quiet runs biases the difference high by construction. Its own runs of the
shipped gate spanned 19.6 to 187.8 µs and failed the 100 µs bound in 2 of 11.

The gate now interleaves, prints each arm's spread beside the difference, and asserts only a
per-frame ceiling with a 13× margin. Five consecutive clean-box runs give differences of +1.0,
−33.1, −4.2, −20.2 and −10.5 µs against spreads of 29–163: the cost is real in principle and this
instrument cannot see it, which is the result.

The shunt's building fit is one `clearAt` per shunted car per frame at 212.8 ns, up to five when
the destination is blocked: 10.6 µs a frame with ten cars shunted at once and every one of them
blocked, 0.064% of the frame.

**Two bugs the gates caught in their own harness**, both the shape CLAUDE.md keeps recording.
`reaction-test` §2 first measured straight-line displacement rather than the slide: at 15 km/h it
read 4.55 m for a 1.34 m slide and at 50 km/h 11.26 m for a 14.90 m slide, because the casualty
got up at 4.4 s and walked — both directions of error at once, from one wrong quantity. And §8
priced casualties on a crowd where all 24 had recovered before the timing loop started, reporting
"crowd of 96 with 0 down": a cost measured on a population of zero.

**And two tools had been broken for longer than this round.** `ped-audit` threw
`Cannot read properties of null` on every run since `0687a53` removed the contact-blob mesh: its
per-mesh loop nulls a mesh the build does not have, with a comment saying exactly why, and twelve
lines later it summed `m.crowdTris` over those nulls. A guard on the producer is not a guard on the
consumer, and nothing noticed for a session of rounds because nobody ran the gate whose subject had
not changed. Its determinant census then turned out to read the FAR crowd meshes only — a ped in
the near pool is written to `nearTorsos`/`nearHeads`/`nearLimbs` with the far slot hidden, so the
headline subject, the close-up ped 2.8 m from the lens, reported `torsoDet` 0, `headDet` 0 and eight
`limbDets` of 0, and a check for a NEGATIVE determinant passed on ten zeros. It now reads the tier
that draws each ped (`torsoDet` 1.602, `headDet` 1.241, eight non-zero limbs) and reports
`zeroDeterminants` beside the negative count, because a tier that stopped being written would
otherwise read as clean.

### Gates after this round

| Gate | Result |
|---|---|
| `reaction-test` (new) | PASS — 65 checks, 6 of them known-bad input |
| `damage-live` | PASS — 67 checks, including the instance matrices of a thrown body |
| `ped-audit` | PASS — ran at all for the first time since `0687a53` |
| `damage-test` | PASS — 101 checks |
| `blocker-test` | PASS — 46 checks |
| `crash-test` | PASS — 76 checks |
| `roadpath-test` | PASS — 75 checks |
| `route-drive` | PASS — 19 checks |
| `mission-test` | PASS — 55 checks |
| `wanted-test` | PASS — 97 checks |
| `traffic-selftest` | PASS — 22 checks |
| `geom-audit` / `golden-trace` / `physics-test` / `leaf-mask` / `sim-determinism` | PASS |
| `check-syntax` | PASS — 187 modules |

**Next, in order.** A crash voice in `audio.js`, which is the last unfed hook in a shipped module
and is already counted (`damageReport().impactSoundsWanted`). Then police cars, which need
`pursuit.js` to hold per-unit state before they can be shunted. Then more missions, which are data
rather than code now. The budget gate can take the road course with `DRIVE_COURSE=roads` when
someone re-baselines it; until then the triangle and chunk-stall WARNs stand between this and a
shippable milestone.

## 9. Three blind reviewers took section 8 apart

The reaction round shipped with 65 passing checks, a live gate, and five frames. Three
independent reviewers — one on the physics, one mutating the modules to see which checks had
teeth, one on integration and edge cases — returned about forty findings between them. Almost
everything below is a correction to something section 8 asserts.

**The fatality threshold was the wrong number, and its own citation refuted it.** `damage.js`
said "roughly 10% at 30 km/h, 50% at 45 km/h, 90% at 80 km/h (Ashton & Mackay; Rosen & Sander)"
and put the line at 45 km/h. Rosén & Sander (2009) fit

    P(fatal) = 1 / (1 + exp(6.9 - 0.090 v))        v in km/h

to 490 weighted GIDAS cases, which gives **1.5% at 30, 5.5% at 45, 8.3% at 50, 57% at 80, and
50% at 76.7 km/h** — the comment's figures are 6.8×, 9.1× and 1.6× that curve. The 10/50/90 shape
is the older Ashton-family estimate, and Rosén, Stigson & Sander's 2011 review — the same
authors, co-cited in the same line — exists to correct it: studies biased toward severe
accidents, "Ashton (1980) among them", gave 35–90% at 50 km/h and "the data bias inevitably
rendered these risk estimates too high". The gate could not see any of this, because what it
asserted was that `pedestrians.js` and `damage.js` agreed on the number.

So the curve is now the model. `pedestrians.js` draws against it with a hash of the pedestrian's
id and the impact speed — deterministic, order-independent, and drawing nothing from the shared
random stream, so the reason first given for preferring a threshold ("a dice roll would make
every capture different") does not apply. Over 4,000 bodies the outcome tracks the published
curve to 0.6 points. The gameplay follows the evidence: at 50 km/h eight people in a hundred die
where before everyone did, and the crime `main.js` files now follows what happened to the body
rather than being recomputed from the speed.

**Twelve of twenty-seven mutations passed the gate.** The reviewer who ran them copied the
modules, broke them one way at a time, and ran the shipped gate against each. The catalogue is in
CLAUDE.md; the shape is that the gate read the module's own bookkeeping (`down.travelled`) rather
than where the body was, and could not see the render at all. Both modules build their
InstancedMeshes against a `{ add() {} }` scene, so the browser gate's pose assertions moved
offline for **295 ms** against twelve minutes. All twelve now fail their mutation, and the gate
has gone from 65 checks to 112.

**Nine defects in the module, in order of how much they cost.**

| | found | fixed |
|---|---|---|
| The gridlock exemption was unbounded | 215 nudges pinned a car for ever; 9 innocent cars deleted in 240 s against 0 in the control | expires at 10 s of shunt-stopped time; a ram freezes the stuck counter instead of zeroing it |
| A NaN direction was accepted | car drawn at (NaN, NaN), never despawns (`NaN > radius` is false), never recovers | both `hit()`s guard the direction, not just the magnitude |
| A zero direction made the fall the identity | casualty stands bolt upright for 45 s while `isDown()` says otherwise | same guard |
| The shunt cap was per-axis | two orthogonal rams reach 6.364 m against a documented 4.5 | the cap is on the offset vector |
| The spin had no sign | every car span the same way whichever side it was hit; a head-on ram span it as hard as a t-bone | signed by the cross product of heading and blow, scaled by the lateral share |
| The shunt was a teleport | 2.84 m in one 1/60 s frame, an implied 170 m/s, under a comment saying it "slides" | walked out at the same deceleration, exactly integrated |
| Shunts pushed cars into each other | mid-block overlap is impossible in this fleet (0 pair-frames); one ram every 2 s made 11, two made 338, closest pair 0.62 m | the fit tests other cars as well as buildings |
| A body was exempt from the despawn radius | simulated and posed **329 m** behind the player, and the streaming-orphan census counted none of it | the down branch respects both |
| A pedestrian hit alongside a car produced no crime at all | an 80 kg body can never out-delta-v a 1400 kg car: 1.04 against 9.60 | the worst of each KIND reacts; the damage charge stays one |

**And four numbers in the prose were wrong.** The throw model is 7.26% ABOVE the 30 km/h anchor
where the comment claimed −7% (the tool printed it through `toFixed(0)`); the rule-of-thumb band
is 42–56 km/h, not "roughly 30 to 60"; the shunt cap is a 63 km/h ram, not 72, and three
different delta-v-to-speed conversions were in use at once; and the sub-step bound was out by a
factor of two, because sub-steps cut evenly in time are not even in distance.

**One thing the review corrected in my favour, which is worth recording too.** `d = v²/(2μg)` is
not the "first-order form" of a projection-and-slide model — it is that family's MINIMUM, the
inversion of Searle's maximum-speed bound, and adding a launch angle throws 1.91× further at the
optimum. It reproduces the published anchors because two errors cancel: no launch angle
under-throws, and using the whole vehicle speed as the launch speed over-throws by about as much.
So μ = 0.66 is a three-point empirical fit (the anchors imply 0.7079, 0.6292, 0.6555, mean 0.664)
that lands on the midpoint of the quoted band, not an independently measured coefficient. The
model is unchanged and the comment now says what it is.

### Gates after this round

| Gate | Result |
|---|---|
| `reaction-test` | PASS — 112 checks, and 12 mutations that used to pass now fail it |
| `damage-test` | PASS — 111 checks, including the published curve at four speeds |
| `traffic-selftest` | PASS — 22 checks |
| `blocker-test` / `crash-test` / `roadpath-test` / `route-drive` | PASS |
| `mission-test` / `wanted-test` / `physics-test` / `golden-trace` | PASS |
| `geom-audit` / `leaf-mask` / `sim-determinism` / `check-syntax` | PASS |

**One victim, one offence.** A casualty gets back on its feet 4.42 s after it goes down, and from
that instant it can be knocked down again — so a player creeping back and forth over one person
collected a fresh crime every cycle. Measured against the real wanted system: **7 knockdowns in
30 s, all 7 charged, heat 5.99, five stars** from one pedestrian and a car that never left the
spot. `wanted.js`'s refractory is per crime TYPE, which is right for a bumper grinding along a
wall and wrong here, because what repeats is the victim. A 20 s per-victim window — a little
longer than the knockdown cycle — collapses it to 2 charged and 5 suppressed, heat 1.15, one
star, and leaves a genuinely different pedestrian a second later fully chargeable.

**Still open from the reviews, and worth saying rather than burying.** A thrown body slides
through walkers — the slide tests buildings only, and a body at 14 m/s crossed 6 cm from a
pedestrian. And the crowd walks through street furniture, which predates all of this (#67).
