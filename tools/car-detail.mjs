// THE GATE FOR THE NUMBER PLATE'S FACE (src/carbody.js PLATE). See tools/car-detail.html.
//
//   node tools/car-detail.mjs              build the plates, render them, check both
//   node tools/car-detail.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// The plate was blank — "a uniform field with no characters", in both arms of the cabin's blind
// review — and the wrong shape: 0.46-0.49 m by 0.13 m, a European plate, where a US plate is 12 x 6
// in. Two halves, and the gate checks both where each can be measured:
//
//   OFFLINE, off the built buffers: every fleet shell and the player's car carries a plate of
//   exactly 0.3048 x 0.1524 m, flat, whose uv.y runs 0 at its foot to 1 at its head (the face's own
//   coordinate), and no body vertex stands behind it inside its outline.
//
//   IN THE PAGE, through the real instanced material, from behind at street height:
//     the face is there      most of the near plate changes, and some of it becomes ink
//     and nowhere else       no pixel off the plate moves by more than 2 levels
//     filtered               at 16 m, where a font pixel is a third of a screen pixel, the plate
//                            integrates to the same face as near, and no pixel reaches the full
//                            darkness of a stroke — the signature of a sampled-not-filtered font
//     per car                a second instance carries different characters
//     on the player too      the player's car has the face (its plate is on its own build)
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';
import { buildTrafficCarGeometry, buildPlayerCar, SHAPES, SURFACE, paletteU } from '../src/carbody.js';

/**
 * A US plate is 12 x 6 inches, WRITTEN OUT HERE rather than imported: comparing the build against
 * the module's own PLATE constant would let a wrong constant move the plate and the expectation
 * together and agree with itself (CLAUDE.md, the shunt-fit ladder).
 */
const US_PLATE = { w: 12 * 0.0254, h: 6 * 0.0254 };

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/car-detail.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 12;
/** The render order: [face] per tile, rows top to bottom (see car-detail.html's plan). */
export const PLANNED = [0, 1, 0, 1, 0, 1, 0, 1];

/** The plate off each built buffer: its extent, its uv.y, and anything standing behind it. */
export function plateGeometry() {
  const one = (name, geo) => {
    const pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
    const u = paletteU(SURFACE.plate);
    const pl = [];
    for (let i = 0; i < pos.count; i++) if (Math.abs(uv.getX(i) - u) < 1e-4) pl.push([pos.getX(i), pos.getY(i), pos.getZ(i), uv.getY(i)]);
    if (!pl.length) return { name, verts: 0 };
    const xs = pl.map((p) => p[0]), ys = pl.map((p) => p[1]), zs = pl.map((p) => p[2]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const zPlate = Math.min(...zs), zSpread = Math.max(...zs) - zPlate;
    // uv.y must be the face's own vertical: 0 on the lowest corners, 1 on the highest.
    const vOk = pl.every((p) => Math.abs(p[3] - (p[1] - y0) / (y1 - y0)) < 1e-6);
    let behind = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(uv.getX(i) - u) < 1e-4) continue;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x > x0 && x < x1 && y > y0 && y < y1 && z < zPlate) behind++;
    }
    return { name, verts: pl.length, w: x1 - x0, h: y1 - y0, zSpread, vOk, behind, cx: (x0 + x1) / 2 };
  };
  const out = ['coupe', 'saloon', 'wagon'].map((s) => one(s, buildTrafficCarGeometry({ groundY: 0, shape: SHAPES[s] })));
  out.push(one('player', buildPlayerCar().bodyMesh.geometry));
  return out;
}

