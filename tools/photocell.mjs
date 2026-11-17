// #142: THE STREET LAMPS ARE ON A PHOTOCELL — the gate.
//
//   node tools/photocell.mjs              offline, in well under a second: the REAL TimeOfDay through
//                                         every preset, with a real StreetFurniture and LightPool attached
//   node tools/photocell.mjs --selftest   the verdict against the measured report and eleven known-bads
//
// src/daynight.js reads the horizontal illuminance of the sun and the sky an hour delivers — what a
// photocontrol on a luminaire reads, blind to the lamps — and holds the street lamps (their globes, the
// LightPool, any registered lamp) on only under ANSI C136.10's 1.5 fc turn-on. The cars keep `lampsOn`,
// inside UN R48's automatic band. This gate asserts the quantity, the decision at every hour, that every
// street-lamp switch follows it, that the cars' switch is inside R48's band, that the two switches part at
// dusk (the reason they are two), and that the audit flags a street lamp lit where its cell holds it off.
//
// THE SKY HERE IS THE HEMISPHERE'S. Offline there is no dome, so skyDelivery() is the HemisphereLight path
// (dusk 354.9 lux, the photocell 382.4); on the page the dome's PMREM carries the sky (about 1,400 lux at
// dusk). Same function, a different input, the same verdicts — boot-check asserts the page's side, so the
// two protocols are two gates.
import { fileURLToPath } from 'node:url';

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/** Fixed, so a check cannot vanish when a population is empty (CLAUDE.md, car-pixel). */
export const CHECK_COUNT = 11;
const HOURS = ['noon', 'golden', 'dusk', 'night'];

/** Rec. 709 luminance of a three Color, restated here so the gate does not read the module's lum3. */
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * Drive the real modules through every preset and record what each switch did. `opts.tod` lets a
 * selftest hand in a doctored TimeOfDay; everything else is built here the way the page builds it.
 */
export async function measure(opts = {}) {
  const THREE = await import('../vendor/three.module.min.js');
  const DN = await import('../src/daynight.js');
  const { StreetFurniture } = await import('../src/streetfurniture.js');
  const { LightPool } = await import('../src/lightpool.js');
  const { makeTod } = await import('./shadow-stable.mjs');
  const tod = opts.tod ?? makeTod();
  tod.post.stats = tod.post.stats ?? { passes: 0 };   // audit() reads it; the stub post has none
  // In the TimeOfDay's OWN scene: audit() traverses that scene for lights, and a pool built anywhere
  // else is a pool the audit cannot see (the first version of this gate did exactly that).
  const scene = tod.scene;
  const fur = new StreetFurniture(scene, { max: 4 });
  const head = fur.addLamp(0, 0, 0);
  const pool = new LightPool(scene);
  pool.addEmitter(head.x, head.y, head.z, 900, 0xffc98a, 46);
  tod.setFurniture(fur, pool);
  const out = { onLux: DN.PHOTOCELL_ON_LUX, footcandle: DN.FOOTCANDLE_LUX, r48: [DN.R48_ON_LUX, DN.R48_OFF_LUX], hours: {} };
  for (const h of HOURS) {
    tod.apply(h);
    const cell = tod.photocellLux();
    // The quantity, recomputed HERE off the lights rather than through daylightLux, so a module that
    // dropped a term cannot agree with itself.
    const sunDelivered = tod.sun.intensity * luma(tod.sun.color);
    const recomputed = sunDelivered * Math.sin(Math.max(tod.preset.elevation, 0)) + tod.skyDelivery().totalLux;
    const g = fur.globeReport();
    const active = pool.lights.filter((l) => l.visible && l.intensity > 0).length;
    const flags = tod.audit().implausible.filter((f) => /photocell/.test(f));
    out.hours[h] = { lux: cell.lux, sun: cell.sun, sky: cell.sky, recomputed, lit: cell.lit, r48: cell.r48,
      streetLampsOn: tod.streetLampsOn, lampsOn: !!tod.preset.lampsOn, globeLit: g.lit, globeNits: g.luminance,
      globeLevelNits: g.level * g.physical, poolActive: active, poolEmitters: pool.emitters.length, flags };
  }
  // The audit, provoked: a street lamp's light on at dusk, and the globes lit at dusk, each alone.
  tod.apply('dusk');
  pool.lights[0].visible = true; pool.lights[0].intensity = 900;
  out.injectedLight = tod.audit().implausible.filter((f) => /photocell/.test(f));
  pool.lights[0].intensity = 0; pool.lights[0].visible = false;
  fur.setLit(true);
  out.injectedGlobe = tod.audit().implausible.filter((f) => /photocell/.test(f));
  tod.apply('dusk');
  out.cleanAfter = tod.audit().implausible.filter((f) => /photocell/.test(f));
  return out;
}

