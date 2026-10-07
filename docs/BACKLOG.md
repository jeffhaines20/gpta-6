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
are *markedly improved*". **ANSWERED: the question was re-put on the paint0/paint1 pair and the
blind critic said yes at both hours.** Two earlier blind reviewers had seen the #56 pair and
neither would use the phrase, both for the same reason: what separated those arms was a basic
feature present or absent on a subset of cars, not a refinement of how the street reads. That
regression was fixed (f95694d), the tone range and the plate tint landed together, and the
re-put question came back affirmative.

The list below is what those reviewers ranked ABOVE body-shell variety, independently, and it
is still the live queue — an affirmative answer on one pair is not a finished car. Item 2 is
closed and item 7's tone half is closed:

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

### #56 FIXED — per-shell body length, and the 0.289 m price was the wrong one for half the sites
Offline half landed (2aca6c5): three shells, length range 0.196 m, 1,050 triangles each.
Visual half run; it found and fixed a shipped regression (the shells' side windows were 95.1%
and 75.3% behind their own bodywork). The "markedly improved" question was re-put and the blind
critic answered yes at both hours.

Per-shell `CAR_LENGTH` now landed. `traffic.js` measures each shell's z extent off the geometry
it has just built — 4.493 / 4.635 / 4.689 — rather than carrying a table, so an overhang change
in `carbody.js` cannot drift it, and `tools/car-shapes.mjs` reads the same quantity the same way
off the same buffers. Six sites read it: the spawn-overlap refusal, `_exitBlocked`, the junction
queue, both junction gap scans and `_playerGap`.

**And the backlog's own 0.289 m was the wrong price for half of them.** It is the car-to-car
figure, where the subtraction removes a whole LEADER. `_playerGap` subtracts half of each body,
because `along` runs centre to centre and the player's half comes from `PLAYER_HALF_L` rather
than from the pool: the coupe gives 4.493/2 + 2.15 = 4.396 against the 4.4 it replaces, four
millimetres. So that site was under-modelled by 0.094 m and the car-to-car site by 0.289, and
quoting the second for both overstated the player-following case x3.1. `traffic-selftest` §10
asserts the two numbers apart for exactly that reason.

The seeded-stream perturbation the deferral was about was measured before and after and is
benign: car-frames 215,965 -> 215,959, **inside a building 0 -> 0**, overlap pair-frames 0 -> 0,
closest approach 4.1 -> 3.93 m. That is the opposite of the leader-term change recorded in
CLAUDE.md, which took the building check 0 -> 342 — because this one moves a threshold by
centimetres rather than changing which edges the fleet drives.

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

**FOLLOWED UP, and the glazing did not move — its denominator did.** The playtester's observation
was right and the diagnosis was not. Every glazing figure in this project is glass divided by the
paint on the SAME car, and the vendored shader says only the denominator carries the tone:
`material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor )` — `vColor` reaches
`diffuseColor` and nothing else, and the glazing is slot 10 at metalness 0.00. So **glass/paint is
1/tone of a material property**, always was, and the 0.137 -> 1.76 is the car having become black.

Three consequences, all now in `glass-census` (13 -> 16 checks):

- The census band is a **LIGHT-CAR band** — all six subjects are white or silver. A dark subject
  cannot be added without restating it; the gate asserts the families.
- `uGlassEnvExtra = 5` compared like against like **by luck**: the sweep's subject bonnet reads
  0.4760 linear (mean sRGB 174,180,190), measured back off the committed frames rather than
  restated — a light car. The constant stands and the qualifier is written down.
- A glazing figure needs the car's **TONE** quoted beside it, the way this project already learned
  it needs its PANE and its GEOMETRY. Three qualifiers, all learned the same way.

The direct test — a real BLACK car's glass over its own paint — was refused twice and recorded as
refusals: the black saloon is ~45 px wide so its screen/boot boundary is 2-3 px, and the black
pickup is in deep shade where its own paint reads p50 0.0006, the JPEG's dark floor.

**Still open:** re-deriving the constant for the new fleet needs a capture whose subject tone is
KNOWN, which `__district.setCarTone` makes possible and nothing does yet.

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

### #94 The chromatic third kept the band the census table replaced, in both fleets
Found by comparing the two numbers rather than by looking at either. The achromatic two thirds now
draw from `src/carpaint.js`'s census table and span **x21.75** (0.040..0.870). The chromatic third
spans **x1.76** in `traffic.js` and **x2.54** in `streetfurniture.js`:

    achromatic, from the census table   0.040 .. 0.870   x21.75
    chromatic, src/traffic.js           0.340 .. 0.600   x1.76
    chromatic, src/streetfurniture.js   0.260 .. 0.660   x2.54

**`traffic.js`'s 0.340..0.600 is byte-identical to the `0.34 + r * 0.26` the table replaced**, and
the identity was verified against `35b6267` — the commit that replaced it. So both `CHROMATIC_L`
constants are each module's own LEGACY ACHROMATIC band, left standing when the achromatic branch
moved out from under them. That is also why the two disagree: they were never a chromatic decision.

So the defect CLAUDE.md records as "the fleet has no white cars and no black ones — a span of x1.77
where a real white over a real black is about x17" is still true of a third of both fleets, in the
commit that fixed it for the other two thirds. There is no dark red, no navy and no dark green car.
The repo's recurring shape, in the branch next door to the one being fixed, by me, this session.

**The floor is derivable and the shape is not, which is why this is recorded rather than tuned.**
The BRDF crossing at `a = 0.040` applies to any car on this material — the paint slot is metalness
0.60, `F0 = 0.016 + 0.6a`, and below 0.040 a car gets less clearcoat sheen than a sheet of glass —
so the chromatic floor at 0.26-0.34 is six to eight times above a bound that is already measured.
What is NOT available is the distribution: the 65-vehicle census resolves FAMILY and says so in its
own file, not VALUE within a family, and a bright red at the white tone is pink rather than a light
red, so the achromatic table cannot simply be reused. Lowering the floor alone would change a third
of both fleets on the strength of a uniform distribution nobody measured.

