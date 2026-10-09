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

### #94 A PRICED REFUSAL — the chromatic third kept the pre-census band, and only its FLOOR is derivable
The defect is real and recorded: the achromatic branch moved to `src/carpaint.js`'s census table
(0.040 .. 0.870, x21.75) and each module's chromatic branch kept its own legacy achromatic band
under a new name — `traffic.js` 0.340 .. 0.600 (x1.76, byte-identical to the expression the table
replaced) and `streetfurniture.js` 0.260 .. 0.660 (x2.54). So the fix shipped for 66% of both
fleets and the defect's own number survived in the other 34%.

**It is not tuned because only the FLOOR is available.** Three's BRDF puts `F0` at the plain
dielectric 0.04 when the albedo is 0.040, so a chromatic floor is derivable and the shipped one
is six to eight times above it. The SHAPE is not: the census resolves FAMILY and says so in its own
file, not VALUE within a family, and a bright red at the white tone is pink rather than a light
red — so the achromatic table cannot be reused. Lowering the floor alone would repaint a third of
both fleets on a uniform distribution nobody measured, which is this project's own "do not move a
figure your instrument cannot resolve" arriving as the obvious fix for a real defect.

`paint-tone` prints all three spans side by side on every run, which is what found it — x1.76 is
not visibly wrong alone and is a factor of twelve beside x21.75.

#### THE ORIGINAL RECORD
### #94 (as filed) The chromatic third kept the band the census table replaced, in both fleets
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

### #95 FIXED — the reset needs the player moving AND RECEDING, and the entry was stale
Shipped in `src/wanted.js`'s `_watchBust`, which carries the whole derivation. **This entry read
OPEN for the rest of the session and I started re-deriving it before grepping the module** — see
the audit note at the end of this file.

Re-measured against the current build, the playtester's own protocol: a 25 m circle steered from
the car's own `R_min(v)` so the SPEED is the variable and the position is held, 3 seeds, 150 s cap,
four stars re-armed whenever the level bled out:

    target km/h   mean   drift m   arrested/3   first bust s
        2.8        3.1      11        3/3       12.7 11.5 11.1
        4.8        5.2      72        3/3       105.2 15.0 15.0
        5.8        6.1      61        3/3        59.6 17.6 17.3
        8.6        8.8      53        3/3        44.9 13.0 12.2
       12.4       12.6      65        3/3        81.9 15.8 16.0
       19.9       20.1      76        3/3        53.2 47.5 53.2

**3 of 3 at every speed, where the entry measured 0 of 3 from 4.8 km/h up.** The drift column is
what says the circle held rather than the car escaping. Gated: `wanted-test`'s circling section
runs three speeds, and `mutation-sweep`'s `bust-sign` and `bust-sign-default` give it teeth.

And the module records that the OBVIOUS derivation was tried and refused: testing the speed against
`RUN_SPEED` (7 m/s) closes the exploit cleanly and takes a deliberate 2 s pause from x1.75 of the
clock's margin to **x0.94**, so the clock stops outlasting it. The sign was the right quantity and
the speed was never the wrong number.

#### THE ORIGINAL RECORD
### #95 (as filed) 4.8 km/h of forward motion makes you permanently un-arrestable (B#2)
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

**SHARPENED BY ROUND 11, in the damning direction: the wreck is 8.2 s, not 13.4.** Measured from a
committed mid-job state — nearest building 23 m, one impact at 15.9 m/s, health 1.000 -> 0.000,
`propertyDamage`, **0 stars**, 4 s hold, replacement on a road 20 m away at health 1.000 — and
over 20 on-road sample points they wrecked at 16 of 20 within 90 s, **p50 6.0 s**. So the ratio is
not 3.7x, it is **6x against the garage's median 49 s**, and the four failures were their own
controller grinding along a wall below the free threshold rather than the game refusing.

Their isolated threshold table, one wall hit at `dirZ 1`, is the derivation a lever would need:

    dv m/s   km/h   health after ONE impact   wrecked
     2.2       8     1.0000                   false   (applied=false, free)
     8        29     0.6859                   false
    12        43     0.2612                   false
    14        50     0.0000                   TRUE
    22        79     0.0000                   TRUE

**And #97's measurement says why the wreck is free in heat terms BY DESIGN**, which is the half
this entry was missing: `propertyDamage` is floorless, `FLOORLESS_CAP` is 1, and the soft knee
asymptotes under it — a 110 km/h write-off charges 0.9000 and reads 0 stars, and two hits are a
star. So "costs one `propertyDamage` and 0 stars" is not an oversight to be patched at the crime
table; it is the shape #90 deliberately shipped, and a lever that files more heat for a wreck
re-opens #97's ladder.

**Three candidate levers, none derived, recorded so the next round does not re-derive them:**

- **The respawn POINT.** Today it is the nearest road, 20-25 m away. The garage is where cars get
  fixed, so respawning THERE is a derivation rather than a tuned number, and it prices the wreck
  at the drive back from the garage — which `#96`'s own table already measures at a median 576 m.
  It is also a large gameplay change and would make a wreck far out of town brutal.
- **The hold.** `WRECK_HOLD_S` is 4.0 and is `BUST_HOLD_S` — "one beat for the game has taken
  over", shared on purpose, with its own derivation against a measured 0.68 s stop-and-go floor.
  Lengthening it alone is a tuned constant AND would move the arrest, which is the wrong coupling.
- **The replacement's HEALTH.** Free today. There is no derivation available for a number between
  0 and 1, and anything under 1 risks the dead end this project has already removed twice (a
  wrecked car with no engine power and no way home).

**#106's fix removes the ABORT half of this and not the REPAIR half.** Handing a job back is 0 s
now, so destroying the car is no longer the cheapest way to decline — but it is still the cheapest
way to REPAIR, by 6x, and that is what is left of #96.

### #97 MEASURED and gated — the flatness is the FIRST hit, the inversion is real, and the obvious fix is refused by arithmetic
The entry below pairs "two gentle taps earn a star" against "one car-destroying impact earns
nothing" and both halves are real. What nobody had measured is the ladder, on the conversion the
GAME uses: `district/main.js`'s wall hook passes `(kmh / 3.6) * 1.15`, which is `normalDv`'s
`|vn| * (1 + e)` at the shipped restitution, so the charged delta-v is 15% above the arrival speed.

    km/h     dv   severity   scale     raw   charged  1 hit   hits to 1*  2*  3*
      10   3.19     0.0285   0.237  0.0712    0.0712     0*       21      36  50
      15   4.79     0.0962   0.802  0.2405    0.2405     0*        5       9  13
      20   6.39     0.1910   1.592  0.4775    0.4775     0*        3       5   7
      25   7.99     0.3129   2.607  0.7822    0.6804     0*        2       3   5
      30   9.58     0.4619   3.849  1.1546    0.7835     0*        2       3   4
      44+ 14.06     1.0000   8.333  2.5000    0.9000     0*        2       3   4

**Severity IS fully priced — 21 hits to a star at 10 km/h against 2 at 44 — and the flatness is
confined to the FIRST hit**, where every severity reads 0 stars. That is #103's shape in the
mirror: there the FLOOR replaces the charge at heat 0, here the CAP holds it under one star. The
same correction, for the second time in two entries: **vary the repetition as well as the
magnitude.**

