# Phase 2 Progress Ledger

Live progress page: [`docs/progress.html`](docs/progress.html) (regenerate with `npm run progress`)

## Current target

**M2 — Living streets.** (M1 reached and approved; see [`MILESTONE-1.md`](MILESTONE-1.md).)

Previous target, M1 — Textured district: Materials + facade system wired into the streamed LOD,
budget thresholds re-derived from a fully textured chunk and logged here, lit windows
at night, bloom + height fog in.

## Status

| System | Owner | State |
|---|---|---|
| Engine shell + post-processing | sequential (lead) | **done** — HDR, bloom, height fog, ACES, dither |
| World streaming | sequential (lead) | **textured + resumable builds**; holds the stall gate |
| Vehicle physics | sequential (lead) | done, gated by golden trace |
| Player controller + camera + anim FSM | sequential (lead) | anim FSM done; on-foot integration pending |
| Traffic AI | sequential (lead) | Phase 1b stub, M2 |
| Materials library | parallel | **landed + wired** — 18 materials, 20 textures / 34 array layers, 28.7 MB, 1.8 s |
| Facade / building kit | parallel | **landed + wired** — 7 recipes, near-LOD only, lit windows |
| Sky + weather | parallel | wave 2 running |
| Signage + branding | parallel | wave 2 running |
| HUD | parallel | wave 2 running |
| Audio | parallel | wave 2 running |
| Loading screen | sequential (lead) | **done** — 760 ms measured first load |
| On-foot player + character | sequential (lead) | **done** — walk/sprint/idle, F to enter/exit |
| Wanted system | parallel | M3 |
| Mission scripting | parallel | M3 |

## Gate results

| Date | Gate | Result | Evidence |
|---|---|---|---|
| 2026-08-29 | **chase harness, textured** (60 + 10, dusk, 2 laps) | **PASS** — draw p95 **114**, tris 60.9k, stall **6.5 ms**, heap +3 MB, 71.5% headroom | `docs/chase-harness.json` |
| 2026-08-29 | chase harness, textured, first attempt | **FAIL** — stall 40.8 ms | fixed in 3 measured rounds; see below |
| 2026-08-29 | **chase harness, textured, new thresholds** | **PASS on fail / WARN on warn** — draw 116, tris 41.7k, stall **9.3 ms**, heap −4 MB, 41.9% headroom to fail | `docs/chase-harness.json` |
| 2026-08-29 | syntax gate | PASS — 38 modules parse | `npm run test:syntax` |
| 2026-08-29 | drive-through + 30 traffic, textured | PASS — draw p95 111, max 121 | `docs/drive-traffic.json` |
| 2026-08-29 | chase harness (untextured, 60 + 10) | PASS — draw p95 90, stall 4.4 ms, 77.5% headroom | superseded by the textured run |
| 2026-08-29 | chase harness, first run | **WARN** — draw p95 **325**, only 18.8% headroom | superseded; see Risk 5 findings below |
| 2026-08-29 | golden-trace | PASS (30 samples, ±0.25 m / ±0.5 km/h) | Phase 1b, re-verified after minified-three swap |
| 2026-08-29 | budget (no traffic) | PASS — draw p95 141, stall 4.8 ms, heap −1 MB | `docs/drive.json` |
| 2026-08-29 | budget (30 stubs) | PASS — draw p95 145, stall 6.6 ms, heap −2 MB | `docs/drive-traffic.json` |

**Thresholds in force** (`tools/budget.mjs`): draw calls warn **200** / fail **320**;
triangles warn **400k** / fail **900k**; chunk stall warn 8 ms / fail 16 ms; heap growth
warn 40 / fail 120 MB.

> Corrected 2026-08-30. This block previously published the superseded Phase 1b values
> (260/400 and 900k/1.8M) as current, contradicting both `tools/budget.mjs` and the
> Threshold change log below it. The re-derivation at M1 happened and **tightened** both;
> the stale text understated how tight the real gate is. Found by the independent
> constraint audit, not by me — see `MILESTONE-REVIEW.md` §6.

## Threshold change log

### 2026-08-30 — CI gate scope: split by determinism, NOT by threshold (owner-approved)

Constraint 4 calls both gates mandatory. Until today nothing ran them automatically:
no `.github/`, no workflow of any format, no git hooks. That is now
`.github/workflows/gates.yml`. Two facts shaped it.

**Which metrics a hosted runner can measure.** Across eleven serial runs on a
dedicated container:

