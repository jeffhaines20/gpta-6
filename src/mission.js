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
  /**
   * Clear, out of the search state, AND cleared BY GETTING AWAY. `wantedAtMost:0` is true during
   * the search phase the moment the last star drops, which is not "you got away" — and the first
   * two conditions alone are also true of an ARREST, which is the opposite of getting away.
   *
   * `clear('busted')` sets stars 0 and state 'clear', so this trigger could not tell being caught
   * from escaping. A blind playtester found the consequence on the flagship's chase stage, whose
   * exit is `all[timer 2, evaded]`: commit a crime, stop, be arrested, and the stage flipped to
   * `drop` in the SAME FRAME as the bust. Because a cooperating arrest does not abort the job and
   * hands the car back repaired, that route beat obeying the HUD by 4-14x — 13.6 s against
   * 55-190 s across five seeds, 4 of 4 arms reaching `drop` against 3 of 5.
   *
   * `src/wanted.js` already knew the difference and nothing asked it: see `clearedBy`.
   */
  evaded: {
    needs: ['wantedStars', 'wantedState', 'wantedClearedBy'],
    test: (t, s) => s.wantedStars <= 0 && s.wantedState === 'clear'
      && s.wantedClearedBy === 'escaped',
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
  /**
   * `start` IS WHERE A PLAYER PICKS THE JOB UP, and it is optional only because a harness may
   * want a mission that cannot be stumbled into. A mission WITHOUT one is unreachable from the
   * world: before this existed the only way to begin either authored mission was
   * `window.__district.startMission(id)` from the browser console, which a playtester reported
   * as the finding that dwarfed the rest of its round — "I was asked to play the first mission
   * and a player has no way to reach it".
   */
  if (m.start !== undefined) {
    const st = m.start;
    if (!st || typeof st !== 'object') errs.push('start must be { x, z, radius? }');
    else {
      if (!Number.isFinite(st.x) || !Number.isFinite(st.z)) errs.push('start needs finite x and z');
      if (st.radius !== undefined && !(st.radius > 0)) errs.push('start.radius must be above 0');
    }
  }

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
    /**
     * A POSITIONAL CUE NEEDS A POSITIONAL EXIT, and this is here rather than in a gate because
     * a gate rule has now put a wrong marker on one stage THREE TIMES. The ledger is in
     * `src/missions.js` under `ambush`; the short version is that each rule was right about
     * what it demanded and silent about the consequence, and the third marker satisfied both
     * earlier rules while pointing 322 m at a place where nothing whatever happens. A player
     * drove to it and stopped — which is what an arrow is for — and was arrested at the two
     * stars the stage itself had just given them.
     *
     * `marker` IS A DESTINATION: `MissionRunner.hud()` posts it as `waypoint`, which
     * `district/main.js` hands to the minimap as a `MARKER_STYLE.waypoint` pin and
     * `tools/playtest.mjs` reports as `look().waypoint` with a bearing and a range. There is no
     * reading of that in which it means anything but "go here".
     *
     * So: a stage with a marker must carry a `reach` trigger, and the marker must lie inside
     * that trigger's radius — the stage's OWN declared number, not a margin anybody picked, and
     * the exact property that makes arriving at the cue satisfy the stage. Measured over the
     * district when this landed, every correct marker was at 0.000 m from its reach target
     * (eastbound, drop, dropHot, shakedown/b, shakedown/c) and `ambush` was the only stage with
     * a marker and no `reach` at all. `tools/mission-test.mjs` prints those separations so a
     * drift off centre shows up as a number rather than waiting for the radius to be crossed.
     *
     * A composite is walked, because `{ all: [reach, ...] }` names a destination just as much
     * as a bare one does. `leave` is NOT a destination — `objectiveDistance` excludes it for
     * the same reason — so a stage whose only positional trigger is `leave` may not post a
     * marker either: an arrow pointing AT the thing you must get away from is the same defect
     * with the sign flipped.
     */
    if (s.marker) {
      const mk = s.marker;
      if (!Number.isFinite(mk.x) || !Number.isFinite(mk.z)) {
        errs.push(`${at(s)}: marker needs finite x and z`);
      } else {
        const reaches = [];
        const walk = (t) => {
          if (!t || !t.kind) return;
          if (t.kind === 'reach') reaches.push(t);
          if (COMPOSITE.has(t.kind) && Array.isArray(t.of)) t.of.forEach(walk);
        };
        es.forEach(walk);
        if (!reaches.length) {
          errs.push(`${at(s)}: posts a marker at (${mk.x}, ${mk.z}) and has no reach trigger,`
            + ' so the one navigational cue on screen points where nothing happens. A stage'
            + ' whose exit is not positional must not post a positional cue.');
        } else if (!reaches.some((t) => Number.isFinite(t.x) && Number.isFinite(t.z)
          && t.radius > 0 && Math.hypot(mk.x - t.x, mk.z - t.z) <= t.radius)) {
          const best = Math.min(...reaches.map((t) => Math.hypot(mk.x - t.x, mk.z - t.z)));
          errs.push(`${at(s)}: its marker is ${best.toFixed(1)} m from the nearest reach`
            + ` trigger, outside every one of their radii — arriving at the cue does not`
            + ' satisfy the stage');
        }
      }
    }
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
    // Cleared with the rest of the per-run state, so a restarted mission cannot put the previous
    // run's distance on its first frame's objective.
    this._px = null; this._pz = null; this._carRange = null;
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
    /**
     * WHAT `hud()` NEEDS TO PUT A NUMBER ON THE OBJECTIVE. Copied out as numbers rather than held
     * as a reference: both hosts reuse one snapshot object across frames, so a reference would
     * make `hud()` read whatever the NEXT frame wrote if the two were ever called out of order.
     *
     * `carRange` is OPTIONAL and is deliberately not in any trigger's `needs`. No predicate reads
     * it, so requiring it would make `start()` throw for a host that does not compute it — and the
     * whole point of the `needs` check is that it fires on a field a TRIGGER needs. A host without
     * it gets an objective with no distance, which `report().objectiveDistance` makes visible
     * rather than leaving to be discovered.
     */
    this._px = Number.isFinite(snap.px) ? snap.px : null;
    this._pz = Number.isFinite(snap.pz) ? snap.pz : null;
    this._carRange = Number.isFinite(snap.carRange) ? snap.carRange : null;

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
  /**
   * HOW FAR THE ACTIVE STAGE IS FROM BEING SATISFIED, in metres, or null when the stage names no
   * destination. `src/hud.js`'s objective band has carried an element for a distance since it was
   * written, dirty-checked per whole metre, and the only tenant using it was the law line.
   *
   * ROUND 6'S PLAYTESTER RAN TO 404 m FROM THE CAR reading "GET IN THE CAR" unchanged the whole
   * way. Two thirds of that was harness gaps and is fixed; this is the third.
   *
   * ONLY A TRIGGER MAY NAME A DESTINATION, and that is the part worth being strict about:
   *
   *   `reach`      the remaining distance to its own edge, `max(0, d - radius)`, so it reads 0
   *                exactly when the stage completes rather than still reading 28 m on arrival.
   *                Radii in this district's missions are 24, 28, 30 and 30 m.
   *   `inVehicle`  `carRange`, which is the distance to the thing you have to get into.
   *
   * A STAGE'S `marker` WAS NOT A DESTINATION, AND THIS GUARD COVERED HALF THE CASE.
   * `marlin-street`'s `ambush` carried one at (-194.8, 38.6) while being satisfied by a timer
   * AND an evasion, so this function correctly refused to put a number on it — and `hud()`
   * eleven lines below went on posting the same marker as `waypoint`, which the minimap draws
   * as a pin and `tools/playtest.mjs` reports with a bearing and a range. The distance was
   * fixed and the arrow was not, so the stage shipped with no number and a cue pointing 322 m
   * at a place where nothing happens; a playtester drove to it, stopped, and was arrested.
   * CLAUDE.md: a guard that covers half a case reads as a guard.
   *
   * `defineMission` now refuses that authoring outright — a marker must lie inside a `reach`
   * trigger's own radius — so a marker IS a destination and the two halves cannot disagree
   * again. `leave` is still excluded here: the number that matters there is how far you have
   * to GO, and the trigger fires on getting out rather than on getting to anything.
   */
  objectiveDistance() {
    const s = this.stage;
    if (!s || this.outcome !== OUTCOMES.RUNNING) return null;
    const list = s.triggers ?? [];
    for (const t of list) {
      if (t.kind === 'reach' && this._px != null && this._pz != null) {
        const d = Math.hypot(this._px - t.x, this._pz - t.z);
        return Math.max(0, d - t.radius);
      }
      if (t.kind === 'inVehicle' && this._carRange != null) return Math.max(0, this._carRange);
    }
    return null;
  }

  hud() {
    const s = this.stage;
    if (!s || this.outcome !== OUTCOMES.RUNNING) return null;
    const dist = this.objectiveDistance();
    const left = s.timeLimit != null ? Math.max(0, s.timeLimit - this.stageTime) : null;
    /**
     * A STRING WHEN THERE IS NO NUMBER, an object when there is. `objectiveLine` and src/hud.js's
     * DOM path both take either, and keeping the string form means a stage that names no
     * destination AND has no deadline renders exactly as it did.
     *
     * AND A STAGE WITH A CLOCK AND NO DESTINATION SHOWS THE CLOCK, which is the gap. Exactly one
     * stage in the game is that shape — `marlin-street`'s `ambush`, 240 s, no marker and no reach
     * trigger, because the thing it asks for is an evasion rather than an arrival. A blind
     * playtester ran it down: `secondsLeft` is 237.933 at entry, and over 237.9 s of running it out
     * the band showed two line families, `LOSE THEM` and `PROPERTY DAMAGE`, with **no countdown and
     * no number**. The only moving field in `look()` was `wantedNote`, which is about the police
     * rather than the clock. It then expired into `dropHot`, whose subtitle says "No more time" —
     * so the objective changed under the player on a deadline never shown.
     *
     * DISTANCE WINS WHERE A STAGE HAS BOTH, which `dropHot` does (300 s and a marker): how far you
     * have to go is the actionable number and the clock is pressure. So this fills a gap rather
     * than competing, and only `ambush` changes.
     *
     * `unit: 's'` IS NOT OPTIONAL. `objectiveLine` defaults to metres — its own comment says it
     * does so "because every objective in the game until the bust countdown was a distance, and a
     * tenant that means seconds must not be able to print them as metres" — and CLAUDE.md records
     * the bust countdown shipping a dropped unit that read "3 m" for a 3 s countdown. The same
     * convention as `composeLaw`'s countdown, deliberately, so there is one shape and not two.
     */
    const out = {
      objective: dist != null ? { text: s.objective, distance: dist }
        : left != null ? { text: s.objective, distance: left, unit: 's' }
          : s.objective,
      subtitle: s.subtitle ?? null };
    /**
     * A WAYPOINT IS A PROMISE THAT ARRIVING DOES SOMETHING, and `defineMission` is what keeps
     * it: a marker must sit inside one of the stage's own `reach` radii. See `objectiveDistance`
     * above for the round this cost.
     *
     * AND IT CARRIES THE RADIUS, so the two numbers on screen stop disagreeing. The band counts
     * to the trigger's EDGE — `max(0, d - radius)`, so it reads 0 exactly when the stage
     * completes — and the minimap drew a PIN at the centre, so a playtester measured "— 42 m" in
     * words against a blip 66 m out and the words reaching "0 m" while the blip was still 24 m
     * ahead. Both numbers were right about different things, which is the worst way for two
     * readouts to disagree.
     *
     * Publishing the radius lets `src/hud.js` draw the ZONE rather than a point, and then "0 m"
     * coincides with the player being inside the circle they can see. Measured before: the gap
     * was exactly the radius at every range, 23.5 to 24.0 m against a declared 24.
     */
    if (s.marker) {
      const reach = (s.triggers ?? []).find((t) => t.kind === 'reach' && Number.isFinite(t.x));
      out.waypoint = { x: s.marker.x, z: s.marker.z,
        radius: reach && reach.radius > 0 ? reach.radius : 0 };
    }
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
      /**
       * Metres still to go on the active stage, or null. Null for a stage that names no
       * destination — which is correct — AND for a host that does not feed `carRange` on an
       * `inVehicle` stage, which is not. The two are told apart by `objectiveDistanceFrom`.
       */
      objectiveDistance: (() => { const v = this.objectiveDistance(); return v == null ? null : +v.toFixed(2); })(),
      objectiveDistanceFrom: (() => {
        if (!s) return null;
        for (const t of s.triggers ?? []) {
          if (t.kind === 'reach') return this._px == null ? 'reach:no-position' : 'reach';
          if (t.kind === 'inVehicle') return this._carRange == null ? 'inVehicle:no-carRange' : 'inVehicle';
        }
        return null;
      })(),
      // Numeric fields this mission read, and the range they took. A field whose min
      // equals its max never varied, so any trigger that needed it to cross a
      // threshold could not have fired. `constantFields` names them outright.
      fieldRange: Object.fromEntries([...this._range].map(([k, r]) => [k, [+r.min.toFixed(4), +r.max.toFixed(4)]])),
      constantFields: [...this._range].filter(([, r]) => r.min === r.max).map(([k]) => k).sort(),
    };
  }
}

