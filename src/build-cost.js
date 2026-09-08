// The per-building cost cap, in one place.
//
// It lived as a method on StreamingWorld AND as a hand copy in
// tools/geom-audit.mjs. Two copies of a rule that decides which buildings get
// balconies is two answers the moment either is touched: the audit would have
// gone on reporting the geometry of a cap the streamer had stopped applying,
// and it would have looked entirely healthy doing it. Extracted so the streamer
// and every tool that has to predict what the streamer will build read the
// same arithmetic.
//
// WHY THE COST PROXY IS floors x PERIMETER and not floors x vertex count: a
// four-point 737 m2 tower emitted 19k trim vertices in 28.5 ms because its
// edges are LONG, not because it has many of them. Balcony and fire-escape
// count scale with edge length. Keying on vertex count missed exactly the
// building the cap exists for.

/** Footprint perimeter in metres, cached on the building. */
export function perimeterOf(b) {
  if (b._perim === undefined) {
    let per = 0;
    for (let i = 0; i < b.p.length; i++) {
      const a = b.p[i], c = b.p[(i + 1) % b.p.length];
      per += Math.hypot(c[0] - a[0], c[1] - a[1]);
    }
    b._perim = per;
  }
  return b._perim;
}

/** The cap's own cost proxy, in its own arbitrary units. */
export function styleCost(style, b) { return style.floors * perimeterOf(b); }

export const CAP = { balconies: 1400, roofUnits: 1800 };

/**
 * Trim an individually expensive style so one building cannot blow a frame.
 * Mutates and returns `style`, which is how both call sites already used it.
 */
export function capStyle(style, b) {
  const cost = styleCost(style, b);
  if (cost > CAP.balconies) { style.balconies = false; style.fireEscape = false; }
  if (cost > CAP.roofUnits) style.roofUnits = Math.min(style.roofUnits, 3);
  return style;
}
