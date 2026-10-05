// Vehicle damage: impacts in, health and degradation out — as pure state.
//
// WHY IT LOOKS LIKE THIS. Same shape as src/wanted.js and src/mission.js: no THREE,
// no DOM, no renderer, no random, a fixed-dt `update()` over plain numbers, and a
// node gate that can drive a thousand crashes in milliseconds and land on the same
// figures every run. Damage is the field three mission stages already branch on
// (`healthBelow 0.2 -> failed` on Marlin Street's `ambush`, `drop` and `dropHot` — not
// on its early stages, because being run off the road before the ambush is not how
// that mission is meant to end), so it is branching code, which is exactly what rots
// unseen. The gate's first draft crashed the car on the wrong stage and read
// `running` for three thousand frames without noticing.
//
//   node tools/damage-test.mjs            the gate
//
// THE INPUT IS delta-v ALONG THE CONTACT NORMAL, NOT SPEED. This is the one decision
// the whole module rests on. A car sliding along a wall at 60 km/h with a 5 degree
// incidence changes its normal velocity by 16.7 * sin(5) = 1.45 m/s; the same car
// hitting that wall square-on changes it by 16.7. Those are a scuff and a write-off,
// and a model fed `speed` cannot tell them apart — it would total the car for
// brushing a kerb at speed, which is the single most infuriating failure a damage
// model has. Feeding delta-v also makes the mass ratio fall out for free: an
// 80 kg pedestrian struck by a 1400 kg car changes the CAR's velocity by 5.4%, so
// the car takes no meaningful damage from it without a special case, and a head-on
// between two equal cars at 100 km/h closing gives each one 50 km/h of delta-v,
// which is exactly the barrier test.
//
// THE THRESHOLDS ARE ANCHORED TO PUBLISHED CRASH TESTS, NOT TUNED BY FEEL. Three of
// them, and all three are checked by the gate:
//
//   free  2.2 m/s  (8 km/h)   FMVSS Part 581 bumper standard: no damage to safety
//                             equipment in a 5 mph pendulum / 2.5 mph barrier hit.
//                             Below this the car takes nothing structural.
//   ref   4.17 m/s (15 km/h)  IIHS low-speed bumper series: cosmetic to moderate
//                             bumper and bonnet damage, car drives away. The model
//                             puts this at 0.067 — about a fifteenth of the car.
//   kill  13.9 m/s (50 km/h)  The NCAP / FMVSS 208 full-frontal rigid barrier. A
//                             modern car is structurally finished by one of these
//                             and the occupant walks away, so this is 1.000.
//
// SEVERITY IS PROPORTIONAL TO DISSIPATED ENERGY, which is what makes those three
// anchors land together instead of needing three separate knobs: crush energy goes
// as delta-v squared, so
//
//   severity = (dv^2 - free^2) / (kill^2 - free^2)
//
// and the 15 km/h reference point is then a PREDICTION of the model rather than an
// input to it. It predicts 0.067, the reference says cosmetic-to-moderate, and that
// agreement is the only evidence here that the curve shape is right. A linear-in-dv
// model with the same two endpoints would put 15 km/h at 0.167 — two and a half
// times as much — and would make city driving feel made of glass.
//
// WHAT STOPS ONE SCRAPE TOTALLING THE CAR. The energy threshold does most of it: a
// resolver that removes the normal velocity leaves the next frame's normal delta-v
// near zero, and a shallow graze never clears `free` in the first place. But a
// bouncing grind — restitution pushes the car off, steering pushes it back — can
// re-charge, so minor impacts also carry wanted.js's refractory, per region, for the
// reason its own comment gives: "a bumper grinding along a wall fires a collision
// every frame; without this, one scrape is a five-star felony". Major impacts are
// never refracted. A crash is never swallowed because a crash came just before it.

/**
 * dt and input guard, lifted from wanted.js and mission.js for the reason their
 * comments give: `this.time += NaN` is permanent, and `health -= NaN` is worse
 * because NaN then fails every `<` comparison downstream in silence — the shape
 * CLAUDE.md calls the most dangerous a measurement bug can take, arriving through
 * the physics instead. `v > lo` is false for NaN, so NaN takes the `lo` branch.
 */
const clamp = (v, lo, hi) => (v > lo ? (v > hi ? hi : v) : lo);

/** Is this a real number we can do arithmetic with? */
const finite = (v) => typeof v === 'number' && v - v === 0;

/** What hit us. Decides the crime and the audio, never the arithmetic. */
export const IMPACT = Object.freeze({
  wall: 'wall',               // a building, a retaining wall: immovable
  prop: 'prop',               // street furniture, a sign, a hydrant
  vehicle: 'vehicle',         // civilian traffic
  police: 'police',           // a pursuit unit
  roadblock: 'roadblock',     // a police roadblock
  pedestrian: 'pedestrian',   // a person
  ground: 'ground',           // landing hard from a jump
});

/**
 * The published anchors, in SI. Exported because the gate asserts against these
 * names rather than against copies of the numbers — a threshold that moves has to
 * move in one place and the gate has to see it move.
 */