/**
 * WHAT A PLAYER CAN ACTUALLY START, and where.
 *
 * THIS EXISTS BECAUSE THE MISSIONS DID NOT. Both authored missions worked, both passed their
 * gate stage by stage, and neither could be begun by anybody holding a keyboard: the only entry
 * point was `window.__district.startMission(id)`, whose own comment says it is named "so a
 * harness can start, drive and audit a mission". A playtester put it plainly — "load the page
 * and you get free roam; the two authored missions are reachable only from the browser console"
 * — and called it the finding that dwarfed its other eleven. 347 gate checks were green over a
 * first mission nobody could reach.
 *
 * STOP IN THE MARKER AND IT STARTS. The first version was DRIVE INTO THE MARKER AND IT STARTS
 * — the genre's own convention, needing no new input plumbing, which mattered because the thing
 * being fixed was that the mission layer had no connection to the world at all. A key wants
 * src/input.js and the marker is a position with a radius, so entering it was enough.
 *
 * IT CONSCRIPTS. The spawn is 30.0 m from `shakedown`'s pickup, which is 2.5x the start radius,
 * and the only way east is through that disc. A playtester asked the harness to drive to the
 * FLAGSHIP's pickup and measured the other mission starting 13.75 s into the trip; reproduced on
 * the seeded harness it fires at t 13.8 s, 11.56 m from a 12 m ring, AT 24 km/h. The player had
 * taken no action at all, and there is no way out of a running mission but to finish it, wreck
 * the car or be arrested — so the cost of choosing the flagship first was about 1,450 m of
 * driving to reach a marker 455 m away.
 *
 * The comment this replaces said a 12 m disc is "hard to miss and impossible to sit in
 * accidentally". Both halves are true and they are about SITTING. Nothing in it was about
 * CROSSING, which is the failure: a car on the centreline of the street the disc straddles
 * covers 24.0 m of ring, 1.6 s at town speed, and the start fires on the first frame inside.
 *
 * So the start needs a DELIBERATE ARRIVAL, and this codebase already has that rule written down
 * once. `src/damage.js`'s garage refuses a moving car "so the garage is somewhere a player stops
 * rather than something they drive through on the way past", and `district/main.js` builds it
 * with `radius: OFFER_RADIUS_M` and `stopMs: SCENE_STOP_MS` — this module's radius and
 * src/wanted.js's stopped threshold. A mission pickup is the same shape as a garage zone: a 12 m
 * disc you are meant to arrive at. It gets the same threshold from the same source.
 *
 * `stopMs` IS A LEVEL AND NOT A DWELL, which is where this parts company with the garage. The
 * garage holds you for `holdS` because the repair takes time; taking a job does not, so there is
 * nothing to wait for and the stop IS the whole deliberate act. That also keeps `offerAt` a pure
 * function of position: no per-frame state on the board, so the latch below is untouched.
 *
 * ON FOOT TOO, and that is a change rather than an accident: WALK_SPEED is 3.2 m/s, so a player
 * who walks into a marker must stop. The cue is what makes it fair — `composeOffer` says
 * "stop to start" inside the ring, in the same words and the same shape as `composeGarage`'s
 * "stop here", which is the only reason a level a player cannot see is allowed to refuse them.
 *
 * THERE IS A NOTICE RADIUS AS WELL AS A START RADIUS, because a marker you can only discover by
 * driving through it is barely better than a console call. Inside `noticeFactor` times the start
 * radius the board reports the offer so the HUD can name it and count down the distance; inside
 * the start radius it fires once the player is stopped. 12 m and 48 m: a 12 m disc across a
 * 6.6 m street is hard to miss, and 48 m is about two seconds at town speed.
 *
 * A PASSED MISSION STOPS BEING OFFERED; A FAILED ONE DOES NOT. Wrecking the car on the way to
 * the marina should cost the run, not the mission — a game that deletes its own content on the
 * player's first mistake has one mission fewer, and this one has two.
 */
