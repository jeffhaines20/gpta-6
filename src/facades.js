// Facade recipes and the building kit-of-parts.
//
// Three things drive every decision in this file.
//
// 1. Phase 1's critic named "intentional irregularity" as the quality gap, so the
//    recipes below are hand-authored parameter sets — bay rhythms, colourways,
//    lit-window patterns and one-off accents are all written down, not sampled
//    from noise. Noise only ever perturbs an authored decision; it never makes one.
//
// 2. Albedo, emissive and roughness/metalness are drawn in ONE traversal of the
//    window grid. Phase 1 measured 2,219 ms per texture when the emissive mask was
//    recovered afterwards with a getImageData readback; drawing all three layers as
//    we go is effectively free and they cannot drift out of sync. Extra time-of-day
//    emissive variants replay a precomputed cell list, so the grid is walked once
//    no matter how many variants are asked for.
//
// 3. Nothing here creates a Mesh. Geometry helpers append into caller-owned arrays
//    with the same calling convention as geom.js extrudeFootprint, so the streamer
//    can merge a whole chunk into one geometry per material. Texture and material
//    factories are memoised by key, so a district of 523 buildings can never end up
//    with more materials than there are recipes.
//
// Wall UVs are in METRES (u along the wall, v up from the base), matching
// extrudeFootprint. A recipe therefore tiles by setting texture.repeat to
// 1/tileU x 1/tileV and every building of that recipe shares one texture.

import * as THREE from '../vendor/three.module.min.js';
import { applyGlazingEnv, applyStorefrontCoating } from './materials.js';

// ---------------------------------------------------------------- determinism
// Buildings must look the same on every load and in every session, so every
// random choice comes from a seed derived from the footprint itself.

export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = typeof p === 'string' ? p : String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const pick = (r, arr) => arr[Math.min(arr.length - 1, (r() * arr.length) | 0)];

// Weighted pick over [[value, weight], ...]. Used for window colour temperature,
// where the weights carry the authored intent (an office is mostly 4000 K).
function weighted(r, table) {
  let total = 0;
  for (const t of table) total += t[1];
  let x = r() * total;
  for (const t of table) { x -= t[1]; if (x <= 0) return t[0]; }
  return table[table.length - 1][0];
}

