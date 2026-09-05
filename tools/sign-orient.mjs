/**
 * Does the lettering on a sign read forwards?
 *
 * Not a derivation — a measurement of the buffers signage.js actually emits.
 * The last three attempts at this class of bug were reasoned out and two of them
 * came out backwards (see the orientRect comment in src/signage.js), so this
 * tool reads the built mesh and asks a question with a mechanical answer:
 *
 *   For each panel quad, walk the vertices to find the world-space direction in
 *   which the texture coordinate u increases. A viewer standing in front of the
 *   panel — looking along -n, upright — has their right hand pointing along
 *   (n.z, 0, -n.x). Text in this atlas reads left-to-right with increasing u, so
 *   the panel reads FORWARDS when those two agree and MIRRORED when they oppose.
 *
 * Both quantities are read off the emitted arrays. Nothing here re-implements
 * the emitter's intent, so the tool cannot inherit the emitter's mistake.
 *
 * Usage:
 *   node tools/sign-orient.mjs                 district-wide census
 *   node tools/sign-orient.mjs --selftest      forwards/mirrored on known input
 */
import { readFileSync } from 'node:fs';

// signage.js paints its atlases at import; positions never depend on a pixel.
// Same no-op 2D context tools/geom-audit.mjs and tools/frontage-stats.mjs install.
if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1, height: 1 };
      return (t[k] = (...a) => {
        if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
            k === 'createPattern' || k === 'createConicGradient') return grad;
        if (k === 'getImageData') {
          const w = a[2] | 0 || 1, h = a[3] | 0 || 1;
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        return undefined;
      });
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }),
  };
}
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

const { districtSignageBuffers, buffers, signPanel, fasciaPlate, shopRect, orientRect } =
  await import('../src/signage.js');
const { edgesOf } = await import('../src/facades.js');

const UP = [0, 1, 0];

/** Orientation of one quad, or null if it is not a near-vertical panel. */
function quadOrientation(pos, nrm, uv, v) {
  const n = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
  if (Math.abs(n[1]) > 0.2) return null;          // floor/ceiling face, no reading direction
  const P = (k) => [pos[(v + k) * 3], pos[(v + k) * 3 + 1], pos[(v + k) * 3 + 2]];
  const U = (k) => uv[(v + k) * 2], V = (k) => uv[(v + k) * 2 + 1];
  // Two corners on the same texture row, differing in u. Whatever the winding
  // correction did to vertex ORDER, each vertex still carries its own uv, so
  // this finds the u axis in world space without assuming any order.
  let a = -1, b = -1;
  for (let i = 0; i < 4 && a < 0; i++) {
    for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      if (Math.abs(V(i) - V(j)) < 1e-6 && Math.abs(U(i) - U(j)) > 1e-6) { a = i; b = j; break; }
    }
  }
  if (a < 0) return null;
  const lo = U(a) < U(b) ? a : b, hi = U(a) < U(b) ? b : a;
  const pl = P(lo), ph = P(hi);
  const du = [ph[0] - pl[0], ph[1] - pl[1], ph[2] - pl[2]];
  const L = Math.hypot(du[0], du[1], du[2]) || 1;
  // Viewer's right = forward x up, forward = -n.
  const right = [
    (-n[1]) * UP[2] - (-n[2]) * UP[1],
    (-n[2]) * UP[0] - (-n[0]) * UP[2],
    (-n[0]) * UP[1] - (-n[1]) * UP[0],
  ];
  const dot = (du[0] * right[0] + du[1] * right[1] + du[2] * right[2]) / L;
  if (Math.abs(dot) < 0.5) return null;           // skewed, not a flat reading face
  const ys = [P(0)[1], P(1)[1], P(2)[1], P(3)[1]];
  return {
    forwards: dot > 0,
    height: +(Math.max(...ys) - Math.min(...ys)).toFixed(2),
    // Canonical UV bounds of the quad, so a cell matches whether or not its u
    // was swapped. (An earlier version wrote V(a) into both v slots -- a and b
    // are chosen to have the SAME v, so it recorded a zero-height rect and
    // matched nothing at all. The census duly reported "0 of 0".)
    rect: [
      Math.min(U(0), U(1), U(2), U(3)), Math.min(V(0), V(1), V(2), V(3)),
      Math.max(U(0), U(1), U(2), U(3)), Math.max(V(0), V(1), V(2), V(3)),
    ],
  };
}