| Metric | Reproducibility on unchanged code | Gates in CI? |
|---|---|---|
| golden trace, physics assertions | exact | **yes** |
| draw calls | within **1.3%** | **yes** |
| triangles | within **0.2%** | **yes** |
| heap growth | within 8 MB of 40/120 bounds | **yes** |
| **chunk stall ms** | **5.3–24.2 ms — spans PASS, WARN and FAIL** | **no — advisory** |

A hosted runner is noisier than that box, so gating stall there produces red builds
on good code. A gate that cries wolf is worse than no gate: people learn to click
through it, and then it stops catching the real regression.

**No threshold moved.** `BUDGET.chunkStallMs` is still 8/16 and still gates in full
everywhere it can be measured — locally, and on the `full` manual dispatch. The new
`BUDGET_ADVISORY` env var scopes *where* a metric is allowed to decide a build, and it
is opt-in: unset, every metric gates exactly as before, which is the default for every
local run. Only the workflow sets it. CI does not get to certify a milestone; stall
verdicts still require N>=5 local runs.

The tempting alternative — raising the CI stall threshold until it stops flaking — is
the silent loosening this constraint forbids, and was not done.

**Cost.** The repository is private, so Actions minutes bill against the owner's
allowance. The fast lane (syntax, golden trace, physics; no browser) is ~1 minute and
runs on every push. The geometry lane needs Chromium and is ~5-8 minutes with the
browser cached. Approved by the owner on 2026-08-30 after being presented with the
cost and the flake trade-off.

