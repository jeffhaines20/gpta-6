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
| 2026-09-01 | **drive-through + 30 traffic**, after the ground-contact shadow work | **WARN** (unchanged verdict) — draw p95 **167** (was 166), tris p95 **353,868** (was 350,597), stall **13.1 ms**, heap +6 MB | `docs/drive-traffic.json` |
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

## Open, measured, deliberately not fixed: noon is unusable

Flagged independently by the sky agent and the facade-glazing agent, then measured
at the fivepoints hero camera on 2026-09-01:

| | noon | dusk |
|---|---|---|
| frame p50 | **9.5** | 115.6 |
| frame p1 | 0.0 | 14.9 |
| sunlit sidewalk | 101.0 | 147.0 |
| left facade (vertical) | **6.1** | 100.0 |

**It is not an exposure fault.** If the stop were wrong the sunlit sidewalk would be
dark too, and at 101 it is close to correct. What is wrong is that every VERTICAL
surface is near-black: the preset puts the sun at `elevation: 1.32` rad = **75.6
degrees**, so a horizontal surface collects cos(14.4) = 0.97 of the 100,000 lux
direct beam while a wall collects almost none and falls back on skylight alone.
That is physically right for latitude 27 and visually unusable - no wall light, no
cast shadows, a flat black city under a bright pavement.

**Why it is not fixed here.** The remedy is a lighting-DESIGN decision (a game noon
is normally graded with a lower sun so walls catch light and shadows have length),
not a bug fix, and it changes the PMREM that lights the whole district. Noon is also
not in the critique set - constraint 3's two-times-of-day rule is being met with
dusk and night, which is what every critic round has judged. Given two lighting
constants were already adjusted this session on partial diagnoses and had to be
reverted, this one is recorded with its measurements rather than guessed at late.

Whoever takes it: lower `PRESETS.noon.elevation` first and re-measure the vertical
vs horizontal split before touching `exposure`. The lux values are inside the
plausibility envelope and are probably not the problem.

> **Update 2026-09-01.** Part of the "black facades" observation was not the elevation at
> all: `docs/shots/tod-noon.png` carried 20,920 literally black (0,0,0) pixels from a
> half-float overflow reaching ACES as NaN, now down to 1,036 after the `src/post.js` guard
> described under Golden hour. The elevation finding above still stands - a wall at 75.6 deg
> collects almost nothing - but the frame was ALSO being corrupted, and the two were being
> read as one defect.

## Golden hour: the hour that was missing, authored off our own atmosphere

The section below establishes that dusk cannot have legible ground shadows and that no
camera or azimuth change can give it any. The remedy was never to fix dusk - it renders
sunset correctly - but to author the hour every critique round was actually describing.
`PRESETS.golden` / `SKY_PRESETS.golden` is that hour, at **8.00 deg** of sun elevation.

**Every photometric number was read back out of `src/sky.js`, not from a textbook.** Set
the dome to 8 deg at turbidity 2.6 (the value `weather.js`'s clear state actually pushes -
see the finding below), refresh, and read `atmosphere`:

| quantity | source | value |
|---|---|---|
| direct normal illuminance | `SUN_ILLUMINANCE * luminance(t)` | **34,470 lux** |
| sky illuminance | cos-weighted hemispherical integral of the dome | **8,519 lux** |
| zenith / horizon | probe read-back | 1,434 / 7,907 nits |
| sun colour | the transmittance `t` itself, `[0.4168, 0.2442, 0.0982]` | `0xffc985` |
| sky colour | the dome's own cos-weighted upper-hemisphere colour | `0xb9d5ff` |

The 8 deg suggestion came with an arithmetic prediction of 31,500 lux from Kasten-Young air
mass 6.857 at tau = 0.21. **Our model says 34,470 - 9.4% brighter, and the model wins.**
Recorded rather than split: the same model puts 9,319 lux at dusk's 3.15 deg, against the
~8,800 `sky.js`'s own comment quotes, so it is self-consistent at both ends.

### Acceptance

`SHARE_TOD=golden node tools/sun-share.mjs`, corridor camera, traffic and pedestrians
frozen, noise floor 0.08 measured first:

| | sun's share of the road | geometry blocks | road band | clipped |
|---|---|---|---|---|
| **golden** | **26.5%** | 15.7% | 122.0 | **0%** |
| noon | 83.8% | 0% | 58.3 | 0% |
| dusk | 2.3% | 100.6% | 98.3 | 0% |

Band means are not the question a critic asks, though. Differencing the authored frame
against the same frame with `shadow.intensity = 0` gives the shadow's actual footprint:

| hour | road pixels darkened >8/255 by cast shadow | mean depth where shadowed |
|---|---|---|
| **golden** | **21.0%** | **23.2/255** |
| dusk | 1.9% | 12.3/255 |
| noon | 0.0% | 13.1/255 |

Eleven times dusk's shadowed area at nearly twice the depth. Frames in
`docs/shots/golden-{corridor,fivepoints}-golden.png`; the fivepoints frame has its
left-hand block as a warm key at cos(46 deg) of full beam and its right-hand block on fill
light only, which is the wall-to-wall separation noon cannot produce at 75.6 deg.

Gates: syntax PASS (74 modules), golden-trace PASS (30 samples), physics PASS (10 checks),
lighting sweep **PASS - all 4 times of day inside the plausible envelope**, negative test
still fires.

### Three things the authoring turned up, all measured

**1. `scene.environmentIntensity` is 1.0, so the sky is delivered twice - and it caps any
sun's share of the road.** `sky.js` recommends 0.35 precisely to avoid double-counting the
HemisphereLight; `daynight.js.apply()` restores 1.0 afterwards, deliberately, with a
comment about walls at noon. Isolating each source at the corridor camera (each switched
off in turn, differenced in exposed units, the three summing to 0.1806 against a measured
total of 0.1760 - additive to 3%, so the split is real):

| source | contribution to the road |
|---|---|
| PMREM environment | **0.0867** |
| HemisphereLight | 0.0494 |
| sun | 0.0445 |

The environment alone outweighs the sun and the hemisphere separately. The atmosphere's own
sun share at 8 deg is 36.0%; the district renders 26.5% because of this. Not fixed here -
it is a district-wide decision with a stated reason - but the golden exposure is derived
against the illuminance the engine actually delivers rather than the one the sky measures,
because pretending it is not there is what makes a stop wrong.

**2. `intensity` is not the illuminance, and `audit()` now says so.** three.js hands the
shader `color * intensity` as irradiance, so a light of intensity E delivers
`E * luminance(color)` lux, and `luminance(color) < 1` for every colour that is not white.
The file header has promised "intensity -> lux" since Phase 1 and that promise is only true
for a white light. Verified in the running district by forcing the sun's colour to white at
a fixed intensity: the road goes 139.5 -> 147.1 of 255 and the sun's own contribution
0.0445 -> 0.0670, a factor of **1.506** against the 1.542 that 1/0.6487 predicts.

`audit()` now reports `sunLuxDelivered` / `skyLuxDelivered` beside the authored values.
**Reported, not gated** - the envelope still judges the authored number, so no existing
verdict moves. Golden is authored to deliver correctly (intensity 53,138 x 0.6487 = 34,394
lux measured); noon delivers 93,080 of its authored 100,000 and dusk 498 of its 1,200, and
neither was touched.

