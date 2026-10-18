// THE GATE FOR BACKLOG #130: the screen-space AO must not darken a car's GLASS beside something
// standing in front of it. See tools/glass-ao.html for the scene and the method.
//
//   node tools/glass-ao.mjs              render the car and the block through the real PostStack
//   node tools/glass-ao.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// WHY A PAGE. Three blind reviewers saw the halo in the district, in both arms of two rounds, and
// the district cannot isolate it: its crowd moves between arms and its captures are minutes a
// frame. One car, one block and the real PostStack render in a couple of seconds and hold
// everything but the term fixed — the same argument as ao-emit, beside which this sits.
//
// WHAT IS ASSERTED, in the order that makes each check mean something:
//   the thing happened   every arm's switch reached the shader, the glass, the paint and the block are
//                        in frame, nothing clipped
//   the defect is live   the BEFORE arm darkens the glass beside the block — measured every run, the
//                        known-bad — and it is the block's doing: with the block gone it does not
//   the fix              the glass beside the block is as bright as with no occlusion at all
//   the mechanism        the tag decodes as exempt on every glass pixel with the fix and as untagged
//                        without, through the composite's own debug view
//   the scope            the PAINT is untouched — byte for byte the same medians in every band — and
//                        its own depth-step halo is printed, because that leak is real and is left for
//                        the range check (src/carbody.js, GLASS_AO)
//   the build            ships the exemption ON
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/glass-ao.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 11;

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE PAGE'S REPORT. Every read goes through an accessor, because a
 * check's arguments are evaluated before the check runs and an absent statistic must FAIL rather than
 * crash the gate (CLAUDE.md, "a check's DETAIL string is evaluated eagerly").
 */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const band = (k, b, arm) => fin(r.surfaces?.[k]?.[b]?.[arm]);
  const f = (v, d = 3) => (v === null ? 'absent' : v.toFixed(d));
  const A = r.arms ?? {};
  const armsOk = [['off', 0, 1, true], ['before', 1, 0, true], ['after', 1, 1, true], ['bare0', 1, 0, false], ['bare1', 1, 1, false]]
    .every(([k, st, ex, wb]) => A[k] && A[k].uStrength === st && A[k].uExempt === ex && A[k].withBlock === wb);
  const SA = r.shareArms ?? {};
  const shareArmsOk = SA.share0?.uExempt === 0 && SA.share1?.uExempt === 1;
  add('every arm\'s switch reached the shader, read back off the uniforms', armsOk && shareArmsOk,
    `luminance arms ${armsOk}, tag arms ${shareArmsOk}`);
  const px = r.pixels ?? {};
  add('the glass, the paint and the block are all in frame, and nothing clipped',
    fin(px.glass) >= 500 && fin(px.paint) >= 500 && fin(px.block) >= 500 && fin(r.clipped) === 0,
    `glass ${px.glass}, paint ${px.paint}, block ${px.block} px; ${r.clipped} clipped`);

  // The near band is 0-8 px from the block's silhouette, where the reviewers' halo was darkest.
  const b0 = band('glass', 0, 'before'), b1 = band('glass', 1, 'before');
  add('THE DEFECT IS LIVE: before the fix the glass beside the block is darkened (the known-bad)',
    b0 !== null && b0 <= 0.75 && b1 !== null && b1 <= 0.9,
    `before/off ${f(b0)} at 0-8 px and ${f(b1)} at 8-16 px (the district's reviewer: 0.057 / 0.139 = 0.41)`);
  const z0 = band('glass', 0, 'bare0');
  add('and it is the block\'s doing: with nothing in front, the same glass is not darkened',
    z0 !== null && z0 >= 0.95, `no block, before the fix: ${f(z0)} at 0-8 px`);
  const a0 = band('glass', 0, 'after'), a1 = band('glass', 1, 'after'), a2 = band('glass', 2, 'after');
  add('THE FIX: the glass beside the block is as bright as with no occlusion at all',
    a0 !== null && a0 >= 0.98 && a1 !== null && a1 >= 0.98 && a2 !== null && a2 >= 0.98,
    `after/off ${f(a0)} / ${f(a1)} / ${f(a2)} at 0-8 / 8-16 / 16-32 px`);

  const S = r.share ?? {};
  add('the mechanism: every glass pixel decodes as exempt with the fix, and as untagged without',
    fin(S.glass?.share1Min) !== null && S.glass.share1Min >= 0.99 && fin(S.glass?.share0) !== null && S.glass.share0 <= 0.01,
    `glass share ${f(fin(S.glass?.share0), 2)} -> ${f(fin(S.glass?.share1), 2)}, least ${f(fin(S.glass?.share1Min), 2)}`);
  // The player's panes are their own material, so the fleet's injection says nothing about them.
  add('the player\'s own glass, on its own material, decodes the same: exempt with the fix, untagged without',
    fin(px.playerGlass) >= 200 && fin(S.playerGlass?.share1Min) !== null && S.playerGlass.share1Min >= 0.99
      && fin(S.playerGlass?.share0) !== null && S.playerGlass.share0 <= 0.01,
    `${px.playerGlass} px, share ${f(fin(S.playerGlass?.share0), 2)} -> ${f(fin(S.playerGlass?.share1), 2)}, least ${f(fin(S.playerGlass?.share1Min), 2)}`);
  add('and nothing else is tagged: paint, block and ground decode as untagged in both',
    ['paint', 'block', 'ground'].every((k) => fin(S[k]?.share0) === 0 && fin(S[k]?.share1) === 0),
    ['paint', 'block', 'ground'].map((k) => `${k} ${f(fin(S[k]?.share0), 2)}/${f(fin(S[k]?.share1), 2)}`).join(', '));
  // THE SCOPE: the paint is not glass, so its medians must not move at all, in any band.
  const paint = r.surfaces?.paint ?? [];
  const paintSame = paint.length === 5 && paint.every((x) => fin(x.before) !== null && x.before === x.after);
  add('the paint is untouched: before and after agree exactly in every band',
    paintSame, paint.map((x) => `${f(fin(x.before))}=${f(fin(x.after))}`).join(' '));
  // PRINTED, and asserted only as present: the same leak on the paint is real and is not this fix's.
  const p0 = band('paint', 0, 'before'), pz = band('paint', 0, 'bare0');
  add('the paint\'s own depth-step halo is measured, so its size is on the record',
    p0 !== null && pz !== null, `paint beside the block ${f(p0)} of AO-off, ${f(pz)} with nothing there — left for the range check`);
  add('the build ships the exemption ON', r.shipped === 1, `uGlassAoExempt ${r.shipped}`);
  return checks;
}

