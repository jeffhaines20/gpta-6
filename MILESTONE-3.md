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
| 5. **Mission scripting + the Marlin Street mission** | **zero lines written.** There is no `src/mission*.js`. |

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
3. **Finish the car line or stop it, explicitly.** Three blind reviewers say the
   cars are improved but **not markedly**. The lamps are off and proven passive,
   the shells are real and cost zero triangles, and the one live lever is the
   pane's *modulation* — 1.06 to 1.14, which means nothing is reflected in the
   glass at any brightness. A glazing albedo sweep is running now; if F0 0.04
   turns out to deliver nothing against this environment, the answer is that this
   pool cannot fix it (one material serves every slot on the car) and the round
   should close as a priced refusal rather than a fourth attempt.
4. **The remaining open visual items, in priority order**: glass reads blue at
   noon (#36), the traffic-car greenhouse at night (#54), `aoKernel` 3 parked for
   a reviewer (#48), and shell variety past the three that shipped (#56).

**Recommendation.** Stop the visual rounds after the glazing one and spend the
next block on item 1. M3's acceptance is gameplay, and there is currently none of
it; every round spent on a 40-pixel car is a round not spent on the thing the
milestone is named for.
