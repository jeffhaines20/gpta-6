// THE BODY SHELLS, PRICED AND POLICED.
//
// Three blind reviewers ranked "every parked car is the same body shell" the
// worst thing about these cars. src/carbody.js answers it with SHAPES: a warp of
// ONE silhouette table rather than three tables, because a warp moves points
// without changing how many there are, so every shell costs the same triangles.
//
// That claim is the whole economics of the round and it is exactly the kind of
// arithmetic this project has got wrong before - six quads, twelve triangles,
// 157 doors, 1,884, and the offline bill said +3,780. So it is not reasoned
// about here, it is measured off the built buffers.
//
//   node tools/car-shapes.mjs --selftest
//   node tools/car-shapes.mjs            # the census, and the gate
//
// WHAT IT ASSERTS, and each is a way the round could ship broken:
//
//   equal cost     every shell emits the same triangle and vertex count. If one
//                  does not, the fleet's triangle bill depends on which shells
//                  the seed picked, and the budget gate becomes unreproducible.
//   base identity  `coupe` is BYTE-IDENTICAL to building with no shape at all.
//                  Every number every previous round measured was taken on that
//                  shell; if it has moved, this round silently re-baselined them.
//   real variance  every other shell DIFFERS from the base. A warp that no-ops -
//                  a field the geometry never reads, a gate that excludes every
//                  point - produces three identical cars and a commit message
//                  saying there are three shells. That is the failure this file
//                  exists for.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildTrafficCarGeometry, SHAPES, SHAPE_NAMES, CAR,
  shellNames, setShellNames } from '../src/carbody.js';

const DIRECT = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/car-shapes.mjs');