export const OFFER_RADIUS_M = 12;
export const OFFER_NOTICE_FACTOR = 4;

export class MissionBoard {
  constructor(missions, opts = {}) {
    const all = Array.isArray(missions) ? missions : Object.values(missions ?? {});
    this.list = all.filter((m) => m && m.start);
    /** Missions with no pickup point, named rather than silently dropped. */
    this.unreachable = all.filter((m) => m && !m.start).map((m) => m.id);
    this.radius = opts.radius ?? OFFER_RADIUS_M;
    this.noticeFactor = opts.noticeFactor ?? OFFER_NOTICE_FACTOR;
    /**
     * THE SPEED BELOW WHICH A PICKUP MAY FIRE, in m/s, and the default is a FALLBACK rather than
     * the number: the HOST passes src/wanted.js's `SCENE_STOP_MS`, exactly as it already does
     * when it builds `src/damage.js`'s garage. This module must not import src/wanted.js — a
     * default copied from another module is the second copy of a constant, which CLAUDE.md
     * records as the recurring defect here — so `tools/mission-test.mjs` asserts this fallback
     * equals the real constant, the way `damage-test` already does for the garage's.
     */
    this.stopMs = opts.stopMs ?? 1.0;
    this.outcomes = new Map();
    /**
     * MARKERS THAT MAY NOT FIRE AGAIN UNTIL THE PLAYER LEAVES THEM.
     *
     * Without this, a mission that ends while the player is standing in its own pickup restarts on
     * the very next frame. Found by tools/mission-live.mjs: aborting `shakedown` while parked on
     * its marker put it straight back into stage `a`, so the rings never came back and the abort
     * could not be observed at all. The same loop is reachable by every ending: wreck the car on
     * top of a marker and the job you just failed begins again before the band can say so.
     *
     * Entering a marker is an ACTION, so it needs an edge and not a level. A mission's marker is
     * latched when it ends and re-armed by `refresh()` the moment the player is outside its
     * radius — which is the same shape as the per-victim crime window in district/main.js, for the
     * same reason: the thing being repeated is one subject, not one kind of event.
     */
    this.latched = new Set();
    this.starts = 0;
    /**
     * COUNTED, so a refusal can never be silent. `refusedMoving` is per FRAME inside a pickup
     * above `stopMs` — a frame counter, not an event counter, which CLAUDE.md asks to be named
     * for what it counts after `stats.runOvers` read 3,684 against 0 charged run-overs.
     */
    this.refusedMoving = 0;
  }