What would close it: a value class per chromatic car off the same panoramas — the same method and
the same instrument that produced the family census, which that file's header shows is reliable at
this coarseness. Then `carpaint.js` gets a chromatic tone table the way it got an achromatic one,
one definition for both fleets instead of two legacy bands.

`paint-tone` prints the span comparison and the legacy identity on every run. It is deliberately
NOT a check: the honest bound needs the census above, and a check written now would assert a number
nobody measured, which is what that tool's own header is about.

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

## Playtest round 10 — two blind Opus playtesters, frozen copies at d042a45

Review A took missions, the garage and the wedged-car cue; review B the crime loop, the police and
driving. Separate trees nothing else was writing to. Both re-ran their load-bearing arms in fresh
processes and got byte-identical results; B recorded four reversals of its own readings, A one.
Reports at `/home/user/review-A/REPORT.md` and `/home/user/review-B/REPORT.md` — **in containers
that will be reclaimed**, so everything worth keeping is below.

### FIXED — being arrested satisfied "you got away" (A#2)
`evaded` tested `wantedStars <= 0 && wantedState === 'clear'` and `clear('busted')` sets both, so
an arrest flipped `ambush` to `drop` in the same frame as the bust. A's one-variable A/B: crime
first -> bust at 13.617 s -> stage flips; no crime -> bust at 14.600 s -> MISSION ABORTED. Obeying
"LOSE THEM" took 55.1 / 58.6 / 189.9 s over 3 of 5 seeds; crime-then-arrest 9.1 / 13.1 / 13.1 /
26.3 s over 4 of 4. See `src/wanted.js`'s `clearedBy` and `mission-test` §11.

### CONFIRMED BY A SECOND PROTOCOL — the arrest band (B#1, and #89 above)
B measured the same stalemate independently, 5 seeds a row, **driving** off-road as well as placing:

    off-road   arrested/5   escaped/5   stuck/5   nearest unit   seen%
      2.7 m        5            0          0          3 m        99
      8.7 m        5            0          0          9 m        99
     20.7 m        5            0          0         21 m        99
     32.6 m        0            0          5         33 m        94-99
     50.6 m        0            0          5         51 m        94-98
     80.6 m        0            0          5         81 m        91-97
    128.2 m        0            5          0        128 m         0-2

Two instruments at different levels, agreeing: my `arrest-band` placed one seed at nine distances
through the play harness, B drove five seeds to seven. **And B measured what I did not:** the band
objective is `null` for the whole 180 s, the escape clock RESETS 1-5 times over 240 s and the best
it ever reached was **4.7 s of the 34 s needed**, and the only cue is the star note cycling
`SEEN -> EVADING 34s -> EVADING 33s -> SEEN`, 21 distinct states in 180 s. So it is not merely
un-winnable, it is un-winnable with a countdown that visibly restarts and no objective text.

### #95 4.8 km/h of forward motion makes you permanently un-arrestable (B#2)
Worse than the band, because it needs no distance at all. At 4★ **2.7 m off a road** — the spot
that arrests a parked car in 9.6 s — driving a 25 m circle so position is held within 50 m:

    mean 2.8 km/h   ARRESTED 3/3   (9.6 / 9.5 / 6.8 s)
    mean 4.8, 5.8, 6.7, 8.6, 12.4, 19.9 km/h   0/3 arrested, free the full 150 s

None escaped either, so it is a second stalemate and a more comfortable one. The whole pursuit is
beaten at walking pace without leaving the block. **B reversed itself twice getting here** — a
straight-line throttle measured POSITION (the car drove 259 m away) and a full-lock circle capped
the car at 1.5-2.5 km/h, under the threshold; only steering from the car's own `R_min(v)` isolates
speed. The mechanism is `_watchBust` reading smoothed `playerVel` against `SCENE_STOP_MS` = 1.0 m/s
= 3.6 km/h, with the smoothing putting the real boundary near 4 km/h.

### #96 An arrest and a wreck are both a free full repair, and the garage is dominated (A#6, B#3)
Both reviewers, from opposite directions. B: car at health 0.511, 1★, stand still -> **health 1.000
in 17.1-22.1 s, 3 of 5 seeds**; three laps of crime -> stand still -> arrest gave 21.5 / 19.2 /
30.8 s, health 1.00 each time, no escalation. Arrest against wreck on the same mission: both abort,
both hold ~4 s, both return health 1.00 and 0 stars — and the wreck moves the car 25 m while the
arrest moves it **0 m**, so being arrested is marginally BETTER than being wrecked.

A priced the garage against destroying the car from one damage state: road distance to the garage
from 24 points spread over the district is min 190 / p25 395 / **median 576** / max 894 m, which is
18-68 s at 14 m/s plus the 4 s hold — **median ~49 s**, and one measured end to end was 55.4 s over
356 m. Destroying it: 8 points tried, 5 reached health 1.00 in **9.5 / 11.7 / 13.4 / 13.5 / 13.7 s,
median 13.4 s**, costing one `propertyDamage` and **0 stars**.

**13.4 s against 49 s — 3.7x, and never worse than the garage's best case.** The garage was built
so that destroying the car would not be the fastest repair (see above); measured, it is not
achieving that, and the arrest is a third route that is faster still and costs nothing.

Not fixed here because the cost is a DESIGN choice, not a derivation: there is no money system, so
the only currencies are time and wanted level. Recorded with both tables so the next round picks a
number against them rather than inventing one.

