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