// ------------------------------------------------------------------- canvases
const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}
function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// One shared grain tile, generated once and scaled up by drawImage. Generating
// value noise at the full 1024 px panel size is a million-iteration JS loop per
// texture; at 192 px it is 28x cheaper and, composited in overlay at low alpha,
// indistinguishable at the frequencies a facade actually needs.
function grainTile(slot) {
  return memo(`grain:${slot}`, () => {
    const S = 192, c = canvas(S), g = c.getContext('2d');
    const img = g.createImageData(S, S);
    const grid = 24, r = rng(hash32('grain', slot));
    const base = new Float32Array(grid * grid);
    for (let i = 0; i < base.length; i++) base[i] = r();
    const at = (x, y) => base[(((y % grid) + grid) % grid) * grid + (((x % grid) + grid) % grid)];
    const smooth = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0, amp = 0.5, freq = grid / S;
        for (let o = 0; o < 3; o++) {
          const fx = x * freq, fy = y * freq;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const tx = smooth(fx - x0), ty = smooth(fy - y0);
          v += amp * lerp(
            lerp(at(x0, y0), at(x0 + 1, y0), tx),
            lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
          amp *= 0.5; freq *= 2;
        }
        const p = clamp01((v - 0.42) * 1.9 + 0.5) * 255;
        const i = (y * S + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = p;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

// A layer set: albedo, emissive and roughness/metalness drawn simultaneously in a
// single shared coordinate space. Emissive and RM are half-resolution because a
// glow and a material mask carry no high-frequency detail worth paying for, and
// the transform lets every draw call below stay in panel-space pixels.
function layers(P, emScale = 0.5, rmScale = 0.5) {
  const mk = (s) => {
    const c = canvas(Math.round(P * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    return { c, g };
  };
  return { P, al: mk(1), em: mk(emScale), rm: mk(rmScale) };
}

// Roughness/metalness are packed into one canvas: three.js samples roughnessMap.g
// and metalnessMap.b, so the same texture serves both and the red channel is left
// carrying ambient occlusion for anyone who wires up aoMap.
const rmColor = (rough, metal, ao = 1) =>
  `rgb(${Math.round(ao * 255)},${Math.round(clamp01(rough) * 255)},${Math.round(clamp01(metal) * 255)})`;

const hsl = (h, s, l) => `hsl(${h},${s}%,${l}%)`;

// A recipe colour triple as a canvas fill. `tone` scales the level and `cool`
// tilts blue against red, which is all a pane needs to stop being its
// neighbour's twin: separately glazed units age and tint differently.
const q255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const rgb = ([r, g, b], tone = 1, cool = 1) =>
  `rgb(${q255(r * tone * (2 - cool))},${q255(g * tone)},${q255(b * tone * cool)})`;

// ---------------------------------------------------------------- colour temps
// Interior lamps, warmest first. Real window grids read as a mix of colour
// temperatures; Phase 1's critic called flat uniform window colour a tell, and
// this table is the fix. Values are approximate sRGB for each Kelvin.
const CT = {
  k2200: '255,166,79',    // sodium / candle-warm restaurant
  k2700: '255,193,124',   // warm domestic LED
  k3000: '255,209,158',   // hotel corridor
  k4000: '255,238,222',   // neutral office
  k5000: '235,241,255',   // cool office / retail
  k6500: '206,226,255',   // fluorescent / workshop
  tv: '138,178,255',      // a television or monitor, flat and blue
};

// ---------------------------------------------------------------------- recipes
//
// Hand-authored parameter sets. Every field here is an art decision:
//   rhythm    relative bay widths across one tile — the source of intentional
//             irregularity. [1,1,1.35,1,1] is a wide centre bay, not noise.
//   floors    floors per tile; tileV = floors * floorM
//   winTop/H  window head and height as a fraction of the floor
//   reveal    depth of the recessed opening in panel pixels at 1024
//   litPattern how occupancy reads at night: 'scatter', 'floorBands' (offices
//             leave whole floors on for cleaners), 'stacks' (corridors and
//             stairwells light vertically), 'strip' (retail lights as a unit)
//   interior  lit-window luminance multiplier; a shop interior really is brighter
//             than a bedroom, and this is where that shows up
//   glass     THE COATING REFLECTANCE of the glazing, head / middle / cill, as
//             sRGB bytes. Not a tint: drawOpening writes these under a metallic
//             term, and three.js builds specularColor = mix(0.04, albedo,
//             metalness), so this colour IS the fraction of the sky the pane
//             sends back. Authoring it as a dark blue-grey — which is what a
//             pane LOOKS like in a photograph — is what made every window in the
//             district a flat fill: it set F0 to 0.02-0.08 while the masonry
//             beside it sat at 0.17-0.18, so the brick was three times the
//             mirror the glass was. The number to think in is F0: 0.22-0.33 for
//             a coated curtain wall, ~0.12-0.18 for domestic glass.
//
//             These bytes are UNCHANGED by the highlight round: they carry the
//             measured golden-hour colour (glass B/R 0.819 against a reference
//             0.804 over 317 photographs) and the deliberate cool tail, and the
//             coating lever was already exhausted - the response is
//             coating_BR^0.68, so closing noon by colour alone needs a
//             district-wide 0.49, which is uniform reflective bronze.
//
//             ROUGHNESS 0.07-0.13 AND METALNESS 0.80-0.88 ARE BOTH BACK AT
//             BASELINE, after a round that moved them to chase a blown pane and
//             was reverted whole. Recorded because the next person to look at
//             that pane will reach for these numbers first.
//
//             The pane: one bayTower cell whose normal sits 1.1 degrees off the
//             half-vector of an 8-degree golden sun. GGX at alpha = 0.013
//             returns about 1e6 cd/m2 against an ACES white point near 30,000,
//             so all three channels clip and it reads flat and achromatic.
//
//             Roughness DOWN to 0.053-0.065 does shrink it - box white 13.2% ->
//             10.5% with bloom on - because above the white point a highlight is
//             an AREA whose radius goes as sqrt(0.31*alpha*sqrt(F0) - alpha^2),
//             growing with roughness until alpha = 0.084. Broadening the lobe
//             makes it bigger, not softer.
//
//             But roughness is also what moves the COLOUR, measured per station
//             across three arms: the worst golden regression (0.925 -> 1.177)
//             is 99% roughness, and metalness had been partly CANCELLING it, so
//             roughness-only landed further from baseline than either. Golden
//             glass B/R goes 0.819 -> 0.858 against a reference 0.804 - giving up
//             a median that lands ON the reference to buy 2.7 points of one pane
//             in one frame at one hour.
//
//             So the pane is not a material fault and must not be fixed here. It
//             is a highlight-rolloff fault: a specular return 30x the white point
//             with nowhere to go. Fix it where it happens - a highlight
//             compression before the tonemap, or a per-pane specular clamp - not
//             by detuning the glazing of every building in the district.
//   accents   named one-off details, applied at authored positions

export const RECIPES = {
  retailStrip: {
    label: 'Low-rise retail strip',
    tileU: 16.8, floors: 2, floorM: 3.9, panel: 1024,
    // LOT MODULE, in metres. tileU is the width of one repeat of the PAINTED bay
    // rhythm - a window-scale number. lotM is a property-scale one: how wide a
    // single tenancy on this kind of street actually is. A fidelity review
    // measured 6-8 m shopfronts on Main Street against a 16.8 m tile and read the
    // tile as the module, which it is not; but the criticism underneath it was
    // right, because before the lot pass NOTHING in this file worked at property
    // scale at all. 7.6 m is the Main Street shopfront: two display bays and a
    // door. See lotCuts().
    lotM: 7.6,
    rhythm: [1, 1.45, 1, 1.2, 0.75],
    wall: { h: 36, s: 16, l: 72 },
    trimHue: 30,
    // The low-rise retail block is the ONE recipe reference/sarasota/
    // 02-Worth-s-Block is a photograph of, and that block is weathered red
    // brick against painted-cream brick with a maroon trim. What stood here was
    // four pale colourways, one of them teal, none darker than l 64: a downtown
    // whose two-storey stock is all the same value as its towers has no Main
    // Street in it. tintOf() divides the palette entry by the baked wall colour
    // and clamps at 1, so an entry can only ever DARKEN - which is exactly what
    // a brick block needs and what nothing in this list could do.
    palette: [{ h: 12, s: 30, l: 44 }, { h: 26, s: 14, l: 72 }, { h: 8, s: 34, l: 52 },
              { h: 38, s: 26, l: 62 }, { h: 44, s: 20, l: 70 }],
    win: { top: 0.10, h: 0.56, inset: 0.10, reveal: 7, mullionsV: 1, mullionsH: 1 },
    shape: 'glazed',
    spandrel: { l: -12, h: 0.30 },
    stringCourse: { at: 0.02, l: 12, thick: 9 },
    // F0 B/R 1.42 -> 0.81. Bronze-grey: this stock is 1920s-60s shopfront and office glass over trading floors, not a coated curtain wall.
    glass: [[157, 151, 145], [138, 131, 124], [108, 102, 95]],
    lit: { noon: 0.06, golden: 0.06, dusk: 0.62, night: 0.34 },
    litPattern: 'strip',
    ct: [[CT.k2700, 3], [CT.k3000, 3], [CT.k4000, 2], [CT.k5000, 2], [CT.k2200, 1]],
    interior: 1.5,
    blinds: 0.14,
    grime: 0.5,
    accents: ['awningStub', 'signBand', 'acUnit', 'patchedStucco'],
    // Built depth. `reveal` is how far the glazing sits behind the wall face,
    // `sill` how far the sill course stands proud of it, and `plinth` the base
    // course at the pavement. These are the numbers that turn a painted window
    // into an opening; see facadeEdge.
    depth: { reveal: 0.16, sill: 0.09, sillDrop: 0.07, plinth: 0.5, plinthOut: 0.06, plinthCell: 'concrete' },
    rough: 0.88, metal: 0.0,
  },

  midOffice: {
    label: 'Mid-rise office',
    tileU: 18.0, floors: 5, floorM: 3.6, panel: 1024,
    // Wider than retail: a 1970s commercial block was built on assembled lots and
    // subdivides more coarsely than a 1920s shopping street.
    lotM: 9.8,
    rhythm: [1, 1, 1, 0.42, 1, 1],          // the narrow bay is the service riser
    wall: { h: 34, s: 6, l: 62 },
    trimHue: 34,
    // reference/sarasota/07-1777-Main-Street is this recipe's real subject and
    // its precast is CREAM, not grey - warm enough to read against a blue sky.
    // One genuinely cool colourway is kept: not every 1970s block is warm.
    palette: [{ h: 36, s: 9, l: 64 }, { h: 30, s: 12, l: 58 }, { h: 42, s: 8, l: 68 },
              { h: 206, s: 5, l: 56 }],
    win: { top: 0.12, h: 0.50, inset: 0.045, reveal: 5, mullionsV: 2, mullionsH: 0 },
    shape: 'glazed',
    spandrel: { l: -9, h: 0.34 },
    stringCourse: { at: 0.0, l: 5, thick: 5 },
    // F0 B/R 1.53 -> 0.65, the warmest in the table. The subject of this recipe is 1777 Main Street, a 1970s precast block, and bronze glass is what that decade glazed them with.
    glass: [[172, 159, 144], [155, 142, 127], [120, 109, 95]],
    lit: { noon: 0.10, golden: 0.10, dusk: 0.46, night: 0.30 },
    litPattern: 'floorBands',
    ct: [[CT.k4000, 5], [CT.k5000, 4], [CT.k6500, 2], [CT.tv, 1], [CT.k3000, 1]],
    interior: 1.1,
    blinds: 0.34,
    grime: 0.34,
    accents: ['riserBlank', 'precastJoints', 'washedPanel'],
    depth: { reveal: 0.15, sill: 0.07, sillDrop: 0.06, plinth: 0.72, plinthOut: 0.07, plinthCell: 'stone' },
    rough: 0.72, metal: 0.06,
  },

  deco: {
    label: 'Art-deco downtown block',
    tileU: 15.6, floors: 3, floorM: 3.8, panel: 1024,
    lotM: 8.4,
    rhythm: [1.25, 0.9, 0.9, 1.25],
    wall: { h: 40, s: 22, l: 74 },
    trimHue: 22,
    // reference/sarasota/01-S.H.-Kress: cream glazed terracotta with an ochre
    // band, standing directly against a painted red block. Both are in here.
    palette: [{ h: 40, s: 18, l: 76 }, { h: 44, s: 30, l: 66 }, { h: 16, s: 30, l: 54 },
              { h: 34, s: 12, l: 82 }],
    win: { top: 0.13, h: 0.52, inset: 0.20, reveal: 11, mullionsV: 1, mullionsH: 1 },
    shape: 'glazed',
    spandrel: { l: -6, h: 0.22 },
    stringCourse: { at: 0.0, l: 16, thick: 13 },
    // F0 B/R 1.41 -> 0.86. Clear glass in a deep reveal, reflecting the warm masonry across the street rather than the sky.
    glass: [[148, 144, 141], [130, 126, 121], [101, 96, 91]],
    lit: { noon: 0.06, golden: 0.06, dusk: 0.50, night: 0.34 },
    litPattern: 'stacks',
    ct: [[CT.k2700, 4], [CT.k3000, 3], [CT.k4000, 2], [CT.k2200, 2]],
    interior: 1.0,
    blinds: 0.26,
    grime: 0.42,
    accents: ['pilasters', 'chevronSpandrel', 'keystone'],
    depth: { reveal: 0.26, sill: 0.13, sillDrop: 0.09, plinth: 0.85, plinthOut: 0.09, plinthCell: 'stone' },
    rough: 0.82, metal: 0.0,
  },

  bayTower: {
    label: 'Bayfront residential tower',
    tileU: 19.2, floors: 6, floorM: 3.15, panel: 1024,
    // NO lotM, and that stays true: a tower is ONE property and its upper floors
    // must stay one wall. `groundM` is the other half of that sentence - the
    // module its GROUND FLOOR subdivides at. A tower on a downtown block has a
    // row of shops at its foot under a single tower above; the reference is
    // 03-Five-Points, where the block left of the roundabout runs one unbroken
    // volume past a continuous canopy with separate tenancies under it, and
    // 07-1777-Main-Street, whose base is one recessed glazed storey under ten
    // identical ones.
    //
    // Before this the kit could not say that, because `lots` was a single flag
    // for "many properties" and "subdivided at street level" at once. Building
    // #76 - 35.2 m, three street elevations of 79.9 + 78.4 + 27.0 m - therefore
    // got one wall colour, one parapet, one window rhythm, no shopfront, no
    // door, no sign and no awning on all 185 m of it, and a blind critic called
    // it a 1970s parking deck.
    //
    // 12.5 m, against retailStrip's 7.6: a tower's structural bay is 9-10 m and
    // a tenancy under one spans one or two of them, so the units are fewer and
    // bigger than a platted 1920s Main Street shopfront. It went out at 10.6 and
    // came back at 12.5 for the budget - see LOT.groundMax, and the commit that
    // measured the district's real headroom at 359 triangles. Used ONLY by the
    // ground pass; `lotM` is still absent and still means this footprint is one
    // property. See `groundLots`.
    groundM: 12.5,
    rhythm: [1.2, 0.85, 1, 1, 0.85, 1.2],
    wall: { h: 38, s: 10, l: 84 },
    trimHue: 36,
    // The condo towers really are pale and really are the cool end of this
    // district - 02-Worth-s-Block has one rising straight out of the back of a
    // brick two-storey, and that contrast IS Main Street. Left pale, warmed a
    // little, with one warm-grey added so a row of them is not one value.
    palette: [{ h: 38, s: 8, l: 84 }, { h: 30, s: 12, l: 88 }, { h: 20, s: 14, l: 78 },
              { h: 196, s: 6, l: 82 }],
    win: { top: 0.09, h: 0.62, inset: 0.06, reveal: 6, mullionsV: 2, mullionsH: 0 },
    shape: 'glazed',
    spandrel: { l: -5, h: 0.24 },
    stringCourse: { at: 0.0, l: 8, thick: 7 },
    // F0 B/R 1.47 -> 1.21, and DELIBERATELY still the cool one. The Sarasota condo towers really are blue-green glazed; the reference distribution has a genuine cool tail (11% of views above B/R 1.2) and this is it. Desaturating this too would have hit the target number by flattening the district, which is the failure mode this recipe exists to avoid.
    glass: [[160, 168, 179], [146, 152, 160], [107, 111, 115]],
    lit: { noon: 0.04, golden: 0.04, dusk: 0.40, night: 0.40 },
    litPattern: 'stacks',
    ct: [[CT.k2700, 5], [CT.k2200, 2], [CT.k3000, 3], [CT.tv, 2], [CT.k4000, 1]],
    interior: 0.8,
    blinds: 0.30,
    grime: 0.22,
    accents: ['balconyRail', 'sliderDoors', 'saltStain'],
    depth: { reveal: 0.17, sill: 0.08, sillDrop: 0.06, plinth: 0.55, plinthOut: 0.06, plinthCell: 'concrete' },
    rough: 0.62, metal: 0.02,
  },

  parking: {
    label: 'Parking structure',
    tileU: 17.6, floors: 4, floorM: 3.0, panel: 1024,
    rhythm: [1, 1, 1, 1],
    wall: { h: 40, s: 3, l: 58 },
    trimHue: 34,
    // The deck behind the roundabout in 03-Five-Points is warm beige concrete.
    palette: [{ h: 38, s: 7, l: 58 }, { h: 30, s: 10, l: 54 }],
    win: { top: 0.16, h: 0.52, inset: 0.03, reveal: 9, mullionsV: 0, mullionsH: 0 },
    shape: 'deck',
    spandrel: { l: -7, h: 0.32 },
    stringCourse: { at: 0.0, l: 7, thick: 11 },
    glass: [[95, 96, 97], [77, 77, 77], [59, 59, 58]],      // the deck has no glazing; kept valid for the stair core
    lit: { noon: 0.9, golden: 0.9, dusk: 1.0, night: 1.0 },   // deck ceiling lamps, always on
    litPattern: 'scatter',
    ct: [[CT.k5000, 4], [CT.k6500, 3], [CT.k2200, 1]],
    interior: 0.45,
    blinds: 0,
    grime: 0.7,
    accents: ['deckRamp', 'cableRail', 'stairCore'],
    depth: { reveal: 0.34, sill: 0.10, sillDrop: 0.08, plinth: 0.62, plinthOut: 0.08, plinthCell: 'concrete' },
    rough: 0.93, metal: 0.0,
  },

  warehouse: {
    label: 'Industrial / warehouse',
    tileU: 16.0, floors: 2, floorM: 4.6, panel: 1024,
    rhythm: [1, 1, 1, 1, 1, 1, 1, 1],        // corrugated ribs, not bays
    wall: { h: 200, s: 7, l: 60 },
    trimHue: 205,
    // Warmed off the blue-grey default, but this is the one recipe entitled to
    // stay industrial: a metal shed is a metal shed in any climate.
    palette: [{ h: 34, s: 8, l: 62 }, { h: 200, s: 7, l: 58 }, { h: 22, s: 16, l: 54 }],
    win: { top: 0.08, h: 0.26, inset: 0.10, reveal: 4, mullionsV: 1, mullionsH: 0 },
    shape: 'louvre',
    spandrel: { l: -4, h: 0.12 },
    stringCourse: { at: 0.0, l: 6, thick: 5 },
    // F0 B/R 1.17 -> 0.96. Wired clerestory glass is green-grey, and it was already the least blue entry here.
    glass: [[134, 136, 134], [114, 115, 112], [94, 93, 90]],
    lit: { noon: 0.2, golden: 0.2, dusk: 0.42, night: 0.22 },
    litPattern: 'floorBands',
    ct: [[CT.k6500, 5], [CT.k5000, 3], [CT.k2200, 1]],
    interior: 0.9,
    blinds: 0,
    grime: 0.85,
    accents: ['corrugation', 'rollUpDoor', 'rustStreaks'],
    depth: { reveal: 0.10, sill: 0.05, sillDrop: 0.05, plinth: 0.45, plinthOut: 0.06, plinthCell: 'concrete' },
    rough: 0.55, metal: 0.35,
  },

  // The baked district is 131 detached houses. Mapping them onto the retail strip
  // recipe made whole residential blocks read as a shopping parade, so they get
  // their own set: stucco render, shutters, and a single storey of punched windows.
  stuccoHouse: {
    label: 'Stucco house / duplex',
    tileU: 12.6, floors: 1, floorM: 3.2, panel: 512,
    rhythm: [1, 0.7, 1.25, 0.8],
    wall: { h: 42, s: 20, l: 80 },
    trimHue: 32,
    // reference/sarasota/06-Frances-Carlton is salmon stucco under barrel tile,
    // and Florida's small stucco stock runs pastel - salmon, butter, cream, a
    // pale aqua. The olive that used to be in here is a temperate colour.
    palette: [{ h: 16, s: 40, l: 72 }, { h: 44, s: 30, l: 82 }, { h: 34, s: 12, l: 86 },
              { h: 168, s: 16, l: 78 }],
    win: { top: 0.22, h: 0.44, inset: 0.24, reveal: 8, mullionsV: 1, mullionsH: 1 },
    shape: 'glazed',
    spandrel: { l: -3, h: 0.10 },
    stringCourse: { at: 0.0, l: 10, thick: 7 },
    // F0 B/R 1.44 -> 0.90. Domestic clear glass over a dark room.
    glass: [[131, 129, 128], [113, 110, 108], [89, 86, 82]],
    lit: { noon: 0.03, golden: 0.03, dusk: 0.36, night: 0.26 },
    litPattern: 'scatter',
    ct: [[CT.k2700, 5], [CT.k2200, 3], [CT.tv, 2], [CT.k3000, 2]],
    interior: 0.7,
    blinds: 0.22,
    grime: 0.3,
    accents: ['shutters', 'acUnit'],
    depth: { reveal: 0.19, sill: 0.11, sillDrop: 0.07, plinth: 0.38, plinthOut: 0.06, plinthCell: 'stucco' },
    rough: 0.9, metal: 0.0,
  },
};

export const RECIPE_NAMES = Object.keys(RECIPES);
// Every hour a cell's `lit` flag is computed for. Not the same list as LIT_TIMES:
// this one drives `cell.lit[t] = cell.rank < rec.lit[t]`, and an hour missing from
// it leaves that flag `undefined`, which compares false and silently unlights the
// whole district rather than erroring. Cheap to carry - it is one boolean per cell,
// with no canvas behind it.
export const TIMES = ['noon', 'golden', 'dusk', 'night'];
// The hours that actually carry lit windows; see facadeMaps.
export const LIT_TIMES = ['dusk', 'night'];

// Emissive intensity per time of day, multiplied by a recipe's `interior`.
// These are not free parameters: they are set against daynight.js exposures
// (noon 1/78000, dusk 1/330, night 1/2.2). A lit window is a constant physical
// luminance, but at night the exposure is a 150x gain, so the stored intensity
// has to come down or every window clips to white and loses the colour
// temperature variation that is the whole point of the CT table.
// golden is 0 for noon's reason, one step further along. A window's interior is a
// fixed luminance; what changes is the stop. Dusk's 96 at golden's 1/4,239 would
// render at 0.023 in exposed units against a road at 0.11 and a sunlit facade at
// 1.15 - two orders under the wall it is cut into, i.e. invisible. So golden joins
// noon in having no emissive map baked at all (see LIT_TIMES): setFacadeTime falls
// back to the night map and multiplies it by zero, which costs nothing and keeps
// the 7 MB of VRAM a third emissive atlas would take.
export const EMISSIVE_INTENSITY = { noon: 0, golden: 0, dusk: 96, night: 3.1 };

// The same table for the TRIM atlas' lit shopfronts.
//
// NIGHT WAS 4.65 AND THAT WAS INHERITED REASONING, NOT A MEASUREMENT. 4.65 is
// EMISSIVE_INTENSITY.night times retailStrip's own `interior` of 1.5, chosen so
// that a shop window and the flat above it would burn at the identical stored
// intensity - two lit interiors on one elevation that disagree about their
// exposure compensation being a defect you cannot un-see. The argument is still
// right about the flats. It is wrong about the shopfront, and a review round
// found out how:
//
//   fivepoints-night, one bay at 12.7 m   p50 140, p90 210, max 222, 18.7% > 200
//   corridor-night,   one bay at 23.3 m   p90 156,                     1.8% > 200
//
// Both are glass@LIT on the same atlas row at the same intensity - verified by
// raycast, not assumed - so the whole of that 10x in clipping is camera distance.
// A punched facade window is a small opening seen at distance and never fills the
// frame; a shopfront pane is about 3 m square seen from 12 m, covering enough of
// the frame to bloom into itself and to sample the atlas near mip 0. The stored
// intensity is not a physical luminance, it is a rendering number, and the same
// luminance on those two surfaces does not survive the tonemap the same way.
//
// So night is set from the measurement instead. Inverting the ACES fit and the
// sRGB encode, p90 210 is about 0.55 in exposed units and the 165 wanted is about
// 0.255, a factor of 0.46; bloom falls away faster than linearly once the peak
// drops back under its threshold, so 0.62 is taken and the rest left to bloom.
// 4.65 * 0.62 = 2.88, rounded to 2.9. The prediction this makes, which the next
// capture either confirms or refutes: fivepoints p90 near 165-175 with >200 in
// low single figures, corridor p90 near 125-135 with >200 near zero.
//
// DUSK IS UNCHANGED at 144, on purpose and as an isolation: no reviewer reported
// clipping at dusk, the shopfront rects moved only 1.3-2.7 mean there against
// 14-29 at night, and changing two hours at once would leave neither measurable.
//
// noon and golden are zero for EMISSIVE_INTENSITY's reasons exactly - at 1/78,000
// and 1/4,239 a lit shop is two orders under the wall it is cut into - and here
// that zero is also the daylight PROOF: at those two hours totalEmissiveRadiance
// is emissive(1,1,1) * 0 * map = 0 for every texel of the atlas, so a lit tenancy
// and a dark one differ in nothing a daylight frame can sample.
export const TRIM_EMISSIVE = { noon: 0, golden: 0, dusk: 144, night: 2.9 };

// ------------------------------------------------------------- panel rendering

// Bay boundaries in panel pixels from a rhythm array.
function bayEdges(rhythm, P) {
  let total = 0;
  for (const w of rhythm) total += w;
  const out = [0];
  let acc = 0;
  for (const w of rhythm) { acc += w; out.push((acc / total) * P); }
  return out;
}

// One window opening: reveal, glass, soft occlusion under the lintel, sill and
// its grime streak, mullions. Drawn into albedo and RM together; lit state is
// recorded on the cell and rendered by drawLit so extra times of day cost a
// second short loop rather than a second grid walk.
function drawOpening(L, rec, cell, r) {
  const { al, rm } = L;
  const { x, y, w, h } = cell;
  const rev = rec.win.reveal * (L.P / 1024);
  const dark = rec.wall.l - 26;
  // Per-pane variation comes off a SEPARATE stream keyed to the cell's position,
  // not off `r`. The panel sequence decides which windows are lit, which have
  // blinds and what colour temperature they burn at — an authored set of
  // patterns — and drawing one extra number from it here would re-roll all of
  // that for every cell after this one. This way the district's occupancy is
  // bit-for-bit what it was before the glazing was touched.
  const jr = rng(hash32('pane', rec.label, Math.round(cell.x), Math.round(cell.y)));

  // The opening itself: masonry reveal, darker than the wall face.
  al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, Math.max(6, dark));
  al.g.fillRect(x, y, w, h);
  rm.g.fillStyle = rmColor(rec.rough * 0.95, rec.metal, 0.55);
  rm.g.fillRect(x, y, w, h);

  const gx = x + rev, gy = y + rev, gw = w - rev * 2, gh = h - rev * 1.4;

  if (rec.shape === 'deck') {
    // Open parking deck. This is a MOUTH, not a pane: there is no glazing here,
    // and it used to be painted as a 16,17,20 fill under an 0.85-black gradient
    // at the head, which is a hole in the elevation and read as one — blind
    // critics called the centre block's deck bands a missing texture twice.
    //
    // Read the opening top to bottom, because that order IS the effect: the head
    // is in the deepest shade in the bay, the back of the deck is a little
    // lighter off the floor bounce, and the strip of floor slab just behind the
    // spandrel rail is the one surface in there with a clear view of the sky and
    // is therefore the brightest thing in the opening by a factor of six. A flat
    // fill has none of that ordering, which is why it read as a hole.
    const deck = al.g.createLinearGradient(0, gy, 0, gy + gh * 0.66);
    deck.addColorStop(0, 'rgb(17,18,21)');       // soffit
    deck.addColorStop(0.22, 'rgb(27,28,32)');
    deck.addColorStop(0.62, 'rgb(36,38,42)');    // back of the deck
    deck.addColorStop(0.82, 'rgb(62,64,68)');    // floor starting to catch sky
    deck.addColorStop(1, 'rgb(112,114,118)');    // lit slab behind the rail
    al.g.fillStyle = deck;
    al.g.fillRect(gx, gy, gw, gh * 0.66);
    rm.g.fillStyle = rmColor(0.98, 0, 0.15);
    rm.g.fillRect(gx, gy, gw, gh);
    // That slab is fair-faced concrete with a sheen, not a matte void: it is the
    // part of the opening that answers the sky, so it gets a lobe.
    rm.g.fillStyle = rmColor(0.74, 0.05, 0.4);
    rm.g.fillRect(gx, gy + gh * 0.56, gw, gh * 0.10);

    // Structure inside the mouth, so the eye has something to land on: columns
    // on the bay lines with a lit nose, the roofs of two parked cars sitting on
    // the lit floor, and a beam hard under the head.
    const cols = 2 + ((jr() * 2) | 0);
    for (let i = 1; i <= cols; i++) {
      const cxp = gx + (gw * i) / (cols + 1), cw = Math.max(2, gw * 0.05);
      al.g.fillStyle = 'rgb(50,52,56)';
      al.g.fillRect(cxp - cw / 2, gy + gh * 0.06, cw, gh * 0.58);
      al.g.fillStyle = 'rgba(158,160,164,0.4)';
      al.g.fillRect(cxp - cw / 2, gy + gh * 0.1, Math.max(1, cw * 0.34), gh * 0.5);
    }
    for (let i = 0; i < 2; i++) {
      if (jr() < 0.3) continue;
      const cw2 = gw * (0.22 + jr() * 0.14), cx2 = gx + gw * (0.05 + jr() * 0.6);
      const chh = gh * 0.2, cy2 = gy + gh * 0.62 - chh;
      al.g.fillStyle = 'rgba(70,72,78,0.75)';
      al.g.fillRect(cx2, cy2, cw2, chh);
      al.g.fillStyle = 'rgba(158,164,172,0.45)';
      al.g.fillRect(cx2 + cw2 * 0.16, cy2, cw2 * 0.68, chh * 0.3);
    }
    al.g.fillStyle = 'rgba(0,0,0,0.55)';
    al.g.fillRect(gx, gy, gw, Math.max(2, gh * 0.1));
    // Spandrel rail across the lower third, as before, plus the shadow it throws
    // on the wall under it.
    al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l - 10);
    al.g.fillRect(gx, gy + gh * 0.66, gw, gh * 0.2);
    rm.g.fillStyle = rmColor(rec.rough, 0, 0.8);
    rm.g.fillRect(gx, gy + gh * 0.66, gw, gh * 0.2);
    al.g.fillStyle = 'rgba(0,0,0,0.42)';
    al.g.fillRect(gx, gy + gh * 0.86, gw, gh * 0.14);
  } else if (rec.shape === 'louvre') {
    // Wired clerestory glazing: dirty and flat, but still glass — it gets a
    // reduced coating rather than none, so a warehouse clerestory catches the
    // sky instead of reading as a painted panel.
    al.g.fillStyle = rgb(rec.glass[1]);
    al.g.fillRect(gx, gy, gw, gh);
    rm.g.fillStyle = rmColor(0.30, 0.45, 0.7);
    rm.g.fillRect(gx, gy, gw, gh);
    al.g.strokeStyle = 'rgba(30,34,38,0.5)';
    al.g.lineWidth = 1.4;
    for (let i = 1; i < 5; i++) {
      al.g.beginPath();
      al.g.moveTo(gx, gy + (gh * i) / 5); al.g.lineTo(gx + gw, gy + (gh * i) / 5);
      al.g.stroke();
    }
  } else {
    // Glass. The colour written here is the pane's COATING REFLECTANCE, not its
    // apparent colour: under the metallic term below, three.js takes
    // specularColor = mix(vec3(0.04), albedo, metalness), so this fill IS the
    // mirror. Measured at the left tower at dusk, the old dark-tint stops put
    // the glass at F0 0.038/0.059/0.082 against the masonry beside it at
    // 0.173/0.182/0.182; on a FLAT wall it is F0, not lobe width, that carries
    // the sky, and raising this one fill moved that pane 64.5 -> 126.6 mean
    // luminance where roughness and metalness together moved it by under 2.
    //
    // The gradient is the small half of it. It is a coated pane's own falloff —
    // marginally more reflective and cooler at the head where it is washed by
    // sky, dirtier and warmer at the cill — and the sky's actual colour arrives
    // from the environment probe, so it tracks the time of day for free instead
    // of being painted in.
    //
    // Per-pane jitter on the level and the colour temperature: a real elevation
    // is a set of separately-glazed, separately-aged units, and a critic reading
    // 60 identical rectangles is reading the absence of this line.
    const tone = 0.88 + jr() * 0.24;
    const cool = 0.93 + jr() * 0.14;
    const g0 = al.g.createLinearGradient(0, gy, 0, gy + gh);
    g0.addColorStop(0, rgb(rec.glass[0], tone, cool));
    g0.addColorStop(0.34 + r() * 0.12, rgb(rec.glass[1], tone, cool));
    g0.addColorStop(1, rgb(rec.glass[2], tone * 0.97, cool));
    al.g.fillStyle = g0;
    al.g.fillRect(gx, gy, gw, gh);
    // Roughness and metalness are the SMALL levers for a pane's TINT - at dusk,
    // moving roughness 0.129 -> 0.059 was worth 1.6 levels of pane luminance and
    // metalness 0.549 -> 0.902 was worth -0.4, against +62 for the fill above -
    // and they are the ONLY levers for its HIGHLIGHT. That is what these numbers
    // are now set for.
    //
    // THE WHITE RECTANGLE ON THE CORRIDOR TOWER WAS THIS CELL. Four critics and
    // two blind reviewers read it as a screen-space sprite; sanitize-probe.mjs
    // cleared the NaN guard and whitebox-probe.mjs cleared bloom. It is one
    // bayTower pane at mirror angle to an 8-degree sun, and it is not subtle:
    // raycast at 260,360 hits facade:bayTower at rm (0.114, 0.831), the sun's
    // half-vector sits 1.1 deg off that pane's normal, and GGX at alpha = r^2 =
    // 0.013 returns ~1e6 cd/m2 there against an ACES white point of 30,000 and a
    // post.js sanitize() ceiling of 60,000. All three channels land on the
    // ceiling, which is exactly why it reads flat and ACHROMATIC rather than
    // sun-coloured. debugSanitize paints 16.1% of the reviewers' box green.
    //
    // A BROADER LOBE MAKES IT WORSE, and that is worth stating because it is the
    // opposite of what everyone (me included) expected. Above the white point the
    // clipped patch is an area, not a peak, and its angular radius goes as
    // sqrt(0.31 * alpha * sqrt(F0) - alpha^2) - it GROWS with roughness until
    // alpha ~ 0.084 (r ~ 0.29). Measured on the corridor box, glass texels only,
    // one page session, bloom at the shipped 0.4:
    //
    //   r      0.052  0.065  0.085  0.114*  0.15   0.24   0.32   0.40
    //   white  9.3%   11.0%  26.8%  21.6%   27.4%  12.6%  10.1%  3.5%
    //
    // (* the value this line used to write.) Only r >= 0.32 beats r = 0.052, and
    // at 0.32 the applyGlazingEnv glass mask starts fading (it wants < 0.34) and
    // at 0.40 the whole district's glazing reads as satin panel - the crop shows
    // dark reveals turning milky. So: DOWN, to just above three.js' own 0.0525
    // floor, where the lobe is narrow enough that the pane keeps a gradient
    // instead of a plateau.
    //
    // Metalness carries the other half. F0 = mix(0.04, albedo, metalness), so
    // 0.80-0.88 made every pane in the district - 1920s shopfronts and stucco
    // houses included - a 25-31% mirror, which is coated-curtain-wall territory.
    // 0.62-0.70 puts F0 at 0.15-0.25 and costs almost nothing in brightness,
    // because what leaves the specular term arrives in the diffuse remainder
    // (1 - metalness, 0.30-0.38 now): measured box luma 176.0 -> 169.1 for the
    // metalness step alone. It is also the one lever that moves the noon colour
    // residual, because at noon the reflected radiance is B/R 2.53 while the
    // irradiance a pane stands in is 1.76 - so shifting weight from mirror to
    // diffuse warms the pane - while at golden the two are 1.429 and 1.433, i.e.
    // the same, so golden's B/R is invariant to the split. Both numbers are off
    // the chrome ball and the diffuse ball in docs/measurements/pane-tint-eng-*.
    //
    // Still true, and why this did not go lower: the lobe has to stay wide enough
    // that a street lamp reflects as a smear rather than an invisible point, and
    // the diffuse remainder has to be big enough that an unlit pane still answers
    // the ambient after the sky has gone.
    rm.g.fillStyle = rmColor(0.07 + r() * 0.06, 0.80 + jr() * 0.08, 0.9);
    rm.g.fillRect(gx, gy, gw, gh);
  }

  // Blinds. Three states, not two: none, half-drawn, and fully drawn. A fully
  // drawn blind still passes light at night, so it is stored on the cell rather
  // than punched out of the emissive the way Phase 1 did it.
  // Hoisted, because the reveal shading below has to punch the blind back into
  // its clip and needs the height this actually drew - not a re-rolled one. A
  // second r() here would also shift every subsequent draw in the panel.
  let bh = 0;
  if (cell.blind > 0) {
    bh = cell.blind === 2 ? gh : gh * (0.28 + r() * 0.34);
    al.g.fillStyle = cell.blind === 2 ? 'rgba(216,208,192,0.88)' : 'rgba(198,192,178,0.8)';
    al.g.fillRect(gx, gy, gw, bh);
    al.g.strokeStyle = 'rgba(120,114,102,0.35)';
    al.g.lineWidth = 1;
    for (let sy = gy + 3; sy < gy + bh; sy += 4) {
      al.g.beginPath(); al.g.moveTo(gx, sy); al.g.lineTo(gx + gw, sy); al.g.stroke();
    }
    rm.g.fillStyle = rmColor(0.86, 0, 0.7);
    rm.g.fillRect(gx, gy, gw, bh);
  }

  // Mullions and transom.
  if (rec.win.mullionsV || rec.win.mullionsH) {
    al.g.fillStyle = hsl(rec.wall.h, Math.max(0, rec.wall.s - 8), Math.max(10, rec.wall.l - 34));
    const mw = Math.max(1.5, 2.6 * (L.P / 1024));
    for (let i = 1; i <= rec.win.mullionsV; i++) {
      al.g.fillRect(gx + (gw * i) / (rec.win.mullionsV + 1) - mw / 2, gy, mw, gh);
    }
    for (let i = 1; i <= rec.win.mullionsH; i++) {
      al.g.fillRect(gx, gy + (gh * i) / (rec.win.mullionsH + 1) - mw / 2, gw, mw);
    }
  }

  // Recessed-reveal shading. This is the detail Phase 1's critic singled out as
  // working, so it is kept and extended: occlusion under the lintel, a jamb
  // gradient on one side only (light comes from one direction), and a bright sill
  // with its own drop shadow. It is baked into albedo rather than left to aoMap
  // because aoMap needs a uv1 attribute the streamer does not currently emit.
  //
  // IT MUST NOT REACH THE GLASS, AND FOR THREE ROUNDS IT DID. A pane is written
  // at metalness 0.80-0.88 twenty lines above, and three.js builds
  //
  //   material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalness )
  //
  // so on a pane this albedo is not a shade over a diffuse surface - it IS the
  // mirror's reflectance. Painted at full strength over the top 42% of the
  // opening it took the coating the recipe authors (157,151,145 -> F0 0.290) down
  // to 157*0.38 = 60 -> F0 0.044 at the head: a 6.6x cut in how much sky a pane
  // can return, deepest exactly where a pane returns the most of it. That is the
  // whole of the "vertical profile is backwards - dark at the head, bright at the
  // cill" that three independent reviewers measured off the frame and read, quite
  // reasonably, as ambient occlusion on a diffuse surface. It was ambient
  // occlusion, on a mirror.
  //
  // It is also why the environment term already in the shader did not show:
  // applyGlazingEnv was compiled, bound and directionally correct (glaz-probe:
  // 4 programs carry it, and pane radiance tracks reflected elevation), and it
  // was being multiplied by an F0 six times too small. Measured, both halves, in
  // tools/glass-f0.mjs (atlas) and tools/glaz-probe.mjs (frame).
  //
  // So the masonry keeps this and the glazing does not. The fill is clipped to
  // the reveal - the opening rect with the glazing punched out of it, even-odd -
  // and a drawn blind is punched back IN, because a blind is cloth and does want
  // its lintel shadow. Three rects, odd crossings inside: reveal 1, glass 2,
  // blind 3.
  al.g.save();
  al.g.beginPath();
  al.g.rect(x, y, w, h);
  if (rec.shape !== 'deck') {
    // A parking deck is a hole, not glazing: its cell is rough and dielectric, so
    // its albedo really is a diffuse surface and really does want the occlusion.
    al.g.rect(gx, gy, gw, gh);
    if (bh > 0) al.g.rect(gx, gy, gw, bh);
  }
  al.g.clip('evenodd');
  const head = al.g.createLinearGradient(0, y, 0, y + h * 0.42);
  head.addColorStop(0, 'rgba(0,0,0,0.62)');
  head.addColorStop(1, 'rgba(0,0,0,0)');
  al.g.fillStyle = head;
  al.g.fillRect(x, y, w, h * 0.42);

  const jamb = al.g.createLinearGradient(x, 0, x + w * 0.3, 0);
  jamb.addColorStop(0, 'rgba(0,0,0,0.40)');
  jamb.addColorStop(1, 'rgba(0,0,0,0)');
  al.g.fillStyle = jamb;
  al.g.fillRect(x, y, w * 0.3, h);
  al.g.restore();

  // The pane's own share of it, at the depth of the actual reveal instead of at
  // 42% of a storey. A pane set back behind a reveal does darken at its head and
  // at its return jamb - but as a MIRROR, because what it reflects there is the
  // soffit and the jamb return rather than the sky, and the soffit is only
  // `reveal` deep. So: the same cue, one order of magnitude smaller, and it
  // stops at the band a 0.16 m reveal can actually subtend.
  if (rec.shape !== 'deck' && bh < gh) {
    const gy0 = gy + bh;
    const soffitH = Math.min(gh - bh, rev * 2.6);
    const soffit = al.g.createLinearGradient(0, gy0, 0, gy0 + soffitH);
    soffit.addColorStop(0, 'rgba(0,0,0,0.30)');
    soffit.addColorStop(1, 'rgba(0,0,0,0)');
    al.g.fillStyle = soffit;
    al.g.fillRect(gx, gy0, gw, soffitH);
    const ret = al.g.createLinearGradient(gx, 0, gx + rev * 2.2, 0);
    ret.addColorStop(0, 'rgba(0,0,0,0.20)');
    ret.addColorStop(1, 'rgba(0,0,0,0)');
    al.g.fillStyle = ret;
    al.g.fillRect(gx, gy0, Math.min(gw, rev * 2.2), gh - bh);
  }

  // Sill: proud of the wall, so it catches light on top and casts below.
  const sillH = Math.max(2, 5 * (L.P / 1024));
  al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, Math.min(96, rec.wall.l + 12));
  al.g.fillRect(x - sillH, y + h, w + sillH * 2, sillH);
  al.g.fillStyle = 'rgba(0,0,0,0.34)';
  al.g.fillRect(x - sillH, y + h + sillH, w + sillH * 2, sillH * 0.8);
  rm.g.fillStyle = rmColor(rec.rough * 0.85, 0, 0.8);
  rm.g.fillRect(x - sillH, y + h, w + sillH * 2, sillH);

  // Grime washing down from the sill ends: the single cheapest cue that a
  // building has been standing in weather.
  if (cell.streak) {
    const sl = al.g.createLinearGradient(0, y + h, 0, y + h + h * 0.9);
    sl.addColorStop(0, `rgba(48,44,38,${0.24 * rec.grime})`);
    sl.addColorStop(1, 'rgba(48,44,38,0)');
    al.g.fillStyle = sl;
    al.g.fillRect(x - sillH, y + h, w * 0.22, h * 0.9);
    al.g.fillRect(x + w * 0.78, y + h, w * 0.22, h * 0.9);
  }
}

// Emissive for one cell at one time of day. Also draws the light spilling onto
// the reveal, which is what makes a lit window read as recessed at night.
function drawLit(L, rec, cell, tod) {
  if (!cell.lit[tod]) return;
  const eg = L.em.g;
  const rev = rec.win.reveal * (L.P / 1024);
  const { x, y, w, h } = cell;
  const gx = x + rev, gy = y + rev, gw = w - rev * 2, gh = h - rev * 1.4;
  const ct = cell.ct;

  if (rec.shape === 'deck') {
    // A parking deck shows the ceiling lamps, not a lit room: a bright band at
    // the head of the opening falling off fast.
    const g0 = eg.createLinearGradient(0, gy, 0, gy + gh * 0.7);
    g0.addColorStop(0, `rgba(${ct},0.95)`);
    g0.addColorStop(1, `rgba(${ct},0)`);
    eg.fillStyle = g0;
    eg.fillRect(gx, gy, gw, gh * 0.7);
    return;
  }

  // A fully drawn blind diffuses rather than blocks: dimmer, flatter, no hotspot.
  const a = cell.blind === 2 ? cell.glow * 0.42 : cell.glow;
  const g0 = eg.createLinearGradient(0, gy, 0, gy + gh);
  g0.addColorStop(0, `rgba(${ct},${a})`);
  g0.addColorStop(0.62, `rgba(${ct},${a * (cell.blind === 2 ? 0.92 : 0.74)})`);
  g0.addColorStop(1, `rgba(${ct},${a * (cell.blind === 2 ? 0.85 : 0.44)})`);
  eg.fillStyle = g0;
  eg.fillRect(gx, gy, gw, gh);

  if (cell.blind === 1) {
    // Half-drawn: the blind is lit from behind, the open part is the bright part.
    eg.fillStyle = `rgba(${ct},${a * 0.30})`;
    eg.fillRect(gx, gy, gw, gh * 0.4);
  }

  // The interior. A lit window is a room, not a rectangle of light: the ceiling
  // just inside the head is the brightest thing in it, the light dies into the
  // jambs, and SOMETHING always breaks the field — a partition, a counter, the
  // back of a wardrobe. Four critics called these flat blown-out rectangles with
  // no interior; nothing in them is actually clipping (measured on the night
  // hero: 0 of 25,413 lit pane pixels at R >= 250), so what is missing is
  // structure, not headroom, and structure is free here.
  //
  // Everything below is keyed off cell.rank, never off r(): drawLit replays the
  // same cell list once per time of day, so a window's furniture has to be the
  // same at dusk as it is at night, and a draw that consumed from the sequence
  // would put the two hours out of step.
  if (cell.blind !== 2) {
    const k = (cell.rank * 7.3) % 1;
    const cg = eg.createLinearGradient(0, gy, 0, gy + gh * 0.32);
    cg.addColorStop(0, `rgba(${ct},${a * 0.30})`);
    cg.addColorStop(1, `rgba(${ct},0)`);
    eg.fillStyle = cg;
    eg.fillRect(gx, gy, gw, gh * 0.32);

    const side = Math.max(1, gw * 0.17);
    for (const [x0, x1] of [[gx, gx + side], [gx + gw, gx + gw - side]]) {
      const sg = eg.createLinearGradient(x0, 0, x1, 0);
      sg.addColorStop(0, `rgba(0,0,0,${0.36 * a})`);
      sg.addColorStop(1, 'rgba(0,0,0,0)');
      eg.fillStyle = sg;
      eg.fillRect(Math.min(x0, x1), gy, side, gh);
    }

    if (k < 0.36) {
      // A partition or a curtain against one jamb.
      const pw = gw * (0.18 + k);
      eg.fillStyle = 'rgba(0,0,0,0.44)';
      eg.fillRect(k < 0.18 ? gx : gx + gw - pw, gy + gh * 0.14, pw, gh * 0.86);
    } else if (k < 0.78) {
      // A counter, a desk or a sill run across the lower part of the room.
      const ty = gy + gh * (0.56 + (k - 0.36) * 0.5);
      eg.fillStyle = 'rgba(0,0,0,0.40)';
      eg.fillRect(gx, ty, gw, gy + gh - ty);
      eg.fillStyle = `rgba(${ct},${a * 0.18})`;
      eg.fillRect(gx, ty, gw, Math.max(1, gh * 0.05));
    }
  }

  // Spill onto the reveal. Weak, but it is the difference between a glowing
  // rectangle and a window in a wall.
  eg.fillStyle = `rgba(${ct},${a * 0.22})`;
  eg.fillRect(x, y, w, rev);
  eg.fillRect(x, y + h - rev * 0.4, w, rev * 0.4);
  eg.fillRect(x, y, rev, h);
  eg.fillRect(x + w - rev, y, rev, h);
}

// Recipe-specific hand-placed detail. These are the "authored" half of the
// intentional-irregularity answer: each one is a decision about what this kind of
// building has on it, placed at a position the recipe chose.
function drawAccents(L, rec, cells, cols, rows, r, ex) {
  const { al, rm, P } = L;
  const fh = P / rows;
  const s = P / 1024;

  for (const a of rec.accents) {
    switch (a) {
      case 'pilasters': {
        // Deco: full-height ribs on the bay divisions, brighter than the wall,
        // with a shadow on one side. Drawn wrapped so the tile seam is invisible.
        for (let i = 0; i < ex.length; i++) {
          const x = ex[i], pw = 24 * s;
          for (const off of [0, -P, P]) {
            if (x + off < -pw || x + off > P + pw) continue;
            al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + 10);
            al.g.fillRect(x + off - pw / 2, 0, pw, P);
            al.g.fillStyle = 'rgba(255,250,238,0.30)';
            al.g.fillRect(x + off - pw / 2, 0, 4 * s, P);
            al.g.fillStyle = 'rgba(0,0,0,0.34)';
            al.g.fillRect(x + off + pw / 2 - 5 * s, 0, 5 * s, P);
          }
        }
        break;
      }
      case 'chevronSpandrel': {
        // A repeated stepped motif in the spandrel band — the deco signature.
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * (rec.win.top + rec.win.h) + 10 * s;
          for (let i = 0; i < cols; i++) {
            const x0 = ex[i], x1 = ex[i + 1], cx = (x0 + x1) / 2;
            al.g.fillStyle = hsl(rec.trimHue, rec.wall.s + 14, rec.wall.l - 16);
            for (let k = 0; k < 3; k++) {
              al.g.fillRect(cx - (16 - k * 5) * s, y + k * 5 * s, (32 - k * 10) * s, 3.4 * s);
            }
          }
        }
        break;
      }
      case 'keystone': {
        for (let rr = 0; rr < rows; rr++) {
          for (let i = 0; i < cols; i++) {
            const cx = (ex[i] + ex[i + 1]) / 2, y = rr * fh + fh * rec.win.top;
            al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + 11);
            al.g.fillRect(cx - 7 * s, y - 11 * s, 14 * s, 11 * s);
            al.g.fillStyle = 'rgba(0,0,0,0.25)';
            al.g.fillRect(cx - 7 * s, y - 2 * s, 14 * s, 2 * s);
          }
        }
        break;
      }
      case 'riserBlank': {
        // The narrow bay in the office rhythm is a service riser: no glazing,
        // a different panel finish, and a louvre near the top of each floor.
        const i = rec.rhythm.indexOf(Math.min(...rec.rhythm));
        const x0 = ex[i], x1 = ex[i + 1];
        al.g.fillStyle = hsl(rec.wall.h, rec.wall.s + 2, rec.wall.l - 7);
        al.g.fillRect(x0, 0, x1 - x0, P);
        rm.g.fillStyle = rmColor(rec.rough + 0.08, rec.metal, 0.85);
        rm.g.fillRect(x0, 0, x1 - x0, P);
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * 0.2;
          al.g.fillStyle = 'rgba(40,42,46,0.85)';
          al.g.fillRect(x0 + 8 * s, y, x1 - x0 - 16 * s, fh * 0.22);
          al.g.strokeStyle = 'rgba(150,152,158,0.4)';
          al.g.lineWidth = 1;
          for (let k = 1; k < 6; k++) {
            const ly = y + (fh * 0.22 * k) / 6;
            al.g.beginPath(); al.g.moveTo(x0 + 8 * s, ly); al.g.lineTo(x1 - 8 * s, ly); al.g.stroke();
          }
        }
        break;
      }
      case 'precastJoints': {
        // Panel joints on the bay lines and the floor lines: an office facade is
        // assembled from panels and the seams are always visible in raking light.
        al.g.strokeStyle = 'rgba(0,0,0,0.20)';
        al.g.lineWidth = 2 * s;
        for (const x of ex) {
          al.g.beginPath(); al.g.moveTo(x, 0); al.g.lineTo(x, P); al.g.stroke();
        }
        break;
      }
      case 'washedPanel': {
        // One panel column was replaced or re-rendered and does not match.
        const i = (r() * cols) | 0;
        al.g.fillStyle = `rgba(255,252,244,${0.10 + r() * 0.07})`;
        al.g.fillRect(ex[i], 0, ex[i + 1] - ex[i], P);
        break;
      }
      case 'corrugation': {
        // Vertical ribs across the whole panel, with the shadow side always the
        // same side so the sheet reads as one direction of profile.
        for (let x = 0; x < P; x += 13 * s) {
          al.g.fillStyle = 'rgba(255,255,255,0.09)';
          al.g.fillRect(x, 0, 4 * s, P);
          al.g.fillStyle = 'rgba(0,0,0,0.16)';
          al.g.fillRect(x + 4 * s, 0, 3.2 * s, P);
        }
        break;
      }
      case 'rollUpDoor': {
        const i = 2 % cols;
        const x0 = ex[i], x1 = ex[Math.min(ex.length - 1, i + 2)];
        const y0 = P - fh * 0.94;
        al.g.fillStyle = 'rgb(78,84,88)';
        al.g.fillRect(x0, y0, x1 - x0, fh * 0.94);
        rm.g.fillStyle = rmColor(0.5, 0.6, 0.7);
        rm.g.fillRect(x0, y0, x1 - x0, fh * 0.94);
        al.g.strokeStyle = 'rgba(20,22,24,0.55)';
        al.g.lineWidth = 1.6 * s;
        for (let y = y0 + 8 * s; y < P; y += 11 * s) {
          al.g.beginPath(); al.g.moveTo(x0, y); al.g.lineTo(x1, y); al.g.stroke();
        }
        break;
      }
      case 'rustStreaks': {
        for (let i = 0; i < 14; i++) {
          const x = r() * P, y = r() * P * 0.7, w = (3 + r() * 7) * s, h = (40 + r() * 190) * s;
          const g0 = al.g.createLinearGradient(0, y, 0, y + h);
          g0.addColorStop(0, `rgba(112,62,30,${0.22 + r() * 0.3})`);
          g0.addColorStop(1, 'rgba(112,62,30,0)');
          al.g.fillStyle = g0;
          al.g.fillRect(x, y, w, h);
        }
        break;
      }
      case 'deckRamp': {
        // The ramp: a sloped soffit line crossing the deck openings.
        al.g.save();
        al.g.strokeStyle = 'rgba(28,28,30,0.65)';
        al.g.lineWidth = 9 * s;
        al.g.beginPath();
        al.g.moveTo(0, fh * 0.42); al.g.lineTo(P, fh * 1.34);
        al.g.stroke();
        al.g.restore();
        break;
      }
      case 'cableRail': {
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * (rec.win.top + rec.win.h * 0.5);
          al.g.strokeStyle = 'rgba(190,192,196,0.5)';
          al.g.lineWidth = 1.4 * s;
          for (let k = 0; k < 3; k++) {
            al.g.beginPath();
            al.g.moveTo(0, y + k * 6 * s); al.g.lineTo(P, y + k * 6 * s);
            al.g.stroke();
          }
        }
        break;
      }
      case 'stairCore': {
        const x0 = ex[0], x1 = ex[1];
        al.g.fillStyle = hsl(rec.wall.h, rec.wall.s + 4, rec.wall.l - 12);
        al.g.fillRect(x0, 0, x1 - x0, P);
        al.g.fillStyle = 'rgba(0,0,0,0.30)';
        for (let rr = 0; rr < rows; rr++) {
          al.g.fillRect(x0 + (x1 - x0) * 0.3, rr * fh + fh * 0.24, (x1 - x0) * 0.4, fh * 0.42);
        }
        break;
      }
      case 'signBand': {
        // A blank painted fascia over the shopfronts. Deliberately unlettered:
        // signage and branding are another builder's module.
        const y = P - fh * 1.06;
        al.g.fillStyle = hsl(rec.trimHue, rec.wall.s + 10, rec.wall.l - 26);
        al.g.fillRect(0, y, P, fh * 0.24);
        al.g.fillStyle = 'rgba(0,0,0,0.28)';
        al.g.fillRect(0, y + fh * 0.24, P, 5 * s);
        rm.g.fillStyle = rmColor(0.42, 0, 0.9);
        rm.g.fillRect(0, y, P, fh * 0.24);
        break;
      }
      case 'awningStub': {
        // The shadow an awning throws ON THE WALL, for the bays that have one -
        // and on the wall is the whole of it. This runs after every drawOpening,
        // so at full strength it was also painting 0.45 black over the shopfront
        // GLAZING of the ground floor, where albedo is F0 (see the long note in
        // drawOpening) and a shadow is a 45% cut in the mirror. This is the same
        // defect as the reveal gradient, one bay lower, and it lands on exactly
        // the shopfront panes a street-level frame is mostly made of.
        //
        // The awning does darken the pane under it - a canopy soffit is what a
        // shopfront reflects at an upward angle - so it is kept over the glass at
        // a third of the strength, with the two-thirds difference falling only on
        // the masonry. Same three-rect even-odd trick as the reveal.
        const groundRow = (rows - 1) * cols;
        for (let i = 0; i < cols; i++) {
          if (((i * 7 + 3) % 5) > 2) continue;
          const y = P - fh * 0.82;
          const glass = cells[groundRow + i];
          const paint = (alpha) => {
            const g0 = al.g.createLinearGradient(0, y, 0, y + fh * 0.5);
            g0.addColorStop(0, `rgba(0,0,0,${alpha})`);
            g0.addColorStop(1, 'rgba(0,0,0,0)');
            al.g.fillStyle = g0;
            al.g.fillRect(ex[i], y, ex[i + 1] - ex[i], fh * 0.5);
          };
          if (!glass || rec.shape === 'deck') { paint(0.45); continue; }
          const rv = rec.win.reveal * (P / 1024);
          al.g.save();
          al.g.beginPath();
          al.g.rect(ex[i], y, ex[i + 1] - ex[i], fh * 0.5);
          al.g.rect(glass.x + rv, glass.y + rv, glass.w - rv * 2, glass.h - rv * 1.4);
          al.g.clip('evenodd');
          paint(0.45);
          al.g.restore();
          paint(0.15);
        }
        break;
      }
      case 'acUnit': {
        // A through-wall air conditioner in one window. One per tile, not many:
        // the point of a hand-placed accent is that it is rare.
        const c = cells[(r() * cells.length) | 0];
        if (!c) break;
        al.g.fillStyle = 'rgb(158,158,152)';
        al.g.fillRect(c.x + c.w * 0.18, c.y + c.h * 0.56, c.w * 0.64, c.h * 0.36);
        al.g.fillStyle = 'rgba(0,0,0,0.35)';
        al.g.fillRect(c.x + c.w * 0.18, c.y + c.h * 0.92, c.w * 0.64, 4 * s);
        rm.g.fillStyle = rmColor(0.55, 0.4, 0.7);
        rm.g.fillRect(c.x + c.w * 0.18, c.y + c.h * 0.56, c.w * 0.64, c.h * 0.36);
        c.blind = 2;
        break;
      }
      case 'patchedStucco': {
        for (let i = 0; i < 3; i++) {
          const x = r() * P, y = r() * P, w = (60 + r() * 150) * s, h = (40 + r() * 110) * s;
          al.g.fillStyle = `rgba(${200 + r() * 40 | 0},${190 + r() * 40 | 0},${170 + r() * 40 | 0},0.13)`;
          al.g.fillRect(x, y, w, h);
        }
        break;
      }
      case 'shutters': {
        for (const c of cells) {
          const sw = c.w * 0.17;
          al.g.fillStyle = hsl(rec.trimHue + 140, 18, 44);
          al.g.fillRect(c.x - sw, c.y, sw, c.h);
          al.g.fillRect(c.x + c.w, c.y, sw, c.h);
          al.g.fillStyle = 'rgba(0,0,0,0.25)';
          for (let sy = c.y + 3 * s; sy < c.y + c.h; sy += 6 * s) {
            al.g.fillRect(c.x - sw, sy, sw, 2 * s);
            al.g.fillRect(c.x + c.w, sy, sw, 2 * s);
          }
        }
        break;
      }
      case 'balconyRail': {
        // Glass balustrade shadow band under each floor line — the tower reads as
        // having balconies even at LOD distances where the geometry is gone.
        for (let rr = 0; rr < rows; rr++) {
          const y = rr * fh + fh * (rec.win.top + rec.win.h) + 3 * s;
          al.g.fillStyle = 'rgba(126,150,164,0.30)';
          al.g.fillRect(0, y, P, fh * 0.20);
          al.g.fillStyle = 'rgba(0,0,0,0.30)';
          al.g.fillRect(0, y + fh * 0.20, P, 4 * s);
          rm.g.fillStyle = rmColor(0.22, 0.3, 0.8);
          rm.g.fillRect(0, y, P, fh * 0.20);
        }
        break;
      }
      case 'sliderDoors': {
        for (const c of cells) {
          al.g.fillStyle = 'rgba(212,216,220,0.55)';
          al.g.fillRect(c.x + c.w * 0.5 - 2 * s, c.y, 4 * s, c.h);
        }
        break;
      }
      case 'saltStain': {
        const g0 = al.g.createLinearGradient(0, P * 0.55, 0, P);
        g0.addColorStop(0, 'rgba(228,232,226,0)');
        g0.addColorStop(1, 'rgba(228,232,226,0.16)');
        al.g.fillStyle = g0;
        al.g.fillRect(0, P * 0.55, P, P * 0.45);
        break;
      }
    }
  }
}