### #97 The escalation runs backwards at the top end (B#4)
13 controlled single impacts into a building, arrival speed measured: heat 0.1050 at 10 km/h rising
to **0.9000 from 44 km/h up**, and **stars 0 at every one of the 13** — including a 138 km/h
head-on that destroys the car. Two hits 3.04 s apart: heat 1.0320 = **1 star**; gaps 3.0-7.4 s all
give a star, 10.1 s does not.

So **two gentle taps costing 0.435 health earn a star and one car-destroying impact earns nothing.**
This is the soft knee's asymptote (recorded under #90 as "a 110 km/h write-off charges 0.9000 and
reads 0 stars") met from the outside, and B's pairing is what makes it indefensible rather than
merely odd. The lever is `propertyDamage`'s missing `min`, which #90 deliberately left alone.

**B's own reversal here is worth keeping:** its first arm hit the wall 8x at 20 km/h, read 0 stars
and heat decaying 0.5320 -> 0.0000, and it was about to file "buildings can never make you wanted".
The arm was reversing 25 m between hits, ~40 s, and `idleBleed` 0.09/s wins that race. **It is the
GAP that decides**, not the count.

### #98 RE-MEASURED — the crawl floor HOLDS, and the dip is the car undershooting it
The playtester's observation reproduces and their attribution does not. `roadpath.js`'s
`cornerSpeed()` floors the corner TARGET at 2.2 m/s and its comment calls the floor "not a fudge";
B measured the ACHIEVED speed at 101 of 601 frames under 1.0 m/s with a dead section reading
0,1,1,1,1 km/h. Those are two different quantities and only one of them is floored. Separated, over
10,800 frames of `followPath` from Five Points to the marina:

    targets under the 2.2 m/s crawl floor    0 of 10,800        the floor holds exactly
    achieved speed   min 0.01   p05 0.61   p50 19.99   max 21.12 m/s
    frames under 1.0 m/s                     8.4%
    worst CONTIGUOUS run under 1.0 m/s       3.38 s             against BUST_HOLD_S 4.0

So `cornerSpeed()` never asks for less than the crawl, and the car arrives slower than it was
asked to — a controller undershoot braking into a floored corner from 22 m/s, not a floor being
violated. **A module's own bookkeeping is not a measurement of the module**, and here the
bookkeeping was right.

Two consequences worth keeping apart:

- **The floor's stated PURPOSE is intact.** It exists so "a contact taken at the floor speed is
  free by construction", and a contact at 0.01 m/s is more free, not less. The undershoot is
  conservative for the thing the floor was derived for.
- **The bust interaction is real and marginal.** 3.38 s of continuous sub-1.0 m/s against a 4.0 s
  clock on this route; B measured 4 s on theirs, so it is route-dependent and sits either side of
  the threshold depending on which junction you take. My 8.4% against their 17% is the same
  phenomenon over a different course, not a disagreement.

Still open as a controller question — should the follower hold the crawl it asks for rather than
coasting under it — and NOT as the floor defect it was filed as. Note that #95's fix does not
close it: a car crawling through a junction is not receding from a parked unit either.

### #98 (original record) The game's own route follower hands a fleeing player to the police (B#5)
`followPath` leaving Five Points spends **101 of 601 frames (17%) under 1.0 m/s**, with a dead
section at t=11-15 s reading 0,1,1,1,1 km/h — **four continuous seconds against a `BUST_HOLD_S` of
4.0**. Identical at maxSpeed 20 and 30 m/s, so it is the geometry and not a cap. Fleeing at 4★ with
it: **arrested 2 of 3** (14.4 s / 21 m and 82.4 s / 771 m), escaped 1 of 3 — against parking out of
sight, which escaped **5 of 5** at 90.1 s. Driving away from the police is worse than parking.

### #99 The `law` tenant owns the headline during a mission, and on `ambush` it says the opposite (A#3)
Headline ownership while a stage was live, over two `shakedown` runs from the board with full crowd
and fleet (both PASSED, stage totals byte-identical): seed 1 mission 9.8 s / law 24.3 s, seed 5
9.4 / 24.7 — **law owns 71-72% of the first mission in the game.** Both runs knocked a pedestrian
down 4.2 s after the first objective appeared, driving the game's own route line at 15 m/s.

On the flagship it is worse than a share, it is a contradiction: parked on `ambush` at the 2 stars
the stage itself grants, with no crime, the band showed only `LOSE THEM` then `BUSTED IN — 4/3/2/1/0
s` and the mission was lost at **14.6 s**. `ambush` is the one stage with no waypoint, so stopping
to read the band is the natural move, and it is punished inside 15 s. In 3 of 5 flagship runs the
line read `STOP AT THE SCENE — 85 m` over `still on: LOSE THEM` for 6.43 / 8.32 / 14.00 s.

The `still on:` subtitle is doing the right thing. What inverts is the precedence, on the one stage
whose point is not to stop.

### #100 A player heading for the flagship is conscripted into the tutorial (A#1) — FIXED (the conscription half)
Reproduced geometrically at HEAD and it is worse than reported. **Both** mission offer centres sit
essentially ON a road centreline:

    marlin-street   0.22 m from a centreline, ring radius 12 m -> a car on it crosses 24.0 m of ring
    shakedown       0.01 m from a centreline, ring radius 12 m -> a car on it crosses 24.0 m of ring

