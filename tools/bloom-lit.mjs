// THE GATE FOR BACKLOG #118: at dusk and night, LIT light must not bloom like a light source. See
// tools/bloom-lit.html for the scene and the method.
//
//   node tools/bloom-lit.mjs              render five panels through the real PostStack and check them
//   node tools/bloom-lit.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// WHAT IS ASSERTED, in order, because each check means something only if the ones above it hold:
//   the thing happened   the tag chunk is patched, the arms' uniforms moved, every panel is in frame
//                        at the radiance and with the tag the page says it built
//   the defect is live   in the OFF arm a lit panel hands the blur what an emitter of the same
//                        radiance does: the known-bad, measured every run rather than remembered
//   the fix              in the shipped arm the lit panel hands on almost nothing
//   the controls         the emitter and the untagged panel bloom as before; a lit glint past the
//                        lit bar still blooms; a half-emitting panel blooms in part
//   the instrument       both arms' bright targets agree with the documented formula, so the split
//                        is the split the comment describes and the off arm is the old pass
//   the derivation       the shipped bar is read off noon's threshold, not typed in
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';
import { fileURLToPath } from 'node:url';

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const argv = IS_MAIN ? process.argv.slice(2) : [];
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/bloom-lit.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 14;

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE PAGE'S REPORT. Every read goes through `num`, because a
 * check's arguments are evaluated before the check runs and an absent statistic must FAIL the check
 * rather than crash the gate (CLAUDE.md, "a check's DETAIL string is evaluated eagerly").
 */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const S = r.surfaces ?? {};
  const num = (k, field) => { const v = S[k] ? S[k][field] : null; return Number.isFinite(v) ? v : null; };
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const f = (v, d = 3) => (v === null || v === undefined ? 'absent' : Number(v).toFixed(d));
  const B = r.bars ?? {};
  const A = r.arms ?? {};
  const T = fin(B.threshold), TL = fin(B.thresholdLit);

  // --- the thing happened
  add('three\'s opaque_fragment chunk carries the #114 emission tag', r.chunkPatched === true,
    `chunkPatched ${r.chunkPatched}`);
  add('each arm\'s bright-pass uniforms are what it asked for, read back off the material',
    A.off?.uThresholdLit === 0 && TL !== null && A.shipped?.uThresholdLit === TL &&
      A.off?.uThreshold === T && A.shipped?.uThreshold === T && r.size &&
      A.shipped?.uSrc?.[0] === r.size.w && A.shipped?.uSrc?.[1] === r.size.h,
    `off ${A.off?.uThreshold}/${A.off?.uThresholdLit}  shipped ${A.shipped?.uThreshold}/${A.shipped?.uThresholdLit}` +
      `  srcSize ${A.shipped?.uSrc}`);
  const names = ['emit', 'lit', 'untagged', 'half', 'glint'];
  const small = names.filter((k) => !((num(k, 'px') ?? 0) >= 400));
  add('every panel is in frame with enough pixels to read its radiance', small.length === 0,
    names.map((k) => `${k} ${num(k, 'px') ?? 0}`).join(' '));
  const off = names.filter((k) => {
    const got = num(k, 'radiance'), want = num(k, 'want');
    return !(got !== null && want !== null && Math.abs(got / want - 1) <= 0.02);
  });
  add('every panel is at the radiance the page built it for, to 2%', off.length === 0,
    names.map((k) => `${k} ${f(num(k, 'radiance'))}/${f(num(k, 'want'))}`).join(' '));
  const sh = (k) => num(k, 'share'), un = (k) => num(k, 'untagged');
  add('the tags: emitted 1, lit 0, half 0.5, the basic material untagged',
    sh('emit') !== null && sh('emit') >= 0.99 && un('emit') === 0 &&
      sh('lit') !== null && sh('lit') <= 0.01 && un('lit') === 0 &&
      sh('glint') !== null && sh('glint') <= 0.01 &&
      sh('half') !== null && Math.abs(sh('half') - 0.5) <= 0.03 &&
      un('untagged') === 1,
    `emit ${f(sh('emit'))} lit ${f(sh('lit'))} glint ${f(sh('glint'))} half ${f(sh('half'))} untagged ${f(un('untagged'))}`);

  // --- the defect is live
  const o = (k) => num(k, 'off'), s = (k) => num(k, 'shipped');
  const ratio = (a, b) => (a !== null && b !== null && b > 0 ? a / b : null);
  const litOff = ratio(o('lit'), o('emit'));
  add('KNOWN-BAD, LIVE: in the OFF arm a lit panel hands the blur what an emitter of its radiance does',
    litOff !== null && litOff >= 0.95 && litOff <= 1.05, `lit/emit ${f(litOff, 4)}`);

  // --- the fix
  const litOn = ratio(s('lit'), s('emit'));
  add('THE FIX: shipped, the lit panel hands on under 3% of what the emitter does',
    litOn !== null && litOn <= 0.03, `lit/emit ${f(litOn, 4)}`);

  // --- the controls
  const emitKeep = ratio(s('emit'), o('emit'));
  add('the emitter blooms as before, to within 5%', emitKeep !== null && emitKeep >= 0.95 && emitKeep <= 1.02,
    `shipped/off ${f(emitKeep, 4)}`);
  const unKeep = ratio(s('untagged'), o('untagged'));
  add('the untagged panel keeps the emitter\'s bar, to within 1%', unKeep !== null && Math.abs(unKeep - 1) <= 0.01,
    `shipped/off ${f(unKeep, 4)}`);
  const glintKeep = ratio(s('glint'), o('glint'));
  add('a lit panel PAST the lit bar still blooms - at least half of what it did',
    glintKeep !== null && glintKeep >= 0.5, `shipped/off ${f(glintKeep, 4)}`);
  const halfKeep = ratio(s('half'), o('half'));
  add('a half-emitting panel blooms in part: neither its old value nor nothing',
    halfKeep !== null && halfKeep > 0.05 && halfKeep < 0.7, `shipped/off ${f(halfKeep, 4)}`);

  // --- the instrument
  const agree = (a) => {
    const g = fin(a?.gpu), e = fin(a?.emulated);
    return g !== null && e !== null && e > 0 ? g / e : null;
  };
  const offAgree = agree(A.off), onAgree = agree(A.shipped);
  add('the OFF arm\'s bright target is the single-threshold formula, to 0.5%',
    offAgree !== null && Math.abs(offAgree - 1) <= 0.005 && A.off?.splitPath === false, `gpu/emulated ${f(offAgree, 5)}`);
  add('the SHIPPED arm\'s is the per-texel split the comment documents, to 0.5%',
    onAgree !== null && Math.abs(onAgree - 1) <= 0.005 && A.shipped?.splitPath === true, `gpu/emulated ${f(onAgree, 5)}`);

  // --- the derivation
  const PL = B.presetLit ?? {};
  add('the lit bar is noon\'s threshold at dusk and night, and noon and golden name none',
    Number.isFinite(B.noonThreshold) && PL.dusk === B.noonThreshold && PL.night === B.noonThreshold &&
      PL.noon === null && PL.golden === null && TL === B.noonThreshold,
    `noon threshold ${B.noonThreshold}  lit bars ${JSON.stringify(PL)}`);
  return checks;
}

