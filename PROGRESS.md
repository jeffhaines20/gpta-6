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

## The white rectangle was the NaN guard after all - it was MAKING them, one line

`sanitize()` in `src/post.js` exists to keep non-finite values out of the frame.
It was written with `mix()`, and `mix(x, y, a)` is `x*(1-a) + y*a` - so for a
channel that FAILS the test, `a` is 0 and the second term is `y * 0.0`. When `y`
is `+Inf`, that is **NaN**. NaN itself came through correctly (GLSL `max(x, y)`
is `y < x ? x : y` and every comparison against NaN is false, so `max(NaN, 0.0)`
is 0 and the mix returned the ceiling), but every INFINITY the guard caught left
it as a NaN. The guard was manufacturing exactly what it exists to remove.

**What that is worth, pass by pass** (`tools/nan-probe.mjs`, golden, whitebox
camera, frame-wide):

| pass | before | after |
|---|---|---|
| hdr scene target | 6,924 NaN + **11 Inf** | 6,942 NaN + 10 Inf (untouched) |
| bright | **1 NaN** at (158,370) | **0** |
| blurA | **312 NaN**, box [134,358]-[180,382] | **0** |
| blurB | **675 NaN**, box **[132,344]-[180,396]** | **0** |

Eleven Inf channels in the scene target become ONE NaN texel in the bright pass,
and four separable blur passes at +-1.4 and +-3.2 texels, run twice at double
step, spread it into a 49x53 half-res block. **NaN does not blur** - any tap
touching one makes the whole result NaN - so the block has a hard edge and a
rectangular support rather than a falloff. The composite then sanitizes it back
to the 60,000-nit ceiling and ADDS it at `bloomStrength`: **+24,000 nits flat**,
2.49 in exposed units at golden, over about 2,700 full-resolution pixels that owe
nothing to the geometry underneath them.

**That is the intermittent additive block**, whose report reads "2,890 px at
(137,349)-(216,402)" against a measured NaN blob at (132,344)-(180,396) and 675
half-res texels x 4 = 2,700 px. It is intermittent because it is seeded by the
ELEVEN Inf channels in a frame: a frame with none has no block, which is how ten
consecutive captures of the same box went 0.1012-0.1023 eight times and 0.2430
twice. **It has corrupted every measurement of that box anyone has taken**,
including the 24.8% the sanitize round recorded - and that round's own conclusion,
"roughly a third of its whiteness is bloom fed by an overflow the guard is
catching a hundred pixels away", was RIGHT about the mechanism and wrong only in
thinking the guard was innocent.

It also settles the disagreement between the two blind reviewers and the round
that audited them. The reviewers said screen-space sprite: hard edge, axis
aligned, zero slope where the string course drops four pixels, painted over a
pier and a spandrel in FRONT of the glass. All of that is true of this block and
none of it is true of a specular highlight. The audit's refutation - "bloom OFF
leaves the box 11.8% white and `hardStepCols` goes 0 to 46" - was reading the
same thing backwards: turning bloom off removes the NaN BLOCK (the block *is*
bloom), which uncovers the pane underneath it and its own hard edge. Bloom was
never softening anything.

The fix is to stop multiplying. A ternary selects the ceiling for anything that
failed the test, so nothing non-finite is ever an operand; finite pixels are
returned bit-for-bit, and NaN still lands on the ceiling rather than on black.
Both copies of the guard - the composite's `sanitize()` and the bright pass's
inlined one - are corrected.

## The blown pane is a HALF-FLOAT fault, and the rolloff is what post can still do

The pane is real and it is not the block. `tools/highlight-probe.mjs` renders the
same camera into a **FloatType** target - no half-float saturation, no tonemap -
and reads the radiance behind it: mean **643,000 cd/m2** over the left pane, peak
**14,287,888** over the right, against a display-white radiance of 29,800 at
golden's 1/9,649. And it is not achromatic light: **B/R 0.227**, the sun's own
colour, over every one of the ceiling-clamped regions.

**None of that reaches `post.js`.** The scene target is `HalfFloatType`, so every
channel past 65,504 stores saturated, and `sanitize()` then pins every channel
past 60,000 onto one number. By the time the composite runs the pane is
(60000, 60000, 60000): flat, achromatic, and bit-identical to the sun disc, which
`sky.js` clamps to the same 60,000. **So no curve in the composite can shrink that
pane and none can give it its colour back** - both were destroyed upstream of the
file this round was scoped to, and post cannot tell the pane from the sun because
they arrive as the same number. That is the finding; the paragraph below is what
was still available.

7,840 px past the ceiling against 14,066 past the display-white radiance, so 44%
of what reads as white DOES still carry a gradient, and the composited value -
scene PLUS bloom - was leaving this shader at a literal 255,255,255 (254 with
bloom off), i.e. the ceiling was reading as the display maximum. A **highlight
rolloff** in front of the ACES fit puts that band back inside the range:

    f(x) = x                            x <= K
    f(x) = K + S(x-K)/(S + (x-K))       x >  K,   S = C - K

per channel, on the EXPOSED value, so one pair of constants is correct at every
preset and nothing in `daynight.js` moves. **C is not a taste**: the four tools
that recover radiance from a byte have to invert this at byte 255, which decodes
to the fit's own white point 7.2416, and the inverse only exists for y < C. So
C = 8.0 - which also keeps display 255 reachable, so "clipped" keeps its meaning.
K = 0.5 is then the only free parameter: at C = 8.0 byte 255 lands on 253.6 with
K = 3.0, 252.1 with K = 0.5 and 252.0 with K = 0.35, so 0.5 is where the return
stops and where the cost stops. **The whole effect is one byte-to-byte map:**

    in   210    220    230    240    245    250    252    254    255
    out  210.0  219.7  229.2  238.5  243.1  247.6  249.4  251.2  252.1

### Measured, at the whitebox box and at all four presets

`tools/whitebox-probe.mjs`'s box at golden, one camera:

| bloom ON | white (>250) | >=245 | >=240 | mean luma | hard-step cols |
|---|---|---|---|---|---|
| before | 0.1633 | 0.3993 | 0.4291 | 202.4 | 1 |
| NaN guard fixed | 0.1146 | 0.2163 | 0.2505 | 193.3 | 0 |
| + rolloff | **0.1087** | **0.2043** | **0.2366** | 192.5 | 0 |

The guard is worth 45% of the near-white area in that box and the rolloff another
6%. With bloom OFF - where the NaN block cannot exist, because the block IS bloom
- the rolloff is the whole of the change and it is visible in the EDGE as well as
the level: white 0.1107 -> **0.0740**, and the columns that step from under 200 to
over 250 in a single pixel go **42 -> 24**. Ten repeat captures on the fixed build
(`tools/whitebox-repeat.mjs`) span 0.1084-0.1087, a spread of 0.03 points against
the 14.2 points the block used to add. Frame-wide at the sweep camera, the committed frames against the re-run
sweep - **noon, dusk and night are unchanged inside the run-to-run spread this
ledger already records**:

| preset | mean | p50 | p95 | clipped | >250 | <16/255 |
|---|---|---|---|---|---|---|
| noon | 113.3 -> 114.6 | 125 -> 127 | 170 -> 170 | 0 -> 0 | 0 -> 0 | 1.75 -> 1.66% |
| golden | 128.8 -> 129.3 | 115 -> 116 | 230 -> 229 | **2,072 -> 0** | **16,756 -> 11,829** | 0.44 -> 0.41% |
| dusk | 107.2 -> 107.7 | 86 -> 86 | 207 -> 207 | 0 -> 0 | 0 -> 0 | 1.33 -> 1.23% |
| night | 26.9 -> 27.0 | 21 -> 21 | 63 -> 63 | 0 -> 0 | 2 -> 0 | 40.94 -> 40.86% |

The sweep was run twice on the fixed build, because the district has traffic and
a crowd in it and the frame mean moves without the renderer moving: 113.6 then
114.6 at noon, 128.8 then 129.3 at golden. Every "after" figure above reproduced
inside that. The one column that did NOT move between the two runs is golden's
>250 count - 11,829 both times - because what it measures is deterministic
glazing rather than anything that walks through frame.

### And the things that are SUPPOSED to be at the top of the range

`tools/rolloff-ab.mjs` swaps the two uniforms inside ONE session, arms asserted
distinct, and reports the ten brightest connected regions found on the ARM WITH
THE ROLLOFF OFF - **the same pixel set in both arms**, because a curve that moves
a region out of the top decile would otherwise re-sort the population and measure
a different object.

- **Night** (lamp lenses, lit windows, signage): seven of the ten regions are
  bit-identical; the other three move 197.1 -> 197.1, 244.3 -> 242.3 and
  231.9 -> 230.9 on the peak. Frame mean 21.73 -> 21.66.
- **The sun disc**, camera pointed at it at golden: peak **255 -> 252.9**, its
  region mean 220.3 -> 219.7, frame mean 139.68 -> 139.62. It still reads as a
  disc.
- **Noon**: brightest peaks move <= 2.1; frame mean 112.01 -> 111.95.
- **Dusk**: brightest peaks move <= 1.4; frame mean 98.83 -> 98.74.

And the guard fix cannot touch night at all, which is measured rather than
argued: `NP_TIME=night node tools/nan-probe.mjs` reports zero non-finite values
in every pass and a peak scene radiance of **10 nits** at that camera, four
orders of magnitude under the 65,504 where the fault lives.

### What it cost, and what is left open

Zero triangles, zero draw calls, zero new post passes (8 either side) and two new
uniforms; the composite is one `min`, one `max` and one divide longer.
`gates:static` PASS and the LIGHTING SWEEP PASS with **both** negative tests
firing.

The four tools that carry this chain's inverse move with it:
`critic-metrics.mjs` (`unDisplay` gains `rollInverse`, `acesFlat` added for
frames captured between the encode and the rolloff), `pane-tint.mjs` (same, plus
a self-test arm that puts a value ABOVE the knee through the whole chain and
requires the two inverses to disagree - the existing arms all sit at 0.04-0.30 in
ACES input, under the knee, and would have passed either way), `glaz-probe.mjs`
and `transfer-audit.mjs` (a third named chain, `srgb-aces-roll`, now the
default). `pane-tint --selftest` 18 passed, 0 failed.

**Open, and sized.** The pane's colour is recoverable only before the half-float
write. Two routes, neither taken here: a highlight compression in the material,
or an `RGBA32F` scene target - which is 2x the bandwidth on the biggest target in
the build and puts float MSAA and `OES_texture_float_linear` on the critical
path. The pane's AREA is not recoverable at all from post: the whole cell sits
above the ceiling, so post sees one flat number across it.

## The frame was never missing light. It was missing a display transfer function

The fidelity reviewer's headline finding was that everything out of direct sun is
two to three times too dark and has swung from warm to cold, with two candidate
causes: **A**, no bounce fill, so a sky dome is the only ambient and every shaded
surface is lit blue and dim; **B**, no display transfer function, deferred and
documented in the noon-exposure round's own commit. They are not mutually
exclusive and the fixes have nothing in common, so `tools/transfer-audit.mjs`
separates them with three measurements before anything changed.

**The separator, and neither hypothesis can hide from it.** A is a claim about
RADIANCE and B is a claim about the ENCODE, so remove both exposure and the encode
and only A can still be there.
Normalise each frame's scene-linear luminance by its own p90 and exposure drops
out; invert each image with its own transfer and the encode drops out. What is
left is the scene's own contrast. Over the 18 matched noon photograph/render
pairs, median of each frame's own normalised quantiles:

| | p05 | p10 | p25 | p50 | p75 |
|---|---|---|---|---|---|
| photographs | 0.0195 | 0.0397 | 0.1022 | 0.2968 | 0.5546 |
| engine | 0.0594 | 0.0864 | 0.1418 | 0.4535 | 0.7114 |

**The engine's dark tail was SHORTER than the photographs', not longer** — and at
golden hour, over 52 pairs, the two rows agree: p25 0.1419 photo against 0.1413
engine, p50 0.2998 against 0.3071, i.e. 0.4% and 2.4% apart. A
photograph's own tone curve compresses and cannot be inverted from here, so this
comparison is biased *toward* finding the engine too contrasty. It did not. There
was no radiance deficit to find.

**B is the whole of the level fault, and it is arithmetic.** `src/post.js`'s
composite is a `RawShaderMaterial`, so three.js substitutes no
`<colorspace_fragment>` into it and the byte was `aces(radiance * exposure)` with
no encode; the display then applied its own ~2.2 decode to a value nothing had
encoded. At the corridor camera the sky-lit facade and the sunlit road sat at ACES
input 0.0796 and 0.4473 — 2.49 stops apart in radiance. At **one stop**, so only
the encode differs:

```
aces only          23.0 and 147.7 of 255  ->  6.41:1 apart,  1.076 display stops per scene stop
srgb(aces())       84.8 and 200.3 of 255  ->  2.36:1 apart,  0.498 display stops per scene stop
```

Same light, same exposure, same tonemap; **2.16x the tonal separation from the
encode alone.** That is "two to three times too dark", exactly.

**What A does explain.** The other half of the complaint — warm to cold — is real
and B cannot touch it. Scene-linear blue/red, each frame referenced to itself so
exposure, encode and white balance all cancel: photographs put their darkest 30%
at **0.68x** their own frame's B/R (shadows warmer than the picture, which is what
light bouncing off pale pavement does); the engine at noon puts them at **0.98x** —
no warm bounce at all, and at golden 0.84 against 0.62. That is A, it is a COLOUR
deficit rather than a level one, and it is left standing with its measurement
rather than folded into this change. Its likely site: `src/sky.js`'s
`uGroundAlbedo` is `0x6b6455`, linear luminance **0.129**, while the district's own
ground renders at an effective **0.18** (plaza 6,017 nits under 105,244 lux at
noon, road 6,262) — the dome tells every wall in the city that the street below it
is darker than the street actually is.

### The re-grade, and the rule it used

Adding the encode without moving the stops would have blown all four presets, so
every camera stop, every bloom threshold, both fog clamps and three audit gates
moved with it. The stops were not fitted by eye. **Because the old byte WAS
`aces(radiance * exposure)`, inverting it recovers the exact radiance behind every
pixel**, so re-tonemapping a shipped frame at a candidate stop gives the frame that
build would actually produce (`tools/transfer-audit.mjs --solve`). The criterion:
*the transfer must correct the toe, not re-grade the picture* — hold each frame's
median display value where the author put it.

| preset | old stop | new stop | stops | pi/E | offset from pi/E |
|---|---|---|---|---|---|
| noon | 1/14,000 | **1/33,500** | -1.26 | 1/33,500 | 0.00 (was +1.26) |
| golden | 1/4,152 | **1/9,649** | -1.22 | 1/3,954 | -1.29 (was -0.07) |
| dusk | 1/719 | **1/1,947** | -1.44 | 1/448 | -2.12 (was -0.68) |
| night | 1/1.15 | **1/5.378** | -2.23 | 1/0.220 | -4.61 (was -2.39) |

Noon is the check that the criterion is not merely "keep it looking the same":
it is the one preset where `pi/E` is applicable, and the two routes land 0.2%
apart — `pi/105,244 = 1/33,500` against the median criterion's `1/33,422`. Noon's
`+1.26`-stop offset, sized by an acceptance test in an earlier round *because* the
toe was crushed, is deleted; the preset now sits on the bare rule. Golden shows why
`pi/E` is not the rule everywhere: it normalises to the illuminance on a
HORIZONTAL surface, and an 8-degree sun puts 2.8x that on the vertical surfaces
the frame is made of, so `pi/E` there renders frame mean 179 with 3.2% clipped.

The offline predictor was checked against the real render before any of this was
trusted: an identity run (same chain in and out) returns the stop it was given to
within 0.01 stops, and the predicted frames match the rendered ones to about two
display units at every preset (worst: golden's shaded facade, 54.1 predicted
against 57.0 rendered, which is the bloom threshold the predictor does not model).

### What it did, at the sweep camera

`tools/tod-readability.mjs` on `docs/shots/tod-*.png`, HUD excluded:

| preset | frame mean | p50 | p95 | <16/255 | <8/255 | >250 | sky-lit facade | sunlit road | sky |
|---|---|---|---|---|---|---|---|---|---|
| noon before | 112.9 | 129 | 178 | 8.16% | 3.12% | 0% | 23.8 | 127.6 | 166.5 |
| noon **after** | 116.6 | 130 | 171 | **1.53%** | **0.14%** | 0% | **41.2** | 129.2 | 160.5 |
| golden before | 129.7 | 139 | 238 | 4.22% | 1.94% | 2.08% | 35.4 | 64.7 | 194.5 |
| golden **after** | 136.3 | 140 | 232 | **0.63%** | **0%** | **1.51%** | **57.0** | 80.2 | 188.9 |
| dusk before | 111.7 | 92 | 220 | 3.40% | 1.55% | 0% | 62.7 | 47.2 | 205.6 |
| dusk **after** | 113.1 | 96 | 207 | **0.99%** | 0.60% | 0% | **73.2** | 57.8 | 191.8 |
| night before | 31.0 | 19 | 91 | 43.35% | 27.52% | 0% | 21.7 | 8.2 | 49.6 |
| night **after** | 25.4 | 20 | 61 | 39.9% | 21.6% | 0% | 18.7 | 9.1 | 37.6 |

Both rows are single renders and the district has traffic and a crowd in it, so
the run-to-run spread is worth knowing: two renders of the unchanged build put
noon's frame mean at 112.9 and 113.0, golden's at 129.4 and 129.7. Every "after"
figure above is reproduced within that on a second sweep.

**Nothing about the light moved, and the audit is the proof.** Either side of the
change, at every preset: sun lux authored and delivered identical, sky delivered
identical over 1 path, lamp candela identical, draw calls identical, zero
implausible flags. The radiance behind each region is the same to within the
traffic moving through frame, and at noon it is the same to the last digit: the
sky-lit facade 1,115 nits before and 1,115 after, the road 6,263 and 6,263, the
sky 8,060 and 8,060, recovered through two DIFFERENT inverses because the chain
changed underneath them. Only the camera moved.

### Against the photographs, and a stale set found on the way

`tools/pano-match.mjs` parks the camera where a Mapillary panorama stood, so the
photograph and the frame differ only in what we built. The fidelity review's
matched-pair statistic — photo mean luminance against engine mean luminance —
comes from this set, and two things had to be sorted out before it could be read.

**The committed set was two bakes stale.** `docs/shots/pano-match/index.json`
records `mtime 2026-09-02` and carries no `sha256` at all (it predates the content
hash); `data/district.json` was re-baked on 2026-09-04 by the roofline round.
Rendering `1414553883288835-R` again returns a different building. So a straight
before/after over that set would have mixed this change with a re-bake, and the
review's own numbers were measured against a world that no longer exists. The set
is re-rendered here — all 70 frames, 9 stations at noon and 26 at golden — with
`--ids`, added so 35 stations do not cost 35 browser launches. It writes
`index-ids9-*.json` and `index-ids26-*.json` rather than clobbering `index.json`,
which keeps the guard the last round added; the consequence is that `index.json`
is now the STALE record and those two files are the current one for every frame on
disk. Four of the frames are force-added to git (the rest are ignored and
regenerable) and they move with this commit, which is deliberate: a committed
frame that provably does not match the bake is worse than no frame.

**The transfer, isolated.** Take the OLD frames and re-tonemap them through the new
chain at the new stop — identical geometry, identical light, only the chain moves:

| noon, 18 pairs | photo | aces only | + sRGB encode |
|---|---|---|---|
| mean luminance, median | 116.1 | 70.6 | **79.2** |
| mean luminance, range | 66.4–177.3 | **3.9**–109.3 | **9.9**–113.2 |
| % below Y=48, median | 12.7 | 53.5 | **39.8** |
| photo brighter by | — | 1.17 ± 1.27 stops | **0.86 ± 0.94** |

| golden, 52 pairs | photo | aces only | + sRGB encode |
|---|---|---|---|
| mean luminance, median | 125.2 | 104.9 | **111.5** |
| % below Y=48, median | 8.7 | 27.7 | **15.6** |
| photo brighter by | — | 0.22 ± 0.40 stops | **0.12 ± 0.36** |

**And re-rendered on the current bake**, over the same pairs:

| re-rendered | noon (18) | golden (52) |
|---|---|---|
| mean luminance, median | 70.6 -> **82.4** (photo 116.1) | 104.9 -> **109.3** (photo 125.2) |
| % below Y=48, median | 53.5 -> **31.3** (photo 12.7) | 27.7 -> **17.3** (photo 8.7) |
| photo brighter by | 1.17 ± 1.27 -> **0.57 ± 0.38** stops | 0.22 ± 0.40 -> **0.18 ± 0.39** stops |
| shadow warmth shift | 0.980 -> **0.909** (photo 0.679) | 0.843 -> **0.779** (photo 0.622) |
| scene-linear p50 | 0.4535 -> 0.4174 (photo 0.2968) | 0.3071 -> 0.2973 (photo 0.2998) |

Noon improves more than the offline isolation alone predicts (0.86 simulated
against 0.57 measured), so the 2026-09-04 massing work is worth about as much
again as the transfer is and the two are additive. Golden barely moves on the
mean, because golden was never the complaint — its dark fraction is what moves,
27.7% to 17.3%. And the scene-linear row does what it did before the change:
nothing, because it cannot see an encode.

**What that residual can and cannot mean.** 0.57 stops is inside the scatter, and
the scatter has a floor under it that no exposure change can lift: the buildings
are AUTHORED massing on real footprints (constraints 9 and 10), so the photograph
and the render are of different buildings. Per pair the offset runs from **-0.02**
stops (the render is already spot on) to **+1.47**, and station 546724041386806 —
the one the review quoted a pixel from — is a white stucco block behind a large
tree in the photograph and a two-storey red-brick shopfront in the render. A
per-pixel comparison there measures massing, not shading. Before this round that
spread was 1.17 ± **1.27** stops with one frame 5.10 stops out; it is now
0.57 ± **0.38** with the worst at 1.47.

### What it cost, stated rather than buried

**Saturation, 16-20%.** HSV saturation over pixels with max >= 8: noon 24.8% ->
20.9%, golden 21.8% -> 17.4%, dusk 40.2% -> 33.8%, night 48.3% -> 40.5%. An
un-encoded ACES output carries artificially high chroma because the missing
gamma expands channel ratios; this is that expansion going away. Against the
photographs the engine is now less chromatic than they are (noon median chroma
28.5 photo against 25.3 engine before), so a modest post-tonemap chroma lift is a
defensible NEXT change - but it is a look decision on top of a correctness fix and
it is not in this one.

**Night's lamp-pool contrast, ~13%.** Brightest 5% of the night ground band
against its median: **9.89x -> 8.53x**, pool 116.3 -> 109.6 and the road between
lamps 11.8 -> 12.8. The run-to-run spread on this metric is worth stating beside
it, because it is not small: two renders of the SAME unchanged build measured 9.89
and 11.0, the traffic and the crowd having moved through the band. So the drop is
real but it is only just outside the noise. Part of 9.89 was the missing transfer
rather than the lamps in any case - the pool-to-road RADIANCE ratio is untouched -
and a photograph of a lit street sits at 3-6x. Night's median held at 20/255, its
blacks held (27.5% -> 21.8% below 8/255) and its window-luminance spread held (sd
27.6 -> 26.5). It is a trade and it is recorded as one.

**Emitters got brighter on the display, and the fix is in files this round was
scoped out of.** `carbody.js`'s `lampEmissive()` divides a `display` constant by
the camera stop, which holds an emitter at a fixed ACES INPUT - so a transfer
function after the tonemap holds it at a brighter DISPLAY value than before.
Measured at the corridor camera, the night traffic-signal lens: mean red 96 ->
171, peak 238 -> 247, still not clipped, and the night frames read correctly,
which is why it was left rather than rushed. The restatement if it is wanted is
the same one the fog clamps got: `carbody.js` 2.6 -> 1.458, `streetfurniture.js`
signal lens 1.9 -> 1.005 and parked-car lens 1.1 -> 0.545, each holding the
display byte it held before (240, 232, 210).

**What did NOT change is the reviewer's own headline region.** `[40,60,180x260]`
on the corridor hero frame is 35-40% dark window GLASS, and that is most of what
"sky-lit rgb 59,63,69" was measuring. Split by luminance inside the region at
noon, before -> after: the glass goes 11,16,23 -> **26,32,41** (a 2.3x lift, which
is where the crush was), and the stucco goes 102,103,110 -> 107,109,114 (already
fine, and it moves 5%). The region mean therefore only goes L 25% -> 30% while the
sweep camera's non-glazed shaded facade goes 23.8 -> 41.2. Both numbers are true;
the second is the one about shading.

**And the hue is untouched**, as the measurement said it would be: that stucco sits
at hue 227 before and 228 after. The frames are no longer dark. They are still
cool, and that is hypothesis A's to fix.

### What A costs to fix, sized rather than promised

`src/sky.js`'s dome fades into `groundRadiance() = uGroundAlbedo * E / PI` below
the horizon, so it already HAS a bounce term — it is just too dark and, being
proportionally too dark against a bright sky, too blue. The numbers, so the next
round starts from arithmetic rather than from scratch:

- `uGroundAlbedo` is `0x6b6455`, linear `[0.147, 0.127, 0.091]`, luminance **0.129**,
  B/R 0.63. The district's own ground reads back at **0.18-0.19** effective albedo
  — `nits*pi/E`, plaza 6,017 nits and road 6,262 under 105,244 lux at noon,
  markings and sheen included. The dome is telling every wall in the city that the
  street below it is a third darker than the street it is standing on.
- On a wall the dome's two halves are near-equal at noon: the light meter reads
  15,006 lux from the upper hemisphere, 15,736 from the lower and 17,084 on a
  vertical (`tools/sky-once.mjs`, tabulated in `src/daynight.js`'s
  `HemisphereLight` block). So raising the albedo to 0.19 is +47% on half the
  wall's light: **+0.28 stops**, and it moves the shaded wall's blue/red from
  ~1.12 toward ~1.00.
- The acceptance test already exists: `tools/transfer-audit.mjs --colour` puts the
  engine's noon shadow shift at **0.909** against the photographs' **0.679**.
  Ground albedo alone will not close that — real warm shade in a street canyon is
  also the sunlit facade opposite, which a dome cannot model — so the honest bar
  is "move it, measure how far, and say what is left".
- **It does NOT disturb the envelope.** `audit().skyLux` integrates the UPPER
  hemisphere only (`_deriveFromProbe`, `y = H>>1` upward), so `PLAUSIBLE`'s
  `skyLux` bounds and the sweep's second negative test are untouched by it. What
  it DOES disturb is the light on every wall, which re-opens the four stops by a
  few tenths — which is exactly why it is a separate round and not this one.

## The trees do cast shadows and they do dapple - three of us measured the wrong ground

Two independent reviewers reported that the canopy contributes nothing to the
light, one calling it "the single most characteristic thing about that street and
it is entirely absent". I verified their number and added my own: at noon the
ground under the tree row read BRIGHTER than open pavement with similar local
variance. Three separate observers, one conclusion, and it was wrong.

`tools/canopy-shadow.mjs` isolates it properly. Prop buckets are welded, so
per-mesh `castShadow` cannot separate a tree from a bin; instead the shared prop
material's `alphaMap` is swapped **for the shadow pass only** for a copy whose
foliage palette column is fully transparent. `alphaTest` then discards every
foliage fragment in the depth pass while the colour pass never sees the swap, so
both arms draw a bit-identical canopy and the only difference is what the canopy
put in the shadow map. Nothing is chosen by eye: where the trees are is read from
the shipped buffers by uv palette column, where the shadow must land is those
vertices dropped along the light's own ray, and a pixel enters a mask only if a
render says the camera sees ground down it.

**At noon the canopy darkens 6,681 of 406,542 visible ground pixels by a mean
72.1/255, worst 147** - and local SD goes 14.90 to 20.53, 38% more small-scale
contrast, which is dapple rather than a flat blob. Aimed at the nearest live oak:
9,403 pixels at mean 78.0, local SD 10.8 to 16.6.

The reviewers' box `(620,560)-(960,760)` reads mean 0.057 because it is 340x200
px of carriageway no canopy shades. A box 360 px to its left in the same frame
reads 5.54 with a max of 147.

**Golden hour genuinely shows none, for two compounding reasons that are not a
bug.** The shadow is thrown 54 m toward bearing 224 degrees while the lens points
358, so 1,482 of 1,642 canopy shadow points land outside the frame; and at 7.9
degrees of elevation the street is already 90.7% building-shadowed, so a second
shadow on shadowed ground is nothing. Forcing the azimuth to 178 moves it 65
pixels into view.

Three candidate causes are dead with evidence: the LOD path at
`src/streaming.js:415` is the building-chunk path and trees never go through it;
1143/1143 and 1642/1642 canopy shadow points measure inside the sun's ortho
frustum; and the noon shadow reaches full strength at 147/255, so bias is not
peeling it.

### The resolution limit, measured rather than asserted

240 m over 2048 texels is **0.1172 m/texel**, and the vendored `PCFSoftShadowMap`
taps -1..+2 per axis for 0.469 m of filter support. An oak leaf CLUMP is 1.3-3.4 m
= 11-29 texels and is comfortably resolved. One stencil stamp texel spans
0.020-0.053 m of world, so an individual leaf cut is 0.2-0.5 shadow texels and can
never punch a separate light spot. **The district resolves foliage at clump scale,
not leaf scale.**

That is also why the bench frame looks leaf-shaped: `tree-look.mjs` uses a +/-30 m
shadow box at 0.0293 m/texel, four times finer. Matching it across the district
needs 8192 squared - sixteen times the texels - and this ledger records 3072
(2.25x) already failing the chunk-stall gate in three of seven runs. Deliberately
not shipped: it would trade the building colonnade's stripes for leaf detail.

### The finding that is not about shadows

The district plants **160 sabal, 135 queen palms and 12 live oaks**. The noon
dapple in the hero frame is thrown by a QUEEN PALM. "Dappled oak shade is absent"
is a species-mix observation, not a shadow one - and it compounds with the
corridor camera not being on Main Street east, which is where the twelve oaks
are. The oak asset works, the placement rule works, the shadow works; there are
twelve of them and the hero cameras do not look at them.

## Four reviewers on the wave: not markedly improved, and the corridor frame is not on the corridor

Six blind pairs (`tools/blind-compare.mjs`, assignment balanced and hidden), three
critics on the pairs and one on fidelity against the photographs.

**Decoded: the new build won 4 of 6, tied 1, and lost corridor-golden.** Verdicts
on the question asked - is it MARKEDLY improved:

| reviewer | verdict |
|---|---|
| general | **no** - "a good change shipped with a regression riding along" |
| architecture | **no** - "net architectural progress: zero" |
| streetscape | **yes, but only where trees exist** - real gain in all three fivepoints pairs, zero change in all three corridor pairs |
| fidelity | "a Sarasota resident would recognise the PLAN and would not recognise the STREET" |

### The corridor hero frame is not on Main Street

The fidelity reviewer checked where the camera actually stands: (-13.6, 3.0),
with no Main Street edge within 45 m, nearest named edges South Pineapple Avenue
33 m, McAnsh Square 21 m, South Lemon Avenue 42 m - and the blade legible in the
frame reads MC ANSH SQUARE. Confirmed from the route: waypoint 2 is *labelled*
"Main St @ Pineapple Ave" but sits 162 m from Five Points, and `hero-shots.mjs`
backs the camera off another 16 m and aims diagonally across the block.

This explains a finding that otherwise contradicted the tree work: the streetscape
reviewer measured **0.097% foliage** in the corridor frame against **1.835%** at
fivepoints and concluded the corridor has no street trees. It has none because the
oak profile is on Main Street east and **that frame is not there**. The asset and
the placement rule are both fine.

Every visual round in this project has been judged partly on a frame that is
misnamed and mis-sited. That is a harness fault, not a build fault, and it is
older than this session.

### The white rectangle, solved after four rounds

Four critics reported it; `sanitize-probe.mjs` refuted the NaN-guard hypothesis
and it stayed unexplained. Two blind reviewers now measured it worse after this
wave - clipped-white in the box 13.2% -> 21.5% - and both read it as a
screen-space sprite on good evidence ("top edge at y=341 at every x from 224 to
260, zero slope" where the facade's string course drops four pixels).

`whitebox-probe.mjs` refutes bloom too: 11.8% white with bloom at zero against
13.2% with it on, and `hardStepCols` **0 -> 46 with bloom OFF**. Bloom was
SOFTENING it, and every observer including me mistook the softened blob for the
artifact. Unblurred it is **one glazing pane blown to pure white**, bounded by its
own mullions and sill, in perspective. It is the glazing round's own named
residual - too sharp a mirror - arriving as a visible defect.

### The canopy contributes nothing to the ground

Two reviewers independently. Verified: between the two builds the canopy region
changed 30.87% of its pixels at mean |delta| 16.97 while the ground beneath
changed 0.15% at mean **0.04**. At noon the ground under the tree row is
*brighter* than open pavement (142.0 vs 116.3) with similar local variance (12.76
vs 13.70) - no dapple where it should be strongest. Under isolation now.

### The fidelity reviewer's two single-cause faults

1. **Everything not in direct sun is 2-3x too dark and has gone blue.** Same wall
   in `m3after-corridor-*`: sunlit rgb 199,177,146 at hue 36; sky-lit rgb
   59,63,69 at hue **221**. Four matched noon pairs: photo mean luminance
   111.7-144.0, engine 57.2-105.9. The palette is not the problem - it is
   researched and it appears the moment sun hits it. Candidate cause is no bounce
   fill, so ACES plus the physical exposure crushes anything lit only by the dome.
   **Cheapest of the five and it changes every daylight frame at once.**
2. **380 m of Main Street is 7 footprints**, two of them running 181 m and 106 m
   of continuous frontage at one height, one recipe, one colour, where the
   photographs show 6-8 m shopfronts each with its own fascia, parapet step and
   sign. Even the facade kit's 16.8 m tile is 2-3x the real lot module.

### What it says NOT to spend effort on

Streetwall height (analytic roofline median engine-minus-photo **-2.5 degrees**),
the facade palettes (correct in sun), canopy density at the census hotspot (44.0%
against 42.0%), brick pavers, sky hue (H 214 against 222), and **night, which is
the best frame in the set** - "it reads as Main Street after dark far better than
any daylight frame".

### A flaw in my own blind protocol

The streetscape reviewer de-blinded itself by fingerprinting pedestrian layout,
which is deterministic per build and identical across a pair's time-of-day
variants. Its grouping was correct and its foliage reasoning stands on its own,
but the protocol leaks and crowd placement has to be frozen before the next round.

## A browser at 0.7 fps cannot measure traffic overlap, and I reported that it could

`tools/smoke.mjs` printed `overlap 0%` at every time of day and I read that as
"junction arbitration holds in the browser rather than only in the headless sim -
the first time that has been checked". It was not a check. It was an artifact,
and the way it came apart is worth recording.

Building `junction-shot.mjs` to make the fix visible, I captured the same
junction at 60 cars with the shipped code and with `301ae39`'s single-occupant
reservation restored in a worktree. **Both arms reported 0% overlap** - against a
headless measurement of 65.38% for that same old code. A before/after that shows
no difference where a difference is known to exist is an instrument failure, not
a null result.

The cause, probed directly: **`frames: 29` after forty seconds.** This browser
renders about 0.7 fps under SwiftShader, so traffic ticks 29 times where
`traffic-sim.mjs` ticks 7,200 for a 120 s window - a sample 250 times smaller.
Worse than small, it is coarse in the wrong dimension: at `dt` = 1.38 s a car at
31 km/h covers **12 m between samples** while the overlap threshold is 2.5 m, so
two cars pass clean through each other and nothing is counted. The statistic is
not noisy at this frame rate; it is structurally blind.

Both tools now say so. `smoke.mjs` reports the traffic tick count and explicitly
does not print overlap; `junction-shot.mjs` keeps the capture, because
queue-versus-crossing is a geometric arrangement rather than a sampled statistic,
and prints a NOTE beside the number whenever the tick count is under 500.

The general lesson, which this ledger has now paid for in a fourth distinct form:
a measurement inherits the sampling rate of whatever drives it. The headless
harness exists precisely because the AI needs no GL context, and the reason it
was written - "turns a 40 s capture into a 2 s run" - is the same reason the
browser cannot substitute for it.

## audio.js and wanted.js reach the game, with zero diff to either module

88 KB built and verified on 2026-09-02, then deliberately shelved while the
budget gate was red at 18.5 ms, and never picked back up when it went green.
Neither was referenced anywhere in `district/main.js`.

**Both were as finished as the ledger claimed**: `src/audio.js`, `src/wanted.js`,
`src/hud.js` and `src/pursuit.js` all have zero diff. Everything wiring needed
was already public and behaved as documented. Only `district/main.js` and
`tools/wanted-test.mjs` changed.

`bindPursuit` is duck-typed and `PursuitUnits` implements none of its vocabulary,
so the shim lives in main.js - the file that already owns the pursuit lifecycle -
rather than making either owner's module learn about the other. It honours fleet
size, convergence target, speed multiplier and give-up radius, and deliberately
omits the per-unit intercept and search-ring roles because PursuitUnits drives
every car greedily at one target. `wantedReport().notHonoured` says so, rather
than a recorder quietly faking it.

`getUnitPositions()` skips empty fleet slots: their hide-matrix translation is the
world origin, so feeding them back would park a phantom officer at 0,0 holding
contact forever and no chase would ever decay.

The HUD already drew five stars, animated the escalation flash and exposed
`setWanted()`. The meter was simply never fed.

### A false alarm, and the recalibration that found it

The first "is the static capture unchanged?" run reported **14% of pixels
different, reproducibly**. It was the harness: the camera was derived from
`vehicle.position`, sampling the suspension mid-settle, which landed 0.43 mm
apart between loads - a 0.01 px shift, invisible as a shift but 1 LSB across the
whole frame. The giveaway was that a control run of the OLD code clustered with
the new one. Camera pinned to the spawn constant, both arms re-run:

| | before | after |
|---|---|---|
| draw calls / scene calls | 75 / 67 | 75 / 67 |
| triangles | 293,707 | 293,707 |
| objects / meshes / instanced / lights | 261 / 181 / 5 / 12 | 261 / 181 / 5 / 12 |
| camera children | 0 | 0 |
| pursuit / audio built | null / false | null / false |

Cross-arm difference 2,090 px (0.41%) against 985-1,171 within-load and up to
4,080 cross-load on the same build - renderer non-determinism, quantified and
bounded rather than asserted. **The instrument was verified in both directions**:
40 pedestrians move 2,049-2,741 px and the police fleet adds +3 draw calls and
+11,208 triangles. The first camera tried was BLIND - the fleet changed zero
pixels there - which is why it was recalibrated instead of the null being
believed. Strongest single result: within one load, `reportCrime` -> 6 cars ->
`clearWanted` returned calls and triangles to exactly their idle values and the
PNG to a byte-identical hash.

### Cost and behaviour

Wanted idles at 0.31-0.41 us per update with zero allocations. Audio idles at
exactly zero because the object does not exist: nothing is built until the first
`pointerdown`/`keydown`/`touchstart`, so a headless capture creates no
AudioContext, no nodes, no `THREE.AudioListener` and no camera child. First
gesture costs 87.5 ms under SwiftShader, and `__district.initAudio()` exists to
move that behind the loading screen.

`wanted-test` is now 97 checks (was 83), adding the partial-setter shape main.js
actually presents and a cross-file invariant that the response table never
outgrows the wired fleet capacity.

A bug the browser probe caught: sirens kept wailing after the level cleared,
because `updatePursuit` only runs while a fleet exists, so voices held their last
wail forever. Silenced on the edge.

### The decision this round did NOT make

**Nothing in the game reports a crime automatically.** `vehicle.js` has no
collision detection and peds and traffic never collide with the player, so the
police are reachable only through `__district.reportCrime()` or `setWanted()`. A
speed-based `reckless` trigger was considered and rejected as a silent decision:
the drive-through autopilot crosses 108 km/h, so it would spawn police inside the
budget gate. Making the wanted system reachable in play needs collision detection
first, and that is its own round.

## Glass: bronze, and half the recorded finding did not reproduce

Recorded as "engine B/R 1.49-2.07 against a reference of 0.67-0.83, and pane:wall
0.49 against 0.12. Not started."

**The reference band is confirmed** - an independent detector over 317
photographs puts the median at **0.804**, stable at 0.796-0.899 across all four
corridor legs. **The pane:wall half does not reproduce.** Measured before the fix
it was 0.231 engine against 0.247 reference on the same detector: the
environment term added two rounds ago had already closed it, and the ledger had
simply never been updated.

### The capture nearly straddled a change, and the defence is now structural

The noon exposure fix landed in the shared tree *while this round's before arm
was being captured*. I flagged it; the arm was straddling, so it was discarded
and re-shot. `glaz-probe` now hashes `daynight.js`, `materials.js`, `facades.js`,
`post.js` and `sky.js` at page load AND at every shot, stamps both into each
capture's meta, and prints a loud SOURCE DRIFT line if they diverge mid-run. Both
final arms carry one identical stamp and only `materials.js` / `facades.js`
differ between them.

### Cause: both halves, and "too much sky" was wrong

- **City share was already 0.53-0.90** (median 0.66), measured per pixel from the
  world-height pass. The panes were already reflecting mostly the opposite
  facade, so "not enough opposite-facade" was the wrong hypothesis.
- **The opposite facade was itself rendered blue.** A chrome-ball probe measures
  sky irradiance on a vertical surface at B/R 1.402; `urbanAlbedo` is 0.777; so
  `urbanAlbedo x iblIrradiance` came out at B/R **1.098** - a city no warmer than
  an overcast day, because the sun that actually lights it was missing.
- **The coating was blue**: seven recipes authored at F0 B/R 1.17-1.53.
- 1.45 x 1.37 = 1.99 against a measured 2.03. The model predicts the measurement.

Verified by one-lever A/Bs on identical masks with the wall as a x1.000 control:
coating alone 2.405 -> 1.341 at luminance x0.99; sun term alone 1.272 -> 1.091.

**A near-miss worth recording.** The first sun A/B came back null and the
environment term was nearly filed as inert. It was the DIAGNOSTIC that was wrong:
`daynight.follow()` moves the sun light *and its target* with the viewer, so the
direction is `position - target`, not `normalize(position)`, and at a station
360 m from the origin those differ by **70 degrees**. The A/B had been run on the
one view in the set where the shader correctly does nothing. The tool now reports
per capture what fraction of pane pixels see a sunlit wall opposite - 0% to 100%
across the 12 views - so a null can be read correctly rather than believed.

### Result

| | glass B/R | shift | pane:wall |
|---|---|---|---|
| reference, 317 photographs | **0.804** | **0.915** | **0.247** |
| noon before -> after | 2.028 -> **1.298** | 1.811 -> **1.113** | 0.375 -> 0.461 |
| golden before -> after | 1.183 -> **0.819** | 1.363 -> **0.885** | 0.398 -> 0.436 |

Golden lands essentially on the reference. Wall B/R is unchanged either side
(1.139 -> 1.137 noon, 0.856 -> 0.854 golden), which is the control saying only
the glass moved.

The change adds the sun to the wall opposite - the opposite wall's normal is
`-geN`, so it is lit exactly when this one is not, needing no new parameter - and
subtracts this side's own shadow across the street using the H and D already
derived from 2,962 baked edges. At noon's 75.6 degrees the shadow line is below
the pavement; at golden's 8 degrees it stands at 12.9 m, which is what stops
golden hour reading as two sunlit walls facing each other. `directionalLights[0]`
is the scene's only directional light and three.js folds intensity into colour,
so **zero new uniforms, materials, textures, programs or draw calls** - captures
report calls 179 and 59 programs identically either side.

The seven recipes were re-authored at **constant linear luminance**, so the hue
change and the environment change stay separable, and as a distribution rather
than one value: midOffice 1.53 -> 0.65 (bronze, the 1970s precast era),
retailStrip 1.42 -> 0.81, warehouse 1.17 -> 0.96, and **bayTower kept cool at
1.21** because the reference has a genuine blue tail - 11% of views above 1.2 -
and the condo towers are it.

### Open, and why it was not chased

Noon still sits at 1.299 against 0.804 on the same detector. The coating lever is
exhausted: measured response is `pane_BR proportional to coating_BR^0.68`, so
closing it by colour alone needs a district-wide coating at B/R ~0.49 - uniform
reflective bronze, hitting the number by flattening exactly the variety the round
was told to preserve. The real cause is that our glazing is a **stronger, cleaner
mirror than Sarasota's stock** (F0 0.22-0.30 at roughness 0.07-0.13, with no
interior term on the facade atlas at all), so it returns the sky's saturated blue
where a real window shows a dark room. That is a mirror-strength fix, and it
would re-open the earlier "every window is a flat dark fill" finding.

Also open: H and D remain district-wide constants, so a bayfront pane still gets
a 16 m skyline opposite; no night A/B (the sun term is arithmetically inert at
0.6 lux but unmeasured); and shopfront `TRIM.glass` is deliberately untouched,
sitting below the horizon and outside the measured band in both domains.

`tools/pane-tint.mjs` is 16 self-tests including an opposite-reading pair, a
flat-field refusal, and one asserting that reading an ACES-encoded frame with the
sRGB inverse gives a different, wrong answer - 0.722 against 0.572. The transfer
choice is load-bearing and now tested.

## Canopy mass: the obvious remedy was the one thing that did not work

The `xings` decomposition said the canopy was too thin inside an envelope that
was already the right size - `covered` 0.454 against the photographs' 0.576 at a
matching span and a matching 24 px mean run. The obvious fix is more clumps.

**More clumps is precisely what fails.** +50% on the same branch lines took the
tunnel `covered` 0.454 -> 0.482 and `meanRun` 23.8 -> 28.5 px, with `xings` going
the WRONG way, 38.6 -> 33.7. It buys mass by MERGING. Every later count step
reproduced it.

The diagnosis that mattered: the crown had **seventeen branch lines to hang 101
pillows on**, so the nearest other clump to the median clump sat at 0.12 of the
two radii - concentric, not adjacent. The frames showed it plainly: four or five
fat sausages of leaf with open sky between them. The lever is DISPERSION, not
quantity.

`OAK_TWIGS` 3 -> 6 secondaries; the far tier gets a web of its own (a move
between tiers, not new tubes); `CLUMP_HUG` 0.42 -> 0.90 re-expressed against each
clump's own smallest half-extent so the attach ratio is 0.900 by identity rather
than as a worst case; `CLUMP_SIDES` 4 -> 6; the ring band retuned at an unchanged
outer figure; counts 52/46 -> 65/58.

`CLUMP_SIDES` 4 -> 6 is the note from two rounds ago coming due. It was set at
four with the comment "if the crown is ever short of mass again this is a real
lever", after that round measured it buying mass and nothing on straightness.
This is that round, and it is the only mass lever that does not coarsen the
grain: it moves no clump, changes no world-space size and touches no stencil - it
stops a four-gon biting chords out of a mask already cut.

### Result: coverage up, and grain UNCHANGED

| | span | runs/row | meanRun | skyInSpan | covered |
|---|---|---|---|---|---|
| photographs | 0.909 | 25.7 | 22.8 | 0.326 | 0.576 |
| up | 0.765 -> **0.811** | 11.25 -> **14.03** | 43.6 -> **39.6** | 0.370 -> **0.317** | 0.482 -> **0.554** |
| row | 0.935 -> **0.966** | 16.25 -> **19.47** | 32.3 -> **29.8** | 0.440 -> **0.421** | 0.524 -> **0.560** |
| tunnel | 0.896 -> **0.904** | 19.70 -> **20.84** | 23.8 -> **23.3** | 0.493 -> **0.477** | 0.454 -> **0.473** |

`meanRun` FALLS on all six frames across both hours and `xings` rises on all six.
oak-up's `skyInSpan` is past the photographs at both hours. `straightFracInner`
improves on up (0.112 -> 0.087) and row; `texture` on up goes 0.2466 -> 0.3402.

**Cost: 954.9 -> 1745.3 triangles per oak (+790.4), district props 287,732 ->
297,182 (+9,450).** Palms bit-identical at 295.1, md5-matched frame for frame.
`CLUMP_SIDES` is 512 of that 790 and is the only change raising coverage and
porosity together; the bough web is the bargain at +0.039 of `covered` for 13.4
triangles a tree. Two of the shipped changes COST coverage and are in anyway,
because they are what holds `meanRun` under its starting value.

### A setting that scored better was rejected on looking at it

83/74 clumps reaches `covered` 0.602/0.566/0.497 - past target on two frames - at
`meanRun` 54.2/36.7/28.7 and `xings` **below the baseline's**. That is the
solid-green-blob failure, and the metric rewards it. Shipped setting is the one
where `meanRun` falls everywhere.

### And there is an analytic ceiling behind the residual

For n independent stencilled plates of duty q, coverage is `1-(1-q)^n` and the
mean gap is `g0/n`, so `covered` and `meanRun` are LOCKED: at this stencil's
q = 0.381, `covered` 0.576 arrives with `meanRun` near 26 px however the mass is
paid for. Dispersion moves that frontier - it is why 0.554 now comes at 39.6 px
where 0.482 used to come at 43.6 - but does not remove it. Reaching 0.576 on
every frame at unchanged grain needs a FINER stencil, which is the round the
plates were fixed in and was deliberately not reopened.

**The tunnel's full-frame `covered` cannot reach 0.576 for a reason that is the
frame, not the tree.** `span` runs from a row's leftmost dark pixel to its
rightmost, so looking down a street it spans both walls and counts
vanishing-point sky - which no canopy can fill - as sky in span. Cropped to the
near crown the same pair reads `covered` 0.595 -> **0.637** and `skyInSpan` 0.242
-> 0.218, past the photographs, at `meanRun` 28.2 -> 24.0. Now noted in the
tool header.

