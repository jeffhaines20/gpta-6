// Mission scripting: objectives, triggers, outcomes — as pure state.
//
// WHY IT LOOKS LIKE THIS. src/wanted.js established the shape that works in this
// project: no THREE, no DOM, no renderer, no Math.random, a fixed-dt `update()` that
// takes plain numbers, and a node gate that drives an hour of game time in
// milliseconds and lands on the same figures every run. Its own test says why —
// "the moment this module needs a scene to answer a question, it has stopped being
// testable and has started being a place bugs hide". A mission layer is mostly
// branching, which is exactly the code that rots unseen, so it gets the same
// treatment.
//
// THE RUNNER NEVER TOUCHES THE GAME. Triggers are pure predicates over a snapshot of
// numbers. Side effects are declared as DATA — `{ setWanted: 2 }`, `{ marker: ... }` —
// emitted as intents for district/main.js to execute. That is what lets the whole of
// a mission's branching be exercised with a fake world, and it is also why a mission
// cannot accidentally depend on frame order.
//
//   node tools/mission-test.mjs            the gate
//
// THE GRAPH IS VALIDATED AT LOAD, NOT AT PLAY. CLAUDE.md records geom-audit passing
// for as long as corner sites existed while being blind to half of them: "it passed
// the whole time. That was luck, not evidence." A mission with a `goto` naming a
// stage that does not exist, or a stage nothing can reach, or a stage with no way
// out, is the same defect — it looks fine until a player walks the one path nobody
// walked. defineMission() throws on all three.

/**
 * dt guard, lifted from wanted.js for the reason its comment gives: `this.time +=
 * NaN` is permanent and silently kills every timer downstream. `v > lo` is false for
 * NaN, so NaN takes the `lo` branch.
 */
const clamp = (v, lo, hi) => (v > lo ? (v > hi ? hi : v) : lo);

/** A mission is running, or it finished one of three ways. */
export const OUTCOMES = Object.freeze({
  RUNNING: 'running', PASSED: 'passed', FAILED: 'failed', ABORTED: 'aborted',
});

/**
 * THE TRIGGER VOCABULARY. Each entry is a pure predicate over the snapshot plus the
 * stage's own elapsed time; nothing here may read the world directly.
 *
 * `needs` lists the snapshot fields the predicate reads, and it is the load-bearing
 * part of this table rather than documentation.
 *
 * A TRIGGER READING AN ABSENT FIELD IS FALSE FOREVER. `undefined >= 2` is false;
 * `undefined === 'clear'` is false; `sqDist(undefined, ...)` is NaN and NaN fails
 * every comparison. So if district/main.js stops feeding `wantedStars`, the mission
 * does not error - it silently dead-ends on the stage that waits for the police, and
 * looks like a design problem. That is the same shape as a lever that reaches
 * nothing, which this project has shipped three times, and as the NaN-in-the-bottom-
 * quarter bug CLAUDE.md calls the most dangerous kind: its wrong answer is quiet.
 *
 * MissionRunner collects the union of `needs` over the whole mission at start() and
 * checks the first snapshot against it, throwing with the missing names. Once, at
 * the start, not per frame - the cost is one pass over a handful of strings.
 */
