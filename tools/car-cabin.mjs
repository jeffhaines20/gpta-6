// THE GATE FOR THE CABIN BEHIND THE CAR GLASS (src/carbody.js CABIN). See tools/car-cabin.html.
//
//   node tools/car-cabin.mjs              render one car through the real material and check it
//   node tools/car-cabin.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// WHY A PAGE. The cabin is a ray cast inside the car material's fragment shader, and nothing offline
// compiles a shader. `car-pixel` renders one car and reads it per palette slot, and this is its
// sibling for the glazing slot: the same instanced material the fleet and the parked pool use, at
// street height, from three sides.
//
// WHAT IT CANNOT SAY is the LEVEL: this page's sky is not the district's, so the shipped transmission
// was chosen on car-pane's district boxes (recorded in CABIN's own comment). Everything asserted here
// holds at any level:
//
//   the thing happened   the build ships the cabin on, the uniforms each render asked for are the
//                        ones the material holds, every view has its glazing in frame
//   it reaches the glass most of the glazing changes when the cabin turns on, in every view
//   and nothing else     no pixel outside the glazing moves by more than 2 levels (1-level changes
//                        are edge-on glass slivers the antialiased scene catches and the mask misses)
//   both of its parts    the interior alone changes the glass, and the far window alone is brighter
//                        than the interior on a real share of it — a cabin you can see THROUGH
//   in the car's frame   the car, the camera and the sun moved by one rigid transform render the same
//                        glass, cabin on — and the cabin-off control says the move alone is invisible
//   not on the player    the player's body material (mirror glass on slot 10) never gets a cabin
//   but in the player    the player's own car — its panes a separate mesh on a separate material —
//                        does get one: the cabin's blind review found it the one black void left
//   structure            on the side pane, whose reflection is flat, the cabin raises modulation
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/car-cabin.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 18;