**And the entry's label is off by 0.7 km/h, which matters because it sits on the switch.** Two hits
earn a star from **20.66 km/h** up, bisected on the module; at exactly 20.00 two hits give heat
0.9100 and 0 stars, three give 1.3875 and 1. So "two hits 3.04 s apart: heat 1.0320 = 1 star" is a
reading at about 20.7 km/h. The number is right and the label is not, which is this file's standing
note that a reviewer's observation outlives their arithmetic — arriving on a boundary where one
km/h changes the answer.

**The inversion is real and this is its size.** Swept over 5-200 km/h and 1-8 hits, in the quantity
a player watches:

    cheapest star    7 x  13 km/h   cost 0.0659 of the car   heat 1.0355   1*
    dearest 0 stars  1 x  44 km/h   cost 1.0000 of the car   heat 0.8730   0*   WRECKED

**15.2x more of the car can be destroyed for no stars than is needed to earn one, and the dearest
nothing is a WRECK at 44 km/h** — not the 138 km/h impact the entry names, which is the same 0.9000
and the same 0 stars. The pair above is stronger than the one reported and it is the one gated.

**WHY THE OBVIOUS FIX IS REFUSED, and it is arithmetic rather than taste.** `FLOORLESS_CAP` is
`min(every floor in the table)` = `hitAndRun.min` = 1, and one star is heat >= 1 — so **whether one
property-damage offence can make a player wanted is answered by a constant about leaving the
scene.** A knee that REACHES the cap instead of asymptoting would grant the star, and it must
compress `rawMax - k` of input into `cap - k` of output while starting at slope 1:

    crime              rawMax  rawMax-k  cap-k  mean slope   p    slope over the top tenth
    reckless            3.333     2.833   0.50     0.1765  5.67               3.80e-6
    propertyDamage      2.500     2.000   0.50     0.2500  4.00               2.50e-4
    civilianCollision   4.167     3.667   0.50     0.1364  7.33               6.33e-8
    brandish            5.000     4.500   0.50     0.1111  9.00               1.11e-9
    evading             1.250     0.750   0.50     0.6667  1.50               2.11e-1

So it buys the star by going flat exactly where #90 removed the flatness — the clip's defect in a
smooth wrapper. The asymptotic knee separates the top tenth by 5e-3 to 9e-3, also unreadable, but
ORDERED. **A severity-sensitive charge that reaches one star needs a bigger cap, not a different
shape**, and the crimes want different caps — propertyDamage 1.127, civilianCollision 1.068 — so
one shared constant cannot deliver it.

**And my own monotonicity scan said "not monotone" before I understood why.** It stepped the
reaching knee 20,000 times and reported three of five crimes non-monotone. The curve is strictly
increasing; it is numerically FLAT near the top, so consecutive samples came out bit-equal. The
quantisation artefact WAS the result — this file's "a metric whose answer is its own quantisation
reads as a result", for once pointing at something true.

**THE THIRD LEVER, and it is the one with no number yet.** `severityFor` measures damage to the
PLAYER'S car, and the offence is against the building. A 44 km/h impact writes off the player's car
and probably marks the wall; seven 13 km/h taps are seven separate incidents and barely scratch
either. Read that way the meter is not backwards at all — it counts offences, severity-weighted,
and a player's own loss is not a crime. Which of those two readings is right is a design decision
and it is not derivable from anything in the repo, so it is recorded rather than taken.

**And the ladder falsified a check in a different gate, which is most of what it was worth.**
`boot-check`'s garage arm clears the wanted level, breaks the car with one `dv: 7.5` wall impact
and asserted `stars > 0` — the host's impact-to-crime wire. That is unreachable: `dv 7.5` files
`propertyDamage`, charged **0.6336**, which is 0 stars by the arithmetic above. The check had been
passing on heat left by an earlier arm — the run-over arm charges `pedestrianHit`, which arms a
scene, and the garage arm's own teleport leaves it, filing `hitAndRun` whose floor is 1 — so on a
run where the run-over arm hit nobody it failed, naming a wire that was never broken. It asserts
HEAT now, split into two checks. **When you measure a ceiling, grep the gates for assertions that
sit above it.**

**Gated as `wanted-test` §f4**, 10 checks: the ladder never rises with speed, it spans 10x, the heat
after two hits rises strictly with speed, the 20.66 km/h switch is bisected off the module, and the
inversion pair is pinned as two KNOWN-BADs with a third check that neither arm is a zero. 287 -> 297
checks.

**Two probe errors on the way, both of which printed a clean table.** The first fed `impact()` the
ARRIVAL speed as the delta-v rather than `(kmh/3.6) * 1.15`, so every scale below the clamp came out
low and two 20 km/h taps read 0.69 of heat where the playtester measured 1.0320 — the disagreement
with their number is what found it. The second stepped the refractory out in ONE `update(2.51)`
call: `WantedSystem.update` clamps dt to `maxDt` 0.25 with a comment saying why, so the clock
advanced 0.25 s, every second hit came back `reason: 'refractory'`, and the table read **11 hits to
one star where the answer is 2** — with the heat sitting at a motionless 0.9000 and no decay, which
is the reassuring shape a measurement bug takes here.

### #97 (the original record) The escalation runs backwards at the top end (B#4)
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

### #99 FIXED — a `status` tenant yields the headline, and the entry was stale
Shipped in `src/wanted.js` (`status: true` on the crime-notice branch) and `src/hud.js`
(`composeBand` walks `BAND_ORDER` and lets a status tenant yield to anything below it). CLAUDE.md
carries the derivation at length, including why re-ranking `law` below `mission` would have fixed
the share and broken the bust countdown — "the one place the game says how to get out of an
arrest". The rule keys off what a line IS rather than where it sits, and `hud-cue`'s band ladder
reads the tenant list off `composeBand`'s own signature so a tenant added without a check is
reported as unexercised.

#### THE ORIGINAL RECORD
### #99 (as filed) The `law` tenant owns the headline during a mission, and on `ambush` it says the opposite (A#3)
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

### #100 FIXED, BOTH HALVES — conscription (this entry) and handing a job back (#106)
The conscription half shipped in this entry's own round. The second half — "a mission you have
taken cannot be handed back" — was split out as #106 and is now fixed too: `Q` while stopped, with
the lever chosen by `tools/abort-cost.mjs` pricing every alternative in seconds rather than by
argument. So #100 is closed end to end.
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

**The remaining half is FIXED too.** See #106 below: Q while stopped hands the job back, and the
lever was chosen by pricing every alternative in seconds rather than by argument.

### #101 FIXED — a stage with a clock and no destination shows the clock, and the entry was stale
Shipped in `src/mission.js`'s `hud()`: an objective takes `{ text, distance, unit: 's' }` when the
stage has a `timeLimit` and no reachable destination. **Exactly one stage in the game is that
shape** — `marlin-street`'s `ambush`, 240 s, no marker and no reach trigger, because what it asks
for is an evasion rather than an arrival — so only `ambush` changes. Distance still WINS where a
stage has both (`dropHot` has 300 s and a marker), since how far you have to go is the actionable
number and the clock is pressure.

`unit: 's'` is not optional and CLAUDE.md records why: `objectiveLine` defaults to metres, and the
bust countdown once shipped with a dropped unit that read "3 m" for a 3 s countdown. Gated in
`mission-test` §12, whose two `mutation-sweep` rows (`stage-clock`, `stage-clock-unit`) are caught
by CHECKS rather than by a throw.

