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
   *SHIPPED, and preferred blind in six pairs of six — see "Cars item 1" below: a ray-cast cabin
   puts the near windscreen's modulation inside the photographed band at noon AND night. The
   reviewer's "crude" list went into a v2 of the seats, which is out to its own blind review.*
2. **No number plates** — *partly done*, see below. Still capped by instanceColor.
   *The cap went with the paint-slot tint (#1). The rest SHIPPED 2026-10-15, pending its blind
   review:* the plate was the wrong shape as well as blank — 0.46-0.49 m by 0.13 m off the built
   buffers, aspect 3.7, a European plate — and it is a US plate now, 12 x 6 in, flat, rear only as
   Florida's are, on every fleet shell and the player's car. Its face is procedural on the plate slot
   (a top line, six characters either side of an orange emblem, a county line; a 3 x 5 font, per car
   by instance), four filtered samples a pixel, so a plate 16 m away integrates to the same face as
   one 6 m away (0.779 of the blank against 0.761) and no pixel there reaches a stroke's darkness
   (0.52 against 0.066 near); one sharp sample a pixel reads 0.346 and 0.050. `tools/car-detail`.
   *Blind review: the face in six pairs of six* (`docs/shots/blind-key-plate-plate0-plate-plate1.json`),
   found by the reviewer from a difference map before looking for it, confidence 4 on all three
   corridor pairs: "A reads as a real plate ... B is a featureless grey-white tag"; character rows
   33-41% darker than the blank in linear light, the emblem rgb 151,80,29, "it does not look pasted
   on" — darkening concentrated in the middle rows on every plate, and the deepest pixel 82-93% darker
   on a 22 px plate against 34-73% on the far ones, "what a filtered texture does as it shrinks".
   Untested by the frames, and said so: shimmer in motion, whether registrations differ, orientation.
3. **Tail lights are dark painted rectangles**, 1.11x the darkest paint on the same car.
   *SHIPPED 2026-10-15 with the headlamps, preferred blind in six pairs of six* — and the headlamps were the
   worse half. The cabin's blind reviewer measured a parked car's unlit headlamps as "flat white
   fields", 0.80 linear, 2.6x its sunlit bonnet: the colour, 0xf7fafe (0.953), was chosen while
   instanceColor multiplied every slot, to sit at "the body's own reflectance", and the paint-slot
   tint (#1) turned it into an absolute white panel on every car. #1's own entry warns about exactly
   that interaction; it arrived from the other side and nothing said so.

   A census of photographed lamps set the target (`reference/sarasota/lamp-census.json`, 13 rows and
   8 refusals, two rows re-run here to four places): unlit headlamps on white cars read 0.14-0.17 of
   the forward-facing paint beside them in sun and 0.21-0.53 in shade (silver 0.43, red 0.61, dark
   grey 0.98, no black car measurable), with internal structure p90/p50 1.7-5.0 (median 2.7) and
   10-30% of the lens over twice its median; tails on white cars 0.08-0.11, nearly uniform, a clear
   reverse insert the brightest part. And the census's reading of WHY a lamp stays bright in shade —
   its brightness is what it reflects, not the light on it — turned out to be the thing the first
   build of the face got wrong.

   The face is procedural on slots 4 and 5 in the fleet's frame (CAR_FRAME_Y lifts the player's car
   into it): a dark cool housing, two reflector bowls with dark projector cores and a light-guide strip,
   and on the tail a dark red lens with soft LED bars and a clear reverse insert whose EMISSION is
   masked, because a reverse lamp is not lit while a car drives forward. The first build drew the
   bright parts as diffuse albedo and the self-shaded front went black — the white paint beside it gets
   its brightness from a specular F0 of 0.5, and a diffuse reflector in shade gets nothing — so they
   are polished metal now, metalness 1 and roughness 0.16 set after three's own finish chunks.
   `tools/car-detail`, white car, this page's light:

                          flat lamp     face       census, white cars
       headlamp / paint     1.510       0.150      0.14-0.53
       p90/p50              3.13        4.04       1.7-5.0
       over twice median    30.0%       28.6%      10-30%
       tail / paint         0.174       0.096      0.08-0.11
       lit at night        0.949        0.949      the face does not put the lamp out
       reverse insert dark   0.0%       16.8%      of the lit tail under 0.3x its median

   *Blind review: the face in six pairs of six* (`docs/shots/blind-key-lamp-lamp0-lamp-lamp1.json`),
   confidence 4, 4, 5 on the corridor and 3, 3, 3 on fivepoints, where the lamps are 10-15 px. The
   reviewer named the term from a difference map — 5,100 px, 0.35% of corridor-noon — and the deciding
   measurement was one this round had not taken: **lamp over the same car's paint ACROSS THE HOURS.**
   The flat lamp climbs as the scene darkens, 2.56 / 3.74 / 17.71 on the nearest corridor car and
   5.0-8.7 / 10.9-16.6 / 12-33 on the fivepoints row, "so the lamp carries its own light"; the face
   holds at 0.44 / 0.29 / 1.17 and 1.35-2.16 / 1.96-2.59 / 1.94-2.12 while the scene's light falls
   about 7.6x, "which is how a lens lit by the scene behaves". So the flat build gave every
   front-facing parked car headlamps that read as switched on at dusk and night and lit nothing on
   the road — and the "glow" that made its bumper 3.5x brighter is the night bright pass taking a
   lamp-lit white face as a light source, which is #118's mechanism on a second subject. The lit
   lamps of the moving car are unchanged between arms (0.483 / 0.496 at dusk, 0.548 / 0.539 at night)
   and the road in front of the parked cars matches to four digits at every hour.

   **Its weaknesses, recorded rather than fixed:** the lens is a matte panel with no sheen beside paint
   carrying a sun glint (a clear polycarbonate cover is the missing term); the two dark bowls read
   "slightly like cartoon eyes" at 1x on the nearest car; on distant cars the bowls are drawn at a
   1-2 px pitch, a 12-level step inside the lamp against 0.4 on the paint beside it — "fine in a still
   but could shimmer in motion", and a still cannot test it. The reverse insert reflects the sky, so at
   dusk it is orange at 18-22x the paint and "at a glance could pass for a lit amber lamp".

   **Wrong in BOTH arms, filed below as #119 and #120:** upright glow BARS in front of the moving
   cars' lit lamps at dusk and night (a 165-180 luma plateau 20 px tall and 5 px wide before the red
   car's nose, a 10 x 21 px red bar with a hard top edge behind its tail), and amber blocks on parked
   cars' front corners at dusk and night only, 8.1-8.6x their surroundings, that read as lit
   parking lamps. Also a spot at the nearest corridor car's outer-lower headlamp corner at night
   only, 18.5-19.7x the paint, "the only lit thing on an otherwise unlit car", unexplained.
4. **Octagonal wheels** at 56 px diameter, and inconsistent between cars — one has a rim ring,
   another is a featureless black lump with no arch cut.
   *PRICED, not spent (2026-10-14).* The traffic wheel is `seg = 8` by design, 8*seg = 64
   triangles a wheel, chosen when the frame had 359 triangles of headroom and the hero framing saw
   wheels 38 px tall and end-on. #114's blind reviewer saw them again, side-on at fivepoints
   (1060-1105, 600-640). seg 12 is +32 a wheel, +128 a car, and both car pools bill at x2.00
   (CLAUDE.md, shadow-bill): **+15,360 in the budget gate's units** across 30 traffic and 30
   parked cars, seg 10 half that. The gate is over its warn and #64 — whether the warn is a
   capability bound or a frozen growth detector — decides whether that is affordable, so this
   waits on #64 rather than spending into it.
5. **No hard sun shadow from any car, at either hour.** Only an ambient blob.
6. **One tint for the whole street**: glass (B-R)/L of 0.527 / 0.629 / 0.404 across three cars.
7. **The fleet is too uniform**: six wheel centres within 1.1 px of one ride height, all
   parallel to the kerb, all wheels dead ahead.
   *Half stale, half priced (2026-10-15).* "All parallel to the kerb" predates the slot yaw: every
   parked slot already turns by `((h >>> 7) % 100 / 100 - 0.5) * 0.06`, +/-1.7 degrees off its kerb,
   from the slot's own hash. Ride height and steered wheels cannot vary per car: the four wheels are
   IN the instanced shell geometry, so lifting a car floats its tyres and no instance can turn its
   own front wheels — both want wheels as their own instanced mesh, which is a draw-call price
   against a frame at 169-186 of a 200 warn. A lateral spread of +/-12 cm off the kerb is free in
   triangles and was not taken: it re-seeds every parked position that boot-check's arms stage
   around, for a variation two pixels wide at the corridor camera's 8 m.

### Cars item 1 SHIPPED — a cabin behind the glass, and the far window is the street, not a surface
The reviewers ranked it first: "no interior behind any glass ... no seats, no headrests, no falloff".
And the number that says what is missing was already in the repo: a real windscreen's MODULATION
(p95/p50 inside the pane) is 1.56-2.25 off the reference photographs, the shipped one 1.20-1.28, and
#92's environment gain could not move it because a gain multiplies the whole pane.

**The cabin is a ray cast in the car material, not geometry.** Each glazing fragment carries a ray
from the eye, in the car's own frame (the camera carried back through the instance and mesh
transforms, per vertex), into a box set inside the glazing's own vertices; it exits through the
headliner, a door card, the dash top, the floor, or past the seat-back planes — rounded shoulders and
elliptical headrests, because hard rectangles read as blocks at 8 m — and the glazing's diffuse
albedo becomes what it hit, tinted by the glass. If it exits through the far window above the
beltline it sees the street: the environment's radiance along the view ray, times a transmission.
No triangle, no draw call, no texture; `uCabinGain` 0 is the old car bit for bit.

**The first version made the far window an ALBEDO, and the district said no.** Lit by the light
falling on the near pane, a sun-facing windscreen at noon and a lamp-facing one at night drove the far
window from the wrong light — night modulation 6.6 at the value that read best at noon — because the
light on the near pane has nothing to do with how bright the street behind the car is. As radiance
along the ray it is the street's, at every hour. Swept on car-pane's own near-windscreen box (8.6 m,
the reviewers' box), one page load, the negative-control body-panel box unmoved throughout:

                         noon med/paint  modulation    night med/paint  modulation
    cabin off                 0.263        1.257            0.044         1.374
    transmission 0.15         0.270        2.026            0.080         1.826     <- shipped
    transmission 0.30         0.270        2.952            0.061         3.652
    transmission 0.60         0.270        4.573            0.061         8.296
    real windscreens          0.137-0.333  1.56-2.25        (glass-census, photographs, noon)

0.15 is the one value inside the band at BOTH hours, and the median does not move at noon — the
structure is added without lifting the level the census already matched. At night the near
windscreen goes from 0.044 to 0.080 of its paint, which is #54's hole, smaller. The rear screen at
14.7 m goes 1.10 -> 1.32 at noon (still under the band) and 1.17 -> 1.71 at night.

**A preview page could not set the level, and saying so is part of the method.** `tools/car-cabin.html`
renders one car from three sides at street height against a PMREM gradient sky; with a light car
(glass/paint goes as 1/tone, and the census band is a light-car band) and the sky calibrated so the
cabin-off windscreen sat inside the photographed band, its glass still carried a modulation of
1.5-2.1 from the reflection alone, where the district's carries 1.20-1.28. So the preview is for
SHAPE — where the headrests land, whether the far window is there — and the level came from the
district. The first preview also had a sky brighter than the car (glass 0.6, a mirror) and a dark
car, and read the cabin as making the windscreen 4.5x brighter; a probe mode lighting one cabin
surface at a time is what showed the far window was most of the pane.

**The gate is that page**: `tools/car-cabin.mjs`, 2.8 s, 13 checks — the cabin reaches 90-98% of the
glazing in every view and moves no other pixel by more than 2 levels (13 one-level slivers on the side
view's roofline, edge-on glass the antialiased scene catches and the single-sample mask misses); the
interior alone and the far window alone each change the windscreen (2,196 of 3,283 pixels see through
the car); the PLAYER's body material, whose slot-10 texels are mirror glass, gets no cabin; and a row
with the car, the camera and the sun moved by one rigid transform matches its untransformed twin to 1
level on all 3,283 glass pixels, with the cabin-off half as the control. That last one is the only
check that can tell a cabin computed in the car's frame from one computed in world space, because
every car this page draws at the origin looks right either way and no car in the district is there.
Six mutation rows on the sweep's offline list, swept: **six of six caught**, and `cabin-eye-world` —
the eye left in world space — by `car-cabin` alone, which is that rigid-transform row earning its place.

**The blind review: six pairs of six, and the two things it found wrong are fixed.** One reviewer,
corridor and fivepoints at noon, dusk and night, the arms scrambled per pair (`docs/shots/
blind-key-cabr-cab0-cabr-cab1.json`). It preferred the cabin in all six — confidence 4 at corridor
noon and dusk, 2 elsewhere, where the cars are under 180 px wide — and recovered the assignment from
the data: the interior arm's signature is the same in every pair. Its numbers on the near-left
windscreen [250,625,350,680]: p95/p50 **2.00 against 1.20 at noon with the median unchanged**
(0.0850 against 0.0846), 1.73 against 1.35 at dusk, 2.07 against 1.19 at night; the same car's hood
byte-identical. Over 31 car-pane boxes the cabin arm is brighter in all 31, by 2-94%, and "between
18% and 81% of each pane is untouched, and the heat maps show those untouched areas are the headrest
and seat silhouettes". Its "still crude" list:

- *"flat, unshaded, hard-edged cut-outs: perfect discs for headrests"* and *"three equal-size
  headrests sit in one row across the near-left windscreen"*. v2 (`e6fc3f3`): each seat row is
  COVERAGE with an 18 mm soft outline, lit from above, and the rear headrests are smaller, lower
  and further inboard than the front ones; rows blend far to near so a soft edge shows what is
  behind it. Out to a v1-against-v2 blind pair.
- **"The stopped junction car's side windows are black voids" [500,559,522,566], sRGB (12,16,23),
  1/18 of a parked car's side glass in the same noon frame — in BOTH arms.** That car is the
  player's. Its panes are a separate mesh on `carGlassMaterial`, which still shipped as roughness
  0.045, METALNESS 0.88 — the "1% reflector" slot 10's comment records fixing for the fleet in
  round 9 — and the cabin went into the fleet's material and not this one. Fixed in `e6fc3f3`: the
  fleet's glass and the same cabin, read through `PLAYER_CABIN_Y = -CAR.ground` into the fleet's
  frame. The recurring shape, twice in one material: a fix applied to one member of a family and
  not its sibling.

**v2's seats against v1's, blind: v2 in six of six, at a margin a viewer barely sees.** The pair
was captured from a worktree carrying a temporary seat-version uniform that never entered history
(`docs/shots/blind-key-seat-seatV1-seat-seatV2.json`), AFTER #117's shadow fix, because the first
capture's ground shimmered 0.75-12% between arms from the player's car coasting behind the camera.
The reviewer recovered the assignment within each framing from the data — and assumed one build
carried the same letters in both framings, which the per-pair scramble does not do; mapped back
through the key, all six of their calls are v2. Corridor noon and dusk, the near car's windscreen,
at confidence 2: in v2 the middle shape is "smaller (19 px) and lower (top y631) than its
neighbours, so it reads as a rear headrest between the front two", where v1 "reads as three equal
heads in a row". The other four were forced at confidence 1. One cue went the other way: from
BEHIND, v2's nearer rear headrests are 14 px against the farther front ones' 16, which the reviewer
read as against perspective — true of the image and true of many real cars, whose rear headrests
are smaller.

**What both arms still get wrong, and it is the next round:** "The cabin silhouettes are perfect
circles on a flat slab ... parked cars look occupied by bald heads", the left one widening row by row
"3, 13, 17, 20, 23, 24, 26, 28 px: a circular arc. A real headrest is a wide, flat-topped cushion on
posts"; "no wheel, dashboard or pillar inside"; the windscreen reflection "reads 110-114 across
x255-390 at noon, with no sky or canopy in it", and at night "near-black, with no streetlight
reflections" — the sky-only environment, which is #36 and #54.

**v3 (`uCabinDetail` 1), against those findings, preferred blind on the one car that resolves it.** The headrests are
squircles — flat on top, square-shouldered, shallower — raised off their seat backs on posts (a 4 cm
gap at the front, 3.3 cm at the rear, the cue a head does not have); a steering wheel's rim and hub at
the driver's seat (+x: the car frame is +z forward and y up, so +x is the left, Florida's driver's
side), on a column pointing up and back so the dash plane already hides its lower half; and the
mirror's dark back, 25 x 7 cm, hung behind the screen's top. The four occluders are blended far to
near in one ordered pass, and at detail 0 the new two are never entered and the rows go in v2's order
with v2's arithmetic, so 0 is v2 exactly. Their edges are antialiased over a pixel at the hit's own
distance: one derivative at the glass, outside the branch, grown by (eye-to-glass + depth) / eye-to-
glass. On `car-cabin`'s new detail row (front three-quarter from the driver's side), v3 changes 379 of
3,283 windscreen pixels (11.5%) and nothing off the glass.