**3. `SKY_PRESETS.turbidity` has been dead in the game since weather landed.**
`weather.js._push()` runs every frame and calls `sky.setTurbidity(2.6)` for the clear state;
`setTimeOfDay()` will not overwrite an override. Measured at all three existing times of
day in `docs/fglass-audits.json`: `turb 2.6` on every row, not the 2.4 / 3.2 / 2.8 the
presets author. `golden` is therefore authored at 2.6 - the atmosphere that actually
renders - and the other three are left alone.

### A pre-existing black hole in the frame, found by an incoherent number

`sun-share` reported `sunPotentialOnFacade: -19.7` - the facade band getting BRIGHTER when
the sun is switched off, which is impossible. It was not impossible; it was reporting a
real defect. `docs/shots/share-golden-authored-base.png` had a 33,352-pixel **pure black**
blob on a sunlit tower, present with the shadow map disabled and absent with the sun off,
and switching bloom off did not remove it.

Reading the scene HDR target directly: **14,259 NaN channels, 8 Inf, and a finite maximum
sitting exactly on 65,504** - half-float's ceiling. The district is authored in absolute
nits, so a metallic pane reflecting the PMREM (whose own ceiling is `sky.js`'s
`maxRadiance` of 60,000 nits) plus a specular lobe from a 34,470 lux sun overflows the
target. `aces()` is `clamp((x(ax+b))/(x(cx+d)+e))`: hand it Inf and it computes Inf/Inf, and
`clamp(NaN)` is 0 on this rasteriser.

**This is not new and not golden's.** `docs/shots/tod-noon.png` on the committed build has
**20,920 pure-black pixels, 1.79% of frame**, and several critic rounds have described noon
as having black facades. Dusk has none - at 1,200 lux nothing gets near the ceiling.

Fixed in `src/post.js` with a NaN/Inf guard where the composite and the bright pass sample
the scene (`lessThanEqual` is false for NaN and for Inf alike, so both land on a 60,000
ceiling; finite pixels are returned unchanged). After: **0 pure-black pixels in all three
golden frames and in both golden hero frames**, and `sunPotentialOnFacade` reads +16.8
instead of -19.7. Noon goes **20,920 -> 1,036** (0.089% of frame): the 33k-pixel blob is
gone, and what is left is two small localised clusters that are as likely to be genuinely
unlit geometry rounding through the dither as another overflow. Not chased further - it was
not what this work was for, and the claim here is the measured 95%, not zero.

No threshold moved and no gate verdict changed - this is a renderer bug, not a gate - but
it does change what noon renders, which is why it is logged here rather than left in a
commit message.

`src/post.js` is outside the set of files this work was scoped to; it was touched because a
black hole in the hero frame is not shippable and the same guard fixes noon.

### Still open

`tools/sun-sweep.mjs`'s `BASE = { dusk: 2.72, noon: 0.6, night: 4.1 }[TOD]` has no `golden`
row, so `SWEEP_TOD=golden` would sweep from `undefined`. Left alone deliberately: another
session has uncommitted edits in that file and staging it would have committed their
work-in-progress. One line, `golden: 0.768`.

## Dusk cannot have legible ground shadows, and the reason is photometric

Round 5's dusk critic gave one change: *"make the sun's occlusion visible on the ground
planes — and if the sun is currently near-axial with the camera, move its azimuth 40–70°
off the street's centreline so that it can be."* The sky agent independently measured that
both hero cameras look 156–172° away from the sun. I agreed with both and planned a third
hero camera. **All three of us were wrong**, and this time the audit came before the fix.

`tools/sun-sweep.mjs` swept the dusk sun through a full 360° at the corridor camera,
rendering each azimuth twice — differing only in `sun.shadow.intensity`, a uniform, so no
shader recompiles and no second system moves — and differenced the frames. The difference
*is* the occlusion.

| Sun azimuth | Off the lens | Ground delta | Ground pixels shadowed |
|---|---|---|---|
| **156° (authored)** | 172° | **3.09** | **23.7%** |
| 276° | 68° | 1.99 | 15.0% |
| 336° | 8° | 3.55 | 33.1% |

The authored azimuth is already the second-best of twelve. The whole 360° spread is 1.99
to 3.55 — a factor of 1.8, not the difference between "hidden" and "visible". Shadows were
never hidden by the sun's bearing.

`tools/sun-share.mjs` found what actually caps them. Same camera, traffic and pedestrians
set to zero, and a **noise floor measured first** by capturing the same untouched frame
twice (0.00 — nothing moves). Then the sun's contribution is isolated:

| | Sun's share of the road | Blocked by geometry |
|---|---|---|
| **noon** | **83.7%** (65.5/255) | 23.2% |
| **dusk** | **1.9%** (2.4/255) | 83.8% |

Noon is the instrument's positive control: the sun there owns five-sixths of the road, so
the probe can plainly see a sun when there is one. At dusk it owns **1.9%**. The geometry
is already blocking 83.8% of it — the shadowing works, there is simply almost nothing to
block. A *perfect* shadow removes 2.4/255 from a 124/255 road: under 2%, below what any
critic can see, at any azimuth, from any camera.

The arithmetic agrees. Dusk authors `sunLux: 1200` at `elevation: 0.055` rad, so the sun
puts 1200·sin(3.15°) = **66 lux** on the road against ~900 lux of sky. The preset is
internally inconsistent about the hour it describes: `src/sky.js` already says, in its own
comment, that 3.15° of elevation transmits about **8,800** lux, not 1,200. Dusk is authored
as *sunset* — sun on the horizon, sky-dominated, flat ground — and it renders that
correctly. What every critic keeps asking for is *golden hour*, which is a different hour.

**So the round-5 ONE CHANGE is unachievable as stated, and no camera change can achieve
it.** Not fixed by moving the sun; addressed by authoring the hour that was missing.

### What this cost, and the metric that was wrong

The first version of `sun-share.mjs` compared the authored frame against the sun-off frame
and reported the shadow removing **666% of the light the sun put down** — impossible. The
frames were correct; the subtraction was not. At this camera the visible road is *already*
in shadow, so switching the sun off changes nothing there, and the sun's contribution only
appears once the shadow is lifted. The unoccluded frame is the reference, not the authored
one:

    potential = noshadow − nosun     the sun's full contribution, nothing blocking
    blocked   = noshadow − base      how much of it the geometry actually takes

An incoherent number is a gift — it is the measurement telling you it was read wrong. The
run before that one had no noise floor and no frozen traffic, and its numbers were the
same shape; had the metric been merely *plausible* instead of impossible, it would have
shipped.

## sun-share was measuring scenes that had not finished loading

The ground-contact build reported the geometry blocking 15.7% -> 25.2% of the sun at
golden hour. My independent re-run of the same tool on the same commit said **0%**, with
the sun's share of the road reading 53.7% instead of 26.5%. One of us was wrong about a
number neither of us had reason to doubt.

Neither. **The tool was.** `sun-share.mjs` waited a fixed 14 s after placing the camera
and then measured. Watching the streamer at that camera:

    t=32s   89 chunks, 264 meshes, 94 loads   <- and unchanged at every poll to t=162s