/**
 * A REAL REPORT, copied from a passing run of the page (rounded to four places), so "correct" in the
 * selftest is the shape and the magnitude the page produces rather than an invented one that can
 * drift from it. Note what it records: the lit panel hands on 0.0079 of the emitter's energy where
 * the off arm hands on 1.0152, and the glint keeps 0.6947 of its own.
 */
const FIXTURE = {
  size: { w: 480, h: 160 },
  bars: {
    threshold: 0.118,
    thresholdLit: 1.331,
    noonThreshold: 1.331,
    presetLit: { noon: null, golden: null, dusk: 1.331, night: 1.331 },
    presetThreshold: { noon: 1.331, golden: 0.602, dusk: 0.314, night: 0.118 },
  },
  chunkPatched: true,
  arms: {
    off: {
      thresholdLit: 0,
      uThreshold: 0.118,
      uThresholdLit: 0,
      uSrc: [480, 160],
      gpu: 1544.3917,
      emulated: 1544.2025,
      splitPath: false,
    },
    shipped: {
      thresholdLit: 1.331,
      uThreshold: 0.118,
      uThresholdLit: 1.331,
      uSrc: [480, 160],
      gpu: 1035.6367,
      emulated: 1035.3788,
      splitPath: true,
    },
  },
  surfaces: {
    emit: {
      px: 930,
      radiance: 0.354,
      want: 0.354,
      share: 1,
      untagged: 0,
      off: 73.7413,
      shipped: 74.3397,
    },
    lit: { px: 930, radiance: 0.354, want: 0.354, share: 0, untagged: 0, off: 74.8586, shipped: 0.5898 },
    untagged: {
      px: 900,
      radiance: 0.354,
      want: 0.354,
      share: null,
      untagged: 1,
      off: 76.4517,
      shipped: 76.4517,
    },
    half: {
      px: 930,
      radiance: 0.354,
      want: 0.354,
      share: 0.5,
      untagged: 0,
      off: 74.9671,
      shipped: 19.816,
    },
    glint: {
      px: 930,
      radiance: 3.9922,
      want: 3.993,
      share: 0,
      untagged: 0,
      off: 1244.373,
      shipped: 864.4395,
    },
  },
};