export const ANCHORS = Object.freeze({
  freeDv: 2.2,      // m/s — FMVSS 581 bumper standard (8 km/h)
  refDv: 4.17,      // m/s — IIHS low-speed series (15 km/h); a PREDICTION, not an input
  refSeverity: 0.067,
  killDv: 13.9,     // m/s — NCAP full-frontal rigid barrier (50 km/h)
  /**
   * THE FATALITY LINE, AND THE CITATION THAT REFUTED THE FIRST ONE. This read "roughly 10% at
   * 30 km/h, 50% at 45 km/h, 90% at 80 km/h (Ashton & Mackay; Rosen & Sander)" and put the line
   * at 12.5 m/s. A blind reviewer checked the source and the two halves of that citation
   * disagree by a factor of nine: Rosen & Sander (2009) fit
   *
   *     P(fatal) = 1 / (1 + exp(6.9 - 0.090 v))        v in km/h
   *
   * to 490 weighted GIDAS cases, which gives 1.5% at 30, 5.5% at 45, 8.3% at 50 and 57% at 80,
   * and puts the 50% point at 76.7 km/h. The 10/50/90 shape is the older Ashton-family curve,
   * and Rosen, Stigson & Sander's own 2011 literature review exists to correct it: studies
   * biased toward severe accidents, "Ashton (1980) among them", gave 35-90% at 50 km/h and "the
   * data bias inevitably rendered these risk estimates too high", against ~10% from the
   * unbiased studies — a point Ashton himself made about his own sample.
   *
   * So the curve is now the model (see pedFatalityRisk below) and this constant is its 50%
   * point: the speed above which a struck pedestrian is more likely than not to die. A host
   * with no crowd module still classifies its crime from it; src/pedestrians.js draws against
   * the whole curve instead, because a threshold makes 46 km/h certainly fatal where the data
   * says 5.6%.
   */
  pedKillSpeed: 21.3,   // m/s (76.7 km/h) — the 50% point of Rosen & Sander (2009)
});

/**
 * Rosen & Sander (2009), equation (2): pedestrian fatality risk against car impact speed, for
 * pedestrians aged 15 or over struck by the front of a passenger car. `v` is in m/s here
 * because everything else in this file is SI; the published form takes km/h.
 *
 * Exported so the crowd can draw against the curve rather than against a step, and so the gate
 * can assert the published points rather than a copy of them.
 */
export function pedFatalityRisk(speedMs) {
  const v = Math.abs(speedMs) * 3.6;
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  return 1 / (1 + Math.exp(6.9 - 0.090 * v));
}

/**
 * Region weights come from the contact direction in BOX space, not in metres. The
 * body is 4.3 m long and 1.9 m wide, so a hit on the front corner sits at body
 * coordinates around (0.95, 2.15): in metres that reads 2.26 times more forward
 * than lateral and would be filed as a pure front hit, when it plainly bent the
 * wing too. Dividing by the half-extents first makes the corner a 45 degree hit,
 * which is what it is.
 *
 * Weights are the squared normalised components, so they sum to 1 and a square-on
 * hit is 100% one region. That also removes the tie a winner-take-all test has at
 * exactly 45 degrees, which is the case a car hitting a building corner produces
 * constantly.
 */
export const HALF_EXTENT = Object.freeze({ x: 0.95, z: 2.15 });

const REGIONS = Object.freeze(['front', 'rear', 'left', 'right']);

export class DamageModel {
  constructor(opts = {}) {
    this.freeDv = opts.freeDv ?? ANCHORS.freeDv;
    this.killDv = opts.killDv ?? ANCHORS.killDv;
    this.pedKillSpeed = opts.pedKillSpeed ?? ANCHORS.pedKillSpeed;

    // An impact at or above this severity always applies. 0.12 is delta-v 5.2 m/s,
    // 19 km/h: hard enough that a player who did it knows they did it.
    this.majorSeverity = opts.majorSeverity ?? 0.12;
    this.minorRefractory = opts.minorRefractory ?? 0.6;   // seconds, per region

    /**
     * Fire. Latches below `fireHealth` and then drains health at `fireRate`, so a
     * car that has been battered to 12% has about three seconds of "get out now"
     * rather than simply stopping. Deterministic on purpose: a fire that starts
     * from a dice roll cannot be gated, and the fail path three mission stages
     * branch on has to be reproducible.
     */
    this.fireHealth = opts.fireHealth ?? 0.12;
    this.fireRate = opts.fireRate ?? 0.04;                // health per second

    this.time = 0;
    this.repair();
  }

  /** Back to showroom. Used by mission restart and by the gate between cases. */
  repair() {
    this._total = 0;
    this.regions = { front: 0, rear: 0, left: 0, right: 0 };
    this._lastMinorAt = { front: -1e9, rear: -1e9, left: -1e9, right: -1e9 };
    this.onFire = false;
    this.fireSince = 0;
    this.wrecked = false;
    this.lastImpact = null;
    this.stats = { impacts: 0, applied: 0, refracted: 0, rejected: 0,
      worstSeverity: 0, worstDv: 0, totalDv: 0 };
    return this;
  }

  /** 1.000 showroom, 0.000 wrecked. */
  get health() { return clamp(1 - this._total, 0, 1); }

  /**
   * Engine power multiplier. The engine is in the front, so it is FRONT damage that
   * takes the power away, not overall health: a car reversed into a wall six times
   * still pulls. Full power to 0.35 of front damage, then down to 0.25 at 0.85 —
   * never to zero while the car lives, because a car that cannot move at all is a
   * mission failure the player cannot see coming and cannot do anything about.
   */
  get enginePower() {
    if (this.wrecked) return 0;
    return 1 - clamp((this.regions.front - 0.35) / 0.5, 0, 1) * 0.75;
  }