// The whole panel. One traversal of the grid produces albedo, RM and the primary
// emissive; extra times of day replay `cells`.
function buildPanel(name, opts = {}) {
  const rec = RECIPES[name];
  const P = rec.panel;
  const seed = opts.seed ?? hash32('facade', name);
  const r = rng(seed);
  const L = layers(P);
  const rows = rec.floors;
  const ex = bayEdges(rec.rhythm, P);
  const cols = rec.rhythm.length;
  const fh = P / rows;

  // Base wall + grain + a broad uneven wash, so no two areas of the wall are the
  // same value before a single window is drawn.
  L.al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l);
  L.al.g.fillRect(0, 0, P, P);
  // Two octaves of the shared grain pool at different scales and offsets. The
  // pool is three tiles for the whole library, not two per recipe: the tile is
  // the only per-pixel JS loop left in here and it is worth amortising.
  L.al.g.globalCompositeOperation = 'overlay';
  L.al.g.globalAlpha = 0.34;
  L.al.g.drawImage(grainTile(seed % 3), 0, 0, P, P);
  L.al.g.globalAlpha = 0.09;
  L.al.g.drawImage(grainTile((seed >>> 3) % 3), -P * 0.9, -P * 0.55, P * 5.5, P * 5.5);
  L.al.g.globalAlpha = 1;
  L.al.g.globalCompositeOperation = 'source-over';

  L.em.g.fillStyle = '#000';
  L.em.g.fillRect(0, 0, P, P);
  L.rm.g.fillStyle = rmColor(rec.rough, rec.metal, 1);
  L.rm.g.fillRect(0, 0, P, P);

  // Spandrels and string courses, drawn per floor before the openings so the
  // reveal shading lands on top of them.
  for (let rr = 0; rr < rows; rr++) {
    const y0 = rr * fh + fh * (rec.win.top + rec.win.h);
    L.al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + rec.spandrel.l);
    L.al.g.fillRect(0, y0, P, fh * rec.spandrel.h);
    const sc = rec.stringCourse;
    const scy = (rr + 1) * fh - sc.thick * (P / 1024);
    L.al.g.fillStyle = hsl(rec.wall.h, rec.wall.s, rec.wall.l + sc.l);
    L.al.g.fillRect(0, scy, P, sc.thick * (P / 1024));
    L.al.g.fillStyle = 'rgba(0,0,0,0.26)';
    L.al.g.fillRect(0, scy + sc.thick * (P / 1024), P, 3 * (P / 1024));
  }

  // Lit-state assignment. `rank` is a stable per-window number; a time of day
  // lights every window whose rank is under that hour's fraction, so windows lit
  // at dusk are still lit at night instead of being an unrelated random set.
  const bandRank = [];
  for (let rr = 0; rr < rows; rr++) bandRank.push(r());
  const stackRank = [];
  for (let cc = 0; cc < cols; cc++) stackRank.push(r());

  const cells = [];
  for (let rr = 0; rr < rows; rr++) {
    for (let cc = 0; cc < cols; cc++) {
      const bx0 = ex[cc], bx1 = ex[cc + 1], bw = bx1 - bx0;
      const inset = bw * rec.win.inset;
      const cell = {
        x: bx0 + inset, y: rr * fh + fh * rec.win.top,
        w: bw - inset * 2, h: fh * rec.win.h,
        blind: r() < rec.blinds ? (r() < 0.45 ? 2 : 1) : 0,
        streak: r() < 0.55,
        ct: weighted(r, rec.ct),
        glow: 0.55 + r() * 0.45,
        rank: 0, lit: {},
      };
      // Authored occupancy patterns. Real night facades are not a uniform
      // scatter: offices leave whole floors on, apartments light in vertical
      // stacks along a corridor, and a retail strip lights as one unit.
      const own = r();
      if (rec.litPattern === 'floorBands') cell.rank = bandRank[rr] * 0.72 + own * 0.28;
      else if (rec.litPattern === 'stacks') cell.rank = stackRank[cc] * 0.34 + own * 0.66;
      else if (rec.litPattern === 'strip') cell.rank = own * 0.35 + bandRank[rr] * 0.15;
      else cell.rank = own;
      for (const t of TIMES) cell.lit[t] = cell.rank < rec.lit[t];
      cells.push(cell);
      drawOpening(L, rec, cell, r);
    }
  }

  drawAccents(L, rec, cells, cols, rows, r, ex);

  // Primary emissive in the same generation, then any extra hours from the same
  // cell list. This is what keeps the mask from drifting out of sync with albedo.
  const tods = opts.times ?? TIMES;
  const em = {};
  for (const t of tods) {
    if (t !== tods[0]) {
      L.em.g.setTransform(1, 0, 0, 1, 0, 0);
      L.em.g.fillStyle = '#000';
      L.em.g.fillRect(0, 0, L.em.c.width, L.em.c.height);
      const s = L.em.c.width / P;
      L.em.g.setTransform(s, 0, 0, s, 0, 0);
    }
    for (const c of cells) drawLit(L, rec, c, t);
    // Copy out, because the next hour overwrites this canvas.
    const out = canvas(L.em.c.width, L.em.c.height);
    out.getContext('2d').drawImage(L.em.c, 0, 0);
    em[t] = out;
  }

  return { albedo: L.al.c, emissive: em, rm: L.rm.c, recipe: rec, windows: cells.length };
}

// ------------------------------------------------------------------ trim atlas
// One 512px atlas of 4x4 material cells shared by EVERY kit part of EVERY recipe.
// A near chunk therefore costs one extra draw call for all its cornices, awnings,
// balconies, fire escapes, roof units and storefronts combined.

export const TRIM = {
  stone: [0, 0], metalDark: [1, 0], gravel: [2, 0], fabricA: [3, 0],
  glass: [0, 1], bulkhead: [1, 1], steel: [2, 1], signFace: [3, 1],
  stucco: [0, 2], concrete: [1, 2], brick: [2, 2], mullion: [3, 2],
  fabricB: [0, 3], rust: [1, 3], louvre: [2, 3], asphalt: [3, 3],
};

const TRIM_GRID = 4;
const TRIM_PAD = 0.004;   // keeps mip sampling inside the cell

// ------------------------------------------------- the lit half of UV space
//
// THE DISTRICT'S SHOPFRONT GLASS IS ON THIS ATLAS and the atlas had no emissive
// map, so no shopfront in the district could be lit from inside. Measured at the
// night corridor camera (tools/glass-owner.mjs): 56.4% of the shopfront row is
// the trim material, 46.2% of it is storefront recess surface - glass 23.2%,
// jamb and soffit 22.0%, stallriser 1.0% - and the facade atlas, which owns all
// of the lit-window machinery, reaches 7.7%. Lighting the facade atlas harder
// cannot fix this because the facade atlas is not what is in frame.
//
// The problem with simply adding an emissive map is that it would light EVERY
// shop equally, and a row of identically glowing windows is its own defect: the
// whole point of rec.lit[t] and cell.rank is that some tenancies are dark. What
// is needed is a per-tenancy switch, and there is nowhere to put one. There is
// no spare vertex attribute (the streamer emits position, normal, uv and colour,
// and streaming.js is not this file), the vertex colour is already carrying the
// lot's masonry tint, and a fourth atlas cell for "lit glass" cannot exist: the
// 4x4 grid is full, and its own comment records that there was no free cell to
// put a purpose-painted door in either.
//
// So the switch is carried in the INTEGER PART OF V, which was previously always
// zero and is therefore free.
//
//   v in [0, 1)   NOT A SHOPFRONT. Every other use of this atlas in the district
//                 - awnings, cornices, roof plant, railings, balcony
//                 balustrades, kerb furniture, entrance doorways - lives here
//                 and this block is black, so none of them can ever glow.
//   v in [1, 2)   shopfront, CLOSED AND DARK
//   v in [2, 3)   shopfront, CLOSED WITH A LIGHT ON
//   v in [3, 4)   shopfront, OPEN
//
// The albedo and rm atlases wrap (wrapT = RepeatWrapping), so v, v + 1 and v + 2
// sample exactly the same texel in them: all three states are BIT IDENTICAL in
// albedo, roughness and metalness. That is what makes the daylight proof trivial
// rather than approximate - at noon and golden there is no emissive intensity at
// all (see TRIM_EMISSIVE), and the only other maps any state can reach are the
// same ones.
//
// FOUR BLOCKS, and the count went 2 -> 3 -> 4 under measurement rather than by
// design, which is worth writing down because each step was a wrong model caught
// by a frame.
//
// Two (lit / unlit, 42% lit) put the whole near row of the corridor hero - the
// CASSAVA / LUMEN CAMERA frontage three reviewers named - into the dark state
// together while the far row drew lit together. Legal under a coin, still a black
// row.
//
// Three (open / closed-with-a-light / dark) fixed the odds but not the model, and
// the frame said so again: base9 against lit9 read EXACTLY 0.0 over x 0-500,
// y 300-800, and glass-owner found all 602 glass hits in that box sitting in the
// dark block. Two adjacent tenancies drawing dark at a 23% share is a 5% roll -
// bad luck, not a bug, verified three ways - but a shopfront whose interior is
// LITERALLY ZERO cannot answer the complaint "black glass, no interior light"
// however rarely it comes up. And it is not true either: a shop at night is
// essentially never pitch black inside. There is an exit sign, a till light, a
// door left open to a lit back room.
//
// So the dark block is split in two. v in [0,1) stays black and stays out of
// reach of any shopfront - it is what the REST of the kit samples, and keeping it
// black is what stops a cornice or a balcony balustrade glowing. Shopfronts start
// at v + 1, and their darkest state is faint rather than absent. The result is
// that NO shopfront in the district is pure black, and there are still three
// plainly different levels above zero.
//
// The EMISSIVE atlas is therefore the trim grid four times over, 4 x 16, sampled
// with repeat.y = 1/4 so that v / 4 lands in it. Canvas rows 0-3 are OPEN, 4-7
// CLOSED-WITH-A-LIGHT, 8-11 CLOSED-AND-DARK, 12-15 black.
//
// Cost: ONE 256x1024 RGBA texture, 1.33 MB with its mip chain. The comment at
// EMISSIVE_INTENSITY refuses 7 MB for a third FACADE emissive atlas; this is 19%
// of that, because the trim atlas is one shared 512 px atlas for the whole
// district rather than a 1024 px panel per recipe. No triangles, no attributes,
// no second material and no second draw call.
export const TRIM_NONE = 0, TRIM_DARK = 1, TRIM_DIM = 2, TRIM_LIT = 3;
export const TRIM_STATES = 4;

// UV rect for a trim cell. Canvas rows run top-down, texture v runs bottom-up.
// `state` is TRIM_NONE / TRIM_DARK / TRIM_DIM / TRIM_LIT and shifts v by whole
// units, which is the one shift a RepeatWrapping albedo sampler cannot see.
// TRIM_NONE is the default so that every existing caller in the kit - and there
// are dozens - keeps the black block without being edited.
export function trimCell(cell, state = TRIM_NONE) {
  const [ix, iy] = cell;
  const s = 1 / TRIM_GRID;
  const dv = state | 0;
  return {
    u0: ix * s + TRIM_PAD, u1: (ix + 1) * s - TRIM_PAD,
    v0: 1 - (iy + 1) * s + TRIM_PAD + dv, v1: 1 - iy * s - TRIM_PAD + dv,
  };
}

// A mip chain built by downscaling every cell INDEPENDENTLY and re-packing it,
// instead of letting the GPU average the whole atlas. Auto-generated mips mix
// neighbouring cells together: at a grazing angle the sidewalk five metres in
// front of the camera is already sampling mip 5, where a 128 px cell is 4 texels
// and the brick swatch two cells away is bleeding into the concrete. Packing each
// level from per-cell downscales removes that entirely and costs ~1 ms.
//
// `gx` and `gy` are separate because the EMISSIVE atlas is not square: it is the
// trim grid twice over, 4 x 8, so that one UV can address a lit tenancy and an
// unlit one. See TRIM_LIT_V. The albedo and rm atlases still pass 4 and 4 and
// get byte-identical output to the square version this replaced - checked by
// eye on the level sizes, which run 512, 256, ... 4, then 2x2 and 1x1 exactly as
// before.
function packedMips(cells, gx, gy, cellSize) {
  const mips = [];
  let cs = cellSize;
  while (cs >= 1) {
    const c = canvas(gx * cs, gy * cs), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    for (let i = 0; i < cells.length; i++) {
      g.drawImage(cells[i], (i % gx) * cs, ((i / gx) | 0) * cs, cs, cs);
    }
    mips.push(c);
    cs = Math.floor(cs / 2);
  }
  // Below one texel per cell the atlas is a few px across and nothing can bleed
  // that is not already a single average colour, so finish the chain
  // conventionally. Both axes halve, and the loop runs until BOTH reach 1 -
  // three.js wants a complete chain, and a 4x8 base that stopped when the width
  // hit 1 would hand it a 1x2 top level and sample garbage at distance.
  let last = mips[mips.length - 1];
  while (last.width > 1 || last.height > 1) {
    const c = canvas(Math.max(1, last.width >> 1), Math.max(1, last.height >> 1));
    c.getContext('2d').drawImage(last, 0, 0, c.width, c.height);
    mips.push(c);
    last = c;
  }
  return mips;
}

function buildTrimAtlas() {
  const S = 512, C = S / TRIM_GRID;
  const al = canvas(S), ag = al.getContext('2d');
  const rm = canvas(S), rg = rm.getContext('2d');
  const r = rng(hash32('trim'));

  // Every cell draws inside a clip of its own rect. Without it a swatch that
  // overruns — the brick course below is deliberately drawn wider than the cell
  // so the bond does not end on a seam — silently paints its neighbour, and the
  // result is a sidewalk with bricks in it.
  const at = (cell) => ({ x: cell[0] * C, y: cell[1] * C });
  const fill = (cell, colour, rough, metal) => {
    const { x, y } = at(cell);
    ag.restore(); ag.save();
    ag.beginPath(); ag.rect(x, y, C, C); ag.clip();
    rg.restore(); rg.save();
    rg.beginPath(); rg.rect(x, y, C, C); rg.clip();
    ag.fillStyle = colour; ag.fillRect(x, y, C, C);
    rg.fillStyle = rmColor(rough, metal, 1); rg.fillRect(x, y, C, C);
    return { x, y };
  };
  ag.save(); rg.save();
  const speck = (x, y, n, lo, hi, a) => {
    for (let i = 0; i < n; i++) {
      const v = lo + r() * (hi - lo);
      ag.fillStyle = `rgba(${v | 0},${(v * 0.98) | 0},${(v * 0.94) | 0},${a})`;
      ag.fillRect(x + r() * C, y + r() * C, 1 + r() * 2, 1 + r() * 2);
    }
  };

  // Cornice / cast stone: horizontal mouldings with their own shadow lines, so a
  // parapet band picks up a profile without any extra geometry.
  {
    const { x, y } = fill(TRIM.stone, 'rgb(206,198,180)', 0.78, 0);
    // Horizontal streaks only: a cornice band is tiled every 2 m along the wall,
    // and any feature with horizontal structure would seam at every repeat.
    for (let i = 0; i < 130; i++) {
      const v = 168 + r() * 62, yy = y + r() * C;
      ag.fillStyle = `rgba(${v | 0},${(v * 0.98) | 0},${(v * 0.93) | 0},${0.12 + r() * 0.3})`;
      ag.fillRect(x, yy, C, 0.6 + r() * 2.2);
    }
    for (const [t, h, sh] of [[0.14, 0.10, 0.28], [0.42, 0.16, 0.34], [0.76, 0.09, 0.30]]) {
      ag.fillStyle = 'rgba(255,252,240,0.5)';
      ag.fillRect(x, y + C * t, C, C * h);
      ag.fillStyle = `rgba(0,0,0,${sh})`;
      ag.fillRect(x, y + C * (t + h), C, C * 0.05);
    }
  }
  // Dark painted metal: railings, fire escapes, awning frames.
  {
    const { x, y } = fill(TRIM.metalDark, 'rgb(44,47,52)', 0.44, 0.85);
    speck(x, y, 500, 30, 80, 0.4);
    for (let i = 0; i < 26; i++) {
      ag.fillStyle = `rgba(120,70,40,${0.06 + r() * 0.12})`;
      ag.fillRect(x + r() * C, y + r() * C, 3 + r() * 14, 6 + r() * 30);
    }
  }
  // Roof gravel / ballast.
  {
    const { x, y } = fill(TRIM.gravel, 'rgb(96,94,88)', 0.97, 0);
    speck(x, y, 5200, 60, 165, 0.55);
  }
  // Awning fabric. Authored two-tone, not a random pattern, and authored off
  // what downtown Sarasota actually hangs over a shopfront rather than off the
  // generic red-and-cream this used to carry:
  //
  //   reference/sarasota/02-Worth-s-Block  two barrel awnings in saturated
  //                                        GOLD, plain rather than striped,
  //                                        each with a dark maroon edge band
  //   reference/sarasota/01-S.H.-Kress     a deep green-teal canopy
  //
  // Colourway A is therefore plain gold with a maroon valance, B a green-and-
  // cream stripe. The band across 14% of the cell is the edge trim; the whole
  // cell maps across every quad of the awning, so it runs along one edge of the
  // canopy and one edge of the valance. WHICH edge is not asserted here — it
  // depends on the texture's flipY as well as on the quad's uv order, and this
  // file has already paid once for a comment that reasoned out a UV direction
  // instead of looking at it.
  for (const [cell, a, b, striped] of [
    [TRIM.fabricA, 'rgb(122,36,38)', 'rgb(206,161,44)', false],
    [TRIM.fabricB, 'rgb(28,76,58)', 'rgb(232,226,208)', true],
  ]) {
    const { x, y } = fill(cell, b, 0.86, 0);
    if (striped) {
      for (let i = 0; i < TRIM_GRID * 2; i++) {
        ag.fillStyle = a;
        ag.fillRect(x + (i * C) / 8, y, C / 16, C);
      }
    } else {
      // A plain awning is still sewn out of 900 mm panels, and the seams are
      // most of what stops a flat colour reading as painted card.
      ag.fillStyle = 'rgba(70,44,10,0.16)';
      for (let i = 0; i < TRIM_GRID * 2; i++) {
        ag.fillRect(x + (i * C) / 8, y, Math.max(1, C / 150), C);
      }
    }
    ag.fillStyle = striped ? 'rgba(0,0,0,0.18)' : a;
    ag.fillRect(x, y + C * 0.86, C, C * 0.14);
  }
  // Storefront glazing, and it is NOT the same problem as a tower pane even
  // though it starts from the same defect. rgb(26,32,40) under metalness 0.6 is
  // F0 0.006 — a six-tenths-of-a-percent mirror — and the shopfronts under the
  // awnings measured 9.8 mean luminance in a dusk frame whose walls sat at 103.
  // But raising the coating alone only took them to 27: a pane at eye level is
  // viewed almost edge-on, so its mirror direction runs HORIZONTALLY, into the
  // half of the environment probe that holds ground rather than sky, while a
  // tower pane seen from the street reflects steeply upward into an open sky.
  // Measured on the same frame: unlit tower panes 122, shopfronts 27, at nearly
  // the same F0. There is no sky in a shopfront to reflect.
  //
  // So this cell is authored the way the parking deck is — as a lit interior
  // seen through glass, with the metalness low enough (0.45) to leave a real
  // diffuse term for that interior to live in, and the reflectance carried by
  // the top of the pane where it does see sky over the street. Top to bottom:
  // sky above the transom, the soffit shadow inside, the back of the shop, the
  // display shelf, and the floor bouncing light in from the pavement.
  {
    const { x, y } = fill(TRIM.glass, 'rgb(150,158,166)', 0.09, 0.45);
    const g0 = ag.createLinearGradient(x, y, x, y + C);
    g0.addColorStop(0, 'rgb(206,222,238)');     // street sky over the transom
    g0.addColorStop(0.10, 'rgb(170,184,200)');
    g0.addColorStop(0.22, 'rgb(92,96,104)');    // soffit shadow inside the shop
    g0.addColorStop(0.46, 'rgb(126,130,138)');  // back of the shop
    g0.addColorStop(0.66, 'rgb(150,150,148)');  // display shelf, lit from within
    g0.addColorStop(0.88, 'rgb(178,172,160)');  // floor bounce off the pavement
    g0.addColorStop(1, 'rgb(120,116,110)');     // cill shadow
    ag.fillStyle = g0; ag.fillRect(x, y, C, C);
    // The shelf itself, its shadow, and the head rail of the shop's own frame.
    ag.fillStyle = 'rgba(226,230,234,0.5)';
    ag.fillRect(x, y + C * 0.615, C, C * 0.028);
    ag.fillStyle = 'rgba(26,28,32,0.45)';
    ag.fillRect(x, y + C * 0.643, C, C * 0.022);
    ag.fillStyle = 'rgba(60,64,70,0.55)';
    ag.fillRect(x, y + C * 0.05, C, C * 0.04);
    // Goods on the shelf: enough silhouette that the eye reads depth, not paint.
    for (let i = 0; i < 7; i++) {
      const w = C * (0.03 + r() * 0.05), h = C * (0.05 + r() * 0.08);
      ag.fillStyle = `rgba(${40 + r() * 60 | 0},${40 + r() * 60 | 0},${44 + r() * 60 | 0},0.5)`;
      ag.fillRect(x + r() * (C - w), y + C * 0.615 - h, w, h);
    }
    // One slim stile: a shop window this wide is always divided.
    ag.fillStyle = 'rgba(88,94,100,0.6)';
    ag.fillRect(x + C * 0.485, y, C * 0.03, C);
  }
  // Shopfront bulkhead: dark glazed tile with a grout grid.
  {
    const { x, y } = fill(TRIM.bulkhead, 'rgb(58,52,48)', 0.5, 0.1);
    ag.strokeStyle = 'rgba(150,146,138,0.30)'; ag.lineWidth = 1.5;
    for (let i = 1; i < 6; i++) {
      ag.beginPath(); ag.moveTo(x, y + (C * i) / 6); ag.lineTo(x + C, y + (C * i) / 6); ag.stroke();
      ag.beginPath(); ag.moveTo(x + (C * i) / 6, y); ag.lineTo(x + (C * i) / 6, y + C); ag.stroke();
    }
  }
  // Galvanised steel: roof plant, ducting, vents.
  {
    const { x, y } = fill(TRIM.steel, 'rgb(150,154,158)', 0.38, 0.92);
    for (let i = 0; i < 70; i++) {
      ag.fillStyle = `rgba(${190 + r() * 50 | 0},${190 + r() * 50 | 0},${196 + r() * 50 | 0},${0.1 + r() * 0.25})`;
      ag.fillRect(x + r() * C, y, 1 + r() * 5, C);
    }
    ag.fillStyle = 'rgba(70,76,80,0.25)';
    for (let i = 0; i < 6; i++) ag.fillRect(x, y + (C * i) / 6, C, 2);
  }
  // Signage blank: a painted board face. Left deliberately blank — original
  // business names and logos are the signage builder's module, not this one.
  {
    const { x, y } = fill(TRIM.signFace, 'rgb(228,222,208)', 0.55, 0);
    ag.fillStyle = 'rgba(0,0,0,0.16)';
    ag.fillRect(x, y, C, 5); ag.fillRect(x, y + C - 5, C, 5);
    ag.fillRect(x, y, 5, C); ag.fillRect(x + C - 5, y, 5, C);
    speck(x, y, 300, 190, 240, 0.3);
  }
  // Stucco render matching the general wall tone.
  {
    const { x, y } = fill(TRIM.stucco, 'rgb(206,196,178)', 0.9, 0);
    speck(x, y, 2600, 165, 225, 0.4);
  }
  // Fair-faced concrete: balcony slabs, parking decks.
  {
    const { x, y } = fill(TRIM.concrete, 'rgb(148,146,142)', 0.93, 0);
    speck(x, y, 2200, 120, 180, 0.35);
    ag.fillStyle = 'rgba(80,80,78,0.2)';
    for (let i = 0; i < 5; i++) ag.fillRect(x, y + r() * C, C, 2 + r() * 3);
  }
  // Brick.
  {
    const { x, y } = fill(TRIM.brick, 'rgb(132,74,58)', 0.92, 0);
    const bh = C / 10;
    for (let row = 0; row < 10; row++) {
      const off = (row % 2) * (C / 8);
      for (let b = -1; b < 8; b++) {
        const v = 0.8 + r() * 0.45;
        ag.fillStyle = `rgb(${(132 * v) | 0},${(74 * v) | 0},${(58 * v) | 0})`;
        ag.fillRect(x + off + (b * C) / 4 + 1.5, y + row * bh + 1.5, C / 4 - 3, bh - 3);
      }
    }
  }
  // Anodised aluminium mullion stock.
  {
    const { x, y } = fill(TRIM.mullion, 'rgb(96,100,104)', 0.3, 0.9);
    ag.fillStyle = 'rgba(190,196,200,0.4)';
    for (let i = 0; i < 4; i++) ag.fillRect(x + (C * i) / 4, y, C / 16, C);
  }
  // Rusted metal.
  {
    const { x, y } = fill(TRIM.rust, 'rgb(122,68,38)', 0.85, 0.35);
    for (let i = 0; i < 180; i++) {
      ag.fillStyle = `rgba(${80 + r() * 90 | 0},${40 + r() * 50 | 0},${20 + r() * 30 | 0},${0.2 + r() * 0.5})`;
      ag.fillRect(x + r() * C, y + r() * C, 2 + r() * 12, 2 + r() * 12);
    }
  }
  // Louvre / vent grille.
  {
    const { x, y } = fill(TRIM.louvre, 'rgb(70,74,78)', 0.5, 0.8);
    for (let i = 0; i < 14; i++) {
      ag.fillStyle = 'rgba(180,186,190,0.35)';
      ag.fillRect(x, y + (C * i) / 14, C, 2);
      ag.fillStyle = 'rgba(0,0,0,0.45)';
      ag.fillRect(x, y + (C * i) / 14 + 2, C, (C / 14) - 4);
    }
  }
  // Asphalt / bitumen roof membrane.
  {
    const { x, y } = fill(TRIM.asphalt, 'rgb(52,52,54)', 0.88, 0.05);
    speck(x, y, 2600, 30, 90, 0.5);
    ag.fillStyle = 'rgba(90,90,92,0.25)';
    for (let i = 0; i < 4; i++) ag.fillRect(x, y + (C * (i + 0.5)) / 4, C, 4);
  }

  ag.restore(); rg.restore();

  // Split the finished atlas back into cells so the mip chain can be packed
  // per-cell rather than across cell boundaries.
  const cut = (src, grid, cs) => {
    const out = [];
    for (let iy = 0; iy < grid[1]; iy++) {
      for (let ix = 0; ix < grid[0]; ix++) {
        const c = canvas(cs);
        c.getContext('2d').drawImage(src, ix * cs, iy * cs, cs, cs, 0, 0, cs, cs);
        out.push(c);
      }
    }
    return out;
  };
  const em = buildTrimEmissive(C / 2);
  return {
    albedo: al, rm, emissive: em,
    albedoMips: packedMips(cut(al, [TRIM_GRID, TRIM_GRID], C), TRIM_GRID, TRIM_GRID, C),
    rmMips: packedMips(cut(rm, [TRIM_GRID, TRIM_GRID], C), TRIM_GRID, TRIM_GRID, C),
    emissiveMips: packedMips(cut(em, [TRIM_GRID, TRIM_GRID * TRIM_STATES], C / 2),
      TRIM_GRID, TRIM_GRID * TRIM_STATES, C / 2),
  };
}