  /** Latch a marker so it cannot fire again until the player has left it. */
  arm(id) { this.latched.add(id); return this; }

  /** Re-arm every latched marker the player is now clear of. Call once a frame. */
  refresh(x, z) {
    if (!this.latched.size) return this;
    for (const id of [...this.latched]) {
      const m = this.list.find((k) => k.id === id);
      if (!m) { this.latched.delete(id); continue; }
      if (Math.hypot(m.start.x - x, m.start.z - z) > this.radiusOf(m)) this.latched.delete(id);
    }
    return this;
  }

  radiusOf(m) { return m.start.radius ?? this.radius; }

  /** Every mission that has not been passed, in authoring order. */
  available() {
    return this.list.filter((m) => this.outcomes.get(m.id) !== OUTCOMES.PASSED);
  }

  /**
   * The nearest available offer within `range` of (x, z), with how far away it is.
   * `mode` is 'start' for the pickup radius and 'notice' for the wider announcement.
   */
  offerAt(x, z, mode = 'start') {
    let best = null;
    for (const m of this.available()) {
      // A latched marker is invisible to the START test and still NAMED by the notice test: the
      // job is on the board, it is simply not being entered again without leaving first.
      if (mode === 'start' && this.latched.has(m.id)) continue;
      const d = Math.hypot(m.start.x - x, m.start.z - z);
      const r = this.radiusOf(m) * (mode === 'notice' ? this.noticeFactor : 1);
      if (d <= r && (!best || d < best.distance)) {
        best = { mission: m, distance: +d.toFixed(2), radius: r };
      }
    }
    return best;
  }

