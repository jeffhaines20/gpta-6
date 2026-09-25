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
   * Pedestrian fatality against impact speed is one of the best-measured curves in
   * road safety: roughly 10% at 30 km/h, 50% at 45 km/h, 90% at 80 km/h (Ashton &
   * Mackay; Rosen & Sander). 45 km/h is where it crosses even, so that is the line
   * between `pedestrianHit` and `pedestrianKilled`. It is a speed, not a delta-v,
   * because what matters to the person is how fast the bumper was travelling.
   */
  pedKillSpeed: 12.5,   // m/s (45 km/h)
});

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
      this.lastImpact = out;
      return out;
    }
    out.dv = Math.abs(dv);
    if (out.dv > this.stats.worstDv) this.stats.worstDv = out.dv;

    const weights = this.regionWeights(dirX, dirZ);
    out.weights = weights;
    out.region = REGIONS.reduce((a, r) => (weights[r] > weights[a] ? r : a), 'front');
    out.crime = this._crimeFor(kind, out.dv, finite(speed) ? Math.abs(speed) : 0);

    const severity = this.severityFor(out.dv);
    out.severity = severity;
    if (severity <= 0) {
      out.reason = 'below-threshold';
      this.stats.rejected++;
      this.lastImpact = out;
      return out;
    }

    // Minor impacts refract per region; a major one always lands.
    if (severity < this.majorSeverity &&
        this.time - this._lastMinorAt[out.region] < this.minorRefractory) {
      out.reason = 'refractory';
      this.stats.refracted++;
      this.lastImpact = out;
      return out;
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
    this.lastImpact = out;
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
    if (dv < this.freeDv) return null;
    switch (kind) {
      case IMPACT.police: return 'policeProperty';
      case IMPACT.roadblock: return 'roadblockRun';
      case IMPACT.vehicle: return 'civilianCollision';
      case IMPACT.wall: case IMPACT.prop: return 'propertyDamage';
      default: return null;
    }
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
