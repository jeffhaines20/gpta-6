// THE PAINT FAMILIES A CAR CAN BE, as ONE definition both fleets draw from.
//
// `src/traffic.js` and `src/streetfurniture.js` each carried a long comment saying the reference
// is "overwhelmingly white, silver, grey and black with the occasional red or blue" and that a
// uniform hue wheel "was a fairground" — and each then drew its chromatic third from a uniform
// hue wheel. The achromatic claim was true and shipped; the chromatic one was true and did not.
// Measured on the shipped draw: green 28.0% of the chromatic third, magenta/pink 13.2%, violet
// 10.9%, cyan 8.0% — 60% in families neither comment mentions — against red+blue at 24.1%.
//
// THE TARGET IS A TABLE WITH A SOURCE, which is what #91 asked for and what neither module had.
// `reference/sarasota/car-colour-census.json` is a census of 65 vehicles over 11 panoramas of the
// corridor this district is modelled on, subsampled so no two frames are within 45 m. It carries
// its own method and its own biases. The result:
//
//     achromatic              55   84.6%        (a LOWER bound on nothing; see below)
//     chromatic               10   15.4%
//       red / maroon           5    50% of the chromatic set
//       blue / navy / teal     4    40%
//       beige / tan / gold     1    10%
//       green                  0     0%
//     cyan, violet, magenta, pink, yellow, orange   0 of 65
//
// **The zeros are the finding.** By the rule of three the 95% upper bound on a family that was
// never observed in 65 draws is 3/65 = 4.6% of all cars. The shipped wheel gives green
// 28.0% x 34.3% = 9.6% of all cars, which is 2.1x that bound, and spends another 32.1% of its
// chromatic third on cyan, violet and magenta against 0 observed.
//
// WHAT THE CENSUS DOES NOT SAY, and the weights below respect both:
//
//   - It does not say the chromatic share is 15.4%. That number is a LOWER bound: dark red and
//     navy read as black in bright Florida sun and only confident calls were counted. So this
//     module does not touch the achromatic/chromatic split, which both call sites still own at
//     their existing 0.66. Changing a figure the instrument cannot resolve would be exactly the
//     "a metric whose answer is its own quantisation" trap CLAUDE.md records.
//   - It does not say green is impossible. Zero of 65 is "rare", not "absent", so green keeps a
//     small share here rather than being deleted — 8% of the chromatic third, which is 2.7% of
//     all cars and sits under the bound the data supports. Deleting it would be over-fitting a
//     sample of ten chromatic cars.
//
// The weights are the census rounded toward the middle for the same reason: n=10 cannot support
// 50/40/10 to the percent, and red and blue being roughly equal and dominant is what it does
// support.
//
// SATURATION IS PER FAMILY AND COSTS NO EXTRA DRAW. A real beige car is not a saturated orange
// and a real green one is muted, so each family carries a scale applied to whatever saturation
// the caller drew. That matters more than it looks: `instanceColor` MULTIPLIES the vertex colour,
// so a saturated body tints its own alloy rims — the reason the achromatic majority exists at all.
//
// AND THE HUE WITHIN A FAMILY COMES OUT OF THE SAME NUMBER. `paintFamily` takes one uniform and
// uses its position WITHIN the chosen family's weight interval as the position within that
// family's hue range. That is still uniform, and it is why this can replace a one-draw hue pick
// without perturbing a seeded stream — `src/traffic.js` draws from the stream the fleet's routing
// and spawning also draw from, and CLAUDE.md records what changing a draw count does: the cars
// drive a different set of edges and defects appear in code nobody touched.

/**
 * Weights sum to 1. `h0`/`h1` are HSL hue in turns; red wraps past 1 and is unwrapped by
 * `paintFamily`. `sat` scales the caller's drawn saturation.
 */
export const PAINT_FAMILIES = Object.freeze([
  Object.freeze({ name: 'red', w: 0.42, h0: 0.995, h1: 1.030, sat: 1.00 }),
  Object.freeze({ name: 'blue', w: 0.36, h0: 0.560, h1: 0.660, sat: 1.00 }),
  Object.freeze({ name: 'beige', w: 0.14, h0: 0.075, h1: 0.115, sat: 0.55 }),
  Object.freeze({ name: 'green', w: 0.08, h0: 0.300, h1: 0.380, sat: 0.70 }),
]);

/**
 * One uniform in [0,1) -> the family it lands in, that family's hue, and its saturation scale.
 *
 * The LAST family is the fallback rather than a bounds check, so floating-point drift in the
 * cumulative sum cannot return null for a legal input — the failure a `for` loop over weights
 * invites, and one that would reach the caller as `setHSL(undefined, ...)` and a black car.
 */
