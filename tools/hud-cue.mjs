// Does the HUD actually DRAW what the state says? A render gate for src/hud.js.
//
// Every other check over this module is on pure functions — `composeBand`'s five tenants in
// playtest --selftest, the marker styles, the layout arithmetic — and none of them touches the
// canvas. So a panel could stop drawing entirely and the whole gate list would stay green. That
// is the shape CLAUDE.md records again and again: the module is right, its gate asserts the
// module, and nothing asserts that the pixels change.
//
// The subject is the damage steer-pull cue, which is the first thing in this HUD whose entire
// value is that the player can SEE it. A playtester reported the pull as violent AND that nothing
// on screen says which way to hold; measured hands-off with a pull at its 0.25 cap, the car turns
// 46 degrees in four seconds at 30 km/h and 98 at 100, drifting 14.5 and 52.9 m off line. It is
// correctable at every speed — full opposite lock overshoots — so what was missing was the
// information, not the authority.
//
// WRITING THIS FOUND TWO THINGS, both of which would have shipped:
//
//   1. The first probe read ZERO rectangles at every pull, and the cue was fine. The HUD
//      dirty-flags its panels, so a SETTLED value is not redrawn — sampling one late frame reads
//      an empty list however well the cue works. The gate records across the run and takes the
//      last frame on which the vitals panel actually drew, marked by the health bar.
//   2. It then reported the arm on the RIGHT for a left pull, because it identified the arm by
//      width and the centre tick is also 1 px wide. The arm is the only rectangle in the band
//      drawn in a THEME colour, so it is identified by fill.
//
//   node tools/hud-cue.mjs
import { THEME, LAYOUT, composeBand, MINIMAP_ZOOM_M, MINIMAP_REACH_M,
  PULL_CAP, PULL_MIN, PULL_MIN_PX, PULL_FULL_PX, PULL_TICK_PX, objectiveLine } from '../src/hud.js';
import { composeWanted, composeLaw, LAW_NOTICE_S, STATES } from '../src/wanted.js';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

/**
 * A DOM thin enough to construct the HUD and record what it draws, and no thinner.
 *
 * `fillRect` alone was enough while the subject was the steer-pull cue, which is four rectangles.
 * It cannot see the star meter or the minimap: a star is `starPath` + `fill()` and a blip is
 * `arc()`/`rect()` + `fill()`, so a panel made entirely of those was invisible to this gate and
 * every check over it would have been vacuous — which is the exact defect this file exists to
 * catch, one layer up. So `fill()` (with the live fillStyle, in call order), `fillText()` and the
 * two path primitives the markers use are recorded too.
 */
/**
 * AND EVERY RECORD CARRIES THE CANVAS IT WAS DRAWN ON, because one `hud.update()` draws the map,
 * the gauge, the vitals and the status panel into the same recorder. The first version of the
 * star-meter check took "the first five `fill()` calls" and read the MINIMAP's fills — a clean
 * table of five plausible alphas, none of them a star. Untagged, a check over any panel made of
 * `fill()` calls is a check over whichever panel happens to draw first.
 */
let elSeq = 0;
const rects = [];
const fills = [];     // { el, fill } in call order; a star's colour is identified by its index
const texts = [];     // { el, text, x, y, fill, font, align }
const paths = [];     // { el, op:'arc'|'rect', ... } — what the minimap's blips are made of
function mkCtx(el) {
  return {
    save() {}, restore() {}, setTransform() {}, resetTransform() {}, transform() {},
    clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc(x, y, r) { paths.push({ el, op: 'arc', x, y, r }); },
    arcTo() {}, roundRect() {}, ellipse() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    rect(x, y, w, h) { paths.push({ el, op: 'rect', x, y, w, h }); },
    clip() {},
    fill() { fills.push({ el, fill: this.fillStyle }); },
    stroke() {}, translate() {}, rotate() {}, scale() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    fillText(text, x, y) {
      texts.push({ el, text, x, y, fill: this.fillStyle, font: this.font, align: this.textAlign });
    },
    strokeText() {}, drawImage() {},
    strokeRect() {}, setLineDash() {}, putImageData() {},
    getImageData: () => ({ data: new Uint8Array(4) }),
    fillRect(x, y, w, h) { rects.push({ el, x, y, w, h, fill: this.fillStyle }); },
    letterSpacing: '0px',
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: '',
    textAlign: '', textBaseline: '', shadowBlur: 0, shadowColor: '', lineCap: '', lineJoin: '',
    font: '', filter: '', imageSmoothingEnabled: true,
  };
}
function mkEl() {
  const id = elSeq++;
  const el = {
    _id: id,
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    dataset: {}, children: [], width: 512, height: 512, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { el.children.push(c); if (c && c.nodeType === 3) el.textContent += c.textContent; return c; },
    replaceChildren(...cs) { el.children.length = 0; el.textContent = '';
      for (const c of cs) el.appendChild(c); },
    setAttribute() {}, removeAttribute() {}, remove() {}, getContext: () => mkCtx(id),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 512, height: 512, top: 0, left: 0 }),
  };
  return el;
}
globalThis.window = {
  devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  requestAnimationFrame: () => 0,
};
globalThis.document = {
  createElement: () => mkEl(), createElementNS: () => mkEl(),
  /**
   * `_syncText` builds the subtitle out of text nodes when it has a speaker, so the stub needs
   * one. It carries `textContent` because that is what this gate reads the objective's distance
   * off — the distance is DOM text, not a canvas fill, so the recorder cannot see it.
   */
  createTextNode: (t) => ({ textContent: String(t ?? ''), nodeType: 3 }),
  head: mkEl(), body: mkEl(), getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

const { HUD } = await import('../src/hud.js');
const hud = new HUD({});

/** The cue's own band, from `_pullCue`. */
const CUE_Y = 20.5, CUE_H = 3.5;
/** The health bar, drawn on every vitals pass, so its presence marks one. */
const isVitalsPass = (rs) => rs.some((r) => Math.abs(r.y - 2) < 1e-9 && Math.abs(r.h - 7) < 1e-9);

/**
 * Drive the HUD to a settled pull and return the last frame the vitals panel drew on.
 * See the header: sampling any single late frame reads nothing, because the panel is dirty-flagged.
 */
function frameAt(pull, frames = 200) {
  let last = null;
  for (let i = 0; i < frames; i++) {
    rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
    hud.update({
      dt: 1 / 60, visible: true, speed: 40, health: 1, armour: 0,
      vehicle: {
        roadSpeed: 11, forwardSpeed: 11, steerPull: pull,
        position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 },
      },
    });
    if (isVitalsPass(rects)) last = [...rects];
  }
  /**
   * NEVER A BARE NULL. The sweep below dereferenced this and the gate THREW on a mutation that
   * pinned `s.steerPull` to 0 — `TypeError: Cannot read properties of null` — which printed no FAIL
   * line at all, so a grep for failures saw the mutation as caught by nothing and as breaking
   * nothing. CLAUDE.md's "a tool that throws is not a tool that passes, and nobody notices which",
   * arrived at through my own grep.
   *
   * It happens for a real reason worth recording: with the pull pinned, no later call changes any
   * vitals input, the panel is never dirtied again, and 200 frames pass with no vitals pass at all.
   * A caller gets an empty band and `vitalsDrew: false`, and the checks read that as the failure it
   * is.
   */
  const band = (last ?? []).filter((r) => Math.abs(r.y - CUE_Y) < 1e-9 && Math.abs(r.h - CUE_H) < 1e-9);
  // The arm is the only rectangle in the band in a THEME colour; track and tick are rgba().
  const arm = band.find((r) => typeof r.fill === 'string' && r.fill.startsWith('#'));
  const track = band.find((r) => r.w > 100);
  return { band, arm, track, vitalsDrew: !!last };
}

console.log('HUD CUE — the damage steer-pull indicator');

// A vitals pass has to be observable at all, or every check below is vacuous.
{
  const f = frameAt(0.25);
  check('the vitals panel draws at all, so this gate can see the HUD', !!f && f.vitalsDrew,
    f ? `${f.band.length} rects in the cue band` : 'no vitals pass in 200 frames');
}

