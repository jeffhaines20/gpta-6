// THE GATE FOR THE ROOM BEHIND THE FACADE GLASS (BACKLOG #36: src/materials.js applyGlassRoom,
// src/facades.js glassRoomGeometry). See tools/glass-room.html.
//
//   node tools/glass-room.mjs              render one wall per recipe through the real material
//   node tools/glass-room.mjs --selftest   prove the verdict on known-bad reports, no browser
//
// WHY A PAGE. The room is a ray cast inside the facade material's fragment shader and the mirror
// lever a line after three's lights_physical_fragment; nothing offline compiles a shader. The page
// draws the REAL memoised facadeMaterial into a float target, so every "unchanged" below is
// unchanged to the bit and every ratio is scene-linear.
//
// WHAT IT CANNOT SAY is whether the district's noon glass now reads like the photographs: this
// page's sky is not the district's. That was measured on the 12 reprojected station views
// (tools/glaz-probe.mjs GLZ_ARMS, tools/pane-tint.mjs --truth) and is recorded in docs/BACKLOG.md
// #36. What is asserted here holds at any sky:
//
//   the thing happened    the build ships #36 on at the levels the sweep chose, every facade
//                         material carries the patch, glass and wall both in every frame
//   off is the build before   the shipped material switched off renders a replica of the pre-#36
//                         material bit for bit, over the whole frame
//   and nothing else      with #36 on, no WALL texel moves at all; the mirror lever moves only glass
//   it reaches the glass  nearly every glass texel changes
//   lit by its window     with the sun and the sky off, the glass is black: the room has no light
//                         of its own, so it cannot glow at night over the lit-window emissive
//   registered to the facade   the room's light does not move when the wall AND the camera move
//                         up 7.3 m: it hangs off the texture's floor bands, not world height
//   a room, not a fill    inside each pane the room's own light varies (p90/p10), and it varies
//                         from pane to pane; and the recipes keep their tints through the glass
//   one program           every recipe shares one compiled program - which is WHY the per-recipe
//                         room is uniforms - and each material holds its own recipe's numbers
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';
import { RECIPES, glassRoomGeometry } from '../src/facades.js';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/glass-room.mjs [--selftest] [--json]`);
    process.exit(2);
  }
}

/**
 * THE SHIPPED LEVELS, restated here rather than read off the module, so a quiet retune of either
 * fails this gate instead of moving it. Where they come from is docs/BACKLOG.md #36's sweep.
 */
export const SHIPPED = { room: 1, mirror: 0.4, rough: 1, k: 0.15 };
export const RECIPES_DRAWN = ['retailStrip', 'midOffice', 'bayTower', 'warehouse'];
/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 16;

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE PAGE'S REPORT. Every read goes through `num`, because a
 * check's arguments are evaluated before the check runs and an absent field must FAIL the check, not
 * crash the gate (CLAUDE.md, "a check's DETAIL string is evaluated eagerly").
 */
export function verdict(r, recipeTable = RECIPES) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const num = (v) => (Number.isFinite(v) ? v : null);
  const R = r?.recipes ?? {};
  const names = RECIPES_DRAWN;
  const S = (n) => R[n]?.stats ?? {};
  const each = (fn) => names.map((n) => fn(n, S(n)));
  const list = (fn) => names.map((n) => `${n} ${fn(n, S(n))}`).join(', ');

  add('the page rendered every recipe, and each frame holds both glass and wall',
    !r?.error && names.every((n) => (num(R[n]?.glassPx) ?? 0) >= 1500 && (num(R[n]?.wallPx) ?? 0) >= 3000),
    r?.error ? `page error: ${String(r.error).split('\n')[0]}` : list((n) => `${R[n]?.glassPx ?? '?'} glass / ${R[n]?.wallPx ?? '?'} wall`));
  add('the build ships #36 ON, at the levels the sweep chose',
    num(r?.ship?.room) === SHIPPED.room && num(r?.ship?.mirror) === SHIPPED.mirror
      && num(r?.ship?.rough) === SHIPPED.rough && num(r?.ship?.k) === SHIPPED.k,
    `room ${r?.ship?.room}, mirror ${r?.ship?.mirror}, rough ${r?.ship?.rough}, k ${r?.ship?.k}  `
      + `(want ${SHIPPED.room} / ${SHIPPED.mirror} / ${SHIPPED.rough} / ${SHIPPED.k})`);
  add('every facade material drawn carries the patch, after applyGlazingEnv',
    names.every((n) => R[n]?.tags === 'glazeEnv|glassRoom'), list((n) => R[n]?.tags ?? 'none'));
  add('ONE compiled program serves every recipe - which is why the room\'s per-recipe numbers are uniforms',
    num(r?.programs?.glassRoom) === 1,
    `${r?.programs?.glassRoom} distinct program(s) drawing ${names.length} recipes; ${r?.programs?.keysMentioning ?? '?'} of ${r?.programs?.total} keys mention glassRoom (light-count variants)`);
  const want = (n) => {
    const g = glassRoomGeometry(recipeTable[n]);
    return [g.floorM, g.floor, g.ceiling, g.tileV, g.width, g.depth];
  };
  const held = (n) => (R[n]?.uniforms ? [...R[n].uniforms.geo, ...R[n].uniforms.dim] : null);
  const sameRoom = names.every((n) => held(n) && want(n).every((v, i) => Math.abs(held(n)[i] - v) < 1e-5));
  const distinct = new Set(names.map((n) => JSON.stringify(held(n)))).size;
  add('each material holds ITS OWN recipe\'s room, read back off its uniforms, and the recipes differ',
    sameRoom && distinct === names.length,
    `${distinct} distinct of ${names.length}; ` + list((n) => (held(n) ? held(n).map((v) => +v.toFixed(2)).join('/') : 'none')));
  // Offline, over EVERY recipe and not only the four drawn: the room's floor is under the sill and its
  // ceiling over the window head, inside the floor band. A room whose ceiling cut through the pane
  // would draw a slab across the middle of every window.
  const reg = Object.entries(recipeTable).filter(([, rec]) => rec.shape !== 'deck').map(([n, rec]) => {
    const g = glassRoomGeometry(rec);
    return { n, ok: g.floor <= g.sill - 0.5 && g.ceiling >= g.head + 0.05 && g.ceiling <= g.floorM, g };
  });
  add('every glazed recipe\'s room is registered to its window: floor under the sill, ceiling over the head, inside the band',
    reg.length >= 6 && reg.every((x) => x.ok),
    reg.map((x) => `${x.n} ${x.g.floor.toFixed(2)}<${x.g.sill.toFixed(2)}..${x.g.head.toFixed(2)}<${x.g.ceiling.toFixed(2)}`).join(' '));

  add('OFF IS THE BUILD BEFORE, BIT FOR BIT: the shipped material switched off renders the pre-#36 replica exactly, whole frame',
    each((n, s) => num(s.offVsPreMax) === 0 && num(s.nonFinite) === 0).every(Boolean),
    list((n, s) => `max |d| ${s.offVsPreMax}, ${s.offVsPreDiffer ?? '?'} values differ, ${s.nonFinite ?? '?'} non-finite`));
  add('and #36 ON moves no WALL texel at all - the room and the mirror stay on the glass',
    each((n, s) => num(s.shipWallMax) === 0).every(Boolean), list((n, s) => `max |d| ${s.shipWallMax}`));
  const reach = (n, s) => (num(s.glassChanged) ?? 0) / Math.max(1, num(R[n]?.glassPx) ?? 0);
  add('it reaches the glass: at least 90% of glass texels change',
    each((n, s) => reach(n, s) >= 0.9).every(Boolean), list((n, s) => `${(100 * reach(n, s)).toFixed(1)}%`));
  add('the mirror lever alone darkens the glass and moves no wall texel',
    each((n, s) => num(s.mirrorWallMax) === 0 && num(s.mirrorGlassDrop) !== null && s.mirrorGlassDrop < 0.95).every(Boolean),
    list((n, s) => `glass x${num(s.mirrorGlassDrop)?.toFixed(3) ?? '?'}, wall max |d| ${s.mirrorWallMax}`));
  add('a room LIT BY ITS WINDOW: sun and sky off, every glass texel is black - nothing to glow at night',
    each((n, s) => s.darkGlassFinite === true && num(s.darkGlassMax) === 0).every(Boolean),
    list((n, s) => `max ${s.darkGlassMax}`));
  add('and lit, the room gives light: its own contribution is positive on every recipe',
    each((n, s) => (num(s.roomLumMean) ?? 0) > 0).every(Boolean), list((n, s) => `${num(s.roomLumMean)?.toExponential(2) ?? '?'}`));
  add('REGISTERED TO THE FACADE, NOT THE WORLD: the room\'s light is unchanged with the wall and camera 7.3 m up',
    each((n, s) => num(s.upRoomMaxRel) !== null && s.upRoomMaxRel < 1e-2).every(Boolean),
    list((n, s) => `max rel ${num(s.upRoomMaxRel)?.toExponential(2) ?? '?'}`));
  add('A ROOM, NOT A FILL: inside each pane the room\'s light spans p90/p10 >= 1.5 (median over panes)',
    each((n, s) => (num(s.roomModMedian) ?? 0) >= 1.5 && (num(s.panes) ?? 0) >= 3).every(Boolean),
    list((n, s) => `${num(s.roomModMedian)?.toFixed(2) ?? '?'} over ${s.panes ?? '?'} panes`));
  add('and rooms differ from pane to pane (cv of their means >= 0.1)',
    each((n, s) => (num(s.roomPaneCV) ?? 0) >= 0.1).every(Boolean), list((n, s) => `${num(s.roomPaneCV)?.toFixed(3) ?? '?'}`));
  const br = (n) => num(S(n).roomBR);
  add('the recipes keep their tints THROUGH the glass: bayTower\'s room reads at least 1.3x bluer than midOffice\'s',
    br('bayTower') !== null && br('midOffice') !== null && br('bayTower') > 1.3 * br('midOffice'),
    `room B/R bayTower ${br('bayTower')?.toFixed(3) ?? '?'}, midOffice ${br('midOffice')?.toFixed(3) ?? '?'}`);
  return checks;
}

// ------------------------------------------------------------------ selftest
function goodReport() {
  const recipes = {};
  for (const n of RECIPES_DRAWN) {
    const g = glassRoomGeometry(RECIPES[n]);
    recipes[n] = {
      glassPx: 9000, wallPx: 30000, tags: 'glazeEnv|glassRoom',
      uniforms: { geo: [g.floorM, g.floor, g.ceiling, g.tileV], dim: [g.width, g.depth] },
      stats: {
        offVsPreMax: 0, offVsPreDiffer: 0, nonFinite: 0, shipWallMax: 0, glassChanged: 8950,
        mirrorWallMax: 0, mirrorGlassDrop: 0.62, darkGlassFinite: true, darkGlassMax: 0, roomLumMean: 0.004,
        upRoomMaxRel: 4e-5, roomModMedian: 2.4, panes: 12, roomPaneCV: 0.3,
        roomBR: n === 'bayTower' ? 1.4 : n === 'midOffice' ? 0.7 : 0.95,
      },
    };
  }
  return { ship: { ...SHIPPED }, recipes, programs: { glassRoom: 1, total: 9 } };
}
function selftest() {
  const fails = [];
  const ck = (name, ok, got) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}   ${got}`); if (!ok) fails.push(name); };
  const good = verdict(goodReport());
  ck('a good report passes every check', good.every((c) => c.ok), good.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'all ok');
  ck(`and the verdict has exactly CHECK_COUNT (${CHECK_COUNT}) checks, whatever the report`, good.length === CHECK_COUNT, good.length);
  const bad = (label, mutate, wantFail) => {
    const r = goodReport();
    mutate(r);
    const v = verdict(r);
    const failed = v.filter((c) => !c.ok).map((c) => c.name);
    const hit = failed.some((n) => n.startsWith(wantFail));
    ck(`KNOWN-BAD ${label} fails "${wantFail.slice(0, 48)}..."`, hit && v.length === CHECK_COUNT,
      failed.length ? failed.map((n) => n.slice(0, 40)).join(' | ') : 'nothing failed');
  };
  bad('the fix shipped off', (r) => { r.ship.room = 0; }, 'the build ships #36 ON');
  bad('a quietly retuned mirror', (r) => { r.ship.mirror = 0.6; }, 'the build ships #36 ON');
  bad('the patch missing from one material', (r) => { r.recipes.bayTower.tags = 'glazeEnv'; }, 'every facade material drawn');
  bad('one program per recipe (constants baked into the source)', (r) => { r.programs.glassRoom = 4; }, 'ONE compiled program');
  bad('every recipe given retailStrip\'s room', (r) => { for (const n of RECIPES_DRAWN) r.recipes[n].uniforms = JSON.parse(JSON.stringify(r.recipes.retailStrip.uniforms)); }, 'each material holds ITS OWN');
  bad('off differing from the build before by one value', (r) => { r.recipes.midOffice.stats.offVsPreMax = 1e-7; r.recipes.midOffice.stats.offVsPreDiffer = 1; }, 'OFF IS THE BUILD BEFORE');
  bad('a NaN in an off frame', (r) => { r.recipes.warehouse.stats.nonFinite = 3; }, 'OFF IS THE BUILD BEFORE');
  bad('the room leaking onto the wall', (r) => { r.recipes.retailStrip.stats.shipWallMax = 0.002; }, 'and #36 ON moves no WALL');
  bad('the room reaching a third of the glass', (r) => { r.recipes.bayTower.stats.glassChanged = 3000; }, 'it reaches the glass');
  bad('a mirror lever that does nothing', (r) => { r.recipes.midOffice.stats.mirrorGlassDrop = 1.0; }, 'the mirror lever alone');
  bad('a room that glows with the lights off', (r) => { r.recipes.midOffice.stats.darkGlassMax = 0.003; }, 'a room LIT BY ITS WINDOW');
  bad('a room with no light at all', (r) => { r.recipes.warehouse.stats.roomLumMean = 0; }, 'and lit, the room gives light');
  bad('a room hung off world height', (r) => { r.recipes.bayTower.stats.upRoomMaxRel = 0.4; }, 'REGISTERED TO THE FACADE');
  bad('a flat fill behind every pane', (r) => { r.recipes.midOffice.stats.roomModMedian = 1.02; }, 'A ROOM, NOT A FILL');
  bad('every room the same', (r) => { r.recipes.retailStrip.stats.roomPaneCV = 0.01; }, 'and rooms differ');
  bad('every recipe\'s glass transmitting grey', (r) => { r.recipes.bayTower.stats.roomBR = 0.95; r.recipes.midOffice.stats.roomBR = 0.95; }, 'the recipes keep their tints');
  bad('a page that threw', (r) => { r.error = 'boom'; }, 'the page rendered every recipe');
  bad('an empty report', (r) => { for (const k of Object.keys(r)) delete r[k]; }, 'the page rendered every recipe');
  // The registration check reads the RECIPES table, so its known-bad is a table with a window head
  // above the room's ceiling: a recipe whose window runs right up to the top of its band.
  {
    const tab = JSON.parse(JSON.stringify(RECIPES));
    tab.midOffice.win = { ...tab.midOffice.win, top: 0.0 };
    const v = verdict(goodReport(), tab);
    const f = v.filter((c) => !c.ok).map((c) => c.name);
    ck('KNOWN-BAD a window head at the very top of its band fails "every glazed recipe..."',
      f.some((n) => n.startsWith('every glazed recipe')), f.join(' | ') || 'nothing failed');
  }
  console.log(fails.length ? `\nGLASS-ROOM SELFTEST: FAIL - ${fails.length}` : '\nGLASS-ROOM SELFTEST: PASS');
  return fails.length === 0;
}

// ---------------------------------------------------------------------- CLI
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
if (IS_MAIN && argv.includes('--selftest')) {
  process.exit(selftest() ? 0 : 1);
}
if (IS_MAIN && !argv.includes('--selftest')) {
  const PORT = Number(process.env.GR_PORT ?? treePort());
  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/tools/glass-room.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__report', null, { timeout: Number(process.env.GR_TIMEOUT ?? 600000), polling: 250 });
  const report = await page.evaluate(() => window.__report);
  await browser.close();
  if (errors.length && !report.error) report.error = errors.join('\n');
  const checks = verdict(report);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
  console.log(`GLASS ROOM (#36) - ${RECIPES_DRAWN.join(', ')} through the real facade material, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n          ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nGLASS-ROOM: ${failed.length ? 'FAIL' : 'PASS'} - ${checks.length} checks, ${failed.length} failed`);
  process.exit(failed.length || checks.length !== CHECK_COUNT ? 1 : 0);
}
