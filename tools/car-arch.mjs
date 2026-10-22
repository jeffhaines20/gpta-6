// THE RING ROUND THE WHEEL ARCHES (#125's fourth item): the gate, and the measurement it came from.
//
//   node tools/car-arch.mjs              the gate: the buffers of every car pool, then the page
//   node tools/car-arch.mjs --selftest   the verdict on known-bad reports, and the instruments on known-bad
//                                        buffers; no browser
//   node tools/car-arch.mjs --measure [--arms a,b] [--cars traffic,parked,player] [--sides 1,-1] [--tod noon]
//                                     [--flat] [--frames <dir>] [--json <file>]
//                                        the measurement: every arm's radial profile round each arch
//
// #119's blind reviewer: "a warm dark ring round the wheel arches that reads as dirt or scorch rather than
// shadow: (91,86,74) against the flank's (142,143,142) on the white car". tools/car-arch.html draws one
// white car side-on at street height through the REAL noon light and reads a radial profile round each
// arch against the flank on the door in the same frame. src/carbody.js's ARCH block has what it found:
// two PAINTED surfaces facing the pavement, lit by the PMREM's warm lower hemisphere and taken to brown by
// the AO. The fix makes the well the car's own plastic, brings the flank down flush to the arch, and gives
// the flank's arch edge the cap's own normal.
//
// WHAT IT ASSERTS, on the BUFFERS of every pool, each built through its own module (src/traffic.js's three
// shells, src/streetfurniture.js's three parked shells, src/pursuit.js's car, buildPlayerCar):
//   the well is not paint     every body triangle inside the arch circle is on SURFACE.matte, in a colour
//                             the build's own trim slot carries (its unpainted plastic)
//   the flank's own normal    every vertex a flank-cap face uses within the arch's reach is shaded with the
//                             cap faces' own normal (the chamfer used to tilt it 33 degrees)
//   confined                  every vertex record outside the arch's reach is byte-identical to the arch
//                             before #125 (`arch: false`), so no other edge's shading can have moved
//   free                      the triangle count is the arch-before-#125's, and the shells stay equal-cost
// and on the PAGE, through the real noon light, against references in the same frame:
//   the lip is flank          the 8.5 cm the chamfer took reads inside the door's own luma spread and no
//                             warmer than its warmest tenth
//   the well is not dirt      the well above the tyre is no warmer than the door's warmest tenth
// Every one has a KNOWN-BAD: the arch before #125, built by the same builders, must fail it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrafficCarGeometry, buildPlayerCar, CAR, SHAPES, SHAPE_NAMES, SURFACE } from '../src/carbody.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * THE GATE RUNS ONLY AS THE MAIN MODULE, report and selftest both: `--selftest` is on process.argv,
 * which every module in the process shares (CLAUDE.md, "a tool's SELFTEST needs the same import guard").
 */
const IS_MAIN = !!process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split('/').pop());
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const KNOWN = new Set(['--selftest', '--measure', '--flat', '--json', '--frames', '--arms', '--cars', '--sides', '--tod', '--w', '--h']);
for (const a of IS_MAIN ? argv : []) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/car-arch.mjs [--selftest | --measure ...]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty (CLAUDE.md, car-pixel's worst-slot seed). */
export const CHECK_COUNT = 16;

// ------------------------------------------------------------------------------------------- buffers
const AXLES = [CAR.rearAxleZ, CAR.frontAxleZ];
/** Everything an arch lever can move lies within the notch and its 8.5 cm inset; a centimetre of margin. */
export const REACH = CAR.archR + CAR.edge + 0.01;
const WHEEL = new Set([SURFACE.tyre, SURFACE.rim, SURFACE.rimCoarse]);
const slotOf = (uv, i) => Math.floor(uv.getX(i) * 16);
const lumaLin = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Where an arch circle's centre is, in a geometry's own y: the fleet stands its shells on groundY, so a
 * vertex's y is CAR's plus (groundY - CAR.ground); the player's body is in CAR's frame (groundY = CAR.ground).
 */
const archDist = (z, y, lift) => Math.min(...AXLES.map((az) => Math.hypot(z - az, y - lift - CAR.archCy)));

/**
 * THE SHELL'S RING LAYOUT, READ OFF THE BUFFER: the centreline ring is the first run of vertices at x === 0,
 * and it is ring (K-1)/2 of K, so its start gives K. Read rather than imported, and checked: if the run is
 * not where a K-ring shell puts it, this throws rather than measuring some other surface.
 */
export function shellLayout(geo) {
  const pos = geo.getAttribute('position');
  let s = -1, e = -1;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getX(i) === 0) { if (s < 0) s = i; e = i; } else if (s >= 0) break;
  }
  const N = e - s + 1;
  if (s < 0 || N < 8 || s % N !== 0) throw new Error(`shellLayout: no centreline ring (run ${s}..${e})`);
  const K = 2 * (s / N) + 1;
  if (!(K === 7 || K === 19)) throw new Error(`shellLayout: ${K} rings is not a shell this file knows`);
  return { N, K };
}

