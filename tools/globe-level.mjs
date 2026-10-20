// THE GATE FOR BACKLOG #136: a street lamp's globe must not be outshone by what its own light lights.
// See tools/globe-level.html for the scene and the method, and src/streetfurniture.js LAMP_CANDELA for
// the derivation of the globe's luminance.
//
//   node tools/globe-level.mjs                 render the lamp through the real PostStack and check it
//   node tools/globe-level.mjs --selftest      prove the verdict on known-bad reports, no browser
//   node tools/globe-level.mjs --sweep L1,L2   print the table at other levels (fractions of physical);
//                                              a measurement, not the gate
//
// WHAT IS ASSERTED, in order, because each check means something only if the ones above it hold:
//   the thing happened   the page's lamp is the module's lamp and its light the module's light; the
//                        module's luminance is the one the page derives off the buffer itself; every
//                        surface is in frame and the lamp's light reached it
//   the instrument       the globe's pixels read back the material's own luminance
//   the defect is live   at the OLD globe (emissiveIntensity 2.4) the facade's lobe, the pilaster and
//                        the lamp's own pavement-side globe each outshine it: measured every run
//   the fix              at the shipped level none of them does, at every camera
//   what it costs        the bloom's blown core, at the shipped level, stays inside a bound in globe
//                        radii at every camera, where the physical globe's does not
//   the cue              at night the shipped globe reaches the display's white and the old one did not
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { launchOptions } from './browser.mjs';
import { ensureServer, treePort } from './serve.mjs';

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const argv = IS_MAIN ? process.argv.slice(2) : [];
const KNOWN = new Set(['--selftest', '--json', '--sweep']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/globe-level.mjs [--selftest] [--json] [--sweep L1,L2,...]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 12;

/**
 * THE HALO BOUND, in the globe's own projected radii: the disc the globe's glare alone takes to white
 * (>= 1 exposed — black to display 0.80) may be at most this wide. The shipped level's worst camera reads
 * 2.70 (58 m); the next level the sweep tried above it, 1/25, reads 3.2 there, 1/20 3.5, 1/10 4.4 and the
 * physical globe 6.5 (9.4 at 100 m, src/streetfurniture.js LAMP_GLOBE_LEVEL has the table). So the bound
 * passes the shipped level and fails the first level above it, and raising the level is what moves it.
 */
export const HALO_BOUND = 3.0;
/** The shipped level sits at least at the measured minimum and under this many times it. */
export const LEVEL_MARGIN_MAX = 1.5;

/**
 * THE VERDICT, AS A PURE FUNCTION OF THE PAGE'S REPORT. Every read goes through an accessor that
 * returns null for an absent statistic, because a check's arguments are evaluated before the check runs
 * and a missing arm must FAIL the check rather than crash the gate (CLAUDE.md, "a check's DETAIL string
 * is evaluated eagerly").
 */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const f = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? 'absent' : Number(v).toFixed(d));
  const M = r.module ?? {}, B = r.buffer ?? {}, E = r.emitter ?? {}, SH = M.shipped ?? {};
  const runs = Array.isArray(r.runs) ? r.runs : [];
  const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol * Math.max(1e-12, Math.abs(b));
  const lvl = (want) => runs.filter((x) => x.hour === 'night' && fin(x.level) !== null && fin(want) !== null &&
    Math.abs(x.level - want) <= 1e-9 * Math.max(1, want));
  const oldLevel = fin(r.oldLevel), shipLevel = fin(M.level), minLevel = fin(r.minLevel), glassLevel = fin(r.glassLevel);
  const OLD = lvl(oldLevel), SHIP = lvl(shipLevel), PHYS = lvl(1), GLASS = lvl(glassLevel);
  const ORDERED = Array.isArray(r.ordered) ? r.ordered : [];
  const ratio = (run, k) => (run.surfaces && run.surfaces[k] && run.surfaces[k].px > 0 ? fin(run.surfaces[k].ratioMax) : null);
  const maxOver = (arm, k) => {
    const v = arm.map((x) => ratio(x, k)).filter((x) => x !== null);
    return v.length ? Math.max(...v) : null;
  };
  const worstOrdered = (arm) => {
    const v = arm.flatMap((x) => ORDERED.map((k) => ratio(x, k))).filter((x) => x !== null);
    return v.length ? Math.max(...v) : null;
  };
  const haloOf = (arm) => {
    const v = arm.map((x) => fin(x.glareOverGlobe?.[0])).filter((x) => x !== null);
    return v.length === arm.length && v.length ? Math.max(...v) : null;
  };

  // --- the thing happened
  const gw = Array.isArray(r.globeWorld) ? r.globeWorld : null;
  const off = gw ? Math.hypot(E.x - gw[0], E.y - gw[1], E.z - gw[2]) : null;
  add('the page\'s lamp is the module\'s: its emitter carries LAMP_CANDELA, the colour and the reach, at the drawn outer globe\'s centre',
    E.candela === M.candela && E.color === M.color && E.distance === M.reach && Number.isFinite(M.candela) &&
      off !== null && off < 1e-4,
    `emitter ${E.candela} cd ${E.color} ${E.distance} m against ${M.candela} ${M.color} ${M.reach}; ${f(off, 6)} m from the buffer's globe`);
  add('the module derives the globe from its light and its buffer: S/4, the physical luminance and the level, as the page reads them',
    near(fin(SH.meanArea), fin(B.meanArea), 1e-9) && near(fin(SH.physical), fin(r.Lphys), 1e-9) &&
      shipLevel !== null && near(fin(SH.luminance), shipLevel * fin(r.Lphys), 1e-6) && near(fin(SH.drawnLevel), shipLevel, 1e-6),
    `S/4 ${f(SH.meanArea, 6)} module, ${f(B.meanArea, 6)} buffer; physical ${f(SH.physical, 2)} / ${f(r.Lphys, 2)} nits; ` +
      `luminance ${f(SH.luminance, 3)} at level 1/${f(shipLevel ? 1 / shipLevel : null, 2)}`);
  const want = { near15: ['facade', 'frond', 'pilaster', 'innerGlobe', 'road', 'globe'], far58: ['glass'] };
  const short = [];
  for (const [cam, ks] of Object.entries(want)) {
    const run = SHIP.find((x) => x.cam === cam);
    for (const k of ks) {
      const px = run && run.surfaces && run.surfaces[k] ? run.surfaces[k].px : 0;
      if (!(px >= (k === 'globe' || k === 'innerGlobe' || k === 'frond' ? 100 : 400))) short.push(`${cam}/${k} ${px}`);
    }
  }
  add('every surface is in frame where it is measured, with pixels enough to read it',
    SHIP.length > 0 && short.length === 0, short.length ? `short: ${short.join(', ')}` : `${SHIP.length} cameras`);
  const unlit = ['facade', 'glass', 'frond', 'pilaster', 'innerGlobe', 'road'].filter((k) => !(maxOver(OLD, k) > 0));
  add('the lamp\'s light reached every lit surface, so a ratio under 1 is not a surface in the dark',
    OLD.length > 0 && unlit.length === 0, unlit.length ? `unlit: ${unlit.join(', ')}` : `${OLD.length} cameras`);

  // --- the instrument
  const allRuns = runs.filter((x) => x.surfaces && x.surfaces.globe && x.surfaces.globe.px > 0);
  const badRead = allRuns.filter((x) => !near(fin(x.surfaces.globe.emitMean), fin(x.Lemit), 0.01));
  add('the globe\'s pixels read back the material\'s own luminance, to 1%, in every arm',
    allRuns.length >= 4 && badRead.length === 0,
    `${allRuns.length - badRead.length} of ${allRuns.length}` +
      (badRead.length ? `; ${badRead.slice(0, 3).map((x) => `${x.cam} 1/${(1 / x.level).toFixed(0)} read ${f(x.surfaces.globe.emitMean)} of ${f(x.Lemit)}`).join('; ')}` : ''));

  // --- the defect is live
  const oldR = Object.fromEntries(['facade', 'pilaster', 'frond', 'innerGlobe'].map((k) => [k, maxOver(OLD, k)]));
  add('KNOWN-BAD, LIVE: at the old globe the facade\'s lobe, the pilaster, a frond and the lamp\'s own inner globe each outshine it',
    Object.values(oldR).every((v) => v !== null && v > 1),
    Object.entries(oldR).map(([k, v]) => `${k} x${f(v, 2)}`).join('  '));

  // --- the fix
  const shipW = worstOrdered(SHIP);
  add('THE FIX: at the shipped level nothing a level can order outshines its globe, at any camera',
    SHIP.length > 0 && shipW !== null && shipW <= 1,
    `worst x${f(shipW, 3)} over ${ORDERED.join(', ')}; ` + ORDERED.map((k) => `${k} x${f(maxOver(SHIP, k), 2)}`).join(' '));
  const margin = minLevel !== null && shipLevel !== null ? shipLevel / minLevel : null;
  add(`and the shipped level is the measured minimum that does it, with under x${LEVEL_MARGIN_MAX} to spare`,
    margin !== null && margin >= 1 && margin <= LEVEL_MARGIN_MAX,
    `minimum 1/${f(minLevel ? 1 / minLevel : null, 1)} (the old level times its worst ratio), shipped 1/${f(shipLevel ? 1 / shipLevel : null, 1)}, x${f(margin, 3)}`);

  // --- what it costs, and the refusal
  const haloShip = haloOf(SHIP), haloPhys = haloOf(PHYS), haloGlass = haloOf(GLASS);
  add(`THE PRICE: at the shipped level no globe's white glare is wider than x${HALO_BOUND} its own radius, at any camera`,
    SHIP.length > 0 && haloShip !== null && haloShip <= HALO_BOUND,
    `worst x${f(haloShip, 2)}; ` + SHIP.map((x) => `${x.cam} ${f(x.glare?.[0], 1)} px / ${f(x.globeScreen?.rpx, 1)}`).join('  '));
  add('KNOWN-BAD, LIVE: the physical globe\'s glare passes that bound — the large blown halo the level refuses',
    PHYS.length > 0 && haloPhys !== null && haloPhys > HALO_BOUND,
    `worst x${f(haloPhys, 2)}; ` + PHYS.map((x) => `${x.cam} ${f(x.glare?.[0], 1)} px / ${f(x.globeScreen?.rpx, 1)}`).join('  '));
  const glassShip = maxOver(SHIP, 'glass');
  add('the glazing\'s mirror is the one surface still over the globe, and the level that would order it costs a halo the bound refuses',
    glassShip !== null && glassShip > 1 && glassLevel !== null && glassLevel > shipLevel && GLASS.length > 0 &&
      haloGlass !== null && haloGlass > HALO_BOUND,
    `glass x${f(glassShip, 2)} at the shipped level; ordered at 1/${f(glassLevel ? 1 / glassLevel : null, 1)}, where the glare is x${f(haloGlass, 2)}`);

  // --- the cue
  // One run a camera: a level shipped at the old or the physical value is rendered twice by the page, and
  // the cue is a statement about each camera, not about how many arms happened to share a level.
  const shown = (arm) => ['near15', 'street29'].map((c) => arm.find((x) => x.cam === c))
    .filter(Boolean).map((x) => fin(x.displayedGlobe?.peak));
  const shownShip = shown(SHIP), shownOld = shown(OLD);
  add('at night the shipped globe reaches the display\'s white and the old one did not',
    shownShip.length === 2 && shownShip.every((v) => v !== null && v >= 0.98) &&
      shownOld.length === 2 && shownOld.every((v) => v !== null && v < 0.9),
    `shipped ${shownShip.map((v) => f(v)).join('/')}, old ${shownOld.map((v) => f(v)).join('/')} display-linear`);
  return checks;
}