if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('BLOOM-LIT SELFTEST');
  const good = FIXTURE;
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));

  say(failing(good).length === 0, 'a real passing report passes every check', failing(good).join(' | ') || `${verdict(good).length} checks`);
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT, 'including on an EMPTY report, which fails rather than throws or shrinks',
    `${verdict({}).length} checks, ${failing({}).length} failed`);

  // The fix reverted: the shipped arm IS the off arm.
  const reverted = bad((c) => { c.arms.shipped = structuredClone(c.arms.off);
    c.arms.shipped.uThresholdLit = c.bars.thresholdLit; c.arms.shipped.splitPath = true;
    for (const s of Object.values(c.surfaces)) s.shipped = s.off; });
  say(fails(reverted, 'THE FIX'), 'KNOWN-BAD: the split reverted fails "THE FIX"', failing(reverted).join(' | '));
  // Weighting by the share alone - lit light NEVER blooms - kills the glint.
  const never = bad((c) => { c.surfaces.glint.shipped = 0; });
  say(fails(never, 'PAST the lit bar'), 'KNOWN-BAD: lit light that never blooms fails the glint', failing(never).join(' | '));
  // The tag read the wrong way round: the emitter is tested as lit.
  const inverted = bad((c) => { c.surfaces.emit.shipped = c.surfaces.lit.shipped; c.surfaces.lit.shipped = c.surfaces.emit.off; });
  say(fails(inverted, 'emitter blooms as before') && fails(inverted, 'THE FIX'),
    'KNOWN-BAD: an inverted share fails both the emitter and the fix', failing(inverted).join(' | '));
  // Untagged treated as lit: the basic material loses its bloom.
  const unAsLit = bad((c) => { c.surfaces.untagged.shipped = 0; });
  say(fails(unAsLit, 'untagged panel'), 'KNOWN-BAD: an untagged texel tested as lit fails its control', failing(unAsLit).join(' | '));
  // A flag rather than a share: the half panel all or nothing.
  for (const [what, v] of [['all', 1], ['nothing', 0]]) {
    const flag = bad((c) => { c.surfaces.half.shipped = c.surfaces.half.off * v; });
    say(fails(flag, 'blooms in part'), `KNOWN-BAD: a flag that gives the half panel ${what} fails`, failing(flag).join(' | '));
  }
  // An unwired uniform: the arms are the same render.
  const unwired = bad((c) => { c.arms.shipped.uThresholdLit = 0; });
  say(fails(unwired, 'uniforms are what it asked for'), 'KNOWN-BAD: an unwired thresholdLit fails the read-back', failing(unwired).join(' | '));
  // The defect not reproduced: the off arm already lit-free (a page whose lit panel is too dim).
  const dim = bad((c) => { c.surfaces.lit.off = c.surfaces.emit.off * 0.2; });
  say(fails(dim, 'KNOWN-BAD, LIVE'), 'KNOWN-BAD: a scene that does not show the defect fails the live check', failing(dim).join(' | '));
  // A shader that does not do what the emulation says.
  const drift = bad((c) => { c.arms.shipped.gpu = c.arms.shipped.emulated * 1.08; });
  say(fails(drift, 'per-texel split'), 'KNOWN-BAD: a shader that drifts from the documented split fails', failing(drift).join(' | '));
  // A literal where the derivation should be.
  const literal = bad((c) => { c.bars.presetLit.night = 1.4; c.bars.thresholdLit = 1.4; c.arms.shipped.uThresholdLit = 1.4; });
  say(fails(literal, 'noon\'s threshold'), 'KNOWN-BAD: a lit bar typed in rather than read off noon fails', failing(literal).join(' | '));
  const daytime = bad((c) => { c.bars.presetLit.golden = c.bars.noonThreshold; });
  say(fails(daytime, 'noon and golden name none'), 'KNOWN-BAD: a lit bar at golden fails (golden keeps the old pass)', failing(daytime).join(' | '));
  const wrongRad = bad((c) => { c.surfaces.lit.radiance *= 0.5; });
  say(fails(wrongRad, 'radiance the page built'), 'KNOWN-BAD: a panel off its radiance fails the setup check', failing(wrongRad).join(' | '));

  console.log(`\nBLOOM-LIT SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

if (IS_MAIN && !argv.includes('--selftest')) {
  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const PORT = Number(process.env.BLOOM_LIT_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 520, height: 200 } });
  const logs = [];
  page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/tools/bloom-lit.html`);
  let report = null, err = null;
  try {
    await page.waitForFunction('window.__bloomLit', null, { timeout: 90000 });
    report = await page.evaluate(() => window.__bloomLit);
  } catch (e) { err = e.message; }
  await browser.close();

  if (!report || report.error) {
    console.error(`the page did not publish a report: ${report ? report.error : err}`);
    if (logs.length) console.error('console:\n' + logs.join('\n'));
    process.exit(1);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

  const B = report.bars;
  console.log(`BLOOM-LIT — five panels through the real PostStack at the NIGHT bars: threshold ${B.threshold},` +
    ` lit ${B.thresholdLit} (noon's threshold ${B.noonThreshold}), exposure 1`);
  console.log('\n  panel       px   radiance  share   handed to the blur: off      shipped   shipped/off');
  for (const [k, s] of Object.entries(report.surfaces)) {
    const g = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '   -');
    console.log(`  ${k.padEnd(9)} ${String(s.px).padStart(5)}   ${g(s.radiance).padStart(7)}  ` +
      `${s.untagged === 1 ? ' none' : g(s.share, 2).padStart(5)}   ${g(s.off, 2).padStart(16)}  ${g(s.shipped, 2).padStart(10)}` +
      `   ${g(s.off > 0 ? s.shipped / s.off : NaN, 4).padStart(9)}`);
  }
  console.log('');
  const checks = verdict(report);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nBLOOM-LIT: ${failed.length || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
    (failed.length ? `, ${failed.length} failed` : '') + (counted ? '' : ` (expected ${CHECK_COUNT})`));
  process.exit(failed.length || !counted ? 1 : 0);
}