export const TRIGGERS = Object.freeze({
  // --- position -------------------------------------------------------------
  reach: {
    needs: ['px', 'pz'],
    test: (t, s) => sqDist(s.px, s.pz, t.x, t.z) <= t.radius * t.radius,
    validate: (t) => (Number.isFinite(t.x) && Number.isFinite(t.z) && t.radius > 0
      ? null : 'reach needs finite x, z and a radius above 0'),
  },
  leave: {
    needs: ['px', 'pz'],
    test: (t, s) => sqDist(s.px, s.pz, t.x, t.z) > t.radius * t.radius,
    validate: (t) => (Number.isFinite(t.x) && Number.isFinite(t.z) && t.radius > 0
      ? null : 'leave needs finite x, z and a radius above 0'),
  },
  // --- time -----------------------------------------------------------------
  // Reads the STAGE clock, not the mission clock: a "survive 30 s" stage entered
  // twice must want 30 s each time.
  timer: {
    needs: [],
    test: (t, s, stageTime) => stageTime >= t.seconds,
    validate: (t) => (t.seconds > 0 ? null : 'timer needs seconds above 0'),
  },
  // --- the police -----------------------------------------------------------
  wantedAtLeast: {
    needs: ['wantedStars'],
    test: (t, s) => s.wantedStars >= t.stars,
    validate: (t) => (t.stars >= 0 && t.stars <= 5 ? null : 'wantedAtLeast needs stars 0..5'),
  },
  wantedAtMost: {
    needs: ['wantedStars'],
    test: (t, s) => s.wantedStars <= t.stars,
    validate: (t) => (t.stars >= 0 && t.stars <= 5 ? null : 'wantedAtMost needs stars 0..5'),
  },
  // Clear AND out of the search state. wantedAtMost:0 is true during the search
  // phase the moment the last star drops, which is not "you got away".
  evaded: {
    needs: ['wantedStars', 'wantedState'],
    test: (t, s) => s.wantedStars <= 0 && s.wantedState === 'clear',
    validate: () => null,
  },
  // --- the player -----------------------------------------------------------
  inVehicle: { needs: ['inVehicle'], test: (t, s) => s.inVehicle === true, validate: () => null },
  onFoot: { needs: ['inVehicle'], test: (t, s) => s.inVehicle === false, validate: () => null },
  speedAbove: {
    needs: ['speed'],
    test: (t, s) => s.speed > t.kmh / 3.6,
    validate: (t) => (t.kmh > 0 ? null : 'speedAbove needs kmh above 0'),
  },
  speedBelow: {
    needs: ['speed'],
    test: (t, s) => s.speed < t.kmh / 3.6,
    validate: (t) => (t.kmh > 0 ? null : 'speedBelow needs kmh above 0'),
  },
  healthBelow: {
    needs: ['health'],
    test: (t, s) => s.health < t.fraction,
    validate: (t) => (t.fraction > 0 && t.fraction <= 1 ? null : 'healthBelow needs fraction in (0,1]'),
  },
  // --- composites -----------------------------------------------------------
  // `of` is a list of trigger bodies WITHOUT goto/outcome - they are predicates, not
  // edges. Nesting is allowed and the validator recurses, so a typo three levels
  // down is still caught at load.
  all: {
    needs: [],
    test: (t, s, st) => t.of.every((sub) => TRIGGERS[sub.kind].test(sub, s, st)),
    validate: (t) => (Array.isArray(t.of) && t.of.length ? null : 'all needs a non-empty `of`'),
  },
  any: {
    needs: [],
    test: (t, s, st) => t.of.some((sub) => TRIGGERS[sub.kind].test(sub, s, st)),
    validate: (t) => (Array.isArray(t.of) && t.of.length ? null : 'any needs a non-empty `of`'),
  },
});

function sqDist(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }

/** Every snapshot field any trigger can read, for the load-time check. */
export function snapshotFields() {
  const out = new Set();
  const walk = (k) => { for (const f of TRIGGERS[k].needs) out.add(f); };
  for (const k of Object.keys(TRIGGERS)) walk(k);
  return [...out].sort();
}

const COMPOSITE = new Set(['all', 'any']);

/**
 * Validate a mission and freeze it. Throws with every fault it found, not the first:
 * an author fixing one typo per run is an author who stops running the validator.
 */
