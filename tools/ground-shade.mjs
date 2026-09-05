// GROUND DARKENING UNDER AN OBJECT — the metric two blind reviewers used to put
// pedestrian shadows at the top of the defect list.
//
// The claim under test, verbatim: "a litter bin removes ~64% of ground luminance,
// with a hard directional edge; a pedestrian removes 3-12%, across a soft fan
// roughly six times his body width, with no edge and no direction."
//
// ---------------------------------------------------------------------------
// WHY A LAB BENCH AND NOT A SCREEN-SPACE BOX
// ---------------------------------------------------------------------------
// tools/contact.mjs measures fixed image boxes, which is the right instrument for
// "did this change move the frame" and the wrong one for "does THIS object darken
// the ground under it": the crowd is instanced and its population varies 74-96
// alive at the same camera on the same commit, so which body lands in which box
// is not repeatable. Worse, the corridor sidewalk carries a 2.3 m live-oak PIT
// SLAB (src/streetfurniture.js, oakFar) — a flat untextured quad that darkens the
// brick by 35-45% at every hour and does not move with the sun. A probe with one
// sample inside that band and one outside reports a shadow that is not there.
//
// So this builds a BENCH: two subjects standing side by side on the same patch of
// sunlit pavement, in the live district, under the live sun and the live shadow
// pass —
//
//   * a PROXY: a bin-sized cylinder (0.52 m across, 0.92 m tall) on a plain
//     MeshStandardMaterial with castShadow/receiveShadow set the way every prop
//     in src/streetfurniture.js sets them. This is the control: an object that is
//     definitively inside the working prop shadow path.
//   * a PEDESTRIAN: one live ped out of the crowd, teleported to the slot beside
//     the proxy and posed standing.
//
// Both are then measured the same way, and the difference between the two numbers
// is the defect, with the shared frame, sun, camera and pavement cancelling out.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED
// ---------------------------------------------------------------------------
// For a subject of height h standing at ground point P, with L the unit vector
// from the ground toward the sun, the shadow of the body point at height t lands
// at  g(t) = P.xz - L.xz * (t / L.y).  Sampling t over 0.12h..0.95h walks the
// shadow's spine from the contact to the head.
//
//   darkening% = 100 * (1 - mean(lum | subject present) / mean(lum | absent))
//
// measured over discs on that spine, with the subject's own projected silhouette
// excluded so a body pixel can never be read as a dark pavement pixel. The pair
// of frames differs in ONE thing: whether that one subject is drawn.
//
// EDGE WIDTH answers the other half of the reviewer's sentence. At t = 0.55h the
// probe walks a line ACROSS the shadow spine and reports the 10-90% luminance
// transition, in metres. A hard directional shadow terminates in a few
// centimetres; a soft radial blob has no edge to find and the number runs to the
// width of the search.
//
// THE PEDESTRIAN'S NUMBER IS SPLIT IN TWO, because the crowd puts two different
// things on the pavement and they need different fixes: an instanced alpha blob
// (src/pedestrians.js `shadows`, where it still exists) and whatever its body
// contributes to the sun's shadow map. The blob mesh is switched off and the
// present/absent pair is taken again; what is left is the real cast shadow plus
// the screen-space AO the body's depth writes.
//
// WHICH PEDESTRIAN, and it changes the answer: --tier (default far) and --pose
// (default walk). The near tier holds at most twelve peds within 24 m and every
// figure in the frames the reviewers read is far; standing puts the legs together
// into one 0.30 m occluder while mid-stride separates them into two 0.14 m tubes,
// and 0.14 m is 1.2 shadow texels. The defaults are the crowd's normal state, not
// its most flattering one - measured on the same bench, the same sun and the same
// brick, a NEAR STANDING ped darkens the ground 47.1% and the crowd's ordinary
// FAR WALKING one is the number this tool reports by default.
//
// BODY TONES come off the same frame: the rendered R,G,B of the head, torso, upper
// arm, forearms and thigh, read at points taken from the live instance matrices,
// against a patch of the pavement up-sun of the figure. That is the instrument for
// the other two findings of the round - "bare forearms sample 138,80,40 against
// lamp-lit brick at 45-54" and "near-white forearms hung off a navy jacket".
//
// CONTROLS, each earned:
//   * NOISE FLOOR: the same frame captured twice, differenced through the whole
//     pipeline. Any result below it is not a measurement.
//   * SUNLIT CHECK, asked of the GEOMETRY: a ray from the bench toward the sun
//     that hits nothing. A luminance threshold cannot tell "in a building's
//     shadow" from "the sun is low", and a bench in shade reports "nothing casts
//     here" as a finding. Samples that turn out to be shaded anyway are dropped
//     on the evidence of the subject-absent frame, not on a guess.
//   * NOTHING FROM THE PROP KIT UNDERFOOT: a tree pit is a flat quad at pad
//     height that darkens brick 35-45% at every hour, so a height test cannot see
//     it and a bench straddling one measures the pit.
//   * PINNED CROWD: --peds is passed to setPedestrians() before anything is
//     placed, because the population moves the frame triangle count by ~18k.
//   * --selftest: re-measures the proxy with castShadow off, and re-samples the
//     head with its instance colour forced red. A probe that still reports a large
//     darkening for a non-caster, or a neutral head after painting it red, is not
//     measuring what it claims and exits non-zero.
//   * --dilate a,b,c sweeps src/pedestrians.js SHADOW_DILATE in one session. At 0
//     the crowd draws through the custom depth material with the inflation off,
//     which must land on the un-dilated build's number - that is the check that
//     the material's depthPacking matches what three's shadow map reads.
//
// Usage:
//   node tools/ground-shade.mjs --tag before --tod noon --port 8133 --selftest
//   node tools/ground-shade.mjs --tag after --tod noon --port 8133 \
//        --selftest --dilate 0,0.03,0.055,0.09
//   node tools/ground-shade.mjs --tier near --pose stand --port 8133
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TAG = arg('tag', process.env.GS_TAG ?? 'gs');
const TIMES = arg('tod', process.env.GS_TOD ?? 'noon,golden').split(',');
// NEVER 8123: that port belongs to the main tree, and ensureServer() throws
// rather than photograph it. See tools/serve.mjs.
const PORT = Number(arg('port', process.env.GS_PORT ?? 8133));
const PEDS = Number(arg('peds', 96));
const MIN_LIT = Number(arg('min-lit', 24));
const SELFTEST = has('selftest');
// A sweep of src/pedestrians.js SHADOW_DILATE values, measured in ONE session so
// the bench, the sun, the crowd and the streamer are identical across the arms.
// Silently skipped on a build whose crowd has no dilated depth material - which
// is how the "before" arm behaves, and is itself the check that the two arms are
// different builds.
const DILATE = arg('dilate', '') ? arg('dilate', '').split(',').map(Number) : null;
// WHICH PEDESTRIAN. Both of these change the answer and the defaults are the
// crowd's normal state, not the flattering one.
//
//   tier  The near tier holds at most NEAR_POOL = 12 peds within 24 m of the
//         camera; a population of 96 is overwhelmingly FAR, and every figure in
//         the frames the reviewers read is far. Measured standing at 8.5 m, a
//         near-tier ped lands a clear human-shaped shadow on the brick; the
//         reviewers' frames show none. Default far, so the bench asks about the
//         crowd rather than about its best twelve members.
//   pose  Standing puts the legs together, which is a 0.30 m occluder; mid-stride
//         separates them into two 0.14 m tubes, and 0.14 m is 1.2 shadow texels.
//         Default walk, because a crowd walks.
const TIER = arg('tier', 'far');
const POSE = arg('pose', 'walk');
const W = 1600, H = 900;

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** Mean luminance over a filled disc, in image pixels. Returns null off-frame. */
function disc(img, cx, cy, r) {
  const { width, height, channels, data } = img;   // channels, NOT 4 — screenshots are RGB
  let s = 0, n = 0;
  const r2 = r * r;
  for (let y = Math.max(0, Math.round(cy - r)); y <= Math.min(height - 1, Math.round(cy + r)); y++) {
    for (let x = Math.max(0, Math.round(cx - r)); x <= Math.min(width - 1, Math.round(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      s += lum(data, (y * width + x) * channels); n++;
    }
  }
  return n ? { mean: s / n, n } : null;
}

/**
 * Mean R,G,B over a disc, for the body-tone half of the round. Reported as bytes
 * because that is the unit both reviewers quoted their findings in.
 */
export function tones(file, body) {
  const img = readPNG(file);
  const { width, height, channels, data } = img;
  const out = {};
  for (const [name, s] of Object.entries(body)) {
    if (!s) { out[name] = null; continue; }
    let r = 0, g = 0, b = 0, n = 0;
    const r2 = s.r * s.r;
    for (let y = Math.max(0, Math.round(s.y - s.r)); y <= Math.min(height - 1, Math.round(s.y + s.r)); y++) {
      for (let x = Math.max(0, Math.round(s.x - s.r)); x <= Math.min(width - 1, Math.round(s.x + s.r)); x++) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 > r2) continue;
        const i = (y * width + x) * channels;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    out[name] = n ? { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1),
      lum: +((0.2126 * r + 0.7152 * g + 0.0722 * b) / n).toFixed(1), n } : null;
  }
  if (out.ground && out.ground.lum > 0) {
    for (const k of ['forearmL', 'forearmR', 'upperArmL', 'torso', 'head', 'thighL']) {
      if (out[k]) out[k].vsGround = +(out[k].lum / out.ground.lum).toFixed(2);
    }
  }
  return out;
}

/** Luminance at one pixel. */
function px(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  return lum(img.data, (Math.round(y) * img.width + Math.round(x)) * img.channels);
}

/**
 * Ground darkening for one subject, from a present/absent pair.
 * `plan` carries the screen-space sample geometry the page computed.
 */
export function darkening(onFile, offFile, plan, minLit = 0) {
  const on = readPNG(onFile), off = readPNG(offFile);
  const rows = [];
  let dropped = 0;
  for (const s of plan.spine) {
    const a = disc(on, s.x, s.y, s.r), b = disc(off, s.x, s.y, s.r);
    if (!a || !b) continue;
    // A sample that is ALREADY dark with the subject absent is in somebody
    // else's shadow, and it cannot measure this subject's. Dropped on the
    // evidence of the absent frame rather than on a geometric guess.
    if (b.mean < minLit) { dropped++; continue; }
    rows.push({ t: s.t, on: +a.mean.toFixed(2), off: +b.mean.toFixed(2),
      dark: +(100 * (1 - a.mean / b.mean)).toFixed(2), px: a.n });
  }
  const lit = rows.length ? rows.reduce((q, r) => q + r.off, 0) / rows.length : 0;
  const withSub = rows.length ? rows.reduce((q, r) => q + r.on, 0) / rows.length : 0;
  // The headline number is a ratio of MEANS, not a mean of ratios: a sample that
  // lands on near-black pavement would otherwise dominate.
  const dark = lit > 0 ? 100 * (1 - withSub / lit) : 0;

  // Edge: the 10-90% transition across the shadow, in metres.
  let edgeM = null, edge = null;
  if (plan.cross && plan.cross.pts.length > 4) {
    const v = plan.cross.pts.map((p) => ({ s: p.s, l: px(on, p.x, p.y) })).filter((p) => p.l !== null);
    if (v.length > 4) {
      const lo = Math.min(...v.map((p) => p.l)), hi = Math.max(...v.map((p) => p.l));
      if (hi - lo > 3) {
        const at = (frac) => {
          const target = lo + (hi - lo) * frac;
          // First crossing walking from the lit end inward.
          for (let i = 1; i < v.length; i++) {
            if ((v[i - 1].l - target) * (v[i].l - target) <= 0) {
              const f = (target - v[i - 1].l) / ((v[i].l - v[i - 1].l) || 1);
              return v[i - 1].s + f * (v[i].s - v[i - 1].s);
            }
          }
          return null;
        };
        const s90 = at(0.9), s10 = at(0.1);
        if (s90 !== null && s10 !== null) edgeM = +Math.abs(s10 - s90).toFixed(3);
      }
      edge = { lo: +lo.toFixed(1), hi: +hi.toFixed(1), n: v.length };
    }
  }
  return {
    darkPct: +dark.toFixed(2), litMean: +lit.toFixed(2), shadedMean: +withSub.toFixed(2),
    samples: rows.length, droppedInShade: dropped, edgeWidthM: edgeM, edgeRange: edge, rows,
  };
}

// ---------------------------------------------------------------- page-side
// Everything below runs INSIDE the browser and must close over nothing.
async function installBench(page, opts) {
  return page.evaluate(async (o) => {
    const THREE = await import('/vendor/three.module.min.js');
    const D = __district;
    const P = D.pedestrians();

    // --- freeze: nothing may move between paired captures.
    D.setTraffic(0);
    D.sky.cloudWind.set(0, 0);
    if (!P._gsFrozen) { P._gsRealUpdate = P.update.bind(P); P.update = () => {}; P._gsFrozen = true; }

    // --- the proxy: a litter-bin-sized cylinder in the standard prop shadow path.
    if (!D._gsProxy) {
      const geo = new THREE.CylinderGeometry(o.binR, o.binR * 0.88, o.binH, 16, 1);
      geo.translate(0, o.binH / 2, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.72, metalness: 0 });
      const m = new THREE.Mesh(geo, mat);
      m.name = 'gs:proxy';
      m.castShadow = true; m.receiveShadow = true;      // exactly what props:near/far carry
      m.visible = false;
      D.scene.add(m);
      D._gsProxy = m;
    }
    return { ok: true };
  }, opts);
}

