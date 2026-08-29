# Phase 2 Progress Ledger

Live progress page: [`docs/progress.html`](docs/progress.html) (regenerate with `npm run progress`)

## Current target

**M1 — Textured district.** Materials + facade system wired into the streamed LOD,
budget thresholds re-derived from a fully textured chunk and logged here, lit windows
at night, bloom + height fog in.

## Status

| System | Owner | State |
|---|---|---|
| Engine shell + post-processing | sequential (lead) | in progress |
| World streaming | sequential (lead) | Phase 1b baseline, being textured |
| Vehicle physics | sequential (lead) | done, gated by golden trace |
| Player controller + camera + anim FSM | sequential (lead) | Phase 1 baseline |
| Traffic AI | sequential (lead) | Phase 1b stub, M2 |
| Materials library | parallel | queued |
| Facade / building kit | parallel | queued |
| Sky + weather | parallel | queued |
| Signage + branding | parallel | queued |
| HUD | parallel | queued |
| Audio | parallel | queued |
| Wanted system | parallel | M3 |
| Mission scripting | parallel | M3 |

## Gate results

| Date | Gate | Result | Evidence |
|---|---|---|---|
| 2026-08-29 | **chase harness** (60 civilian + 10 pursuit, dusk, 2 laps) | **PASS** — draw p95 **90**, tris 20.6k, stall 4.4 ms, heap −2 MB, 77.5% headroom | `docs/chase-harness.json` |
| 2026-08-29 | chase harness, first run | **WARN** — draw p95 **325**, only 18.8% headroom | superseded; see Risk 5 findings below |
| 2026-08-29 | golden-trace | PASS (30 samples, ±0.25 m / ±0.5 km/h) | Phase 1b, re-verified after minified-three swap |
| 2026-08-29 | budget (no traffic) | PASS — draw p95 141, stall 4.8 ms, heap −1 MB | `docs/drive.json` |
| 2026-08-29 | budget (30 stubs) | PASS — draw p95 145, stall 6.6 ms, heap −2 MB | `docs/drive-traffic.json` |

**Thresholds in force** (`tools/budget.mjs`): draw calls warn 260 / fail 400; triangles
warn 900k / fail 1.8M; chunk stall warn 8 ms / fail 16 ms; heap growth warn 40 / fail 120 MB.
Set against *untextured* extrusions in Phase 1b. **Scheduled re-derivation at M1** once the
first fully textured chunk lands (binding constraint 4).

## Threshold change log

_No changes yet. Any change must be re-derived from measurements and recorded here._

## Failed approaches

| What | Why it failed | What replaced it |
|---|---|---|
| Overpass API for the OSM bake | 503s + mid-exchange tunnel resets across 4 mirrors through the container proxy | Canonical `api.openstreetmap.org/api/0.6/map` bbox endpoint |
| Emissive facade mask via `getImageData` readback | 2,219 ms per 1024px texture (1M-pixel JS loop) | Single-pass: albedo + emissive drawn together, 143 ms |
| Shared scratch vector in `Vehicle.applyImpulseAt` | `offset.cross(impulse)` became a self-cross → suspension torque silently zero | Dedicated `_tq` scratch, documented as do-not-optimise |
| Per-frame steering lerp / variable timestep | Handling changed with frame rate; 30 Hz vs 120 Hz diverged ~75 m over 8 s | `stepFixed()` 120 Hz accumulator; now within 1.6 m |
| Distance-threshold "orphan" counter in traffic | Tallied frames × cars (34,864), not distinct orphans | Counts distinct cars whose chunk is genuinely not resident |
| Bayfront band as "within 220 m of trim west edge" | Band was mostly open water; caught only 15 footprints | Distance to real coastline geometry; 153 footprints |
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

Integrate the six M1 builder modules as they land, then re-derive the draw-call
thresholds against the first fully textured chunk and log the change here.
