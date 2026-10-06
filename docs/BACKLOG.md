# Open work

**This file exists because the session task list was lost with its container.** It held 92
items; the container was reclaimed between 2026-10-01 and 2026-10-05 and took `node_modules`
and the whole backlog with it. CLAUDE.md's own rule — anything worth keeping is committed —
had not been applied to the backlog itself. The SUBJECT lines below are recovered verbatim
from the last listing; the DESCRIPTIONS are recovered in full only where this session still
held them, and the rest are marked `detail lost`. Do not treat a short entry as a small
problem.

Keep this file current in the same commit as the work. A tracker that lives only in a
session is a tracker one timeout from gone.

---

## The cars — the live line, and the owner's standing ask

The owner asked for the cars to be iterated with reviewers "until they conclude that the cars
are *markedly improved*". Two blind reviewers have now seen the #56 pair. **Neither would use
that phrase**, and both gave the same reason: what separated the arms was a basic feature
present or absent on a subset of cars, not a refinement of how the street reads. That
regression is fixed (f95694d); **the question has not been re-put.**

What both reviewers ranked ABOVE body-shell variety, independently:

1. **No interior behind any glass.** Panes have the same internal structure as the door skin
   (1.89/1.40 against the door's 1.77/1.40); the building glazing in the same frame reads
   4.76/8.38, six to eight times more. No seats, no headrests, no A-pillar, no falloff.
2. **No number plates** — *partly done*, see below. Still capped by instanceColor.
3. **Tail lights are dark painted rectangles**, 1.11x the darkest paint on the same car.
4. **Octagonal wheels** at 56 px diameter, and inconsistent between cars — one has a rim ring,
   another is a featureless black lump with no arch cut.
5. **No hard sun shadow from any car, at either hour.** Only an ambient blob.
6. **One tint for the whole street**: glass (B-R)/L of 0.527 / 0.629 / 0.404 across three cars.
7. **The fleet is too uniform**: six wheel centres within 1.1 px of one ride height, all
   parallel to the kerb, all wheels dead ahead.

### #56 Body-shell variety — IN PROGRESS
Offline half landed (2aca6c5): three shells, length range 0.196 m, 1,050 triangles each.
Visual half run; it found and fixed a shipped regression (the shells' side windows were 95.1%
and 75.3% behind their own bodywork). Still open: per-shell `CAR_LENGTH` in `traffic.js` as its
own commit — 4.4 under-models the wagon by 0.289 m, and changing it perturbs the seeded traffic
stream. Then re-put the "markedly improved" question.

### #1 FIXED, with the tone range it was entangled with — the plate goes x0.41 -> x0.915
Two defects, one fix, because either alone makes the other worse.

**instanceColor multiplied EVERY vertex of an instance**, so a car's plate, headlamps, rims,
tyres and glass all carried the body's colour and the body's tone. The recorded x0.41 reproduced
exactly (plate vertex colour 0.7317 x a fleet instanceColor median of 0.4448 = 0.3255 against a
real plate's ~0.80). The stated cause was not the binding one: "body panels are already authored
0.995" is about the PAINT slot, and the plate's own vertex colour has headroom to 1.0 — what bound
it was the instanceColor luma range.

**And neither fleet could draw a white car or a black one.** `l = 0.34 + r * 0.26` and
`l = 0.26 + ((h*7)%1) * 0.4` are LINEAR albedos in three's working colour space, so the whole
fleet lived between a mid grey and a light grey: spans of x1.77 and x2.54, against a census that
is 29.2% white / 20.0% silver / 35.4% black. **64.6% of the real population had no tone at all.**

They had to land together. Widening alone takes the plate to 0.0233 on a black car — **x0.029** of
a real one — and de-tinting alone leaves a fleet of grey cars with correct plates.

    the fix                  plate rendered        fleet tone span
    before                   0.212 .. 0.482        x2.27
    widened, not de-tinted   0.023 .. 0.636        x27.30      strictly worse at the dark end
    shipped (both)           0.7317 on every car   x27.30      x0.915 of a real plate

**The tint is confined to palette slot 0, as a rule and not a list.** `paletteU(i)` is
`(i + 0.5) / 16`, so `floor( uv.x * 16 )` IS the slot, in the vertex shader, read off the same
number the material indexes its roughness with. "The paint slot is tinted and nothing else is"
needs no set to maintain and cannot fall out of step with a slot added later. 59.2% of a traffic
car's vertices escape it.

It also makes the traffic car agree with the PLAYER'S car for the first time — the player's car is
not instanced, so its vertex colours were always absolute, and the two were authored within 5% of
each other all along (plate 0xdadfe2 both; lamp 0xf2f4f6 against 0xf7fafe). The multiply was the
whole difference and it was a factor of two nobody had put side by side.

**And it spends the argument both fleets used to justify an achromatic majority**: "there is no
per-instance escape from that inside one InstancedMesh; a fleet that is mostly achromatic is the
escape". There is one now and it costs no draw call, so the 84.6% achromatic share stays because
the census says so.

**The tone numbers are derived, not picked.** `tools/paint-tone.mjs` measures a white car against
a black one in ONE frame, ONE parked row, ONE light and ONE panel orientation, in linear light:

    open midday sun   white 0.5303  silver 0.3864  black 0.0313    white/black x16.9
    deep shade        white 0.1693                 black 0.0895    white/black x1.89

The two rows disagree by x9.0 and the difference is the light, not the cars. The shaded row is the
FLOOR (both subjects sit where every camera pipeline lifts shadows, and a lift compresses a ratio
toward 1); the sunlit row is the estimate. White is the anchor at 0.80, a real white car's
reflectance; black is DERIVED, 0.80 / 16.9 = 0.047. Silver is used for its ORDER only — metallic
flake lifts a silver car's photographed luminance well above its diffuse albedo, so its x12.3 is
not a reflectance ratio and nothing is fitted to it.

**A blind playtester, given the pair with the labels scrambled per hour, says MARKEDLY IMPROVED.**
That was the owner's question. They preferred the same build at both hours without knowing it was
the same build, and then determined the assignment from the data rather than from me: on a car
whose paint is byte-identical, the plate moves (x2.70 noon, x2.26 dusk), which no brightness,
exposure or registration change can fake. Cross-checked on an independent quantity — the grey
car's boot lid, after/before 0.652 at noon and 0.656 at dusk, **0.6% apart across two hours**.

Their evidence, in their order: the tone spread on one surface class goes **x3.75 -> x12.4**; the
per-car albedo multipliers span **x35.5 in both directions** (cars got darker AND lighter, so it
is a re-draw and not a shift); the plate goes **0.314 -> 1.244** of its own paint with a
byte-identical control car proving nothing else moved; and **0 clipped pixels** in either arm at
either hour. Only 2.59% of the noon frame and 1.48% of the dusk frame differ at all, and all of
it is cars plus two pedestrians who moved.

What a player registers at 50 km/h is **the tone and only the tone** — the parked rows go from one
pale mass to a mixed row. The plate and the tail lamps are a near-range win and much stronger at
dusk: a car stopped ahead of you at a light goes from a brown smear to two red lamps and a plate.

**And one player-facing COST, measured and worth owning:** dark cars at distance against shaded
tarmac are harder to pick out than pale ones were — the black car reads 0.15x the shaded lane
beside it and 0.075x sunlit tarmac. Never invisible, and it is traffic you notice later.

**The weakest remaining thing is the glazing, and this round made it conspicuous.** The panes are
untouched (rear window 0.0362 -> 0.0375 at noon, consistent with anti-aliasing on a box edge), so
lowering the paint under an unchanged pane inverts the relationship: glass over paint on the car
that became black goes **0.137 -> 1.76 at noon and 0.165 -> 1.83 at dusk**. The greenhouse is now
substantially brighter than the body under it. Real black cars do that and not by this much, and
CLAUDE.md already records the panes as 5-10x too dark at a modulation of 1.2-1.28 against a real
1.56-2.25. **#54/#92 arriving from the opposite side, and now the first thing to look at.**

Two more from the same reviewer, both open:

- **No car reads as a convincingly WHITE car.** The kerbside car is in the white band — its flank
  moves x2.62 at noon and x2.88 at dusk, which puts it in 0.73-0.87 — and still reads as light
  silver with a strong metallic gradient (flank p90/p10 = 2.70). White is 29.2% of the census and
  the frame does not show it. The term is the METALNESS, not the table: at 0.60 an albedo of 0.800
  realises 0.320 of diffuse and an F0 of 0.496. Do not reach for the lightness.
- **The headlamp lens is a flat panel** — p10 0.7753 / p50 0.7908 / p90 0.8002, a x1.03 span across
  the whole lens — and it is now the brightest element on a black car, so it is the first thing
  that will look cheap at a closer framing than this one.
- **The plate cannot win on a white car, by construction.** Authored 0.7317 against a white body
  authored 0.730-0.870. The de-tint takes it from "tinted by the body" to "the same value as the
  body": an improvement in hue and none in contrast. (Arithmetic, not measurement.)

**And the black family had no internal variety, which the BRDF fix had just made worse.** The
census family is "black, charcoal and any dark body", and a range topping out at 0.054 contains no
charcoal at all — with w = 0.419, two cars in five got the same near-black and the reviewer saw
three parked cars merge into one dark mass. Black is 0.040..0.080 now; the measured ratio pins
where a TRUE black sits (0.047, 18% up the range) rather than the median, and the median ratio is
restated at x13.3. A x2.75 hole remains between 0.080 and silver's 0.220, where real dark greys
and gunmetals live, and closing it needs a census that can separate dark grey from black — which
this one explicitly cannot.

**I edited the tree while both reviewers were measuring it**, which is CLAUDE.md's own rule and the
second time this session has had to record it. The code reviewer's source reads and the playtester's
`src/carpaint.js` reads were against a moving target; both said so, and both sets of frame
measurements are unaffected because the PNGs are static. Copy the checkout next time.

**A blind review found eight things and five were real.** What it cost and what it bought:

- **The lamp-spill mechanism I wrote down was false, in four places.** `carGlowMaterial()` returns
  a bare `MeshBasicMaterial` and `patchLensFalloff` is applied only inside `carSurfaceMaterial`,
  so the spill is immune because its material was never a candidate — not because its vertices are
  all slot 0. Corrected in `src/carbody.js`, in `paint-census`'s own message and in two
  `mutation-sweep` rows. The slot census is kept, labelled as the CONDITIONAL it is.
- **"A measured ratio is a floor" was overreach.** A lift compresses a ratio and a TOE or an
  S-curve EXPANDS it — a true x16 reads x66.7 through smoothstep. So the tone-curve leg bounds
  nothing; only the additive leg (glare, sheen, ambient) does, by 5-23%. What makes x16.9
  believable is that published white/black automotive paint is x12.5 to x21 — two independent
  lines on ~16. `paint-tone --selftest` proves both directions now.
- **Black's floor was under the BRDF's dielectric crossing.** Slot 0 is metalness 0.60, so
  `F0 = 0.016 + 0.6a` crosses the plain dielectric 0.04 at exactly a = 0.040, and the table ran to
  0.032. The bottom 27% of the black range had less sheen than glass. Floor is the crossing now;
  the median stays at the measured 0.047.
- **Three checks that could not fail**, all written in the same round as the code they guard: four
  literals against two consts in the same file; a KNOWN-BAD testing one of the two fleets it
  named; and a check guaranteed by the function under test. First deleted, second split in two,
  third kept and labelled.
- **A mutation nothing catches.** Swapping `mix`'s first two arguments inverts the rule and passes
  every regex, all 70 boot-check checks and all 65 traffic-selftest checks. In the table as
  `tint-invert` with its `why` saying so: catching it needs a rendered sample of a plate against
  its own paint, which only works on committed PNGs today.

**And one consequence nothing in the round had stated: the record is now incomparable.** Replaying
the fleet car for car, 17 of 30 move by more than 2x (8 darker, 9 brighter, range x0.08 to x2.14).
`car-pane` measures glass over the paint ON THE SAME CAR, so every glazing figure in CLAUDE.md —
side glass 0.2506, modulation 5.295, ceiling 1.327, windscreen 0.0201, backlight 0.0321 — has a
denominator that just moved. No gate breaks; a re-capture at the same camera cannot be compared
with those numbers.

**Not yet answered, and it needs a camera and not an instrument.** The render's white/black ratio
against the photographs' x16.9. Five Points holds no parked black car: the two parked achromatic
cars in frame read 0.6909 and 0.2637, which is a white against a mid grey (x2.62), and the black
cars visible are moving ones that shift up to 5 m in the 0.5 s between arms. The albedo ratio is
17.0 by construction and the RENDERED one must be smaller, because ambient fill lifts the dark
car. How much smaller is open.

**Still open, deliberately.** The CHROMATIC lightness did not move — one term at a time — and
measuring it turned up that the two fleets have always disagreed about it (0.34..0.60 in
`traffic.js`, 0.26..0.66 in `streetfurniture.js`) with nobody having put the two side by side.
`paint-tone` prints both so the next round can settle it on purpose. A red car's rendered luma is
within about x1.5 of plausible, so it is small.

### #92 FIXED (the level), and the remaining half is named: uGlassEnvExtra 2 -> 5
`src/carbody.js`'s glazing environment gain is 5 now, DERIVED from two measurements rather than
picked: the census band (0.137-0.333, median 0.164) and the `ge*` sweep of this very constant
(windscreen median/paint at noon: 0.0167 / 0.0368 / 0.0619 / 0.0916 / 0.1616 at extra 0/1/2/3/5).
5 is the value INSIDE the swept range whose windscreen lands on the band's median — not an
extrapolation — and `glass-census` asserts that relation, so the constant cannot drift: setting it
back to 2 fails the gate, because ge2's measured 0.0619 is below the 0.137 floor.

2 was not wrong so much as unfinished. The round that added the knob swept it and shipped 2 while
correctly concluding the rest was the environment; what it did not have was a TARGET, so nothing
could tell 2 from 5.

**What this does not fix, and the same sweep says so:** MODULATION. 1.284 at extra 2 and 1.269 at
extra 5, against real glass at 1.56-2.25. A gain multiplies the whole pane, so it turns a flat dark
pane into a flat brighter one — "a level knob cannot put content in a window", which that earlier
round wrote down and this change does not contradict. Still open, and it is #54's lit shopfronts
reaching the environment; a sky-only PMREM has no structure to give. At night the windscreen moves
0.0078 -> 0.0156 of the paint: still a hole, same reason.

### #92 (the investigation that got there) The side glass is within 8.6% of the paint at noon
Measured on the pane's own projection, glass over the door skin beside it: 0.934 / 0.837 /
0.972 / 1.043 after the pane fix. #54 records the opposite extreme at night (0.0225 in linear
light) and #36 the hue problem. The glazing is wrong at both ends of the day.

**The target, measured off `reference/sarasota/mapillary` as this entry asked.**
`tools/glass-census.mjs` samples a box on the side glass and a box on the door skin beside it on
the same car in the same frame, in LINEAR light:

    fusion-silver   0.137      rejected: suburban-white, 76% of the paint box clipped
    lexus-white     0.164                prius-white, paint spread 1.82 and a ratio of 1.254
    atlas-silver    0.333
    median          0.164      range 0.137 .. 0.333

So a real window is **a sixth of the paint beside it**, and the shipped car is at 0.914-1.043 —
a factor of about six. **And a window is a RANGE, not a number**: the widest accepted window
spans 0% to 56% of its own paint across its own area, because one pane carries a sky reflection,
the interior behind it and a near-black patch at once. The shipped pane is near-constant, which
is a second defect the single-number framing hides.

Two cautions on the number. The camera's tone curve is not exactly sRGB, so linearising leaves a
residual — the claim the gate makes is "well under half", not "0.164 exactly". And Florida cars
often carry aftermarket tint, which would bias the target dark; the 0.137-0.333 spread is wide
enough that it is not one tint level, but a bigger sample would narrow it.

**And the isolation changes the finding: the glazing is wrong in OPPOSITE DIRECTIONS on
different panes, which one number was hiding.** `tools/car-pane.mjs` measures the windscreen and
the backlight with fixed, reviewer-vetted boxes against paint on the same car in the same frame,
and the shipped build reads:

    pane          noon (1-shell / 3-shell)    night            against a target of 0.137-0.333
    windscreen      0.0201 / 0.0167           0.0039 / 0.0037        5 to 10x TOO DARK
    backlight       0.0321 / 0.0320           0.0061 / 0.0043        5x TOO DARK

So the two panes with reviewer-vetted boxes are a long way UNDER the target, not over it. The
0.914-1.043 in this entry is the SIDE pane, measured by the #56 round through a
geometry-following projection rather than a fixed box — a different pane, measured a different
way, and not re-measured here. Both can be true, and if they are then one material is producing
a 5-10x deficit on two panes and a 5.6x excess on a third.

**Which is the isolation, and it rules the material out.** A material change moves every pane
together — they share palette slot 10 — so it cannot close a deficit and an excess at once. The
geometry says the same thing from the other side: off the built buffer, the windscreen and
backlight normals sit 62.3 deg from horizontal and the side pane's 21.8 deg, with shading normals
tracking face normals to within 0.4 deg on the coupe, so there is no smoothing artefact to blame.

**DONE, and the premise does not survive it.** `car-pane` gained a `sideGlass` pane — a box on
the near car's side window with the door skin below it as paint, in the same frame as the other
two — and real windows were re-measured in the SAME statistic. All three panes and the reference,
at noon:

                        med/paint    modulation (p95/p50)   ceiling (p95/paint)
    real cars          0.137-0.333        1.56 - 2.25           0.257 - 0.583
    shipped side glass    0.2506             5.295                 1.327
    shipped windscreen    0.0201             1.276                 0.026
    shipped backlight     0.0321             1.195                 0.038

**The side glass's MEDIAN is 0.2506 — inside the band real cars occupy.** "Within 8.6% of the
paint" is not this pane's median; 0.914-1.043 is its BRIGHT END, and at a modulation of 5.295 the
p95 is 1.327 of the paint. Both figures are true of one pane and they are different statistics,
which is exactly the floor/ceiling split `car-pane`'s own header exists to enforce.

So #92 restates into two defects, neither of which is the one it was filed as:

- **The side pane's CEILING runs away.** 1.327 against a real 0.257-0.583 — its top edge is
  brighter than the body it is set in, which is what reviewers reported as "body-coloured sheet
  metal with no window". Its median is fine.
- **The windscreen and backlight are too dark AND too flat.** 0.02-0.03 against 0.137-0.333, at a
  modulation of 1.2-1.28 against a real 1.56-2.25. A dark panel, not a window.

A window is therefore not simply "dark": it is dark with a BOUNDED amount of life in it, and the
shipped panes miss that band on both sides. Any fix has to move three numbers per pane, not one.

Two things found on the way, both recorded in the tools. `car-pane`'s `r1QuarterControl` is a
documented negative control — glass in a 1-shell frame (0.357), body panel in a 3-shell one
(1.350) — and reading it as glass would have "confirmed" the old figure off a box that is not on
glass. And the new `sideGlass` box has the SAME problem one pane forward: annotated crops show it
inside the glass on `cumS1` and almost entirely on BODY PANEL on `cumS3`, where the near car is a
different shell with a shorter greenhouse. It carries an `onlyTags` scope and the runner skips the
arms it is not valid for, with a printed reason.

### THE LEVER, isolated against two sweeps that were already captured and never read this way

Both sweeps exist in `docs/shots` and needed no new capture — `ga*` scales the glazing albedo at
fixed metalness, `ge*` scales the glazing's own environment gain. Measured with `car-pane`:

**The albedo is nearly exhausted.** Windscreen median/paint at noon, over the whole albedo range:

    gaShip x1   0.0167      gaA014 x0.14  0.0135
    gaA033 x0.33 0.0145     gaA000 x0.00  0.0127

Zeroing the albedo ENTIRELY moves it by 0.0040 — **76% of the pane is already the environment
reflection**, present with no albedo at all. Reaching 0.164 on the diffuse term alone would need
roughly x37, a linear albedo near 0.19, which is a frosted panel and not glass. That is the case
`src/carbody.js`'s own slot-10 comment predicted: "no albedo setting fixes it".

**The environment gain IS the lever, and it reaches the band.** Same pane, same statistic:

    carGlassEnv      0       1       2       3       5
    windscreen    0.0167  0.0368  0.0619  0.0916  0.1616
    backlight     0.0320  0.0728  0.1217  0.1767  0.2946
    modulation     1.207   1.257   1.284   1.275   1.269

Monotonic, near-linear, x9.7 on the windscreen across the range, and **ge5 lands the windscreen on
0.1616 against a target median of 0.164**. It is per-slot (`ENV_GAIN_SLOTS` is the glazing alone),
so it does not touch the paint.

**But it does not fix the other half, and the sweep says so plainly: the modulation does not
move.** 1.207 to 1.269 on the windscreen and 1.056 to 1.033 on the backlight, against real glass
at 1.56-2.25. A gain multiplies the whole pane, so it lifts a flat pane to a brighter flat pane. A
window that reads as a window needs STRUCTURE in what it reflects, which is the same conclusion
`carbody.js` reached by a different route — "the lit shopfronts reaching the environment, which a
sky-only PMREM cannot carry".

**THE TENSION I RECORDED HERE DISSOLVED WHEN THE MISSING REFERENCE WAS MEASURED, and the error
was mine in the way this entry keeps producing.** I wrote that the side pane's ceiling of 1.327
"runs away" and that a uniform gain would push it out of band — comparing a pane seen at a GRAZING
angle against a reference measured FACE-ON. A real windscreen seen off its normal in midday sun is
mirror-bright: 29% of its glass box is clipped at 255 while its own sunlit white bonnet clips 0%,
so over much of its area it is at least as bright as the brightest paint on the car, and its
ceiling is at least 3.538 of the paint.

    ceiling (p95/paint)       real side glass, face-on     0.257 - 0.583
                              real windscreen, off-normal    >= 3.538
                              shipped side pane, grazing        1.327

So the shipped side pane's ceiling is well UNDER what a real pane reaches at that geometry, not
over it. **Every shipped pane is too dark at every geometry that has a matched reference, and a
uniform environment gain is the right lever after all.** The "three panes, one knob" problem was an
artefact of comparing two different incidences — the same mistake as quoting a pane ratio without
naming the pane, one level down.

That windscreen cannot be given a median ratio at all: there is no box on it that does not clip,
which is why `glass-census` refuses the row and asserts the clipping ASYMMETRY instead. It bounds
the direction without inventing a precision the sensor cannot give.

Also: the absolute level of the `ge` sweep does not match the shipped `cum` frames — ge0 reads
0.0167 where `cumS1-r9cum` reads 0.0201 — because the sweep's base holds other car terms off. The
sweep gives the SLOPE reliably; the shipped operating point has to be read off the shipped build.

### #91 FIXED — the target is a table with a source now, which is what was actually missing
Both modules' comments were right about the reference and neither had a DISTRIBUTION or a SOURCE,
so there was nothing for the code to be wrong against. `reference/sarasota/car-colour-census.json`
is the source: 65 vehicles over 11 panoramas of the corridor, 2024 capture, greedily subsampled so
no two frames are within 45 m, classified into seven coarse high-contrast families. It carries its
own method and its own biases.

    achromatic  55  84.6%      red    5   50% of the chromatic set
    chromatic   10  15.4%      blue   4   40%
                               beige  1   10%
                               green  0    0%
    cyan, violet, magenta, pink, yellow, orange — 0 of 65

**The zeros are the finding.** By the rule of three an unobserved family has a 95% upper bound of
3/65 = 4.6% of all cars. The shipped wheel gave green 28.0% x 34.3% = 9.6% of all cars, 2.1x that
bound, and spent 48% of its chromatic third in bands the census never saw once.

`src/carpaint.js` is the one table both fleets draw from — the pair that has now had the same
defect twice, so it is a shared module rather than two patches. Weights: red 42%, blue 36%,
beige 14%, green 8%, with a per-family saturation scale so beige is not a saturated orange.

Two things the census does NOT say, and the table respects both. It does not say the chromatic
share is 15.4% — that is a LOWER bound, because dark red and navy read as black in bright sun and
only confident calls were counted, so the 0.66 achromatic split is untouched. And it does not say
green is impossible: zero of 65 is "rare", not "absent", so green keeps 8% of the chromatic third
= 2.7% of all cars, under the bound its own source supports. Deleting it would be over-fitting a
sample of ten chromatic cars.

**The draw count is unchanged and gated.** The family AND the hue within it both come out of the
first draw, so the chromatic branch still takes exactly two numbers from the stream `_chooseNext`
shares. `tools/paint-census.mjs` counts the `this._r()` calls in the shipped block rather than in
a copy, and `mutation-sweep`'s `paint-draw` row adds a third draw to prove the gate has teeth.

Still open from the same area: nothing here touches **#92** (the glazing) or **#1** (instanceColor
capping the light details), and the achromatic/chromatic split remains at its authored 0.66
because the instrument that would move it cannot resolve the quantity.