  /**
   * Steering pull, -1 (pulls left) .. 1 (pulls right), from the left/right
   * asymmetry. A bent near-side corner drags that way. Capped at 0.25 of the
   * vehicle's steering authority so it is a handicap, not a loss of control.
   */
  get steerPull() {
    return clamp((this.regions.right - this.regions.left) * 0.5, -0.25, 0.25);
  }

  /** 0..1 for whoever draws smoke. Starts at half health, full by 0.15. */
  get smoke() {
    return clamp((0.5 - this.health) / 0.35, 0, 1);
  }

  /**
   * One impact.
   *
   *   dv     m/s, the change in velocity along the contact normal. REQUIRED.
   *   kind   one of IMPACT; decides the crime, never the arithmetic.
   *   dirX   body-space x from the car's centre toward the contact (+ = right)
   *   dirZ   body-space z from the car's centre toward the contact (+ = forward)
   *   speed  m/s, the car's own speed — only read for the pedestrian fatality line
   *
   * Returns a record, always, including for a rejected impact: a caller that wants
   * to play a sound needs to know a graze happened even when it cost nothing.
   */
  impact({ dv, kind = IMPACT.wall, dirX = 0, dirZ = 1, speed = 0 } = {}) {
    this.stats.impacts++;
    const out = { applied: false, reason: null, severity: 0, dv: 0, region: 'front',
      weights: null, crime: null, health: this.health, kind };

    // A non-finite delta-v is a physics bug upstream, and letting it reach the
    // accumulator would make health NaN — after which `health < 0.2` is false, the
    // mission never fails, and the car is immortal. Reject loudly in the record.
    if (!finite(dv) || !finite(dirX) || !finite(dirZ)) {
      out.reason = 'non-finite';
      this.stats.rejected++;
      return this._finish(out);
    }
    out.dv = Math.abs(dv);
    if (out.dv > this.stats.worstDv) this.stats.worstDv = out.dv;

    const weights = this.regionWeights(dirX, dirZ);
    out.weights = weights;
    out.region = REGIONS.reduce((a, r) => (weights[r] > weights[a] ? r : a), 'front');
    out.crime = this._crimeFor(kind, out.dv, finite(speed) ? Math.abs(speed) : 0);

    const severity = this.severityFor(out.dv);
    out.severity = severity;
    /**
     * HOW BIG AN OFFENCE THIS WAS, for src/wanted.js's `opts.scale`. See `_crimeScaleFor`.
     * It rides on the record because this module is the one that knows the delta-v and the
     * speed; wanted.js owns the ladder and must not learn the physics.
     */
    out.crimeScale = out.crime
      ? this._crimeScaleFor(kind, out.dv, finite(speed) ? Math.abs(speed) : 0, severity)
      : 0;
    if (severity <= 0) {
      out.reason = 'below-threshold';
      this.stats.rejected++;
      return this._finish(out);
    }

    // Minor impacts refract per region; a major one always lands.
    if (severity < this.majorSeverity &&
        this.time - this._lastMinorAt[out.region] < this.minorRefractory) {
      out.reason = 'refractory';
      this.stats.refracted++;
      return this._finish(out);
    }
    if (severity < this.majorSeverity) this._lastMinorAt[out.region] = this.time;

    this._total += severity;
    for (const r of REGIONS) this.regions[r] = clamp(this.regions[r] + severity * weights[r], 0, 1);
    this.stats.applied++;
    this.stats.totalDv += out.dv;
    if (severity > this.stats.worstSeverity) this.stats.worstSeverity = severity;

    out.applied = true;
    out.reason = 'applied';
    this._checkFire();
    out.health = this.health;
    return this._finish(out);
  }

  /**
   * THE ONE EXIT. Every record leaves through here, including the rejected ones, because
   * this method's own doc comment already says why: "a caller that wants to play a sound
   * needs to know a graze happened even when it cost nothing". There were four returns and
   * each set `lastImpact` by hand; a fifth would have forgotten.
   *
   * `onImpact` is optional and unset by default, so nothing about this module's behaviour
   * depends on a host attaching one. district/main.js uses it for the crash voice.
   */
  _finish(out) {
    this.lastImpact = out;
    if (this.onImpact) this.onImpact(out);
    return out;
  }

  /**
   * Energy-proportional severity for a normal delta-v. Exposed so the gate can walk
   * the curve without constructing impacts, and so the three published anchors are
   * checked against the same code the game runs.
   */
  severityFor(dv) {
    const a = Math.abs(dv);
    if (!(a > this.freeDv)) return 0;
    const f2 = this.freeDv * this.freeDv, k2 = this.killDv * this.killDv;
    return clamp((a * a - f2) / (k2 - f2), 0, 1);
  }

  /** Region weights for a body-space contact direction. See HALF_EXTENT. */
  regionWeights(dirX, dirZ) {
    const bx = dirX / HALF_EXTENT.x, bz = dirZ / HALF_EXTENT.z;
    const sx = bx * bx, sz = bz * bz;
    const sum = sx + sz;
    // A contact exactly at the centre has no direction; blame the front, because a
    // degenerate contact almost always means a spawn overlap and the front is where
    // the least damage does the least harm.
    if (!(sum > 0)) return { front: 1, rear: 0, left: 0, right: 0 };
    return {
      front: bz > 0 ? sz / sum : 0,
      rear: bz > 0 ? 0 : sz / sum,
      right: bx > 0 ? sx / sum : 0,
      left: bx > 0 ? 0 : sx / sum,
    };
  }