/** The table a run prints: one line per (camera, hour, level). */
export function table(r) {
  const out = [];
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '   -');
  const S = ['facade', 'glass', 'frond', 'pilaster', 'innerGlobe', 'road', 'fixture'];
  out.push(`  cam       hour   level       globe nits   worst   ${S.map((s) => s.padStart(10)).join('')}   glare r 1/0.1/0.01 (globe r)   shown`);
  for (const x of r.runs ?? []) {
    const s = x.surfaces ?? {};
    const fp = (x.glare ?? []).map((v) => (Number.isFinite(v) ? v.toFixed(1) : '-')).join('/');
    out.push(`  ${x.cam.padEnd(9)} ${x.hour.padEnd(6)} ${('1/' + (1 / x.level).toFixed(0)).padEnd(10)} ${f(x.Lemit, 2).padStart(10)}` +
      `   x${f(x.worstRatio)}  ${S.map((k) => (s[k] && s[k].px ? ('x' + f(s[k].ratioMax)) : '-').padStart(10)).join('')}` +
      `   ${fp.padStart(14)} (${f(x.globeScreen?.rpx, 1)})   ${f(x.displayedGlobe?.peak, 3)}`);
  }
  return out.join('\n');
}

/**
 * A REAL REPORT, from a passing run of the page (six significant figures), so "correct" in the selftest
 * is the shape and the magnitude the page produces rather than an invented one that can drift from it.
 * What it records: the old globe outshone by the facade's lobe x57.75, the shipped one by nothing a
 * level can order (worst x0.774), the glass x3.19 over it and ordered only at 1/9.4.
 */