It settles at about 30 seconds, so a 14 s wait samples a half-built district - a different
half each run. That is why the same commit read 26.5%/15.7% once and 53.7%/0% the next
time. It also explains the `world chunk 7 / 110` figure in the Round 6 audit above, which
the ground-contact build re-measured as **57 / 259** once settled; the `0 / 42` props
figure was taken from the same unsettled scene and happened to be right.

Fixed by settling on the loaded count holding still across four consecutive polls. The
first attempt waited for `queued === 0` and timed out after four minutes on a scene that
had been static for three and a half of them - **the queue never drains**: it sits at
69-81 forever while chunks, meshes and loads stop moving. That stuck counter is a real
defect in `streaming.js` stats, found by accident, and is not yet chased.

Re-measured on settled scenes, two runs of golden agreeing to the digit:

| hour | sun's share of the road | blocked by geometry |
|---|---|---|
| noon | 84.2% | 1.2% |
| **golden** | **26.5%** | **25.2%** |
| dusk | 2.0% | 97.4% |

The ground-contact result is confirmed exactly as the build reported it. And the
foundational claim this project's golden-hour work rests on survives: dusk puts 2.0% of
the road's light in the sun against golden's 26.5%, a factor of 13.

**Every earlier number from this tool was taken on an unsettled scene** - dusk 1.9%/2.3%,
noon 83.7%/83.8%, golden 26.5%. They land close to the settled values, which is luck
rather than method: the near ground the tool samples loads first. The lesson is the one
already in this ledger under "Sampling integrity", arriving this time as *when* the sample
was taken rather than *what* was in it.

## Round 7, art critic: right about the look, wrong about the cause, in its own boxes

The round-7 art director gave a single change - "raise the sun elevation for golden and
dusk so direct sunlight actually lands on horizontal surfaces" - resting on two claims:

1. "The ground plane receives no direct sunlight."
2. "Nothing casts a shadow onto flat ground, in any of the four daylight frames."

Both were tested by toggling only `sun.intensity` and `sun.shadow.intensity` on a settled
scene, sampling **the critic's own regions**:

| its region | base | sun off | shadow off | sun contributes | shadow removes |
|---|---|---|---|---|---|
| near sidewalk (250,800,120x40) | 162.0 | 139.2 | 169.4 | **30.2** | 7.3 |
| plaza mid-right (1000,570,120x30) | 131.0 | 117.3 | 153.5 | **36.2** | 22.5 |
| its F2 scanline band (150,790,410x40) | 162.6 | 140.7 | 168.2 | **27.5** | 5.6 |

On its own scanline at y=810, the deepest pixel the shadow actually removes is **30.6** -
above the ">25 step" it reported as absent.

**So the ground receives about a fifth to a quarter of its light directly from the sun,
and cast shadows do land on it.** What the critic actually measured - ground reads blue
(B-R +12 to +46), sun-facing walls read warm (B-R -32 to -46) - is correct and useful.
The inference from it is not. At 8 degrees elevation a horizontal surface takes
sin(8) = 0.139 of the beam while a sun-facing wall takes ~0.99: the wall gets seven times
the direct flux, so the sky dominates the GROUND'S HUE while still supplying only three
quarters of its light. That is what golden hour does, not a bug.

Its proposed change would also fail its own test #4, "the sky must not change" - moving
the sun moves the sky.

### What survives from it, and is worth acting on

- **The golden sky's warm end is bleached.** Measured across the top of `corridor-golden`:
  B-R +64 at x=480, +62 at x=640, -7 at x=880, -14 at x=1520. The blue-to-warm horizontal
  gradient is real and correct - the critic explicitly checked several columns, having been
  warned about the single-column error, and caught that the previous round's "no blue
  anywhere" claim was a sampling artifact. But the warm end sits at chroma **0.064**, i.e.
  near-neutral grey. The sky runs blue-to-grey rather than blue-to-gold.
- **Golden is the least colourful daylight state.** Whole-frame mean chroma: corridor-golden
  **22.3**, fivepoints-golden 31.8, corridor-dusk 37.7, fivepoints-dusk 38.7.
- **Street lamps are emissive at dusk but emit no light.** Pavement directly under the lit
  lamp head measures 108.2 against 134.7 and 163.0 either side - darker under the lamp.
  At night the same test gives +20/25 with a real falloff and a cast pole shadow. This is
  the second round running that a critic has found a lamp glowing without lighting.
- **The road speckle boundary is neither shadow nor paint.** High-frequency energy 5-15
  above y~730 and 30-50 below, with the zebra bars crossing the boundary unbroken and the
  paint reading BRIGHTER below it. That rules out both readings and points at a detail
  layer fading in at a fixed radius - which matches the aliasing already logged.

The critic also volunteered that it had twice caught itself misreading its own crops. That
is the behaviour worth having.

## The budget gate could not see the shadow pass, and fixing that turned it red

`src/post.js` read `renderer.info.render.calls` after `renderer.render()`. three.js does
this, in that order:

    beginShadows(); shadowMap.render(...); endShadows();
    this.info.autoReset === true && this.info.reset();

It counts every shadow-map draw call and then **wipes the counter before the opaque
pass**. So the gate has always sampled the colour pass alone. The ground-contact build
proved it without meaning to: casters went 84 -> 331 and the gate's draw-call number did
not move by one.

Fixed by taking `info.autoReset` ourselves and resetting once at the top of
`PostStack.render()`, before anything draws. The read still happens before the post
blits, so full-screen quads stay in `passes` rather than being smuggled into geometry.

**The honest cost, same commit, three circuits with traffic:**

| | was (colour pass only) | now (shadow + colour) |
|---|---|---|
| draw calls p95 / max | 167 / ~180 | **228 / 241** |
| triangles p95 / max | ~351,000 | **726,597 / 760,689** |

The shadow pass roughly doubles submitted triangles, which is what re-submitting the
casting geometry costs.

### Threshold change log entry: drawCalls and triangles, 2026-09-01

The gated quantity changed, so the thresholds had to be re-derived (binding constraint
4). Derived two ways and the **tighter taken for each**, so this cannot be a quiet
loosening:

- (a) this file's own documented rule, warn ~1.6x and fail ~2.5x the measured worst:
  draw 386 / 602, triangles 1,217,000 / 1,902,000.
- (b) preserving the headroom the project has been operating under - old p95 sat at
  0.835 of warn and 0.522 of fail for draw calls, 0.878 and 0.390 for triangles:
  draw 273 / 437, triangles 828,000 / 1,863,000.

Adopted: **drawCalls 275 / 440**, **triangles 830,000 / 1,850,000**. Both now PASS with
48% and 61% headroom. Noted while deriving: under (b) the triangle warn had only **13%
headroom left on the old metric**, so it was close to firing on ordinary content growth
before any of this.

### ESCALATION - condition (a), raised and RESOLVED: the stall metric was the shadow map

The chunk-stall metric has failed **three times in seven runs** since the ground-contact
work landed, which is escalation condition (a): a budget gate failing twice after a
documented strategy change.

| build | runs | worst |
|---|---|---|
| before ground contact | 10.9, 8.3, 9.4, 8.2, 8.3, 9.7, 10.3, 12.2 | 12.2, never a FAIL |
| after ground contact | 10.1, 15.8, **23.5**, **17.1**, **17.1**, 11.8, 10.9 | three FAILs (>= 16) |