/** The checks, over a report. Pure, so the selftest can hand it doctored reports. */
export function verdict(R) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const H = R.hours;
  const fc = 1 / (0.3048 * 0.3048);
  check('the turn-on is ANSI C136.10\'s 1.5 fc, in lux: 1.5 / 0.3048^2 = 16.146',
    Math.abs(R.footcandle - fc) < 1e-9 && Math.abs(R.onLux - 1.5 * fc) < 1e-9, `${R.onLux} lux, fc ${R.footcandle}`);
  const offBy = HOURS.map((h) => [h, Math.abs(H[h].lux - H[h].recomputed) / Math.max(1, H[h].recomputed)]);
  check('at every hour the cell reads the sun on the horizontal plus the sky as delivered, recomputed off the lights',
    offBy.every(([, e]) => e < 1e-9) && HOURS.every((h) => H[h].sky > 0 && H[h].sun >= 0),
    offBy.map(([h, e]) => `${h} ${H[h].lux.toFixed(3)} vs ${H[h].recomputed.toFixed(3)} (${e.toExponential(1)})`).join('; '));
  const want = { noon: false, golden: false, dusk: false, night: true };
  check('noon, golden and DUSK hold the street lamps off and night lights them, each by lux < turn-on',
    HOURS.every((h) => H[h].streetLampsOn === want[h] && H[h].lit === want[h] && H[h].lit === (H[h].lux < R.onLux)),
    HOURS.map((h) => `${h} ${H[h].lux.toFixed(3)} lux ${H[h].streetLampsOn ? 'ON' : 'off'}`).join(', '));
  const margins = HOURS.map((h) => [h, Math.max(H[h].lux / R.onLux, R.onLux / H[h].lux)]);
  check('and no hour decides by a hair: every one sits at least x10 from the turn-on',
    margins.every(([, m]) => m >= 10), margins.map(([h, m]) => `${h} x${m.toFixed(1)}`).join(', '));
  // Against the CELL's reading (`lit`, which check 3 ties to lux < turn-on), not against streetLampsOn: a
  // module that set its own flag wrong and switched the globes by it would agree with itself.
  check('the globes follow the cell: dark where it is off, at the module\'s declared level where it is on',
    HOURS.every((h) => H[h].globeLit === H[h].lit &&
      (H[h].lit ? Math.abs(H[h].globeNits / H[h].globeLevelNits - 1) < 1e-9 && H[h].globeNits > 0 : H[h].globeNits === 0)),
    HOURS.map((h) => `${h} ${H[h].globeLit ? 'lit' : 'dark'} ${H[h].globeNits.toFixed(2)} nits`).join(', '));
  check('the LightPool follows it: no light on where the cell is off, its emitter lit where it is on',
    HOURS.every((h) => H[h].poolEmitters > 0 && (H[h].lit ? H[h].poolActive > 0 : H[h].poolActive === 0)),
    HOURS.map((h) => `${h} ${H[h].poolActive}/${H[h].poolEmitters}`).join(', '));
  const r48ok = (h) => (H[h].r48 === 'on' ? H[h].lampsOn : H[h].r48 === 'off' ? !H[h].lampsOn : true);
  check('the cars\' lamps keep lampsOn, and it is inside UN R48\'s automatic band (on under 1,000 lux, off over 7,000) at every hour',
    HOURS.every(r48ok) && R.r48[0] === 1000 && R.r48[1] === 7000,
    HOURS.map((h) => `${h} ${H[h].r48}/${H[h].lampsOn ? 'on' : 'off'}`).join(', '));
  // KNOWN-BAD, LIVE: the switch this replaced. `lampsOn` lights the street lamps at dusk; it agrees with
  // the cell at every other hour, so the split is exactly the dusk preset and nothing else.
  const parted = HOURS.filter((h) => H[h].lampsOn !== H[h].streetLampsOn);
  check('KNOWN-BAD, live: the old switch (lampsOn) and the photocell part at dusk and at no other hour',
    parted.length === 1 && parted[0] === 'dusk' && H.dusk.lampsOn && !H.dusk.streetLampsOn, `they differ at: ${parted.join(', ') || 'none'}`);
  check('the audit flags a street lamp\'s light lit at an hour its cell holds off',
    R.injectedLight.length === 1 && /street lamps are lit/.test(R.injectedLight[0]), JSON.stringify(R.injectedLight));
  check('and flags the globes lit at such an hour, each provocation alone',
    R.injectedGlobe.length === 1 && /globes are lit/.test(R.injectedGlobe[0]), JSON.stringify(R.injectedGlobe));
  check('and the shipped light raises neither flag at any hour, nor after the provocations are undone',
    HOURS.every((h) => H[h].flags.length === 0) && R.cleanAfter.length === 0,
    HOURS.map((h) => `${h} ${H[h].flags.length}`).join(', ') + `, after ${R.cleanAfter.length}`);
  return checks;
}

function print(checks) {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
}