/** The verdict as a pure function of the report, so the selftest can feed it known-bads. */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const num = (v) => (Number.isFinite(v) ? v : null);
  const G = Array.isArray(r.geometry) ? r.geometry : [];
  add('every fleet shell and the player\'s car carries a plate', G.length === 4 && G.every((g) => g.verts >= 4),
    G.map((g) => `${g.name} ${g.verts}`).join(', '));
  add('a US plate, 12 x 6 in, on every one of them, to a millimetre',
    G.length === 4 && G.every((g) => Math.abs(g.w - US_PLATE.w) < 1e-3 && Math.abs(g.h - US_PLATE.h) < 1e-3),
    G.map((g) => `${g.name} ${num(g.w)?.toFixed(4)} x ${num(g.h)?.toFixed(4)}`).join(', '));
  add('flat, centred, carrying its own vertical in uv.y, with no body standing behind it',
    G.length === 4 && G.every((g) => g.zSpread < 1e-6 && Math.abs(g.cx) < 1e-6 && g.vOk && g.behind === 0),
    G.map((g) => `${g.name} z-spread ${num(g.zSpread)?.toExponential(1)} v ${g.vOk} behind ${g.behind}`).join(', '));

  add('the build ships the face ON', num(r.shipped) === 1, `shipped ${r.shipped}`);
  const rb = r.readback ?? [];
  add('every render\'s switch is what it asked for, read back off the material\'s own uniform',
    rb.length === PLANNED.length && PLANNED.every((k, i) => rb[i] === k), `${rb.length} of ${PLANNED.length} tiles`);

  const N = r.near ?? {}, F = r.far ?? {}, O = r.other ?? {}, P = r.player ?? {};
  const changed = (x) => (num(x.plateChanged) ?? 0) / Math.max(1, num(x.platePx) ?? 0);
  add('the face is there: most of the near plate changes, and some of it is ink',
    num(N.platePx) >= 120 && changed(N) >= 0.4 && num(N.inkFrac) >= 0.08 && num(N.inkFrac) <= 0.4,
    `${N.plateChanged} of ${N.platePx} px changed (${(100 * changed(N)).toFixed(1)}%), ink ${(100 * (num(N.inkFrac) ?? 0)).toFixed(1)}%`);
  const leaks = [N, F, O, P].map((x) => num(x.otherChanged2));
  add('and nowhere else: no pixel off the plate moves by more than 2 levels, in any row',
    leaks.every((v) => v === 0) && [N, F, O, P].every((x) => num(x.otherPx) > 0),
    `${leaks.join(' / ')} px; max ${[N, F, O, P].map((x) => x.otherMax).join(' / ')} levels`);
  const nearR = num(N.meanOn) !== null && num(N.meanOff) > 0 ? N.meanOn / N.meanOff : null;
  const farR = num(F.meanOn) !== null && num(F.meanOff) > 0 ? F.meanOn / F.meanOff : null;
  /**
   * FILTERED, TWO WAYS. At 16 m a font pixel is about a third of a screen pixel. A face that is
   * filtered integrates to the same ink there as near (0.779 of the blank against 0.761 near), and no
   * pixel can be a whole stroke (the darkest far pixel is 0.52 of the blank, where a near stroke is
   * 0.066). The first cut's edge could widen past a font pixel and inked bare plate at 15.6%: the far
   * plate read 0.551 against 0.761 near.
   */
  add('filtered: at 16 m the plate integrates to the same face as it does near',
    num(F.platePx) >= 8 && nearR !== null && farR !== null && Math.abs(farR - nearR) <= 0.1,
    `far ${farR?.toFixed(3)} of the blank against near ${nearR?.toFixed(3)}, over ${F.platePx} px`);
  add('and no far pixel reaches the darkness of a whole stroke',
    num(F.minOnRatio) !== null && F.minOnRatio >= 0.3 && num(N.minOnRatio) !== null && N.minOnRatio < 0.3,
    `darkest far px ${num(F.minOnRatio)?.toFixed(3)} of the blank; near strokes reach ${num(N.minOnRatio)?.toFixed(3)}`);
  const T = r.twoCars ?? {};
  add('per car: a second instance carries different characters on the same plate',
    num(T.shared) >= 120 && num(T.frac) >= 0.1, `${T.differ} of ${T.shared} px differ (${(100 * (num(T.frac) ?? 0)).toFixed(1)}%)`);
  add('the player\'s car has the face too', num(P.platePx) >= 120 && changed(P) >= 0.4,
    `${P.plateChanged} of ${P.platePx} px changed`);
  add('and the switch is back to the shipped state after the page is done with it', num(r.after) === num(r.shipped),
    `after ${r.after}`);
  return checks;
}