/** One geometry's arch, off its buffer. `lift` is groundY - CAR.ground (see archDist). */
export function archBuffer(geo, lift) {
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal'), col = geo.getAttribute('color');
  const uv = geo.getAttribute('uv'), idx = geo.getIndex().array;
  const P = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
  const hex = (i) => [col.getX(i), col.getY(i), col.getZ(i)].map((v) => v.toFixed(6)).join(',');
  // The build's own unpainted plastic: every colour its trim slot carries.
  const trim = new Set();
  for (let i = 0; i < pos.count; i++) if (slotOf(uv, i) === SURFACE.trim) trim.add(hex(i));
  // THE WELL: every body triangle with all three corners inside the arch circle. The flush lip's rail is ON
  // the circle (to 1e-4) and its other rail 8.5 cm outside it, so the lip itself is never counted.
  const well = { tris: 0, paint: 0, notMatte: 0, foreign: 0, lumaMax: 0 };
  // THE FLANK CAP: a face whose three corners all sit where the cap ring's vertices sit (by exact position),
  // which the chamfer, the flush lip and the well never do.
  const { N, K } = shellLayout(geo);
  const capPos = new Set();
  for (const k of [0, K - 1]) for (let i = 0; i < N; i++) capPos.add(P(k * N + i).join(','));
  const capSum = new Map();
  for (let t = 0; t < idx.length / 3; t++) {
    const v = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]];
    if (v.some((i) => WHEEL.has(slotOf(uv, i)))) continue;
    const C = v.map(P);
    if (C.every((p) => archDist(p[2], p[1], lift) <= CAR.archR + 1e-4)) {
      well.tris++;
      if (v.some((i) => slotOf(uv, i) === SURFACE.paint)) well.paint++;
      if (v.some((i) => slotOf(uv, i) !== SURFACE.matte)) well.notMatte++;
      if (v.some((i) => !trim.has(hex(i)))) well.foreign++;
      for (const i of v) well.lumaMax = Math.max(well.lumaMax, lumaLin(col.getX(i), col.getY(i), col.getZ(i)));
    }
    if (C.every((p) => capPos.has(p.join(',')))) {
      const e1 = C[1].map((q, k) => q - C[0][k]), e2 = C[2].map((q, k) => q - C[0][k]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const i of v) { const a = capSum.get(i) ?? [0, 0, 0]; capSum.set(i, [a[0] + n[0], a[1] + n[1], a[2] + n[2]]); }
    }
  }
  // THE FLANK'S NORMAL AT THE ARCH: the normal a cap vertex within reach is shaded with, against the cap
  // faces' own area-weighted normal there. Shared with the chamfer, it is pulled toward the pavement.
  let tiltWorst = 0, tiltN = 0;
  for (const [i, a] of capSum) {
    const p = P(i);
    if (archDist(p[2], p[1], lift) > REACH) continue;
    const L = Math.hypot(...a);
    if (!L) continue;
    const c = (a[0] * nrm.getX(i) + a[1] * nrm.getY(i) + a[2] * nrm.getZ(i)) / L;
    tiltWorst = Math.max(tiltWorst, Math.acos(Math.min(1, c)) * 180 / Math.PI);
    tiltN++;
  }
  return { tris: idx.length / 3, verts: pos.count, trimColours: trim.size, well,
    tilt: { n: tiltN, worst: +tiltWorst.toFixed(4) } };
}