  /**
   * What the police would call this. Returns a src/wanted.js crime id, or null when
   * the contact is not worth reporting — nudging a wall at 3 km/h is not property
   * damage, and a model that reports it makes the wanted meter unusable in a car
   * park.
   */
  _crimeFor(kind, dv, speed) {
    if (kind === IMPACT.pedestrian) {
      return speed >= this.pedKillSpeed ? 'pedestrianKilled' : 'pedestrianHit';
    }
    /**
     * THE SAME TEST `severityFor` USES, and it was `dv < this.freeDv` while that reads
     * `!(a > this.freeDv)`. The two disagree at exactly `dv === freeDv`: the crime was filed
     * and the severity was 0, so the offence charged no heat, burned its refractory, and
     * reported itself applied. One quantity, two predicates, differing on a boundary the
     * gate walks — CLAUDE.md's "a check whose two sides are both zero", inside the classifier.
     */
    if (!(dv > this.freeDv)) return null;
    switch (kind) {
      case IMPACT.police: return 'policeProperty';
      case IMPACT.roadblock: return 'roadblockRun';
      case IMPACT.vehicle: return 'civilianCollision';
      case IMPACT.wall: case IMPACT.prop: return 'propertyDamage';
      default: return null;
    }
  }

  /**
   * HOW BAD THIS INSTANCE OF THE OFFENCE WAS, as a multiplier on the crime's table heat.
   * src/wanted.js's `reportCrime` has taken `opts.scale` since it was written, and its own doc
   * comment says why — "a 90 km/h impact is not a 10 km/h one" — and no caller ever passed one.
   *
   * A blind playtester priced the consequence of that. From a clean record, isolating one
   * offence (the damage model's severity beside it, so the two can be compared):
   *
   *     closing km/h    dv    severity   charged   stars      the same, scaled
   *             10    3.19      0.028      0.30      0        0.07      0
   *             20    6.39      0.191      0.30      0        0.48      0
   *             40   12.78      0.841      0.30      0        2.10      2
   *            110   35.14      1.000      0.30      0        2.50      2
   *
   * Every row charged 0.30 and read 0 stars. Writing the car off against a building at 110 km/h
   * — health 1.000 to 0.000, delta-v 18.88, the loudest thing in the game — was a free action,
   * and so was a 107 km/h head-on into an occupied civilian car (0.50, 0 stars). Thirty-one
   * separate building crashes were needed for one star, and seven car rams. Meanwhile ONE
   * pedestrian knocked down at 9 km/h was 1.15 and one star immediately. The damage model was
   * fully speed-aware over that sweep — severity 0.028 to 1.000, a 36x range — and the crime
   * heat was a constant across the same rows.
   *
   * The scale is `severity / majorSeverity` for anything with a delta-v. Both terms are already
   * in this module: `majorSeverity` (0.12) is its own line between an impact that refracts per
   * region and one that always lands, so the table's heat becomes the charge for a minimum
   * MAJOR impact, a scrape costs proportionally less, and a fatal-range one costs up to 8.33x.
   * Bounded by construction rather than by a clamp, because severity is already bounded to 1.
   *
   * A PEDESTRIAN IS DIFFERENT, AND ANY MULTIPLIER ON ONE IS ALMOST ENTIRELY INVISIBLE. Tried
   * first with `pedFatalityRisk(speed) / pedFatalityRisk(pedKillSpeed)`, which is 1.000 exactly
   * at the speed where `_crimeFor` switches from `pedestrianHit` to `pedestrianKilled` — a
   * self-validating join, since `pedKillSpeed` IS that curve's 50% point. Measured:
   *
   *     km/h     risk    crime   scale   charged   stars
   *        8   0.0021      hit    0.00      1.00      1
   *       40   0.0356      hit    0.07      1.00      1
   *       60   0.1824      hit    0.36      1.00      1
   *     76.7   0.5007   KILLED    1.00      2.00      2
   *      110   0.9526   KILLED    1.90      3.81      3
   *
   * `pedestrianHit` carries `min: 1`, and `min` is a floor on HEAT, not on stars — so every
   * scale below 0.87 comes back out as exactly 1.00 and the charge is one star from 8 km/h to
   * 76 km/h however the scale is computed. The quadratic energy form `(v/pedKillSpeed)^2` was
   * tried too and collapses identically. That floor is right — hitting a person is hitting a
   * person, and the escalation is the classification switch at a published fatality speed, not
   * a curve — so the pedestrian charge is left alone and the invisible range is stated here
   * with its number rather than fixed with a fudge. Above the switch the scale does graduate,
   * and that range is where it earns its place.
   *
   * THE MECHANISM ABOVE IS RIGHT AND THE CONCLUSION WAS INCOMPLETE, so the refusal is recorded
   * rather than deleted. What it missed is that the flatness was never the defect a player felt:
   * the table's ORDER was inverted. The same scale on the other side reaches 8.33x with no floor
   * to stop it, so a wall at 60 km/h charged 2.50 (two stars) and a civilian car 4.17 (FOUR),
   * against 1.00 for a struck person — that is the inversion, and this comment's own table shows
   * the person's side of it without ever comparing the two. `src/wanted.js`'s FLOORLESS_CAP is the
   * fix and it lives there, because the ordering is the ladder's and the ladder is that module's.
   * The pedestrian scale here is unchanged: still the risk ratio, still normalised at the curve's
   * 50% point.
   *
   * AND THE TABLE VALUE THE SCALE MULTIPLIES MOVED, 1.15 -> 2.00, which is what buys back the
   * graduation this comment refused. The refusal turned on `min: 1` swallowing every product
   * below 1, and where that bites depends on the table heat: at 1.15 the product crosses 1 at
   * 75 km/h and the charge is flat over 8-75; at 2.00 it crosses at 63 and the band reads
   * 1.00 / 1.00 / 1.42 / 1.96 at 50 / 60 / 70 / 76. Same floor, same curve, 13 km/h of visible
   * graduation instead of 2 — and the number is not picked, it is `pedestrianKilled.min`, so a
   * strike AT the switch costs what a kill costs at its floor. See src/wanted.js.
   *
   * WHAT THAT COST, because it is not free: `heat` is the charge at scale 1, and scale 1 is this
   * curve's 50% point, so an UNSCALED `pedestrianHit` is now the reference case and worth two
   * stars rather than one. Every production caller passes a scale — one defect found by making
   * this change, district/main.js's run-over site passing a literal `scale: 1` for a crime whose
   * scale is a function of speed it already had in hand — and `pedCrimeScale` below exists so
   * that site can ask for the scale rather than copy the formula. `wanted-test` §5 no longer
   * builds its response ladder out of a scaled crime for the same reason, and mission-test's
   * "one accident" arm no longer reports bare ids.
   */
  _crimeScaleFor(kind, dv, speed, severity) {
    if (kind === IMPACT.pedestrian) return this.pedCrimeScale(speed);
    return this.majorSeverity > 0 ? severity / this.majorSeverity : 1;
  }