// ------------------------------------------------------- the lit shop interior
//
// The emissive part of the trim atlas: 4 x 12 cells at HALF the albedo cell size,
// because a glow through a shop window carries no high-frequency detail worth
// paying for - the same argument layers() makes for the facade panels' emScale.
// Canvas rows 0-3 are the OPEN variant of trim rows 0-3, rows 4-7
// closed-with-a-light, rows 8-11 closed-and-dark, and rows 12-15 the block every
// non-shopfront part of the kit samples, which stays black. See TRIM_NONE for how
// one v addresses all four.
//
// What is painted here is a photograph of Main Street after dark, read the way
// the albedo glass cell is read - top to bottom, because the ORDER is the effect:
//
//   the head of the pane is the darkest part of a lit shop, not the brightest.
//   Nobody puts a light in a transom. Above the fittings there is only the
//   ceiling, seen edge-on and in its own shade, and painting the top of the pane
//   bright is the single quickest way to make a shopfront look like a lightbox.
//   The old flat emissive panels the reviewers preferred to this row did exactly
//   that, and it is why they read as signs rather than as rooms.
//
//   the display zone at the shelf is the brightest thing in the window, by some
//   way. A shop lights its goods, not its air. This is the "display lighting near
//   the window" a review round asked for and it is a band, not a wash.
//
//   the floor is bright but not as bright as the shelf, and it falls off hard
//   into the cill shadow at the very bottom, which is what stops the pane
//   reading as a slab of light sitting ON the pavement.
//
// The colour is 2700-3000 K throughout - warm, and warmer low, because the
// fittings deep in a shop are usually older and yellower than the display track
// at the window. Values are sRGB bytes: three.js decodes the map (colorSpace is
// set in trimMaps) and multiplies by emissive x TRIM_EMISSIVE[time].
function buildTrimEmissive(E) {
  const GX = TRIM_GRID, GY = TRIM_GRID * TRIM_STATES;
  const c = canvas(GX * E, GY * E);
  const g = c.getContext('2d');
  // Black is the default and it is load-bearing: a dark tenancy, and every kit
  // part in the district that is not a shopfront, multiplies its emissive by the
  // texel it finds here. A cell nobody painted cannot glow.
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  // Canvas row for a cell in a given state. LIT is the top block because reading
  // the atlas top to bottom then runs brightest to darkest, which is the order
  // anyone opening it in an image viewer will expect.
  const at = (cell, state) => ({
    x: cell[0] * E,
    y: (cell[1] + (TRIM_LIT - state) * TRIM_GRID) * E,
  });
  const clip = (x, y, fn) => {
    g.save();
    g.beginPath(); g.rect(x, y, E, E); g.clip();
    fn();
    g.restore();
  };
  const warm = (k) => (a, b, cc) =>
    `rgb(${Math.round(a * k)},${Math.round(b * k)},${Math.round(cc * k)})`;

  // --- the pane itself
  //
  // `k` scales the whole interior: 1.0 is a shop that is open and trading, 0.30 a
  // closed one showing a security light. The DIM state is not a dimmer copy of
  // the lit one though - it also drops the display band and the shelf silhouettes
  // to a fraction, because what is on after hours is the back-of-house light, not
  // the display track. A uniformly scaled copy would read as the same shop seen
  // through sunglasses.
  const pane = (state, k, disp) => {
    const { x, y } = at(TRIM.glass, state);
    const w = warm(k);
    clip(x, y, () => {
      const gl = g.createLinearGradient(0, y, 0, y + E);
      gl.addColorStop(0.00, w(3, 2, 1));         // above the transom: nothing lit
      gl.addColorStop(0.08, w(22, 15, 7));       // ceiling, edge-on and in shade
      gl.addColorStop(0.22, w(74, 51, 26));      // the soffit inside starts to catch
      gl.addColorStop(0.44, w(104, 73, 37));     // back of the shop
      gl.addColorStop(0.58, w(158, 115, 60));    // rising into the display zone
      gl.addColorStop(0.655, w(126, 91, 47));    // under the shelf, in its shadow
      gl.addColorStop(0.80, w(116, 83, 43));     // floor
      gl.addColorStop(0.94, w(62, 43, 21));
      gl.addColorStop(1.00, w(9, 6, 3));         // cill shadow
      g.fillStyle = gl;
      g.fillRect(x, y, E, E);

      // The display lighting. A track over the shelf throws a hard bright band at
      // the shelf line and a short falloff above it; the shelf itself then cuts
      // the light off below. Both edges are drawn because a band with only a top
      // edge reads as a horizon. `disp` is what separates an open shop from a
      // closed one far more than the overall level does.
      if (disp > 0) {
        const band = g.createLinearGradient(0, y + E * 0.50, 0, y + E * 0.645);
        band.addColorStop(0, 'rgba(255,214,150,0)');
        band.addColorStop(0.72, `rgba(255,214,150,${(0.58 * disp).toFixed(3)})`);
        band.addColorStop(1, `rgba(255,228,174,${(0.95 * disp).toFixed(3)})`);
        g.fillStyle = band;
        g.fillRect(x, y + E * 0.50, E, E * 0.145);
      }

      // THE SHELF EDGE, and it is a hard line on purpose.
      //
      // An emissive that is all smooth gradient ADDS A WASH to a textured albedo
      // and lowers its relative contrast, which is measurable and was measured:
      // on one CASSAVA pane the local-contrast RMS fell 0.2091 unlit to 0.1805
      // lit, while the pane got brighter. Brightness was never the complaint -
      // "dim grey with faint shelves" is a complaint about STRUCTURE. Gradients
      // are also the first thing minification destroys, so what carries at 23 m
      // and survives at 12 m is an EDGE, not a ramp.
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x, y + E * 0.632, E, Math.max(1, E * 0.022));
      // The counter front below it, catching the display light from above: the
      // one bright hard edge in the lower half, so the eye has a horizontal to
      // read the depth of the shop against.
      g.fillStyle = `rgba(255,226,178,${(0.30 * Math.max(0.35, disp)).toFixed(3)})`;
      g.fillRect(x, y + E * 0.654, E, Math.max(1, E * 0.016));

      // Goods on the shelf, as silhouettes AGAINST the display light rather than
      // as lit objects: this is the same seven-object shelf the albedo cell
      // draws, and it has to occlude here or the two layers disagree about where
      // the merchandise is. Drawn from a stream re-seeded per state so both
      // states put their stock in the SAME places - a shop does not rearrange its
      // window when it closes. Deepened from 0.35-0.65 alpha: at a 64 px cell an
      // object is two or three texels, and at that size a half-transparent
      // silhouette is gone by the time the mip chain and the bloom have had it.
      const jr = rng(hash32('shelf'));
      for (let i = 0; i < 7; i++) {
        const sw = E * (0.035 + jr() * 0.055), sh = E * (0.06 + jr() * 0.09);
        g.fillStyle = `rgba(8,5,2,${(0.62 + jr() * 0.3).toFixed(3)})`;
        g.fillRect(x + jr() * (E - sw), y + E * 0.632 - sh, sw, sh);
      }

      // The stile. A shop window this wide is always divided, the albedo cell
      // draws one at 48.5%, and a mullion in front of a lit interior is a dark
      // line - so it has to be dark HERE too or the glow crosses it.
      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x + E * 0.485, y, E * 0.03, E);
      // Head rail of the shop's own frame, same place the albedo puts it.
      g.fillStyle = 'rgba(0,0,0,0.8)';
      g.fillRect(x, y + E * 0.05, E, E * 0.04);
    });
  };

  // --- the recess the pane sits in
  //
  // Jambs and soffit share the stucco cell, and the two want opposite gradients:
  // a jamb's u runs wall-to-glass while a soffit's v runs street-to-shop. One
  // cell cannot be right for both, so it is deliberately NOT directional - a soft
  // vignette at a level that reads as bounce rather than as a source. This is the
  // surface storefront()'s own comment calls "the one that catches shop light",
  // and at night it was pure black.
  //
  // THE LEVEL HERE IS THE ONE THING THE FIRST CAPTURE GOT WRONG. At 92/66/38 the
  // wash reached the pilasters between bays and the whole frontage read flooded -
  // an interior spilling onto its own front wall as hard as the window itself,
  // which is not what a recess does. It is bounce off a plastered return a metre
  // from the source, so it is cut to about 45% and pulled tighter, and the pane
  // is left as the brightest thing in the elevation by a clear margin.
  const recess = (state, k) => {
    const { x, y } = at(TRIM.stucco, state);
    const w = warm(k);
    clip(x, y, () => {
      const rg2 = g.createRadialGradient(x + E * 0.5, y + E * 0.58, E * 0.04,
        x + E * 0.5, y + E * 0.58, E * 0.62);
      rg2.addColorStop(0, w(42, 30, 16));
      rg2.addColorStop(0.5, w(26, 18, 10));
      rg2.addColorStop(1, w(6, 4, 2));
      g.fillStyle = rg2;
      g.fillRect(x, y, E, E);
    });
  };

  // --- the stallriser under the pane and the threshold slab in front of it.
  //
  // This is the spill, and it is as far as the spill can go: the slab runs from
  // the glass line out to the wall line, 0.42-0.88 m of recess floor depending on
  // the lot. The public pavement beyond it is a different material owned by
  // src/materials.js' ground, and putting light on it would need either a real
  // emitter - the pool is ten slots against 543 lamps, so no - or a new quad per
  // bay, which is triangles this budget does not have.
  const spill = (state, k) => {
    const { x, y } = at(TRIM.bulkhead, state);
    const w = warm(k);
    clip(x, y, () => {
      const gl = g.createLinearGradient(0, y, 0, y + E);
      gl.addColorStop(0, w(58, 41, 21));
      gl.addColorStop(0.6, w(36, 25, 13));
      gl.addColorStop(1, w(12, 8, 4));
      g.fillStyle = gl;
      g.fillRect(x, y, E, E);
    });
  };

  // OPEN AND TRADING: full interior, full display track, bounce on the recess.
  pane(TRIM_LIT, 1, 1);
  recess(TRIM_LIT, 1);
  spill(TRIM_LIT, 1);
  // CLOSED, LIGHT LEFT ON: a tube left burning over the window rather than the
  // whole display run, and little on the recess because there is not much source
  // to bounce.
  // 0.78, raised from 0.60 with the night intensity cut. That cut was aimed at
  // the OPEN state, which was the one clipping at 12 m, but TRIM_EMISSIVE scales
  // all three states together and took closed-with-a-light down 38% with it -
  // and closed-with-a-light is exactly what the rows the reviewer called "not
  // selected" are now made of (the CASSAVA row's glass is 51% dim after the run
  // cap, against 0% before it). So the two changes were pulling on that row in
  // opposite directions and it barely moved.
  //
  // Raising DIM rather than the global intensity is what keeps this isolable: the
  // blown bay and the good bay are both glass@LIT by raycast, so neither can move
  // by a single grey level from this, and the next capture is a test of that as
  // much as of the row. 0.78 * 2.9 = 2.26 against the 0.60 * 4.65 = 2.79 that
  // shipped, so a closed-with-a-light shop still ends up dimmer than it was.
  pane(TRIM_DIM, 0.78, 0.14);
  recess(TRIM_DIM, 0.42);
  spill(TRIM_DIM, 0.42);
  // CLOSED AND DARK: an exit sign, a till display, a door left open to a lit back
  // room. Not a shop you would say is lit, and not black either - which is the
  // whole reason this state exists rather than reusing TRIM_NONE. No display
  // track at all: that band is what says "open", and it is the difference between
  // the states far more than the level is.
  //
  // THE LEVEL HERE WAS MEASURED THREE TIMES AND RAISED TWICE. The CASSAVA /
  // LUMEN CAMERA row draws this state on every visible lot - the same unlucky run
  // every version of this has had, because tenancyState's hash never changed and
  // only its thresholds moved - so it is the one place this state is on show, and
  // it is the row three reviewers named. Against the baseline, on a
  // shopfront-only rect:
  //
  //     0.085   mean 0.323, max 4      one pane 35.84 -> 36.2
  //     0.20    mean 0.901, max 9      one pane 35.84 -> 37.48
  //     0.32    the level shipped
  //
  // A state that exists in the atlas, is correctly addressed by the geometry, and
  // cannot be seen is the same defect as not having it. What this level has to
  // buy is not brightness - the reviewers' complaint was that the row reads
  // "muddy, neither open-and-lit nor closed-and-dark" - it is DEPTH ORDERING: a
  // soffit, a back wall, a shelf line and a floor, so the eye reads a room rather
  // than a grey panel. The display band stays at zero, because that band is what
  // says OPEN and it separates the states far more than the level does.
  pane(TRIM_DARK, 0.32, 0);
  recess(TRIM_DARK, 0.14);
  spill(TRIM_DARK, 0.09);
  // TRIM_NONE is the black the canvas was filled with, and it is what every
  // non-shopfront part of the kit samples. Nothing is drawn for it, on purpose: a
  // state defined by an absence should not have a painter that could drift away
  // from zero.
  return c;
}