/** Find the bench, place both subjects and the camera, return the sample plan. */
async function poseBench(page, opts) {
  return page.evaluate(async (o) => {
    const THREE = await import('/vendor/three.module.min.js');
    const D = __district;
    const P = D.pedestrians();
    const sun = D.tod.sun;
    const scene = D.scene;

    // Sun direction: L points FROM the ground TOWARD the sun.
    const L = new THREE.Vector3().copy(sun.position).sub(sun.target.position).normalize();
    const px0 = -L.z, pz0 = L.x;                       // perpendicular to the sun in XZ
    const pl = Math.hypot(px0, pz0) || 1;
    const perpX = px0 / pl, perpZ = pz0 / pl;

    const r = D.district.meta.route;
    const a = r[3], b = r[4];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;                 // along the street, east
    const sx = -fz, sz = fx;                            // across it

    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const proxy = D._gsProxy;
    const wasVisible = proxy.visible;
    proxy.visible = false;                              // never probe against ourselves

    // Two FLAT candidate lists, built once. intersectObject(scene, true) walks
    // 300+ meshes including the sky dome on every call, and this search fires
    // thousands of rays: this is the difference between a bench search that takes
    // twenty seconds and one that takes ten minutes.
    const isCrowd = (ob) => { for (let n = ob; n; n = n.parent) if (n.name === 'pedestrians') return true; return false; };
    const isSky = (ob) => { for (let n = ob; n; n = n.parent) { const nm = n.name; if (nm === 'sky' || nm === 'skydome' || nm === 'weather') return true; } return false; };
    const groundList = [], castList = [];
    scene.traverse((ob) => {
      if (!ob.isMesh || !ob.visible || ob === proxy || isCrowd(ob) || isSky(ob)) return;
      groundList.push(ob);
      if (ob.castShadow) castList.push(ob);
    });

    const probe = (x, z) => {
      rc.set(new THREE.Vector3(x, 8, z), down);
      const hits = rc.intersectObjects(groundList, false);
      if (!hits.length) return null;
      const top = hits[0];
      return { y: top.point.y, mat: (top.object.material && top.object.material.name) || '',
        name: top.object.name || '' };
    };
    // IS THIS SPOT IN THE SUN? Asked of the geometry, not of the pixels: a ray
    // from just above the pavement toward the sun that hits nothing is a spot the
    // shadow pass will leave lit. A luminance threshold cannot tell "in a
    // building's shadow" from "the sun is low", and a bench in shade reports
    // "nothing casts here" as a finding.
    const sunlit = (x, y, z) => {
      rc.set(new THREE.Vector3(x, y + 0.25, z), L);
      rc.far = 260;
      const hits = rc.intersectObjects(castList, false);
      rc.far = Infinity;
      return hits.length === 0;
    };
    // Nothing standing within `rad` of the point, sampled on a ring. The first cut
    // used 1.2 m and put the bench between two parked cars.
    //
    // AND NOTHING FROM THE PROP KIT UNDERFOOT. A tree pit is a FLAT quad at pad
    // height, so no height test can see it, and it darkens the brick it covers by
    // 35-45% at every hour - the "hard-edged textureless wedge" a reviewer
    // reported on the corridor sidewalk is one of these. A bench half on and half
    // off it would measure the pit and call it a shadow.
    const onProps = (g) => !!g && /^props:/.test(g.name);
    const clear = (x, z, rad) => {
      for (let k = 0; k < 8; k++) {
        const th = (k / 8) * Math.PI * 2;
        const g = probe(x + Math.cos(th) * rad, z + Math.sin(th) * rad);
        if (!g || g.y > 0.30 || onProps(g)) return false;
      }
      return true;
    };

    // Both subject slots straddle the centre along the perpendicular-to-sun axis,
    // so the two shadows are parallel and cannot overlap.
    const half = o.gap / 2;
    const slotsOf = (cx, cz) => ({
      ped: { x: cx - perpX * half, z: cz - perpZ * half },
      bin: { x: cx + perpX * half, z: cz + perpZ * half },
    });

    // The SPINE is not held to the subject surface. At golden hour the sun is
    // 8 degrees up, so a 1.7 m figure throws 8.7 m of shadow and no Main Street
    // sidewalk is 8.7 m wide: requiring brick all the way down the spine has no
    // solution and the first cut of this returned "no slot found" for exactly
    // that reason. What the spine must be is FLAT, UNOBSTRUCTED and SUNLIT — the
    // pair of frames differences the same pixels either way, so the surface under
    // them only has to be the same in both.
    const why = { ground: 0, surface: 0, clear: 0, slots: 0, slotSurface: 0, slotSun: 0, spine: 0 };
    const search = (surf, clearRad, spineT) => {
      for (const along of o.along) {
        for (const across of o.across) {
          const cx = a.x + fx * along + sx * across;
          const cz = a.z + fz * along + sz * across;
          // Cheapest predicates first: one ray, then one ray, then the ring.
          const g = probe(cx, cz);
          if (!g || g.y > 0.30 || g.y < -1 || onProps(g)) { why.ground++; continue; }
          if (surf && g.mat !== surf) { why.surface++; continue; }
          if (!sunlit(cx, g.y, cz)) { why.slotSun++; continue; }
          const SS = slotsOf(cx, cz);
          const gp = probe(SS.ped.x, SS.ped.z), gb = probe(SS.bin.x, SS.bin.z);
          if (!gp || !gb || gp.y > 0.30 || gb.y > 0.30 || onProps(gp) || onProps(gb)) { why.slots++; continue; }
          if (surf && (gp.mat !== surf || gb.mat !== surf)) { why.slotSurface++; continue; }
          if (!sunlit(SS.ped.x, gp.y, SS.ped.z) || !sunlit(SS.bin.x, gb.y, SS.bin.z)) { why.slotSun++; continue; }
          if (!clear(cx, cz, clearRad)) { why.clear++; continue; }
          // Only the NEAR half of the spine has to be provably lit. At golden the
          // far half is 8 m away and crosses the kerb; requiring it to be sunlit
          // has no solution on a street this narrow. Samples that turn out to be
          // in shadow anyway are dropped by darkening(), which can see it in the
          // subject-absent frame - a filter on evidence rather than on geometry.
          let spineOK = true;
          for (const S0 of [SS.ped, SS.bin]) {
            for (let t = 0.25; t <= spineT + 1e-6; t += 0.25) {
              const gx = S0.x - (L.x / L.y) * t, gz = S0.z - (L.z / L.y) * t;
              const sg = probe(gx, gz);
              if (!sg || sg.y > 0.30 || !sunlit(gx, sg.y, gz)) { spineOK = false; break; }
            }
            if (!spineOK) break;
          }
          if (!spineOK) { why.spine++; continue; }
          return { x: cx, z: cz, y: g.y, mat: g.mat, along, across, slots: SS,
            gp: gp.y, gb: gb.y, constraint: `${surf || 'any-ground'} clear${clearRad} spine${spineT}` };
        }
      }
      return null;
    };
    // Preferred surface first, then progressively looser. Which rung it settled
    // for is reported, because "brick" and "asphalt" are not the same measurement
    // and a 2.6 m clearance is not a 1.8 m one.
    let found = null;
    for (const rung of [[o.surface, o.clearRad, 0.9], [o.surface, 1.9, 0.6],
      [o.surfaceFallback ? null : o.surface, 1.9, 0.6], [o.surfaceFallback ? null : o.surface, 1.5, 0.35]]) {
      found = search(rung[0], rung[1], rung[2]);
      if (found) break;
    }
    proxy.visible = wasVisible;
    if (!found) {
      return { ok: false, why: `no clear sunlit slot: rejected by ${JSON.stringify(why)}` };
    }

    const pedPos = found.slots.ped, binPos = found.slots.bin;
    const gy = (x, z) => (D.world && D.world.heightAt ? D.world.heightAt(x, z) : 0) - 0.05;

    // --- proxy
    proxy.visible = true;
    proxy.position.set(binPos.x, gy(binPos.x, binPos.z), binPos.z);
    proxy.updateMatrixWorld();
    const S = found;

    // --- pedestrian: teleport one live ped into the slot and pose it standing.
    let pedIdx = -1;
    for (let i = 0; i < P.count; i++) if (P.peds[i]) { pedIdx = i; break; }
    if (pedIdx < 0) return { ok: false, why: 'no live pedestrian to bench' };
    const ped = P.peds[pedIdx];
    ped.x = pedPos.x; ped.z = pedPos.z;
    // Mid-stride, not at rest: at phase 0.55 of the cycle the legs are at their
    // widest separation, which is the hardest case for a shadow map and the one
    // the street actually shows.
    if (o.pose === 'walk') { ped.v = 1.35; ped.phase = 0.55 * Math.PI * 2; }
    else { ped.v = 0; ped.phase = 0; }
    ped.stride = undefined;
    // Face across the sun so the silhouette is at its widest, which is the
    // hardest case for a shadow to survive and the easiest to see.
    ped.yaw = Math.atan2(perpX, perpZ);
    ped.hscale = 1.0; ped.build = 1.0;
    // Every other ped is walked off the bench so nothing else can shade it.
    for (let i = 0; i < P.count; i++) {
      if (i === pedIdx || !P.peds[i]) continue;
      const q = P.peds[i];
      if (Math.hypot(q.x - S.x, q.z - S.z) < o.clearR) { P._hide(i); P.peds[i] = null; }
    }
    // --- where to stand. Sweep the ring around the bench and keep the standpoint
    // that (a) is on clear ground, (b) has an unobstructed line to the bench, and
    // (c) is closest to the ideal bearing: up-sun and to one side, so the shadows
    // run diagonally into the frame at close to their true length instead of
    // pointing at the lens.
    const wantX = L.x * 0.55 + perpX * 0.85, wantZ = L.z * 0.55 + perpZ * 0.85;
    const wl = Math.hypot(wantX, wantZ) || 1;
    let bestCam = null, bestDot = -2;
    for (let k = 0; k < 36; k++) {
      const th = (k / 36) * Math.PI * 2;
      const dxc = Math.cos(th), dzc = Math.sin(th);
      const cxp = S.x + dxc * o.back, czp = S.z + dzc * o.back;
      const gcam = probe(cxp, czp);
      if (!gcam || gcam.y > 0.30 || gcam.y < -1) continue;
      // Line of sight: nothing between the standpoint and the bench.
      const dir = new THREE.Vector3(S.x - cxp, 0, S.z - czp).normalize();
      rc.set(new THREE.Vector3(cxp, gcam.y + o.camY, czp), dir);
      rc.far = o.back - 1.2;
      const blocked = rc.intersectObject(scene, true)
        .filter((hh) => hh.object.isMesh && hh.object.visible && !isCrowd(hh.object)
          && hh.object !== proxy).length > 0;
      rc.far = Infinity;
      if (blocked) continue;
      const dot = (dxc * wantX + dzc * wantZ) / wl;
      if (dot > bestDot) { bestDot = dot; bestCam = { x: cxp, z: czp, y: gcam.y }; }
    }
    if (!bestCam) return { ok: false, why: 'no clear standpoint around the bench' };
    // HOW HIGH TO STAND depends on the sun. At golden a 1.7 m figure throws 8.7 m
    // of shadow and an eye-height camera sees all of it; at noon it throws 0.44 m,
    // which from eye height is entirely BEHIND the figure. A probe that reports
    // "no shadow at noon" from a 1.9 m camera has measured its own framing. The
    // camera rises with sin(elevation) so the contact is always in view.
    const camH = o.camY + o.camRise * Math.max(0, L.y - 0.25);
    D.setAutopilot(() => {});
    D.freeCam([bestCam.x, bestCam.y + camH, bestCam.z], [S.x, S.y + o.aimY, S.z], o.fov);
    const cam = D.camera;
    cam.updateMatrixWorld();
    // The near tier claims slots by CAMERA distance through onBeforeRender, which
    // has not run yet for this camera; drive it explicitly so the bench ped is
    // posed into whichever tier it will actually be drawn in.
    P._camX = cam.position.x; P._camZ = cam.position.z; P._camSeen = true;
    // setNearLod(0) is the crowd's own harness hook for "the geometry that
    // shipped before the near tier existed", which is what 84 of 96 peds are at
    // any moment.
    P.setNearLod(o.tier === 'near' ? -1 : 0);
    P._assignNearLod(cam.position.x, cam.position.z);
    for (let i = 0; i < P.count; i++) {
      const q = P.peds[i];
      if (!q) { P._hide(i); continue; }
      P._writePose(i, q, 0.838 * q.hscale);
    }
    if (P.shadows) P.shadows.instanceMatrix.needsUpdate = true;
    P.torsos.instanceMatrix.needsUpdate = true;
    P.heads.instanceMatrix.needsUpdate = true;
    P.limbs.instanceMatrix.needsUpdate = true;
    P._syncNearCounts();
    // FLUSH THE COLOUR BUFFERS BY HAND. update() is what normally uploads them
    // and update() is frozen, so without this the near tier draws with the WHITE
    // its instanceColor was preallocated to in the constructor - and the first
    // bench frame came back with a chalk-white figure whose torso, arms and legs
    // were all the same value. That is an artefact of freezing the crowd, not a
    // defect in it, and it would have silently flattened every body tone this
    // probe reports.
    for (const m of [P.torsos, P.heads, P.limbs, P.nearTorsos, P.nearHeads, P.nearLimbs]) {
      if (m && m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    P._colorDirty = false; P._nearColorDirty = false;

    // --- sample plans. Screen projection of the shadow spine on the ground.
    const project = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(cam);
      return { x: (v.x * 0.5 + 0.5) * o.W, y: (-v.y * 0.5 + 0.5) * o.H, z: v.z };
    };
    // World metres per screen pixel at a ground point, for sizing the sample disc.
    const mPerPx = (x, y, z) => {
      const p0 = project(x, y, z), p1 = project(x + 0.25, y, z + 0.25);
      const d = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      return Math.hypot(0.25, 0.25) / d;
    };
    const planFor = (pos, h, bodyR) => {
      const gyy = gy(pos.x, pos.z);
      const spine = [];
      const N = o.spineN;
      for (let k = 0; k < N; k++) {
        const t = h * (0.12 + (0.95 - 0.12) * (k / (N - 1)));
        const gx = pos.x - (L.x / L.y) * t;
        const gz = pos.z - (L.z / L.y) * t;
        const p = project(gx, gyy, gz);
        if (p.x < 2 || p.y < 2 || p.x > o.W - 2 || p.y > o.H - 2 || p.z > 1) continue;
        const mpp = mPerPx(gx, gyy, gz);
        // A disc of bodyR*0.55 metres: inside the shadow's own width at every
        // sun angle this scene reaches, so a sample cannot straddle the edge.
        const rpx = Math.max(1.5, (bodyR * 0.55) / mpp);
        // Never sample the subject's own pixels: skip anything within its
        // projected silhouette.
        const top = project(pos.x, gyy + h, pos.z);
        const base = project(pos.x, gyy, pos.z);
        // Tight, because at noon the sun is 75.6 degrees up and the whole shadow
        // is within half a metre of the feet: a generous exclusion box there
        // throws away every sample there is.
        const halfW = Math.max(3, (bodyR * 0.85) / mPerPx(pos.x, gyy, pos.z));
        const inBody = p.x > base.x - halfW && p.x < base.x + halfW
          && p.y > Math.min(top.y, base.y) - 2 && p.y < base.y + 1;
        if (inBody) continue;
        spine.push({ t: +t.toFixed(3), x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: +rpx.toFixed(1) });
      }
      // Cross-section at t = 0.55h, walked perpendicular to the shadow spine.
      const tc = h * 0.55;
      const cx = pos.x - (L.x / L.y) * tc, cz = pos.z - (L.z / L.y) * tc;
      const pts = [];
      for (let s = -o.crossM; s <= o.crossM + 1e-6; s += o.crossStep) {
        const p = project(cx + perpX * s, gy(cx, cz), cz + perpZ * s);
        if (p.x < 1 || p.y < 1 || p.x > o.W - 1 || p.y > o.H - 1) continue;
        pts.push({ s: +s.toFixed(3), x: +p.x.toFixed(1), y: +p.y.toFixed(1) });
      }
      return { spine, cross: { pts, atT: +tc.toFixed(2) } };
    };

    // --- BODY TONES. The second and third findings of the round are about the
    // pedestrian's own pixels, not the ground's: "bare forearms sample 138,80,40
    // against lamp-lit brick at 45-54" and "near-white forearms hung off a navy
    // jacket ... 112,113,113". Both need the same instrument - the rendered RGB
    // of one named body part - so the bench hands back where each part LANDED,
    // read off the instance matrices rather than recomputed from the skeleton.
    const partAt = (mesh, slot, localY) => {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(slot, m);
      const e = m.elements;
      // Column 1 is the bone's own +Y axis times its length scale, so a point at
      // local (0, localY, 0) is position + col1 * localY.
      const wx2 = e[12] + e[4] * localY, wy2 = e[13] + e[5] * localY, wz2 = e[14] + e[6] * localY;
      const p = project(wx2, wy2, wz2);
      if (p.x < 3 || p.y < 3 || p.x > o.W - 3 || p.y > o.H - 3 || p.z > 1) return null;
      return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: 2.5,
        w: [+wx2.toFixed(2), +wy2.toFixed(2), +wz2.toFixed(2)] };
    };
    const nsA = P._nearSlot[pedIdx];
    const nearT = nsA >= 0;
    const limbMesh = nearT ? P.nearLimbs : P.limbs;
    const limbBase = nearT ? nsA * 14 : pedIdx * 8;
    const body = {
      // The capsule is authored with its pivot at the top cap and its shaft
      // running to local y = -LIMB_CYL; -0.25 is the midpoint of the shaft.
      forearmL: partAt(limbMesh, limbBase + 5, -0.25),
      forearmR: partAt(limbMesh, limbBase + 7, -0.25),
      upperArmL: partAt(limbMesh, limbBase + 4, -0.25),
      thighL: partAt(limbMesh, limbBase + 0, -0.25),
      torso: partAt(nearT ? P.nearTorsos : P.torsos, nearT ? nsA : pedIdx, 0.62),
      head: partAt(nearT ? P.nearHeads : P.heads, nearT ? nsA : pedIdx, -0.02),
    };
    // A patch of the pavement the figure is standing on, up-sun of it so it is
    // never inside its own shadow: the denominator for "3x the ground".
    {
      const gyy = gy(pedPos.x, pedPos.z);
      const rx = pedPos.x + (L.x / L.y) * 1.1, rz = pedPos.z + (L.z / L.y) * 1.1;
      const p = project(rx, gyy, rz);
      body.ground = (p.x > 6 && p.y > 6 && p.x < o.W - 6 && p.y < o.H - 6 && p.z <= 1)
        ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: 5 } : null;
    }

    const pedH = 1.70 * ped.hscale;
    const plans = {
      ped: planFor(pedPos, pedH, 0.185),
      proxy: planFor(binPos, o.binH, o.binR),
    };
    return {
      ok: true, pedIdx, pedPos, binPos, plans, body,
      nearTier: nearT, bare: !!ped.bare,
      pedColors: { skin: ped.skin, shirt: ped.shirt, pants: ped.pants },
      sun: { x: +L.x.toFixed(4), y: +L.y.toFixed(4), z: +L.z.toFixed(4),
        elevDeg: +((Math.asin(L.y) * 180) / Math.PI).toFixed(2) },
      cam: { x: +cam.position.x.toFixed(2), y: +cam.position.y.toFixed(2), z: +cam.position.z.toFixed(2) },
      groundY: +gy(S.x, S.z).toFixed(3),
      surface: S.mat, constraint: S.constraint,
      bench: { x: +S.x.toFixed(2), z: +S.z.toFixed(2), along: S.along, across: S.across,
        camBearingDot: +bestDot.toFixed(3) },
      alive: P.aliveCount,
    };
  }, opts);
}

