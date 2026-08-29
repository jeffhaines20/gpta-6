# Phase 1 — Feasibility Probe

**Project:** open-world third-person crime-action vertical slice, Three.js, fully static,
100% procedurally generated assets, GitHub Pages deployable.
**Probe date:** 2026-08-29 · **Time-boxed:** ~45 min

**Bottom line:** the coupled core works and the visual bar is reachable *for GTA V-era
quality*, not GTA VI trailer quality. Two of the five risks below are already
confirmed rather than hypothetical — I hit them during this probe. Section 5 lists
what I now believe should be cut from the spec.

---

## 1. Decomposition plan

Legend: **SEQ** = one sequential owner, **PAR** = safe to hand to a parallel builder.

The rule I used: a piece gets a parallel builder only if it can be defined by a
**pure interface with no shared mutable per-frame state**. Anything that reads or
writes the same physics/transform state inside a single frame goes sequential,
because two builders touching that state produce bugs that are indistinguishable
from each other's bugs at the seam.

| # | Piece | Mode | Why | Tightly coupled to |
|---|---|---|---|---|
| 1 | **Engine shell** — renderer, fixed-step scheduler, scene registry, event bus | **SEQ** | Everything else is downstream of its contracts. Must land before any parallel work starts. | Everything |
| 2 | **World streaming & city layout** | **SEQ** | *Mandated, and correct — see argument below.* | 3, 4, 10, render budget |
| 3 | **Vehicle physics** | **SEQ** | *Mandated, and correct.* Single mutable rigid-body state advanced in-order each substep. | 2, 4, 5, 10, 11 |
| 4 | **Player controller** | **SEQ** | *Mandated, and correct.* | 2, 3, 5, 8, 12 |
| 5 | **Camera rig** | **SEQ — same owner as #4** | Camera is not a separate concern: "feel" is a joint property of controller + camera + input. Splitting it across two people produces two half-tunings. | 3, 4 |
| 6 | **Procedural material/texture library** | **PAR** | Pure functions `params → CanvasTexture`. Zero shared state. Highest parallel value. | naming contract only |
| 7 | **Building kit-of-parts generator** | **PAR** | Pure `params → BufferGeometry`, consumed by #2 through an interface. | 2 (interface), 6 |
| 8 | **Character meshes + skinning/animation clips** | **PAR** | Rig and clip *authoring* is pure data. | — |
| 8b | **Animation state machine** | **SEQ — same owner as #4** | Reads controller state every frame; a separate owner desyncs it from locomotion. | 4 |
| 9 | **Procedural audio** (engine, tyres, sirens, ambience, music) | **PAR** | WebAudio graph driven purely by events off the bus. | event bus |
| 10 | **Traffic & pedestrian AI** | **SEQ, starts after #2's road graph is stable** | Writes to many vehicle bodies per frame; sits directly on top of streaming *and* vehicle physics, the two riskiest systems. Can start early against a stubbed road graph. | 2, 3 |
| 11 | **Wanted / police response** | **PAR**, on top of #10 | State machine over events; touches no physics directly, only issues AI goals. | 10, event bus |
| 12 | **Mission scripting + triggers** | **PAR**, last | Declarative trigger/objective graph over the event bus. | 4, 11, event bus |
| 13 | **Sky, atmosphere, day/night, weather** | **PAR** | Owns its own lights and uniforms behind a `TimeOfDay` interface. | render budget |
| 14 | **HUD, minimap, menus** | **PAR** | DOM/canvas overlay, reads state, writes nothing. | — |
| 15 | **Post-processing stack** | **SEQ — same owner as #1** | Competes for the same frame budget as everything else; needs one person holding the budget. | 1, 13 |

### The mandate on #2/#3/#4 — I agree, and this probe produced the evidence

I was asked to argue if I disagreed. I don't. The probe itself demonstrated why:

The vehicle module contained a **scratch-vector aliasing bug** (`applyImpulseAt`
reused a temporary the caller was still holding, so `offset.cross(impulse)` became a
self-cross and evaluated to zero). Its only symptom was that **suspension torque was
silently always zero** — the car looked fine, drove forward, and reported four wheels
grounded. It surfaced only as second-order weirdness: a top speed of 221 km/h, a car
riding at 0.88 m, and two wheels off the ground under acceleration.

That is exactly the class of bug that becomes unfixable with parallel owners. If a
traffic-AI builder and a vehicle-physics builder had both been editing during that
window, the symptom ("cars look wrong at speed") points at neither of them. One owner,
one deterministic harness, one bisectable history.

