// THE GATE FOR BACKLOG #124's FIRST ITEM: no star draws its lattice cell's faces as 1-px strokes.
// See tools/star-strokes.html for the scene and the mechanism.
//
//   node tools/star-strokes.mjs              render the night sky through the real Sky and PostStack
//   node tools/star-strokes.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// A STROKE is a bright component longer than 4 px and under half full — a line, an L, a bracket —
// where a star is a compact blob. The camera, the sky and the lattice are fixed, so both arms are
// deterministic: the counts are the same on every run, and the bounds sit in the gap between them.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/star-strokes.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 5;

export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const B = r.before ?? {}, A = r.after ?? {};
  add('both arms reached the shader, read back off the switch', r.arms?.before === 0 && r.arms?.after === 1,
    `before ${r.arms?.before}, after ${r.arms?.after}`);
  // Measured 5 strokes and 79 components before; the bound is well under it and over the after arm.
  add('THE DEFECT IS LIVE: before the fix the stars carry strokes (the known-bad)',
    fin(B.strokes) !== null && B.strokes >= 3, `${B.strokes} strokes, ${B.components} bright components, longest ${B.longest} px`);
  add('THE FIX: at most one stroke-shaped component is left',
    fin(A.strokes) !== null && A.strokes <= 1,
    `${A.strokes} (the one left is a disc clipped by its own cell face, a dim edge rather than a lit line), ${A.components} components, longest ${A.longest} px`);
  // PER STAR, NOT THE FRAME'S BRIGHTEST: the before arm's brightest pixel was a stroke beside a star.
  // The median of each matched star's peak after over before was 0.943 when this shipped.
  const M = r.matched ?? {};
  add('and the stars are still there and as bright: matched star by star, the median peak within 15%',
    fin(A.sized) !== null && A.sized >= 15 && fin(M.stars) !== null && M.stars >= 15
      && fin(M.medianRatio) !== null && M.medianRatio >= 0.85 && M.medianRatio <= 1.15,
    `${A.sized} stars of 4 px or more; ${M.stars} matched, median peak after/before ${fin(M.medianRatio)?.toFixed(3)}, p10 ${fin(M.p10)?.toFixed(3)}`);
  add('the build ships the fix ON', r.shipped === 1, `uStarAA ${r.shipped}`);
  return checks;
}

if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
  console.log('STAR-STROKES SELFTEST');
  /** A REAL REPORT, from the run that shipped the fix. */
  const good = { shipped: 1, arms: { before: 0, after: 1 },
    before: { components: 79, sized: 31, strokes: 5, lines: 3, longest: 9, peakMax: 0.563 },
    after: { components: 27, sized: 23, strokes: 1, lines: 3, longest: 7, peakMax: 0.464 },
    matched: { stars: 51, medianRatio: 0.943, p10: 0.75 } };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  say(failing(good).length === 0, 'a real passing report passes every check', failing(good).join(' | '));
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT && failing({}).length > 0, 'including on an EMPTY report, which fails rather than throws');
  for (const [what, fn, needle] of [
    ['the build before #124: the after arm is the before arm', (c) => { c.after = { ...c.before }; }, 'THE FIX'],
    ['a fix that removes the stars along with the strokes', (c) => { c.after.sized = 2; }, 'still there'],
    ['a fix that dims them', (c) => { c.matched.medianRatio = 0.5; }, 'still there'],
    ['a fix that brightens them', (c) => { c.matched.medianRatio = 1.6; }, 'still there'],
    ['a page whose before arm has no strokes, so the fix is measured on nothing', (c) => { c.before.strokes = 0; }, 'DEFECT IS LIVE'],
    ['a switch that never reached the shader', (c) => { c.arms.after = 0; }, 'reached the shader'],
    ['the fix shipped OFF', (c) => { c.shipped = 0; }, 'ships the fix ON'],
  ]) { const r = bad(fn); say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | ')); }
  console.log(`\nSTAR-STROKES SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.env.STAR_STROKES_PORT ?? treePort(ROOT));
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${PORT}/tools/star-strokes.html`, { waitUntil: 'commit' });
let report = null, err = null;
try {
  await page.waitForFunction('window.__stars', null, { timeout: 300000 });
  report = await page.evaluate(() => window.__stars);
} catch (e) { err = e.message; }
await browser.close();
if (!report || report.error) {
  console.error(`the page did not publish a report: ${report ? report.error : err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
console.log('STAR-STROKES — the night sky through the real Sky and PostStack, looking up away from the city\n');
console.log('  arm      bright comps   4px+   strokes   1-px lines   longest   brightest');
for (const k of ['before', 'after']) {
  const x = report[k];
  console.log(`  ${k.padEnd(8)} ${String(x.components).padStart(12)} ${String(x.sized).padStart(6)} ${String(x.strokes).padStart(9)} ${String(x.lines).padStart(12)} ${String(x.longest).padStart(9)}   ${x.peakMax?.toFixed(3)}`);
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nSTAR-STROKES: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` + (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