/** Hide/show one subject. Returns what it actually did, so an arm cannot be silent. */
async function setSubject(page, which, on) {
  return page.evaluate(async ([w, want]) => {
    const THREE = await import('/vendor/three.module.min.js');
    const D = __district, P = D.pedestrians();
    if (w === 'proxy') { D._gsProxy.visible = want; return { proxy: D._gsProxy.visible }; }
    const i = D._gsPedIdx;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    if (!want) {
      D._gsSaved = {
        torso: P.torsos.instanceMatrix.array.slice(i * 16, i * 16 + 16),
        head: P.heads.instanceMatrix.array.slice(i * 16, i * 16 + 16),
        limbs: P.limbs.instanceMatrix.array.slice(i * 8 * 16, i * 8 * 16 + 16 * 8),
        blob: P.shadows ? P.shadows.instanceMatrix.array.slice(i * 16, i * 16 + 16) : null,
        ns: P._nearSlot[i],
        near: null,
      };
      const ns = P._nearSlot[i];
      if (ns >= 0) {
        D._gsSaved.near = {
          torso: P.nearTorsos.instanceMatrix.array.slice(ns * 16, ns * 16 + 16),
          head: P.nearHeads.instanceMatrix.array.slice(ns * 16, ns * 16 + 16),
          limbs: P.nearLimbs.instanceMatrix.array.slice(ns * 14 * 16, ns * 14 * 16 + 16 * 14),
        };
        P.nearTorsos.setMatrixAt(ns, zero); P.nearHeads.setMatrixAt(ns, zero);
        for (let k = 0; k < 14; k++) P.nearLimbs.setMatrixAt(ns * 14 + k, zero);
      }
      P.torsos.setMatrixAt(i, zero); P.heads.setMatrixAt(i, zero);
      if (P.shadows) P.shadows.setMatrixAt(i, zero);
      for (let k = 0; k < 8; k++) P.limbs.setMatrixAt(i * 8 + k, zero);
    } else if (D._gsSaved) {
      const s = D._gsSaved;
      P.torsos.instanceMatrix.array.set(s.torso, i * 16);
      P.heads.instanceMatrix.array.set(s.head, i * 16);
      P.limbs.instanceMatrix.array.set(s.limbs, i * 8 * 16);
      if (P.shadows && s.blob) P.shadows.instanceMatrix.array.set(s.blob, i * 16);
      if (s.near && s.ns >= 0) {
        P.nearTorsos.instanceMatrix.array.set(s.near.torso, s.ns * 16);
        P.nearHeads.instanceMatrix.array.set(s.near.head, s.ns * 16);
        P.nearLimbs.instanceMatrix.array.set(s.near.limbs, s.ns * 14 * 16);
      }
    }
    for (const m of [P.torsos, P.heads, P.limbs, P.shadows, P.nearTorsos, P.nearHeads, P.nearLimbs]) {
      if (m) m.instanceMatrix.needsUpdate = true;
    }
    // Read back the torso's scale so the caller can PROVE the arm took.
    const t = P.torsos.instanceMatrix.array;
    return { pedScaleX: +Math.hypot(t[i * 16], t[i * 16 + 1], t[i * 16 + 2]).toFixed(4) };
  }, [which, on]);
}