#### THE ORIGINAL RECORD
### #101 (as filed) `ambush`'s 240 s clock has no representation, and expires into a stage nothing reached (A#4)
`secondsLeft` is 237.933 at entry. Over 237.9 s of running it down the band showed two line
families — `mission: LOSE THEM` and `law: PROPERTY DAMAGE` — and **no countdown and no number**.
The only moving `look()` field is `wantedNote`, which is about the police, not the clock. It does
expire and `dropHot` works (1 of 3 seeds reached it, at 237.9 s, band `DELIVER THE PARCEL — THEY ARE
STILL BEHIND YOU — 241 m` / `No more time. Get it to the marina.`) — so the objective changes under
the player saying "No more time" on a deadline never shown.

### #102 FIXED — the fence line is signed on the nose, and the entry was stale
Shipped in `src/blockers.js`: `subtitle: f.noseOut ? 'reverse' : 'drive'`, composed in ONE place
where it had been inline in both hosts. A nose still pointing out of the district is told to
reverse, because forward is refused; a nose already pointing home is told to drive. That is the
control the entry measured at **210.9 m home** against 0.1 m for the one the band used to name.

The refusal itself was fixed in the same family of rounds and CLAUDE.md records both wrong versions
— a barrier that refused all power stranded the car 786 m out, and a brake ramped on DEPTH rather
than on the velocity's SIGN moved it 0.1 m in thirty seconds of full throttle pointing at town.

#### THE ORIGINAL RECORD
### #102 (as filed) The fence band names the one control that does not work (B#9)
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

### #108 FIXED — the clamp asked a greedy router for a global minimum, and the entry's own diagnosis was wrong
#89's admission beyond the officer's reach was `near.d <= bestApproach(target)`, the network's own
minimum, exactly. `PursuitUnits._chooseNext` descends the distance from an option's **far
endpoint** to the target; `bestApproach` minimises an edge's **closest approach**. Two different
functions, so the minimising edge is often one no unit will ever drive — and the condition cannot
be satisfied by any unit at those spots.

Walking the router itself, no sim, from 24 start states at 516 clear spots 30-140 m off a road:

    the router reaches a minimising edge     319 of 516   62%
    it never does                            197 of 516   38%
    and where it does not, the closest edge it CAN reach is
      p50 31.71 m further than the network's own, p90 153.97, max 190.02

`reachRadius` is 28 m, so **no tolerance of the form `best + reach` rescues even half of that** —
which is what killed the first candidate fix, written before the measurement.

**Two more mechanisms, and all three read as the same symptom.** Where the minimum sits at an
edge's far ENDPOINT, the clamp fires on the one frame that also triggers the reroute, which clears
`stopped` — traced at 730 and 1,460 unit-frames on a minimising edge with the approach clause true
in 1 and 2 of them. The reroute comment's claim that a unit "re-holds on the new edge at t = 0" is
true INSIDE the reach, where the admission is a radius both edges satisfy, and was false outside
it. And `_closestOn` is **not bit-identical in the two directions**: it reverses the point list for
a backward unit, so over 88 targets x 935 edges the two reads differ in 0.23% of pairs by up to
2.274e-13 m, and on a MINIMISING edge the backward read exceeded the forward minimum in 5 of 89
cases. A few ULPs decided whether a player could be arrested. `bestApproach`'s own comment claimed
that identity "by construction"; the claim is corrected in place rather than deleted, because
"true in exact arithmetic" and "bit-identical" are different sentences and only one is about the
code.

**The fix is the quantity, not a bound.** `_localBest(u, target)` is the best approach among the
edges the unit may take next — `_chooseNext`'s own option set, which both now take from
`_optionsAt` rather than copying the filter. The guard stays global, because "can the roads reach
the player at all" genuinely is a global question. Two questions, two quantities.

    admission                        arrested       p50      newly   lost
    global, `near.d <= best`         45 of 107    16.5 s         -      -
    local                           100 of 107    25.0 s        55      0
    local AND the walk is clear     101 of 107    25.5 s        56      0
    the officer can walk the line   101 of 107                         <- the ceiling

107 clear spots 35-110 m off a road, 90 s stationary at four stars. **Not one spot regressed.** The
ceiling is `_footPathClear` from the stop point, measured on its own, and it is the one term here
that is not a defect — a player with a building between them is not being held by anybody.

**The walk is in the admission for a CUE, not for that one spot.** Without it, 27% of stopped
unit-frames are a car that has pulled up with no officer able to reach the player (stop 63.7%
against held 46.8%). A unit stopping is the only signal this game gives that an arrest is
beginning, so a build where it means nothing a quarter of the time lies to the player. With it the
two coincide at 50.9% and 50.9%, by construction.

**What it costs is 6.5 s on the median arrest that already worked** — 5 faster, 29 slower, worst
+30.5 s, measured on the arm that ships — which is `arrestSeconds` pricing a longer walk. `arrest-band` disagrees in SIGN and the
two reconcile, which is the useful part:

    placed   #89 held  closest  ended      #108 held  closest  ended
       0 m        1      7.9     31 s          1       7.9      31 s   <- inside the reach,
      15 m        1     22.8     30 s          1      22.8      30 s      byte-identical
      30 m        1     37.6     37 s          5      82.6      13 s
      45 m        1     52.5     46 s          5      97.5      16 s
      60 m        2     67.3     45 s          5      80.7      12 s
      90 m        2     97.1     46 s          6     110.4      16 s
     130 m        2    136.6     28 s          6     136.6      28 s
     180 m        3    185.8     33 s          6     199.7      35 s
     260 m        0      n/a    240 s          0       n/a     240 s   escaped, both

The `closest` column got BIGGER and the arrest got FASTER, because units now stop sooner instead of
driving past: the global rule eventually put ONE unit at 37.6 m after ~31 s of milling, the local
rule puts FIVE at ~82 m within 2 s, and the clock is `arrestSeconds` of the NEAREST HELD one. So
the grid's +6.5 s and the band's -25 s are the same mechanism measured where the two terms rank
differently, and the 0 m and 15 m rows being byte-identical is the guard's promise confirmed by a
second tool.

**`pursuit-test` 36 -> 48 checks, and the bound that caught the move was restated rather than
loosened.** "A holding unit is inside the reach OR at the closest the network gets" failed at a
worst excess of **82.949 m against a 1.400 m bound** the moment the admission went local. It is
now the same bound per unit, computed from `district` by the gate's own `approachTo`/`optionsTo`
rather than by the module whose rule it judges, with the dead-end frames (no bound, correctly)
counted and printed. Inside the reach the per-unit traces are **BIT-IDENTICAL** with the clause
disabled over 402,485 characters, with a separate check that those traces are not empty of the
state being compared. Six mutation rows: two repointed (their `find` strings went stale in this
commit) and four added, including `arrest-eps` with its own gap written into its `why`.

### #108 (the original record) The two hosts disagree about how sticky a long arrest hold is — REFUTED
Kept because the refutation is the lesson. The entry below was filed off a real observation —
`boot-check`'s arm latched the right clock at 57.4 m and advanced it 0.145 s over 103 frames — and
every candidate cause in it is wrong:

    boot-check's spot, run through tools/playtest.mjs   busts 0, held on 0 of 480 steps
    arrest-band's 60 m row, same harness                busts 1, held on 17 of 31 steps

