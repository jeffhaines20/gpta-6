// What the crowd actually submits, and whether any of it draws nothing.
//
// src/pedestrians.js runs two tiers over one population: a far tier at 616
// triangles a ped and a near tier at 2,256 for the nearest 12 within 24 m. A ped
// that claims a near slot is written into the near meshes AND its far instance is
// set to a zero scale, with the comment "the far tier must not draw it a second
// time" -- which is visually right and is not the same as not PAYING for it. An
// InstancedMesh bills every instance below `count`, so a zero-scale instance is
// submitted, transformed, and counted by renderer.info in the colour pass and in
// every shadow map the mesh casts into. Both tiers set castShadow.
//
// Measured against the budget gate's own drive, replayed offline: the frame the
// gate's p95 selects (rank 5 of 88) holds TWELVE near-tier peds, so 12 x 616 =
// 7,392 triangles are submitted there for bodies the near tier is already drawing.
// Far-tier waste over the top tenth of frames by triangle count is saturated at
// 7,392; over all frames its median is 1,848. The reduction therefore lands on
// exactly the frames the gate's near-maximum statistic picks, which is the only
// reason it is worth doing at all.
//
//   node tools/crowd-bill.mjs
//   node tools/crowd-bill.mjs --count 96 --at 43,-44
//   node tools/crowd-bill.mjs --selftest
//
// The four invariants below are the gate for any change to the tier split. Three
// of them hold today; `no hidden instance inside the far tier's drawn range` is
// the one that does not, and it is the measurement, not a failure.
import fs from 'node:fs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, { get(t, k) {
    if (k === 'canvas') return { width: 1, height: 1 };
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
    if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    if (k === 'measureText') return () => ({ width: 10 });
    return () => {}; } });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: ctx, style: {} }),
    createElementNS: () => ({ width: 0, height: 0, getContext: ctx, style: {} }) };
  globalThis.window = globalThis;
}
const THREE = await import('../vendor/three.module.min.js');
const { Pedestrians } = await import('../src/pedestrians.js');

const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
/** Is this instance's matrix a zero scale? That is how the module hides one. */
function hiddenAt(mesh, i, m = new THREE.Matrix4(), v = new THREE.Vector3()) {
  mesh.getMatrixAt(i, m);
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), v);
  return !(v.x > 1e-6 && v.y > 1e-6 && v.z > 1e-6);
}

/**
 * Does the colour at each drawn far slot belong to the ped that slot holds?
 *
 * This is the invariant swap-remove can break and nothing else can see. Matrices are
 * rewritten every frame, so a swap that moved the matrix and not the colour would
 * place every body correctly and dress the wrong one -- a defect that looks like
 * art direction, not like a bug.
 */
export function colourIdentity(crowd) {
  if (!crowd.torsos.instanceColor || !crowd.heads.instanceColor) return { checked: 0, wrong: 0 };
  const c = new THREE.Color(), want = new THREE.Color();
  let checked = 0, wrong = 0;
  for (let s = 0; s < crowd.torsos.count; s++) {
    const i = crowd._farOf ? crowd._farOf[s] : s;
    const ped = crowd.peds[i];
    if (!ped) continue;
    checked++;
    crowd.torsos.getColorAt(s, c); want.setHex(ped.shirt);
    if (Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b) > 1e-4) { wrong++; continue; }
    crowd.heads.getColorAt(s, c); want.setHex(ped.skin);
    if (Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b) > 1e-4) wrong++;
  }
  return { checked, wrong };
}

/** Are _farAt and _farOf mutually inverse over the whole population? */
export function permutationOk(crowd) {
  if (!crowd._farAt) return { ok: true, slots: 0, note: 'not packed' };
  const n = crowd.count;
  const seen = new Uint8Array(n);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const s = crowd._farAt[i];
    if (s < 0 || s >= n || crowd._farOf[s] !== i || seen[s]) bad++;
    else seen[s] = 1;
  }
  return { ok: bad === 0, bad, slots: n };
}