**Portability fix this required.** Six harnesses hardcoded
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` — this container's path and
nowhere else's — so every one of them failed on any other machine, the owner's
included. Resolution now goes through `tools/browser.mjs`. `playwright` was also
imported by every harness while being declared in `package.json` as a dependency of
nothing at all; it is now a pinned devDependency with a lockfile.


### 2026-08-30 — BACKFILL: the gated quantity was redefined at `02ccfdf` and never logged

Thresholds are only half of gate strictness. The other half is *what gets compared to
them*, and that changed without an entry here. `02ccfdf` switched the gated field:

```
- worst_chunk_build_ms: +world.worstBuildMs.toFixed(2),   // summed cost of building a chunk
+ worst_chunk_build_ms: +world.worstSliceMs.toFixed(2),   // worst uninterrupted main-thread slice
+ worst_chunk_total_ms: +world.worstBuildMs.toFixed(2),
```

The gate reads `worst_chunk_build_ms`, so this **redefined the number the 16 ms threshold
judges**. Measured across eight runs by the independent gate verifier, the redefinition
reduces the gated value by **20–45%**, and three of those eight runs would have read FAIL
under the old definition.

**The engineering case is sound and stands:** chunk building is genuinely resumable, so
the worst *uninterrupted* slice is the number a player actually feels as a hitch, and the
superseded value is still printed beside it as `worst_chunk_total_ms` in every artifact.
It was disclosed in the commit message, in code comments in both harnesses, and in the
Failed approaches table. But it was not disclosed *here*, and redefining what is measured
is a strictness change of exactly the class constraint 4 says is never silent. Logging it
retroactively rather than leaving the ledger incomplete. Found by the independent gate
verifier, not by me — see `MILESTONE-REVIEW.md` §6.

### 2026-08-30 — stall gate moves from one sample to a statistic (methodology, not threshold)

Eleven serial harness runs on two frozen commits established that the stall metric spans
the entire verdict range on unchanged code:

| Code | Stall samples (ms) | Range | Verdicts spanned |
|---|---|---|---|
| M2 HEAD, chase | 7.6, 12.0, 24.2 (doc: 18.5) | **3.2x** | PASS, WARN, FAIL |
| M1 `441faee`, chase | 8.4, 5.3 (doc: 6.4) | 1.6x | PASS, WARN |

Draw calls and triangles reproduce to within 4% across every run; only the timing metric
is unstable. **A single sample cannot decide a 16 ms threshold with this variance**, and
both milestone documents decided it with one. M1 drew the favourable tail and declared
"all four gates PASS"; M2 drew the unfavourable tail and escalated.

**No threshold moved.** The 8/16 ms bounds are unchanged. What changes is that a stall
verdict now requires **N>=5 runs reported as median and p80**, and milestone claims quote
the statistic, not a sample. Measurement sets live in `docs/measurements/`.

### 2026-08-30 — `physics-test.mjs` made into an actual gate (strictness INCREASED)

The file computed acceleration, braking, cornering, handbrake, stability, timestep
independence and step cost — and asserted **none of it**. No comparison, no threshold, no
`process.exit` in 137 lines. It could not fail, and `npm run gates` piped its output to
`/dev/null` before printing `ALL-STATIC-GATES-PASS` unconditionally. The property its own
comment calls "the #1 way vehicle physics rots later" was printed and ignored.

Ten assertions added, every bound derived from a measured value with its headroom stated:

| Check | Measured | Bound | Headroom |
|---|---|---|---|
| fixed-step position convergence, 15–144 Hz | **1.67 m** | < 2.5 m | 1.5x |
| fixed-step speed convergence | 0.00 km/h | < 1.0 km/h | — |
| all outputs finite | finite | no NaN/Inf | — |
| speed at 10 s | 112.6 km/h | 80–140 | — |
| top speed | 129.2 km/h | 100–170 | — |
| brakes to rest | 0 km/h by 4 s | == 0 | — |
| ride height | 0.717 m | 0.4–1.2 | — |
| wheels grounded under power | 4 | == 4 | — |
| turn radius | 17.6 m | 8–40 m | — |
| step cost | 2.4 us | < 10 us | 4x |

Verified it can fail: with two bounds artificially tightened it reports
`PHYSICS: FAIL - 2 of 10 checks failed` and exits 1.

`npm run gates` now runs **all four** gates — syntax, golden trace, physics, lighting
sweep and the budget gate — with no output suppression and no unconditional success echo.
The budget gate and lighting sweep were previously in no aggregate script at all.

### 2026-08-30 — measurement-window correction (NOT a threshold change)

`startRecording()` reset `worstBuildMs` but never `worstSliceMs`, so the stall metric
carried the **initial chunk-fill burst** — dozens of chunks built while the loading screen
is still up — into what is meant to be a steady-state churn measurement. The drive-through
reported **17.9 ms (FAIL)** on a run whose steady-state worst slice, measured over 90 s,
was **7.2 ms**.

`resetPeakStats()` now clears every peak at the start of the recorded window. After the
fix: drive-through **17.9 → 9.4 ms**, chase harness 10.6 → 10.7 ms (unchanged, as
expected — its numbers were already dominated by steady-state churn).

**No threshold moved.** This narrows the measurement to the window the harness actually
records, and the excluded stall is one the player never experiences because the loading
screen covers it. Flagging it explicitly because it *looks* like a gate being loosened,
and constraint 4 says those are never silent. If you disagree with the reasoning, the
one-line revert is to drop `worstSliceMs` from `resetPeakStats()`.

### 2026-08-29 — re-derived against the first fully textured district (binding constraint 4)

| Metric | Was | Now | Direction |
|---|---|---|---|
| Draw calls | warn 260 / fail 400 | **warn 200 / fail 320** | tightened |
| Triangles | warn 900k / fail 1.8M | **warn 400k / fail 900k** | tightened |
| Chunk stall | warn 8 / fail 16 ms | unchanged | — |
| Heap growth | warn 40 / fail 120 MB | unchanged | — |

**Measurements the new values are derived from** — all with 60 civilian + 10 pursuit units,
materials + facade kit + post stack live:

| Source | Draw calls | Triangles |
|---|---|---|
| Chase harness, 2 laps at speed | p95 114, max ~125 | 60.9k p95 |
| Drive-through + traffic, 3 laps | p95 111, max 121 | — |
| 9 static route cameras @ 1920×1080 | max 112 | max 37.1k |

**Rationale.** The old values were set in Phase 1b against *untextured* extrusions and were
never a real budget. warn ≈ 1.6× and fail ≈ 2.5× the measured textured worst case leaves
room for the systems still to land (signage atlas, sky dome, rain, mission props — HUD is
DOM and adds zero WebGL calls) while still failing on a structural regression such as
losing instancing or reintroducing per-object materials. Stall and heap stay principled
rather than measurement-derived: 16 ms is one frame at 60 Hz.

Both draw-call and triangle thresholds moved **down**. No gate was loosened.

## Failed approaches

| What | Why it failed | What replaced it |
|---|---|---|
| Overpass API for the OSM bake | 503s + mid-exchange tunnel resets across 4 mirrors through the container proxy | Canonical `api.openstreetmap.org/api/0.6/map` bbox endpoint |
| Emissive facade mask via `getImageData` readback | 2,219 ms per 1024px texture (1M-pixel JS loop) | Single-pass: albedo + emissive drawn together, 143 ms |
| Shared scratch vector in `Vehicle.applyImpulseAt` | `offset.cross(impulse)` became a self-cross → suspension torque silently zero | Dedicated `_tq` scratch, documented as do-not-optimise |
| Per-frame steering lerp / variable timestep | Handling changed with frame rate; 30 Hz vs 120 Hz diverged ~75 m over 8 s | `stepFixed()` 120 Hz accumulator; now within 1.6 m |
| Distance-threshold "orphan" counter in traffic | Tallied frames × cars (34,864), not distinct orphans | Counts distinct cars whose chunk is genuinely not resident |
| Bayfront band as "within 220 m of trim west edge" | Band was mostly open water; caught only 15 footprints | Distance to real coastline geometry; 153 footprints |
| Synchronous chunk build with the facade kit | One chunk cost 31.2 ms; the stall gate fails at 16 ms and `budgetMs` cannot help when the granularity is a whole chunk | Resumable build: append until the frame deadline, continue next frame; gate now measures the worst uninterrupted slice |
| Per-building cost cap keyed on `floors × vertex count` | Missed the actual worst case — a four-point 737 m² tower emitting 19k trim vertices in 28.5 ms | Keyed on `floors × perimeter`, because balcony count scales with edge length not edge count |
| Recomputing the want/unload/queue scan every `update()` | 6.8 ms per call for an answer that was identical almost every time | Rescan only when the player crosses a chunk boundary |
| Mesh upload inside the same slice as geometry append | 9.8 ms of unbounded buffer creation tacked onto a slice that had already spent its budget | Upload is its own scheduled phase |
| Plausibility audit that only checked its own lights | The sky can emit 7.1x the illuminance the camera stop was calibrated for and the top-level `implausible` list still read empty — the gate was decorative exactly where it mattered | Attached subsystems escalate their own flags, plus an explicit sky-vs-preset illuminance ratio check |
| Zone-polygon triangulation inside a single upload step | Ear clipping is O(n²) and the district has 161 parking polygons; a chunk full of them blew the slice to 38.5 ms and FAILED the gate | Moved into the deadline-gated append phase, one polygon per iteration; 38.5 → 10.6 ms |
| Lighting gate keyed on sky illuminance ratio | Passed at 1.76× while the frame was still washed out — the wrong quantity. Saturation is decided by radiance × exposure, which measured 2.14 (fog) and 6.52 (inscatter) | Gate checks radiance × exposure; `normalisePostExposure()` renormalises after sky and weather have both written |
| Releasing the junction reservation at the transition | The next car entered while the first was still physically inside the intersection; 653 of 1015 overlap frames were near a junction | Hold until the car is `JUNCTION_CLEAR_DIST` along its NEW edge |
| Traffic entering an edge without checking it was clear | Measured closest approach 0.21 m — interpenetration, not a near miss | `_entryBlocked()` gate before committing to a transition |
| Releasing the junction while entry-blocked | Tried as a deadlock guard; measured **34.3%** overlap against 13.0% for holding | Reverted; the deadlock does not occur because the blocking car always clears |
| Keeping the traffic edge index live within a frame | Measured **35.2%** against 13.0%. A car added at t=0 mid-frame becomes a leader for vehicles already on that edge, whose gap goes negative and triggers emergency braking that bunches the edge | Reverted to the stale index — the rare same-frame double entry costs less |
| Mesh upload as one block per chunk | The whole chunk's meshes uploaded together; worst slice 13.4 ms | Split into one-mesh steps the deadline can gate; upload fell to 2.3–3.7 ms |
| Unbounded unload loop | Crossing several chunk boundaries in one update disposed every out-of-range chunk at once — the last unbounded block | Bounded to one disposal per update, deferred through a pending map |
| One mesh pair per street lamp (233 posts = 466 meshes) | ~70% of all draw calls at worst case; chase harness measured 325 p95, 18.8% headroom | `src/streetfurniture.js`: 3 InstancedMeshes for the whole district |
| One `PointLight` per street lamp (233 live lights) | three.js forward-renders every light per fragment and compiles materials against the light count; software rendering here could never expose it | `src/lightpool.js`: fixed pool of 10 real lights reassigned to the nearest emitters, with hysteresis |
| `renderer.info.render` read directly for the budget gate | After the composite blit it describes a 1-triangle fullscreen pass — reported **1 draw call** and would have silently defeated the gate | `PostStack.stats.sceneCalls/totalCalls` snapshot taken right after the scene render |
| Traffic overlap metric with an inner-loop `break` | Several outer iterations counted the same frame; reported **119.9%** of frames | Single `overlapped` flag, counted once per frame |

## Cut-list status

Per FEASIBILITY-1B.md §6. Cuts execute bottom-up. Reaching item 4 or higher escalates.

| # | Item | Status |
|---|---|---|
| 1 | Weather beyond rain + fog | **CUT** (per binding constraint 3) |
| 2 | Pedestrians | not cut |
| 3 | Building interiors | **CUT** (never in scope) |
| 4 | Full district height authoring | **partially cut** — corridor + mission route authored, rest defaulted (binding constraint 9, pre-approved) |
| 5 | Second LOD tier + occlusion culling | not cut |
| 6 | TAA | not cut |
| 7 | Bloom + height fog | **NEVER CUT** (binding constraint 8) |
| 8 | The two CI gates | **NEVER CUT** (binding constraint 8) |

Item 4 is marked partially cut because binding constraint 9 pre-authorises exactly that
scope ("author heights along the Marlin Street corridor and mission route; defaulted
massing acceptable elsewhere"). This is the approved plan, not an escalation.

## Critic rounds

| Round | Frames | Verdict | Record |
|---|---|---|---|
| M1 blind critic round (`wf_1186b7f8`) | dusk + night, 4 critics | **all `GTA_V_BETTER`** | `MILESTONE-1.md` §6, `docs/m1-critique.json` |
| M1/M2 reviewer verification, 2026-08-30 | dusk + night, 4 blind critics + 3 auditors | **all `GTA_V_BETTER`; neither milestone passes** | `MILESTONE-REVIEW.md` |

An earlier attempt (`wf_1fa8d5ce`) died entirely to a session limit and returned nothing.

> This section previously read "_None yet._" while the M1 round was documented in
> MILESTONE-1 §6 and its artifacts were committed. Corrected 2026-08-30.

## Sky integration — calibration RESOLVED, refresh cost OPEN

**Resolved.** After the wave-2 rewrite the lighting gate passes at all three presets and
the negative test still fires:

| Preset | Sky emits | Preset expects | Ratio | Gate |
|---|---:|---:|---:|---|
| noon | 15,887 lux | 20,000 lux | 0.79× | pass |
| dusk | 1,583 lux | 900 lux | 1.76× | pass |
| night | 2.19 lux | 3.5 lux | 0.62× | pass |

**Still open: a sky refresh costs 2,429 ms**, of which 822–2,148 ms is a GPU→CPU
read-back of the scattering probe. With three discrete presets that is a hitch on each
manual switch, which is survivable; **a continuous day/night cycle cannot afford it**, and
the cycle is in scope for M3. A `readPixels` of a 32×16 probe should be single-digit
milliseconds on a real driver, so this is very likely another SwiftShader artifact —
it goes on the M1 real-hardware checkpoint list beside chunk disposal. If it is real, the
probe has to move off the synchronous path (async readback, or derive the fog terms
analytically from the same LUT the shader uses rather than reading pixels back).

First load also moved 760 ms → 3,713 ms, the atmosphere step accounting for 2,453 ms of
it. Still inside constraint 7's 8 s budget, so no IndexedDB cache, but the margin is now
2.2× rather than 10×.

### Superseded: first pass over-exposed



The first integration measured badly wrong, which is what prompted closing the gate hole:

| Preset | Sky emits | Preset expects | Ratio | Gate |
|---|---:|---:|---:|---|
| dusk | 6,371 lux | 900 lux | **7.1×** | FLAGGED |
| night | 2.0 lux | 3.5 lux | 0.4× | FLAGGED |
| noon | 14,903 lux | 20,000 lux | 0.75× | pass |

At dusk this blew the frame to white (`docs/shots/sky-corridor-dusk.png`). The important
part is that the gate caught it — it would not have before the hole was closed.

## Sub-agent capacity interruption (2026-08-29 23:0x – 00:00 UTC)

The first builder wave lost four of six agents and the entire four-critic panel to
`You've hit your session limit · resets 12am (UTC)`. **facades** completed and verified;
**materials** produced a complete, working module before its agent died (it is integrated
and the syntax gate passes); **sky, signage, HUD and audio never ran**, and no critic
round happened. Wave 2 was relaunched after the reset with those four builders.