The change that plausibly causes it: the shadow map went 2048 -> 3072 (2.25x the texels)
and casters 84 -> 331. This container renders through SwiftShader, which rasterises on
the CPU, so shadow-map rasterisation competes for the same core as the streaming slice
the metric measures. On real GPU hardware that work is not on this thread and would
likely not touch this metric at all - **but that is a hypothesis, and this project's rule
is that a hypothesis does not get to dismiss a red gate.**

**No threshold was touched.** Escalated, and the answer was to isolate before choosing a
remedy rather than act on the SwiftShader hypothesis. `DRIVE_SHADOW` on the drive-through
harness makes the variants testable; each one prints the state it actually reached,
because a switch that silently does nothing has already cost this project a day.

| variant | chunk stall, three runs each | FAILs |
|---|---|---|
| 3072, casters on | 10.1  15.8  23.5  17.1  17.1  11.8  10.9 | **3** |
| shadows off | 8.6  9.6  7.9 | 0 |
| **2048, casters on** | **9.2  8.4  10.4** | **0** |

**It is the map size, not the caster count.** At 2048 every caster and the tightened
extent are kept, draw calls stay at 228, and the stall returns to its old band. 3072 is
2.25x the texels, and SwiftShader rasterises them on the CPU that also runs the streaming
slice this metric measures.

The resolution that mattered came from the extent, not the map: at +/-120 over 2048 a
texel is 240/2048 = **0.117 m**, still 2.17x finer than the 0.254 m that made a pedestrian
2 texels wide and un-castable. A pedestrian is now ~4.3 texels, a bollard ~1.3.

**Resolved.** Applied 2048; the ground-contact result survives almost intact - geometry
blocks **24.3%** of the sun at golden hour against 25.2% at 3072 and 15.7% before the
work. Gate over three runs: **PASS / WARN / WARN**, stall 7.4 / 8.0 / 8.2, no FAILs, and
7.4 is the lowest stall reading recorded this session. The shadows-off control also
independently confirmed the blind-spot fix: with the pass disabled the gate reads 165
calls and 351,781 triangles, which is what it used to report with shadows ON.

## Round 6: three blind critics, one agreed change, and the audit that found its cause

Six frames (corridor + fivepoints x golden/dusk/night, HUD hidden, each paired with its
audit - `implausible 0` at every hour). Three blind critics, none told what had changed.

**Two independently gave the same single highest-leverage change: objects have no ground
contact.** Cars, bins, posts, planters, pedestrians and the player sit *on top of* the
ground rather than in it.

The two disagreed on the evidence, and the more careful one was right. The art director
measured "nothing casts a shadow in any of the six frames" - too strong. The environment
artist measured that **real sun shadows DO exist**: long sharp signal-mast shadows
crossing the crosswalk at (680-800, 670-800) and (860-940, 655-800) in
`r6-corridor-golden.png`, while cars, bins, posts and pedestrians produce nothing. That
reconciles with my own `sun-share` reading of 15.7% of the sun blocked over 21% of road
pixels at golden hour - those were the masts and the buildings. **A critic measurement is
evidence, but two critics measuring the same pixels can still disagree; the one whose
claim was narrower was the one that held.**

The scene-graph audit found the cause, and it is two causes:

| category | casters / meshes | instances |
|---|---|---|
| `mesh: props` | **0 / 42** | - |
| `instanced: furniture` | **2 / 4** | 1,659 |
| `world chunk (buildings/road)` | **7 / 110** | - |
| `instanced: pedestrians` | 6 / 7 | 440 |

1. **`castShadow` is not set on most of the scene.** Zero of 42 prop meshes, half the
   furniture batches, and 7 of 110 chunk meshes.
2. **The shadow map cannot resolve street-scale objects even where it is set.** The
   directional light runs a 2048 map over a camera spanning left -260 to right +260:
   520 m across 2048 texels = **0.254 m per texel**. A bollard (~0.15 m) is 0.6 texels
   and can never appear; a pedestrian (~0.5 m) is ~2 texels, which is why peds cast
   nothing *despite being flagged as casters*. A car at 4.5 m is ~18 texels, so its
   absence is cause 1, not cause 2.

> **Corrected by the build that acted on this** - see "Ground contact: a missing flag, a
> texel too coarse, and a shadow that was a crossing" below. Two things in the block
> above did not survive re-measurement. (a) The "long sharp signal-mast shadows crossing
> the crosswalk" are the zebra crossing's white bars over dark aggregate: capturing that
> frame with `shadow.intensity = 0` moves both named boxes by **0.00** of 255, so there
> was no cast shadow at either, and the narrower critic claim was not the one that held
> either. (b) `world chunk 7 / 110` was a scene that had not finished streaming; at the
> same camera with the mesh count settled it is **57 / 259**, and `_buildUnused` is dead
> code. The two causes themselves are both real and both are now fixed. Cause 1's
> `0 / 42` props is exact.

Scheduled as builder work with the critics' own falsifiable predictions as the acceptance
test, and with their named regressions guarded: the fivepoints-night lamp pools and the
corridor-night window spill are the best things in the set, and `r6-corridor-night.png`
is already 27% crushed at luminance <= 6.

### The third critic: same one change, and two colour claims that did not survive

The lighting/materials critic independently gave the SAME single change - shadows and
ground contact - making it **three for three**. Its supporting measurement is the
sharpest of the set: the road patch where the red car's shadow should fall in
`r6-fivepoints-dusk` reads L 99.0 against three same-depth controls at 108.5 / 96.0 /
100.5, with a road texture sd of ~30. The shadow is inside the noise. It also caught a
detail the others missed: in `r6-corridor-golden` the signal **gantry arm casts** while
the **vertical poles directly beneath it do not** - which points at caster inclusion or
bias rather than a missing feature, and matches the audit's 0-of-42 props.

Two findings of its own worth keeping:

- **Glass is not behaving as glass.** The same tower pane tracks the diffuse wall beside
  it to within 2% across a 0.62x change in level (golden 202.1 vs 202.9; dusk 123.7 vs
  125.9). A dielectric is driven by what it reflects, which moves independently - and the
  sky over that span went UP while the pane went down. This is after the glazing F0
  rework, so that fix did not reach these panes.
- **Some night lamps are emissive with no light.** The corridor-night lamp head at
  (1213-1240, 440-480) throws no measurable pool on the pavement below, while the
  fivepoints-night lamps do. Candidate cause: the nearest-N pool (10 real lights over
  ~1000 emitters) not selecting it. Not yet audited.

**Two colour claims did not survive checking, and the reason is sampling.** The critic
measured one sky column at x=1420 and concluded that "golden is not golden" (R-B +13 to
+16, warm-neutral where a golden zenith should be blue) and that dusk is "a flat uniform
orange wash" with no vertical gradient. Sampling three columns instead of one:

| frame | x=200 | x=700 | x=1420 |
|---|---|---|---|
| golden, R-B at y5 / y120 | +66 / +41 | **-62 / -42** | +13 / +12 |
| dusk, R-B at y5 / y120 | +64 / +54 | **-29 / -6** | +61 / +57 |

The clear part of the dome at x=700 is strongly blue at golden (-62) and blue at the dusk
zenith (-29) rising to +40 lower down - the ozone gradient is present and doing its job.
x=1420 is the hazy, sun-side column and x=200 is largely the tower facade, not sky. **The
critic's method was sound and its sample was not representative** - the same failure this
ledger already documents twice under "Sampling integrity". Its measurements are still
evidence; they are evidence about x=1420.