export function bill(crowd) {
  const far = [crowd.torsos, crowd.heads, crowd.limbs];
  const near = [crowd.nearTorsos, crowd.nearHeads, crowd.nearLimbs];
  const perFarSlot = far.map((m) => tris(m.geometry));
  const perNearSlot = near.map((m) => tris(m.geometry));
  const limbSlots = crowd.limbs.instanceMatrix.count / crowd.count;
  const farPerPed = perFarSlot[0] + perFarSlot[1] + perFarSlot[2] * limbSlots;

  // Which far slots are inside the drawn range, and which of those draw nothing.
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  let drawnFar = 0, hiddenInRange = 0;
  for (let i = 0; i < crowd.torsos.count; i++) {
    drawnFar++;
    if (hiddenAt(crowd.torsos, i, m, v)) hiddenInRange++;
  }
  const nearLive = crowd._nearLive ?? crowd.nearTorsos.count;
  const farBill = far.reduce((a, mm, k) => a + perFarSlot[k] * mm.count, 0);
  const nearBill = near.reduce((a, mm, k) => a + perNearSlot[k] * mm.count, 0);
  return { nearLive, drawnFar, hiddenInRange, farPerPed, farBill, nearBill,
    total: farBill + nearBill, wasted: hiddenInRange * farPerPed, limbSlots,
    perNearPed: perNearSlot[0] + perNearSlot[1] + perNearSlot[2] * (crowd.nearLimbs.instanceMatrix.count / Math.max(1, crowd.nearPool)) };
}

/** Is every ped drawn exactly once, across the two tiers? */
export function tierCoverage(crowd) {
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  let bothVisible = 0, neitherVisible = 0, farOnly = 0, nearOnly = 0;
  for (let i = 0; i < crowd.count; i++) {
    if (!crowd.peds[i]) continue;
    const ns = crowd._nearSlot[i];
    const inNear = ns >= 0 && ns < crowd.nearTorsos.count && !hiddenAt(crowd.nearTorsos, ns, m, v);
    const slot = crowd._farAt ? crowd._farAt[i] : i;
    const inFar = slot < crowd.torsos.count && !hiddenAt(crowd.torsos, slot, m, v);
    if (inNear && inFar) bothVisible++;
    else if (inNear) nearOnly++;
    else if (inFar) farOnly++;
    else neitherVisible++;
  }
  return { bothVisible, neitherVisible, farOnly, nearOnly };
}

function makeCrowd(count) {
  const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
  return new Pedestrians({ add() {}, remove() {} }, district, { count });
}
/** Walk the focus to (x,z) at the game's step so the tiers settle honestly. */
function settleAt(crowd, x, z, seconds = 12, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) crowd.update(dt, { x, z });
}

function report() {
  const count = Number(val('--count', 96));
  const at = (val('--at', '43,-44') || '43,-44').split(',').map(Number);
  const crowd = makeCrowd(count);
  settleAt(crowd, at[0], at[1]);
  const b = bill(crowd);
  const c = tierCoverage(crowd);
  console.log(`crowd of ${count}, focus (${at[0]}, ${at[1]}), ${b.limbSlots} limb slots a ped`);
  console.log(`  near tier      ${String(b.nearLive).padStart(3)} peds` +
    `   ${String(b.nearBill).padStart(7)} tris  (${b.perNearPed}/ped)`);
  console.log(`  far tier       ${String(b.drawnFar).padStart(3)} slots drawn` +
    `   ${String(b.farBill).padStart(7)} tris  (${b.farPerPed}/ped)`);
  console.log(`  of those, ${b.hiddenInRange} draw nothing: ${b.wasted} triangles submitted for` +
    ` bodies the near tier is already drawing`);
  console.log(`  crowd total    ${b.total} triangles, of which ${b.wasted}` +
    ` (${(100 * b.wasted / Math.max(1, b.total)).toFixed(1)}%) is invisible`);
  const perm = permutationOk(crowd), col = colourIdentity(crowd);
  console.log(`  packing: ${perm.ok ? 'a permutation' : `BROKEN, ${perm.bad} bad slots`}` +
    `, colours ${col.wrong === 0 ? 'match' : `WRONG on ${col.wrong}`} of ${col.checked} drawn slots`);
  console.log(`\ncoverage: ${c.farOnly} far-only, ${c.nearOnly} near-only,` +
    ` ${c.bothVisible} drawn TWICE, ${c.neitherVisible} drawn NOWHERE`);
  console.log(`  (both and neither must be 0: a ped drawn twice is a double image and a ped`);
  console.log(`   drawn nowhere is a hole in the crowd. Neither is about the triangle count.)`);
  const fail = c.bothVisible || c.neitherVisible || !perm.ok || col.wrong;
  if (fail) { console.log('\nCROWD BILL: FAIL — the tier split is not a partition'); process.exit(1); }
  console.log('\nCROWD BILL: the tier split is a partition; the waste figure above is the lever.');
}