### #54 Traffic-car greenhouse is a hole at night: glass/paint 0.0225 in linear light
`detail lost` beyond the subject line. Related to #92 and #36.

### #36 Glass reads blue at noon again, because it now correctly reflects our very blue sky
`detail lost` beyond the subject line.

---

## Missions and driving — playtest round 8

### The flagship's chase stage is LOST by obeying the HUD and WON by ignoring it — FIXED
Fixed in the commit that removed `ambush`'s marker. The root was that a GATE RULE put each of
three wrong markers on that one stage, so the property moved into `src/mission.js`'s
`defineMission`, where it is an authoring error a later round cannot satisfy sideways: a stage
posting a `marker` must carry a `reach` trigger and the marker must lie inside its radius. Five
gate rules in this tree had baked the marker in and all five are restated. What the player gets
instead was already on screen and is measured: `EVADING 16s` in the wanted strip and two `enemy`
blips at 128 m and 265 m. The original record follows.

### The flagship's chase stage is LOST by obeying the HUD and WON by ignoring it
Two arms, identical entry into `marlin-street`'s `ambush` stage at t=50.8 s, 2 stars,
empty world so only the mission and the police are in play. Byte-identical on a re-run.

    obey the arrow   drove to the marker it points at and stopped
                     -> arrow 1 m, arrested 88 s in, MISSION ABORTED at 142.4 s, 3 of 6 stages
    ignore it        drove away at 40 km/h
                     -> `evaded` fired, stage advanced, MISSION PASSED at 273.7 s, 4 stages