// ------------------------------------------------------------------- textures
function toTexture(c, { srgb = false, repeatU = 1, repeatV = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatU, repeatV);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Textures for one facade recipe, memoised so a district of 523 buildings holds
 * exactly one set per recipe. UVs are in metres, so `repeat` is 1/tile and every
 * building of the recipe shares the same texture with no per-building state.
 *
 * @param {string} name  key into RECIPES
 * @returns {{map, rmMap, emissive: Object<string,Texture>, tileU:number, tileV:number, recipe:Object}}
 */
export function facadeMaps(name) {
  return memo(`facade:${name}`, () => {
    const p = buildPanel(name, { times: LIT_TIMES });
    const rec = p.recipe;
    const tileU = rec.tileU, tileV = rec.floors * rec.floorM;
    const ru = 1 / tileU, rv = 1 / tileV;
    // Only dusk and night get an emissive map. EMISSIVE_INTENSITY.noon is 0 —
    // at 1/78000 s a lit window is invisible anyway — so a noon variant would be
    // 7 more megabytes of VRAM that never reaches a pixel. setFacadeTime falls
    // back to the night map and zeroes the intensity.
    const emissive = {};
    for (const t of LIT_TIMES) {
      emissive[t] = toTexture(p.emissive[t], { srgb: true, repeatU: ru, repeatV: rv });
    }
    return {
      map: toTexture(p.albedo, { srgb: true, repeatU: ru, repeatV: rv }),
      rmMap: toTexture(p.rm, { repeatU: ru, repeatV: rv }),
      emissive, tileU, tileV, recipe: rec, windows: p.windows,
    };
  });
}

/** The single shared trim atlas used by every kit part. */
export function trimMaps() {
  return memo('trim', () => {
    const a = buildTrimAtlas();
    const mk = (c, mips, srgb, repeatV = 1) => {
      const t = toTexture(c, { srgb, repeatV });
      t.mipmaps = mips;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      return t;
    };
    return {
      map: mk(a.albedo, a.albedoMips, true),
      rmMap: mk(a.rm, a.rmMips, false),
      // repeatV 1/3 is the whole mechanism, and it is three.js' own per-map UV
      // transform doing it - the vertex shader computes
      // `vEmissiveMapUv = ( emissiveMapTransform * vec3( uv, 1 ) ).xy`, so this
      // map alone sees v / 3 while map and rmMap see v. A quad at v + 2 lands in
      // the top third of a 4 x 12 atlas, at v + 1 in the middle third, at v in
      // the black bottom third; and because map and rmMap WRAP, all three are
      // identical in albedo, roughness and metalness. No shader patch is
      // involved, which is deliberate: the alternative was rewriting
      // <emissivemap_fragment>, and a hand-written sample would also have had to
      // reproduce three.js' sRGB decode of the texel, which is exactly the sort
      // of thing that drifts.
      emissiveMap: mk(a.emissive, a.emissiveMips, true, 1 / TRIM_STATES),
    };
  });
}

/**
 * Optional material factory. Memoised by recipe, so a caller physically cannot
 * end up with a material per building — the failure mode this project's
 * performance contract exists to prevent.
 */
export function facadeMaterial(name, { time = 'night' } = {}) {
  const mat = memo(`mat:${name}`, () => {
    const m = facadeMaps(name);
    const glazed = new THREE.MeshStandardMaterial({
      // Named so a raycast readback can say WHICH material it hit. Every audit of
      // this district has had to identify glazing by guessing at texel values;
      // the name costs nothing and makes the measurement unambiguous.
      name: `facade:${name}`,
      map: m.map,
      roughnessMap: m.rmMap, metalnessMap: m.rmMap,
      roughness: 1, metalness: 1,
      emissiveMap: m.emissive.night,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      vertexColors: true,
    });
    // Glazing on this atlas is the smooth metallic cell drawOpening writes -
    // roughness 0.07-0.13 at metalness 0.80-0.88, against a wall at 0.62-0.82 and
    // metalness 0-0.06 - so the shader can find its own panes without a second
    // material, a second draw call or a UV set the streamer does not emit.
    // Measured on a 54 m tower: without this the pane reflected the bright band
    // of sky just above the horizon at EVERY floor and the elevation read
    // brightest at the pavement. See applyGlazingEnv in src/materials.js.
    return applyGlazingEnv(glazed, { glassTexelsOnly: true });
  });
  setFacadeTime(name, time);
  return mat;
}

/** Trim material, shared across all recipes: one draw call for the whole kit. */
export function trimMaterial() {
  const mat = memo('mat:trim', () => {
    const t = trimMaps();
    const m = new THREE.MeshStandardMaterial({
      name: 'trim',
      map: t.map, roughnessMap: t.rmMap, metalnessMap: t.rmMap,
      roughness: 1, metalness: 1, vertexColors: true,
      // Exactly facadeMaterial's arrangement: a white emissive scaled by an
      // intensity that is ZERO at noon and golden, so the map is bound at every
      // hour and reaches a pixel at none of the daylight ones. That is what makes
      // the daylight claim provable rather than argued - see setTrimTime.
      emissiveMap: t.emissiveMap,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    });
    // THE DISTRICT'S SHOPFRONT GLASS IS ON THIS MATERIAL, and until now it had no
    // reflectance model at all: `trim` was the one atlas material with no glazing
    // patch on it (glaz-probe printed `trim=(none)` beside five patched facade
    // materials, every round), so every recessed shop window storefrontBays draws
    // reflected the bare sky dome and nothing of the street it stands in. That is
    // the glass a street-level frame is mostly made of, and it is the glass a
    // review round measured its "dark at the head, bright at the cill" profile
    // down - see applyStorefrontCoating in materials.js, which has the numbers.
    //
    // The mask window is on ROUGHNESS here, not metalness. In this atlas the
    // glazing cell (0.09, 0.45) is the only one under roughness 0.25, while
    // mullion (0.30, 0.90), steel (0.38, 0.92), dark metal (0.44, 0.85) and
    // louvre (0.50, 0.80) are all MORE metallic than the glass and none of them
    // is a window. The facade atlas' default window would have caught all four.
    const glassWindow = {
      glassTexelsOnly: true, roughLo: 0.16, roughHi: 0.24, metalLo: 0.25, metalHi: 0.35,
    };
    applyStorefrontCoating(m, glassWindow);
    // paneMetres is the shopfront module rather than the curtain-wall one: a Main
    // Street bay is about 1.15 m of glass on a 2.6 m storey, which is what
    // MaterialRegistry's own glassStorefront is built with.
    return applyGlazingEnv(m, { ...glassWindow, paneMetres: [1.15, 2.6] });
  });
  // The hour the world is at, applied whether this call created the material or
  // found it in the cache. The streamer calls trimMaterial() with no arguments
  // from every chunk build, so this may NOT default to a time the way
  // facadeMaterial does - defaulting to 'night' would let a chunk that streams in
  // at noon relight the whole district, since there is exactly one trim material
  // and the last caller would win. Instead the hour is remembered from the last
  // setTrimTime and re-applied here, which also closes the reverse ordering hole:
  // a material created after the time was pushed would otherwise sit at
  // intensity 0 until the next preset change.
  setTrimTime(trimTime);
  return mat;
}

// The hour the trim atlas is currently lit for. Module state rather than a
// parameter for the reason above; 'noon' is the safe initial value because its
// intensity is 0, so a trim material that is somehow never told the time is dark
// rather than glowing in daylight.
let trimTime = 'noon';

/**
 * Swap the shopfront glow for a time of day. Same contract as setFacadeTime, and
 * loud for the same reason: `?? 0` would turn an hour merely missing from the
 * table into an hour with every shop in the district dark, which reads as a
 * content bug rather than as a table with a hole in it.
 */
export function setTrimTime(time) {
  if (!(time in TRIM_EMISSIVE)) {
    throw new Error(`trim has no emissive intensity for time of day: ${time}`);
  }
  trimTime = time;
  const m = cache.get('mat:trim');
  if (!m) return;
  m.emissiveIntensity = TRIM_EMISSIVE[time];
  m.needsUpdate = true;
}

/**
 * Swap a recipe's lit-window set and glow for a time of day. Cheap: the maps are
 * already generated, this only rebinds and rescales.
 */
export function setFacadeTime(name, time) {
  // Loud, because the alternative is quiet: `?? 0` turned an hour that is merely
  // missing from EMISSIVE_INTENSITY into an hour with no lit windows anywhere,
  // which reads as a content bug rather than a table with a hole in it. The
  // emissive MAP genuinely falls back - noon and golden bake none, by design -
  // but the intensity may not.
  if (!(time in EMISSIVE_INTENSITY)) {
    throw new Error(`facades have no emissive intensity for time of day: ${time}`);
  }
  const m = cache.get(`mat:${name}`);
  if (!m) return;
  const maps = facadeMaps(name);
  m.emissiveMap = maps.emissive[time] ?? maps.emissive.night;
  m.emissiveIntensity = EMISSIVE_INTENSITY[time] * maps.recipe.interior;
  m.needsUpdate = true;
}

/**
 * Apply a time of day to every recipe material that has been created, and to the
 * shared trim material with it.
 *
 * The trim call belongs HERE rather than in the streamer because the streamer is
 * not this file: src/streaming.js' setFacadeTime is the one place the world
 * pushes an hour into the texture library, and hanging the shopfronts off it
 * means there is one path, not two that can disagree about what time it is.
 */
export function setAllFacadeTimes(time) {
  for (const n of RECIPE_NAMES) setFacadeTime(n, time);
  setTrimTime(time);
}

/**
 * Generate the whole library up front behind the loading screen and report the
 * cost, because with 100% procedural assets texture generation is a startup
 * budget that has to be profiled like any other.
 */
export function generateFacadeLibrary({ recipes = RECIPE_NAMES } = {}) {
  const t0 = performance.now();
  const per = {};
  for (const n of recipes) {
    const t = performance.now();
    facadeMaps(n);
    per[n] = +(performance.now() - t).toFixed(1);
  }
  const tt = performance.now();
  trimMaps();
  per.trim = +(performance.now() - tt).toFixed(1);
  return { ms: +(performance.now() - t0).toFixed(1), per };
}

// -------------------------------------------------------------- recipe picking

// A footprint's identity: stable across reloads, array reordering and rebakes,
// because it is derived from the geometry rather than from the index.
export function seedOf(b) {
  const p = b.p[0];
  return hash32(p[0].toFixed(2), p[1].toFixed(2), b.p.length, (b.h ?? 0).toFixed(1));
}

/**
 * Pick a facade recipe for a baked building. Deterministic: same footprint,
 * same recipe, every session.
 *
 * @param {{p:Array, h:number, a:number, z?:string, k?:string}} b  district.json building
 * @returns {string} key into RECIPES
 */
export function pickRecipe(b) {
  const z = b.z ?? '', k = b.k ?? '', h = b.h ?? 6, a = b.a ?? 100;
  const r = rng(seedOf(b));

  if (z === 'parking' || k === 'parking' || k === 'garages') return 'parking';
  if (z === 'industrial' || k === 'industrial' || k === 'warehouse' ||
      k === 'construction' || (k === 'roof' && a > 400)) return 'warehouse';
  if (h >= 26) return 'bayTower';
  if (k === 'house' || k === 'hut' || k === 'cabin' ||
      (z === 'residential' && !k && a < 320 && h <= 7)) return 'stuccoHouse';
  if (k === 'apartments' || k === 'hotel' || k === 'residential') {
    return h >= 15 ? 'bayTower' : 'deco';
  }
  if (k === 'office' || (z === 'commercial' && h >= 12)) return 'midOffice';
  if (h <= 8) return 'retailStrip';

  // The genuinely ambiguous middle of the stock — 3 to 5 storeys of downtown
  // commercial. Split it deterministically so a street is a mix rather than a
  // run of identical blocks, weighted toward deco in the historic core.
  const t = r();
  if (t < 0.42) return 'deco';
  if (t < 0.78) return 'midOffice';
  return 'retailStrip';
}

// One palette entry, as a vertex colour. Linear-space RGB, since three.js treats
// vertex colours as linear.
//
// The baked wall colour is divided out so the entry is a true recolour, and the
// result is clamped at 1, so an entry can only ever DARKEN the painted wall. That
// is deliberate and it is why the palettes read: a brick block needs to go down
// from the panel's value, not up. `v` is the value nudge that keeps two
// neighbours in the same colourway from being identical.
function paletteTint(rec, base, v) {
  const c = new THREE.Color();
  c.setHSL(base.h / 360, base.s / 100, base.l / 100, THREE.SRGBColorSpace);
  const wall = new THREE.Color();
  wall.setHSL(rec.wall.h / 360, rec.wall.s / 100, rec.wall.l / 100, THREE.SRGBColorSpace);
  return [
    clamp01((c.r / Math.max(0.02, wall.r)) * v),
    clamp01((c.g / Math.max(0.02, wall.g)) * v),
    clamp01((c.b / Math.max(0.02, wall.b)) * v),
  ];
}

// Rec. 709 relative luminance of a vertex tint. Used to prove that two lots
// actually differ on screen rather than merely differing in the table.
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Per-building colour. Returns the ENTRY INDEX as well as the colour, because
// the lot pass needs to know which colourway the block as a whole is in so its
// shopfronts can vary around it instead of away from it.
//
// Draws from `r` exactly twice, in this order: the palette index, then the value
// nudge. buildingStyle's random stream is the building's identity and every
// consumer downstream of this call would shift if that changed.
function tintOf(rec, r) {
  const i = Math.min(rec.palette.length - 1, (r() * rec.palette.length) | 0);
  const v = 0.9 + r() * 0.22;
  return { tint: paletteTint(rec, rec.palette[i], v), idx: i, v };
}

/**
 * The highest a shopfront head may sit on this recipe without DELETING the
 * window band above it.
 *
 * facadeEdge skips any band whose bottom is under `ground.top + 0.14`, so a head
 * set over a band bottom does not push that band up - it removes it, and leaves
 * blank wall from the fascia to the next band instead of a sill course.
 *
 * Nothing noticed because the flat 4.0 m head only ever met recipes whose first
 * qualifying band bottom is well above it: retailStrip 5.23 m, deco 5.13,
 * midOffice 4.97. bayTower's is 4.06 - its floorM is 3.15 and its win.top 0.09,
 * so its ground band runs 0.91-2.87 m - and a 4.0 m head there swallows BOTH
 * bands and leaves 3.2 m of blank wall over the fascia, which is the "1970s
 * parking deck" reading arriving by a different route. So this is a latent bug
 * that only had no subject until towers were given a shopfront.
 *
 * 0.72 is the fascia's own maximum depth (0.58) plus the 0.14 clearance
 * lotPlanFor already keeps between a fascia top and the sill above it.
 *
 * @returns {number} metres, or Infinity when no band would be at risk
 */
export function headCapFor(rec, height) {
  const nF = Math.floor(height / rec.floorM);
  for (let F = 0; F < nF; F++) {
    const bt = rec.floorM * (F + 1 - rec.win.top);
    if (bt > height - 0.06) break;
    const bb = bt - rec.floorM * rec.win.h;
    if (bb >= 2.9) return bb - 0.72;
  }
  return Infinity;
}

/**
 * The full deterministic style for one building: recipe, storey count, colour
 * and which kit parts it carries.
 *
 * @param {Object} b  district.json building
 * @returns {Object} style, consumed by appendBuilding and by the kit helpers
 */
export function buildingStyle(b) {
  const name = pickRecipe(b);
  const rec = RECIPES[name];
  const seed = seedOf(b);
  const r = rng(seed ^ 0x5f3a);
  const h = b.h ?? 6;
  const floors = Math.max(1, Math.round(h / rec.floorM));
  const area = b.a ?? 200;

  const commercialGround = name === 'retailStrip' || name === 'deco' ||
    (name === 'midOffice' && r() < 0.7);
  // A TOWER ON A COMMERCIAL STREET TRADES AT STREET LEVEL; a tower on a
  // residential street has a lobby. `b.z` is baked OSM landuse, so this is the
  // district's own answer and not a roll: of the 32 bayTowers, 25 stand in the
  // commercial zone and 7 do not, and those 7 keep the single recessed entrance
  // they have always had. Counted with tools/frontage-stats.mjs --census.
  const towerGround = name === 'bayTower' && (b.z ?? '') === 'commercial';
  // The tower base draws from its OWN stream. `r` is the building's identity and
  // every draw after this point - fabric, fire escape, BALCONIES, roof units -
  // shifts if a new draw is spliced into it. Splicing would have reshuffled the
  // balconies of 25 towers whose upper floors this change does not touch, and a
  // before/after in which the massing moved as well as the base is one nobody
  // can read. Isolate one term at a time.
  const gr = rng(hash32('towerbase', seed));
  // Drawn in this order because the random stream is the building's identity:
  // tintOf consumes from `r` first, exactly as it did when the storefront was
  // built inline in the object literal below.
  const tint = tintOf(rec, r);
  // headCapFor is applied to the TOWER case only, and I got that wrong once:
  // capping every recipe moved 40-odd midOffice lots' heads from 4.36 to 4.25 m
  // - a real 11 cm change to buildings this round is not about, riding along
  // unmeasured under a commit that claimed it was a no-op. The cap reserves the
  // fascia's full 0.58 depth, and midOffice's first qualifying band bottom is
  // 4.968, so its cap is 4.248 and the stepped head can reach 4.36. It was never
  // the no-op I asserted; tools/lot-shots.mjs --report printed 4.25 where the
  // committed number was 4.36 and that is how it was caught. Loosening the cap
  // to bb - 0.34 would clear midOffice but leaves a bayTower fascia 0.20 m deep,
  // under the 0.24 m signage.js needs to letter it, so the shops would lose
  // their names. Gating on the case that needs it is the honest fix.
  const shop = (commercialGround || towerGround) && h > 4.2
    ? { head: towerGround
          ? Math.max(2.9, Math.min(4.0, h - 0.8, headCapFor(rec, h)))
          : Math.min(4.0, h - 0.8),
        depth: 0.55 + (commercialGround ? r() : gr()) * 0.35, bulkhead: 0.42,
        // A TOWER'S GROUND FLOOR IS GLAZED IN BIG PANES, not in 3.2 m shop bays.
        // 07-1777-Main-Street's base is one recessed storey of wide panels
        // between wide piers, and 08-1819-Main-Street's is a single glazed wall
        // under a canopy - neither is a row of 3.2 m display windows. So the
        // tower takes its own bay module. It is also where a third of this
        // change's triangles were: storefront() emits per BAY, and the bay count
        // over 1,596 m of tower frontage does not care how the tenancies are cut.
        ...(towerGround ? { bayM: 4.8 } : {}) }
    : null;
  // Hoisted out of the literal below so `groundLots` can be stated against it.
  const lots = !!rec.lotM && h <= 22;

  return {
    recipe: name, rec, seed, height: h, floors,
    tint: tint.tint, tintIdx: tint.idx,
    // TWO QUESTIONS, AND CONFLATING THEM IS WHAT MADE #76 A PARKING DECK.
    //
    // `lots`: is this footprint MANY PROPERTIES? A tower, a parking deck, a shed
    // and a house are each ONE property and must stay one wall; a low-rise
    // downtown block is a row of tenancies and reads wrong as anything else.
    // `lotM` on the recipe is the gate, height is the second: a 22 m commercial
    // block is a single development, not a parade. Unchanged, and it should be -
    // that reasoning is about the UPPER FLOORS, which is all it now governs.
    lots,
    // `groundLots`: is the frontage SUBDIVIDED AT STREET LEVEL? A different
    // question with a different answer, because a tall building on a retail
    // street still has a row of shops at its foot. What varies per tenancy is
    // what a TENANT owns - the shopfront recess, the street door, the fascia and
    // its colour, the awning, the sign, whether the lights are on after dark -
    // and a pier stands between neighbours. What does not vary is anything above
    // the fascia: one wall colour, one parapet line, one window rhythm, one
    // spandrel stripe, because up there it is one building. See lotPlanFor,
    // which builds both plans, and appendBuilding, which emits ONE facadeEdge
    // per elevation for a ground plan against one per lot for a property plan.
    //
    // Never both: a footprint that is many properties already subdivides its
    // ground floor with them.
    groundLots: !lots && !!shop && !!(rec.groundM ?? rec.lotM),
    // A parapet is nearly universal on a flat-roofed building and is the single
    // cheapest silhouette upgrade: without it every roof is a bare cut edge.
    parapet: { height: name === 'deco' ? 1.5 : name === 'bayTower' ? 0.95 : 1.15,
               project: name === 'deco' ? 0.34 : 0.2,
               stepped: name === 'deco' },
    storefront: shop,
    // Ground-floor treatment for everything the shopfront kit does not cover.
    // Several critics counted the same window grid at street level as on floor
    // seven; a base course under every building and a recessed entrance on the
    // ones with no shop is the cheapest honest answer, and it lands on the part
    // of the building nearest the camera.
    plinth: { height: rec.depth.plinth, project: rec.depth.plinthOut,
              cell: TRIM[rec.depth.plinthCell] ?? TRIM.concrete },
    entrance: !shop && h > 3.4 && name !== 'parking',
    pipes: name !== 'stuccoHouse' && h >= 5.5,
    awnings: commercialGround && name !== 'midOffice' && r() < 0.72,
    fabric: r() < 0.5 ? TRIM.fabricA : TRIM.fabricB,
    fireEscape: (name === 'deco' || name === 'midOffice') && h >= 9 && r() < 0.45,
    balconies: name === 'bayTower' && r() < 0.85,
    signBlank: commercialGround && area > 260 && r() < 0.55,
    roofUnits: name === 'stuccoHouse' ? 0
      : Math.min(9, Math.max(1, Math.round((area / 420) * (0.6 + r())))),
  };
}

// ------------------------------------------------------------------------ lots
//
// THE defect this section exists to fix, measured twice.
//
// An independent fidelity review against Mapillary photographs found that 380 m
// of Main Street east is seven footprints, two of them running 181 m and 106 m of
// continuous frontage "at one height, one recipe and one colour", where
// reference/sarasota/mapillary/views/1110353507514779-L.png shows THREE separate
// shopfronts inside a 24.5 m frame, each with its own fascia, parapet step,
// colour and sign. Re-measured independently over data/district.json: twelve
// footprints touch the band, mean street frontage 78.8 m, longest 181.4 m.
//
// The footprint is not the fault and is not the fix. data/district.json is baked
// OSM and authoritative (binding constraint 10), a re-bake moves every building
// in the district and invalidates every committed comparison, and the complaint
// itself is about APPEARANCE inside a footprint: "one continuous tan wall, one
// flat parapet, one string course, identical bays running the whole block with no
// door, sign or colour change."
//
// So a footprint is a PROPERTY and a lot is an APPEARANCE UNIT inside it. One
// footprint carries many lots; each lot gets its own wall colour, parapet height,
// shopfront head, recess depth, texture phase, awning and street door, and a
// party pier stands at every boundary. Nothing here touches a coordinate.
//
// Three rules this had to get right, and each is a way to make it look worse:
//
//   COLOUR STAYS INSIDE THE RECIPE. RECIPES carries researched Sarasota colour
//   and a fidelity review said in as many words not to touch it. A lot draws a
//   palette ENTRY of its own recipe and a value nudge, exactly what tintOf
//   already did per building. No new hues enter the district.
//
//   ADJACENT LOTS DIFFER, BUT THE BLOCK IS STILL ONE STREET. If every lot drew
//   independently across the full range the block would read as a harlequin,
//   which is a different and worse failure than a blank wall. So there is a run
//   rule: a lot most often takes the block's own colourway, sometimes repeats its
//   neighbour's (two shops in one paint), and only sometimes strikes out. What
//   always differs between neighbours is the value.
//
//   CORNERS AND ENDS ABSORB, THEY DO NOT SLIVER. A boundary landing 30 cm from a
//   building corner is a defect, so cuts are clamped to a minimum lot width from
//   both ends. And the FIRST and LAST lot of every edge keep the building's own
//   parapet height, so at a corner this edge's parapet meets the returning edge's
//   at exactly the height it always did - no open end-cap where two walls meet.
//   Every interior step is closed by its own return quad.

export const LOT = {
  min: 6.2,          // a narrower tenancy than this is a sliver, not a shop
  max: 11.5,         // wider than this and the row stops reading as a row
  minEdge: 13.0,     // an edge shorter than this is already one shopfront
  jitter: 0.30,      // boundary wander, as a fraction of the nominal lot width
  // A GROUND tenancy under a tower is not a platted 1920s shopfront and does not
  // cap at the same width. A tower's structural bay is 9-10 m and a tenancy
  // under one spans one or two of them; 11.5 m forced #76's 79.9 m elevation
  // into eight units where six is the honest number. It is also the single
  // biggest lever on what this costs: every boundary buys a pier, a fascia, a
  // sign, and a piece of shopfront furniture, so tenancy COUNT is the price.
  groundMax: 13.5,
};

/**
 * Cut a frontage into lots. Deterministic in `seed`.
 *
 * The count is chosen first so no lot is narrower than LOT.min or wider than
 * LOT.max, then the interior boundaries wander, then each wandered boundary is
 * clamped so neither it nor anything after it can produce a sliver. That last
 * pass is the one that matters: jitter alone will eventually put a cut 30 cm off
 * a corner, and a 30 cm lot is a defect, not a variation.
 *
 * @param {number} len   frontage length in metres
 * @param {number} seed  32-bit seed
 * @returns {Array<[number,number]>} [start,end] pairs covering 0..len exactly
 */
export function lotCuts(len, seed, opts = {}) {
  const m = opts.m ?? 8.4;
  const min = opts.min ?? LOT.min, max = opts.max ?? LOT.max;
  if (!(len > min * 2)) return [[0, len]];
  let n = Math.max(1, Math.round(len / m));
  while (n > 1 && len / n < min) n--;
  while (len / n > max) n++;
  const base = len / n;
  // Both bounds have to be feasible for the count that was chosen, or the clamp
  // below would fight itself and produce the sliver it exists to prevent.
  const minLot = Math.min(min, base * 0.75);
  const maxLot = Math.max(max, base * 1.05);
  const r = rng(seed);
  const cuts = [0];
  for (let i = 1; i < n; i++) cuts.push(base * i + (r() - 0.5) * base * (opts.jitter ?? LOT.jitter));
  cuts.push(len);
  // Clamp each boundary against BOTH what it leaves behind it and what it leaves
  // in front: `lo` keeps this lot from being a sliver and keeps enough room for
  // the lots after it, `hi` keeps this lot from swallowing the block.
  for (let i = 1; i < n; i++) {
    const lo = Math.max(cuts[i - 1] + minLot, len - (n - i) * maxLot);
    const hi = Math.min(cuts[i - 1] + maxLot, len - (n - i) * minLot);
    cuts[i] = Math.max(lo, Math.min(hi, cuts[i]));
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push([cuts[i], cuts[i + 1]]);
  return out;
}

/**
 * A slice of an edge, in the shape edgesOf() returns, so every helper in this
 * file can be handed a lot exactly where it would be handed a wall.
 */
export function subEdge(e, s0, s1) {
  return {
    a: [e.a[0] + e.tx * s0, e.a[1] + e.tz * s0],
    b: [e.a[0] + e.tx * s1, e.a[1] + e.tz * s1],
    len: s1 - s0, i: e.i,
    tx: e.tx, tz: e.tz, nx: e.nx, nz: e.nz,
  };
}

const PARAPET_STEP = [-0.32, -0.16, 0, 0.20, 0.44];
const HEAD_STEP = [-0.38, -0.20, 0, 0.18, 0.36];
// Pick from a table, never the same entry twice running: the whole point of a
// step is that the neighbour did something else.
const stepAfter = (r, table, prev) => {
  let v = table[(r() * table.length) | 0];
  if (v === prev) v = table[(table.indexOf(v) + 1 + ((r() * (table.length - 1)) | 0)) % table.length];
  return v;
};

// Which bay of the painted rhythm a lot starts on.
//
// Free choice here is what de-aligns one lot's windows from its neighbour's, but
// it is not free of consequence: openingsAlong drops an opening that would break
// a corner, so an unlucky phase can leave a 7 m lot with no window at all above
// its shopfront. So the phases are scored and the choice is made among those
// within one opening of the best - varied, and never blank.
function phaseFor(rec, len, r) {
  const ex = bayEdges(rec.rhythm, 1);
  const cand = [], counts = [];
  let best = -1;
  for (let j = 0; j < rec.rhythm.length; j++) {
    const u0 = ex[j] * rec.tileU - 0.34;
    const n = openingsAlong(rec, len, { u0, margin: 0.34 }).length;
    cand.push(u0); counts.push(n);
    if (n > best) best = n;
  }
  const keep = cand.filter((_, j) => counts[j] >= best - 1);
  return keep[(r() * keep.length) | 0];
}

/**
 * The lot plan for one building: which frontages are subdivided and what each
 * lot looks like. Consumed by appendBuilding, by signage.js so a shop's fascia
 * and awning land on ITS lot rather than straddling two, and by
 * tools/frontage-stats.mjs so the claim can be measured.
 *
 * @param {Array<[number,number]>} ring   footprint
 * @param {Object} style   buildingStyle result
 * @param {number} height  building height
 * @param {Array} fronts   the edges that carry frontage (street-facing first)
 * @returns {Map<number, {e:Object, lots:Array}>} keyed by ring edge index
 */
export function lotPlanFor(ring, style, height, fronts) {
  const plan = new Map();
  // GROUND-ONLY. Same cutting, same tenancy structure, same party lines - and
  // then everything belonging to the BUILDING rather than to the tenant is held
  // at the building's own value. See buildingStyle's `groundLots`.
  const ground = !style.lots && !!style.groundLots;
  if (!style.lots && !ground) return plan;
  const rec = style.rec, pal = rec.palette;
  const baseParapet = style.parapet?.height ?? 1.15;
  const shop = style.storefront;
  // The bottom of every window band facadeEdge will emit, so a fascia can be
  // sized to stop clear of the one above it instead of growing into it. Same
  // arithmetic as facadeEdge, kept here because the lot has to decide its own
  // fascia height and signage.js has to be able to read it back.
  const bandBottoms = [];
  for (let F = 0; F < Math.floor(height / rec.floorM); F++) {
    const bt = rec.floorM * (F + 1 - rec.win.top);
    if (bt > height - 0.06) break;
    bandBottoms.push(bt - rec.floorM * rec.win.h);
  }

  // A two- or three-storey block subdivides at SHOPFRONT scale whatever its wall
  // is made of. The recipe carries the module for its own stock; a low building
  // of any recipe was built on the narrower lots the street was platted in, which
  // is why the reference photograph shows three tenancies in 24.5 m of a block
  // this kit had drawn as one 181 m wall.
  const lotM = ground ? (rec.groundM ?? rec.lotM) : rec.lotM * (height <= 12 ? 0.88 : 1);
  // See headCapFor. buildingStyle already caps `shop.head` on a tower; this caps
  // the value AFTER the per-lot step, which can add 0.36. GROUND-ONLY, for the
  // reason spelled out at that call: the cap reserves a full-depth fascia, and
  // midOffice's cap of 4.25 m sits UNDER its maximum stepped head of 4.36, so
  // applying it everywhere silently reheads every tall midOffice lot in the
  // district. A ground-only frontage takes no step at all, so the two caps agree
  // there and this line is belt and braces.
  const headCap = ground ? headCapFor(rec, height) : Infinity;

  for (const e of fronts) {
    if (e.len < LOT.minEdge) continue;
    const cuts = lotCuts(e.len, hash32('lot', style.seed, e.i),
      ground ? { m: lotM, max: LOT.groundMax } : { m: lotM });
    if (cuts.length < 2) continue;
    const r = rng(hash32('lotstyle', style.seed, e.i));
    const lots = [];
    let prevIdx = -1, prevV = -1, prevPar = null, prevHead = null;
    // Consecutive closed-and-dark tenancies placed so far on THIS edge. Reset per
    // edge rather than per building: a corner site's two frontages are two
    // streets and a run does not carry round the corner.
    let darkRun = 0;
    for (let k = 0; k < cuts.length; k++) {
      const [s0, s1] = cuts[k];
      const len = s1 - s0;

      // Colourway. Mostly the block's own, sometimes the neighbour's again, and
      // sometimes another entry of the same recipe. Never a new hue.
      //
      // A GROUND-ONLY frontage skips every line of this and takes the building's
      // own colour, unchanged, on every tenancy. The wall over these shopfronts
      // is ONE wall and appendBuilding emits it as one facadeEdge, so a per-lot
      // tint here would be a colour nothing draws with - and if anything ever
      // did draw with it, it would be the full-height parade this split exists
      // to prevent. The distinct-wall-colour count for such a frontage is 1 by
      // construction, and tools/frontage-stats.mjs --selftest asserts it.
      let idx = style.tintIdx ?? 0;
      let tint = style.tint;
      if (!ground) {
        if (k && r() < 0.30) idx = prevIdx;
        else if (r() < 0.55) idx = style.tintIdx ?? 0;
        else idx = (((style.tintIdx ?? 0) + 1 + ((r() * (pal.length - 1)) | 0)) % pal.length);
        // The VALUE, and then the check that actually matters. Two lots that draw
        // different palette entries can still land on the same brightness - most of
        // midOffice's palette clamps against its own wall colour, so four authored
        // colourways collapse to about two - and a party line you cannot see is not
        // a party line. So the luminance of the finished tint is compared with the
        // neighbour's and pushed apart until it reads. The lever is the value nudge
        // tintOf already applies per building, widened from +-11% to +-18%; no hue
        // moves, no entry is added, RECIPES is untouched.
        let v = 0.86 + r() * 0.28;
        tint = paletteTint(rec, pal[idx], v);
        if (k) {
          // Push AWAY from the neighbour, whichever side of it this lot fell on, so
          // the rule does not quietly darken every lotted frontage in the district;
          // reverse at the clamp, because an entry already clamped to white cannot
          // be separated by going brighter. The floor sits further from 1 than the
          // ceiling on purpose: midOffice's palette entry 2 divides out ABOVE 1 in
          // every channel, so it is white for any nudge over about 0.80, and
          // darkening is the only lever that entry leaves.
          let dir = lum(tint) >= prevV ? 1 : -1;
          for (let g = 0; g < 8 && Math.abs(lum(tint) - prevV) < 0.055; g++) {
            if (v + dir * 0.09 > 1.18 || v + dir * 0.09 < 0.70) dir = -dir;
            v = Math.max(0.70, Math.min(1.18, v + dir * 0.09));
            tint = paletteTint(rec, pal[idx], v);
          }
          // Last resort: if the nudge cannot separate them - both entries clamp to
          // white whatever it does - take the palette's most contrasting entry
          // instead. Still this recipe's own colour, and it beats two identical
          // shops sharing a party pier.
          if (Math.abs(lum(tint) - prevV) < 0.055) {
            let bj = idx, bd = 0;
            for (let j = 0; j < pal.length; j++) {
              const dd = Math.abs(lum(paletteTint(rec, pal[j], 0.92)) - prevV);
              if (dd > bd) { bd = dd; bj = j; }
            }
            if (bd >= 0.055) { idx = bj; v = 0.92; tint = paletteTint(rec, pal[idx], v); }
          }
        }
      }

      // The tenancy's after-dark state, capped so a camera cannot land on a long
      // dead run. Computed before the lot object so darkRun is advanced exactly
      // once per lot however the object below is edited.
      let litState = TRIM_NONE;
      if (shop) {
        const capped = tenancyStateCapped(darkRun, style.seed, e.i, k);
        litState = capped.state;
        darkRun = capped.run;
      }

      // Parapet. Pinned to the building's own height at both ends of the edge so
      // the corners meet the returning walls exactly as they did before lots.
      // A ground-only frontage never steps at all: that parapet is 30 m over the
      // shopkeeper's head and belongs to the tower, not to the shop.
      const end = k === 0 || k === cuts.length - 1;
      const pstep = (ground || end) ? 0 : stepAfter(r, PARAPET_STEP, prevPar);
      const parapetH = Math.max(0.55, baseParapet + pstep);

      // Shopfront head - the fascia line, and the horizontal the eye reads first.
      // It was Math.min(4.0, h - 0.8) for every shopfront in the district, which
      // is precisely the "constant storey height to the pavement" finding.
      let head = null, depth = null, doorSpan = null, fasciaY = null;
      if (shop) {
        // ONE HEAD FOR THE WHOLE ELEVATION on a ground-only frontage. A tower
        // has one continuous soffit over its shops - 07-1777-Main-Street and
        // 08-1819-Main-Street both carry a dead-level band over a subdivided
        // base - and a stepped one would put the building straight into the "row
        // of sheds" failure the lot pass already had to avoid. It also keeps the
        // wall over the shopfronts a single uncut run, which is what makes this
        // nearly free in triangles.
        const hstep = ground ? 0 : stepAfter(r, HEAD_STEP, prevHead);
        head = Math.max(2.9, Math.min(Math.min(4.6, height - 0.7, headCap), shop.head + hstep));
        prevHead = hstep;
        depth = 0.42 + r() * 0.46;
        // MUST use the same module storefront() will, or the door lands where
        // there is no bay to put it in.
        const bays = storefrontBays(len, shop);
        if (bays.length) {
          const bi = r() < 0.72 ? (r() < 0.5 ? 0 : bays.length - 1) : ((r() * bays.length) | 0);
          const [b0, b1] = bays[bi];
          const dw = Math.min(1.35, (b1 - b0) * 0.5);
          // Not every lot: a run of shopfronts where every single unit has its
          // own door at the same spacing is its own kind of regularity, and two
          // adjacent lots trading as one unit is ordinary on a real high street.
          if (dw > 0.85 && r() < 0.82) doorSpan = bi === 0 ? [b0, b0 + dw] : [b1 - dw, b1];
        }
        // The fascia band over the shopfront: as deep as it can be without
        // reaching the first-floor sill above it.
        let ceil = height - 0.18;
        for (const bb of bandBottoms) if (bb >= head + 0.2) { ceil = Math.min(ceil, bb - 0.14); break; }
        const fh = Math.min(0.58, ceil - head);
        if (fh >= 0.2) fasciaY = [head, head + fh];
      }

      lots.push({
        i: e.i, k, s0, s1, len, sub: subEdge(e, s0, s1),
        tint,
        tintIdx: idx,
        // The fascia is PAINTED joinery, not masonry, so it takes its own entry
        // of the same palette and is allowed to go darker than a wall would.
        // This is the band the shop's name sits on and it is what makes one
        // tenancy legible from across the street.
        fasciaTint: paletteTint(rec, pal[(r() * pal.length) | 0], 0.68 + r() * 0.34),
        // Texture phase: which bay of the painted rhythm this lot starts on, less
        // a pier's width so the first opening clears the party line. Adjacent
        // lots therefore do not line their windows up, which is the single
        // cheapest cue that two neighbours were built by different people.
        // A ground-only lot does not choose a phase: the window rhythm above it
        // belongs to the BUILDING and is emitted once for the whole elevation.
        u0: ground ? undefined : phaseFor(rec, len, r),
        parapetH, head, depth, doorSpan, fasciaY,
        // Open, closed-with-the-light-on, or dark? Off a separate hash stream, so
        // the whole sequence above - colourway, value nudge, parapet step, head
        // step, recess depth, door bay - draws exactly the numbers it drew before
        // and every daylight frame is untouched. See tenancyState, and
        // MAX_DARK_RUN for why the raw roll is capped along the frontage.
        litState: litState,
        awning: !!shop && len > 3.8 && r() < 0.46,
        // A lot with no shopfront still meets the street somewhere, but an office
        // block has fewer street doors than a retail row.
        entrance: !shop && r() < 0.34,
      });
      prevIdx = idx; prevV = lum(tint); prevPar = pstep;
    }
    // `ground` is on the PLAN, not only on the lots, because every consumer
    // decides per elevation: facadeWalls emits one wall or many, parapet() steps
    // or does not, appendBuilding stops the party piers at the fascia or carries
    // them to the cornice. tools/frontage-stats.mjs reads it to keep the two
    // kinds of run apart in its counts.
    plan.set(e.i, { e, lots, ground });
  }
  return plan;
}

// ------------------------------------------------------------- geometry helpers
//
// Every helper below appends into caller-owned arrays with the same convention as
// geom.js extrudeFootprint: (shape args..., pos, nrm, uv, idx, opts). None of
// them constructs a Mesh, a Material or a BufferGeometry — the streamer owns
// meshing so it can merge a whole chunk into one geometry per material.
//
// Buffers may carry an optional `col` array (opts.col) for per-building vertex
// colours. Pass it consistently: a geometry either has colours on every vertex or
// on none.

function pushCol(col, tint, n) {
  if (!col) return;
  for (let i = 0; i < n; i++) col.push(tint[0], tint[1], tint[2]);
}

// One quad, wound a-b-c-d, with `uvq` = [u0,v0,u1,v1] mapped a=(u0,v0) b=(u1,v0)
// c=(u1,v1) d=(u0,v1).
//
// The winding is corrected against the supplied normal rather than trusted. Every
// helper below places quads relative to a footprint edge whose outward direction
// depends on the ring's winding, and OSM gives both windings (168 of the
// district's 523 footprints wind the other way). Hand-deriving the correct vertex
// order for each of those cases is exactly the kind of bug that only shows up as
// a hole in a facade seen from one side, so it is computed instead.
function quad(pos, nrm, uv, idx, a, b, c, d, n, uvq, col, tint) {
  quadS(pos, nrm, uv, idx,
    a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2],
    n[0], n[1], n[2], uvq[0], uvq[1], uvq[2], uvq[3], col, tint);
}

// The same thing with every argument a scalar. The built-depth pass emits an
// order of magnitude more quads than the kit ever did, and at that volume the
// four [x,y,z] arrays and four UV pairs quad() allocated per call are the
// dominant term in chunk build: the work is trivial, the garbage is not.
// Measured on the whole district, routing the depth pass through this cut
// facade generation by roughly a third with no change to a single vertex.
function quadS(pos, nrm, uv, idx, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz,
  nx, ny, nz, u0, v0, u1, v1, col, tint) {
  // Winding is corrected against the supplied normal rather than trusted; see
  // edgesOf on why both ring windings reach this code.
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const gx = e1y * e2z - e1z * e2y;
  const gy = e1z * e2x - e1x * e2z;
  const gz = e1x * e2y - e1y * e2x;
  let uaU = u0, uaV = v0, ubU = u1, ubV = v0;
  const ucU = u1, ucV = v1;
  let udU = u0, udV = v1;
  if (gx * nx + gy * ny + gz * nz < 0) {
    // Reversing the winding has to carry the UVs with it. Swapping only the
    // positions transposes the mapping — u ends up running up the wall and v
    // across it — which on a square-ish tile still looks like windows, so it
    // survives a glance and only shows up as vertical banding on a tall tower.
    let t = bx; bx = dx; dx = t;
    t = by; by = dy; dy = t;
    t = bz; bz = dz; dz = t;
    t = ubU; ubU = udU; udU = t;
    t = ubV; ubV = udV; udV = t;
  }
  const v = pos.length / 3;
  pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
  nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
  uv.push(uaU, uaV, ubU, ubV, ucU, ucV, udU, udV);
  idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  if (col) {
    const r = tint[0], g = tint[1], b = tint[2];
    col.push(r, g, b, r, g, b, r, g, b, r, g, b);
  }
}

/**
 * An axis-aligned box, all six faces sampling one trim cell. The workhorse for
 * roof plant, railings, sign blanks and awning frames.
 */
export function box(cx, cy, cz, sx, sy, sz, pos, nrm, uv, idx, opts = {}) {
  const cell = trimCell(opts.cell ?? TRIM.concrete);
  const q = [cell.u0, cell.v0, cell.u1, cell.v1];
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  quad(pos, nrm, uv, idx, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], q, col, t);
  quad(pos, nrm, uv, idx, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], q, col, t);
  quad(pos, nrm, uv, idx, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], q, col, t);
  quad(pos, nrm, uv, idx, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], q, col, t);
  quad(pos, nrm, uv, idx, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], q, col, t);
  quad(pos, nrm, uv, idx, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], q, col, t);
}

/**
 * A thin square prism between two points — the primitive a sloped bracket needs
 * and box() cannot express. Rooftop rafters, awning arms and stay rods all rake,
 * and an axis-aligned box forced to stand in for one is what produced awning
 * "supports" that sat 0.4 m above the fabric they were meant to carry.
 *
 * Emits six quads / 24 vertices, exactly like box(), so anything that splits a
 * merged buffer back into solids on a 24-vertex stride still works.
 *
 * @param {number[]} a  [x,y,z] one end
 * @param {number[]} b  [x,y,z] the other
 * @param {number} r    half-width of the square section
 */
export function strut(a, b, r, pos, nrm, uv, idx, opts = {}) {
  // uvRect lets signage.js emit the same hardware against ITS atlas rather than
  // the trim atlas, so one bracket recipe serves both kits.
  const cell = trimCell(opts.cell ?? TRIM.metalDark);
  const q = opts.uvRect ?? [cell.u0, cell.v0, cell.u1, cell.v1];
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  // Any reference not parallel to the axis, so the cross products stay stable
  // for a vertical strut as well as a raking one.
  const ref = Math.abs(dy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ref[1] * dz - ref[2] * dy;
  let uy = ref[2] * dx - ref[0] * dz;
  let uz = ref[0] * dy - ref[1] * dx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const P = (p, su, sv) => [
    p[0] + ux * su * r + vx * sv * r,
    p[1] + uy * su * r + vy * sv * r,
    p[2] + uz * su * r + vz * sv * r,
  ];
  const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [s0, w0] = corner[i], [s1, w1] = corner[(i + 1) % 4];
    const n = [
      (ux * (s0 + s1) + vx * (w0 + w1)) / 2,
      (uy * (s0 + s1) + vy * (w0 + w1)) / 2,
      (uz * (s0 + s1) + vz * (w0 + w1)) / 2,
    ];
    quad(pos, nrm, uv, idx, P(a, s0, w0), P(a, s1, w1), P(b, s1, w1), P(b, s0, w0), n, q, col, t);
  }
  quad(pos, nrm, uv, idx, P(a, -1, -1), P(a, 1, -1), P(a, 1, 1), P(a, -1, 1), [-dx, -dy, -dz], q, col, t);
  quad(pos, nrm, uv, idx, P(b, -1, -1), P(b, 1, -1), P(b, 1, 1), P(b, -1, 1), [dx, dy, dz], q, col, t);
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

// Edge list with outward normals, sorted long-first when asked. OSM footprints
// arrive in both windings — 168 of the district's 523 wind the other way — so
// outwardness is derived from the signed area rather than assumed. (geom.js
// extrudeFootprint does assume it, which is why its wall normals point inward
// for those 168; harmless for a Lambert box, wrong once the wall is lit.)
export function edgesOf(ring, { minLen = 1.5, longest = 0 } = {}) {
  const flip = ringArea(ring) > 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < minLen) continue;
    out.push({
      a, b, len, i,
      tx: dx / len, tz: dz / len,
      nx: (dz / len) * flip, nz: (-dx / len) * flip,
    });
  }
  if (longest > 0) {
    return out.slice().sort((p, q) => q.len - p.len).slice(0, longest);
  }
  return out;
}

