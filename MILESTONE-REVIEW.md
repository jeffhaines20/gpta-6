# M1 / M2 Reviewer Verification

**Verdict: the reviewers did not sign off. Neither milestone passes.**

You asked whether reviewers had signed off before any continuation to M3. They had
not — M1 had one critic round whose frames predated the fixes those critics prompted,
and M2 had none at all. This document is the round that was missing.

Seven independent fresh-context reviewers: four blind visual critics (one per frame,
denied access to every report and all source), one gate re-run verifier (11 serial
harness executions), one acceptance-claims auditor, one binding-constraint auditor.

Nothing here is M3 work. Everything below is M1/M2 remediation.

---

## 1. Headline findings

| # | Finding | Severity |
|---|---|---|
| 1 | **M1's "All four gates PASS" rests on a single lucky draw.** The stall metric spans PASS/WARN/FAIL on unchanged code | Critical |
| 2 | **The M2 overlap acceptance criterion is not met.** Measured like-for-like it is 26.7% vs the stub's 27.0% | Critical |
| 3 | **There is no CI.** No workflow, no hook, no config. Constraint 4's gates are manual scripts | Critical |
| 4 | **`npm run gates` omits the budget gate and runs an un-failable check** whose output is discarded | Critical |
| 5 | **The junction reservation leaks permanently.** 139 held against 59 living cars | High |
| 6 | **All four blind critics returned `GTA_V_BETTER`** at both dusk and night | High |
| 7 | The gated stall quantity was redefined (`worstBuildMs` -> `worstSliceMs`) without a ledger entry | Medium |

---

## 2. The stall gate is a coin flip

Eight budget runs on two frozen commits, strictly serial, no contention:

| Code | Stall samples (ms) | Range | Verdicts spanned |
|---|---|---|---|
| HEAD, chase | 7.6, 12.0, 24.2 (doc: 18.5) | **3.2x** | PASS, WARN, FAIL |
| HEAD, drive-through | 7.7, 9.7 | 1.3x | PASS, WARN |
| M1 (`441faee`), chase | 8.4, 5.3 (doc: 6.4) | 1.6x | PASS, WARN |

Draw calls and triangles reproduce to within 4% across every run. The timing metric
spans the entire verdict range on identical code. **Both milestone documents decide a
16 ms threshold from a single sample.**

The direction of error is not self-serving, and that matters for diagnosis:

- **M1 reported the favourable tail.** Claimed 6.4 ms PASS; re-measured 8.4 ms WARN on
  the same commit. "All four gates PASS" is a property of one draw, not of the code.
  **This is the one that let a milestone be declared reached.**
- **M2 reported the unfavourable tail.** Claimed 18.5 ms FAIL; two of three re-runs came
  in under it. M2 escalated and stopped the project on a number that could equally have
  read PASS.

Root cause is single-sample methodology, not bias. **Remedy: gate on a statistic over
N>=5 runs (median or p80), not one sample.** This is a measurement-methodology change,
not a threshold change, and will be derived and logged as such. Until it lands, no
stall verdict in either document is a fact — including M2's escalation.

---

## 3. The M2 overlap criterion fails

MILESTONE-2 §1 claims "14.6% at 30 cars" against a 35.4% stub baseline, and §2 calls it
"measured like-for-like, same definition, same fleet size". It is not like-for-like.

The 35.4% baseline was produced by the **drive-through** harness. The 14.6% figure was
produced by the **chase** harness. Running the M2 traffic AI through the harness the
baseline actually came from, at the same fleet size:

| 30 cars, `drive-through --traffic` | overlap % of frames | same-edge |
|---|---|---|
| stub @ `4bc2485` — the cited baseline | 35.4 | — |
| stub @ `441faee` — later re-run, still stub | 27.0 | — |
| **M2 traffic AI, same harness** | **26.7** | **7** |

On the overlap metric the traffic AI is **statistically indistinguishable from the stub
it replaced.** The claimed -59% is an artifact of comparing across harnesses; the harness
alone moves the number by 2.1x.

Two further defects in the same claim:

- **"Same-edge overlaps: 0 — eliminated" is refuted at 7.** The classifier tests
  `overlapNearJunction` first and only ever classifies the single worst pair per frame,
  so a same-edge overlap within 13 m of a junction is silently bucketed as near-junction.
- **The 14.6% headline has no committed artifact.** The supporting statistics printed
  beside it (9.6% follow-brake, 32.7% junction-wait, 23 dead ends, 18 U-turns) are all
  60-car numbers.
- A newer 27.0% stub run was already committed at `docs/drive-traffic.json` and was
  never compared against.

Evidence preserved at `docs/review-drive-traffic-m2ai.json`.

**The three behavioural criteria do hold.** The IDM is a genuine Intelligent Driver
Model with the standard delta=4 exponent, not a proximity hack; junction reservation is a
real mechanism; dead-end U-turns are real. It is specifically the overlap-rate criterion
that fails.