Tunnel `boundaryD` fell 1.605 -> 1.586, located by crop to the near crown's own
outline (1.589 -> 1.551) while that same crop's `holesPerK` ROSE 5.88 -> 6.34.
The crown is not smoothing; its silhouette is, as it fills. The photographs sit
at 1.538, so it moved from above them toward them.

## Junctions pass non-conflicting movements, and throughput went UP

`src/traffic.js` reserved a junction for ONE car at a time, so a northbound and a
southbound through-movement queued for each other. Replaced with conflict-based
arbitration: a movement is (approach edge+direction -> exit edge+direction),
planned at the stop line, and two movements conflict when the point sets their
cars will occupy come within 3.6 m.

### The ledger's own before figures did not reproduce

Recorded here as 14.6% overlap at 30 cars and 64.3% at 60. Neither reproduces:
`data/district.json` was re-baked on 2026-09-04, after those numbers were taken,
and same-edge overlaps were NOT in fact eliminated on the current bake (3-4k
frames of them). Re-measured on HEAD over 8 seeds x 180 s: **33.79%** at 30 cars
and **73.25%** at 60, with closest approach 0.00-0.29 m - interpenetration, not
near-misses. A stale baseline would have made any change look better than it is.

### 3.6 m is read off the district, not chosen

Over all 6,404 movement pairs at the 503 multi-approach junctions the separations
are trimodal: 1,983 at 0.0-0.5 m, 1,132 at 2.20 m (one lane offset), 346 at 4.40
m (two). Only 112 pairs fall in the 2.5-4.0 m band. 3.6 m sits in that gap -
above the 2.5 m overlap threshold, so **nothing the model waves through can
register as an overlap by construction**, and below the 5th percentile of
reciprocal through-pairs. It frees 1,705 of 6,404 pairs.

A junction's arms are separate polylines and joining them draws a phantom segment
through the node that drags reciprocal through-pairs from 4.40 m to 2.27 m,
making 95% of them conflict - which would have silently reproduced the old
one-at-a-time behaviour while looking like a fix.

### Deadlock is bounded, not assumed away

FCFS ticketing gives starvation-freedom in the arbitration, but physical gridlock
in a grid of short blocks is not an arbitration property and no reservation rule
prevents it. The guarantee is a bounded-hold rule: a car stationary AT a junction
- refused, or holding one it has not finished crossing - for more than 20 s is
removed. Any wait-for cycle must contain a relation crossing a junction, because
same-edge following orders cars strictly by position along a finite edge and
cannot close on itself.

Tested where it occurs rather than argued. Static player, 300 s, worst immobile
time measured OUTSIDE the module:

| | worst immobile, rule on | rule off |
|---|---|---|
| n=60 | 20.0 s | **172.8 s** |
| n=120 | 20.0 s | **280 s (permanent)** |
| n=200 | 20.0 s | **280 s (permanent)** |

**And a control against the obvious objection**: with the rule off across the
whole grid, overlap is unchanged (0.00/0.20/1.15 -> 0.00/0.20/1.24). So the
overlap result does not come from deleting jammed cars. What the rule buys is
bounded waits - max 24.9 s against 78.6 s at 60 cars.

### Result

| config | overlap before -> after | crossings/min | mean km/h |
|---|---|---|---|
| n=30 | 33.79% -> **0.00%** | +17.3% | +15.7% |
| n=60 | 73.25% -> **0.20%** | +18.9% | +18.5% |
| n=90 | 87.10% -> **1.15%** | +22.0% | +18.4% |
| static n=90 | 99.14% -> **5.74%** | +107.1% | +66.4% |

Throughput and mean speed are up in **all nine cells**, so this is not a
timidity fix. Verified independently on the same harness by swapping HEAD's
traffic.js back in: 60 cars, same seeds, **65.38% -> 0.17% overlap while
crossings/min went 800.9 -> 875.4**. Same-edge overlaps genuinely zero. Closest
approach 0.00-0.29 m -> 1.0-3.3 m. Max simultaneous movements in one junction 1
-> 5.

`tools/traffic-selftest.mjs` is 22 two-way tests, including "the predicate is not
a constant across the district" (4,699 conflicting, 1,705 free) - the check that
would catch an arbitration that had quietly become always-yes or always-no.

Three supporting changes were forced by measurement: car-following now reaches
across the junction (a car lost its leader the moment the leader crossed and
parked on the node - a third of residual pairs); the stop line moved 2.6 -> 6.0 m
because OSM nodes sit at intersection CENTRES; and don't-block-the-box sized at
14.6 m, the room a car needs to come to rest past the clear distance.

Cost: `update()` 0.098 -> 0.107 ms at 60 cars. Movements are interned so the hot
path allocates nothing - before interning, per-frame allocation produced a 44 ms
GC spike at 90 cars.

**The browser-side budget gate for this round is NOT measured, deliberately.** I
ran it and threw the result away. It came back at 799,708 triangles and 230 draw
calls against a clean 784,737 / 225 - but `src/streetfurniture.js` was modified
at 02:09:02 by a canopy round still in flight and the drive-through capture wrote
at 02:09:16, fourteen seconds later, so the run measured this round plus two
others that are not finished. Attributing +14,971 triangles to junction
arbitration would have been wrong and would have sat in the ledger looking
authoritative.

The general point, since this working tree now routinely has three rounds live at
once: **a whole-district budget capture cannot be attributed to one round unless
the tree is quiet.** Per-round scene-graph triangle counts still can be, because
they are computed from one emitter in isolation. The gate is re-run against a
quiet tree before the round is called done.

### Residual, named

Overlap is not zero at 90 cars and the anti-gridlock rule still fires 6-10 times
per 180 s run there. The cause is not the conflict model: it is clusters of 3-15
m blocks where the OSM graph models one large intersection as a ring of tiny
edges, so a car stopping on a sub-13 m block cannot clear the junction behind it
- structural hold-and-wait no reservation rule removes. The obvious remedy (one
car at a time on short blocks) measured WORSE on every axis and is reverted, not
shipped. The real fix is graph-level, merging sub-15 m clusters. At the densities
this project ships - 30 in main.js, 60 in the chase harness - the residual is
0.00-1.69% against a 33-88% baseline.

## Limb tubes: four of five proposed levers measured and rejected

After the leaf plates were fixed, the branches became the straightest thing in a
close frame - 3-gon swept prisms, which present a dead-straight silhouette from
any angle and which the leaf stencil never touched.

### The brief was wrong in two places, and the builder measured rather than followed

An opt-in `--drop <palette column>` in `tools/tree-look.mjs` withholds one
surface from the SAME geometry through the SAME material, so leaves-in-situ can
be scored against leaves-plus-bark. `straightFracInner`, golden:

| frame | leaves only | shipped | bark alone |
|---|---|---|---|
| oak-up | 0.089 | 0.122 | n/a (8% mass) |
| oak-tunnel | 0.056 | 0.120 | 0.698 |
| oak-row | 0.054 | 0.054 | 0.878 |

The tubes really are near-totally straight in isolation. But "bark contributes
more than leaves" holds on oak-tunnel (+0.064 against a 0.056 leaf residual) and
NOT on oak-up (+0.033 against 0.089), and is zero on oak-row.

And **palms are untouched by anything done to `limbTube`** - palm trunks use a
separate `palmTrunk` emitter. A new `--segments` mode in `foliage-grain.mjs`
prints where the >=24 px runs actually are, and on oak-tunnel 711 px of the
2,026 px of long run - **35%** - is one sabal trunk at frame left, out of this
round's reach entirely. On oak-up, 232 px of 1,397 is the bench's own shopfront
wall, a harness artefact that floors that frame at about 0.020 no matter what
any tree does.

### What the proposed levers actually bought

- **Radius/cross-section jitter**: 0.128 / 0.123, WORSE than baseline. It moves
  the ends of a straight run, not its middle.
- **Per-segment phase drift**: no straightness effect, and it folded the tube at
  sharp bends - 2 backfacing until damped.
- **More sides, 3 to 4**: +42.0 tris/tree (+504 district), oak-up 0.112 to
  **0.135**. Worse, and for a reason that generalises: the outline of a swept
  prism is one straight mesh edge per segment per side whatever n is.
- **Subdivision**, at two levels. `GNARL_SUB = 3` costs +259.5 tris/tree for
  0.122 to 0.127. `SUB = 8` with the trunk cut up **doubles** the per-oak count
  to ~1,942 for 0.124. Null or worse both times, because splitting a 105 px run
  into 81 + 39 leaves both halves over the 24 px threshold while lengthening the
  contour.

All four reverted. The stencil was the only mechanism that worked, and it took
four failed cuts to render: a 4% bite was sub-pixel; driving it to the rails
pinned depth flat for 20-40 rows; a facet spanning all 64 tile columns minified
u by 6-8x, so mip 0 point-sampled speckle while coarser mips averaged the fringe
into a smooth ramp that alphaTest turned back into a straight edge (a facet now
spans 12 texels); and per-facet offsets left orphan slivers where two facets met.
At half-facet depth the noise severed 15 of 64 rows outright and only mipping hid
it - `BARK_CORE` texels are opaque by construction now.

### Result, both times of day, zero triangles

| frame | golden | dusk |
|---|---|---|
| oak-up | 0.122 -> **0.112** | 0.132 -> **0.119** |
| oak-tunnel | 0.120 -> **0.114** | 0.149 -> **0.129** |
| oak-row | 0.054 -> 0.054 | 0.056 -> 0.056 |

954.9 tris/oak and 295.1/palm, district props 287,732 - bit-identical to
baseline. D, holesPerK and xings all rise; `canopy-density` moves the right way
(runs/row up on every frame, meanRun down). Palm frames bit-identical on both
instruments at both hours.

**One real regression**: `texture` on oak-up, -0.0077 golden and -0.0042 dusk,
because fraying replaces bark pixels - which carry a strong gradient - with sky.
Tunnel and row both improve. Not recoverable: more radius payback helps texture
and breaks the backfacing gate at FAT >= 1.22. Degenerate count went 1 -> 2 per
400 trees (not backfacing); it persists down to FAT 1.06, so it is a knife-edge
rather than a threshold.

### The gate was deliberately made stronger

`leaf-mask.mjs` check 3 asserted that any vertex leaving v = 0.5 must address the
FOLIAGE column, which flagged 10,038 legitimate bark vertices. It now asserts per
zone: a v in an oak or palm zone carries the foliage column, a v in the bark zone
the bark column, anything else the opaque guard. Strictly stronger - the old form
could not have caught a bark vertex landing in the sabal zone. Check 3b untouched;
`--break` still fires 19 checks.

### Honest limit

The limbs are no longer ruler-straight and the edges carry an irregular 2-4 px
roughness with no splinters or holes - but they still read as smooth tapered rods,
not as live oak limbs. At street distance the fringe is sub-pixel and mips away,
which is why oak-row is unmoved. A harder setting was built (coverage 0.55,
oak-up 0.109) and REJECTED on looking at it: long slivers peeling off the limb,
reading as a splintered stick. The milder setting shipped.

What remains straight on these frames is the palm trunk (a different emitter),
the bench wall (a harness artefact), and limbs left exposed because `covered` is
0.48 against the photographs' 0.576 - which is the canopy-mass round, not this one.

## The leaf plates stop reading as cards — by grain, not by the radius I prescribed

The stencil round moved every metric and the close-up still read as flat
quadrilateral cards with holes punched in them. This round fixed that, and the
interesting part is that two thirds of the plan I handed the builder was wrong
and it measured rather than followed.

### The diagnosis was arithmetic

`CLUMP_SIDES = 4`, so a clump's silhouette between two ring vertices is a CHORD
with uv interpolated linearly along it. The ring vertices land at stamp radius
0.805–1.000, outside the mask's solid core at `OAK_STAMP_R = 0.70` — but the
chord's midpoint reaches only **0.569–0.707**, inside it. The mask was solid
exactly where the quad's own edge ran. Sides needed for the chord to clear a
0.70 core: eight.

That made the comment in `leafClump` false as written — "its boundary is INSIDE
the polygon's in every direction, so the silhouette that reaches the frame is
the mask's and never the quad's" holds at the four vertices and fails on the
four edges between them.

### Two of my three prescribed levers were wrong

**Shrink `OAK_STAMP_R` under the chord.** Pulling the falloff to 0.44 cleared
every chord and cost **eight points of massFrac** for 0.02 of straightFrac. The
arithmetic was right; the remedy was not. The falloff is now gentle
(`OAK_STAMP_R = 1.00`, the ring itself) and the edge is broken by GRAIN. Chord
test on the shipped stamp: the longest unbroken solid run an edge crosses is
14.7% of its own length on average, 46.5% at worst, against 21.6% / 71.2%.

**Pay the mass back by enlarging the plate.** Already spent. Over 40 trees the
*realised* `rad/spread` has median **0.116** against a nominal floor of 0.195 —
the clearance caps already set the size of most clumps, and multiplying the
nominal by 1.6 moves the median by nothing (p90 0.207 → 0.215). Coverage has to
come from the stencil.

**And `CLUMP_SIDES`, measured so it need not be spent.** At identical mask and
duty, straightFrac up/row/tunnel is 0.177/0.080/0.069 at four sides and
0.199/0.080/0.068 at eight. Six and eight buy MASS and nothing measurable on
straightness. A real lever for mass, a false one for cards; now a comment on the
constant.

### What actually worked: square stamps

3 × 64×64 in place of 7 × 64×32, inside the same atlas rows. A plate is round in
world space, so at 64×32 the vertical axis carried half the resolution and set
the floor on leaf grain. Square, at equal duty and before any retuning:
straightFrac 0.196/0.081/0.067 → **0.161/0.055/0.066**. Paid for in variety (7
stamps → 3), with the ring phase still rotating the window continuously.

Alongside it: the `h3` dither is gone — uncorrelated, and *over Nyquist*, since a
32×32 cell grid on a 64×32 stamp is one coin per 2×1 texels — and `uvAt` drops
its radius argument, so every ring vertex lands at stamp radius 1 instead of 60%
of them sitting on a clamp.

All of it texture and uv: **956.9 → 954.9** triangles per oak, district props
287,820 → 287,732.

### A defect in the instrument, found by the builder

A straight run along the CROP RECTANGLE is not a silhouette edge, it is the crop:
canopy reaching the frame edge makes the contour follow it. On the reference,
**85–100%** of every canopy station's straight edge is border, so the
photographs' apparent 0.044 is really **0.007** of actual leaf silhouette — the
target I set was three times easier than it looked, and it flattered any build
that happened to fill the frame. `straightFracInner` now drops segments with both
endpoints on the crop edge, from numerator and denominator alike.

### Where it landed

`straightFracInner` at golden, across both rounds:

| frame | before r1 | after r1 | after r2 |
|---|---|---|---|
| oak-row | 0.538 | 0.134 | **0.054** |
| oak-up | 0.923 | 0.235 | **0.122** |
| oak-tunnel | 0.488 | 0.247 | **0.120** |
| photographs | | | 0.007 |

Row is down tenfold. The 0.10 target was not reached everywhere and is not
claimed to be. Every other column improved or held: oak-row D 1.396 → 1.529,
holes 3.49 → 5.25, xings 21.93 → 31.12, texture 0.268 → 0.319, mass 32 → 33.

Budget: draw calls **225** unchanged, triangles **784,737** (down 962 from the
stencil round) against an 830,000 warn, chunk stall **8.3 ms** — back to exactly
its pre-stencil value, inside the 5.3–24.2 ms band this ledger records for that
metric on identical builds.

### Still wrong, and the next thing to fix is not the plates

The residual straight edge at close range is largely the **limb tubes** — 3-gon
tubes with dead-straight silhouettes that the stencil never touches and that a
more porous canopy now exposes. In the builder's offline silhouette simulator
(shipped emitters, shipped stencil, software-rasterised, verified against a null
that reads 0.94 with the alpha test off), adding bark takes oak-up from 0.178 to
0.234 and oak-tunnel from 0.066 to 0.172.

A faint hairline of surviving quad edge is still visible against the sky where
alpha just clears the 0.42 test. And at 3.5 m the crown reads as hard-edged
texel-quantised blobs — a stencil at magnification — rather than as leaves.
Pushing porosity harder made that worse rather than better: the frame started
reading as scattered angular flakes, which is a different failure and not an
improvement, and the shipped setting backed off from it.

`ALPHA_TEST` 0.42 now sits above the oak zone's coverage (0.381). The comment
claiming it sits "below the coverage of every zone" was false when written at
0.346; it now says so and names the palm zones it *is* below.

## Foliage: an alpha stencil through a uv channel nobody was using

The oak round shipped crowns of ~48 flat plates. The complaint — "the leaves are too
coarse" — had no number attached to it, and this ledger's own history says an
unmeasured visual judgement is how the last four rounds went wrong. So the round
began with an instrument.

### The instrument, and the two bugs a hexagon found in it

`tools/foliage-grain.mjs` scores a canopy crop on four independent things:
`boundaryD` (box-counting dimension of the canopy/sky silhouette), `holesPerK`
(enclosed sky per 1000 canopy px, with median area), `xings` (canopy/sky
transitions per scanline) and `texture` (RMS luminance gradient inside a mask
eroded by 2 px, so the silhouette cannot inflate it). Segmentation is Otsu on the
crop's own histogram — a colour rule is what under-read the backlit wall in the
census and it inverts at golden hour. A crop that is not bimodal reads n/a.

`--selftest` builds four rasters whose order is known in advance: flat, hexagon,
eight smooth pillows, fractal canopy. It earned its keep twice before the tool was
ever pointed at a frame. The hexagon found the mask comparing unrounded luma
against a threshold that names a histogram BIN, reporting the hexagon as 0% mass.
It then found `boundaryD` returning `1 - slope` — the relation for boundary LENGTH,
where counting boundary CELLS is box-counting and wants `-slope`. A hexagon was
scoring D = 2.01: a boundary dimension of two, for six straight sides. Neither
would have been visible on a real frame, where 1.4-ish looks like an answer.

### What it said, and what it killed

Against the 33 reprojected stations the census flagged as canopy-overhead, the
photographs sit at D **1.538**, holes/1k **3.57**, xings **50.0**, openFrac **0.401**,
texture **0.247**, and the spread is tight (D 1.41–1.53). The oak crown from
underneath sat at D **1.035** — the self-test's hexagon is 1.008.

`--sweep` then killed the obvious fix. Holding coverage constant and varying only
plate count, 16x more plates buys xings 3.3 → 14.3 against a target of 50. Spending
the entire 56,184-triangle headroom on the twelve oaks does not reach it and leaves
nothing for the 276 palms. Overlapping convex opaque blobs merge into a blob.

### Two wrong calls I made from simulation, and how each was caught

**Wrong once: the clumping steer.** I concluded from `--stencil` that the
photographs' crossings were "sky channels opening outward between discrete leaf
clumps", and told the builder to redistribute the oak leaf mass. Put to the
photographs — for every interior sky run, does it reach outside? — it inverts:
they are **40% open, 60% enclosed**; the engine crown was **85% open**. Ours was
the loose one. Rebuilding into clumps would have moved it further from the
reference while the number I was steering by improved. `openFrac` is now a fifth
column on every frame so the next such claim meets it.

**Wrong twice, underneath the first: a scale confound in my own instrument.**
Every synthetic raster was 320 px wide, and the tool normalises only frames WIDER
than 1024 — so the synthetics were never normalised while every photograph was.
`xings` counts per ROW and `holeMedian` is an AREA, so the simulations understated
themselves by 3.2x and tenfold against the very target they were compared with.
Rebuilt at 1024x528 the subdivision result strengthens (128 plates: D 1.060), and
the stencil sizing moves from the K=16 I had recommended to K≈26–32 — reversing a
"K=32 is sub-pixel speckle, do not use it" warning I had also issued.

### The change

`propMaterial()` carries an `alphaMap` + `alphaTest 0.42` addressed through the uv
channel that has held a constant `(paletteU(surf), 0.5)` since the kit was written.
The palette is 16 texels on `NearestFilter`, so `u` anywhere inside a texel resolves
to the same entry and `v` was never read at all — a free 2-D stencil per surface id,
at **zero triangles, zero new materials, zero new attributes**. Atlas 1024x512, one
64-wide tile replicated under every palette column so linear filtering at a column
boundary can only blend the tile with a copy of itself. Mipmapped, so a distant
crown closes back into a solid mass rather than dissolving.

Free alongside it: palm crown reach became a fraction of trunk height (mean R
1.69 → 2.78 m, crown diameter 3.4 → 5.6 m), the queen arc stopped plunging
(tip drop 1.70x reach → 0.97x), and oak clump normals splay toward the crown
centre so the crown lights as a volume (texture 0.098 → 0.230).

**Shadows cut for free.** three.js copies `alphaMap`/`alphaTest` onto the derived
depth material, so leaf shadows became leaf-shaped. `tree3-shadow-base.png` shows
solid rectangular blocks; `tree3-shadow-after.png` shows dapple.

### What was paid for, and it is not nothing

The stencil cut the crown to 26% mass and read skeletal. Paying that back cost
clump counts 26–30/22–26 → 52–60/46–54 and a third twig ring:

| | before | after |
|---|---|---|
| oak FAR `tree` | 287.9 | 495.9 |
| oak NEAR `treeDetail` | 238.3 | 461.0 |
| **oak per tree** | 526.2 | **956.9** |
| **palm per tree** | 295.1 | **295.1** |
| district props | 282,738 | 287,820 |

+430.7 per oak, +5,082 district — 9.0% of headroom, all of it on the twelve oaks.
The round is **not** the zero-cost change its mechanism suggested and must not be
described as one.

### Gates

`gates:static` PASS. `oak-audit --tiers` 0 backfacing across all eight
tier/handedness combinations; `--attach` 0 detached over 54,234 clumps with the
`--break` opposite reading live at 53,901. Budget: draw calls **225** (unchanged),
triangles **785,699** against an 830,000 warn, chunk stall 9.7 ms — a WARN that was
already 8.3 ms on the previous run and whose own noise band this ledger records as
5.3–24.2 ms on identical builds. Not attributable to this round.

New gate `tools/leaf-mask.mjs` asserts the guard band is alpha 1.0000 at all 16
palette entries, every `maskU` stays inside its own texel, every foliage vertex
addresses the palette column it claims, and **all 17 non-foliage prop kinds (19,176
vertices) sample alpha 1.0** — alphaTest can only discard, so those props draw
exactly the pixels they drew before. `--break` fires 19 checks.

**A clearance regression, caught mid-round by auditing before committing.** The
density restoration pushed the oak near tier to 3.95 m over a carriageway with a
4.20 m minimum — a branch in truck clearance. Localised to a twig tube whose lift
test ran on the station centreline while the ring reaches beyond it. Now 4.44/4.49.
Separately, the audit showed the PALMS had been violating the frontage rule all
along (3.78 m toward a guaranteed 2.2 m, and 3.93 m over the road) because reach
was measured from a trunk top that sways with nothing subtracted; the clearance
gate only ever checked oaks. Now 2.00 m and 4.33 m, with a wider crown.

### Where it landed, and what did not close

| frame | D | holes/1k | xings | open% | tex | mass% |
|---|---|---|---|---|---|---|
| oak-up | 1.035 → **1.209** | 0.01 → **0.57** | 6.66 → **11.78** | 89 → **59** | 0.098 → **0.230** | 46 → 51 |
| oak-row | 1.095 → **1.396** | 0.45 → **3.49** | 8.91 → **21.93** | 70 → **37** | 0.177 → **0.268** | 27 → 32 |
| oak-tunnel | 1.269 → **1.474** | 0.42 → **3.83** | 17.17 → **27.97** | 78 → **52** | 0.159 → **0.263** | 35 → 42 |
| palm-row | 1.122 → **1.263** | 0.36 → **2.12** | 7.27 → **12.36** | 77 → **53** | 0.047 → **0.070** | 17 → 17 |
| target | 1.538 | 3.57 | 49.98 | 40 | 0.247 | 43–88 |

`holesPerK`, `openFrac` and `texture` are at or past target on the oak frames at
street distance and mass rose rather than fell. **`xings` did not close** — 22–28
against 50 — and neither the builder nor I have a story for the remainder. It is
recorded as open rather than explained away.

**And the frames say less than the numbers do.** At district distance the canopy is
a clear improvement: it stops reading as stacked shingles. On the close bench the
individual leaf plates are still visibly flat quadrilateral cards, now with lacy
holes cut in them — better on every metric, still not a live oak. The metric moved
further than the appearance did, which is the standing hazard with any metric and
is why the frames are looked at as well as scored.

### Left broken deliberately

`tools/oak-look.mjs` aims its DirectionalLight at the world origin while its bench
stands at (118, -170), so a +/-30 m shadow box contains no tree and a canopy shadow
has never appeared in one of its frames. `tools/tree-look.mjs` fixes it for the new
bench; `oak-look.mjs` still has it. The dark square under a trunk in old bench
frames is the tree PIT, which a critic round already once mistook for a baked blob.

## Live oaks, placed from a census — and three ways the census nearly misled us

An art critic reported 15 of 15 reference views along Main St east showing live-oak
canopy and rated putting oaks back the largest perceptual gap after anti-aliasing.
A canopy census over all 404 reprojected stations qualified that (oaks are
clustered, not continuous), and building against the census qualified it again.