  /**
   * THE PEDESTRIAN SCALE, PUBLIC, because a caller that has a speed and no delta-v needs it and
   * must not re-derive it. A run-over is that caller: the body does not resist, so there is no
   * delta-v to hand `impact()`, and district/main.js passed `scale: 1` — which charged a 2 km/h
   * roll over a body exactly what a 76 km/h one cost. One definition, called from
   * `_crimeScaleFor` above, so the two paths cannot drift.
   *
   * 1.000 exactly at `pedKillSpeed` by construction, since that IS the curve's 50% point. A
   * non-finite speed reads 0 rather than throwing, which lands the charge on the crime's floor —
   * the safe direction, and the one `Math.hypot(NaN, NaN) || 1` got wrong elsewhere in this round.
   */
  pedCrimeScale(speed) {
    const ref = pedFatalityRisk(this.pedKillSpeed);
    const v = finite(speed) ? Math.abs(speed) : 0;
    return ref > 0 ? pedFatalityRisk(v) / ref : 1;
  }

  /**
   * THE WHOLE CHARGE FOR DRIVING OVER A BODY THAT IS ALREADY DOWN, in one place, because
   * district/main.js was deciding it in three: which crime (`r.fatal ? killed : hit`), what scale
   * (a literal 1), and nothing tying either to this module's own threshold. `charge-window` in
   * mutation-sweep records what that costs — no offline gate imports district/main.js, so a rule
   * that lives there is a rule nothing can mutate-test. `VictimWindow` moved into src/wanted.js
   * for exactly this reason and this is the same move.
   *
   * `fatal` is src/pedestrians.js's verdict, which is decided by THIS module's `pedKillSpeed`
   * (see `hit()` there), so it is passed in rather than re-derived. Left null it falls through to
   * `_crimeFor`, which is the one definition of the switch — so the two paths cannot disagree
   * about where it sits, only about who asked.
   */
  runOverCrime(speed, fatal = null) {
    const crime = fatal === null
      ? this._crimeFor(IMPACT.pedestrian, 0, speed)
      : (fatal ? 'pedestrianKilled' : 'pedestrianHit');
    return { crime, scale: this.pedCrimeScale(speed) };
  }

  _checkFire() {
    if (!this.onFire && !this.wrecked && this.health <= this.fireHealth) {
      this.onFire = true;
      this.fireSince = this.time;
    }
    if (this.health <= 0) { this.wrecked = true; this.onFire = false; }
  }

  /** One tick. Runs the fire clock; that is all the time-dependence there is. */
  update(dt) {
    this.time += clamp(dt, 0, 0.25);
    if (this.onFire) {
      this._total += this.fireRate * clamp(dt, 0, 0.25);
      this._checkFire();
    }
    return this;
  }

  report() {
    return {
      health: +this.health.toFixed(4),
      wrecked: this.wrecked,
      onFire: this.onFire,
      fireFor: this.onFire ? +(this.time - this.fireSince).toFixed(2) : 0,
      enginePower: +this.enginePower.toFixed(4),
      steerPull: +this.steerPull.toFixed(4),
      smoke: +this.smoke.toFixed(4),
      regions: {
        front: +this.regions.front.toFixed(4), rear: +this.regions.rear.toFixed(4),
        left: +this.regions.left.toFixed(4), right: +this.regions.right.toFixed(4),
      },
      time: +this.time.toFixed(3),
      stats: { ...this.stats,
        worstSeverity: +this.stats.worstSeverity.toFixed(4),
        worstDv: +this.stats.worstDv.toFixed(3),
        totalDv: +this.stats.totalDv.toFixed(3) },
    };
  }
}

/**
 * The normal delta-v a collision against an IMMOVABLE surface produces, given the
 * approach velocity and the outward surface normal.
 *
 * This lives here, next to the thresholds, because it is where the "delta-v not
 * speed" decision actually gets made and it is the one line a caller is most likely
 * to get wrong. `vn` is the component of velocity INTO the surface — negative when
 * approaching. Separating (vn >= 0) is not an impact at all, which is the case a
 * resolver hits on the frame after it has already pushed the car out.
 *
 * With restitution e, the outgoing normal velocity is -e*vn, so the change is
 * |vn| * (1 + e). At e = 0 (a fully plastic crash into a concrete wall, which is
 * what a real barrier test is) that is just the closing speed.
 */
