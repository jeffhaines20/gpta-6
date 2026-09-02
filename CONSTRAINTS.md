# Binding constraints

The standing rules for this project, in one place because they were previously
scattered across `FEASIBILITY-1B.md`, `README.md` and the conversation, and a session
that starts fresh cannot reconstruct them from the code.

**These are the user's calls, not mine. They are not to be relaxed, reinterpreted or
traded away for convenience.** Where one has been amended, the amendment is recorded
under it with the date and the reasoning.

---

## 1. Visual bar

The bar is **GTA V on PC**. GTA VI trailer frames are secondary reference, for
composition and colour script only.

For real-location fidelity, use **only openly licensed reference photographs**
(Mapillary CC BY-SA, Wikimedia Commons) or photographs the user supplies.

> **No Google Maps or Street View data or imagery anywhere in this project, including
> as critic references.**

This holds even when a request asks for "street views" in passing — it was asked for on
2026-09-02 and declined, with Mapillary and Commons offered instead. Reference is
**reference, never a source asset**: nothing is traced, sampled or colour-picked into a
texture, which is what keeps CC BY-SA share-alike off the shipped work.

## 2. Footprint

The baked **1.437 km²** district, unchanged. The **Main Street corridor from the marina
through Five Points** is the dense hero corridor. Bayfront water is the western world
edge.

## 3. Weather and time of day

**Rain and fog only.** The full day/night cycle is retained on the physical-unit
`daynight` system. **Every visual critique samples at least two times of day.**

## 4. CI gates

The budget gate (`tools/budget.mjs`, run via `tools/drive-through.mjs --traffic`) and the
golden-trace physics gate (`tools/golden-trace.mjs`) are **mandatory and never bypassed**.

> **Gates are never loosened silently.** A threshold change must be re-derived from
> measurements and logged in the ledger's Threshold change log.

Also gating: `check-syntax`, `physics-test`, `geom-audit`, `daynight-sweep`.

## 5. Critique discipline

Every visual critique is **paired with a scene-graph audit before any builder work is
scheduled from it**.

> **Critic measurements are evidence; critic diagnoses are hypotheses until audited.**

This has paid for itself repeatedly. Six critic headline diagnoses have failed audit,
including "nothing casts a shadow" (mast shadows existed), "the ground receives no direct
sunlight" (it receives 23–33%), and "a baked blob shadow decal" (a tree pit).

## 6. Three.js

Ships as the **committed minified build** in `vendor/`. No new dependencies.

## 7. Textures

Generated at runtime behind a loading screen. An IndexedDB cache is added **only if**
first load exceeds 8 s at a real-hardware checkpoint.

## 8. Descope

The ordered cut list in `FEASIBILITY-1B.md` §6 is the **only** descope path, executed
bottom-up and logged. **Reaching item 4 or beyond triggers escalation.** Bloom, height
fog and the two CI gates are **never** cut.

## 9. Massing

**Building massing is authoring work, not a data import.**

## 10. Source data and identity

Baked OSM geometry is authoritative for streets, footprints and coastline.

> **ODbL attribution — "© OpenStreetMap contributors" — remains in the README, the
> credits screen, and the on-page attribution line.**

**Amended 2026-09-02.** Originally "all identity fictional". The district is real
downtown Sarasota (origin 27.335, −82.54125). The user's call, given three options, was
**real streets, invented businesses**:

- **Streets and the city name are real.** They are factual public geography already
  carried in the OpenStreetMap extract.
- **Every business, shopfront, sign and logo stays invented.** The buildings are authored
  massing on real footprints, not surveyed premises — 5.7% carry a real height and 28.1%
  were hand-authored — so a real business name on one would claim a likeness we have not
  earned.

The fictionalizing machinery is retained behind `REAL_STREET_NAMES` in
`tools/bake/fictionalize.mjs`, so the swap is reversible.

---

## Escalation rule

**Stop and check in** if:

- **(a)** any budget gate fails twice after a documented strategy change
- **(b)** the cut list would reach item 4 or beyond
- **(c)** there is evidence a spec requirement is unreachable
- **(d)** anything would require **deploying, spending money, using credentials, fetching
  data at runtime, or contacting anyone** — all forbidden without explicit approval

Condition (a) was raised and resolved once, on 2026-09-01: the chunk-stall gate failed
three times in seven runs after the ground-contact work. The user's call was to isolate
before choosing a remedy, which found the cause was the shadow map's size rather than its
caster count.

## Milestone gates

**M1** textured district · **M2** living streets · **M3** playable slice.

At each: **STOP**, write `MILESTONE-N.md`, and wait for the user to say **CONTINUE**.

> **M3 has not been approved. Nothing proceeds past it.**

---

## Working rules earned the hard way

Not user constraints — lessons this project paid for. The ledger has the evidence.

- **Confirm what is in the sample, and when it was taken.** Scenes take ~30 s to finish
  streaming; a fixed short wait measures a half-built district. A sky claim from one
  column was wrong; three columns disagreed with it.
- **Verify an instrument can produce the opposite reading** before trusting a null
  result. A probe that toggled a material's visibility produced an identical frame — it
  was affecting zero meshes.
- **An incoherent number means you read it wrong**, not that the render is broken. A
  probe reporting a shadow removing 666% of the light the sun put down was subtracting
  against the wrong reference.
- **A value another system rewrites every frame is inert.** `LightPool` does this to
  `PointLight.intensity`; `material.envMapIntensity` is overwritten from
  `scene.environmentIntensity` unless the material owns an `envMap`.
- **While any agent is running, stage by explicit path** — `git add src/foo.js`, never
  `-A` or `.`. An `-A` once swept ~1,300 lines of two agents' in-flight work into an
  unrelated commit and corrupted one of their control runs.
- **Backticks inside a GLSL comment terminate the template literal.** This has happened
  twice.
- Frame **rate is never reported** from this container — it renders through SwiftShader.