/** Every vertex record OUTSIDE the arch's reach, as exact strings, sorted: a multiset two builds can compare. */
export function outsideRecords(geo, lift) {
  const pos = geo.getAttribute('position'), out = [];
  const A = ['position', 'normal', 'color', 'uv'].map((n) => geo.getAttribute(n));
  for (let i = 0; i < pos.count; i++) {
    if (archDist(pos.getZ(i), pos.getY(i), lift) <= REACH) continue;
    out.push(A.map((a) => Array.from(a.array.subarray(i * a.itemSize, (i + 1) * a.itemSize)).join(',')).join('|'));
  }
  return out.sort();
}
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Every car pool the page builds, each through its OWN module (CLAUDE.md: construct the subject the way the game does). */
export async function poolMeshes() {
  const THREE = await import('../vendor/three.module.min.js');
  const district = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/district.json'), 'utf8'));
  const { StreetFurniture, LAMP_POOL, PARKED_GROUND_Y } = await import('../src/streetfurniture.js');
  const { Traffic } = await import('../src/traffic.js');
  const { PursuitUnits } = await import('../src/pursuit.js');
  const sink = { add() {} };
  const furniture = new StreetFurniture(new THREE.Scene(), { max: LAMP_POOL });
  furniture.buildParkedCars({ count: 30 });
  const traffic = new Traffic(sink, district, { count: 30, seed: 0 });
  const police = new PursuitUnits(sink, district, { count: 8, seed: 0 });
  const shapeOf = (m) => m.name.split(':')[1];
  return [
    ...traffic.meshes.map((m) => ({ pool: 'traffic', name: m.name, shape: shapeOf(m), groundY: 0, geo: m.geometry })),
    ...furniture.parked.meshes.map((m) => ({ pool: 'parked', name: m.name, shape: shapeOf(m), groundY: PARKED_GROUND_Y, geo: m.geometry })),
    { pool: 'police', name: 'police', shape: 'coupe', groundY: 0, geo: police.mesh.geometry },
    { pool: 'player', name: 'player', shape: null, groundY: CAR.ground, geo: buildPlayerCar().bodyMesh.geometry },
  ];
}

/** The same car before #125, by the same builder with the same options. */
const beforeOf = (p, arch = false) => (p.shape
  ? buildTrafficCarGeometry({ groundY: p.groundY, shape: SHAPES[p.shape], arch })
  : buildPlayerCar({ arch }).bodyMesh.geometry);

export async function bufferReport() {
  const pools = await poolMeshes();
  const rows = pools.map((p) => {
    const lift = p.groundY - CAR.ground;
    const before = beforeOf(p);
    return { pool: p.pool, name: p.name, shape: p.shape,
      now: archBuffer(p.geo, lift), before: archBuffer(before, lift),
      outsideSame: sameList(outsideRecords(p.geo, lift), outsideRecords(before, lift)) };
  });
  // The comparator must SEE a change outside the arch, or "confined" passes for the most flattering reason:
  // a shell 1 mm wider moves every flank vertex.
  const nudged = buildTrafficCarGeometry({ groundY: 0, shape: { hw: CAR.hw + 0.001 } });
  const coupe = buildTrafficCarGeometry({ groundY: 0 });
  const comparatorBites = !sameList(outsideRecords(nudged, -CAR.ground), outsideRecords(coupe, -CAR.ground));
  // A liner that is not the car's plastic must fail the plastic check.
  const whiteLiner = archBuffer(buildTrafficCarGeometry({ groundY: 0, arch: { liner: { colour: 0xffffff } } }), -CAR.ground);
  const shellCost = SHAPE_NAMES.map((n) => { const g = buildTrafficCarGeometry({ groundY: 0, shape: SHAPES[n] });
    return { name: n, tris: g.index.count / 3, verts: g.getAttribute('position').count }; });
  return { rows, comparatorBites, whiteLiner: whiteLiner.well, shellCost };
}

// ------------------------------------------------------------------------------------------- the page
/** Run the page and return its report (and frames, when asked). */
export async function runPage({ arms, cars, sides, tod = 'noon', debug = false, flat = false, w, h, port } = {}) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const PORT = Number(port ?? process.env.CAR_ARCH_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const qs = new URLSearchParams({ tod, ...(arms ? { arms } : {}), ...(cars ? { cars } : {}),
      ...(sides ? { sides } : {}), ...(debug ? { debug: '1' } : {}), ...(flat ? { flat: '1' } : {}),
      ...(w ? { w: String(w) } : {}), ...(h ? { h: String(h) } : {}) });
    await page.goto(`http://127.0.0.1:${PORT}/tools/car-arch.html?${qs}`);
    await page.waitForFunction('window.__carArch', null, { timeout: 900000 });
    const report = await page.evaluate(() => window.__carArch);
    const frames = debug ? await page.evaluate(() => window.__carArchFrames) : null;
    return { report, frames, errors };
  } finally {
    await browser.close();
  }
}