*Blind review, v2 against v3* (`docs/shots/blind-key-cdet-cdet0-cdet-cdet1.json`): the reviewer named
the variant correctly in all six pairs — "W" (a wheel ring with a hub on the driver's side, flat-topped
headrests, a bar centred under the screen's top "whose position and size fit an interior mirror")
against "N" ("dark hemispherical domes") — and preferred v3 in all three corridor pairs, confidence 3, 2
and 2: "A reads as an empty cabin ... B shows three dark round domes that read as heads". Fivepoints
went to confidence 1 three times, which is the honest answer at 16-99 px a car: "not separable at 1:1".
**So the win is real and small, and it rests on essentially one car** — the corridor's near-left
parked car, whose windscreen changed by over 4 levels on 837 pixels at noon and 661 at night.

**Its caveats are the next round, and the first is measured:** the wheel and the mirror read LIGHTER
than the cabin behind them, where real ones are dark — the ring 1.35x the area inside it at noon and
2.08x at night, the bar 1.42x and 2.42x — so they read as pale objects in front of a dark interior.
The mirror's tones are the reverse of a real one's, light from the front and dark from behind (from
the front a camera sees the housing; from behind, the glass). And from behind, v3 makes a car STOPPED
IN TRAFFIC read as empty where v2's dome "happens to read as a driver": the moving fleet has nobody
driving it, which no round has asked about.

**Both arms, from the same review:** a pedestrian behind the near-left car is drawn over its windscreen
"with none of the glass's reflection" and "a dark halo onto the glass" — 12-38 where the glass reads
about 110-154 — which is what an occlusion pass does at the depth step between a transparent pane and
what is behind it; a "brown smudge" round a white car's wheel arches (1060-1125, 585-625); the side
glass a flat pale panel at 2.91x the door below it; and the octagonal tyres, cars item 4.

**And the gate now compares the player's cabin with the coupe's**, whose greenhouse it shares to
4 mm, on the pixels that are glass in both: the change the cabin makes correlates at 0.980 (0.920 at
dusk), at x0.975 the strength, and with the cabin off the player's pane reads x0.894 of the coupe's.
"Most of the glazing changes" could not see a wrong lift — with `PLAYER_CABIN_Y` at 0, 77.7% of the
player's glazing still changes with its seats 0.717 m out of place — and the correlation reads 0.273.
Five more rows, five caught, all by `car-cabin`: the player's cabin off, its frame, its transmission
unwired (correlation −0.476), its glass back to the metal (x0.475), and the fleet's transmission row
repointed, because the player's material binds the uniform with the same line and the selftest's
"finds its target exactly once" said so.

**Both-arms findings from the same review, filed rather than taken here**: a parked car's
headlamps are flat white fields, 2.6x its sunlit hood at noon with no lens or reflector structure;
the number plates are blank fields; and noon canopy shade carries soft ~0.5 m squares that change
between two captures half a second apart, which is #117.

**v3.1: the three caveats as two exact switches, each blind-reviewed, and neither earns its default.**
Both off one page load (`tools/ground-albedo.mjs`'s `cfix0` / `cfix1` / `cdrv1`), six pairs each.

- *`uCabinFix`* — the wheel and the mirror's back on the DASH's albedo, the mirror's face from behind
  (`docs/shots/blind-key-cab31-cfix0-cab31-cfix1.json`). The reviewer recovered the partition by a
  sign test, 2,699 changed cabin pixels with no exception in any pair, and preferred the UNFIXED arm
  in corridor noon, confidence 2 — "its cabin holds a recognisable wheel; A's reads as glass with
  headrests and nothing else" — with no preference in the other five. **The fix does what it says
  and that is why it loses:** a wheel on the dash's albedo matches the dark cabin behind it, so the
  measured defect (the ring 1.35x its surround at noon) was the only thing making the wheel legible.
  It stays at 0; a wheel that is both dark AND legible needs something the cabin does not have — a
  rim catching the light through the glass — and nothing has been tried.
- *`uCabinDriver`* — a driver in the moving fleet and the player's car
  (`docs/shots/blind-key-cab31-cfix1-cab31-cdrv1.json`). The corridor's three pairs have no traffic
  car in frame and every car pixel identical, so they cannot show it. At fivepoints the reviewer found
  the driver arm in 3 of 3, by a cross-hour correlation on a stopped car's cabin (r +0.952 / −0.946 /
  −0.906; 30 pixels the same sign at all three hours for this partition against 0, 0 and 1 for the
  other three), and preferred it at noon (confidence 2) and dusk (1), none at night: "a car waiting
  at a light shows a driver; B's cabin is empty", and "invisible at 1:1 ... a featureless smudge".
  **It named its own confound:** the non-driver arm was shot first in every pair, so build and
  capture order are one partition. A direction, on about 45 px of one car. Held at 0 for the
  reviewer's own protocol: a traffic car stopped side-on within ~15 m at noon, with the order of the
  two captures alternated. It costs no triangle — two ray-cast ellipsoids in the cabin pass — so it
  is independent of #64's baseline.

  **RE-REVIEWED ON ITS OWN PROTOCOL, AND IT SHIPS AT 1.** `cabd-cfix0` against `cabd-cdrv0`: the
  driver alone on the shipped cabin, the player's car side-on at 11 m (`hero-shots`' `cabin` framing),
  noon / dusk / night, capture order alternated so the driver arm went SECOND at noon and night and
  FIRST at dusk (`docs/shots/blind-key-cabd-cfix0-cabd-cdrv0.json`). The head is about 60 x 50 px, so
  `blind-compare` was given `--roi 720,405,860,460 --min-signal 4`: the arms are not the same build
  twice (arm-diff max 144 at the car, every other band identical), they differ in one small object.
  The reviewer recovered the partition from a per-frame ratio — the cap of the head over the glass
  beside it, linear luma, 0.603 / 0.493 / 0.417 with the driver against 0.988 / 1.062 / 1.041 without
  — and preferred the driver at **all three hours: noon 3, dusk 4, night 2** ("someone at the wheel
  of a car stopped in the road, at a believable size and place ... the only thing in either frame
  that makes the side glass read as glass with a space behind it"). Preferred in both capture
  orders, so the confound the first review named is not what it was measuring. `car-cabin` now
  asserts the build ships the driver ON and the fix OFF — its rows set both switches themselves, so
  nothing else would see either decision reverted — and `cabin-driver-default` is that mutation.

  What it still gets wrong, from the same report: the head is an egg with a dead-flat hairline where
  the side glass's two tones meet (y 440 at noon) and no profile; at noon its upper half matches the
  glass above it to 3 levels, so it reads as a dark cap over a pale blob; at night it is visible
  only under magnification.

  **Both arms, from the same review**, most important first: the side glass is two flat painted
  tones with a one-pixel step between them and nothing reflected or seen through (at dusk a pale
  lilac 14x the door below it — #36 and #54's territory); the hero car shows no cabin at all side-on,
  where the parked cars behind it show headrests; the headlamp and tail-lamp pools are hard-edged
  car-width carpets with no visible source on the car; the tyres are near-black (p50 linear 0.0033,
  1/14 of the door) and the rims dark dishes with no spoke openings; low-poly facets show in the
  rocker and quarter; **the wing mirror shows its GLASS to a side-on camera** ([731,450,756,465],
  noon), where a real door mirror shows the housing — new, and filed below as #133; and, off the
  car, **the street-name blades are blank** ([1235,85,1495,210], noon), #134.

**Both arms, from these two reviews** — the glazing and the paint first, and each is a sighting of
something already numbered: the side glass a flat, pale panel at 3.0-8.8x its own car's paint
(p95/p50 1.05 against a canopy at 26.5) and paint like "satin clay", p10-p90 x1.25 on a bonnet beside
road at x13, which are #36 and #54; octagonal tyres, cartoon headlamps and a warm ring round the arches,
#125; three dusty pink or mauve cars in ten, which is #94's priced refusal seen from the street; the
night stars as glyphs, #124. And one that has now been reported three times and had no number: #130.

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

### #54 OPEN, detail recovered — car glass at night reflects a city with no lights in it, and its number was retired
The subject's figure — glass/paint **0.0225** in linear light at night — is one of the ratios
CLAUDE.md's "Two defects that each make the other worse" section RETIRES: the tone table moved 17 of
30 cars' paint by more than 2x, and every glass-over-paint ratio has the car's paint as its
denominator ("a glazing figure needs the car's TONE quoted beside it"). So the number is not
comparable with anything captured since, and re-measuring it needs a night capture whose subject tone
is KNOWN, which `__district.setCarTone` makes possible.

What is known about the cause: #92 raised the glazing's environment gain to 5 and that fixed the
DAYTIME floor; at night the environment the pane reflects is a dark sky, because "the lit
shopfronts reaching the environment" are something "a sky-only PMREM cannot carry" (src/carbody.js,
quoted in CLAUDE.md). So the lever is what the glass REFLECTS at night, not the glass — the same
family as #36, from the other end of the day. Still open; the 2026-10-14 #48 captures include night
frames of the shipped build that a re-measurement can start from.

#### THE ORIGINAL RECORD
### #54 Traffic-car greenhouse is a hole at night: glass/paint 0.0225 in linear light
`detail lost` beyond the subject line. Related to #92 and #36.

### #36 OPEN, detail recovered — building glass at noon is 1.30 B/R against a photographed 0.804, and the coating lever is exhausted
Recovered from PROGRESS.md's "Glass: bronze" round, which the backlog lost. On one detector over
**317 reference photographs** real glazing reads B/R **0.804** (stable 0.796-0.899 across all four
corridor legs). After that round's fix — the sun added to the wall opposite, the coatings re-authored
at constant luminance as a distribution — golden lands on the reference (0.819) and **noon still sits
at 1.298**.

Why it was not chased, in the round's own words: the coating lever is EXHAUSTED — the measured
response is `pane_BR ∝ coating_BR^0.68`, so closing noon by colour alone needs a district-wide coating
at B/R ~0.49, "uniform reflective bronze, hitting the number by flattening exactly the variety the
round was told to preserve". The real cause is that the glazing is a **stronger, cleaner mirror than
Sarasota's stock** (F0 0.22-0.30 at roughness 0.07-0.13, with no interior term on the facade atlas),
so it returns the sky's saturated blue where a real window shows a dark room. That is a
mirror-strength or interior fix, and it would re-open the earlier "every window is a flat dark fill"
finding — so the lever has to give a window something to show, not just make it darker. The cars'
live line item 1, "no interior behind any glass", is the same root on the other glazing.
(PROGRESS.md gives noon as 1.298 in its table and 1.299 in its text; 1.30 here.)

#### THE ORIGINAL RECORD
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

### #96 MEASURED — the direction is forced, the NUMBER is not available, and the binding derivation is unmeasured
**`tools/wreck-cost.mjs`, plus a blind review of the proposal on a frozen copy.** The entry below
records three candidate levers and says of the third that "there is no derivation available for a
number between 0 and 1, and anything under 1 risks the dead end this project has already removed
twice". Both clauses needed testing against the modules. The modules answer the second and refuse
the first in a way neither the entry nor the review expected.

**THE RESPAWN POINT IS REFUSED BY ARITHMETIC, and the entry's objection had the sign backwards.**
It worried that respawning at the garage "would make a wreck far out of town brutal". Route (c) is
route (a) with the drive to the garage REMOVED: a player who wants a repair wrecks the car and is
delivered to the garage repaired, skipping the one cost the garage exists to impose. Measured over
11 routes, the wreck is the cheaper repair on 11 of 11 — it does not reduce the inversion, it
MAXIMISES it, and hands over a p50 57.3 s drive for nothing.

    wreck pt    to garage   (a) garage healthy   (b) wreck today   (c) respawn AT the garage
    p50            655 m          57.3 s              8.2 s            50.3 s of driving back

**THE DEAD END IS A PROPERTY OF `wrecked`, NOT OF `health` — so a derivation exists.**
`enginePower` returns 0 only `if (this.wrecked)`; otherwise it bottoms at 0.25, and its own comment
says why: "never to zero while the car lives, because a car that cannot move at all is a mission
failure the player cannot see coming and cannot do anything about". A respawn clears `wrecked` by
definition. And `fireHealth` 0.12 is a hard FLOOR: at or below it the fire latch re-wrecks the car
in `fireHealth/fireRate` = 3.0 s, an infinite loop.

**THREE REVIEW FINDINGS, ALL REPRODUCED HERE INDEPENDENTLY, and the first retires my own headline:**

- **`enginePower` is a function of `regions.front`, not of health.** At health 0.130: all-front
  gives 0.2500, all-rear 1.0000, all-left 1.0000 (with steerPull −0.2500), spread 1.0000. So three
  of four geometries at that health hand back a car at FULL power, and `wreck-cost`'s x1.70 drive
  penalty is the ONE corner that does not — a ceiling, not an estimate. (The review's median-wreck
  distribution, 0.5356 of power and x1.20, is theirs: my own attempt produced **1 wreck from 1,576
  full-throttle runs** and is not a sample.)
- **0.13 re-wrecks.** The band between "free by construction" (`freeDv` 2.2 m/s, FMVSS 581, which
  `src/roadpath.js` also derives its crawl floor from) and "the fire latches" is **0.394 m/s —
  1.4 km/h**, confirmed to 0.001 m/s. At 0.20 that band is 8.1 km/h, 5.7x wider.
- **The shipped follower stalls at exactly the power floor.** Vertex 1961 → garage, 1049 m,
  bisected: arrives at 0.30 (143.1 s), 0.35, 0.40, 0.50, 0.70 and 1.00 — and is **STUCK at index 5**
  at 0.25. `src/vehicle.js` states the dependency itself: `reverseMax` "has to stay well above
  src/roadpath.js's reverse manoeuvre, which backs out of an unreachable aim point at 0.35 of
  throttle", and a respawn at the floor quarters the other factor in that product.

**SO THE NUMBER IS NOT 0.13, AND IT IS NOT ESTABLISHED AT 0.20 EITHER.** Two derivations were
offered and only one holds:

    the POWER margin   enginePower 0.30 needs front <= 0.8167, so health >= 0.1833     HOLDS
    the CONTACT margin fireHealth + severityFor(worst contact on a garage drive)       UNMEASURED

      the review  56 routes, 115 contacts   max 4.137 m/s  ->  health >= 0.1852
      mine        40 routes,   5 contacts   max 8.489 m/s  ->  health >= 0.4768

**2.6x apart on the input and on the answer, and the contact margin is the BINDING one.** With five
samples p95, p99 and max are one reading, so mine cannot bound a tail; and neither is a human
driver — both are the shipped follower's own line, which traffic, police, props and a player all
exceed. 0.20 clears a worst contact of 4.463 m/s and **nothing establishes that 4.463 is the
worst.** That is the reason not to ship, and it is not a reason either the entry or the review had.

**And my first version of that measurement read 0.096 m/s over 148 contacts**, in the flattering
direction: it never set `vehicle.blockers`, so `_collideBody` never ran, the car drove THROUGH
every wall, and what it logged was frame-to-frame velocity change from friction — "148 of 148 free
by construction" over a car that was never in contact with anything.

**THE BLAST RADIUS IS ENUMERATED and it is large**, which is the other reason to stop. The review
found, with file:line: `district/main.js:784`'s `bustWatch` calls `respawnCar()`, so the ARREST and
the WRECK share one function and a change there silently gives an arrest a car-damage penalty it
was never designed to have; `wreckFor = 0` runs at `:649` BEFORE `damage.repair()` at `:651`, so a
partial repair that does not clear `wrecked` is an infinite 4 s respawn loop; three
`healthBelow: MISSION_FAIL_HEALTH` triggers fire at 0.12, so a car handed back at 0.13 fails the
flagship's last three stages on any contact over 1.4 km/h; and `mission-test:694-721`'s check
**stays green while its stated REASON becomes false** ("the car wrecks, and respawnCar() repairs
it"), which is this file's "a check that states a false reason reads as coverage for it".

**AND THE STRUCTURAL HOLE NOTHING MODELS: the garage refuses a wanted car.** Once the wreck stops
being a repair, a four-star player with a damaged car has no repair in the game — the wreck was
that escape hatch. That is a design decision rather than a number, and it is the first thing to
settle, not the last.

**One record inconsistency fixed while here:** #96 prices the wreck exit at **8.2 s** and
`tools/abort-cost.mjs:71` at **13.4 s** ("5 seeds, median"). Same exit, 1.63x apart, and the
proposal quoted the smaller one — which flatters the inversion it is arguing against. `wreck-cost`
labels its 8.2 s as round 11's figure and says it needs a browser and is not re-measured there.

#### The original record, kept verbatim

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

### #107 PRICED AND REFUSED — the limit already exists, and filing `reckless` against it is a star every 18 s
**CLOSED BY MEASUREMENT, `tools/speed-limit.mjs`.** The entry below asked "should this district have
a speed limit", called the three candidate derivations unmeasured, and argued for one on the grounds
that `reckless` "never on its own makes you wanted". **Both of those are wrong, and the second one
is the answer.**

**The limit already exists.** `src/traffic.js:653` `_speedLimit(edgeIdx)` is a DECLARED limit per
road class, keyed off the baked graph's own `r` field, shipped since the fleet was:

    limit      km/h    edges   metres   share of network   classes
    15.5 m/s   55.8       79     6,061        13.7%        primary
    12.5 m/s   45.0      270     9,596        21.8%        tertiary, secondary
     9.0 m/s   32.4      233    11,566        26.2%        residential
     6.5 m/s   23.4      353    16,887        38.3%        service

So the entry's candidate 1 — "the traffic fleet's own distribution ... src/traffic.js owns it" —
understates it: the module does not merely have a distribution to be measured, it has a number the
district declares. Nothing has to be invented. **And `damage-test`'s pin said in as many words
"reckless driving, which has no speed limit to break", which was false for as long as it was
written** — corrected in place, with the reason the refusal still stands.

**The entry's premise is also false, and that is the whole of the refusal.** `FLOORLESS_CAP`'s soft
knee bounds each DELTA at 1; `reportCrime` does `max(heat + delta, c.min)`, which does not bound the
TOTAL at all:

    one reckless charge at scale 1      0.4000 of heat, 0 stars        the entry is right
    continuous charging                 ONE STAR at 6.1 s, heat 1.0920
    60 s of it                          heat 5.9900, five stars

**AND THE GATE FOR THAT ALREADY EXISTED, which is the cheaper half of this round and a correction
to the first version of this entry.** `wanted-test` §2 is titled "minor crimes accumulate" and has
asserted, BY NAME, since it was written:

    check('two reckless events are still zero stars', trace[1].stars === 0)
    check('three reckless events make one star',      trace[2].stars === 1)

So the entry argued from a premise a committed check refutes by name, and one `grep` for the crime's
name in `tools/` would have found it — the same command this file already prescribes under "a gate
that already priced a refusal is the thing to grep for before filing it again", which is how the
`damage-test` pin was found in the first place. **A grep that settles a refusal settles a premise
too.** I wrote the falsification up as a new measurement before running the sweep row that told me
otherwise; what this round actually adds is the break-even scale, the declared limit's per-class
table, and the price.

**The price, two protocols on one denominator.** The shipped follower on the shipped vehicle, 8
cross-district routes, 12,298 m, each sample scored against the limit of the road it is ON:

    planar speed                         p50 74.1   p90 76.3   max 76.3 km/h
    OVER its road's declared limit       79.5% of 7,506 samples
    excess when over                     p50 31.3   p90 43.9   max 52.9 km/h
    as a ratio of the limit              p50 x1.70  p90 x2.59  max x3.26

and the fleet, by a second protocol, over 5,969 car-samples:

    fleet speed                          p50 30.4   p90 45.8   max 62.2 km/h
    against its own road's limit         p50 x0.90  p90 x1.05  max x1.15   <- its jitter ceiling
    over the limit                       21.8% of car-samples

**The max of x1.15 is the by-construction check that validates the denominator**: `car.limit` is
`_speedLimit(e) * (0.85 + r * 0.3)`, so a correct reading cannot exceed x1.15 and does not. A
mis-keyed limit lookup is the one way this measurement could be wrong without looking wrong, and
that number rules it out. **So the declared limit IS this district's normal, the fleet obeys it, and
the player is the anomaly.** (The playtester's quoted p50 36 / p90 52 / max 64 reproduces at
30.4 / 45.8 / 62.2 — reproduce before quoting.)

**The decisive number is the BREAK-EVEN SCALE, 0.141.** `idleBleed` is 0.09 heat/s GATED on
`idleGrace` (2.5 s), so at `reckless`'s 3 s refractory it is live 16.7% of the time and sheds
0.0150/s. Bisected off the module, a charge under scale 0.141 can never reach one star however long
you speed. Both natural scale rules land 5-6x above it:

    excess / limit     median scale 0.696   p90 1.590   15.9 charges/min   ~1 star in 18 s
    excess / 10 m/s    median scale 0.868   p90 1.220   15.9 charges/min   ~1 star in 18 s

**And the tolerance degenerates.** The multiplier on the declared limit that would charge only the
worst 5% is x3.23 and the worst 1% is x3.26, against a measured MAXIMUM of x3.26 — past about x2.6
the tolerance is reading the autopilot's own 79.2 km/h cap rather than any property of the roads.
There is no multiplier that charges the worst few percent without charging almost nothing.

**So: a priced refusal, and its reason has moved.** It is not "there is no limit to break" — there
is one, derivable, per road class. It is that **`reckless` above the break-even is a punishment and
below it is a cue with no consequence**, and the thing this district is missing is the cue, not the
crime. Filing it needs a scale that stays under 0.141 by construction, which makes it a HUD
affordance rather than an entry in the crime table.

**One limitation stated rather than buried.** The follower is not a player: `followPath` caps at
22 m/s = 79.2 km/h and the car will do 140, so 79.5% is a FLOOR on what a human would earn, not an
estimate of it. The refusal only gets stronger if a human is faster.

`tools/speed-limit.mjs --selftest` is 10 checks in 1.3 s and is on the offline gate list and
`mutation-sweep`'s. Two rows, and **running them is what corrected the paragraph above**:

    bleed-ungated      caught by wanted-test AND speed-limit --selftest
    speed-limit-flat   caught by speed-limit --selftest ALONE

`bleed-ungated` removes the `idleGrace` gate, which moves the break-even 6x — and `wanted-test`
catches it with six failures, one of them named "heat holds during the grace window", a check on
that exact gate. So the new gate is a second reading of an already-gated quantity there, not the
only one, and the row's own comment said the opposite until the sweep ran. `speed-limit-flat` makes
every road a primary and is the row that earns the gate: invisible to `traffic-selftest`, because
the fleet still drives, still holds its lane, and its cars still never exceed their own x1.15
jitter ceiling — that ceiling being relative to whatever the limit returns.

**Two wrong instruments on the way, both of which printed a reassuring number, recorded in the
tool's own header:** a "net of bleed" column computed as `gross - idleBleed` that read -0.0567
heat/s beside a module-measured "1 star at 60.4 s" — a negative net cannot reach a star, and the
arithmetic column was the wrong model of a gated bleed; and percentiles of `cornerSpeed(local
radius)` over all 1,452 interior course points reading p50 110 km/h, p90 1,474, max 10,458, which
are the straights. A third read 0 car-samples and a NaN percentile because it put the player at
(1e6, 1e6) and `_spawn` rejects a start outside 70-260 m of the target.

#### The original record, kept verbatim

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

### #104 MEASURED — lane keeping is not the defect; 82% of it is corners the car cannot turn
**`tools/lane-keep.mjs`.** The entry below ruled out the crowd, the contact test and the router,
and concluded "it is `followPath` leaving its own lane", leaving lane keeping as the open item.
**Nothing had measured the cross-track error.** Measured, against the lane the follower is actually
tracking, over the shipped 3,264 m tour with body collision on:

    the car's CENTRE from its own lane   p50 0.578  p90 2.715  p99 4.004  max 4.411 m

and split by whether the course asked for a corner the car can take — `R_min(v) = 8.446 + 0.2826 v`,
which `roadpath-test` re-measures against `src/vehicle.js`:

    the course was TIGHTER than the car can turn   1582 samples  p50 1.266  p90 3.052   body past the lane 26.0%
    the course was within the car's envelope       1387 samples  p50 0.089  p90 1.298   body past the lane  6.4%

**411 of the 500 samples that put the body past the lane — 82% — are at corners the car physically
cannot follow. On course it can follow, the follower holds its lane to 9 cm at the median.** So the
lever is the course's corner geometry, not the controller, and CLAUDE.md already records why those
corners exist ("a graph junction is a point and a right-angle turn across it reads as 2 m") and
already derives the crawl floor as the response to them. The worst single sample is at a course
point of **R 3.7 m** at 23.5 km/h — less than half the car's standstill minimum.

**AND MORE SMOOTHING IS REFUSED, WITH A NUMBER.** `tour()` takes `smoothPasses` and ships 2:

    passes      0     1     2     3     5     8    12
    under    4.3%  4.4%  4.9%  4.7%  4.4%  4.4%  4.4%     of course points under R_min(0)
    p10 R     5.9   7.0   7.4   7.2   7.1   7.6   7.1  m
    blocked     0     0     0     0     0     0     0     points where the CAR BODY does not fit

Saturated, and **the shipped value is the worst of the seven.** Smoothing pins its endpoints and
redistributes a turn rather than widening it, so it cannot manufacture a radius the graph does not
have — it lifts the p10 corner from 5.9 to 7.4 m while pushing a few more points just under the
threshold, and 7.4 m is still under the car's 8.45 m minimum. It costs nothing in clearance (0
body-blocked points at every pass count), so the refusal is not a trade: it simply does not work.

**TWO INSTRUMENT ERRORS ON THE WAY, and the second is #104's own defect recurring inside the probe
written for it:**

- **A windowed nearest-point search snaps.** The first version searched ±60 points at 4 m spacing —
  ±240 m of course — and CLAUDE.md's "nine ways" #6 records a 180 m jump from exactly that wherever
  a route passes near itself. A snap UNDER-reports, which is the flattering direction. §0 now runs
  a ±8 window beside the wide one: they agree to 1 cm on **98.3%** of samples and the tight one
  reads marginally larger, so no snap is in play and the error stands.
- **Banding by the MATCHED point credits a straight with the exit of the corner before it.**
  Cross-track error at a point is caused by the geometry leading INTO it, so a car still wide from
  a junction is sampled where the matched point has become a straight:

        straight (R > 200 m)   by the matched point    p50 0.222   p90 1.893   max 4.349
                               by the preceding 40 m   p50 0.054   p90 0.815

  **That is #104's own classifier defect** — a threshold applied to the wrong body, which the entry
  below records as having inverted its own conclusion — and it is what made the straights look as
  though they had a tracking problem. The gate asserts the disagreement so the honest banding
  cannot be quietly dropped.

**And the two fractions are DIFFERENT QUANTITIES**, worth separating because they will otherwise be
quoted interchangeably: **4.4% of course POINTS** turn tighter than the car's standstill minimum,
while **53.3% of driven SAMPLES** sit within 40 m downstream of a corner tighter than the car's
envelope at its then-speed. The second is larger because one tight point taints the ten behind it
and because `R_min(v)` grows with speed — 8.45 m at rest, 12.37 at 50 km/h. The first is a property
of the course; the second is why the error is spread far wider than the tight points are.

**What is left, and where it belongs.** The residual on achievable course is 6.4% of samples with
the body edge past the lane at a p50 of 0.089 m, which is a real but small lane-keeping component.
The large half is the router emitting corners under the car's turning circle, and fixing that means
rounding junction turns to `R_min` — a change to `tour()` that moves what `route-drive` and
`drive-through` measure, so it needs a fresh baseline and belongs with **#64** exactly as the entry
below already said. `lane-keep --selftest` is 10 checks in 4.1 s, on the offline gate list and `mutation-sweep`'s,
with the smoothing refusal gated so the next round does not re-derive it.

**And the gate did not catch the mutation it was written next to, until it was run.** The first
version's checks were all RELATIONSHIPS — the forced band is worse than the achievable one, the
matched-point banding reads worse than the honest one — and `mutation-sweep`'s `corner-now`
(removing the corner-speed ceiling, so the car floors the throttle at full lock) makes every one of
them hold HARDER. Swept, it came back `roadpath-test route-drive playtest` and not `lane-keep`.
Measured both ways:

    forced band p90              3.052 shipped    7.065 under corner-now   x2.3
    forced band max              4.411            8.802                    x2.0
    forced, body past the lane   25.9%            42.1%
    ACHIEVABLE band p90          1.187            1.169                    unmoved
    achievable, body past lane   6.5%             6.5%     88 of ~1361 BOTH times

**The achievable half being byte-for-byte unmoved is the crawl-floor argument from the other
side**: the corner-speed ceiling is what holds the car near its lane at corners it cannot
geometrically make, and it does nothing where the course is followable. The seventh check bounds
the forced band's p90 at 5.0 — picked, in the middle of a measured 2.3x gap with nothing in
between, on a drive that reproduces p90 3.051808 to six decimals across runs because it carries no
RNG at all. It FAILs at 7.065 and PASSes at 3.052.

**And the tool ran its whole report on IMPORT**, so `import { drive }` printed forty lines before
the importer's first statement — three of my own probes did that while measuring this. Gated on
being the main module; a tool whose exports cannot be imported quietly is a tool nothing else can
build on.

#### The original record, kept verbatim

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

### THE AUDIT'S OWN INSTRUMENT, because grepping the headings over-reports by 3x
The convention this audit introduced keeps the ORIGINAL entry verbatim under a `#### ` marker
below the live one. So `grep '^### #'` counts every preserved record as an open item: run on this
file it returned **17** candidates where the answer is **4**, and two of the seventeen were the
`#109` and `#87` records sitting under markers one line above them. I then spent reads
re-auditing #109 and #112 against the source before noticing.

`tools/backlog-audit.mjs` is the version that respects the convention: it tracks whether the
nearest preceding `#### ` marker says "original record" / "kept verbatim", skips the headings
under one, and reports the live headings that carry no resolved status. **40 preserved records,
16 live headings, 4 without a status.**

**A grep is a measurement and this one had a denominator problem** — this file's own "count the
lines against the population before drawing a conclusion from them", arriving against its own
headings. Run the tool rather than the grep.


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
    #85   a pinned car rocks and the HUD says nothing        FIXED — composeStuck, gated 3 ways
    #87   driveTo wrecks the car in 200 m                    CLOSED BY MEASUREMENT

The four older entries left — #75, #64, #42, #48 — are parked by their own headings (a triangle
warn, a gate re-baseline, an unresolved gate verdict, and one explicitly "needs a reviewer not a
decision from me"), so they are genuinely open and correctly labelled.

**#87's audit produced a new measurement rather than just a status**, which is the argument for
re-measuring an old entry rather than grepping it: the wreck it was filed about is gone, and the
contact rate turns out to be NON-MONOTONIC in speed — 19 shunts at 22 km/h against 0 at 36.

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

### #109 SHIPPED — the lexicographic option rule is in, priced at 2 stalemates and +1.5 s
**`src/pursuit.js`'s `_chooseNext` is lexicographic as of `e32dd1d`.** "Prefer an option that gets
CLOSER to the player than where I already am; when none does, head TOWARD them" — two objectives in
priority order with no weight between them. What unblocked it was not a new lever but a corrected
measurement, below: the recorded price of "7 spots that arrest today would stop arresting" was one
spawn draw per spot, and five of the seven arrest under other draws.

    draws   expected coverage      never arrest under ANY draw
            endpoint      lex      endpoint  lex   REMOVED  CREATED
      3       88.7%     91.1%        135     107      30       2
      6       88.7%     91.2%        122      99      25       2

**The 2 it creates are (93.4, 357.4) and (155.4, −363.3)** — the same two a separate per-spot
re-draw named on different seeds, so they are a known residual rather than a future discovery.

**And the time it costs is +1.5 s at close range, not the +4 s one seed said.** `arrest-band`
hardcodes `seed: 3` and reads 31 → 35 s on its two closest rows. Paired over six seeds at the same
deterministic spot (the longest non-service edge's midpoint, so only the pursuit's spawn draws
vary):

    off-road   shipped mean   lever mean   cost
       0 m        26.2 s        27.7 s     +1.5
      15 m        25.2 s        26.7 s     +1.5
      30 m        22.3 s        22.5 s     +0.2
      60 m        28.2 s        28.2 s      0.0   byte-identical, all six seeds

**24 of 24 arrest under BOTH rules.** Seed 3 is the worst of the six, which is the figure a
single-draw instrument reports — the same lesson as the coverage metric, arriving as the COST
rather than the benefit. The probe reproduces `arrest-band`'s own 35.0 s at `arrest-band`'s own
seed, which is what says it measures the same thing.

**THE RULE SHIPPED WITH NO GATE AND THAT IS NOW FIXED (`43a5342`).** Measured rather than assumed:
the endpoint-only rule it replaced passes §1–§9 of `pursuit-test`, `arrest-band` with **identical
coverage** (same 8 arrest distances, same escape at 264 m, still "no stalemate row"),
`playtest --selftest`, `wanted-test` and `boot-check` at its full 103 checks. The effect is a
statistic over 1,636 spots and no gate asserts a statistic, so `pursuit-test` §10 asserts the RULE:
it hunts the real network for a junction where the two rules disagree (edge 13 fw true — approach
18.38 m against the endpoint pick's 35.60 m, from 35.60 m), checks the module takes the improving
option, and checks the fallback's own case where nothing improves (edge 0 fw true → edge 692, with
`stats.approachPicks` holding). `router-endpoint` is the mutation row.

**And the first attempt to ship it failed for a reason that was not the lever.** `pursuit-test` §4
failed at 4.12 m, I assumed a re-baseline, and it was a pre-existing unbounded station-keeping
teleport that HEAD reproduced **larger** (5.65 m, seed 3, edge 100) — fixed in `d45da65`, after
which the lever passes 48/48 three times. CLAUDE.md's "a regression that appears in a module you
did not touch is evidence about coverage, not about your change", and the newly-visited case was
never right.

**The residual is greediness, not the objective**, which is why 2 is not 0 — see the original entry
below. Reaching zero wants a different KIND of router.

#### The original record, kept verbatim

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
own bar was "NOT ONE SPOT REGRESSED", so this does not clear it. The reason: a descent on closest
approach is myopic about the FUTURE — it will take an edge that passes near the target and leads
nowhere — where a descent on the endpoint is myopic about the PRESENT.

**A THIRD RULE IS BETTER THAN BOTH AND NEEDS NO CONSTANT.** A blend would need a weight, which
this project refuses; a LEXICOGRAPHIC order does not — "prefer an option that gets CLOSER to the
player than where I already am; when none does, head TOWARD them". Among improving options it
descends the approach; with nothing improving it falls back to the shipped rule, which keeps
making geometric progress and cannot stall:

    rule                                     covered        newly   LOST   mean steps
    shipped, far ENDPOINT              1463 of 1636  89.4%      -      -        12.4
    candidate, closest APPROACH        1495 of 1636  91.4%     46     14        11.9
    candidate, LEXICOGRAPHIC           1497 of 1636  91.5%     41      7        12.1

Best coverage of the three, **half the regressions**, same router cost.

**And it is still not zero, which LOCATES the cause.** The lexicographic order cannot be accused
of choosing the wrong objective — it only ever prefers an option that genuinely improves the
approach. So the 7 remaining losses are the price of **GREEDINESS, not of the objective**: a local
improvement can still lead into a worse local minimum, and no ordering fixes that when the router
commits to one edge at a time with no lookahead. What would reach zero is a different KIND of
router — a search over the option tree, or Dijkstra on "best approach reachable from here" — which
is a different module and a different cost. **That is more useful than either candidate's
percentage.**

So: the lever works, the best shape of it is known, its price is 7 regressions for 41 gains, and
the residual is named. Taking it means re-baselining `pursuit-test`, `arrest-band` and
`boot-check`'s arrest arms, because it perturbs the seeded pursuit stream.

#### RE-MEASURED: the price is 2, not 7, and #108's bar was never the bar it looked like

**Every number above is ONE SPAWN DRAW PER SPOT.** `router-lever` built a single `PursuitUnits` at
seed 0 and took one 8-start draw per spot — so a binary coverage metric conflated **CANNOT be
arrested** with **WAS NOT, on that draw**. And #109's own recorded mechanism is seed dependence:
"seeds 0 and 11: held 0%; seed 2: a unit reaches edge 761, BUST at 16 s", for a single spot. A
parked player gets many draws as the fleet respawns.

`router-lever --draws N` is the paired re-draw. Of the 7 single-draw "losses", re-drawn 10 times
each at seeds 100-109:

    spot                 endpoint    lex     a real stalemate?
    (  93.4,   357.4)      10/10    0/10     YES
    ( 723.0,   236.2)      10/10   10/10     no — it was one unlucky draw
    ( 155.4,  -363.3)      10/10    0/10     YES
    ( 126.4,    78.9)      10/10    7/10     no
    ( 713.1,    40.7)      10/10    3/10     no
    ( 499.6,    28.1)      10/10    7/10     no
    (-556.5,  -486.7)      10/10    9/10     no

**Five of the seven arrest under other draws.** And over every spot:

    draws   expected coverage      stalemates: never arrest under ANY draw
            endpoint      lex      endpoint   lex    REMOVED   CREATED
      3       88.7%     91.1%         135     107       30        2
      6       88.7%     91.2%         122      99       25        2

**The CREATED count is 2 at both draw counts, and they are the SAME two spots the per-spot
re-draw named, on different seeds** — three measurements, two protocols, one answer. The
absolutes fall as draws rise, which is exactly right: a bigger sample has fewer spots that merely
never came up. **The DIFFERENCE is the trustworthy half, because this is a PAIRED design** — both
rules walk the same starts from the same draw — so the comparison survives a sample size the
absolutes do not.

So the trade is **25-30 stalemates removed for 2 created**, expected coverage **+2.5 points**, and
per-spot arrest probability better on 89 spots and worse on 21, **4.24:1**. The router stays
marginally cheaper.

**And #108's bar was measured the same way, so it was never the bar it appeared to be.** "NOT ONE
SPOT REGRESSED" was a statement about one draw per spot; the quantity that means what it says is
"how many spots can never be arrested at all", and the lever moves that from 122 to 99. The bar
is worth restating rather than re-applying, because a change that removes 25 stalemates and
creates 2 is a different kind of proposition from one that regresses 7 with no compensating
measurement.

**Still not shipped, and the remaining cost is unchanged:** taking it re-baselines `pursuit-test`,
`arrest-band` and `boot-check`'s arrest arms, because it perturbs the seeded pursuit stream. The
2 created stalemates are named above so that a build taking the lever can assert them rather than
discover them.

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

### #113 FIXED — a police car keeping pace alongside could arrest you at 76 km/h
Found by `tools/clear-time.mjs` on its first real drive, measuring round 11's third question: a
2-star chase, the follower accelerating away from 14 to 21 m/s, BUSTED at 7.8 s. Frame by frame:

    unit 7.3 m away closing to 2.5 m, `held` on every frame, bustFor 0.04 -> 3.97 s, busted at 76 km/h

**Two correct rules meeting.** `src/pursuit.js`'s stop clamp keeps a STOPPED unit at the player's
projection on its edge, bounded only by the unit's own driving speed (22 m/s at two stars), so a
stopped unit paces a player driving along its road — inside `holdRadius` it is `held` with no walk
test. And `_recedingFrom` reads the player's velocity along the unit-to-player line, about zero for a
unit pacing on a parallel line, at any speed. So the bust clock ran while the player drove away.

**The quantity is the player's GROUND speed.** Relative to a pacing unit the player is stationary —
exactly what the clock exists to arrest — and what makes the arrest impossible is that an officer on
foot would have to run at the car's speed. `ARREST_PACE_MS` is that pace, `RUN_SPEED` (7.0 m/s),
restated in a module that cannot import three.js and pinned equal by `wanted-test`; at or above it
the clock resets, below it nothing changed.

    arrests above the officer's 25.2 km/h pace, clear-time's 160 chases   before 25 of 137   after 0 of 136
    the fastest arrest                                                    before 56 km/h     after 24 km/h
    escapes                                                               before 23          after 24

The escapes barely move — those chases now end in a slow arrest about 10 s later — which is the
point: the fix does not make the police worse, it makes the arrest physical. The PRICE, stated: a
player circling above 25.2 km/h near a unit is no longer arrested by this clock (`wanted-test` §d2
pins it at 0); that is the rule's own physics, and it is not an out, since a player in sight of a
unit cannot shed a star. `response-iso`'s outcome table — 160 stationary runs — is identical before
and after, to the second, as it has to be: a parked player never reaches the pace.

**A mutation row had described this defect as a mutation.** `bust-any-speed`'s comment read "a unit
that pulls alongside on a straight busts you at 70 km/h" — true of the shipped build since #95 made
the reset `moving && away`. It was caught all along, by `wanted-test`'s radial DRIVING AWAY arm, a
different geometry, so the sentence read as covered. Every §d2 arm parked the unit at the origin;
`drive()` takes a unit path now, and the paced arm is the catch the row was always described as.
`bust-outrun` is the new row; all four `bust-*` rows are caught, three by `wanted-test` alone.

### #112 FIXED (all three divergences) — and its "four highest-heat crimes" sub-entry too
Audited against the source rather than re-derived, which is this list's own standing lesson:

    look().blips overstates the page during a mission   playtest.mjs gates _offers on mission.hud(),
                                                        with a playtest --selftest check that asserts
                                                        BOTH directions (the offer blips go, the
                                                        garage survives, they come back)
    missionBoard().offerLine is stale during a mission   district/main.js:2275
                                                        `if (missionHud || wreckLine) lastOfferLine
                                                        = null;`, commented "which is #112"
    the two offer gates differ on the wreck case        playtest.mjs:708 carries the mode term,
                                                        `!(this.mode === 'car' && this.damage.wrecked)`
    the four highest-heat crimes have never been played ONE of the four was an instrument gap and is
                                                        closed: the contact pass iterates
                                                        `_unitPositions()` and files IMPACT.police.
                                                        The other three are priced refusals
                                                        `damage-test` already pins.

**Round 11's own "could not resolve" list below is ANSWERED**, each by a committed probe that varies
one term — and the third question turned out to be hiding a defect, #113, which is the useful half.

#### THE ORIGINAL RECORD
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

### ANSWERED — what round 11 could not resolve, one term at a time

**Which column of `RESPONSE` makes 3 stars arrest where 2 does not: `units` and `cooldown`, two
mechanisms, and nine of the eleven columns do nothing at all.** `tools/response-iso.mjs` replaces a
session's table (`wanted.js` reads `this.response`) and swaps one column of one row, both ways, on
the cases where the levels disagree. Stationary and braked, 20 spots x 4 seeds, 240 s:

    2 stars   arrested 77, escaped 2, stalemate 1 of 80
    3 stars   arrested 79, escaped 0, stalemate 1 of 80     3* arrests where 2* does not: 3; the reverse: 1

    spot 15 seed 4   2* stalemate, 3* A11    lift `units` -> A12; drop `units` -> stalemate   units alone
    spot 6  seed 4   2* E44,       3* A119   lift `cooldown` -> A58; no single drop flips it   cooldown alone
    spot 6  seed 3   2* E31,       3* A61    no single lift; drop `units` -> E66, `cooldown` -> E85   both

So "3 stars arrests where 2 does not" is two different things: a second pair of units is a second
chance to reach an arresting stop point (the stalemate case — #109's bimodal router, again), and a
26 s cooldown keeps the level up long enough for an arrest that an 18 s one lets the player ESCAPE
first. `speedMul` changes every trace and no outcome. The other eight — the spawn band, the give-up
radius, intercept, aggression, search growth, the spot radius and the siren — leave the trace
BYTE-IDENTICAL in every case, which is district/main.js's comment that the shim does not honour the
spawn band or the intercept roles, measured. The controls hold: 2 stars carrying row 3 entire
reproduces 3 stars byte for byte in 3 of 3, and an identity table changes nothing.

**Whether repeat wreck-cancels are penalised: yes, by two mechanisms, neither of them designed as a
penalty.** `tools/wreck-cancel.mjs` takes a job, wrecks out of it, drives back and retakes it, four
times, and asserts every attempt is exactly one wreck (round 11's arm failed that and measured
nothing). Bare world:

    marlin-street   cycle 14.3 s, 64.5 s, 11.7 s, 27.9 s     heat 0.89, 0.90, 0.90, 1.24 -> ONE STAR
                    attempt 2: loop-breaker fired, respawned at the district spawn 354 m from the pickup
    shakedown       cycle 20.3 s, 27.0 s, 45.9 s, 43.1 s     heat 0.90 each, 0 stars; breaker fired on
                    attempt 2 too, but this pickup is 30 m from the spawn, so it cost nothing

Each wreck files `propertyDamage`, which the soft knee holds under one star; two inside the idle
bleed's reach are a star, and attempt 4 on `marlin-street` came 11.7 s after the last. And the
loop-breaker — written for a car that wrecks ITSELF on respawn — reads a player wrecking on purpose
near one pickup as the same sequence and sends the replacement to the spawn. Both are working as
specified. Neither matters much since #106: `Q` hands a job back in 0 s. **The three seeds were
byte-identical, and that is not the seed defect**: in a bare world the seed reaches only the
pursuit, which does not exist until a star is up — so it is one deterministic measurement, reported
as one.

**The real 2-star clear-by-driving time, read off the module's own `clear` event at physics-step
resolution with the reason attached** (`tools/clear-time.mjs`; the shipped follower at 22 m/s, 10
spots x 4 seeds, 300 s, two destination policies, a bare world and the shipped one):

    bare     far    escaped 11/40   p10 37.5   p50 55.2   p90 100.9   max 194.0 s
    bare     away   escaped  8/40   p10 30.0   p50 50.0   p90  72.6   max 122.0 s
    shipped  far    escaped  2/40   p50 43.7 s
    shipped  away   escaped  3/40   p50 30.0 s
    the floor: 18 + 12 = 30 s out of contact, and no escape beat it

So the escape that happens is about 50-55 s in the bare world, and round 11's 95.2 s upper bound was
the end of whichever leg it cleared in. **But most drives do not escape at all: 29-38 of 40 end in an
arrest**, now at a median 3 km/h — the follower crawls through tight corners at the 2.2 m/s floor
and a unit alongside takes it there, which is within the rules. The follower is a floor on a human's
driving, not on their judgement; a human does better and the column says how much better is needed.

**And before f0ac12f, 25 of 137 of those arrests were made with the car above an officer's running
pace, at up to 56 km/h — see #113.** Round 11's "one seed's 45.8 s clear was an ARREST" was a drive
that got arrested, and it was read, correctly, as an instrument error; nobody asked why a DRIVING
player had been arrested, and the speed at the arrest — the number that would have said — was not
recorded.

#### THE ORIGINAL RECORD
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

#### AND ITS STRONGEST PHRASE IS THE SEED DEFECT'S SIGNATURE
"**Identical in all five seeds**" is what `Session` not passing its seed to `Traffic` produces.
The fleet fell through to `Traffic`'s own fixed default for every seed, so five seeds held one
fleet and varied only the crowd and the police — and an arm driving a fixed route past traffic
has little else for the crowd to change. Stated as a conditional because the reviewer's code is
not in the tree: **if they used the shipped harness's `Session`, their five seeds were five
replicates.**

So the refutation's two supports are both weaker than they read. Its own caveat already said the
lift rule fired on 3% of frames; this says the agreement across seeds is not evidence of
robustness either. **The conclusion may well be right** — 2 rams either way is a small effect
to begin with, and #87's own 16-fleet sweep puts the base rate at about 0.3 cars per 350 m — but
it is one fleet's answer, and re-running it is now a one-line change.

#### RE-RUN ACROSS 16 REAL FLEETS: THE REFUTATION HOLDS, AND MORE STRONGLY THAN IT DID
`shunt-rate --b11`, same pair, 43 km/h, the seed now reaching the fleet so these are 16 fleets
rather than 16 replicates:

    arm        cars  frames   contact   health   m driven  arrived   lift fired
    ignore        1       6   1 of 16   0.9595        457    16/16   n/a
    lift 25 m     1       6   1 of 16   0.9784        388    13/16   22.5% of steps

    paired per fleet: worse on 1, better on 1, LEVEL ON 14 of 16
    deltas:           0 0 -1 0 0 1 0 0 0 0 0 0 0 0 0 0

**And the one column that LOOKS like it supports round 8 is a rate built on a single event.** Per
kilometre the arm reads **0.137 cars/km ignoring against 0.161 lifting off** — lifting off worse,
which is round 8's direction. It is the SAME ONE CAR divided by two different distances: 1/7.31 km
against 1/6.21 km. A ratio whose numerator is 1 is not a rate, and this is the shape this list
already records as "a check whose two sides are both zero", with the zeros replaced by ones.
Printed because leaving it out would hide the exposure difference, and annotated because printing
it bare would read as evidence.

**What IS a real cost of the lift rule: it stops the drive finishing.** 13 of 16 arrived against
16 of 16, and 6.21 km driven against 7.31. So the honest summary is that lifting off buys no
reduction in contacts, costs 0.019 of health in the good direction, and fails to complete the
route three times in sixteen — which is a reason not to use it in a harness, and not the reason
round 8 gave.

**And it answers the review's own caveat rather than inheriting it.** Their lift rule fired on 3%
of frames, which is why they called it weak evidence about braking. This one tests every direction
rather than only ahead and fires on **22.5% of steps — 7x more active — and is still null.** A
rule that intervenes on nearly a quarter of the drive and changes nothing is a much stronger
statement than one that barely engages.

Two honest limits. **The base rate is the binding one:** 1 contact per 16 drives means this pair
could not detect a doubling, so the result is a bound rather than a demonstration of equality —
and that bound is what matters, because round 8's claim was a 6-against-0 difference. And the lift
arm drives slower, so it completes fewer routes and has less exposure; the first printing of this
table labelled a column "m driven" that was really `driveTo`'s ROUTE length returned only on
arrival, which reads 0 on a timeout. `drive()` returns the odometer now and the arm prints the
arrival count beside it.

Reconciling the units: B#11's "2 rams" is the FRAME counter, so at the ~6 frames per car measured
here it is well under one car — which is why two arms of a real comparison both read 2. Their
1.98 rams/km in frames is the same order as the 0.16 cars/km here once converted. **The two rounds
never disagreed; one of them was counting frames.**

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

### #87 CLOSED — the "contact rate" was a frame counter AND the seed never reached the fleet
The entry's own next step was "hold the fleet's speed multiplier and sweep the player's, which
separates 'matches the flow' from 'is simply slow'". Run, in `tools/shunt-rate.mjs`, together
with the two arms it needed. **The headline number was not a rate and the guessed mechanism is
backwards**, and neither of those needed the isolation to see.

`stats.shunts` counted FRAMES. `hit()` has no per-car refractory, both hosts call it once a
frame for the worst contact, and it applies a shunt whenever the delta-v clears `SHUNT_MIN_DV` —
so a player leaning on one car counts once a frame. Reproduced over 5 seeds at each of 8 speeds:

    km/h   FRAMES   distinct CARS   frames/car   worst dv   health
      22       35               3        11.67      3.721    0.945
      29        7               1         7.00      4.783    0.972
      36        0               0            -      0.000    0.993
      38        0               0            -      0.000    0.994
      40       61               2        30.50      6.190    0.641
      43       56               2        28.00      6.756    0.713
      50       50               1        50.00      7.021    0.763
      61       49               2        24.50      9.191    0.395

**258 frames over 11 distinct cars, 23.5 each, worst 50 frames on ONE car.** So "19 shunts at
22 km/h against 0 at 36" is one to three CARS against none, and the entry's magnitude is out by
a factor of 23. Renamed to `shuntFrames` with `shuntCars` beside it, in both hosts.

**AND THE SECOND DEFECT IS WHY THE FIRST ONE WAS HARD TO SETTLE: `Session` NEVER PASSED ITS
SEED TO `Traffic`.** `PursuitUnits` gets `opts.seed ?? 0` and `Pedestrians` gets it; the fleet
line took `count` alone, so `Traffic` fell through to its own fixed default and **every Session
in a seed sweep held the SAME fleet.** Only the crowd and the police varied. It took three
readings of the same table to find, and the sequence is the entry's real content:

    1. five same-fleet seeds, events 3,1,0,0,2,2,1,2     "not a signal"      (right, badly argued)
    2. sixteen same-fleet seeds, 16/16 against 0/16       "real, deterministic"   (wrong)
    3. the seed wired through, sixteen FLEETS             flat                (the answer)

    km/h   cars per seed, 16 DIFFERENT fleets              cars   seeds with any
      22   1 0 0 0 1 1 0 0 0 0 1 0 0 0 0 2                   6        5/16
      29   0 0 0 1 1 0 0 0 1 0 0 0 0 0 0 2                   5        4/16
      36   0 0 1 0 1 0 1 0 1 0 0 0 0 0 0 1                   5        5/16
      40   0 0 1 1 1 0 1 0 0 1 1 0 0 0 0 0                   6        6/16
      43   0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0                   1        1/16
      50   0 1 0 0 0 0 0 0 1 1 1 0 0 0 0 0                   4        4/16

**6, 5, 5, 6, 1, 4 — flat.** The 36 km/h "zero" that this entry was built on is one fleet's
layout, and the 43 km/h cell the entry called hot is now the QUIETEST in the table. So the
non-monotonicity is not a property of the player's speed at all.

**I was right at step 1 and wrong at step 2, and step 2 looked decisive precisely because of the
defect.** 16/16 against 0/16 is not a stochastic reading — it is one world replicated sixteen
times, and the near-determinism that made it convincing is what should have made it suspect.
**A cross-seed column that is TOO consistent is evidence the seed is not reaching what you
varied.** The same tell fired twice in this round and I read it as signal both times: the first
contact of each drive hit a car doing **8.091 m/s in six of six seeds, identical to three
decimals**, which no set of different fleets can produce.

**The mechanism, asserted rather than guessed.** At the frame of contact, all 258: the car is
**AHEAD** of the player 258 of 258, its own speed is **0.00 m/s p50** — it is stopped — and the
player's is 3.92-5.98. The player rams a car, `car.stopS` holds that car still for 1.2-5 s
where it was hit, and a follower with no car-following term grinds on it. The entry's "a car
crawling at 22 is overtaken from behind" is the opposite of what happens, at every speed.

**ARM B, no fleet at all: walls are not a term.** 0 wall contacts and health 1.000 at every
speed from 22 to 72 km/h, arriving 5 of 5 — where WITH the fleet 72 km/h wrecks the car 5 of 5.
The entry says this by construction ("followPath has no car-following term") and nothing had
measured it. Settled cross-track p50 **0.086 m**, against `lane-keep`'s 0.087 m on a different
course: two tools, two courses, one follower.

**ARM C, the entry's own isolation. SINGLE-FLEET, and moot now that the effect is flat.** It was
run before the seed defect was found, so each scale is one fleet rather than three draws. Kept
because it is what the entry asked for and because its reading is clean on its own terms — and
labelled, because with the non-monotonicity gone there is no longer an effect for it to explain.
Shunt frames, 3 seeds against one fleet per scale:

    player km/h    22   29   36   43   50   61     fleet mean km/h
    fleet x0.6      0    0    0    0    0    0       24
    fleet x1.0     19    0    0   30   30   27       37
    fleet x1.5     17    0    0    0    0   30       50

"Matches the flow" predicts the clean band MOVES with the fleet, and it does not. **The x0.6 row
is zero at every player speed** — including 61 km/h against a 24 km/h fleet, which is the
largest relative speed in the table and the cell the hypothesis says should be worst. At x1.5
the 43 and 50 km/h cells are clean while 22 is not. What x0.6 changes is how much road the
fleet covers, so what the table is sensitive to is the ENCOUNTER RATE rather than the speed
difference.

**And the entry's operational advice DOES NOT survive.** "The parameter for any future round is
`maxSpeed: 10` (36 km/h), which is clean in both columns" is a statement about one fleet; at 16
fleets that cell reads 5 of 16, the same as 22 km/h. The fine grid that looked like a cliff
between 10.5 and 11.0 m/s — 0 frames to 61 — is the same single-fleet artefact.

What survives is the part that was never a count: **severity is monotonic in speed** — worst
charged dv 3.72 / 4.78 / 6.19 / 6.76 / 7.02 / 9.19 at 22 / 29 / 40 / 43 / 50 / 61 km/h. Speed
decides how bad a contact is. Nothing measured here decides how often you have one, except that
it is about 0.3 cars per 350 m drive and does not move with the player's cap.

**NOTHING IS LEFT OPEN IN THE ENTRY, and what the seed defect leaves open is bigger than it
was.** Every playtest round that varied `seed` and reported on traffic reported one fleet —
including the flow figures CLAUDE.md quotes ("a median 36 km/h, 90th 52, max 64") and round 8's
and round 11's ram counts. Those are single-fleet readings, not seed sweeps. They are not
necessarily wrong; they have one draw behind them where they read as having several.

Nothing was shipped against the game: both fixes are to the harness. `mutation-sweep`'s
`shunt-cars-frames` stops the frame count coming back and `session-fleet-seed` stops the fleet
un-seeding itself, and the second is the one with no other gate behind it — it is
behaviour-preserving for every caller that passes no seed, and every other caller in `tools/`
that passes one also passes `traffic: 0`, so nothing had a fleet to perturb and nothing failed.
`shunt-rate --selftest` asserts that two seeds build two different fleets, by their spawn EDGE
SET rather than by a derived statistic, because two fleets can share a mean speed and nothing
else.

#### THE ROUND THAT MEASURED IT AS "PARTLY FIXED, NON-MONOTONIC"
### #87 PARTLY FIXED, and the contact rate is NON-MONOTONIC in speed — 36 km/h is clean
The wreck at the entry's own speed is gone. `driveTo` to `marlin-street`'s pickup, 3 seeds each,
40 peds and 12 traffic, 350 m completed every time:

    maxSpeed   km/h   health   wrecks   shunts   knockdowns   crimes
        6 m/s    22    0.951      0       19          2         11
       10        36    0.989      0        0          2          5
       14        50    0.714      0       30          1          5
       20        72    0.000      3       27          1          4

**0 wrecks at 50 km/h where the entry measured a wreck at 43**, so the follower work closed that.
What is left is two things worth separating:

- **72 km/h still wrecks, 3 of 3.** The harness's autopilot is `followPath`, which has no
  car-following term at all — that lives in `src/traffic.js` and is for the FLEET. So `driveTo`
  does not avoid traffic, by construction, and a round that reads "driveTo wrecked the car" as a
  game defect is reading an instrument property. Round 11 flagged the same thing about its own
  `maxSpeed: 12` and labelled the strikes as its parameter rather than the game's difficulty.
- **The contact rate is NOT monotonic in speed, and that is the new finding.** 22 km/h gives
  **19 shunts** where 36 km/h gives **0** — slower is worse. The likely reason, labelled as a
  guess: the fleet's own median flow is about 36 km/h, so a car crawling at 22 is overtaken from
  behind and a car at 50 overtakes into them, while 36 matches the flow and meets nobody.

**So the parameter for any future round is `maxSpeed: 10` (36 km/h), which is clean in both the
damage and the shunt columns**, and that is a more useful thing to take from this entry than the
wreck it was filed about. The guess about WHY wants one isolation nobody has run: hold the fleet's
speed multiplier and sweep the player's, which separates "matches the flow" from "is simply slow".

#### THE ORIGINAL RECORD
### #87 (as filed) driveTo wrecks the car in 200 m: 13 civilianCollision in 32 s at 43 km/h
`detail lost` beyond the subject line.

### #85 FIXED — the wedged cue exists, is gated, and names the control that works
`composeStuck` is in `src/vehicle.js` (`THE CAR IS WEDGED`, with the out SIGNED on the jam's
direction: a nose-in jam is told to reverse, a tail-in jam to drive). Gated in `hud-cue` and by
`boot-check`'s wedged arm, which asserts three things — the car genuinely got wedged rather than
wrecked or timed out, the line reaches the page with its one word, and the line is GONE once the
car frees itself, so it is not a stuck panel.

Round 10 measured the shipped behaviour from outside: the cue fires **8 of 8 on genuinely pinned
arms with 0 of 13 false positives** on arms that slid along a wall, and reverse recovers
**131.69 m against 0.52 m forward**. So both halves of the entry are answered — the HUD says
something, and the thing it says is the control that moves the car.

#### THE ORIGINAL RECORD
### #85 (as filed) A pinned car rocks 20 degrees back and forth for ever, and the HUD says nothing
`detail lost` beyond the subject line.

---

## Budget and rendering

### #75 MEASURED — derivation (b) cannot fire if it is recomputed, so it fires only by being frozen
**DECIDED 2026-10-17 (#64): (a), the capability bound, on a road-course baseline — warn 1,400,000, fail 2,180,000.**

`detail lost` beyond the subject line, so the entry is reconstructed from `tools/budget.mjs`'s own
header and the committed artifact. Nothing was run for this: both numbers are in `docs/drive-traffic.json`.

    metric       p95        warn        fail       headroom vs warn   vs fail
    drawCalls    241         275         440            +12.4%         45.2%   PASS
    triangles    852,605     830,000   1,850,000         -2.7%         53.9%   WARN

**The two metrics have diverged, and the comfortable one is the one the gate's own header calls
the wall.** That header opens "Phase 1's Risk 1 was that submission cost, not triangle count, is
the wall". Against the 2026-09-01 re-derivation (draw p95 228, triangles p95 726,597):

    draw calls  228 -> 241       +5.7%
    triangles   726,597 -> 852,605  +17.3%     3.0x faster

Which is what efficient content growth looks like here: `shadow-bill` says a triangle added to the
crowd, either car pool, the signage or the facade trim costs TWO in the gate's number and ZERO
draw calls, so detail added inside existing instanced meshes multiplies triangles and does not
touch submission cost at all.

**And the arithmetic that settles what kind of threshold (b) is.** `budget.mjs` now computes both
derivations rather than quoting them (`derivations(p95, max)`), on today's artifact:

    (a) capability bound, 1.6x / 2.5x the measured MAX     warn 1,383,533   fail 2,161,770
    (b) headroom ratchet, p95 / 0.878                      warn   971,076
    shipped (the tighter of the two, frozen 2026-09-01)    warn   830,000   fail 1,850,000

**(b) recomputed today is 971,076, above the p95 it is derived from — because (b) IS p95 / 0.878,
so recomputing it always places the warn 14% above whatever the content currently is.** It can
never fire when recomputed; it fires only because it was frozen at an older p95. So (b) is not a
bound on anything, it is a growth detector with a date on it, and the entry's title is exactly
right. The header's own last paragraph predicted this in as many words — "under (b) the triangle
warn had only 13% headroom left on the OLD metric, so that threshold was close to firing on
ordinary content growth before any of this" — and deferred the decision.

**NO THRESHOLD IS MOVED, and that is deliberate.** Choosing between a capability bound and a
growth detector is the decision the header deferred, CLAUDE.md's rule is that a gate is never
loosened silently, and it is a judgment about what the project wants the gate to protect rather
than a measurement. What this round removes is the need to recompute the inputs to make it.

**What IS fixed is the gate lying about it.** `headroomPct` was computed against `r.fail` alone,
so the triangle row printed **53.9% headroom beside the word WARN** — and CLAUDE.md has recorded
that for several rounds ("the gate's own headroom % column is measured against the FAIL line, not
the WARN line, so it reads comfortable while the warn line is close") while the code still only
had the fail figure. It prints the warn figure first and signed now, so an over-warn row reads
`-2.7% of warn`. This file's own history contains a round that explained a WARN away; a gate
printing 53.9% next to it was helping.

### #64 FIXED — the budget gate drives the road course, and its triangle threshold is the capability bound
**Decided by the owner on 2026-10-17: derivation (a).** #75 had settled what (b) is — recomputed it
always lands 14% above the p95 it comes from, so it fires only by being frozen — and the choice
between a capability bound and a growth detector was the owner's, not a measurement.

**The course moved in the same change, as this entry said it should.** `drive-through` drives the road
graph (src/roadpath.js's tour of the same route, its own follower), body collision ON, for ONE full
lap; `DRIVE_COURSE=straight` keeps the old course for re-measuring old artifacts. The lap is the
stop now because the straight course never finished its three circuits either (its baselines read
`laps_completed: 1`), and the road course, at a p50 of 39 km/h, covered 1,075 m of
3,264 in the old 300 s cap: a third of the route. A full lap is 660-709 s of wall clock on an idle
box, and every artifact records `course`, `body_collision`, `ended`, `route_length_m`,
`stuck_teleports` and a `drive_ledger` of everything the net did.

**Two defects were in the way, and the verification laps found both.** The first lap held for its
whole net behind an oncoming fleet car in the same physical lane — every route lane was on the
driver's LEFT, which is #127. With that fixed the lap completed, and the ledger's new impact log
showed the net feeding itself: one contact at a one-way jog on Main Street east, then four more as
each stuck-teleport put the car down facing due north (`placeAt`'s default yaw) 3.9 m from the
parking lane. Teleporting along the course took that lap's 5 teleports and 13 applied impacts to 1
and 3-5 in the three baseline runs. What is left is three sites, all filed as `wall` — course index
111-112 north of Five Points, the jog's exit at 174, and index 370 at (653.5, -346.9) at dv 11.1 —
and src/vehicle.js files a parked-car contact as a wall too (#126), so which of them are cars is
not yet known.

Three runs on an idle box, at commit 6b47266, with the course on the right side of the road (#127):

    run   ended            frames   m driven   teleports   tri p95    tri max    draw p95 / max
    1     course driven      277     3,158           1    832,174    872,882   225 / 252
    2     course driven      261     3,153           1    834,484    875,880   225 / 253
    3     course driven      270     3,128           1    845,957    861,880   236 / 243

    run   the drive's net: repairs (min health), heat clears, holds, knockdowns; applied impacts by kind
    1     4 (0.372), 6, 1, 1; wall 4
    2     6 (0.341), 10, 0, 2; vehicle 1, wall 5
    3     3 (0.374), 3, 0, 0; wall 3

    triangles  warn 1,400,000  fail 2,180,000   1.6x and 2.5x the worst max 875,880, rounded DOWN to 10,000
    draw calls warn 275       fail 440        unchanged: (b), and the decision was about triangles

The p95 spread across the three runs is 13,783 — within one session, which CLAUDE.md says is
the only kind of comparison this gate supports. `tools/budget.mjs` carries the three runs as
`BASELINE` and types the thresholds beside them; its selftest re-derives them, so a hand edit to
either fails it.

#### THE BLOCKED RECORD
### #64 Re-baseline the budget gate on the road course — STILL BLOCKED, and on a decision not a measurement
`src/roadpath.js` is the real fix for the autopilot driving through a third of the city, and it
is not the gate's course yet, because changing what a gate measures needs a fresh baseline and
the triangle warn is unresolved.

**#75 narrows the blocker rather than clearing it.** The triangle warn is now known to be a frozen
ratchet whose recomputed value (971,076) sits above the p95 it derives from, and the draw-call
metric that matches the gate's stated purpose is at +12.4% of its warn. So what #64 waits on is
the deferred choice between derivations (a) and (b), which is one decision and not more
measurement. Taking the road course would reset the baseline for both metrics at once, so it is
the natural moment to settle the threshold too rather than carrying a frozen one onto a new course.

### #42 MEASURED — the stall gate WARNs at N=5 on a clean box, and the spread is the scheduler's, measured
PROGRESS.md's 2026-08-30 protocol — N>=5 sequential runs, median and p80 — run for the first time on
a box with nothing else alive: a fresh 4-core container, load average 4.15 median over 45 samples,
which is the run's own browser. `docs/stall/head-9fad52a/`:

    runs        8.6  17.2  10.6  9.1  8.0 ms      median 9.1   p80 10.6   against warn 8 / fail 16
    verdict     WARN on both statistics, one run in five over fail

**The verdict is WARN, and what it measures is mostly the box.** Two readings say so, neither of
them an argument:

- **Runs 1 and 2 did byte-identical streaming work** — 158 loads, 168 unloads, 263 LOD swaps — and
  read 8.6 and 17.2 ms. Same work, x2.0. (The five runs do not all do the same work: the gate stops
  at a 300 s wall-clock cap, so how far it drives depends on how fast the box renders, and runs 3
  and 5 covered 3,185 and 3,527 m against ~4,000.)
- **The worst live step costs twice the whole chunk's offline price.** `tools/append-cost.mjs`
  (min of 5 passes, deterministic) prices chunk 0,-2's repeat build — all nine buildings — at
  3.92 ms; the chunk-steps ledger on the same box saw ONE `append:near` step on that chunk take
  7.7 ms. The worst single building in the district appends in 1.40 ms, and a slice can only
  overrun its 3 ms budget by one building, so a step past ~4.4 ms is carrying time beyond the
  facade kit's WARM cost.

What the second reading cannot say is WHOSE time that is, and there are three candidates:
SwiftShader's raster threads competing for four cores (load 4.15 says they are), a V8 garbage-
collection pause (which a GPU machine would pay too), or the same code running colder in the page
than in node's best of five. The measurement that separates the first from the other two is a
fixed, non-allocating workload timed on the main thread during the same drive — its excess is
preemption alone.

**Run (`DRIVE_JITTER=1`), and the scheduler alone is the size of the spread.** A loop calibrated to
1.0 ms, sampled once per rendered frame INSIDE the sim loop, where `world.update()` and so the slices
run:

    114 frames   p50 1.1   p99 5.7   max 12.3 ms    worst stretch 11.3 ms    3 samples past x5
    the same drive's worst slice: 8.2 ms

11.3 ms of pure preemption, in the slices' own phase, against a stall spread of 8.6 to 17.2 ms on
identical work — and 114 samples is a LOWER bound on what the thousands of slices in a run can meet.
So the run-to-run spread that carries this gate across its warn and fail lines is the box's,
measured; GC and colder code are not needed to explain it, though nothing here rules them out for
the residue. **The gate's stall verdict cannot be certified on a SwiftShader box at all**: the build's
own cost — 3.92 ms for the worst whole chunk, 1.40 ms for the worst building, warm and deterministic
— sits inside the budget with room, and the browser number adds a scheduler term that is as large
as the threshold. That is a statement about the instrument on this hardware, and no threshold moves.

**And the first version of the probe measured a different phase and read 17x worse.** On a 25 ms
timer it sampled BETWEEN frames, while SwiftShader's raster threads work on the frame just submitted:
median 18.5 ms for the same 0.9 ms loop, 11,050 of 11,560 samples past x5. True, and about another
quantity — the timer never fires where the slices run. Both artifacts are kept
(`jitter-interval.json`, `jitter-simloop.json`), because the gap between them is the finding that a
probe's PHASE is part of what it measures.

The chunk-steps run itself (`chunk-steps-traffic.json`): worst slice 8.4 ms = dispose 4.7 + steps
3.2 + scan 0.5, ledger 0.00 ms from the gate's own number. **And that tool had been attributing a
different drive since 2026-09-25**: it copies the gate's autopilot and never turned body collision
off when the gate did, so it measured a car wrecked ~10 s in and teleported round the route.
`chase-harness` had the same drift. Both fixed in 33e2e1c, and both now print the state before and
after the switch.

#### THE ORIGINAL RECORD
### #42 Chunk stall: attributed and structurally improved, but the gate verdict is unresolved
`detail lost` beyond the subject line. `chunk stall ms` is unusable while anything else runs on
the box — see CLAUDE.md.

### #48 REFUSED by blind review — kernel 3 was preferred in 0 of 6 pairs, and the reviewer recovered the assignment in 6 of 6
src/post.js's own record had already priced the trade and could not settle it, which is why it was
parked for a reviewer: at the shipped intensity 8.5, kernel 3 (a 32-tap spiral with a
uniform-solid-angle elevation) grounds feet and props harder — foot 0.797 -> 0.850, prop@18.8
0.232 -> 0.281 — and darkens the corridor seam, 0.9147 -> 0.9509. Whether a viewer sees the
grounding or the seam is a judgement, and numbers alone could not make it.

**The pair:** `aok0` (the shipped legacy twelve) against `aok3`, ONE page load, both hero framings
at noon, dusk and night, the arms proved distinct on the kernel alone (radius 0.6, intensity 8.5,
strength 1, floor 0.04 identical). Corridor noon's facade band carries 19.4% of samples >4/255
apart, above blind-compare's 8% floor. Scrambled per pair, A was the shipped arm in 3 of 6. One
blind Opus reviewer, confined to the PNGs and the generic image tools.

**The verdict, decoded:**

    reviewer's "D" (the arm with an extra layer of soft, wide occlusion)   kernel 3 in 6 of 6
    reviewer's preference                                                  the SHIPPED kernel, 6 of 6
    confidence                                                             2-3 of 5; whole-frame D/L 0.979-0.993

**And its reasons are the record's two numbers in a viewer's words.** Against kernel 3: "a one-sided
dark skirt on the wall face" — pillar faces 27-36% darker and their feet 51-59%, with the pavement in
front within 1% — plus darker plates and windscreen bottoms, "surfaces a photograph would show
evenly lit". That is the seam. For it: "cars look heavier", a soft skirt on the road beside them,
stronger kerb faces. That is the contact gain. Recesses a draw; no grain or halo specific to either
arm. So two independent instruments — the record's measurements and a blind eye — agree on the trade,
and the eye says the seam costs more than the grounding buys. **The shipped kernel stays**;
`aoKernel: 3` remains a sweepable option in post.js and an arm in tools/ground-albedo.mjs. The 6.5
pairing was not sent: the record had already refused it at thirteen to one (reveal contrast -21%
for a 1.6% lighter seam).

**What the reviewer found wrong in BOTH arms**, which outlives the question it was asked:
  - lit shop windows at night go dark beside every pillar — 0.004 against 0.11 over 24 px — which is
    #114, filed below, because it looks like AO multiplying EMITTED light;
  - a wall-mounted menu board darkens the pillar around it to 25-35% of its open value;
  - soot-like smudges under cornices, and dark rings in the cars' wheel wells;
  - and a capture note: tree-shadow flecks change between the two arms (corridor noon's road box is
    81.8% byte-identical where the sky is 99.8-100%), so the foliage's shadow is a clock
    tools/hero-shots.mjs does not pin.

#### THE ORIGINAL RECORD
### #48 aoKernel 3: parked deliberately, needs a reviewer not a decision from me
`detail lost` beyond the subject line.

### #114 FIXED, and a blind reviewer preferred it 3 of 4, decisively at night — emitted light is exempt from the screen-space AO, by a share the lit materials tag themselves
Found by #48's blind reviewer in BOTH arms, so independent of the kernel: in fivepoints-night a lit
shop window beside the MARROW & VINE pillar rises from 0.004 to 0.11 (linear luma) over the 24 px
next to it, and corridor-night "shows dark streaks flanking every pillar". 0.004 / 0.11 = 0.036,
the AO floor of 0.04 reached through the tonemapper's toe.

**The control first, because "it looks like AO" is a diagnosis.** One page load, the same frame
with the composite's AO strength at 0: the window beside that pillar reads **0.199 of its AO-off
value at the pillar's edge and recovers over 20 px** — the band is the AO, not the facade's
emissive texture.

**The defect is half of an argument the composite already made.** It did `color = scene * ao +
bloom` under a comment saying AO spares the bloom because "bloom comes from emissives — lit
windows, lamps, signage — and those are light sources, not surfaces receiving ambient". Right, and
it covered the blurred glow added on top; the window's own pixels are in `scene` and were
multiplied like a wall. A guard right about what it protects and silent about the case next door.

**The fix.** Only reflected light is occluded, so a pixel whose light is a share `e` emitted wants
`mix(ao, 1, e)`, and nothing downstream of the material can recover `e`. So every lit material
says: one patch to three's `opaque_fragment` chunk — the last line every lit material runs, where
`outgoingLight` and `totalEmissiveRadiance` are both in scope — writes the emitted share of the
pixel's luminance into the scene target's alpha, which nothing else reads (HalfFloat RGBA; bloom
and AO read rgb and depth; the canvas has no alpha). The composite decodes it behind a runtime
uniform, `aoEmitExempt`, whose 0 is the old composite bit for bit, so a before and an after come
off one page load.

**The encoding is NEGATIVE, `-(1 + e)`, and that is the safety argument.** A tag lives in [-2, -1]
and nothing an untagged pass leaves does (clear 1, unlit and unpatched materials 1, background 0 or
1). And every blended draw over a tagged pixel can only REDUCE what it decodes to: this build's
normal blending leaves `s + a(1 - s)` in alpha and its additive `a + s`
(`blendFuncSeparate(SRC_ALPHA, ONE, ONE, ONE)`, read off the vendored bundle — I had written `s^2`
from memory and corrected it), and both move a negative tag toward "nothing emitted". A positive
encoding inverts that: the shopfront soffit glow is additive at alpha 1, and over a wall tagged
`2 + 0` it decodes as all emitted and lifts the wall's occlusion entirely. Wrongness here can only
cost exemption, never invent it. Only OPAQUE lit materials are tagged: a transparent one's alpha is
its coverage, and tagged it blends as `src*(-1) + dst*2` — measured, a half-coverage white pane went
from luma 0.839 to 0.000. The district's road markings are such a material.

**Measured, three arms off ONE page load** (`aoOff`, `aoEmit0` = before, `aoEmit1` = after,
tools/ground-albedo.mjs), proved distinct on the one field they differ in:

    the reviewer's pillar, fivepoints-night, the lit window from the pillar's edge, / AO-off
      x       1300   1304   1308   1312   1316   1320
      before  0.199  0.320  0.672  0.786  0.863  0.999
      after   0.908  0.923  0.962  0.974  0.985  1.000
    the remaining 3-9% is the glass's REFLECTED share, correctly still occluded

    every pixel the old composite darkened by more than a tenth, by its AO-off luma
                          fivepoints-night         corridor-night           noon, both framings
      luma >= 0.15        p50 0.865 recovered      p50 0.000, 7.7% > 0.5     p90 0.000 in every band
      0.05 - 0.15         p90 0.805                p90 0.206                 (recovered > 0.5 on
      0.01 - 0.05         p90 0.612                p90 0.021                  0.1-5.7%: the crowd and
                                                                              trees moving between arms)

**And what each surface TAGS as, read rather than inferred**: `postParams().debugEmitShare` draws
the decoded share as grey, and `aoEmitShow` captures it beside the three arms.

    frame                share > 0.05   > 0.5    where the share is 0, after == before on
    corridor-night          5.47%       1.27%    99.23% of pixels
    fivepoints-night       13.93%       7.19%    94.53%
    corridor-noon           0.00%       0.00%    92.64%   share 0 on 1,439,953 of 1,440,000 px
    fivepoints-noon         0.01%       0.01%    93.66%   the signal lenses, and nothing else
    (the pixels that differ where the share is 0 are the crowd, the traffic and the foliage moving
     between the arms; the share map is a separate page load, so it is a mask and not a pairing)

Lit glazing, signs and lamp heads tag; awnings and sign boards read 0. The deli's
glass in the corridor reads about HALF emitted, brighter toward its head — the rest of its light is
the street lamps and the canyon reflected in it — which is why it recovers 0.55-0.94 of the way
rather than all of it. That is the fix being right, not partial: reflected light is what AO is for.

**Noon does not move**, and that is by construction rather than by luck: the facade and trim
emissive intensities are 0 at noon and golden, so the share is 0 on every building surface and the
exemption has nothing to act on. The emitters that are lit at noon — signal heads, car lamps — are
emitters, and exempting them is the fix.

**The gate is a page, because nothing offline compiles a shader.** `tools/ao-emit.mjs`, 2.4 s: a
wall of three panels — all emitting, half emitting, none — each with a pillar against it, an
additive overlay across the foot of two of them and a transparent lit pane on the third, rendered
through the real PostStack in the same three arms. 16 checks, including the defect itself measured
LIVE every run (the before arm darkens the window to 0.463 of AO-off at p50), the fix (0.986 of the
way back), the wall and pillars byte-identical to before, the half panel exempted IN PART (0.564),
the overlay over the wall not lifting it, the pane still blending, and a frame-wide invariant — every
channel of every pixel of `after` lies in [before, off] to within one code value: 0 of 294,912
outside. Selftest on a real report with 13 known-bads. On mutation-sweep's offline list with six
rows (`emit-exempt-off`, `emit-tag-unsigned`, `emit-tag-binary`, `emit-tag-all`,
`emit-tag-transparent`, `emit-uniform-unwired`), each of which renders a plausible frame and passes
every other gate, because no other gate compiles a shader. Swept: **six of six caught, every one by
`ao-emit` alone** — which is the claim in that sentence measured rather than asserted.

**The blind review.** Both framings at dusk and night, one page load per framing, `aoEmit0` against
`aoEmit1` scrambled per pair (A was the fix in 2 of 4), one blind Opus reviewer confined to the PNGs.
The set had to be forced past `blind-compare`'s 8% signal floor and say why: the change is LOCAL
(lit glazing beside occluders, 1.6-6.7% of samples per pair), and noon was left out because its
own crowd-and-foliage motion between arms (6.4%) is as large as night's signal. Decoded:

    pair               reviewer's "darker arm"     preferred          confidence
    corridor-dusk      the old composite           the fix            2
    corridor-night     the old composite           the fix            4
    fivepoints-dusk    the old composite           the old composite  1, "close to a tie"
    fivepoints-night   the old composite           the fix            5

**They recovered the assignment 4 of 4 from the pixels**, and their night reasons are the defect in
a viewer's words: the old arm "darkens glowing windows, lit shop glass, signal lamps and a lit sign.
A photograph can't do that" — the lit menu board's edge at 0.23-0.26 (a 102-level drop), dark smears
on the glowing glass beside every column, a halo on lit glass around a pedestrian's head, the
pedestrian signal heads dimmed 24-30% and the LEMON street sign 25%. Static pixels darker by more than
10 levels in the old arm: 0.08% / 0.28% at dusk, 0.81% / 2.97% at night, which is where the
preference is. The one pair that went the other way did so at confidence 1, on the old arm darkening
the top edge of lit upper-floor panes "as the window reveal shading a recessed pane seen from below"
— and the same reviewer called its band beside the shop column "too strong: 0.19 at the junction".

**What they found wrong in BOTH arms**, which outlives the question: a regular pattern of pale blue
ellipses on the road at dusk (#116 below); polygonal wheels and an oversized dark ring around a white
car's wheel arch (cars live line, item 4); dark pools at pedestrians' feet that move with them; a
figure washed out by glow where it overlaps a sunlit car roof; and by eye only, cut-out leaf cards,
flat lightbox shopfronts at night and uniform-width road cracks.

**What it does not fix, measured, and it is a different term — filed as #115.** In the corridor's
deli colonnade the glass beside each pillar comes back, and the strip of the PILLAR'S OWN FACE beside
it stays nearly as dark as it was: 0.612, 0.321 and 0.173 of its AO-off value at 12, 8 and 4 px from
the edge before, 0.640, 0.364 and 0.205 after. Those columns tag 3-10% emitted — the trim atlas's
shopfront emission washes the reveals, which is interior light on the jamb and correctly exempt — so
the pillar lifts by its share and no more. The other 90-97% of its light is the street lamps, and
the composite multiplying DIRECT light by ambient occlusion is a different and much larger question
than this one.

(I first wrote that the pillar tags exactly 0 and is byte-identical, off a downscaled view of the
share map in which it looked black. Read per pixel it is bytes 8-26 of 255 and after == before on 0
of 70 rows at those columns. A dark grey at a fifth of full size is not a zero.)

### #115 OPEN — the composite's AO multiplies DIRECT light as well as ambient, and at night almost all light is direct
What #114 left, measured on its own capture. Ambient occlusion is a statement about how much of the
AMBIENT a surface can see, and the composite applies it to everything that left the surface. #114
took the emitted part out. The direct part is still in: a pillar face lit by a street lamp in the
corridor's deli colonnade reads 0.173 of its AO-off value 4 px from its edge (linear luma) before
#114 and 0.205 after — the lift is its 3-10% of reveal glow — where the glass beside it now reads
0.55-0.94. At night nearly all of the light
in this district is direct (lamps) or emitted (windows), so the AO darkens the very light that
exists, and over the corridor-night frame 58,283 pixels brighter than 0.15 with AO off are darkened
by more than a tenth and only 7.7% of them are emissive enough for #114 to recover.

**A second instance, from #114's blind reviewer, on a car.** "An oversized soft dark ring on the body
around [a white car's] wheel arch", fivepoints-dusk (1050-1115, 590-640), in both arms. At 3x it is
a halo on the low-sun-lit flank all round the recessed wheel — the AO's depth step at the arch lip
darkening a panel the dusk sun is lighting directly. So this term is not only a night-and-lamps
question: at dusk it is the sun.

**Why it is not simply #114 again with the direct term added to the share.** The same tag would
then exempt every SUNLIT surface at noon — `reflectedLight.directDiffuse + directSpecular` is in
scope at the same chunk and the arithmetic is one line — and the AO in sunlight is doing work the
sun's shadow map is too coarse to: #48's reviewer weighed exactly that grounding ("cars look
heavier", "stronger kerb faces") against the seam and said what they preferred. So the direct share
is a LOOK decision at noon and a physics decision at night, and one alpha channel can carry only one
share. Levers, unpriced: a second tag channel (an MRT, which this stack does not have); a
time-of-day weight on the direct share (`aoDirectExempt` 0 at noon, 1 at night — but the tag would
then have to carry emitted + direct and lose the ability to tell them apart, so the weight would
apply to emitted light at noon too, which #114 says is wrong); or the honest one, point lights
that cast their own shadows, which is a cost question this project has not priced.

### #116 FIXED — the asphalt's roughness map carried seven glossy spots per 3 m tile, on a lattice nothing de-tiled
`src/materials.js`'s asphalt `paintRough` painted seven smooth radial "oil" spots per tile (roughness
~0.27 against 0.89 dry, 0.16-0.63 m across), and the map repeats every 3 m with nothing to break it:
the road shader's de-tiling (`pvMacro`) multiplies the ALBEDO only. So every carriageway carried a
3 m lattice of mirrors, each catching the brightest sky of the hour. Oil gloss already existed where
oil is — `pvOil`, in world space, dripped down each lane's centre — so the tiled spots go, and the
painter's stream is its own (`mulberry32(seed)` per painter), so nothing else on the road moves.

`tools/road-gloss.mjs` counts it: pixels brighter than 1.2x their 31x31 neighbourhood median AND
bluer than red (paint is never bluer than red; a sky reflection is — without that term the first
version read the same 18% at noon from lane paint and crack edges). Selftest with a spot lattice,
paint and warm highlights. Same camera, two page loads (the road box is static):

                              before                after
    corridor road, dusk       18.29%, 106 blobs     9.34%, 55 blobs
    corridor road, noon       19.51%, 113 blobs    15.70%, 103 blobs
    fivepoints road, dusk     11.39%,  81 blobs     3.59%, 47 blobs
    fivepoints road, noon      1.68%,  46 blobs     0.36%,  7 blobs

What remains is the world-space tyre-track polish, which runs ALONG each lane as a sheen rather than
in rows across it — at 1:1 the dusk road reads as worn asphalt with two polished tracks a lane, and
the rows of ellipses are gone. No gate checks the roughness map itself: the change is in a canvas
painter, and the instrument is the frame.

#### THE ORIGINAL RECORD
### #116 OPEN — rows of pale blue ellipses on the asphalt at dusk, from #114's blind reviewer
Found in BOTH arms of #114's review, so independent of the AO: at dusk, "rows of pale blue elliptical
spots on the asphalt", 64 of them covering 7.63% of corridor's road box (560-1040, 600-760) and 52
covering 5.70% of fivepoints' (0-600, 650-800); absent at night. Looked at, at 2x: they are regular —
rows of sky-coloured ellipses on a grid across both lanes, which no wet road does. The cheap reading is
low-roughness patches in a TILED road texture catching the brightest sky of the day (src/materials.js
says the asphalt map repeats every 3 m and has its own de-tiling pass), which would also say why night
hides them. Not diagnosed: the first measurement is the road's roughness along a lane against the
spot positions, and whether noon and golden show them too.

### #117 FIXED — the sun's shadow box followed the car to the micron, so every shadow edge crawled when it moved
**It was the mechanism the original entry below guessed, and it is bigger in motion than the stills
suggested.** `TimeOfDay.follow()` centred the ortho shadow box exactly on the player's car, so a
centimetre of travel re-rasterised every caster at a new sub-texel phase. Offline, through three's own
`LightShadow.updateMatrices`, a fixed road point's position in the 2048-texel map moved by 0.05-0.07 of
a texel per centimetre of car travel at noon, 0.035 at dusk. And the light's direction tilted with the
car's HEIGHT: `follow()` set the sun's y as an absolute `sin(el) * 400` while the target took the car's
y, so at dusk a car at y 0.95 lit the city at 3.015 degrees for a preset of 3.151, and a 20 cm kerb
moved every shadow in the frame by 1.7 texels.

Measured in the page — corridor's hero camera, traffic, crowd and clouds frozen, the car out of frame
behind the camera, stepping it 2.3 cm a frame (1.4 m/s):

                         ground px over 2 levels, per frame     over 8     max
    HEAD, noon             12.58%  12.88%  13.10%                34,543+     72
    HEAD, car still         0.10%   0.06%   0.06%       (control)   275       31
    fixed, noon             0.019%  0.056%  0.047%                   15-30     50
    HEAD, golden / dusk     0.03-0.07% / 0.025-0.048%    the road is in building shade at
                                                         this camera: nothing sunlit to crawl

So driving at noon, an eighth of the ground in frame changed every frame; fixed, it is at the level of
a still car. **The box now moves only in whole texels of its own grid**, along the two lateral axes
three builds the shadow camera with (`Matrix4.lookAt`, up (0, 1, 0)): a fixed point always lands at
the same sub-texel phase, and a move is an integer shift of the map, which rasterises to the same
picture. **The light's direction comes from the preset alone**, which is also what the bounce, the
canyon-wall term and the audit had always assumed — the light was the one thing that did not. And
`_applyPost` took the post stack's sun direction by normalising the light's POSITION, which after a
follow is the viewer plus 400 m toward the sun; it reads the preset too now.

The difference map of a HEAD step is a mosaic of parallelogram texels across the dappled shade, which
is exactly the reviewer's "isolated, soft-edged squares" — hero-shots leaves the car coasting behind
the camera, so its two captures half a second apart straddled a few millimetres of travel.

`tools/shadow-stable.mjs` is the gate, offline in 0.05 s: the real `TimeOfDay` through the real
`updateMatrices` over a 156-position walk per preset (sub-texel nudges, a suspension bob, a kerb,
driving, a ramp). A fixed point's phase holds to 4e-12 of a texel, every move is whole texels, the
light and the post's sun are the preset's to 0 degrees, the box stays within half a texel of the
viewer on each axis. Its selftest runs the old `follow()` verbatim and fails it on phase AND direction,
plus a snap in world axes, a frozen box and the old `_applyPost`. Four mutation rows.

**Original record:**

#117 OPEN — soft ~0.5 m squares in the noon canopy shade change between two captures half a second apart
From the cabin's blind reviewer, in BOTH arms and so independent of the cabin: at corridor noon, "22
isolated, soft-edged squares of about 0.5 m on the road and pavements. Each is 25-75 px wide and
changes by a factor of 0.75 to 1.56; 17 are brighter in B and 5 darker", and on top of that "23-29% of
the dappled sunlit ground shows a ±1-2 level speckle that averages to zero". Six more in the palm's
shadow at fivepoints. None at dusk (the road byte-identical over 242,775 px) or at night. "If this
flicker also happens between consecutive frames, it would show as shimmering squares in the canopy
shade; worth checking in motion." Its difference map shows the squares as parallelograms on one
lattice, which is what a shadow-map texel looks like projected onto the ground.

Candidate mechanism, from reading the code and NOT yet measured: `TimeOfDay.follow(pos)` moves the
sun's ortho shadow box with the player's car every frame with no snap to the map's own texel grid
(0.117 m), so any sub-texel motion of the focus re-rasterises every caster at a new phase — and it
sets the sun's height as an ABSOLUTE `sin(el) * 400` while the target takes the car's own y, so the
light's direction itself tilts with the car's height on its suspension.

### #118 FIXED, and a blind reviewer preferred it in 4 of 4 dusk and night pairs — at dusk and night the bright pass took LIT surfaces as light sources; lit light has its own bar now
**The blind review (2026-10-15, r12b, `docs/shots/blind-key-r12b-bloom0-r12b-bloom1.json`).** Six pairs,
the arms scrambled per pair. The reviewer found the term itself, said which letter carried it in each
pair from the frames alone, and was right four times of four:

    pair              preferred           confidence   strongest reason
    corridor noon     neither             1            99.42% of pixels byte-identical, the rest walking peds
    fivepoints noon   neither             1            94.65% identical, all of it moving figures and cars
    corridor dusk     the fix             2            the old arm glows on sun-lit columns, x1.023, 15-20 px fringes
    fivepoints dusk   the fix             2            the old arm haloes a windscreen glare x1.14 and a roof rail
    corridor night    the fix             4            the old arm lifts every lit surface: frame mean +18%,
                                                       cornice x1.53, canopy x1.71, a 24 px halo off the cornice
    fivepoints night  the fix             3            the old arm throws an 18 px glow off a lit parapet

Noon identical is the design: noon and golden name no lit bar and run the old pass bit for bit.

**Two things it noticed that the fix does, and neither was something it set out to do:**

- **At dusk the fix LIFTS sky-bordered foliage**, 14-20% on leaves beside the sun patch (corridor dusk
  x=450 y=330-346), and leaves bark, the signal mast arm against the same sky and the open sky itself
  unchanged. The footprint fits the split path's per-texel threshold rather than anything about lit
  light: an UNTAGGED texel is still tested against the hour's threshold, but now one texel at a time
  rather than on the 2x2 mean the one-tap pass thresholded, and where sky shows through a leaf card at
  the texel scale the mean sits under the knee while the sky texels sit over it. Uniform sky is
  identical by construction and a solid edge has one mixed row, which is the 1-2% the reviewer read on
  the mast arm. NOT MEASURED — the test is `emulateHalfRes` split against one-tap on a dusk readback,
  untagged texels only — so the sentence above saying untagged light "keeps the hour's threshold whole,
  as before" is true of the threshold and not of the sampling. The reviewer read the lift as "like
  shooting into a low sun" and preferred this arm anyway.
- **At night the small street lamps lose their glare.** The old arm gave the pole lamp at fivepoints
  (795, 406) a halo x1.96 at r=6-10 px and the twin globes at (686, 431) x1.5-1.95 at r=12-16, and the
  fix draws them as "bare dots". That was the lamp-LIT housing blooming, which is exactly what this
  entry removed — but it was standing in for a glare the emitter does not make on its own. Filed as #123.

**The entry's candidate was right in kind and needed two corrections to be right in detail.** Every lit
material already tags the EMITTED share of its radiance into the scene target's alpha (#114), so the
bright pass now splits each texel: the emitted part is tested against the hour's threshold, the lit
part against its own bar, and anything untagged — the sky, every MeshBasicMaterial glow and halo —
keeps the hour's threshold whole, as before (`src/post.js` brightSplit).

**The bar is noon's threshold, at dusk and night only** (`src/daynight.js`, assigned from
`PRESETS.noon` rather than typed). Noon's and golden's thresholds were each derived from the brightest
plausible LIT surface at that hour — "nothing that is merely lit" blooms there by construction — and
dusk's and night's were display-unit values carried across two re-stops for the emitters. So at dusk
and night a lit surface blooms only where it sits brighter on screen than noon's brightest lit surface
does, by noon's margin: the photographic rule the reviewer stated, "a photograph does not glare around
a mid-grey diffuse surface". Through the composite's own rolloff, ACES and encode, the knee puts the lit
onset at 0.532 exposed, display byte 209 (full at 1.331, byte 237), where the old night onset was 0.047,
**byte 57** — and the reviewer's plate "at only about sRGB 87" is 0.082 exposed, byte 87 by the same
chain: inside the old knee, which runs from byte 57 to 111. Noon and golden name no bar and run the old
pass bit for bit. The OTHER candidate — weight the pass by the share, so lit light never blooms — was refused on one
panel: a lit glint three times past the bar is a real glare source (a lamp's specular highlight on a car
roof) and it would go dark.

`tools/bloom-lit.html`, five panels at known radiances through the real PostStack at the night bars,
both arms off one page load:

    panel       radiance   share   handed to the blur: off    shipped   shipped/off
    emit          0.354     1.00                 73.74        74.34      1.0081
    lit           0.354     0.00                 74.86         0.59      0.0079    the plate's case
    untagged      0.354     none                 76.45        76.45      1.0000
    half          0.354     0.50                 74.97        19.82      0.2643
    glint         3.992     0.00               1244.37       864.44      0.6947

The lit panel handed the blur **1.015 of what an emitter of its radiance did** in the old pass, which is
the defect, measured every run; it hands on **0.008** now, all of it the MSAA rim where a lit texel's tag
is averaged with the clear's and decodes as untagged.

**Two corrections the gate forced, both in the first hour:**

- **The tag cannot go through the bright pass's linear filter.** The pass samples the scene at half
  resolution, and the mean of an emitter's -2 and the sky's +1 is -0.5, which decodes as nothing. So
  the split path fetches the four texels the filter would have blended, at their centres, splits each
  and blends the RESULTS with the filter's own weights. Off, the old one-tap pass runs untouched.
- **A lit texel's tag sits exactly on the edge of the valid range**: -1 is share 0. A centre fetch that
  picks up 1e-7 of a neighbouring +1 reads -0.9999998, decodes as untagged, and the texel is tested
  against the emitter's bar. The gate's instrument check found it — the GPU's bright target 1.3% over
  the documented formula on the glint panel and exact on its twin to the left, which is a rounding of
  the fetch position and nothing in the formula — so the bright pass decodes with a 0.01 tolerance,
  clamped. The composite does not need one: there untagged and share 0 are the same number.

**In the district it was most of the night's bloom.** `tools/bloom-source.mjs` reads the scene target
and its tag at the hero cameras, re-runs the bright pass in JS and splits what it takes by where the
light came from, checking itself against the GPU's own bright target every frame (ratio 1.0000 at
corridor/night). At corridor/night the OLD pass took:

    emitted     3.5%     the windows, the lamp lenses, the car lamps
    LIT        89.9%     the lamp-lit cream facade (one region of 43,872 px), the canopy over the
                         lamps, the road markings, the parked cars' bodywork
    untagged    6.6%     the awning soffits' additive glow, the shopfront spill on the pavement

So the night frame's glow was a halo round everything a street lamp touched, which is the reviewer's
plate at every scale. Priced on the same readback, the lit share left at each candidate bar:

    lit bar, x the night threshold     x1     x2     x4     x8    x16    x32    never
    lit energy left, of the old total  88.6%  39.0%  16.5%  10.2%  7.8%   6.3%   0

Noon's threshold is x11.3 at night, between x8 and x16, and the pass takes 82% less in all. All six
frames, the old pass's input by source and what the shipped pass takes of it:

    frame              emitted    lit    untagged    shipped / old
    corridor night       3.5%   89.9%     6.6%          0.179
    fivepoints night    54.3%   38.6%     7.1%          0.577
    corridor dusk        0.1%    3.7%    96.2%          0.963    the untagged is the dusk SKY
    fivepoints dusk      0.7%    5.7%    93.6%          0.945
    corridor noon        0.0%   99.4%     0.6%          1        the pass is unchanged at noon,
    fivepoints noon      0.0%   99.6%     0.4%          1        and the glints are the design

"Shipped / old" is read two independent ways that agree to three places — the full-resolution priced
table interpolated at the shipped bar, and the GPU's own half-resolution bright target against the
old total — and the GPU matches the documented formula to 1.0000 on every frame (1.0001 at noon, the
old one-tap path). So the change is a NIGHT change: dusk's bloom is the sky's, and it moves 4-5%. What is
lit and still blooms is the glare a camera would give: the brightest lit source left is a 147 px patch
of mullioned facade at (987-995, 446-465), 6.2 exposed, right beside where a lamp's point light stands —
and in the FRAME it reads as the brightest lamp on the street. It is lit, not emitted (the map is pure
green there), so "weight the pass by the share" would have put out the thing a viewer takes for the
lamp. I first wrote it down as the lamp's globe, lit by its own light; the globes are `headMat`,
emissive 2.4 at night, and a crop of the map put it on the wall instead.

#### THE ORIGINAL RECORD
### #118 OPEN — at dusk and night a lamp-lit plate BLOOMS: the night bright-pass catches diffuse surfaces
From the plate's blind reviewer, in both arms: "Unclipped plates bloom at dusk and night. The halo is
the same on all four sides (about 19% left and right, 13% above, 39% below at 4-8 px) and is zero at
noon. At night a plate at only about sRGB 87 still spreads light 12-14 px onto the bodywork, and at
noon a plate at about sRGB 144 spreads none. A photograph does not glare around a mid-grey diffuse
surface." At dusk the blank plate read "a uniform glowing peach panel (24x its own paint)", the paint
2 px off it +36% brighter than in the face arm and still +2% at 14 px.

The mechanism reads straight off `daynight.js`: night's bloomThreshold is 0.118 in EXPOSED units,
derived as "0.6325 nits ... Same radiance, new units — which matters most here, because at night
everything that blooms is an emitter". A white plate under a street lamp is a few nits; so are lit
pavement and white paint near a lamp. The premise is what the plates falsify: at night a lamp-lit
DIFFUSE surface clears the threshold too, and gets a halo no camera gives it.

Not retuned here, because the same comment records why the threshold sits where it does: moved in
display units it "would have switched the lit windows out of the bloom" — the emitters and the brightest
lit surfaces overlap in radiance, so a threshold alone may not separate them. The candidate that does
not depend on separating them is #114's own tag: every lit material already writes the share of its
radiance that is EMITTED into the scene target's alpha, and weighting the bright pass by it at night
blooms what emits and not what is lit. Measure first: the radiance of lit windows, lamp heads and car
lamps against lamp-lit plates, pavement and paint at the night hero cameras.


### #119 FIXED — the lens halos removed: a blind reviewer preferred no halos in both pairs that showed them
**The blind review (2026-10-17, r12b, halo0 against bloom1 = everything shipped; key
`docs/shots/blind-key-r12b-halo0-r12b-bloom1.json`).** The reviewer found the term by measurement — "a
set of glow cards on the lamps of the two lit TRAFFIC cars at the fivepoints junction ... nothing
else in any frame belongs to the term" — and said which letter carried it from the pixels alone,
both times correctly:

    pair              preferred        confidence   strongest reason
    fivepoints dusk   no halos         3            "two pale translucent vertical posts in front of the
                                                    red car's headlamps ... light standing in the air"
    fivepoints night  no halos         3            "two bright vertical bars (peak +93) on top of the
                                                    round bloom both arms share"
    the other four    neither          1            no lit traffic car in frame, or noon

Measured inside the four lamp boxes, |diff| >= 4: 810 px at dusk and 1,222 at night, with 0-1 px
differing in a building strip as the registration control. The shapes: two 5 x 22-25 px ellipses
before the headlamps, a 9 x 20 px red ellipse behind the tail "cut by a hard vertical edge exactly
where the body begins", and 1-px hairlines on a car seen more exactly side-on — the disc's own
edge, as this entry guessed. The reviewer's one cost: on a side-on car at night the tail halo was
"the only cue that the taillight is lit" beyond the road spill, because the tail lens does not wrap
round the corner of the body (#125). Their caveat: no lit car faced the camera, so the halos were only
ever judged edge-on.

**So the halos are gone from `buildCarGlowGeometry`, not switched off**: hiding geometry is not the
same as not paying for it (CLAUDE.md), and a switch left on a build with nothing to switch is an arm
pair of one build twice. 64 -> 32 triangles a car in the glow mesh, which draws at most 6 cars and
casts no shadow; the ground pools are untouched. `setCarHalo`/`carHalo`, the shader injection, its
cache key and `ground-albedo`'s `halo0` arm went with them.

#### THE ORIGINAL RECORD
### #119 OPEN — a moving car's lit lamps stand upright BARS in front of it at dusk and night
From the lamp face's blind reviewer, in BOTH arms, so independent of the face: at fivepoints dusk and
night "two vertical bars stand in front of the red car's nose at x643-660 y560-590; at x652 there is a
165-180 luma plateau about 20 px tall and 5 px wide. A red bar about 10 x 21 px with a hard top edge
sits behind its tail (x454-463 y568-591). A photographed headlamp glares as a round or horizontal bloom
on the lamp itself."

The likely mechanism is in `buildCarGlowGeometry`'s `halo()`: a disc at each lens, centre bright and
rim black, built in the plane of the lens — a WORLD-SPACE vertical disc facing along the car's axis.
Seen nose-on it is a round glow; seen from the fivepoints camera's three-quarter angle it foreshortens
toward its own edge, which is an upright bar, and its "hard top edge" is the disc's rim clipped where
the octagon's black vertices sit. Glare is a property of the CAMERA, not of the space in front of the
lamp, so it is round in the image whatever the car's heading — and the post stack already makes one
from the lens itself. Not diagnosed: the first measurement is the halo's own contribution against the
bloom's at those boxes (the halo is a MeshBasicMaterial, so it carries no #114 tag and `bloom-source`
counts it as untagged), and then whether a camera-facing halo or none at all is the fix.

*Switch and arm in place (2026-10-15):* `setCarHalo(0)` removes the discs and keeps the ground pools
(`src/carbody.js` HALO_U, told apart by the vertex normal: every halo vertex sits on a disc normal to
the car's z axis, every pool vertex on a horizontal plane), and `halo0` pairs with `bloom1`, which is
everything shipped. Smoke-tested in the district: the switch reads back 0 and 1, six glow programs
compiled under the new cache key, no shader error. The pair is in the 2026-10-15 r12 capture.

### #120 OPEN — the "amber blocks" were not located, the earlier diagnosis was wrong, and the census turns the question round
**Two corrections to the record below, both mine.** "`buildTrafficCarGeometry` paints it `0xd8801e`" is
false: that colour is `buildPlayerCar`'s indicator and the traffic/parked builder has no indicator
band and no amber anywhere — `git log -S` finds none in its history either. And the "parked wagon,
slot 8" was located by projecting cars' BOUNDING BOXES, which hold whatever stands behind a car as
well as the car. Scanning the reviewer's own lamp frames and the r12b frames for saturated orange
clusters (hue 15-45 deg, saturation over 0.55, twice their surround or more) that are not orange at
noon finds 47 clusters at dusk and ~313 at night — warm lamp-lit surfaces under the street lights —
and none within 20 px of either reported box. So what the reviewer saw is unlocated; the likeliest
candidate on the code is the lamp face's outboard chrome bowl reflecting the warm-lit street
(metalness 1, F0 0.62), which is a guess and is recorded as one.

**And the census (`reference/sarasota/amber-census.json`, 2026-10-15/17) says the fleet's defect is the
opposite one.** Real cars carry an amber element at the front corner on **16 of 32** (50%; 16 of 29
counting only views that show the side face) — and this fleet carries none. Where it is present: lens
over the paint beside it white 0.673 (n 4), silver 1.344 (n 4), dark grey 1.775 and dark blue 2.748
(n 1 each), tracking paint tone inversely; 0.41 of the headlamp's width and 0.50 of its height,
0.082 of its bounding-box area (a strip, chevron or corner wedge, not a block); a muted orange-red
to salmon, hue 8-28 deg. No black or red car survived measurement. That is a target for a feature
— side markers on about half the fleet, which instanceColor cannot gate per car — not a fix.

#### THE ORIGINAL RECORD
### #120 OPEN — amber blocks on parked cars' front corners at dusk and night, "lit parking lamps"
Same reviewer, both arms: at fivepoints "x720-724 y547-553 are 8.1x their surroundings at dusk and 8.6x
at night; x734-738 y541-545, 3.6x and 3.4x. They read as lit parking or indicator lamps", absent at noon.

**Measured: it is a PARKED car**, a wagon (parked slot 8, at (68.7, -159.2), 34.8 m from the
fivepoints camera) whose screen box [731-800, 530-580] holds the reviewer's (736, 543) at its front
corner. So the first reading below is out, and the amber is not emitted: the parked palette lights
the tail and headlamp texels only. It is the indicator's ALBEDO — `buildTrafficCarGeometry` paints it
`0xd8801e`, linear luma 0.30, about 16x a black car's diffuse paint — lamp-lit at dusk and night, and
in the reviewer's frames also bloomed by the night bright pass #118 has since changed. That is the
headlamp face's defect on the one lens slot the lamp census never measured.

Two readings were on the table before that measurement, and they wanted opposite fixes. The traffic pool's emissive palette lights the indicator
texel (`PALETTE[6]`, 255/122/14), and a US car with its headlamps on DOES show lit amber side markers
at its front corners — so on a moving car this is correct and the defect would be only its size. The
parked pool's retroreflector palette lights the tail texel and the headlamp texel and NOT the indicator
(`writeRetroTexels`), so on a parked car nothing should be amber and lit. Not diagnosed: the first
measurement is which pool the car at (720, 547) in the fivepoints frame belongs to.

### #121 FIXED — the crowd walked in the PARKING LANE: its pavements never moved out with the kerb, and the lane pointed half of it into the road
**"The crowd cannot feel parked cars" was the symptom. The crowd was on the wrong side of the kerb.**
`src/kerb.js` widened every street that carries a parking lane: from the ribbon edge outward it is
shoulder to 0.55 m, PARKING LANE to 2.00, gutter pan to 2.50, kerb top to 2.64 and back chamfer to 2.74
— "the parking lane the graph already assumes and the surface never drew". `src/pedestrians.js`'s
pavement insets, `[1.9, 1.45, 1.05, 0.8]` from the ribbon edge, were written when the kerb WAS the
ribbon edge and were never moved, so every kerbed pavement baked at 1.9 m: 0.10 m inside the parking
lane's outer edge, through cars `streetfurniture.js` parks centred at 1.30. Measured offline, 96 peds,
120 s, the pool parked around each focus the way the game fills it, each walker against its OWN
street's edge (`ped-arms`, three foci):

    arm                        parking lane   pan      kerb    PAVEMENT   inside a pool car's BODY
    before                       55-65%      22-24%   3-5%     10-18%       5.31 / 6.80 / 7.86%
    insets only                   3-6%        9-12%   6-8%     74-80%       0.86 / 0.94 / 0.66%
    personal-lane sign only      34-36%      30-33%   8-12%    21-28%       4.55 / 5.70 / 5.09%
    insets + lane                0.5-2.2%    2-4%     1-4%     89-95%       0.04 / 0.04 / 0.03%
    shipped, + kerb-section bake  0.2-1.7%   1.9-3.6% 2-4%     91-95%       0.05 / 0.00 / 0.04%

So one walker-frame in fifteen was inside a parked car — which is what cabin v3's reviewer saw as a
head through a windscreen, and what the bloom reviewer of the same week found again, unprompted, at
corridor noon ("the right-kerb pedestrian's torso is drawn over the dark parked car's roof").

**Three defects, and each was hiding the next.**

1. **The insets** (`KERB_INSETS`, derived, not picked). The floor puts the whole body on the pavement:
   `KERB.backOuter` + a person's radius, 2.74 + 0.35 = 3.09. The first choice puts the walk line behind
   the kerb row on `STATION_LINE` 2.85 (now exported from `src/kerb.js` once, where three modules read
   it): plus the row's p90 solid radius 0.40 (measured 0.396; bollards are 755 of its 1,342 at p50 0.157)
   plus a person's radius, 3.60. The measurement agrees — across 28,514 mid-segment kerbed stations the
   share of offsets where a walker touches a solid prop or comes within `BUILDING_MARGIN` of a wall is
   lowest at 3.6-3.7 m (8.9%), against 10.3% at 3.1 and 12.6% at 5.0. Streets with no kerb keep the old
   list, because there the pad does run to the ribbon.
2. **The personal lane's sign.** `_laneOf` signed the displacement by SIDE; `_targetAt` applies it along
   the TRAVEL direction's normal, and the pavement is offset along the EDGE's, so for a ped walking the
   edge backwards the two are opposite: mid-walk, forward walkers sat p50 +0.23 m from their walk (away
   from the road, as the comment said) and backward walkers p50 **-0.73** (p10 -1.06) — into it, under a
   comment saying the lane "always points AWAY from the carriageway ... so nobody can be nudged into the
   road". It was invisible in the parking lane, where 0.9 m toward the road is still parking lane. Behind
   the kerb, 3.60 - 0.90 is the back chamfer. It is a candidate for part of what `_pushOffRoad` was
   written to undo: at inset 0.8 a backward walker's band put them 0.1 m INSIDE the carriageway before
   anybody had pushed them.
3. **The bake held a pavement to the carriageway alone.** With 1 and 2 fixed, 422 of 65,998 kerbed
   pavement samples still lay inside a parked car's body when every one of the district's 2,569 slots is
   filled — and 419 of the 422 were ANOTHER street's slot: the inner pavement of a divided road, laid down
   its neighbour's parking lane, and walk ends at a junction reaching into the cross street's lane.
   `_inKerbSection` is the carriageway plus, on a kerbed street, everything out to the back chamfer; the
   bake's trim and its mid-walk test use it, and the PUSH still uses the carriageway, because what that
   keeps a ped out of is traffic. Now 0 of 56,538.

**What it cost**: kerbed pavements baked 779 -> 689 of 884, and 34.85 -> 27.34 km of them after the
junction trim; plain streets 852 -> 827. Of the 195 kerbed rejections, 102 are short connectors that
nothing survives trimming back to both cross streets' kerbs (3.49 km), 53 run into buildings (3.78 km)
and 40 still cross another street's kerb section mid-walk (3.56 km). The network kept is 1,516 of
1,870, 81.1%, against `reaction-test`'s bound of 80% — close, and the bound is the right one: a
pavement laid through a parking lane is the defect, not coverage.

**Gated** in `reaction-test`'s "the crowd and the kerb", every check beside the pre-#121 crowd rebuilt on
an instance as its known-bad: every kerbed pavement behind its own kerb by a body radius (nearest 3.090
against 3.09; before 0.288), no pavement sample in any slot (0 of 56,538; before 36.8%), the lane away
from the road in both directions (400 / 0; before 200 / 200), and a 48-ped crowd among the 44 cars the
pool parks at the hero focus (0.000% of walker-frames inside one; before 6.87%). The offset check's count
guard matters: under the kerb-section bake the old insets bake NO kerbed pavement, and a minimum over
nothing is Infinity. `mutation-sweep` rows `ped-kerb-insets`, `ped-lane-sign`, `ped-kerb-section`.

**And the road push's convergence check had to be rebuilt**, because it needed a ped inside TWO
carriageways at once and the crowd supplied one only through defects 1 and 2: with both fixed the run's
worst count was 1, and the check would have failed a resolver that works. It now builds the junction —
a point a metre along each of two crossing streets from the hero junction's vertex — and asserts two
passes and clear.

#### THE ORIGINAL RECORD
### #121 OPEN — a pedestrian walks THROUGH a parked car: the crowd cannot feel parked cars at all
From cabin v3's blind reviewer, in both arms, filed as "a pedestrian head drawn over the windscreen"
at corridor dusk (205-265, 600-640): "the body is hidden behind the car, yet the head reads 12-38
where the glass reads about 110-154 ... and casts a dark halo onto the glass". A 4x crop of
`docs/shots/cdet-cdet1-corridor-dusk.png` settles what it is: a dark head standing up THROUGH the
near-left parked car's windscreen and roof line, its body inside the car. The "dark halo" is the
screen-space AO doing what it should at the depth step where a head pokes out of a pane.

The mechanism reads straight off the code. `src/pedestrians.js` feels street furniture through
`setProps`, and `district/main.js` hands it `furniture.placed` — the furniture pass's own placement
list, which holds benches, bins, planters and masts and never the parked pool, whose slots live in
`this.parkSlots` and are drawn by a separate InstancedMesh. So a walker whose path crosses a parking
lane passes straight through whatever is parked there. Not measured: how often. The first measurement
is the crowd's ped-frames inside a parked car's footprint (plus a body radius) over a replay, against
the same count for the furniture props the crowd does feel — and the lever, if it is common, is the
body collider's own idea: a car as three circles along its axis, handed to `setProps` beside the
furniture, so a walker veers round it as it veers round a planter.

### #122 FIXED — two thirds of the crowd ended up stuck at a kerb for good: a walker handed a pavement across the road could never cross and never gave up
**Two causes, and the second was the one survivor of the fix for the first.**

1. `_chooseNext` now refuses a continuation whose handover crosses a carriageway — the path `_enter`
   will give the ped, round the corner when `_cornerBetween` finds one, straight otherwise, sampled
   at the trim's own step — and the existing about-face catches a ped with nowhere left, which is
   what its own comment ("every continuation is across the road") had always said it was for.
2. With that in, ONE ped at `reaction-test`'s focus was still held for 38.2 s of 60: mid-walk, its
   personal lane — which since #121 points away from the ped's own road in both directions — had
   put its target inside an ALLEY running right beside the pavement, so the push held it at the
   alley's edge. `_targetAt` falls back to the walk's own node when the displaced target is in a
   carriageway (the node is clear by the bake): 4,688 of ~172,800 targets in that run, 2.7%.

        at the hero focus, 96 peds, 120 s     held at a kerb ever   still held   road pushes
        before                                       67                 67        32% of ped-frames
        after                                         0                  0         0
        at reaction-test's focus, 48 peds, 60 s   worst spell    held at the end   pushes
        before                                      58.4 s             20           43,864
        after                                        2.2 s              0              184

The crowd turns more corners (235 -> 450 in the 120 s run) and refuses 1,158 crossings, with 0
dead-end turns and 0 stuck despawns. `reaction-test` gates the longest unbroken push (under 5 s,
against the pre-#122 choice of pavement at 58.4 s), and `mutation-sweep` rows `ped-cross-refuse`
and `ped-lane-clamp` are each caught by it. The crowd still never crosses a road, which is the rule
this module already meant; a pedestrian crossing is a feature (signals, traffic that yields), not a
fix.

#### THE ORIGINAL RECORD
### #122 OPEN — two thirds of the crowd ends up stuck at a kerb for good: a walker that picks a pavement across the road can never cross and never gives up
Found measuring #121, and it predates it. At the hero focus, 96 peds, 120 s, wrapping `_pushOffRoad`:

    build           peds ever held at a kerb   still held at the end   spell p50   line to next waypoint crosses a road
    before #121             67                        63                55 s                553 of 553
    after #121              67                        67                92 s                569 of 569

and about 31% of all ped-frames are a push, 99.9% of them at walk node 0 and under 1 cm deep, p50
3.9 mm: a ped standing at the kerb walking into it.

Two rules, each right on its own, compose into an absorbing state. `_chooseNext` admits a next
pavement whose first point is within 16 m — "anything this far away is on the far pavement across
the road" — and a narrow street's far pavement is nearer than that (6.6 + 2 x 3.6 = 13.8 m), so the
ped steers straight at it; `_pushOffRoad` clamps it at the carriageway edge every frame; and the push
CLEARS the stuck clock, on the stated argument that "a ped walking the kerb line with the crowd leaning
on it is making progress along the pavement — it is simply being held off the road". A ped walking
INTO the kerb is not making progress, so the stuck handler that would turn it round never fires.

`_chooseNext`'s own fallback already names the intended rule — "every continuation is across the road:
about-face" — and the 16 m distance was standing in for it. The candidate fix is the quantity itself:
refuse a continuation whose path from here (through the corner detour when `_cornerBetween` gives one)
crosses a carriageway, and let the existing about-face catch a ped with nowhere left. Not measured yet:
where the crowd goes once nobody crosses, and what `reaction-test`'s road-push bounds read, since their
"46,957 road pushes in 60 s" is mostly these peds.

### #123 OPEN — a street lamp at night is a dot or a disc, never a glare: the lit-surface bloom #118 removed was standing in for the lamp's own
From #118's blind reviewer. With lit light off the bright pass, the small lamps at fivepoints night
read as "bare dots" — the pole lamp at (795, 406) had a halo x1.96 at r=6-10 px in the old arm, the
twin globes at (686, 431) x1.5-1.95 at r=12-16 — and in BOTH arms the far lamp at corridor night
(990, 455) is "a flat disc about 45 px across: it holds >= 0.81 linear out to r=10, half-maximum at
r~16, nothing beyond r~26 — a fuzzy ball with no glare tail". A photographed street lamp at night
glares from a bright CORE with a long falloff. Not diagnosed; the first measurement is each lamp
emitter's own exposed radiance and on-screen size against the bright pass's night threshold, and what
draws the 45 px disc (a halo sprite would carry no #114 tag and count as untagged).

### #124 PARTS 1 AND 2 FIXED — the star strokes were fwidth() across the star field's own cell faces, and the signal lens was a square plate; two items remain
**The night-sky strokes.** At 8x the reviewer's two boxes in `r12b-bloom1-fivepoints-night`, (241-252,
56-67) and (271-283, 66-74), are two stars each wearing 1-px straight lines — an L and a bracket.
`src/sky.js` draws one star per occupied cell of a 3D lattice over the view direction and measured its
size in pixels as `dist / fwidth(dist)`; `dist` is measured inside the star's own cell, so it JUMPS at
every cell face, and the derivative of a jump is the jump. Across the row of pixels straddling a face
the pixel read as a whole cell wide, `px` fell toward 0, and the row lit at the star's full core: an
occupied cell drew its own faces. The fix differentiates `dist` through the continuous coordinate —
its cell-space gradient is `rel / dist` and `s = d * 118` has no jump — which is the same number
wherever `dist` was smooth, so every star keeps its size.

`tools/star-strokes.html`, the real Sky at the night preset through the real PostStack, looking up
away from the city, both arms off one page (`uStarAA` 0 and 1):

                               before     after
    bright components               79        27     the strokes were fragments
    stroke-shaped (>= 4 px, < half full)  5    1
    longest component, px           9         7
    matched stars, median peak after/before   0.937 over 47 stars

**The one left is a different, smaller defect:** a star near a face has its OWN glow cut by that face,
a dim straight edge rather than a lit line (one 3-px triangle on the page). Each star is evaluated in
its own cell only, and at the hero framings a cell is about 9 px while the brightest star's spread is
about 5 px in radius, so the comment's "the whole spread still fits inside one 0.49-degree cell" is not
true for the bright ones. The fix is the 2 x 2 x 2 block of cells round the fragment, about 8x the star
cost on every sky pixel; not taken until a reviewer can see the edge. Gated by `star-strokes` (5
checks, selftest 10); `mutation-sweep`'s `star-aa-off` and `star-aa-fwidth`.

**Part 2, the square signal lens (ff96583).** Every aspect lens in `_signalMast` was `plate()`, a square
emitter at any distance, which is what the reviewer's 0.98 fill of a 15 px box was. `lensDisc()` is an
n-gon fan in plate()'s own plane and winding, `LENS_SIDES` 8, with a flat at the top and bottom like
the visor over it; an octagon's flats sit 7.6% of its radius inside the circle, half a pixel on that
lens. `kerb-stand` builds the module's own `_signalMast` in a frame of each handedness and measures each
lens off the buffer: the nearest point of its OUTLINE (edge midpoints, because a square's four corners
are one distance from its centre and a vertex-only measure reads it as a circle) over its farthest
vertex, which is cos(pi/n) for a regular n-gon:

                                       roundness   lens triangles facing away
    the plate, rebuilt as KNOWN-BAD       0.707
    the octagon, both hands               0.924     0 of 48           bound 0.9
    every triangle the dress pass emits             0 of 299,332      (a new district-wide check)

Price: +6 triangles a lens and three lenses a head, so 134 -> 152 a mast, over the 233 masts that stand:
+4,194 geometry district-wide, in the furniture bucket (x1.28 in shadow-bill) before the resident share.
`mutation-sweep` rows, each run alone: `lens-square` caught by kerb-stand and blocker-test,
`lens-hexagon` (0.866, between the square and the bound) and `lens-winding-hand` (the fan wound one way
in both frames, right in one hand only) caught by kerb-stand. The pedestrian head stays a plate. Not
reviewed blind yet; the hero framings hold the lens at about 15 px.

The remaining three, as filed:
- Night-sky specks carry 1-px straight bracket-like strokes: fivepoints night (241-248, 56-66) and
  (271-283, 66-74).
- The green signal lens is a flat square emitter (about 464-476, 400-414).
- Foliage is hard alpha-cutout cards in a camouflage pattern (corridor canopy, 650-1300 x 0-300) and
  tree limbs are flat tan ribbons, e.g. (0,500)-(450,250). `leaf-mask` is the gate nearest to this.
- At corridor noon the cornice's cast-shadow edge on the brick re-rasterises between two captures with
  no light change: 56 px along (12,340)-(439,430), 1-6 codes, so in motion it would shimmer. The
  sun's shadow box is #117's; the first question is what moved between the two captures.

### #125 TWO OF FIVE FIXED, THREE OPEN — what #119's reviewer found wrong in BOTH arms, cars first
**The side-on taillight: FIXED (0812a0e).** `overlayBand` lays the tail lens flat across the rear
profile, so every lens triangle faced straight back. Off the buffers, 0.0 cm2 of tail lens faced either
side on all three shells AND on the player's car, the lens stopping 6-10 cm inboard of the flank. Real
tail lamps wrap the corner, and a US car carries a red rear side marker there (FMVSS 108).
`tailWrap()` puts the lens's own height, 0.14 m of it, on each flank at the rear corner, on the same
slot, so the night palette lights it: 173.6 cm2 facing each side on every build. The saloon's and
wagon's flanks taper at the corner, so about 144 cm2 of their wrap also faces back. `car-detail` gates
it off the buffers (every build and side at least 100 cm2; KNOWN-BADs for the rear-only lens and for
the fleet wrapped without the player's car). Rows `tail-wrap-fleet-off` and `tail-wrap-player-off`,
both caught by car-detail. +4 triangles a car. Not reviewed blind.

**The polygonal wheels: FIXED (298290a)**, recorded here late: the fleet's and the parked cars' wheels
are 12-gons, a wheel's flats 3.4% of its radius inside the circle where the 8-gon's were 7.6%, +160
triangles a car (320 -> 480 of the wheels), gated by `car-shapes`' roundness check.

Still open, as filed: the cartoon headlamps, the dark ring round the wheel arches, and the foliage.

#### #125 (as filed)
- No lit taillight on a side-on traffic car at night except the road spill: the tail lens does not
  wrap round the corner of the body, and the halo that stood in for it is gone (#119).
- Polygonal wheels on the nearest cars: the corridor near-left car's front wheel is octagonal at about
  (285-335, 760-860), and the fivepoints white parked car's rim at (1060-1100, 600-640).
- "Cartoon headlamps" on the corridor near-left car: the pods read as eyes, black rings with white
  centres on flat dark plates at about (10-60, 765-785) and (160-230, 765-785) — the lamp face's
  bowls at the nearest distance any capture shows them.
- A warm dark ring round the wheel arches that reads as dirt or scorch rather than shadow: (91,86,74)
  against the flank's (142,143,142) on the white car, an olive smudge on the corridor car.
- Foliage alpha-cut with leaf clusters floating free of branches, trunks as stretched ribbons
  (corridor right trunk, about 1430-1600 x 0-700), blocky pedestrians — the same as #124's.
None measured beyond the reviewer's own pixel reads.

### #126 PART 2 FIXED — the rigid street furniture is solid to the car, and making it so found #132
Every lamp pole, signal mast, bollard, hydrant, utility pole and tree trunk is a static circle in
`CarBlockers` (`setStatic`, a grid of 8 m cells): 2,728 on the page after #132, set once at load
because none of it moves. A contact out of one is filed `prop`, beside `parked` and `wall`, all three
property damage, so no charge moves. They ghost and settle by the parked boxes' rule, so a car PUT on
a bollard by a respawn is not thrown off it. The knock-aside props — bins, newsboxes, cafe chairs —
are not in it: they want per-prop state.

**The collider is the cross-section a car hits, measured by slicing.** A palm's audit footprint is
its 0.46 m mulch pit, flush with the pavement; the car meets the trunk. So each circle is the extent
of every triangle edge that crosses 0.6 m above the prop's own lowest vertex. The first version kept
the vertices inside a band and found 3 of 325 trees and no signals or utility poles at all: a pole is
a ruled surface with vertices only at its ends — CLAUDE.md's "measure coverage of emitted geometry by
connectivity, not by vertex proximity", arriving as a collider.

    a real Vehicle into a lamp pole at 30 km/h       stops 13.40 m short, health 0.386, filed `prop`
      KNOWN-BAD, no statics                           42.8 m, untouched
    boot-check: the page's CarBlockers holds every solid the page built, and a body circle on a
      lamp pole is pushed clear and named a prop

**And the original entry's "it does not reach the budget drive" was true of the COURSE and not of the
DRIVE.** It censused the planned points — 0 within a body of a lamp pole — and the follower cuts
corners: on every lap it hit a signal mast at (-148.6, -418.8), 2.96 m from the nearest course point,
at 5.6 m/s, health 1.000 -> 0.572 over three circuits. The mast stood 3.0 m in front of the drawn
corner kerb, in the road. That is #132, and with it fixed `route-drive` — which now drives among the
page's furniture, built by the module's own placement — reads 3 of 3 circuits, 88 contacts, all
walls, health 1.000: byte-identical to the drive with no furniture at all.

Gates: `blocker-test` 99 -> 128, `route-drive`'s "touches none of it", `boot-check`'s two wire checks,
and `mutation-sweep`'s `static-off` and `static-ghost`, both caught by blocker-test.

### #126 PART 1 FIXED — parked cars are solid to the car and to the player on foot; poles, trees and bollards are still not
**What shipped.** `src/blockers.js` `CarBlockers` wraps the building index and adds ORIENTED BOXES,
answering the same two questions src/vehicle.js asks (`anyNear`, `resolveCircle`, same return
shape, same epsilon), so the car's contact impulse, its damage charge and its crime wire are the
walls' own and nothing about them is copied. `src/streetfurniture.js` `parkedSolids()` hands over
the cars the pool is DRAWING — `cand[0 .. filled)`, each a box centred on its shell's own bounding
box — and district/main.js re-hands the list whenever the pool refills (`fillSerial`). Only the car
and the walker get the layer: the router, the respawn's clear test, the crowd and the fleet keep
the building index, because a parked car is not a wall to any of them.

**A box that arrives on top of a body is a ghost until the body has left it.** The pool refills by
distance from the camera and the parking lane is drivable, so a slot can become a drawn car with
the player's car in it; made solid at once, the resolver throws the car sideways out of a collision
that never happened and charges it. `release()` does the same for a car that was PUT somewhere — a
respawn, a harness teleport. Both bodies are tested, because the car is stepped on foot too.

**Measured.**

    into a parked car at 30 km/h (blocker-test, the real Vehicle and DamageModel)
      stops with its centre at 9.55 m against a bumper at 11.70; dv 11.10 m/s; health 0.372
      the shipped collider, same drive: 42.8 m, 0 contacts, health 1.000
    the boxes are the drawn cars: 120 buffer corners through their own instance matrices lie on
      their box to 7.1e-6 m (Float32 matrices); a box symmetric about the slot is 0.1795 m off
    the page (boot-check, twice): 30 parked cars drawn; driven into one's side from the road at up to
      13.3 km/h, from 6.195 m off its centre to a closest 3.195 m against a 2.54 m bound;
      31 box contacts; health 1.000 -> 0.928

Gates: `blocker-test` §"parked cars are solid" (16 checks) and §"the parked boxes are the drawn
cars" (3), 99 -> 118, `boot-check`'s host-wire arm (4), and five `mutation-sweep` rows — `car-box-frame`,
`car-box-ghost`, `car-box-release`, `car-box-wallpass` and the browser-only `car-box-wire`.

**Still open, in the order the entry gave:** rigid street furniture (543 lamp poles, 307 trees,
237 signals, 172 hydrants, 140 utility poles, 1,497 bollards) — a crash, like a wall, and the
obvious next layer of the same class; and light props (bins, newsboxes, cafe chairs), which want
knocking aside and so need per-prop state. Two more things this does not do: a parked car is an
immovable box rather than a 1,400 kg body that shoves, and **`tools/playtest.mjs` builds no
street furniture at all**, so the harness has no parked cars for its car or its crowd — a
divergence this entry adds a reason to close.

**And a parked-car contact is filed as a WALL.** src/vehicle.js charges every body contact as
`kind: 'wall'`, and `CarBlockers` answers through the same resolver, so the damage model, the crime
it files and every instrument that counts by kind see a facade. Found when the budget drive's new
impact ledger (#64) read thirteen applied impacts, all `wall`, at z -156.2 to -158.7 on Main Street
east against a course at -161.4 — which is the north parking lane, not a building line.
`resolveCircle` already returned the box's key, so the contact can say what it hit: **it does now** —
`IMPACT.parked`, filed as property damage exactly as a wall is, so no charge moves; `lastContact`
carries the kind and the box. `blocker-test` drives the real car into a parked car and into a
building face at the same z and requires `parked` for one and `wall` for the other, and
`mutation-sweep`'s `parked-kind` puts the old label back.

#### THE ORIGINAL RECORD
### #126 OPEN — the car drives through every parked car, lamp post, tree and bollard in the district
Found reading the call graph while fixing #64's drive, not by playing. The car's body collider is
`vehicle.blockers`, a `BlockerIndex` built from `district.buildings` and nothing else
(src/blockers.js's constructor), and the moving-body contact pass in district/main.js tests three
lists: `traffic._lastPositions`, `peds.positions()` and the pursuit units. Nothing else is solid to
the car. Censused off the page's own builders (the lamp loop copied from district/main.js, then
`dressDistrict` with `audit: true` and `buildParkedCars`):

    parked-car slots   2,280   (the page's pool draws the nearest 30: `buildParkedCars({ count: 30 })`)
    lamp poles           543
    placed props       8,214   bollard 1,497, bin 570, bench 518, meter 514, planter 402,
                               newsbox 379, bikerack 320, tree 307, cabinet 268, signal 237,
                               hydrant 172, utilityPole 140, ... and flush castings (manhole 331,
                               gully 206) that are rightly not obstacles

The crowd learned to feel parked cars and props in #121 (`peds.setProps`); the car never did. So a
player who mounts the pavement, or swerves into the parking lane, drives straight through a row of
parked cars and a lamp post at full speed with no contact, no damage and no crime — in a game whose
whole wanted ladder is built on what a collision costs.

**It does not reach the budget drive, measured rather than assumed:** of the road course's 818
points, the car body (the collider's 0.95 m) overlaps a parked slot at 0 and a lamp pole at 0; the 10
prop overlaps are gullies and manholes, which are flush with the road. So making these solid would
not move #64's course.

Not designed yet. Three classes want three answers, and the order is by how glaring each is:
parked cars (a 1,400 kg body the player can see, and the obvious one), rigid street furniture
(poles, trees, signals, hydrants — a crash, like a wall), and light props (bins, newsboxes, cafe
chairs — knocked aside in every game of this genre, which needs per-prop state this module does not
keep). The first measurement is how often a player's line actually crosses each class, from the
playtest harness's own driving, before choosing what to charge for it.

### #127 FIXED — every route lane was on the driver's LEFT: the HUD line, the budget course and every harness drove in the oncoming lane
**Found while fixing #64's drive.** The budget gate's first road-course lap on Main Street met an
oncoming fleet car head-on IN THE SAME PHYSICAL LANE — its lateral −2.10 m against the car's −2.19,
opposite headings — and each stopped for the other until the run's net. `src/roadpath.js`'s
`offsetRight` took the right of a heading (dx, dz) as (dz, −dx), "where +x is right of +z", which is
true on graph paper with z drawn upward and false in this world: three.js is right-handed with y up,
so a camera looking along +z has world −x on its right. Projected through the vendored three.js, a
point 2 m to world +x of a heading-+z camera lands at NDC x −0.195, the left of the screen.
`src/traffic.js`'s lane normal is (−dz, dx) and its fleet drives on the right, so every route with
an offset drove against it:

- the HUD's route line to a mission marker, drawn 1.5 m LEFT of the centreline;
- the budget gate's road course, 3 m;
- every harness that drives `ROUTE_LANE_M` — playtest's `driveTo`, `clear-time`, `shunt-rate`,
  `reaction-test`'s lane audit — and `route-drive` and `lane-keep`'s course.

**Why nothing inside the module could see it.** `offsetRight` places the lane and `laneOffsets`
tests its clearance, both read one convention, and so they agreed with each other the whole time.
And `roadpath-test`'s handedness checks were LITERALS written from the same intuition as the code —
"a line along +x offset 3 m right lands at (4, −3)" encoded the bug rather than testing it. They
are an oracle now: the offset projected through three.js's own camera at 16 headings (NDC x +0.292
at every one), the old convention kept as a KNOWN-BAD that lands left, and a 12-car `Traffic` asked
which side its own cars are on (6 of 6 on the positive side of `rightOf`). `rightOf` is the one
function every lateral decision on a route reads, and `mutation-sweep`'s `route-side` puts the old
one back.

**What it retired — every one of these was a statement about the wrong side of the road.**

- **#87's mechanism.** "The car is AHEAD and STOPPED, 258 of 258" was an ONCOMING car that had
  stopped for a player in its lane, with the follower grinding into it head-on. On the right side
  `shunt-rate`'s arm A reads 1 car and 2 frames in 45 drives, a car doing 2.89 m/s rear-ended at
  12.02. There is no contact rate left to be monotonic or otherwise.
- **`ROUTE_LANE_M`'s sweep** (3.81 / 4.69 / 2.17 / 18.44 "shunts/km", a frame counter). Re-run on the
  right side, counting distinct cars, every leg from rest, six seeds and then twelve more on the two
  contenders: 1.33 / 1.35 / 1.53 / 0.67 over seeds 0-5 and 1.33 / 1.29 for 1.5 and 2.2 over seeds
  6-17. The 0.67 did not survive its own replication. **The fleet cannot tell 0 to 2.2 m apart, so
  1.5 is kept, not re-chosen.**
- **`lane-keep`'s recorded figures** — the forced band's p90 3.052 → 2.996 m.

**And the flip exposed two latent defects the wrong side had been hiding.** `route-drive` at its
22 m/s wrecked the car 17 s in:

    LANE_MARGIN_M   20 m/s    22 m/s           23 m/s          24 m/s
    1.20            wrecked   wrecked at 17 s  wrecked         wrecked
    1.25            clean     3 impacts        wrecked         wrecked
    1.30 - 1.35     clean     clean            wrecked         wrecked
    1.50            clean     clean            3, health 0.96  wrecked

- **The margin.** On the right the tour passes building 51's corner on Main Street's east side,
  2.84 m right of the centreline, and the fit put the lane exactly 1.2 m off it — "a quarter metre
  of slop", never measured. The car tracked its line to 0.18 m at 21 m/s, its body still reached the
  corner, and a dv 4.24 glancing contact left the steering pull that put it into a wall at 20 m/s ten
  seconds later. **1.5** is the top of the bracket: it is the largest margin at which `ROUTE_LANE_M`
  is still honoured on the narrowest two-way road (6.0 m: 3.0 − 1.5 = 1.5), and it buys 0.55 m
  against a measured need of 0.30-0.35.
- **The seam.** `route-drive` handed `followPath` the ring and reset its state at `done`, and
  `pathSpeedLimit` scans to the END OF THE ARRAY, so the last 25-plus metres of every lap were driven
  blind to the 64-degree junction beyond the seam. Latent while that corner was taken on its outside;
  on the right it is taken on its inside, and the car hit the kerb-side building at 22, 18 and 16 m/s
  alike, on lap 2 every time. The circuits are one polyline now.

With both, three circuits in 745.9 s at 47.2 km/h, health 1.000, 0 applied impacts, 88 free
contacts with the worst at 1.987 m/s — against 1.425 on the left side, and see #128 for what binds.

#### THE ORIGINAL RECORD
Filed as task 45 in the session that found it, not in this file: "the route lane is on the
driver's LEFT: fix offsetRight and restate every gate it moves".

### #128 FIXED — the follower cut every junction with a look-ahead tuned for a steering model it no longer had, and its crawl was not free
**What shipped**, two terms in `src/roadpath.js`, measured one at a time over the 1,416 junction
turns of 60-120 degrees the router allows, each driven with up to 200 m of run-up, walls on:

    look-ahead          crawl floor   charged turns   not completed   median turn time   worst dv
    6 + 0.9 v, >= 8        2.2             93               7              9.9 s          24.37
    6 + 0.9 v, >= 8        1.613           90               7             10.6 s
    2 + 0.7 v, >= 3        2.2             30               1             12.6 s          15.64
    2 + 0.7 v, >= 3        1.583           15               1             14.4 s          18.07   shipped

- **The look-ahead.** `clamp(6 + 0.9 v, 8, 28)` was set when the steering was a flat gain and then
  bicycle geometry, and never re-measured after it became the measured-response inversion. Traced,
  the entry contacts were pure pursuit turning in about 20 m early at 18 m/s and clipping the inside
  building; the exit ones were the car accelerating out of a crawl corner with 18 degrees of heading
  still on and overshooting into the alley's far wall. A 60-law grid puts the optimum at 9-12 m of
  look-ahead at 10-15 m/s; too short (0.5 v) is worse again. Not a weave: from a 1 m offset it
  crosses the line twice at 22 m/s and four times at 28-35, overshoot 0.12-0.16 m against the old
  0.08-0.15. Turn-in braking (brake to the corner speed by the time the AIM reaches the corner) was
  measured too — 93 to 49 alone, and nothing over the short look-ahead (33 and 28 against 30 and 26)
  at more time — and not shipped.
- **The crawl floor.** "Free by construction" compared a speed with a delta-v: the loop holds target
  + 0.3, and a wall charges (1 + e) = 1.15 of the normal speed, so a head-on clip at the 2.2 floor
  charged 2.88. `CRAWL_MS = 2.2 / 1.15 - 0.3 - 0.03` = 1.583, the last term the loop's one-step
  overrun at the coarsest control step a caller uses (clear-time's 1/15 s). `roadpath-test` measures
  the held speed at that step (1.9112 against 1.883 + 0.03) and charges a clip at it (2.1967, free),
  with the old floor's clip as the KNOWN-BAD (2.873, charged).

**route-drive**: 88 body contacts at a worst 1.987 -> **none**, at every cap from 22 to 28 m/s — the
8.52 m corner its comment called beyond any controller included. Mean speed 47.2 -> 34.8 km/h, which
is the price of a line the walls allow. The headroom #128 was about is a check now: the course again
at cap + 4 m/s must be undamaged; the old look-ahead charged 3 impacts at 24.

**What it moved**, each restated in the same commit: `roadpath-test`'s crawl checks (two that could
not fail, six measured); `playtest` §7's pinning pose (the old one backs out by the geometric
reverse now — 60 of 60 of its family); `shunt-rate` §5 (no shunt at 12 m/s any more; 20 m/s, five
seeds) and its fleet-scale bound (the drive is deterministic, so a mis-wired override reads x1.000);
`speed-limit`'s over-the-limit bound (79.5% -> 63.7% over, now bounded by the fleet's 21%, not a
picked half); `clear-time`'s "the follower drives" (an arrest at 150 m is a drive; a rate against the
crawl). And `clear-time`'s own measurement moved: 2-star escapes 27 -> 17 of 160, arrests at p50
~22 s against ~47, property-damage crimes 1.57 -> 0.20 a run in the bare world. The old follower got
its distance by cutting junctions through buildings; a harness driver is a model of a player.

**Residual, 15 turns on seven alley edges** (55, 563, 475, 1, 2, 756, 3), all 2.8 m `service`.
The first reading of it, kept: "whose own course passes within a body's half-width of a wall — edge
55's course point is blocked by 9 mm. That is the road inside the building, for the router's exclusion
test or a room term, not the follower."

**RE-MEASURED, and that is two-thirds wrong.** Only three of the seven have a centreline a 0.95 m
body circle touches at all (475 by 0.343 m, 563 by 0.110, 2 by 0.101, each at ONE pinch), and the
wall-to-wall gap is 5.5-9.6 m on every one of the seven — no alley is narrower than the car. Placed
against each turn's own course:

    contact 33-159 m before the course ends, mid-alley, at 4.7-21.2 m/s    14 of 15
    contact 1.7 m from the end of a dead-end course, at 15.3 m/s            1     522:239:475, wrecked

So the fourteen are the follower's own tracking at speed against the margin the lane fit leaves it
(the lane takes a 1.5 m-radius clear point, so a 0.95 m body has 0.55 m), which is a room term in the
SPEED control — `pathSpeedLimit` reads curvature and not room, as #131 recorded. And the fifteenth is
a different defect: **`pathSpeedLimit` has no term for the end of the path**, so a drive to a
destination arrives at full speed, which at a dead end is the wall. That one is real for every harness
drive that ends somewhere, and it is priced rather than taken: `playtest`'s `driveTo` arriving while
still rolling is documented behaviour with a dependent (`--selftest` §5b's negative arm needs the car
rolling into a pickup), so a stop at the end restates the harness, not just the follower.

**And the router's justification for admitting the three pinched alleys was false.** Its comment said
"refusing them would disconnect the network". Strongly connected components over the directed graph,
with and without each: edge 2 changes nothing (the largest stays 637 vertices), and 475 and 563 each
lose ONE vertex from it, their dead-end far ends (1090, 1259). The tolerance stands on its other
reason — a 0.10-0.34 m pinch at one point is a scrape for a driver taking care — and the comment says
that now.

**The budget gate on this follower**, two runs on 2026-10-19, against the #64 baseline (three runs
at 6b47266, the old follower):

                         baseline (3 runs)      run 1, 14b5383       run 2, d06c7ee
    triangles p95        832,174 - 845,957      822,195 PASS         827,333 PASS    warn 1,400,000
    draw calls p95       225 - 236              229 PASS             226 PASS        warn 275
    chunk stall ms       10 (kept artifact)     306.6 FAIL           9.3 WARN        warn 8 / fail 16
    lap, s of sim        295.5                  390.9                366.3
    applied impacts      3 walls (kept one)     0 in the lap         0
    repairs / crimes     3-6 / 3                1 / 1 after the lap  0 / 0
    stuck-teleports      1, at index 175        2, at 635 and 654    2, at 635 and 654

Run 2 carries #125's wheels and #124's stars as well, which the triangle row cannot resolve from
sampling (CLAUDE.md: under ~20,000 is not the gate's to confirm).

- **Run 1's 306.6 ms stall did not reproduce.** Run 2 read 9.3 ms, inside #42's clean-box spread of
  8.0-17.2, with the jitter probe on: worst preemption stretch 12.9 ms, 4 samples past x5. Run 1 was
  the first browser on a container that had just restarted, and for five minutes of it a builder's
  offline probes were building the district's furniture beside it; it had no jitter probe, so the
  306.6 is unattributed, not explained.
- **The follower costs the lap 24-32% more sim time and no damage.** 0 applied impacts in either lap
  against 3 wall hits in the baseline's, p50 speed 19.5-25.3 km/h against 33.8 — the crawl corners.
- **Run 1's repair and crime were the HARNESS.** The runner polls the lap count every 4 s of wall
  clock, several seconds of sim at time scale 22, and the autopilot drove on through them with its
  progress index back at 0, turning for the start of the ring it had just finished at 76 km/h: a
  16.37 m/s write-off into a prop 2.3 s after the lap, charged to it. Since d06c7ee the car brakes
  once the lap is driven (`lap_end_t`); run 2's last contact is a 0.62 m/s free graze under that brake.
- **The two stuck-teleports are a PARKED CAR, the same two in both runs**, which run 2's ledger could
  say because d06c7ee counts free contacts too: 225 and 262 frames against a parked car at a worst
  2.06 m/s — under the 2.2 free line, as `CRAWL_MS` was derived to keep it — with the car 3.6-3.8 m
  wide of its line and stopped. The course's own radius there is **3.2 m at index 633 and 2.6 m at
  653**, against the car's standstill minimum of 8.45, both right turns with the kerbside row on the
  outside. That is #104's "router emitting corners under the car's turning circle", which #104
  deferred to a fresh baseline; #64 has since moved the baseline, so the lever — rounding `tour()`'s
  junction turns to `R_min` — is unblocked, and these two stops are its first deterministic subjects
  on the gate's own course. The old follower cut both corners inside, so it was not stopped there and
  hit walls instead; the baseline's one teleport, at 175 (a 4.3 m corner), is now driven.

The artifacts are `docs/drive-traffic-128a.json` and `-128b.json`; `docs/drive-traffic.json` stays
the #64 baseline.

#### THE ORIGINAL RECORD
### #128 OPEN — `route-drive` holds its 22 m/s by 0.5 m/s, and what binds is a 2.8 m alley taken at 72 km/h
On the right side of the road the worst charged contact climbs with the speed cap and leaves the
2.2 m/s free band between 22 and 22.5:

    m/s      18     20     21     21.5   22     22.5   23
    dv     0.85   0.81   1.52   1.82   1.99   2.34   3.03

Everything from 21 up is ONE site: the 30-degree bend at course index 66-72 from edge 32 (6.6 m)
into service alley edge 350 (2.8 m, single-track, so the lane drops to the centreline). The
follower takes it at its corner-speed limit, 19.6-20.0 m/s, runs 2.5-2.9 m wide through it, crosses
its line at index 73 and overshoots to 1.84 m on the far side, where the body scrapes the alley wall
at index 75-76. The crawl corner at 561-563 (8.52 m on this side, where the car needs 9.07 m at its
2.2 m/s crawl) reads 0.68-0.81 at every speed, free by construction.

`route-drive` is deterministic, so this cannot flake. It can be TIPPED by any change that moves the
follower's line through that bend by a few tens of centimetres, and the budget gate drives the same
course at the same cap. The lever the measurement points at is a WIDTH term in the speed limit — the
follower reads curvature and nothing about how much road there is — but nothing has been tried.

**And it is not one site, measured by driving every junction turn at speed (#131's census).** From
rest 40 m out, every turn of 90-120 degrees completes. With a run-up — from rest up to 200 m before the
junction, so the follower reaches its own speed — and, as a second protocol, placed at 18 m/s 80 m out:

    |deflection|   not completed          completed with a charged contact (dv > 2.2)
                   run-up    placed       run-up    placed
      60 - 90      1 of 722  2 of 722       51        62
      90 - 100     4 of 626  2 of 626       33        54
     100 - 120     2 of 68   4 of 68         4         3
    the worst, placed: dv 11.47 into a 2.8 m alley at 90.5 degrees; 9.51, 8.77, 8.29, 7.91 at right angles

Two protocols that agree on the shape — a few failures and dozens of charged contacts at ordinary
junctions, none of them a geometry the car cannot make from rest — is what makes it a finding rather
than an artefact of placing a car at speed.

So the follower's speed control into a junction is the defect, and it is the same one as the alley
bend: it brakes for the CURVATURE ahead and knows nothing of how much road there is, so it arrives at
a right angle into an alley at a speed the alley's width cannot hold. #131's one regressing leg is
the extreme of it — a 114.6-degree corner completed from rest in 12.1 s, reached at 76 km/h after a
straight-line brake, placed wrong for a corner tighter than its own turning circle, and lost to the
reversing cycle.

### #129 FIXED — a route that opened behind a moving car is the last resort now, and where every route turns round the harness stops first
**What shipped.** `RoadGraph.path` takes the car's `heading` and `speed`, and for a car at or above
1.0 m/s (src/wanted.js's SCENE_STOP_MS) it prefers any of its four start/end combinations that does
not TURN ROUND — open behind the nose, or double back along the edge the car is on, which is what a
route to a dead end does — and the shortest within each class. A preference, not a penalty, so there
is no number in it. When every combination turns round it says so (`turnsBack`), and playtest's
`driveTo` brakes to a stop first, because followPath's three-point turn was traced from a standstill
and works there. A caller that passes no heading is routed exactly as before; the HUD's line is one.

**Measured.** Over 1,415 chained random legs arriving along each path's own last segment, routed
blind, 894 opened behind the car (63.2%); with the heading 225, and those 225 are routes no
alternative avoids — dead-end 2.8 m alleys and one-way streets. What it costs where it chose
differently: p50 +37 m, p90 +171, max +742. And on the follower, 60 such legs driven by `driveTo`
arriving at 11 m/s with no fleet:

                                      arrived   wrecked   applied wall hits   timeouts
    a route opens ahead      blind       19         8            40              3
                             heading     22         1             9              7
    no route opens ahead     blind       15        14            57              1
                             heading     27         0             8              3

Leg 7 itself opens at cos −1.00 to the nose blind and +0.88 with the heading, for 3 m more route.
**The timeouts went UP, 4 → 10, and that is #131, not this:** the forward routes reach junctions the
blind ones avoided, and one of them turns 121 degrees into the 2.8 m alley of #128.

The first version of the doubling-back term compared `r.edges[0] === a.edge`, and a route's edges
are `{ e, forward }` OBJECTS, so it never fired — the leg it was written for still timed out, and
the trace said so before any table did. Gates: `roadpath-test` §6c (5 checks) and
`mutation-sweep`'s `path-uturn` and `path-spur`.

#### THE ORIGINAL RECORD
### #129 OPEN — a path that starts behind a moving car: the follower circles forward 44 m off its line into a building
Found as the whole of `ROUTE_LANE_M`'s re-run wall column (#127), which it had made unreadable: in
the sweep's no-fleet control, 18 legs per offset, every applied wall impact was ONE site, at every
offset including the centreline. Leg 7 of the district's route, chained at speed in playtest's `driveTo`: leg 6 arrives at
(208.5, −381.4) doing 11 m/s heading −z, and leg 7's path starts up service alley edge 574 heading +z.
Traced at 30 Hz:

    t+0.0 - 1.1 s   the three-point-turn rule fires: reverse throttle, i.e. braking, 11.0 -> 2.7 m/s
    t+1.3 s         reqRadius has grown past 0.95 R_min(v), so it COMMITS FORWARD on full lock
    t+1.3 - 9.6 s   a ~22 m circle, off the line 9.5 -> 44.0 m, out of the street
    t+9.75 s        dv 11.42 into a wall at (167.5, −368.6), 41 m off the line, then pinned there

followPath's comment says its rule was traced "both times a `driveTo` from a standstill", and from
rest it works. At speed the reverse is a brake, the car comes to rest pointing the wrong way, and
by then the forward circle looks achievable to a test that cannot see the street is 6 m wide. Every
harness that chains `driveTo` legs meets it wherever a path opens behind the car. Two levers, neither
tried: `driveTo` arriving at rest, or the turn rule preferring the reverse whenever the forward
circle does not fit the corridor.

### #130 FIXED (the cloud) — the glazing is exempt from the screen-space AO; the torso is unsettled, and the leak on everything else is the range check's

**The reported cloud reproduces, off the committed frames and then on a purpose-built page.** The dusk
box the reviewer quoted, (218-250, 628-660), reads 0.0570 linear in `cab31-cfix1-corridor-dusk` and
0.1389 / 0.1427 in the other two arms, which is their 0.057 against 0.139; at 3x the pedestrian is
standing IN FRONT of the car's corner, between camera and windscreen, and the dark haze spreads from
their outline onto the glass. That is the AO's depth-step leak: the range check is
`smoothstep(0, 1, radius / dz)`, and at the shipped radius 0.6 m with `aoRangeScale` 0 it still passes
35% of an occluder 1.5 m proud of the surface, which the 8.5 exponent turns into a halo.

`tools/glass-ao.html`: one fleet car and the player's car through the real PostStack and the real
materials, and a pedestrian-sized block 1.5 m in front of the windscreen, five arms off one page:

    glass, over AO-off, by distance from the block's outline
                 0-8 px   8-16    16-32   32-64      with no block
    before        0.488   0.702   0.944   1.000      1.000
    after         1.000   1.000   1.000   1.000      1.000

    paint beside the same block, before and after   0.708 0.869 0.858 0.979   (no block 0.989)

**The fix is the glass, not the estimator.** Nothing a pane sends is ambient light it could be
occluded from — it is the environment's reflection (gained x6 by `uGlassEnvExtra`) and the picture of
what is behind it (the cabin, and the street through the far window) — so the glazing tags itself
fully exempt through #114's alpha tag, the way an emitter does, in BOTH car materials (the fleet's by
the same pack-alpha test the cabin and the environment gain use; the player's panes are their own
material, every texel glass). The tag is read back through the composite's own `debugEmitShare`: every
glass pixel 0 -> 1, the player's 1,139 too, and paint, block and ground 0 in both.

**What it does not fix, on purpose.** The paint beside the block is darkened to 0.708 by the same leak,
and so is anything else with a nearer object standing in front of it — that is the estimator, and its
lever is `aoRangeScale`, which every contact shadow in the district is priced against (src/post.js's
own table shows it moving the seam the wrong way; its price on the protected metrics was never taken).
A different round. And the glazing loses whatever AO it had in its own creases: 12 glass pixels on the
page, at a pillar, 0.554 -> 1.000.

**The torso is unsettled.** The noon "person inside the car", (12,18,25) over a rear screen, is a
pedestrian whose silhouette overlaps the screen; from the PNG alone it is either somebody standing at
the car's rear corner, correctly drawn in front of the glass, or a depth fault, and only the depth
buffer can say which. The glass is opaque by design (its far window is the environment, not the
scene), so a pedestrian BEYOND the car cannot show through it.

Gated by `glass-ao` (11 checks, selftest 15 with the build before #130 as the first known-bad);
`mutation-sweep`'s `glass-ao-off`, `glass-ao-fleet-seam`, `glass-ao-player-seam` and
`glass-ao-whole-car`.

**Blind review, 2026-10-19: preferred in both pairs that isolate it.** On the glass-ao page (4/5) the
other build's windscreen "darkens in a gradient toward the block's edge... B/A falls to 0.46-0.58 at
x~800 and 0.26 at (800,472)", "a reflection of the block would be sharp-edged, not a gradient". In
blade-noon the same reviewer independently found it on four street cars' windscreens behind
pedestrians (B/A 1.31-1.69 beside a head) and called the darkening "an artifact". One thing reads the
other way and is worth having. Without the AO on the glass, window BASES are no longer darkened, and
the reviewer half-preferred the darker base in two pairs because "real rear windows have a black frit
band and parcel shelf exactly there". So the AO had been faking a frit band, and the glazing has no real
one. That is a feature, not a reason to put the leak back (#125).

#### #130 (as filed)
Reported by three blind reviewers in two rounds, in both arms every time, so independent of what each
round changed. Cabin v3's: a pedestrian behind the near-left car is drawn over its windscreen "with
none of the glass's reflection" and "a dark halo onto the glass", 12-38 where the glass reads about
110-154. Cabin v3.1's, once per build: at corridor dusk a pedestrian at the foreground car's front
corner darkens the windscreen beside them "in a soft cloud" — 0.057 linear at (218-250, 628-660)
against 0.139 with nobody there, 2.4x darker, fading over about 60 px, with a light fringe round the
shoulder — and at corridor noon a torso over the right near car's rear screen reads solid navy
(12,18,25) where that glass reads (116,140,173), "a person inside the car". The shape — dark where
the glass should still be reflecting, fading with distance from the edge — is what a screen-space
occlusion term does at the depth step between a pane and what stands behind it, which would make it
the same family as #114 and #115. Not measured: the first reading is the AO buffer over one such pane
with the pedestrian present and absent.

### #131 FIXED — the router does not route through a turn the car cannot make from a standstill, unless nothing else reaches
**Measured first, by driving every turn the graph offers.** 2,294 directed junction turns; for each,
the course `path()` would build through it (lane offset, smoothing) from 40 m before the junction to
40 m after, driven by the shipped follower from rest with the walls solid:

    |deflection|    completed in 60 s
        < 120 deg      674 of 674
      120 - 130         29 of 30
      130 - 140         14 of 20
      140 - 150          4 of 14
      150 - 180          9 of 18

Every failure the same: no contact, two thirds of a minute in reverse, cycling at the mouth. The
deflection is read off each edge's own end segment, at the junction; over 5 or 10 m of each edge the
boundary is the same, over 20 m it smears (two failures at 110 and 119). So `TURN_LIMIT_RAD` is
120 degrees, read off the data — the deflection below which the car never fails from a standstill.

**The router is a search over LINKS now** (`RoadGraph.route`), because the cost of leaving a junction
depends on how it was entered. A turn at or over the limit is not taken; when nothing under it
reaches, the unlimited route comes back flagged `hairpin` — a preference, never a refusal. It took
three more things to make the limit mean what it says:

- **the route's two ENDS are turns too**: `path()` passes the direction its walk along the start edge
  arrives in and the one its walk along the target edge leaves in, and `tour()` passes each leg the
  last one's. Without them two legs in thirty still failed at the target.
- **the route of no edges is a turn too**, and #131's own example was one: from a point on 33 to a
  point on 350, the shortest route has no edges — the walk in and the walk out meet at vertex 95,
  139 degrees apart — and `route` returned before pricing it. Over the limit it is now the shortest
  loop round the block that arrives back the right way: 226 m against 52, and the follower arrives
  in 24.8 s where through the hairpin it times out at 240.
- **`path()` prefers a candidate that took no hairpin before comparing lengths**, one rung below
  #129's "opens behind" preference.

    387 seeded legs   29 change; median +8.1% length (p90 +33%)
                      the follower arrives on 28 of the 29, against 11 on the unlimited routes
    the tour          unchanged: 818 points, 88 contacts, byte-identical drive
    path() cost       p50 3.1 ms, max 17.7 over 60 random paths, against 5.2 / 19.8 for the old
                      vertex search — on a binary heap, because the first link search scanned for
                      its minimum and ran p50 19.9 / max 142.7, a visible hitch when the HUD replans

**The one leg that regresses is not the router's.** 190 -> 489 arrives on the unlimited route and not
on the limited one, whose new path turns 114.6 degrees at vertex 106 (208 -> 35). That turn completes
from rest in 12.1 s; the car reaches it at 76 km/h, brakes in a straight line, arrives slow but
placed for a corner tighter than its turning circle, and falls into the reversing cycle. Recorded
under #128.

`roadpath-test` §6d (5 checks): no limited route turns 120 degrees or more over 193 random pairs (by
the gate's own arithmetic, not `RoadGraph.turn`), the unlimited search does on 8, nothing is
refused, and the reported turn goes round the block and arrives where the hairpin times out. §6c's
"no route ahead" subject moved to a real dead end, because the old one only looked like one: the
turn-limited router finds edge 87 out of it, 711 m, arriving in 41.4 s at dv 0. Five `mutation-sweep`
rows, `route-turn-off`, `route-no-fallback`, `route-zero-edge`, `route-ends-blind` and
`route-hairpin-equal`.

#### THE ORIGINAL RECORD
### #131 OPEN — the router takes turns the car cannot make: 121 degrees from a 6.6 m road into a 2.8 m alley, and the follower cycles at the mouth for the whole timeout
Found as #129's timeouts. The route from (13, −13) to (66, −164) turns −121 degrees at course index 37,
from edge 33 (6.6 m, tertiary) into edge 350 (2.8 m, service — the alley of #128), and the follower
arrives at (−88, −117) at 0.5 m/s and spends the remaining 200 s of a 240 s timeout reversing and
re-entering: off its line 3-7 m, never past index 36, never 'wedged' because each cycle moves it
more than STUCK_M. The router is a vertex Dijkstra over edge length and has no turn cost, so a
hairpin into an alley is as good as a straight. Of the seven timeouts in #129's first set, the
trapped cars sit at five places, two of them twice — (−86, −111) and (−652, −76) — so it is a
handful of junctions rather than a rate. The lever is a turn cost, which needs an edge-based
search (the cost of leaving a vertex depends on how it was entered); not tried.


### #132 FIXED — the lamps, the signal masts, the utility poles and the street signs stood in front of the kerb
Found by #126 part 2's first drive among solid furniture: the route follower hit a signal mast on
every lap, and the mast was 3.0 m in front of the corner kerb it should have stood behind. Censused
against the face the streamer draws (`planKerbs`, the face at `panOuter` past each run's anchor):

    lamp posts       472 of 543 in front of the face, every one at -1.10 m: district/main.js's w/2 + 1.4
    signal masts     199 of 237: 108 at -1.15 (w/2 + 1.35), the rest up to 3.8 m out in a junction
    utility poles     84 of 140 at -1.00 (w/2 + 1.5), on the r = 5 streets that are kerbed
    sign posts       every stop, one-way and parking plate (w/2 + 1.1, 1.3) and the corner blades
    pavement props   about 250 — bollards, meters, bins, trees — at corners and run ends

`src/kerb.js` widened every kerbed street by 2.74 m and its header said "every lamp, bin, bench,
planter and signal still stands on the flat pad". That was true of the furniture's kerb ROW, which
stands on STATION_LINE and was moved with the kerb, and of nothing placed anywhere else; the same
header noted that the sign posts now stood in its parking lane and called them "a post in the
ground". Nothing could fail on it, because nothing collided with a lamp — CLAUDE.md's "a surface that
moves takes everything positioned against it", the crowd's lesson in #121, for the furniture.

**The fix is one question asked of the drawn kerb**, `KerbFace` in src/kerb.js: how far a point is
behind the face nearest it, and a footprint's points moved out until each clears the back chamfer of
the face nearest IT. Every placer asks it: the lamps (their loop moved out of district/main.js into
`placeStreetLamps`, so the dress pass, the crowd and every offline gate stand the page's posts), the
masts (their arm grows by however far the mast moved off its own carriageway, so the heads hang where
they did), the utility poles and their spans, the four kinds of sign post, and a guard in the dress
pass's `emit` that refuses any other prop whose emitted footprint centres in front of the face. The
host builds the face ONCE, from the streamer's own plan, so what every placer measures is the kerb on
screen.

    lamps          543 -> 509   441 moved behind the kerb, 34 with no room (a building, or two faces)
    signal masts   237 -> 233
    utility poles  140 -> 140   and their spans 46 -> 49
    sign posts     523 moved, 15 with no room (blades 114 -> 110, stops 111 -> 109, parking 260 -> 256)
    props          8,214 -> 7,889; the guard refused 249 standing in the road
    prop triangles 327,414 -> 312,707, district-wide (resident share ~40%, x1.28: under 8k of gate units)
    parking slots  2,280 -> 2,568: the "lampClearance < 3.2" rule existed because the lamp line ran
                   through the parking lane; it is a body-overlap test now, which no post behind a
                   kerb can fail
    rigid solids   2,896 -> 2,728

**Three wrong versions of the footprint, each found by the gate.** A radius of the footing's
half-width left 64 corner masts' footing corners on the back chamfer, because a footing is square to
its approach and not to a corner return. Its corner radius (x1.41) refused the 23 masts on divided
roads' medians, where two faces 1.21 m apart hold a footing turned square to both with 0.065 m to
spare. And a centre pushed clear of face A stood its corner 0.18 m in front of face B. So a footprint
is POINTS, each against the face nearest it (`behindPoints`; a round post is its rim). And the
query's reach was 4 m, picked: a mast 4.08 m in front of a corner return, on the asphalt the return
rounds off, read as having no kerb at all. A perpendicular corner's apron runs 5.4 m out; it is 8.

**Gate: `tools/kerb-stand.mjs`** (9 checks, 1 s, selftest 5): every lamp, mast, utility pole and sign
post with its whole footprint behind the back chamfer — a footing measured by its own emitted points
(`auditFoot`), because a world-axis box reads a square at 45 degrees as 1.41x itself — and every
other prop with its centre behind the face. Its classifier is its own, not `KerbFace`, which is the
placers'; the selftest pins it on synthetic faces, including the corner-vertex case an unclamped
projection gets wrong, and its KNOWN-BAD replays the old lamp line from the recorded expression: 475
of 477 kerbed posts in front. `mutation-sweep` has eight rows, one per placer, the guard and the query.
reaction-test's crowd now walks round the lamps (183 checks), and route-drive drives among them.

**Not done:** the 206 gullies sit 0.34 m inside the travelled way, placed against the old ribbon-edge
kerb, where the gutter they drain is 2.0-2.5 m further out. Moving them into the pan needs the pan's
13% fall under a flat grate, so it is recorded here rather than widened into this change. And a lamp's
head moved out with its post, over the parking lane rather than the travelled way — a change to the
night street that only a capture can judge.

**Blind review: the shipped build preferred in all four pairs, and the grouping recovered from the
data.** Two trees (e5e812e against 1e64f4d, one arm, corridor and fivepoints, noon and night), set
`k132b-cdrv0` / `k132-cdrv0`, scrambled per pair. The reviewer preferred the after frame at
corridor-noon (confidence 4), corridor-night (4), fivepoints-noon (5) and fivepoints-night (4), and put
the four after frames together by two quantities that agree: the ground under each base — 13 of 15
before-build bases on mostly asphalt, 7 of 9 after-build bases on mostly brick — and the base's
signed offset from the kerb line, -0.05 to -0.69 of a camera height in front against -0.06 to +2.2
behind, with every matched item 0.55-1.02 further into the road in the before build. Frames, key
and audits are committed (`docs/shots/k132*-cdrv0-*`, `docs/k132-audits.json`).

**Three of its "still wrong in the shipped build" findings were checked and two are its instrument.**
Projecting the shipped positions through the hero camera (fov 55, 1600x900, the framing's own pose):

    "the P sign stands mid-footway, 1.44 u behind the kerb"    the sign is at o 0.36 m — the back
        chamfer plus its post, as designed — and its base projects to (437, 658); the reviewer read
        the base at (438, 604), 54 px up the post, which is where 1.44 u comes from
    "a portal post at the back of the footway against the shops"   nothing placed stands there but a
        cafe's menu case (o 5.16); the nearest mast, (176.6, -156.9), is at o 0.54 and projects 14 px
        lower than the base the reviewer took
    "base plates oversized, overhanging the kerb stone"   the plinth is the 0.6 m square the
        footprint is settled with (SIGNAL_FOOT_HALF), and at 6x it abuts the back chamfer rather than
        crossing it — kerb-stand's nine-point footprint rule. Its size is a style call, not #132

The reviewer's observations were right about what is in the frame; what failed was reading a base
that is hidden, which this file already records for the ground-contact metric ("a prop 46 m out is ~2
pixels of ground contact"). The third finding is real and is not this change: see #135-#137, which
are what the review's "a light with no fixture" and "almost no street lighting as a system" turned
out to be. And its "clouds moved between the paired captures" is the harness: each tree froze the deck
at its own load time (17.945 s and 30.662 s), so a two-tree pair carried 12.7 s of drift — hero-shots
pins one time now.

### #138 OPEN — the AO's depth-step leak darkens anything standing behind something nearer, and #130 only took the glass out
Found by #130's page, `tools/glass-ao.html`, in the arm #130 does not touch. A pedestrian-sized block
1.5 m in front of a car darkens the car's PAINT beside its outline to 0.708 of AO-off (0-8 px), 0.869
(8-16) and 0.858 (16-32), against 0.989 with no block — the same cloud the reviewers saw on the glass,
on a bonnet, and at a 1600 x 1000 render it is a plain dark smudge beside the block. The mechanism is
the range check, `smoothstep(0, 1, rs / dz)` with `rs = radius = 0.6 m` at `aoRangeScale` 0: it passes
35% of an occluder 1.5 m proud and 10% of one 3 m proud, and pow(ao, 8.5) turns a few such hits into
a halo round every silhouette that stands in front of a lit surface — people, posts, cars against
walls. The lever exists (`aoRangeScale`, or a hard cut past 2 rs) and src/post.js's own table shows
what it did to the seam (the wrong way, by a little); its price on the protected metrics — foot
contact, the parked-car umbra and its edge, prop contact, the window reveal, the halo extinction —
has never been taken, and that is the first job: `ao-sweep`, `prop-ground` and `ao-noise --live`,
one page load each, with and without. The page carries the leak's own before and after already, so
a candidate can be checked against it in seconds.

### #139 MEASURED — no lamp stands in a palm; the census found a refused tree drawing half of itself
**The census, every lamp against every palm.** It uses each palm's own parameters (`treeParams`),
placed by the frame the dress pass used (`treeSites`). A crown is a sphere of its radius R round the
trunk top; the head 2.2 m out at 7.7 m; the post a vertical line to 8.2 m; the trunk its plan segment,
base to top:

    lamp heads inside a crown          0 of 1,228    nearest 1.62 m outside its radius
    posts through a crown              0
    posts through a trunk              0             nearest 2.39 m clear

The review's posts "up a trunk" were screen overlap at two depths, which it said it could not rule
out ("inferred, not measured in depth"). Its fronds "lit from inside" and brighter than the globe are
#136: a 900 cd light 2-3 m from a crown lights it several times its own globe's luminance. No placer
change.

**What it found instead was the tree placer.** A tree is two emits, the far tier (`tree`: trunk,
even fronds) and the near tier (`treeDetail`: odd fronds, boot plates), and each was judged against
the kerb face on its OWN footprint:

    trees planted                          261
    refused by the kerb face                16
      ...whose near half drew anyway         5    odd fronds and boot plates, no trunk under them
    accepted trees whose near half was refused   1
    counted in treeSpecies                 261    (245 stand)

`_plantTree` makes the halves one verdict: the near half is emitted only for a tree that stands, and
inherits its verdict. The species are counted from what stands (245: sabal 130, queen 104, oak 11).
Each standing tree's key and frame are kept, and its halves' identity rides on the audit record.
kerb-stand 21 -> 25 checks:
- the crown census, with a palm planted 0.8 m from a lamp post as its KNOWN-BAD;
- the halves paired by identity. Pairing by footprint within 1.5 m read two oaks as orphans: an oak's
  near half is its canopy, whose lowest point is 2-3 m up and 1.8-2.0 m off its pit;
- the species against what stands.

A tree's near half is no longer tallied as a pavement prop. mutation-sweep rows: `tree-halves-split`
and `tree-species-refused`, both caught by kerb-stand.

#### #139 (as filed)
### #139 OPEN — the new lamps stand in palms: a post up a trunk, a globe inside a crown
From #135/#137's blind review, new build only. At corridor dusk a lamp post runs up the left palm's
trunk at x 683-688 to the same base row. A far post's arm crosses another palm's trunk, and a globe sits
inside that palm's crown. At night the post in the palm "lights the fronds from inside": mean 0.161, p90
0.52 against 0.009 in the other build. A crown edge reads p50 0.81, brighter than the nearest globe's
peak of 0.67.

**The mechanism, from the placer's own numbers. NOT yet a census.** A street tree is kept 3.4 m from
the nearest lamp POST at its base (`lampClearance(st.treeX, st.treeZ) >= 3.4`). A palm's crown centre
sways up to `PALM_SWAY_CAP` 1.15 m off that base, and its radius reaches `PALM_CROWN_CAP` 3.55 m (queen)
or 2.90 m (sabal), with the crown at 5.5-12.6 m of trunk where the lamp head is at 7.7 m and 2.2 m out
from its post. So the test the placer runs can pass with the crown overlapping the post by up to 1.3 m,
and the head inside it. #137 more than doubled the lamps, 509 -> 1,228, which is why the review saw it
now.

The measurement: per lamp, the head's and the post's distance from every palm's crown centre at height,
against that palm's R. Then the fix belongs in the placer: a palm keeps its CROWN clear of a lamp's head
and post, and the clearance must not be the base distance.

### #140 OPEN — the lamp globes are icosahedra, and a near one reads as a hexagon
From the same review. At fivepoints dusk the near-left globe at (134,183)-(163,212), 29 px across,
holds its left edge at x 134-135 for 20 rows and its right at x 163 for 15. A globe is 20 triangles,
and #137's report prices a lamp at 72 (pole 20, bracket 12, globes 20 + 20). A subdivision to 80 each
costs 1,228 x 2 x 60 = 147,360 triangles in the colour pass and the same again in the sun's map
(lamps bill x2.00 in their own `street lamps` bucket since f330afa): 294,720 of the gate's units, more
than #137 itself. Cheaper levers, unpriced: globes out of the shadow map (a 0.25 m sphere's shadow is
under a pixel past a few metres), or a camera-facing impostor with a sphere normal, which is 2 triangles
and round at any distance.

### #133 FIXED — the player car's door mirrors were laid on their side, glass outward

Measured off `buildPlayerCar`'s own body buffer, which is the one number the entry asked for: every
glazing-slot triangle on that material is mirror glass (its panes are on `carGlassMaterial`), and the
glass's big face had a normal of **(0.99, 0, 0.16)** on the +x side — outward and a little forward. The
housing was 8.8 cm across and 19.6 cm fore and aft, so the whole mirror was turned through 90 degrees,
and the glass was a closed slab on the housing's OUTBOARD face:

                                     before                   after
    glass a side                     349.1 cm2, 12 tris       139.8 cm2, 2 tris
    projected toward a camera
      beside the car (outboard)      144.2 cm2                0.0
      behind it                      33.4, most of it buried  137.1
      ahead of it                    33.4                     0.0
    outer edge, |x|                  1.085 m                  1.085 m   12 cm past the body's widest point
    body triangles                   2,806                    2,786

The housing is 18 cm wide and 8.8 cm deep now, its outer end swept back by 0.2 rad, and the glass is one
quad 2 mm proud of its back face, toed in toward the cabin — so from beside the car what reads is the
body-coloured housing, and from behind the glass. The outer edge did not move, by construction.

**Gated in `car-detail`**, which already reads the player's plate off the same builder: "the player's
door mirrors show their glass to the back of the car, and none of it to the side" — 0.9 of the area
toward the back (a toe-in up to 26 degrees), 5% to the side (a toe-OUT shows sin(0.2) = 20%), 100 cm2 a
side so a car with no glass cannot pass. Its selftest carries the shipped-before numbers, a wrong-way
toe, no glass and one mirror as known-bads; `mutation-sweep`'s `mirror-sideways` puts the old slab
back and `mirror-toe-out` flips the toe.

**Blind review, 2026-10-19: the new mirror preferred in all four car pairs.** One reviewer, six pairs
scrambled per pair, told nothing about the change. Side-on (cabin noon 3/5, dusk 3/5) it preferred the
build whose mirror reads as "a body-coloured box... no glass": "a real door mirror's glass faces
rearward and is turned toward the driver, so from outboard you see only the housing". The other build's
"framed glass face" was "a small screen facing the camera", which is the defect as filed. From behind
(mirrorback noon 4/5, dusk 3/5) it preferred the build that shows glass, at 0.20-0.28 m of housing
width. The reviewer could not reconcile its own model: "B's mirror shows glass both from behind and
face-on from the side, which a single rear-facing pane can't do". B was a different build in those
pairs, so the per-pair scramble was working as designed. Noted against both builds: the traffic cars'
mirrors are plain cubes with no glass (only the player's car changed), and the new glass reads flat at
0.073-0.077 with no structure.

**The fleet's mirrors: FIXED (008c4bf).** Each traffic, parked and police car's mirror box carries one
glass quad on its back face, 2 mm proud and inset a centimetre, facing straight back (an 11.5-degree toe
on a 9 cm pane is under a pixel at fleet distance). `car-detail` measures it off each shell's buffer,
isolating the mirror glass by position (every corner outboard of 0.94 m; no shell's side glass reaches
past 0.924): 57.6 cm2 a mirror on all three shells, all of it to the back. 1,210 -> 1,214 triangles a
shell, +8 gate units a drawn car. `mutation-sweep`'s `fleet-mirror-bare` caught by car-detail. The flat
glass is still open, and not reviewed blind.

#### #133 (as filed)
From the driver's re-review (cabin v3.1), both arms: side-on at 11 m, noon, the door mirror at
[731,450,756,465] is a red-framed rectangle holding a sky-over-pavement reflection. A real door
mirror's glass faces BACKWARDS, so from beside the car what reads is the body-coloured housing; a
mirror whose face shows sideways reads as a little window stuck on the door. Seen in
`docs/shots/cabd-cfix0-cabin-noon.png` at 6x. Not measured: the mirror's face normal off the player
car's own buffer (`buildPlayerCar`), which says in one number whether the glass is turned outward.

### #134 FIXED — the street-name blades were blank from one side, and the census could not see a blade at all

`streetBladeAssembly` passed `backRect: bladeBack`, a blank, from when `signPanel`'s default back was
the u-swapped rect and would have MIRRORED the name. That default was fixed long ago — the front's own
rect on the back face reads forwards from behind, which `sign-orient --selftest` has asserted since —
and the blank stayed on. The entry's "check first" question answers itself off that selftest: the
same rect on the back face reads `fwd / fwd`, and a u-swapped one reads mirrored. Note `postSign`'s
own default back is `signBack`, another blank, so dropping the option would not have fixed it; the
blade passes its own name.

**And the instrument that should have seen it could not.** `tools/sign-orient.mjs` censuses lettered
faces by rect, and its TEXT set was the shop atlas only, so the street buffer printed no row — 55
blank blade backs, district-wide, were invisible to the one tool about which way signs face. It also
printed its table and exited 0 whatever it said. Both fixed:

                                     before        after
    lettered blade faces             55            110     for 55 blades planned, owed 110
    blank blade backs                55            0
    mirrored, blades / district-wide 0 / 0         0 / 0

It is a gate now (0.8 s, three checks against the plan's OWN blade count, so a blank back fails — a
classifier that only counted mirrored faces would pass the shipped defect, because a blank is not
text). Its selftest builds the shipped assembly, a blank back and a u-swapped back on two real baked
names; `mutation-sweep`'s `blade-back-blank` is the defect put back. Same triangles: the back face was
always emitted.

**Blind review, 2026-10-19: preferred at 5/5.** "Blank slabs with no legend" against white legends at
about 9:1 to the plate. Two things the reviewer read off the fixed build were real defects in the PLANNER,
fixed in b6eb6f2 and gated by `sign-orient` (6 checks), measured off the emitted faces:

    lettered faces whose blade hangs ACROSS the street it names   216 of 432 -> 0, worst 0 deg
    corner posts naming one street twice (its North/South halves)    4 of 108 -> 0
    faces beside a name change naming the far half                   8 of 18 -> 0 of 10
    blades the gate could see at all                                 55 of 216 -> 216

Names were handed out in the order a junction's edges happened to be listed, while blade i was turned
to yaw + i*pi/2 off the widest arm. `bladePick` now puts the widest road's street on the upper blade and
the most important OTHER street below it, each turned to its own street's arm on the post's corner and
named for that arm's half. Pairing by importance is what removed the doubled posts. The `streetKey`
dedupe added beside it turned out to be a guard this district does not exercise: the plan is
byte-identical without it, so `blade-halves` is an inert row with that measurement. The gate had
been building the module's twelve-name fallback atlas, so it saw 55 of 216 blades; it now bakes the
district's names as the page does. The lower blade's shadowed segment also reads 3-5% of its own lit
face, where the post beside it shades to 26%: still open, not measured beyond the reviewer's read.

**The two blades on one post differ in colour: FIXED (2170431).** The colourway was hashed from each
blade's NAME, so a post took two colours whenever its names hashed apart: 73 of 108 posts. A post now
takes the colourway of its UPPER blade's street (the junction's widest), the lower blade is drawn in it,
and the hash is on `streetKey` so the two halves of a street that changes name are one colour. The atlas
bakes a cell per (name, colourway) the PLAN uses, so the page plans the signage before baking it: 84
cells for the 50 names on a blade, where it baked all 98 names, and the street atlas goes from 1,024 x
1,280 to 1,024 x 1,088. `sign-orient` reads each lettered face's colour off the atlas DRAWING (its canvas
shim records every fill with the colour it painted) and matches faces to posts by position:

    posts carrying two colourways                      0 of 108    each blade in its own street's: 80
    streets heading posts in two colourways            0 of 29     hashed on the name instead: 3
    colourways in use                                  3

Rows: `blade-plate-own` and `blade-plate-name` caught by sign-orient and its selftest; `blade-halves` is
no longer inert, because the halves now split three streets' colour; `blade-back-blank` repointed.
Not reviewed blind.

#### #134 (as filed)
From the same review, both arms: a blade assembly at [1235,85,1495,210], noon, shows two grey-green
faces with no lettering. `appendStreetSignage` draws each blade double-sided with
`backRect: streetRect('misc', 'bladeBack')`, a blank, so from the side the name faces away from the
blade reads as an unpainted plate — and with two blades at right angles there is a whole quadrant
round every corner from which BOTH are blank. A real street-name blade carries the name on both
faces. The lever is the back's rect; the thing to check first is whether a reused name rect comes
out mirrored on the back face.

### #135 FIXED — every lamp's arm hangs over its own carriageway
The yaw is `atan2(nz * side, -nx * side)`: the post stands at `+side * n` from the centreline, so
the road is `-side * n` from it, and the fixture's local +x (bracket and both globes) goes to
`(cos yaw, -sin yaw)`. Measured by `kerb-stand` off the pole and head instance matrices, with the
globes' centres read off the head mesh's own buffer (its poles' midpoint: a five-sided sphere's
bounding box is lopsided and read the outer globe 21 mm short):

    every outer globe nearer its OWN carriageway than its post   1,228 of 1,228, by exactly 2.200 m
    on a kerbed street, in front of its own kerb face             1,007 of 1,007, the inner globe behind
    the emitter the LightPool lights is the drawn outer globe     worst 3.4e-5 m (float32 instances)
    KNOWN-BAD, the recorded yaw on the same posts                 0 of 1,228 gain half the arm, median 0.000

"Its own carriageway", not the nearest one: against the nearest road a lamp near a corner is read
against the cross street, which credited 15 of the old along-the-street arms with a gain over half
an arm and would have let the KNOWN-BAD read partly fixed. Two more nearest-X traps in the same
instrument on the way: each globe against its own nearest kerb face, then all three against the
post's nearest face, both of which put 43 posts' frames on a side street's kerb. The face is now
the lamp's own street's straight kerb, read off `planKerbs` by edge, not off the arm. Mutation row
`lamp-yaw-along`, caught by kerb-stand.

Every lamp light moved 2.2 m toward its road, onto the parking lane on a kerbed street: see the
captures under #137.

**Blind review, 2026-10-19: the new lamps preferred in all four pairs** (corridor dusk 2/5, night 3/5,
fivepoints dusk 2/5, night 4/5), scrambled per pair. The reviewer recovered which frames were one build
from the frames themselves and said so, so the four preferences are ONE judgement, driven by the night
pairs. At fivepoints night the road under the junction read x31 brighter (0.151 against 0.0048, the old
build "0.17x the sky, which is what asphalt reflects from skylight alone"). At dusk the old arms, which
ran along the street, read end-on from down the street as "post-top lanterns", and the new ones read as
"a twin-arm post". What it found WRONG in the new build, each filed:
- **Posts through palms, globes in crowns** (#139): "a dark post runs exactly up the palm trunk", and at
  night "B's post through the palm lights the fronds from inside", the fronds outshining the lamp.
- **Hexagonal globes** (#140): the near-left globe at five points holds a straight left edge for 20 rows.
- **A glow on a corner pilaster with no fixture**, 4x the nearest globe's area. That is #136's
  mechanism on one of the new lamps.
And in both builds: wall glows brighter than any lamp (#136); lamps no brighter than what they light,
with no globe clipping (#136); square signal lenses (#124); the stars' bracket strokes and the octagonal
wheel (fixed in main since this branch was cut, 433f304 and 298290a); flat card canopies; and a uniform
road-crack network to the horizon.

### #135 (as filed) every lamp's arm points along the street, not over the roadway
Found chasing #132's blind review. `placeStreetLamps` (and district/main.js's loop before it, since
c109275 on 2026-08-31) sets `yaw = atan2(-nx * side, -nz * side)` under a comment "Point the arm back
over the roadway". The bracket and both globes are on the fixture's local +x, which a yaw about +y
sends to `(cos yaw, -sin yaw)` = `(-nz * side, nx * side)` — the edge's own direction. Measured off
the instance matrices at the page's pool size: **509 of 509 arms run along the street** (|cos| to the
nearest centreline 1.00 on every one), 0 toward the road. So the "roadway" globe and the emitter the
LightPool lights hang 2.2 m along the pavement from the post, at the post's own lateral offset —
behind the kerb since #132 — and the second, "pavement-side" globe hangs 1.0 m the other way along the
same line. The fixture's own comment says "what a real roadway/pavement twin does"; neither globe is
over the road. The fix is the yaw (`atan2(nz * side, -nx * side)`), and it moves every lamp light
2.2 m toward the carriageway, which is a night-look change for a capture and a blind review.

### #136 FIXED FOR EVERYTHING A LEVEL CAN ORDER — the globe draws at 1/30 of its light's flux; window glass is not a level's to fix
**The tie.** `src/streetfurniture.js` holds the lamp's light as `LAMP_CANDELA` 900, `LAMP_LIGHT_COLOR` 0xffc98a
and `LAMP_REACH` 46 beside `LAMP_HEAD_Y`, and `district/main.js` reads them where it typed them. The globe's
luminance is derived from them: a Lambertian emitter of area S radiates pi L S lumens and an isotropic point
4 pi I, so the globe that radiates its own light's flux has L = I / (S/4), S/4 being the mean projected area
(Cauchy). Off the head mesh's own buffer the outer globe is 20 facets, S = 0.592 m2, S/4 = 0.1480 m2 — 75% of
pi 0.25^2 — and I is 900 cd times the colour's luminance 0.6487 that three multiplies it by:

    physical globe     583.8 cd / 0.1480 m2 = 3,944.7 nits
    the old globe      2.4 x luma(0xffd9a0) = 1.762 nits      1/2,239 of it

(1/2,600 as filed took the candela without its colour and the sphere without its facets.) `LAMP_GLOBE_LEVEL`
is the fraction of the physical luminance the globe draws at; `setLit` derives `emissiveIntensity` from it
and `setGlobeLevel` is a tool's lever, which reads back what the material holds.

**In the district, at the old level** (`tools/globe-order.mjs`, new): both hero cameras at night, traffic and
crowd off, every pixel's lamp light read as the difference of two HDR reads with the LightPool's ten lights at
full and at intensity 0 (kept visible, so nothing recompiles), over the globe's luminance read off the
material. A ratio of two radiances in one frame, so no exposure enters it, and linear in the level. The
globe's own pixels read back 1.762 to four figures, every globe in frame.

                                       corridor          fivepoints
    pixels a lamp lit over its globe     7,784             8,730       (x10: 52 and 542)
    window glass, a mirror               x334.6            x2,259      the reviews' "light with no fixture"
                                                            x380.4      the red parked car's windscreen
    car paint                            x18.5             x30.1       the white parked car's roof
    the lamp's own inner globe           x6.95                         lit from 3.2 m by its twin
    oak leaves, awnings, walls           x5.1, x1.5        x2.5, x1.6

Classified by looking at each component's box in the frame: the probe cannot tell glass by itself. At dusk,
corridor only, the same ratios to a few hundredths (the lamp light does not depend on the hour), from noisier
reads. The fourth run, fivepoints at dusk, died when its browser closed under it ("Target page, context or
browser has been closed" in `settleFrames`), so `docs/globeord0.json` holds three runs and says `partial: true`.
These are all at the OLD level; the ratios at 1/30 are those divided by x74.6, by linearity, not re-measured in
the district.

**On a page** (`tools/globe-level.html`, new, the gate): the module's own lamp, its light through the real
LightPool and the real PostStack at the night bars, and the surfaces the reviews named at the distances the
district has them: the facade atlas' WALL cell (roughness 0.220, F0 0.18, `src/materials.js` GLAZING's
table) 5.03 m behind the light, as building 18 is; its GLASS cell; a pilaster at 2.2 m; a palm frond at
#139's nearest crown, 1.62 m; the lamp's own inner globe; the road. Lamp light over the globe, night:

    level      globe nits   wall lobe  pilaster   frond   inner   glass    glare / globe radius
                            15 m cam                      globe   58 m     15 m  29 m  58 m  100 m
    1/2,239        1.76      x57.75    x15.75    x5.88    x7.57   x238      -     -     -     -
    1/150         26.3       x3.87     x1.06     x0.39    x0.51   x16.0    1.2   0.8    -     -
    1/50          78.9       x1.29     x0.35     x0.13    x0.17   x5.32    1.7   2.1    -     -
    1/30         131.5       x0.77     x0.21     x0.08    x0.10   x3.19    1.9   2.5   2.7    -
    1/20         197.2       x0.52     x0.14     x0.05    x0.07   x2.13    2.0   2.7   3.5    -
    1/9.4        420.1       x0.24     x0.07     x0.02    x0.03   x1.00    2.2   3.1   4.5   5.0
    1             3944.7     x0.03     x0.01     x0.00    x0.00   x0.11    2.6   3.9   6.5   9.4

"Glare / globe radius" is the radius of the disc the globe's OWN glare takes to white (>= 1 exposed, black to
display 0.80), read off the bloom target with the light off so nothing lit is in it, the twin globe's half
excluded, over the globe's projected radius at that camera. The displayed globe at night: 0.72-0.83 of white
at the old level, 0.999-1.000 from 1/50 up — "no globe clips" was one of the reviews' findings.

**The level is 1/30, 131.5 nits, x74.6 the old globe.** The binding case of everything a level CAN order is
the wall cell's lobe seen from 15 m down the street, which needs 1/38.8; 1/30 orders it with 29% to spare and
every other page surface and every non-glass component of both hero frames (worst x0.40, the white car) with
more. Its price is a white disc 1.9-2.7 globe radii wide at 15-58 m and none at 100 m; the physical globe's is
6.5 at 58 m and 9.4 at 100 m — a 1.9 px globe 100 m off is an 18 px white ball, on every one of 1,228 lamps.

**Not fixed, and not a level's to fix: window glass.** Glass reflects the LIGHT, which is physical whatever the
globe draws at, and a point light has no size, so three's GGX lobe on glazing roughness 0.030-0.124
(`src/materials.js` GLAZING: coated 0.030-0.092, shop 0.040-0.124; the module's comment quotes the coated range)
concentrates it: the page's glass needs 1/9.4 and fivepoints' pane 1.01 of the PHYSICAL globe. At 1/30 the
window reflections are still brighter than their globes in the HDR target; both are past the display's white at
night, and how the two read side by side is for the captures and the review, not measured here. The lever is the
light's own size: widen each pool light's lobe by the globe it stands for (Karis' sphere-light normalisation,
alpha' = alpha + R / 2d with R = sqrt(I / (pi L)) from the globe's own luminance), which orders a mirror's
reflection at F x the globe by construction at any level. It is a patch to every lit material's punctual-light
term and is not taken here.

**Not fixed: three lamps hang their globe against a wall.** Every lamp light against every building footprint
tall enough to reach 7.7 m: lamps 571, 197 and 198 stand 0.224, 0.254 and 0.484 m from a wall (571's globe,
r 0.25, intersects it); the next is 0.95 m, the p1 2.0 m, the p50 18.9 m. A wall 0.22 m from a 900 cd light
is lit to about 1,300 nits by the light alone, ten times the shipped globe. It is a placer change, #139's shape
for walls rather than crowns.

**At dusk** the globe is 0.068 exposed (1/1,947), a dim warm dot against the sky where the old one was 0.0009,
black. One physical luminance cannot also be bright against a dusk sky without being 30 times further over
white at night; holding the globe at a fixed EXPOSED level (carbody.js's lampEmissive) would make dusk a
second term, and it was not taken.

**The captures.** `hero-shots`, corridor and fivepoints at dusk and night, no pedestrians, `traffic=0`, settle
15 frames: BEFORE from an export of e4bb67b (tag g136b, port 8244), AFTER from cf761b5 (tag g136, port 8245),
one after the other. Both logs open "cloud deck: frozen at 20s", both rc 0 with 4 captures, no errors and no
shot errors. Each capture's audit agrees with its pair's on all 203 fields but the file name, timings and the
frame counter (91/86, 112/107, 148/142, 169/162). The GROUND band is identical to within 1 of 255 in all four
pairs (max |d| 0, 1, 0, 0): the lamps' light did not change, so their pools did not, which is the pair's
built-in control. What differs is 4 to 41 compact components, 0.03-2.05% of the pixels, the largest on the near
globes and their glare at peak |d| 50-60 at dusk and 170-221 at night; the smaller ones were not attributed one
by one. So `blind-compare` refused the set on its 8% line — best band 0.06%, 2.65%, 0.33% and 2.72% of samples
over 4/255 for corridor-dusk, corridor-night, fivepoints-dusk and fivepoints-night — and since one `--roi`
rectangle serves every pair and the two framings' globes do not share one, it was built with `--force`. The
tagged frames sit beside `docs/shots/blind/` byte for byte, so a reviewer should be handed a copy of that
directory alone.

**Gated.** `globe-level` (12 checks, about 27 s): the page's lamp is the module's and so is its light; the
module's luminance is the page's own derivation off the buffer; the instrument reads the material back to 1%;
KNOWN-BAD live, the old globe outshone by the wall lobe, the pilaster, the frond and its own twin; THE FIX at
every camera; the shipped level within x1.0-1.5 of the minimum read off the old arm; the halo under x3.0 at
every camera with the physical globe's measured over it as a second known-bad; the glass named as the one
surface still over, at a level the bound refuses; and the globe reaching white at night. Its selftest feeds
a real report and eleven known-bads. `globe-order --selftest` (11) holds the arithmetic both tools and
boot-check share. `boot-check` +2: every emitter the live pool holds carries the module's light, one per lamp,
and the globe the page draws is the module's level of the physical luminance recomputed off the buffer.
`mutation-sweep` rows `globe-level-old`, `globe-level-physical`, `globe-area-typed`,
`globe-light-uncoloured`, `globe-setlit-literal`, and `lamp-candela-typed` [browser].

#### #136 (as filed)
### #136 OPEN — a lamp's reflection outshines the lamp: the globe emits about 1/2,600 of what its light implies
The review's "a light with no fixture" — a warm disc on the corridor's right facade at second-floor
height at night, nothing mounted there at noon, 12 px apart between the two builds — is the specular
lobe of lamp 483's point light on building 18's facade. The light is 5.03 m from the wall; its mirror
image across the wall projects to (969, 455) against the disc's measured centre (975, 454), and with
the post 1.1 m further out (the build before #132) to (980, 455) against (988, 454) — the same 11-13 px
shift. And the light pool's ten live lights, read off the page at that camera, are all at lamp heads;
none is at the disc. In linear light, the after frame:

    the disc     [957,443,1002,466]  mean 0.4965 over 1,104 px, core clipped at 255
    its lamp     [860,446,878,462]   mean 0.0588, one pixel at 0.84

so the reflection carries about 29x the light of its own source as the camera sees it, which no
passive surface can do. The mismatch is in the units: the light is 900 cd, which over a 0.25 m
globe's 0.196 m2 of projected area is ~4,600 cd/m2, and the globe's material emits `emissive`
0xffd9a0 at `emissiveIntensity` 2.4 — a luminance of about 1.75 in the same units. Not measured: the
roughness of the facade where the lobe lands, which decides its size, and what bloom does with a
globe raised by three orders of magnitude. Either lever changes the whole night frame.

### #137 FIXED — lamps by arc length along each whole edge, both sides lit on 85% of the street
`placeStreetLamps` places along each whole drivable edge now (`_lampStations`): `ceil(span / 26) + 1`
stations evenly over the edge's usable span, sides alternating along the whole edge, both ends
anchored, so an edge too short for one gap gets a lamp each side; edges longest first, and a station
skipped where its side already has a lamp within half a spacing. A spot is usable where `planKerbs`'
kerb runs STRAIGHT on that side (the junction mouths as drawn, side by side: the far side of a T
keeps its lamps), where no road comes nearer the post than its own road's lamp line, and where a
road turning off at either end keeps `KERB.cornerR` clear if kerb.js draws no return there. Every
#132 rule kept. kerb-stand's `lampCoverage` (a lamp on that side of THIS street's pavement within
26 m along it, any edge's lamp counting):

                                       before      after
    lamps                                 509      1,228   of 1,546 stations: 221 skipped as lit,
                                                           86 with no usable spot, 11 refused,
                                                           0 past the pool
    street lit on both sides            22.0%      85.2%
    on one side only                    49.0%      13.2%
    on neither                          29.0%       1.6%
    lamps on side +1                    72.7%      53.7%   two-way streets 71.2% -> 50.0%, one-way
                                                           74.4% -> 58.1%: the left of a one-way
                                                           carriageway is often its median
    same-side pairs under 13 m              -         10   (225 with the skip removed)
    corridor framing, x 112-320       0 left / 3 right   6 left / 5 right
    Five Points, within 30 m          2, in 2 quadrants  6, in all four

The before column is the 509 posts 08ba1bc draws, read off its pole instances, with their sides from
its own loop replayed station by station (3.2e-5 m from every drawn post). kerb-stand's KNOWN-BAD
replays that loop at its pre-#132 line, 543 posts, and reads 25.5 / 48.5 / 26.1% and 73.3% on +1: the
34 posts #132 refused at the kerb (28 of them on side +1) left the shipped build a little worse lit
than the loop it came from, and the same measure on the after plan reproduces kerb-stand's 85.2 /
13.2 / 1.6% exactly.

THE PRICE, in the gate's units. Lamps are three InstancedMeshes, never culled, all casting: 72
triangles a lamp in the colour pass and again in the sun's shadow map. 509 -> 1,228 is +719 lamps,
+103,536 of the budget gate's triangles; the worst 2026-10-17 baseline p95 (845,957) goes to about
949,500, 67.8% of the 1,400,000 warn. Measured live at the boot preset (dusk) by toggling the three
meshes ABBA and reading the post stack's scene count: 75,417 before and 175,354 after, x2.06 and
x1.98 per lamp per pass against x2 by construction — the residue is streamer drift. Draw calls do
not move (three meshes at any count). The dress pass stands 253 fewer props (lampClearance: trees
-40, benches -35, meters -35, bollards -34), -16,985 prop triangles district-wide; parking slots
2,568 both.

The 26 m was checked against the reference before it was kept, and the reference shows a different
system: 02-Worth's Block's standards are single post-top globes and its twin globe is a wall sconce;
03-Five Points has shepherd's-crook posts with pendant globes; and Main St east, mosaicked from the
2024 panoramas into an elevation of each pavement, has 4 m lanterns 8.7-11.0 m apart along built
frontage. That density with this 8.2 m roadway standard would be about 5,400 lamps and take the
worst baseline p95 past the warn. LAMP_SPACING carries the measurement.

Three drafts route-drive caught, each fixed in the placer: posts 0.26-0.40 m off a narrow one-way
carriageway at a fork (every road keeps its lamp line clear), a post in the inside corner of the
turn from edge 107 into service alley 350 (the corner clearance), and a post past the unradiused
82-degree fold on edges 179/180 (the own road's other segments count). `lamp-line-carriageway`
came back MISSED once the corner clearance existed — 10 posts within 1.4 m of another unkerbed
carriageway, none on route-drive's course — so kerb-stand censuses it. Mutation rows
`lamp-per-segment`, `lamp-corner-off`, `lamp-line-carriageway`, `lamp-own-bend`,
`lamp-overflow-hidden`, `lamp-skip-off`: all caught.

The pool is LAMP_POOL (1,800, every station the plan can propose) at all eight sites that typed
`{ max: 1200 }`, and a lamp past it is `overflow`, which the module used to count as placed.

THE CAPTURES, `hero-shots` arm cdrv0, corridor and fivepoints at dusk and night, no pedestrians:
BEFORE at 08ba1bc (tag l135b, port 8212), AFTER at 563a77e (tag l135, port 8211), both logs opening
"cloud deck: frozen at 20s", both rc 0 with 4 captures and no shot errors. Each pair agrees on every
residency count the audit carries — draw calls 184 / 171 / 207 / 193, 83 chunks at 16 near and 67
far, 346 plain and 11 instanced meshes, 102-103 shadow casters — and on exposure and sun, so the
delta is the build's and not the streamer's:

    frame               before     after      delta    less the lamps' own +103,536
    corridor/dusk      616,413   709,541    +93,128    -10,408
    corridor/night     611,117   702,503    +91,386    -12,150
    fivepoints/dusk    664,491   756,559    +92,068    -11,468
    fivepoints/night   643,112   734,204    +91,092    -12,444

The night deltas are within 2% of dusk's: the directional light's shadow map is still drawn at night
(sunLux 0.6, shadow map on in all four audits), so the lamps bill x2 at every hour. The 10-12k under
the lamps' own price is NOT isolated. The same audits show the lamps' clearance taking dressing out of
the district — trees 305 -> 261 (sabal 160 -> 137, queen 134 -> 113, oak 11 both) and props
7,600 -> 7,387, by the page's own count — which is the only other content change they can see; but
no tri-breakdown was run on the pair, and the bound is loose: the offline dress probe's 16,985 prop
triangles district-wide (it removes 253 props where the page removes 213, so it is not the page's
dress exactly) at furniture's x1.28 is at most about 21,700, and only if every one were resident.

The light pool: emitters 509 -> 1,228, and at the corridor camera the pool lights whose reach meets
the view frustum (`illuminating`) went 5 -> 10 of 10 at both hours; Five Points 10 both. Before,
half the pool was on and lighting nothing in shot.

RESIDUAL, found after the captures and not fixed: the small roundabout at (259, -164), dead ahead of
the corridor camera at about 147 m, stands THREE posts on its island — #1209, #1210 and #1214, one on
the inner side of each of the one-way ring edges 767, 768 and 772 (13.6-15.0 m long), 4.35, 4.43 and
5.70 m apart. A ring edge is shorter than one gap, so it is anchored on both sides; the outer side is
all junction mouth and is dropped, the inner side is the island's straight kerb and is kept; and the
skip that thins a crowded side tests a lamp within half a spacing on ITS OWN edge's side, which on a
9 m ring is a different frame from the next edge's — so kerb-stand's same-side count, taken in each
lamp's own street's frame, does not see it either. Posts nearer than R to ANY other post, any street,
any side, district-wide:

                 under 3 m   under 5 m   under 8 m   groups of 3+ within 5 m
    before (509)         5           7          10        0
    after (1,228)        0           7          63        1, this island

The other 8 m groups are pairs across a junction (6.6-7.7 m), which the density brings. The lever is
the skip measured as plain distance between posts, or one post for a ring's island, with kerb-stand's
crowding check restated to count any street's posts. It changes the plan the captures show, so it
waits for their blind review rather than going in under it.

### #137 (as filed) the lamp loop lights 65% of the street length, and puts 73% of its lamps on one side
The review's top "wrong in both builds": "there is almost no street lighting as a system" — the
corridor's left side has no lamp in frame and three of the four corners at fivepoints have none. The
loop walks each edge's POLYLINE SEGMENTS and places `floor(len / 26)` lamps per segment, alternating
sides by `s % 2` and restarting at s = 1 on every segment. Over the district's 1,476 drivable segments:

    segments shorter than 26 m, given no lamp         1,141   9,627 m of 27,223 m — 35.4% of the street
    segments given exactly one lamp, always side +1     217
    lamps on side +1 against side -1                 398 / 145   73.3% on one side
    lit edges lit on one side only                    163 of 276, 9,757 m of street

At the corridor camera the left side's nearest lamps are 6 m behind the lens and 210 m ahead. The lever
is to space by arc length along the whole EDGE and alternate (or pair) continuously, which roughly
doubles the count — a price in the gate's units, since lamps are three never-culled InstancedMeshes
in both passes (72 triangles a lamp, x2), and a night-look change for a blind review alongside #135.