  /**
   * THE OFFER THAT MAY ACTUALLY FIRE: inside the pickup, not latched, and the player stopped.
   * This is the one a host starts a mission from; `offerAt` stays a pure function of position so
   * the HUD can still NAME an offer the player is standing in but moving through.
   *
   * `speed` IS REQUIRED AND THERE IS NO PERMISSIVE DEFAULT. A `speed = 0` fallback would make
   * every caller that forgets it silently keep the drive-through behaviour this method exists to
   * remove — a guard whose default is the permissive case, which CLAUDE.md records twice as
   * reading like a guard without being one. `MissionRunner` already throws on a snapshot missing
   * a declared need, and this is the same discipline in the same module: a host that cannot say
   * how fast the player is going gets an exception rather than a conscription.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} speed  the player's planar speed in m/s — the CAR's own when driving and the
   *   person's when on foot, which is the quantity `_snapshot()` already computes in both hosts.
   */
  pickupAt(x, z, speed) {
    const hot = this.offerAt(x, z, 'start');
    if (!hot) return null;
    if (!Number.isFinite(speed)) {
      throw new TypeError('MissionBoard.pickupAt needs the player speed in m/s');
    }
    if (speed >= this.stopMs) { this.refusedMoving++; return null; }
    return hot;
  }

  /** Every available offer as a HUD blip. The same shape MissionRunner.hud()'s markers use. */
  markers() {
    return this.available().map((m) => ({ x: m.start.x, z: m.start.z, kind: 'offer', id: m.id }));
  }