---

## 4. The junction reservation leaks permanently

`docs/chase-harness.json` records `alive: 59` and `junctionsHeld: 139`.
`car.holdingJunction` is a scalar, so a car holds at most one junction. **80 reservations
are held by cars that can never release them.** Two paths, both in `src/traffic.js`:

1. **`:299-301`** — claiming a new junction assigns `car.holdingJunction = jv`, overwriting
   the previous vertex without releasing it. `_release` (`:197-202`) can only delete what
   `holdingJunction` currently points at, so the old vertex is stranded.
2. **`:358`** — `if (!p) { this.cars[i] = null; continue; }` drops a car with no release.

A car releases at `JUNCTION_CLEAR_DIST` (7 m) onto its new edge but claims the next at
`JUNCTION_CLAIM_DIST` (13 m) out, so on any edge shorter than 20 m the claim fires first.
**31.7% of the district's 935 edges are under 20 m.** Car ids are monotonic (583 spawns),
so a stranded vertex can never be matched by a future car either — it is closed for the
rest of the session, and every car routed through it stops dead.

Downstream numbers fit exactly: `overlapNearJunction` is 1577 of 1582 overlap frames
(99.7%), `stoppedPctOfCarFrames` 19.7, `junctionWaitPctOfCarFrames` 33.

**MILESTONE-2 §2 is wrong on this.** It attributes the 64.3% overlap at 60 cars to needing
junction *capacity* and defers it to M3 as "not a tweak". It is a ratcheting reservation
leak, and it is a fix. The disproof was in the committed evidence file and was read past.

---

## 5. Visual: four blind critics, unanimous

All four returned **`GTA_V_BETTER`** at both dusk and night. Frames were captured at
current HEAD with traffic populated, each paired with a scene-graph audit per constraint 5.

**Convergent across all four:** no ambient occlusion or contact shadows anywhere; no
visible light pools or lamp fixtures at night; night sky rust-orange with oversized
uniform stars and no horizon extinction; the player vehicle is a box with four cylinders;
road material reads as paving slab rather than asphalt, markings absent or incoherent;
lit windows are flat blown quads with no interior and no bloom halo; no pedestrians;
dusk clipped to near-white.

**Geometry integrity** (exhaustive scan, Five Points dusk): a floating mint-green cuboid
with no support; a street blade with no post reaching the ground; the arcade canopy
projecting past its own wall with no brackets; mid-block awnings with no supports; an
untethered rooftop slab; yellow decal squiggles on the sidewalk at an apparently wrong UV.
This is the third independent sighting of the floating-prop defect class.

**Credited by multiple critics:** perspective and canyon composition correct and confident;
aerial perspective working; block massing credible urban geometry; the asphalt crack decal
network genuinely well authored; the HUD close to shippable.

### 5.1 Critic diagnoses, audited (constraint 5)

Their measurements were sound. Their diagnoses were mostly wrong, and would have sent
builder work in the wrong direction:

| Critic diagnosis | Audit result |
|---|---|
| "No shadow map bound" (all four) | **Wrong.** PCF soft shadows enabled at `district/main.js:33-34`, 88 casters, 238 receivers, frustum follows the player via `tod.follow()`. Both dusk frames are backlit into the sun |
| "No punctual lights / emissives seed no lights" | **Wrong.** 10 PointLights pooled from 233 emitters, 9 active, 300-3000 cd |
| "No bloom pass" | **Wrong.** 6 passes; night threshold 0.55, strength 0.85 |
| "Ambient term tinted orange" | **Wrong mechanism, right observation** — see below |

**Actual root causes, measured:**