export function normalDv(vx, vz, nx, nz, restitution = 0) {
  const n = Math.hypot(nx, nz);
  if (!(n > 0)) return 0;
  const vn = (vx * nx + vz * nz) / n;
  if (!(vn < 0)) return 0;
  return -vn * (1 + clamp(restitution, 0, 1));
}

/**
 * The delta-v a collision against a body of finite mass produces, for the FIRST
 * body. A head-on between equals at 100 km/h closing gives each 50 km/h, which is
 * the barrier test — and that equivalence is the reason this project can price a
 * car-to-car crash off published barrier data at all.
 */
export function pairDv(closingSpeed, massA, massB, restitution = 0) {
  if (!(closingSpeed > 0) || !(massA > 0) || !(massB > 0)) return 0;
  return closingSpeed * (massB / (massA + massB)) * (1 + clamp(restitution, 0, 1));
}

/**
 * One contact against a MOVING body — a traffic car, a pedestrian, a police unit.
 *
 * Kept here, with the thresholds, because the quantity that matters is the CLOSING
 * speed along the contact normal and the mass ratio, and both are easy to get wrong in
 * a way that looks fine. Two cars travelling the same way at 60 km/h that touch have a
 * closing speed of nearly zero and should cost nothing; a head-on at 60 each is 120
 * km/h of closing and half of it lands on each car. A model that used either car's
 * SPEED would make the first a write-off and the second survivable, which is backwards.
 *
 * THE CAR IS FIVE CIRCLES, NOT ONE. src/vehicle.js's BODY_SAMPLES exist because one
 * circle round a 1.9 x 4.3 m body is 2.36 m in radius and would collide with things
 * over a metre clear of the paintwork. The nearest sample to the body is the contact.
 *
 * Returns null when clear or separating, otherwise the event `impact()` wants plus the
 * push-out the caller should apply:
 *
 *   { dv, dirX, dirZ, nx, nz, depth, closing, sampleZ }
 *
 * (nx, nz) points from the body toward the car, i.e. the direction the CAR should be
 * pushed. (dirX, dirZ) is the contact in the car's own body space, for the regions.
 */
export function dynamicContact({
  carX, carZ, fwdX, fwdZ, rightX, rightZ, carVX, carVZ, carMass = 1400,
  samples, carRadius,
  bodyX, bodyZ, bodyVX = 0, bodyVZ = 0, bodyRadius, bodyMass,
  restitution = 0.15,
}) {
  // Nearest sample first. The caller is expected to have already ruled out bodies
  // further than (enclosing + bodyRadius) away with one distance test.
  let bestS = 0, bestD = Infinity, bsx = 0, bsz = 0;
  for (const sz of samples) {
    const sx = carX + fwdX * sz, sw = carZ + fwdZ * sz;
    const d = Math.hypot(bodyX - sx, bodyZ - sw);
    if (d < bestD) { bestD = d; bestS = sz; bsx = sx; bsz = sw; }
  }
  const reach = carRadius + bodyRadius;
  if (!(bestD < reach)) return null;
  // Normal from the body toward the car. At zero separation there is no direction, and
  // the fallback has to be MINUS the car's forward, not plus: the normal points from the
  // body to the car, so a body at the car's own centre is treated as one directly ahead,
  // which files the contact to the front — damage.js's stated convention for a
  // degenerate contact, "because a degenerate contact almost always means a spawn
  // overlap and the front is where the least damage does the least harm". The first
  // draft used +forward, which made `closing` negative and returned null: a car
  // spawned exactly on top of another would have reported no contact at all.
  let nx, nz;
  if (bestD > 1e-6) { nx = (bsx - bodyX) / bestD; nz = (bsz - bodyZ) / bestD; }
  else { nx = -fwdX; nz = -fwdZ; }
  const closing = (carVX - bodyVX) * -nx + (carVZ - bodyVZ) * -nz;
  if (!(closing > 0)) return null;                 // touching but moving apart
  const dv = pairDv(closing, carMass, bodyMass, restitution);
  // Contact point on the car's collider surface, in body space, so a side-swipe reads
  // as a side. Same correction vehicle.js needed for walls: the SAMPLE CENTRE has no
  // lateral component and would file every collision as pure front or pure rear.
  const cx = bsx - nx * carRadius, cz = bsz - nz * carRadius;
  const ox = cx - carX, oz = cz - carZ;
  return {
    dv, closing, sampleZ: bestS,
    nx, nz, depth: reach - bestD,
    dirX: ox * rightX + oz * rightZ,
    dirZ: ox * fwdX + oz * fwdZ,
  };
}