/** The gate's page: the fleet's coupe and the player's car, the sun side, the arch before #125 and shipped. */
export const GATE_PAGE = { arms: 'none,shipped', cars: 'traffic,player', sides: '1', w: 640, h: 360 };

// ------------------------------------------------------------------------------------------- the verdict
const num = (v) => (Number.isFinite(v) ? v : null);
const f3 = (v) => (num(v) === null ? 'n/a' : v.toFixed(3));
const sg = (v) => (num(v) === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(3));

/**
 * THE TWO BAND RULES, against the door IN THE SAME FRAME, so neither bound is a number anybody picked:
 *   lip   median luma at least the door's own p10, and median (R-B)/luma no more than the door's p90
 *   well  median (R-B)/luma no more than the door's p90
 * Both are null-safe: a band the page did not measure is a failure, never a pass.
 */
export function lipOk(run, arch) {
  const b = run?.bands?.[arch]?.lip, f = run?.flank;
  if (!b || !f || num(b.Lr) === null || num(b.dw) === null || !num(f.L) || num(f.p10) === null || num(f.w90) === null) return false;
  return b.Lr >= f.p10 / f.L && f.w + b.dw <= f.w90;
}
export function wellOk(run, arch) {
  const b = run?.bands?.[arch]?.well, f = run?.flank;
  if (!b || !f || num(b.dw) === null || num(f.w) === null || num(f.w90) === null) return false;
  return f.w + b.dw <= f.w90;
}