if (IS_MAIN && process.argv.includes('--selftest')) {
  const R = await measure();
  const good = verdict(R);
  const says = [];
  const say = (ok, name, detail = '') => { says.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };
  say(good.length === CHECK_COUNT && good.every((c) => c.ok), `the measured report passes all ${CHECK_COUNT} checks`,
    good.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  const doctor = (fn) => { const r = structuredClone(R); fn(r); return verdict(r); };
  const fails = (v, needle) => v.some((c) => !c.ok && c.name.includes(needle));
  const KB = [
    ['the dusk lamps lit by the old rule', (r) => { r.hours.dusk.streetLampsOn = true; r.hours.dusk.lit = true; }, 'DUSK hold'],
    ['a cell that reads the sun alone (the sky dropped)', (r) => { for (const h of HOURS) r.hours[h].lux = r.hours[h].sun; }, 'sky as delivered'],
    ['a turn-on typed as 1.5 lux rather than 1.5 fc', (r) => { r.onLux = 1.5; }, '1.5 fc'],
    ['a turn-on in footcandles of the wrong foot (0.3 m)', (r) => { r.footcandle = 1 / 0.09; r.onLux = 1.5 / 0.09; }, '1.5 fc'],
    ['globes lit at dusk while the cell holds them off', (r) => { r.hours.dusk.globeLit = true; r.hours.dusk.globeNits = 131.56; }, 'globes follow'],
    ['the pool lit at dusk while the cell holds it off', (r) => { r.hours.dusk.poolActive = 10; }, 'LightPool follows'],
    ['the cars dark at night, under R48\'s 1,000 lux', (r) => { r.hours.night.lampsOn = false; }, 'R48'],
    ['an hour two times off the turn-on', (r) => { r.hours.dusk.lux = 2 * r.onLux; r.hours.dusk.recomputed = r.hours.dusk.lux; }, 'by a hair'],
    ['the cars\' lamps switched off at dusk with the street lamps', (r) => { r.hours.dusk.lampsOn = false; }, 'part at dusk'],
    ['an audit deaf to a lit street lamp', (r) => { r.injectedLight = []; }, 'street lamp\'s light'],
    ['an audit that flags the shipped dusk', (r) => { r.hours.dusk.flags = ['street lamps are lit while their photocell reads ...']; }, 'neither flag'],
  ];
  for (const [what, fn, needle] of KB) {
    const v = doctor(fn);
    say(fails(v, needle), `KNOWN-BAD: ${what}`, v.filter((c) => !c.ok).map((c) => c.name.slice(0, 60)).join(' | '));
  }
  // And the real module, doctored: a TimeOfDay whose apply() lights the street lamps by lampsOn again.
  const { makeTod } = await import('./shadow-stable.mjs');
  const old = makeTod();
  const apply = old.apply.bind(old);
  old.apply = (n) => {
    const p = apply(n);
    old.streetLampsOn = !!p.lampsOn;
    if (old.furniture) old.furniture.setLit(old.streetLampsOn);
    if (old.lightPool) old.lightPool.update({ x: 0, y: 0, z: 0 }, old.streetLampsOn ? 1 : 0);
    return p;
  };
  const vOld = verdict(await measure({ tod: old }));
  say(fails(vOld, 'DUSK hold') && fails(vOld, 'globes follow') && fails(vOld, 'LightPool follows'),
    'KNOWN-BAD, the real module: a TimeOfDay that lights the street lamps by lampsOn fails the hour, the globes and the pool',
    vOld.filter((c) => !c.ok).map((c) => c.name.slice(0, 50)).join(' | '));
  const failed = says.filter((x) => !x).length;
  const WANT = 1 + KB.length + 1;
  console.log(`\nPHOTOCELL SELFTEST: ${failed || says.length !== WANT ? 'FAIL' : 'PASS'} — ${says.length} checks` +
    `${says.length === WANT ? '' : ` (expected ${WANT})`}, ${failed} failed`);
  process.exit(failed || says.length !== WANT ? 1 : 0);
}

if (IS_MAIN && !process.argv.includes('--selftest')) {
  const t0 = performance.now();
  const R = await measure();
  console.log('PHOTOCELL — the street lamps against ANSI C136.10\'s turn-on, the cars against UN R48, every preset');
  console.log(`  turn-on ${R.onLux.toFixed(3)} lux (1.5 fc); R48 band ${R.r48.join('-')} lux; the sky through the HemisphereLight (no dome offline)`);
  for (const h of HOURS) {
    const x = R.hours[h];
    console.log(`  ${h.padEnd(7)} ${x.lux.toFixed(3).padStart(11)} lux (sun ${x.sun.toFixed(3)}, sky ${x.sky.toFixed(3)})  x${(x.lux / R.onLux).toFixed(3)} the turn-on` +
      `  street lamps ${x.streetLampsOn ? 'ON ' : 'off'} (globe ${x.globeNits.toFixed(2)} nits, pool ${x.poolActive})  cars ${x.lampsOn ? 'on' : 'off'} (R48 ${x.r48})`);
  }
  const checks = verdict(R);
  print(checks);
  const failed = checks.filter((c) => !c.ok).length;
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nPHOTOCELL: ${failed || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
    `${counted ? '' : ` (expected ${CHECK_COUNT})`}, ${failed} failed, ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  process.exit(failed || !counted ? 1 : 0);
}