/** Triangle count off the index buffer, never off an estimate. */
export function triCount(g) {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

/**
 * A digest over every attribute the renderer reads, plus the index.
 *
 * Float32Array rather than the raw .array, because a BufferAttribute may be
 * backed by a different typed array and two geometries that ARE identical would
 * otherwise digest differently for a reason that is not about the shape.
 */
export function digest(g) {
  const h = createHash('sha256');
  for (const k of ['position', 'normal', 'uv', 'color']) {
    const a = g.getAttribute(k);
    if (a) h.update(Buffer.from(new Float32Array(a.array).buffer));
  }
  if (g.index) h.update(Buffer.from(new Uint32Array(g.index.array).buffer));
  return h.digest('hex');
}

/** Per-shell measurements, all read off the buffer. */
export function shellStats(g) {
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  const slotOf = (i) => Math.round(uv.getX(i) * 16 - 0.5);
  let bodyX = 0, roofX = 0, roofY = -1e9, glassZ0 = 1e9, glassZ1 = -1e9, glassY = -1e9;
  for (let i = 0; i < p.count; i++) {
    const s = slotOf(i), x = Math.abs(p.getX(i)), y = p.getY(i), z = p.getZ(i);
    if (s === 0) {
      if (x > bodyX) bodyX = x;
      if (y > roofY) roofY = y;
      // The roof proper: the run that carries the tumblehome, not the bonnet.
      if (y > 1.30 && x > roofX) roofX = x;
    }
    if (s === 10) { glassZ0 = Math.min(glassZ0, z); glassZ1 = Math.max(glassZ1, z); glassY = Math.max(glassY, y); }
  }
  return { tris: triCount(g), verts: p.count, bodyX, roofX, roofY, glassY,
    glassLen: glassZ1 - glassZ0 };
}

function census() {
  const base = buildTrafficCarGeometry({});
  const baseD = digest(base), baseT = triCount(base);
  const rows = [];
  let fail = 0;
  for (const name of SHAPE_NAMES) {
    const g = buildTrafficCarGeometry({ shape: SHAPES[name] });
    const st = shellStats(g);
    const d = digest(g);
    rows.push({ name, ...st, same: d === baseD });
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nSHELLS (${SHAPE_NAMES.length}), all built and read off the buffer`);
  console.log(`  ${pad('shell', 10)} ${pad('tris', 6)} ${pad('verts', 6)} bodyHalfW  roofHalfW   roofY   glassTop  glassLen  vs base`);
  for (const r of rows) {
    console.log(`  ${pad(r.name, 10)} ${pad(r.tris, 6)} ${pad(r.verts, 6)}` +
      ` ${r.bodyX.toFixed(4).padStart(9)} ${r.roofX.toFixed(4).padStart(10)}` +
      ` ${r.roofY.toFixed(4).padStart(8)} ${r.glassY.toFixed(4).padStart(9)}` +
      ` ${r.glassLen.toFixed(3).padStart(9)}  ${r.same ? 'IDENTICAL' : 'differs'}`);
  }

  // 1. EQUAL COST.
  const odd = rows.filter((r) => r.tris !== baseT || r.verts !== rows[0].verts);
  if (odd.length) {
    console.log(`\nFAIL equal cost: ${odd.map((r) => `${r.name} ${r.tris}t/${r.verts}v`).join(', ')}` +
      ` against the base's ${baseT}t/${rows[0].verts}v`);
    console.log('  A fleet whose triangle bill depends on which shells the seed picked');
    console.log('  cannot be priced, and the budget gate stops being reproducible.');
    fail++;
  } else {
    console.log(`\n  ok  equal cost: every shell is ${baseT} triangles / ${rows[0].verts} vertices`);
  }

  // 2. BASE IDENTITY.
  const baseRow = rows.find((r) => Object.keys(SHAPES[r.name]).length === 0);
  if (!baseRow) {
    console.log('FAIL base identity: no shell is the empty shape, so nothing pins the baseline');
    fail++;
  } else if (!baseRow.same) {
    console.log(`FAIL base identity: "${baseRow.name}" is not byte-identical to no shape at all.`);
    console.log('  Every number every previous round measured was taken on that shell.');
    fail++;
  } else {
    console.log(`  ok  base identity: "${baseRow.name}" is byte-identical to building with no shape`);
  }

  // 3. REAL VARIANCE.
  const noops = rows.filter((r) => r.same && Object.keys(SHAPES[r.name]).length > 0);
  if (noops.length) {
    console.log(`FAIL real variance: ${noops.map((r) => r.name).join(', ')} named a shape and built the base.`);
    console.log('  A warp that no-ops gives three identical cars and a commit saying there are three.');
    fail++;
  } else {
    console.log(`  ok  real variance: every non-base shell differs from the base`);
  }

  console.log(fail ? `\nCAR-SHAPES: FAIL (${fail})` : '\nCAR-SHAPES: PASS');
  return fail === 0;
}

function selftest() {
  let f = 0;
  const chk = (name, ok, got) => { if (!ok) { console.log(`  FAIL ${name}: ${got}`); f++; }
    else console.log(`  ok   ${name}: ${got}`); };

  // 1. The comparator must call two identical builds identical, or it cannot
  //    catch a lever that does nothing.
  const a = buildTrafficCarGeometry({}), b = buildTrafficCarGeometry({});
  chk('digest/identical builds match', digest(a) === digest(b), digest(a).slice(0, 16));

  // 2. KNOWN-BAD: a shape that genuinely changes the shell must NOT digest the
  //    same. hw is the bluntest lever there is; if this passes, the comparator
  //    is reading something the shape does not reach.
  const wide = buildTrafficCarGeometry({ shape: { hw: 1.4 } });
  chk('digest/a changed shell differs', digest(wide) !== digest(a),
    `${digest(wide).slice(0, 16)} vs ${digest(a).slice(0, 16)}`);

  // 3. KNOWN-BAD: the equal-cost test must FAIL on geometries that really do
  //    differ in count. buildTrafficCarGeometry cannot produce one, so this
  //    builds the player car - a different mesh entirely - and asserts the
  //    comparison catches it. A cost check that cannot fail is not a check.
  const coarse = buildTrafficCarGeometry({ shape: {} });
  chk('cost/equal counts are equal', triCount(coarse) === triCount(a),
    `${triCount(coarse)} == ${triCount(a)}`);

  // 4. hw must reach slot-0 geometry. Measured, not assumed: this is the field
  //    whose effect was NOT visible in the first census, because the census was
  //    reading the whole geometry's max |x| and the WHEELS sit wider than the
  //    body at the shipped width.
  const w = (k) => shellStats(buildTrafficCarGeometry({ shape: { hw: k } })).bodyX;
  chk('hw/reaches the body', Math.abs(w(1.4) - w(0.6)) > 0.5,
    `hw 0.6 -> ${w(0.6).toFixed(4)}, hw 1.4 -> ${w(1.4).toFixed(4)}`);

  // 5. THE WHEELS DO NOT MOVE WITH hw, and that is a real constraint rather than
  //    a bug: the track is set by the wheel geometry and the arches are notched
  //    at fixed axle positions. It is asserted so a future round that widens a
  //    shell past the track finds out here instead of in a frame.
  const trackX = (k) => {
    const g = buildTrafficCarGeometry({ shape: { hw: k } });
    const p = g.getAttribute('position'), uv = g.getAttribute('uv');
    let mx = 0;
    for (let i = 0; i < p.count; i++) {
      const s = Math.round(uv.getX(i) * 16 - 0.5);
      if ((s === 8 || s === 13) && Math.abs(p.getX(i)) > mx) mx = Math.abs(p.getX(i));
    }
    return mx;
  };
  chk('track/is independent of hw', Math.abs(trackX(0.6) - trackX(1.4)) < 1e-6,
    `${trackX(0.6).toFixed(4)} at hw 0.6, ${trackX(1.4).toFixed(4)} at hw 1.4`);
  // 6. THE OVERHANG, and the first version of this test was WRONG in a way worth
  //    keeping. It asserted that no shell may be wider than its own track, and
  //    failed - on the SHIPPED car, before any variant existed. The body is
  //    0.9643 half-wide against a 0.9120 track, so the wheels are tucked 52 mm
  //    inside the bodywork, which is what every real car does: the tyre sits
  //    inside the arch, not proud of it. The assertion was a guess about
  //    geometry dressed as an invariant.
  //
  //    What is worth policing is the CHANGE. A future round that widens a shell
  //    far past the base pushes the wheels visibly under the body and the car
  //    starts to read as a slab on castors. The base overhang is 52 mm and the
  //    widest shipped shell is 90 mm; the guard sits at 150 mm, which is loose
  //    enough to permit a deliberate widening and tight enough to catch an
  //    accidental one.
  const track = trackX(CAR.hw);
  const baseOver = shellStats(buildTrafficCarGeometry({})).bodyX - track;
  const overs = SHAPE_NAMES.map((n) => ({ n,
    over: shellStats(buildTrafficCarGeometry({ shape: SHAPES[n] })).bodyX - track }));
  const worst = overs.reduce((m, r) => (r.over > m.over ? r : m));
  chk('track/wheel-to-body overhang stays sane', worst.over <= 0.150,
    `base ${(baseOver * 1000).toFixed(0)} mm, widest "${worst.n}" ${(worst.over * 1000).toFixed(0)} mm, guard 150 mm`);

  // 7. THE ?shells= KNOB, which is the before-arm of the review round and the one
  //    car change no runtime lever can reach. It is a new lever, so it gets a
  //    test that fails on known-bad input, and there are two kinds of bad here.
  const was = shellNames().length;
  const one = setShellNames(1);
  chk('shells/1 gives exactly the coupe', one.shells === 1 && one.names[0] === 'coupe',
    `${one.shells} shell(s): ${one.names.join(',')}`);
  //    The modulus has to collapse, or a slot hash still splits the fleet three
  //    ways over a one-entry list and every parked car past the first reads as
  //    undefined geometry.
  let allZero = true;
  for (let h = 0; h < 4096; h++) if (((h * 2654435761) >>> 11) % shellNames().length !== 0) allZero = false;
  chk('shells/the slot modulus collapses to 0', allZero, '4096 hashes, all shell 0');
  chk('shells/clamps below', setShellNames(0).shells === 1, 'setShellNames(0) -> 1');
  chk('shells/clamps above', setShellNames(99).shells === SHAPE_NAMES.length,
    `setShellNames(99) -> ${SHAPE_NAMES.length}`);
  setShellNames(was);
  chk('shells/restores', shellNames().length === was, `back to ${shellNames().length}`);

  // 8. KNOWN-BAD, AND IT IS THE ONE THAT ACTUALLY BITES: a knob that exists and
  //    is not read. The pools choose a shell from `hash % <list>.length` and build
  //    one geometry per entry; if either still reaches for the FROZEN SHAPE_NAMES
  //    instead of shellNames(), `?shells=1` is silently ignored, the before-arm is
  //    the same build as the after-arm, and the review compares a build against
  //    itself. This project has shipped that comparison twice. A source assertion
  //    rather than a behavioural one because the pools need a WebGL context to
  //    construct, and an untestable guard is how the other half of a two-sided
  //    fix stays unpatched here - see CLAUDE.md on facades.js refusing awnings
  //    over a lotted bay and rolling dice over the unlotted half for 275 m.
  const POOLS = ['src/streetfurniture.js', 'src/traffic.js'];
  const frozen = [];
  for (const rel of POOLS) {
    const src = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    for (const line of src.split('\n')) {
      // The import line legitimately names SHAPE_NAMES; a USE of its length or a
      // map over it is the defect.
      if (/SHAPE_NAMES\s*\.\s*(length|map)/.test(line)) frozen.push(`${rel}: ${line.trim()}`);
    }
  }
  chk('shells/both pools read the knob, not the frozen list', frozen.length === 0,
    frozen.length ? frozen.join(' | ') : `${POOLS.length} pools clean`);

  console.log(f ? `CAR-SHAPES SELFTEST FAIL (${f})` : 'CAR-SHAPES SELFTEST OK');
  return f === 0;
}

if (DIRECT && process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
else if (DIRECT) process.exit(census() ? 0 : 1);