/** The verdict as a pure function of the two reports, so the selftest can feed it known-bads. */
export function verdict(buf, page) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const R = Array.isArray(buf?.rows) ? buf.rows : [];
  const want = { traffic: 3, parked: 3, police: 1, player: 1 };
  const counts = Object.fromEntries(Object.keys(want).map((k) => [k, R.filter((r) => r.pool === k).length]));
  // 1. The populations exist, or every check below passes over nothing.
  add('every car pool the page builds was built through its own module, and each has a well to measure',
    Object.entries(want).every(([k, n]) => counts[k] === n) && R.every((r) => r.now?.well?.tris > 0 && r.now?.tilt?.n > 0),
    `${JSON.stringify(counts)}; well tris ${R.map((r) => r.now?.well?.tris).join('/')}, cap vertices at the arch ${R.map((r) => r.now?.tilt?.n).join('/')}`);
  // 2-3. The well is the car's own plastic, not paint.
  add('the well is not paint: no body triangle inside any arch circle is on the paint slot, on any pool',
    R.length && R.every((r) => r.now?.well?.paint === 0 && r.now?.well?.notMatte === 0),
    R.map((r) => `${r.name} ${r.now?.well?.paint}/${r.now?.well?.tris}`).join(', '));
  add('KNOWN-BAD: before #125 the well was paint, on every pool',
    R.length && R.every((r) => r.before?.well?.paint > 0),
    R.map((r) => `${r.name} ${r.before?.well?.paint}/${r.before?.well?.tris}`).join(', '));
  // 4-5. In the car's own unpainted plastic.
  add('and it is the car\'s own unpainted plastic: every well corner carries a colour its trim slot carries',
    R.length && R.every((r) => r.now?.well?.foreign === 0 && r.now?.trimColours > 0),
    R.map((r) => `${r.name} ${r.now?.well?.foreign} foreign, luma <= ${f3(r.now?.well?.lumaMax)}`).join(', '));
  add('KNOWN-BAD: a liner in white is not the car\'s plastic, and the check says so',
    buf?.whiteLiner?.foreign > 0, `${buf?.whiteLiner?.foreign} foreign corners, luma ${f3(buf?.whiteLiner?.lumaMax)}`);
  // 6-7. The flank's own normal at the arch.
  add('the flank keeps the cap\'s own normal at the arch: no cap vertex within reach tilts over 0.05 degrees',
    R.length && R.every((r) => num(r.now?.tilt?.worst) !== null && r.now.tilt.worst <= 0.05),
    R.map((r) => `${r.name} ${r.now?.tilt?.worst} deg over ${r.now?.tilt?.n}`).join(', '));
  add('KNOWN-BAD: before #125 the chamfer pulled it toward the pavement by over 10 degrees, on every pool',
    R.length && R.every((r) => r.before?.tilt?.worst > 10),
    R.map((r) => `${r.name} ${r.before?.tilt?.worst}`).join(', '));
  // 8-9. Confined.
  add('confined: every vertex outside the arch\'s reach is byte-identical to the arch before #125, on every pool',
    R.length && R.every((r) => r.outsideSame === true), R.map((r) => `${r.name} ${r.outsideSame}`).join(', '));
  add('KNOWN-BAD: and the comparator sees a shell 1 mm wider, so "identical" is a measurement',
    buf?.comparatorBites === true, `${buf?.comparatorBites}`);
  // 10. Free.
  const SC = Array.isArray(buf?.shellCost) ? buf.shellCost : [];
  add('free: every pool\'s triangle count is the arch-before-#125\'s, and the fleet\'s shells are still equal-cost',
    R.length && R.every((r) => r.now?.tris === r.before?.tris) && SC.length === 3
      && SC.every((s) => s.tris === SC[0].tris && s.verts === SC[0].verts),
    R.map((r) => `${r.name} ${r.before?.tris}->${r.now?.tris} tris, ${r.before?.verts}->${r.now?.verts} verts`).join(', ')
      + `; shells ${SC.map((s) => `${s.tris}t/${s.verts}v`).join(' ')}`);

  // THE PAGE.
  const runs = Array.isArray(page?.runs) ? page.runs : [];
  const run = (arm, car) => runs.find((r) => r.arm === arm && r.car === car && r.side === 1);
  const cars = ['traffic', 'player'];
  const pairs = cars.flatMap((c) => ['rear', 'front'].map((k) => [c, k]));
  // 11. The page built the game's cars.
  add('the page ran, and its own builds are the modules\' (the fleet\'s and the parked pool\'s)',
    !page?.error && page?.moduleIdentity?.traffic === true && page?.moduleIdentity?.parked === true,
    page?.error ? String(page.error).slice(0, 160) : JSON.stringify(page?.moduleIdentity));
  // 12. Both arms exist, differ inside the arch, and the references were found: or every band rule below is
  //     about nothing.
  const zoneChanged = (c) => { const v = run('shipped', c)?.vsFirst; if (!v) return null;
    let ch = 0, px = 0; for (const [k, e] of Object.entries(v)) if (k.startsWith('arch:')) { ch += e.changed; px += e.px; } return px ? ch / px : null; };
  const measured = (r, k) => r?.flank?.n >= 1000 && r?.tyre?.[k]?.n >= 20 && ['well', 'lip'].every((b) => r?.bands?.[k]?.[b]?.n >= 50);
  add('both arms rendered, differ inside the arch, and found the door, the tyre and both bands at every arch',
    cars.every((c) => run('none', c) && run('shipped', c) && zoneChanged(c) >= 0.01)
      && pairs.every(([c, k]) => measured(run('none', c), k) && measured(run('shipped', c), k)),
    cars.map((c) => `${c} ${f3(zoneChanged(c))} of the arch zone changed`).join(', '));
  // 13-14. The lip.
  const lipLine = (arm) => pairs.map(([c, k]) => { const r = run(arm, c), b = r?.bands?.[k]?.lip, f = r?.flank;
    return `${c} ${k} luma ${f3(b?.Lr)} (door p10 ${f3(f && f.p10 / f.L)}) warmth ${sg(b?.dw)} (door p90 ${sg(f && f.w90 - f.w)})`; }).join('; ');
  add('the lip reads as the flank: inside the door\'s own luma spread and no warmer than its warmest tenth',
    pairs.every(([c, k]) => lipOk(run('shipped', c), k)), lipLine('shipped'));
  add('KNOWN-BAD: before #125 the lip fails it at every arch of both cars',
    pairs.every(([c, k]) => run('none', c) && !lipOk(run('none', c), k)), lipLine('none'));
  // 15-16. The well.
  const wellLine = (arm) => pairs.map(([c, k]) => { const r = run(arm, c), b = r?.bands?.[k]?.well, f = r?.flank;
    return `${c} ${k} warmth ${sg(b?.dw)} (door p90 ${sg(f && f.w90 - f.w)}) luma ${f3(b?.Lr)} tyre ${f3(r?.tyre?.[k]?.Lr)}`; }).join('; ');
  add('the well is not dirt: no warmer than the door\'s warmest tenth',
    pairs.every(([c, k]) => wellOk(run('shipped', c), k)), wellLine('shipped'));
  add('KNOWN-BAD: before #125 the well fails it at every arch of both cars',
    pairs.every(([c, k]) => run('none', c) && !wellOk(run('none', c), k)), wellLine('none'));
  return checks;
}

