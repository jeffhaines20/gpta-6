# Port Verano — open-world driving prototype

A fully static, client-side open-world driving/on-foot prototype in Three.js.
No server, no runtime build step, no external asset downloads at runtime. Every
texture, mesh, animation and sound is generated procedurally in code.

Currently at **Phase 1b (feasibility)**. See
[FEASIBILITY.md](FEASIBILITY.md) and [FEASIBILITY-1B.md](FEASIBILITY-1B.md).

## Running

```
npm run serve      # static server on :8123
```

| Page | What it is |
|---|---|
| `/skeleton/` | Walking skeleton: character controller, raycast vehicle, chase camera |
| `/visual/` | Procedural street corner (visual bar check) |
| `/district/` | Streaming district on real baked map data |

## Checks

```
npm run test:physics    # deterministic fixed-step vehicle rig (no browser)
npm run test:golden     # golden-trace handling regression gate
npm run probe           # drives the walking skeleton via Playwright
npm run drive           # scripted district drive-through + draw-call budget gate
npm run drive:traffic   # same, with 30 stub vehicles
npm run sweep           # day/night sweep with scene-graph audits
```

## Map data attribution

The street topology, building footprints, land-use polygons and the bayfront
water boundary of the game's district are derived from **OpenStreetMap**.

> **© OpenStreetMap contributors**
> Map data available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
> See <https://www.openstreetmap.org/copyright>.

OSM data is used **at author time only** (`tools/bake/`). The game never fetches
map data at runtime; it loads the committed, derived `data/district.json`.
`data/district.json` is a Produced Work derived from an ODbL database and carries
the attribution above, which is also shown in the game's credits screen and in
the on-screen attribution line of the district page.

No Google Maps, Google Street View, or any other proprietary mapping data or
imagery is used anywhere in this project.

## Naming

The **geometry** is real; the **identity** is invented. The city, its bay, all
street names, businesses, signage and logos are fictional. The real→invented
street-name mapping is emitted into `data/district.json` under `streetNames` so
the decision can be revisited.