What DOES survive from its colour work, because it is sampled across many patches rather
than one column: at dusk every vertical surface is warm (R-B +24 to +77) while every
ground surface is cool (-13 to -22). That split is mine - it is the ambient wave that
drove sidewalk R-B from +17.6 to -10.7 and road from +8.0 to -22.1 to fix three critics
reporting "nothing in the image is cool". It is physically defensible (a horizontal
surface sees the whole dome, a sun-facing wall sees the orange horizon), but it is worth
re-checking whether it went too far.

### The white rectangle - a strong hypothesis, recorded before it is tested

Both critics independently found a hard-edged, flat, achromatic white rectangle at
roughly (193-290, 349-400) on the corridor tower, **present at golden hour and absent at
the same pixels at dusk and night** (169.7 -> 168.7 at dusk; 42.3 -> 41.0 at night - no
edge exists there). One-pixel transition, no bloom falloff, screen-axis-aligned while the
facade recedes. Both said explicitly that they could not determine the cause and that
nothing should be fixed on their say-so. They were right to.

**My hypothesis: it is the NaN/Inf guard added to `src/post.js` this session, working as
written.** That guard was added after measuring 14,259 NaN channels and 8 Inf in the
scene target at the corridor camera **at golden hour**, with the finite maximum sitting
exactly on 65,504 - a half-float overflow where a metallic pane reflects the PMREM under
a strong low sun. `sanitize()` maps every non-finite channel to `CEIL = 60000.0`, which is
far above the ACES shoulder and therefore clips to pure white. The guard turned a
pure-BLACK blob into a pure-WHITE one. That is an improvement - a blown highlight is
physically white and a hole is not - but the overflow is still there, and it is now the
brightest object in the frame.

Consistent with every measurement the critics took: golden-hour only (the overflow is
exposure-dependent), achromatic, flat, hard-edged, and exactly where the NaNs were
measured.

**The test, not yet run:** make `sanitize()` return an unmistakable debug colour for
non-finite input and re-capture the golden corridor frame. If the rectangle turns that
colour it is confirmed, and the fix is to stop the overflow - or clamp to a ceiling that
rolls off through the tonemapper - rather than to clamp to white. Unrun only because
`src/post.js` is in a builder's hands as I write this.

## The chunk-stall WARN is not the HUD, and not the build budget either

The ledger has carried a number since the M2 gate — HUD off 8.1 ms, HUD on 12.2 ms —
and drew from it the recommendation "reduce HUD per-frame allocation and re-measure".
No harness could reproduce it, because nothing in `tools/` had ever called
`setHudEnabled`. `DRIVE_HUD=off` now makes it testable. Three runs each, same build,
nothing else on the machine:

| | runs | median |
|---|---|---|
| canvas HUD on | 10.9, 8.3, 9.4 | **9.4** |
| canvas HUD off | 8.2, 8.3, 9.7 | **8.3** |

**The 4.1 ms gap does not reproduce.** The whole canvas HUD is worth about 1 ms with
the distributions overlapping, and — the part that settles it — **with the HUD entirely
disabled the gate still WARNs at 8.2, 8.3 and 9.7**. No amount of HUD work reaches this
threshold, so none was done.

Two other candidates died the same way:

- **`world.report()` per frame.** It traverses every loaded chunk to count triangles
  and main.js calls it every frame for a debug line, which looked damning. Measured:
  **0.01 ms** over 112 meshes, and no measurable heap delta over 200 calls. Irrelevant.
- **`_dispose` at ~8 ms**, the ledger's other stated dominant term. Measured
  `worstDisposeMs: 0` — though with `unloads: 0` in that probe, so this is ruled out
  only for the load path, not under the gate's own three-circuit drive. Still open.

What the slice actually is: `scan + budgetMs + one work-unit overshoot`. The deadline
is checked BETWEEN units, so the last unit always runs past it. Measured worst scan
2.0 ms, worst upload 2.8 ms, budget 3 ms — a structural floor of 7.8 ms against a warn
threshold of 8. The metric has been sitting on its own design limit.

That suggested lowering `budgetMs` from 3 to 2, which is defensible on its own terms
(3 ms is 18% of a 60 Hz frame). **It made things worse: 7.1, 16.4, 11.0 — a median of
11.0 against the baseline's 9.4, and one outright FAIL.** Reverted. The FAIL was
produced by my own experiment and does not count toward escalation condition (a); the
shipped build has never failed this gate.

The real lesson is about the instrument. Across every run this session the metric spans
**7.1 to 16.4 ms** on an unchanged build. n=3 cannot separate a 1 ms effect from that,
and the ledger's original 8.1-vs-12.2 was almost certainly two samples of this same
spread read as a signal. **Before any further work on this gate, the metric needs enough
samples to have a distribution rather than a number** — and the honest reading today is
that chunk stall is a WARN whose cause is not established.

## The `roadMarkings` material is dead, and the defect blamed on it is not explained

The pedestrian build reported that road markings draw through near pedestrians, and
named the cause: `polygonOffsetFactor: -3` on `roadMarkings`, whose slope-scaled term
explodes at a grazing angle. The frame it pointed at genuinely shows two pale bars
crossing a pedestrian's chest and shins, so the defect is real. **The diagnosis is not.**

Three measurements, in the order they should have been taken:

1. Changing the offset to `factor 0` and regenerating the frame produced a
   **byte-for-byte identical pedestrian**. The bars did not move.
2. A probe that toggled the marking material's visibility produced an **identical
   frame** — the control I should have run first. The instrument could not produce
   the opposite reading, which voids the bleed table I had already measured with it
   (`64 → 4 px` over a furniture mask across five offset settings). Those numbers are
   discarded, not reinterpreted.
3. Enumerating the live scene: **`meshesUsingIt: 0`.** No mesh anywhere uses it.

The cause is a silent key mismatch. `streaming.js::_roadMesh` builds the carriageway
ribbon with `this.materials.markings ?? this.materials.road`, and
`MaterialRegistry.streamingMaterials()` returns exactly `building, road, land, ground,
water`. There has never been a `markings` key, so the `??` has always taken its right
branch and every road ribbon has rendered with the plain road material. The material
built in `_buildMarkings()` — its transparency, its `depthWrite: false`, its polygon
offset — has never reached a pixel.

The markings that ARE visible come from `applyRoadMarkings` compositing them into the
road's own shader, off the mesh UVs `applyMarkingUV` writes. That refactor is the one
whose comment says "so roads stay ONE opaque draw"; the standalone material is what it
left behind. So this is dead code rather than a bug in the picture — but a `??`
fallback is why nobody noticed, and it is the third time this session a value that
looks authoritative turned out never to be read.

**The bars are still unexplained.** The `kerb` material is `0xd8d4cb` and `kerbPainted`
is `0xe8b53a`, which match the pale bars and the yellow line under them, so kerb
geometry is the next thing to rule in or out — but that is a hypothesis, and it is
recorded here as one. Nothing was changed on the strength of it: the offset edit was
reverted, because a change that fixes nothing and is justified by a void measurement is
worse than the defect it was aimed at.

