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
import { THEME } from '../src/hud.js';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

// --- a DOM thin enough to construct the HUD and record every fillRect, and no thinner.
const rects = [];
function mkCtx() {
  return {
    save() {}, restore() {}, setTransform() {}, resetTransform() {}, transform() {},
    clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
    arcTo() {}, roundRect() {}, ellipse() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    rect() {}, clip() {}, fill() {}, stroke() {}, translate() {}, rotate() {}, scale() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {}, drawImage() {},
    strokeRect() {}, setLineDash() {}, putImageData() {},
    getImageData: () => ({ data: new Uint8Array(4) }),
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill: this.fillStyle }); },
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: '',
    textAlign: '', textBaseline: '', shadowBlur: 0, shadowColor: '', lineCap: '', lineJoin: '',
    font: '', filter: '', imageSmoothingEnabled: true,
  };
}
function mkEl() {
  const el = {
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    dataset: {}, children: [], width: 512, height: 512, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { el.children.push(c); return c; },
    setAttribute() {}, removeAttribute() {}, remove() {}, getContext: () => mkCtx(),
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
    rects.length = 0;
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
for (const pull of [0, 0.01, 0.02, 0.06, 0.12, 0.25, -0.06, -0.25]) {
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
check('and a pull under 2% is below the threshold', at(0.01).band.length === 0,
  `${at(0.01).band.length} rects at 0.01`);
check('KNOWN-BAD: something IS drawn once the pull is real', at(0.06).band.length > 0,
  `${at(0.06).band.length} rects at 0.06`);

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
const armFull = (at(0.25).w / 2) - 1;
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

const failed = checks.filter((c) => !c.ok);
console.log();
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(failed.length
  ? `\nHUD CUE: FAIL — ${failed.length} of ${checks.length}`
  : `\nHUD CUE: PASS — ${checks.length} checks`);
process.exit(failed.length ? 1 : 0);