### What the classifier got wrong, and how it was caught

**1. The L/R split was a backlight artifact, not a one-sided tree line.** Pooled,
Main St east x 90-165 read L 38.7% against R 10.3%, 12 of 15 stations heavy against
1 of 15 — which looks like oaks on one wall only. It is not. `isFoliage` wants
`g - b >= 0.16*max + 5`, which a shaded leaf at (30,35,28) fails, so the mask
painted only the sunlit top of an obviously-present crown. **The unit has to be the
STATION on max(L,R), not the view**, which roughly doubles the hotspot readings.
Caught by rendering the mask and looking at it, not by reasoning.

**2. `foliage` is the wrong discriminator; `upper` is the right one.** Per station
on max(L,R), the x≈540 cluster I had flagged as secondary density reads median
`upper` **2.6%** — trees, yes, but not canopy. Checked by eye at x=547 and x=563:
leggy semi-defoliated specimens in front of modern glass, crown low in frame. x≈300
is 0 of 14 and genuinely open.

**3. A green-pixel classifier cannot resolve species.** Five Points' heaviest
station (548044374984819-L, 21.3% foliage, 34.1% upper) is a **Canary Island date
palm**. The bayfront's x≈-240 bucket — the densest in the district at 8 of 8 — is a
**park lawn** with big oaks behind a kerb, and x≈387-403 is a landscaped apartment
setback. Those are real trees but not shopfront street trees, so legs 0 and 2 are
excluded **by hand**, and the exclusion is named in `tools/oak-profile.mjs` rather
than buried in a threshold where it would read as a measurement.

Four runs survive — **360 m of 2,654 m, 14% of the corridor**: bayfront (s 240-320,
peak 0.71), McAnsh (520-540, 0.40), **Main St east 740-820 (peak 0.90)** and Main St
east 1040-1080 (0.63).

### Density mattered as much as species

`OAK_PROFILE` is 64 weights per 20 m of arc-length, Gaussian-smoothed at sigma 16 m,
with trailing zeros dropped because the census only walked 4 of the 8 legs and a
zero there would assert a measurement never taken. It drives **two** things, and it
had to: **before, the 250 m of Main St east from x=50 to x=300 held six trees and
not one of them stood inside the measured tunnel at x 86-148.** A species switch on
six trees is not a canopy. The tree branch now fires at `roll < 130 + 780*w`, so
that stretch holds twelve, nine inside x 78-155 — a tree every ~9 m alternating
kerbs, which is what "one per shopfront bay" comes to counting both sides.

One tree in eight stays a palm even at peak weight, because the reference has one:
`1007445660973812-R` shows a palm standing in the oak line.

**307 trees now (was 276): 160 sabal, 135 queen, 12 oak.**

### The geometry, and what the audits caught

Not the old broadleaf. Short thick trunk forking at **1.75-3.2 m** — at or below
fascia height, so it is a tree you look through and under rather than up at — crown
**1.4-1.9x as wide as tall**, limbs grown 30% longer over the carriageway and cut
back hard at the frontage.

| | broadleaf (2026-09-02) | palm | **live oak** |
|---|---|---|---|
| FAR `tree` | 116.6 | 154.0 | **287.9** |
| NEAR `treeDetail` | 134.0 | 138.6 | **238.3** |
| per tree | 250.6 | 292.6 | **526.2** |

Expensive per tree, cheap in aggregate because it is rare: 12 of 307. District prop
triangles **272,349 -> 282,738 (+3.8%)**.

**Detached leaf plates — I spotted them in an isolation frame and the audit
confirmed them.** The frontage caps used to *move* a clump's centre by up to ~2 m to
satisfy the clearance rule, leaving it hanging in open sky. They now **shrink** the
clump instead and the offset is bounded at 0.42 radii. `tools/oak-audit.mjs
--attach` walks 16,469 clumps on 536 oaks against the limb polylines *that same tier
draws*: **0 detached, worst 0.940**. `--attach --break` displaces every clump 1.5 m
and reports **26,777 detached**, so the audit can produce the opposite reading.

Note that `geom-audit` would **never** have caught this: that gate checks a prop
reaches its host SURFACE — the ground — not that a leaf reaches its own branch.

**Three winding defects, found by probe and not by eye**, in the emitter class the
ledger already records as where this bug reappears: `limbTube`'s ring frame was not
parallel-transported (523 of 16,296 backfacing); limbs clipped in reach but not in
height became vertical spikes with a 116-180 degree fold (205 of 16,296);
`leafClump`'s per-vertex caps distorted the pillow away from its own normals (26 of
20,270). District-wide backfacing **0 -> 0**, and the counter reads 262 of 262 bad
on a deliberately reversed tree, so it is not inert.

`worstFloatMm` -40 -> -40. Crown reaches at most 1.93 m toward the frontage against
a 2.20 m guarantee, and hangs no lower than 4.30 m over the carriageway.

### A harness error, in the flattering direction

The builder's first node harness dressed the district **without placing lamps**, so
`lampClearance` was Infinity and it reported 294 trees and 278,101 triangles where
the page reports 276 and 272,349 — an 18-tree, 5,752-triangle error, and it flattered
the change. Fixed; node and browser now agree exactly on 6,832 props, 282,738
triangles, 307 trees and an identical species split.

### Gate

draw **225**, triangles **773,816** (was 759,569; +14,247, and 6.8% under the 830k
warn), stall **8.3 ms**, heap **-3 MB**. The builder predicted 770-780k from its
scene-graph counts before the gate ran, which is the right way round.

### Open, and said plainly

- **The foliage is coarse** — 48 pillows of 8 triangles. It reads as canopy from
  15 m and as chunky plates closer. Halving plate size again is ~+250 tris/tree
  across 12 trees, which is affordable.
- **12 oaks is what the census supports**, and 6 are in one 70 m stretch. The McAnsh
  run drew 2 trees and the hash gave it 0 oaks. The lever for legibility there is a
  cap on oak count, not the profile.
- **The soffit sits at 4.3-6 m** over the carriageway because of pruning clearance,
  so there is more daylight under the canopy than the reference shows.
- The 16.5 m kerb-station grid is untouched: it is the hard floor on tree spacing
  and moving it would move every other prop in the district.

## Heights read off the photographs, and a critic's ranking that inverted under measurement

The art critic reported buildings 29 and 28 as grossly too tall — +38.8 deg at
x=148/159 and +24.2 deg at x=239 — and named re-massing them the second-biggest
win in the build. `tools/massing-truth.mjs`, which converts a parapet angle in a
reprojected view into **metres** for the footprint it lands on, was built for
exactly this question. Run over all 404 stations rather than the critic's five, it
says something different.

### The critic's stations were the worst ones, not representative ones

| population | band ratio (built / implied) |
|---|---|
| the critic's 5 stations | **1.59** (built too tall) |
| all 404 stations | **0.88** (built slightly too SHORT) |

Per building, over 31,699 accepted columns:

| idx | frontage | built | implied | ratio | columns | IQR | verdict |
|---|---|---|---|---|---|---|---|
| 29 | 106 m | 13.95 | 7.91 | **1.76** | 2,037 | 9.5 | too tall — confirmed |
| 49 | 135 m | 10.75 | 7.70 | **1.40** | **6,832** | 3.0 | too tall — never flagged |
| 90 | 58 m | 7.55 | 13.38 | **0.56** | 4,964 | 5.1 | too SHORT |
| 24 | 51 m | 7.55 | 11.78 | 0.64 | 1,057 | 5.7 | too SHORT |
| 68 | 30 m | 7.55 | 11.03 | 0.68 | 1,467 | **0.4** | too SHORT |
| **28** | 56 m | 10.75 | 8.90 | **1.21** | 730 | 5.3 | **inside the band's own noise** |

So: **29 is confirmed. 28 is not.** Over 730 columns it reads 21% tall, which is
less than several buildings nobody complained about. And the largest single error
on the corridor is not a tall building at all — it is **90, too SHORT by a factor
of 1.8**, with 4,964 columns behind it. Four of the six worst are too short. The
critic looked where the eye is drawn, which is up.

### What changed, and why it is not a distribution change

A band ratio of 0.88 means the *distribution* is close to right; the *individual*
buildings are wrong in both directions. Changing the area→storeys table would move
all eleven to fix five, so instead there is now a `REFERENCE_HEIGHTS` table in
`tools/bake/massing.mjs`: heights read off the photographs for the footprints where
the evidence is strong enough to beat a hash.

The bar, fixed before anything went in it: **at least 1,000 accepted columns, an
IQR of 6 m or less, and a ratio outside 0.74–1.35.** Everything that fails keeps
its band height, because a wide spread means the footprint does not HAVE one
height and pinning it to a median would be inventing precision.

These heights are **not quantised to `LEVEL_H`**. A 3.2 m storey grid is our model,
not the street's, and rounding a measured 11.03 m to the nearest multiple would put
back part of the error the table exists to remove.

Result — four of five now match the photograph exactly:

| idx | was | now | implied |
|---|---|---|---|
| 49 | 10.75 | **7.70** | 7.70 |
| 90 | 7.55 | **13.40** | 13.40 |
| 68 | 7.55 | **11.03** | 11.03 |
| 24 | 7.55 | **11.78** | 11.78 |
| 29 | 13.95 | **6.80** | 7.91 (see below) |

Exactly 5 of 523 footprints moved. No band, no other building, no other leg.

### Building 29 is a compromise and is recorded as one

It **fails the spread bar** — IQR 9.5 m — and is pinned anyway. The reason is in
the split: of its 2,037 columns, **1,416 read 6.8 m and 621 read 20.6 m**. That is
not noise. It is a **106 m frontage that is genuinely two different buildings in
reality and one polygon in the OSM extract**, and we cannot split a baked footprint
because the bake's geometry is authoritative (constraint 10). So the choice is
which half to be wrong about. 70% of the evidence and the whole hero view are the
low half, so the low half wins, and it is pinned to the dominant face (6.8) rather
than to the overall median (7.9).

### The instrument caught the author's own error

The first version of the table set `height = implied`, and all five came back
**about 10% tall**. `appendBuilding` draws from `h` to `h + parapet`, and the
photograph's parapet angle is the TOP of that — so a measured height is a
*parapet-top*, and the wall must be 1.15 m shorter. Every entry now carries both
`height` (the wall) and `implied` (what was measured), so the offset cannot be
lost again. That is the argument for re-measuring after a change rather than
declaring victory from the diff.

Gates: syntax PASS (97), golden-trace PASS, physics PASS, geom-audit PASS, lighting
sweep PASS with both negative tests firing, budget PASS/PASS/WARN — draw **226**,
triangles **759,569**, stall **12.4 ms** inside its 7.1-16.4 noise band, heap
**-27 MB**.

## Two instruments from a round that ran out of budget, and one claim they qualify

Three builders were cut off mid-task by a session usage limit. Their tools and
measurements survive and are committed; the code changes they were working toward
are NOT done, and are listed as open below rather than half-applied.

### `tools/massing-truth.mjs` — the question a massing table is actually written against

`roofline-analytic.mjs` answers "how high does our streetwall stand" in degrees and
`roofline.mjs` answers it for the photograph. Neither answers the question the
table needs, which is in **metres**: given that this footprint is 7.6 m from the
camera and its parapet subtends 14.7 deg in the photograph, how tall is it? This
converts per station, per band, per building. It is the instrument the Main St east
re-massing needs and did not have — every previous pass reasoned about angles and
then guessed at storeys.

### `tools/oak-census.mjs` — and a critic claim it does not straightforwardly support

The art critic reported that **15 of 15** reference views along Main St east show
live-oak canopy at 25-85% of frame, and rated putting oaks back the largest single
perceptual gap after anti-aliasing. A census over all **404** reprojected stations
measures something more equivocal:

| leg | stations | median foliage | above 15% of frame |
|---|---|---|---|
| Marina → Bayfront | 14 | 7.5% | 0 / 14 |
| Bayfront → Pineapple | 94 | **12.7%** | **41 / 94** |
| Pineapple → Five Points | 72 | 4.6% | 10 / 72 |
| **Five Points → Main St east** | 224 | **8.5%** | **52 / 224** |

So canopy is real and it is heaviest on the **bayfront-to-Pineapple** leg, not on
Main St east where the critic sampled. On Main St east the median station shows
8.5% foliage and only 23% of stations exceed 15%.

That does not refute the critic — its 15 views are inside this population, its
metric is a visual estimate rather than this one's pixel classifier, and a street
can be an oak tunnel in the stretches a photographer stops at while the median
station between them is open. But it does mean **the tree work should be driven by
this census across 404 stations rather than by 15 hand-picked frames**, and that a
uniform "oaks on Main St east" rule would be the same mistake in the other
direction as the uniform "palms everywhere" it would replace. The right shape is
per-station, and now measurable.

### Open, not done

- **Live oaks.** Census built; no tree geometry written, no placement rule, nothing
  changed in `src/streetfurniture.js`. All 276 trees are still palms.
- **Main St east re-massing.** `massing-truth.mjs` built; the table is unchanged.
  Buildings 29 (106 m frontage, h 12.8) and 28 (h 9.6) still stand where the
  photographs show one tall retail storey, at +38.8 and +24.2 deg.
- **Glass bronze, not cobalt.** Not started. Engine B/R 1.49-2.07 against a
  reference of 0.67-0.83, and pane:wall 0.49 against 0.12.

## The renderer asked for anti-aliasing and never got any

An independent art critic's headline finding, and the cheapest large win in the
build. `district/main.js` constructed the renderer with `antialias: true`. That
flag configures multisampling on the **default framebuffer** — and the scene is
never drawn there. `PostStack` renders it into an offscreen HDR target, and the
only thing that reaches the default framebuffer is a fullscreen triangle with no
interior edges to resolve. So the request had been inert for the build's whole
life while looking, in that one line, exactly like working anti-aliasing.

Confirmed in source before anything was changed: the HDR target at `src/post.js`
is created with no `samples:` option, and `grep` for FXAA or SMAA over the whole
post chain returns **0**.

### The instrument

One scanline is an anecdote. `tools/aa-edges.mjs` turns it into a population: it
walks every row and column as a 1-D luma signal and counts, for each edge that
runs between two **flat plateaux**, how many samples fall strictly between them.
The plateau requirement is what makes it a SILHOUETTE metric rather than a texture
one — it selects sky against a mast, or a lit wall against a dark one, and ignores
the interior of a brick texture where "transition width" would mean nothing. A
12% deadband at each end stops 8-bit dither and the composite's own ordered dither
manufacturing an intermediate level.

`--selftest` separates four synthetic cases and **passes**: a hard step reads
hardFrac 1.00, a 1-sample ramp reads 0.00/width 1.00, a 3-sample ramp reads
0.00/width 3.00, and a flat field reads **n/a rather than 0 or 1** — which is the
case that matters, because a metric that reports "smooth" on a region with no
edges in it looks exactly like working anti-aliasing.

### What the four arms measure

All four captured in one page session at one camera, with the arm asserted from
the render target's own `samples` and the renderer's context attribute, so an arm
cannot silently be the wrong one. **All four digests differ** (4858ea / a2b5b0 /
b8e731 / 04e44d), which is the check the lamp-pool A/B failed earlier this session.

| arm | hard-stepped edges | mean width | draw calls | post passes |
|---|---|---|---|---|
| off | **43.7%** | 1.41 | 189 | 8 |
| **msaa x4 (shipped)** | **16.1%** | 1.80 | **189** | 8 |
| fxaa | 22.2% | 1.93 | 190 | 9 |
| msaa + fxaa | 9.7% | 2.10 | 190 | 9 |

MSAA takes hard-stepped silhouettes from 43.7% to 16.1% — a **63% reduction** —
for **zero additional draw calls**, because it is a property of the target rather
than a pass. `msaa+fxaa` reaches 9.7% but costs a pass and blurs more (mean width
2.10 against 1.80), and FXAA cannot tell a silhouette from a one-pixel piece of
signage lettering. MSAA alone is the shipped default; the others stay reachable
through `setAA()` because the choice is a measurement, not an opinion.

`antialias` on the renderer is now explicitly **false**, with the reason written
where the misleading line used to be: asking for it there would only allocate a
multisampled backbuffer nothing renders into.

Gate after: draw **226**, triangles **760,529**, stall **9.3 ms** inside its
7.1-16.4 noise band, heap **-31 MB**.

### Still open on this

FXAA runs after the composite on the tonemapped 8-bit image, deliberately — it
thresholds on luma contrast, and pointed at the linear HDR target it would see a
60,000-nit sky against a 600-nit wall and call every pixel an edge. That path is
built and measured but not shipped, and it has had no second-time-of-day pass.

## CORRECTION: the golden-hour roofline instrument was reading the sun, not the buildings

Two independent adversarial reviews went over this session's work. One of them
broke the instrument the whole massing pass was measured with. **Several numbers
published above and in commits `5c273da` and `fa6dced` are withdrawn**, and they
are listed here rather than quietly edited.

### The defect

`tools/roofline.mjs` finds the roofline as the topmost non-sky pixel per column,
with `isSky = b>90 && b>=g && b>r+6 && mean>85`. At golden hour our sun sits at
bearing **134 degrees (SE), 8 degrees up** (`src/sky.js`), so **every `R` view on
this corridor looks into that half of the dome**. ACES plus the horizon glow
desaturates our sky until `b - r <= 6` and then past it to `b < r`, and the scan
stops in the middle of open sky.

Verified directly, column 900 of `523356163931260-R-golden`:

```
y=  0  177,191,211  b-r  34   sky
y=180  200,201,207  b-r   7   sky
y=190  196,194,197  b-r   1   <== DETECTOR STOPS, reports ~31.6 deg
y=450  218,211,202  b-r -16   still sky
y=560  254,251,245  b-r  -9   still sky, and BRIGHTER
y=690  202,168,119                first actual object. True roofline about -2.2 deg
```

About **34 degrees of one-sided error**, on `R` views only.

`tools/roofline-analytic.mjs` now measures the built side by ray-casting the baked
footprints through the same camera — no detector at all. It imports the real
`buildingStyle()` so parapets are the shipped ones, models the streaming LOD tiers,
and ships four self-checks (projection against `THREE.Vector3.project` to 4.5e-13
px, row scale against `elevOf` to 7e-15 deg, all 48 stamped yaws reproduced to
0.049 deg, and a both-ways response test: +20 m gives 61.4, flattened gives -0.1).

Against the pixel detector, per column, **independently recomputed**:

| | median (pixel − analytic) |
|---|---|
| **L views** (away from the glow) | **0.02 deg** |
| **R views** (into the glow) | **14.66 deg** |

A broken ray-caster would be wrong on both sides. Right on `L` and wrong only on
`R` is the signature of the detector failing in the glow.

### Withdrawn

- **"Main St east +10.1 -> +6.1 deg"**. Direction right, both endpoints wrong.
  Analytic: **+8.3 -> -1.0** clamped to the frame, **+16.4 -> -1.0** uncensored.
  The +6.1 residual was mostly R-view glow, not massing.
- **"Five Points approach +19.9 -> +13.4"**. That leg is **one station, n=2**. Its
  analytic silhouette moved **0.0 and -0.1 degrees**. The 6.5-degree
  "improvement" was entirely instrument.
- **"the residual is still 3.8 deg mean on the hero leg"** and **"one face
  (x=283 R) sits at +11.0 unchanged ... that is per-BUILDING error"**. x=283 R is
  analytic 9.7 against pixel 32.4. Instrument, not massing.
- **"14 pairs, mean absolute error 6.71 -> 5.48, Main St east 6.3 -> 3.8"**, and
  the single-band comparison at 6.43 on the same set. The 14-pair set was never
  recorded and is only recoverable by search — two different 14-subsets of a
  19-pool reproduce it. It also rests on the broken built side.

### Strengthened

- **"12 of 14 marlin-core-east buildings moved, mean 12.6 -> 7.3 m; 0 of 15
  marlin-core-west"** — exact, from the data, no instrument involved.
- **"Pineapple and the bayfront unchanged to a tenth of a degree"** is now
  *proven*: the analytic silhouette is **bit-identical** between the base and
  after worlds in all 23 of those views.
- **"the split costs nothing where it was already right"** needs no measurement at
  all: on Main St east the single-band and split worlds are identical in every
  height, so the split's whole advantage is the 11 west-of-Five-Points buildings
  it leaves alone.
- The sky headline **improves**: columns filled edge-to-edge on Main St east go
  **61% -> 17%** against a reference of **18%**, not the 62% -> 26% published.

### The reference side is worth less than assumed

A photograph has no geometry, so the reference roofline still comes from pixels.
`roofline.mjs` now reports five confidence terms per boundary, and on the 48
photographs: 42% soft (no colour step), 33% near-white, 20% foliage-coloured, 13
of 48 pinned at the top of frame. `9496096920505025-L` reads 41.9 deg / 74%
clipped and is, cropped and looked at, **a live oak canopy filling the frame** —
not a streetwall.

**Clean on all four screens and not pinned: 6 of 48.** Both remaining biases point
the same way (canopy and cloud read as roofline, raising the reference; the glow
raised the built side), so on `R` views the published delta was a difference of
two unquantified upward biases and is not interpretable at all.

### And the noon frames were never lit

The new degenerate-frame guard caught two captures already committed:
`1414553883288835-{L,R}-noon.png` have mean luma **9.3 and 3.9**. Fed to the
instrument, a black frame produces its **maximum** reading — 41.9 deg, no-sky
100%, "+28.3 deg, built is TALLER". The failure mode of the whole chain was the
most alarming possible answer. `roofline.mjs` now refuses them.

That also means **binding constraint 3 is unmet in substance for the massing
critique**: the second time of day was captured and is unusable. Recorded as open.

### Guards added

Degenerate frames refused; `--all` with no time argument now exits 2 instead of
silently measuring an empty set and writing `roofline---all.json`; and provenance
is checked against the stamp nothing previously read — world, camera, completeness,
page errors, and the reference views' own freshness. `pano-match.mjs` now stamps a
**content hash** as well as mtime and size, because a re-bake that changed nothing
but `meta.baked`'s date moved the mtime and made the guard refuse a frame set that
was in fact current. mtime is not content, and `touch` defeats it.

## The glazing claim was wrong, and the real defect was what the pane reflects

"The tower pane sits at a fixed 0.82-0.84 of the wall beside it right through
daylight", filed by three critic rounds. **Not reproduced.** Measured on the main
face, scene-linear: **0.348 at noon and 0.519 at golden** — it moves by about 2x
across daylight. 0.82-0.84 does appear, but only in the *lower* bands at *golden*
(0-8 m: 0.879 on the corridor frame, 0.813 on the tower). It was never a fixed
number; it was one band at one hour.

Masks verified before anything was read off them: 241,543 glass px against 479,348
wall px, world-height agreeing with raycasts to 0.07 m, and the opposite-reading
check firing — `scene.environmentIntensity = 0` takes the glass 3.5 -> 0.5 of 255.

**The pane was already a directional mirror.** Against a chrome ball rendered into
a float target at the same elevations, it returns a near-constant **third** of the
environment (0.33, 0.26, 0.33, 0.35, 0.39, 0.36 across 0-50 degrees). So "no
environment term" was the wrong diagnosis and would have led to the wrong fix.

What was actually wrong is **what it reflects**: our sky peaks just above the
horizon (8,109 nits at +10 degrees) and dims overhead, low panes reflect
near-horizontally, and there is no city anywhere in `scene.environment` to block
that bright band. The tower was therefore **brightest at the pavement and faded
upward** — the inverse of a photograph:

| band (m) | 0-8 | 8-16 | 16-24 | 24-32 | 32-40 | 40-60 |
|---|---|---|---|---|---|---|
| noon, before | 5.1 | 5.5 | 4.9 | 3.7 | 4.0 | 3.4 |
| noon, after | **3.3** | **2.7** | 4.9 | 3.7 | 4.0 | 3.4 |

`applyGlazingEnv()` puts the street back: a pane at height y sees the mass opposite
subtend `atan((H-y)/D)`, reflecting the city below that ragged skyline and the sky
above it. H = 16 m and D = 22 m come from raying all **2,962 baked building edges**
(86% hit something), not from taste. The city's radiance is
`urbanAlbedo * iblIrradiance / PI` — the district's own wall palette, so it tracks
hour, weather and fog for free. **Zero new varyings, uniforms, textures, draw calls
or programs.**

The wall is untouched (x0.999-1.002 across every band) and only glass below the
skyline moves. The builder caught its own live-fire error on the way: the first
edit left `applyGlazingEnv` after an existing `return`, i.e. dead code — the same
silently-identical-arms failure as the lamp A/B — and the probe now asserts the
program is actually patched (`programs with glazeEnv 2/55`).

Open, and said out loud: no matched **night** A/B (argued inert at 0.1-0.3 nits,
not measured); the fix only removes light and no compensating gain was invented;
and H and D are district-wide constants, so a bayfront pane with nothing opposite
gets the same 16 m skyline as one on Main Street.

## The lamp margin, and hysteresis demonstrated rather than asserted