## Ground contact: a missing flag, a texel too coarse, and a shadow that was a crossing

The builder's half of the round-6 entry above. Three blind critics agreed that cars,
bins, posts, planters and the player sit ON the street rather than in it, and all three
called it the single highest-leverage change in the set. The observation is right. One
of the facts offered in support of it is not, and it had to be cleared before anything
could be fixed.

### The "long sharp signal-mast shadows" are the zebra crossing

The round's strongest evidence was that the shadow pass demonstrably works and is
*selectively* empty: long sharp mast shadows cross the crosswalk at (680-800, 670-800)
and (860-940, 655-800) in `r6-corridor-golden.png` while cars and bins produce nothing.

Measured, by capturing that frame twice with nothing moving and
`DirectionalLight.shadow.intensity` set to 0 for the second: those two boxes move by
**0.00 and 0.00** of 255. There is no cast shadow at either. What is there is the
crossing's white bars over the road's dark aggregate, read at critique scale as shadow
bars raking across the carriageway. The rest of the frame moves by 5.95 mean, so the
instrument was working and the toggle was real - see `docs/shots/share-golden-*.png`
for the same pair.

This matters beyond the correction: taking that claim at face value means believing the
pass reaches the near pavement and something object-specific is wrong. It does not reach
it. Where the pass IS working at this camera is the left tower's facade and the
mid-distance carriageway, both far behind the objects under discussion.

Filed under the existing rule: **a blind critic's OBSERVATION is reliable evidence and
its INFERRED CAUSE usually is not.** This is the first time the ledger has caught the
inference wrong in a *supporting measurement* rather than in a diagnosis.

### Cause 1 - the whole street-dressing kit was flagged not to cast

`src/streetfurniture.js` welds 4,596 props into spatial buckets and set
`castShadow = false` on every one of them, with a comment giving two reasons: a far
bucket is 512 m and the shadow camera was 520 m, so every bucket would render into the
map; and the SSAO pass already draws these contacts. Both were tested.

The first is wrong because `cullProps()` already sets `visible = false` past each tier's
cull distance, and three.js skips an invisible object in the shadow pass exactly as it
does in the colour pass. At the corridor hero camera with traffic and the crowd frozen,
this change takes the shadow pass from 84 caster meshes of 338 to 128 - the buckets
actually in range plus the two lamp batches - not to the whole 4,596-prop kit.

The second is the interesting one. Switching `aoEnabled` off lifts the bin box at
(1250-1325, 578-660) from 53.0 to 71.3 of 255: the AO term is worth **18.3** there,
more than any cast shadow in the frame, and at the fivepoints camera it is worth 25.3
on the parked car and 20.6 on the storefront. So AO was reaching these contacts. What
it is not is directional - a 2.2 m screen-space hemisphere puts a soft halo around an
object and its surroundings alike, with no edge running away from the sun and nothing
anchoring the object to one spot on the paving. The old comment's premise was right and
its conclusion was wrong, and that is why **no AO change was made**: the pass named in
the round-6 brief as the fallback is already the strongest darkening in these frames,
and turning it up is the named way to wreck the night lamp pools.

### Cause 2 - 0.254 m per shadow texel

A 2048 map over a +-260 ortho camera resolves 0.254 m per texel, and PCF needs roughly
two texels of contiguous occlusion to survive filtering. That puts a bollard (0.15 m) at
0.6 texels and a bin (0.5 m) at 2. Neither can produce a shadow whatever flag it carries.

The extent was tightened rather than only raising the map, and what that costs was
measured first, because it is the half of this change that can lose something. Same
method as `tools/sun-share.mjs`, per horizontal band, props casting in every row:

| extent x map | m/texel | facade band | mid band | near band |
|---|---|---|---|---|
| 260 x 2048, as shipped | 0.254 | 7.02 | 21.32 | **2.91** |
| 260 x 2048 + props cast | 0.254 | 7.05 | 21.50 | 6.68 |
| 260 x 4096 | 0.127 | 7.28 | 21.68 | 6.02 |
| 180 x 2048 | 0.176 | 7.18 | 21.59 | 6.60 |
| 120 x 2048 | 0.117 | 7.27 | 21.61 | 6.25 |
| 150 x 4096 | 0.073 | 7.35 | 21.61 | 6.82 |
| 90 x 2048 | 0.088 | 7.01 | 21.63 | 6.21 |

Each cell is the mean luminance the shadow pass removes from that band. The **mid band**
is the one a tighter camera was expected to cost - the far half of the carriageway,
where distant buildings throw their shadows - and it does not move: 21.32 to 21.63 all
the way down to +-90. The reason is the streamer. Near chunks run to nearRadius 2 x
chunkSize 128 = +-320 m around the viewer, so a +-120 shadow box sits entirely inside
full-detail geometry, and every caster that was reaching the frame still is.

It is also worth stating what S bounds, because it is not shadow length. The ortho box's
lateral axes are perpendicular to the light ray: one across the sun's bearing and one
near-vertical. A ground point d metres up-sun sits only d*sin(elevation) = 0.14d along
the near-vertical axis at golden hour, so S admits casters hundreds of metres up-sun and
the up-sun limit is `near`, not S. S bounds the ACROSS-SUN slab.

Shipped: **3072 over +-120, 0.078 m/texel**, 3.25x finer. Not the +-90 that also measured
clean - 90 was the tightest extent the probe happened to test, at one camera and one
azimuth, and an extent chosen at the edge of its own evidence is how a shadow volume
pops on a street the probe never stood in. Not 4096 either: 3072 costs 2.25x the shadow
map's fill and memory where 4096 costs 4x, for a texel within 7% of the 150 x 4096 row.

### What the audit table in the brief got wrong, and why

The scene-graph audit that opened this work reported `world chunk: 7 casters / 110
meshes` and sent the search to `_buildUnused` in `src/streaming.js` - dead code that
nothing has called since the resumable build landed. Two separate things were wrong.

The live path is `_stepBuild` / `_planUploads` / `_stepUploads`, and there the near
tier's facade and trim meshes DO cast; roads, zone polygons and the far tier's merged
boxes do not, by design. And 7/110 was a scene that had not finished streaming: chunks
were still arriving two minutes after the camera was placed (44 chunks / 112 meshes at
20 s, 94 / 264 at settle). Audited at the corridor hero camera with the mesh count
settled, the same figure is **57 casters of 259**.

Both tools now hold the fix. `tools/shadow-audit.mjs` places the hero camera through
`tools/framing.mjs` and waits for the mesh count to stop changing before it counts
anything, and `_planUploads` names every mesh it emits `chunk:<key>:lod<n>:<what>` so
the next audit can say WHICH meshes rather than how many.

### What shipped

- `src/streetfurniture.js`: prop buckets cast (`castShadow = true`), and the lamp arm
  and head join the pole as casters now that a 0.13 m arm is 1.7 texels instead of 0.5.
- `src/daynight.js`: sun shadow map 2048 -> 3072, ortho extent +-260 -> +-120.
  `audit()` now reports `shadowMap { mapSize, extentM, metresPerTexel, casterMeshes,
  receiverMeshes }`.
- `src/streaming.js`: every chunk mesh is named; the far tier's non-casting is now a
  documented measurement rather than an unset flag; `_buildUnused` is labelled dead.