// ------------------------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('GLASS-AO SELFTEST');
  const row = (n, before, after, bare0, bare1) => ({ n, before, after, bare0, bare1 });
  /** A REAL REPORT, from the passing run that shipped the fix. */
  const good = {
    shipped: 1, clipped: 0, pixels: { glass: 1717, paint: 5531, carOther: 6490, block: 6389, ground: 71102, playerGlass: 600 },
    arms: { off: { uStrength: 0, uExempt: 1, withBlock: true }, before: { uStrength: 1, uExempt: 0, withBlock: true },
      after: { uStrength: 1, uExempt: 1, withBlock: true }, bare0: { uStrength: 1, uExempt: 0, withBlock: false },
      bare1: { uStrength: 1, uExempt: 1, withBlock: false } },
    shareArms: { share0: { exempt: 0, uExempt: 0 }, share1: { exempt: 1, uExempt: 1 } },
    surfaces: {
      glass: [row(177, 0.488, 1, 1, 1), row(238, 0.702, 1, 1, 1), row(626, 0.944, 1, 1, 1), row(664, 1, 1, 1, 1), row(12, 0.554, 1, 0.554, 1)],
      paint: [row(656, 0.708, 0.708, 0.989, 0.989), row(740, 0.869, 0.869, 0.990, 0.990), row(1120, 0.858, 0.858, 0.989, 0.989),
        row(1494, 0.979, 0.979, 0.980, 0.980), row(1521, 1, 1, 1, 1)],
    },
    share: { glass: { share0: 0, share1: 1, share1Min: 1 }, paint: { share0: 0, share1: 0, share1Min: 0 },
      block: { share0: 0, share1: 0, share1Min: 0 }, ground: { share0: 0, share1: 0, share1Min: 0 },
      playerGlass: { share0: 0, share1: 1, share1Min: 1 } },
  };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  say(failing(good).length === 0, 'a real passing report passes every check', failing(good).join(' | '));
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT && failing({}).length > 0,
    'including on an EMPTY report, which fails rather than throws', `${failing({}).length} failed`);
  for (const [what, fn, needle] of [
    // The build before #130: the after arm IS the before arm.
    ['the glass under the AO, as shipped before #130', (c) => { c.surfaces.glass.forEach((x) => { x.after = x.before; }); c.share.glass = { share0: 0, share1: 0, share1Min: 0 }; }, 'THE FIX'],
    ['a tag that reaches part of the pane', (c) => { c.share.glass.share1Min = 0.4; }, 'the mechanism'],
    ['a tag on the paint as well', (c) => { c.share.paint.share1 = 1; }, 'nothing else is tagged'],
    ['the player\'s glass left under the AO', (c) => { c.share.playerGlass = { share0: 0, share1: 0, share1Min: 0 }; }, 'player\'s own glass'],
    ['the player\'s car out of frame', (c) => { c.pixels.playerGlass = 0; }, 'player\'s own glass'],
    ['a fix that lifts the paint too', (c) => { c.surfaces.paint[0].after = 0.989; }, 'paint is untouched'],
    ['a page whose block casts no halo, so the fix is measured on nothing', (c) => { c.surfaces.glass[0].before = 1; c.surfaces.glass[1].before = 1; }, 'DEFECT IS LIVE'],
    ['a halo that is there without the block, so it is not the block\'s', (c) => { c.surfaces.glass[0].bare0 = 0.5; }, 'block\'s doing'],
    ['a switch that never reached the shader', (c) => { c.arms.after.uExempt = 0; }, 'reached the shader'],
    ['the block out of frame', (c) => { c.pixels.block = 0; }, 'in frame'],
    ['a clipped frame', (c) => { c.clipped = 40; }, 'in frame'],
    ['the exemption shipped OFF', (c) => { c.shipped = 0; }, 'ships the exemption ON'],
  ]) {
    const r = bad(fn);
    say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | '));
  }
  console.log(`\nGLASS-AO SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

// ----------------------------------------------------------------------------------- the gate
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.env.GLASS_AO_PORT ?? treePort(ROOT));
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 512, height: 320 } });
const logs = [];
page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (q) => logs.push(`requestfailed: ${q.url()} — ${q.failure()?.errorText}`));
await page.goto(`http://127.0.0.1:${PORT}/tools/glass-ao.html`);
let report = null, err = null;
try {
  await page.waitForFunction('window.__glassAo', null, { timeout: 120000 });
  report = await page.evaluate(() => window.__glassAo);
} catch (e) { err = e.message; }
await browser.close();
if (!report || report.error) {
  console.error(`the page did not publish a report: ${report ? report.error : err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

console.log(`GLASS-AO — a pedestrian-sized block ${report.proud} m in front of a fleet car's windscreen\n`);
console.log('  each arm over AO-off, median per band of distance from the block\'s silhouette');
console.log('  surface  band px     n    before    after   no block, before / after');
for (const [k, rows] of Object.entries(report.surfaces ?? {})) {
  for (const x of rows) {
    const b = `${x.band[0]}-${x.band[1] > 999 ? '' : x.band[1]}`;
    const v = (n) => (Number.isFinite(n) ? n.toFixed(3) : '  -  ');
    console.log(`  ${k.padEnd(7)} ${b.padEnd(8)} ${String(x.n).padStart(6)}    ${v(x.before)}    ${v(x.after)}     ${v(x.bare0)} / ${v(x.bare1)}`);
  }
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nGLASS-AO: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` + (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
