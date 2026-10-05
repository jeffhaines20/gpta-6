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
