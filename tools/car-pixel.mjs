// THE ONE GATE THAT LOOKS AT A PIXEL OF A CAR. See tools/car-pixel.html for the method.
//
//   node tools/car-pixel.mjs              render a car and check the paint-slot tint
//   node tools/car-pixel.mjs --selftest   prove the statistics and the classifier
//
// WHY IT EXISTS. `src/carbody.js`'s paint-slot tint is a vertex-shader rule, and everything that
// checks it today checks something adjacent: `paint-census` three source regexes and the mix's
// argument order, `boot-check` the uniform's own getter (which a mutated shader still reports
// correctly), `paint-tone` committed PNGs (which a mutated source cannot reach). A blind
// reviewer's `tint-invert` — the mix's two arguments swapped, so instanceColor reaches every slot
// EXCEPT the paint, which is #1 upside down — passed all three regexes, all 70 of boot-check and
// all 65 of traffic-selftest. CLAUDE.md records the gap as still open and names the check it
// wants: "max-over-median across one car's own pixels with the fleet forced near-black".
//
// THE TWO ARMS ARE A PAIR AND NEITHER ALONE IS A CHECK. Near-black instanceColor must take the
// PAINT dark and leave the lamps and the plate alone; near-white must take the paint bright and
// STILL leave them alone. One arm on its own passes for a material that ignores instanceColor
// entirely, which is the "a negative needs its positive" rule this project has already paid for
// once in this very module's comment.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/car-pixel.mjs [--selftest]`);
    process.exit(2);
  }
}

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE TWO ARMS, so the selftest can feed it known-bad numbers
 * without a browser. Everything the gate asserts is in here; the driver only supplies the report.
 */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const dark = r.arms.find((a) => a.tint < 0.5);
  const light = r.arms.find((a) => a.tint > 0.5);
  const PAINT = r.paintSlot;
  /**
   * A slot needs enough pixels for a median to mean anything. The number plate is 2 triangles and
   * can land on a dozen pixels at this framing, and a ratio of two medians over a dozen pixels is
   * noise that would read as a confinement failure. Slots under this are REPORTED and not asserted,
   * and the report says which — a dropped subject is a result, not a silent exclusion.
   */
  const MIN_PX = 40;
  const px = Object.fromEntries(r.slotPx.map((s) => [s.slot, s.px]));
  const nonPaintPx = r.slotPx.filter((s) => s.slot !== PAINT).reduce((a, b) => a + b.px, 0);

  // --- the thing happened at all. Every one of these has been the reason a check in this repo
  // passed over an empty population.
  add('the car drew triangles', r.triangles > 0, `${r.triangles} triangles`);
  add('the car covers a sane share of the frame, so the camera is on it',
    r.carPx / (r.size.w * r.size.h) > 0.04,
    `${(100 * r.carPx / (r.size.w * r.size.h)).toFixed(1)}% of ${r.size.w}x${r.size.h}`);
  add('the PAINT slot is visible', (px[PAINT] ?? 0) > 500, `slot ${PAINT}: ${px[PAINT] ?? 0} px`);
  add('and so are non-paint slots, or there is nothing for the tint to spare',
    nonPaintPx > 200, `${nonPaintPx} px over ${r.slotPx.length - 1} slots`);
  add('more than one palette slot reached the framebuffer', r.slotPx.length > 1,
    r.slotPx.map((s) => `${s.slot}:${s.px}`).join(' '));
  add('both arms rendered', !!dark && !!light, r.arms.map((a) => a.tint).join(', '));
  if (!dark || !light) return checks;

  const ratio = (slot) => {
    const d = dark.slots[slot], l = light.slots[slot];
    if (!d || !l || !(d.p50 > 0)) return null;
    return l.p50 / d.p50;
  };

  // --- the rule. One ratio per slot, over the same pixels under two instance colours, which
  // cancels the lighting, the exposure and the camera.
  const rPaint = ratio(PAINT);
  add('the PAINT slot moves with instanceColor', rPaint !== null && rPaint > 4,
    rPaint === null ? 'no paint sample' :
      `p50 ${dark.slots[PAINT].p50.toFixed(5)} -> ${light.slots[PAINT].p50.toFixed(5)}, x${rPaint.toFixed(1)}`);
  /**
   * AND EVERY OTHER SLOT DOES NOT. This is the half `tint-invert` breaks, and the half a single
   * arm cannot see: inverted, the instance colour reaches the lamps, the plate, the rims and the
   * tyres instead of the paint, so these ratios run away while the one above collapses.
   */
  const others = r.slotPx.filter((s) => s.slot !== PAINT && s.px >= MIN_PX).map((s) => s.slot);
  const moved = others.map((sl) => ({ slot: sl, r: ratio(sl) })).filter((o) => o.r !== null);
  /**
   * SEEDED FROM THE FIRST ROW, not from `{ slot: null, r: 1 }`. With that seed nothing beats it
   * when every slot reads exactly x1.000 — which is the CORRECT build — so `worst.slot` stayed
   * null, the separation check below was skipped by its own guard, and the gate printed 11 checks
   * where it has 12. A check that disappears when the build is right is worse than one that fails:
   * the count is the only thing a reader has to notice it by.
   */
  const worst = moved.length
    ? moved.reduce((a, b) => (Math.abs(Math.log(b.r)) > Math.abs(Math.log(a.r)) ? b : a))
    : null;
  add('and every OTHER slot does not — the tint is confined',
    moved.length > 0 && moved.every((o) => o.r > 0.8 && o.r < 1.25),
    worst ? `${moved.length} slots asserted, worst slot ${worst.slot} at x${worst.r.toFixed(3)}` +
      `  (${moved.map((o) => `${o.slot}:x${o.r.toFixed(3)}`).join(' ')})` : 'no slot had enough pixels');
  add('and the slots asserted are not just one, or "every other slot" is one slot',
    moved.length >= 3, `${moved.length} of ${r.slotPx.length - 1} non-paint slots over ${MIN_PX} px`);
  /**
   * THE SEPARATION, as one number, because the two checks above are thresholds and a reader
   * deserves the margin. It is how far apart the paint's ratio and the worst other slot's are.
   */
  // Unconditional, so the check count cannot move with the result. With no asserted slot at all
  // it FAILS and says so, rather than vanishing.
  const worstDev = worst ? Math.max(worst.r, 1 / worst.r) : null;
  add('the paint moves at least an order of magnitude more than the worst other slot',
    rPaint !== null && worstDev !== null && rPaint / worstDev > 10,
    worstDev === null ? 'no non-paint slot had enough pixels to compare against'
      : `x${rPaint.toFixed(1)} against x${worstDev.toFixed(3)} = ` +
        `${(rPaint / worstDev).toFixed(1)}x apart`);
  add('the tint uniform is on, or every check above passes for the wrong reason',
    r.tint && r.tint.value === 1, `uPaintTintOnly ${r.tint ? r.tint.value : 'absent'}`);
  add('and the module says it is confined to the slot this gate asserted',
    r.tint && r.tint.tintedSlot === PAINT,
    `tintedSlot ${r.tint ? r.tint.tintedSlot : 'absent'}, asserted ${PAINT}`);
  return checks;
}

