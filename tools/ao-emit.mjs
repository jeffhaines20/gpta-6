// THE GATE FOR BACKLOG #114: the screen-space AO must not darken EMITTED light. See
// tools/ao-emit.html for the scene and the method.
//
//   node tools/ao-emit.mjs              render the wall through the real PostStack and check it
//   node tools/ao-emit.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// WHY A PAGE AND NOT THE DISTRICT. The defect is one line in a composite shader and one chunk in
// three's lit materials, and nothing offline compiles either. The district's captures take minutes
// a frame and their crowd moves between arms. A purpose-built wall with three panels and a pillar
// in front of each renders in about two seconds and holds everything but the term fixed — which is
// why this is cheap enough for mutation-sweep's offline list, beside car-pixel.
//
// WHAT IS ASSERTED, and the order matters because each check is only meaningful if the ones above
// it hold:
//   the thing happened   the chunk is patched, the arms' uniforms moved, every surface is in frame,
//                        the AO actually darkened each panel beside its pillar, nothing clipped
//   the defect is live   the BEFORE arm darkens the window: the known-bad, measured rather than
//                        remembered, every run
//   the fix              the window gets its emitted light back
//   the control          the plain wall and the pillars are byte-for-byte as occluded as before
//   the share            a panel half lit and half emitting is exempted in part, not 0 and not 1
//   the safety property  an additive overlay over an occluded wall does not lift it, and over the
//                        window it can only take exemption away
//   the guard            a transparent lit pane still blends, so the tag stayed off its alpha
//   the invariant        over EVERY pixel, after lies between before and off
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/ao-emit.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 16;

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE PAGE'S REPORT, so the selftest feeds it known-bad numbers
 * without a browser. Every read goes through `num`, because a check's arguments are evaluated before
 * the check runs and an absent statistic must FAIL the check rather than crash the gate (CLAUDE.md,
 * "a check's DETAIL string is evaluated eagerly").
 */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const S = r.surfaces ?? {};
  const num = (k, field, p) => {
    const s = S[k];
    if (!s) return null;
    const v = p ? (s[field] ? s[field][p] : null) : s[field];
    return Number.isFinite(v) ? v : null;
  };
  const f = (v, d = 3) => (v === null ? 'absent' : v.toFixed(d));

  // --- the thing happened
  add('three\'s opaque_fragment chunk carries the emission tag', r.chunkPatched === true,
    `chunkPatched ${r.chunkPatched}`);
  const A = r.arms ?? {};
  add('each arm\'s uniforms are what it asked for, read back off the composite',
    A.off?.uStrength === 0 && A.before?.uStrength === 1 && A.before?.uExempt === 0 &&
      A.after?.uStrength === 1 && A.after?.uExempt === 1,
    ['off', 'before', 'after'].map((k) => `${k} ${A[k]?.uStrength}/${A[k]?.uExempt}`).join('  '));
  const need = { window: 500, half: 500, wall: 500, pillar: 500, overlayWindow: 200, overlayWall: 200, pane: 200 };
  const short = Object.entries(need).filter(([k, n]) => !((num(k, 'px') ?? 0) >= n));
  add('every surface is in frame with enough pixels for a median', short.length === 0,
    Object.keys(need).map((k) => `${k} ${num(k, 'px') ?? 0}`).join(' '));
  const actedOn = ['window', 'half', 'wall', 'overlayWindow', 'overlayWall'];
  const thin = actedOn.filter((k) => !((num(k, 'acted') ?? 0) >= 100));
  /**
   * WHERE THE AO ACTS is selected on the BEFORE arm (darker than off by a tenth) and judged on
   * AFTER, an independent render. Without this, every ratio below would be over pixels the AO never
   * touched, and "the window is not darkened" would pass for the most flattering possible reason.
   */
  add('the AO darkened every panel beside its pillar, so there is something to exempt',
    thin.length === 0, actedOn.map((k) => `${k} ${num(k, 'acted') ?? 0} px`).join(' '));
  const clipped = ['window', 'half', 'wall'].filter((k) => (num(k, 'clipped') ?? 1) !== 0);
  add('nothing the checks read is clipped, where every ratio reads 1 for the wrong reason',
    clipped.length === 0, ['window', 'half', 'wall'].map((k) => `${k} ${num(k, 'clipped')}`).join(' '));

  // --- the defect, live
  const wBefore = num('window', 'beforeOff', 'p50');
  add('KNOWN-BAD, LIVE: the composite before the fix darkens the lit window beside its pillar',
    wBefore !== null && wBefore < 0.8,
    `window before/off p50 ${f(wBefore)} — that is the defect, every run`);

  // --- the fix
  const wRec50 = num('window', 'recovered', 'p50'), wRec10 = num('window', 'recovered', 'p10');
  /**
   * NOT 1, AND THE GAP IS PHYSICS. The window has no albedo, but it is a dielectric (F0 0.04), so
   * a few percent of what it sends is the sun and the ambient REFLECTED off it, and that part is
   * correctly still occluded. Measured 0.965 / 0.986 at p10 / p50; the exemption switched off
   * reads 0, so 0.9 has nothing between it and either.
   */
  add('the fix: the window gets its emitted light back where the AO had taken it',
    wRec50 !== null && wRec10 !== null && wRec50 >= 0.95 && wRec10 >= 0.9,
    `recovered p10 ${f(wRec10)} p50 ${f(wRec50)} of the way from before to off`);

  // --- the control
  const same = (k) => {
    const lo = num(k, 'afterBefore', 'p10'), hi = num(k, 'afterBefore', 'p90');
    return { ok: lo !== null && hi !== null && lo >= 0.995 && hi <= 1.005, lo, hi };
  };
  const wall = same('wall');
  add('the control: the plain wall is exactly as occluded as before',
    wall.ok, `wall after/before p10 ${f(wall.lo, 4)} p90 ${f(wall.hi, 4)}`);
  const pil = same('pillar');
  add('and so are the pillars, which emit nothing either',
    pil.ok, `pillar after/before p10 ${f(pil.lo, 4)} p90 ${f(pil.hi, 4)}`);

  // --- the share
  const hRec = num('half', 'recovered', 'p50');
  add('a panel half lit and half emitting is exempted IN PART — the tag is a share, not a flag',
    hRec !== null && hRec > 0.2 && hRec < 0.8, `half recovered p50 ${f(hRec)}`);
  const wRecAll = wRec50 ?? -1;
  add('and in part strictly less than the all-emitting window',
    hRec !== null && wRec50 !== null && hRec < wRecAll, `half ${f(hRec)} < window ${f(wRec50)}`);

  // --- the safety property
  const ow = same('overlayWall');
  /**
   * THE ENCODING'S WHOLE ARGUMENT. An additive surface over an occluded wall adds its own alpha to
   * the wall's tag. Encoded negative, that moves the tag toward "nothing emitted" and the wall stays
   * occluded; encoded positive (or decoded without its sign), it moves the wall toward "all
   * emitted" and an awning's glow would lift the AO off whatever it falls on.
   */
  add('an additive overlay over an occluded wall does NOT lift its occlusion',
    ow.ok, `overlay-on-wall after/before p10 ${f(ow.lo, 4)} p90 ${f(ow.hi, 4)}`);
  const owRec = num('overlayWindow', 'recovered', 'p50');
  add('and over the window it can only take exemption AWAY, never add it',
    owRec !== null && wRec50 !== null && owRec <= wRec50 + 1e-9,
    `overlay-on-window recovered p50 ${f(owRec)} against the bare window's ${f(wRec50)}`);

  // --- the guard
  const pane = num('pane', 'offLuma'), wallL = num('wall', 'offLuma');
  /**
   * A transparent lit material is not tagged, because its alpha is its coverage. Removed, the guard
   * hands the pane a source alpha near -1 and normal blending computes src*(-1) + dst*2: measured,
   * the pane went from 0.839 to 0.000. White at half coverage over grey must read brighter.
   */
  add('a transparent lit pane still blends — the tag stayed off a transparent material\'s alpha',
    pane !== null && wallL !== null && pane > wallL,
    `pane ${f(pane)} over a wall reading ${f(wallL)}`);

  // --- the invariant
  const inv = r.invariant ?? {};
  add('over EVERY pixel and channel, after lies between before and off to within one code value',
    Number.isFinite(inv.compared) && inv.compared > 0 && inv.violations === 0,
    `${inv.violations ?? 'absent'} of ${inv.compared ?? 'absent'} outside, worst by ${inv.worst ?? 'absent'}`);
  add('and the invariant covered the whole frame, not a sample of it',
    Number.isFinite(inv.compared) && r.size && inv.compared === r.size.w * r.size.h * 3,
    `${inv.compared} of ${r.size ? r.size.w * r.size.h * 3 : 'absent'}`);
  return checks;
}