**The two hosts agree. The SPOT differs**, and 57.8 m against 59.2 m of road distance is not the
variable — the local topology is. So "the likely fix is to make the hold sticky once armed" was
aimed at the wrong flag entirely: `u.held` never flickered. Of 363 stopped unit-frames at that
spot, `held` equalled the foot-path test in 363, with 0 stopped-and-not-held and 0 refused walks.
`u.stopped` was the variable and it was never set, because the admission demanded a minimum the
router could not reach.

Two things to carry. **When one host works and another does not, run the SAME spot through both
before believing the hosts differ** — one `Session` reproduced boot-check's failure in playtest and
disposed of the whole entry in a minute. And the first probe I wrote after that measured the GAP
between the best and second-best edge approach, on a story about ties, and the data came back
inverted: the two spots that never arrested had a 0.50 m mean gap against 15.68 m for the eight
that did. A candidate fix was already drafted on that premise. **A sweep that confounds two columns
cannot name either**: the failing pair's mean road distance was 63.3 m against 49.8 for the rest,
and ten spots cannot separate the two — an arrested spot sat at 67.9 m and a failing one at 54.6.
The measurement that settled it took the physics out altogether and walked the router.

**The entry as it was filed, kept verbatim below**, because the observation in it is sound and only
the diagnosis is not — and because a wrong entry that was corrected is more use to the next round
than a deleted one.

Found while gating #89's fix, and it is the one thing that round could not close. The change is
correct in both hosts — the clock the page latches is right to 7 ms — and the two differ in whether
it ever RUNS OUT.

    tools/playtest.mjs, via arrest-band   busts at 37, 53, 68, 97, 137 and 186 m in 28 to 46 s
    district/main.js, via boot-check      latches 8.205 s at 57.4 m, then advances 0.145 s
                                          over 103 rendered frames and never fires

The latch is provably right: the page's own `bustNeeds` reads **8.208 s** against the gate's
independently computed `arrestSeconds(57.408 m)` = **8.201 s**, with `bustNoWalk` not moving, so the
host computed and passed the walk. `bestApproach` reads **57.464** against `roadDistance`'s
**57.408** — two walks of the same network. Everything about the wire checks out.