/**
 * THE STATE HAS TO TRACK THE VEHICLE, asserted on its own. A mutation that replaced
 * `s.steerPull = v.steerPull ?? 0` with a constant 0 was caught by nothing here — it made the gate
 * throw rather than fail, and once that was fixed it would have read as "no cue drawn", which is
 * indistinguishable from the cue being deleted. The read is a separate link in the chain from the
 * draw, so it gets its own check.
 */
{
  const seen = [];
  for (const pull of [0.25, -0.18, 0]) {
    for (let i = 0; i < 200; i++) {
      hud.update({ dt: 1 / 60, visible: true, speed: 40, health: 1, armour: 0,
        vehicle: { roadSpeed: 11, forwardSpeed: 11, steerPull: pull,
          position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
    }
    seen.push({ pull, state: hud.state.steerPull, disp: hud.disp.steerPull });
  }
  console.log('\n  the read: vehicle.steerPull -> state -> damped display');
  for (const r of seen) {
    console.log(`    ${String(r.pull).padStart(6)} -> state ${r.state.toFixed(4).padStart(8)} ` +
      `-> disp ${r.disp.toFixed(4).padStart(8)}`);
  }
  check('the HUD reads steerPull off the vehicle',
    seen.every((r) => Math.abs(r.state - r.pull) < 1e-12),
    seen.map((r) => `${r.pull}:${r.state}`).join(' '));
  check('and the display follows it, signed',
    seen.every((r) => Math.abs(r.disp - r.pull) < 1e-3),
    seen.map((r) => r.disp.toFixed(4)).join(' '));
  // Non-empty by construction: a sweep of all zeros would satisfy both tests above.
  check('the read arm exercises a non-zero pull in both directions',
    seen.some((r) => r.pull > 0.1) && seen.some((r) => r.pull < -0.1),
    seen.map((r) => r.pull).join(' '));
}

console.log('\n  steerPull   rects   arm x      arm w    colour     side');
const rows = [];
for (const pull of [0, 0.01, 0.0197, 0.06, 0.12, 0.25, -0.06, -0.25]) {
  const f = frameAt(pull);
  if (!f.vitalsDrew && pull !== 0) {
    check(`the vitals panel drew for pull ${pull}`, false, 'no vitals pass in 200 frames');
  }
  const w = f.track ? f.track.w : 0;
  const side = f.arm ? (f.arm.x >= w / 2 ? 'right' : 'left') : '-';
  rows.push({ pull, ...f, w, side });
  console.log(`  ${String(pull).padStart(9)}   ${String(f.band.length).padStart(5)}   ` +
    `${(f.arm ? f.arm.x.toFixed(1) : '-').padStart(6)}   ${(f.arm ? f.arm.w.toFixed(2) : '-').padStart(7)}   ` +
    `${(f.arm ? f.arm.fill : '-').padStart(8)}   ${side}`);
}
const at = (p) => rows.find((r) => r.pull === p);

// 1. An undamaged car gets no extra chrome. This is also the known-bad guard: a cue that always
//    draws would pass every other check in this file.
check('an undamaged car draws no cue', at(0).band.length === 0 && !at(0).arm,
  `${at(0).band.length} rects`);
check('KNOWN-BAD: something IS drawn once the pull is real', at(0.06).band.length > 0,
  `${at(0.06).band.length} rects at 0.06`);

/**
 * THE THRESHOLD, RESTATED IN THE SAME COMMIT THAT MOVED IT, with the derivation.
 *
 * This check used to read "a pull under 2% is below the threshold", asserting `_pullCue`'s old
 * `mag > 0.02`. That value is defensible on its own terms — a hands-off car at 0.02 of pull leaves
 * a 2.35 m half-lane in 3.9 s at 50 km/h, measured — and it was still wrong, because it is a STEP
 * at 9.2 PIXELS of arm: the cue went from nothing at all straight to a nine-pixel bar. A round-5
 * playtester measured the blind zone underneath it, an 11.12 m drift over 118.7 m with no cue at
 * all, which I reproduce as 10.92 m over 124.0 m on a 630 m radius.
 *
 * The threshold is now one pixel of arm, `PULL_CAP / PULL_FULL_PX`, which is what a reading owes:
 * visible wherever the quantity is resolvable. There is no noise floor to suppress — src/damage.js
 * gives EXACTLY zero on an undamaged car — so the canvas is the only floor there is.
 *
 * Asserted against the module's own exported geometry, not against a copied 115: a check that
 * re-derived the arithmetic would be agreeing with itself.
 */
/**
 * AND A SETTLED READER, because near the threshold the dirty flag decides the answer.
 *
 * `frameAt` returns the LAST frame the panel drew on, which `update()` leaves up to
 * `0.0015 * exp(10/60)` of pull short of the commanded value — the epsilon this file already
 * derives, 0.815 px on a 115 px arm. That shortfall is a rounding error against a 27 px arm and it
 * is the whole answer against a 1 px one: the first version of these checks read ZERO rects at
 * 1.5 px of commanded arm, because the last drawn frame carried 0.894 px. Two adjacent sweep
 * values closer together than the epsilon do it too — 0.0197 then 0.02 never dirties the panel at
 * all, and reads as "draws nothing" at a value well above the threshold.
 *
 * So the threshold arms settle the value first and then force one pass with `layout()`, which is
 * the public "redraw everything". The checks above keep `frameAt` and its epsilon, because what
 * they measure is the arm's LENGTH where that shortfall is the right thing to allow for.
 */
function settledAt(pull, frames = 300) {
  for (let i = 0; i < frames; i++) {
    hud.update({ dt: 1 / 60, visible: true, speed: 40, health: 1, armour: 0,
      vehicle: { roadSpeed: 11, forwardSpeed: 11, steerPull: pull,
        position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
  }
  hud.layout();
  rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
  hud.update({ dt: 1 / 60, visible: true, speed: 40, health: 1, armour: 0,
    vehicle: { roadSpeed: 11, forwardSpeed: 11, steerPull: pull,
      position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
  const band = rects.filter((r) => Math.abs(r.y - CUE_Y) < 1e-9 && Math.abs(r.h - CUE_H) < 1e-9);
  return { band, arm: band.find((r) => typeof r.fill === 'string' && r.fill.startsWith('#')),
    drew: isVitalsPass(rects) };
}

console.log(`\n  the cue's arm is ${PULL_FULL_PX} px at the ${PULL_CAP} cap, so one pixel of arm ` +
  `is a pull of ${PULL_MIN.toFixed(5)}; the old 0.02 threshold was ${(0.02 / PULL_MIN).toFixed(1)} px`);
{
  const rows = [PULL_MIN * 0.5, PULL_MIN * 1.5, 0.01, 0.0197, 0.02];
  console.log('    pull      settled arm px');
  for (const q of rows) {
    const f = settledAt(q);
    console.log(`    ${q.toFixed(5).padStart(8)}  ${(f.arm ? f.arm.w.toFixed(2) : 'none').padStart(14)}`);
  }
}
/**
 * MEASURED OFF THE DRAWN ARM, because the first version of this check was circular twice over:
 * `PULL_MIN === PULL_CAP / PULL_FULL_PX` compares a constant with the expression it is DEFINED as,
 * and the second clause re-derived `LAYOUT.vitals.w / 2 - 1`, which is the copied 115 in a
 * different spelling — the very thing the neighbouring comment says not to do. A reviewer changed
 * `_pullCue`'s own local `armFull` to `L.w / 2` and it passed.
 *
 * What has teeth is the arm the cue actually DRAWS at the cap: `PULL_MIN` must be one pixel of
 * THAT, so the page's threshold and the harness's are one quantity.
 */
const drawnFull = settledAt(PULL_CAP).arm?.w ?? NaN;
console.log(`  the arm drawn at the ${PULL_CAP} cap is ${drawnFull.toFixed(2)} px; one pixel of it ` +
  `is ${(PULL_CAP / drawnFull).toFixed(5)} of pull against PULL_MIN ${PULL_MIN.toFixed(5)}`);
check('the threshold is one pixel of the arm the cue actually draws',
  Math.abs(PULL_MIN - PULL_CAP / drawnFull) < 1e-6,
  `${PULL_MIN.toFixed(6)} against ${(PULL_CAP / drawnFull).toFixed(6)}`);
check('and the exported arm length is the one drawn, not a second copy of it',
  Math.abs(PULL_FULL_PX - drawnFull) < 1e-6, `${PULL_FULL_PX} against ${drawnFull.toFixed(2)}`);
check('a pull below one pixel of arm draws nothing', settledAt(PULL_MIN * 0.5).band.length === 0,
  `${settledAt(PULL_MIN * 0.5).band.length} rects at ${(PULL_MIN * 0.5).toFixed(5)}`);
check('and a pull above it draws', settledAt(PULL_MIN * 1.5).band.length > 0,
  `${settledAt(PULL_MIN * 1.5).band.length} rects at ${(PULL_MIN * 1.5).toFixed(5)}`);
check('the settled reader saw a vitals pass at all, so those two are not both vacuous',
  settledAt(PULL_MIN * 1.5).drew && settledAt(PULL_MIN * 0.5).drew, 'both drew');
/**
 * THE BLIND ZONE IS GONE, which is the whole point and needs saying as its own check: the two
 * above would pass for a threshold anywhere below 0.02.
 */
check('the 13 km/h scrape that drew nothing now draws a cue',
  !!settledAt(0.0197).arm, `${settledAt(0.0197).arm?.w.toFixed(2)} px of arm`);
check('and so does the half-of-that scrape below it',
  !!settledAt(0.01).arm, `${settledAt(0.01).arm?.w.toFixed(2)} px of arm`);
// A small arm has to read as an arm rather than as the centre tick it sits beside.
check('the shortest arm drawn is wider than the centre tick',
  PULL_MIN_PX > PULL_TICK_PX && settledAt(PULL_MIN * 1.5).arm?.w >= PULL_MIN_PX,
  `${settledAt(PULL_MIN * 1.5).arm?.w.toFixed(2)} px against a ${PULL_TICK_PX} px tick`);

/**
 * THE LAST DRAWN FRAME IS ALWAYS A LITTLE SHORT OF THE TARGET, and that is the dirty flag, not a
 * defect. `update()` keeps the vitals panel dirty only while `|disp - state| > 0.0015`, so the
 * final pass necessarily draws a damped value about 0.0015 below the commanded pull — 0.2485 for a
 * 0.25 command. Both of these checks were first written against the ideal settled value and failed
 * by 0.08 and 0.78 of a pixel.
 *
 * The tolerance is that threshold converted into pixels rather than a number chosen to make the
 * check pass: 0.0015 of pull, over the 0.25 cap, across the arm's full length.
 */
const DIRTY_EPS = 0.0015;
/**
 * And the bound is ONE DAMPING STEP WIDER than that epsilon, which is the second thing these two
 * checks got wrong. `update()` damps first and tests after, so the last pass drawn is the last frame
 * whose remaining gap still EXCEEDED the epsilon — and the frame before that one was up to
 * `exp(rate * dt)` further out. With hud.js's rate of 10 and this gate's 1/60 s step that is 1.181,
 * so the true bound is 0.001772 of pull and 0.815 px, not 0.69. Measured 0.78, which sits inside the
 * derived bound and outside the naive one.
 */
const DAMP_RATE = 10, DT = 1 / 60;
// From the module's own export rather than re-derived off the drawn track: `PULL_FULL_PX` is what
// `_pullCue` scales the arm by, so a copy here would be this gate agreeing with its own arithmetic.
const armFull = PULL_FULL_PX;
const PX_EPS = (DIRTY_EPS * Math.exp(DAMP_RATE * DT) / 0.25) * armFull;
console.log(`\n  the dirty-flag epsilon is ${DIRTY_EPS} of pull; one damping step wider is ` +
  `${(DIRTY_EPS * Math.exp(DAMP_RATE * DT)).toFixed(6)}, which is ${PX_EPS.toFixed(2)} px on a ` +
  `${armFull.toFixed(2)} px arm — so the last pass draws that short of the target`);
// 2. The side. This is the whole instruction — hold the other way — so it is the check that
//    matters most, and the one the first probe got wrong by identifying the arm by width.
check('a right pull draws on the right', at(0.25).side === 'right', at(0.25).side);
check('a left pull draws on the left', at(-0.25).side === 'left', at(-0.25).side);
check('and the two are mirrored, within the dirty-flag epsilon',
  at(0.25).arm && at(-0.25).arm && Math.abs(at(0.25).arm.w - at(-0.25).arm.w) <= PX_EPS,
  `${at(0.25).arm?.w.toFixed(2)} against ${at(-0.25).arm?.w.toFixed(2)}, epsilon ${PX_EPS.toFixed(2)}`);

// 3. The magnitude is monotonic and reaches the full arm at the cap, so the bar is a reading and
//    not a light. A constant-width marker would pass the side checks.
const widths = [0.06, 0.12, 0.25].map((p) => at(p).arm?.w ?? 0);
check('the arm grows with the pull', widths[0] < widths[1] && widths[1] < widths[2],
  widths.map((w) => w.toFixed(2)).join(' < '));
check('and fills its arm at the 0.25 cap, within the same epsilon',
  at(0.25).arm && at(0.25).arm.w >= armFull - PX_EPS,
  `${at(0.25).arm?.w.toFixed(2)} of ${armFull.toFixed(2)}, epsilon ${PX_EPS.toFixed(2)}`);

// 4. The colour is a state readout, on the health bar's own convention, so peripheral vision
//    reports it. Asserted against THEME rather than against copied hex.
check('under a third of the cap reads healthy', at(0.06).arm?.fill === THEME.health,
  `${at(0.06).arm?.fill} against ${THEME.health}`);
check('past a third it goes amber', at(0.12).arm?.fill === THEME.healthLow,
  `${at(0.12).arm?.fill} against ${THEME.healthLow}`);
check('and at the cap it is critical', at(0.25).arm?.fill === THEME.healthCrit,
  `${at(0.25).arm?.fill} against ${THEME.healthCrit}`);
check('the colour depends on the magnitude, not the direction',
  at(0.06).arm?.fill === at(-0.06).arm?.fill,
  `${at(0.06).arm?.fill} / ${at(-0.06).arm?.fill}`);

/**
 * THE STAR METER, which nothing had ever looked at.
 *
 * `wanted` had a source, and one playtester escaped four stars over 96 s reporting that the star
 * COUNT was the only field of the HUD that ever differed over the whole run. The drain and the
 * note are the fix; this is the part of it that only a render gate can see, because both are drawn
 * with `fill()` and `fillText()` and neither existed in this recorder until now.
 *
 * The status panel is dirty-flagged like the vitals one, so the same last-drawn-frame discipline
 * applies — see the header. It is marked by the weapon plate's `--` placeholder, which every
 * status pass draws.
 */
console.log('\nSTATUS PANEL — the stars, the drain and the note');
const STATUS_EL = hud.cStatus._id;
const onStatus = (rs) => rs.filter((r) => r.el === STATUS_EL);
/** The weapon plate's `--` placeholder is drawn on every status pass, so it marks one. */
const isStatusPass = (ts) => onStatus(ts).some((t) => t.text === '--');
/**
 * THE ESCALATION FLASH IS ON THE WALL CLOCK, AND THIS GATE HAS NO WALL CLOCK.
 *
 * `update()` sets `_escalateUntil = performance.now()/1000 + escalateSeconds` on any star INCREASE
 * and the flash stays up until that passes. 200 frames of `dt: 1/60` take about 20 ms of real time,
 * so every arm that raises the star count flashes for its entire duration — the first version of
 * this table read all five stars at the ghost alpha at five stars and an alternating drain, which
 * is the 2 Hz square wave correctly sampled and nothing to do with what was being measured.
 *
 * So the drain and count arms turn the escalation off, which is CLAUDE.md's "isolate one term at a
 * time": the flash is a separate signal with its own arm below, where it is driven through
 * `wantedFlash` and `_flashPhase`, both of which advance on the passed dt and not on the clock.
 */
function statusAt(w, { escalate = false, frames = 200 } = {}) {
  hud.escalateSeconds = escalate ? 4 : 0;
  hud._escalateUntil = -1;
  /**
   * AND ONE PASS IS FORCED, because the clean-record arm asks for a state the panel is ALREADY in.
   * At zero stars with no note and no weapon nothing dirties the status canvas, so 200 frames pass
   * with no draw at all and the arm cannot tell "no note was drawn" from "nothing was drawn" — it
   * read `no status pass in 200 frames` on its first run, which is the dirty-flag trap this file's
   * header records, arriving from the other direction. `layout()` is the public "redraw
   * everything" and its first frame is the one this captures.
   */
  hud.layout();
  let last = null;
  for (let i = 0; i < frames; i++) {
    rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
    hud.update({
      dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
      wanted: w.stars, wantedFlash: w.flash, evade: w.evade, wantedNote: w.note,
      vehicle: { roadSpeed: 0, forwardSpeed: 0, steerPull: 0,
        position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } },
    });
    if (isStatusPass(texts)) last = { fills: onStatus(fills), texts: onStatus(texts) };
  }
  if (!last) return { drew: false, star: [], note: null, texts: [], fills: [] };
  // The five stars are the first five `fill()` calls OF THE STATUS PANEL, in index order: the loop
  // does starPath + fill for every slot whether lit or not, and the weapon plate's own fill comes
  // after them. Identified by order rather than by colour, because colour is what is under test.
  const star = last.fills.slice(0, 5).map((f) => f.fill);
  // The note is the only status text on its own line: the weapon name is at y 49 and the ammo at 68.
  const note = last.texts.find((t) => t.y === 32) ?? null;
  return { drew: true, star, note, texts: last.texts, fills: last.fills };
}
/** Alpha out of an rgba() string, or 1 for an opaque hex. */
const alphaOf = (c) => {
  const m = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/.exec(String(c));
  return m ? parseFloat(m[1]) : (/^#/.test(String(c)) ? 1 : NaN);
};

{
  const clean = statusAt(composeWanted({ stars: 0 }));
  check('the status panel draws at all, so these checks are not vacuous', clean.drew,
    clean.drew ? `${clean.fills.length} fills` : 'no status pass in 200 frames');
  check('KNOWN-BAD: a clean record draws no note', clean.note === null,
    clean.note ? clean.note.text : 'none');
  check('and no star is lit', clean.star.every((c) => alphaOf(c) < 0.6),
    clean.star.map((c) => alphaOf(c).toFixed(2)).join(' '));
}

// The lit count is the star count, which nothing asserted before this file could see a fill.
{
  console.log('\n  stars   drawn star alphas                         note');
  const rows = [];
  for (const n of [0, 1, 3, 5]) {
    const f = statusAt(composeWanted({ stars: n, state: STATES.SEARCH, remaining: 20, evade: 0 }));
    // evade 0 so the top star is not draining: this arm is counting lit stars, not reading one.
    rows.push({ n, ...f });
    console.log(`  ${String(n).padStart(5)}   ${f.star.map((c) => alphaOf(c).toFixed(2)).join('  ')}` +
      `            ${f.note ? `"${f.note.text}"` : '-'}`);
  }
  check('the number of lit stars is the wanted level',
    rows.every((r) => r.star.filter((c) => alphaOf(c) > 0.6).length === r.n),
    rows.map((r) => `${r.n}:${r.star.filter((c) => alphaOf(c) > 0.6).length}`).join(' '));
  check('and the lit ones are the leftmost, not a scatter',
    rows.every((r) => r.star.slice(0, r.n).every((c) => alphaOf(c) > 0.6)
      && r.star.slice(r.n).every((c) => alphaOf(c) < 0.6)), 'prefix');
}

/**
 * THE DRAIN. `evade` is 0 the moment contact is lost and 1 the instant before a star goes, and the
 * top star fades from solid to the meter's own flashed-off ghost across that — so it arrives
 * already looking like the thing it becomes. Monotonic, or it is a light and not a reading.
 */
{
  console.log('\n  evade   top star alpha   the star below it');
  const seen = [];
  for (const e of [0, 0.25, 0.5, 0.75, 1]) {
    const f = statusAt(composeWanted({ stars: 3, state: STATES.SEARCH, remaining: 9, evade: e }));
    const top = alphaOf(f.star[2]), below = alphaOf(f.star[1]);
    seen.push({ e, top, below });
    console.log(`  ${e.toFixed(2).padStart(5)}   ${top.toFixed(3).padStart(13)}   ${below.toFixed(3)}`);
  }
  /**
   * AT EVERY STAR COUNT, and one star is the case that matters most — "am I about to be clear?".
   * This arm used `stars: 3` only, so a reviewer's `drainAt = stars > 1 ? stars - 1 : -1` — the
   * drain never showing at one star — passed every check in the file.
   */
  console.log('\n  stars   drained top-star alpha at evade 0.75');
  const perStar = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const f = statusAt(composeWanted({ stars: n, state: STATES.SEARCH, remaining: 9, evade: 0.75 }));
    perStar.push({ n, top: alphaOf(f.star[n - 1]) });
    console.log(`  ${String(n).padStart(5)}   ${alphaOf(f.star[n - 1]).toFixed(3)}`);
  }
  check('the drain shows at every star count, including one',
    perStar.every((r) => r.top > 0.26 && r.top < 1), perStar.map((r) => r.top.toFixed(3)).join(' '));
  check('and it is the same reading at each, because it is the same quantity',
    new Set(perStar.map((r) => r.top.toFixed(6))).size === 1,
    perStar.map((r) => r.top.toFixed(3)).join(' '));
  check('the top star drains monotonically with the escape clock',
    seen.every((r, i) => i === 0 || r.top < seen[i - 1].top),
    seen.map((r) => r.top.toFixed(3)).join(' > '));
  check('at zero progress it is fully lit', seen[0].top === 1, seen[0].top);
  check('and at the top of the clock it has reached the meter\'s own ghost alpha',
    Math.abs(seen[4].top - 0.26) < 1e-6, seen[4].top);
  check('only the star about to go drains; the ones below stay solid',
    seen.every((r) => r.below === 1), seen.map((r) => r.below).join(' '));
  // Known-bad: without this the checks above would pass for a meter that drained EVERY star.
  check('KNOWN-BAD: the drain moved at all between its two ends',
    seen[0].top !== seen[4].top, `${seen[0].top} vs ${seen[4].top}`);
}

/**
 * THE NOTE, and the ALARM'S effect on it. The flash and the drain mean opposite things — "they
 * have a fix on you" against "you are nearly clear" — and they were the same animation, so the
 * note is coloured on the health bar's convention to say which of the two it is without being read.
 */
{
  const evading = statusAt(composeWanted({ stars: 2, state: STATES.SEARCH, remaining: 24, evade: 0.4 }));
  const seenNow = statusAt(composeWanted({ stars: 2, state: STATES.ACTIVE }));
  console.log(`\n  evading -> "${evading.note?.text}" in ${evading.note?.fill}`);
  console.log(`  in contact -> "${seenNow.note?.text}" in ${seenNow.note?.fill}`);
  check('the note is drawn, and it is the string the composer produced',
    evading.note && evading.note.text === 'EVADING 24s', evading.note?.text);
  check('it is right-aligned inside the panel, clear of the weapon plate',
    evading.note && evading.note.align === 'right' && evading.note.x === LAYOUT.status.w
    && evading.note.y > 23 && evading.note.y < 36,
    `x ${evading.note?.x} y ${evading.note?.y} of ${LAYOUT.status.w}`);
  check('the evading note is amber and the contact note is alert, so the two read apart',
    evading.note?.fill === THEME.healthLow && seenNow.note?.fill === THEME.alert,
    `${evading.note?.fill} / ${seenNow.note?.fill}`);
}

/**
 * THE ALARM BLINKS, which nothing had ever asserted either — and it is the signal whose MEANING
 * this round changed. It used to be fed `state === SEARCH` (the level draining) while src/hud.js
 * also raised it on any star increase, so "they have just spotted me" and "I have shaken them"
 * were one animation. It now means contact alone.
 *
 * Collected across every status pass rather than from the last one: a blink is two alphas over
 * time and the last frame is only ever one of them.
 */
{
  const sweep = (flash) => {
    hud.escalateSeconds = 0; hud._escalateUntil = -1;
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
      hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
        wanted: 2, wantedFlash: flash, evade: 0, wantedNote: flash ? 'SEEN' : null,
        vehicle: { roadSpeed: 0, forwardSpeed: 0, steerPull: 0,
          position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
      if (isStatusPass(texts)) seen.add(alphaOf(onStatus(fills)[1].fill));
    }
    return [...seen].sort((a, b) => a - b);
  };
  const on = sweep(true), off = sweep(false);
  console.log(`\n  alarm up:   the lit star takes alphas ${on.join(', ')}`);
  console.log(`  alarm down: ${off.join(', ')}`);
  check('with the alarm up the lit star blinks between solid and the ghost',
    on.length === 2 && on[0] === 0.26 && on[1] === 1, on.join(', '));
  check('KNOWN-BAD: with the alarm down and the clock at zero it is steady',
    off.length === 1 && off[0] === 1, off.join(', '));
}

/**
 * AND THE WORDS STOP WHEN THE ALARM DOES. src/hud.js's `escalateSeconds` is how long the star
 * meter flashes after a level change; src/wanted.js's LAW_NOTICE_S is how long the offence stays
 * in the band. wanted.js must not import the presentation layer, so the two are separate
 * constants — which is exactly the shape CLAUDE.md records as "copying the regexes into a second
 * page.evaluate". This file is the one gate that imports both, so it asserts the relation.
 */
{
  // From a FRESH HUD, not from `hud`: the arms above set `escalateSeconds` to 0 to isolate the
  // drain, and reading the mutated field would have made this check assert 4 === 0. It read
  // exactly that on its first run.
  const fresh = new HUD({}).escalateSeconds;
  console.log(`\n  LAW_NOTICE_S ${LAW_NOTICE_S} s against a fresh HUD's escalateSeconds ${fresh} s`);
  check('the offence line and the star meter\'s alarm end together',
    LAW_NOTICE_S === fresh, `${LAW_NOTICE_S} against ${fresh}`);
  hud.escalateSeconds = fresh;    // leave the shared HUD as it was found
}

/**
 * THE OBJECTIVE'S DISTANCE ELEMENT, which nothing looked at — and a playtester measured the
 * consequence from the other end: the law tenant's number appeared in 0 of 289 glances while a
 * mission was live, because `HOLDS_MISSION_SUBTITLE` overwrote the subtitle it used to live in.
 * It is in the OBJECTIVE now, where the page has an element for it and dirty-checks it per whole
 * metre. `_write` sets `textContent`, so this is read off the DOM stub rather than the canvas.
 */
console.log('\nTHE OBJECTIVE BAND — the distance element');
{
  const feed = (objective, subtitle) => {
    hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
      objective, subtitle: subtitle ?? null,
      vehicle: { roadSpeed: 0, forwardSpeed: 0, steerPull: 0,
        position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
    return { text: hud.elObjText.textContent, dist: hud.elObjDist.textContent,
      sub: hud.elSub.textContent };
  };
  const plain = feed('TURN BACK', 'the district ends here');
  const withD = feed({ text: 'STOP AT THE SCENE', distance: 67 }, 'leaving is a second offence');
  const closer = feed({ text: 'STOP AT THE SCENE', distance: 12 }, 'leaving is a second offence');
  const none = feed({ text: 'STOPPED AT THE SCENE' }, 'leaving costs nothing now');
  console.log(`    "TURN BACK"                      -> text "${plain.text}" dist "${plain.dist}"`);
  console.log(`    STOP AT THE SCENE, distance 67   -> text "${withD.text}" dist "${withD.dist}"`);
  console.log(`    the same, distance 12            -> text "${closer.text}" dist "${closer.dist}"`);
  console.log(`    STOPPED, no distance             -> text "${none.text}" dist "${none.dist}"`);
  check('an objective with a distance draws it', withD.dist === '67 m', `"${withD.dist}"`);
  check('and the number follows the value', closer.dist === '12 m', `"${closer.dist}"`);
  check('KNOWN-BAD: an objective with no distance draws none', none.dist === '' && plain.dist === '',
    `"${none.dist}" / "${plain.dist}"`);
  check('and the words are drawn either way', withD.text === 'STOP AT THE SCENE'
    && plain.text === 'TURN BACK', `${withD.text} / ${plain.text}`);
  /**
   * AND `objectiveLine` IS THE SAME WORDS FOR A HOST WITH NO CANVAS. The harness has no element,
   * so a flattening that dropped the number would put a playtester back where they started.
   */
  const line = objectiveLine({ text: 'STOP AT THE SCENE', distance: 67 });
  console.log(`    objectiveLine -> "${line}"`);
  check('objectiveLine carries the same words and the same number as the page draws',
    line.startsWith(withD.text) && line.endsWith(withD.dist), `"${line}" against "${withD.text}" + "${withD.dist}"`);
  check('and it passes a plain string through unchanged',
    objectiveLine('TURN BACK') === 'TURN BACK' && objectiveLine(null) === null, 'ok');
  /**
   * AND THE NUMBER SURVIVES A RUNNING MISSION, which is the whole finding. `composeBand` hands the
   * mission's objective to the subtitle of any tenant above it, so a distance in the SUBTITLE is
   * deleted whenever a mission is live — most of the game.
   */
  const law = composeLaw({ stars: 1, scene: { d: 18, leaveIn: 67, stopped: false } });
  const alone = composeBand({ law });
  const running = composeBand({ law, mission: { objective: 'DRIVE EAST ALONG MARLIN STREET' } });
  console.log(`    law alone     -> "${objectiveLine(alone.objective)}" / "${alone.subtitle}"`);
  console.log(`    law + mission -> "${objectiveLine(running.objective)}" / "${running.subtitle}"`);
  check('the law line keeps its distance with a mission running',
    /\d+\s*m$/.test(objectiveLine(running.objective)), objectiveLine(running.objective));
  check('and it is the same number as with no mission',
    objectiveLine(running.objective) === objectiveLine(alone.objective),
    `${objectiveLine(running.objective)} / ${objectiveLine(alone.objective)}`);
  check('while the mission still keeps the subtitle', running.subtitle.includes('DRIVE EAST'),
    running.subtitle);
  // And the page draws it in that state, not just the composer.
  const drawn = feed(running.objective, running.subtitle);
  check('the page draws that distance too, with the mission in the subtitle',
    drawn.dist === '67 m', `"${drawn.dist}" / "${drawn.sub}"`);
}

/**
 * THE STATUS PANEL'S DIRTY WIRING, which every check above is blind to because `statusAt` calls
 * `layout()` to force a pass. That was the right fix for the clean-record arm — at zero stars
 * nothing dirties the panel, so 200 frames pass with no draw and the arm cannot tell "no note
 * drawn" from "nothing drawn" — and it blinds the gate to `_set`'s dirty list.
 *
 * A blind reviewer dropped `evade` and `wantedNote` from that list and ALL 68 CHECKS PASSED, with
 * the panel redrawing ONCE over an 18 second four-star escape instead of 1,080 times: one note
 * drawn instead of eighteen, one star alpha instead of 740. That is the playtester's original
 * complaint reinstated verbatim — "the only field of the HUD that ever differed was the star
 * count" — with the gate green. So this arm forces nothing and counts.
 */
console.log('\nSTATUS PANEL — does a changing readout reach the screen?');
{
  const run = (vary) => {
    hud.escalateSeconds = 0; hud._escalateUntil = -1;
    hud.layout();
    // Settle at the starting state so the forced redraw is not what we count.
    for (let i = 0; i < 20; i++) {
      hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
        wanted: 3, wantedFlash: false, evade: 0, wantedNote: 'EVADING 18s',
        vehicle: { roadSpeed: 0, forwardSpeed: 0, steerPull: 0,
          position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
    }
    let passes = 0;
    const notes = new Set(), alphas = new Set();
    const N = 1080;                        // 18 s at 60 Hz
    for (let i = 0; i < N; i++) {
      rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
      const frac = i / N;
      hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
        wanted: 3, wantedFlash: false,
        evade: vary ? frac : 0,
        wantedNote: vary ? `EVADING ${Math.max(1, Math.ceil(18 * (1 - frac)))}s` : 'EVADING 18s',
        vehicle: { roadSpeed: 0, forwardSpeed: 0, steerPull: 0,
          position: { x: 0, z: 0 }, quaternion: { w: 1, x: 0, y: 0, z: 0 } } });
      if (isStatusPass(texts)) {
        passes++;
        const t = onStatus(texts).find((q) => q.y === 32);
        if (t) notes.add(t.text);
        alphas.add(alphaOf(onStatus(fills)[2].fill));
      }
    }
    return { passes, notes: notes.size, alphas: alphas.size, of: N };
  };
  const varying = run(true), fixed = run(false);
  console.log(`    over ${varying.of} frames of a four-star escape, evade and the note changing:`);
  console.log(`      status redraws ${varying.passes}, distinct notes ${varying.notes}, ` +
    `distinct top-star alphas ${varying.alphas}`);
  console.log(`    the same with both HELD fixed: redraws ${fixed.passes}, notes ${fixed.notes}, ` +
    `alphas ${fixed.alphas}`);
  check('a changing evade and note redraw the status panel every frame, not once',
    varying.passes > varying.of * 0.9, `${varying.passes} of ${varying.of}`);
  check('and the drain and the words both reach the screen as they change',
    varying.notes > 10 && varying.alphas > 100,
    `${varying.notes} notes, ${varying.alphas} alphas`);
  check('KNOWN-BAD: holding both fixed stops the redraws, so the count above is the wiring',
    fixed.passes <= 1, `${fixed.passes} redraws with nothing changing`);
  hud.escalateSeconds = new HUD({}).escalateSeconds;
}

/**
 * THE OBJECTIVE BAND'S PRIORITY ORDER, WALKED AS A LADDER — because testing it one tenant at a
 * time asserts nothing about priority, and that is what was happening.
 *
 * `composeBand` has five tenants and one order: wreck, fence, mission, ended, offer. Every check
 * over it supplied ONE of them and asserted that one won, which is true for any order whatsoever.
 * `tools/mutation-sweep.mjs` reversed the order to `offer ?? ended ?? mission ?? fence ?? wreck`
 * and nothing in the 16-gate offline list or playtest --selftest noticed: with only a wreck set,
 * `pick` is the wreck under both orders.
 *
 * So: supply ALL FIVE, assert the winner, remove it, assert the next, down to nothing. A reversed
 * or shuffled order cannot survive that, and the ladder is printed so the order is legible rather
 * than implied by five separate checks.
 */
console.log('\nOBJECTIVE BAND — the priority order, as a ladder');
{
  const all = {
    wreck: { objective: 'THE CAR IS WRECKED', subtitle: 'a replacement in 4 s' },
    fence: { objective: 'TURN BACK', subtitle: 'the district ends here' },
    // The sixth tenant, and the one that was missing: src/wanted.js's composeLaw. Built from a
    // real snapshot rather than a literal, so a rename or a reshape of what the module publishes
    // fails this ladder instead of passing it.
    law: composeLaw({ stars: 2, scene: { d: 12, leaveIn: 73, stopped: false } }),
    mission: { objective: 'DRIVE TO THE MARKER', subtitle: 'Five Points' },
    ended: { objective: 'JOB DONE', subtitle: null },
    offer: { objective: 'SHAKEDOWN', subtitle: 'two markers by the bayfront' },
  };
  const ORDER = ['wreck', 'fence', 'law', 'mission', 'ended', 'offer'];
  const live = { ...all };
  const walked = [];
  for (const expect of ORDER) {
    const band = composeBand(live);
    walked.push(band.from);
    console.log(`    ${Object.keys(live).length} tenant(s) live -> "${band.from}" ` +
      `("${band.objective}")`);
    check(`with ${Object.keys(live).join(', ')} live the band is the ${expect}`,
      band.from === expect, `${band.from}`);
    delete live[expect];
  }
  const empty = composeBand(live);
  console.log(`    none live -> ${JSON.stringify(empty)}`);
  check('the ladder came down in exactly the declared order', walked.join(' > ') === ORDER.join(' > '),
    walked.join(' > '));
  check('and with nothing live the band is empty, not a stale line',
    empty.from === null && empty.objective === null && empty.subtitle === null,
    JSON.stringify(empty));
  // Every tenant must be distinguishable, or the ladder could pass by returning one of them twice.
  check('the six tenants carry six different objectives',
    new Set(ORDER.map((k) => all[k].objective)).size === 6, 'all distinct');

  /**
   * AND THE FENCE KEEPS A RUNNING MISSION'S SUBTITLE. Driving a live mission outside the world
   * fence replaced both lines with TURN BACK while `mission.update()` kept running, so the job was
   * still live with nothing on screen saying so. The mutation sweep dropped that rule and nothing
   * noticed either — the existing fence check supplies no mission, so the branch never ran.
   */
  const outside = composeBand({ fence: all.fence, mission: all.mission });
  console.log(`    fence + live mission -> "${outside.objective}" / "${outside.subtitle}"`);
  check('the fence takes the objective, because turning back is the only actionable thing',
    outside.from === 'fence' && outside.objective === all.fence.objective, outside.objective);
  check('and the mission keeps the subtitle, so the job is not silently invisible',
    typeof outside.subtitle === 'string' && outside.subtitle.includes(all.mission.objective),
    `${outside.subtitle}`);
  // Without a mission the fence keeps its own subtitle — the rule is conditional, not a rewrite.
  const alone = composeBand({ fence: all.fence });
  check('a fence with no mission behind it keeps its own subtitle',
    alone.subtitle === all.fence.subtitle, `${alone.subtitle}`);

  /**
   * AND THE LAW TENANT HAS THE SAME RULE, which is why it is a SET in src/hud.js and not a second
   * `from === '...'` branch. This is the recurring shape CLAUDE.md records under "patching one tool
   * and leaving its siblings": the fence's rule was written as one name, and a sixth tenant that
   * needed it would silently not have it.
   */
  const lawOverMission = composeBand({ law: all.law, mission: all.mission });
  console.log(`    law + live mission -> "${lawOverMission.objective}" / "${lawOverMission.subtitle}"`);
  check('the law takes the objective, because its line carries a deadline in seconds',
    lawOverMission.from === 'law' && lawOverMission.objective === all.law.objective,
    lawOverMission.objective);
  check('and the mission keeps the subtitle here too, on the same rule as the fence',
    typeof lawOverMission.subtitle === 'string'
    && lawOverMission.subtitle.includes(all.mission.objective), `${lawOverMission.subtitle}`);
  const lawAlone = composeBand({ law: all.law });
  check('a law line with no mission behind it keeps its own subtitle',
    lawAlone.subtitle === all.law.subtitle, `${lawAlone.subtitle}`);
  // And a tenant BELOW the mission must NOT take its subtitle: there is no running mission when
  // one of those wins, so the rule would be meaningless — but a set that grew carelessly could
  // include one.
  const endedWithMission = composeBand({ ended: all.ended, mission: all.mission });
  check('a tenant below the mission is the mission, so the rule cannot reach it',
    endedWithMission.from === 'mission', endedWithMission.from);
  // Every one of the law tenant's own lines has to be able to reach the band, not just the one
  // the ladder happened to use.
  const lawLines = [
    composeLaw({ stars: 1, scene: { d: 3, leaveIn: 82, stopped: false } }),
    composeLaw({ stars: 1, scene: { d: 3, leaveIn: 82, stopped: true } }),
    composeLaw({ stars: 2, notice: { id: 'hitAndRun', label: 'Left the scene', age: 0.5 } }),
  ];
  console.log(`    the law tenant's three lines: ${lawLines.map((l) => `"${l.objective}"`).join(', ')}`);
  check('the law tenant has three distinct lines and every one wins the band',
    new Set(lawLines.map((l) => l.objective)).size === 3
    && lawLines.every((l) => composeBand({ law: l, mission: all.mission }).objective === l.objective),
    lawLines.map((l) => l.objective).join(' / '));
}

/**
 * THE MINIMAP'S BLIPS, which had exactly one kind and drew none at all during a mission.
 *
 * `markers` was `missionHud ? null : offerMarkers`, so a five-star chase with eight units spawning
 * 150-470 m out showed no police — `MARKER_STYLE.enemy` was defined in src/hud.js and the string
 * 'enemy' appeared nowhere else in the tree — and three authored on-foot stages said "GET IN THE
 * CAR" over a blank map, where a playtester spent 130 s going from 1.7 m to 71.2 m away.
 *
 * The projection is NOT re-derived here: re-implementing the transform and checking it agrees with
 * itself is the circular check CLAUDE.md records under the shunt-fit ladder. What is asserted is
 * independent of the arithmetic — a blip appears when a marker does, north draws up, east draws
 * right, further draws further out, and a marker off the map is clamped to the frame at the
 * smaller radius the code uses for exactly that case.
 */
console.log('\nMINIMAP — the blips');
{
  const MAP_EL = hud.cMap._id;
  /** The marker radii from Minimap._marker: 6 on the map, 4.4 clamped to the frame. */
  const ON_MAP_R = 6, OFF_MAP_R = 4.4;
  /**
   * A BLIP IS NOT ONE PRIMITIVE, and taking only `arc()` undercounts a mixed set. `_marker` draws
   * `dot` as an arc, `pin` as a teardrop whose cap is an arc, and `square` — which is
   * `MARKER_STYLE.vehicle` and `MARKER_STYLE.offer`, two of the three kinds this round posts — as
   * `rect(px - r*0.8, py - r*0.8, r*1.6, r*1.6)`. The first version of this arm read one blip for
   * three markers, and the two it missed were the ones the round added. Both shapes are folded to
   * a centre and a radius so the geometry checks below do not care which kind they got.
   */
  const RADII = [ON_MAP_R, OFF_MAP_R];
  const isR = (v) => RADII.some((r) => Math.abs(v - r) < 1e-9);
  const blipsOf = (qs) => qs.flatMap((q) => {
    if (q.op === 'arc' && isR(q.r)) return [{ x: q.x, y: q.y, r: q.r, shape: 'round' }];
    if (q.op === 'rect' && isR(q.w / 1.6) && Math.abs(q.w - q.h) < 1e-9) {
      return [{ x: q.x + q.w / 2, y: q.y + q.h / 2, r: q.w / 1.6, shape: 'square' }];
    }
    return [];
  });
  const isMapPass = (rs) => rs.some((r) => r.el === MAP_EL
    && r.w === LAYOUT.map.w && r.h === LAYOUT.map.h);
  /**
   * Drive the HUD with a fixed pose and a marker set, and return that frame's blips.
   *
   * TWO THINGS HAVE TO HAPPEN IN THIS ORDER and getting them the wrong way round reads as no
   * blips at all. The pose has to SETTLE, because `_drawMap` projects the DAMPED position and an
   * unsettled arm places the blip relative to wherever the previous arm left the car. And then a
   * pass has to be FORCED, because a settled pose with an unchanged marker set correctly stops
   * redrawing — the first version settled and then sampled, read `0 blips` at every input, and
   * the code was right. That is this file's own header, for the third time in three panels.
   */
  const AT = { x: 100, z: -60 };
  function blipsFor(markers, { settle = 400 } = {}) {
    const feed = () => {
      rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
      hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
        wanted: 0, wantedNote: null, evade: 0, markers, waypoint: null,
        player: { x: AT.x, z: AT.z, heading: 0 } });
    };
    for (let i = 0; i < settle; i++) feed();
    hud.layout();
    feed();
    const passes = isMapPass(rects) ? 1 : 0;
    return { passes, blips: passes ? blipsOf(paths.filter((q) => q.el === MAP_EL)) : [] };
  }

  const none = blipsFor(null);
  const north = blipsFor([{ x: AT.x, z: AT.z - 40, kind: 'enemy' }]);
  const south = blipsFor([{ x: AT.x, z: AT.z + 40, kind: 'enemy' }]);
  const east = blipsFor([{ x: AT.x + 40, z: AT.z, kind: 'enemy' }]);
  const far = blipsFor([{ x: AT.x, z: AT.z - 90, kind: 'enemy' }]);
  const offMap = blipsFor([{ x: AT.x, z: AT.z - 500, kind: 'enemy' }]);
  const three = blipsFor([
    { x: AT.x, z: AT.z - 40, kind: 'enemy' },
    { x: AT.x + 30, z: AT.z, kind: 'vehicle' },
    { x: AT.x - 20, z: AT.z + 20, kind: 'offer' },
  ]);
  // NEVER A BARE undefined: an arm that produced no blip must FAIL the checks below rather than
  // throw inside one of them, or a grep for failures sees a mutation as caught by nothing. Every
  // comparison against NaN is false, which is the failure, and `toFixed` on it prints 'NaN'.
  const b = (r) => r.blips[0] ?? { x: NaN, y: NaN, r: NaN };
  console.log(`    no markers -> ${none.blips.length} blips` +
    `   one -> ${north.blips.length}   three -> ${three.blips.length}`);
  console.log(`    40 m north  (${b(north)?.x.toFixed(1)}, ${b(north)?.y.toFixed(1)}) r ${b(north)?.r}`);
  console.log(`    40 m south  (${b(south)?.x.toFixed(1)}, ${b(south)?.y.toFixed(1)}) r ${b(south)?.r}`);
  console.log(`    40 m east   (${b(east)?.x.toFixed(1)}, ${b(east)?.y.toFixed(1)}) r ${b(east)?.r}`);
  console.log(`    90 m north  (${b(far)?.x.toFixed(1)}, ${b(far)?.y.toFixed(1)}) r ${b(far)?.r}`);
  console.log(`    500 m north (${b(offMap)?.x.toFixed(1)}, ${b(offMap)?.y.toFixed(1)}) r ${b(offMap)?.r}`);

  check('the map redrew at all on a settled pose, so these arms measured something',
    north.passes > 0 && none.passes > 0, `${none.passes} / ${north.passes} passes`);
  check('KNOWN-BAD: with no markers the map draws no blips', none.blips.length === 0,
    `${none.blips.length}`);
  check('one marker draws one blip, three draw three',
    north.blips.length === 1 && three.blips.length === 3,
    `${north.blips.length} / ${three.blips.length}`);
  // And the kinds are told apart on screen, which is what MARKER_STYLE is for: a police car and
  // the car you parked must not be the same blip.
  check('a police dot and a parked-car square draw as different shapes',
    new Set(three.blips.map((q) => q.shape)).size === 2,
    three.blips.map((q) => q.shape).join(' '));
  check('a marker to the north draws above the car and one to the south below it',
    b(north).y < b(south).y, `${b(north).y.toFixed(1)} against ${b(south).y.toFixed(1)}`);
  check('and one to the east draws to the right of both',
    b(east).x > b(north).x && Math.abs(b(east).y - b(north).y) > 1,
    `${b(east).x.toFixed(1)} against ${b(north).x.toFixed(1)}`);
  check('further away draws further from the car, so the map is a reading',
    Math.abs(b(far).y - b(north).y) > 20 && b(far).y < b(north).y,
    `${b(north).y.toFixed(1)} -> ${b(far).y.toFixed(1)}`);
  check('a marker beyond the map is clamped to the frame at the off-map radius',
    Math.abs(b(offMap).r - OFF_MAP_R) < 1e-9 && b(offMap).y >= 0
    && b(offMap).y <= LAYOUT.map.h, `r ${b(offMap)?.r} at y ${b(offMap)?.y.toFixed(1)}`);
  check('and the on-map ones are at the on-map radius',
    [north, south, east, far].every((r) => Math.abs(b(r).r - ON_MAP_R) < 1e-9),
    [north, south, east, far].map((r) => b(r).r).join(' '));


  /**
   * THE PROJECTION ITSELF, which direction-and-monotonicity did not test. A blind reviewer wrote
   * four wrong projections that ALL PASSED the 68 checks: `rot = 0` (the map stops rotating with
   * the car, the most visible minimap bug there is), the rotation reversed, every blip at half
   * scale, and an anisotropic squash. The commit that added those checks quoted a hand-derived
   * coordinate — 71.97 for a marker 40 m north — and left it in the commit message rather than
   * the gate.
   *
   * What is asserted here is the minimap's own CONTRACT rather than its arithmetic: the map is
   * `zoomMetres` across its width (`MINIMAP_ZOOM_M / 2` is why the reach is what it is), it rotates
   * with the car unless `northUp`, and it is isotropic. Re-deriving the transform and checking it
   * agrees with itself is the circular check CLAUDE.md records under the shunt-fit ladder.
   */
  console.log('\n    the projection: scale, rotation and isotropy');
  {
    const ppm = LAYOUT.map.w / hud.state.zoomMetres;   // design px per world metre, the contract
    /** Where a marker `m` metres away on bearing `b` (0 = north) lands, at a given car heading. */
    const at = (metres, bearing, heading) => {
      const wx = AT.x + Math.sin(bearing) * metres, wz = AT.z - Math.cos(bearing) * metres;
      const feed = () => {
        rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
        hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
          wanted: 0, wantedNote: null, evade: 0, objective: null, subtitle: null,
          markers: [{ x: wx, z: wz, kind: 'enemy' }], waypoint: null,
          player: { x: AT.x, z: AT.z, heading } });
      };
      for (let i = 0; i < 600; i++) feed();
      hud.layout();
      feed();
      const b = blipsOf(paths.filter((q) => q.el === MAP_EL))[0];
      if (!b) return null;
      // The car's own position on the plate: centre, pushed below by the forward bias.
      const cx = LAYOUT.map.w / 2, cy = LAYOUT.map.h / 2 + LAYOUT.map.h * hud.minimap.forwardBias;
      return { x: b.x, y: b.y, r: Math.hypot(b.x - cx, b.y - cy),
        th: Math.atan2(b.x - cx, -(b.y - cy)) };
    };
    const n40 = at(40, 0, 0), n80 = at(80, 0, 0), e40 = at(40, Math.PI / 2, 0);
    console.log(`      40 m north, heading 0: ${n40.r.toFixed(2)} px from the car ` +
      `(contract: ${(40 * ppm).toFixed(2)})`);
    console.log(`      80 m north:            ${n80.r.toFixed(2)} px`);
    console.log(`      40 m east:             ${e40.r.toFixed(2)} px`);
    check('a blip sits at its world distance times the map scale, which is the zoom contract',
      Math.abs(n40.r - 40 * ppm) < 1, `${n40.r.toFixed(2)} against ${(40 * ppm).toFixed(2)} px`);
    check('and twice as far draws twice as far out, so the scale is not halved',
      Math.abs(n80.r - 2 * n40.r) < 1, `${n80.r.toFixed(2)} against ${(2 * n40.r).toFixed(2)}`);
    check('the projection is isotropic: 40 m east is as far from the car as 40 m north',
      Math.abs(e40.r - n40.r) < 0.5, `${e40.r.toFixed(2)} against ${n40.r.toFixed(2)}`);
    /**
     * AND THE MAP ROTATES WITH THE CAR. `rot = 0` — the map frozen north-up while `northUp` is
     * false — passed every check this file had.
     */
    const headings = [0, Math.PI / 4, Math.PI / 2, Math.PI];
    const bearings = headings.map((h) => at(40, 0, h));
    console.log('      a marker 40 m north, by car heading:');
    for (let i = 0; i < headings.length; i++) {
      console.log(`        heading ${(headings[i] * 180 / Math.PI).toFixed(0).padStart(3)} deg -> ` +
        `(${bearings[i].x.toFixed(1)}, ${bearings[i].y.toFixed(1)}), ` +
        `${(bearings[i].th * 180 / Math.PI).toFixed(1)} deg on the plate`);
    }
    check('the map rotates with the car, so a fixed marker moves round the plate',
      new Set(bearings.map((b) => b.y.toFixed(1))).size === headings.length,
      bearings.map((b) => b.y.toFixed(1)).join(' '));
    // And it rotates the RIGHT WAY: a marker ahead stays ahead, so the plate angle is MINUS the
    // heading. Checked as a relation over the sweep rather than a sign copied out of the source.
    check('and it rotates the right way, so what is ahead of the car draws above it',
      bearings.every((b, i) => {
        const want = -headings[i];
        let d = b.th - want;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return Math.abs(d) < 0.05;
      }), bearings.map((b, i) => `${(b.th * 180 / Math.PI).toFixed(0)}/${(-headings[i] * 180 / Math.PI).toFixed(0)}`).join(' '));
    check('and north-up mode holds it still, which is the control for that',
      (() => {
        const feed = (heading) => {
          rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
          hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
            northUp: true, markers: [{ x: AT.x, z: AT.z - 40, kind: 'enemy' }], waypoint: null,
            player: { x: AT.x, z: AT.z, heading } });
        };
        const ys = [0, Math.PI / 2].map((h) => {
          for (let i = 0; i < 600; i++) feed(h);
          hud.layout(); feed(h);
          return blipsOf(paths.filter((q) => q.el === MAP_EL))[0]?.y;
        });
        hud.update({ northUp: false });
        return ys[0] != null && Math.abs(ys[0] - ys[1]) < 0.5;
      })(), 'north-up is heading-invariant');
  }

  /**
   * AND THE MARKER HASH ON EVERY TERM IT CARRIES. The only arm this file had moved one blip 5 m in
   * Z, so a reviewer dropped the `m.x` term, the `m.kind` term, the whole waypoint term and
   * rounded the sum to the nearest integer — four mutations, all missed. Two of those terms exist
   * only because a comment says why.
   */
  console.log('\n    the marker hash, per term');
  {
    const live = [{ x: AT.x, z: AT.z - 40, kind: 'enemy' }];
    let wp = null;
    const feed = () => {
      rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
      hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
        wanted: 0, wantedNote: null, evade: 0, objective: null, subtitle: null,
        markers: live, waypoint: wp, player: { x: AT.x, z: AT.z, heading: 0 } });
    };
    /** Settle, confirm the map is quiet, then apply `mutate` and report whether it redrew. */
    const moves = (label, mutate) => {
      for (let i = 0; i < 600; i++) feed();
      let quiet = 0;
      for (let i = 0; i < 20; i++) { feed(); if (isMapPass(rects)) quiet++; }
      mutate();
      feed();
      const redrew = isMapPass(rects);
      console.log(`      ${label.padEnd(34)} quiet ${quiet}, then ${redrew ? 'redrew' : 'DID NOT REDRAW'}`);
      return { quiet, redrew };
    };
    const inZ = moves('a blip 5 m in z', () => { live[0].z += 5; });
    const inX = moves('a blip 5 m in x', () => { live[0].x += 5; });
    const small = moves('a blip 0.4 m, under a metre', () => { live[0].x += 0.4; });
    const kind = moves('a blip changing kind in place', () => { live[0].kind = 'objective'; });
    const added = moves('a second blip appearing', () => { live.push({ x: AT.x + 20, z: AT.z, kind: 'vehicle' }); });
    const wpOn = moves('a waypoint appearing', () => { wp = { x: AT.x, z: AT.z - 30 }; });
    const wpMove = moves('the waypoint moving 5 m', () => { wp = { x: AT.x, z: AT.z - 25 }; });
    const all = { inZ, inX, small, kind, added, wpOn, wpMove };
    check('a settled pose with an unchanged marker set stops redrawing the map',
      Object.values(all).every((r) => r.quiet === 0),
      Object.entries(all).map(([k, r]) => `${k}:${r.quiet}`).join(' '));
    check('every term of the hash redraws the map: x, z, kind, count and the waypoint',
      Object.values(all).every((r) => r.redrew),
      Object.entries(all).filter(([, r]) => !r.redrew).map(([k]) => k).join(' ') || 'all seven');
    check('and a sub-metre move counts, so the hash is not rounded',
      small.redrew, `${small.redrew}`);
    hud.update({ waypoint: null });
  }

  /**
   * AND A BLIP THAT MOVES REDRAWS THE MAP. `HUD._set` compares by identity and the host mutates one
   * array in place — which is what the minimap wants, since its own draw pass deliberately
   * allocates nothing — so before the contents were hashed the only thing that forced a redraw was
   * the PLAYER moving. Every blip the HUD had was a fixed job on the board, so that was enough. A
   * police car closing on a player who has STOPPED is not, and that is exactly when the map is
   * being read.
   */
  const live = [{ x: AT.x, z: AT.z - 40, kind: 'enemy' }];
  const settleFeed = () => {
    rects.length = 0; fills.length = 0; texts.length = 0; paths.length = 0;
    hud.update({ dt: 1 / 60, visible: true, speed: 0, health: 1, armour: 0,
      wanted: 0, wantedNote: null, evade: 0, markers: live, waypoint: null,
      player: { x: AT.x, z: AT.z, heading: 0 } });
  };
  for (let i = 0; i < 400; i++) settleFeed();
  let quiet = 0;
  for (let i = 0; i < 20; i++) { settleFeed(); if (isMapPass(rects)) quiet++; }
  live[0].z += 5;                       // the same array, mutated in place: the police close in
  settleFeed();
  const afterMove = isMapPass(rects);
  console.log(`    settled: ${quiet} map passes in 20 still frames; after moving a blip 5 m: ` +
    `${afterMove ? 'redrew' : 'DID NOT REDRAW'}`);
  check('a settled pose with an unchanged marker set stops redrawing the map', quiet === 0,
    `${quiet} passes`);
  check('and mutating a marker in place redraws it, identity unchanged', afterMove, `${afterMove}`);
}