A measured the consequence: `driveTo(flagship)` from the spawn arrived in 52.2 s over 454 m and
**`shakedown` started at t~13.75 s**; the same route passes 1.4 m from shakedown's first objective
marker, so on arrival at the flagship the player is on shakedown's FINAL stage reading `NOW THE
MARINA — 500 m`, pointing 539 m back. 3 of 8 compass routes 400 m out pass inside the ring. Parked
dead on the flagship marker, 3.2 m inside a 12 m ring, for 30 s: `offer: null`, nothing starts,
because offers are only evaluated when nothing is running.

**And there is no way out:** 300 s parked mid-mission leaves `outcome running`, and no `look()`
field matches /abort|decline|cancel|abandon/. Only complete, wreck, or arrest. Cost of choosing the
flagship first: ~1,450 m of driving to reach a marker 455 m away.

**FIXED. Reproduced to the decimal first** — t 13.8 s, 11.56 m from a 12 m ring, **at 24 km/h**,
with the spawn 30.0 m from that ring — and the geometry is now a recorded number rather than an
unexamined fact: `mission-test` routes the spawn to each pickup and prints how close it passes to
every other, which reads **2.0 m from `shakedown`'s r12 pickup** on the way to the flagship and
331.1 m the other way. One crossing, in one direction, and it is unavoidable.

`MissionBoard.pickupAt(x, z, speed)` refuses above `stopMs`, which the HOST supplies as
`SCENE_STOP_MS` — **the same threshold, from the same module, that it already feeds the garage**,
whose own comment says a moving car is refused "so the garage is somewhere a player stops rather
than something they drive through on the way past". A mission pickup is the same shape as a garage
zone; it gets the same rule. A LEVEL and not a dwell, because taking a job takes no time, so the
stop is the whole deliberate act and `offerAt` stays a pure function of position.

    the 454 m trip to the flagship   before   shakedown starts at t 13.8 s, 24 km/h
                                     after    0 starts, 342 refused frames inside the ring
    arriving still rolling           37 km/h  -> "SHAKEDOWN / stop to start", nothing starts
    then braking to rest             0.90 s   -> starts, which is a brake curve and not a dwell

**The cue is what makes a level a player cannot see fair**, and `composeGarage`'s "stop here" is the
precedent it copies, down to the `ownSubtitle`. `composeOffer` is in src/mission.js rather than in
either host for the reason CLAUDE.md records twice: both hosts had built that line inline and it
was about to grow a second branch in two places.

**Three checks were restated, not loosened.** `playtest --selftest` §5b read "driving into the
marker starts the job" and was correct about the behaviour it was written for; arriving is now two
checks (rolling refuses, braking accepts) with the drive-through as the control, which is free
because `driveTo` leaves the car rolling. §13 of `mission-test` is the offline half: the threshold
AT the boundary rather than either side of it, the `stopMs` fallback against `SCENE_STOP_MS` the way
`damage-test` checks the garage's, and four shapes of missing `speed` throwing rather than guessing.

All four mutation rows caught, run one at a time on a clean tree:

    pickup-moving         caught by  mission-test playtest
    pickup-speed-default  caught by  mission-test              behaviour-preserving for both hosts
    offer-cue             caught by  mission-test playtest
    pickup-stopms-copy    caught by  mission-test              invisible to every behavioural arm

**The remaining half is the one the entry's second paragraph names, and it is still open.** See
#106: a mission you have taken cannot be handed back. The stop rule makes TAKING one deliberate, so
nobody is conscripted any more, and the cost of a job you took and no longer want is unchanged.

### #101 `ambush`'s 240 s clock has no representation, and expires into a stage nothing reached (A#4)
`secondsLeft` is 237.933 at entry. Over 237.9 s of running it down the band showed two line
families — `mission: LOSE THEM` and `law: PROPERTY DAMAGE` — and **no countdown and no number**.
The only moving `look()` field is `wantedNote`, which is about the police, not the clock. It does
expire and `dropHot` works (1 of 3 seeds reached it, at 237.9 s, band `DELIVER THE PARCEL — THEY ARE
STILL BEHIND YOU — 241 m` / `No more time. Get it to the marina.`) — so the objective changes under
the player saying "No more time" on a deadline never shown.

### #102 The fence band names the one control that does not work (B#9)
34.0 m out, at rest, 30 s of full throttle, **wheel straight**: nose-off 0-89 deg -> 0.1 m;
91 deg -> 1.1 m; 100 deg -> 11.4 m; 135 deg -> 135.2 m at 105 km/h; 180 deg -> 162.7 m. **Full lock:
every angle including 180 deg -> under 7.7 m.** Reverse straight -> **210.9 m home**.

So the fence does NOT strand you — B could not get stuck, which is the thing the last round fixed —
but nothing forward works until the nose is past 90 deg, and you cannot get the nose past 90 deg by
driving forward. The only exit is reverse, and the band reads `TURN BACK` / `the district ends here —
34 m out` while the wedged tenant one priority away already knows the word: `THE CAR IS WEDGED` /
`reverse`. **B reversed itself here too** — its first sweep used full lock at every angle, read
under 0.4 m everywhere, and had written "the fence cannot be driven out of at any forward angle".

### #103 Every pedestrian strike up to 59 km/h is the same one star (B#7) — NARROWED to the FIRST strike, and gated
Single victim isolated: 23.7 / 43.5 / 51.7 / 58.8 km/h all file `pedestrianHit` at heat **exactly
1.0000, 1 star**, while `pedCrimeScale` rises **0.0169 -> 0.3328, x19.7**. 67.7 km/h -> fatal, 2★.
97.9 km/h -> 3★. The `min: 1` floor hides the whole graduated range until the scale passes 0.5
(~62 km/h), so what a player sees is a step function: no-hit -> 1 star -> fatal at 62-68 km/h.

Same shape for a civilian car (B#8): 20 -> 110 km/h gives heat 0.2280 -> 0.9400 and **stars 0 at all
seven**, with your own car at health 0.000 by 70. The route to a star is leaving the scene — and
that is **the best-communicated mechanic either reviewer found**: `STOP AT THE SCENE — 84 m` /
`leaving is a second offence`, then `STOPPED AT THE SCENE` / `an arrest will not cost the job`;
stop 60 s -> 0 stars, no arrest, 2 of 2.

**Every number above reproduces, and the entry isolated the one case where the floor wins.** The
ladder nobody had looked at:

    km/h    scale     raw   strikes to 2*   heat after 2 strikes
    10     0.0049  0.0099        >60              1.010
    23.7   0.0169  0.0337         31              1.034
    43.5   0.0962  0.1923          7              1.192
    51.7   0.1911  0.3822          4              1.382
    58.8   0.3335  0.6671          3              1.667
    67.7   0.6167  1.2334          2              2.467
    76.7   1.0009  2.0018          1              4.004   pedestrianKilled, min 2

**So the flatness is the FIRST strike only, and from the second on speed is fully priced over a
31-to-1 range.** Same for the clock: one strike then stand still clears in **26.1 s at 10 km/h and
26.1 s at 58.8**, and 49.9 s for a kill. The mechanism is `max(heat + delta, c.min)` — at heat 0
the floor REPLACES the charge rather than lifting it — and the boundary is where `c.heat * scale`
overtakes `min`, **derived by scanning the module at 64.5 km/h, scale 0.500**. The entry's band
stops at 58.8, just under it, and `src/wanted.js`'s own comment already said "every scale under 0.5
comes back out as one star".

**Gated as `wanted-test` §f3**, because nothing in the repo asserted that a faster strike is worse:
`damage-test` asserts `pedCrimeScale` is monotonic in speed, which is the INPUT. Ten checks — the
ladder never rising with speed, a 10x span, the second strike's heat strictly rising, and the
first-strike flatness as KNOWN-BADs with the derived boundary on either side. Two mutation rows on
the one line that does it: `heat-no-stack` (caught, `wanted-test`) and `heat-floor-lift` (caught,
`wanted-test damage-test`).

**The obvious lever was measured and NOT taken.** `max(heat, c.min) + delta` — the floor lifting the
charge instead of replacing it — does make the first strike graduate: 1.034 / 1.192 / 1.382 / 1.667
where today all four are 1.0000. It over-charges at the top, and by construction:
`pedestrianKilled`'s `min` is 2 and its charge AT the fatality switch is 2.0018 *because the table
was built so the two meet there*, so lifting one by the other makes **one kill four stars where the
table says two**. It is kept as a mutation row with that reasoning in its own `why`.

**What is still open is narrower: should the first strike graduate at all, and in which quantity?**
Stars cannot, without crossing "two stars is the police having found you: two offences, or one
kill". Heat cannot, for the reason above. The one term that can is **`cool`** — `evadeRequired()` is
`tune().cooldown + this.cool`, which the HUD shows as "EVADING 34s", and `this.cool += c.cool` adds
a flat **8 s for `pedestrianHit` at any speed**. Scaling it by the same `scale` the charge uses adds
0.04 s at 10 km/h, which is nothing for a real offence, and any floor under that is a number nobody
has measured. So: a measurement, not a patch, until somebody decides whether a player should feel
the difference on their first contact.

### #107 `reckless` is unfiled, and it is a PRICED REFUSAL rather than an oversight — the open question is a speed limit
B's observation is exact and reproduces: `reckless` (heat 0.40, cool 2, refractory 3.0, **no `min`**)
has been in `CRIMES` since the table was written, and **120 s at a top speed of 94 km/h with 40 swerve
and handbrake events files 0 crimes**. `grep` over `district/`, `src/` and `tools/` finds no
`reportCrime('reckless')` at all; `wanted-test` exercises the row directly and is its only caller.

**And their diagnosis is already answered in the repo, which I nearly filed over.** `damage-test`
counts the orphans, prints them, and PINS the count:

> HOW MANY CRIMES NOTHING NAMES. It was ten of sixteen; `hitAndRun` has since been wired, because it
> was the only one of the ten whose every input already existed. **The remaining nine are a priced
> refusal, not an oversight**: the systems that would file them do not exist. Weapons, theft, police
> on foot, restricted zones, the pursuit layer's own `evading`, and **reckless driving, which has no
> speed limit to break**. The count is pinned so adding a crime without a reporter is visible in the
> diff.

So this is not CLAUDE.md's "a system that is never switched on is not a feature" — it is the opposite
shape, a refusal that was measured, written down and gated. The first draft of this entry said
otherwise and was wrong; the check that corrected it is the one in `damage-test` doing its job.

**The real open question is therefore not "wire `reckless`" but "should this district have a speed
limit".** That is a design decision, and the reason it is worth putting is that `reckless` is
floorless: it accumulates through the soft knee and never on its own makes you wanted, which is
exactly "not enough to make you wanted" and exactly the graduation #103 asks for and cannot get from
stars or heat.

Candidates for a DERIVED limit, none measured:

- **The traffic fleet's own distribution.** A playtester measured the fleet at a median 36 km/h, 90th
  52, max 64; 94 km/h is 1.5x its maximum. That is a measurable "normal" rather than a picked number,
  and `src/traffic.js` owns it.
- **Off the carriageway.** `ROUTE_LANE_M` and the road index already answer "is the car on the road",
  and #104's knockdown classifier uses exactly that distance. Driving on the pavement needs no new
  quantity at all and is not a speed limit.
- **Near-misses.** `peds` already reports contacts; passing within a body width at speed is the same
  data one step earlier.

Not started: it is a new mechanic rather than a fix, and `damage-test`'s pin means adding it is a
visible, deliberate act rather than something a round can drift into.

### #104 Knockdowns on the carriageway are 1.33-2.17 per km — not fixed (B#6)
Four drives of 6.0 km, each knockdown classified by the car's distance from a centreline at the
moment it happened: totals 2.17 / 2.67 / 3.67 / 2.00 per km, of which **on the carriageway (under
4.5 m) 1.67 / 2.17 / 2.17 / 1.33 per km**. Individual hits at 0.2, 0.3, 0.6, 0.6, 0.7, 1.3, 1.3,
1.6 m from the centreline — middle of the lane. A separate 10.0 km drive: 4.00 knockdowns/km, 8
fatal, 94 crimes, 5★ at the end, 17 wrecks, 18 respawns. Knockdown speeds are **bimodal**: a cluster
at 8.5-9.1 km/h, barely over the 8 km/h free threshold, and one at 50-76.

The earlier "4.11 /km" entry was marked FIXED for a car on the road. At 1.33-2.17 /km on the
carriageway it is improved and not fixed, and the restatement is owed.

**RESTATED, and the per-km rate is not a statement about the crowd.** Four quantities isolated over
3 seeds and 9.99 km, hooking `peds.hit` so the subject is read on the frame of the impact rather
than from where the body landed:

    0 of 57    struck pedestrians were inside ANY carriageway            the crowd is right
    max 1.32   of a 1.30 m bound ACROSS the car's axis                   the collider is right
    0 of 2012  lane points put the car's CENTRE on the pavement          the router is right
    51 of 57   had the car's BODY over the kerb, 35 its CENTRE           the FOLLOWER
    36 of 36   on a road over 3.0 m of half width -- p50 0.82 m PAST it
    15 of 21   on an alley of 2.0 m or less, where 0.95 m of body cannot avoid it anyway

**On a proper street, every single knockdown had the car off the road.** The crowd predicate is the
module's own `_onCarriageway`, the lateral bound is `BODY_RADIUS + PERSON.bodyRadius` and the
measured max sits on it, and the route points are 1.50 m inside the kerb at the median — so neither
the placement, nor the contact test, nor the lane fit is producing these. It is `followPath` leaving
its own lane, which `reaction-test`'s crowd-and-carriageway section had already concluded in one
sentence ("every remaining contact has the car straddling or beyond the kerb") and which this
confirms by a second protocol and splits one level further.

**And #104's own classifier is why it read as a crowd defect.** It called a knockdown "on the
carriageway" when the CAR was under 4.5 m from a centreline. The half widths in the sample run
**1.40 to 3.50 m**, so 4.5 m is on the pavement of every road in it: the band it named carriageway
is mostly pavement, which is exactly what the rows above say was happening. A threshold picked
rather than read off the geometry, and it inverted the conclusion.

So: **not a crowd defect, and not a new one.** The residual rate measures the harness's autopilot,
and CLAUDE.md already records that follower driving 32.8% of `drive-through`'s course inside
buildings. Gated as a new `reaction-test` section — the router clean at 0 of 2,012, with a
KNOWN-BAD showing 158 of 411 centreline points sit on roads narrower than a car body, so the
clearance it asserts is not free. The open item is `followPath`'s lane keeping, which belongs with
#64 rather than here.

### #105 The run-over charge is correct and almost unreachable (B#10)
Driving over the body you just knocked down at 14.5 / 22.5 / 32.5 / 47.5 / 58.2 km/h: `charged
false` 5 of 5, heat stays 1.0000, while the scale graduates 0.0074 -> 0.3191. Coming back 35 s
later: **vacuous 6 of 6, the body has got up.** The one route that works is kill at 75 km/h, wait
36 s, drive over the corpse -> `charged true`, 1 star. A body stands up in ~4.4 s and the per-victim
window is 20 s, so **a survivor can never be charged twice** and the only chargeable body is a
fatality needing ~68 km/h.

### #106 A mission you have taken cannot be handed back (#100's second half)
Split out of #100 because the half that shipped a fix and the half that did not are different
decisions. The conscription is gone — a pickup now needs the player stopped, measured at 0 starts
over the 454 m trip that used to take the job 13.8 s in — so what is left is a player who stopped
on a marker, took a job, and changed their mind.

A measured it at HEAD and nothing about it has moved: 300 s parked mid-mission leaves `outcome
running`, and **no `look()` field matches /abort|decline|cancel|abandon/**. The three exits are
complete, wreck and arrest, and `district/main.js`'s `abortMission` hook is reachable only from a
browser console — the same shape as `startMission` before #100's round, which a playtester called
the finding that dwarfed its other eleven.

So the cheapest way to decline a job is to **destroy your own car**, which #96 measures at a 13.4 s
median. That is the optimal-play inversion this project has already removed once, arriving through a
new door.

**Two candidate levers, neither taken, and the reason is that neither is derived yet:**

- **A key.** `src/input.js` exists and `abortMission` is already written, so this is a wire rather
  than a feature. What it needs is a decision about which key and a cue, and the HUD has no
  precedent for a held-to-confirm input.
- **Re-enter the pickup to hand it back**, under the same stop rule, which needs no new input and no
  new geometry. Checked for collisions, off the mission definitions: the closest any stage trigger
  comes to its OWN pickup is `shakedown/b` at **72.5 m with a 24 m radius** — clear of a 12 m
  pickup ring by 36.5 m — and the next closest is 162.5 m, so no stage could satisfy itself on an
  abort zone. `shakedown`'s leg from `b` to `c` passes 58.6 m from its pickup in a straight line,
  and the latch the board already has would stop a handed-back job restarting on the next frame. It
  reads well as fiction too. What stops it being obvious is that it gives `marlin-street` an abort
  zone 500 m from its own delivery point and `shakedown` one at the start of a 400 m walk, so
  "where you took it" is not somewhere a player who wants out is standing.

Worth one playtest question before either: **is being unable to decline actually felt as a trap
once nobody is conscripted into it?** The finding was reported as a consequence of the
conscription, not on its own, and this file already records a round that measured a saturation's
cost before fixing it and found the player could not tell.

### REFUTED — braking for traffic is not worse than ignoring it (B#11)
Round 8 measured "flat out at 40 km/h ignoring traffic: 0 rams, 519 m; lifting off for any car
within 25 m: 6 rams, 357 m". B ran it as a registered pair, 5 seeds, same route: ignore -> 1010 m,
**2 rams**, health 0.96; lift off -> 1010 m, **2 rams**, health 0.98. Identical in all five seeds,
1.98 rams/km either way. **Caveat B states itself:** the lift rule fired on only 3% of frames, so
this is weak evidence about braking and strong evidence that a car rarely gets within 25 m of the
windscreen.

### The four highest-heat crimes have never been played (B, "what I could not resolve")
`tools/playtest.mjs`'s contact pass iterates the traffic fleet and the crowd and **not the pursuit
units**, so `policeProperty`, `roadblockRun`, `officerAssault` and `officerDown` — the four
highest-heat entries in the crime table — cannot be filed in the harness at all. B tried: 3 seeds x
120 s steering at the nearest `enemy` blip at 4★ gave closest approaches of 16.26 / 22.27 / 21.30 m
and **0 police-kind damage records** against 10,401-10,991 wall records. `district/main.js` does have
that pass, so it is an instrument gap rather than a missing feature — but it means nobody has played
that branch, and **#89 above leans on `policeProperty` being the one row an unclamped crime scale
would break.** That claim is now known to rest on an untested branch.

Side observation that IS about the game: steering by the enemy blip's bearing drove the car into
buildings for 10,000+ damage records. The blip is a bearing with no road between you and it.

### Smaller, with numbers
- **67.67 s of completely blank band** (`null | null`) between shakedown ending and the flagship
  starting, on the natural journey between them (A#11). Navigable — the waypoint points — but no text.
- **`drop` bounces back to `ambush` in one frame at 2 stars**, and one civilian collision reads 2
  stars, so a single scrape on the delivery leg costs another 55-190 s chase (A#11).
- **`MISSION FAILED` is 6.000 s but in TWO spells**, 1.050 s then 4.000 s of `THE CAR IS WRECKED`
  interrupting it then 4.950 s (A#9). Better than the 1.9 s previously recorded, and not one read.
- **Which of two words a player sees depends on the stage.** `healthBelow` exists only on `ambush`,
  `drop` and `dropHot`; on `eastbound` the same 49 km/h hit gives `MISSION ABORTED | the car is
  wrecked` instead of `MISSION FAILED` (A#9).
- **A failed job can be retaken and the latch is correct**, but for the 60 s before you leave, the
  band reads `MARLIN STREET | ... — 1 m`, offering a job that cannot start until you leave and
  return (A#11).
- **No "nearly there" state at the garage**: repaired at 0.01/6.00/11.00/11.90 m, nothing at
  12.11 m and no garage line at all — the cue is binary at 12 m (A#7).
- **No route line to the garage**, only a blip bearing (A#7). With a damaged car at the spawn the
  waypoint still points at `shakedown`, and driving to the garage from the spawn therefore starts
  the tutorial — #100 again, through a second door.

### What both reviewers confirmed WORKS, with numbers
The garage dwell and all five of its refusals (A#7); the wedged cue, 8 of 8 on genuinely pinned
arms and **0 of 13 false positives** on arms that slid along the wall, with reverse recovering
131.69 m against 0.52 m forward (A#8); `shakedown`'s opening read correctly both on foot (stage `a`
holds 720 of 720 frames reading `GET IN THE CAR — 8 m`) and driving in (0 frames, never says it)
(A#10); `drop` now holds **72.60 s over 626-722 m** where a previous round measured 0.033 s (A#4);
the arrest itself, **24 of 25 arrested in 7.7-19.9 s** across 1★-5★ including 5 of 5 on foot (B#12);
the bust countdown in SECONDS with the right unit in every arm (both); the pure decay ladder
byte-identical over 5 seeds at 251 m from any road — 1★ 12.1 s, 2★ 30.1, 3★ 56.1, 4★ 90.1, 5★ 134.1,
exactly the cumulative cooldowns (B#12); the throw model exact to 0.04 m at six speeds (B#7); and
**no dead end found** — five worst service alleys, 40 s of full throttle into each, got out of all
five, 18.7-137.1 m recovered (B#12).

The car's handling numbers all hold: 0-50 in 3.092 s, 0-100 in 7.800 s, brakes 11.36 m/s2, coasting
58.7 s to 1 km/h (A#12). A's own earlier top-speed and coasting figures are recorded **void** — that
run hit a wall at 199 m.

### And the damage ladder does not reproduce at the quoted speeds (A#5) — unresolved
Nine arms, one wall, head-on along its own normal, standoff sized to the speed, all nine recording a
contact with impact speed and charged delta-v printed:

    at impact   charged dv   dv/closing   health      previously quoted
      9 km/h      2.72         1.09       0.987
     19           5.93         1.12       0.839       20 -> 0.94
     24           7.50         1.13       0.727
     39          12.29         1.13       0.223       40 -> 0.67
     49          15.49         1.14       WRECKED
     59          18.68         1.14       WRECKED     60 -> 0.21 ; 90 -> wrecked

Smooth curve, `dv/closing` a tight 1.09-1.14 — but the old pairs land on A's curve at about **two
thirds of the stated speed**. A explicitly declines to call it a regression because it could not
isolate: yawing the body scrubbed the velocity off through the tyres and **8 of 10 arms never
reached the wall** (impact speeds 0-2 km/h). The subject resisted the instrument. **The next round
should compare charged delta-v, not the speedometer**, and A's are above.

The mission consequence is independent of which curve is right: 49 km/h is a write-off and `ambush`
is driven at 58-79 km/h, so any head-on at chase speed ends the mission — **3 of 5 flagship runs and
2 of 5 evade runs ended by wrecking**, not by a mission rule.

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

### #93 CLOSED BY MEASUREMENT — real in the scale, invisible in the outcome, dangerous where it is visible
The analysis below is correct and the fix should not be taken. The scale does saturate at 8.333
from 44.5 km/h. What was never measured is what the saturation COSTS, and the answer is nothing a
player can reach. `wanted-test` §f2 sweeps the unclamped scale against the shipped one over one
to six impacts:

       50 km/h  scale   8.33 ->   11.07   stars 012345  against  012345
       80 km/h  scale   8.33 ->   28.68   stars 012345  against  012345
      140 km/h  scale   8.33 ->   88.27   stars 012345  against  012345
      180 km/h  scale   8.33 ->  146.05   stars 012345  against  012345

The star ladder is byte-identical at every speed, because `civilianCollision` is floorless and
`FLOORLESS_CAP` is 1: the soft knee that #90 put in asymptotes at the cap, so a x17 larger scale
buys 0.06 of a star. The one crime where it is NOT invisible is the one with a floor and no cap —
`policeProperty` at 180 km/h goes **10.0 -> 175.3 of heat**, which is five stars from a single
ram and the meter saturated for the rest of the session.

So unclamping would move nothing where the entry said it would and would break the one place it
was not looking. The entry's own "every number in all four gates moves" was the tell: a change
whose only measurable effect is on gates is a change with no gameplay effect. Left as it is, with
the sweep committed so the next round does not re-derive it.

### #93 (original record) The crime scale inherits the damage model's clamp
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

### #89 RE-MEASURED, and the remaining half is a STALEMATE rather than immunity
The cue half is fixed. The other half was "beyond the hold radius a nose-in crash is total
IMMUNITY — 1 of 14 run-ups into walls 8-18 m off the road was ever arrested", measured BEFORE the
28 m reach landed. 8-18 m is now inside the reach and `playtest --selftest` arrests at 14.15 m in
7.3 s, so that sentence is closed. What is underneath it is worse and was never named.

`tools/arrest-band.mjs` sweeps a stationary four-star player outward from a 412 m primary edge,
240 s per placement, with the on-road row as a control the tool THROWS without:

      placed   true road d   stars   units  held   seen%   closest   busts   ended
          0 m         8.0 m   4->0       6     1     97%     7.9 m       1   arrested
         15 m        22.9 m   4->0       6     1     87%    22.8 m       1   arrested
         30 m        37.8 m   4->4       6     0     93%    37.0 m       0   STALEMATE
         45 m        52.6 m   4->4       6     0     93%    51.7 m       0   STALEMATE
         60 m        67.5 m   4->4       6     0     85%    66.5 m       0   STALEMATE
         90 m        97.3 m   4->4       6     0     77%    96.2 m       0   STALEMATE
        130 m       136.7 m   4->4       6     0     55%   135.8 m       0   STALEMATE
        180 m       185.9 m   4->0       6     0      2%   185.8 m       0   escaped
        260 m       264.4 m   4->0       0     0      2%       n/a       0   escaped

**Both transitions land on a constant, which is what makes this a mechanism and not a story.**
Arrest needs a unit within `reachRadius` = max(holdRadius, RUN_SPEED * BUST_HOLD_S) = 28 m, so
22.9 m is arrested and 37.8 m is not. Escape needs the state out of ACTIVE, and `_evaluateContact`
holds it there out to `tune().spotRadius` = 150 m at four stars, so 136.7 m never decays and
185.9 m does. Between them the game can see you, cannot touch you, and will not let you go: five
of nine placements sat at four stars for the full 240 s with a unit 37-136 m away.

Neither radius is wrong on its own and both are honestly derived. **Nothing compared them** —
they live in different modules, and the ratio runs 3.04x at one star to 6.25x at five.

Two things that make the band ordinary rather than an edge case:
- **Neither host narrows it.** `_evaluateContact` short-circuits on `player.seen` and then on
  `this.losTest`, and `district/main.js` sets neither — its own comment says so. Spotting is pure
  distance with no line of sight, so a building between you and the unit does not help.
- **The whole off-road interior is drivable.** Flood-filling the district from the road network
  over positions where the five-circle body collider fits: 521,354 of 521,552 car-sized cells are
  reachable, and **53.56% of them are further than 28 m from any centreline**, worst 729 m. (The
  first version of that sweep reported the same 53% without the flood fill, which was a superset
  counting the bay; connectivity changed it by 198 cells, so the number stands.)

**The CLOCK half of the fix is derived and the TRIGGER half is not, and the obvious trigger is
wrong. Traced before writing it, so the next round does not write it.**

The clock is free. An arrest is made by a person covering ground at `RUN_SPEED`; the current model
evaluates that at one point and calls the answer a radius. Stated as a function instead:

    required(d) = max(BUST_HOLD_S, d / RUN_SPEED)

`reachRadius` is exactly where the two terms cross — `RUN_SPEED * BUST_HOLD_S / RUN_SPEED` is
`BUST_HOLD_S` — so this is **identical to today's behaviour at every distance the game currently
arrests at** and lengthens the countdown with the walk beyond it. 14.3 s at 100 m, 21.4 s at 150 m.
No new constant, and `wanted.js` can compute `d` itself: `reportUnits` already gives it every
unit's position and `_evaluateContact` already measures exactly that distance.

The trigger is the hard half. **Do not widen `u.stopped` from `reachRadius` to `spotRadius`.** Its
condition is `near.d <= reachRadius`, where `near` is the closest approach of the player to the
unit's CURRENT EDGE — so widening it to 150 m makes a unit clamp on the first edge that passes
within 150 m of the player instead of continuing to route closer. Units would stop further away
than they do now and the chase would get *worse*, which is the opposite of the finding. Measured in
the stalemate rows, units never stop at all: `held` is 0 at every placement from 38 m out, and they
mill about at 37-136 m, because no edge they are on comes within 28 m.

So the arrest cannot key off `u.stopped`. What it needs is "this unit cannot get closer" — the
minimum over the unit's reachable road of distance to the player — which is a graph query, or an
approximation of one via the plan's own assigned goal. That is a pursuit design change rather than
a constant, and it is the open half.

Held for the playtest round in flight, whose blind measurement of the pursuit is the before-arm.

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