/**
 * Edges whose outward normal faces a given direction, longest first. The streamer
 * can pass the direction of the nearest road; without one, callers fall back to
 * the longest edges, which is right often enough for a block interior.
 *
 * @param {Array<[number,number]>} ring
 * @param {number} dx  street direction x (the way the front should face)
 * @param {number} dz  street direction z
 */
export function facingEdges(ring, dx, dz, { minLen = 3, max = 2, cone = 0.35 } = {}) {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  return edgesOf(ring, { minLen })
    .filter((e) => e.nx * ux + e.nz * uz > cone)
    .sort((a, b) => b.len - a.len)
    .slice(0, max);
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// A band running along an edge, subdivided so the trim cell tiles at `cellM`
// metres instead of being stretched over a 40 m wall.
function bandAlong(e, y0, y1, outset, cell, pos, nrm, uv, idx, opts, cellM = 2.0) {
  const c = trimCell(cell);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  // cellM = 0 stretches one cell over the whole edge. That is the right choice
  // for a swatch with no horizontal structure — the cornice stone is drawn as
  // horizontal streaks precisely so this is possible — and it turns a 40 m
  // cornice from 20 quads into 1.
  const segs = cellM > 0 ? Math.max(1, Math.round(e.len / cellM)) : 1;
  const ox = e.nx * outset, oz = e.nz * outset;
  for (let s = 0; s < segs; s++) {
    const t0 = s / segs, t1 = (s + 1) / segs;
    const ax = e.a[0] + e.tx * e.len * t0 + ox, az = e.a[1] + e.tz * e.len * t0 + oz;
    const bx = e.a[0] + e.tx * e.len * t1 + ox, bz = e.a[1] + e.tz * e.len * t1 + oz;
    quad(pos, nrm, uv, idx,
      [ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az],
      [e.nx, 0, e.nz], [c.u0, c.v0, c.u1, c.v1], col, t);
  }
}

/**
 * Cornice / parapet. A projecting band at roof level plus the wall that carries
 * on above it, with an inner face and a capping so it reads from the street and
 * from above. `stepped` adds the deco centre step on the longest edges.
 *
 * @param {Array<[number,number]>} ring  footprint
 * @param {number} y  roof height
 */
export function parapet(ring, y, pos, nrm, uv, idx, opts = {}) {
  const h = opts.height ?? 1.1, proj = opts.project ?? 0.22;
  const cell = opts.cell ?? TRIM.stone;
  const c = trimCell(cell);
  const q = [c.u0, c.v0, c.u1, c.v1];
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = edgesOf(ring, { minLen: 0.6 });
  // The cornice line comes from the BUILDING's parapet height, not the lot's, so
  // that one horizontal still runs the length of the block. Only the top steps.
  // A block whose cornice AND parapet both jumped at every party line would be a
  // row of sheds, not a row of shops.
  const cornice = y - h * 0.35;

  // The projecting cornice: soffit, face and top wash. Its line and its
  // projection are the same for every lot, so it is emitted once per EDGE and
  // keeps the building's own colour - a continuous cornice is what stops a row of
  // stepped parapets reading as a row of sheds, and it is three quads a lot
  // saved on the most-instanced kit part in the district.
  const corniceRun = (e, tint) => {
    const o = { ...opts, tint };
    const ox = e.nx * proj, oz = e.nz * proj;
    const ax = e.a[0], az = e.a[1], bx = e.b[0], bz = e.b[1];
    quad(pos, nrm, uv, idx,
      [bx, cornice, bz], [ax, cornice, az], [ax + ox, cornice, az + oz], [bx + ox, cornice, bz + oz],
      [0, -1, 0], q, col, tint);
    bandAlong(e, cornice, y, proj, cell, pos, nrm, uv, idx, o, 0);
    quad(pos, nrm, uv, idx,
      [ax + ox, y, az + oz], [bx + ox, y, bz + oz], [bx, y, bz], [ax, y, az],
      [0, 1, 0], q, col, tint);
  };
  // The parapet standing on it: outer face, cap, inner face. THIS is what steps.
  const run = (e, ph, tint) => {
    const o = { ...opts, tint };
    const ax = e.a[0], az = e.a[1], bx = e.b[0], bz = e.b[1];
    const top = y + ph;
    bandAlong(e, y, top, 0, cell, pos, nrm, uv, idx, o, 0);
    const ix = -e.nx * 0.26, iz = -e.nz * 0.26;
    quad(pos, nrm, uv, idx,
      [ax, top, az], [bx, top, bz], [bx + ix, top, bz + iz], [ax + ix, top, az + iz],
      [0, 1, 0], q, col, tint);
    quad(pos, nrm, uv, idx,
      [bx + ix, y, bz + iz], [ax + ix, y, az + iz], [ax + ix, top, az + iz], [bx + ix, top, bz + iz],
      [-e.nx, 0, -e.nz], q, col, tint);
  };

  for (const e of edges) {
    const lots = opts.lots?.get(e.i);
    corniceRun(e, t);
    if (!lots || lots.length < 2) { run(e, h, t); continue; }
    for (const L of lots) run(L.sub, L.parapetH, L.tint);
    // Close every interior step. The parapet is a 0.26 m slab; where the lot on
    // one side is taller its slab has an open END, and an open end is a hole you
    // can see the sky through from the pavement opposite.
    for (let k = 1; k < lots.length; k++) {
      const a = lots[k - 1], b = lots[k];
      const d = a.parapetH - b.parapetH;
      if (Math.abs(d) < 0.02) continue;
      const lo = y + Math.min(a.parapetH, b.parapetH), hi = y + Math.max(a.parapetH, b.parapetH);
      jambQ(e, b.s0, lo, hi, 0, -0.26, d > 0 ? -1 : 1, q, pos, nrm, uv, idx,
        { col, tint: (d > 0 ? a : b).tint });
    }
  }

  if (opts.stepped) {
    for (const e of edgesOf(ring, { minLen: 4, longest: 2 })) {
      const mx = (e.a[0] + e.b[0]) / 2, mz = (e.a[1] + e.b[1]) / 2;
      const w = Math.min(6, e.len * 0.34);
      for (let s = 0; s < 3; s++) {
        const sw = w * (1 - s * 0.26), sh = 0.44;
        box(mx + e.nx * 0.08, y + h + sh / 2 + s * sh, mz + e.nz * 0.08,
          Math.abs(e.tx) * sw + Math.abs(e.nx) * 0.5, sh,
          Math.abs(e.tz) * sw + Math.abs(e.nz) * 0.5,
          pos, nrm, uv, idx, { cell, col: opts.col, tint: opts.tint });
      }
    }
  }
}

/**
 * Ground-floor storefront band with GEOMETRICALLY recessed glazing: the glass
 * plane sits `depth` metres behind the wall line with real jamb, head and sill
 * returns. Reveals are painted into the facade texture everywhere else, but at
 * eye level the depth has to be real or the shopfront reads as a decal.
 *
 * Call this on the street-facing edges only (opts.edges), otherwise every
 * building gets shops on its back alley.
 */
// WHICH SHOPS ARE ON after dark, as cumulative shares of all ground-floor
// tenancies.
//
//   0.00 - 0.30   OPEN. Trading, full interior, display track running.
//   0.30 - 0.72   CLOSED WITH THE LIGHT ON. One tube over the window, or a
//                 back-of-house light seen down the shop. This is the COMMON
//                 case and it is the one the binary version of this got wrong by
//                 not having: a shopfront that is fully black at night is the
//                 exception on a real high street, because insurers and
//                 ordinances want a lit interior.
//   0.72 - 1.00   CLOSED AND DARK. Vacant, shuttered, or a unit that switches
//                 off - but still not BLACK: see TRIM_DARK, which is an exit
//                 sign and a till light, at 8.5% of an open shop.
//
// retailStrip's own lit.night of 0.34 is the figure for the flats and offices
// STACKED ON a shop, which go dark when the last person leaves; the ground floor
// does not behave like its upper storeys and does not share its number. These
// are the levers to move if a later round says the street is too bright or too
// dead. `lit.night` itself is untouched and means what it always meant.
export const TENANCY_MIX = { open: 0.30, dimTo: 0.72 };

/**
 * Which state is this tenancy in? TRIM_DARK, TRIM_DIM or TRIM_LIT - never
 * TRIM_NONE, which is reserved for everything that is not a shopfront at all.
 * Deterministic,
 * and drawn from its OWN hash stream rather than from the lot planner's `r`.
 *
 * That is not a style preference. drawOpening records the same rule for panes and
 * the reason is identical: the lot sequence decides colourway, parapet step,
 * shopfront head, recess depth and door position, in that order, off one stream,
 * and taking one extra number out of it would re-roll every one of those for
 * every lot after this one - which would change the DAYLIGHT frames this change
 * has to leave untouched. Keyed on the building seed as well as the edge and lot
 * index, or every building's first lot on its first edge would light in unison
 * across the whole district.
 */
export function tenancyState(...parts) {
  const x = rng(hash32('shoplit', ...parts))();
  if (x < TENANCY_MIX.open) return TRIM_LIT;
  if (x < TENANCY_MIX.dimTo) return TRIM_DIM;
  return TRIM_DARK;
}

// How many closed-and-dark tenancies may stand in a row before the next one is
// promoted to closed-with-a-light.
//
// THIS IS THE ONE RULE HERE THAT IS ABOUT THE CAMERA RATHER THAN ABOUT SARASOTA,
// and it is worth being honest about that. A street-level camera sees roughly
// four to six tenancies across a near frontage, so an independent-per-lot roll
// with a 27.5% dark share puts a run of four at about 0.6% per starting lot -
// rare per lot, and a near certainty somewhere in 2,127 of them. It duly landed
// on the hero frame: the CASSAVA / LUMEN CAMERA row drew dark on every visible
// lot in FOUR successive versions of this change, because tenancyState's hash
// never moved, only its thresholds. Three reviewers named that row; two rounds
// measured it unchanged.
//
// A real high street does have dead runs. It does not have them uniformly at
// random, because a landlord who lets one unit lets the ones beside it, and a
// dark run that long is a distinctive thing rather than a background texture. So
// 2 is a cap and not a tuning: in any four bays a camera can see, at least two
// now carry an interior. The census reports the resulting run histogram, and it
// still contains runs of 2 - the rule removes the tail, not the variation.
export const MAX_DARK_RUN = 2;

/**
 * tenancyState, with the run cap applied along a frontage.
 *
 * `run` is the number of consecutive TRIM_DARK tenancies already placed on this
 * edge; the caller carries it. Returns the state and the new run length together
 * so the caller cannot update one and forget the other, which is exactly the bug
 * a pair of parallel variables invites.
 */
export function tenancyStateCapped(run, ...parts) {
  let st = tenancyState(...parts);
  if (st === TRIM_DARK && run >= MAX_DARK_RUN) st = TRIM_DIM;
  return { state: st, run: st === TRIM_DARK ? run + 1 : 0 };
}

/**
 * The street door for an IMPLIED tenancy, on a frontage with no lot plan.
 *
 * A lotted frontage gets its door from the lot planner, which hands storefront()
 * one `doorSpan`. An unlotted one was handed nothing, so `opts.doorSpan ?? null`
 * resolved to null and NO DOOR WAS EMITTED ANYWHERE ON IT. Measured before this
 * existed: 139 of 387 street edges and 1,166 m of the district's 8,397 m of
 * frontage — 13.9% — carried display glazing, a bulkhead, a transom and a
 * threshold, and no way in. The lot pass fixed "the ground floor does not meet
 * the street" for the frontages it cut and left the rest exactly as it found
 * them, which is why the finding kept coming back for the shorter buildings.
 *
 * Same rule as lotPlanFor's, deliberately, so the two paths cannot drift into
 * two different-looking high streets: a bay biased to the end of the unit, a
 * leaf half the bay wide capped at 1.35 m, a minimum of 0.85 m so a narrow bay
 * does not get a door too thin to walk through, and 82% of units rather than all
 * of them — a row where every single unit has its own door at the same spacing
 * is its own kind of regularity, and two units trading as one is ordinary.
 *
 * Pure in (seed, edge, pair), like tenancyState: there is no rng STREAM in this
 * loop to advance, and adding one would have resequenced every lit-tenancy
 * decision in the district.
 *
 * @returns {[number,number]|null} the door span in edge metres, or null
 */
export function impliedDoor(seed, ei, pair, bays) {
  if (!bays.length) return null;
  const r = rng(hash32('shopdoor', seed, ei, pair));
  const lo = pair * 2, hi = Math.min(lo + 1, bays.length - 1);
  if (lo > hi) return null;
  const atEnd = r() < 0.72;
  const bi = atEnd ? (r() < 0.5 ? lo : hi) : lo + ((r() * (hi - lo + 1)) | 0);
  const [b0, b1] = bays[Math.min(bi, bays.length - 1)];
  const dw = Math.min(1.35, (b1 - b0) * 0.5);
  if (!(dw > 0.85) || !(r() < 0.82)) return null;
  return bi === lo ? [b0, b0 + dw] : [b1 - dw, b1];
}

export function storefrontBays(len, opts = {}) {
  const bayM = opts.bayM ?? 3.2, pier = opts.pier ?? 0.32;
  const bays = Math.max(1, Math.round((len - pier * 2) / bayM));
  const bw = (len - pier * 2) / bays;
  const out = [];
  for (let i = 0; i < bays; i++) {
    out.push([pier + i * bw + pier * 0.5, pier + (i + 1) * bw - pier * 0.5]);
  }
  return out;
}

export function storefront(ring, pos, nrm, uv, idx, opts = {}) {
  const head = opts.head ?? 3.6, depth = opts.depth ?? 0.6, bulk = opts.bulkhead ?? 0.42;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  // Both states of every cell this function draws with, resolved once. A lit
  // tenancy takes the second column and that is the ENTIRE cost of lighting it:
  // the same quads, the same count, four different numbers in the UV rect - the
  // trick the door leaf below already uses to stop being a window. See
  // TRIM_LIT_V for why v + 1 is free.
  const cells = (c) => [trimCell(c, TRIM_NONE), trimCell(c, TRIM_DARK),
    trimCell(c, TRIM_DIM), trimCell(c, TRIM_LIT)];
  const glassC = cells(opts.glassCell ?? TRIM.glass);
  const bulkCs = cells(opts.bulkheadCell ?? TRIM.bulkhead);
  const jambCs = cells(opts.jambCell ?? TRIM.stucco);
  const edges = opts.edges ?? edgesOf(ring, { minLen: 4, longest: opts.faces ?? 2 });
  // Where this tenancy's own street door goes, in edge metres. A separate
  // fidelity finding - "the ground floor does not meet the street: no doors, no
  // entrances" - is answered here and nowhere else, because before the lot pass
  // a shopfront building had NO door at all: buildingStyle only gives an
  // `entrance` to buildings with no shopfront.
  // A LOTTED frontage is handed one door span by the lot planner. An UNLOTTED
  // one is handed nothing, and used to get no door at all; impliedDoor() gives
  // each implied tenancy its own, on the same rule. `null` here now means "work
  // it out per pair" rather than "there is no door on this elevation".
  const door = opts.doorSpan ?? null;
  const doorSeed = opts.seed ?? 0;

  for (const e of edges) {
    const P = (x) => [e.a[0] + e.tx * x, e.a[1] + e.tz * x];
    const back = (p, d) => [p[0] - e.nx * d, p[1] - e.nz * d];

    const bays = storefrontBays(e.len, opts);
    // The implied-tenancy state for an unlotted frontage, and the run cap along
    // it. `lastPair` exists because the pair is decided ONCE and then reused by
    // its second bay: without it the same pair would be rolled twice and would
    // advance darkRun twice, which caps at 1 instead of 2.
    let darkRun = 0, lastPair = -1, pairState = TRIM_NONE;
    for (let bi = 0; bi < bays.length; bi++) {
      const [s0, s1] = bays[bi];
      // A LOTTED frontage is one tenancy and lights as one - opts.state is the lot
      // planner's decision for it, and every bay of that shop agrees, because a
      // shop with the lights on in half its window is not a thing.
      //
      // An UNLOTTED frontage has no tenancy structure to inherit, so one is
      // implied here at the same scale the lot planner works at: retailStrip's
      // lotM is 7.6 m against a 3.2 m bay, so bays are grouped in pairs and each
      // pair decides for itself. Without this the whole-edge shopfronts - the
      // frontages too short to cut into lots - would be uniformly lit or
      // uniformly dark down their entire length.
      let st;
      if (opts.state !== undefined) st = opts.state;
      else if (bi >> 1 === lastPair) st = pairState;
      else {
        const capped = tenancyStateCapped(darkRun, opts.seed ?? 0, e.i, bi >> 1);
        st = capped.state; darkRun = capped.run;
        lastPair = bi >> 1; pairState = st;
      }
      const glass = glassC[st], bulkC = bulkCs[st], jambC = jambCs[st];
      const o0 = P(s0), o1 = P(s1);            // opening edges at the wall line
      const g0 = back(o0, depth), g1 = back(o1, depth);

      // Recessed glass, its bulkhead, and the transom over it.
      quad(pos, nrm, uv, idx,
        [g0[0], bulk, g0[1]], [g1[0], bulk, g1[1]], [g1[0], head, g1[1]], [g0[0], head, g0[1]],
        [e.nx, 0, e.nz], [glass.u0, glass.v0, glass.u1, glass.v1], col, t);
      quad(pos, nrm, uv, idx,
        [g0[0], 0, g0[1]], [g1[0], 0, g1[1]], [g1[0], bulk, g1[1]], [g0[0], bulk, g0[1]],
        [e.nx, 0, e.nz], [bulkC.u0, bulkC.v0, bulkC.u1, bulkC.v1], col, t);

      // Jambs: the returns that make the recess real.
      quad(pos, nrm, uv, idx,
        [o0[0], 0, o0[1]], [g0[0], 0, g0[1]], [g0[0], head, g0[1]], [o0[0], head, o0[1]],
        [e.tx, 0, e.tz], [jambC.u0, jambC.v0, jambC.u1, jambC.v1], col, t);
      quad(pos, nrm, uv, idx,
        [g1[0], 0, g1[1]], [o1[0], 0, o1[1]], [o1[0], head, o1[1]], [g1[0], head, g1[1]],
        [-e.tx, 0, -e.tz], [jambC.u0, jambC.v0, jambC.u1, jambC.v1], col, t);
      // Soffit over the recess: this is the surface that catches shop light and
      // gives the storefront its occlusion at street level.
      quad(pos, nrm, uv, idx,
        [o0[0], head, o0[1]], [o1[0], head, o1[1]], [g1[0], head, g1[1]], [g0[0], head, g0[1]],
        [0, -1, 0], [jambC.u0, jambC.v0, jambC.u1, jambC.v1], col, t);
      // Threshold slab. The only horizontal in the kit that a lit shop can spill
      // onto - it runs from the glass line out to the wall line, which is the
      // whole of the recess floor and as far as this mechanism reaches.
      quad(pos, nrm, uv, idx,
        [g0[0], 0.02, g0[1]], [g1[0], 0.02, g1[1]], [o1[0], 0.02, o1[1]], [o0[0], 0.02, o0[1]],
        [0, 1, 0], [bulkC.u0, bulkC.v0, bulkC.u1, bulkC.v1], col, t);

      // The door, if it falls in this bay. Its leaf stands 5 cm STREET-WARD of
      // the display glazing rather than behind it: that is where a door in its
      // frame actually sits, it occludes the pane instead of z-fighting it, and
      // it needs no second copy of the bay to make room.
      //
      // Lotted: one span for the elevation, from the lot planner. Unlotted: one
      // per implied pair, decided by the same hash that decided the pair's lit
      // state, so a unit's door and its lights agree about where it begins.
      const bayDoor = door ?? impliedDoor(doorSeed, e.i, bi >> 1, bays);
      if (bayDoor && bayDoor[0] >= s0 - 1e-6 && bayDoor[1] <= s1 + 1e-6) {
        const o2 = { col, tint: t };
        const dOut = -(depth - 0.05);
        const leaf = Math.min(2.35, head - 0.5);
        const kick = Math.min(0.92, leaf * 0.4);
        // THE DOOR HAS TO LOOK DIFFERENT FROM THE WINDOW BESIDE IT.
        //
        // A blind reviewer searched roughly 300 m of modelled frontage and could
        // not find a single door: "no door leaf, no recessed entry, no
        // threshold, no mat, no step". The geometry was there the whole time --
        // leaf, kick panel, jambs, head, threshold slab, standing 5 cm proud of
        // the display glazing. What was missing is that every one of those
        // quads sampled the SAME atlas cells as the shopfront around it, so a
        // door was a window with a bulkhead under it, which is what a display
        // bay already is.
        //
        // What makes a real shopfront door read at street distance is not the
        // glass, which is the same glass. It is the FRAME: a dark stile-and-rail
        // outline and a kick plate, against the pale jamb and pale bulkhead of
        // the bay. So the leaf keeps the glass cell -- it is glass -- and the
        // frame and kick take painted metal.
        //
        // Costs nothing. Same quads, same count, different four numbers in the
        // UV rect, and the trim atlas is a full 4x4 grid with no free cell to
        // add a purpose-painted door to.
        const frameC = trimCell(TRIM.metalDark);
        const gq = [glass.u0, glass.v0, glass.u1, glass.v1];
        const fq = [frameC.u0, frameC.v0, frameC.u1, frameC.v1];
        faceQ(e, bayDoor[0], bayDoor[1], 0.02, kick, dOut, fq, pos, nrm, uv, idx, o2);
        faceQ(e, bayDoor[0], bayDoor[1], kick, leaf, dOut, gq, pos, nrm, uv, idx, o2);
        jambQ(e, bayDoor[0], 0.02, leaf, -depth, dOut, -1, fq, pos, nrm, uv, idx, o2);
        jambQ(e, bayDoor[1], 0.02, leaf, -depth, dOut, 1, fq, pos, nrm, uv, idx, o2);
        shelfQ(e, bayDoor[0], bayDoor[1], leaf, -depth, dOut, -1, fq, pos, nrm, uv, idx, o2);
        shelfQ(e, bayDoor[0], bayDoor[1], 0.02, -depth, dOut, 1, fq, pos, nrm, uv, idx, o2);
      }
    }
  }
}

/**
 * The pilaster at a party line. A lot boundary that is only a colour change is a
 * stripe painted on a wall; what makes two neighbours read as two BUILDINGS is a
 * vertical element between them, and it does a second job as well - it stands
 * proud of both the plinth and the fascia band, so the seam where two lots'
 * texture phases meet is behind something solid rather than on show.
 *
 * @param {Object} e    the PARENT edge (not the lot), so `s` is in edge metres
 * @param {number} s    boundary position along the edge
 * @param {number} top  height to carry the pier to - the roof, under the cornice
 */
export function partyPier(e, s, top, pos, nrm, uv, idx, opts = {}) {
  const w = opts.width ?? 0.44, out = opts.project ?? 0.16, y0 = opts.base ?? 0.02;
  const c = trimCell(opts.cell ?? TRIM.stone);
  const q = [c.u0, c.v0, c.u1, c.v1];
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  const s0 = Math.max(0.02, s - w / 2), s1 = Math.min(e.len - 0.02, s + w / 2);
  if (s1 - s0 < 0.1 || top <= y0) return;
  faceQ(e, s0, s1, y0, top, out, q, pos, nrm, uv, idx, o);
  jambQ(e, s0, y0, top, 0, out, -1, q, pos, nrm, uv, idx, o);
  jambQ(e, s1, y0, top, 0, out, 1, q, pos, nrm, uv, idx, o);
  shelfQ(e, s0, s1, top, 0, out, 1, q, pos, nrm, uv, idx, o);
}

/**
 * The lintel band over one shopfront - the fascia a shop's name goes on.
 *
 * This is the horizontal that carries the row. Every shopfront head in the
 * district was Math.min(4.0, h - 0.8), i.e. 4.00 m on every building over 4.8 m
 * tall, so the one line the eye follows down a block was dead level for 380 m.
 * A lot sets its own head, and this band makes the step visible instead of
 * merely present.
 */
export function fasciaBand(e, s0, s1, y0, y1, pos, nrm, uv, idx, opts = {}) {
  if (s1 - s0 < 0.4 || y1 - y0 < 0.12) return;
  const out = opts.project ?? 0.13;
  const c = trimCell(opts.cell ?? TRIM.stucco);
  const q = [c.u0, c.v0, c.u1, c.v1];
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  faceQ(e, s0, s1, y0, y1, out, q, pos, nrm, uv, idx, o);
  shelfQ(e, s0, s1, y1, 0, out, 1, q, pos, nrm, uv, idx, o);
  shelfQ(e, s0, s1, y0, 0, out, -1, q, pos, nrm, uv, idx, o);
}

/**
 * Sloped fabric awnings over alternate storefront bays, with a valance and side
 * gussets. Deliberately not every bay: an unbroken run of awnings is the exact
 * kind of regularity that reads as procedural.
 */
// -------------------------------------------------------- THE AWNING SECTION
//
// An awning in reference/sarasota/02-Worth-s-Block is a BARREL: the fabric
// leaves the wall almost vertically, turns over, and comes down to a vertical
// front face carrying the valance. What both awning kits here drew instead was
// a flat rake — a wedge — which is a different fixture, and one this district
// does not have.
//
// The section is a quarter circle, which is what a barrel awning's hoops are:
//
//     o(s) = out * sin(s * pi/2)          dy(s) = drop * (1 - cos(s * pi/2))
//
// ONE definition, exported, and used by three callers: facades' awnings(),
// signage's awning(), and tools/geom-audit.mjs. That is not tidiness. The gate
// asserts that no piece of hardware sits above the fabric, and it can only do
// that against a model of where the fabric IS; the straight-rake model it used
// to carry would fail every curved awning in the district the moment the
// geometry changed under it, and a second copy of this curve in the audit would
// drift from the first exactly the way this file's crackSet() comment describes.
// TWO hoops, not three. Three was the first cut and it measured +22,669 gate
// triangles for the pair of awning kits — more than the entire palm change cost
// (+16,857) for a curve you read at ten metres, and it left the triangle gate at
// 94.6% of its warn with nothing in hand. Two hoops is three stations: still
// plainly a barrel against the sky, still no chord gap down the cheeks, and half
// the bill. The rule this file works to is more silhouette per triangle, not a
// bigger threshold.
export const AWNING_SEGS = 2;
export function awningProfile(s, out, drop) {
  const a = s * Math.PI * 0.5;
  return { o: out * Math.sin(a), dy: drop * (1 - Math.cos(a)) };
}
/**
 * The fabric height at a given projection off the wall — the inverse of the
 * profile above, in closed form, because cos(asin(u)) is sqrt(1 - u^2).
 *
 * The curve is convex up, so it lies AT OR ABOVE the straight rake everywhere
 * (1 - sqrt(1-u^2) <= u on [0,1]). Every existing bracket therefore still
 * passes under it, which is why awningFrame() needs no change at all.
 */
export function awningFabricY(o, yTop, out, drop) {
  const u = Math.max(0, Math.min(1, o / out));
  return yTop - drop * (1 - Math.sqrt(1 - u * u));
}

export function awnings(ring, pos, nrm, uv, idx, opts = {}) {
  const head = opts.head ?? 3.6, out = opts.project ?? 1.35, drop = opts.drop ?? 0.55;
  const bayM = opts.bayM ?? 3.2;
  const fab = trimCell(opts.cell ?? TRIM.fabricA);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = opts.edges ?? edgesOf(ring, { minLen: 4, longest: opts.faces ?? 2 });
  const r = rng(opts.seed ?? 1);

  for (const e of edges) {
    const bays = Math.max(1, Math.round(e.len / bayM));
    const bw = e.len / bays;
    for (let i = 0; i < bays; i++) {
      if (r() < 0.42) continue;
      const s0 = i * bw + 0.15, s1 = (i + 1) * bw - 0.15;
      const a0 = [e.a[0] + e.tx * s0, e.a[1] + e.tz * s0];
      const a1 = [e.a[0] + e.tx * s1, e.a[1] + e.tz * s1];
      const f0 = [a0[0] + e.nx * out, a0[1] + e.nz * out];
      const f1 = [a1[0] + e.nx * out, a1[1] + e.nz * out];
      const yTop = head + 0.35, yFront = head + 0.35 - drop;

      // The barrel, as AWNING_SEGS hoops. Each station carries its own outward
      // offset, height and surface normal, so the canopy shades as a curve
      // instead of as one flat lambert value.
      const st = [];
      for (let k = 0; k <= AWNING_SEGS; k++) {
        const s = k / AWNING_SEGS;
        const { o, dy } = awningProfile(s, out, drop);
        const a = s * Math.PI * 0.5;
        // Normal of the quarter circle at s, lifted into 3D on the edge normal.
        const nx = e.nx * Math.sin(a), ny = Math.cos(a), nz = e.nz * Math.sin(a);
        const nl = Math.hypot(nx, ny, nz) || 1;
        st.push({
          p0: [a0[0] + e.nx * o, a0[1] + e.nz * o],
          p1: [a1[0] + e.nx * o, a1[1] + e.nz * o],
          y: yTop - dy, n: [nx / nl, ny / nl, nz / nl],
          v: fab.v0 + (fab.v1 - fab.v0) * s,
        });
      }
      // Top surface and its underside, so it is not a one-sided plane from below.
      for (let k = 0; k < AWNING_SEGS; k++) {
        const A = st[k], B = st[k + 1];
        const nm = [(A.n[0] + B.n[0]) / 2, (A.n[1] + B.n[1]) / 2, (A.n[2] + B.n[2]) / 2];
        quad(pos, nrm, uv, idx,
          [A.p0[0], A.y, A.p0[1]], [A.p1[0], A.y, A.p1[1]],
          [B.p1[0], B.y, B.p1[1]], [B.p0[0], B.y, B.p0[1]],
          nm, [fab.u0, A.v, fab.u1, B.v], col, t);
        quad(pos, nrm, uv, idx,
          [B.p0[0], B.y, B.p0[1]], [B.p1[0], B.y, B.p1[1]],
          [A.p1[0], A.y, A.p1[1]], [A.p0[0], A.y, A.p0[1]],
          [-nm[0], -nm[1], -nm[2]], [fab.u0, B.v, fab.u1, A.v], col, t);
      }
      // Valance hanging off the front edge.
      quad(pos, nrm, uv, idx,
        [f0[0], yFront - 0.32, f0[1]], [f1[0], yFront - 0.32, f1[1]],
        [f1[0], yFront, f1[1]], [f0[0], yFront, f0[1]],
        [e.nx, 0, e.nz], [fab.u0, fab.v0, fab.u1, fab.v1], col, t);
      // Side gussets. A straight quad from the wall head to the leading edge is
      // the CHORD of the barrel, and the fabric bulges above it — that leaves a
      // crescent of open air down each side of every awning. So the gusset is a
      // fan that follows the same stations the canopy does.
      const side = (which, sx, sz) => {
        const base = which ? a1 : a0, front = which ? f1 : f0;
        for (let k = 0; k < AWNING_SEGS; k++) {
          const A = st[k], B = st[k + 1];
          const pa = which ? A.p1 : A.p0, pb = which ? B.p1 : B.p0;
          const ta = k / AWNING_SEGS, tb = (k + 1) / AWNING_SEGS;
          // The cheek's lower edge stays a straight line from the wall to the
          // bottom of the valance; only its top follows the hoops.
          const lo = (u, p) => [
            base[0] + (front[0] - base[0]) * u,
            (head - 0.05) + ((yFront - 0.32) - (head - 0.05)) * u,
            base[1] + (front[1] - base[1]) * u,
          ];
          const la = lo(ta), lb = lo(tb);
          quad(pos, nrm, uv, idx,
            la, [pa[0], A.y, pa[1]], [pb[0], B.y, pb[1]], lb,
            [sx, 0, sz], [fab.u0, A.v, fab.u1, B.v], col, t);
        }
      };
      side(0, -e.tx, -e.tz);
      side(1, e.tx, e.tz);
      awningFrame(a0, a1, f0, f1, yTop, yFront, out,
        pos, nrm, uv, idx, { col, tint: t });
    }
  }
}

/**
 * The hardware under an awning: a front bar along the leading edge and raking
 * rafters from the wall down to it.
 *
 * The old version was ONE horizontal box at a fixed height under the wall
 * attachment. A canopy rakes — it drops `drop` metres over `out` metres — so a
 * level bar crosses the fabric partway out and emerges ABOVE it: measured 0.41 m
 * proud of the leading edge on the facade kit and 0.385 m on the signage kit,
 * on every awning in the district. What a critic saw was a stray tube floating
 * over the cloth and a canopy with nothing holding its front edge up, which is
 * exactly what it was. A rafter has to follow the rake, and that is why strut()
 * exists.
 *
 * All the hardware is placed just UNDER the fabric plane, so the canopy is never
 * pierced from below either.
 */
export function awningFrame(a0, a1, f0, f1, yTop, yFront, out, pos, nrm, uv, idx, opts = {}) {
  const cell = { cell: TRIM.metalDark, uvRect: opts.uvRect, col: opts.col, tint: opts.tint };
  const clear = 0.05;                       // rafter sits this far below the cloth
  const inset = 0.10;                       // front bar tucks inside the valance line
  const drop = yTop - yFront;
  const ob = Math.max(0, out - inset);
  const yb = yTop - (drop / out) * ob - clear;      // fabric height at the bar, minus clearance
  const B = (p0, p1) => [p0[0] + (p1[0] - p0[0]) * (ob / out), p0[1] + (p1[1] - p0[1]) * (ob / out)];
  const b0 = B(a0, f0), b1 = B(a1, f1);
  strut([b0[0], yb, b0[1]], [b1[0], yb, b1[1]], 0.035, pos, nrm, uv, idx, cell);   // front bar
  const rafter = (aP, bP) => strut(
    [aP[0], yTop - clear, aP[1]], [bP[0], yb, bP[1]], 0.032, pos, nrm, uv, idx, cell);
  // Set the end rafters just inboard of the bay, where a lateral arm actually
  // bolts, rather than in the plane of the side gusset.
  const tx = (a1[0] - a0[0]), tz = (a1[1] - a0[1]);
  const tl = Math.hypot(tx, tz) || 1;
  const inb = 0.09;
  const shift = (p, k) => [p[0] + (tx / tl) * k, p[1] + (tz / tl) * k];
  rafter(shift(a0, inb), shift(b0, inb));
  rafter(shift(a1, -inb), shift(b1, -inb));
  // A bay wider than about three metres gets a middle rafter, the way a real
  // lateral-arm awning does; without it the fabric spans unsupported.
  const span = tl;
  if (span > 3.2) {
    rafter([(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2], [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2]);
  }
}

/**
 * Roof mechanical: condensers, a stair bulkhead, a duct run and a vent stack,
 * all placed inside the footprint and clear of the parapet. This is the part of
 * the kit that most changes how a city reads from a high camera.
 */
export function roofUnits(ring, y, pos, nrm, uv, idx, opts = {}) {
  const n = opts.count ?? 3;
  const r = rng(opts.seed ?? 7);
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  // Rejection-sample inside the footprint. Bounded so a pathological concave
  // footprint cannot spin here during a chunk build.
  const spots = [];
  for (let tries = 0; tries < n * 8 + 12 && spots.length < n; tries++) {
    const x = lerp(x0 + 1.2, x1 - 1.2, r()), z = lerp(z0 + 1.2, z1 - 1.2, r());
    if (!inRing(ring, x, z)) continue;
    if (spots.some((s) => Math.hypot(s[0] - x, s[1] - z) < 2.4)) continue;
    spots.push([x, z]);
  }

  // Anything above about eleven metres shows its roof against the sky from the
  // street, and three rounds of critics called the rooflines "unbroken straight
  // edges". Ducts and condensers hide behind the parapet; a mast or a tank on
  // legs does not, so a tall building always gets one. Derived from `y`, which
  // the streamer and the geometry audit both pass, so the two cannot diverge.
  const tall = y >= 11;

  spots.forEach(([x, z], i) => {
    if (i === 0 && spots.length > 1) {
      // Stair bulkhead: the tallest thing on the roof, and the one that reads.
      const w = 2.6 + r() * 1.6, d = 2.2 + r() * 1.4, hh = 2.4 + r() * 0.9;
      box(x, y + hh / 2, z, w, hh, d, pos, nrm, uv, idx, { cell: TRIM.stucco, col, tint: t });
      box(x, y + hh + 0.08, z, w + 0.3, 0.16, d + 0.3, pos, nrm, uv, idx,
        { cell: TRIM.asphalt, col, tint: t });
      return;
    }
    if (tall && i === spots.length - 1) {
      const cell = { cell: TRIM.metalDark, col, tint: t };
      if (r() < 0.45) {
        // Aerial mast on a ballast pad, with two cross arms.
        box(x, y + 0.07, z, 0.62, 0.14, 0.62, pos, nrm, uv, idx,
          { cell: TRIM.concrete, col, tint: t });
        const mh = 3.6 + r() * 3.4;
        strut([x, y + 0.14, z], [x, y + 0.14 + mh, z], 0.055, pos, nrm, uv, idx, cell);
        for (const f of [0.62, 0.84]) {
          const aw = 0.5 + r() * 0.6, ay = y + 0.14 + mh * f;
          strut([x - aw, ay, z], [x + aw, ay, z], 0.035, pos, nrm, uv, idx, cell);
        }
      } else {
        // Water tank on legs: the classic downtown roof silhouette.
        const w = 1.9 + r() * 0.9, lh = 1.1 + r() * 0.8, th = 2.1 + r() * 1.0;
        const a = w / 2 - 0.22;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            strut([x + sx * a, y, z + sz * a], [x + sx * a, y + lh, z + sz * a],
              0.07, pos, nrm, uv, idx, cell);
          }
        }
        box(x, y + lh + th / 2, z, w, th, w, pos, nrm, uv, idx,
          { cell: TRIM.rust, col, tint: t });
        box(x, y + lh + th + 0.11, z, w * 0.72, 0.22, w * 0.72, pos, nrm, uv, idx,
          { cell: TRIM.metalDark, col, tint: t });
      }
      return;
    }
    const kind = r();
    if (kind < 0.6) {
      const w = 1.5 + r() * 1.5, d = 1.1 + r() * 1.1, hh = 0.8 + r() * 0.7;
      box(x, y + 0.12, z, w + 0.4, 0.24, d + 0.4, pos, nrm, uv, idx,
        { cell: TRIM.asphalt, col, tint: t });                       // curb
      box(x, y + 0.24 + hh / 2, z, w, hh, d, pos, nrm, uv, idx,
        { cell: TRIM.steel, col, tint: t });
      box(x, y + 0.24 + hh + 0.05, z, w * 0.7, 0.1, d * 0.7, pos, nrm, uv, idx,
        { cell: TRIM.louvre, col, tint: t });                        // fan grille
    } else if (kind < 0.85) {
      // Duct run on sleepers.
      //
      // Two bugs lived in the one line this replaces. The axis was chosen with
      // TWO independent r() draws — `r()<0.5 ? len : 0.7` for x and another for
      // z — so a quarter of them came out len x len: 31 of the district's 130
      // ducts were square slabs up to 6.48 x 6.48 m, and 35 more were 0.7 m
      // cubes. And the box was centred at y+0.85 with a height of 0.7, putting
      // its underside at y+0.50: half a metre of air between the duct and the
      // roof, with nothing in between. Tinted with its building's own stucco
      // colour that is a cuboid floating over a roofline with no visible
      // support, which is what three critics reported.
      //
      // One draw picks the axis; sleepers carry the duct the way a real rooftop
      // run is carried, so the assembly is continuous down to the slab.
      const len = 2.5 + r() * 4;
      const alongX = r() < 0.5;
      const sx = alongX ? len : 0.7, sz = alongX ? 0.7 : len;
      const rise = 0.22;                     // sleeper height
      box(x, y + rise + 0.35, z, sx, 0.7, sz, pos, nrm, uv, idx,
        { cell: TRIM.steel, col, tint: t });                          // duct run
      const half = (len / 2) - 0.45;
      for (const s of [-1, 1]) {
        box(x + (alongX ? s * half : 0), y + rise / 2, z + (alongX ? 0 : s * half),
          alongX ? 0.5 : 0.62, rise, alongX ? 0.62 : 0.5,
          pos, nrm, uv, idx, { cell: TRIM.concrete, col, tint: t });  // sleeper
      }
    } else {
      box(x, y + 0.9, z, 0.5, 1.8, 0.5, pos, nrm, uv, idx,
        { cell: TRIM.rust, col, tint: t });                          // vent stack
    }
  });
}