/**
 * THE MINIMAP'S REACH IS HALF ITS ZOOM, and nothing asserted the relation. The sweep set
 * `MINIMAP_REACH_M` to 1e9 — every job on the board becoming a blip from anywhere in the district
 * — and all 16 offline gates and playtest --selftest passed, because the only consumer filters by
 * whatever the constant says and agrees with itself by construction.
 *
 * The reach is half the zoom because the minimap draws a box `MINIMAP_ZOOM_M` across centred on
 * the player, so the furthest thing inside it is half that away. Asserting the derivation is what
 * makes it a reach rather than a number.
 */
console.log('\nMINIMAP — the reach is derived from the zoom');
{
  console.log(`    zoom ${MINIMAP_ZOOM_M} m across, reach ${MINIMAP_REACH_M} m from the centre`);
  check('the reach is exactly half the zoom box', MINIMAP_REACH_M === MINIMAP_ZOOM_M / 2,
    `${MINIMAP_REACH_M} against ${MINIMAP_ZOOM_M / 2}`);
  check('and it is a district distance, not an unbounded one',
    MINIMAP_REACH_M > 20 && MINIMAP_REACH_M < 1000, `${MINIMAP_REACH_M} m`);
}

const failed = checks.filter((c) => !c.ok);
console.log();
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(failed.length
  ? `\nHUD CUE: FAIL — ${failed.length} of ${checks.length}`
  : `\nHUD CUE: PASS — ${checks.length} checks`);
process.exit(failed.length ? 1 : 0);