Review found the incumbent margin was applied twice and the halves were not
commensurate: the distance discount was worth 8 rank-metres while the sphere
dilation was worth `maxDistance + swapMargin` = 138, a **17x asymmetry**. A lamp 50
m behind the camera — which by the pool's own criterion cannot light anything
visible — held rank 42 and outranked every in-view lamp beyond 42 m.

`held` now changes **exactly one thing**: the radius of the sphere the view test
uses. Every rank is now exactly `d` or exactly `d + maxDistance` — 45,123 bench
positions, 0 off-grid. The same lamp at 45.95 m behind now scores 45.95, its true
distance, so it can only outrank lamps genuinely further away. The 8 m band is
measured at 1 cm steps: leaves view at **45.81 m as a challenger, 53.81 m as an
incumbent**, and **0.00 m at margin 0** as the negative control. Wasted slots over
24 headings: **61 of 240 at margin 8 and 61 of 240 at margin 0** — identical, so
the residual costs nothing measured. That waste is supply-limited, not
margin-caused: only 6 of the 15 emitters within 130 m of the corridor camera can
reach the view at all.

The earlier `swapMargin` evidence was also weak, and the review was right about
why: the boundary was located at margin 0 and then dithered at margin 8, so "0
swaps" was equally consistent with a shifted-but-still-sharp threshold. A two-path
sweep settles it — the same heading gives a **different lit set depending on which
way the camera arrived**:

| | switches going up | coming down | path-dependent |
|---|---|---|---|
| margin 8 | 19.5, 26.0 deg | 15.5, 21.5 deg | **17 of 41 angles = 8.5 deg** |
| margin 0 | 19.5, 21.5 deg | 19.5, 21.5 deg | **0** |

A shifted threshold cannot produce that, and margin 0 proves the rig by collapsing
it to zero. Churn under dither was then run at **both** candidate boundaries — the
control that was missing — and margin 8 gives 0 reassignments at each while margin
0 gives 23.

**Emitter count settled: 543**, re-derived by replaying the placement loop against
the bake — 582 drivable edges, 1,476 segments, 1,141 shorter than 26 m and skipped,
cap of 1,100 never binding. Three comments disagreed (233 / 543 / 1100) and now
agree.

**Found, measured, NOT fixed:** `sky.update(camera)` runs before `chase.update()`,
the same class of bug just fixed for the lamp pool and a worse case. After a 30
degree camera jump the sky's captured rotation still reads the old heading for 1-2
rendered frames, carrying the *full* rotation, so the dome is drawn from a
different camera than the geometry beside it. Moving the call is not sufficient —
`sky.update` reads `camera.matrixWorld` and nothing refreshes it until the renderer
does at end of frame, so it also needs its own `updateMatrixWorld()`, as
`LightPool.setView()` does. `weather.update` has the same ordering and does **not**
matter: it reads only `camera.position`, for a rain volume and a splash centre
snapped to a 2 m grid, and one frame of travel is 0.93 m at 100 km/h.

## The queue counter was a symptom: chunks were being deleted while wanted

Chased on a builder pass. The counter question turned out to be the cheap half.

### The counter, answered

`stats.queued` was assigned in exactly one place, right after the queue rebuild
and before `_drainQueue()`, and never touched again as the queue drained. Worse,
**the rebuild is skipped entirely on any update that does not cross a chunk
boundary** — which, parked, is all of them. So the number was the rebuild loop's
verdict for the last boundary crossing, frozen. After a cold start that verdict is
"the whole ring is missing", which is why it shadowed the loaded-chunk count at
69-81 rather than sitting near zero.

Measured parked and settled (`tools/stream-queue-probe.mjs`, `docs/stream-probe.json`):
want 44, missing 0, LOD-differs 0, already-correct 44, **live queue depth 0** — the
rebuild pushes nothing — while the reported figure said 44. One forced rescan on
that same settled world took it from 44 to 0 without loading or unloading anything.

`report()` now derives a live `queued` — queue depth plus the in-flight chunk,
because a chunk being built is real outstanding work. The scan-time figure was
first kept as `queuedAtScan`; a review then found it had one write and **no
readers anywhere**, so a misleading field had simply become a dead one, and it is
now deleted. If a stall-budget gate ever wants "work created by one crossing", it
should come back with the reader that needs it, in the same change.

**Four harnesses had each invented a different wrong reason for that number** —
"a cumulative counter" (`contact.mjs`), "the queue never drains" (`sun-share.mjs`),
"the far ring keeps a permanent backlog" (`lamp-onscreen.mjs`), "the far ring keeps
re-queueing" (`glaz-probe.mjs`). None of those happen. A misnamed field cost four
independent wrong explanations.

### The real defect underneath it: wanted, present, unqueued, then deleted

Disposal is spread at `unloadsPerUpdate = 1`, so a chunk can still be sitting in
`_pendingUnload` when the player turns round and it re-enters `want`. **Nothing
took a key back out of that map.** The drain loop disposes whatever is in it
without consulting `want`, while the queue rebuild skips the same chunk because at
that moment it is still in `this.loaded` with the right LOD. So the chunk is
wanted, present, unqueued — and then deleted.

> **Correction.** The first version of this entry, and the commit message at
> `258aded`, quoted figures from a run of the *fixed* code — I re-ran the probe
> after applying the fix and it overwrote its own before-evidence, so the entry
> cited a file that refuted it. The defect is real; the numbers below are the
> re-measured ones, taken against `258aded^` served from a scratch checkout.
> The commit message cannot be corrected without rewriting history, so it stands
> wrong and this is the record. **A probe that writes to a fixed output path will
> destroy its own control run.** Before/after now go to distinct files.

Measured pre-fix (`tools/stream-uturn-probe.mjs` → `docs/stream-uturn-before.json`,
`258aded^`). Home chunk 1,0, want = 94. Cross one boundary, dwell 3 updates, cross
straight back:

- the return rescan logs **3 keys in `want` and in `_pendingUnload` at once**, and
  queues 6 — **none of them those 3**, because all 3 are still in `this.loaded` at
  the right LOD (`alreadyCorrect` 88);
- over the next 3 updates, with the rescan count frozen at 3 and **`loads` frozen
  at 101** — no build is ever started for them — `missing` climbs **5 → 8**,
  `unloads` climbs **12 → 15**, and the wanted-and-pending count falls 3 → 0. One
  disposal per update, each one a wanted chunk;
- **it does not self-heal.** Once the queue drained (loads 101 → 106), `missing`
  sat at exactly **3 for the next 20 samples**, updates 73 → 94, with an empty
  queue, no job in flight and `loads` frozen at 106;
- only a forced rescan repaired it, and it cost **3 full chunk builds**:
  loads 106 → 109.

The cost is a dispose plus a full chunk build per u-turn, both landing in the stall
budget, for chunks that never needed to leave. They are always far-tier — a chunk
only exits `want` from the outer edge of the ring, so the near ring cannot lose
geometry this way.

The fix is one line: `else this._pendingUnload.delete(key)`.

Same probe against the fixed tree (`docs/stream-uturn-after.json`): the return
rescan logs **0** keys in both maps, `unloads` stays frozen at 11 across the whole
24-update watch window, `missing` falls 5 → 0 instead of climbing, and the closing
forced rescan finds nothing to repair (`alreadyCorrect` 94, `loads` unchanged).

### And a second one under that: the in-flight chunk was built twice

Found by an adversarial review of the above, and **pre-existing** — it measures the
same at `258aded^`. `_drainQueue` guarded a dequeued entry only with
`if (!want.has(next.key)) continue;` and never consulted `this.loaded`. The chunk
being built is in *neither* `loaded` nor the queue — `this.job` is its own place —
so a rescan landing mid-build re-queues it as a fresh load. The job completes and
writes `loaded`; the duplicate then dequeues with `swap:false`, disposes nothing,
and adds a **second group to root**. The first is orphaned: still parented, still
drawn, still holding its buffers, and invisible to `this.loaded`, so nothing will
ever dispose it. Its roads and zone polygons sit at the same fixed `y` as the new
copy, which is a z-fight.

The same branch also disposed `this.loaded.get(key)` on a LOD swap **without
deleting the key**, so between the dispose and the rebuild landing, `loaded`
pointed at a group that had left the scene — `chunksLoaded` counted it, and a
rescan in that window read its stale `cur.lod` and could call the chunk already
correct.

Measured on a zig-zag stress walk, ~1,520 updates and 163 rescans against each tree
(`tools/stream-churn-probe.mjs`). It is a stress walk, not the route: it crosses a
boundary about every 10 updates, so these are an upper bound on churn, not a
prediction of the gate's.

| | before (`258aded^`) | after |
|---|---|---|
| orphaned groups in root at rest | 3 | **0** |
| chunk groups in root vs `loaded.size` | 96 / 93 | **94 / 94** |
| orphan meshes / triangles | 12 / 11,272 | **0 / 0** |
| updates with a `loaded` entry whose group had left the scene | 649 of 1,520 | **0 of 1,517** |
| `_beginBuild` on a key already in `loaded` | 1,070 | **0** |
| zero-queued updates whose committed want map was **not** satisfied | 6 of 813 | **0 of 819** |

The fix is again one guard, deciding from `this.loaded` now rather than from the
`swap` flag stamped at scan time: skip the entry if the chunk is already there at
the wanted LOD, and otherwise dispose **and delete** before rebuilding.

That last table row is also the answer to a question left open by the counter fix:
a chunk was sitting at the wrong LOD, unqueued, after a u-turn. It was not
instrument drift — a floating-point tie on the LOD boundary would not care about a
change to the dequeue path, and this one went to zero across it.

### What `queued === 0` is allowed to promise

It means: every chunk in the want map committed at the last crossing is loaded at
its wanted LOD, and no build is in flight. That is the settle signal four harnesses
wanted. **It does not mean the streamer is idle** — disposal is a separate budget,
and 237 of 819 zero-queued updates still had chunks awaiting disposal, up to 8 at
once, drawn and holding their buffers the whole time. A settle check that cares
about draw calls or triangles has to wait on `pendingUnload` too. It is also a
statement about the last crossing's want map, not about where the camera is right
now: `desiredLod()` reads a continuous position but the map is only rebuilt on a
chunk change, so the ring is deliberately stale between crossings (467 of the
zero-queued updates, in both trees — by design, not a defect).

## The lamp pool now ranks by what it can light, and the A/B that said otherwise was broken

543 emitters, 10 slots, chosen by horizontal distance alone. Three critic rounds
filed "lamps glow without lighting".

The rank is now view-aware, and the test is deliberately **not** "is the lamp on
screen" but "can this lamp light anything on screen" — the emitter's own falloff
sphere against the view frustum. That keeps a lamp just off the left edge, which
lights pavement that is in shot, and keeps one a few metres behind whose 46 m reach
still covers the road ahead, while dropping one 60 m behind that cannot reach any
visible surface. Anything failing the test is ranked after everything that passes.

A frame-ordering bug fell out of it: `lightPool.update()` ran BEFORE
`chase.update()`, which is what writes the frame's camera transform. Selection was
ranking against last frame's view — a lag the player would see as the lit set
trailing the turn. It now runs after.

### The A/B reported a clean null, and the null was the instrument

The first run compared legacy against view-aware across eight cameras and found
**zero difference at all eight**. That reads as "the change does nothing".

Every legacy row also recorded `viewAware: true`, which is incoherent — the arm
that exists to have the bias off was reporting it on. The cause: the switches were
handed to `page.evaluate(sw)` as a **string** holding an arrow function.
Playwright evaluates a string as an expression, so it built a function object and
threw it away. Neither arm ever ran. The PROBE worked only because it was invoked
as `` `(${PROBE})()` `` — with the call parentheses. Both arms measured whatever
`main.js` had left the pool in, so identical results were guaranteed.

The harness now **asserts `pool.hasView` matches the arm** and throws rather than
recording a row, so this cannot silently no-op again.

### What the corrected A/B says

Eight cameras on the hero route, along and across, at night. Two have no emitters
in range and measure nothing; the other six:

| | legacy | view-aware |
|---|---|---|
| lit lamps that can light a visible surface | **34** of 60 | **51** of 60 |
| lit lamps behind the camera | **34** | **19** |
| lit lamps on screen | 9 | 18 |

Better at all six live cameras, worse at none. The night frame's mean luma goes
25.9 → 31.1 with 35.5% of pixels changed; **dusk moves 107.83 → 107.88**, which is
the regression check — lamps are on at dusk too and the change does not disturb it.

### `swapMargin` was a dead field and has now earned its place

It was set in the constructor and read nowhere, because distance does not change
when the player turns and so there was no boundary to flicker across. Making
selection view-dependent creates one. It is now applied twice, both as a length:
dilating an incumbent's sphere so it must fall clearly out of view before losing
its slot, and shortening an incumbent's effective distance so a challenger must be
clearly closer.

A monotonic sweep said it bought nothing, which is the wrong exercise — nothing
crosses a boundary twice. On a **yaw dither** around a heading where an emitter
sits on the frustum edge: **margin 0 gives 11 slot swaps in 24 samples, margin 8
gives 0**. The instrument can produce the opposite reading, and did.

## Main Street east was 1.67x too tall, and the corridor is two massing regimes

Acting on the audited finding above. `tools/bake/massing.mjs` `marlin-core` applied
ONE storey distribution along the whole spine, bayfront to Main St east. Measured
against the photography leg by leg, that single table was wrong in a specific way:
the eastern leg was far too tall and the western leg was already right.

**First attempt: one corrected table for the whole band. It worked and it broke
things.** Re-derived from 16 street-facing walls with an unclipped reference angle,
the candidate that best centred the distribution measured 0.94 median and 0.95 mean
built/reference ratio against the old table's 1.67 (only 2 of those 16 walls had
been within a third of the real height). Five candidates were scored before one was
chosen; the winner was not the one with the best median but the one with the
tightest spread, 0.46-1.81 against 0.25-2.41.

Re-baked and re-measured, the hero leg improved — and two faces that had been
**exactly right** regressed: x=34.6 went 0.0 -> -10.4 deg and x=-240.4 went -20.2 ->
-23.6. Both are west of Five Points. A correction aimed at the whole corridor had
shortened the half that was not wrong.

**The fix is that the corridor is not one regime.** Split at the Five Points
junction, same spine geometry, index 5:

| leg | before | what it is |
|---|---|---|
| `marlin-core-west` bayfront -> Five Points | **0.0 deg median, already correct** | carries the district's real towers |
| `marlin-core-east` Five Points -> Main St east | **+10.1 deg median, 20/24 too tall** | a two-to-three storey retail wall |

West keeps its original table untouched. East takes the re-derived one, with a
floor of 2 storeys above 300 m2 because a 3.2 m single-storey box on a retail wall
reads as a shed and the reference has none.

### Result, on the same instrument, before and after

| leg | median delta | built columns with NO sky | mean abs delta |
|---|---|---|---|
| **Main St E of Five Points** | +10.1 -> **+6.1** | **62% -> 26%** | 12.1 -> 9.9 |
| Five Points approach | +19.9 -> **+13.4** | 71% -> 52% | 14.4 -> 11.1 |
| Main St @ Pineapple | 0.0 -> **0.0** | 38% -> 38% | 7.3 -> 7.4 |
| bayfront leg | -0.9 -> **-0.9** | 18% -> 18% | 7.0 -> 7.0 |

Restricted to the 14 pairs where **both** images are unclipped in **both** runs, so
every number is a measurement rather than a lower bound: whole-corridor mean
absolute error **6.71 -> 5.48 deg**, Main St east **6.3 -> 3.8**, and the other two
legs **unchanged to a tenth of a degree**. The single-band attempt scored 6.43 on
that same set, so the split is better *and* costs nothing where it was already
right — which is the whole point of splitting it.

The headline number is the sky. On the hero leg our streetwall filled the frame
edge-to-edge in 62% of image columns; it now does in 26%, against a reference that
shows sky in 82%. Main Street reads as a low street under a wide Florida sky
rather than as a canyon.

**14 buildings are in `marlin-core-east` and 12 of them moved** (mean height 12.6 ->
7.3 m). `marlin-core-west` is 15 buildings and **0 moved**, which is the check that
the split did what it says.

### What this does NOT fix

A distribution keyed on footprint area cannot make an individual building right. On
the unclipped set the residual is still 3.8 deg mean on the hero leg and one face
(x=283 R) sits at +11.0 unchanged. That is per-BUILDING error, and the instrument
to author against it now exists: `tools/pano-match.mjs --id <pano>` plus
`tools/roofline.mjs` gives a per-wall number in about forty seconds. The five
hand-placed `LANDMARKS` are untouched and at least one of them deserves the same
treatment — `Main Street Arcade` puts 7 levels at (250, -150) where the station at
x=239 measures a reference implying about 2.5.

## Measurement integrity, a fifth of the same shape: a sliding window matched the previous run's frames

The massing change was re-baked, the 48 matched frames re-captured, the roofline
re-measured — and every leg came back **identical to three decimal places**. Main
St east still +10.1 deg median, still 20 of 24, still 62% of columns with no sky.
The obvious conclusion was that the change had done nothing.

It had. The frames were the old ones.

The capture was waited on with

```
until [ "$(find docs/shots/pano-match -name '*golden.png' -newermt '-25 minutes' | wc -l)" -ge 48 ]
```

`-newermt '-25 minutes'` is a **sliding** window. The previous run's 48 frames were
themselves less than 25 minutes old, so the condition was true the instant it was
first evaluated, the wait returned immediately, and the measurement ran against a
directory that had not been rewritten yet. Seventeen of the forty-eight had been
replaced by then; the rest were answers about the previous build.

What made it survivable was that the frame was checked against the one already
committed and found **byte-identical** — not merely similar. A render is not
bit-stable across a data change; identical bytes meant identical input, which
pointed at the sample rather than at the change. The served `district.json` was
also confirmed to carry the new heights (marlin-core mean 7.8 m), which ruled out
a caching explanation and left only staleness.

**The fix is structural, not a resolution to be careful.** `tools/pano-match.mjs`
now stamps its `index.json` with `data/district.json`'s mtime and size, and
`tools/roofline.mjs` **refuses to measure at all** — exit 3, no numbers printed —
if any frame it is about to read predates `data/district.json`. Verified by running
it on the mixed directory, where it reported `29 of 48 frames predate
data/district.json` and stopped.

This is the fifth failure of this exact shape in the ledger, and the first three
were all "the sample was not what I thought it was". The general rule stands and
gets sharper: **an absolute reference (is this file newer than that file) is safe;
a relative one (is this file recent) is not, because "recent" silently includes the
thing you are trying to replace.**

## Street-level reference, and a headline diagnosis of mine that failed its own audit

A session finally held `MAPILLARY_TOKEN`. What came back changed the instruments
more than it changed the art, and the first thing it did was refute me.

### The fetch tool was hiding 99% of what is there

`tools/fetch-mapillary.mjs` ran for the first time and returned **39 images, every
one a panorama from a single 2024 sequence**. Read literally that says the district
has no flat street-level coverage. It has plenty; the tool could not see it.

The Graph API caps a bbox response and returns whatever it reaches first, so one
query over the trim box returns roughly one sequence. Gridding the box helps and
does not fix it, and **the proof is that the answer keeps moving**: the same box
censused at `GRID=4` twice returned 4,348 then 4,814 unique images, and at `GRID=8`
returned 6,686 (flat 1,257 / 1,586 / 2,513). A count that grows as you subdivide is
still hitting the cap; one that changes between identical runs is a
nondeterministic subset. **The census is now reported as a lower bound and says so
in its own output.**

Selection no longer runs off the census at all. It queries a small box at each
corridor station — about 80 m across, far under the cap — which returns everything
there and is local and repeatable. 29 images now cover marina → Five Points → Main
St east, one flat and one pano per 45 m station, newest capture preferred.

### The panoramas needed reprojecting, and the convention needed measuring

431 of the 670 images within reach of a station are 360 spheres, and all of the
newest are. Raw they cannot be used to judge a building: equirectangular bends a
straight cornice into a sine wave. `tools/reproject-pano.mjs` remaps them to
rectilinear views aimed at either street wall, which makes them **better** than the
flat frames — a flat frame points wherever the capture vehicle was going, a sphere
can be aimed at the shopfront.

Which bearing sits at the image's horizontal centre is a convention, not a fact
derivable from the file, and **guessing it wrong yields views that are sharp,
plausible, and pointing at the wrong building** — the worst kind of wrong, because
nothing about the output looks broken. So `--calibrate` renders one pano at world
yaw 0/90/180/270 on the stretch of Main Street that runs dead east-west, where a
view down the street and a view at a wall are ninety degrees apart. Run 2026-09-02:
yaw 90 gave the carriageway receding east with the centreline straight and First
Methodist's steeple where it stands; yaw 180 gave a shopfront square-on with a
level parapet. Both halves, so it could have failed and did not. Straight edges
coming out straight is also what proves the remap itself — a sign error bends them
visibly.

### The instrument that made the comparison honest

`tools/pano-match.mjs` parks the engine camera **at the pano's own x,z**, on the
same bearing, with the same eye height, pitch and field of view (75 h on 4:3 →
59.8 vertical for three.js). The photograph and the frame then differ only in what
we built. `tools/roofline.mjs` reads both and reports, per image column, the
elevation angle of the topmost built thing — valid only because both pipelines
share one camera model by construction, so a row index means the same angle in
each.

### My headline read, and why the first version of it was wrong

Looking at a matched pair by eye, the difference was obvious: the reference has a
2-storey shopfront with sky above it, and we render a slab filling the frame. I
wrote down "**the Main Street streetwall is systematically too tall**".

Pooled over all 48 pairs that is **false**: delta p50 median +3.4 deg, taller in 28
of 48, range −24.5 to +29.0. No systematic bias. Two hypotheses died there — the
massing one, and a follow-up guess that the difference was palm canopy overhead,
which measured 0.6% of the upper frame in the reference against 0.3% in ours.

**The pooled number was hiding the finding, not disproving it.** Segmented by
corridor leg:

| leg | n | delta p50 median | taller in | reference roofline p50 | built |
|---|---|---|---|---|---|
| **Main St E of Five Points** | 24 | **+10.1 deg** | **20/24** | 25.5 deg | **41.9 deg (clipped)** |
| Main St @ Pineapple | 10 | 0.0 | 4/10 | 39.4 | 39.3 |
| bayfront leg | 12 | −0.9 | 2/12 | 41.9 (clipped) | 37.8 |
| Five Points approach | 2 | +19.9 | 2/2 | 33.0 | 41.9 (clipped) |

The corridor is **correctly massed at Pineapple and along the bayfront**, and
**systematically over-massed east of Five Points**, where our roofline pins at the
top of frame (62% of columns see no sky at all) against a reference that shows sky
in 82% of them. Eight consecutive stations from x=107 to x=555 read +20 to +29 deg.
Worst: x=197 (+29.0), x=331 (+28.3), x=107 (+26.0), x=374 (+24.7), x=148 (+24.7).

All 46 corridor footprints are `s: "authored"` — these heights were authored by
hand, not defaulted, so this is an authoring error and not a bake artifact
(binding constraint 9).

**The instrument was negative-tested before any of this was believed.** It reports
−24.5 deg where we are shorter than the reference, so it can produce the opposite
reading; and where a reading is clipped at frame top it is reported as a LOWER
bound with the clipped fraction beside it, never as a measurement. The two tools'
corridor-bearing definitions were also checked against each other across all 24
panos and agree to within 1 deg — had they not, "L" would have meant different
walls in the photo and the render, and every delta would have been scrambled in
exactly the way the pooled numbers first suggested.

## The white rectangle is NOT the NaN guard, and the guard is still doing something

The test recorded at Round 6 and never run has now been run. `sanitize()` in
`src/post.js` gained a `debugSanitize` uniform that paints every pixel the guard
catches an unmistakable green; the probe captures the corridor hero frame twice in
one page session, guard-normal and guard-flagged, so the only difference between
the two frames is that uniform.

**Refuted.** In the reported box (193–290, 349–400) the guard paints **0%**. The box
is 24.8% near-white with the guard normal, and none of that white is the guard's
own pixels.

But the guard **does** fire: 1,334 pixels frame-wide, 96% of them inside the column
band x=344–408, centroid (390, 363). And the box's white fraction falls **24.8% →
15.4%** when the guard's output changes from a 60000 white to a 40000 green, while
zero pixels inside the box are green. The only path by which a change 100 px away
alters the box is **bloom**. Both runs reproduced to the pixel (1333 then 1334), so
this is a measurement and not frame noise.

So the honest verdict is neither of the two the hypothesis offered: the white
rectangle is not the guard's pixels, but roughly **a third of its whiteness is
bloom fed by an overflow the guard is catching a hundred pixels away**. The
remaining two thirds are something else and still unattributed. The overflow at
x≈344–408 is a narrow vertical band over y 293–568 — the shape of a single building
edge or glazing column — and is the thing worth chasing next.

`docs/sanitize-probe.json`, `docs/shots/sanitize-{off,on}-golden.png`.

## The district was dressed as a generic North American city, and it is Sarasota

