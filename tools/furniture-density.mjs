// How much furniture is actually standing on a given stretch of pavement, and
// where the placement rule threw stations away.
//
// A blind reviewer counted ZERO objects on the corridor's right-hand walk -- a
// full shopfront run in front of the deli -- and zero on the Five Points plaza,
// with the nearest furniture a single bin and a single shrub. The district as a
// whole carries roughly 4,600 props, so "add more furniture" is the wrong
// response to that: the question is why THOSE stretches came out empty. This
// answers it by counting placements per metre of kerb in a named band, and by
// recording every station the rule considered and rejected, with the reason.
//
//   node tools/furniture-density.mjs
//   node tools/furniture-density.mjs --band 100,200,-235,-140 --name "corridor right walk"
//   node tools/furniture-density.mjs --selftest
//
// No browser: the dressing pass runs in node, following tools/oak-audit.mjs,
// lamps included -- without lamps every lampClearance() is Infinity and the
// harness dresses a district the page never renders.
import * as THREE from '../vendor/three.module.min.js';
import fs from 'node:fs';
import { StreetFurniture } from '../src/streetfurniture.js';

const arg = (k, dflt) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

/** StreetFurniture that keeps a record of every kerb station and its fate. */
function instrument(fu) {
  const log = [];
  const orig = fu._kerbStation.bind(fu);
  fu._kerbStation = function (emit, st) {
    const before = { ...this.props };
    // Re-evaluate the same three tests the rule uses, so a rejection can be
    // attributed rather than merely counted.
    const road = this.roadClearance(st.x, st.z, -1);
    const bld = this.buildingClearance(st.x, st.z);
    const lamp = this.lampClearance(st.x, st.z);
    orig(emit, st);
    let placed = 0;
    for (const [k, v] of Object.entries(this.props)) placed += v - (before[k] ?? 0);
    log.push({
      x: st.x, z: st.z, placed,
      road: +road.toFixed(2), bld: +bld.toFixed(2), lamp: +lamp.toFixed(2),
      reason: placed > 0 ? null
        : road < 1.5 ? 'road' : bld < 0.8 ? 'building' : lamp < 1.6 ? 'lamp' : 'passed-gate-placed-nothing',
    });
  };
  return log;
}

function dress() {
  const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
  const fu = new StreetFurniture(new THREE.Scene(), { max: 1200 });
  let placed = 0;
  for (const e of d.edges) {
    if (e.r > 6) continue;
    for (let k = 0; k < e.v.length - 1 && placed < 1100; k++) {
      const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 26);
      for (let s = 1; s <= n && placed < 1100; s++) {
        const f = s / (n + 1);
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        const side = s % 2 ? 1 : -1;
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        const off = (e.w / 2 + 1.4) * side;
        fu.addLamp(x + nx * off, z + nz * off, Math.atan2(-nx * side, -nz * side));
        placed++;
      }
    }
  }
  fu.commit();
  const log = instrument(fu);
  // --no-frontage dresses the district WITHOUT the shopfront row, so the before
  // and the after come out of one process against one district and the delta is
  // not a comparison of two runs on two trees. That mistake has already cost
  // this project a review round.
  fu.dressDistrict(d, { audit: true, shopFrontage: !process.argv.includes('no-frontage') &&
    !process.argv.includes('--no-frontage') });
  return { fu, log, d };
}

function bandReport(name, box, fu, log) {
  const [x0, x1, z0, z1] = box;
  const inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const props = (fu.placed ?? []).filter((p) => inBox(p.x, p.z));
  const st = log.filter((s) => inBox(s.x, s.z));
  const byKind = {};
  for (const p of props) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  const byReason = {};
  for (const s of st) if (s.reason) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  const area = (x1 - x0) * (z1 - z0);
  console.log(`\n=== ${name}   x ${x0}..${x1}  z ${z0}..${z1}   (${area} m2)`);
  console.log(`  kerb stations considered : ${st.length}`);
  console.log(`  stations that placed     : ${st.filter((s) => s.placed > 0).length}`);
  console.log(`  rejected, by reason      : ${Object.keys(byReason).length ? JSON.stringify(byReason) : 'none'}`);
  console.log(`  props standing here      : ${props.length}   ${JSON.stringify(byKind)}`);
  console.log(`  props per 1000 m2        : ${(1000 * props.length / area).toFixed(1)}`);
  return { props: props.length, stations: st.length, byReason };
}

