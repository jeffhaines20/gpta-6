# Milestone 1 — Textured District

**Status: reached, with two WARNs and one open item for your real-hardware check.**
Phase 2 is paused here per the milestone rule. Nothing proceeds to M2 without your
**CONTINUE**.

Live progress page: [`docs/progress.html`](docs/progress.html) · Ledger:
[`PROGRESS.md`](PROGRESS.md)

---

## 1. M1 acceptance criteria

| Requirement | State | Evidence |
|---|---|---|
| Materials wired into the streamed LOD | **done** | 18 materials, 20 textures / 34 array layers, 28.7 MB. One shared surface-array material covers every building via per-vertex `aLayer` + `color`, so the whole district's wall and roof variety costs the same single draw call per chunk that flat grey did. |
| Facade system wired into the streamed LOD | **done** | 7 recipes with storefronts, awnings, parapets, roof plant, fire escapes, balconies. Near LOD only, grouped by recipe: a chunk costs *(recipes present) + 1* draw calls. |
| Budget thresholds re-derived and logged | **done** | Draw calls 260/400 → **200/320**, triangles 900k/1.8M → **400k/900k**. Both **tightened**. Derivation and evidence in `PROGRESS.md` § Threshold change log. |
| Lit windows at night | **done** | Per-window lit/unlit/blinds state with colour-temperature variation, emissive generated in the same pass as albedo. Visible in `docs/shots/m1-corridor-night.png`. |
| Bloom + height fog in | **done** | `src/post.js`: HDR half-float target, soft-knee bright pass, 4 separable blurs at half res, composite with depth-based height fog, sun-direction inscatter, ACES and ordered dither. 6 passes. |

Beyond the M1 line, also landed: the **Risk 5 chase harness** running from week one, **sky
and weather**, **on-foot mode** with a procedural character and locomotion FSM, a
**loading screen**, **zone ground surfaces**, and **authored corridor massing**.

---

## 2. Gate results

### Budget gate — worst case (60 civilian + 10 pursuit, dusk, route at speed)

```
BUDGET GATE: WARN
  PASS draw calls             143   warn 200   fail 320   headroom 55.3%
  PASS triangles            40811   warn 400k  fail 900k  headroom 95.5%
  WARN chunk stall ms        10.7   warn 8     fail 16    headroom 33.1%
  PASS heap growth MB          -4   warn 40    fail 120   headroom 103.3%
```

### Budget gate — drive-through, 3 circuits + 30 traffic

```
BUDGET GATE: WARN
  PASS draw calls             144   warn 200   fail 320   headroom 55.0%
  PASS triangles            40068   warn 400k  fail 900k  headroom 95.5%
  WARN chunk stall ms         9.4   warn 8     fail 16    headroom 41.3%
  PASS heap growth MB          -1   warn 40    fail 120   headroom 100.8%
```

Chunk loads 257 over the route (1.41/s of simulated time), 414 LOD swaps, 5,100 m driven.

### Golden-trace physics gate

`PASS` — 30 samples within ±0.25 m / ±0.5 km/h. **The Phase 1 `Vehicle` class still drives
the streamed, textured district unmodified**, through the same `ground.js` interface it
used on the flat test block.

### Syntax gate

`PASS` — 54 modules parse. Added this milestone; it caught a builder mid-write during M1.

### Lighting sweep — three-point, with scene-graph audit

```
LIGHTING SWEEP: PASS
```

| | Noon | Dusk | Night |
|---|---|---|---|
| Sun (lux) | 100,000 | 1,200 | 0.6 |
| Sky (lux) | 20,000 | 900 | 3.5 |
| Street lamps lit | 0 | 7 | 7 |
| Lamp intensity (cd) | — | 900 | 900 |
| Exposure | 1/78,000 | 1/330 | 1/2 |
| Draw calls | 119 | 119 | 119 |
| Implausible flags | 0 | 0 | 0 |

Negative test still fires: re-injecting the Phase 1 mis-tuning (lamps at 26 cd) is
`CAUGHT` with 7 flags.

---

## 3. Screenshots at two times of day

![Marlin Street corridor, dusk](docs/shots/m1-corridor-dusk.png)
*Marlin Street corridor, dusk.*

![Marlin Street corridor, night](docs/shots/m1-corridor-night.png)
*Same camera, night. Lit windows and lamp pooling.*

![Five Points, dusk](docs/shots/m1-fivepoints-dusk.png)
![Five Points, night](docs/shots/m1-fivepoints-night.png)
*Five Points junction, dusk and night.*

