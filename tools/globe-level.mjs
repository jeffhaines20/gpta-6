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
 *
 * #140, the same bound over a ROUND globe (the module's ray-cast sphere, 15% bigger on screen than the
 * facets it replaced, at the same 131.5 nits): the shipped 1/22.6 reads 2.80 at 58 m, 1/20 2.93, 1/18 3.06,
 * 1/16 3.27, 1/10 3.77 and the physical globe 5.65 (the shipped and physical off the gate's own run, the
 * rest off a --sweep table printed to 0.1 px). The bound is unchanged; the level it passes is the
 * luminance #136 chose, restated over the sphere's area (src/streetfurniture.js, LAMP_GLOBE_LEVEL).
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
 *
 * Re-recorded at #140, off the run that passed with the globe a ray-cast sphere at 1/22.6: the same
 * x57.75 and x0.774, because the levels moved and the luminances did not; the glass x3.19, ordered at
 * 1/7.1 of the SPHERE's physical luminance (1/9.4 was of the facets'); the halo at 58 m 2.80, where the
 * facets read 2.70. The buffer now says `kind: 'sphere'`, two triangles a globe, pi r^2.
 */
const FIXTURE = {
  module: {"candela":900,"color":16763274,"reach":46,"level":0.04424778761061947,"shipped":{"meanArea":0.19634954084936207,"physical":2973.3423189402124,"luminance":131.5638194221333,"drawnLevel":0.04424778761061947,"level":0.04424778761061947}},
  buffer: {"meanArea":0.19634954084936207},
  emitter: {"x":1.3471114790620887e-16,"y":7.7,"z":0,"candela":900,"color":16763274,"distance":46},
  globeWorld: [4.884981414229807e-16,7.699999809265137,4.7683715642676816e-08],
  Lphys: 2973.3423189402124,
  oldLevel: 0.0005926564722891884,
  minLevel: 0.03422438087662592,
  glassLevel: 0.1412783258503935,
  ordered: ["facade","frond","pilaster","innerGlobe","road","fixture"],
  runs: [
    {"cam":"near15","hour":"night","level":0.0005926564722891884,"Lemit":1.76217,"globeScreen":{"rpx":13.8672},"surfaces":{"facade":{"px":716831,"ratioMax":57.7474,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":5.87872,"emitMean":0},"pilaster":{"px":16863,"ratioMax":15.7522,"emitMean":0},"road":{"px":135736,"ratioMax":0.114078,"emitMean":0},"fixture":{"px":6238,"ratioMax":0.498776,"emitMean":0},"globe":{"px":518,"ratioMax":0,"emitMean":1.76059},"innerGlobe":{"px":316,"ratioMax":7.88089,"emitMean":1.76207}},"glare":[0,9.77,24.02],"glareOverGlobe":[0,0.705,1.732],"displayedGlobe":{"peak":0.815496}},
    {"cam":"street29","hour":"night","level":0.0005926564722891884,"Lemit":1.76217,"globeScreen":{"rpx":7.52562},"surfaces":{"facade":{"px":447013,"ratioMax":44.3889,"emitMean":0},"glass":{"px":109886,"ratioMax":0.664584,"emitMean":0},"frond":{"px":258,"ratioMax":5.85787,"emitMean":0},"pilaster":{"px":4499,"ratioMax":15.6732,"emitMean":0},"road":{"px":375308,"ratioMax":0.117635,"emitMean":0},"fixture":{"px":1385,"ratioMax":0.289641,"emitMean":0},"globe":{"px":135,"ratioMax":0,"emitMean":1.76208},"innerGlobe":{"px":94,"ratioMax":6.60964,"emitMean":1.76198}},"glare":[0,0,16.47],"glareOverGlobe":[0,0,2.188],"displayedGlobe":{"peak":0.823905}},
    {"cam":"far58","hour":"night","level":0.0005926564722891884,"Lemit":1.76217,"globeScreen":{"rpx":3.82438},"surfaces":{"facade":{"px":448283,"ratioMax":5.49011,"emitMean":0},"glass":{"px":4483,"ratioMax":238.381,"emitMean":0},"frond":{"px":52,"ratioMax":5.84864,"emitMean":0},"pilaster":{"px":1089,"ratioMax":15.2255,"emitMean":0},"road":{"px":525730,"ratioMax":0.119712,"emitMean":0},"fixture":{"px":184,"ratioMax":0.205021,"emitMean":0},"globe":{"px":26,"ratioMax":0,"emitMean":1.76208},"innerGlobe":{"px":16,"ratioMax":4.09125,"emitMean":1.76186}},"glare":[0,0,9.51],"glareOverGlobe":[0,0,2.486],"displayedGlobe":{"peak":0.797927}},
    {"cam":"near15","hour":"night","level":0.04424778761061947,"Lemit":131.564,"globeScreen":{"rpx":13.8672},"surfaces":{"facade":{"px":716831,"ratioMax":0.773471,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":0.0787398,"emitMean":0},"pilaster":{"px":16863,"ratioMax":0.210985,"emitMean":0},"road":{"px":135736,"ratioMax":0.00152796,"emitMean":0},"fixture":{"px":6238,"ratioMax":0.00668063,"emitMean":0},"globe":{"px":518,"ratioMax":0,"emitMean":131.428},"innerGlobe":{"px":316,"ratioMax":0.105795,"emitMean":131.557}},"glare":[24.46,31.23,35.31],"glareOverGlobe":[1.764,2.252,2.546],"displayedGlobe":{"peak":1}},
    {"cam":"street29","hour":"night","level":0.04424778761061947,"Lemit":131.564,"globeScreen":{"rpx":7.52562},"surfaces":{"facade":{"px":447013,"ratioMax":0.594546,"emitMean":0},"glass":{"px":109886,"ratioMax":0.00890146,"emitMean":0},"frond":{"px":258,"ratioMax":0.0784606,"emitMean":0},"pilaster":{"px":4499,"ratioMax":0.209927,"emitMean":0},"road":{"px":375308,"ratioMax":0.0015756,"emitMean":0},"fixture":{"px":1385,"ratioMax":0.00387947,"emitMean":0},"globe":{"px":135,"ratioMax":0,"emitMean":131.539},"innerGlobe":{"px":94,"ratioMax":0.0886878,"emitMean":131.553}},"glare":[17.22,24.38,28.75],"glareOverGlobe":[2.289,3.24,3.82],"displayedGlobe":{"peak":0.999358}},
    {"cam":"far58","hour":"night","level":0.04424778761061947,"Lemit":131.564,"globeScreen":{"rpx":3.82438},"surfaces":{"facade":{"px":448283,"ratioMax":0.0735347,"emitMean":0},"glass":{"px":4483,"ratioMax":3.19289,"emitMean":0},"frond":{"px":52,"ratioMax":0.0783369,"emitMean":0},"pilaster":{"px":1089,"ratioMax":0.203931,"emitMean":0},"road":{"px":525730,"ratioMax":0.00160343,"emitMean":0},"fixture":{"px":184,"ratioMax":0.00274606,"emitMean":0},"globe":{"px":26,"ratioMax":0,"emitMean":131.539},"innerGlobe":{"px":16,"ratioMax":0.0552859,"emitMean":131.551}},"glare":[10.7,19.41,24.41],"glareOverGlobe":[2.799,5.076,6.383],"displayedGlobe":{"peak":0.999358}},
    {"cam":"near15","hour":"night","level":0.1412783258503935,"Lemit":420.069,"globeScreen":{"rpx":13.8672},"surfaces":{"facade":{"px":716831,"ratioMax":0.242248,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":0.024661,"emitMean":0},"pilaster":{"px":16863,"ratioMax":0.0660798,"emitMean":0},"road":{"px":135736,"ratioMax":0.00047855,"emitMean":0},"fixture":{"px":6238,"ratioMax":0.00209235,"emitMean":0},"globe":{"px":518,"ratioMax":0,"emitMean":419.708},"innerGlobe":{"px":316,"ratioMax":0.0330389,"emitMean":420.062}},"glare":[28.34,33.53,36.72],"glareOverGlobe":[2.044,2.418,2.648],"displayedGlobe":{"peak":1}},
    {"cam":"street29","hour":"night","level":0.1412783258503935,"Lemit":420.069,"globeScreen":{"rpx":7.52562},"surfaces":{"facade":{"px":447013,"ratioMax":0.186209,"emitMean":0},"glass":{"px":109886,"ratioMax":0.0027879,"emitMean":0},"frond":{"px":258,"ratioMax":0.0245735,"emitMean":0},"pilaster":{"px":4499,"ratioMax":0.0657482,"emitMean":0},"road":{"px":375308,"ratioMax":0.000493473,"emitMean":0},"fixture":{"px":1385,"ratioMax":0.00121503,"emitMean":0},"globe":{"px":135,"ratioMax":0,"emitMean":420.063},"innerGlobe":{"px":94,"ratioMax":0.0277335,"emitMean":420.07}},"glare":[21.23,26.82,30],"glareOverGlobe":[2.821,3.564,3.987],"displayedGlobe":{"peak":1}},
    {"cam":"far58","hour":"night","level":0.1412783258503935,"Lemit":420.069,"globeScreen":{"rpx":3.82438},"surfaces":{"facade":{"px":448283,"ratioMax":0.0230308,"emitMean":0},"glass":{"px":4483,"ratioMax":1,"emitMean":0},"frond":{"px":52,"ratioMax":0.0245348,"emitMean":0},"pilaster":{"px":1089,"ratioMax":0.0638704,"emitMean":0},"road":{"px":525730,"ratioMax":0.000502189,"emitMean":0},"fixture":{"px":184,"ratioMax":0.000860054,"emitMean":0},"globe":{"px":26,"ratioMax":0,"emitMean":420.063},"innerGlobe":{"px":16,"ratioMax":0.0168696,"emitMean":420.059}},"glare":[15.84,22.45,25.81],"glareOverGlobe":[4.141,5.871,6.748],"displayedGlobe":{"peak":1}},
    {"cam":"near15","hour":"night","level":1,"Lemit":2973.34,"globeScreen":{"rpx":13.8672},"surfaces":{"facade":{"px":716831,"ratioMax":0.0342244,"emitMean":0},"glass":{"px":0,"ratioMax":0,"emitMean":null},"frond":{"px":983,"ratioMax":0.00348406,"emitMean":0},"pilaster":{"px":16863,"ratioMax":0.00933564,"emitMean":0},"road":{"px":135736,"ratioMax":6.76088e-05,"emitMean":0},"fixture":{"px":6238,"ratioMax":0.000295603,"emitMean":0},"globe":{"px":518,"ratioMax":0,"emitMean":2971.04},"innerGlobe":{"px":316,"ratioMax":0.00455662,"emitMean":2973.47}},"glare":[32.92,36.41,38.68],"glareOverGlobe":[2.374,2.625,2.789],"displayedGlobe":{"peak":1}},
    {"cam":"street29","hour":"night","level":1,"Lemit":2973.34,"globeScreen":{"rpx":7.52562},"surfaces":{"facade":{"px":447013,"ratioMax":0.0263073,"emitMean":0},"glass":{"px":109886,"ratioMax":0.00039387,"emitMean":0},"frond":{"px":258,"ratioMax":0.00347171,"emitMean":0},"pilaster":{"px":4499,"ratioMax":0.00928879,"emitMean":0},"road":{"px":375308,"ratioMax":6.9717e-05,"emitMean":0},"fixture":{"px":1385,"ratioMax":0.000171658,"emitMean":0},"globe":{"px":135,"ratioMax":0,"emitMean":2973.55},"innerGlobe":{"px":94,"ratioMax":0.00376526,"emitMean":2973.34}},"glare":[26.1,29.73,32.09],"glareOverGlobe":[3.468,3.95,4.265],"displayedGlobe":{"peak":1}},
    {"cam":"far58","hour":"night","level":1,"Lemit":2973.34,"globeScreen":{"rpx":3.82438},"surfaces":{"facade":{"px":448283,"ratioMax":0.00325375,"emitMean":0},"glass":{"px":4483,"ratioMax":0.141278,"emitMean":0},"frond":{"px":52,"ratioMax":0.00346624,"emitMean":0},"pilaster":{"px":1089,"ratioMax":0.00902351,"emitMean":0},"road":{"px":525730,"ratioMax":7.09484e-05,"emitMean":0},"fixture":{"px":184,"ratioMax":0.000121507,"emitMean":0},"globe":{"px":26,"ratioMax":0,"emitMean":2973.55},"innerGlobe":{"px":16,"ratioMax":0.00234981,"emitMean":2973.65}},"glare":[21.59,25.56,27.68],"glareOverGlobe":[5.645,6.683,7.238],"displayedGlobe":{"peak":1}},
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
  // An area typed in place of the buffer's. Before #140 the typed one was the sphere's pi r^2 against the
  // facets' 0.1480 off the buffer; since #140 the buffer IS the sphere, so the typed one is the facets'.
  const sphere = bad((c) => { c.module.shipped.meanArea = 0.1480; });
  say(fails(sphere, 'derives the globe'), 'KNOWN-BAD: the facets\' area typed in place of the sphere the buffer carries fails the derivation', failing(sphere).join(' | '));
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