// ------------------------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('AO-EMIT SELFTEST');
  /**
   * THE FIXTURE IS A REAL REPORT, copied from a passing run of the page (statistics rounded to
   * four places), so "correct" here is the shape and the magnitude the page produces rather than
   * an invented one that can drift from it.
   */
  const st = (p10, p50, p90) => ({ p10, p50, p90 });
  const one = st(1, 1, 1), zero = st(0, 0, 0);
  const good = {
    size: { w: 384, h: 256 }, chunkPatched: true,
    arms: { off: { uStrength: 0, uExempt: 1 }, before: { uStrength: 1, uExempt: 0 },
      after: { uStrength: 1, uExempt: 1 } },
    invariant: { compared: 294912, violations: 0, worst: 0 },
    surfaces: {
      pillar: { px: 12374, acted: 1574, offLuma: 0.6939, clipped: 0, beforeOff: st(0.208, 0.6697, 0.8252), afterBefore: one, recovered: zero },
      window: { px: 13193, acted: 3879, offLuma: 0.7084, clipped: 0, beforeOff: st(0.1252, 0.4627, 0.8431), afterBefore: st(1.174, 2.139, 7.9082), recovered: st(0.9646, 0.9856, 1) },
      half: { px: 15810, acted: 4077, offLuma: 0.7913, clipped: 0, beforeOff: st(0.1544, 0.5349, 0.8145), afterBefore: st(1.0991, 1.4902, 4.4169), recovered: st(0.4556, 0.5636, 0.6204) },
      wall: { px: 11217, acted: 3834, offLuma: 0.6939, clipped: 0, beforeOff: st(0.1473, 0.4997, 0.8411), afterBefore: one, recovered: zero },
      pane: { px: 1110, acted: 0, offLuma: 0.8388, clipped: 0, beforeOff: null, afterBefore: null, recovered: null },
      overlayWindow: { px: 1369, acted: 479, offLuma: 0.7231, clipped: 0, beforeOff: st(0.18, 0.4997, 0.8723), afterBefore: one, recovered: zero },
      overlayWall: { px: 1591, acted: 512, offLuma: 0.7084, clipped: 0, beforeOff: st(0.1075, 0.4894, 0.8524), afterBefore: one, recovered: zero },
    },
  };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));

  say(failing(good).length === 0, 'a real passing report passes every check', `${verdict(good).length} checks`);
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT, 'including on an EMPTY report, which fails rather than throws or shrinks',
    `${verdict({}).length} checks, ${failing({}).length} failed`);

  // KNOWN-BAD: the exemption switched off — the composite before the fix. The window recovers
  // nothing; everything else is the correct build.
  const off = bad((c) => { c.surfaces.window.recovered = zero; c.surfaces.window.afterBefore = one;
    c.surfaces.half.recovered = zero; c.surfaces.half.afterBefore = one; });
  say(fails(off, 'the fix:'), 'KNOWN-BAD: the exemption off fails "the fix"', failing(off).join(' | '));

  // KNOWN-BAD: everything exempted — a tag written as "all emitted" for every lit pixel.
  const all = bad((c) => { for (const k of ['wall', 'pillar', 'overlayWall']) {
    c.surfaces[k].recovered = one; c.surfaces[k].afterBefore = st(1.2, 2.0, 6.0); } });
  say(fails(all, 'the control') && fails(all, 'pillars'),
    'KNOWN-BAD: every lit pixel exempted fails the wall AND the pillar controls', failing(all).join(' | '));

  // KNOWN-BAD: the tag decoded without its sign, so an additive overlay INVENTS exemption.
  const unsigned = bad((c) => { c.surfaces.overlayWall.recovered = one; c.surfaces.overlayWall.afterBefore = st(1.3, 2.0, 7.0); });
  say(fails(unsigned, 'does NOT lift'), 'KNOWN-BAD: an overlay that lifts the wall fails the safety check',
    failing(unsigned).join(' | '));

  // KNOWN-BAD: a binary tag — any emission at all reads as all of it.
  const binary = bad((c) => { c.surfaces.half.recovered = st(0.95, 0.99, 1); });
  say(fails(binary, 'IN PART'), 'KNOWN-BAD: a flag rather than a share fails the half panel', failing(binary).join(' | '));

  // KNOWN-BAD: the AO inert — nothing darkened, so nothing could be exempted. Every exemption
  // check would pass over an empty population; these are the ones that say so.
  const inert = bad((c) => { for (const s of Object.values(c.surfaces)) { s.acted = 0; s.beforeOff = null; }
    c.surfaces.window.recovered = null; c.surfaces.half.recovered = null; });
  say(fails(inert, 'darkened every panel') && fails(inert, 'KNOWN-BAD, LIVE'),
    'KNOWN-BAD: an inert AO fails "the AO darkened" and the live known-bad', failing(inert).join(' | '));

  // KNOWN-BAD: the composite uniform not wired — both AO arms are exempt and the BEFORE arm reads
  // as the fix.
  const unwired = bad((c) => { c.arms.before.uExempt = 1; });
  say(fails(unwired, 'uniforms are what it asked for'), 'KNOWN-BAD: an unwired aoEmitExempt fails the read-back',
    failing(unwired).join(' | '));

  // KNOWN-BAD: the OPAQUE guard gone — the transparent pane renders black.
  const unguarded = bad((c) => { c.surfaces.pane.offLuma = 0; });
  say(fails(unguarded, 'transparent lit pane'), 'KNOWN-BAD: a tagged transparent material fails the guard check',
    failing(unguarded).join(' | '));

  for (const [what, fn, needle] of [
    ['the chunk not patched', (c) => { c.chunkPatched = false; }, 'opaque_fragment'],
    ['a pixel outside [before, off]', (c) => { c.invariant.violations = 3; c.invariant.worst = 9; }, 'EVERY pixel'],
    ['an invariant over half the frame', (c) => { c.invariant.compared = 147456; }, 'whole frame'],
    ['a clipped window', (c) => { c.surfaces.window.clipped = 40; }, 'clipped'],
    ['a surface out of frame', (c) => { delete c.surfaces.half; }, 'in frame'],
    ['the overlay adding exemption to the window', (c) => { c.surfaces.overlayWindow.recovered = st(1, 1, 1);
      c.surfaces.window.recovered = st(0.96, 0.98, 1); }, 'only take exemption AWAY'],
  ]) {
    const r = bad(fn);
    say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | '));
  }

  console.log(`\nAO-EMIT SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

// ----------------------------------------------------------------------------------- the gate
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.env.AO_EMIT_PORT ?? treePort(ROOT));
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 420, height: 300 } });
const logs = [];
page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
// Chromium asks for /favicon.ico on every page and the dev server has none; name every OTHER 4xx.
page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
await page.goto(`http://127.0.0.1:${PORT}/tools/ao-emit.html`);
let report = null, err = null;
try {
  await page.waitForFunction('window.__aoEmit', null, { timeout: 90000 });
  report = await page.evaluate(() => window.__aoEmit);
} catch (e) { err = e.message; }
await browser.close();

if (!report || report.error) {
  console.error(`the page did not publish a report: ${report ? report.error : err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

console.log(`AO-EMIT — a wall of three panels and a pillar against each, ${report.size.w}x${report.size.h}, ` +
  `through the real PostStack at exposure ${report.exposure}`);
console.log('\n  surface         px  where AO acts   before/off p50   recovered p10 / p50   after/before p50');
for (const [k, s] of Object.entries(report.surfaces)) {
  const g = (o, p, d = 3) => (o && Number.isFinite(o[p]) ? o[p].toFixed(d) : '   -');
  console.log(`  ${k.padEnd(14)} ${String(s.px).padStart(5)}  ${String(s.acted).padStart(8)} px` +
    `        ${g(s.beforeOff, 'p50')}          ${g(s.recovered, 'p10')} / ${g(s.recovered, 'p50')}` +
    `          ${g(s.afterBefore, 'p50', 4)}`);
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nAO-EMIT: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
  (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