// ------------------------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('CAR-DETAIL SELFTEST');
  const g = (name) => ({ name, verts: 4, w: 0.3048, h: 0.1524, zSpread: 0, vOk: true, behind: 0, cx: 0 });
  const row = (px, changed, inkFrac, meanOn, minOnRatio) => ({ platePx: px, plateChanged: changed, inkFrac, offMed: 0.602,
    meanOff: 0.602, meanOn, minOnRatio, otherPx: 141980, otherChanged2: 0, otherMax: 0 });
  /** A REAL REPORT, from a passing run of the page at noon. */
  const good = {
    geometry: ['coupe', 'saloon', 'wagon', 'player'].map(g),
    shipped: 1, readback: [...PLANNED], after: 1,
    near: row(230, 158, 0.174, 0.4581, 0.066), far: row(21, 20, 0, 0.4690, 0.522),
    other: row(230, 145, 0.152, 0.4708, 0.044), player: row(230, 158, 0.174, 0.4581, 0.066),
    twoCars: { shared: 230, differ: 62, frac: 0.2696 },
  };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  say(failing(good).length === 0, 'a real passing report passes every check', failing(good).join(' | '));
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT && failing({}).length > 0,
    'including on an EMPTY report, which fails rather than throws', `${failing({}).length} failed`);
  for (const [what, fn, needle] of [
    // The plate as it shipped, measured: 0.46 x 0.13 on the coupe.
    ['a European plate', (c) => { c.geometry[0].w = 0.4620; c.geometry[0].h = 0.1300; }, '12 x 6 in'],
    ['the player\'s plate left on the old band', (c) => { c.geometry[3].zSpread = 0.063; c.geometry[3].vOk = false; }, 'flat, centred'],
    ['a plate buried in its bumper', (c) => { c.geometry[1].behind = 6; }, 'flat, centred'],
    ['a shell with no plate', (c) => { c.geometry[2].verts = 0; }, 'carries a plate'],
    ['the face shipped off', (c) => { c.shipped = 0; c.after = 0; }, 'ships the face ON'],
    ['a switch that never reaches the material', (c) => { c.readback[1] = 0; }, 'switch is what it asked for'],
    ['a blank plate', (c) => { c.near.plateChanged = 0; c.near.inkFrac = 0; }, 'the face is there'],
    ['a face painted over the whole car', (c) => { c.near.otherChanged2 = 9000; c.near.otherMax = 140; }, 'nowhere else'],
    // Measured: the first cut's edge, two font pixels wide at distance.
    ['a filter biased to ink at distance', (c) => { c.far.meanOn = 0.551 * 0.602; }, 'integrates to the same face'],
    ['a font sampled rather than filtered', (c) => { c.far.minOnRatio = 0.07; }, 'darkness of a whole stroke'],
    ['every car the same plate', (c) => { c.twoCars.differ = 0; c.twoCars.frac = 0; }, 'different characters'],
    ['the player\'s plate blank', (c) => { c.player.plateChanged = 0; }, 'player\'s car has the face'],
    ['the page leaving the switch changed', (c) => { c.after = 0; }, 'back to the shipped state'],
  ]) {
    const r = bad(fn);
    say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | '));
  }
  // And the geometry checks read the REAL builders, so they are run here too: a selftest that only
  // fed the verdict invented numbers would pass on a build whose plate had already regressed.
  const real = plateGeometry();
  const geo = verdict({ ...good, geometry: real }).slice(0, 3);
  say(geo.every((c) => c.ok), 'the shipped builders\' plates pass the three geometry checks', geo.filter((c) => !c.ok).map((c) => c.detail).join(' | '));
  console.log(`\nCAR-DETAIL SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

// ----------------------------------------------------------------------------------- the gate
const geometry = plateGeometry();
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.env.CAR_DETAIL_PORT ?? treePort(ROOT));
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1000, height: 1240 } });
const logs = [];
page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
await page.goto(`http://127.0.0.1:${PORT}/tools/car-detail.html`);
let report = null, err = null;
try {
  await page.waitForFunction('window.__carDetail', null, { timeout: 90000 });
  report = await page.evaluate(() => window.__carDetail);
} catch (e) { err = e.message; }
await browser.close();
if (!report || report.error) {
  console.error(`the page did not publish a report: ${report ? report.error : err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
report.geometry = geometry;
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

console.log(`CAR-DETAIL — the number plate, built and drawn (${report.tod})\n`);
console.log('  plate      w x h (m)          flat   uv.y   behind');
for (const g of geometry) {
  console.log(`  ${g.name.padEnd(9)} ${g.w?.toFixed(4)} x ${g.h?.toFixed(4)}   ${g.zSpread < 1e-6 ? 'yes ' : 'NO  '}   ${g.vOk ? 'yes' : 'NO '}    ${g.behind}`);
}
console.log('\n  row      plate px  changed   ink     mean on/blank   darkest on/blank');
for (const k of ['near', 'far', 'other', 'player']) {
  const x = report[k];
  console.log(`  ${k.padEnd(8)} ${String(x.platePx).padStart(8)}  ${String(x.plateChanged).padStart(7)}   ${(100 * x.inkFrac).toFixed(1).padStart(5)}%` +
    `   ${(x.meanOn / x.meanOff).toFixed(3).padStart(10)}       ${x.minOnRatio?.toFixed(3)}`);
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nCAR-DETAIL: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` + (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