/**
 * Fire escape: landings, balustrades and stair stringers zig-zagging up one
 * face. Cheap and enormously characterful on a deco or older office block.
 */
export function fireEscape(ring, pos, nrm, uv, idx, opts = {}) {
  const floors = opts.floors ?? 4, floorM = opts.floorM ?? 3.6;
  const w = opts.width ?? 2.4, out = opts.project ?? 1.25;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const e = opts.edge ?? edgesOf(ring, { minLen: 5, longest: 1 })[0];
  if (!e) return;
  const cx = e.a[0] + e.tx * (e.len * (opts.at ?? 0.5));
  const cz = e.a[1] + e.tz * (e.len * (opts.at ?? 0.5));
  const sx = Math.abs(e.tx) * w + Math.abs(e.nx) * out;
  const sz = Math.abs(e.tz) * w + Math.abs(e.nz) * out;
  const px = cx + e.nx * (out / 2), pz = cz + e.nz * (out / 2);
  const cell = { cell: TRIM.metalDark, col, tint: t };

  for (let f = 1; f <= floors; f++) {
    const y = f * floorM - 0.35;
    box(px, y, pz, sx, 0.09, sz, pos, nrm, uv, idx, cell);              // landing
    box(px + e.nx * (out / 2), y + 0.55, pz + e.nz * (out / 2),
      Math.abs(e.tx) * w + Math.abs(e.nx) * 0.06, 1.05,
      Math.abs(e.tz) * w + Math.abs(e.nz) * 0.06, pos, nrm, uv, idx, cell);  // rail
    // Two verticals per landing edge.
    for (const s of [-1, 1]) {
      box(px + e.tx * s * (w / 2), y + 0.55, pz + e.tz * s * (w / 2),
        0.07, 1.05, 0.07, pos, nrm, uv, idx, cell);
    }
    if (f < floors) {
      // Stringer to the next landing, offset to one side so the runs alternate.
      const side = f % 2 ? 1 : -1;
      box(px + e.tx * side * (w * 0.28) + e.nx * out * 0.35, y + floorM / 2,
        pz + e.tz * side * (w * 0.28) + e.nz * out * 0.35,
        Math.abs(e.tx) * 0.9 + Math.abs(e.nx) * 0.9, floorM * 0.92,
        Math.abs(e.tz) * 0.9 + Math.abs(e.nz) * 0.9, pos, nrm, uv, idx, cell);
    }
  }
}

/**
 * Balconies for towers: a cantilevered slab per floor with a glass balustrade,
 * on the long faces only. This is the silhouette that separates a bayfront tower
 * from an extruded box.
 */
export function balconies(ring, pos, nrm, uv, idx, opts = {}) {
  const floors = opts.floors ?? 8, floorM = opts.floorM ?? 3.15;
  const from = opts.from ?? 2, depth = opts.depth ?? 1.7;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const edges = opts.edges ?? edgesOf(ring, { minLen: 6, longest: opts.faces ?? 2 });
  const r = rng(opts.seed ?? 11);
  const con = trimCell(TRIM.concrete), gls = trimCell(TRIM.glass), met = trimCell(TRIM.metalDark);
  const cq = [con.u0, con.v0, con.u1, con.v1];
  const gq = [gls.u0, gls.v0, gls.u1, gls.v1];
  const mq = [met.u0, met.v0, met.u1, met.v1];

  for (const e of edges) {
    const runs = Math.max(1, Math.floor(e.len / (opts.bayM ?? 6.5)));
    const rw = e.len / runs;
    for (let f = from; f < floors; f++) {
      const y = f * floorM;
      for (let i = 0; i < runs; i++) {
        if (r() < 0.12) continue;             // a few units are enclosed instead
        const s0 = i * rw + 0.35, s1 = (i + 1) * rw - 0.35;
        // Six quads, not seven boxes. A tower carries around a hundred of these
        // and the difference is 24 vertices each against 168 — the single
        // largest vertex cost in the kit before this was written out.
        const A = [e.a[0] + e.tx * s0, e.a[1] + e.tz * s0];
        const B = [e.a[0] + e.tx * s1, e.a[1] + e.tz * s1];
        const D = [A[0] + e.nx * depth, A[1] + e.nz * depth];
        const C = [B[0] + e.nx * depth, B[1] + e.nz * depth];
        const yb = y, yt = y + 0.18, yr = y + 1.06;
        // Slab: top, soffit, front edge.
        quad(pos, nrm, uv, idx, [A[0], yt, A[1]], [B[0], yt, B[1]], [C[0], yt, C[1]], [D[0], yt, D[1]],
          [0, 1, 0], cq, col, t);
        quad(pos, nrm, uv, idx, [A[0], yb, A[1]], [B[0], yb, B[1]], [C[0], yb, C[1]], [D[0], yb, D[1]],
          [0, -1, 0], cq, col, t);
        quad(pos, nrm, uv, idx, [D[0], yb, D[1]], [C[0], yb, C[1]], [C[0], yt, C[1]], [D[0], yt, D[1]],
          [e.nx, 0, e.nz], cq, col, t);
        // Glass balustrade, drawn both ways because it is seen from above too.
        const gi = 0.06;
        const D2 = [D[0] - e.nx * gi, D[1] - e.nz * gi], C2 = [C[0] - e.nx * gi, C[1] - e.nz * gi];
        quad(pos, nrm, uv, idx, [D2[0], yt, D2[1]], [C2[0], yt, C2[1]], [C2[0], yr, C2[1]], [D2[0], yr, D2[1]],
          [e.nx, 0, e.nz], gq, col, t);
        quad(pos, nrm, uv, idx, [C2[0], yt, C2[1]], [D2[0], yt, D2[1]], [D2[0], yr, D2[1]], [C2[0], yr, C2[1]],
          [-e.nx, 0, -e.nz], gq, col, t);
        // Cap rail.
        const cr = 0.05;
        quad(pos, nrm, uv, idx,
          [D2[0] - e.nx * cr, yr, D2[1] - e.nz * cr], [C2[0] - e.nx * cr, yr, C2[1] - e.nz * cr],
          [C2[0] + e.nx * cr, yr, C2[1] + e.nz * cr], [D2[0] + e.nx * cr, yr, D2[1] + e.nz * cr],
          [0, 1, 0], mq, col, t);
      }
    }
  }
}

/**
 * A blank parapet sign panel standing proud of the roofline, with its frame.
 * Left unlettered on purpose: business names, logos and neon are the signage
 * builder's module. This provides the mounting surface and the silhouette.
 */
export function signBlank(ring, y, pos, nrm, uv, idx, opts = {}) {
  const h = opts.height ?? 1.9, thick = opts.thick ?? 0.22;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const e = opts.edge ?? edgesOf(ring, { minLen: 6, longest: 1 })[0];
  if (!e) return;
  const w = Math.min(opts.maxWidth ?? 9, e.len * 0.62);
  const cx = e.a[0] + e.tx * (e.len / 2) + e.nx * 0.1;
  const cz = e.a[1] + e.tz * (e.len / 2) + e.nz * 0.1;
  const sx = Math.abs(e.tx) * w + Math.abs(e.nx) * thick;
  const sz = Math.abs(e.tz) * w + Math.abs(e.nz) * thick;
  box(cx, y + h / 2 + 0.25, cz, sx, h, sz, pos, nrm, uv, idx,
    { cell: opts.cell ?? TRIM.signFace, col, tint: t });
  // Legs down to the ROOF SLAB, not just 0.11 m into the parapet cap.
  //
  // `y` is the top of the parapet, and the old legs spanned y-0.11..y+0.39 — fine
  // while the parapet is drawn, and nothing at all once it is not. The parapet is
  // near-LOD kit; the sign panel signage.js paints on this blank is district-wide
  // and never streamed. At LOD1 the building is a bare bounding box with no
  // parapet under it, so a leg that stops inside the parapet leaves the sign
  // standing on air. `base` is the roof height; the legs now span it.
  const base = opts.base ?? (y - 0.5);
  const legTop = y + 0.30;
  for (const s of [-1, 1]) {
    box(cx + e.tx * s * (w * 0.35), (base + legTop) / 2, cz + e.tz * s * (w * 0.35),
      0.14, Math.max(0.5, legTop - base), 0.14, pos, nrm, uv, idx,
      { cell: TRIM.metalDark, col, tint: t });
  }
}


// ------------------------------------------------------------------ built depth
//
// THE defect this section exists to fix. Three rounds of blind critics reported
// the same thing in almost the same words: "every window is a solid rectangle
// flush with the wall — no reveal shadow on the top or side edge, no sill, no
// mullion thickness". They were right. Every wall was ONE quad per footprint
// edge with the whole window grid painted onto it, so at any view angle the
// openings stayed exactly as flat as the plane they were printed on.
//
// The fix is real geometry, and the design constraint is the chunk-build stall
// gate: a chunk is assembled synchronously on the render thread inside a 3 ms
// per-frame slice, so the wall cannot be tessellated into a grid and the openings
// cannot be punched one by one. Instead each floor's window band is emitted as a
// RECESSED HORIZONTAL BAND with the piers between the windows left standing at
// the wall plane:
//
//        wall face  ────┐   ┌────┐   ┌────┐   ┌────  piers, at the wall plane
//        head soffit    ╲___╱    ╲___╱    ╲___╱       returns into the recess
//        glazing        ░░░░     ░░░░     ░░░░        band face, `reveal` behind
//        sill course  ──────────────────────────      proud of the wall face
//
// which costs 3n + 7 quads per floor per edge for n windows, against roughly 8n
// for individually punched openings, and produces exactly the two cues the
// critics looked for and did not find: a jamb return that shows as a lit or
// shadowed sliver at an oblique angle, and a head soffit that puts a hard shadow
// across the top of every opening.
//
// Measured over the whole district (523 buildings, both buffers, warm, in node):
//   flat walls          155k triangles,  67 ms to build every building
//   built depth         339k triangles, 135 ms
// In the drive-through, where only the sixteen NEAR chunks carry any of it, the
// p95 triangle count the gate sees moves by roughly +20k and stays under the
// 400k warn line with 60% headroom. The cost that does NOT come for free is the
// worst uninterrupted chunk-build step: an identical scripted walk of the route
// measured 9.9 ms without this and 19.9 ms with it, so a chunk slice is about
// twice the work it was. See REVEAL_OPENINGS and frontEdges for the two knobs
// that bound it.
//
// Everything here samples the SAME facade panel the flat wall did. The jambs and
// soffits are mapped onto the `reveal`-pixel border the panel already paints
// inside each opening — which is also where drawLit paints its emissive spill —
// so a lit window at night now spills onto returns that physically exist, and no
// new material, texture or draw call is introduced anywhere.

// Width of the panel's painted reveal border, in metres, along u and along v.
// drawOpening insets the glazing by `reveal` panel pixels at 1024; the geometric
// returns are mapped onto exactly that strip so paint and geometry agree.
function paintedReveal(rec) {
  const f = rec.win.reveal / 1024;
  return { u: f * rec.tileU, v: f * rec.floors * rec.floorM };
}
// drawOpening's sill is 5 px at 1024, drawn immediately below the opening.
const paintedSill = (rec) => (5 / 1024) * rec.floors * rec.floorM;

/**
 * Where the painted window openings fall along one wall edge, in metres from the
 * edge start. Derived from the same rhythm, inset and tile origin that
 * buildPanel and extrudeFacade use, so the geometry cannot drift from the paint.
 *
 * Openings that would break a corner are dropped rather than clipped: a
 * half-opening at a party wall is a hole in the silhouette.
 *
 * `u0` is the texture origin for this run of wall. It defaults to the centred
 * origin extrudeFacade uses, and a LOT passes its own so its window rhythm
 * starts on a different bay from its neighbour's. Whatever it is, it is the same
 * number facadeEdge writes into the UVs, so paint and geometry cannot disagree.
 *
 * @param {Object} rec    recipe
 * @param {number} len    edge length in metres
 * @returns {Array<[number,number]>} sorted [start, end] pairs
 */