  /** Called when a mission finishes, so the board stops offering a job already done. */
  record(id, outcome) { this.outcomes.set(id, outcome); return this; }

  report() {
    return {
      offered: this.list.map((m) => m.id),
      unreachable: this.unreachable.slice(),
      available: this.available().map((m) => m.id),
      outcomes: Object.fromEntries(this.outcomes),
      latched: [...this.latched],
      starts: this.starts,
      radius: this.radius,
      noticeRadius: this.radius * this.noticeFactor,
      stopMs: this.stopMs,
      refusedMoving: this.refusedMoving,
    };
  }
}

/**
 * THE OFFER'S BAND LINE, in this module rather than in either host, because an offer line
 * assembled in `district/main.js` is a line `tools/playtest.mjs` cannot reproduce — the defect
 * CLAUDE.md records as "a host rule is a rule no offline gate can reach", measured once at four
 * of `composeBand`'s five tenants being missing from the node harness's own view of the screen.
 * Both hosts built this line inline and byte-differently before it moved here.
 *
 * TWO BRANCHES, and the second is the whole point of `pickupAt`:
 *
 *   - inside the PICKUP and moving -> "SHAKEDOWN / stop to start". A level a player cannot see
 *     is only allowed to refuse them if something says so, and `composeGarage`'s "stop here" is
 *     the precedent this copies, down to the `ownSubtitle`.
 *   - inside the NOTICE radius -> "SHAKEDOWN / <brief> — 312 m", which is what it always said.
 *
 * `ownSubtitle` ON BOTH, for `composeGarage`'s reason: src/hud.js's HOLDS_MISSION_SUBTITLE would
 * otherwise replace an instruction with a mission objective. Nothing is running while an offer
 * shows, so there is no objective to be replaced BY today — this is the conditional half, and it
 * costs nothing to be right about now rather than after somebody stacks a tenant on it.
 *
 * @param {object|null} offer  an `offerAt(x, z, 'notice')` result, or null
 * @param {{stopped:boolean, inPickup:boolean}} at
 */
export function composeOffer(offer, at = {}) {
  if (!offer || !offer.mission) return null;
  const title = String(offer.mission.title ?? offer.mission.id ?? '').toUpperCase();
  if (at.inPickup && !at.stopped) {
    return { objective: { text: title }, subtitle: 'stop to start', ownSubtitle: true };
  }
  // A PLAIN STRING on this branch and a `{ text }` on the other, deliberately: `objectiveLine`
  // flattens both and this is the shape the notice line has always shipped as. A change that
  // adds a branch should not also retitle the branch that was already there.
  return {
    objective: title,
    subtitle: `${offer.mission.brief} — ${Number(offer.distance ?? 0).toFixed(0)} m`,
    ownSubtitle: true,
  };
}