// ------------------------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('CAR-PIXEL SELFTEST');
  /**
   * THE FIXTURE IS A REAL REPORT, copied from a passing run of the gate rather than invented, so
   * the selftest's "correct" arm is the shape and the magnitude the page actually produces. An
   * invented fixture drifts from the page silently — and did: the first version of this selftest
   * used two lumped masks and kept passing after the page moved to per-slot statistics, so it was
   * proving a `verdict` nobody called any more.
   */
  const stat = (p50) => ({ n: 100, p50, p95: p50 * 1.6, max: p50 * 3 });
  const good = {
    size: { w: 384, h: 256 }, triangles: 1050, paintSlot: 0, mixedTris: 104, carPx: 11486,
    slotTris: [{ slot: 0, tris: 500 }, { slot: 1, tris: 160 }],
    slotPx: [{ slot: 0, px: 6918 }, { slot: 1, px: 827 }, { slot: 4, px: 295 },
      { slot: 8, px: 674 }, { slot: 10, px: 1943 }, { slot: 11, px: 18 },
      { slot: 12, px: 340 }, { slot: 13, px: 471 }],
    tint: { value: 1, tintedSlot: 0, slots: 16 },
    arms: [
      { tint: 0.02, all: stat(0.009), slots: { 0: stat(0.00605), 1: stat(0.01300), 4: stat(0.70016),
        8: stat(0.01092), 10: stat(0.00396), 11: stat(0.00898), 12: stat(0.03414), 13: stat(0.01434) } },
      { tint: 0.98, all: stat(0.09), slots: { 0: stat(0.27889), 1: stat(0.01300), 4: stat(0.70016),
        8: stat(0.01092), 10: stat(0.00396), 11: stat(0.00898), 12: stat(0.03414), 13: stat(0.01434) } },
    ],
  };
  const bad = (f) => { const c = structuredClone(good); f(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);

  say(failing(good).length === 0, 'a correct report passes every check',
    `${verdict(good).length} checks`);
  say(verdict(good).length === 12, 'and the check COUNT is fixed, so one cannot vanish on a pass',
    `${verdict(good).length} checks`);

  /**
   * KNOWN-BAD: `tint-invert`. The mix's two arguments swapped sends instanceColor to every slot
   * EXCEPT the paint, which is #1 upside down. The paint then sits at its authored value in both
   * arms and every other slot swings with the instance colour.
   */
  const inverted = bad((c) => {
    for (const arm of c.arms) arm.slots[0] = stat(0.2789);
    c.arms[0].slots[1] = stat(0.00042); c.arms[1].slots[1] = stat(0.01300);
    c.arms[0].slots[4] = stat(0.02000); c.arms[1].slots[4] = stat(0.70016);
    c.arms[0].slots[8] = stat(0.00031); c.arms[1].slots[8] = stat(0.01092);
  });
  const invFails = failing(inverted);
  say(invFails.length >= 3, 'KNOWN-BAD: tint-invert fails, and on more than one check',
    `${invFails.length} failed: ${invFails.join(' | ')}`);
  say(invFails.some((n) => n.includes('PAINT slot moves')),
    'and one of them is that the paint stopped moving at all');
  say(invFails.some((n) => n.includes('confined')),
    'and one is the confinement ratio, which is the half a single arm cannot see');

  /**
   * KNOWN-BAD: a material that ignores instanceColor entirely — the uniform forced to 0, or the
   * injection matching nothing. The paint is dark in BOTH arms, so an arm that only looked at the
   * near-black case would pass. That is why the ratio, not a level, is the check.
   */
  const inert = bad((c) => { c.arms[1].slots[0] = stat(0.00605); });
  const inertFails = failing(inert);
  say(inertFails.length > 0, 'KNOWN-BAD: a material that ignores instanceColor fails',
    inertFails.join(' | '));
  say(verdict(inert).find((c) => c.name.includes('confined')).ok,
    'and the CONFINEMENT check still passes on it, which is why confinement alone is not a check');

  /**
   * KNOWN-BAD: the tint leaking into ONE slot only. A lumped "all other slots" median would bury
   * an 827 px slot under 4,568 px of others; per-slot is what notices it.
   */
  const oneLeak = bad((c) => { c.arms[0].slots[1] = stat(0.00400); });
  say(failing(oneLeak).some((n) => n.includes('confined')),
    'KNOWN-BAD: a leak into ONE slot is caught, which a lumped mask would bury',
    `slot 1 x${(0.013 / 0.004).toFixed(2)}`);

  for (const [what, f] of [
    ['an invisible paint slot', (c) => { c.slotPx = c.slotPx.filter((x) => x.slot !== 0); }],
    ['no non-paint slot visible', (c) => { c.slotPx = [{ slot: 0, px: 6918 }]; }],
    ['a car off camera', (c) => { c.carPx = 300; c.slotPx = c.slotPx.map((x) => ({ ...x, px: 30 })); }],
    ['the tint uniform off', (c) => { c.tint.value = 0; }],
    ['the tint on the wrong slot', (c) => { c.tint.tintedSlot = 7; }],
    ['no triangles at all', (c) => { c.triangles = 0; }],
  ]) {
    say(failing(bad(f)).length > 0, `KNOWN-BAD: ${what} fails`, failing(bad(f)).join(' | '));
  }

  console.log(`\nSELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

// ----------------------------------------------------------------------------------- the gate
const PORT = Number(process.env.CAR_PIXEL_PORT ?? treePort(new URL('..', import.meta.url).pathname.replace(/\/$/, '')));
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 420, height: 300 } });
const logs = [];
/**
 * Chromium asks for `/favicon.ico` on every page and the dev server has none, so a 404 with no URL
 * in it appears in the console on a perfectly healthy run. Named here because an unexplained 404
 * in a gate's output is the sort of thing a later round spends an hour on — and the `response`
 * listener below prints the URL so there is never any doubt which resource it was.
 */
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
// WHICH resource 404'd, not just that one did. "Failed to load resource: 404" with no URL is a
// diagnostic you cannot reason from, and this project has a CLAUDE.md section about exactly that.
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`http ${r.status()}: ${r.url()}`); });
await page.goto(`http://127.0.0.1:${PORT}/tools/car-pixel.html`);
let report = null, err = null;
try {
  await page.waitForFunction('window.__carPixel', null, { timeout: 90000 });
  report = await page.evaluate(() => window.__carPixel);
} catch (e) { err = e.message; }
await browser.close();

if (!report) {
  console.error(`the page never published a report: ${err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

console.log(`CAR-PIXEL — one traffic shell, ${report.triangles} triangles, ` +
  `${report.size.w}x${report.size.h} orthographic, ${report.carPx} px of car`);
console.log(`  visible pixels by palette slot: ` +
  report.slotPx.map((s) => `${s.slot}:${s.px}`).join(' ') +
  `   (paint is slot ${report.paintSlot})`);
const dark = report.arms.find((a) => a.tint < 0.5), light = report.arms.find((a) => a.tint > 0.5);
console.log(`\n  slot   px    p50 @ ${dark.tint.toFixed(2)}    p50 @ ${light.tint.toFixed(2)}    ratio`);
for (const { slot, px } of report.slotPx) {
  const d = dark.slots[slot], l = light.slots[slot];
  if (!d || !l) continue;
  const rr = d.p50 > 0 ? l.p50 / d.p50 : null;
  console.log(`  ${String(slot).padStart(4)} ${String(px).padStart(5)}    ${d.p50.toFixed(5)}` +
    `       ${l.p50.toFixed(5)}     ${rr === null ? '  n/a' : 'x' + rr.toFixed(3)}` +
    `${slot === report.paintSlot ? '   <- the tinted slot' : ''}`);
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nCAR-PIXEL: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
  (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