export function paintFamily(u) {
  let x = u - Math.floor(u);
  if (!(x >= 0)) x = 0;                       // a non-finite input lands in the first family
  for (let i = 0; i < PAINT_FAMILIES.length; i++) {
    const f = PAINT_FAMILIES[i];
    if (x < f.w || i === PAINT_FAMILIES.length - 1) {
      // Where in this family's slice the draw fell, rescaled to [0,1): still uniform, and the
      // whole reason this needs no second draw.
      const t = f.w > 0 ? Math.min(1, Math.max(0, x / f.w)) : 0;
      let h = f.h0 + (f.h1 - f.h0) * t;
      if (h >= 1) h -= 1;
      return { name: f.name, h, sat: f.sat };
    }
    x -= f.w;
  }
  // Unreachable: the loop above always returns on its last iteration.
  return { name: PAINT_FAMILIES[0].name, h: PAINT_FAMILIES[0].h0, sat: PAINT_FAMILIES[0].sat };
}

/** The families this table deliberately does not contain. Named so a gate can assert the absence. */
export const PAINT_EXCLUDED = Object.freeze(['cyan', 'violet', 'magenta', 'pink', 'yellow', 'orange']);

// ---------------------------------------------------------------------------- tone
// THE TONE A CAR IS PAINTED, which is the other half of the census and was missing for longer.
//
// #91 fixed the HUE of the chromatic third and left the achromatic two thirds exactly where it
// found them, deliberately and under a comment saying so. Measured afterwards, that range was the
// larger defect: `src/traffic.js` drew `l = 0.34 + r * 0.26` and `src/streetfurniture.js`
// `l = 0.26 + u * 0.4`, and in three's WORKING colour space those numbers are LINEAR ALBEDOS.
// (`Color.setHSL(h, s, l)` defaults its colorSpace argument to the working space, not to sRGB —
// `src/facades.js` passes `THREE.SRGBColorSpace` explicitly where it wants the other behaviour.)
// So the whole shipped fleet lived between a mid grey and a light grey:
//
//     traffic      0.34 .. 0.60    a span of x1.77
//     parked pool  0.26 .. 0.66    a span of x2.54
//
// against a census that is 29.2% white, 20.0% silver and 35.4% black — 64.6% of the population
// with no tone in either draw. A white car's paint is about 0.80 and a black car's about 0.05.
//
// WHAT DECIDES THE NUMBERS. `tools/paint-tone.mjs` measures a white car against a black one in
// ONE frame, ONE parked row, ONE light and ONE panel orientation, in linear light, off
// `reference/sarasota/mapillary`:
//
//     open midday sun   white 0.5303   silver 0.3864   black 0.0313    white/black x16.9
//     deep shade        white 0.1693                   black 0.0895    white/black x1.89
//
// The two rows disagree by x8.9 and the difference is the light, not the cars. The shaded row is
// the FLOOR — both its subjects sit in the shadow region every camera pipeline lifts, and a lift
// compresses a ratio toward 1 — and the sunlit row is the estimate. WHITE IS THE ANCHOR at 0.80,
// which is a real white car's reflectance; BLACK IS DERIVED, 0.80 / 16.9 = 0.047. So one number
// is authored and one is measured, rather than both being chosen to look right.
//
// SILVER IS ORDERED, NOT FITTED. Metallic flake lifts a silver car's photographed luminance well
// above its diffuse albedo — the row reads silver/black at x12.3, which is not a reflectance
// ratio — so the measurement is used for the ORDER (white > silver > black, which it gives
// cleanly) and the range is the census family's own description, "silver, light grey and mid
// grey". `paint-tone` asserts the ordering and deliberately does not assert that ratio.
//
// THE WEIGHTS ARE THE RAW CENSUS COUNTS: white 19, silver 13, black 23 of 55 achromatic. The
// census's own biases note says it OVER-counts white, because four of the vehicles are commercial
// vans — correcting for that would read 0.294 / 0.255 / 0.451. It is not corrected, for the same
// reason the chromatic split was not: "do not move a figure your instrument cannot resolve", and
// the census cannot say which four frames the vans are in. The bias is recorded instead.
//
// AND THIS IS ONLY SAFE BECAUSE THE PAINT NO LONGER TINTS THE WHOLE CAR. Both modules' comments
// said a mostly-achromatic fleet was the ESCAPE from `instanceColor` multiplying the alloy rims,
// the plate and the lamps along with the body — "there is no per-instance escape from that inside
// one InstancedMesh". There is now: `src/carbody.js`'s paint-slot tint confines instanceColor to
// palette slot 0. Without it, widening this range to reach black would take the number plate, the
// headlamps, the rims and the tyres down with the paint, and a black car would have a black plate.

/** The achromatic share of the fleet. Both call sites read it here rather than keeping a 0.66. */
export const ACHROMATIC_SHARE = 0.66;