`src/missions.js` gives `ambush` a `marker` and **no reach trigger**; its only exit is
`{ all: [timer 2 s, evaded] }`. So the one navigational cue on screen points at a spot
where nothing happens, and arriving there and stopping is exactly how you get arrested at
the 2 stars the stage's own `onEnter: { setWanted: 2 }` just gave you. The arrow and the
subtitle give opposite instructions.

**Third instance of the family CLAUDE.md records twice** under "A marker rule produced the
defect it did not forbid". Both recorded instances were about WHERE a marker sits. This one
is that a **flee** stage has a destination marker at all. The property to assert is not
another rule about marker placement: *a stage whose exit condition is not positional must
not post a positional cue.*

### You cannot drive through this city without running people over — FIXED for a car on the road
Three causes, each measured and each fixed. The headline: **a car wholly inside its own
carriageway now hits nobody — 1.70 /km before (16 of 31 contacts), 0.00 /km after (0 of 34)** over
~10 km with 64 peds and no traffic, five seeds.

    the whole crowd's clearance beyond the kerb   p01  -2.47 m -> -0.00 m
    on streets <= 3.3 m wide                      p05  -0.69 m -> -0.00 m
    deepest ped inside a carriageway, 48-crowd         0.5878 m -> 0.0000 m
    baked pavement points inside a carriageway        35.30% -> 0.00%