/**
 * How far a struck pedestrian is thrown, in metres, from the vehicle's impact speed.
 *
 * ANCHORED TO FORENSIC RECONSTRUCTION, not chosen for looks:
 *
 *     d = v^2 / (2 * mu * g)
 *
 * with `mu` the sliding coefficient of a clothed body on asphalt, quoted between 0.6 and 0.7,
 * and g the real 9.81 — this is a body on tarmac, not the arcade 2 g the car drives under.
 * Taking the midpoint, 0.66:
 *
 *     30 km/h ->  5.3628 m     published ~5 m      +7.26%
 *     40 km/h ->  9.5339 m     published ~10 m     -4.66%
 *     50 km/h -> 14.8968 m     published ~15 m     -0.69%
 *
 * WHERE THIS SITS IN ITS OWN FAMILY, because a reviewer worked it out and the first version of
 * this comment was wrong twice over. It said "within 7% at all three", and 30 km/h is 7.26% —
 * outside the claim, and ABOVE the anchor, where the comment wrote -7%. The tool printed it as
 * "7" through toFixed(0), which is how a prose claim came to be a rounding artefact.
 *
 * And this is not the "first-order form" of a projection-and-slide model: it is that family's
 * MINIMUM. Add a launch angle to a ground-level launch with a plastic landing and
 * S(th) = v^2 sin(2 th)/g + v^2 cos^2(th)/(2 mu g), whose value at th = 0 is exactly the formula
 * above and whose derivative there is 4 mu/g > 0. The optimum at mu 0.66 is 34.6 degrees and
 * throws 1.91x as far. Searle's published pair of bounds says the same from the other side: the
 * inversion of his maximum-speed bound IS d = v^2/(2 mu g), and his minimum-speed bound inverts
 * to d = v^2 (1 + mu^2)/(2 mu g), 43.6% further.
 *
 * It reproduces the anchors because two errors cancel: no launch angle under-throws, and taking
 * the launch speed to be the whole VEHICLE speed over-throws by roughly the 20% Searle reports
 * between the two, which in a v^2 law is +44%. So mu 0.66 is a three-point empirical fit — the
 * values each anchor implies are 0.7079, 0.6292 and 0.6555, mean 0.664 — that happens to land on
 * the midpoint of the quoted band. It is a calibration absorbing the missing terms, it has no
 * warrant outside the 30-50 km/h window its anchors occupy, and it extrapolates to 38.1 m at
 * 80 km/h, which nothing here checks.
 *
 * ONE MORE THING THE MODEL AND THE LITERATURE DO NOT AGREE ABOUT: a published throw distance is
 * impact point to the body's final REST POSITION, and what this drives is the slide of the
 * body's ROOT. src/pedestrians.js lands the drawn torso about 0.93 m short of the root — 8.7% at
 * 40 km/h, larger than the 4.66% being argued about at that speed.
 *
 * The other figure often quoted — throw distance in metres is a quarter to a third of impact
 * speed in km/h — is a linear approximation to a quadratic, so it can only agree over a window.
 * Solving exactly, this model is inside that band from 41.96 to 55.94 km/h: it is BELOW it at 30
 * (5.36 against 7.50) and at 40 (9.53 against 10.00), and above it from 56 km/h up. The comment
 * used to say "roughly 30 to 60", which was a guess. The data points are the anchor; the rule of
 * thumb is not a second one.
 *
 * tools/reaction-test.mjs checks all three rows, because a throw distance is the one number
 * in a knockdown a viewer can judge by eye and get right.
 */
export const THROW = Object.freeze({ mu: 0.66, g: 9.81 });

export function throwDistance(speed) {
  const v = Math.abs(speed);
  if (!(v > 0)) return 0;
  return (v * v) / (2 * THROW.mu * THROW.g);
}

/**
 * The speed a thrown body leaves at, for a wanted throw distance — the inverse of the above,
 * so a caller that wants the published distance can integrate a decelerating slide to it
 * instead of teleporting the body there.
 *
 * Sliding at `mu * g` from v0 covers v0^2/(2 mu g), so v0 IS the impact speed and the slide
 * simply runs the formula forwards. Exported so the gate can assert the round trip rather
 * than trusting that an integrator agrees with the closed form.
 */
export function slideDecel() { return THROW.mu * THROW.g; }

/**
 * A PLACE TO GET THE CAR FIXED, because until this landed the fastest repair in the game was
 * destroying the car. A playtester measured the dead end: 0.686 health, no engine power, 60 s of
 * full throttle and 60 s of full reverse both giving 0 km/h, and the only repair reachable from
 * the page being `__district.repair()` from a browser console. Wrecking it on purpose hands back
 * a perfect one, so the optimal play was to drive into a building.
 *
 * The owner chose "a garage you drive to" over an automatic trickle, which reuses the reach
 * trigger and the minimap machinery the missions already have: a zone on the map, stop in it,
 * wait, drive away with the car fixed.
 *
 * WHAT IS IN THIS MODULE AND WHAT IS NOT. Everything that decides anything is here — the zone,
 * the dwell, the three refusals and the band line — and the host is left with one wire: feed it
 * the car, act on `repaired`, hand the line to the band. CLAUDE.md records why: "a host rule is
 * a rule no offline gate can reach", and when `composeBand` lived in district/main.js four of
 * its five tenants were missing from the node harness's own view of the screen.
 *
 * THE THREE REFUSALS, each of which is a rule rather than a safety check:
 *
 *   - A CAR THAT IS ALREADY PERFECT gets no dwell and no line. Otherwise a player parked in the
 *     garage between jobs watches a countdown to a repair that changes nothing, which reads as
 *     the garage being broken.
 *   - A WANTED CAR IS REFUSED, and that is most of what makes damage cost anything: with it, a
 *     damaged car at four stars is a decision — run for it, or shake the tail first.
 *   - A MOVING CAR IS REFUSED, so the garage is somewhere a player stops rather than something
 *     they drive through on the way past. Measured: a crossing of the zone at 2.45 to 5.78 m/s
 *     spends 5.75 s inside it, comfortably more than the hold, so without this rule the feature
 *     would be collected by accident and never learned.
 *
 * The dwell RESETS on every refusal rather than decaying, because a decaying dwell can be banked
 * over many short visits and "hold still" then stops being a requirement.
 */