function selftest() {
  let checks = 0, failed = 0;
  const ok = (cond, label, got) => {
    checks++;
    if (cond) console.log(`  ok    ${label}${got !== undefined ? `   ${got}` : ''}`);
    else { failed++; console.log(`  FAIL  ${label}${got !== undefined ? `   ${got}` : ''}`); }
  };
  const crowd = makeCrowd(96);
  settleAt(crowd, 43, -44);
  const b = bill(crowd), c = tierCoverage(crowd);

  console.log('1. the bill agrees with the module\'s own documented figures');
  ok(b.farPerPed === 616, 'far tier is 616 triangles a ped', `${b.farPerPed}`);
  ok(b.perNearPed === 2256, 'near tier is 2,256 a ped, as pedestrians.js states', `${b.perNearPed}`);
  ok(b.nearLive > 0, 'and this focus actually populates the near tier, so the arm measures something',
    `${b.nearLive} near`);

  console.log('2. the split is a partition');
  ok(c.bothVisible === 0, 'no ped is drawn in both tiers', `${c.bothVisible}`);
  ok(c.neitherVisible === 0, 'and none is drawn in neither', `${c.neitherVisible}`);
  ok(c.farOnly + c.nearOnly === crowd.peds.filter(Boolean).length,
    'every live ped is accounted for exactly once',
    `${c.farOnly}+${c.nearOnly} of ${crowd.peds.filter(Boolean).length}`);

  console.log('3. KNOWN BAD: with the near tier off there is nothing to waste');
  const off = makeCrowd(96);
  off.setNearLod(0);
  settleAt(off, 43, -44);
  const bo = bill(off), co = tierCoverage(off);
  ok(bo.nearLive === 0 && bo.nearBill === 0, 'the near tier is empty', `${bo.nearLive} peds, ${bo.nearBill} tris`);
  ok(bo.wasted === 0, '...so the waste is exactly 0, not a leftover', `${bo.wasted}`);
  ok(co.bothVisible === 0 && co.neitherVisible === 0, '...and it is still a partition');

  console.log('4. the far tier is PACKED: nothing inside the drawn range is invisible');
  ok(b.hiddenInRange === 0, 'no drawn far instance is hidden', `${b.hiddenInRange}`);
  ok(b.drawnFar === crowd.peds.filter(Boolean).length - b.nearLive,
    'and the drawn count is alive minus near-held',
    `${b.drawnFar} against ${crowd.peds.filter(Boolean).length} - ${b.nearLive}`);
  // hiddenAt still needs its POSITIVE case exercised, or the two checks above pass
  // for the most flattering possible reason: a predicate that never says "hidden"
  // reports no waste whatever the code does. A near-held ped's own far slot sits
  // outside the prefix and is written with the zero scale, so it is the known-hidden
  // instance this check needs.
  const THREE2 = THREE, mm = new THREE2.Matrix4(), vv = new THREE2.Vector3();
  let outsideHidden = 0, outsideChecked = 0;
  for (let i = 0; i < crowd.count; i++) {
    if (!crowd.peds[i] || crowd._nearSlot[i] < 0) continue;
    outsideChecked++;
    if (hiddenAt(crowd.torsos, crowd._farAt[i], mm, vv)) outsideHidden++;
  }
  ok(outsideChecked > 0 && outsideHidden === outsideChecked,
    'and a near-held ped\'s own far slot, outside the prefix, does read hidden',
    `${outsideHidden}/${outsideChecked}`);
  const nOff = bill(off).hiddenInRange;
  ok(nOff === 0, 'with no near tier at all, nothing reads hidden either', `${nOff}`);

  console.log('4b. the packing is a permutation, and it carries the colours');
  const perm = permutationOk(crowd);
  ok(perm.ok, '_farAt and _farOf are mutually inverse over all slots',
    `${perm.bad ?? 0} bad of ${perm.slots}`);
  const col = colourIdentity(crowd);
  ok(col.checked > 0, 'the colour check reads something', `${col.checked} slots`);
  ok(col.wrong === 0, '...and every drawn slot wears the shirt and skin of the ped it holds',
    `${col.wrong} wrong of ${col.checked}`);
  const permOff = permutationOk(off);
  ok(permOff.ok, 'and with the near tier off it is still a permutation');

  console.log('5. and the total moves the way the tiers say it should');
  ok(b.total === b.farBill + b.nearBill, 'total is the two tiers summed');
  ok(bo.total < b.total, 'the near tier costs more than it saves in the far tier',
    `${bo.total} with it off against ${b.total} with it on`);

  console.log(`\n${checks - failed}/${checks} checks passed`);
  if (failed) process.exit(1);
}

if (has('--selftest')) selftest(); else report();