1. **THE PAVEMENTS WERE IN THE ROADS.** A walk is offset from its OWN edge and `_blockedFraction`
   checked it against buildings only, so 2,302 of 6,521 baked points lay inside some carriageway,
   2,296 of them a NEIGHBOURING street's — a 2.8 m alley's pavement ran down the middle of a
   13.2 m tertiary road. Rejecting those is the obvious fix and costs 84% of the network (300 of
   1,870 survive at zero tolerance); the intrusion is 75.8% END-ONLY, so trimming both ends
   removes 7.55 km of 88.23 and keeps 1,631 of 1,870 pavements.
2. **THE CORNER HANDOVER WALKED THEM ACROSS JUNCTIONS.** With (1) fixed, every remaining in-road
   contact was at walk node 0. A detour waypoint at the intersection of the two pavement lines
   routes them round.
3. **SEPARATION PUSHED THEM IN AND NOTHING PUSHED BACK.** `_laneOf` points away from the road and
   `_pushOut` covers the building side; neither covers the crowd shoving somebody sideways.

**The total rate did not move (3.29 -> 3.26 /km), and that is the instrument.** Every remaining
contact has the car straddling or beyond the kerb — the follower CLAUDE.md already records driving
into buildings at 3.3/km with zero traffic and zero pedestrians. So the rate cannot judge this
fix and the in-lane split can. Still open: the autopilot's own lane-keeping (#84/#87), and a 2.8 m
alley has no room for a 1.9 m car and a pavement.

