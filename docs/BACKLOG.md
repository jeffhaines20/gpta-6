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

### instanceColor caps every light detail at the car's own paint — NEW
Plate reaches **x0.41** of a real plate's ~0.80 reflectance, in the car's own hue, and no vertex
colour can raise it: body panels are already authored 0.995. Dark details survive; light ones
cannot. The tail lens is NOT affected in hue (R/(R+G+B) holds at 0.929-0.931) — its defect is
brightness alone, so it is not blocked by this. Escapes: emissive (the palette's emissive is not
multiplied, which is why the lens reads red at night, but the parked pool deliberately zeroes
every texel but the lens); a separate mesh (+1 draw call per pool); or accept it and fix #91
first, since two thirds of the fleet is achromatic and the plate is nearly right on those.

### #92 The side glass is within 8.6% of the paint at noon
Measured on the pane's own projection, glass over the door skin beside it: 0.934 / 0.837 /
0.972 / 1.043 after the pane fix. A window that reads as a window is well under half the paint
beside it. #54 records the opposite extreme at night (0.0225 in linear light) and #36 the hue
problem. The glazing is wrong at both ends of the day. Not yet established: whether the lever is
the normal, the material, or both — isolate one at a time; and what the target ratio IS, which
should be measured off `reference/sarasota/mapillary` rather than asserted.

### #91 Both fleets' chromatic third is still the hue wheel both comments say they replaced
`src/streetfurniture.js` ~4835 and `src/traffic.js` 472 both say a uniform hue wheel "was a
fairground" and that the reference is "overwhelmingly white, silver, grey and black with the
occasional red or blue". The achromatic claim is true (65.7%). The chromatic third is still the
wheel: green 28.0% of it, magenta/pink 13.2%, violet 10.9%, cyan 8.0% — 60% in families neither
comment mentions, against red+blue at 24.1%. `traffic.js` is worse: `setHSL(this._r(), ...)` is
a straight uniform draw. The TARGET should be stated as a table with a source, not chosen by
taste. `traffic.js`'s draw comes from the seeded stream, so changing how many draws it takes
perturbs every routing and spawn decision after it.

### #54 Traffic-car greenhouse is a hole at night: glass/paint 0.0225 in linear light
`detail lost` beyond the subject line. Related to #92 and #36.

### #36 Glass reads blue at noon again, because it now correctly reflects our very blue sky
`detail lost` beyond the subject line.

---

## Crime, damage and the police

### #90 The cap flattens everything above one star, and the offence floor is 3.3/km on an empty street
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