`data/district.json` `meta.origin` is 27.335, -82.54125 — Main Street at Five
Points, latitude 27 north, the Gulf coast of Florida — and as of this morning it
carries the real street names. What it was dressed with was temperate broadleaf
trees, poured concrete slab pavements, cobra-head lamp standards, red-and-cream
awnings on a full hue wheel, and a building palette whose low-rise stock was all
the same pale value as its towers. The reference photography in
`reference/sarasota/` establishes every one of those as wrong. Businesses,
shopfronts, signs and logos stay invented; nothing here is traced, sampled or
colour-picked from a photograph (binding constraints 1 and 9).

Six items, taken in the order the brief ranked them. Gate at the end:
**draw 229 (was 228), triangles 766,051 (was 727,193, +5.3%)**, stall 13.9 ms
inside its documented 7.1–16.4 noise band, heap +6 MB.

### 1. Palms, and the biggest single tell in the district

`propTree`/`propTreeDetail` in `src/streetfurniture.js` were a lobed two-tier
broadleaf crown on a leaning trunk. They are now a **sabal** (costapalmate fans,
grey-brown boot trunk) or a **queen** (pinnate feather fronds, smooth pale grey
trunk), 55/45 by hash.

A palm is CHEAPER to draw convincingly than a broadleaf, because a broadleaf is
a mass and a palm is a skeleton: a dozen long thin arcs off the top of a pole,
and a long thin arc is what triangles are good at.

| | broadleaf | palm |
|---|---|---|
| FAR tier `tree` | 116.6 | **154.3** |
| NEAR tier `treeDetail` | 134.0 | **138.3** |
| per tree | 250.6 | 292.6 |
| district, 276 trees | 69,009 | **80,558** |

Every frond is a **closed wedge**, not a card — an upper-left blade, an
upper-right blade, and a floor between their outer edges — because the camera in
this game sits 1.5–2.4 m off the pavement and a palm carries its crown at 6–13 m,
so the view of a street palm is overwhelmingly the view UP INTO IT. A
single-sided blade would be culled from exactly the angle the player spends the
whole game at. The third strip also buys the shading for free: two upper normals
tilted up-and-out to either side of the rachis and one pointing down, so one
blade is always brighter than the other and the underside is always dark.

The tier split cannot pop. Twelve to sixteen fronds are laid on the golden angle
with an "age" running 0..1 across them (young fronds short and upright, old ones
long and flat) and the FAR tier takes the EVEN indices — golden-angle indexing
spreads even and odd evenly round the azimuth, and even indices sample the whole
age range, so the far tier already carries the full outline at half the density.
Crossing 200 m fills the crown in; it does not change its shape.

The sabal's criss-cross boot costs **no triangles at all**: in the boot zone
alternate vertices of each trunk ring are pushed in and out and the phase flips
on the next ring, so the trunk's own silhouette zigzags in a diamond. It is a
radius modulation on vertices that already exist. The near tier adds ten real
protruding plates on top at the distance where 6 cm is more than a pixel; the
same ten on a queen sit nearly flush and read as ring scars.

**Three things were wrong in the first capture and were fixed by looking at it,
not by reasoning about it:**

1. **The sabal's fans were paddles.** `wOf` opened at t^0.8 on a half-width of
   0.28R, which put a metre-wide blade on a 1.4 m frond: six banana leaves, not a
   cabbage palm. Now t^1.5 on 0.155R — thin petiole, fan opening late.
2. **Whole fronds read as black wedges.** The floor's true normal is straight
   down the keel, and a straight-down normal at an 8 degree sun collects nothing
   but the dome's ground term. A palm leaflet is one cell thick and transmits, so
   the floor normal is tilted half a unit OUTWARD — still facing down, now also
   facing the horizon, which is where the light that reaches the underside of a
   frond actually comes from.
3. **Every frond started at one vertex**, giving a hard umbrella join at the top
   of the trunk. Each origin is now pushed out along its own azimuth and down by
   its own age, which is what a crown of leaf bases is. Free.