Four things my own work got wrong on the way, all measured and recorded in the source: the road
test first went into `_blockedFraction`, where a wall-clip tolerance rejected what the trim should
fix (1,102 baked against 1,721 predicted); the push's `BUILDING_MARGIN` standoff WAS its
displacement, a 0.29 m hop on 2.7% of ped-frames; halving the walk speed on each such push took a
kerb-walking ped under the stuck threshold in four frames and despawned 50 in 90 s; and the push
resolved one kerb, so a junction left peds 0.59 m inside the crossing street. The original record
follows.

### You cannot drive through this city without running people over
24 autopilot legs, 12.91 km, traffic 0 so pedestrians are isolated, on the lane the game
draws:

    peds 64   53 struck, 11 killed, 21 hit-and-run charges   4.11 /km
    peds  0   0 struck over the identical 12.91 km           0.00 /km   <- control
    speed caps 10 / 20 / 35 km/h -> 3.25 / 4.65 / 4.42 /km   flat over 3.5x

Flat across the speed range, so it is not a speed problem. The bodies land **2.28–3.09 m**
from the route centreline while the car is 0.66–1.95 m off it — they are in the
carriageway. And they do not yield: held a dead-straight line at 11 km/h, a pedestrian
entered at bearing −0.34 / 17.7 m and the bearing NARROWED to −0.24 as range fell to 8.1 m.
8.5 s of warning, 8 people in the windscreen, knocked down without steering.

The cost of care, one 495 m leg hand-driven on `look()` alone:

    35 km/h cap                    515 m in  54 s, 1 hit
    16 km/h cap                    500 m in 110 s, 1 hit
    stop for anyone <20 m      307 of 495 m in 400 s, 0 hits, 328 s stationary
    stop for anyone <35 m          151 m in 400 s, 0 hits, 376 s stationary

**The only two options on that street are "run somebody over" or "don't arrive."**
Distinct from the known 3.3/km item, which is the follower hitting BUILDINGS.

### A live scene takes the objective band and nothing below it can ever show — FIXED
A scene is now discharged `LAW_NOTICE_S` (4 s) after the player stops at it, which is already
this file's answer to "how long does a law line stay on screen after the thing it reports".
Measured, 600 s parked at a scene:

    band from `law`     600.0 s -> 4.52 s   (0.50 telling + 4.02 acknowledging)
    band from `mission`   0.0 s -> 595.5 s
    distinct lines            1 -> 3        instruction, acknowledgement, what was below

Nothing about the crime moved, which is what made it safe to isolate: `cooperated` is latched on
the stop and its own comment already said it outlives the scene, and the leave branch only files
`hitAndRun` when the driver did NOT stop. Five arms confirm it — a driver who never stops is still
charged (fled 1, cooperated false), every stopping arm files nothing.

