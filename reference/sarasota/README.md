# Reference photography — downtown Sarasota

The baked district is real downtown Sarasota: `data/district.json` `meta.origin` is
27.335, -82.54125, and `data/raw/osm-extract.xml` carries Ringling Boulevard, Main Street,
Cocoanut Avenue, Central Avenue and Five Points. Only the names in the game are invented.

**Sources are restricted by binding constraint 1: openly licensed only (Wikimedia Commons,
Mapillary CC BY-SA) or photographs supplied by the user. No Google Maps or Street View
imagery is used anywhere in this project, including as critic reference.**

These are REFERENCE, not source assets. Nothing here is traced, sampled or copied into a
texture — materials stay procedurally authored (binding constraint 9), which also keeps the
CC BY-SA share-alike terms off the shipped assets.

| file | subject | from origin | licence | author |
|---|---|---|---|---|
| `00-First-Methodist-Church-Sarasota-Florida.jpg` | First Methodist Church, Sarasota, Florida | 74 m | CC BY 2.0 | Noé Alfaro |
| `01-S.H.-Kress-Building-Sarasota.jpg` | S.H. Kress Building - Sarasota | 157 m | CC BY-SA 4.0 | Upstateherd |
| `02-Worth-s-Block-Sarasota.jpg` | Worth's Block - Sarasota | 157 m | CC BY-SA 4.0 | Upstateherd |
| `03-Five-Points-Roundabout-in-Sarasota-Florida.jpg` | Five Points Roundabout in Sarasota, Florida | 211 m | CC BY-SA 3.0 | Patrick Braga |
| `04-Sarasota-Bay-and-waterfront-Sarasota-Florida-200` | Sarasota Bay and waterfront, Sarasota, Florida (2003) | 239 m | CC BY-SA 2.0 | Roger from Sarasota, Florida, U.S.A. |
| `05-Sarasota-Opera-House.jpg` | Sarasota Opera House | 344 m | CC BY-SA 4.0 | Thumbwind Publications LLC |
| `06-Frances-Carlton-Apartments-Sarasota.jpg` | Frances-Carlton Apartments - Sarasota | 401 m | CC BY-SA 4.0 | Upstateherd |
| `07-1777-Main-Street-in-Sarasota-Florida-December-20` | 1777 Main Street in Sarasota Florida December 2024 | 699 m | CC BY-SA 4.0 | FloridaArmy |
| `08-Sarasota-City-Center-at-1819-Main-Street-Decembe` | Sarasota City Center at 1819 Main Street December 2024 | 800 m | CC BY-SA 4.0 | FloridaArmy |
| `09-Untitled-panoramio-186-.jpg` | Untitled - panoramio (186) | 836 m | CC BY-SA 3.0 | William “Patrick” Ma… |

Full geosearch result including files not downloaded: `index.json` — 56 free-licence files
at 900 px or better, from 150 geolocated candidates within 900 m. Each entry carries its
Commons description page under `descUrl`.

## What the reference establishes about the real district

- **Palms are the dominant vegetation** — sabal and queen palms line Five Points and every
  building base. The district currently ships temperate broadleaf trees.
- **Terracotta barrel tile** appears as roofs, canopies and window hoods, including on the
  1970s concrete towers.
- **Cream and off-white precast concrete and stucco**, not grey.
- **Deep chamfered window reveals** that self-shadow strongly, rather than flush ribbon glazing.
- **Dark bronze / smoked glass**, not blue.
- **Five Points is a landscaped roundabout** with planted islands, low flowering shrubs and
  ornamental twin-globe lamp standards; its paving is pale concrete, not dark asphalt.

---

## `mapillary/` — street-level coverage of the hero corridor

229 photographs along the marina → Five Points → Main St east corridor, added 2026-09-02
once a session finally held `MAPILLARY_TOKEN`, and densified to 88 stations at 14 m
spacing on 2026-09-04. Fetched by `tools/fetch-mapillary.mjs`;
every file's creator, capture date, licence and Mapillary permalink is in
`mapillary/index.json`, and each is reported in the district's own local metres so a photo
can be found in-engine by parking the camera at the same `x,z`.

**Imagery © Mapillary contributors, CC BY-SA 4.0.** Same discipline as above: reference,
never source assets. Creators in this set are `Sitetour` (2024 panoramas), `networklanman`
(2021), `fdot_vl` (2016, Florida DOT), `lvl5` (2018) and `jbthemilker`.

### How dense, and why this dense

202 panoramas and 27 flat frames. Every panorama reprojects into BOTH street walls,
so the set yields **404 facade views plus 27 flat** — against 58 + 5 at the first
pass. The density is not collecting for its own sake: an adversarial review of the
roofline instrument found that only **6 of 48** reference frames were trustworthy,
because a live oak canopy and a white cloud both read as a roofline to a colour
detector and there is no way to tell a sunlit stucco parapet from a cloud edge on
one frame. More frames of the same wall from different stations is the only cheap
way to raise that count.

Flat coverage on this corridor is genuinely thin and no amount of searching fixes
it — 27 of 229, none at all at Pineapple or Five Points. `MLY_PER_STATION` exists
because of that: taking several panoramas per station at different headings is a
better use of the same bandwidth than widening the search radius, which just drags
in frames aimed down a side street.

### Two things worth knowing before re-running the fetch

**The Graph API's bbox response is capped, so a count from it is a lower bound.** The first
run asked for the whole trim box with `limit=40`, got 39 images, and every one was a
panorama from a single 2024 sequence — which read as "the district is pano-only". It is
not. The same box censused at `GRID=4` twice returned 4,348 then 4,814 unique images, and
at `GRID=8` returned 6,686. A number that grows as you subdivide is still hitting the cap;
one that moves between identical runs is a nondeterministic subset. Selection therefore
queries a small box at each corridor station instead, which stays under the cap and is
local and repeatable. `--census` reports the box count and says out loud that it is a floor.

**Most of the current coverage is 360 spheres** — 431 of the 670 images within reach of a
station. Raw, they are useless for judging a building, because equirectangular projection
bends a straight cornice into a sine wave. `tools/reproject-pano.mjs` remaps them to
rectilinear views aimed at either street wall, which makes them *better* reference than the
flat frames: a flat frame points wherever the capture vehicle was going, and a sphere can
be aimed at the shopfront. Its `--calibrate` mode checks the orientation convention against
a stretch of Main Street that runs dead east-west, where a view down the street and a view
at a wall are 90° apart and cannot be mistaken for each other.

Reprojected views land in `mapillary/views/` and are **not tracked** — derived, and
regenerable from the tool plus the index.