- `tools/contact.mjs` + `tools/contact-diff.mjs`: paired-capture instrument for ground
  contact, with the critics' prediction boxes stated in the tool so the acceptance test
  is fixed before the change. Freezes traffic, the crowd AND the cloud deck (which
  drifts on wall-clock time and moved the upper frame by 20+ luminance across one run),
  and waits for the streamer to stop adding meshes before capturing.
- `tools/shadow-audit.mjs`: what can cast, and what the map can resolve, per category.

Nothing was changed in `src/post.js`. The AO measurement above is why.

### The critics' own acceptance test, scored

Paired captures, traffic and crowd and cloud deck frozen, noise floor measured by
capturing one untouched frame twice (0.00-0.25 of 255 per box). `docs/contact-before.json`,
`docs/contact-after.json`, `docs/contact-diff-before-after.json`.

| prediction | box | mean before -> after | % of box darkened >8 | verdict |
|---|---|---|---|---|
| bin interrupts the sidewalk tile joint | corridor trash-can | 53.02 -> 49.74 | 10.6% at depth 25.5 | **met** |
| sidewalk gains structure from 3 bollards + a bin | corridor sidewalk-left | 135.79 -> 133.45 | 9.9% at depth 16.6 | **met** |
| parked green car gains contact | fivepoints green-car | 39.91 -> 36.11 | 10.9% at depth 29.6 | **met, but not by the car** |
| red car gains a shape at the tyre contacts | corridor red-car | 53.77 -> 53.53 | 0.04% | **not met - it already had one** |
| mailbox gains contact | fivepoints mailbox | 28.91 -> 28.91 | 0% | **not met** |
| player gains contact | fivepoints player | 137.32 -> 137.32 | 0% | **not met** |

Three of six, and the three that failed failed for one reason, measured rather than
argued. A cast shadow can only remove light the sun is putting down, so each box was
captured three ways - as authored, with the shadow off, and with the sun off - and the
sun's POTENTIAL in it read off the difference:

| box | sun's potential | already blocked | headroom for a new shadow |
|---|---|---|---|
| corridor trash-can | 20.08 | 4.08 (20%) | yes |
| corridor sidewalk-left | 27.80 | 7.05 (25%) | yes |
| corridor red-car-ground | 16.82 | 5.89 (35%) | yes |
| fivepoints green-car | 8.82 | 8.48 (**96%**) | almost none |
| fivepoints mailbox | 29.37 | 29.23 (**100%**) | **none** |
| fivepoints player | 29.38 | 29.38 (**100%**) | **none** |

The fivepoints near street is entirely in the left-hand block's shade at golden hour.
The mailbox and the player stand in it, and no caster flag and no shadow map can put a
contact shadow on ground the sun is not reaching. The green car's box moved by 3.80
anyway - but the pixels that moved are the sunlit column BEHIND it going into shadow,
not the car meeting the pavement, which moved by 0.90. Scoring that box "met" without
looking would have been the ledger's own trap: a number that moves the right way for
the wrong reason.

The corridor red car is a different case again, and the answer is not "nothing changed"
but "nothing needed to". Switching the player car's three meshes to `castShadow = false`
in the shipped build moves **2.07%** of the frame against a 0.07% noise floor: the car
was casting before this change and still is, because `src/carbody.js` has always flagged
it and 1.8 m is 7 texels even on the old map. Where that shadow LANDS is the thing the
prediction missed. At golden hour's 8 degrees a 1.4 m car throws a 10 m streak, and the
diff map puts it lying across the near sidewalk to the left of frame - inside the
`sidewalk-left` box, not under the tyres. "A dark shape 1.5-2x its footprint attached at
the tyre contact points" is what a high sun does. This sun does not have that shape to
give, and asking the shadow map for it is asking the wrong subsystem.

### Regressions guarded

The round-6 critics named three things as the best in the set. All three were measured
before and after, in the same paired captures:

| what | metric | before -> after |
|---|---|---|
| `r6-fivepoints-night` lamp pools | box (810-1020, 535-730) mean | 58.76 -> 58.57 (-0.19) |
| `r6-fivepoints-night` storefront spill | box (1180-1560, 380-680) mean | 42.68 -> 42.70 (+0.02) |
| `r6-corridor-night` window glow on the mullions | box (60-480, 300-540) mean | 28.648 -> 28.651 (+0.00) |
| `r6-corridor-night` crush | fraction of the frame at luminance <= 6 | 26.57% -> 26.64% |

The night frames are essentially untouched: at night the sun's intensity is 0-3 lux and
there is no sun shadow to add. The corridor-night crush moves by 0.07 of a percentage
point, which is 1,008 pixels of 1.44 M.

### Cost, and the part of it the gate cannot see

The shadow pass at the corridor hero camera, `tools/shadow-audit.mjs`, golden hour,
traffic 30 / crowd 40:

| | before | after |
|---|---|---|
| caster meshes | 91 | 135 |
| of which prop buckets | 0 of 42 | 42 of 42 |
| of which lamp instanced | 2 of 4 | 4 of 4 |
| of which chunk meshes | 57 of 259 | 57 of 259 |
| metres per shadow texel | 0.254 | 0.078 |
| shadow map texels | 4.2 M | 9.4 M |

The budget gate itself, `node tools/drive-through.mjs --traffic`, verdict unchanged at
**WARN**:

| | before | after | threshold |
|---|---|---|---|
| draw calls p95 | 166 | **167** | warn 200 / fail 320 |
| triangles p95 | 350,597 | **353,868** | warn 400k / fail 900k |
| chunk stall | 9.6 ms | **13.1 ms** | warn 8 / fail 16 |
| heap growth | 4 MB | **6 MB** | warn 40 / fail 120 |

The stall row was already WARN before this change and the ledger records the same metric
spanning 7.1-16.4 ms on an unchanged build, so 13.1 is inside its known noise and is not
read as a regression from one run. No threshold was touched.

**But the gate cannot see the shadow pass at all, and that is a property of three.js,
not a choice.** `WebGLRenderer.render()` calls `info.reset()` AFTER `shadowMap.render()`, so
`renderer.info.render.calls` - which `PostStack.stats.sceneCalls` snapshots and
`tools/budget.mjs` gates on - counts the colour pass only. Every toggle in the probes
above reported an unchanged 142 draw calls while the shadow pass went from 84 casters
to 331. The gate is still mandatory and was still run; it simply cannot see this axis,
and the honest cost statement is the caster table, not the gate row.

The one place the added cost DOES show is the software rasteriser this container
renders through, where a depth-only pass is CPU work like any other. In the same 300 s
wall-clock cap the drive-through covered **216.7 simulated seconds and 7,273 m** against
**228.1 s and 7,733 m** before - about 6% less route per second of wall clock. That is a
SwiftShader number and does not extrapolate to a GPU, where a 9.4 M-texel depth-only
pass over 135 meshes is a fraction of a millisecond; it is recorded because it is the
only direct measurement of the cost available here.

### Still open

- **A car standing on shaded road still floats.** Every vehicle in the district was
  already flagged `castShadow` before this change and the shadow map now resolves one
  at 23 texels, so where the sun reaches the carriageway a car does throw a shadow. At
  both hero cameras at golden hour the carriageway under the parked and player cars is
  in the block's own shade, and there is nothing left to remove. What would fix it is a
  contact decal - `src/pedestrians.js` already builds one, a black `CircleGeometry`
  8 mm above the pavement under each ped - not another shadow-map setting. Not done
  here: it is a different mechanism from the one this change is about.