`.wind-audit.mjs` caught a real defect the eye did not: the ten boot plates were
emitting **20 backfacing triangles per palm** — the whole-kit winding defect at
the top of `streetfurniture.js`, reintroduced on a new emitter. With u radial and
s = (-uz, ux) tangential, u x s = -Y and s x Y = -u, so the obvious vertex order
comes out with its geometric normal pointing down and INTO the trunk. The palm
now measures **0 backfacing** in both handednesses, and the district total went
6,269 → 0 (the 6,269 were the broadleaf's deliberately jittered leaf normals).

The tree pit went 0x40382f → 0x5a4a35. A round-7 critic tracked that quad's
centroid across golden/dusk/night, measured it moving 4 px while the facade
terminator beside it moved 110, and reported it as a baked blob-shadow decal. It
is not a decal, it is the pit — but at that value it read as one. Pine-bark mulch
is what a Sarasota palm stands in and it is 2.4x lighter.

### 2. Brick paver sidewalks — zero triangles, and a measured cost at night

`sidewalkSurface` in `src/materials.js` is a canvas painter, so replacing poured
concrete slabs with clay pavers in running bond is **zero triangles and zero draw
calls**. 15 x 30 modules over the 3 m tile is a 200 x 100 mm paver with a 9 mm
joint: 34 x 17 px at the 512 albedo, 17 x 8.5 at the 256 height map. Per-brick
variation is hashed off the brick's own COORDINATES rather than off the shared
random stream, because `paintAlbedo` and `paintHeight` consume different numbers
of values before they get there — the exact trap `crackSet()` exists for.

**The first cut read as confetti.** Hue 9–26, saturation 18–33, lightness 31–44
with a burnt paver every 14 and a buff one every 14 gave a mosaic of
independently coloured chips, and it aliased, because a per-brick step with that
much variance mips to an average nothing like the near view. Halved the range,
moved the outliers to 1-in-40, and kept them WARM: at saturation 10 the buff
paver was the only near-neutral thing in a warm field, so the sky lit it blue and
it read as a chip of tile dropped on a brick pavement.

`applySlabVariation` went from one cell per 1.5 m slab to one per 3 m tile: a
1.5 m grid of tint steps over a 200 mm bond reads as concrete slabs printed with
a brick pattern, which is worse than either. One cell per tile is a paver BAY.

**The cost, stated rather than left to be found.** Clay is darker than concrete.
`tools/critic-metrics.mjs` on corridor-night, against the committed `a8` capture:

| corridor-night | `a8` before | pavers at l 40–48 | pavers at l 44–52 |
|---|---|---|---|
| crushed fraction Y<=2 | 6.13% | 7.79% | **7.25%** |
| lamp pool, band median away | 11.2 | 4.9 | **5.5** |
| lamp pool ratio | 3.55 | 6.08 | **5.45** |
| lit-window spread | 28.8 | 28.3 | 27.7 |

The same-build noise on crushed fraction is 0.09 pp (`r7` 6.14 vs `b8` 6.05), so
+1.12 pp is real and is mine. It was lifted from 40–48 to 44–52 — still plainly
brick, still inside what the reference supports — which recovered a third of it,
and the rest is a property of the material. The lamp pool RATIO went the other
way, 3.55 → 5.45 and 2.54 → 4.60 at fivepoints: against a darker pavement the
lamps read more strongly, which is the "lamp glows without lighting anything"
complaint measurably improving for the same reason. **The residual is not fixed
and is not hidden**: the frame this ledger already calls a black hole below
y~560 is now slightly darker below y~560.

### 3. Twin-globe lamp standards, paid for out of the pole

`02-Worth-s-Block` and `03-Five-Points` both show black posts carrying two
frosted spheres on brackets. The district shipped a plain tube with a box on a
straight arm.

Lamps are three InstancedMeshes with `frustumCulled = false`, so all 1,100 are
submitted every frame in BOTH the colour and the shadow pass: **a triangle here
costs 2,200**. The 8-sided capped cylinder spent 32 triangles on something under
3 px wide at any distance a player sees it from, and a 5-gon is 20 and shades
identically because `CylinderGeometry`'s normals are radial. That saving buys
both globes:

    was   pole 32 + arm 12 + head 12                    =  56
    now   pole 20 + bracket 12 + globe 20 + globe 20    =  72

**Not one emitter moved.** The outer globe centre is at exactly (2.2, 7.7) —
where the box head was — and that is the point `addLamp()` returns and
`district/main.js` hands to the `LightPool`, so the night grade three critic
rounds have called the best in the set is untouched. The second globe goes on a
shorter pavement-side bracket. The symmetric fixture would have had to move the
light 2.2 m off the carriageway, which is a lighting change, not a dressing one,
and would have had to be re-measured as one.

The pole material also went from 0.75-metalness galvanised steel to matte black
cast iron, which is what every ornamental standard in the reference is.

`mergeGeos()` is six lines: the vendored three build is core only
(`'mergeGeometries' in THREE` is false, checked) and both globes have to be one
geometry or the fixture costs a fourth draw call at every lamp count.

### 4. Awnings: the palette was generic and the section was the wrong fixture

**Palette.** `STRIPE_HUES` in `src/signage.js` was `[20, 206, 348, 30, 268, 96,
142, 44, 292, 168]` — a hue wheel with blue, purple and magenta in it. It is now
`[42, 36, 12, 356, 152, 28, 20, 48, 186, 96]`: eight warm or green, two cool.
Gold also has to be SATURATED to read as gold — at the flat s 48 / l 38 the bar
colour used for every hue, hue 42 comes out dark olive — so warm hues now take
s 58 / l 45. `facades.js`'s two trim fabrics went from red-and-cream and
teal-and-cream stripes to plain GOLD with a maroon valance and a green-and-cream
stripe, off `02-Worth-s-Block` and `01-S.H.-Kress` respectively.

Found by looking at the result: **the valance took `biz.h` while the fabric takes
`biz.a`** — two independent numbers — so a green canopy finished in a purple hem.
One shopfront wearing two unrelated colours and reading as two objects. The
valance and its scallop band now take the awning's own colourway.

**Section.** Both kits drew a flat rake; the reference awnings are BARRELS. The
section is now a quarter circle, `o(s) = out·sin(s·pi/2)`,
`dy(s) = drop·(1-cos(s·pi/2))`, exported from `facades.js` as `awningProfile()`
with its closed-form inverse `awningFabricY()` — `cos(asin(u))` is `sqrt(1-u²)`.

**ONE definition, three callers**, and the third is the gate. `geom-audit.mjs`
asserts that no piece of hardware sits above the fabric, and it can only do that
against a model of where the fabric is; it carried its own straight-rake model
and would have failed every curved awning in the district. It now imports
`awningFabricY` — the same function the geometry is built from — so when the
canopy went from a rake to a barrel the audit line needed **no edit at all**.
The curve is convex up, so it lies at or above the old rake everywhere and every
existing bracket still passes under it: `awningFrame()` needed no change either.

The side cheeks follow the same stations. A straight quad from the wall head to
the leading edge is the CHORD of the barrel and the fabric bulges above it, which
would have left a crescent of open air down each side of every awning.

**AWNING_SEGS is 2, and that is a budget decision made by measurement.** Three
hoops measured **+22,669 gate triangles** across the two awning kits — more than
the entire palm change cost (+16,857) for a curve read at ten metres — and left
the triangle gate at 94.6% of its warn with nothing in hand. Two hoops is three
stations: still plainly a barrel, still no chord gap, half the bill. Re-measured
at **766,425**. The rule is more silhouette per triangle, not a bigger threshold.

### 5. Warm masonry: every one of the seven recipes' palettes

`RECIPES[*].palette` is what `tintOf()` picks a building's colour from, and the
low-rise stock — the recipes `02-Worth-s-Block` and `01-S.H.-Kress` are
photographs OF — had nothing darker than l 64 and had teal in it. A downtown
whose two-storey stock is the same value as its towers has no Main Street in it.

`tintOf()` divides the palette entry by the baked wall colour and clamps at 1, so
an entry can only ever DARKEN — which is exactly what a brick block needs and
what nothing in the old list could do. `retailStrip` now runs from weathered red
brick (h 12, s 30, l 44) to painted cream; `deco` is the Kress's cream glazed
terracotta with an ochre band and the painted red block beside it; `stuccoHouse`
is Frances-Carlton salmon and Florida pastels instead of an olive that is a
temperate colour; `midOffice` is 1777 Main Street's warm precast with one
genuinely grey colourway kept; `warehouse` keeps one industrial blue-grey,
because a metal shed is a metal shed in any climate. Zero triangles.

The condo towers are left pale on purpose: `02-Worth-s-Block` has one rising
straight out of the back of a brick two-storey, and that contrast IS Main Street.

### 6. Terracotta barrel tile — NOT done, and why

Ranked last and not reached. The honest obstacle is the trim atlas: it is 4x4
and **all sixteen cells are in use** (counted, not assumed), so barrel tile as a
material needs either a 5x5 grid at a non-integer 102.4 px cell or a 1024 px
atlas at roughly +4 MB, for the lowest-ranked item on the list. The cheap
substitute — tinting the existing `parapet()` cornice band terracotta — was
rejected as well: the `stone` cell is authored with HORIZONTAL streaks because a
cornice tiles along the wall, and barrel tile ridges run perpendicular to the
eaves, so it would have been the right colour with the grain at ninety degrees.

Whoever takes it: `07-1777-Main-Street`'s tiled window hoods on a concrete tower
are the most street-visible instance in the whole reference set, and
`06-Frances-Carlton` has the roofs and porch canopies.

### What was looked at

`docs/shots/sar-{corridor,fivepoints}-{golden,dusk,night}.png` and
`docs/shots/sar2-*` (the paver lift), every one opened and read rather than
generated and filed. The iteration that produced the three palm fixes and the
two paver fixes was captured, cropped at 2.4–6x, looked at, and the intermediate
frames deleted once the finding was in a comment.

Gates: syntax PASS (82), golden-trace PASS (30 samples), physics PASS (10),
geom-audit PASS with `awningArmAboveFabric 0.00`, lighting sweep **PASS at all
four times of day with both negative tests firing**, budget PASS/PASS/WARN.

The geom-audit null result was verified rather than trusted: dropping
`awningFabricY` by 0.30 m makes it report `gap 0.314` on both awning kits, and
reverting it returns 0.00. A gate that cannot fail is not a gate.

## Gate results

| Date | Gate | Result | Evidence |
|---|---|---|---|
| 2026-09-04 | **drive-through + 30 traffic**, with live oaks on the corridor | **PASS/PASS/WARN** — draw p95 **225**, tris p95 **773,816** (+14,247, 6.8% under warn), stall **8.3 ms**, heap **-3 MB** | `docs/drive-traffic.json` |
| 2026-09-04 | **drive-through + 30 traffic**, foliage alpha stencil + restored oak density | **PASS/PASS/WARN** — draw p95 **225** (unchanged), tris p95 **785,699** (+11,883, 5.3% under warn), stall **9.7 ms**, heap **-22 MB**. Stall was already 8.3 ms pre-round and its own noise band is 5.3–24.2 ms on identical builds; not attributable here. | `docs/drive-traffic.json` |
| 2026-09-04 | **drive-through + 30 traffic**, square leaf stamps (cards fix) | **PASS/PASS/WARN** — draw p95 **225** (unchanged), tris p95 **784,737** (−962 vs the stencil round, 5.5% under warn), stall **8.3 ms** (back to its pre-stencil value), heap **−8 MB** | `docs/drive-traffic.json` |
| 2026-09-05 | **drive-through + 30 traffic**, after six rounds: noon stop, bark stencil, junction arbitration, canopy mass, glass tint, audio+wanted wired | **PASS/PASS/PASS/PASS** — the first all-green gate of the session. draw p95 **230**, tris p95 **804,602** (3.1% under warn), stall **7.8 ms** (under the 8 ms warn for the first time), heap **+3 MB**. Run on a QUIET tree: the previous attempt read 799,708 while two rounds were still in flight and was discarded. | `docs/drive-traffic.json` |
| 2026-09-04 | **drive-through + 30 traffic**, after the reference-authored heights | **PASS/PASS/WARN** — draw p95 **226**, tris p95 **759,569**, stall **12.4 ms** inside its 7.1-16.4 band, heap **-27 MB** | `docs/drive-traffic.json` |
| 2026-09-04 | **drive-through + 30 traffic**, with MSAA x4 on the HDR target | **PASS/PASS/WARN** — draw p95 **226**, tris p95 **760,529**, stall **9.3 ms** inside its 7.1-16.4 band, heap **-31 MB** | `docs/drive-traffic.json` |
| 2026-09-03 | **drive-through + 30 traffic**, after the glazing reflection, the in-flight chunk guard and the lamp margin rework | **PASS/PASS/WARN** — draw p95 **228**, tris p95 **766,853**, stall **12.5 ms** inside its 7.1-16.4 noise band, heap **-1 MB** | `docs/drive-traffic.json` |
| 2026-09-03 | **lighting sweep**, with the glazing reflection in | **PASS** — all four times of day, both negative tests firing | `docs/daynight.json` |
| 2026-09-03 | syntax / golden-trace / physics / geom-audit | PASS — 92 modules, 30 samples, 10 checks | `npm run gates:static` |
| 2026-09-02 | **drive-through + 30 traffic**, after the streaming unload fix and the view-aware lamp pool | **PASS/PASS/WARN** — draw p95 **228**, tris p95 **762,402**, stall **9.7 ms** inside its 7.1-16.4 noise band, heap +3 MB | `docs/drive-traffic.json` |
| 2026-09-02 | **lighting sweep**, after the view-aware lamp pool | **PASS** — all four times of day, both negative tests firing | `docs/daynight.json` |
| 2026-09-02 | **drive-through + 30 traffic**, after the Main St east massing split | **PASS/PASS/WARN** — draw p95 **228** (was 229), tris p95 **760,681** (was 766,051), stall **8.7 ms** inside its 7.1-16.4 noise band, heap +3 MB | `docs/drive-traffic.json` |
| 2026-09-02 | **lighting sweep**, after the massing split | **PASS** — all four times of day, both negative tests firing | `docs/daynight.json` |
| 2026-09-02 | syntax / golden-trace / physics / geom-audit, after the massing split | PASS — 81 modules, 30 samples, 10 checks, every prop reaches its host surface | `npm run gates:static` |
| 2026-09-02 | **drive-through + 30 traffic**, after the Sarasota streetscape pass | **PASS/PASS/WARN** — draw p95 **229** (was 228), tris p95 **766,051** (was 727,193, +5.3%), stall **13.9 ms** inside its 7.1-16.4 noise band, heap +6 MB | `docs/drive-traffic.json` |
| 2026-09-02 | **lighting sweep**, after the streetscape pass | **PASS** — all 4 times of day inside the envelope, `paths: 1`, both negative tests firing | `docs/daynight.json` |
| 2026-09-02 | syntax / golden-trace / physics / geom-audit | PASS — 82 modules, 30 samples, 10 checks, `awningArmAboveFabric 0.00`, and the awning check verified able to FAIL before its null result was trusted | `npm run gates:static` |
| 2026-09-01 | **drive-through + 30 traffic**, sky delivered once | **PASS** — draw p95 **229** (warn 275), tris p95 **720,802** (warn 830k), stall **7.9 ms** (warn 8), heap **−5 MB** | `docs/drive-traffic.json` |
| 2026-09-01 | **lighting sweep**, sky delivered once | **PASS** — all 4 presets inside the envelope on the DELIVERED sky, `paths: 1` at every one, both negative tests firing | `docs/daynight.json`, `docs/daynight-negative-sky.json` |
| 2026-09-01 | syntax / golden-trace / physics / geom-audit | PASS — 81 modules, 30 samples, 10 checks, every prop reaches its host surface | `npm run gates:static` |
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

> **Resolved 2026-09-01.** Finding 1 below is fixed — see "The sky is delivered once,
> and the premise that made it hard was false". The exposure derivation quoted in this
> section (1/6,006 from E_render 18,868 lux) is superseded: golden is now 1/4,152 from a
> measured 12,423 lux, and the sun's share of the road went 26.5% → **35.5%**.

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

## Round 7, environment critic: the most careful review yet, and two audits it needed

This critic checked and REJECTED three of its own candidate findings before reporting -
a repeated crack decal (the cross-correlation was driven by a paving joint, not the
crack), a floating signal pole (occluded by the red car's bonnet), and it explicitly
recorded that the diagonal road bands are the painted zebra rather than cast shadows,
which is the exact error round 6 made. That is the behaviour worth having from a critic.

Its single change - "put props, pedestrians and vehicles into the sun's caster set, and
delete the baked blob quads" - rests on two findings. Audited:

**1. "Nothing is planted": under-base luminance ratios of 0.88 to 1.33.** The measurement
is real; the metric is looking in the wrong place. **At 8 degrees of sun elevation a 1 m
bin throws its shadow 1/tan(8) = 7.1 m**, so there is nothing under the base to find -
the shadow is metres away across the pavement. The soft darkening that IS at the base is
SSAO, already measured at **18.3 of 255** on the same bin box. The critic's own prediction
(ratios should fall to 0.55-0.75 under the bases) would only hold for a high sun or for a
directional contact term, and would not be evidence about casters either way.

**2. "A baked blob-shadow decal that does not move all day."** The evidence is strong and
correct: the dark quad at the fivepoints tree has a centroid of (144,641) at golden,
(146,640) at dusk, (142,641) at night - a 4 px drift - while the facade terminator on the
same building moves over 110 px across the same interval. So it is definitely not a sun
shadow.

It is a **tree pit**. `src/streetfurniture.js:847` draws
`pitSlab(..., 0.72, 0.72, PAD_Y + 0.004, 0x40382f, S.concrete)` - a 0.72 m dark-brown slab
at the tree base. Geometry, not a decal, and it is correct for it not to rotate. The
critic considered this and dismissed it because the quad reads offset from the trunk
rather than centred; that offset is the one part of its measurement I have not resolved.
A scene-graph search for meshes named shadow/blob/decal/contact returns **nothing** - and
that search is itself a weak instrument, since it matches on names, so it is recorded as
"found nothing by name", not as "no blob exists".

### What is confirmed and worth building on

- **The corridor night lamp glows without lighting anything.** Third independent critic
  round to report it, now with the pavement measuring *darker* under the lit head (3.8)
  than 200 px away (18.8). Audited: the nearest-N pool holds **543 emitters and lights
  10**, nearest lit at 21.5 m. Every emissive head outside that ten glows with no light
  attached. That is the design working as written, and it looks wrong - selection is by
  distance alone, with no bias toward what is actually on screen.
- **The corridor night frame is a black hole below y~560**: ground-band median **8/255**
  with 53% of pixels under 10, against fivepoints-night's median 35 and 20%.
- **Blown windows at (235-300, 340-382) in corridor-golden are 47.7% pure white.** Fourth
  independent sighting of this rectangle, and the first with an area measurement. Still
  consistent with the `sanitize()` CEIL hypothesis already logged.
- **The pedestrian contact blob draws nothing** - measured by the ground-contact build at
  0.0266 against a 0.0254 noise floor, and `SHADOW_Y = -0.042` puts it below the paving.

## The district is Sarasota, and now says so

Asked to make the playable area look like downtown Sarasota. It already IS downtown
Sarasota: `meta.origin` is 27.335, -82.54125 and `data/raw/osm-extract.xml` carries
Ringling Boulevard, Main Street, Cocoanut Avenue, Central Avenue and Five Points. Real
street layout, 523 real footprints, real coastline. Only the names were invented.

**Two calls taken by the user, both recorded as amendments:**

1. **Binding constraint 10 amended: real streets and city, invented businesses.** Streets
   and the city name are factual public geography already in the extract, and renaming
   them was the one thing stopping the map reading as Sarasota. Businesses, shopfronts,
   signs and logos stay invented - the buildings are authored massing on real footprints,
   not surveyed premises (5.7% carry a real height, 28.1% were hand-authored), so a real
   business name on one would claim a likeness we have not earned. `credits.html` said all
   naming was fictional, which had become false; it now states the split.

2. **Binding constraint 1 held, not relaxed.** The request said "images or street views".
   Google Maps and Street View remain excluded from this project entirely, including as
   critic reference. Reference came from Wikimedia Commons geosearch around the bake
   origin: 150 geolocated files, 56 free-licence at 900 px or better, 12 architectural.
   Several are buildings inside our own footprint set - First Methodist Church at 74 m,
   the S.H. Kress Building and Worth's Block at 157 m, Five Points Roundabout at 211 m.
   Saved with licence and author in `reference/sarasota/`. **Reference, not source
   assets**: nothing is traced or sampled into a texture, which also keeps CC BY-SA
   share-alike off the shipped work. Mapillary is allowed by constraint 1 and has far
   denser street-level coverage, but needs an API token - a credential, so it waits on the
   user under escalation rule (d).

The re-bake ran from the cached extract with no network fetch, and **geometry is
byte-identical either side**: sha256 `961d0e70a9996d430c2a68c926dd2d1b` over verts, edges,
footprints, water, coastline, zones and chunk keys. Only names moved. The fictionalizing
machinery is retained behind `REAL_STREET_NAMES` so the swap is reversible.

### What the photographs say we get wrong

Ranked, and handed to a builder in this order:

1. **Palms, and we ship temperate broadleaf trees.** Sabal palms with the fibrous
   crisscross boot trunk, and queen palms. They line Five Points and stand at every
   building base. This is the single biggest tell that our street is not Florida.
2. **Brick paver sidewalks, and we ship plain concrete slabs** - red-brown clay pavers in
   running bond with a soldier-course border at the kerb.
3. **Ornamental twin-globe black lamp standards**, not the plain modern poles we ship.
4. **Saturated fabric awnings**, scalloped or barrel-curved, gold and red.
5. **Warm painted brick and weathered masonry** on the low-rise stock, not grey stucco -
   and two-storey historic blocks standing directly against tall modern condo towers,
   which is what Main Street actually looks like.
6. **Terracotta barrel tile** as roofs, canopies and window hoods, including on the 1970s
   concrete towers.

## The bloom was veiling glare: the bright pass thresholded nits against a camera stop

Found while auditing the double-sky build's own open items. `src/post.js` computed

    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float contrib = max(soft, lum - threshold) / max(lum, 1e-5);

with `c` in **nits** - a sunlit road at golden hour is thousands - while `daynight.js`
authors `bloomThreshold` on the 0-2 scale the tonemapper works in (noon 1.7, dusk 0.85,
night 0.55). At golden the stop is 1/4152, so mid-grey is about 750 nits against a
threshold of 1.4. `lum - threshold` was indistinguishable from `lum`, **contrib came out
~1 for every pixel**, and the composite added `bloomStrength x a 20 px blur of the entire
frame`.

Measured at the golden corridor camera - mean luminance the bloom ADDED, binned by each
pixel's own no-bloom luminance:

| no-bloom luminance | before | after |
|---|---|---|
| 0-19 | **+29.3** | +3.6 |
| 20-49 | +27.7 | +1.1 |
| 50-99 | **+32.5** | +0.9 |
| 100-159 | +30.5 | +1.7 |
| 160-219 | +19.6 | +1.6 |
| 220-255 | **+8.0** | **+3.2** |

**It was lifting the darks hardest and the highlights least** - the exact inverse of a
bloom, and a uniform ~30/255 veil across the frame. That single defect accounts for a
remarkable amount of what critics have reported for rounds: "milky with no black point",
flattened shadow edges, low chroma at golden (a grey veil desaturates), dusk having no
specular, and the shallow cast shadows measured after the ground-contact work. The
double-sky build had independently found the same thing from the other end - bloom/scene
0.998-1.016 at every daylight preset - and left it as an open item because fixing it
would re-grade all four presets.

Fixed by multiplying `lum` by the camera stop inside the bright pass, so the authored
threshold means what it says: 1.4x mid-grey rather than 1.4 nits. `contrib` is a ratio and
stays unit-free, so the colour it scales is still in nits.

The authored `bloomStrength` values were tuned against the broken pass and are retained
rather than re-dialled - they now act on highlights only, and the night frame reads with a
real black point and a localised lamp glow for the first time. If a critic reports the
bloom as too weak, that is a measured signal to re-derive them; guessing new numbers now
would just be re-authoring against a fresh unknown.

Gates after: syntax PASS (81), golden-trace PASS, physics PASS, lighting sweep PASS with
both negative tests firing, budget PASS/PASS/WARN (draw 227, tris 721,148, stall 8.8).

**A repeat mistake worth recording:** the first version of this edit put backticks inside
a GLSL comment, which terminated the template literal - the identical error already in
this ledger's Failed approaches. Reading a lesson is not the same as having it.

## The sky is delivered twice, and that is why golden hour reads flat

The round-7 lighting critic produced the best-controlled measurement this project has
received: a **key:fill of 0.85 stops** on a pair of boxes either side of a verified
building shadow at golden hour, on the same material - established by the two boxes
agreeing to within 1% at dusk, when neither is sunlit. Golden hour wants 2.5-4 stops.

It could not tell from pixels whether the key was too weak or the fill too strong. The
isolation says fill, and names the mechanism. Corridor hero camera, golden hour, settled
scene, one light path zeroed at a time, contributions linearised:

| region | sun | HemisphereLight | environment (PMREM) | key:fill |
|---|---|---|---|---|
| sunlit wall (120,120,120x60) | 55.5% | 3.9% | **40.6%** | 1.25x = **0.32 stops** |
| ground (250,800,120x40) | 23.0% | 30.9% | **46.1%** | 0.30x = **-1.75 stops** |

`daynight.js` runs a HemisphereLight at the preset's `skyLux`, and `sky.js` builds a PMREM
from the same dome which `scene.environment` delivers again at `environmentIntensity 1` -
over sky.js's own figure of 0.35. **On the ground that is 77% of all light, from one sky
counted two ways.** On a vertical the hemisphere contributes almost nothing (3.9%, since
its sky half only fully reaches an up-facing normal) while the PMREM still delivers 40.6%.

This was already known and logged. The golden-hour build wrote: *"The district's sky is
delivered twice, which structurally caps any sun's share (36% atmospheric -> 26.5%
rendered). Reported, not fixed - it's a district-wide decision with a stated reason in
apply()."* A blind critic has now independently measured its consequence in the picture,
which is the point at which "reported, not fixed" stops being good enough.

It also explains, without any new hypothesis, four separate things critics have reported
across two rounds: the ground reading blue while sun-facing walls read warm; golden being
the least colourful daylight state (mean chroma 22.3 against dusk's 37.7); cast shadows
measuring shallow (fill fills them back in); and "golden is not golden".

Scheduled as builder work. The non-trivial part is that a HemisphereLight approximates
sky **plus ground bounce**, and the PMREM has no bounce term - so deleting the hemisphere
outright removes something the PMREM never had. Exposure must be re-derived for every
preset once the total illuminance changes, and `PLAUSIBLE` asserts the HemisphereLight's
raw intensity, which may become the wrong quantity to assert.

### Round 7, lighting critic: what else it measured

- **Glazing has no environment term at all.** The tower pane sits at a fixed **0.82-0.84**
  of the concrete beside it right through daylight; at night it reads (3,4,11) while a
  slab of emissive windows faces it across the street. Third round to report this, and the
  first to control it against the wall.
- **Contact darkening is zero and the sign runs backwards.** Four boxes along one row from
  a post's foot outward: the contact pixel is 1% *brighter* than 88 px away at golden, 5%
  at dusk, 37% at night. Paving joints render as brighter ridges than the slab faces.
- **The highlight is a hard clip, not a shoulder.** corridor-golden R channel: 1,022 pixels
  at 254 and **12,185 at 255** - a 12x pile-up in the last bin, and the channels clip at
  different times so the top end skews yellow.
- **Dusk has no specular at all** - nothing exceeds 248, 99% is at or below 226.
- It also checked 19 sky boxes rather than one column and reported the blue-left /
  warm-right gradient correctly, explicitly noting that a single column would have given
  the wrong answer in either direction.

## The sky is delivered once, and the premise that made it hard was false

The section above scheduled this and named the hard part: *"a HemisphereLight
approximates sky PLUS ground bounce, and the PMREM has no bounce term — so deleting
the hemisphere outright removes something the PMREM never had."* That is true of
nearly every sky PMREM. **It is false for this one**, and being able to say so
rather than argue about it is what the new instrument bought.

### The instrument, because differencing screenshots could not settle it

Every previous isolation in this ledger differenced screenshots. That cannot answer
"how much light is there", and this build breaks it three ways at once:

1. **The capture is neither linear nor sRGB.** `src/post.js`'s composite is a
   `RawShaderMaterial` writing `aces(color * exposure)` straight to `gl_FragColor`
   with no `<colorspace_fragment>`, so three.js adds no encode and the 8-bit value
   in a screenshot **is** the Narkowicz ACES output. Checked, not assumed: noon's
   ground region reads 15,976 nits out of the HDR target at 1/78,000, and
   `aces(15976 · (ao + bloomStrength) / 78000)` is 98 of 255 while an sRGB encode of
   the same is 169. The frame reads **97.7**.
2. **A ratio of two pixel boxes is a ratio of two materials as much as of two
   lights**, even when the materials are verified identical, because fog, AO and
   bloom reach the two boxes differently.
3. **A screenshot cannot be inverted past a clip**, and `corridor-golden` has 12,185
   pixels in the last bin of R.

`tools/sky-once.mjs` therefore puts a **light meter in the frame**: four albedo-1,
roughness-1, emissive-0 patches 2.4 m in front of the hero camera — facing up, facing
down, vertical facing the lens, and vertical turned as far toward the sun as the
camera can read. A Lambertian surface of albedo 1 under irradiance E has radiance
E/π, so π times the patch's radiance read out of `post.hdr` is **lux**. Each light
path is then switched off in turn.

It is self-tested against a closed form — with the sun and the environment off, an
up-facing patch must read `intensity · luminance(skyColor)`, which is what
`getHemisphereLightIrradiance` computes for an up-facing normal. On the committed
build: **0.0%** error at noon, golden and dusk on all four patches. On the changed
build, where that light is off, the test injects a known intensity and checks the
same identity: **−0.01%, −0.01%, +0.07%**. The three light paths also sum to the
measured total to within **0.01%**.

Three of its own failures are recorded, because each produced plausible numbers:

- **A 700 ms wait between the toggle and the readback was sometimes less than one
  frame**, so the readback returned the *previous* variant's target: `base` came back
  byte-identical to `envonly`, which made the sun's contribution negative. Switching
  a light ON cannot remove light, and that impossibility is what exposed it. Now it
  waits six rendered frames, re-asserts the state every frame while waiting, and
  records in the artifact the intensities each variant's frame was rendered at.
- **A key patch read at a grazing angle stopped being a diffuse meter.** A
  `MeshStandardMaterial` keeps its dielectric lobe and Schlick's `(1−cosθ)^5` takes
  F0 = 0.04 to 0.34 at 78°: the patch read the sun 68% over the arithmetic and read
  the HemisphereLight **26.8% under a value the shader computes in closed form**.
  Clamped to 55°, where the Fresnel term is 0.054.
- **One whole run measured the inside of a building** — see the Measurement
  integrity entry below.

### The derivation: this dome's ground bounce is six times the light's

`src/sky.js`'s `skyRadiance()` does not stop at the horizon —
`L = mix(L, groundRadiance(), 1 − exp(−below · uGroundHaze))` with
`groundRadiance() = uGroundAlbedo · E / π` — so the LUT's lower hemisphere is a lit
ground plane, and the PMREM is built from that LUT. Integrating it with the same
`∫L cosθ dω` that produces `skyLux`:

| preset | surface | HemisphereLight | PMREM env | the dome's own integral |
|---|---|---|---|---|
| noon | up | 13,074 lux | 15,006 lux | 15,126 lux |
| noon | **down** | **2,580** | **15,736** | **15,593** |
| noon | wall | 7,827 | 17,084 | 16,482 |
| golden | up | 5,548 | 7,359 | 8,503 |
| golden | down | 732 | 1,550 | 1,273 |
| golden | wall | 3,140 | 6,490 | 6,111 |
| dusk | up | 355 | 1,381 | 1,595 |

The dome's ground bounce is **15,593 lux at noon against the HemisphereLight's
2,580** — six times as much, not absent — and the PMREM delivers it to within 1%.
Giving the sky to the PMREM and keeping the hemisphere for the bounce, which is the
obvious compromise and the one this change was expected to make, would have
double-counted the bounce: the same mistake one level down.

So the hemisphere carries **nothing** when the dome's map is in the scene and
everything when it is not — `labs/materials`, `labs/facades` and `labs/signage`
construct `TimeOfDay` without a dome and would go black otherwise. `apply()` decides
*after* the dome has written, because that is when the question can be asked. The
light stays in the scene at intensity 0 rather than being removed, so the shader
permutation and the audit's light census do not move across the change.

Correcting the PMREM's residual with `environmentIntensity` is ruled out by the same
table: at golden the roughness-1 convolution delivers **86.5% of the dome's integral
on an up-facing normal and 122% on a down-facing one in the same frame**. The error
is angular, not scalar. `sky.js`'s `recommendedEnvironmentIntensity` — 0.35, which
existed *only* to leave room for the HemisphereLight — is now 1 and agrees with
`daynight.js`. That matters beyond tidiness: `sky.refresh()` calls `applyToScene()`
again on every weather transition, so a disagreement re-dims the district mid-rain.

Night is deliberately absent from the table above: the meter's single-path frames
still contain the street lamps at that hour, which at 0.7 lux total swamp the 0.008
lux the hemisphere delivers. The closed form and the by-difference isolation agree
there instead — 0.008 lux, 1.1% of the light at that camera, with base-minus-
hemisphere-off reading 0.0 against a 0.05 lux quantisation.

### Exposure, re-derived for every preset

The rule is `exposure = π/E`. Only `golden` was ever authored strictly to it — noon
sits 2.1× under, dusk 1.35×, night 6×, each deliberately — so each stop moves by the
factor its **own** horizontal illuminance moved by, which is what an auto-exposure
does. Re-deriving three presets from the rule would re-grade them for a reason
unrelated to this change.

| preset | E_before | HemisphereLight | E_after predicted | E_after **measured** | factor | stop |
|---|---|---|---|---|---|---|
| noon | 119,851 lux | 13,075 (10.9%) | 106,775 | **106,758** | 1.1225 | 1/78,000 → **1/69,490** |
| golden | 17,971 | 5,548 (30.9%) | 12,423 | **12,423** | 1.4466 | 1/6,006 → **1/4,152** |
| dusk | 1,764 | 355 (20.1%) | 1,409 | **1,410** | 1.2518 | 1/900 → **1/719** |
| night | 0.700 | 0.008 (1.1%) | 0.692 | **0.700** | 1.0116 | 1/1.15 → **left alone** |

The last two columns are the check that the derivation was right rather than
plausible: the changed build's own light meter reproduces the predicted E_after to
**0.016% at noon, 0.002% at golden and 0.035% at dusk**. Night is left alone as the
derivation's own answer — 1.2% is below the meter's resolution there, and the night
frames are the ones three critic rounds have named as the best in the set.

**An 18% card sits where it sat.** What moves is the split, because the term removed
was fill and the sun was not:

| preset | sun's share of the light on the road | key:fill on the meter (same material, same point, two orientations) |
|---|---|---|
| noon | 76.6% → **86.0%** | 1.29 → 1.43 (0.37 → 0.51 stops) |
| golden | 28.2% → **40.8%** | **2.99 → 3.95 (1.58 → 1.98 stops)** |
| dusk | 1.6% → 2.0% | 1.02 → 1.02 (the dusk sun is 8° off the camera-facing wall's own normal, so there is no shadow side to measure) |
| night | 28.6% → 28.9% | 0.62 → 0.62 |

Golden's 40.8% is *above* the atmosphere's own 36.0% quoted in the preset, because
the PMREM under-delivers the dome's sky by 13.5% on a horizontal normal. The `26.5%
of the road` that comment used to carry was measured on the double-counted build and
does not describe this one.

**What this costs noon, stated rather than left to be found.** The HemisphereLight
was 31.4% of the light on a vertical surface at the corridor camera (7,827 lux of
24,906), and a 75.6° sun leaves a wall almost nothing else; the corridor wall region
goes 3,807 → 3,103 nits. The frame this ledger already records as unusable loses that
much again. The recorded remedy — lower the elevation — is unchanged and still right.

### The envelope was asserting the wrong quantity

`PLAUSIBLE[preset].skyLux` was checked against `hemi.intensity`, which is an
intensity rather than an illuminance *and* was only one of the two paths delivering
the sky. It now judges `skyDelivery().totalLux` and counts `paths`. No bound moved.
Full derivation, and the demonstration that the new assertion fails on the old
configuration, in the Threshold change log.

### The critic's predictions, scored

Scored with one instrument (`tools/critic-metrics.mjs`) on frames from one harness
(`tools/hero-shots.mjs`), before (`b8-*`) and after (`a8-*`). The noise floor comes
first: re-capturing the *unchanged* build as `b8-*` against the committed `r7-*` set
moves whole-frame metrics by 0.5–5% (that harness does not freeze pedestrians), while
the critic's verified pair reads **byte-identically** — `key8 [199.5, 185, 160.8]`,
`fill8 [141.7, 143.2, 142]` in both — because it sits on static facade geometry.

| prediction | `r7` | `b8` before | `a8` after | met? |
|---|---|---|---|---|
| **1.** fivepoints-golden pair, linear ratio → 5–7 | 1.72 | 1.72 | **1.56** (sRGB) / **1.74** (ACES⁻¹) | **no** |
| **2.** fivepoints-golden ground box warm → tens of % | 0.39% | 0.39% | **0.35%** | **no** |
| **3.** corridor-golden pixels at 255 → below 0.2% | 0.846% | 0.844% | **1.087%** | **no, and worse** |
| **3b.** corridor-golden R 254→255 step → below 3× | 11.9× | 12.0× | **13.0×** | **no** |
| **4.** corridor-golden mean chroma → rise | 22.33 | 22.44 | **21.07** | **no** |

Five predictions, none met — and the change is nevertheless the right one, because each
of the five is measuring something other than what it was written to measure. The
evidence for that is in the same frames.

**The change is unambiguously there.** Differencing the frames: at golden the corridor
moves by mean |Δ| **15.0** with 86% of pixels changed, against a *same-build* r7↔b8
noise of 2.2 and 10%; fivepoints moves 10.5 / 73% against 0.67 / 3.7%; dusk moves 10.1
/ 88% against 2.3 / 13%. At night it moves 2.2 / 20.5% against a same-build 2.1 /
19.1% — i.e. nothing, which is what a 1.1% term should do.

**Prediction 2 is the one that carries information, and its own alternative is right
for a reason it did not offer.** The critic wrote: *"if it stays near 0.4%, the
road/sidewalk materials are off the sun path and that is a separate, cheaper fix."*
The materials are not off the sun path. The **same materials, same build, same
change** at the other two cameras:

| ground band, golden hour | warm fraction (R−B>10) | R−B |
|---|---|---|
| corridor hero camera (`skyonce-*-golden`) | 18.2% → **41.4%** | −8.2 → **+3.5** |
| sweep camera (`tod-golden`) | 7.4% → **33.8%** | −12.7 → **−2.6** |
| **fivepoints hero camera** | **0.39% → 0.35%** | **−42.0** |

At fivepoints the carriageway and both pavements are inside the blocks' own shadow —
an 8° sun down a street canyon does not reach them — so the box contains almost no
sunlit ground to warm. `docs/shots/a8-fivepoints-golden.png` shows the shadow edge
running the width of the frame. The answer to "report which" is **neither branch**: the
materials are on the sun path where the sun reaches them, and that box is in shade.

**Predictions 3 and 4 move the wrong way, and the mechanism is the exposure rule
working correctly.** The rule normalises an 18% card on the *ground*; the term removed
was on the ground and not in the sky, whose radiance is what it always was. So
re-exposing raises the sky by the full 1.4466× while the road stays put:

| golden band, corridor | mean Y | chroma | R−B |
|---|---|---|---|
| ground, before → after | 123.6 → 127.8 | 21.6 → 23.1 | **−8.2 → +3.5** |
| sky, before → after | 193.0 → **216.8** | 31.4 → **16.2** | −12.3 → −8.3 |

A brighter sky is a *less* saturated sky once ACES has it, and the sky is a third of
the frame — so whole-frame chroma falls (prediction 4) while the street it is meant to
describe goes from blue to warm. The extra clipped pixels (prediction 3) are the same
sky and the specular glass in it, neither of which the HemisphereLight was lighting.

**And the bright pass is amplifying all of it by 1.4×** — see the bloom finding below.
The counterfactual is captured: `docs/shots/skyonce-after-golden-nobloom.png` is the
same frame with `bloomStrength` set to 0 for one capture. It reads chroma **24.94**
against 22.66 and 0.886% clipped against 1.086%. Removing the veil recovers most of
prediction 4 and a fifth of prediction 3 on its own.

**Prediction 1 is capped by the dome, and the cap is measurable.** The meter's
controlled key:fill — one material, one point, two orientations — went **2.99 → 3.95
(1.58 → 1.98 stops)** at golden, which is the whole of what removing the double count
can buy. The remaining gap to 2.5–4 stops is the sky's own irradiance on a wall: the
dome puts **12,104 lux on a sun-facing vertical** against 34,394 lux of beam, so a
shadow edge on that wall cannot exceed 1 + 34,067/10,894 = 4.13 (2.05 stops) however
the sky is delivered. Getting to 5–7 needs a less luminous horizon at 8°, not a
lighting-delivery fix.

### Regressions guarded

The round-7 critics named three things as the best in the set, all at night — the
preset where the HemisphereLight was delivering 0.008 lux of 0.700. Same harness,
same tags, and the `r7` capture of the *unchanged* build included so the run-to-run
spread is visible next to the change:

| corridor-night | `r7` | `b8` before | `a8` after |
|---|---|---|---|
| crushed fraction, Y≤2 | 6.14% | 6.05% | **6.13%** |
| lamp pool, brightest 5% of ground band | 41.3 | 42.5 | 39.7 |
| lamp pool, band median "away" | 9.3 | 9.1 | 11.2 |
| lit-window spread (sd of bright facade pixels) | 28.7 | 29.2 | **28.8** |
| whole-frame chroma / mean Y | 17.83 / 28.5 | 17.63 / 28.2 | 17.68 / 28.5 |

| fivepoints-night | `r7` | `b8` before | `a8` after |
|---|---|---|---|
| crushed fraction, Y≤2 | 2.41% | 2.47% | **2.43%** |
| lamp pool, in / away / ratio | 91.7 / 36.2 / 2.53 | 91.7 / 36.0 / 2.55 | 91.3 / 35.9 / **2.54** |
| lit-window spread | 46.1 | 47.4 | **46.7** |

**Nothing at night moved, and the frame difference proves it rather than the table.**
Differencing corridor-night pixel by pixel: `r7` against `b8` — the *same build*,
captured twice — gives mean |Δ| **2.106** with 19.1% of pixels changed by more than
3; `b8` against `a8`, across the change, gives **2.221** and 20.5%. The change is
inside the harness's own noise, which is 96 unfrozen pedestrians walking through the
frame. The one number that moves outside that band is the corridor's "away" median
(9.1 → 11.2), and it is a median over a band those pedestrians walk across; the
band's *mean* moves 12.7 → 13.4, and `r7`'s is 12.6.

The crushed fraction is quoted at `Y≤2` on Rec.709 luminance throughout. The brief's
11.6% for this frame is the same measurement at a different threshold — `Y≤3` gives
12.32% and `max(R,G,B)≤2` gives 4.24% — so the threshold is stated rather than the
number inherited.

### Found on the way, measured, NOT fixed: the bright pass thresholds nits against a number authored in exposed units

`src/post.js`'s bright pass does:

```
this.brightMat.uniforms.threshold.value = this.params.bloomThreshold;   // 1.4 at golden
...
float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));            // c is the SCENE TARGET
float contrib = max(soft, lum - threshold) / max(lum, 1e-5);
```

`c` is `post.hdr` — absolute nits, thousands of them in daylight. `bloomThreshold`
is 1.4. `src/daynight.js` derives that 1.4 explicitly **"in exposed units at
1/6,006"**, from three quantities it computes as `radiance * exposure`. The shader
and the file that authors the constant disagree about what the constant means by a
factor of the exposure — 6,006 at golden, 78,000 at noon, 900 at dusk.

So `contrib` is `1 - threshold/lum`, which is ~1 for every pixel in the frame, and
the composite's `scene * ao + bloom * bloomStrength` adds **`bloomStrength` times a
blurred copy of the whole frame**. That is not an inference. `tools/sky-once.mjs`
reads the bloom target over the same boxes as the scene target:

| preset | bloom / scene, wall box | bloom / scene, ground box | bloomStrength |
|---|---|---|---|
| noon | 1.001 | 1.001 | 0.30 |
| golden | 1.004 | 1.011 | 0.40 |
| dusk | 0.998 | 0.997 | 0.62 |
| night | (fill) | (fill) | 0.85 |

A second, independent check: predicting a pixel from the HDR readback only comes
out right with the veil in it. Noon's ground region is 15,976 nits at 1/78,000;
`aces(15976 * (0.95 + 0.30) / 78000)` is 98.5 of 255 and the frame reads **97.7**.
Without the bloom term the same arithmetic gives 78.

**Why this matters to the round-7 critique specifically.** The blur is four passes
at half resolution with taps at 1.38 and 3.23 texels, i.e. a radius of roughly 20
full-resolution pixels, and the critic's verified pair sits **38 pixels apart across
a shadow edge**. A 40%-strength blurred copy at that radius adds nearly the same
value to both boxes, which is arithmetically a contrast reducer: with a true
lit:shadow illuminance ratio of K:F, the frame shows `(K + 0.4M) : (F + 0.4M)` with
M the local mean. At golden's measured wall irradiances that turns 3.4 into about
2.3 before ACES ever gets involved.

**Not fixed here, deliberately.** The fix is one uniform, but it changes what every
preset looks like at every time of day: at dusk `0.85` exposed is 765 nits against
the `0.85` nits the shader currently uses, so the veil would go from total to almost
absent, and all four presets' `bloomThreshold`/`bloomStrength` pairs were authored
against the veiled look and would have to be re-derived together. Doing it inside
this change would also make this change unmeasurable. It is the next item, it is in
`src/post.js`, and it is the thing standing between the critic's predictions 1, 3
and 4 and their targets.

The counterfactual is captured rather than argued: `docs/shots/skyonce-after-*-nobloom.png`
is each hero frame with `bloomStrength` set to 0 for one capture and restored
immediately. Nothing shipped is changed by it.

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

## Measurement integrity, a fourth of the same shape: the probe measured the inside of a wall

Added to the list below, because it is the same failure with a new disguise and it
cost a full measurement pass.

One run of `tools/sky-once.mjs` put the corridor camera inside a building. Every
input was identical to the run before it — the same coordinates `(3.7, −1.9)`, the
same `back 16`, the same 3.2 m of clearance reported by `framing.mjs`, the same 89
chunks and 264 meshes settled — and the entire frame was a brick facade at arm's
length. `docs/shots/skyonce-meter-after.png` from that run is a wall, edge to edge.

**The numbers it produced were plausible.** An up-facing patch reading 13,042 lux at
noon rather than 119,851 is just a dark scene; region contributions that still summed
to 100% looked like a working isolation. Two readings were *impossible*, and they are
what caught it: a **down-facing** patch reporting 22,628 lux of direct sun, and the
meter self-test coming back **87% under** a value the shader computes in closed form.

`placeCamera()` was then ruled out rather than assumed. A diagnostic placed the
camera before *and* after streaming settled: identical position, identical clearance,
correct street view both times. Nothing about the placement is nondeterministic and
re-running reproduces the good frame, so the cause is still unidentified — which is
exactly why the guard is on the **result** and not on the inputs. `sky.audit()` knows
the dome's own radiance, so if no pixel in the top band of the HDR target comes
within a factor of four of it, the camera is not looking at the street: the tool
re-places once and aborts with exit 2 if that does not fix it, and re-checks at every
preset.

**The rule this adds to the ones below.** A harness that frames its own shot must
prove the shot is the one it thinks it is, from the *rendered frame*, not from the
inputs it fed the framing code. Three tools in this repo previously measured from
inside building 67 and the defect surfaced only when somebody finally *looked* at a
capture; this one measured from inside a different wall and the defect surfaced only
because one of its readings was arithmetically impossible. Neither is a reliable
tripwire on its own.

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

### 2026-09-05 — five ACES-input thresholds restated for the display transfer (strictness HELD)

`src/post.js`'s composite now applies an sRGB encode after the tonemap. Five gates
and clamps are written in ACES INPUT units but exist to bound a DISPLAY value, and
inserting a transfer function between the two changes what the same number
permits. Each was restated so the display value it allows is identical:

| where | quantity | before | after | display byte either side |
|---|---|---|---|---|
| `daynight.js` `normalisePostExposure()` | fog colour clamp | 0.85 | **0.410** | 196 |
| `daynight.js` `normalisePostExposure()` | inscatter clamp | 2.2 | **1.193** | 236 |
| `daynight.js` `audit()` | fog washes out | 1.2 | **0.60** | 214 |
| `daynight.js` `audit()` | sun lobe blows | 3.0 | **1.744** | 243 |
| `sky.js` `audit()` | mid-sky is blown | 1.0 | **0.491** | 205 |
| `sky.js` `fogCeiling` | ceiling handed to post | 1.1 | **0.545** | 210 |
| `sky.js` `inscatterCeiling` | ceiling handed to post | 2.7 | **1.528** | 241 |

Each new value solves `srgb(aces(x')) = aces(x)` for the old `x`, so no frame that
was permitted before is forbidden and none that was forbidden is now permitted.
**Left at the old numbers every one of them would have been LOOSENED**, and by a
lot: the mid-sky gate would have stopped firing until mid-sky reached 229/255
instead of 205, and the far field would have been allowed to reach 222 where it
was allowed 196. That is the direction this change had to be checked in, and it is
why the numbers moved rather than staying put.

Measured on the changed build (`docs/daynight.json`), all four presets pass with
margin: mid-sky exposed 0.222 noon, 0.349 golden, 0.298 dusk, 0.017 night against
the 0.491 gate. The clamps bite less than they did because every stop came down —
golden's inscatter clamp goes 0.627 -> 0.825 and dusk's 0.765 -> unclamped — and
the display ceiling they enforce is unchanged, which is the point.

**No plausibility bound moved.** `PLAUSIBLE`'s lux and candela envelopes, the
draw-call and triangle budgets and the golden-trace tolerances are all untouched;
the sweep's two negative tests both still fire.



### 2026-09-01 — the lighting envelope's `skyLux` bound now judges DELIVERED illuminance (strictness INCREASED)

`PLAUSIBLE[preset].skyLux` has been checked against `hemi.intensity` since Phase 1.
That is the wrong quantity twice over, and the second way is the one that mattered.

**It is an intensity, not an illuminance.** three.js hands the shader
`color * intensity` as irradiance, so a light of intensity E puts
`E * luminance(color)` lux on a facing surface, and `luminance(color) < 1` for
every colour that is not white. The file has said so since the golden-hour build
and reported `skyLuxDelivered` beside the authored value — reported, not gated.

**It was not even the only path carrying the sky.** `sky.js`'s PMREM is built from
the same dome and `scene.environment` delivers it again. On the committed build,
measured at the corridor hero camera with `tools/sky-once.mjs`'s light meter:

| preset | HemisphereLight delivers | environment delivers | total | envelope |
|---|---|---|---|---|
| noon | 13,074 lux | 15,156 lux | 28,230 | 8,000–30,000 |
| golden | 5,548 | 8,519 | **14,067** | **5,500–11,800** |
| dusk | 355 | 1,596 | 1,951 | 100–2,500 |
| night | 0.008 | 0.197 | 0.205 | 0.03–1.5 |

The gate read PASS on all four (`docs/b8-audits.json`, eight captures, zero flags)
because it was looking at `hemi.intensity` — 8,519 at golden — and calling it lux.
**Golden was outside its own envelope by 19% and the gate could not see it.**

**What changed.** `audit()` now computes `skyDelivery()`: the sky's diffuse
illuminance on a horizontal surface summed over every path that carries it
(`hemi.intensity * luminance(hemi.color)` plus the dome's own measured `skyLux`
times `scene.environmentIntensity`), and the envelope judges that total. The
bounds themselves are unchanged — they were always authored as sky *illuminance*
ranges swept from `src/sky.js`'s own atmosphere, so they now mean what they say.

**A second, new assertion.** `skyDelivery().paths` counts how many independent
paths are delivering the sky, and the audit flags anything but 1. This is not a
threshold; it is a physical statement — one sky, one delivery. It exists because
the delivered-total check alone would NOT have caught the double count at noon or
dusk, where the doubled figure still lands inside the band. A count does.

**This is a strictness increase, not a relaxation.** Every preset that passed
before still has to pass on a stricter quantity, and one of them (golden) did not
until the double delivery was removed. No bound was widened. The negative test in
`tools/daynight-sweep.mjs` still fires.

**What it would have caught.** Re-run the old check against the fixed build and it
passes; run the new check against the committed build and golden fails on the
total and all four fail on `paths`. That is the test that this change makes the
gate stronger rather than merely different.

**Demonstrated, not asserted.** `tools/daynight-sweep.mjs` now carries a second
negative test that re-injects exactly the removed state — the HemisphereLight back at
the preset's `skyLux` at golden, environment untouched — and FAILS the gate if the
checker does not fire. It fires with both flags (`docs/daynight-negative-sky.json`):

```
sky delivers 14067 lux to a horizontal surface (hemisphere 5548 + environment 8519),
  outside plausible 5500-11800 for golden
the sky is delivered 2 times: HemisphereLight 5548 lux AND environment 8519 lux,
  from the same dome
```

Sweep verdict on the changed build: **PASS**, all four presets inside the envelope,
`paths: 1` at every one, and both negative tests firing.


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

**RESUMED, working the open list autonomously.** The block that stood here was written
at the M2 gate and had gone stale in three ways worth naming, because a stale status
section is read as current by every reviewer and every next session:

- It called the budget gate **RED** at 18.5 ms chunk stall against a 16 ms fail, and
  treated that as escalation condition (a). Measured 2026-09-04: **8.3 ms**, PASS/PASS/WARN.
  The stall is a WARN, not a fail, and this ledger records that metric spanning
  5.3-24.2 ms on identical builds, so it is advisory.
- It listed AO / contact shadows as the most-cited critic gap and not done. SSAO is in
  `src/post.js` and pedestrians carry contact shadows.
- It said "waiting for CONTINUE". Work has continued for several rounds since.

### Actually open, as of 2026-09-04

| item | state |
|---|---|
| Limb tubes read as extruded triangles | in flight — 3-gon tubes, dead-straight silhouettes, now the straightest thing in a close frame |
| Glass reads cobalt, reference is bronze | in flight — engine B/R 1.49-2.07 vs reference 0.67-0.83, pane:wall 0.49 vs 0.12 |
| Noon renders darker than night | in flight — `midSkyExposed` 0.107 vs 0.81 at golden, so constraint 3's second time of day is unusable |
| `src/audio.js`, `src/wanted.js` unwired | 88 KB built and verified 2026-09-02, held back while the gate was red. The gate is no longer red and neither module is reachable from `district/main.js`. |
| Canopy `xings` 20-38 against a reference 50 | open, unexplained. Two rounds have moved it and neither produced a story for the residual. |
| Close crown reads as texel-quantised blobs | open — pushing porosity harder made it worse (scattered angular flakes), so the shipped setting backed off |
| Five Points naming | the waypoint is Main/Lemon; the real roundabout is 196 m west with no reference coverage |
| Junction capacity in traffic | 64.3% overlap at 60 cars; non-conflicting movements do not cross together |

Traffic AI is otherwise done: 14.6% overlap at 30 cars against the 35.4% stub baseline,
same-edge overlaps eliminated.

The three geometry defects the old block listed (severed awning post, floating plaza
bars, orphaned pole stub) are not reproducible against the current `geom-audit`, which
passes; they are treated as closed unless a critic re-reports one.

---

## Status as of 2026-09-06 — the four-round improvement pass

The table above ("Actually open, as of 2026-09-04") is superseded. Everything in it is
closed except the two noted below. This section is written the same way and for the same
reason: a stale status block is read as current by every reviewer and every next session.

### The process failure that shaped this round

A blind review round was spent comparing a build against **itself**. `ensureServer()`
returns early when anything is already listening on its port, and `http-server -s .`
serves whatever directory started it, so a capture run from a worktree silently reused the
main tree's server. Three reviewers each measured before judging and all three
independently caught it; that discipline is the only reason it was caught at all.

It had happened once before in the same session and been patched in ONE tool with its own
port variable, leaving the trap armed everywhere else. It went off again in the next round.
The check now lives in `ensureServer` itself — write a token into the tree, read it back
over HTTP, refuse a foreign document root — and `blind-compare` additionally refuses to
build a pair set carrying under 8% facade-band signal. The same "fixed in one copy,
live in the other four" shape turned up again in `_streetDirFor`, which five files each
carried their own copy of; it now lives once in `src/geom.js`.

### Closed this round, with the measurement that closed it

| item | evidence |
|---|---|
| Buildings facing the wrong street | 348 of 519 more than 45 deg off, 99 of them backwards. Nearest road VERTEX replaced with an edge-based frontage search. Building #18's chosen edge has a road 3.5 m in front against the old choice's 11.7 m |
| Buildings fronting service alleys | The first fix improved the statistic and made the frames worse: a high street is WIDE, so its centreline is further away than the alley behind. Roads now carry a class and an alley is a last resort |
| Mirrored signage | 1,379 of 3,582 lettered faces reversed, from three causes. Now 0, with a regression test |
| Pedestrians hovering | Not the shadow path: `aoRadius` 2.2 m. A figure put 0.041 of darkening on the pavement six body widths away and did not fall under 0.05 until 8.5. Now 0.6 m at exponent 8.5: 0.011 at six widths, and the window reveal holds at 0.067 |
| Glazing had no reflectance | The environment term was present. `drawOpening` painted its reveal AO into ALBEDO, and panes are metalness 0.80-0.88, so that albedo IS the mirror: F0 collapsed 0.290 -> 0.044 at the head. glass/wall 0.478 -> 0.714 noon, 0.479 -> 0.934 golden |
| Golden hour read cooler than dusk | Five Points ground plane mean R-B **-5.8 -> +40.0**, measured on the shipped frames. Dusk 16.1 -> 26.0 |
| Bare sidewalks | Reference-grounded frontage row. Corridor props in frame within 35 m: 5 -> 20. Its own gap-filler half was DROPPED on measurement (+0.4 props per route station for +16,466 triangles, nothing at either hero camera) |
| Doors invisible | Present as geometry all along, painted with the same atlas cells as the windows beside them. Frame and kick now take painted metal |

### Still open

| item | state |
|---|---|
| Noon shade is blue | **Partly fixed, and the honest number is mixed.** Corridor road at noon, exposure-robust (R-B)/luma: -0.897 -> -0.697, so 22% less blue and still blue. Brightness is much better: that region goes L 32.9 -> 53.0. The shaded walk band went the other way on hue, 0.246 -> 0.157 |
| Tall buildings have no tenancy expression | `lots` gates on `h <= 22`, so building #76 stays a 123 m unbroken wall on a street whose road is 2.4 m from its face. This is the Five Points block a critic called "a 1970s parking deck". The monolith is the gate, not the geometry |
| No shopfront lights at night | Diagnosed, not fixed. The facade atlas lights its ground row, but the glazing a street camera sees is the TRIM atlas cell, which has no emissive map at all. Needs either an emissive for the trim atlas modulated by the vertex tint, or moving recessed shop glazing onto the facade atlas |
| Glass reads blue at noon | A CONSEQUENCE of the glazing fix, not a regression of the old cobalt bug: street-level panes now genuinely see sky, and our noon sky is B/R 2.4-3.1. Golden and dusk both moved toward the reference |
| HUD per-frame allocation | Four allocation sites removed; the benefit is NOT demonstrated. See the commit — the timing arms were contaminated by concurrent headless captures, and a microbenchmark cannot see it because V8 scalar-replaces an object that never escapes |

### Two numbers not to trust

- **The budget gate's triangle count carries ~20k of run-to-run noise** from traffic and
  crowd placement — measured at 20,649 and 23,242 spread within an UNCHANGED configuration.
  A single run cannot resolve a 1,000-triangle margin against the 830,000 warn. Use the
  deterministic offline count or `tri-breakdown` when a change needs pricing.
- **`chunk stall ms` is unusable while anything else runs on the box.** The same code
  measured 7.1, 24.1, 7.9, 68.5 and 11.6 ms depending only on how many headless browsers
  were alive. It is a max, not a percentile.

---

## Status as of 2026-09-07 — the kerb

A blind reviewer, measuring rather than eyeballing: **there is no kerb anywhere in the
district.** "At corridor y=700, x1120→1200 the profile falls monotonically 113.6 → 63.9:
no gutter line, no kerb face, no shadow at its base. At 5× the asphalt abuts the brick
along a single hairline seam with the two surfaces reading as coplanar."

They were right, and the cause is a datum, not a missing model. The drawn land pad sits at
**-0.05** and the road ribbon at **+0.02**, so the pavement is 70 mm BELOW the carriageway
— the wrong way round by about 170 mm.

### What was built

`src/kerb.js` — the section and the plan, as pure arithmetic over the baked graph with no
THREE import, so the offline price (`tools/kerb-cost.mjs`) and the geometry gate
(`tools/geom-audit.mjs`) run the same code the streamer draws.

Section, `o` metres outboard of the ribbon edge:

| o | y | what |
|---|---|---|
| -0.06 | +0.018 | lap under the ribbon edge |
| 0.55 | -0.040 | shoulder, 10.5% |
| 2.00 | -0.040 | parking lane, flat |
| 2.50 | -0.105 | concrete gutter pan, 13% |
| 2.50 → 2.52 | -0.105 → +0.012 | **kerb face, 117 mm, battered 20 mm** |
| 2.64 | +0.012 | kerb top |
| 2.74 | -0.048 | back chamfer, on to the pad |

Every offset is pinned by something already placed, not chosen: parked cars straddle
o = 0.55..2.05 at y = -0.070 (a flat lane sinks them 23-30 mm against the 20 mm the bare
pad already does); signage.js stands its plates at o = 1.10..1.30 with their bases on the
pad; and the assembly stops 0.11 m short of streetfurniture.js's kerb station line at
w/2 + 2.85. The widening is not invented — `w` in the bake is lanes × laneWidth, the
travelled way only, which is why cars already parked 1.3 m beyond the drawn asphalt, on
brick pavers.

### The measurement, before and after

`tools/kerb-profile.mjs`, one build on one port, `?kerbs=0` as the control. A median of 13
sections 0.7 m apart across a kerb line at (126.5, -169.3), 15.1 m from the corridor
camera, walked as a 3D section rather than as a line on the ground. Parked cars and the
crowd are hidden in BOTH arms.

| time | build | monotone | reversals | faceDrop | panLift |
|---|---|---|---|---|---|
| golden | before | 0.523 | 52 | **2.0** | **7.7** |
| golden | after | 0.519 | 24 | **14.2** | **17.1** |
| noon | before | 0.526 | 75 | **18.6** | **14.4** |
| noon | after | 0.516 | 45 | **71.3** | **33.4** |
| dusk | before | 0.528 | 52 | **4.4** | **6.9** |
| dusk | after | 0.509 | 22 | **14.0** | **15.8** |

`faceDrop` is the darkest turning point in the face band against the brighter of its two
shoulders — the reviewer's "shadow at its base". `panLift` is the brightest turning point
in the gutter band against the carriageway mean — their "gutter line". Both are read off
TURNING POINTS, not band extremes, because the darkest sample in the face band of a
monotonic fall is simply its far end and subtracting the bright end reports a shadow that
is not there.

The reversal count FALLS (52 → 24, 75 → 45, 52 → 22) because 2.74 m of high-frequency
brick paving is replaced by smoother asphalt and concrete: the noise-driven turning points
go and the real ones stay. `monotone` sits near 0.5 in both arms and does not discriminate
— a textured render is not a smooth ramp, and that statistic is measuring paver noise.

At golden hour the after arm's three turning points across the kerb are
`max@-0.43 m = 70.0` (the pan), `min@+0.01 m = 50.1` (the face), `max@+0.02 m = 70.1` (the
top). The before arm has none: 67.7 / 64.2 / 69.7 / 64.2 across the same four stations, a
+-3 wander of brick.

Station luminances, noon: the parking lane goes 151.4 → 123.8 (brick to grimy asphalt),
the pan 168.6 → 167.6 (brick to concrete, near enough the same value but now a band with
edges), the face 175.9 → 161.1.

### Reference

`reference/sarasota/mapillary/mly-467303624342265.jpg` and `mly-4313177338733385.jpg` are
flat frames on Main Street east — the corridor the hero camera stands in. Both show the
same section: dark asphalt, a pale concrete gutter pan noticeably brighter than the road, a
short kerb face carrying a hard shadow, then the pavement. Florida DOT Type F: cast
concrete, a real pan rather than a bare face, and the pan LIGHTER than the road it edges.

### Cost

Priced offline and deterministically, because the budget gate's triangle statistic carries
~20,000 of noise:

    whole district      near 59,277   far 11,657
    worst loaded ring   26,674 total (19,192 near over 25 chunks, 7,482 far over 75)

against ~335,000 for the district's buildings. The polylines do the work: 442 kerbed edges
carry 21.6 km of centreline in 932 segments, mean 23.2 m, so a swept section costs 12
triangles per SEGMENT and not per metre.

The far tier gets the footprint flat and nothing else. At 1600x900 and 55 degrees, with the
camera 2.4 m above the pad, the whole 2.74 m section is 0.17 of a pixel DEEP at the 192 m
the far ring starts at and the 117 mm face is 0.57 of a pixel TALL. The widening is a
different matter because it is LATERAL and does not foreshorten: 15 px at 192 m, 9 px at
320 m, a visible notch in the kerb line at the LOD seam. So the apron stays and the rest
goes — 2 triangles per station pair instead of 12.

Draw calls: one extra mesh per NEAR chunk, on the registry's existing `kerb` material. The
asphalt half rides in the road mesh and costs none. The concrete half receives shadow and
does not cast — the dark line at the foot of a kerb is mostly the face's own shading, its
normal leans back over the carriageway, and a caster would add a second draw call per near
chunk to the depth pass against a 228/275 draw-call p95.

Measured at the two hero cameras, one build, one port, `?kerbs=0` as the control:

| camera | time | draw k0 → k1 | triangles k0 → k1 | Δ |
|---|---|---|---|---|
| corridor | noon | 159 → 162 | 640,534 → 654,874 | +14,340 |
| corridor | golden | 171 → 174 | 658,938 → 673,278 | +14,340 |
| corridor | dusk | 176 → 179 | 656,466 → 670,806 | +14,340 |
| corridor | night | 163 → 166 | 651,748 → 666,088 | +14,340 |
| fivepoints | noon | 176 → 183 | 686,991 → 693,949 | +6,958 |
| fivepoints | golden | 188 → 195 | 700,883 → 707,841 | +6,958 |
| fivepoints | dusk | 194 → 201 | 715,290 → 722,248 | +6,958 |
| fivepoints | night | 180 → 187 | 693,693 → 700,651 | +6,958 |

**+3 draw calls and +14,340 triangles at the corridor camera; +7 and +6,958 at Five
Points.** The triangle delta is IDENTICAL across all four hours at each camera, which is
what a clean A/B looks like: the crowd and the parked pool are instanced and do not move
with the clock, so none of the ~20,000 of budget-gate noise gets in. Peak of the eight is
201 draw calls against a 275 warn and 722,248 triangles against an 830,000 warn.

### Two bugs the gate found, and one the gate could not

| found by | what |
|---|---|
| `geom-audit` kerbInCarriageway | the miter's outboard normal was inverted at both tips, standing 117 mm of concrete across three arterials, 1.94 m deep |
| `geom-audit` kerbInCarriageway | `breakRun` skipped a run's OWN edge, so an offset polyline that folds over itself on an 82° shape point put the kerb face 0.6 m inside its own road |
| a whole-frame diff | **half the district's kerbs were back-facing.** The handedness of (travel, outboard) flips between the two sides of a street, and these materials are FrontSide. It did not look like a bug — a street with a kerb down one side looks like plenty of real streets |

The third is the one worth remembering: no number said "back-facing". The before/after
profile came back IDENTICAL across the left kerb while a whole-frame diff of the same two
PNGs showed 5.72% of pixels differing and a 2.7 m band of change down the right.
`geom-audit` now checks that every emitted triangle's geometric normal agrees with the
vertex normal it carries — 0 of 55,486 today, 39,298 of 55,486 with `KERB_AUDIT_FAULT=wind`.

### New gates, all falsifiable

`tools/geom-audit.mjs` gained a SURFACE, not just a check: `drawnGroundAt()` replays
src/kerb.js's own section, and the street-sign check now measures each post against the
ground it actually stands on rather than the flat -0.05 it used to assume.

    KERB_AUDIT_FAULT=float   kerbSection floatsAbovePavement  0.122            FAIL
    KERB_AUDIT_FAULT=sink    kerbSection sinksBelowPavement   0.118            FAIL
    KERB_AUDIT_FAULT=road    kerbInCarriageway  1,600 stations, 3.49 m deep    FAIL
    KERB_AUDIT_FAULT=lane    streetSignPost stop 0.025, many                   FAIL
    KERB_AUDIT_FAULT=wind    kerbBackFacing  39,298 of 55,486                  FAIL

`tools/kerb-profile.mjs --selftest` fails on a monotonic ramp reported as a kerb, on noise
reported as a kerb, on a seam 2.5 m off the kerb line being credited, and on a 4-byte PNG
stride. `tools/kerb-cost.mjs --selftest` fails on a mispriced run and on a section outside
the 100-150 mm reveal band.

### Two things this instrument got wrong before it got anything right

- **A section across a kerb is a 3D curve, not a line on the ground.** The corridor camera
  looks down the street, so a section across the kerb projects to a single image ROW: a
  straight line between its two ends runs along the FOOT of the kerb and never climbs its
  face. At 20 m the face is 5.2 px tall and the sample line passed under all five.
- **The band landed on a parked car.** The kerb face is 5.8 m from the centreline and the
  parking lane is 1.3 m of that, so a parked car stands squarely between a camera in the
  carriageway and the kerb behind it. The instrument now hides the parked-car pool and the
  crowd in both arms, and writes an overlay of its own sample points on the frame every
  run — both faults were invisible in the table and obvious in one look at where it
  sampled.

### Still open, adjacent

The same reviewer called the brick paving "a blurred low-texel mush at this camera
distance". The kerb takes 2.74 m of the nearest brick out of every street-level frame and
replaces it with asphalt and concrete, which helps, but the paver albedo is still 512 px
over a 3 m tile — 171 px/m against roughly 770 px/m of screen resolution at 2 m. That is a
texture-budget decision, not a geometry one, and it was not made here.