What does not is the HOLD. `_watchBust` resets `bustFor` on any frame where `player.held` is false,
and `u.held` is `u.stopped && (near.d <= holdRadius || _footPathClear(...))` — so over a 57 m walk
the straight-line foot test flickers as the clamp point shifts, and the clock restarts every few
frames. **This is a class CLAUDE.md already records, in this module**: "The condition `u.t <=
near.t` was a strict ratchet ... `held` was true for exactly TWO frames at a time. Once sticky, six
variants of one scenario all bust at 16 s."

Ruled out, each by measurement rather than by argument:

- **The car moving.** Drift 0.05 m over the whole window, still 57.4 m from a road.
- **The spot having no clear walk.** The gate now samples `clearAt` along the line from the car to
  its nearest road point before committing to a spot, at the module's own predicate, and the same
  spot is chosen.
- **`clearAt` missing in one host.** Both pass it — `district/main.js:1156` and
  `tools/playtest.mjs:271` — so the foot test is live in both and this is not playtest measuring a
  world without walls.
- **The sim-loop placement.** `wantedBridge.update` is inside `district/main.js`'s `timeScale`
  loop, at relative depth 1 from the `for (let s = 0; s < timeScale; s++)`, so the clock should
  advance `timeScale * dt` a frame and the slow advance is resets, not placement.

**The likely fix is to make the hold sticky once armed** — WRONG, see the measurement above: the
hold never flickered and `u.stopped` was never set in the first place — the way `u.stopped` already is — an
officer who has got out and started walking does not get back in because a wall briefly intersects
a straight line. That is a pursuit change with a gate to write, and `mutation-sweep` would need a
row proving the stickiness cannot become "held for ever", which is the defect the ratchet was
guarding against in the first place.

`boot-check`'s arm asserts the wire and PRINTS the rate rather than asserting the completion, with
a comment saying why: a check that cannot pass reliably reads as a defect in whatever ran last.

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

### #105 A PRICED REFUSAL — the run-over charge is correct, rare BY A DESIGN RULE, and a fix needs four undevived constants
Everything the entry measures reproduces and the conclusion changes. The feature is wired, gated
offline, and proven on the live page by `boot-check`'s run-over arm (which charges
`{kmh: 14.4, crime: "pedestrianHit", scale: 0.0073}` against its own staged victim, deterministic
over three runs). What makes it rare is `VictimWindow`, and that is a rule somebody chose:

    VictimWindow keys on the VICTIM ID ALONE, for 20 s — "one victim, one offence"

So a strike charges, and driving over the same body inside 20 s is a REPEAT and refused. A survivor
stands up in ~4.4 s, which is well inside the window, so the only chargeable body is one that does
not get up — a fatality, needing ~68 km/h — or somebody else's casualty.

**The cost of the refusal, which is what decides it:** round 11 measured `stats.runOverFrames`
(then `runOvers`) at **3,684 over a 10 km drive against 0 charged**. So in ordinary driving the
charge never fires. By this file's "a system that is never switched on is not a feature" that reads
as a defect — and it is not, because the window is preventing a DOUBLE COUNT of one collision: a
car that knocks somebody down at 40 km/h rolls over them in the same event, 4.4 s is the same
incident, and charging twice prices one impact as two crimes.

**And the obvious fix is refused by arithmetic, not by taste.** Keying the window on
(victim, crime) instead of victim would not help: `DamageModel.runOverCrime` returns
`pedestrianHit` or `pedestrianKilled` — the SAME crime ids a strike files — so the pair is
identical and the window still bites. Making a run-over chargeable therefore needs a NEW ROW in
the crime table, which is four numbers (`heat`, `min`, `cool`, `refractory`) nobody has measured,
on a case that is already reachable and already gated. That is the "do not move a figure your
instrument cannot resolve" refusal, arriving as a new table row.

Recorded with the numbers so the next round does not re-derive it. If it is ever taken, the thing
to measure first is how often a player runs over a body they did NOT knock down, because that is
the only case the window was never arguing about.

#### THE ORIGINAL RECORD
### #105 (as filed) The run-over charge is correct and almost unreachable (B#10)
Driving over the body you just knocked down at 14.5 / 22.5 / 32.5 / 47.5 / 58.2 km/h: `charged
false` 5 of 5, heat stays 1.0000, while the scale graduates 0.0074 -> 0.3191. Coming back 35 s
later: **vacuous 6 of 6, the body has got up.** The one route that works is kill at 75 km/h, wait
36 s, drive over the corpse -> `charged true`, 1 star. A body stands up in ~4.4 s and the per-victim
window is 20 s, so **a survivor can never be charged twice** and the only chargeable body is a
fatality needing ~68 km/h.

### #106 FIXED — Q while stopped hands the job back, and the lever was chosen by a price
Shipped in `c0384de`, with the probe that decided it in `4bd428c` and the host arm in `97fcabe`.

**The entry's two candidate levers were ARGUMENTS, and both lose to the defect they were meant to
fix.** `tools/abort-cost.mjs` prices every way out in one unit, by driving the shipped follower on
the shipped vehicle to each zone and stopping under `SCENE_STOP_MS` — which is the rule a pickup
already fires under, so the price includes the braking the player actually has to do:

    position in the job   back to own pickup   to the garage   wreck the car
    marlin-street  10%          8.0 s              13.3 s          13.4 s
                   25%         18.8                24.0            13.4
                   50%         16.6                22.3            13.4
                   75%         31.6                26.4            13.4
                  100%         43.1                37.9            13.4
    shakedown      10%          6.7                18.6            13.4
                   25%          7.9                17.3            13.4
                   50%          4.2                26.9            13.4
                   75%         10.3                32.7            13.4
                  100%         16.7                37.9            13.4

A geometry lever is cheaper than wrecking your own car on **5 of 10 sampled positions** and loses
by up to **24.5 s**. The wreck is reachable from anywhere, so a lever that loses to it does not
remove the inversion it exists to remove — a player who wants out still drives into a wall. **And
the third candidate was mine, added on the same kind of argument as the entry's** (the garage,
because `mission-test` already gates it 24 m clear of every mission zone and `composeGarage`'s
"stop here" is a cue precedent): it is the worst of the three at **1 of 10, by 0.1 s**.

So the key, at 0 s from every position in that table. `src/mission.js`'s `abortOffer` owns both
"may it be handed back right now" and the cue, from one comparison, so the prompt cannot advertise
a key that does nothing.

**The deliberate act is the pickup's own and needed no new constant:** the car stopped, under
`src/wanted.js`'s `SCENE_STOP_MS`, passed by the host exactly as `MissionBoard` and the garage
already take it. It is a safety property with a measured price — `KeyQ` is one finger from the
throttle and nothing undoes an ended mission — and `abort-cost`'s selftest puts the stop at
`(22 - 1) / 11.0` = 1.91 s derived against 1.85 s measured, against the wreck's 13.4 and 0 s from
a car already stopped.

**The cue needed no new HUD mechanism either.** `src/hud.js` has drawn a keyed `prompt` panel
since it was written and was fed exactly one string (`PRESS F TO ENTER VEHICLE`). It is a separate
band from the objective and the subtitle, so the cue competes with neither the mission's objective
nor the stage's authored line — which a band tenant would have done, and "a live scene takes the
objective band" is a defect class already removed here. The entry's "the HUD has no precedent for
a held-to-confirm input" was true and the wrong thing to look for.

**Two things the entry said that the round did not need, and one it asked for that still stands.**
The geometry argument ("where you took it is not somewhere a player who wants out is standing")
turned out to be true for a sharper reason than taste, and the held-to-confirm problem dissolved.
The playtest question — **is being unable to decline actually felt as a trap?** — is still the
right question and is NOT answered by this; it is round 11's, running against an isolated tree at
`c4cdac8`. The fix stands on the inversion being arithmetic rather than on the trap being felt.

**One consequence stated rather than discovered later:** a player being chased cannot satisfy the
stop rule without being arrested. That is coherent — you may not quit a job to escape the police —
and the arrest ends the mission anyway, so the exit exists in that case too.

Gates: `mission-test` 162 -> 194 (§14), `boot-check` +12 (a real `KeyboardEvent`, the prompt
panel's own DOM, and the host's two counters), `mutation-sweep` +7 rows, two marked `browser`.

#### And it found a second defect in the module, three lines from the rule
**My own justification for a guard was false and §14 caught it on its first run.** I copied
`pickupAt` and made a non-finite speed throw, reasoning it was free: "`MissionRunner.update`
already throws on a non-finite snapshot `speed`, so a NaN that kills the page here would already
have killed it there." That check sits behind `if (!this._checkedSnapshot)` and runs on the
**first frame only** — measured, one frame at 5 then the same snapshot with a NaN does not throw.
So the throw would have added a new way for one bad physics frame to end the session, in a
presentation path called every frame, for a value CLAUDE.md records as actually occurring.

The split that holds is **by what can be transient**: a non-NUMBER speed is a wiring error, caught
on frame 1, so it throws; a number that is not finite is a physics value, so the abort is refused
(the flattering direction) and `badSpeed` says so, with the host counting it — `stats.badScales`
and `stats.bustNoWalk`'s shape. `stopMs` throws whatever it is, because 1.0 is exactly the
`SCENE_STOP_MS` both hosts pass and a default would make an unwired host behave identically.

**And the gap it exposed is now an instrument.** The throw's own message says a NaN means "every
distance trigger would never fire", which is as true on frame 2,000 as on frame 1. `update` now
counts, per field, the frames a declared field arrived non-finite, and `report().nonFinite`
publishes it — a pure counter, no behaviour change, because a throw on frame 2,000 would be this
module's own clamp-dt argument upside down. A non-zero entry is the diagnosis for a mission that
dead-ended with every trigger false. The NaN is also excluded from `fieldRange`, which would
otherwise read min `-Infinity` for ever on exactly the run that needs it.

#### THE ORIGINAL ENTRY, kept verbatim, with its recommendation marked
Its diagnosis was exact. Its two levers were both refused by measurement, and the lever it did
not consider (the HUD's existing keyed prompt panel) was sitting in `src/hud.js` the whole time.

> Split out of #100 because the half that shipped a fix and the half that did not are different
> decisions. The conscription is gone — a pickup now needs the player stopped, measured at 0 starts
> over the 454 m trip that used to take the job 13.8 s in — so what is left is a player who stopped
> on a marker, took a job, and changed their mind.
>
> A measured it at HEAD and nothing about it has moved: 300 s parked mid-mission leaves `outcome
> running`, and **no `look()` field matches /abort|decline|cancel|abandon/**. The three exits are
> complete, wreck and arrest, and `district/main.js`'s `abortMission` hook is reachable only from a
> browser console — the same shape as `startMission` before #100's round, which a playtester called
> the finding that dwarfed its other eleven.
>
> So the cheapest way to decline a job is to **destroy your own car**, which #96 measures at a 13.4 s
> median. That is the optimal-play inversion this project has already removed once, arriving through a
> new door.
>
> **Two candidate levers, neither taken, and the reason is that neither is derived yet:**
>
> - **A key.** `src/input.js` exists and `abortMission` is already written, so this is a wire rather
>   than a feature. What it needs is a decision about which key and a cue, and the HUD has no
>   precedent for a held-to-confirm input.
> - **Re-enter the pickup to hand it back**, under the same stop rule, which needs no new input and no
>   new geometry. Checked for collisions, off the mission definitions: the closest any stage trigger
>   comes to its OWN pickup is `shakedown/b` at **72.5 m with a 24 m radius** — clear of a 12 m
>   pickup ring by 36.5 m — and the next closest is 162.5 m, so no stage could satisfy itself on an
>   abort zone. `shakedown`'s leg from `b` to `c` passes 58.6 m from its pickup in a straight line,
>   and the latch the board already has would stop a handed-back job restarting on the next frame. It
>   reads well as fiction too. What stops it being obvious is that it gives `marlin-street` an abort
>   zone 500 m from its own delivery point and `shakedown` one at the start of a 400 m walk, so
>   "where you took it" is not somewhere a player who wants out is standing.
>
> Worth one playtest question before either: **is being unable to decline actually felt as a trap
> once nobody is conscripted into it?** The finding was reported as a consequence of the
> conscription, not on its own, and this file already records a round that measured a saturation's
> cost before fixing it and found the player could not tell.

## AUDIT — five entries read OPEN and four of them were FIXED

Asked to keep going on the open issues, I picked **#95** ("4.8 km/h of forward motion makes you
permanently un-arrestable"), read the entry, and started deriving a fix. One `grep` for
`_recedingFrom` stopped it: the fix has been in `src/wanted.js` for some time, with the whole
derivation in its comment, three speeds in `wanted-test` and two `mutation-sweep` rows. **The
entry's heading did not say so, and the heading is all a round reads before committing to a
direction.**

So the remaining headings were audited against the source. Four of five were already shipped:

    #95   the bust reset needs moving AND RECEDING          `_recedingFrom`, gated, mutation-covered
    #99   a `status` tenant yields the headline             `status: true`, hud-cue's band ladder
    #101  a stage with a clock and no destination shows it  `unit: 's'`, mission-test §12, 2 rows
    #102  the fence line is signed on the nose              `noseOut ? 'reverse' : 'drive'`
    #105  the run-over charge is rare                       a PRICED REFUSAL, re-argued

Then the same pass over the rest, because a partial audit leaves the next round the same trap:

    #94   the chromatic third kept the pre-census band      a PRICED REFUSAL — only the floor is derivable
    #100  conscription + handing a job back                 FIXED BOTH HALVES, the second as #106
    #110  ambush's timeout is out of reach by parking       WORKING AS DESIGNED — and #101 put the
                                                            clock on screen, which this entry had
                                                            not checked: "LOSE THEM — 240 s"
    #111  seeking an arrest does not work                   WORKING AS DESIGNED, and the band says so

**Two of those changed meaning rather than status, and both because another entry's fix had
landed underneath them.** #110 reads as a trap only while the 240 s deadline is invisible, and
#101 made it visible; #100's second half reads as open only until #106 shipped. **An entry is not
just stale about ITSELF — it can be stale about a neighbour**, which is the argument for auditing
all of them in one pass rather than the one you happen to pick up.

Each is restated with the evidence and the original record kept verbatim underneath. #95's is
re-measured rather than asserted, because a symbol being present is not a fix working: the
playtester's own circle protocol now arrests **3 of 3 at every speed from 2.8 to 19.9 km/h** where
they measured 0 of 3 from 4.8 up.

**The shape is the one this session already found twice** — a stale `mutation-sweep` row covering
nothing, and a `lastOfferLine` holding the last value its branch produced. A record that reads as
open is the same defect as a check that cannot fail: both present as coverage of work that is not
being done, and both are silent until somebody asks. The difference is who pays — a stale row
costs a defect nobody tests, and a stale entry costs a round re-deriving a fix.

**So a backlog heading carries its status, and the cheap check before starting anything is a grep
for the fix's own symbol.** That took one command and would have saved the first twenty minutes of
this pass.

## PLAYTEST ROUND 11 — changing your mind about a job

One Opus playtester, blind, on an isolated copy of the tree at `c4cdac8`, briefed with the
scenario ("take a job, get into it, then decide you would rather be doing something else") and
NOT with anything this session had found. The brief did not mention aborting, a key, a zone or
the word decline. Their harness reproduced a 14-build prefix to `t = 38.13 s` byte-identical and
they ran one page arm on their own port with their own document root — the Captures trap, avoided
without being told about it.

**#106 was confirmed independently and blind, and the fix landed while they measured.** Their
tree predates `c0384de`, so "there is no cancel input" is correct for what they had and is now
false. Worth keeping because the confirmation is what a blind round is for:

    every key code the game reads, grepped    KeyW KeyA KeyS KeyD Space ShiftLeft ShiftRight KeyF
    gameplay callers of mission.abort          2 — the wreck and the bust
    player-facing strings matching
      /abandon|cancel|quit|give up/            0 of 31
    stationary mid-mission                     shakedown 300 s, marlin-street 560 s, still RUNNING
    on foot, 777.9 m from the car, 240 s       still RUNNING

**And their exit prices are TIGHTER than the ones #106 was decided on, in the direction that
strengthens the decision.** `tools/abort-cost.mjs` used #96's 13.4 s median for the wreck; round
11 measured the wreck from a committed mid-job state at **8.2 s** — nearest building 23 m, one
impact at 15.9 m/s, health 1.000 -> 0.000, `propertyDamage`, 0 stars, 4 s hold, replacement at
health 1.000 — against **41.6 s** to finish the job. Over 20 on-road sample points they wrecked
at 16 of 20 within 90 s, p50 **6.0 s**. At 8.2 s rather than 13.4 s, EVERY geometry lever in
abort-cost's table loses: the cheapest row was 4.2 s but the next three are 6.7, 7.9 and 8.0. So
the key is the right lever by a wider margin than the commit claimed, and the table's own figures
are understated against the shipped wreck.

Their end-to-end session: decision -> new job running was **69.8 s via the wreck** against
**122.5 s** by finishing first. And nothing persists — `MissionBoard.available()` filters on
`outcome !== PASSED`, so an aborted job is indistinguishable from one never attempted.

### #109 Two police cars stop 24 m away and nothing ever happens, 0.04 m from a road
Round 11's finding 4, which they correctly flagged as the one they most wanted checked. At
**(329.8, -92.2)**, stuck at every seed they tried: a unit `stopped` on 90-97% of frames and
`held` on **0%**, closest approach **24.1 m** — INSIDE `reachRadius` 28. What the player reads
over 120 s parked: two `enemy` blips at 24 m, **objective band `null` on 406 of 480 samples
(85%)**, the note cycling SEEN -> REPORTED -> EVADING with `evade` 0.00, 0 busts, 2 stars at the
end.

**Their guess was `_footPathClear`, labelled as a guess, and it is right — but not as stated, and
the difference is the whole mechanism.** Measured here:

    the NETWORK's best approach to that point      0.04 m, walk CLEAR, arrestSeconds 4.0
    seeds 0 and 11: the unit stops on edge 354    24.77 - 24.80 m, walk BLOCKED, held 0%
    seed 2:         a unit reaches edge 761       22.95 m, walk CLEAR, held true, BUST at 16 s

So the walk from the network's own best point is clear; the walk from the point the unit's
greedy router actually hands it is not. **The seed decides which edge a unit drives, and that
decides whether an arrest is possible at all.**

**This is #108's residual, arriving INSIDE the reach rather than outside it.** #108 made the
admission local — a unit stops where IT cannot get closer — and said in as many words that it did
not make the ROUTER better: "the router reaches a minimising edge 319 of 516 clear spots 30-140 m
off a road; it never does 197 of 516, 38%". Round 11's spot is **0.04 m from a road** and shows
the same failure, which no one had looked for there, because #108's whole frame was "a player far
off a road cannot be arrested".

Per #89's own ceiling argument a blocked walk is NOT a defect — "a player with a building between
them is not being held by anybody". What makes this one a defect is that a clear-walk position
exists 0.04 m away and no unit ever drives to it.

#### And the obvious lever is MEASURED, not deferred — `tools/router-lever.mjs`
CLAUDE.md: "'it perturbs a seeded stream' is a reason to measure, not a reason to defer." So it
was measured, offline, by walking the router directly with no physics and no seeds — #108's own
protocol. Score options by their closest APPROACH instead of their far ENDPOINT, which is the
quantity `_localBest` already computes:

    can ANY of a spawned fleet of 8 reach a stop point that arrests this spot?
    shipped, score by FAR ENDPOINT        1463 of 1636   89.4%
    candidate, score by CLOSEST APPROACH  1495 of 1636   91.4%
    newly covered 46 (2.8%)    LOST 14 (0.9%)    neither 127 (7.8%)
    mean steps to settle  12.4 -> 11.9, so the router is marginally CHEAPER

**A net +32 spots and +2.0 points, and 14 spots that arrest today would stop arresting.** #108's
own bar was "NOT ONE SPOT REGRESSED", so this does not clear it, and the reason for the
regressions says what a better lever would have to do: a descent on closest approach is myopic
about the FUTURE — it will take an edge that passes near the target and leads nowhere — where a
descent on the endpoint is myopic about the PRESENT. A blend needs a weight, and a tuned constant
with no derivation is what this project refuses. **So the lever works, its size is known, and the
obstacle is named. Not shipped at the end of a long session on a blend nobody has derived.**

**AND THE CONFIGURATION CHANGED THE CONCLUSION, which is why the probe is committed.** The first
version started each walk from 8 edges spread round the network and read **80.6% against 81.0%
with 47 spots LOST** — a reshuffle, and I nearly wrote the lever off on it. `_spawn` rejects any
point outside **70 to 260 m** of the target, so a real unit starts in a band AROUND the player
and walks a short way where a spread start set walks across the district. Using the module's own
`_spawn` moved the reading from "refuse the lever" to "the lever works and costs 14 spots".

One instrument note worth more than the finding: my FIRST probe of this read `_footPathClear`
clear on **1340 of 1340** spots, because it built `PursuitUnits` with no `clearAt` — and
`_footPathClear` opens `if (!this.clearAt) return true`, so the reach is 28 m straight through
walls. That is CLAUDE.md's `traffic-selftest` trap exactly, and the cheap proof is that the fix
changed the reading: with the predicate both hosts wire, 366 of 1309 in-reach spots (**28.0%**)
have a blocked walk, which reproduces this file's own recorded 27%.

### #110 WORKING AS DESIGNED, and #101's fix is what makes it fair — the clock is on screen
Round 11's measurement reproduces: entering `ambush` hands the player 2 stars via
`onEnter: { setWanted: 2 }` with no scene, so braking cannot cooperate, and parking is an arrest
after 14.0 s against the stage's `timeLimit` of 240. Three seeds, byte-identical.

**What makes it a design rather than a trap is that the deadline is VISIBLE**, which #101's fix
delivered and which this entry was filed without checking. Walked through the real runner:

    entering ambush   objective {"text":"LOSE THEM","distance":240,"unit":"s"}  -> "LOSE THEM — 240 s"
    t+ 60 s                                                                       "LOSE THEM — 180 s"
    t+180 s                                                                       "LOSE THEM — 120 s"
    t+239 s                                                                       "LOSE THEM —  60 s"

So a player on `ambush` is told they have 240 seconds and told to lose the police. Stopping during
a timed chase, with the clock counting down on screen, is the player declining the stage — and the
authored `dropHot` branch IS reachable by playing it (round 10 reached it at 237.9 s on 1 of 3
seeds). Nothing is 17x out of reach; one route to it is, and that route is "stand still while being
chased".

#### THE ORIGINAL RECORD
### #110 (as filed) `ambush`'s authored timeout ending is 17x out of reach by standing still
Round 11, three seeds, byte-identical: entering `ambush` hands the player 2 stars via
`onEnter: { setWanted: 2 }` with no scene, so braking cannot cooperate — and parking is an
**arrest after 14.0 s** against the stage's `timeLimit` of 240. So the authored
"out of time -> `dropHot`" branch cannot be reached by stopping; it needs 240 s of driving, which
is playing the mission rather than quitting it. Related to #101 (the 240 s clock has no
representation) and to this file's own "a system that is never switched on is not a feature",
arriving as a stage nothing reaches by the one route a player would try.

### #111 WORKING AS DESIGNED — stopping at your own scene is cooperation, and the band says so
Round 11's numbers are right and the behaviour is the rule. `SCENE_LEAVE_M` is 85 m and both
`pedestrianHit` and `civilianCollision` carry `scene: true`, so stopping inside 85 m of your own
scene latches `cooperated` and the bust then spares the job. Four park spots at 71 / 189 / 284 /
386 m from the body gave busts 1 / 0 / 1 / 0 with the job surviving every one.

**And the game says it in as many words**, which is what makes it a rule rather than a surprise:
`BUSTED  a unit held you for 4 s — released in 4 s (you stopped at the scene, so the job stands)`.
`composeLaw` is also the one place the game tells a player an arrest will not cost them the job.

Filed and kept because it removes the arrest from the list of ways out of a mission, which is what
#106 was choosing between — not because anything is broken.

#### THE ORIGINAL RECORD
### #111 (as filed) Seeking an arrest does not work, because stopping is "cooperating"
Round 11, measured. `SCENE_LEAVE_M` is 85 m and both `pedestrianHit` and `civilianCollision`
carry `scene: true`, so stopping inside 85 m of your own scene latches `cooperated` and the bust
then spares the job — the band says so verbatim: `BUSTED  a unit held you for 4 s — released in
4 s (you stopped at the scene, so the job stands)`. Four park spots at 71 / 189 / 284 / 386 m from
the body gave busts 1 / 0 / 1 / 0 with the job surviving every one. This is the rule working as
designed; it is filed because it removes the arrest from the list of ways out, which is what #106
was choosing between.

And they reversed themselves on it, with both readings recorded: from the one spot their prefix
stops at, 2 stars parked for 300 s never arrested, and they wrote "you cannot get arrested on
purpose at 2 stars by parking". Their own 20-point x 3-seed sweep refutes it — **arrested at 17,
19 and 19 of 20**, 8.8 to 51.5 s — and the spot they had was the exception. The isolation is the
valuable part: traffic, crowd, the running mission, the yaw and teleport-vs-drive are all null;
the **pursuit seed is decisive**, and the failure is bimodal (closest approach frozen at exactly
36.4 m, not a spread), which is #109 again.

### #112 Three host divergences the harness hides, found by round 11 reading both sources
Each is a case where a number taken from `tools/playtest.mjs` is about a game the page is not
running. CLAUDE.md already records the general form — "a gate that reproduces the host rather
than reading it cannot see the host being wrong".

- **`look().blips` overstates the page during a mission.** The harness lists `board.markers()`
  unconditionally; the page calls `updateOfferMarkers(!!missionHud)` and draws none. Measured
  mid-job: harness `["shakedown@43","garage@199","enemy@238","marlin-street@291"]` against page
  `ringsVisible 0 of 2`. **Any legibility claim made from `look().blips` while a mission runs is
  about a map the page is not drawing** — which is a caveat on several earlier rounds' findings.
- **`missionBoard().offerLine` is stale during a mission.** `lastOfferLine` is assigned only
  inside the `!missionHud && !wreckLine` branch, so with a mission running and the car **0.34 m**
  from `marlin-street`'s pickup it still read `SHAKEDOWN / stop to start` — a job 332 m away. Not
  player-visible (the band is `mission`), and a probe quoting it misreports which job the player
  is standing in.
- **The two offer gates differ on one case.** Page: `!missionHud && !wreckLine` with
  `wreckLine = mode === 'car' ? wreckState : null`. Harness: `!this.mission.hud() &&
  !this.damage.wrecked`. **On foot during the 4 s wreck hold the page runs the offer pass and the
  harness does not**, so a pickup can fire on the page and cannot in node. Source-read, not played.

### Round 11's own corrections, kept because they are the round's method working
- They read "a mission is running" off `mission.mission` being non-null and reported an arm as
  having started `marlin-street`. It had started it AND been arrested out of it 4.7 s later —
  `MissionRunner` keeps the reference after the outcome changes. This file records the identical
  error from `boot-check`'s own pickup arm; they found it themselves and re-ran everything.
- `followPath`'s `maxSpeed` is m/s, so their `maxSpeed: 12` was 43 km/h through Main @ Pineapple
  and picked up a star in 4 of 12 prefix builds. They flagged those strikes as their parameter
  rather than the game's difficulty.
- `_crime('pedestrianHit', 1)` is heat 2.00 and therefore 2 stars, where a real 29-40 km/h strike
  charges one. Their "1 star" and "2 star" sweep rows were the same arm, and they noticed only
  because the traces came back byte-identical.

### What round 11 could not resolve
Which column of `RESPONSE` makes 3 stars arrest where 2 does not at the same spot (the level moves
`units`, `speedMul`, `spotRadius` and `giveUpRadius` together and a scenario cannot vary them
independently); whether repeat wreck-cancels are penalised (their arm failed its own assertion —
wrecks stayed at 1 across attempts 2-4 — so it measured nothing, and the page's `LOOP_R`/`LOOP_S`
loop-breaker went unexercised); and the real 2-star clear-by-driving time, where their probe only
tests `stars === 0` at route-leg boundaries so 95.2 s is an upper bound at one-leg resolution, and
one seed's "45.8 s clear" was an ARREST clearing the meter rather than an escape.

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

**CLOSED. Both halves shipped, and the entry had already done the hard part: it named the query and
ruled out the wrong version of it.**

`PursuitUnits.bestApproach(target)` is the minimum over all 935 edges of the point-polyline
distance, cached per target position. A unit now clamps at its edge's closest approach when that
approach is within `reachRadius` **or when it equals the network's minimum** — because then routing
on cannot help. **No epsilon**: both numbers come out of `_closestOn` on the same target, and its
`d` does not depend on `forward`, so for the minimising edge they are bit-identical.

**The premise was already proved by the table above and nobody had read it that way.** Over nine
placements the closest a unit ever got ran 7.9 / 22.8 / 37.0 / 51.7 / 66.5 / 96.2 / 135.8 m against
a true road distance of 8.0 / 22.9 / 37.8 / 52.6 / 67.5 / 97.3 / 136.7 — **agreeing to between 0.1
and 1.1 m at every row.** The network's own minimum IS what the pursuit achieves.

`arrestSeconds(d) = max(BUST_HOLD_S, d / RUN_SPEED)` is the clock the entry derived, in
`src/pursuit.js` because that is the module that owns both constants and already multiplies them.
`src/wanted.js` takes it as `player.holdSeconds`, the way it already takes `player.held`.

`arrest-band` re-run, same tool, same protocol:

      placed   true road d   stars   units  held   seen%   closest   busts   ended
          0 m         8.0 m   4->0       6     1     97%     7.9 m       1    31 s  arrested
         15 m        22.9 m   4->0       6     1     87%    22.8 m       1    30 s  arrested
         30 m        37.8 m   4->0       6     1     84%    37.6 m       1    37 s  arrested
         45 m        52.6 m   4->0       6     1     83%    52.5 m       1    46 s  arrested
         60 m        67.5 m   4->0       6     2     78%    67.3 m       1    45 s  arrested
         90 m        97.3 m   4->0       6     2     80%    97.1 m       1    46 s  arrested
        130 m       136.7 m   4->0       6     2     96%   136.6 m       1    28 s  arrested
        180 m       185.9 m   4->0       6     3     15%   185.8 m       1    33 s  arrested
        260 m       264.4 m   4->0       0     0      2%       n/a       0   240 s  escaped

**"no stalemate row: every placement was either arrested or escaped."** Five stalemates became
arrests.

**One row changed that was not a stalemate, and it is a real cost: 180 m went from escaped to
arrested.** Its `seen%` went 2% -> 15%, because units now park at the best approach instead of
milling, so the player is in contact more often and the escape clock never completes. So the
"stand still and wait it out" escape boundary moved from about 186 m to somewhere between 186 and
264 m. Standing still while the police can see you and have parked as close as the roads allow is
an arrest now; the way out is to MOVE, which #95's sign fix already makes work.

**`pursuit-test` isolates the two levers, because there are now two and a two-arm table cannot say
which bought what:**

    nearest edge      n   LEGACY   +REACH   +NETWORK FLOOR
    0-8.75 m          8      7/8      7/8       7/8
    8.75-16 m         8      0/8      8/8       8/8
    16-28 m           8      0/8      6/8       6/8
    28-999 m          8      0/8      0/8       8/8

Each lever's contribution is explicit and neither undoes the other. Three checks there were
restated rather than loosened — "beyond the reach it is immunity in BOTH arms, which is the design
limit" was right about the build it was written for, and `reachRadius`'s own comment had predicted
this: "driving a hundred metres into open land is still immunity ... it needs police who get out of
the car, not a bigger number here."

**And the field was silently dropped on its first wiring.** `_sanitize` is a WHITELIST that copies
into one reused object, and `holdSeconds` was not in it: both hosts set it, `bindPursuit` passed the
object through unchanged, and `_watchBust` still read `undefined`. An arrest 508 m from the nearest
road took 4.0 s instead of 72.7. **Caught by `stats.bustNoWalk`, the counter added in the same
commit because the fallback is the flattering one** — and then nearly misdiagnosed: a probe
comparing `player === session._wantedPlayer` inside `_watchBust` read false and sent me looking for
a second caller that does not exist. `_sanitize` is a copy, not a different source.

Six mutation rows, and three of them are invisible to every behavioural arm: `bust-walk-dropped`
(the whitelist again), `bust-hud-floor` (a 19.5 s arrest counting down from 4) and
`bust-clamp-down` (a host able to shorten an arrest).

**And the first version of the clamp was a widening INSIDE the reach as well, which the claim for
the change said it was not.** `near.d <= this.reachRadius || near.d <= best` admits every edge at
or below the best approach wherever the network gets inside 28 m, so units clamped on edges they
used to drive past and the hold arrived sooner than before. `boot-check` went from 3 of 3 passing
at HEAD to passing about half the time — the garage's wanted-refusal arm parks a four-star car
12 m from a road and was being arrested mid-dwell, reading `[law] BUSTED IN — 4 s / drive` against
the `[garage] GARAGE / not while they are looking` it expects. Three baseline runs at HEAD passed
in 347-367 s, SLOWER than the failing runs at 272-283 s, so neither contention nor duration
explained it. The condition is `best > this.reachRadius && near.d <= best` now, disjoint by
construction, and `arrest-band` and `pursuit-test`'s isolation table are unchanged by the guard.

Three runs with the guard: **PASS 81 checks at 235 / 232 / 237 s, 0 failures**, against the flaky
tree's PASS / FAIL(6) / PASS / FAIL(6) / PASS at 272-283 s. The spread is 5 s and the cadence is
back, which is the second thing the guard restored — the failing runs were slower *because* the
early arrest was doing extra work in two arms.

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