This is a capacity interruption, not a spec problem, and it did not stop sequential work —
the engine shell, post stack, streaming integration, chase harness, threshold
re-derivation, on-foot mode and loading screen were all built in that window. It is
recorded because it moved the first critic round later than planned.

## Constraint 7 — first-load measurement

Measured through the real loading path (`src/loading.js`): **760 ms total** — 12.3 ms
reading the district, 596.3 ms generating materials and the facade library, 2.5 ms
lighting. **Well under the 8 s threshold, so no IndexedDB cache is adopted.** Caveat: this
is SwiftShader; texture generation is CPU canvas work so it should be broadly
representative, but this number is on the list to confirm at the M1 real-hardware check.

## Open item for the M1 real-hardware checkpoint

The stall metric sits at **9.3 ms — a WARN, 41.9% headroom to the 16 ms fail**. Its
dominant term is a single `_dispose` measured at **8 ms**, which is WebGL buffer
deletion. That is almost certainly a SwiftShader artifact: a real driver frees buffers
far more cheaply. Everything else in the slice is now bounded and small (scan 1.1 ms,
upload 2.3–3.7 ms). **This is the first thing to re-measure on real hardware at M1.** If
it holds at ~8 ms there, chunk disposal needs a different strategy (geometry pooling);
if it collapses, the stall metric should comfortably clear the warn threshold.