// ------------------------------------------------------------------------------------------- the measurement's printout
export function printProfile(run, { step = 2, r0 = 0.30, r1 = 0.80 } = {}) {
  const f = run.flank;
  const p3 = (v) => (v == null ? '   -  ' : v.toFixed(3).padStart(6));
  const s3 = (v) => (v == null ? '   -  ' : (v >= 0 ? '+' : '') + v.toFixed(3));
  console.log(`\n=== ${run.arm} / ${run.car} / side ${run.side > 0 ? '+x' : '-x'}   flank on the door: n ${f.n}, ` +
    `luma ${p3(f.L)} (p10 ${p3(f.p10)} p90 ${p3(f.p90)}), (R-B)/luma ${s3(f.w)} (p90 ${s3(f.w90)})   ` +
    `${run.geometry.tris} tris ${run.geometry.verts} verts`);
  if (run.vsFirst) {
    const { against, ...z } = run.vsFirst;
    console.log(`  pixels changed against "${against}", by zone and class (* = a triangle with a corner in the arch covers it or a neighbour): ` +
      Object.entries(z).sort(([a], [b]) => a.localeCompare(b)).map(([k, e]) => `${k} ${e.changed}/${e.px}${e.changed ? ` (max ${e.max})` : ''}`).join(', '));
  }
  for (const k of ['rear', 'front']) {
    const b = run.bands[k];
    console.log(`  ${k} arch: well luma ${p3(b.well.Lr)} warmth ${s3(b.well.dw)} | lip luma ${p3(b.lip.Lr)} warmth ${s3(b.lip.dw)} | ` +
      `flank past it ${p3(b.near.Lr)} ${s3(b.near.dw)} | tyre ${p3(run.tyre[k].Lr)}`);
    console.log('           r m    n   luma/flank  (R-B)/L - flank   classes');
    for (let j = 0; j < run.prof[k].length; j += step) {
      const p = run.prof[k][j];
      if (p.r < r0 || p.r > r1) continue;
      const cls = Object.entries(p.cls).sort((a, c) => c[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' ');
      console.log(`           ${p.r.toFixed(2)} ${String(p.n).padStart(5)}   ${p3(p.Lr)}      ${s3(p.dw)}       ${cls}`);
    }
  }
}

// ------------------------------------------------------------------------------------------- selftest
function selftest() {
  let fails = 0;
  const chk = (name, ok, got) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}`); if (!ok) fails++; };
  // THE INSTRUMENTS, on real buffers: they must see the defect and not invent one.
  const before = archBuffer(buildTrafficCarGeometry({ groundY: 0, arch: false }), -CAR.ground);
  const now = archBuffer(buildTrafficCarGeometry({ groundY: 0 }), -CAR.ground);
  chk('the well census sees the painted well before #125', before.well.paint > 0 && before.well.tris === now.well.tris,
    `${before.well.paint} of ${before.well.tris} painted, against ${now.well.paint} of ${now.well.tris} now`);
  chk('the tilt census sees the chamfer\'s pull before #125 and none now', before.tilt.worst > 10 && now.tilt.worst <= 0.05,
    `${before.tilt.worst} deg against ${now.tilt.worst} over ${now.tilt.n} vertices`);
  const g0 = buildTrafficCarGeometry({ groundY: 0 }), g1 = buildTrafficCarGeometry({ groundY: 0 });
  chk('two builds of one car are identical outside the arch, so the comparator does not invent a change',
    sameList(outsideRecords(g0, -CAR.ground), outsideRecords(g1, -CAR.ground)), `${outsideRecords(g0, -CAR.ground).length} records`);
  let threw = false;
  try { shellLayout(buildTrafficCarGeometry({ groundY: 0 }).clone().translate(0.5, 0, 0)); } catch { threw = true; }
  chk('the layout reader refuses a geometry with no centreline ring rather than measuring something else', threw, `threw ${threw}`);

  // THE VERDICT, on synthetic reports: a good pair passes every check, and each known-bad fails its own.
  const goodRow = (pool, name) => ({ pool, name, shape: 'coupe', outsideSame: true,
    now: { tris: 1218, verts: 805, trimColours: 1, well: { tris: 40, paint: 0, notMatte: 0, foreign: 0, lumaMax: 0.05 }, tilt: { n: 28, worst: 0.01 } },
    before: { tris: 1218, verts: 749, trimColours: 1, well: { tris: 40, paint: 40, notMatte: 40, foreign: 40, lumaMax: 1 }, tilt: { n: 28, worst: 33.3 } } });
  const goodBuf = () => ({ comparatorBites: true, whiteLiner: { foreign: 40, lumaMax: 1 },
    shellCost: [0, 1, 2].map(() => ({ tris: 1218, verts: 805 })),
    rows: [...[0, 1, 2].map((i) => goodRow('traffic', `t${i}`)), ...[0, 1, 2].map((i) => goodRow('parked', `p${i}`)),
      goodRow('police', 'police'), goodRow('player', 'player')] });
  const band = (Lr, dw) => ({ n: 200, Lr, dw });
  const pageRun = (arm, car, lipLr, lipDw, wellDw) => ({ arm, car, side: 1,
    flank: { n: 9000, L: 0.4, w: 0.10, p10: 0.27, p90: 0.5, w10: 0.05, w90: 0.18 },
    tyre: { rear: { n: 100, Lr: 0.01 }, front: { n: 100, Lr: 0.01 } },
    bands: { rear: { well: band(0.01, wellDw), lip: band(lipLr, lipDw) }, front: { well: band(0.01, wellDw), lip: band(lipLr, lipDw) } },
    vsFirst: arm === 'none' ? null : { against: 'none', 'arch:flank*': { px: 1000, changed: 500, max: 40 } } });
  const goodPage = () => ({ moduleIdentity: { traffic: true, parked: true }, runs: ['traffic', 'player'].flatMap((c) =>
    [pageRun('none', c, 0.45, 0.20, 0.30), pageRun('shipped', c, 1.04, -0.04, -0.01)]) });
  const good = verdict(goodBuf(), goodPage());
  chk('a good report passes every check', good.every((c) => c.ok), good.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'all ok');
  chk('the check count is a property of the gate, not of the report', good.length === CHECK_COUNT, `${good.length} of ${CHECK_COUNT}`);
  const failsOn = (label, buf, page, want) => {
    const v = verdict(buf, page);
    const bad = v.filter((c) => !c.ok).map((c) => c.name);
    chk(`KNOWN-BAD ${label}`, v.length === CHECK_COUNT && want.every((w) => bad.some((n) => n.includes(w))),
      bad.length ? bad.join(' | ').slice(0, 220) : 'nothing failed');
  };
  { const b = goodBuf(); b.rows[0].now.well.paint = 3; failsOn('a painted well fails "the well is not paint"', b, goodPage(), ['the well is not paint']); }
  { const b = goodBuf(); b.rows[7].now.well.foreign = 2; failsOn('a liner off the trim slot\'s colours fails the plastic check', b, goodPage(), ['unpainted plastic']); }
  { const b = goodBuf(); b.rows[3].now.tilt.worst = 33.3; failsOn('a tilted flank normal fails', b, goodPage(), ['keeps the cap']); }
  { const b = goodBuf(); b.rows[5].outsideSame = false; failsOn('a vertex moved outside the arch fails "confined"', b, goodPage(), ['confined']); }
  { const b = goodBuf(); b.comparatorBites = false; failsOn('a comparator that cannot see a change fails', b, goodPage(), ['comparator']); }
  { const b = goodBuf(); b.rows[1].now.tris = 1220; failsOn('two more triangles fails "free"', b, goodPage(), ['free']); }
  { const b = goodBuf(); b.rows.pop(); failsOn('a missing pool fails the population check', b, goodPage(), ['every car pool']); }
  { const b = goodBuf(); b.rows[0].before.well.paint = 0; failsOn('a before-arm with no painted well fails its KNOWN-BAD', b, goodPage(), ['before #125 the well was paint']); }
  { const p = goodPage(); p.runs[1].bands.front.lip.dw = 0.2; failsOn('a warm lip fails', goodBuf(), p, ['the lip reads as the flank']); }
  { const p = goodPage(); p.runs[3].bands.rear.lip.Lr = 0.5; failsOn('a dark lip fails', goodBuf(), p, ['the lip reads as the flank']); }
  { const p = goodPage(); p.runs[3].bands.front.well.dw = 0.3; failsOn('a warm well fails', goodBuf(), p, ['the well is not dirt']); }
  { const p = goodPage(); p.runs[0].bands.rear.lip.dw = -0.05; p.runs[0].bands.rear.lip.Lr = 1.0;
    failsOn('a before-arm whose lip passes fails its KNOWN-BAD', goodBuf(), p, ['before #125 the lip fails']); }
  { const p = goodPage(); p.moduleIdentity.parked = false; failsOn('a page build that is not the module\'s fails', goodBuf(), p, ['the page ran']); }
  { const p = goodPage(); p.runs[3].vsFirst = { against: 'none', 'arch:flank*': { px: 1000, changed: 0, max: 0 } };
    failsOn('two arms that are one build fail', goodBuf(), p, ['both arms']); }
  { const p = goodPage(); delete p.runs[1].bands.rear.lip;
    failsOn('a band the page did not measure fails rather than passing', goodBuf(), p, ['both arms', 'the lip reads as the flank']); }
  // AND NOTHING THROWS on a report with nothing in it: a crash is not a verdict.
  let threw2 = false, n0 = 0;
  try { n0 = verdict({}, {}).length; } catch { threw2 = true; }
  chk('an empty report is a full set of FAILs, not a crash', !threw2 && n0 === CHECK_COUNT && verdict({}, {}).every((c) => !c.ok),
    `threw ${threw2}, ${n0} checks`);
  console.log(fails ? `\nCAR-ARCH SELFTEST: FAIL (${fails})` : '\nCAR-ARCH SELFTEST: PASS');
  return fails === 0;
}

// ------------------------------------------------------------------------------------------- main
if (IS_MAIN && argv.includes('--selftest')) {
  process.exit(selftest() ? 0 : 1);
} else if (IS_MAIN && argv.includes('--measure')) {
  const { writePNG } = await import('./crop.mjs');
  const t0 = Date.now();
  const { report, frames, errors } = await runPage({ arms: arg('--arms'), cars: arg('--cars'), sides: arg('--sides'),
    tod: arg('--tod', 'noon'), debug: !!arg('--frames'), flat: argv.includes('--flat'), w: arg('--w'), h: arg('--h') });
  if (errors.length) console.log('page errors:', errors.join('\n'));
  if (report.error) { console.log('PAGE ERROR', report.error); process.exit(1); }
  console.log(`car-arch: ${report.runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(1)} s, light ${JSON.stringify(report.light)}`);
  console.log(`module identity ${JSON.stringify(report.moduleIdentity)}   page ms ${JSON.stringify(report.ms)}`);
  for (const run of report.runs) printProfile(run);
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(report));
  if (frames) {
    const dir = arg('--frames');
    fs.mkdirSync(dir, { recursive: true });
    const [W, H] = report.size;
    for (const [name, fr] of Object.entries(frames)) {
      writePNG(path.join(dir, `${name}.png`), W, H, Buffer.from(fr.rgb, 'base64'));
      writePNG(path.join(dir, `${name}-mask.png`), W, H, Buffer.from(fr.mask, 'base64'));
    }
    console.log(`frames -> ${dir}`);
  }
} else if (IS_MAIN) {
  const t0 = Date.now();
  const buf = await bufferReport();
  const tb = Date.now();
  const { report, errors } = await runPage(GATE_PAGE);
  if (errors.length) report.error = (report.error ? report.error + '\n' : '') + errors.join('\n');
  const checks = verdict(buf, report);
  console.log(`CAR ARCH (#125) — buffers ${((tb - t0) / 1000).toFixed(1)} s, page ${((Date.now() - tb) / 1000).toFixed(1)} s`);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}\n         ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\nCAR-ARCH: FAIL (${failed.length} of ${checks.length})` : `\nCAR-ARCH: PASS — ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}
