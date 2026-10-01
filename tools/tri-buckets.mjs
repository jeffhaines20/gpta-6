// The one definition of "which subsystem does this mesh belong to".
//
// It lived inside tools/tri-breakdown.mjs's page.evaluate, which was fine while
// one tool needed it. tools/shadow-bill.mjs needs the SAME buckets or its table
// cannot be read beside the other's, and copying the regexes into a second
// page.evaluate is the recurring shape of defect in this repo: patch one tool,
// leave its sibling armed. So it is exported once, with its source, because a
// browser tool has to inject it as text rather than import it.
//
//   node tools/tri-buckets.mjs --selftest
//
// Two of the checks below are regressions of real bugs. A streamer mesh is named
// `chunk:<key>:lod<N>:<part>` and the KEY HOLDS A COMMA, not a colon, so the part
// is everything from the fourth segment on; slicing from the third left 'lod1:road'
// and scattered the streamer into a dozen 'other:' rows. And an unnamed mesh must
// come back 'unnamed' rather than '' or 'other: ', because the caller keys its
// unattributed-detail table on exactly that string - the traffic fleet's three
// shell meshes sat in it carrying 9.4% of the colour pass.

/** Bucket an Object3D. Pure, and must stay pure: it is stringified into a page. */
export function bucketOf(o) {
  let n = o, name = '';
  while (n) { if (n.name) { name = n.name; break; } n = n.parent; }
  const part = /^chunk:/.test(name) ? name.split(':').slice(3).join(':') : name;
  if (/^facade/.test(part)) return 'facade (near LOD)';
  if (/^trim/.test(part)) return 'facade trim (near LOD)';
  if (/^far/.test(part)) return 'buildings (far LOD)';
  if (/^road/.test(part)) return 'roads';
  if (/^kerb/.test(part)) return 'kerbs (near LOD)';
  if (/^zone/.test(part)) return 'ground zones';
  if (/furniture|prop/i.test(name)) return 'street furniture + trees';
  if (/sign/i.test(name)) return 'signage';
  if (/ped|crowd|character/i.test(name)) return 'pedestrians';
  if (/car|vehicle|traffic|pursuit/i.test(name)) return 'vehicles';
  if (/sky|dome/i.test(name)) return 'sky dome';
  return name ? `other: ${part || name}` : 'unnamed';
}

/** The same function as text, for injection into a page.evaluate. */
export const bucketSource = bucketOf.toString();

/** Triangles in a geometry, counting instances. The other half both tools share. */
export function trisOf(geometry, instances = 1) {
  if (!geometry) return 0;
  const n = geometry.index ? geometry.index.count : (geometry.attributes?.position?.count ?? 0);
  return (n / 3) * instances;
}
export const trisSource = trisOf.toString();

if (process.argv.includes('--selftest')) {
  let checks = 0, failed = 0;
  const ok = (cond, label, got) => {
    checks++;
    if (cond) console.log(`  ok    ${label}${got !== undefined ? `   ${got}` : ''}`);
    else { failed++; console.log(`  FAIL  ${label}${got !== undefined ? `   ${got}` : ''}`); }
  };
  const mesh = (name, parent = null) => ({ name, parent });
  const cases = [
    ['facadeWall', 'facade (near LOD)'],
    ['trimCourse', 'facade trim (near LOD)'],
    ['farBlock', 'buildings (far LOD)'],
    ['roadSurface', 'roads'],
    ['kerbFace', 'kerbs (near LOD)'],
    ['zoneGrass', 'ground zones'],
    ['furnitureProps', 'street furniture + trees'],
    ['signage', 'signage'],
    ['pedestrians', 'pedestrians'],
    ['trafficCar:coupe', 'vehicles'],
    ['parkedCar:wagon', 'vehicles'],
    ['playerCar', 'vehicles'],
    ['skyDome', 'sky dome'],
  ];
  for (const [name, want] of cases) ok(bucketOf(mesh(name)) === want, `${name} -> ${want}`, bucketOf(mesh(name)));

  console.log('  -- the two regressions --');
  // The key holds a COMMA, so the part starts at segment four.
  ok(bucketOf(mesh('chunk:3,-2:lod1:road')) === 'roads',
    'a streamer road mesh is a road, not an "other: lod1:road"', bucketOf(mesh('chunk:3,-2:lod1:road')));
  ok(bucketOf(mesh('chunk:-11,4:lod0:facadeWall')) === 'facade (near LOD)',
    'and a streamer facade is a facade', bucketOf(mesh('chunk:-11,4:lod0:facadeWall')));
  ok(bucketOf(mesh('')) === 'unnamed', 'an unnamed mesh reads "unnamed", not "" or "other: "',
    JSON.stringify(bucketOf(mesh(''))));
  ok(bucketOf({ name: '', parent: mesh('signage') }) === 'signage',
    'and it inherits the nearest named ancestor', bucketOf({ name: '', parent: mesh('signage') }));
  // THE INHERITANCE RULE IS CORRECT AND IT IS WHAT HID 31,500 TRIANGLES.
  // The parked pool's three shell meshes were unnamed under `furniture`, so they
  // read as street furniture: a REAL bucket with a REAL name, which is worse than
  // the `unnamed` row because nothing in the table says it could not be
  // attributed, and street furniture prices at x1.41 against vehicles' x2.00.
  // This case is the mechanism, asserted as correct. What it CANNOT see is a car
  // pool that forgets to name itself - there is no scene here - so that check
  // lives in tools/boot-check.mjs, over the live graph.
  ok(bucketOf({ name: '', parent: mesh('furniture') }) === 'street furniture + trees',
    'an unnamed mesh under `furniture` IS street furniture -- so a car pool that does not name itself',
    bucketOf({ name: '', parent: mesh('furniture') }));
  ok(bucketOf({ name: 'parkedCar:coupe', parent: mesh('furniture') }) === 'vehicles',
    '...is only a vehicle once it says so, even under the same parent',
    bucketOf({ name: 'parkedCar:coupe', parent: mesh('furniture') }));

  console.log('  -- known bad: the source must be injectable --');
  const rebuilt = new Function(`return (${bucketSource})`)();
  ok(rebuilt(mesh('trafficCar:wagon')) === 'vehicles',
    'the stringified copy behaves like the original', rebuilt(mesh('trafficCar:wagon')));
  ok(!/\b(require|import)\b/.test(bucketSource) && !bucketSource.includes('=>'),
    'and it closes over nothing, so injecting it cannot fail in a page');
  ok(trisOf({ index: { count: 300 } }) === 100, 'trisOf reads the index when there is one');
  ok(trisOf({ attributes: { position: { count: 300 } } }) === 100, '...and position when there is not');
  ok(trisOf({ index: { count: 300 } }, 30) === 3000, '...and multiplies by the instance count');
  ok(trisOf(null) === 0, '...and a mesh with no geometry is 0, not NaN');

  console.log(`\n${checks - failed}/${checks} checks passed`);
  if (failed) process.exit(1);
}