- **Night monochrome.** `src/sky.js` sets `nightHorizonNits = 0.42` against
  `nightZenithNits = 0.045` — energy biased **9.3:1 toward the horizon** — at
  `nightHorizonColor = 0xffab6e`, near-full sodium saturation. The comment directly above
  those constants states the correct remedy ("biased toward the zenith and the sodium tint
  pulled back off full saturation"); the constants do the opposite. `sky.js:1017` then
  samples that horizon as `fogColor`, and it also feeds the PMREM environment at
  `envIntensity: 1.0`, so the orange becomes both the fog and the ambient lighting the
  entire district.
- **Dusk blowout.** The dome renders at `horizonNits: 1185` against exposure 1/330 =
  **3.59x saturation**. Measured sky 245/255; darkest region in frame is asphalt at 173.
- **The plausibility gate cannot see it.** It checks sky *illuminance* (1612 lux, inside
  the 100-2500 envelope) and reports `implausible: []`. Saturation is `radiance x exposure`.
  That correction was applied to `fogColor` and `fogInscatter` — both correctly clamped
  here at 0.451 and 0.361 — and **never extended to the dome itself.**
- **No light pools.** Ground at night measures 0.055 nits. A 900 cd lamp at 8 m should
  deliver 1.34 nits — 24x short — consistent with lamps falling outside the 46 m cutoff
  at these camera positions. Placement density, not a missing system.

---

## 6. Gate integrity

### What is clean, and it is worth stating plainly

- **No threshold in this project has ever been loosened.** `git log -p --follow
  tools/budget.mjs` returns exactly two commits; the only change tightened draw calls
  260/400 -> 200/320 and triangles 900k/1.8M -> 400k/900k. The ledger matches git exactly.
- **`data/golden-trace.json` was recorded once and never re-recorded**, despite
  `src/vehicle.js` changing afterward. The `--update` escape hatch was never used.
- M2 committed a red gate and genuinely paused rather than burying it.

### What is broken

- **No CI exists.** No `.github`, no workflow of any format, no git hooks, no
  `core.hooksPath`. Constraint 4 calls the gates mandatory; nothing runs them.
- **`npm run gates` omits the budget gate entirely** — it runs syntax + golden + physics.
  The draw-call/stall/heap gate lives only inside `drive` and `chase`, neither aggregated.
  The lighting sweep is in no aggregate script either. `npm test` is undefined.
- **`tools/physics-test.mjs` has zero assertions and no `process.exit` in 137 lines.**
  It cannot fail. Its output is piped to `/dev/null`, then `echo ALL-STATIC-GATES-PASS`
  prints unconditionally. The property its own comment calls "the #1 way vehicle physics
  rots later" — timestep independence — is printed and ignored.
- **WARN exits 0**, so the warn threshold does nothing automated. Four of eight budget
  runs landed in WARN.
- **The gated quantity was redefined without a ledger entry.** `02ccfdf` switched
  `worst_chunk_build_ms` from `world.worstBuildMs` to `world.worstSliceMs`. The engineering
  case is sound — chunk building is resumable, so the worst uninterrupted slice is what a
  player feels — and it was disclosed in the commit message and in code comments. But it
  reduces the gated number by 20-45% and would flip three of eight runs from FAIL, and
  redefining what is measured is a strictness change of the same class as moving a
  threshold. It belongs in the Threshold change log next to the `resetPeakStats()` entry.

---

## 7. Constraint compliance

| # | Constraint | Status |
|---|---|---|
| 1 | GTA V bar; no Google/Street View | **COMPLIANT** — searched all source, markdown, JSON and full git history. The only `google` hits are OSM contributors' own `books.google.com` citations in raw XML the parser never reads. No reference imagery of any kind exists in the repo |
| 2 | 1.437 km2 footprint, water is western edge | **PARTIAL** — data exact at 1.4366 km2, `TRIM` never modified, 100% of in-box coastline western. But `streaming.js:88-111` pads water 900 m on all four sides and no edge barrier exists; you can drive off any edge |
| 3 | Rain + fog only; full day/night; physical units | **PARTIAL** — weather is exactly clear/lightRain/heavyRain, no other states anywhere; units genuinely lux/candela. But day/night is three discrete presets with no clock and no interpolation. Documented as M3 scope in three places, so unfinished rather than concealed |
| 4 | Two CI gates, never bypassed | **VIOLATED** — see §6 |
| 5 | Critique paired with scene-graph audit | **COMPLIANT** — structurally enforced; `hero-shots.mjs` writes the audit unconditionally for every capture. It earned its place again this round (§5.1) |
| 6 | Three.js committed minified | **COMPLIANT** — 381,124 + 338,908 bytes tracked, relative imports, no CDN, no `node_modules/three` |
| 7 | Runtime textures, IndexedDB only if >8 s | **COMPLIANT** — no IndexedDB/localStorage/ServiceWorker anywhere; first load 6.4 s. Margin is now 1.25x, down from 10x |
| 8 | Cut list is the only descope path | **COMPLIANT** — bloom, height fog and both gates never cut. No genuine descope has been executed |
| 9 | Massing is authoring, not import | **COMPLIANT** — authored massing beats the OSM height tag by design; 117 authored of 523 |
| 10 | ODbL attribution in three places | **COMPLIANT** — exact string in `README.md:38`, `district/credits.html:24`, `district/index.html:19` |

---

## 8. Corrections to the milestone documents

**MILESTONE-1.md**
- §2 "All four gates PASS" -> the stall gate is PASS-or-WARN depending on the run.
- §2 chunk-loads sentence blends two runs: 257 loads / 1.41 per s / 414 swaps come from
  the superseded `8005ea4` run (stall 9.4 ms, not the 6.0 quoted two lines above); "5,100 m"
  is the chase harness distance. Real M1 figures: 310 / 1.38 / 522 / 7,691 m.
- §1 "28.7 MB" -> recomputed **25.42 MB** (stale from a texture-shrink commit; errs against
  the project).
- §1 "covers every building" -> far-LOD only; near LOD uses the facade kit.
- §1 balconies: real, but survive the perf cap on only **6 of 523** buildings.

**MILESTONE-2.md**
- §1 overlap criterion -> **NOT MET**. 26.7% vs stub 27.0% like-for-like.
- §1/§2 "same-edge overlaps: 0 — eliminated" -> refuted at 7.
- §2 attribution of the 64.3% to junction capacity -> **wrong**; it is a reservation leak.
- §3 HUD attribution (8.1 off / 12.2 on) -> the claimed 4.1 ms effect is roughly a quarter
  of the within-condition spread. Not refuted, but not supported by two runs.

**PROGRESS.md**
- "Thresholds in force" block still publishes the superseded 260/400 and 900k/1.8M.
- "Critic rounds — *None yet*" is stale; the M1 round happened.
- Threshold change log is missing the `02ccfdf` gated-quantity redefinition.

---

## 9. What has to happen before either milestone can be re-claimed

Ordered by dependency, not by size. Status as of 2026-08-30.

| # | Item | Status |
|---|---|---|
| 1 | Junction reservation leak — release before overwrite, release on despawn | **DONE** — `holds` is now an array; `_releaseBehind` keeps the junction ahead. `junctionsHeld` 139→median 15 against 30 alive |
| 2 | Re-measure overlap through the drive-through harness, N>=5, restate with harness named | **DONE** — median 7.1% vs the stub's 27.0% in the same harness, −74%. Same-edge 0 across all five. `docs/measurements/junction-leak-fix.json` |
| 3 | Stall gate as a statistic over N>=5 | **PARTIAL** — methodology derived, logged in the ledger, and applied to both re-measurements (chase N=5: median 8.5 ms, p80 8.7, no FAIL in five). The harness still emits one sample per run; aggregating N runs inside the gate is not yet automated |
| 4 | Budget gate + lighting sweep into an aggregate script; real assertions in `physics-test.mjs`; WARN visible | **MOSTLY DONE** — `npm run gates` now runs all four gates with no output suppression and no unconditional success echo; `npm test` defined. `physics-test.mjs` has 10 derived assertions and was verified to fail when it should. **WARN still exits 0** and is not yet visible to automation |
| 5 | Saturation check on the sky dome; rebalance night skyglow; re-derive dusk exposure | **DONE** — mid-sky check added and verified to fire (1.70× at the old exposure). Night sky saturation 68.7%→14.5% against ground 44.3%. Dusk exposure re-derived 1/330→1/660; plaza 214→174, asphalt 173→134. Starfield reworked: density −40%, magnitude distribution steepened, horizon extinction added, gain derived against the bloom knee |
| 6 | AO / contact shadows | **OPEN** — the most-cited gap across both critic rounds |
| 7 | Geometry defects: floating cuboid, postless blade, unsupported canopy and awnings, untethered rooftop slab, sidewalk decal UV | **OPEN** |
| 8 | Ledger corrections | **DONE** — stale thresholds block, stale critic-rounds section, and the backfilled `02ccfdf` gated-quantity redefinition |
| 9 | CI (constraint 4) | **DONE** — owner approved the determinism split. `.github/workflows/gates.yml` is green on both jobs ([run 2](https://github.com/jeffhaines20/gpta-6/actions/runs/33332927114)). Static lane 13 s; geometry lane gates draw calls, triangles and heap while recording stall as advisory. Validated cross-hardware: triangles agree to 1.2% and draw calls to within 7% between this container and a hosted runner. `docs/measurements/ci-cross-hardware.json` |

**Still not signed off.** Items 6 and 7 are unaddressed, no critic has seen the
post-fix frames, and CI does not exist. What has changed is that both critical
measurement failures are corrected and the two M2 acceptance criteria that failed
now hold on evidence rather than on assertion.

**CI (constraint 4) needs your decision before I build it.** Adding `.github/workflows/`
starts consuming Actions minutes on your account, which the escalation rule puts to you.
There is also a design constraint: draw calls and triangles gate cleanly, but stall
milliseconds on a shared runner will flake, and a looser CI-only threshold would be
exactly the silent loosening constraint 4 prohibits. Recommendation is to hard-fail on
the deterministic metrics and record timing as reported-not-gating, with the split
derived and logged.

---

## 10. Process note

Three of these findings were sitting in committed evidence and were not read:
`junctionsHeld: 139` against `alive: 59`; a 27.0% stub run already in `docs/`; and a
`gates` script whose own text omits the budget gate. The reviewer round found them in
hours. The lesson is not that more review is needed in general — it is that **the
author of a claim is the worst available checker of it**, and the two milestones were
written without an independent pass. That pass is now part of the milestone procedure,
not an optional extra.