/**
 * Weights sum to 1. `l0`/`l1` are HSL lightness in three's WORKING (linear) colour space, which
 * for an unsaturated colour is the paint's linear albedo directly.
 *
 * BLACK'S RANGE IS 0.040..0.080, AND THE TWO ENDS COME FROM DIFFERENT PLACES.
 *
 * THE TOP IS THE FAMILY'S OWN DEFINITION. The census calls this family "black, charcoal and any
 * dark body that could not be separated from black". The first cut ran to 0.054, which contains
 * no charcoal at all — so the range contradicted the definition it was drawn from, and with
 * w = 0.419 roughly two cars in five got the same near-black. A blind playtester saw it before
 * measuring it: "the three parked cars merge into one dark mass", and the family spanned x1.35.
 * 0.080 is a dark charcoal. This is honouring the family's definition, not inventing data.
 *
 * SO THE MEASURED RATIO NOW PINS THE FLOOR REGION AND NOT THE MEDIAN, and that is the restatement
 * the widening owes. The photographed subject was a true BLACK saloon, not a charcoal one, and
 * 0.80 / 16.94 = 0.047 is where a true black belongs — which this range contains, 18% up from its
 * floor. The MEDIAN is 0.060 and the white/black median ratio is x13.3, still inside the sunlit
 * row's own box spread of x5.79..x37.33. A gate is never loosened silently; this is the
 * derivation that moved with it.
 *
 * WHAT IS STILL OPEN: there is a hole between this family's 0.080 and silver's 0.220, a factor of
 * x2.75 with nothing drawn in it, and real cars live there as dark grey and gunmetal. Closing it
 * needs a census that can separate dark grey from black, and the one in this repo explicitly
 * cannot — its own biases note says dark bodies read as black in bright Florida sun. Do not move
 * a figure the instrument cannot resolve.
 *
 * AND THE FLOOR IS THE BRDF'S, NOT A TASTE. Palette slot 0 is metalness
 * 0.60, so three's physical BRDF splits an albedo `a` into `diffuse = a * 0.40` and
 * `F0 = 0.04 * 0.40 + a * 0.60`. That F0 crosses the plain DIELECTRIC value of 0.04 at exactly
 * a = 0.040: below it the metal mix drives the specular response UNDER what a non-metal would
 * give, so the darkest cars would have less clearcoat sheen than a sheet of glass. The first cut
 * of this table ran to 0.032 and put the bottom 27% of the black range there. Found by a blind
 * reviewer; the floor is now the crossing itself, and the median stays where the measurement put
 * it above it — see the paragraph on the
 * family's definition for where the median actually sits now.
 *
 * AND THE SAME SPLIT MEANS THE SHIPPED DIFFUSE IS 0.40 OF THESE NUMBERS. The photographic target
 * is a reflectance; at metalness 0.60 an albedo of 0.800 realises 0.320 of diffuse and an F0 of
 * 0.496, and 0.047 realises 0.0188 and 0.0442. Whether a white car reads as white paint or as
 * polished metal is therefore a question about the METALNESS and not about this table, and it is
 * unmeasured — see docs/BACKLOG.md. Do not "fix" it by raising the lightness: that would be
 * compensating a BRDF term with an albedo term, which is this project's standing error.
 */
export const PAINT_TONES = Object.freeze([
  Object.freeze({ name: 'white', w: 0.345, l0: 0.730, l1: 0.870 }),
  Object.freeze({ name: 'silver', w: 0.236, l0: 0.220, l1: 0.580 }),
  Object.freeze({ name: 'black', w: 0.419, l0: 0.040, l1: 0.080 }),
]);

/**
 * One uniform in [0,1) -> the tone it lands in and its lightness within that tone.
 *
 * Same shape as `paintFamily` and for the same reason: ONE draw carries both the tone and the
 * position inside it, so this can replace a one-draw lightness pick without perturbing a seeded
 * stream. `src/traffic.js` draws from the stream the fleet's routing and spawning also draw from,
 * and CLAUDE.md records what changing a draw COUNT does there — the cars drive a different set of
 * edges and defects surface in modules nobody touched.
 *
 * The LAST tone is the fallback rather than a bounds check, so drift in the cumulative sum cannot
 * return null for a legal input and reach the caller as `setHSL(..., undefined)`.
 */
export function paintTone(u) {
  let x = u - Math.floor(u);
  if (!(x >= 0)) x = 0;                         // a non-finite input lands in the first tone
  for (let i = 0; i < PAINT_TONES.length; i++) {
    const t = PAINT_TONES[i];
    if (x < t.w || i === PAINT_TONES.length - 1) {
      const f = t.w > 0 ? Math.min(1, Math.max(0, x / t.w)) : 0;
      return { name: t.name, l: t.l0 + (t.l1 - t.l0) * f };
    }
    x -= t.w;
  }
  // Unreachable: the loop above always returns on its last iteration.
  return { name: PAINT_TONES[0].name, l: PAINT_TONES[0].l0 };
}