/** The order the page renders in: [gain, level, through] per tile, rows top to bottom. */
export function plannedReadback(level, through) {
  const out = [];
  for (let r = 0; r < 3; r++) out.push([0, level, through], [1, level, through]);
  out.push([1, level, 0], [1, 0, through]);
  out.push([0, level, through], [1, level, through]);
  out.push([0, level, through], [1, level, through]);
  out.push([0, level, through], [1, level, through]);
  out.push([0, level, through], [1, level, through]);
  return out;
}

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE PAGE'S REPORT. Every read goes through `num`, because a
 * check's arguments are evaluated before the check runs and an absent field must FAIL the check, not
 * crash the gate (CLAUDE.md, "a check's DETAIL string is evaluated eagerly").
 */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const num = (v) => (Number.isFinite(v) ? v : null);
  const V = r.views ?? {};
  const names = ['front34', 'side', 'rear34'];

  add('the build ships the cabin ON', num(r.shipped?.value) === 1,
    `shipped gain ${r.shipped?.value}, level ${r.shipped?.level}, transmission ${r.shipped?.through}`);
  const want = plannedReadback(r.level, r.through);
  const got = r.readback ?? [];
  add('every render\'s uniforms are what it asked for, read back off the material\'s own uniform objects',
    got.length === want.length && want.every((w, i) => w.every((x, k) => got[i] && got[i][k] === x)),
    `${got.length} of ${want.length} tiles match`);
  const px = names.map((n) => num(V[n]?.glassPx) ?? 0);
  add('every view has its glazing in frame', px.every((p) => p >= 800), names.map((n, i) => `${n} ${px[i]}`).join(' '));

  const reach = names.map((n) => (num(V[n]?.glassChanged) ?? 0) / Math.max(1, num(V[n]?.glassPx) ?? 0));
  add('the cabin reaches the glazing: most of it changes when the cabin turns on, in every view',
    reach.every((f) => f >= 0.5), names.map((n, i) => `${n} ${(100 * reach[i]).toFixed(1)}%`).join(' '));
  const leak = names.map((n) => num(V[n]?.otherChanged2));
  add('and nothing else: no pixel outside the glazing moves by more than 2 levels',
    leak.every((v) => v === 0),
    names.map((n, i) => `${n} ${leak[i]} (${V[n]?.otherChanged ?? '?'} at 1 level, max ${V[n]?.otherMax ?? '?'})`).join(', '));

  const S = r.split ?? {};
  const intFrac = (num(S.interiorChanged) ?? 0) / Math.max(1, num(S.glassPx) ?? 0);
  add('the interior alone changes the windscreen', intFrac >= 0.5,
    `${S.interiorChanged} of ${S.glassPx} glass px (${(100 * intFrac).toFixed(1)}%)`);
  const thrFrac = (num(S.throughPx) ?? 0) / Math.max(1, num(S.glassPx) ?? 0);
  add('and the far window alone is brighter than the interior on a real share of it — you can see THROUGH the car',
    thrFrac >= 0.2, `${S.throughPx} of ${S.glassPx} glass px (${(100 * thrFrac).toFixed(1)}%)`);

  const I = r.invariance ?? {};
  add('the CONTROL: moving the car, the camera and the sun together moves no glass pixel with the cabin off',
    num(I.off?.glassPx) >= 800 && I.off?.movedOver2 === 0,
    `${I.off?.movedOver2} of ${I.off?.glassPx} glass px over 2 levels, max ${I.off?.max}`);
  add('and with it ON, so the cabin is computed in the CAR\'S frame — the fleet is never at the origin',
    num(I.on?.glassPx) >= 800 && I.on?.movedOver2 === 0,
    `${I.on?.movedOver2} of ${I.on?.glassPx} glass px over 2 levels, max ${I.on?.max}`);

  const P = r.player ?? {};
  add('the player\'s body material never gets a cabin (its slot-10 texels are mirror glass)',
    num(P.glassPx) >= 800 && P.glassChanged === 0 && P.otherChanged === 0,
    `${P.glassChanged} glass and ${P.otherChanged} other px changed of ${P.glassPx} / ${P.otherPx}`);
  add('and the player check is not vacuous: the same pixels DO change on the traffic material',
    (num(V.front34?.glassChanged) ?? 0) > 0, `front34 traffic material: ${V.front34?.glassChanged} glass px changed`);

  const PC = r.playerCar ?? {};
  const pcReach = (num(PC.glassChanged) ?? 0) / Math.max(1, num(PC.glassPx) ?? 0);
  /**
   * THE PLAYER'S OWN CAR, whose panes are a separate mesh on `carGlassMaterial`. The cabin went into
   * the fleet's material first and not this one, and the cabin's blind review found the player's
   * car the one "black void" in the frame (side glass sRGB 12,16,23). The recurring shape: a fix
   * applied to one member of a family and not its sibling.
   */
  add('the player\'s OWN car gets the cabin too: most of its glazing changes',
    num(PC.glassPx) >= 800 && pcReach >= 0.5,
    `${PC.glassChanged} of ${PC.glassPx} glass px (${(100 * pcReach).toFixed(1)}%)`);
  /**
   * 8 LEVELS, NOT 2, for this row only, and measured: the player's glass is a separate mesh over its
   * body, and two antialiased pixels 2.2 px from a pane move 3 levels where the fleet's single mesh
   * moves at most 1. A cabin leaking onto the body would move thousands of pixels by far more.
   */
  add('and nothing else on it moves by more than 8 levels',
    num(PC.otherPx) > 0 && (num(PC.otherMax) ?? 99) <= 8,
    `${PC.otherChanged2} px over 2 levels, max ${PC.otherMax}`);
  const VS = PC.versusCoupe ?? {};
  const corr = num(VS.corr), amp = num(VS.amp), offRatio = num(VS.offRatio);
  /**
   * AND IT IS THE COUPE'S CABIN, NOT JUST A CHANGE. The player's greenhouse is the coupe's to 4 mm and
   * its cabin is read through PLAYER_CABIN_Y into the fleet's frame, so on the pixels that are glass
   * in both cars the change the cabin makes must be the same picture. "Most of the glazing changes"
   * cannot see a wrong lift — measured with PLAYER_CABIN_Y at 0, 2,319 of 2,983 player glass pixels
   * still change, 77.7%, and the seats are 0.717 m from where they belong. The correlation reads
   * 0.980 shipped against 0.273 with that lift (0.920 at dusk; the gate runs at noon).
   */
  add('the player\'s cabin is the coupe\'s: on the pane they share, the change it makes is the same picture',
    num(VS.sharedPx) >= 1000 && corr !== null && corr >= 0.9,
    `correlation ${corr?.toFixed(4)} over ${VS.sharedPx} shared glass px`);
  /** Shipped 0.975; with the lift at 0 the seats sit in the dark under the sill and it reads 0.313. */
  add('and as strong: the mean change on the player\'s pane is the coupe\'s, within a third',
    amp !== null && amp >= 0.75 && amp <= 1 / 0.75,
    `|change| ${VS.meanAbsPlayer?.toFixed(5)} against ${VS.meanAbsCoupe?.toFixed(5)}, x${amp?.toFixed(3)}`);
  /**
   * THE GLASS ITSELF, CABIN OFF. The player's glass shipped as a metal (metalness 0.88, the "1%
   * reflector" slot 10 records) for as long as the fleet's had been the dielectric it is; on the
   * same pixels the player's pane now reads 0.894 of the coupe's, and that old material reads 0.475.
   * Not 1.0: the two panes are two builders' meshes, and the bound is a third either way.
   */
  add('the player\'s glass is the fleet\'s glass: cabin off, its median is the coupe\'s within a third',
    offRatio !== null && offRatio >= 0.75 && offRatio <= 1 / 0.75,
    `${VS.offP50Player?.toFixed(5)} against ${VS.offP50Coupe?.toFixed(5)}, x${offRatio?.toFixed(3)}`);

  const side = V.side ?? {};
  const mL = num(side.left?.modulation), mR = num(side.right?.modulation);
  /**
   * STRUCTURE, ON THE ONE PANE WHERE THE REFLECTION HAS NONE. A side pane faces the horizon, and
   * this page's sky has no azimuthal structure, so with the cabin off its modulation is ~1.06 — flat,
   * which is exactly the district's complaint about every pane. The windscreen views cannot carry
   * this check here: their reflection already spans the sky gradient (modulation 1.5-2.1), so the
   * cabin's structure is mixed with the reflection's and need not raise the statistic.
   */
  add('on the side pane, whose reflection is flat, the cabin adds structure: modulation rises by a third',
    mL !== null && mR !== null && mR >= 1.33 * mL, `side modulation ${mL?.toFixed(3)} -> ${mR?.toFixed(3)}`);
  add('and the cabin is back to the shipped state after the page is done with it',
    num(r.gainAfter) === num(r.shipped?.value), `gain after ${r.gainAfter}`);
  return checks;
}