- **The pedestrian contact blob does not draw, measured.** `src/pedestrians.js` builds
  `this.shadows`, 96 instances of a black `CircleGeometry` at `SHADOW_Y = -0.042`.
  Setting `shadows.visible = false` with the crowd frozen changes the frame by
  **0.0266 mean absolute against a 0.0254 noise floor**, and 0.065% of pixels against
  0.07% - the toggle is inside its own noise, so the mesh is contributing nothing.
  A strong candidate, not yet confirmed: -0.042 is 8 mm above `streaming.js`'s land pad
  at -0.05, but `src/streetfurniture.js` paves the sidewalk at `PAD_Y = -0.05` and lays
  road ribbons at `ROAD_Y = +0.02`, so a ped standing on anything stacked on the pad has
  its blob 60 mm BELOW the surface and the depth test discards it. Left for the
  pedestrian system's owner; it is that file's mechanism, not this one's.
- **The near-band gain is concentrated where the sun lands.** `tools/sun-share.mjs` at
  golden hour: the sun's share of the road is unchanged at 26.5% and the fraction of it
  the geometry blocks went **15.7% -> 25.2%**. That is the whole change in one number.

## Attribution integrity — `git add -A` with agents running

Commit `0a2e1ad`, whose message is entirely about weather, `envMapIntensity` and
specular aliasing, also contains ~1,300 lines belonging to two other agents that were
mid-investigation at the time: `src/daynight.js`, `src/sky.js`, `src/signage.js`,
`src/facades.js`, `src/audio.js` and `tools/daynight-sweep.mjs` from the golden-hour
build, and `src/pedestrians.js` (509 lines), `tools/ped-audit.mjs` and
`tools/ped-near.mjs` from the pedestrian build. It was pushed before either agent
reported. The golden-hour agent found it and said so in its own report.

The cause is one character: `git add -A` in a tree that three writers were sharing.
This project's ledger already records the same failure once — "a facades commit swept
up another agent's work at an intermediate state" — and the lesson taken then was to
separate the *later* commits, which does nothing about the next `add -A`.

The work is all present and correct; what is wrong is the history. Two commits now
claim authorship of changes their messages do not describe, and one of them snapshots
a half-finished `pedestrians.js` under a message about rain. Nothing was rewritten to
repair it: the branch is pushed, and rewriting shared history to tidy an attribution
error trades a real risk for a cosmetic gain.

**The rule, which is not a note to be careful:** while any agent is running, commit by
explicit path — `git add src/weather.js tools/framing.mjs` — never `-A`, never `.`.
`git status` before a commit is a list of who else is working, not a list of what to
stage.

A second thing this cost: it made a status report to the user wrong. Having committed
`pedestrians.js` and both ped tools in `0a2e1ad`, I then told the user I had
"deliberately left the pedestrian agent's files alone" because three stray PNGs were
still unstaged. The three PNGs were the leftovers of a sweep I had not noticed making.

## Sampling integrity — confirm what is IN the sample before adjusting for it

A second failure mode, distinct from the broken-instrument one below and recorded
after it bit three times on 2026-08-31.

1. **A night-sky region I adjusted for turned out to contain cloud.** A critic
   reported the night zenith over-saturated; I measured 46.8% chroma in a box near
   the top of frame, desaturated `nightZenithColor` and dropped `nightZenithNits`
   0.045 -> 0.030, re-measured, and the number went the WRONG WAY - 56.1%. The sky
   wave had added a cloud deck driven by different constants, and my box was full of
   it. Reverted; the correct move is to mask the sample to clear sky first.
2. **Four wrong emitters before the right one.** A reversed shopfront name was
   chased through `signPanel`, `bladeSign` and `fasciaPlate` - five minutes of
   rendering each - before a two-minute probe showed the awning VALANCE drew it.
3. **A critic's stated defect was wrong and something worse was underneath.** Red
   and green reported lit on one signal mast. Measured: one head, red lit, and the
   *unlit* tints were saturated mid-tones the dusk key drove to RGB(95,95,35). But
   probing that turned up the real bug - aspects assigned by `leg % 2` down the
   incident-edge list, giving two CROSSING approaches green simultaneously at the
   hero junction. The reported symptom and the actual fault were different bugs.

**The rule.** Before adjusting a constant because a measurement moved, verify the
sample contains what you think it contains, and that the constant you are reaching
for is what drives it. A number that moves the wrong way is the cheap version of
this lesson; a number that moves the right way for the wrong reason is the
expensive one.

**Corollary, earned repeatedly this session:** a blind critic's OBSERVATION is
reliable evidence and its INFERRED CAUSE usually is not. Four separate rounds
asserted a missing subsystem - no shadow map, no AO pass, no street lighting, no
bloom - where isolation measured 43%, 29%, 76% and 52% of pixels changing when
each was disabled. Every one of those observations still pointed at something real.

## Measurement integrity — three failures in one session, same shape

Recorded because the pattern repeated three times on 2026-08-30/31 and cost real
work each time. In every case an instrument was broken, the reading was confident,
and the tell was a number that did not move when it should have.

1. **Crashed harnesses re-read a stale artifact.** Three budget runs agreed to the
   decimal. They agreed because all three had crashed - concurrent Chromium
   instances competing for CPU - and a crashed harness does not rewrite
   `docs/drive-traffic.json`, so each re-read run 1 byte-for-byte. Reverting the
   change under test produced *identical numbers including the triangle count*,
   which is arithmetically impossible if the revert took effect. That impossibility
   is what exposed it.
2. **A light-isolation test that disabled nothing.** Zeroing `PointLight.intensity`
   does nothing, because `LightPool.update()` rewrites intensity from the emitter's
   candela every frame - the light is back on before the screenshot. It reported
   street lamps contributing 0.5% of night pixels; two code changes were made on
   that evidence before the instrument was checked. Disabling the pool so
   `update()` early-returns gives the truth: 83.0 mean |diff|, 76% of pixels.
3. **A two-sample A/B on a loaded box.** An agent cited a parity reading from one
   round; its own second round contradicted it, with the spread *inside* one arm
   (58.5 -> 74.6 ms) wider than the gap between arms. It amended its commit message
   rather than leave the stronger claim standing.

**The rule, now project policy.** Byte-identical measurements mean something is not
running. Check the artifact mtime and the harness exit code, not the numbers. Before
believing a reading that confirms what a critic just told you, verify the instrument
can produce the opposite reading.

**Outstanding at time of writing.** Load time and chunk stall were both measured
over threshold during the content wave, but every one of those samples was taken
with three or four sibling agents' browser harnesses on the same box. They are
recorded as suspect and must be re-measured on a quiet box before any conclusion or
any threshold discussion. The triangle count is the one figure that is deterministic
and therefore trustworthy: **395,511 p95 against a 400,000 warn**, up from 184,600
before the wave. That headroom is genuinely gone and is a content-cost problem, not
a measurement artifact.

**Commit-message correction.** `8dae041` was pushed carrying a parity claim its
author later withdrew; the corrected reasoning is preserved in this entry rather
than by rewriting the pushed history.

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