// ------------------------------------------------------------------- main
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/ground-shade.mjs')) {
  const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
  console.log(`server ${JSON.stringify(srv)}`);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
  await page.evaluate((n) => __district.setPedestrians(n), PEDS);

  // Stand the streamer up where the bench will be before anything is measured.
  await page.evaluate(() => {
    const r = __district.district.meta.route;
    __district.placeAt(r[3].x + 10, r[3].z);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  });
  {
    let last = -1, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) {
      const m = await page.evaluate(() => __district.worldReport().meshes);
      stable = m === last ? stable + 1 : 0; last = m;
      if (stable < 3) await page.waitForTimeout(2500);
    }
    console.log(`world settled at ${last} chunk meshes`);
  }
  // AND WAIT FOR THE CROWD, separately. The mesh count settles on the streamer's
  // schedule; the crowd fills on the RENDER loop's, and under a loaded box those
  // are minutes apart. A run that froze update() before anybody had spawned came
  // back with "no live pedestrian to bench" on a build whose crowd was perfectly
  // healthy - 96 alive once it had 47 frames instead of 10.
  {
    const want = Math.min(20, Math.max(1, Math.floor(PEDS / 3)));
    try {
      await page.waitForFunction(
        (n) => { const P = __district.pedestrians(); return !!P && P.aliveCount >= n; },
        want, { timeout: 300000, polling: 1000 });
    } catch {
      console.error('the crowd never populated; nothing to bench');
    }
    const alive = await page.evaluate(() => { const P = __district.pedestrians(); return P ? P.aliveCount : 0; });
    console.log(`crowd populated: ${alive} alive of ${PEDS}`);
  }

  const BENCH = {
    // Slots are searched along Main Street east from the corridor hero waypoint,
    // then across it. The reviewers' frames are 10-60 m along this leg.
    // 8..160 m along Main Street east from the corridor hero waypoint, and 3..13 m
    // either side of its centreline: about 2,400 candidate standpoints. It needs
    // to be that many. At golden hour the sun is 8 degrees up and most of this
    // street is in its own buildings' shadow - the first cut searched 312 and the
    // rejection census came back {ground:172, clear:596, slotSun:428, ...}.
    along: Array.from({ length: 39 }, (_, i) => 8 + i * 4),
    across: Array.from({ length: 22 }, (_, i) => (i % 2 ? -1 : 1) * (3 + Math.floor(i / 2))),
    surface: arg('surface', 'sidewalk'),   // the reviewers measured on sunlit brick
    surfaceFallback: !has('strict-surface'),
    // THE PROXY IS PERSON-HEIGHT, and the first cut was not. A 0.92 m litter bin
    // is the object the reviewers used, and at noon it cannot be measured this way
    // at all: the sun is 75.6 degrees up, so a 0.92 m object throws 0.24 m of
    // shadow and every bit of it is inside its own footprint. The probe's own
    // selftest caught it - with the bin's castShadow switched OFF its measured
    // "darkening" only fell 60.7% -> 57.3%, i.e. 94% of what was being read was
    // not a shadow - and refused the run with exit 3. That is the whole reason
    // --selftest exists.
    //
    // 1.70 m tall and 0.52 m across is the control the question actually needs:
    // the SAME HEIGHT as the pedestrian, so the shadow lands in the same place and
    // at the same length, and 3.7x the thickness, which is the one variable under
    // test. A bin-height proxy is still available with --proxy-h, and at noon it
    // will fail the selftest, correctly.
    //
    // ONE MORE THING TO KNOW BEFORE RAISING IT. The standpoint sweep below aims
    // the camera up-sun and to one side, which is mostly ALONG the axis the two
    // subjects are separated on, so at 1.70 m the proxy stands between the lens
    // and the pedestrian's shadow and hides a third of it. That is fine for the
    // proxy's own number and ruins the pedestrian's, and a before/after pair that
    // changes the proxy's height is therefore not a pair at all. Either keep the
    // height fixed across the arms, or fix the standpoint rule first: separating
    // the subjects on `perp` and standing DOWN-sun (want = -L.xz) puts them side
    // by side with both shadows running toward the lens.
    binR: 0.26, binH: Number(arg('proxy-h', 1.70)),
    gap: 2.8,                        // between the two subjects
    clearRad: 2.6,                   // nothing may stand this close to the bench
    clearR: 11,                      // other peds inside this radius are removed
    // WHERE THE CAMERA STANDS IS PART OF THE MEASUREMENT, and the defaults are a
    // close inspection: 8.5 m back, rising with the sun so the contact is always
    // in view. The hero framings are NOT that - they stand at eye height 20-40 m
    // away - and at noon a 1.7 m figure's shadow is 0.44 m long, so from eye
    // height at 30 m it is a few pixels and mostly behind the figure's own feet.
    // --back / --camy / --camrise / --fov reproduce the hero viewing geometry on
    // the same bench, which is how "the shadow is not there" gets separated from
    // "the shadow cannot be seen from there".
    //   close  --back 8.5 --camy 1.9 --camrise 4.6 --fov 40   (default)
    //   hero   --back 30  --camy 2.4 --camrise 0   --fov 48
    back: Number(arg('back', 8.5)), camY: Number(arg('camy', 1.9)),
    camRise: Number(arg('camrise', 4.6)), aimY: 0.55, fov: Number(arg('fov', 40)),
    spineN: 9, crossM: 1.1, crossStep: 0.055,
    tier: TIER, pose: POSE,
    W, H,
  };
  BENCH.binR = Number(arg('proxy-r', BENCH.binR));

  const inst = await installBench(page, BENCH);
  if (!inst.ok) { console.error('bench failed:', inst.why); await browser.close(); process.exit(2); }

  const results = [];
  let floor = null;
  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(3000);
    const posed = await poseBench(page, BENCH);
    if (!posed.ok) {
      // NOT fatal, and this is a finding rather than a failure. At golden hour the
      // sun is 8 degrees up and Main Street east is in its own buildings' shadow
      // end to end - the capture proves it, docs/shots/r2post-corridor-golden.png
      // has no sunlit pavement in the frame at all - so there is no bench to be
      // had there and nothing, bin or person, casts a ground shadow at that hour
      // on that street. Say so and move to the next hour.
      console.log(`\n${tod}: NO BENCH — ${posed.why}`);
      results.push({ tod, benched: false, why: posed.why });
      continue;
    }
    await page.evaluate((i) => { __district._gsPedIdx = i; }, posed.pedIdx);
    // Wait on rendered FRAMES, never on a clock: under SwiftShader a short wait
    // can be less than one frame and the screenshot then belongs to the previous
    // state.
    const settle = async () => {
      const f0 = await page.evaluate(() => __district.frames);
      await page.waitForFunction((f) => __district.frames > f + 3, f0, { timeout: 300000, polling: 200 });
    };
    await settle();

    const shot = async (suffix) => {
      const f = `${OUT}/_gs-${TAG}-${tod}-${suffix}.png`;
      await page.screenshot({ path: f, timeout: 300000 });
      return f;
    };

    const fAll = await shot('all');
    if (!floor) {
      await settle();
      const fAll2 = await shot('noise');
      floor = {
        ped: darkening(fAll, fAll2, posed.plans.ped).darkPct,
        proxy: darkening(fAll, fAll2, posed.plans.proxy).darkPct,
      };
      console.log(`noise floor (same frame twice): ped ${floor.ped}%  proxy ${floor.proxy}%`);
    }

    const offPed = await setSubject(page, 'ped', false);
    await settle();
    const fNoPed = await shot('noped');
    await setSubject(page, 'ped', true);

    const offProxy = await setSubject(page, 'proxy', false);
    await settle();
    const fNoProxy = await shot('noproxy');
    await setSubject(page, 'proxy', true);
    await settle();

    // --- SPLIT THE PEDESTRIAN'S NUMBER IN TWO. The crowd puts two different
    // things on the pavement: an instanced alpha blob (src/pedestrians.js
    // `shadows`) and whatever its BODY contributes to the sun's shadow map. They
    // are indistinguishable in the pair above and they need completely different
    // fixes, so the blob mesh is switched off and the pair is taken again: what
    // is left is the real cast shadow (plus the screen-space AO the body's depth
    // writes). This is the number the round turns on.
    const blobOn = await page.evaluate(() => {
      const P = __district.pedestrians();
      // A build with no contact blob at all reports that, rather than throwing:
      // "there is nothing to switch off" is the after arm's whole point.
      if (!P.shadows) return { blobMesh: false };
      P.shadows.visible = false;
      return { blobMesh: true, blobVisible: P.shadows.visible };
    });
    await settle();
    const fBodyOnly = await shot('noblob');
    await setSubject(page, 'ped', false);
    await settle();
    const fNoPedNoBlob = await shot('noblob-noped');
    await setSubject(page, 'ped', true);
    await page.evaluate(() => { const P = __district.pedestrians(); if (P.shadows) P.shadows.visible = true; });
    await settle();

    // --- AND SPLIT IT AGAIN: how much of the body's contribution is the SUN'S
    // SHADOW and how much is the screen-space AO pass? src/post.js runs SSAO at a
    // 2.2 m world radius and 0.95 strength, which against a 0.4 m body is a halo
    // roughly six times its width - the exact phrase a reviewer used for what the
    // crowd puts on the pavement. With the blob already off, the sun's shadow is
    // switched off too and the pair retaken: what remains is AO alone, and the
    // difference is the cast shadow. Without this the two are indistinguishable
    // and "the crowd is not in the shadow pass" cannot be told from "the crowd is
    // in it and the AO halo is louder".
    await page.evaluate(() => {
      const P = __district.pedestrians();
      if (P.shadows) P.shadows.visible = false;
      const sh = __district.tod.sun.shadow;
      __district._gsShadowWas = sh.intensity;
      sh.intensity = 0;
    });
    await settle();
    const fAoOnly = await shot('noblob-noshadow');
    await setSubject(page, 'ped', false);
    await settle();
    const fAoNoPed = await shot('noblob-noshadow-noped');
    await setSubject(page, 'ped', true);
    const shadowBack = await page.evaluate(() => {
      const P = __district.pedestrians();
      const sh = __district.tod.sun.shadow;
      sh.intensity = __district._gsShadowWas;
      if (P.shadows) P.shadows.visible = true;
      return sh.intensity;
    });
    await settle();

    const ped = darkening(fAll, fNoPed, posed.plans.ped, MIN_LIT);
    const proxy = darkening(fAll, fNoProxy, posed.plans.proxy, MIN_LIT);
    const pedBody = darkening(fBodyOnly, fNoPedNoBlob, posed.plans.ped, MIN_LIT);
    const pedAO = darkening(fAoOnly, fAoNoPed, posed.plans.ped, MIN_LIT);
    // The body-tone half of the round, off the same frame.
    const body = tones(fAll, { ...posed.body });

    // A bench pitched in shade cannot answer the question.
    const litOK = ped.litMean >= MIN_LIT && proxy.litMean >= MIN_LIT;

    const tri = await page.evaluate(() => __district.renderStats());
    results.push({ tod, sun: posed.sun, cam: posed.cam, surface: posed.surface,
      constraint: posed.constraint, bench: posed.bench, tier: TIER, pose: POSE,
      pedIdx: posed.pedIdx, alive: posed.alive, arms: { offPed, offProxy, blobOn },
      litOK, minLit: MIN_LIT, ped, pedBody, pedAO, proxy, body, shadowBack,
      nearTier: posed.nearTier, bare: posed.bare,
      pedColors: posed.pedColors && Object.fromEntries(
        Object.entries(posed.pedColors).map(([k, v]) => [k, '0x' + (v >>> 0).toString(16)])),
      render: tri, noiseFloor: floor });
    console.log(`\n${tod}  sun elev ${posed.sun.elevDeg} deg  surface ${posed.surface}  ` +
      `tier ${TIER}  pose ${POSE}  ` +
      `bench (${posed.bench.x}, ${posed.bench.z})  cam (${posed.cam.x}, ${posed.cam.z})  ` +
      `${litOK ? '' : 'WARNING: BENCH IS NOT SUNLIT  '}peds ${posed.alive}`);
    console.log(`  PROXY (bin-sized, prop shadow path): ${proxy.darkPct}% darkening  ` +
      `lit ${proxy.litMean} -> ${proxy.shadedMean}  edge ${proxy.edgeWidthM ?? 'n/a'} m  n=${proxy.samples}`);
    console.log(`  PED  (crowd, blob + body)          : ${ped.darkPct}% darkening  ` +
      `lit ${ped.litMean} -> ${ped.shadedMean}  edge ${ped.edgeWidthM ?? 'n/a'} m  n=${ped.samples}`);
    console.log(`  PED  (body only, blob off)         : ${pedBody.darkPct}% darkening  ` +
      `lit ${pedBody.litMean} -> ${pedBody.shadedMean}  edge ${pedBody.edgeWidthM ?? 'n/a'} m`);
    console.log(`  PED  (AO only, blob + sun shadow off): ${pedAO.darkPct}% darkening  ` +
      `edge ${pedAO.edgeWidthM ?? 'n/a'} m   => CAST SHADOW alone ` +
      `${(pedBody.darkPct - pedAO.darkPct).toFixed(2)} points`);
    console.log(`  ratio ped/proxy ${(proxy.darkPct ? ped.darkPct / proxy.darkPct : 0).toFixed(3)}` +
      `   body/proxy ${(proxy.darkPct ? pedBody.darkPct / proxy.darkPct : 0).toFixed(3)}`);
    const fmt = (t) => (t ? `${t.r},${t.g},${t.b} lum ${t.lum}` + (t.vsGround ? ` (${t.vsGround}x ground)` : '') : 'off-frame');
    console.log(`  BODY  ${posed.nearTier ? 'near' : 'far'} tier, ${posed.bare ? 'bare' : 'sleeved'} arms, ` +
      `skin 0x${(posed.pedColors.skin >>> 0).toString(16)} shirt 0x${(posed.pedColors.shirt >>> 0).toString(16)}`);
    for (const k of ['ground', 'head', 'torso', 'upperArmL', 'forearmL', 'forearmR', 'thighL']) {
      console.log(`    ${k.padEnd(10)} ${fmt(body[k])}`);
    }

    // --- SHADOW_DILATE sweep. Also the validation that the custom depth material
    // is written in the packing three's shadow map reads: at dilate = 0 the crowd
    // is drawing through MeshDepthMaterial instead of three's own, and if the
    // packing disagreed the number would not land on the un-dilated build's.
    if (DILATE) {
      const have = await page.evaluate(() => {
        const P = __district.pedestrians();
        return !!(P.depthMaterial && P.depthMaterial.userData && P.depthMaterial.userData.inflate);
      });
      if (!have) {
        console.log('  dilate sweep: this build has no dilated depth material — skipped');
      } else {
        const sweep = [];
        await page.evaluate(() => { const P = __district.pedestrians(); if (P.shadows) P.shadows.visible = false; });
        for (const d of DILATE) {
          await page.evaluate((v) => { __district.pedestrians().depthMaterial.userData.inflate.value = v; }, d);
          await settle();
          const f1 = await shot(`dil${String(d).replace('.', 'p')}`);
          await setSubject(page, 'ped', false);
          await settle();
          const f2 = await shot(`dil${String(d).replace('.', 'p')}-noped`);
          await setSubject(page, 'ped', true);
          const r = darkening(f1, f2, posed.plans.ped, MIN_LIT);
          sweep.push({ dilateM: d, darkPct: r.darkPct, edgeWidthM: r.edgeWidthM, samples: r.samples });
          console.log(`  dilate ${d} m -> ped body darkening ${r.darkPct}%  edge ${r.edgeWidthM ?? 'n/a'} m`);
        }
        await page.evaluate(() => { const P = __district.pedestrians(); P.shadows && (P.shadows.visible = true); });
        results[results.length - 1].dilateSweep = sweep;
      }
    }

    if (SELFTEST) {
      // KNOWN-BAD INPUT: the proxy stops casting. A probe that still reports a
      // large darkening is not measuring shadows and must fail.
      await page.evaluate(() => { __district._gsProxy.castShadow = false; });
      await settle();
      const fNoCast = await shot('selftest-nocast');
      await page.evaluate(() => { __district._gsProxy.visible = false; });
      await settle();
      const fNoCastOff = await shot('selftest-nocast-off');
      await page.evaluate(() => { __district._gsProxy.visible = true; __district._gsProxy.castShadow = true; });
      const noCast = darkening(fNoCast, fNoCastOff, posed.plans.proxy, MIN_LIT);
      results[results.length - 1].selftest = { withCast: proxy.darkPct, withoutCast: noCast.darkPct };
      console.log(`  SELFTEST  proxy castShadow off: ${noCast.darkPct}% (was ${proxy.darkPct}%)`);
      if (!(proxy.darkPct > 25 && noCast.darkPct < proxy.darkPct * 0.4)) {
        console.error('SELFTEST FAILED: this probe cannot distinguish a caster from a non-caster.');
        fs.writeFileSync(`docs/ground-shade-${TAG}.json`, JSON.stringify({ tag: TAG, results, errors }, null, 1));
        await browser.close();
        process.exit(3);
      }
      // KNOWN-BAD INPUT for the body-tone sampler: paint this ped's head instance
      // pure red. If the head sample does not go red, the sampler is not on the
      // head and every tone it reports is of some other pixel.
      const before = body.head;
      await page.evaluate(async () => {
        const T = await import('/vendor/three.module.min.js');
        const P = __district.pedestrians(), i = __district._gsPedIdx;
        const ns = P._nearSlot[i];
        const m = ns >= 0 ? P.nearHeads : P.heads, slot = ns >= 0 ? ns : i;
        __district._gsHeadWas = m.instanceColor.array.slice(slot * 3, slot * 3 + 3);
        m.setColorAt(slot, new T.Color(1, 0, 0));
        m.instanceColor.needsUpdate = true;
      });
      await settle();
      const fRedHead = await shot('selftest-redhead');
      const red = tones(fRedHead, { head: posed.body.head });
      await page.evaluate(async () => {
        const P = __district.pedestrians(), i = __district._gsPedIdx;
        const ns = P._nearSlot[i];
        const m = ns >= 0 ? P.nearHeads : P.heads, slot = ns >= 0 ? ns : i;
        m.instanceColor.array.set(__district._gsHeadWas, slot * 3);
        m.instanceColor.needsUpdate = true;
      });
      const ratioBefore = before ? before.r / Math.max(1, before.g) : 0;
      const ratioAfter = red.head ? red.head.r / Math.max(1, red.head.g) : 0;
      results[results.length - 1].selftest.headRedRatio = { before: +ratioBefore.toFixed(2), after: +ratioAfter.toFixed(2) };
      console.log(`  SELFTEST  head R/G with the head painted red: ${ratioAfter.toFixed(2)} (was ${ratioBefore.toFixed(2)})`);
      if (!(ratioAfter > 2.5 && ratioAfter > ratioBefore * 1.8)) {
        console.error('SELFTEST FAILED: the body-tone sampler is not looking at the head.');
        fs.writeFileSync(`docs/ground-shade-${TAG}.json`, JSON.stringify({ tag: TAG, results, errors }, null, 1));
        await browser.close();
        process.exit(3);
      }
      console.log('  SELFTEST PASSED');
    }
  }

  fs.writeFileSync(`docs/ground-shade-${TAG}.json`,
    JSON.stringify({ tag: TAG, peds: PEDS, port: PORT, bench: BENCH, results, errors }, null, 1));
  console.log(`\nwrote docs/ground-shade-${TAG}.json`);
  if (errors.length) console.log('PAGE ERRORS:', errors);
  await browser.close();
}