Two things my own gates got wrong on the way, both worth keeping: wanted-test §23(f) had been
sampling ONE point inside the window (180 frames at a local `DT = 1/60` is 3 s against a 4 s
constant — it would have failed at the file's outer `DT = 1/30`), and the first version of the
hud-cue bound capped the whole `law` occupancy, failing by 0.45 s because `_trackVelocity` smooths
towards the true speed so a car arriving at 20 m/s is TOLD to stop for ln(20)/6 = 0.50 s before it
is acknowledged as stopped. Only the acknowledgement is bounded now. Also noted: `_watchScene`'s
leave-branch early-return is now reachable only above `SCENE_LEAVE_M / LAW_NOTICE_S` = 21.25 m/s,
so the gate drives it at 29.75. The original record follows.

### A live scene takes the objective band and nothing below it can ever show
600 s parked beside a casualty 30 m from a job marker: the band showed ONE line,
`STOPPED AT THE SCENE / an arrest will not cost the job`, until an arrest broke it. In
another run that line held 360 s at 5 stars with no mission, distinct-line count over 240 s
of it exactly 1. `BAND_ORDER` puts `offer` last and `mission` below `law`, and `_watchScene`
clears `_scene` only when the player moves beyond `SCENE_LEAVE_M` (85 m) — stopping inside
it sets `stopped = true` with no timeout. One clipped pedestrian plus a stop hides the
mission objective, the completion line and every job offer until you drive 85 m.

### Being jammed has no cue, and the out is the control a player will not try — FIXED
`src/vehicle.js` now owns a jam detector and `composeStuck`, and `THE CAR IS WEDGED / reverse` is
a band tenant between `law` and `mission`. Measured at a real pin found by gridding the shipped
district — 388 candidate pockets, 5 real pins:

    (132.89, 221.48)   forward 0.183 m over 10 s, 94 contacts/s, reverse 28.7 m
    the playtester's   forward 0.34 m over 30 s, ~96 contacts/s, reverse 145.15 m

On the page: `stuckFor 4.05 s`, 473 contacts, 0 wrecks, and the DOM reads
`"THE CAR IS WEDGED" / "reverse"`.

Three derivations, each with its sweep. The throttle threshold is 0.5 and NOT `composeLaw`'s
0.05, because at 0.05 a legitimate crawl away spends 4.633 s under the stop threshold — longer
than the 4 s dwell, so the bust's constant would fire the cue on a careful driver. The dwell is
the same beat `BUST_HOLD_S` and `WRECK_HOLD_S` are, x10 of the 0.400 s worst pull-away at its own
throttle threshold. And the contact grace is `district/main.js`'s own dt clamp of 0.05 s, because
a wedged car is contact-free on 23.0% of steps with a worst gap of 0.0333 s — the first version
reset on any contact-free step and the cue NEVER FIRED.

Still open from #85/#89: a nose-in crash is both the crime and the immobilisation, and beyond the
pursuit's reach it is total immunity. The original record follows.

### Being jammed has no cue, and the out is the control a player will not try
Five identical rebuilds of one pin, 30 s each: full throttle forward **0.34 m**; full
reverse **145.15 m**. 34,296 wall contacts over 360 s of which 34,295 charged nothing, so
the car presses a wall at ~96 contacts/s for free. Engine power 0.46 — not powerless, just
pointed at a wall. The game does have the words: `composeLaw`'s `bustStuck` branch prints
"BUSTED IN — 4 s / reverse", the only place reverse is ever suggested, and it appears only
once an arrest is already running. Refines the known "pinned car rocks and the HUD says
nothing": the magnitude is 0.34 m against 145 m and the fix exists one tenant away.

### Smaller, from the same round — ALL SIX FIXED
- **The author's note as the game's first words** — `shakedown`'s `brief` now reads "Easy money.
  Two markers by the bayfront, a few hundred metres apart." and `mission-test` gates every
  player-facing mission string against twelve build-vocabulary terms, with the shipped line as its
  known-bad.
- **"watch the stars drop"** — fixed with the ambush marker; the subtitle names `EVADING`, the word
  `composeWanted` actually prints, read off that module rather than spelled again.
- **Two disagreeing distances** — the gap was exactly the reach radius at every range, 23.5-24.0 m
  against a declared 24. `MissionRunner.hud()` publishes the radius and the minimap draws the ZONE,
  so "0 m" is the moment the player is inside a circle they can see. Gated in `hud-cue` as an arc of
  the waypoint's own radius in pixels — a blip is 4.4-6 px, the ring is 25.3.
- **`shakedown`'s one-frame first stage** — the stage stays (on foot it is real, and `b`'s `onFoot`
  trigger routes back to it) and it gains a subtitle that is a SENTENCE OF THE BRIEF, which
  `mission-test` required and refused the first attempt at.
- **`MISSION FAILED` never read when the car is wrecked** — measured at 1.9 s of a 6 s hold, not
  never: the wreck line ate 4 s of it. The hold is now spent only on frames where `ended` wins the
  band, in both hosts: 1.9 s -> 5.9 s.
- **No repair short of a write-off** — FIXED, by the option the owner picked of the three:
  a garage you drive to, at **(-67.9, 60.3)**, 0.00 m off the centreline of a 6 m street and
  routable from the spawn in 44 route points over 340 m. Stop in the 12 m zone with a damaged
  car and it repairs after a 4 s hold; the three constants are `OFFER_RADIUS_M`, `BUST_HOLD_S`
  and `SCENE_STOP_MS`, passed in by the host from the modules that own them.

  Measured end to end, driving in from 15.7 m out: health **0.727 -> 1.000 at t=8.3 s** after
  12.2 m, with the band reading `GARAGE / stop here` then `REPAIRING — 4 s` counting to 1. It
  refuses a wanted car (4* for 10 s -> 0 repairs, "not while they are looking") and a moving one
  (5.75 s inside the zone at 2.45-5.78 m/s -> 0 repairs).

  Three things it turned up, all in the instruments rather than the feature. `MARKER_STYLE.shop`
  had sat in `src/hud.js` since the file was written with nothing ever posting one — the third
  style in that position after `vehicle`. `playtest`'s `look()` had no garage blip either, so a
  playtester navigating by it could not have found the garage. And **the garage's dwell was the
  third hold in `district/main.js` to be written into the HUD block instead of the sim loop**,
  which is the defect CLAUDE.md records for `bustWatch` and `wreckWatch`: under `?timeScale=40`
  a 4 s repair would have taken 160 s of simulated time. `playtest` had it in the right place, so
  no offline gate disagreed with the page — `boot-check` reads the dwell against the sim clock for
  exactly that reason.