export class Garage {
  /**
   * @param {{x:number,z:number,radius?:number,holdS?:number,stopMs?:number}} opts
   *   `radius`, `holdS` and `stopMs` default to the three constants above, which the HOST passes
   *   in from the modules that own them — this file must not import src/wanted.js or
   *   src/mission.js, and a default copied from either is the second copy of a number that
   *   CLAUDE.md records as the recurring defect here. A caller that passes none gets the
   *   fallbacks below and `tools/damage-test.mjs` asserts they equal the real constants.
   */
  constructor(opts = {}) {
    this.x = opts.x ?? 0;
    this.z = opts.z ?? 0;
    this.radius = opts.radius ?? 12;
    this.holdS = opts.holdS ?? 4.0;
    this.stopMs = opts.stopMs ?? 1.0;
    this.dwell = 0;
    this.inside = false;
    this.distance = null;
    this.stats = { entries: 0, repairs: 0, refusedWanted: 0, refusedMoving: 0 };
  }

  /**
   * One frame. `player` is `{ x, z, speed, wantedStars, health }` — the speed is the car's own,
   * not a smoothed one, because this is a question about whether the car is parked rather than
   * about whether it is being driven.
   *
   * Returns what the host needs to act and to draw: whether the car is in the zone, how far
   * through the dwell it is, and whether THIS frame completed a repair.
   */
  update(dt, player) {
    const d = Math.hypot((player.x ?? 0) - this.x, (player.z ?? 0) - this.z);
    /**
     * STORED, because `report()` takes the distance as an argument and a HOOK calls it with none.
     * `boot-check`'s first run read `distance: -1` on every frame of the drive in and the number
     * was correct the whole time — the probe was asking a function that had not been told. A
     * field that only exists on one of two call paths is a field that reads null in whichever
     * one a tool happens to use.
     */
    this.distance = d;
    const wasInside = this.inside;
    this.inside = d <= this.radius;
    if (!this.inside) { this.dwell = 0; return this.report(d, false); }
    if (!wasInside) this.stats.entries++;
    // Nothing to do for a car that is already perfect: the dwell would run and the line would
    // count down to a repair that changes nothing, which reads as the garage being broken.
    const hurt = (player.health ?? 1) < 1;
    if (!hurt) { this.dwell = 0; return this.report(d, false); }
    if ((player.wantedStars ?? 0) > 0) {
      this.dwell = 0;
      this.stats.refusedWanted++;
      return this.report(d, false);
    }
    if ((player.speed ?? 0) >= this.stopMs) {
      this.dwell = 0;
      this.stats.refusedMoving++;
      return this.report(d, false);
    }
    this.dwell += dt;
    if (this.dwell < this.holdS) return this.report(d, false);
    this.dwell = 0;
    this.stats.repairs++;
    return this.report(d, true);
  }

  report(d = null, repaired = false) {
    return { inside: this.inside, distance: d ?? this.distance ?? null,
      dwell: +this.dwell.toFixed(3),
      left: +Math.max(0, this.holdS - this.dwell).toFixed(3), repaired };
  }

  /** The minimap blip. `shop` has been in src/hud.js's MARKER_STYLE since it was written. */
  marker() { return { x: this.x, z: this.z, kind: 'shop' }; }
}

/**
 * THE GARAGE'S BAND LINE, beside `composeLaw` and `composeStuck` in shape and for the same
 * reason: presentation assembled inside district/main.js is presentation the node harness cannot
 * reproduce, and when `composeBand` lived there four of its five tenants were missing from
 * `look()`.
 *
 * `ownSubtitle` ON EVERY BRANCH, because every one of them is an instruction or a reason, and
 * src/hud.js's `HOLDS_MISSION_SUBTITLE` would replace it with the mission objective — the rule
 * that ate `composeLaw`'s "reverse" for a round and was measured at the word `drive` appearing
 * in 0 of them.
 *
 * Null for a car that is already perfect, so a player parked in the garage between jobs is not
 * reading a panel about nothing.
 *
 * @param {object|null} g       the `update()` report
 * @param {{health:number, wantedStars:number, speed:number}} player
 */
export function composeGarage(g, player = {}) {
  if (!g || !g.inside) return null;
  /**
   * THE FRAME THE REPAIR LANDS ON SAYS NOTHING, read off the report rather than off the health.
   * `update()` zeroes the dwell before reporting, so on that one frame `dwell` is 0 and `left` is
   * the full hold — the "stop here" branch — and whether the caller sees it depends on whether it
   * has applied `repaired` to the health yet. district/main.js repairs first and would be fine;
   * a host that composed first would flash "GARAGE / stop here" at the moment of success. Both
   * orders now read the same, which is the difference between a wire that is correct and one that
   * is correct by call order.
   */
  if (g.repaired) return null;
  if ((player.health ?? 1) >= 1) return null;
  if ((player.wantedStars ?? 0) > 0) {
    return { objective: { text: 'GARAGE' }, subtitle: 'not while they are looking',
      ownSubtitle: true };
  }
  if (g.dwell <= 0) {
    return { objective: { text: 'GARAGE' }, subtitle: 'stop here', ownSubtitle: true };
  }
  return { objective: { text: 'REPAIRING', distance: Math.ceil(g.left), unit: 's' },
    subtitle: 'hold still', ownSubtitle: true };
}