const FIXTURE = {
  module: {"candela":900,"color":16763274,"reach":46,"level":0.03333333333333333,"shipped":{"meanArea":0.1479981115754986,"physical":3944.7422193226134,"luminance":131.49140731075377,"drawnLevel":0.03333333333333333,"level":0.03333333333333333}},
  buffer: {"meanArea":0.1479981115754986},
  emitter: {"x":0,"y":7.7,"z":0,"candela":900,"color":16763274,"distance":46},
  globeWorld: [0,7.699999809265137,0],
  Lphys: 3944.7422193226134,
  oldLevel: 0.0004467137449488041,
  minLevel: 0.025796565236010337,
  glassLevel: 0.10648828279383328,
  ordered: ["facade","frond","pilaster","innerGlobe","road","fixture"],
  runs: [
    {"cam":"near15","hour":"night","level":0.0004467137449488041,"Lemit":1.76217,"globeScreen":{"rpx":12.0393},"surfaces":{"facade":{"px":716948,"ratioMax":57.7474,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":5.87872,"emitMean":0},"pilaster":{"px":16946,"ratioMax":15.7522,"emitMean":0},"road":{"px":135736,"ratioMax":0.114078,"emitMean":0},"fixture":{"px":6259,"ratioMax":0.498776,"emitMean":0},"globe":{"px":389,"ratioMax":0,"emitMean":1.76208},"innerGlobe":{"px":230,"ratioMax":7.56631,"emitMean":1.76214}},"glare":[0,6.86,21.94],"glareOverGlobe":[0,0.57,1.822],"displayedGlobe":{"peak":0.822121}},
    {"cam":"street29","hour":"night","level":0.0004467137449488041,"Lemit":1.76217,"globeScreen":{"rpx":6.53364},"surfaces":{"facade":{"px":447036,"ratioMax":44.3889,"emitMean":0},"glass":{"px":109886,"ratioMax":0.664584,"emitMean":0},"frond":{"px":258,"ratioMax":5.85787,"emitMean":0},"pilaster":{"px":4514,"ratioMax":15.6732,"emitMean":0},"road":{"px":375308,"ratioMax":0.117635,"emitMean":0},"fixture":{"px":1391,"ratioMax":0.289641,"emitMean":0},"globe":{"px":98,"ratioMax":0,"emitMean":1.76208},"innerGlobe":{"px":68,"ratioMax":6.14536,"emitMean":1.7619}},"glare":[0,0,14.8],"glareOverGlobe":[0,0,2.265],"displayedGlobe":{"peak":0.829616}},
    {"cam":"far58","hour":"night","level":0.0004467137449488041,"Lemit":1.76217,"globeScreen":{"rpx":3.32027},"surfaces":{"facade":{"px":448285,"ratioMax":5.49011,"emitMean":0},"glass":{"px":4483,"ratioMax":238.381,"emitMean":0},"frond":{"px":52,"ratioMax":5.84864,"emitMean":0},"pilaster":{"px":1092,"ratioMax":15.2255,"emitMean":0},"road":{"px":525730,"ratioMax":0.119712,"emitMean":0},"fixture":{"px":184,"ratioMax":0.205021,"emitMean":0},"globe":{"px":18,"ratioMax":0,"emitMean":1.76208},"innerGlobe":{"px":13,"ratioMax":5.02698,"emitMean":1.76227}},"glare":[0,0,6.96],"glareOverGlobe":[0,0,2.095],"displayedGlobe":{"peak":0.799692}},
    {"cam":"near15","hour":"night","level":0.03333333333333333,"Lemit":131.491,"globeScreen":{"rpx":12.0393},"surfaces":{"facade":{"px":716948,"ratioMax":0.773897,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":0.0787832,"emitMean":0},"pilaster":{"px":16946,"ratioMax":0.211102,"emitMean":0},"road":{"px":135736,"ratioMax":0.0015288,"emitMean":0},"fixture":{"px":6259,"ratioMax":0.00668431,"emitMean":0},"globe":{"px":389,"ratioMax":0,"emitMean":131.492},"innerGlobe":{"px":230,"ratioMax":0.101771,"emitMean":131.492}},"glare":[22.71,29.47,33.61],"glareOverGlobe":[1.886,2.448,2.791],"displayedGlobe":{"peak":1}},
    {"cam":"street29","hour":"night","level":0.03333333333333333,"Lemit":131.491,"globeScreen":{"rpx":6.53364},"surfaces":{"facade":{"px":447036,"ratioMax":0.594873,"emitMean":0},"glass":{"px":109886,"ratioMax":0.00890636,"emitMean":0},"frond":{"px":258,"ratioMax":0.0785038,"emitMean":0},"pilaster":{"px":4514,"ratioMax":0.210042,"emitMean":0},"road":{"px":375308,"ratioMax":0.00157647,"emitMean":0},"fixture":{"px":1391,"ratioMax":0.0038816,"emitMean":0},"globe":{"px":98,"ratioMax":0,"emitMean":131.492},"innerGlobe":{"px":68,"ratioMax":0.0824175,"emitMean":131.487}},"glare":[16.27,23.01,27.52],"glareOverGlobe":[2.491,3.522,4.213],"displayedGlobe":{"peak":0.999358}},
    {"cam":"far58","hour":"night","level":0.03333333333333333,"Lemit":131.491,"globeScreen":{"rpx":3.32027},"surfaces":{"facade":{"px":448285,"ratioMax":0.0735752,"emitMean":0},"glass":{"px":4483,"ratioMax":3.19465,"emitMean":0},"frond":{"px":52,"ratioMax":0.0783801,"emitMean":0},"pilaster":{"px":1092,"ratioMax":0.204044,"emitMean":0},"road":{"px":525730,"ratioMax":0.00160432,"emitMean":0},"fixture":{"px":184,"ratioMax":0.00274757,"emitMean":0},"globe":{"px":18,"ratioMax":0,"emitMean":131.492},"innerGlobe":{"px":13,"ratioMax":0.0674689,"emitMean":131.494}},"glare":[8.96,18.75,23.8],"glareOverGlobe":[2.697,5.646,7.169],"displayedGlobe":{"peak":0.999358}},
    {"cam":"near15","hour":"night","level":0.10648828279383328,"Lemit":420.069,"globeScreen":{"rpx":12.0393},"surfaces":{"facade":{"px":716948,"ratioMax":0.242248,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":0.024661,"emitMean":0},"pilaster":{"px":16946,"ratioMax":0.0660798,"emitMean":0},"road":{"px":135736,"ratioMax":0.00047855,"emitMean":0},"fixture":{"px":6259,"ratioMax":0.00209235,"emitMean":0},"globe":{"px":389,"ratioMax":0,"emitMean":420.063},"innerGlobe":{"px":230,"ratioMax":0.0316386,"emitMean":420.068}},"glare":[26.61,31.84,35.09],"glareOverGlobe":[2.21,2.644,2.915],"displayedGlobe":{"peak":1}},
    {"cam":"street29","hour":"night","level":0.10648828279383328,"Lemit":420.069,"globeScreen":{"rpx":6.53364},"surfaces":{"facade":{"px":447036,"ratioMax":0.186209,"emitMean":0},"glass":{"px":109886,"ratioMax":0.0027879,"emitMean":0},"frond":{"px":258,"ratioMax":0.0245735,"emitMean":0},"pilaster":{"px":4514,"ratioMax":0.0657482,"emitMean":0},"road":{"px":375308,"ratioMax":0.000493473,"emitMean":0},"fixture":{"px":1391,"ratioMax":0.00121503,"emitMean":0},"globe":{"px":98,"ratioMax":0,"emitMean":420.063},"innerGlobe":{"px":68,"ratioMax":0.0259075,"emitMean":420.077}},"glare":[20.37,25.58,29.29],"glareOverGlobe":[3.118,3.915,4.484],"displayedGlobe":{"peak":1}},
    {"cam":"far58","hour":"night","level":0.10648828279383328,"Lemit":420.069,"globeScreen":{"rpx":3.32027},"surfaces":{"facade":{"px":448285,"ratioMax":0.0230308,"emitMean":0},"glass":{"px":4483,"ratioMax":1,"emitMean":0},"frond":{"px":52,"ratioMax":0.0245348,"emitMean":0},"pilaster":{"px":1092,"ratioMax":0.0638704,"emitMean":0},"road":{"px":525730,"ratioMax":0.000502189,"emitMean":0},"fixture":{"px":184,"ratioMax":0.000860054,"emitMean":0},"globe":{"px":18,"ratioMax":0,"emitMean":420.063},"innerGlobe":{"px":13,"ratioMax":0.0210277,"emitMean":420.059}},"glare":[14.76,21.68,25.58],"glareOverGlobe":[4.444,6.528,7.705],"displayedGlobe":{"peak":1}},
    {"cam":"near15","hour":"night","level":1,"Lemit":3944.74,"globeScreen":{"rpx":12.0393},"surfaces":{"facade":{"px":716948,"ratioMax":0.0257966,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":0.00262611,"emitMean":0},"pilaster":{"px":16946,"ratioMax":0.00703672,"emitMean":0},"road":{"px":135736,"ratioMax":0.00005096,"emitMean":0},"fixture":{"px":6259,"ratioMax":0.00022281,"emitMean":0},"globe":{"px":389,"ratioMax":0,"emitMean":3944.74},"innerGlobe":{"px":230,"ratioMax":0.00354234,"emitMean":3944.85}},"glare":[31.76,35.02,37.07],"glareOverGlobe":[2.638,2.908,3.079],"displayedGlobe":{"peak":1}},
    {"cam":"street29","hour":"night","level":1,"Lemit":3944.74,"globeScreen":{"rpx":6.53364},"surfaces":{"facade":{"px":447036,"ratioMax":0.0198291,"emitMean":0},"glass":{"px":109886,"ratioMax":0.000296879,"emitMean":0},"frond":{"px":258,"ratioMax":0.00261679,"emitMean":0},"pilaster":{"px":4514,"ratioMax":0.00700141,"emitMean":0},"road":{"px":375308,"ratioMax":0.0000525491,"emitMean":0},"fixture":{"px":1391,"ratioMax":0.000129387,"emitMean":0},"globe":{"px":98,"ratioMax":0,"emitMean":3944.74},"innerGlobe":{"px":68,"ratioMax":0.00294585,"emitMean":3945.01}},"glare":[25.48,29.19,31.31],"glareOverGlobe":[3.9,4.467,4.792],"displayedGlobe":{"peak":1}},
    {"cam":"far58","hour":"night","level":1,"Lemit":3944.74,"globeScreen":{"rpx":3.32027},"surfaces":{"facade":{"px":448285,"ratioMax":0.00245251,"emitMean":0},"glass":{"px":4483,"ratioMax":0.106488,"emitMean":0},"frond":{"px":52,"ratioMax":0.00261267,"emitMean":0},"pilaster":{"px":1092,"ratioMax":0.00680145,"emitMean":0},"road":{"px":525730,"ratioMax":0.0000534772,"emitMean":0},"fixture":{"px":184,"ratioMax":0.0000915857,"emitMean":0},"globe":{"px":18,"ratioMax":0,"emitMean":3944.74},"innerGlobe":{"px":13,"ratioMax":0.00236766,"emitMean":3945.05}},"glare":[21.56,25.51,27.66],"glareOverGlobe":[6.493,7.682,8.33],"displayedGlobe":{"peak":1}},
  ],
};

if (IS_MAIN && argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('GLOBE-LEVEL SELFTEST');
  const good = FIXTURE;
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const arm = (c, level) => c.runs.filter((x) => near(x.level, level));

  say(failing(good).length === 0, 'a real passing report passes every check', failing(good).join(' | ') || `${verdict(good).length} checks`);
  say(verdict(good).length === CHECK_COUNT, 'and the check COUNT is fixed', `${verdict(good).length} of ${CHECK_COUNT}`);
  say(verdict({}).length === CHECK_COUNT && failing({}).length === CHECK_COUNT,
    'an EMPTY report fails every check rather than throwing or shrinking', `${verdict({}).length} checks, ${failing({}).length} failed`);

  // A LEVEL SHIPPED, the way the page reports it when LAMP_GLOBE_LEVEL is that level: the module
  // declares it and draws it, and the page's shipped arms are rendered at it.
  const shipAt = (level) => bad((c) => {
    const from = c.runs.filter((x) => near(x.level, level)).map((x) => structuredClone(x));
    c.runs = c.runs.filter((x) => !near(x.level, c.module.level)).concat(from);
    c.module.level = level;
    Object.assign(c.module.shipped, { level, drawnLevel: level, luminance: level * c.Lphys });
  });
  // The defect shipped: the old globe.
  const oldShipped = shipAt(good.oldLevel);
  say(fails(oldShipped, 'THE FIX') && fails(oldShipped, 'measured minimum') && fails(oldShipped, 'reaches the display'),
    'KNOWN-BAD: the old globe shipped fails the fix, the minimum and the cue', failing(oldShipped).join(' | '));
  // The level raised to physical: the halo.
  const physShipped = shipAt(1);
  say(fails(physShipped, 'THE PRICE') && fails(physShipped, 'measured minimum'),
    'KNOWN-BAD: the physical globe shipped fails the halo bound and the minimum', failing(physShipped).join(' | '));
  // The glass level shipped: it orders the glass and pays the halo.
  const glassShipped = shipAt(good.glassLevel);
  say(fails(glassShipped, 'THE PRICE') && fails(glassShipped, 'measured minimum'),
    'KNOWN-BAD: the level that orders the glass, shipped, fails the halo bound and the minimum', failing(glassShipped).join(' | '));
  // The sphere's area typed in place of the buffer's.
  const sphere = bad((c) => { c.module.shipped.meanArea = Math.PI * 0.25 * 0.25; });
  say(fails(sphere, 'derives the globe'), 'KNOWN-BAD: the typed sphere area in place of the buffer\'s fails the derivation', failing(sphere).join(' | '));
  // A light that is not the module's.
  const typed = bad((c) => { c.emitter.candela = 1800; });
  say(fails(typed, 'the module\'s:'), 'KNOWN-BAD: an emitter at a typed candela fails the wiring', failing(typed).join(' | '));
  const moved = bad((c) => { c.globeWorld = [0, 7.7, 2.2]; });
  say(fails(moved, 'the module\'s:'), 'KNOWN-BAD: an emitter off the drawn globe fails the wiring', failing(moved).join(' | '));
  // An instrument that does not read the material.
  const halfRead = bad((c) => { for (const x of c.runs) if (x.surfaces.globe) x.surfaces.globe.emitMean *= 0.5; });
  say(fails(halfRead, 'read back'), 'KNOWN-BAD: a globe read at half its luminance fails the instrument', failing(halfRead).join(' | '));
  // A scene that does not show the defect.
  const tame = bad((c) => { for (const x of arm(c, c.oldLevel)) for (const k of ['facade', 'pilaster']) x.surfaces[k].ratioMax *= 0.01; });
  say(fails(tame, 'KNOWN-BAD, LIVE: at the old globe'), 'KNOWN-BAD: a page whose old arm shows no defect fails the live check', failing(tame).join(' | '));
  // An unlit surface reads as an ordered one.
  const dark = bad((c) => { for (const x of arm(c, c.oldLevel)) x.surfaces.frond.ratioMax = 0; });
  say(fails(dark, 'reached every lit surface'), 'KNOWN-BAD: a frond the light never reached fails the coverage check', failing(dark).join(' | '));
  // The halo refusal measured on nothing: a physical arm whose glare never whitens anything.
  const flat = bad((c) => { for (const x of arm(c, 1)) x.glareOverGlobe[0] = 0; });
  say(fails(flat, 'large blown halo'), 'KNOWN-BAD: a physical arm with no glare fails its own known-bad', failing(flat).join(' | '));
  // The glass ordered by something else: the refusal has to be restated, not silently pass.
  const glassFixed = bad((c) => { for (const x of arm(c, c.module.level)) x.surfaces.glass.ratioMax = Math.min(x.surfaces.glass.ratioMax, 0.9); });
  say(fails(glassFixed, 'glazing'), 'KNOWN-BAD: glass under the globe at the shipped level fails the refusal, so it is restated', failing(glassFixed).join(' | '));
  // A camera lost.
  const lost = bad((c) => { c.runs = c.runs.filter((x) => !(x.cam === 'far58' && near(x.level, c.module.level))); });
  say(fails(lost, 'in frame'), 'KNOWN-BAD: a missing camera fails the coverage check', failing(lost).join(' | '));

  console.log(`
GLOBE-LEVEL SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

if (IS_MAIN && !argv.includes('--selftest')) {
  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const PORT = Number(process.env.GLOBE_LEVEL_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const si = argv.indexOf('--sweep');
  const sweep = si >= 0 ? argv[si + 1] : null;
  const qs = sweep ? `?levels=${sweep}&hours=${process.env.GLOBE_LEVEL_HOURS ?? 'night,dusk'}` +
    `&cams=${process.env.GLOBE_LEVEL_CAMS ?? 'near15,street29,far58,far100'}` : '';
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const logs = [];
  page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
  // 'commit', not 'load': the page does all of its work in its module script, and a sweep of a dozen
  // levels at four cameras is minutes on this rasteriser, which 'load' would wait out and time out on.
  await page.goto(`http://127.0.0.1:${PORT}/tools/globe-level.html${qs}`, { waitUntil: 'commit', timeout: 120000 });
  let report = null, err = null;
  try {
    await page.waitForFunction('window.__globeLevel', null, { timeout: 1200000, polling: 1000 });
    report = await page.evaluate(() => window.__globeLevel);
  } catch (e) { err = e.message; }
  await browser.close();
  if (!report || report.error) {
    console.error(`the page did not publish a report: ${report ? report.error : err}`);
    if (logs.length) console.error('console:\n' + logs.join('\n'));
    process.exit(1);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
  console.log(`GLOBE-LEVEL — the module's lamp through the real PostStack: ${report.module.candela} cd, ` +
    `physical globe ${report.Lphys.toFixed(1)} nits (S/4 ${report.buffer.meanArea.toFixed(5)} m2 off the buffer), ` +
    `shipped level 1/${(1 / report.module.level).toFixed(1)}, old level 1/${(1 / report.oldLevel).toFixed(1)}`);
  console.log(table(report));
  if (sweep) process.exit(0);
  console.log('');
  const checks = verdict(report);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nGLOBE-LEVEL: ${failed.length || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
    (failed.length ? `, ${failed.length} failed` : '') + (counted ? '' : ` (expected ${CHECK_COUNT})`));
  process.exit(failed.length || !counted ? 1 : 0);
}