// Which atlas cells carry LETTERING. A mirrored blank swatch is invisible -- a
// plate edge, a post band, a sign back are uniform colour and read the same
// either way -- so counting those as defects buries the signal. The first run of
// this census reported 21.1% mirrored district-wide, and half of that was
// signBox return faces on plain metal, which is not a defect at all: a box has
// four vertical faces and two of them necessarily point the other way.
function textRects() {
  const set = new Map();
  const put = (r) => {
    const k = `${Math.min(r[0], r[2]).toFixed(6)},${Math.max(r[0], r[2]).toFixed(6)},` +
              `${Math.min(r[1], r[3]).toFixed(6)},${Math.max(r[1], r[3]).toFixed(6)}`;
    set.set(k, true);
  };
  for (const kind of ['fascia', 'valance', 'blade', 'mark']) {
    for (let i = 0; i < 512; i++) {
      try { put(shopRect(kind, i)); } catch { break; }
    }
  }
  return set;
}
const TEXT = textRects();
const isText = (r) => TEXT.has(
  `${Math.min(r[0], r[2]).toFixed(6)},${Math.max(r[0], r[2]).toFixed(6)},` +
  `${Math.min(r[1], r[3]).toFixed(6)},${Math.max(r[1], r[3]).toFixed(6)}`);

function census(buf, tag, out) {
  for (let v = 0; v + 3 < buf.pos.length / 3 + 3; v += 4) {
    if ((v + 3) * 3 + 2 >= buf.pos.length) break;
    const o = quadOrientation(buf.pos, buf.nrm, buf.uv, v);
    if (!o) continue;
    if (!isText(o.rect)) continue;
    const key = `${tag} h=${o.height}`;
    if (!out.has(key)) out.set(key, { forwards: 0, mirrored: 0 });
    out.get(key)[o.forwards ? 'forwards' : 'mirrored']++;
  }
}