## Risk 5 chase harness — running from week one

`tools/chase-harness.mjs` (`npm run chase`). Spawns the worst case — 60 civilian stubs +
10 pursuit units + the route driven at speed, forcing continuous streaming churn on the
real road graph — and asserts against the budget gate. It found three real defects on its
first run, all listed under Failed approaches above, and one of them (the
`renderer.info` read) would have silently disabled the draw-call gate for the rest of
Phase 2.

| | First run | After fixes |
|---|---|---|
| Draw calls p95 | 325 (WARN, 18.8% headroom) | **90 (PASS, 77.5% headroom)** |
| Live point lights | 233 | **10** (fixed pool over 233 emitters) |
| Lamp draw calls | ~466 meshes | **3** InstancedMeshes |

Pursuit behaviour over 2 laps: 10 active, 35 spawns, 9 lost beyond the give-up radius,
752 junction reroutes, 16 one-way dead-ends. Civilian traffic at 60 units: 659 spawns,
549 despawns, 50 dead-ends, **0 orphans**, overlap 68.7% of frames (vs 35.4% at 30 units —
the honest scaling of a stub with no following distance; M2's job).

## FIRST THING TO DO ON CONTINUE

**Re-enable the hourly watchdog** — `trig_01AcU4HEkk7RNy3cSyi7J6zP`, fires at :53. Paused
again at the M2 gate for the same reason as at M1: its purpose is surviving usage limits
during active building, and at a gate it can only cost a turn an hour for no result.
Re-arm with `update_trigger` / `enabled: true` before resuming.

## Next action

**PAUSED AT THE M2 GATE.** See [`MILESTONE-2.md`](MILESTONE-2.md). Waiting for CONTINUE.

**The budget gate is RED** (chunk stall 18.5 ms vs a 16 ms fail) and that is escalation
condition (a). It is isolated, not guessed: HUD off measures 8.1 ms, HUD on 12.2 ms, so
the HUD adds ~4 ms to the *streaming* slice through GC while adding zero WebGL draw calls.
Part real defect, part harness artifact (22 sim steps per rendered frame charges one HUD
update's garbage against 22 streaming updates). **The threshold was deliberately not
relaxed.**

On CONTINUE, in order:
1. Resolve the stall gate. Recommended: reduce HUD per-frame allocation and re-measure.
   Alternative: measure streaming with `setHudEnabled(false)` and gate the HUD's frame
   cost separately — but that risks hiding a real interaction.
2. Integrate `src/audio.js` and `src/wanted.js` (both built and verified, deliberately not
   wired in while a gate is red).
3. Fix the three critic-confirmed geometry defects: severed awning post, floating plaza
   bars, orphaned pole stub.
4. AO / contact shadows — the most-cited gap across all four M1 critics.
5. Mission scripting and the Marlin Street mission → M3.

Traffic AI is done: 14.6% overlap at 30 cars against the 35.4% stub baseline, same-edge
overlaps eliminated. Remaining traffic work is junction *capacity* (non-conflicting
movements crossing together), which is what the 64.3% figure at 60 cars is about.