Sweep frames: [`tod-noon`](docs/shots/tod-noon.png) ·
[`tod-dusk`](docs/shots/tod-dusk.png) · [`tod-night`](docs/shots/tod-night.png).
Chase harness: [`chase-harness`](docs/shots/chase-harness.png). Builder labs:
[`lab-facades`](docs/shots/lab-facades.png) · [`lab-sky`](docs/shots/lab-sky.png) ·
[`lab-signage`](docs/shots/lab-signage.png).

---

## 4. What the gates caught

Nine real defects this milestone, every one found by measuring rather than looking. The
full list with fixes is in `PROGRESS.md` § Failed approaches. The five that mattered:

**The budget gate silently disabling itself.** It read `renderer.info.render` directly,
which after the composite blit describes a 1-triangle fullscreen pass. It reported **1
draw call**. Undetected, that would have left the project's single most important gate
inert for the rest of Phase 2.

**233 point lights.** One per street lamp. three.js forward-renders every light per
fragment and compiles materials against the light count — catastrophic on real hardware,
and software rendering here could never expose it. Now a fixed pool of 10 real lights
reassigned to the nearest emitters, with hysteresis.

**The stall gate, five rounds.** The facade kit took a chunk build to 31.2 ms, then 40.8.
Attribution rather than guessing: scan 6.8 ms (cached), upload 9.8 ms (phased), upload
per chunk 3.7 ms (split per mesh), disposal 8 ms (bounded), zone triangulation 38.5 ms
(moved into the gated append phase). One cost cap I wrote keyed on `floors × vertex count`
and **missed the worst case entirely** — a four-point 737 m² tower. Balcony count scales
with **perimeter**, not vertex count.

**A lighting gate that passed on a blown-out frame.** It checked sky illuminance ratio —
the wrong quantity. Saturation is decided by *radiance × exposure*, which measured 2.14
for fog and 6.52 for inscatter at dusk while the gate read "pass". It now checks exactly
that, and fog is renormalised against the camera stop after sky and weather have written.

**A plausibility audit that only checked its own lights.** A sky emitting 7.1× the
illuminance its exposure was calibrated for still reported `implausible: 0`. Attached
subsystems now escalate their own flags.

---

## 5. Open items

### For your real-hardware check

1. **Chunk stall, 10.7 ms (WARN).** Dominated at times by a single `_dispose` measured at
   **8 ms** — GL buffer deletion. A real driver frees buffers far more cheaply, so this is
   very likely a SwiftShader artifact. **This is the first thing to look at.** If it holds
   at ~8 ms on real hardware, chunk disposal needs geometry pooling; if it collapses, the
   stall metric clears the warn threshold outright.
2. **Sky refresh costs 2,429 ms**, of which 822–2,148 ms is a GPU→CPU read-back of the
   scattering probe. Survivable for three discrete presets; **a continuous day/night cycle
   cannot afford it**, and that cycle is in M3 scope. A `readPixels` of a 32×16 probe
   should be single-digit milliseconds on a real driver.
3. **First load 3.7 s** (2.45 s of it atmosphere). Inside constraint 7's 8 s budget, so no
   IndexedDB cache — but the margin is now 2.2×, not 10×.

### A measurement change you should sanity-check

`startRecording()` reset `worstBuildMs` but never `worstSliceMs`, so the stall metric
carried the initial chunk-fill burst — chunks built while the loading screen is still up —
into a steady-state churn measurement. The drive-through reported **17.9 ms (FAIL)** on a
run whose steady-state worst slice over 90 s was **7.2 ms**. Fixed by clearing every peak
at the start of the recorded window: 17.9 → 9.4 ms.

**No threshold moved**, and the excluded stall is one a player never experiences. But it
superficially resembles loosening a gate, so per constraint 4 it is flagged rather than
buried. One-line revert: drop `worstSliceMs` from `resetPeakStats()`.

### Sub-agent capacity interruption

Four of six wave-1 builders and the entire first critic panel died to
`session limit · resets 12am UTC`. Sky, signage, HUD and audio never ran in wave 1.
Relaunched after the reset; sky, signage and HUD have since landed, audio is still
building. Sequential work continued throughout — the engine shell, chase harness and
threshold re-derivation were all built in that window. **You have since asked me to arm an
hourly watchdog, which is now live** (`trig_01AcU4HEkk7RNy3cSyi7J6zP`, fires at :53).

---

## 6. Blind critic round

<!--CRITIC-->

---

## 7. Updated estimate and cut list

<!--ESTIMATE-->
