# Start here

Written for a session that begins with no memory of the conversation that produced this
branch. Read **`CONSTRAINTS.md` first** — it holds the user's standing rules, which are
not reconstructable from the code.

Branch: `claude/gta-game-feasibility-t31z79`. Everything below is pushed.

---

## Why this session exists: the Mapillary token

The previous session could not use it. **A cloud session copies environment values once,
at startup**, so a token added while a session is running is invisible to it. This session
should be able to see it.

Check, then run:

```bash
node tools/fetch-mapillary.mjs          # needs MAPILLARY_TOKEN
```

It exits 2 with an explanation if the token is absent. If it is absent and you expected it
to be there, the alternative is to add it as an **API credential** on the environment
(host `graph.mapillary.com`, header `Authorization`, prefix **`OAuth`** — not Bearer),
which the agent proxy attaches outside the sandbox and which works without restarting.

`graph.mapillary.com` is confirmed reachable from this environment.

### What it is for

The district is real **downtown Sarasota** (origin 27.335, −82.54125; the extract carries
Ringling Boulevard, Main Street, Cocoanut Avenue, Five Points). The brief is to make the
playable area look like the real place.

Wikimedia Commons gave 12 usable architectural photographs for **523 footprints** — enough
to author the Sarasota *idiom*, not enough to match specific buildings. Mapillary has dense
CC BY-SA street-level coverage and is what upgrades that to matching actual blocks along
Main Street.

The tool reports every photograph in the **district's local metres**, using the bake's own
projection, so the hero camera can be parked at the same `x,z` and compared like with like.
It flags panoramas, which are useless as facade reference without reprojection.

**Licence discipline is binding.** Mapillary imagery is CC BY-SA 4.0. It is reference,
never a source asset — nothing traced, sampled or colour-picked into a texture. See
constraint 1 and `reference/sarasota/README.md`.

---

## Where the work stands

Existing reference: `reference/sarasota/` — 10 downloaded photographs with licence and
author, several of buildings inside our own footprint set (First Methodist Church 74 m,
S.H. Kress and Worth's Block 157 m, Five Points Roundabout 211 m).

**What the photographs say we get wrong**, in priority order:

1. **Palms** — sabal with the fibrous crisscross boot trunk, and queen palms. We shipped
   temperate broadleaf trees. The biggest single tell. *A builder was working this when
   the previous session ended; check `src/streetfurniture.js` and the git log.*
2. **Brick paver sidewalks** — red-brown clay in running bond with a soldier-course border.
   We ship plain concrete slabs.
3. **Ornamental twin-globe black lamp standards** — we ship plain modern poles.
4. **Saturated fabric awnings**, scalloped or barrel-curved, gold and red.
5. **Warm painted brick** on the low-rise stock, not grey stucco — two-storey historic
   blocks standing directly against modern condo towers, which is what Main Street is.
6. **Terracotta barrel tile** as roofs, canopies and window hoods.

## Open items, with evidence

All have measurements in `PROGRESS.md`; none is guessed at.

- **A white rectangle on the corridor tower at golden hour** — four independent critic
  sightings, 47.7% pure white in that box. Strong hypothesis: the `sanitize()` guard in
  `src/post.js` maps non-finite channels to `CEIL = 60000`, far above the ACES shoulder,
  so a half-float overflow that used to render black now renders white. **The test is
  written but not run**: make `sanitize()` return a debug colour for non-finite input and
  re-capture the golden corridor frame.
- **Road albedo aliasing** — dropping the road map takes ground high-frequency energy
  6.39 → 2.29. Not chased, because the mipmap toggle in that probe may not have taken
  effect and this renderer appears not to implement anisotropic filtering. Needs real
  hardware.
- **Glazing has no environment term** — the tower pane sits at a fixed 0.82–0.84 of the
  wall beside it right through daylight. Three critic rounds have reported it.
- **Night lamps outside the nearest-10 pool glow without lighting** — 543 emitters, 10
  lit, selection by distance with no bias toward what is on screen. Three rounds.
- **Noon is deliberately unfixed** — the sun sits at 75.6°, so walls get almost nothing.
  The recorded starting point is to lower the elevation and re-measure the
  vertical/horizontal split before touching exposure.
- **`streaming.js` queue counter never drains** — sits at 69–81 forever while chunks,
  meshes and loads stop changing. Found by accident, not chased.

## Gate state

All green as of the last full run: syntax (81 modules), golden-trace, physics, geom-audit,
lighting sweep with both negative tests firing, budget PASS/PASS/WARN — draw 227,
triangles 721k, chunk stall 8.8.

The budget gate now **counts the shadow pass**; it did not before, because three.js resets
`renderer.info` between the shadow and opaque passes. Thresholds were re-derived and
logged. Chunk stall is noisy: **7.1–16.4 ms on unchanged builds**, so never read one run as
a regression.