export function defineMission(m) {
  const errs = [];
  const at = (s, i) => `stage "${s?.id ?? `#${i}`}"`;
  if (!m || typeof m !== 'object') throw new Error('defineMission: needs an object');
  if (!m.id) errs.push('mission needs an id');
  if (!m.title) errs.push('mission needs a title');
  if (!Array.isArray(m.stages) || !m.stages.length) errs.push('mission needs at least one stage');

  const stages = Array.isArray(m.stages) ? m.stages : [];
  const ids = new Map();
  stages.forEach((s, i) => {
    if (!s.id) { errs.push(`${at(s, i)}: needs an id`); return; }
    if (ids.has(s.id)) errs.push(`duplicate stage id "${s.id}"`);
    ids.set(s.id, i);
    if (!s.objective) errs.push(`${at(s, i)}: needs an objective string for the HUD`);
  });

  // Edges, and the three ways a graph goes wrong.
  const reachable = new Set(stages.length ? [stages[0].id] : []);
  const queue = stages.length ? [stages[0].id] : [];
  const edgesOf = (s) => (Array.isArray(s.triggers) ? s.triggers : []);

  const validateTrigger = (t, where, depth = 0) => {
    if (!t || !t.kind) { errs.push(`${where}: trigger needs a kind`); return; }
    const def = TRIGGERS[t.kind];
    if (!def) { errs.push(`${where}: unknown trigger kind "${t.kind}"`); return; }
    const bad = def.validate(t);
    if (bad) errs.push(`${where}: ${bad}`);
    if (COMPOSITE.has(t.kind) && Array.isArray(t.of)) {
      if (depth > 4) { errs.push(`${where}: composite nested deeper than 4`); return; }
      t.of.forEach((sub, j) => {
        if (sub && (sub.goto || sub.outcome)) {
          errs.push(`${where}: sub-trigger ${j} carries goto/outcome; composites take predicates, not edges`);
        }
        validateTrigger(sub, `${where} > ${t.kind}[${j}]`, depth + 1);
      });
    }
  };

  for (const s of stages) {
    const es = edgesOf(s);
    if (!es.length && !s.terminal) {
      errs.push(`${at(s)}: no triggers and not marked terminal — nothing can leave it`);
    }
    es.forEach((t, j) => {
      const where = `${at(s)} trigger ${j}`;
      validateTrigger(t, where);
      const hasGoto = typeof t.goto === 'string';
      const hasOut = typeof t.outcome === 'string';
      if (hasGoto === hasOut) errs.push(`${where}: needs exactly one of goto or outcome`);
      if (hasOut && !['passed', 'failed'].includes(t.outcome)) {
        errs.push(`${where}: outcome must be "passed" or "failed"`);
      }
      if (hasGoto && !ids.has(t.goto)) errs.push(`${where}: goto "${t.goto}" is not a stage id`);
    });
    if (s.timeLimit != null && !(s.timeLimit > 0)) errs.push(`${at(s)}: timeLimit must be above 0`);
    if (s.timeLimit != null && !s.onTimeout) {
      errs.push(`${at(s)}: timeLimit needs onTimeout ("failed", "passed" or a stage id)`);
    }
    if (s.onTimeout && !['passed', 'failed'].includes(s.onTimeout) && !ids.has(s.onTimeout)) {
      errs.push(`${at(s)}: onTimeout "${s.onTimeout}" is neither an outcome nor a stage id`);
    }
  }

  // Reachability, breadth-first from the first stage.
  while (queue.length) {
    const cur = stages[ids.get(queue.shift())];
    for (const t of edgesOf(cur)) {
      if (typeof t.goto === 'string' && ids.has(t.goto) && !reachable.has(t.goto)) {
        reachable.add(t.goto); queue.push(t.goto);
      }
    }
    if (cur.onTimeout && ids.has(cur.onTimeout) && !reachable.has(cur.onTimeout)) {
      reachable.add(cur.onTimeout); queue.push(cur.onTimeout);
    }
  }
  for (const s of stages) {
    if (s.id && !reachable.has(s.id)) errs.push(`${at(s)}: unreachable from the first stage`);
  }
  // At least one way to win. A mission that can only be failed is authored wrong,
  // and it is the kind of wrong that reads as "hard".
  const canPass = stages.some((s) => edgesOf(s).some((t) => t.outcome === 'passed')
    || s.onTimeout === 'passed');
  if (stages.length && !canPass) errs.push('no trigger anywhere reaches outcome "passed"');

  if (errs.length) {
    throw new Error(`defineMission("${m.id ?? '?'}") found ${errs.length} fault(s):\n  - ${errs.join('\n  - ')}`);
  }
  // The union of every snapshot field this mission's triggers will read, computed
  // once here so the runner's first-frame check is a lookup rather than a walk.
  const needs = new Set();
  const collect = (t) => {
    if (!t || !TRIGGERS[t.kind]) return;
    for (const f of TRIGGERS[t.kind].needs) needs.add(f);
    if (COMPOSITE.has(t.kind) && Array.isArray(t.of)) t.of.forEach(collect);
  };
  for (const s of stages) (Array.isArray(s.triggers) ? s.triggers : []).forEach(collect);
  return Object.freeze({ ...m, needs: Object.freeze([...needs].sort()),
    stages: Object.freeze(stages.map((s) => Object.freeze({ ...s }))) });
}

/**
 * Runs one mission at a time.
 *
 * Events, same emitter shape as WantedSystem so main.js wires them the same way:
 *   stage     { from, to, elapsed }    a stage boundary was crossed
 *   intent    { ...stage.onEnter }     declared side effects, for main.js to execute
 *   finished  { outcome, elapsed, stagesVisited }
 */