// ---------------------------------------------------------------- near field
//
// THE BAND REPORT ABOVE IS THE WRONG INSTRUMENT FOR THE COMPLAINT, and running
// it is what proved that. It says the corridor's right-hand walk carries 4.3
// props per 1000 m2, the same as every other band, with 14 of 14 kerb stations
// placing -- and the reviewer's crop of that exact walk is nine metres of bare
// brick. Both are true: 4.3 per 1000 m2 over that foreground is an EXPECTATION
// of under one object, so half the time it is zero, and a district average
// cannot see that.
//
// So this counts what the reviewer counted: objects that land inside the hero
// FRAME, and inside the exact pixel rectangle the review named. It is a real
// perspective projection through the camera tools/hero-shots.mjs builds -- same
// route waypoints, same pull-in loop, same eye height, target and fov, same
// 1600 x 900 viewport -- so a prop this tool calls visible is a prop that is in
// the picture.
//
// A PLAN-DISTANCE CONE IS NOT GOOD ENOUGH HERE, which is also measured: at 20 m
// radius the corridor camera's cone touches its right-hand wall over about two
// metres of that wall's length, so the number it gives is decided by whether one
// station happened to fall in a 2 m window. The frame is the instrument.
const HERO = [
  { name: 'corridor', wpA: 3, wpB: 4, back: -55, side: 0,
    fov: 55, fwd: 260, height: 2.4, tgtY: 16,
    // The rectangle a blind reviewer cropped and reported as empty brick.
    crop: [1180, 600, 1600, 899] },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7,
    fov: 48, fwd: 200, height: 3.0, tgtY: 12, crop: null },
];
const VW = 1600, VH = 900;          // the hero viewport
const NEAR_R = Number(arg('radius', 35));

// Road furniture and overhead hardware are not what "objects on the walk" means:
// a manhole cover is in the carriageway and a catenary span is 8 m up. They are
// still counted in `inFrame`, and excluded from `onFoot`, so both numbers are
// visible and neither is quietly doing the arguing.
const NOT_ON_FOOT = new Set(['manhole', 'gully', 'span', 'signal', 'treeDetail']);

/** The hero cameras, with the basis they project through. `clearOf` is the
 *  signed clearance test hero-shots.mjs uses to keep the camera out of a wall;
 *  any function with that shape does, which is what lets the self-test drive
 *  this. */