### Smaller, from the same round — the original record
- **The first words of the game are a note to its own author**: the offer band reads
  `SHAKEDOWN / Two markers by the bayfront. Exists so the wiring can be checked in a
  minute. — 30 m`. That is `brief` in `src/missions.js`.
- **"watch the stars drop" names a cue that never fires.** 109 s of fleeing at 40 km/h:
  stars read 2 at every sample, `evade` 0.00 at 5 of 6; the count went 2 -> 0 in one step
  at the stage transition, after the stage was already won. `wantedNote` does change
  usefully (SEEN -> EVADING 11s -> SEEN -> REPORTED); the stars do not.
- **Two disagreeing distances for one objective**: `— 42 m` in words with the arrow at
  66 m. 66 − 24 (the trigger radius) = 42. The words count to the zone edge, the arrow to
  its centre; the words read "— 0 m" while the blip is still 24–30 m ahead.
- **`shakedown`'s first objective is "GET IN THE CAR" when you start it by driving in** —
  stage `a`'s only exit is `inVehicle`, already true, so it lasts one frame.
  `marlin-street`'s `toCar` has a long comment about this exact defect and works around it;
  `shakedown` never got that fix.
- **No repair short of a write-off.** 55 km/h into a wall -> health 0.39, still 0.39 after
  300 s parked. The only routes back to 1.00 are being wrecked or arrested, so the fastest
  way to fix a damaged car is to destroy it. (FIXED — see the garage above.)
- **Braking for traffic caused more collisions than ignoring it.** Flat out at 40 km/h
  ignoring traffic: 0 rams, 519 m, 48 s. Lifting off for any car within 25 m: 6 rams,
  357 m, 300 s.
- **`MISSION FAILED` is never read when the car is wrecked** — `wreck` outranks `ended` and
  the wreck hold is 4 s against `_endFor`'s 6.

### What the same playtester said is good, and worth not breaking
The car. 0–50 in 3.09 s, 0–100 in 7.80 s, top 145.8 km/h, brakes 10.5–11.9 m/s², coasting
from 100 km/h takes 60 s. Damage grades cleanly: 20 km/h -> 0.94, 40 -> 0.67, 60 -> 0.21
with power 0.88 and smoke 0.83, 90 -> wrecked. The wreck->respawn loop and the arrest both
read well. `eastbound`'s band is the clearest instruction in the game.

## Crime, damage and the police

### THE POLICE CANNOT HOLD YOU OFF THE ROAD — FIXED
An arrest is made by a PERSON, so the reach is the officer's and not the car's:
`RUN_SPEED * BUST_HOLD_S` = 7.0 * 4.0 = **28.0 m**, derived from two constants the game already
declares, with the walk refusable by the real blocker index. `holdRadius` still decides where the
CAR stops; `reachRadius` decides whether an arrest can be made.

    nearest road edge   arrestable BEFORE   AFTER      (longest contiguous hold vs BUST_HOLD_S)
    0 - 8.75 m                7/8            7/8
    8.75 - 16 m               0/8            8/8
    16 - 28 m                 0/8            6/8
    beyond 28 m               0/8            0/8       <- the stated design limit, both arms

End to end at 14.15 m off a road, four stars, on the brake: **0 busts in 200 s -> arrested at
7.3 s**. On-road is byte-identical between the arms (51.6% held, longest 4.00 s, bust at
t=7.8 s), which is what says the band widened rather than moved. The chase itself is unchanged:
spawns, lost, reroutes, deadEnds and minimum distance are byte-identical over three seeds, and
only 22 and 12 stopped unit-frames of 72,000 differ.

**The bound existed in THREE places and widening one did nothing a player could feel** —
`src/pursuit.js`, `district/main.js`'s frame loop and `tools/playtest.mjs` each re-tested the
held unit against the player with `holdRadius`. In that state `u.held` was true on 98.5% of
samples with a longest hold of 197.0 s and no arrest. All three now read the module. Still open
from this item: beyond 28 m it is immunity, which needs police who get out of the car. The
original record follows.

### THE POLICE CANNOT HOLD YOU OFF THE ROAD — playtest round 8, headline, verified
A blind playtester found it by playing: two arms off one seed, pedals and wheel only, no
teleports. Brake 5.4 m off the centreline and you are **busted in 11.0 s** with a unit
holding you on 41% of frames. Hold full lock for ~3 s first, stop 15.6 m off, and you get
**180.5 s on the brake at 4 stars with 0 busts**, held on 0% of frames. Reproduces
byte-identically across three runs. The arrest countdown can be killed mid-count: "BUSTED
IN — 4 s" was on screen, a touch of throttle and it was gone 1.75 s later.

**Mechanism, confirmed in the source.** `src/pursuit.js` holds on
`near.d <= this.holdRadius`, and `near` comes from `_closestOn`, which is the closest
approach of **the unit's own road edge to the player** — not the unit's distance to the
player. So the hold is a function of how far the PLAYER is from a road.

    holdRadius                  8.75 m   (widest edge 13.2 m / 2 + HALF_EXTENT.z)
    RESPONSE[].spotRadius   85..175 m   by star level

A 20x gap in radius, 400x in area, in which the police see you — which is what blocks the
evade timer — and can never touch you. `district/main.js` runs the identical check, so it
is not harness-only.

**Their exposure figure is wrong and the finding survives it.** They quoted 95.1% of road
positions, measured as room to park beyond 8.75 m before hitting GEOMETRY. The hold tests
distance to the nearest ROAD EDGE, and this is a dense network: measured on the pursuit
module alone, stepping off the widest edge's midpoint, units still held on 782-834 frames
of 1200 at 10, 12, 15 and 20 m, and only failed outright at 40 and 80 m. Gridding the
district at 4 m, against the real blocker index:

    clear of buildings                        107,958 of 130,620 grid points   82.7%
    ...and beyond the hold radius              70,908                          65.7% of clear
    ...and within 60 m of a road               34,559                          32.0% of clear

So **32%**, not 95% — still a third of the drivable, building-free area within a short
drive of a road, which is more than enough for a player to find by accident in their first
chase.

Not yet decided: whether the fix is letting a held unit leave its edge for the last few
metres, or letting line-of-sight at short range count as a hold. Either changes what
`pursuit-test` asserts, so restate its bounds in the same commit.


