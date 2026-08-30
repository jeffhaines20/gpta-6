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

**Thresholds in force** (`tools/budget.mjs`): draw calls warn 260 / fail 400; triangles
warn 900k / fail 1.8M; chunk stall warn 8 ms / fail 16 ms; heap growth warn 40 / fail 120 MB.
Set against *untextured* extrusions in Phase 1b. **Scheduled re-derivation at M1** once the
first fully textured chunk lands (binding constraint 4).

## Threshold change log

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

_None yet._

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

## Next action

**M1 APPROVED — building M2 (Living streets).** Watchdog re-armed 13:34 UTC.

M2 gate requires: traffic AI with following distance, intersections and dead-end routing,
reporting the overlap rate against the **35.4% stub baseline**; and the chase harness
running worst case with gate metrics.

Order of work:
1. Traffic AI (sequential owner) — the M2 gate itself.
2. Integrate `src/signage.js` (+8 draw calls district-wide, measured) and `src/hud.js`.
3. Fix the three critic-confirmed geometry defects: severed awning post, floating plaza
   bars, orphaned pole stub.
4. AO / contact shadows — the most-cited gap across all four M1 critics.
5. `src/audio.js` — the one wave-2 builder the usage limit killed.