function selftest() {
  // A wall edge in each winding. edgesOf() flips the normal by ring winding, so
  // these two rings produce the two handednesses the district actually contains.
  const cw = [[0, 0], [30, 0], [30, 20], [0, 20]];
  const ccw = [...cw].reverse();
  const rect = shopRect('fascia', 0);
  let fail = 0;
  for (const [name, ring] of [['cw', cw], ['ccw', ccw]]) {
    const e = edgesOf(ring, { minLen: 6, longest: 1 })[0];
    const cross = e.tx * e.nz - e.tz * e.nx;
    // Control: fasciaPlate is the field-verified path. It must read forwards on
    // BOTH windings; if it does not, the tool's sign convention is wrong and
    // every other number it prints is worthless.
    const f = buffers();
    fasciaPlate(e, 4, 14, 3, 4.5, rect, f.pos, f.nrm, f.uv, f.idx, { col: f.col, tint: [1, 1, 1] });
    const fo = quadOrientation(f.pos, f.nrm, f.uv, 0);
    const ok = fo && fo.forwards;
    if (!ok) fail++;
    console.log(`  ${name.padEnd(4)} cross=${cross.toFixed(0).padStart(2)}  fasciaPlate face: ${ok ? 'forwards' : 'MIRRORED'}`);
    // The parapet pair, emitted exactly as appendBuildingSignage does it: two
    // faces, rt = +/-t, normal = +/-n, and ONE raw rect for both.
    //
    // I guessed the invariant here twice and was wrong twice. First guess: "the
    // s=-1 face is mirrored". Second: "exactly one of the two is mirrored, and
    // which one depends on the winding". Both wrong for the same algebra slip --
    // the NORMAL carries s as well as the tangent does, so in
    //     dot(rt, right) = dot((tx,tz)*s, (nz,-nx)*s) = s^2 * (tx*nz - tz*nx)
    // the s cancels. The two faces of a sign always read the SAME way, and which
    // way is fixed by the ring winding alone.
    //
    // Which makes the shipping defect worse than "one bad face per sign": every
    // parapet sign on a footprint wound one way is mirrored on BOTH faces, and
    // there is no angle from which it reads. The orientRect comment above
    // fasciaPlate counts the district split at 36 edges to 47.
    const raw = [], fixed = [];
    for (const sgn of [1, -1]) {
      for (const [bag, r] of [[raw, rect], [fixed, orientRect(e, rect)]]) {
        const m = buffers();
        signPanel([10, 5, 0], [e.tx * sgn, 0, e.tz * sgn], UP, 6, 1.5, r,
          m.pos, m.nrm, m.uv, m.idx,
          { col: m.col, tint: [1, 1, 1], normal: [e.nx * sgn, 0, e.nz * sgn] });
        const mo = quadOrientation(m.pos, m.nrm, m.uv, 0);
        bag.push(mo ? mo.forwards : null);
      }
    }
    const show = (b) => b.map((x) => (x === null ? '??' : x ? 'fwd' : 'mir')).join(' / ');
    // Raw: both faces agree, and agree with the sign of cross.
    const rawOK = raw[0] !== null && raw[0] === raw[1] && raw[0] === (cross > 0);
    if (!rawOK) fail++;
    console.log(`  ${name.padEnd(4)} raw rect,   s=+1/-1:  ${show(raw)}` +
      `  ${rawOK ? '(both agree, and follow cross -- the bug)' : 'UNEXPECTED'}`);
    // orientRect: both faces forwards, on either winding. This is the fix, and
    // this line is the regression test that keeps it fixed.
    // A double-sided panel: both faces should read forwards, because a blade
    // sign is read from both pavements. signPanel's back-rect default derives
    // the back from the front by swapping u -- measured below, that is the
    // MIRRORED back, not the readable one.
    const ds = (backRect) => {
      const m = buffers();
      signPanel([10, 5, 0], [e.nx, 0, e.nz], UP, 1.2, 1.3, orientRect(e, rect),
        m.pos, m.nrm, m.uv, m.idx,
        { col: m.col, tint: [1, 1, 1], doubleSided: true, normal: [-e.tx, 0, -e.tz], backRect });
      return [0, 4].map((v) => {
        const o = quadOrientation(m.pos, m.nrm, m.uv, v);
        return o ? o.forwards : null;
      });
    };
    const dflt = ds(undefined);
    const same = ds(orientRect(e, rect));
    console.log(`  ${name.padEnd(4)} doubleSided default:  ${show(dflt)}   same-rect back: ${show(same)}`);
    // Both must now read forwards. Before the fix the default gave `fwd / mir`
    // and this line asserted exactly that, to pin the bug down; once signPanel's
    // default became the front's own rect the assertion had to become the
    // regression test it is now, or it would fail on correct code.
    const dsOK = dflt[0] === true && dflt[1] === true &&
                 same[0] === true && same[1] === true;
    if (!dsOK) fail++;

    const fixOK = fixed[0] === true && fixed[1] === true;
    if (!fixOK) fail++;
    console.log(`  ${name.padEnd(4)} orientRect, s=+1/-1:  ${show(fixed)}` +
      `  ${fixOK ? '(both forwards -- the fix)' : 'STILL MIRRORED'}`);
  }
  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

const district = JSON.parse(readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
if (process.argv.includes('--selftest')) {
  process.exit(selftest() ? 1 : 0);
}
const res = districtSignageBuffers(district);
const out = new Map();
for (const bk of res.buckets) census(bk.sign, 'shop', out);
census(res.street, 'street', out);
const rows = [...out.entries()].sort((a, b) => (b[1].forwards + b[1].mirrored) - (a[1].forwards + a[1].mirrored));
let F = 0, M = 0;
console.log('group                 forwards  mirrored');
for (const [k, v] of rows) {
  F += v.forwards; M += v.mirrored;
  const flag = v.mirrored ? '  <-- ' + (100 * v.mirrored / (v.forwards + v.mirrored)).toFixed(0) + '% mirrored' : '';
  console.log(`${k.padEnd(20)} ${String(v.forwards).padStart(8)} ${String(v.mirrored).padStart(9)}${flag}`);
}
console.log(`${'TOTAL'.padEnd(20)} ${String(F).padStart(8)} ${String(M).padStart(9)}   ${(100 * M / (F + M)).toFixed(1)}% mirrored`);