The same argument holds for streaming (frame-budget ownership can't be split) and for
the player controller (feel is not decomposable).

---

## 2. Risk register

Ranked by expected damage. **Risks 1 and 3 are confirmed** — I hit them in this probe.

### Risk 1 — Draw-call ceiling, not triangle count *(CONFIRMED)*
One street corner already costs **545 draw calls / 631 geometries** for only 8,514
triangles. Triangles are a non-issue; **submission cost is the wall**. A dense district
is 50–100× this corner. At ~2,000 draw calls most browsers fall off 60 fps regardless
of GPU.
**Mitigation:** make instancing structural, not an optimisation pass. Buildings become
`InstancedMesh` per kit-part; street furniture becomes one instanced buffer per prop
type; facades share one texture atlas so blocks can be merged into a single geometry
per city block. Add a **hard CI gate** that fails the build if a representative camera
exceeds a draw-call budget. Do this *before* content volume grows, because retrofitting
instancing into authored content is a rewrite.

### Risk 2 — The procedural quality plateau
Procedural generation reaches "convincingly game-like" fast and then stalls well short
of "art-directed". The gap is *intentional irregularity* — the weathering, signage,
asymmetry and hand-placed hero detail that reads as authored. Pure noise does not
produce it, and more noise makes it worse.
**Mitigation:** kit-of-parts with **hand-authored parameter sets** (a human picks the
20 facade recipes; code instances them), plus a small number of hand-placed hero
landmarks along the mission route. Budget an explicit art-direction pass as a named
deliverable, not as leftover time.

### Risk 3 — Physics/controller rot under a variable timestep *(CONFIRMED)*
Measured with a variable frame-time step, the identical input sequence over 8 s of
cornering diverged from **z = 174 m at 30 Hz to z = 13 m at 120 Hz**. Frame rate was
silently changing vehicle handling. Two further frame-rate dependencies were found in
the same module (a per-frame steering lerp; per-frame tuning constants).
**Mitigation:** already implemented — `Vehicle.stepFixed()` runs a 120 Hz accumulator
regardless of render rate. Post-fix, 15 Hz and 144 Hz agree to **1.6 m over 8 s**
(residual is the partial-step remainder). Plus: **golden-trace regression tests** in
CI — a fixed input script whose output positions are asserted, so any handling change
is deliberate.

### Risk 4 — No real GPU performance signal during development *(CONFIRMED — environmental)*
This container renders through SwiftShader (software). Measured **4.7 fps**, which says
nothing about real hardware. Building for months against a blind perf target is how a
project discovers on launch day that it needs a 40% cut.
**Mitigation:** treat *proxy metrics* as the gate — draw calls, triangles, texture
memory, active lights, shader-permutation count — all asserted in CI. Schedule explicit
**real-hardware checkpoints** at each milestone; nothing merges past a milestone without
one. Budget for a mid-project perf crisis rather than being surprised by it.

### Risk 5 — Four load-bearing systems that only fail together
Streaming, traffic, police response, and mission scripting each work in isolation and
interact badly at load: a police chase pushes 20 AI vehicles across a streaming boundary
while a mission trigger is live. This integration is where projects like this stall,
and it is always discovered late.
**Mitigation:** force the integration early — a "chase harness" scene that spawns the
worst case (max traffic + active pursuit + streaming churn) from week one, long before
the mission exists. Keep a **written cut list** ordered in advance (see §5) so that
descoping is a decision, not a panic.

**Also watched, below the top five:** total payload on GitHub Pages (three.js is already
2.0 MB unminified, and no build step means no bundler); WebGL context loss on long
sessions; audio autoplay policy; and mobile/Safari WebGL2 divergence.

---

## 3. Walking skeleton — built and verified

`skeleton/` — a static page, no server, no build step. Character walks and runs,
approaches a car, presses **F** to enter, drives with real suspension and tyre
friction, handbrakes, exits.

**Modules** (`src/`): `input.js` · `player.js` (kinematic capsule) · `vehicle.js`
(raycast vehicle, no physics library) · `camera.js` (spring-arm chase cam) ·
`ground.js` (the interface the streaming world will implement).

![On foot, next to the vehicle](docs/shots/skeleton-onfoot.png)
*On foot: camera-relative movement, procedural walk cycle, contextual enter prompt.*

![Driving](docs/shots/skeleton-driving.png)
*Driving: 33 km/h, 4/4 wheels in contact, camera auto-aligning behind the car.*

### Verification — deterministic, headless, no human at the keyboard

`tools/probe.mjs` drives the real page through Playwright (walk → enter → accelerate →
corner → brake → exit). `tools/physics-test.mjs` steps the **same** `Vehicle` class at
a fixed 60 Hz with no renderer, so the numbers do not depend on frame rate.

| Measurement | Result | Read |
|---|---|---|
| 0 → 100 km/h | ~8.5 s (112.6 km/h at 10 s) | plausible street car |
| Top speed | 129 km/h | plausible |
| Braking, 112 km/h → 27 km/h | 2.0 s (≈1.2 g) | plausible |
| Steady cornering | 17.6 m radius @ 32 km/h, 0.4° body roll | plausible |
| Ride height under power | 0.717 m, 4/4 wheels grounded | stable |
| 30 s of adversarial random input | no NaN, quaternion normalised, car on its wheels | stable |
| Fixed-step determinism, 15 Hz vs 144 Hz | agree within 1.6 m over 8 s | **fixed** |
| Cost per vehicle substep | 2.29 µs | ~60 cars at 120 Hz ≈ 0.27 ms/frame |

**Verdict: the coupled core is not a project risk.** Controller, vehicle, camera and
input integrate cleanly, and vehicle CPU cost leaves ample headroom for dense traffic.
The risk in this project is entirely in **content volume and draw-call submission**,
not in the simulation.

---

## 4. Visual bar check

`visual/` — one street corner at dusk after rain. Every pixel is generated in code:
asphalt, wet-roughness maps, sidewalk concrete, facade window grids and their matching
emissive masks are all drawn into `<canvas>` at runtime. No image files, no downloads.
ACES filmic tone mapping, a procedural sky doubling as the IBL environment map,
shadow-casting sun, and per-lamp point lights.

![Procedural street corner at dusk](docs/shots/visual-street-corner.png)

**Cost:** 545 draw calls · 8,514 triangles · 14 textures · 631 geometries.
The draw-call figure is the headline number, and it is Risk 1.

### Blind critic verdict

<!--CRITIC-->

---

## 5. Budget estimate and recommended spec changes

<!--BUDGET-->