export class MissionRunner {
  constructor(opts = {}) {
    this.mission = null;
    this.stageIndex = -1;
    this.outcome = OUTCOMES.RUNNING;
    this.time = 0;              // mission clock
    this.stageTime = 0;         // stage clock, reset on every boundary
    this.visited = [];
    this.transitions = 0;
    this._listeners = new Map();
    // A transition budget per frame. A graph with a cycle of stages whose triggers
    // are all instantly true would otherwise spin forever inside one update() and
    // hang the frame. Bounded, and the overflow is REPORTED rather than swallowed:
    // a mission that trips this is authored wrong and the gate asserts it is seen.
    this.maxChainPerFrame = opts.maxChainPerFrame ?? 8;
    this.chainOverflows = 0;
    // CREATED HERE AND NOT ONLY IN start(), because report() reads it. A runner that
    // has never started a mission is a perfectly ordinary state — district/main.js
    // holds one from page load, and any harness that asks what the mission layer is
    // doing before starting one gets here first — and report() threw "this._range is
    // not iterable" on it. tools/damage-live.mjs found that on its first run, which is
    // three rounds after the offline gate passed 51 checks without ever calling
    // report() on a fresh runner.
    this._range = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }
  off(event, fn) { this._listeners.get(event)?.delete(fn); return this; }
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) for (const fn of set) fn(payload);
    return this;
  }

  start(mission) {
    this.mission = mission;
    this.stageIndex = 0;
    this.outcome = OUTCOMES.RUNNING;
    this.time = 0;
    this.stageTime = 0;
    this.visited = [mission.stages[0].id];
    this.transitions = 0;
    this.chainOverflows = 0;
    this._checkedSnapshot = false;
    // THE RANGE EACH READ FIELD ACTUALLY TOOK, so a trigger nobody can satisfy shows
    // up as a number instead of as a mystery.
    //
    // The absent-field check below catches a field that was never SUPPLIED. This
    // catches the other half: a field supplied as a constant. district/main.js has no
    // damage model, so `health` is 1.000 every frame and every healthBelow trigger in
    // every mission is inert - a fail condition that cannot fire, which reads as a
    // mission being generous rather than as a mission being broken. CLAUDE.md's
    // recurring complaint is levers that reach nothing; this is the same defect seen
    // from the mission's side, and report().fieldRange puts it in the audit.
    this._range = new Map();
    this._fireEnter(mission.stages[0]);
    return this.report();
  }

  abort(reason = 'aborted') {
    if (!this.mission || this.outcome !== OUTCOMES.RUNNING) return this.report();
    this.outcome = OUTCOMES.ABORTED;
    this.emit('finished', { outcome: this.outcome, reason, elapsed: this.time, stagesVisited: this.visited.slice() });
    return this.report();
  }

  get stage() {
    return this.mission && this.stageIndex >= 0 ? this.mission.stages[this.stageIndex] : null;
  }

  /**
   * One tick. `snap` is plain numbers; see snapshotFields().
   *
   * dt is clamped rather than trusted, for the reason wanted.js's clamp comment
   * gives: a first frame with an uninitialised dt, or a NaN out of the physics, is
   * permanent damage to every timer in here.
   */
  update(dt, snap) {
    if (!this.mission || this.outcome !== OUTCOMES.RUNNING) return this.report();
    // THE FIRST SNAPSHOT IS CHECKED AGAINST WHAT THE MISSION WILL READ. See the
    // TRIGGERS note: a missing field is not an error at the trigger, it is a
    // predicate that is false for the rest of the run.
    if (!this._checkedSnapshot) {
      this._checkedSnapshot = true;
      const missing = (this.mission.needs ?? []).filter((f) => !(snap && f in snap));
      if (missing.length) {
        throw new Error(`MissionRunner: mission "${this.mission.id}" reads ${missing.join(', ')}`
          + ` and the snapshot does not carry ${missing.length === 1 ? 'it' : 'them'}.`
          + ' A trigger on an absent field is false forever and the mission dead-ends silently.');
      }
      const nonFinite = ['px', 'pz', 'speed', 'health', 'wantedStars']
        .filter((f) => f in snap && typeof snap[f] === 'number' && !Number.isFinite(snap[f]));
      if (nonFinite.length) {
        throw new Error(`MissionRunner: snapshot field(s) ${nonFinite.join(', ')} are not finite;`
          + ' NaN fails every comparison silently and every distance trigger would never fire.');
      }
    }
    for (const f of this.mission.needs ?? []) {
      const v = snap[f];
      if (typeof v !== 'number') continue;
      const r = this._range.get(f);
      if (!r) this._range.set(f, { min: v, max: v });
      else { if (v < r.min) r.min = v; if (v > r.max) r.max = v; }
    }
    const d = clamp(dt, 0, 0.25);
    this.time += d;
    this.stageTime += d;

    let chain = 0;
    for (;;) {
      const s = this.stage;
      if (!s) break;
      let moved = false;

      // The stage's own deadline is checked BEFORE its triggers. A stage that can be
      // completed on the same frame its clock runs out should complete: the player
      // did reach the marker. Timeout is the fallback, not a race.
      const fired = this._firstFiring(s, snap);
      if (fired) {
        moved = this._take(s, fired.goto, fired.outcome, `trigger:${fired.kind}`);
      } else if (s.timeLimit != null && this.stageTime >= s.timeLimit) {
        const t = s.onTimeout;
        moved = ['passed', 'failed'].includes(t)
          ? this._take(s, null, t, 'timeout')
          : this._take(s, t, null, 'timeout');
      }

      if (!moved || this.outcome !== OUTCOMES.RUNNING) break;
      if (++chain >= this.maxChainPerFrame) { this.chainOverflows++; break; }
    }
    return this.report();
  }

  _firstFiring(s, snap) {
    const list = Array.isArray(s.triggers) ? s.triggers : [];
    for (const t of list) {
      if (TRIGGERS[t.kind].test(t, snap, this.stageTime)) return t;
    }
    return null;
  }

  _take(from, goto, outcome, why) {
    if (outcome) {
      this.outcome = outcome === 'passed' ? OUTCOMES.PASSED : OUTCOMES.FAILED;
      this.transitions++;
      this.emit('stage', { from: from.id, to: null, outcome: this.outcome, why, elapsed: this.stageTime });
      this.emit('finished', { outcome: this.outcome, reason: why, elapsed: this.time, stagesVisited: this.visited.slice() });
      return false;
    }
    const next = this.mission.stages.findIndex((s) => s.id === goto);
    if (next < 0) return false;              // defineMission makes this unreachable
    const prevId = from.id;
    this.stageIndex = next;
    this.stageTime = 0;
    this.transitions++;
    this.visited.push(goto);
    this.emit('stage', { from: prevId, to: goto, outcome: null, why, elapsed: this.time });
    // AN INTENT ENDS THE CHAIN FOR THIS FRAME, and the gate found out why.
    //
    // The Marlin Street ambush stage declares `onEnter: { setWanted: 2 }` and waits
    // for `evaded` - stars 0 and the search over. Without this break the runner
    // entered the stage, emitted the intent, and then evaluated `evaded` in the SAME
    // update against a snapshot still reading zero stars, because main.js had not
    // been given a frame to apply it. The chase was skipped entirely and the mission
    // slid from the ambush to the drop on one frame. The coverage walk caught it as
    // "clean -> passed at t=1.1s" on a mission whose chase alone is meant to take
    // twenty seconds.
    //
    // It is general, not specific to that mission: any intent that changes the world
    // has to land before the next trigger sees the world. So a stage whose entry
    // declares side effects gets its first evaluation on the NEXT tick.
    return !this._fireEnter(this.mission.stages[next]);
  }

  /** Emits the stage's declared side effects. Returns whether any were declared. */
  _fireEnter(s) {
    if (!s.onEnter) return false;
    this.emit('intent', { stage: s.id, ...s.onEnter });
    return true;
  }

  /** Straight into src/hud.js's own state contract. Null when nothing is running. */
  hud() {
    const s = this.stage;
    if (!s || this.outcome !== OUTCOMES.RUNNING) return null;
    const out = { objective: s.objective, subtitle: s.subtitle ?? null };
    if (s.marker) out.waypoint = { x: s.marker.x, z: s.marker.z };
    if (s.markers) out.markers = s.markers;
    // Seconds remaining, for a stage that has a deadline. Floored at 0 so a HUD
    // never renders a negative countdown on the frame the timeout resolves.
    if (s.timeLimit != null) out.secondsLeft = Math.max(0, s.timeLimit - this.stageTime);
    return out;
  }

  report() {
    const s = this.stage;
    return {
      mission: this.mission ? this.mission.id : null,
      outcome: this.outcome,
      stage: s ? s.id : null,
      stageIndex: this.stageIndex,
      stageCount: this.mission ? this.mission.stages.length : 0,
      elapsed: +this.time.toFixed(3),
      stageElapsed: +this.stageTime.toFixed(3),
      transitions: this.transitions,
      visited: this.visited.slice(),
      chainOverflows: this.chainOverflows,
      secondsLeft: s && s.timeLimit != null ? +Math.max(0, s.timeLimit - this.stageTime).toFixed(3) : null,
      // Numeric fields this mission read, and the range they took. A field whose min
      // equals its max never varied, so any trigger that needed it to cross a
      // threshold could not have fired. `constantFields` names them outright.
      fieldRange: Object.fromEntries([...this._range].map(([k, r]) => [k, [+r.min.toFixed(4), +r.max.toFixed(4)]])),
      constantFields: [...this._range].filter(([, r]) => r.min === r.max).map(([k]) => k).sort(),
    };
  }
}