### #90 FIXED, and the diagnosis was half right: a second saturation was being blamed on the cap
The cap is a soft knee now — `src/wanted.js`'s `floorlessCharge`, `cap - (cap/2)^2 / raw` above
`k = cap/2` and linear below it, C1 at the join with no constant to tune. Strictly monotonic
everywhere, so no two severities ever charge the same, and asymptotic to the cap rather than
meeting it, which makes #80's invariant STRICT. On the pair the finding was about:

    22 vs 88 km/h into a car   clip 0.9854 / 1.0000   0.0146 apart
                               knee 0.7463 / 0.9400   0.1937 apart, x13.3

**But the flatness above 44.5 km/h is NOT the cap and no shape of cap can fix it.** `crimeScale`
is `severity / majorSeverity`, and `severityFor` clamps severity at 1 once the delta-v reaches
`killDv` — the right rule for DAMAGE, since one impact cannot cost more than the whole car — so
the scale reads **8.333 at 50, 60, 80, 110 and 140 km/h**, identically. Isolating one term at a
time:

    a wall           the knee bends at 20.5 km/h   the clip flattened from 28.5   the SCALE is flat from 44.5
    a civilian car   the knee bends at 16.5 km/h   the clip flattened from 22.5   the SCALE is flat from 44.5

So the knee recovers the band between the cap and the scale's own ceiling — 16 km/h wide for a
wall, 22 for a car, which is where ordinary street driving lives — and the finding's own headline
example at 88 km/h sits in the region only `severityFor` can reach. **That is a separate open
item: see #93 below.**

**One gameplay consequence, stated because it is visible.** A knee is asymptotic, so a SINGLE
110 km/h write-off into a building charges 0.9000 and reads **0 stars** where the clip charged
exactly 1.0000 and read 1. The argument for keeping it: `propertyDamage` has no `min`, which the
table says means "not on its own enough to make you wanted", and a ceiling set AT the lowest floor
granted precisely the star the missing floor denies — every floorless crime at high severity
landed on exactly one star whatever it was. It is not immunity, because offences stack: two
building hits are a star, and the 3,304 m drive that produced 11 of them reaches five either way.
The alternative is to give `propertyDamage` a `min`, which is retracted below for the same reason
it was retracted before: a floored crime is exempt from the cap and that re-creates #80's
inversion.

Also fixed in the same line: **`opts.scale` had no validation at all.** A NaN scale made `heat`
NaN and the meter then never rose again — `NaN >= 1` is false, so the player was immune for the
rest of the session with the HUD reading 0 stars and nothing in the console. A scale of −1 charged
0, a crime that makes you less wanted. Both are charged at the table value now and counted in
`stats.badScales`; `mutation-sweep`'s `scale-nan` and `scale-sign` are the two rows, the second
because a finite check alone does not cover the sign.

The offence floor is the BUILDINGS, not the driving: 3.3/km over 3,304 m with zero traffic and
zero pedestrians, 11 of 11 `propertyDamage` — the follower hitting buildings, #84/#87 territory,
and still open.

### #93 The crime scale inherits the damage model's clamp, so every crash over 44.5 km/h is one offence
Split out of #90, which was blaming this on the cap. `DamageModel._crimeScaleFor` returns
`severity / majorSeverity` and `severityFor` clamps severity at 1 at `killDv` (13.9 m/s), so the
crime scale saturates at `1 / 0.12 = 8.333` and a 50 km/h collision, an 88 and a 140 are the
same offence to `src/wanted.js`. The clamp is CORRECT where it is: health cannot drop more than
the whole car in one hit. What is wrong is reusing a damage-bounded quantity as a severity
report.

The lever is a crime scale that does not inherit the clamp — scaled off the raw delta-v ratio
rather than off clamped severity — and it is a bigger change than it looks: `crimeScale` appears
in damage-test, wanted-test §24, crash-test and boot-check's run-over arm, and every number in
all four moves. Needs #80's gate treatment, which means the sweep over speed has to come with it.

### #90 (original record) The cap flattens everything above one star
`FLOORLESS_CAP` is 1 and it CLIPS, so every floorless crime is flat from the scale at which
`heat * scale` first reaches 1 to the top of its range:

    brandish            flat over 80% of its severity range
    civilianCollision   76%
    reckless            70%
    propertyDamage      60%
    evading             20%

An 88 km/h head-on into an occupied car is flat against a collision at a quarter of that
severity. **The task's own earlier suggestion is retracted**: giving those crimes a `min`
removes them from the cap entirely and re-creates the inversion #80 fixed. The lever is the
SHAPE of the cap — a clip is the only saturation that produces a tie. A soft knee at k = 0.5*cap
leaves the linear region alone and bends only near the ceiling (unchanged below 0.5, 0.75 at raw
1.0, 0.90 at 2.5, 0.94 at 4.17). Needs #80's gate treatment: wanted-test §24 sweeps the
RELATION, and the same sweep must cover strict monotonicity in severity.

The offence floor is the BUILDINGS, not the driving: 3.3/km over 3,304 m with zero traffic and
zero pedestrians, 11 of 11 `propertyDamage`. That is the follower hitting buildings — #84/#87
territory — and the soft knee would not touch it, since those are all below the knee.

### #89 A nose-in crash is both the crime and the immobilisation, and reverse is the unstated out
Half open. Beyond the hold radius a nose-in crash is total IMMUNITY — 1 of 14 run-ups into walls
8-18 m off the road was ever arrested.

### #87 driveTo wrecks the car in 200 m: 13 civilianCollision in 32 s at 43 km/h
`detail lost` beyond the subject line.

### #85 A pinned car rocks 20 degrees back and forth for ever, and the HUD says nothing
`detail lost` beyond the subject line.

---

## Budget and rendering

### #75 The triangle warn is derivation (b), a headroom ratchet, and its own comment predicted this
`detail lost` beyond the subject line. The tree reads over its 830,000 warn; see CLAUDE.md on
why the magnitude is not a stable number across sessions.

### #64 Re-baseline the budget gate on the road course
`src/roadpath.js` is the real fix for the autopilot driving through a third of the city, and it
is not the gate's course yet, because changing what a gate measures needs a fresh baseline and
the triangle warn is unresolved.

### #42 Chunk stall: attributed and structurally improved, but the gate verdict is unresolved
`detail lost` beyond the subject line. `chunk stall ms` is unusable while anything else runs on
the box — see CLAUDE.md.

### #48 aoKernel 3: parked deliberately, needs a reviewer not a decision from me
`detail lost` beyond the subject line.