function heroCameras(route, clearOf) {
  return HERO.map((cfg) => {
    const a = route[cfg.wpA], b = route[cfg.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    let back = cfg.back, px = 0, pz = 0;
    for (;;) {
      px = a.x - (dx / len) * back + nx * cfg.side;
      pz = a.z - (dz / len) * back + nz * cfg.side;
      if (clearOf(px, pz) >= 3.0 || back <= 8) break;
      back -= 1;
    }
    // The look-at target hero-shots.mjs uses. It is ABOVE the horizon, so the
    // camera is pitched up and the ground falls in the lower half of the frame;
    // ignoring that pitch would put every prop's screen row several hundred
    // pixels wrong, which is the whole of the reviewer's crop.
    const eye = [px, cfg.height, pz];
    const tgt = [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd];
    let f = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    f = [f[0] / fl, f[1] / fl, f[2] / fl];
    // right = f x up, then up' = right x f. The same basis three.js builds for
    // a lookAt with world up. cross(f, (0,1,0)) = (-f.z, 0, f.x), and the sign
    // is not cosmetic: getting it backwards mirrors the frame, so every prop
    // reads on the wrong side of the picture and the pitch inverts with it. The
    // self-test pins both -- looking east, right is +z, and the horizon sits
    // BELOW centre because the camera is aimed at y = 16 from y = 2.4.
    let r = [-f[2], 0, f[0]];
    const rl = Math.hypot(r[0], r[2]) || 1;
    r = [r[0] / rl, 0, r[2] / rl];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const tanV = Math.tan((cfg.fov * Math.PI) / 360);
    return { name: cfg.name, x: px, z: pz, back, eye, f, r, u, tanV,
      tanH: tanV * (VW / VH), crop: cfg.crop };
  });
}

/** Where a world point lands on the hero frame, or null if it is behind the
 *  camera or outside it. Screen pixels, origin top-left, 1600 x 900. */
function project(cam, x, y, z) {
  const vx = x - cam.eye[0], vy = y - cam.eye[1], vz = z - cam.eye[2];
  const a = vx * cam.f[0] + vy * cam.f[1] + vz * cam.f[2];
  if (a <= 0.05) return null;
  const rr = vx * cam.r[0] + vy * cam.r[1] + vz * cam.r[2];
  const uu = vx * cam.u[0] + vy * cam.u[1] + vz * cam.u[2];
  let ndcX = rr / (a * cam.tanH), ndcY = uu / (a * cam.tanV);
  // A point exactly on the frame edge is in the frame. Without the epsilon a
  // corner lands at 1.0000000000000002 and drops out, which is a silly way to
  // lose the objects nearest the camera - they are the ones at the edges.
  const E = 1e-9;
  if (ndcX < -1 - E || ndcX > 1 + E || ndcY < -1 - E || ndcY > 1 + E) return null;
  ndcX = Math.max(-1, Math.min(1, ndcX));
  ndcY = Math.max(-1, Math.min(1, ndcY));
  return { sx: ((ndcX + 1) / 2) * VW, sy: ((1 - ndcY) / 2) * VH,
    dist: Math.hypot(vx, vz), ahead: a };
}

/** Props that reach the hero frame. `props` is fu.placed, or anything carrying
 *  {kind, x, z, lowY}. */
function nearField(cam, props, R) {
  const out = { inFrame: 0, onFoot: 0, near: 0, nearOnFoot: 0, crop: 0, cropOnFoot: 0,
    left: 0, right: 0, byKind: {} };
  for (const p of props) {
    if (p.kind === 'treeDetail') continue;              // half of a tree, not a prop
    // The prop's CONTACT with the ground, which is the pixel a reviewer counting
    // objects on a pavement is looking at.
    const s = project(cam, p.x, p.lowY ?? -0.09, p.z);
    if (!s) continue;
    const foot = !NOT_ON_FOOT.has(p.kind);
    out.inFrame++;
    if (foot) out.onFoot++;
    if (s.sx >= VW / 2) out.right++; else out.left++;
    if (s.dist <= R) {
      out.near++;
      if (foot) { out.nearOnFoot++; out.byKind[p.kind] = (out.byKind[p.kind] ?? 0) + 1; }
    }
    if (cam.crop && s.sx >= cam.crop[0] && s.sx <= cam.crop[2] &&
        s.sy >= cam.crop[1] && s.sy <= cam.crop[3]) {
      out.crop++;
      if (foot) out.cropOnFoot++;
    }
  }
  return out;
}

function nearFieldReport(fu, d) {
  const cams = heroCameras(d.meta.route, (x, z) => fu.buildingClearance(x, z));
  for (const cam of cams) {
    const n = nearField(cam, fu.placed ?? [], NEAR_R);
    console.log(`\n=== ${cam.name} hero frame   camera (${cam.x.toFixed(1)}, ${cam.z.toFixed(1)}), ` +
      `${VW}x${VH}, projected`);
    console.log(`  props anywhere in the frame   : ${n.inFrame}   (left ${n.left}, right ${n.right})`);
    console.log(`  within ${NEAR_R} m of the camera     : ${n.near}   on the walk ${n.nearOnFoot}   ${JSON.stringify(n.byKind)}`);
    if (cam.crop) {
      console.log(`  IN THE REVIEWER'S CROP  x ${cam.crop[0]}..${cam.crop[2]}, y ${cam.crop[1]}..${cam.crop[3]}` +
        `  : ${n.crop}   on the walk ${n.cropOnFoot}`);
    }
  }
}

function nearFieldSelftest() {
  let fail = 0;
  // A route leg running due east from the origin, so the corridor camera lands
  // at x 55 and every expected pixel can be written down.
  const route = [0, 0, 0, { x: 0, z: 0 }, { x: 100, z: 0 }];
  const cam = heroCameras(route, () => 99)[0];
  const okCam = Math.abs(cam.x - 55) < 1e-6 && Math.abs(cam.z) < 1e-6 &&
    Math.abs(cam.r[2] - 1) < 1e-6;
  console.log(`  camera from the route    : ${okCam ? 'x 55, right = +z' : 'WRONG ' + JSON.stringify(cam)}`);
  if (!okCam) fail++;
  // The pull-in loop, both halves. It only runs while `back > 8`, so on the
  // corridor camera -- which stands at back = -55, FORWARD of its waypoint --
  // it never runs at all and the camera is where the constant says whatever the
  // footprints do. That is hero-shots.mjs's actual behaviour, asserted here
  // rather than assumed: a count taken at a camera this tool placed somewhere
  // else would be a count of the wrong pavement.
  const stuck = heroCameras(route, () => -1)[0];
  const okStuck = stuck.back === -55 && Math.abs(stuck.x - 55) < 1e-6;
  console.log(`  corridor cam never pulls : ${okStuck ? 'back stays -55' : 'WRONG ' + JSON.stringify(stuck)}`);
  if (!okStuck) fail++;
  const pulled = heroCameras(route, (x) => (x < -10 ? -1 : 99))[1];
  const okPull = pulled.back === 10 && Math.abs(pulled.x + 10) < 1e-6 && Math.abs(pulled.z - 7) < 1e-6;
  console.log(`  fivepoints cam pulls in  : ${okPull ? 'back 26 -> 10, off the wall' : 'WRONG ' + JSON.stringify(pulled)}`);
  if (!okPull) fail++;

  // The projection, against pixels derived by hand rather than by running it.
  const onAxis = project(cam, cam.eye[0] + cam.f[0] * 30, cam.eye[1] + cam.f[1] * 30,
    cam.eye[2] + cam.f[2] * 30);
  const okAxis = onAxis && Math.abs(onAxis.sx - VW / 2) < 0.01 && Math.abs(onAxis.sy - VH / 2) < 0.01;
  console.log(`  a point on the view axis : ${okAxis ? 'lands at the frame centre' : 'WRONG ' + JSON.stringify(onAxis)}`);
  if (!okAxis) fail++;
  const at = (dist, rr, uu) => [cam.eye[0] + cam.f[0] * dist + cam.r[0] * rr + cam.u[0] * uu,
    cam.eye[1] + cam.f[1] * dist + cam.r[1] * rr + cam.u[1] * uu,
    cam.eye[2] + cam.f[2] * dist + cam.r[2] * rr + cam.u[2] * uu];
  const edge = project(cam, ...at(20, 20 * cam.tanH, 0));
  const okEdge = edge && Math.abs(edge.sx - VW) < 0.01;
  console.log(`  the right frame edge     : ${okEdge ? 'lands at x = 1600' : 'WRONG ' + JSON.stringify(edge)}`);
  if (!okEdge) fail++;
  const past = project(cam, ...at(20, 20 * cam.tanH * 1.02, 0));
  console.log(`  and 2% beyond it         : ${past === null ? 'off screen' : 'WRONG ' + JSON.stringify(past)}`);
  if (past !== null) fail++;
  // The pitch is not decorative: the camera looks at y = 16 from y = 2.4, so a
  // point on the horizon in front of it is ABOVE the frame centre. Assert the
  // sign, because dropping the target height is the easy way to write this
  // function wrongly and still get plausible-looking pixels.
  const horizon = project(cam, cam.eye[0] + 200, cam.eye[1], cam.eye[2]);
  const okPitch = horizon && horizon.sy > VH / 2 + 20;
  console.log(`  the camera is pitched up : ${okPitch ? 'the horizon sits below centre' : 'WRONG ' + JSON.stringify(horizon)}`);
  if (!okPitch) fail++;

  // The counter. Props placed at chosen pixels by inverting the projection,
  // including two that straddle the crop edges by ten pixels, because an
  // off-by-one on that rectangle is how this metric would quietly flatter the
  // change it exists to measure.
  const put = (px, py, dist, kind = 'bin') => {
    const ndcX = (px / VW) * 2 - 1, ndcY = 1 - (py / VH) * 2;
    const p = at(dist, ndcX * dist * cam.tanH, ndcY * dist * cam.tanV);
    return { kind, x: p[0], z: p[2], lowY: p[1] };
  };
  const props = [
    put(1300, 700, 18),                   // inside the crop
    put(1300, 700, 18, 'manhole'),        // inside it, but in the carriageway
    put(1170, 700, 18),                   // ten pixels left of the crop
    put(1300, 590, 18),                   // ten pixels above it
    put(800, 450, 18),                    // in frame, well outside the crop
    put(800, 450, 90),                    // in frame, but beyond the near radius
    put(800, 450, 18, 'treeDetail'),      // half of a tree, never a prop
    { kind: 'bin', x: cam.eye[0] - 20, z: cam.eye[2], lowY: 0 },   // behind the camera
  ];
  const n = nearField(cam, props, 35);
  const checks = [
    ['counts what is in frame ', n.inFrame === 6, n.inFrame],
    ['drops what is off-radius', n.near === 5, n.near],
    ['separates walk from road', n.onFoot === 5 && n.nearOnFoot === 4, `${n.onFoot}/${n.nearOnFoot}`],
    ['counts the crop exactly ', n.crop === 2 && n.cropOnFoot === 1, `${n.crop}/${n.cropOnFoot}`],
  ];
  for (const [label, ok, got] of checks) {
    console.log(`  ${label} : ${ok ? 'ok' : `WRONG (${got})`}`);
    if (!ok) fail++;
  }
  return fail;
}

function selftest() {
  // The instrument must attribute a rejection to the test that actually failed,
  // and must not report a rejection for a station that placed something. Both
  // are checked against a stub rather than the district, so the assertion is
  // about the bookkeeping and not about this particular city.
  let fail = 0;
  const stub = {
    props: {},
    roadClearance: () => 9, buildingClearance: () => 9, lampClearance: () => 9,
    _kerbStation(emit, st) { if (st.ok) this.props.bin = (this.props.bin ?? 0) + 1; },
  };
  const log = instrument(stub);
  stub._kerbStation(null, { x: 0, z: 0, ok: true });
  stub._kerbStation(null, { x: 1, z: 1, ok: false });
  const a = log[0], b = log[1];
  const ok1 = a.placed === 1 && a.reason === null;
  const ok2 = b.placed === 0 && b.reason === 'passed-gate-placed-nothing';
  console.log(`  station that placed      : ${ok1 ? 'counted 1, no reason' : 'WRONG ' + JSON.stringify(a)}`);
  console.log(`  station that placed none : ${ok2 ? 'counted 0, reason recorded' : 'WRONG ' + JSON.stringify(b)}`);
  if (!ok1) fail++;
  if (!ok2) fail++;
  // A failing clearance must be named, not lumped in with the catch-all.
  const stub2 = { ...stub, props: {}, buildingClearance: () => 0.1,
    _kerbStation(emit, st) { /* gate would have rejected */ } };
  const log2 = instrument(stub2);
  stub2._kerbStation(null, { x: 0, z: 0 });
  const ok3 = log2[0].reason === 'building';
  console.log(`  blocked by a building    : ${ok3 ? "named 'building'" : 'WRONG ' + JSON.stringify(log2[0])}`);
  if (!ok3) fail++;
  fail += nearFieldSelftest();
  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

const { fu, log, d } = dress();
const rep = fu.report();
console.log(`district: ${rep.propCount} props, ${rep.propTriangles} triangles, ${log.length} kerb stations considered`);
const rejected = log.filter((s) => !s.placed);
const allReasons = {};
for (const s of rejected) allReasons[s.reason] = (allReasons[s.reason] ?? 0) + 1;
console.log(`district: ${rejected.length} of ${log.length} stations placed nothing — ${JSON.stringify(allReasons)}`);

const custom = arg('band', null);
if (custom) {
  bandReport(arg('name', 'band'), custom.split(',').map(Number), fu, log);
} else {
  // The two stretches the reviewer called empty, in world coordinates.
  bandReport('corridor right-hand walk (in front of the deli)', [100, 200, -235, -140], fu, log);
  bandReport('Five Points plaza', [-40, 80, -120, -20], fu, log);
  bandReport('Main St band, for comparison', [40, 440, -215, -115], fu, log);
  nearFieldReport(fu, d);
}