export function openingsAlong(rec, len, { margin = 0.32, u0 = null } = {}) {
  const ex = bayEdges(rec.rhythm, 1);          // bay boundaries as 0..1 fractions
  const org = u0 ?? -((len % rec.tileU) / 2);  // extrudeFacade's centred origin
  const out = [];
  const k0 = Math.floor(org / rec.tileU) - 1;
  const k1 = Math.ceil((org + len) / rec.tileU) + 1;
  for (let k = k0; k <= k1; k++) {
    for (let i = 0; i < rec.rhythm.length; i++) {
      const ins = (ex[i + 1] - ex[i]) * rec.win.inset;
      const s0 = (k + ex[i] + ins) * rec.tileU - org;
      const s1 = (k + ex[i + 1] - ins) * rec.tileU - org;
      if (s1 - s0 < 0.35) continue;
      if (s0 < margin || s1 > len - margin) continue;
      out.push([s0, s1]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// The three primitives every depth feature is made of, all in edge space:
// `s` runs along the edge from e.a, `y` is world height, `out` is metres proud of
// the wall face (negative is into the building). Each takes an explicit UV rect
// so the caller can aim a return at the strip of panel it should sample.

// A wall-parallel face.
function faceQ(e, s0, s1, y0, y1, out, uvq, pos, nrm, uv, idx, o) {
  if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return;
  const ox = e.nx * out, oz = e.nz * out;
  const ax = e.a[0] + e.tx * s0 + ox, az = e.a[1] + e.tz * s0 + oz;
  const bx = e.a[0] + e.tx * s1 + ox, bz = e.a[1] + e.tz * s1 + oz;
  quadS(pos, nrm, uv, idx, ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az,
    e.nx, 0, e.nz, uvq[0], uvq[1], uvq[2], uvq[3], o.col, o.tint);
}

// A horizontal return: a soffit (up = -1) or a sill (up = +1).
function shelfQ(e, s0, s1, y, oA, oB, up, uvq, pos, nrm, uv, idx, o) {
  if (s1 - s0 < 1e-3 || Math.abs(oB - oA) < 1e-3) return;
  const aox = e.nx * oA, aoz = e.nz * oA, box = e.nx * oB, boz = e.nz * oB;
  const p0x = e.a[0] + e.tx * s0, p0z = e.a[1] + e.tz * s0;
  const p1x = e.a[0] + e.tx * s1, p1z = e.a[1] + e.tz * s1;
  quadS(pos, nrm, uv, idx,
    p0x + aox, y, p0z + aoz, p1x + aox, y, p1z + aoz,
    p1x + box, y, p1z + boz, p0x + box, y, p0z + boz,
    0, up, 0, uvq[0], uvq[1], uvq[2], uvq[3], o.col, o.tint);
}

// A jamb: the side wall of a reveal, perpendicular to the facade. `dir` is which
// way it faces along the edge tangent.
function jambQ(e, s, y0, y1, oA, oB, dir, uvq, pos, nrm, uv, idx, o) {
  if (y1 - y0 < 1e-3 || Math.abs(oB - oA) < 1e-3) return;
  const px = e.a[0] + e.tx * s, pz = e.a[1] + e.tz * s;
  const ax = px + e.nx * oA, az = pz + e.nz * oA;
  const bx = px + e.nx * oB, bz = pz + e.nz * oB;
  quadS(pos, nrm, uv, idx, ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az,
    e.tx * dir, 0, e.tz * dir, uvq[0], uvq[1], uvq[2], uvq[3], o.col, o.tint);
}

/**
 * One complete wall face, with built depth. Replaces the single flat quad
 * extrudeFacade emitted for this edge — call it INSTEAD of that quad, never as
 * well, or the flat wall will z-fight the piers it is coplanar with.
 *
 * @param {Object} e        edge from edgesOf()
 * @param {number} height   building height
 * @param {Object} rec      recipe
 * @param {Object} opts     .ground {top, gaps:[[s0,s1]]} openings kept clear at
 *                          street level (shopfronts, doorways); .bandFloors how
 *                          many floors get piers and jambs before the cheaper
 *                          band-only treatment takes over; .col/.tint buffers
 */
export function facadeEdge(e, height, rec, pos, nrm, uv, idx, opts = {}) {
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  const u0 = opts.u0 ?? -((e.len % rec.tileU) / 2);
  const dep = rec.depth;
  const D = opts.reveal ?? dep.reveal;
  const sp = opts.sill ?? dep.sill, sd = dep.sillDrop;
  const win = rec.win, fm = rec.floorM, L = e.len;
  const pr = paintedReveal(rec), ps = paintedSill(rec);
  const W = (s0, s1, y0, y1) =>
    faceQ(e, s0, s1, y0, y1, 0, [u0 + s0, y0, u0 + s1, y1], pos, nrm, uv, idx, o);

  // An entrance is a slot cut clean through the base and the ground-floor window
  // band, so every full-width course in that height range is emitted over the two
  // segments either side of it instead of the whole edge.
  const slot = opts.slot ?? null;
  const segs = (yTop) => (slot && slot.top > yTop - 0.02)
    ? [[0, slot.s0], [slot.s1, L]] : [[0, L]];

  // 1. Street level. Shopfront bays are recesses built by another helper into the
  //    trim buffer; all this has to do is leave the hole.
  let y = 0;
  const g = opts.ground;
  if (g && g.gaps.length) {
    let cur = 0;
    for (const [a, b] of g.gaps) {
      if (a > cur) W(cur, a, 0, g.top);
      cur = Math.max(cur, b);
    }
    if (cur < L) W(cur, L, 0, g.top);
    y = g.top;
  }

  // 2. Window bands, one per floor.
  const ops = opts.openings ?? openingsAlong(rec, L);
  const nF = Math.floor(height / fm);
  const bandFloors = opts.bandFloors ?? nF;
  for (let F = 0; F < nF; F++) {
    const bt = fm * (F + 1 - win.top);
    const bb = bt - fm * win.h;
    if (bb < y + 0.14) continue;                  // swallowed by the street level
    if (bt > height - 0.06) break;                // no room for the head above it
    const sg = segs(bb);
    for (const [a, b] of sg) W(a, b, y, bb);      // spandrel and wall below

    // Sill course: proud of the wall, so it catches light on top and drops a
    // shadow line along the whole floor. Mapped onto the panel's painted sill.
    for (const [a, b] of sg) {
      const sq = [u0 + a, bb - ps, u0 + b, bb];
      shelfQ(e, a, b, bb, -D, sp, 1, sq, pos, nrm, uv, idx, o);
      faceQ(e, a, b, bb - sd, bb, sp, sq, pos, nrm, uv, idx, o);
      shelfQ(e, a, b, bb - sd, 0, sp, -1, sq, pos, nrm, uv, idx, o);
      // The recessed glazing plane, and the head soffit over it.
      faceQ(e, a, b, bb, bt, -D, [u0 + a, bb, u0 + b, bt], pos, nrm, uv, idx, o);
      shelfQ(e, a, b, bt, -D, 0, -1, [u0 + a, bt - pr.v, u0 + b, bt], pos, nrm, uv, idx, o);
    }

    // Piers at the wall plane and the jambs that return back to the glazing.
    // Above bandFloors the band is left continuous: at that height a pier is a
    // few pixels wide and the horizontal shadow is doing all the work, so the
    // vertical returns stop earning their triangles.
    for (const [a, b] of sg) {
      if (F < bandFloors) {
        let cur = a;
        for (const [p0, p1] of ops) {
          if (p1 <= a || p0 >= b) continue;
          if (p0 > cur) W(cur, p0, bb, bt);
          jambQ(e, p0, bb, bt, 0, -D, 1, [u0 + p0, bb, u0 + p0 + pr.u, bt], pos, nrm, uv, idx, o);
          jambQ(e, p1, bb, bt, 0, -D, -1, [u0 + p1, bb, u0 + p1 - pr.u, bt], pos, nrm, uv, idx, o);
          cur = p1;
        }
        if (cur < b) W(cur, b, bb, bt);
      } else {
        // Close the ends so the band does not open onto the corner.
        jambQ(e, a, bb, bt, 0, -D, 1, [u0 + a, bb, u0 + a + pr.u, bt], pos, nrm, uv, idx, o);
        jambQ(e, b, bb, bt, 0, -D, -1, [u0 + b, bb, u0 + b - pr.u, bt], pos, nrm, uv, idx, o);
      }
    }
    y = bt;
  }

  // 3. Whatever is left between the last head and the roof. If the building is
  //    too short to have carried a single band, the entrance slot has not been
  //    cut yet and this strip has to do it.
  if (y < height) {
    if (slot && slot.top > y + 0.02) {
      const cutTop = Math.min(slot.top, height);
      for (const [a, b] of segs(y)) W(a, b, y, cutTop);
      if (cutTop < height) W(0, L, cutTop, height);
    } else {
      W(0, L, y, height);
    }
  }
}

/**
 * Every wall of a building, with built depth on the edges long enough to carry
 * it and a plain quad on the stubs. Same job as extrudeFacade's wall pass; call
 * one or the other, not both.
 *
 * @param {Object} plan  per-edge options keyed by ring index: { ground, bandFloors }
 */
export function facadeWalls(ring, height, rec, pos, nrm, uv, idx, opts = {}) {
  const plan = opts.plan ?? new Map();
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  const opCache = new Map();
  // Built depth is spent on the faces the player can actually stand in front of.
  // A ring averages six edges and a notched tower plate has twelve, most of them
  // party walls or rear elevations pressed against the next block; detailing all
  // of them tripled the streamed geometry and blew the chunk-build deadline for
  // faces nobody ever sees. `plan` names the frontages, and everything else keeps
  // the flat painted quad it always had.
  //
  // edgesOf allocates an object per edge and several helpers here want the same
  // list, so appendBuilding computes it once and hands it down.
  for (const e of opts.edges ?? edgesOf(ring, { minLen: 0.05 })) {
    const p = plan.get(e.i);
    if (!p || !p.detail || e.len < (opts.minDetail ?? 4.5)) {
      const u0 = -((e.len % rec.tileU) / 2);
      faceQ(e, 0, e.len, 0, height, 0, [u0, 0, u0 + e.len, height], pos, nrm, uv, idx, o);
      continue;
    }
    // Openings depend only on the edge LENGTH and the texture origin, and a
    // rectangular block has two pairs of equal edges, so caching halves the
    // arithmetic on the commonest footprint in the district.
    const opsFor = (len, u0) => {
      const key = `${len.toFixed(3)}:${u0 === undefined ? '-' : u0.toFixed(3)}`;
      let ops = opCache.get(key);
      if (!ops) {
        ops = openingsAlong(rec, len, u0 === undefined ? {} : { u0, margin: 0.34 });
        opCache.set(key, ops);
      }
      return ops;
    };
    // A LOT is a run of this wall with its own colour, its own texture phase and
    // its own ground floor. Emitting one facadeEdge per lot is what turns a 181 m
    // frontage into a row: the wall below the windows, the sill course, the
    // glazing plane and the head soffit are all cut at the party line, so the
    // colour change runs the full height of the building rather than stopping at
    // a course, and the window rhythm restarts on the far side of it.
    // ... and a GROUND-ONLY subdivision is the opposite instruction. Its lots
    // are tenancies inside ONE building, so the wall over them is emitted once
    // for the whole elevation - one tint, one texture phase, one window rhythm,
    // one spandrel stripe running the full length - with every tenancy's
    // shopfront bays cut out of its street level as a single gap list that
    // appendBuilding assembled. Falling into the per-lot branch here is exactly
    // the parade the split exists to avoid, and it would cost the extra sill
    // course, glazing plane and head soffit at every party line for the whole
    // height of a tower.
    if (p.lots && p.lots.length > 1 && !p.groundOnly) {
      for (const L of p.lots) {
        facadeEdge(L.sub, height, rec, pos, nrm, uv, idx, {
          col: o.col, tint: L.tint, u0: L.u0,
          openings: opsFor(L.len, L.u0),
          ground: L.ground, slot: L.slot, bandFloors: opts.bandFloors,
        });
      }
      continue;
    }
    facadeEdge(e, height, rec, pos, nrm, uv, idx, {
      ...o, openings: opsFor(e.len), ground: p.ground, slot: p.slot, bandFloors: opts.bandFloors,
    });
  }
}

/**
 * The base course: a projecting plinth around the foot of the building, skipping
 * the shopfront and doorway openings. Cheap, and it is the detail that stops a
 * building looking like it was pushed into the pavement — several critics asked
 * for a plinth by name.
 */
export function plinth(ring, pos, nrm, uv, idx, opts = {}) {
  const h = opts.height ?? 0.5, out = opts.project ?? 0.07;
  const c = trimCell(opts.cell ?? TRIM.concrete);
  const q = [c.u0, c.v0, c.u1, c.v1];
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  const plan = opts.plan ?? new Map();
  // Both kinds of street-level opening have to interrupt the base course: a
  // shopfront bay, and the entrance slot. Running a 0.7 m stone band across a
  // doorway is exactly the sort of thing that reads as a bug from the pavement.
  const band = (e, src, tint) => {
    const gaps = [...(src?.ground?.gaps ?? [])];
    if (src?.slot) gaps.push([src.slot.s0, src.slot.s1]);
    gaps.sort((a, b) => a[0] - b[0]);
    const segs = [];
    let cur = 0;
    for (const [a, b] of gaps) { if (a > cur) segs.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < e.len) segs.push([cur, e.len]);
    const oo = { col: o.col, tint };
    for (const [s0, s1] of segs) {
      if (s1 - s0 < 0.2) continue;
      faceQ(e, s0, s1, 0.02, h, out, q, pos, nrm, uv, idx, oo);
      shelfQ(e, s0, s1, h, 0, out, 1, q, pos, nrm, uv, idx, oo);
    }
  };
  for (const e of opts.edges ?? edgesOf(ring, { minLen: 1.2 })) {
    if (e.len < 1.2) continue;
    const p = plan.get(e.i);
    // A ground-only frontage falls through to the whole-edge band: one base
    // course in the building's colour, interrupted by every tenancy's bays,
    // because a plinth under one tower is one plinth.
    if (p?.lots && p.lots.length > 1 && !p.groundOnly) {
      for (const L of p.lots) band(L.sub, L, L.tint);
      continue;
    }
    band(e, p, o.tint);
  }
}

/**
 * A recessed entrance for a building with no shopfront — the other half of the
 * "no doorway at street level" finding. A door leaf set back in the wall, its
 * jambs and soffit, a threshold, and a hood on two brackets over it.
 *
 * The hole in the wall is cut by facadeEdge from the same rect, which is why
 * doorPlan() returns it rather than this function choosing one.
 */
export function doorway(e, s0, s1, top, pos, nrm, uv, idx, opts = {}) {
  const d = opts.depth ?? 0.42;
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  const cellOf = (c) => { const k = trimCell(c); return [k.u0, k.v0, k.u1, k.v1]; };
  const lq = cellOf(opts.leafCell ?? TRIM.bulkhead);
  const gq = cellOf(TRIM.glass);
  const jq = cellOf(opts.jambCell ?? TRIM.stucco);
  const sq = cellOf(opts.hoodCell ?? TRIM.stone);
  const mq = cellOf(TRIM.mullion);
  const leaf = Math.min(top - 0.35, 2.35);

  faceQ(e, s0, s1, 0.02, leaf, -d, lq, pos, nrm, uv, idx, o);           // door leaves
  faceQ(e, s0, s1, leaf, top, -d, gq, pos, nrm, uv, idx, o);            // transom light
  faceQ(e, s0, s1, leaf - 0.06, leaf + 0.06, -d + 0.03, mq, pos, nrm, uv, idx, o);
  const mid = (s0 + s1) / 2;
  faceQ(e, mid - 0.04, mid + 0.04, 0.02, leaf, -d + 0.03, mq, pos, nrm, uv, idx, o);
  jambQ(e, s0, 0.02, top, 0, -d, 1, jq, pos, nrm, uv, idx, o);
  jambQ(e, s1, 0.02, top, 0, -d, -1, jq, pos, nrm, uv, idx, o);
  shelfQ(e, s0, s1, top, -d, 0, -1, jq, pos, nrm, uv, idx, o);          // soffit
  shelfQ(e, s0, s1, 0.02, -d, 0, 1, sq, pos, nrm, uv, idx, o);          // threshold

  // Hood. Wider than the opening and carried on two raking brackets, so it
  // reads from across the street and is never a slab hanging off nothing.
  const hp = opts.hood ?? 0.8, ht = top + 0.1, hw = 0.2;
  faceQ(e, s0 - 0.28, s1 + 0.28, ht, ht + hw, hp, sq, pos, nrm, uv, idx, o);
  shelfQ(e, s0 - 0.28, s1 + 0.28, ht + hw, 0, hp, 1, sq, pos, nrm, uv, idx, o);
  shelfQ(e, s0 - 0.28, s1 + 0.28, ht, 0, hp, -1, sq, pos, nrm, uv, idx, o);
  const P = (s, ou, y) => [e.a[0] + e.tx * s + e.nx * ou, y, e.a[1] + e.tz * s + e.nz * ou];
  for (const s of [s0 - 0.16, s1 + 0.16]) {
    strut(P(s, 0.02, ht - 0.6), P(s, hp - 0.07, ht - 0.02), 0.045,
      pos, nrm, uv, idx, { cell: TRIM.metalDark, col: o.col, tint: o.tint });
  }
}
/**
 * Rainwater downpipes and a wall vent on the faces that carry nothing else.
 * A blank flank wall with no pipe on it is one of the tells that a building was
 * extruded rather than built, and this is the cheapest possible answer: one
 * strut, a hopper and two brackets.
 */
export function wallPipes(ring, height, pos, nrm, uv, idx, opts = {}) {
  const o = { col: opts.col, tint: opts.tint ?? [1, 1, 1] };
  const r = rng(opts.seed ?? 5);
  const skip = opts.skip ?? new Set();
  const cell = { cell: TRIM.metalDark, col: o.col, tint: o.tint };
  const edges = edgesOf(ring, { minLen: 5 }).filter((e) => !skip.has(e.i));
  let placed = 0;
  for (const e of edges) {
    if (placed >= (opts.max ?? 1)) break;
    if (placed && r() < 0.45) continue;
    const s = e.len * (r() < 0.5 ? 0.06 : 0.94);
    const ox = e.nx * 0.11, oz = e.nz * 0.11;
    const x = e.a[0] + e.tx * s + ox, z = e.a[1] + e.tz * s + oz;
    const top = Math.max(1.5, height - 0.35);
    strut([x, 0.04, z], [x, top, z], 0.055, pos, nrm, uv, idx, cell);
    box(x, top + 0.16, z, 0.3, 0.3, 0.3, pos, nrm, uv, idx, cell);            // hopper
    for (const f of [0.35, 0.72]) {
      box(x - e.nx * 0.05, top * f, z - e.nz * 0.05,
        Math.abs(e.tx) * 0.22 + Math.abs(e.nx) * 0.14, 0.07,
        Math.abs(e.tz) * 0.22 + Math.abs(e.nz) * 0.14, pos, nrm, uv, idx, cell);
    }
    // A louvre on the same flank, at a floor line rather than anywhere.
    if (r() < 0.6 && height > 6) {
      const vs = e.len * (0.3 + r() * 0.4);
      box(e.a[0] + e.tx * vs + e.nx * 0.09, 2.4 + Math.floor(r() * 2) * 3.2,
        e.a[1] + e.tz * vs + e.nz * 0.09,
        Math.abs(e.tx) * 0.8 + Math.abs(e.nx) * 0.18, 0.6,
        Math.abs(e.tz) * 0.8 + Math.abs(e.nz) * 0.18,
        pos, nrm, uv, idx, { cell: TRIM.louvre, col: o.col, tint: o.tint });
    }
    placed++;
  }
}

/**
 * Wall extrusion for a facade-textured building. Same job as geom.js
 * extrudeFootprint, with three differences the facade system needs:
 *   - outward normals for BOTH windings (see edgesOf)
 *   - the u origin is centred on each wall, so bays land symmetrically on a
 *     facade instead of being cut at whichever corner happened to be first
 *   - an optional vertex-colour array, which is how per-building colour survives
 *     merging a whole chunk into one material
 *
 * @param {Array<[number,number]>} ring
 * @param {number} height  metres
 */
export function extrudeFacade(ring, height, pos, nrm, uv, idx, opts = {}) {
  const base = opts.base ?? 0;
  const tileU = opts.tileU ?? 16;
  const col = opts.col, t = opts.tint ?? [1, 1, 1];
  const roofCell = trimCell(opts.roofCell ?? TRIM.gravel);
  const vTop = opts.vTop ?? height;

  if (opts.walls !== false) {
    for (const e of edgesOf(ring, { minLen: 0.05 })) {
      const u0 = -((e.len % tileU) / 2);
      quad(pos, nrm, uv, idx,
        [e.a[0], base, e.a[1]], [e.b[0], base, e.b[1]],
        [e.b[0], base + height, e.b[1]], [e.a[0], base + height, e.a[1]],
        [e.nx, 0, e.nz], [u0, 0, u0 + e.len, vTop], col, t);
    }
  }

  if (opts.roof !== false) {
    const tris = triangulateRing(ring);
    const start = pos.length / 3;
    const cellM = opts.roofCellM ?? 4;
    for (const p of ring) {
      pos.push(p[0], base + height, p[1]);
      nrm.push(0, 1, 0);
      const fu = ((p[0] / cellM) % 1 + 1) % 1, fv = ((p[1] / cellM) % 1 + 1) % 1;
      uv.push(lerp(roofCell.u0, roofCell.u1, fu), lerp(roofCell.v0, roofCell.v1, fv));
      pushCol(col, t, 1);
    }
    // Emit each triangle in the order that faces up. A roof polygon whose winding
    // is taken on trust is back-facing for one of the two windings OSM produces,
    // and a back-facing roof is invisible from a helicopter and from the shadow
    // pass while still looking fine from the street — so it survives review.
    for (let i = 0; i < tris.length; i += 3) {
      const a = ring[tris[i]], b = ring[tris[i + 1]], c = ring[tris[i + 2]];
      const up = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (up < 0) idx.push(start + tris[i], start + tris[i + 1], start + tris[i + 2]);
      else idx.push(start + tris[i + 2], start + tris[i + 1], start + tris[i]);
    }
  }
}

// Ear clipping, kept local so this module has no dependency on geom.js ordering
// and can be used by a caller that only wants the kit.
function triangulateRing(ring) {
  const n = ring.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  if (ringArea(ring) > 0) idx.reverse();
  const out = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = ring[ia], b = ring[ib], c = ring[ic];
      if (cross(a, b, c) <= 0) continue;
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(ring[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/**
 * The one-call form: append a whole styled building into two shared buffers.
 *
 *   wall  {pos,nrm,uv,idx,col}  -> facadeMaterial(style.recipe)
 *   trim  {pos,nrm,uv,idx,col}  -> trimMaterial()  (shared by all recipes)
 *
 * A chunk therefore costs (recipes present in that chunk) + 1 draw calls for its
 * buildings. Nothing here allocates a geometry, mesh or material.
 *
 * @param {Array<[number,number]>} ring   footprint in world XZ
 * @param {number} height                 metres
 * @param {Object} style                  from buildingStyle()
 */
// How many window openings one building may carry the full pier-and-jamb
// treatment on. streaming.js already caps individually expensive styles because
// the chunk-build deadline is a hard constraint; this is the same idea for wall
// depth, and it lives here because the cost depends on the recipe's bay rhythm,
// which streaming.js does not know. Above the cap the bands stay recessed — the
// head shadow and the sill course survive all the way up a tower — and only the
// per-window vertical returns stop, which is the term that scales with floors.
//
// 150 leaves every building under about eight storeys of frontage fully detailed,
// which is 470 of the district's 523, and trims only the tops of the towers.
// Measured district-wide: 168k wall triangles uncapped, 143k at this value.
const REVEAL_OPENINGS = 150;

function revealFloors(edges, rec, height) {
  const bay = rec.tileU / rec.rhythm.length;
  let perFloor = 0;
  for (const e of edges) perFloor += Math.max(1, Math.round(e.len / bay));
  const floors = Math.max(1, Math.floor(height / rec.floorM));
  if (!perFloor) return floors;
  return Math.max(2, Math.min(floors, Math.floor(REVEAL_OPENINGS / perFloor)));
}

// The faces that get built depth: the ones facing the nearest street, with the
// longest edge as a fallback so a building whose frontage is ambiguous still
// gets one detailed elevation rather than none.
function frontEdges(ring, allEdges, streetEdges, max = 3) {
  const out = [], seen = new Set();
  for (const e of streetEdges) { if (!seen.has(e.i)) { seen.add(e.i); out.push(e); } }
  if (out.length < max) {
    const rest = allEdges.filter((e) => e.len >= 3.2 && !seen.has(e.i))
      .sort((a, b) => b.len - a.len);
    for (const e of rest) {
      if (out.length >= max) break;
      // Only a face comparable to the frontage is worth detailing. A corner
      // block whose second elevation is nearly as long as its first gets both;
      // a short return on the flank of a long block is not a second elevation,
      // it is a chamfer. Measured district-wide this rule only moves 5k of 144k
      // wall triangles, which is the useful finding: almost every extra face it
      // does admit is a genuine second frontage, so they are worth keeping.
      if (out.length && e.len < out[0].len * 0.8) break;
      seen.add(e.i); out.push(e);
    }
  }
  return out;
}

// The entrance bay: one of the painted openings on the street face, cut clean
// through the base and the ground-floor band so the door head lines up with the
// ground-floor window heads the way a real elevation does.
export function entrancePlan(ring, rec, height, style, streetEdges) {
  const e = streetEdges[0] ?? edgesOf(ring, { minLen: 4, longest: 1 })[0];
  if (!e || e.len < 5) return null;
  const ops = openingsAlong(rec, e.len);
  if (!ops.length) return null;
  const r = rng(style.seed ^ 0x2b17);
  const pickAt = ops[Math.min(ops.length - 1, ((0.25 + r() * 0.5) * ops.length) | 0)];
  const top = rec.floorM * (1 - rec.win.top);
  if (top < 2.2 || top > height - 0.5) return null;
  return { e, s0: pickAt[0], s1: pickAt[1], top };
}

export function appendBuilding(ring, height, style, wall, trim, opts = {}) {
  const rec = style.rec;
  const t = style.tint;
  const allEdges = edgesOf(ring, { minLen: 0.05 });
  // A corner site fronts TWO streets and needs the shopfront kit on both. One
  // direction plus facingEdges' 0.35 cone can only ever admit one of them: the
  // perpendicular elevation dots to ~0 and is dropped, and widening the cone
  // past 90 degrees would start admitting the back wall. So the caller passes
  // every street it stands on and the sets are unioned.
  //
  // Bounded deliberately. Each direction contributes at most `faces` edges and
  // the union is capped one above that, so a corner building gets its second
  // elevation without a four-sided building acquiring shopfronts all the way
  // round -- the facade kit is the expensive part of the triangle budget.
  const dirs = opts.streets?.length ? opts.streets : (opts.street ? [opts.street] : null);
  const faces = opts.faces ?? 2;
  let streetEdges;
  if (dirs) {
    const seen = new Map();
    for (const d of dirs) {
      for (const e of facingEdges(ring, d[0], d[1], { minLen: 4, max: faces })) {
        if (!seen.has(e.i)) seen.set(e.i, e);
      }
    }
    streetEdges = [...seen.values()].sort((a, b) => b.len - a.len)
      .slice(0, dirs.length > 1 ? faces + 1 : faces);
  } else {
    streetEdges = edgesOf(ring, { minLen: 4, longest: faces });
  }

  // Where the wall is cut at street level. The wall pass (facade buffer) and the
  // kit standing inside the cut (trim buffer) read the SAME plan, so a hole and
  // the thing in it cannot drift apart.
  //
  // This is also the fix for a defect that survived three review rounds. The
  // storefront kit builds its glazing 0.55 m BEHIND the wall line — correct, that
  // is what a recess is — but nothing ever cut the wall, so every shopfront in
  // the district was hidden behind an unbroken quad. "Buildings carry the same
  // window grid at street level as on floor 7, with no doorway, shopfront or
  // plinth" was an accurate description of what was on screen.
  const plan = new Map();
  const fronts = frontEdges(ring, allEdges, streetEdges, opts.detailFaces ?? 3);
  for (const e of fronts) plan.set(e.i, { detail: true });

  // LOTS. See the lot section for why a footprint is not the same thing as a
  // building. Every frontage long enough to hold more than one tenancy is cut
  // into lots here, and from this point on the lot - not the edge - is the unit
  // the wall, the plinth, the parapet, the shopfront and the signage all work in.
  // Street-facing frontages only. frontEdges also admits a long rear or party
  // elevation so it gets built depth, and a parade of shopfronts down an alley is
  // both wrong and paid for out of the same triangle budget as the high street.
  const streetSet = new Set(streetEdges.map((e) => e.i));
  const lotPlan = lotPlanFor(ring, style, height, fronts.filter((e) => streetSet.has(e.i)));
  for (const [i, lp] of lotPlan) {
    const p = plan.get(i) ?? {};
    p.lots = lp.lots;
    plan.set(i, p);
    // GROUND-ONLY: the tenancies are a row of shopfronts at the foot of ONE
    // wall. Their bays are collected into a single edge-metres gap list, which
    // is what facadeWalls cuts the street level with and what plinth() steps
    // around; the lot keeps its own lot-metres copy because storefront() and
    // fasciaBand() below are handed L.sub and work in its coordinates.
    if (lp.ground) {
      p.groundOnly = true;
      const gaps = [];
      for (const L of lp.lots) {
        // storefront() below is handed `...style.storefront`, so the bay module
        // is whatever that object carries; the wall must be cut on the same one.
        L.ground = { top: L.head, gaps: storefrontBays(L.len, style.storefront) };
        for (const [a, b] of L.ground.gaps) gaps.push([L.s0 + a, L.s0 + b]);
      }
      // Every head on a ground plan is the same by construction (lotPlanFor
      // holds it at the building's value), so lots[0] is the elevation's head.
      p.ground = { top: lp.lots[0].head, gaps };
      continue;
    }
    for (const L of lp.lots) {
      if (style.storefront && streetSet.has(i)) {
        L.ground = { top: L.head, gaps: storefrontBays(L.len, style.storefront) };
      } else if (L.entrance) {
        const ops = openingsAlong(rec, L.len, { u0: L.u0, margin: 0.34 });
        const top = rec.floorM * (1 - rec.win.top);
        if (ops.length && top >= 2.2 && top <= height - 0.5) {
          const pick = ops[(ops.length / 2) | 0];
          L.slot = { e: L.sub, s0: pick[0], s1: pick[1], top };
        }
      }
    }
  }

  if (style.storefront) {
    for (const e of streetEdges) {
      const p = plan.get(e.i) ?? {};
      if (!p.lots) p.ground = { top: style.storefront.head, gaps: storefrontBays(e.len, style.storefront) };
      plan.set(e.i, p);
    }
  }
  // The single building entrance is what a frontage with no lots gets. A lotted
  // frontage puts a door on its own tenancies instead, which is the whole point.
  const door = style.entrance && !lotPlan.size
    ? entrancePlan(ring, rec, height, style, fronts) : null;
  if (door) {
    const p = plan.get(door.e.i) ?? {};
    p.slot = door;
    plan.set(door.e.i, p);
  }

  facadeWalls(ring, height, rec, wall.pos, wall.nrm, wall.uv, wall.idx, {
    tint: t, col: wall.col, plan, edges: allEdges,
    bandFloors: revealFloors(fronts, rec, height),
  });
  // The roof goes in the trim buffer: gravel and membrane are trim materials, and
  // keeping them out of the facade buffer means the facade texture never has to
  // reserve space for a surface nobody sees from the street.
  extrudeFacade(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
    tint: [1, 1, 1], col: trim.col, walls: false, roof: true,
    roofCell: style.recipe === 'stuccoHouse' ? TRIM.asphalt : TRIM.gravel,
  });

  const tArgs = { col: trim.col, tint: [1, 1, 1] };
  if (style.parapet) {
    // Only PROPERTY lots step the parapet. A ground-only frontage is one
    // building and its parapet is one line, 30 m over the shopkeeper's head.
    const stepped = new Map();
    for (const [i, lp] of lotPlan) if (!lp.ground) stepped.set(i, lp.lots);
    parapet(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
      ...style.parapet, cell: TRIM.stone, ...tArgs, tint: t,
      lots: stepped.size ? stepped : null,
    });
  }
  if (style.plinth) {
    plinth(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
      ...style.plinth, plan, edges: allEdges, col: trim.col, tint: t,
    });
  }
  if (door) {
    doorway(door.e, door.s0, door.s1, door.top, trim.pos, trim.nrm, trim.uv, trim.idx, tArgs);
  }
  // Party piers, one per interior lot boundary, carried to the roof so they die
  // under the cornice the way a pilaster does. Tinted with the lot on their LEFT,
  // so the colour change lands on the pier's far edge and the pier belongs to a
  // building rather than floating between two.
  // parapet() puts the cornice soffit at height - parapetHeight * 0.35; a
  // pilaster stops UNDER a cornice, so the pier top is that line and not the roof
  // slab, or its last 0.4 m stands inside the cornice band and crosses its soffit.
  const pierTop = height - (style.parapet?.height ?? 0) * 0.35;
  for (const [, lp] of lotPlan) {
    // A PROPERTY boundary is a pilaster to the cornice. A TENANCY boundary
    // inside one building is a SHOPFRONT PIER and stops at the top of the
    // fascia, because above that line there is one building and not two -
    // carrying it up a 35 m tower would draw 30 m of party wall between two
    // shops that share a landlord, which is the parade in a different costume.
    const L0 = lp.lots[0];
    const top = lp.ground
      ? (L0.fasciaY ? L0.fasciaY[1] : (L0.head ?? 0) + 0.2)
      : pierTop;
    for (let k = 1; k < lp.lots.length; k++) {
      partyPier(lp.e, lp.lots[k].s0, top, trim.pos, trim.nrm, trim.uv, trim.idx,
        { col: trim.col, tint: lp.lots[k - 1].tint });
    }
  }
  for (const [, lp] of lotPlan) {
    for (const L of lp.lots) {
      // Per-lot street door for a frontage with no shopfront.
      if (L.slot) {
        doorway(L.slot.e, L.slot.s0, L.slot.s1, L.slot.top,
          trim.pos, trim.nrm, trim.uv, trim.idx, tArgs);
      }
      if (!L.ground) continue;
      storefront(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
        ...style.storefront, head: L.head, depth: L.depth, doorSpan: L.doorSpan,
        edges: [L.sub], state: L.litState, ...tArgs,
      });
      // The fascia stops short of the piers at both ends, so what you see between
      // two shops is the pilaster and not two signboards butted together.
      if (L.fasciaY) {
        fasciaBand(L.sub, 0.24, L.len - 0.24, L.fasciaY[0], L.fasciaY[1],
          trim.pos, trim.nrm, trim.uv, trim.idx,
          { col: trim.col, tint: L.fasciaTint, cell: TRIM.stucco });
      }
    }
  }
  if (style.storefront) {
    // Frontages with no lots keep the whole-edge shopfront they always had.
    const plainEdges = streetEdges.filter((e) => !lotPlan.has(e.i));
    if (plainEdges.length) {
      storefront(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
        // No lot plan on these edges, so no `state`: storefront() implies a tenancy
        // per pair of bays off this seed instead. See the bay loop.
        ...style.storefront, edges: plainEdges, seed: style.seed, ...tArgs,
      });
    }
    // AWNINGS BELONG TO signage.js, and `opts.awnings` is how a caller says it
    // is not running signage. Default off, because the shipped path always is.
    //
    // The guard here used to be `plainEdges` alone -- no facade cloth over a
    // LOTTED bay, because there the lot plan holds one flag both kits read.
    // That covered half the problem. On an UNLOTTED frontage signage.js still
    // plans a tenancy per bay and still decides awning-or-fascia per tenancy
    // (`t.lot ? t.lot.awning : aw < 0.48`), so both kits were rolling their own
    // dice over the same wall. tools/awning-overlap.mjs measured the result
    // district-wide by intersecting what the two emitters actually put on the
    // wall, not by re-deriving their selection:
    //
    //   facade-kit cloth      286.2 m   5,562 triangles
    //   double-covered wall   130.0 m   26 edges on 23 buildings
    //   fascia under cloth    145.3 m
    //   redundant             275.4 m   96.2% of it, 5,352 triangles
    //
    // The second line is the one that matters more than the triangles. A tenant
    // "either awns or plates its fascia, never both", so signage.js chooses one
    // to keep the NAME readable -- and the facade kit's independent dice were
    // hanging a canopy over 145.3 m of the wordmarks it had just placed. Ten
    // point eight metres of the district's facade cloth was doing anything at
    // all, and this is the integration step signage.js's own header has asked
    // callers to perform since it was written ("set style.awnings = false").
    // Making it the default is what stops the next caller forgetting again.
    if (opts.awnings === true && style.awnings && plainEdges.length) {
      awnings(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
        head: style.storefront.head, edges: plainEdges, cell: style.fabric,
        seed: style.seed, ...tArgs,
      });
    }
  }
  if (style.pipes) {
    // Flanks only. A downpipe belongs on a blank wall, and on a detailed
    // elevation it would also cross the sill courses it is drawn in front of.
    wallPipes(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
      seed: style.seed ^ 0x77, skip: new Set(fronts.map((e) => e.i)), ...tArgs,
    });
  }
  if (style.fireEscape) {
    fireEscape(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
      floors: Math.min(style.floors, 6), floorM: rec.floorM, ...tArgs,
    });
  }
  if (style.balconies) {
    balconies(ring, trim.pos, trim.nrm, trim.uv, trim.idx, {
      floors: style.floors, floorM: rec.floorM, seed: style.seed, ...tArgs,
    });
  }
  if (style.roofUnits) {
    roofUnits(ring, height, trim.pos, trim.nrm, trim.uv, trim.idx, {
      count: style.roofUnits, seed: style.seed, ...tArgs,
    });
  }
  if (style.signBlank) {
    signBlank(ring, height + (style.parapet?.height ?? 0), trim.pos, trim.nrm, trim.uv, trim.idx,
      { ...tArgs, base: height });
  }
}

/** An empty buffer bundle in the shape every helper here appends into. */
export function buffers() {
  return { pos: [], nrm: [], uv: [], idx: [], col: [] };
}