// ------------------------------------------------------------------------------------- selftest
if (argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('CAR-CABIN SELFTEST');
  /** A REAL REPORT, copied from a passing run of the page at noon (statistics rounded). */
  const mod = (m) => ({ p50: 0.03, p95: 0.03 * m, modulation: m });
  const view = (g, gc, oc, l, rr) => ({ glassPx: g, glassChanged: gc, otherPx: 135000, otherChanged: oc,
    otherChanged2: 0, otherMax: oc ? 1 : 0, left: mod(l), right: mod(rr), paintP50: 0.13 });
  const good = {
    shipped: { value: 1, level: 1, through: 0.15 }, level: 1, through: 0.15,
    readback: plannedReadback(1, 0.15),
    views: { front34: view(3283, 3128, 0, 1.513, 1.553), side: view(1447, 1299, 13, 1.056, 1.792),
      rear34: view(3817, 3739, 0, 2.052, 1.936) },
    split: { glassPx: 3283, throughPx: 2196, interiorChanged: 2995 },
    invariance: { off: { glassPx: 3283, movedOver2: 0, max: 1 }, on: { glassPx: 3283, movedOver2: 0, max: 1 } },
    player: { glassPx: 3283, glassChanged: 0, otherPx: 135236, otherChanged: 0 },
    playerCar: { glassPx: 2983, glassChanged: 2855, otherPx: 138441, otherChanged: 1, otherChanged2: 1, otherMax: 3,
      versusCoupe: { sharedPx: 2627, corr: 0.9803, amp: 0.9745, meanAbsPlayer: 0.00756, meanAbsCoupe: 0.00776,
        offRatio: 0.8937, offP50Player: 0.03328, offP50Coupe: 0.03724 } },
    gainAfter: 1,
  };
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));

  say(failing(good).length === 0, 'a real passing report passes every check', `${verdict(good).length} checks`);
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT, 'including on an EMPTY report, which fails rather than throws',
    `${verdict({}).length} checks, ${failing({}).length} failed`);

  for (const [what, fn, needle] of [
    // The mask inverted: the cabin lands on every slot EXCEPT the glazing.
    ['the cabin on everything but the glass', (c) => { for (const v of Object.values(c.views)) { v.glassChanged = 0; v.otherChanged2 = 9000; v.otherMax = 120; } }, 'nothing else'],
    ['the cabin shipped off', (c) => { c.shipped.value = 0; c.gainAfter = 0; }, 'ships the cabin ON'],
    ['a uniform that never reaches the material', (c) => { c.readback[1] = [0, 1, 0.15]; }, 'uniforms are what it asked for'],
    ['no far window', (c) => { c.split.throughPx = 0; }, 'see THROUGH'],
    ['no interior', (c) => { c.split.interiorChanged = 0; }, 'interior alone'],
    // The eye left in world space: the parked pool and the fleet stand anywhere but the origin.
    ['a cabin computed in world space', (c) => { c.invariance.on.movedOver2 = 2100; c.invariance.on.max = 60; }, 'CAR\'S frame'],
    ['a scene the transform itself moves', (c) => { c.invariance.off.movedOver2 = 40; }, 'CONTROL'],
    ['a cabin on the player\'s mirrors', (c) => { c.player.glassChanged = 200; }, 'player\'s body material'],
    ['a cabin that adds no structure', (c) => { c.views.side.right = mod(1.06); }, 'adds structure'],
    ['the page leaving the gain changed', (c) => { c.gainAfter = 0; }, 'back to the shipped state'],
    ['a view with no glass in it', (c) => { c.views.rear34.glassPx = 40; c.views.rear34.glassChanged = 40; }, 'in frame'],
    // The sibling left out: the player's glass on its own material, never given the cabin.
    ['the player\'s own glass left out of the cabin', (c) => { c.playerCar.glassChanged = 0; }, 'OWN car'],
    ['a cabin leaking onto the player\'s body', (c) => { c.playerCar.otherChanged2 = 5000; c.playerCar.otherMax = 90; }, 'nothing else on it'],
    // Measured, not invented: PLAYER_CABIN_Y at 0 read these, and still changed 77.7% of the glazing.
    ['the player\'s cabin read in the wrong frame', (c) => {
      c.playerCar.glassChanged = 2319; Object.assign(c.playerCar.versusCoupe, { corr: 0.2730, amp: 0.3131 });
    }, 'same picture'],
    ['the player\'s cabin as a faint ghost of the coupe\'s', (c) => { c.playerCar.versusCoupe.amp = 0.3131; }, 'as strong'],
    // And the old metal glass, measured: 0.475 of the fleet's pane with the cabin off.
    ['the player\'s glass back to the old metal', (c) => { c.playerCar.versusCoupe.offRatio = 0.4745; }, 'fleet\'s glass'],
    ['no pane shared with the coupe at all', (c) => { Object.assign(c.playerCar.versusCoupe, { sharedPx: 0, corr: null }); }, 'same picture'],
  ]) {
    const r = bad(fn);
    say(fails(r, needle), `KNOWN-BAD: ${what} fails`, failing(r).join(' | '));
  }
  // And the player check cannot pass vacuously: a material the cabin never reached at all passes
  // "the player is excluded" — which is why the traffic material must be seen to change.
  const inert = bad((c) => { for (const v of Object.values(c.views)) v.glassChanged = 0; });
  say(fails(inert, 'not vacuous') && !fails(inert, 'player\'s body material'),
    'KNOWN-BAD: an inert cabin passes the player check and fails the one that says it is not vacuous',
    failing(inert).join(' | '));

  console.log(`\nCAR-CABIN SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

// ----------------------------------------------------------------------------------- the gate
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.env.CAR_CABIN_PORT ?? treePort(ROOT));
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1000, height: 2440 } });
const logs = [];
page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
await page.goto(`http://127.0.0.1:${PORT}/tools/car-cabin.html`);
let report = null, err = null;
try {
  await page.waitForFunction('window.__carCabin', null, { timeout: 90000 });
  report = await page.evaluate(() => window.__carCabin);
} catch (e) { err = e.message; }
await browser.close();

if (!report || report.error) {
  console.error(`the page did not publish a report: ${report ? report.error : err}`);
  if (logs.length) console.error('console:\n' + logs.join('\n'));
  process.exit(1);
}
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));

console.log(`CAR-CABIN — one ${report.shape} at tone ${report.tone}, ${report.tod}, three views from street ` +
  `height, cabin level ${report.level} and transmission ${report.through}`);
console.log('\n  view       glass px  changed   other px moved (>2 lv)   glass modulation off -> on');
for (const [k, v] of Object.entries(report.views)) {
  console.log(`  ${k.padEnd(9)} ${String(v.glassPx).padStart(8)}  ${String(v.glassChanged).padStart(7)}` +
    `   ${String(v.otherChanged).padStart(8)} (${v.otherChanged2})              ` +
    `${v.left.modulation.toFixed(3)} -> ${v.right.modulation.toFixed(3)}`);
}
console.log('');
const checks = verdict(report);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
console.log(`\nCAR-CABIN: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
  (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
