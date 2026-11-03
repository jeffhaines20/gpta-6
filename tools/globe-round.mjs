// #140: IS A STREET LAMP'S GLOBE ROUND? The gate, its instrument, and the district measurement.
//
//   node tools/globe-round.mjs                 the gate: tools/globe-round.html, two of the district's own
//                                              lamps through the hero cameras that saw them and two more
//   node tools/globe-round.mjs --selftest      the instrument on known-bad masks and planes, and the
//                                              verdict on known-bad reports; no browser
//   node tools/globe-round.mjs --measure       the page's table without the verdict
//   node tools/globe-round.mjs --district      the measurement at the hero cameras in the district: every
//                                              near globe's outline off a magnified mask through its real
//                                              material, off the scene target and off the displayed frame,
//                                              and at noon the globes' shadows, ON against OFF
//
// #136's blind reviewer: at fivepoints dusk the near-left globe at (134,183)-(163,212), 29 px across,
// "holds its left edge at x 134-135 for 20 rows and its right at x 163 for 15": a polygon, not a sphere.
// The globe was SphereGeometry(0.25, 5, 3), 20 triangles; it is a ray-cast sphere on a two-triangle card
// now (src/streetfurniture.js buildGlobeCards). tools/globe-round-math.mjs is how an outline is read and
// why it is read in the angular frame rather than the screen's.
//
// WHAT IT ASSERTS, in order, each meaningful only if the ones above hold:
//   the thing measured   the page's head mesh is the module's: patched material, patched sun-pass material,
//                        LAMP_GLOBES in its buffer; two triangles a globe; every outline read
//   the instrument       the 96x64 reference sphere reads round; every faceted arm's outline off its pixels
//                        agrees with the hull of its own vertices (two protocols, one outline)
//   the defect is live   the 20 facets depart from a sphere by over half a pixel at every camera, 4.5 px at
//                        the reviewer's globe
//   the fix              the shipped globe departs by under half a pixel at every camera, and is the sphere
//                        of the stated radius; the scene target as drawn reads it round to a pixel
//   what it must keep    the depth the AO and the fog read is the sphere's (a card's is not); the shading
//                        under the noon sun is the sphere's (the facets' is not); the noon shadow darkens a
//                        sphere's area of ground (the facets' does not)
//
// WHAT IT DOES NOT SEE, measured rather than assumed:
//   - the frame's EDGE QUALITY. The globe's outline is decided per pixel by a discard, so it gets one
//     coverage sample a pixel where every mesh gets four: on the scene target at night it reads 0.82-0.91
//     px from round at the page's cameras, the 96x64 mesh sphere 0.37-0.50 and the facets 1.6-4.5. The
//     check bounds it at one pixel; the aliasing itself is visible in a capture and is not gated.
//   - the district. The page draws two of its lamps at their own poses through its own cameras with the
//     lamp's own material; tools/globe-round.mjs --district reads the hero frames themselves.
//   - the light. tools/globe-level.mjs owns the globe's luminance against what its light lights.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as RM from './globe-round-math.mjs';

const IS_MAIN = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const argv = IS_MAIN ? process.argv.slice(2) : [];
const KNOWN = new Set(['--selftest', '--district', '--json', '--measure']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/globe-round.mjs [--selftest | --district]`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------------------- the instrument's selftest
/**
 * THE INSTRUMENT ON INPUTS WHOSE ANSWER IS KNOWN, with no browser: an exact sphere rasterised off its own
 * cone of grazing rays, the 20-facet globe rasterised off the hull of its own vertices, a card, a hexagon,
 * an empty crop. Returns the checks so the gate's selftest can count them with its own.
 */
export async function instrumentChecks() {
  const THREE = await import('../vendor/three.module.min.js');
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const cam = { W: 1600, H: 900, fov: 48 };
  const at = (thetaDeg, psi, dist) => {
    const th = thetaDeg * Math.PI / 180;
    return [Math.sin(th) * Math.cos(psi), Math.sin(th) * Math.sin(psi), -Math.cos(th)].map((x) => x * dist);
  };
  const k = 8;
  const raster = (centre, r, inside) => {
    const g = RM.globeOnScreen(centre, r, cam);
    const half = Math.ceil(g.rRad * 1.6) + 2;
    const x0 = Math.floor(g.sx - half), y0 = Math.floor(g.sy - half), w = 2 * half * k, h = 2 * half * k;
    const F = RM.rectFrame(centre);
    const m = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = RM.rectify(RM.cropRay(x0 + (i + 0.5) / k, y0 + (j + 0.5) / k, cam), F);
      m[j * w + i] = p && inside(p, g) ? 1 : 0;
    }
    return { m, w, h, crop: { ...cam, k, x0, y0 }, g };
  };
  const disc = (p, g) => Math.hypot(p[0], p[1]) <= g.tanA;
  const R = 0.25;

  // 1. An exact sphere on the axis.
  const c0 = at(0.5, 0, 15);
  const s0 = raster(c0, R, disc);
  const S0 = RM.silhouetteProfile(s0.m, s0.w, s0.h, s0.crop, c0, R);
  add('an exact sphere on the axis reads round: deviation under 0.012 and its own size to 0.5%',
    S0.dev < 0.012 && Math.abs(S0.size - 1) < 0.005, `dev ${S0.dev?.toFixed(4)} size ${S0.size?.toFixed(4)} over ${S0.n} edge points`);
  // 2. The same sphere 35 degrees off the axis, where the screen shows an ellipse.
  const c1 = at(35, Math.PI - 0.37, 16);
  const s1 = raster(c1, R, disc);
  const S1 = RM.silhouetteProfile(s1.m, s1.w, s1.h, s1.crop, c1, R);
  add('...and 35 degrees off the axis, where its outline on the screen is an ellipse x1.22 long, it reads the same',
    S1.dev < 0.012 && Math.abs(S1.size - 1) < 0.005,
    `dev ${S1.dev?.toFixed(4)} size ${S1.size?.toFixed(4)}; on screen ${S1.globe.rTan.toFixed(1)} x ${S1.globe.rRad.toFixed(1)} px`);
  // KNOWN-BAD INSTRUMENT: a circle fitted in screen pixels condemns that perfect sphere.
  {
    const C = RM.maskComponent(s1.m, s1.w, s1.h, (s1.g.sx - s1.crop.x0) * k, (s1.g.sy - s1.crop.y0) * k);
    const E = RM.maskEdges(C.comp, s1.w, s1.h).map(([u, v]) => [s1.crop.x0 + u / k - s1.g.sx, s1.crop.y0 + v / k - s1.g.sy]);
    let rmin = Infinity, rmax = 0;
    for (const p of E) { const rr = Math.hypot(p[0], p[1]); rmin = Math.min(rmin, rr); rmax = Math.max(rmax, rr); }
    const naive = (rmax - rmin) / rmax;
    add('KNOWN-BAD INSTRUMENT: the same edge measured round its projected centre in SCREEN pixels reads that exact sphere 15%+ out of round',
      naive > 0.15, `screen-space deviation ${naive.toFixed(4)} on a sphere the angular frame reads at ${S1.dev?.toFixed(4)}`);
  }
  // 3. The globe this file is about: SphereGeometry(0.25, 5, 3), rasterised off the hull of its own vertices.
  const geo = new THREE.SphereGeometry(R, 5, 3);
  const pos = geo.attributes.position;
  const agree = [];
  for (const yaw of [0, 0.3, 1.0]) {
    const verts = [];
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      verts.push([v.x + c1[0], v.y + c1[1], v.z + c1[2]]);
    }
    const F = RM.rectFrame(c1);
    const hh = RM.hull2(verts.map((q) => RM.rectify(q, F)));
    const inPoly = (p) => hh.every((a, i) => {
      const b = hh[(i + 1) % hh.length];
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    });
    const sp = raster(c1, R, inPoly);
    const P = RM.silhouetteProfile(sp.m, sp.w, sp.h, sp.crop, c1, R);
    const H = RM.hullRoundness(verts, c1);
    agree.push({ yaw, pix: P.dev, hull: H.dev, sides: H.sides });
  }
  add('the 20-facet globe off its PIXELS agrees with the hull of its VERTICES to 0.01, at three yaws — two protocols, one outline',
    agree.every((a) => Math.abs(a.pix - a.hull) < 0.01),
    agree.map((a) => `yaw ${a.yaw}: pixels ${a.pix.toFixed(4)} hull ${a.hull.toFixed(4)} (${a.sides} sides)`).join('; '));
  add('...and it reads a polygon at every yaw: deviation over 0.15',
    agree.every((a) => a.pix > 0.15), agree.map((a) => a.pix.toFixed(3)).join(' / '));
  // 4. A card.
  {
    const sq = raster(c1, R, (p, g) => Math.abs(p[0]) <= g.tanA && Math.abs(p[1]) <= g.tanA);
    const Q = RM.silhouetteProfile(sq.m, sq.w, sq.h, sq.crop, c1, R);
    add('a square card facing the eye reads 1 - 1/sqrt 2 = 0.2929 to 0.005', Math.abs(Q.dev - (1 - Math.SQRT1_2)) < 0.005,
      `${Q.dev?.toFixed(4)}`);
  }
  // 5. The hull's own arithmetic on a regular hexagon in the gnomonic plane.
  {
    const c = [0, 0, -10], verts = [];
    for (let i = 0; i < 6; i++) verts.push([Math.cos(i * Math.PI / 3), Math.sin(i * Math.PI / 3), -10]);
    const H = RM.hullRoundness(verts, c);
    add('a regular hexagon: 6 sides and 1 - cos 30 = 0.1340', H.sides === 6 && Math.abs(H.dev - (1 - Math.cos(Math.PI / 6))) < 1e-9,
      `${H.sides} sides, ${H.dev.toFixed(6)}`);
  }
  // 6. A frame's plane: an anti-aliased exact sphere at native resolution, 4 x 4 coverage a pixel.
  const plane = (centre, r, inside, bg = 0.1, fg = 5) => {
    const g = RM.globeOnScreen(centre, r, cam), F = RM.rectFrame(centre);
    const out = new Float32Array(cam.W * cam.H).fill(bg);
    const half = Math.ceil(g.rRad * 2.4) + 2;
    for (let y = Math.floor(g.sy - half); y < g.sy + half; y++) for (let x = Math.floor(g.sx - half); x < g.sx + half; x++) {
      if (x < 0 || y < 0 || x >= cam.W || y >= cam.H) continue;
      let n = 0;
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
        const p = RM.rectify(RM.cropRay(x + (a + 0.5) / 4, y + (b + 0.5) / 4, cam), F);
        if (p && inside(p, g)) n++;
      }
      out[y * cam.W + x] = bg + (fg - bg) * n / 16;
    }
    return out;
  };
  const whole = { ...cam, k: 1, x0: 0, y0: 0 };
  {
    const E = RM.radialEdge(plane(c1, R, disc), cam.W, cam.H, whole, c1, R);
    add('a frame\'s anti-aliased exact sphere, read along rays at native resolution, reads round to 0.03 and its size to 1%',
      E.dev < 0.03 && Math.abs(E.size - 1) < 0.01 && E.missed === 0, `dev ${E.dev?.toFixed(4)} size ${E.size?.toFixed(4)} missed ${E.missed}`);
    const F = RM.rectFrame(c1);
    const verts = [];
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      verts.push([v.x + c1[0], v.y + c1[1], v.z + c1[2]]);
    }
    const hh = RM.hull2(verts.map((q) => RM.rectify(q, F)));
    const inPoly = (p) => hh.every((a, i) => {
      const b = hh[(i + 1) % hh.length];
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    });
    const Ep = RM.radialEdge(plane(c1, R, inPoly), cam.W, cam.H, whole, c1, R);
    add('...and the 20-facet globe\'s frame reads the polygon, over 0.15', Ep.dev > 0.15, `dev ${Ep.dev?.toFixed(4)}`);
    // The same globe DARKER than its background (dusk): the crossing is found from either side.
    const Ed = RM.radialEdge(plane(c1, R, disc, 2, 1.2), cam.W, cam.H, whole, c1, R);
    add('...and a globe darker than its background, as at dusk, is read the same way', Ed.dev < 0.03 && Math.abs(Ed.size - 1) < 0.01,
      `dev ${Ed.dev?.toFixed(4)} size ${Ed.size?.toFixed(4)}`);
  }
  // 6b. A frame as the district has it: the globe darker than its background (dusk), a facade behind its
  // lower-left and the bracket running out of it to the left. The rays that leave onto either are not read.
  {
    const g = RM.globeOnScreen(c1, R, cam), F = RM.rectFrame(c1);
    const out = new Float32Array(cam.W * cam.H).fill(2.0);
    const half = Math.ceil(g.rRad * 2.4) + 2;
    for (let y = Math.floor(g.sy - half); y < g.sy + half; y++) for (let x = Math.floor(g.sx - half); x < g.sx + half; x++) {
      if (x < 0 || y < 0 || x >= cam.W || y >= cam.H) continue;
      let n = 0, wall = 0, bar = 0;
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
        const p = RM.rectify(RM.cropRay(x + (a + 0.5) / 4, y + (b + 0.5) / 4, cam), F);
        if (!p) continue;
        if (Math.hypot(p[0], p[1]) <= g.tanA) n++;
        else if (p[0] < -0.6 * g.tanA && p[1] < 0.2 * g.tanA) wall++;
        else if (p[0] < 0 && Math.abs(p[1] + 0.85 * g.tanA) < 0.12 * g.tanA) bar++;
      }
      out[y * cam.W + x] = (1.2 * n + 1.4 * wall + 0.2 * bar + 2.0 * (16 - n - wall - bar)) / 16;
    }
    const E = RM.radialEdge(out, cam.W, cam.H, whole, c1, R);
    const B = RM.radialEdge(out, cam.W, cam.H, whole, c1, R, { keepOccluded: true });
    // 0.06, not the clean frame's 0.03: a ray that grazes the bracket's anti-aliased edge has its crossing
    // pulled outward by up to a pixel (measured 0.0427 of the radius at 250 degrees, beside the bracket
    // at 232-245, on this 19 px globe), and no test on the ray's ends can see a sub-pixel neighbour.
    add('a frame whose bracket and facade meet the outline is read off the rays that leave onto the sky, and reads round to ' +
      'a pixel; KNOWN-BAD INSTRUMENT: reading every ray does not',
      E.dev < 0.06 && E.occluded > 0 && !(B.dev < 0.1),
      `${E.occluded} of ${E.rays} rays not read, dev ${E.dev?.toFixed(4)}; every ray read: dev ${B.dev?.toFixed(4) ?? B.refused}`);
  }
  // 7. Refusals: nothing is not round.
  {
    const flat = new Float32Array(cam.W * cam.H).fill(1);
    const E = RM.radialEdge(flat, cam.W, cam.H, whole, c1, R);
    const empty = RM.silhouetteProfile(new Uint8Array(s1.w * s1.h), s1.w, s1.h, s1.crop, c1, R);
    // The left half of the same crop: the outline runs off its right border.
    const cw = s1.w >> 1, cut = new Uint8Array(cw * s1.h);
    for (let y = 0; y < s1.h; y++) cut.set(s1.m.subarray(y * s1.w, y * s1.w + cw), y * cw);
    const clipped = RM.silhouetteProfile(cut, cw, s1.h, s1.crop, c1, R);
    add('a featureless plane, an empty crop and a crop that cuts the outline are each REFUSED, not read as round',
      !!E.refused && !!empty.refused && !!clipped.refused, `${E.refused} | ${empty.refused} | ${clipped.refused}`);
  }
  // 8. A twin globe in the same crop is not part of the outline.
  {
    const twin = (p, g) => Math.hypot(p[0], p[1]) <= g.tanA || Math.hypot(p[0] - 2.5 * g.tanA, p[1] - 0.3 * g.tanA) <= 0.8 * g.tanA;
    const g = RM.globeOnScreen(c1, R, cam);
    const half = Math.ceil(g.rRad * 3.2) + 2;
    const x0 = Math.floor(g.sx - half), y0 = Math.floor(g.sy - half), w = 2 * half * k, h = 2 * half * k;
    const F = RM.rectFrame(c1);
    const m = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const p = RM.rectify(RM.cropRay(x0 + (i + 0.5) / k, y0 + (j + 0.5) / k, cam), F);
      m[j * w + i] = p && twin(p, g) ? 1 : 0;
    }
    const T = RM.silhouetteProfile(m, w, h, { ...cam, k, x0, y0 }, c1, R);
    add('a second globe in the crop is a second component, and the outline read is the first one\'s',
      T.dev < 0.012 && Math.abs(T.size - 1) < 0.005, `dev ${T.dev?.toFixed(4)} size ${T.size?.toFixed(4)}`);
  }
  add('fewer than 16 edge points is no outline, not a round one', RM.roundness([[1, 0], [0, 1], [-1, 0]], 1) === null);
  return checks;
}
export const INSTRUMENT_CHECKS = 14;



// ------------------------------------------------------------------------------- the district measurement
if (IS_MAIN && argv.includes('--district')) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } = await import('./hero-cams.mjs');
  const { writePNG } = await import('./crop.mjs');
  const { readPNG } = await import('./png.mjs');
  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const PORT = Number(process.env.GLOBE_ROUND_PORT ?? treePort(ROOT));
  const TAG = process.env.GR_TAG ?? 'globeround';
  const OUT = process.env.GR_OUT ?? 'docs/shots';
  const JSON_OUT = process.env.GR_JSON ?? `docs/${TAG}.json`;
  const TIMES = (process.env.GR_TIMES ?? 'dusk,night,noon').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY = (process.env.GR_SHOTS ?? 'fivepoints,corridor').split(',').map((s) => s.trim()).filter(Boolean);
  const NGLOBES = Number(process.env.GR_GLOBES ?? 4);
  const K = Number(process.env.GR_K ?? 8);
  const shots = HERO_FRAMINGS.filter((s) => ONLY.includes(s.name));
  if (shots.length !== ONLY.length) throw new Error(`GR_SHOTS names no such framing: ${ONLY}`);
  fs.mkdirSync(OUT, { recursive: true });
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/?traffic=0`, { waitUntil: 'networkidle', timeout: 300000 });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 600000 });
  await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
  const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
  console.log(`cloud deck: ${froze ? `frozen at ${froze.atSeconds}s` : 'NOT FROZEN'}`);
  await page.evaluate(() => __district.setPedestrians(0));
  const fnSrc = Object.entries(RM).filter(([, f]) => typeof f === 'function')
    .map(([n, f]) => `const ${n} = ${f.toString().replace(/^export\s+/, '')};`).join('\n');
  const SRC = `(() => {\n${fnSrc}\nreturn { ${Object.keys(RM).filter((n) => typeof RM[n] === 'function').join(', ')} };\n})()`;

  const runs = [];
  for (const s of shots) {
    const placed = await placeHeroCam(page, s);
    console.log(`${s.name}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ${placed.clearance} m clear`);
    await settleFrames(page, FRAME_SETTLE, `camera ${s.name}`);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await settleFrames(page, FRAME_SETTLE, `tod ${tod}`);
      const frameFile = `${OUT}/${TAG}-${s.name}-${tod}.png`;
      let frameErr = null;
      try { await page.screenshot({ path: frameFile, timeout: 180000 }); } catch (e) { frameErr = e.message.split('\n')[0]; }
      const r = await page.evaluate(async ({ src, k, nGlobes, isNoon }) => {
        const M = eval(src);   // eslint-disable-line no-eval
        const d = __district, R = d.renderer, post = d.post, cam = d.camera, fur = d.furniture, scene = d.scene;
        const waitFrames = (n) => new Promise((res) => { const f0 = d.frames; const t = () => (d.frames >= f0 + n ? res() : setTimeout(t, 100)); t(); });
        const W = post.hdr.width, H = post.hdr.height;
        const camInfo = { W, H, fov: cam.fov };
        const V3 = cam.position.constructor, M4 = cam.matrixWorld.constructor;
        // THE GLOBES, OFF THE HEAD BUFFER: a globe's centre is its poles' midpoint (tools/kerb-stand.mjs
        // found its bounding box lopsided), its radius the farthest vertex from that centre.
        const hp = fur.heads.geometry.attributes.position;
        // #140's cards put every corner AT the centre and carry the radius in `lampGlobe`, so the poles'
        // midpoint is the centre and the farthest vertex is 0 m out: read the radius off the attribute,
        // and there are no facets for a hull to be taken of.
        const card = fur.heads.geometry.attributes.lampGlobe ?? null;
        const sides = { o: [], i: [] };
        for (let q = 0; q < hp.count; q++) sides[hp.getX(q) > 0 ? 'o' : 'i'].push([hp.getX(q), hp.getY(q), hp.getZ(q), card ? card.getZ(q) : 0]);
        const globeDef = (vs) => {
          if (card) {
            const c = [0, 1, 2].map((a) => vs.reduce((s, v) => s + v[a], 0) / vs.length);
            return { c, r: Math.max(...vs.map((v) => v[3])), verts: null };
          }
          let top = vs[0], bot = vs[0];
          for (const v of vs) { if (v[1] > top[1]) top = v; if (v[1] < bot[1]) bot = v; }
          const c = [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2, (top[2] + bot[2]) / 2];
          let r = 0;
          for (const v of vs) r = Math.max(r, Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]));
          return { c, r, verts: vs };
        };
        const defs = { outer: globeDef(sides.o), inner: globeDef(sides.i) };
        cam.updateMatrixWorld(true);
        const view = cam.matrixWorldInverse;
        const m4 = new M4();
        const list = [];
        for (let i = 0; i < fur.count; i++) {
          fur.heads.getMatrixAt(i, m4);
          for (const [which, g] of Object.entries(defs)) {
            const wc = new V3(...g.c).applyMatrix4(m4);
            const vc = wc.clone().applyMatrix4(view);
            if (!(vc.z < -1)) continue;
            const on = M.globeOnScreen([vc.x, vc.y, vc.z], g.r, camInfo);
            if (on.sx < on.rRad || on.sy < on.rRad || on.sx > W - on.rRad || on.sy > H - on.rRad) continue;
            list.push({ lamp: i, which, r: g.r, world: [wc.x, wc.y, wc.z], view: [vc.x, vc.y, vc.z], on, m: m4.clone() });
          }
        }
        list.sort((a, b) => b.on.rTan - a.on.rTan);
        const picked = list.slice(0, nGlobes);
        // THE FRAME AS DRAWN: the scene target's luminance, rows top-down, read once.
        const half = (rt) => {
          const raw = new Uint16Array(rt.width * rt.height * 4);
          R.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, raw);
          return raw;
        };
        const LUT = new Float32Array(65536);
        for (let v = 0; v < 65536; v++) {
          const sg = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
          LUT[v] = e === 0 ? sg * f * 5.9604644775390625e-8 : e === 31 ? (f ? NaN : sg * Infinity) : sg * Math.pow(2, e - 15) * (1 + f / 1024);
        }
        const lumOf = (raw) => {
          const out = new Float32Array(W * H);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = ((H - 1 - y) * W + x) * 4;
            out[y * W + x] = 0.2126 * LUT[raw[o]] + 0.7152 * LUT[raw[o + 1]] + 0.0722 * LUT[raw[o + 2]];
          }
          return out;
        };
        const lum = lumOf(half(post.hdr));
        // THE MAGNIFIED MASK: only the head mesh, on a layer nothing else is on, so no light and no other
        // object enters; the emissive forced so the globe saturates whatever the hour; k times the frame.
        const RT = post.hdr.constructor;
        const maskOf = (g) => {
          const c = Math.ceil(g.on.rRad * 1.5) + 3;
          const x0 = Math.floor(g.on.sx - c), y0 = Math.floor(g.on.sy - c), size = 2 * c;
          const w = size * k, h = size * k;
          const rt = new RT(w, h);
          const saved = { camLayers: cam.layers.mask, headLayers: fur.heads.layers.mask, ei: fur.headMat.emissiveIntensity,
            clear: R.getClearColor(new (fur.headMat.emissive.constructor)()), alpha: R.getClearAlpha(), bg: scene.background,
            target: R.getRenderTarget() };
          fur.heads.layers.enable(31);
          cam.layers.set(31);
          fur.headMat.emissiveIntensity = 1000;
          scene.background = null;
          cam.setViewOffset(W * k, H * k, x0 * k, y0 * k, w, h);
          R.setRenderTarget(rt);
          R.setClearColor(0x000000, 1);
          R.clear();
          R.render(scene, cam);
          const px = new Uint8Array(w * h * 4);
          R.readRenderTargetPixels(rt, 0, 0, w, h, px);
          cam.clearViewOffset();
          cam.layers.mask = saved.camLayers;
          fur.heads.layers.mask = saved.headLayers;
          fur.headMat.emissiveIntensity = saved.ei;
          scene.background = saved.bg;
          R.setClearColor(saved.clear, saved.alpha);
          R.setRenderTarget(saved.target);
          rt.dispose();
          const mask = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = px[((h - 1 - y) * w + x) * 4] > 127 ? 1 : 0;
          return { mask, w, h, crop: { ...camInfo, k, x0, y0 } };
        };
        const globes = [];
        for (const g of picked) {
          const mk = maskOf(g);
          const S = M.silhouetteProfile(mk.mask, mk.w, mk.h, mk.crop, g.view, g.r);
          // THE SECOND PROTOCOL: the hull of the globe's own vertices, carried into view space.
          const Hh = defs[g.which].verts
            ? M.hullRoundness(defs[g.which].verts.map((v) => { const q = new V3(v[0], v[1], v[2]).applyMatrix4(g.m).applyMatrix4(view); return [q.x, q.y, q.z]; }), g.view)
            : { sides: null, dev: null };
          const E = M.radialEdge(lum, W, H, { ...camInfo, k: 1, x0: 0, y0: 0 }, g.view, g.r);
          // A small picture of the mask, top-down, one native pixel a k-block, for looking at.
          let bin = '';
          for (let i = 0; i < mk.mask.length; i += 0x8000) bin += String.fromCharCode.apply(null, mk.mask.subarray(i, i + 0x8000));
          globes.push({ lamp: g.lamp, which: g.which, r: g.r, world: g.world.map((v) => +v.toFixed(3)),
            dist: +g.on.dist.toFixed(2), theta: +(g.on.theta * 180 / Math.PI).toFixed(2), sx: +g.on.sx.toFixed(1), sy: +g.on.sy.toFixed(1),
            rTan: +g.on.rTan.toFixed(2), rRad: +g.on.rRad.toFixed(2), view: g.view,
            mask: { dev: S.dev, fitDev: S.fitDev, rms: S.rms, size: S.size, off: S.off, n: S.n, refused: S.refused ?? null,
              profile: S.profile, resolution: S.resolution, w: mk.w, h: mk.h, crop: mk.crop, png: btoa(bin) },
            hull: Hh,
            hdr: { dev: E.dev, fitDev: E.fitDev, rms: E.rms, size: E.size, missed: E.missed, refused: E.refused ?? null,
              inside: E.inside, outside: E.outside, contrast: E.contrast, profile: E.profile } });
        }
        // THE SHADOW, at noon: the frame with the head mesh casting and without, nothing else moved.
        let shadow = null;
        if (isNoon) {
          await waitFrames(3);
          const on = lumOf(half(post.hdr));
          fur.heads.castShadow = false;
          await waitFrames(3);
          const off = lumOf(half(post.hdr));
          fur.heads.castShadow = true;
          await waitFrames(2);
          const back = lumOf(half(post.hdr));
          // Where each globe's shadow should fall: down the sun's ray to the ground plane.
          const s = d.tod.sunDirection(new V3());
          const ground = 0.02;
          const pred = [];
          for (let i = 0; i < fur.count; i++) {
            fur.heads.getMatrixAt(i, m4);
            for (const [which, g] of Object.entries(defs)) {
              const wc = new V3(...g.c).applyMatrix4(m4);
              const t = (wc.y - ground) / s.y;
              const P = new V3(wc.x - s.x * t, ground, wc.z - s.z * t);
              const vp = P.clone().applyMatrix4(view);
              if (!(vp.z < -0.5)) continue;
              const ndc = P.clone().project(cam);
              if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
              const sx = (ndc.x + 1) / 2 * W, sy = (1 - ndc.y) / 2 * H;
              // its size on screen: the ellipse's semi-axes on the ground (r across, r / sin(el) along) at
              // that depth, through the vertical fov's pixels per metre; a sizing, not a fit
              const f = (H / 2) / Math.tan(cam.fov * Math.PI / 360);
              const across = f * g.r / -vp.z, along = f * g.r / s.y / -vp.z;
              pred.push({ lamp: i, which, sx: +sx.toFixed(1), sy: +sy.toFixed(1), depth: +(-vp.z).toFixed(2),
                world: [+P.x.toFixed(2), +P.z.toFixed(2)], pxAcross: +across.toFixed(1), pxAlong: +along.toFixed(1) });
            }
          }
          // The difference, and its connected pieces.
          const diff = new Float32Array(W * H);
          let drift = 0;
          let nonFinite = 0;
          for (let i = 0; i < W * H; i++) {
            diff[i] = off[i] - on[i];
            // The scene target carries a few non-finite texels (the composite sanitises them); a NaN here
            // made the first run's drift read NaN, so they are counted and left out.
            const dd = Math.abs(back[i] - on[i]);
            if (Number.isFinite(dd)) drift = Math.max(drift, dd); else nonFinite++;
          }
          const lab = new Int32Array(W * H).fill(-1);
          const comps = [];
          const thr = (i) => diff[i] > 0.02 * off[i] && diff[i] > 1e-4;
          for (let i0 = 0; i0 < W * H; i0++) {
            if (lab[i0] >= 0 || !thr(i0)) continue;
            const id = comps.length, st = [i0];
            lab[i0] = id;
            let area = 0, sx = 0, sy = 0, peak = 0, sumC = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, offSum = 0, onSum = 0;
            while (st.length) {
              const j = st.pop(), x = j % W, y = (j / W) | 0;
              area++; sx += x; sy += y;
              const c = 1 - on[j] / off[j];
              peak = Math.max(peak, c); sumC += c; offSum += off[j]; onSum += on[j];
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              for (const q of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) {
                if (q >= 0 && lab[q] < 0 && thr(q)) { lab[q] = id; st.push(q); }
              }
            }
            comps.push({ area, cx: +(sx / area).toFixed(1), cy: +(sy / area).toFixed(1), box: [x0, y0, x1, y1],
              peak: +peak.toFixed(4), mean: +(sumC / area).toFixed(4), meanOff: +(offSum / area).toFixed(4), meanOn: +(onSum / area).toFixed(4) });
          }
          comps.sort((a, b) => b.area - a.area);
          for (const p of pred) {
            let best = null;
            for (const c of comps) {
              const dd = Math.hypot(c.cx - p.sx, c.cy - p.sy);
              if (!best || dd < best.d) best = { d: dd, c };
            }
            p.nearest = best ? { d: +best.d.toFixed(1), ...best.c } : null;
          }
          let changed = 0;
          for (let i = 0; i < W * H; i++) if (diff[i] > 1e-4) changed++;
          shadow = { sun: [s.x, s.y, s.z], predicted: pred, comps: comps.slice(0, 30), compCount: comps.length, changed,
            drift: +drift.toExponential(3), nonFinite };
        }
        return { W, H, fov: cam.fov, inFrame: list.length, globes, shadow,
          level: fur.globeReport ? fur.globeReport() : null };
      }, { src: SRC, k: K, nGlobes: NGLOBES, isNoon: tod === 'noon' });
      // The displayed frame: the same ray read on the PNG's linear luminance.
      let png = null;
      if (!frameErr) {
        const img = readPNG(frameFile);
        const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        const L = new Float32Array(img.width * img.height);
        for (let i = 0; i < img.width * img.height; i++) {
          const o = i * img.channels;
          L[i] = 0.2126 * lin(img.data[o]) + 0.7152 * lin(img.data[o + 1]) + 0.0722 * lin(img.data[o + 2]);
        }
        png = r.globes.map((g) => {
          const E = RM.radialEdge(L, img.width, img.height, { W: r.W, H: r.H, fov: r.fov, k: 1, x0: 0, y0: 0 }, g.view, g.r);
          return { dev: E.dev, fitDev: E.fitDev, size: E.size, missed: E.missed, refused: E.refused ?? null,
            inside: E.inside, outside: E.outside, profile: E.profile };
        });
      }
      for (const [gi, g] of r.globes.entries()) {
        const m = g.mask;
        if (m.png) {
          const raw = Buffer.from(m.png, 'base64');
          const rgb = Buffer.alloc(m.w * m.h * 3);
          for (let i = 0; i < m.w * m.h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = raw[i] ? 255 : 0;
          writePNG(`${OUT}/${TAG}-${s.name}-${tod}-mask${gi}.png`, m.w, m.h, rgb);
          delete m.png;
        }
        g.png = png ? png[gi] : null;
      }
      const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : '-');
      console.log(`\n${s.name}/${tod}: ${r.inFrame} globes in frame; level ${r.level ? `1/${(1 / r.level.level).toFixed(1)}` : '?'}`);
      for (const g of r.globes) {
        console.log(`  #${g.lamp} ${g.which.padEnd(5)} ${String(g.dist).padStart(6)} m, ${String(g.theta).padStart(5)} deg off axis, ` +
          `at (${g.sx}, ${g.sy}), ${g.rTan} x ${g.rRad} px`);
        console.log(`      mask x${K}: dev ${f(g.mask.dev)} fitDev ${f(g.mask.fitDev)} size ${f(g.mask.size)}  ` +
          `hull: ${g.hull.sides ?? '-'} sides dev ${f(g.hull.dev)}  ` +
          `hdr: dev ${f(g.hdr.dev)} size ${f(g.hdr.size)}${g.hdr.refused ? ` REFUSED ${g.hdr.refused}` : ''}  ` +
          `frame: dev ${f(g.png?.dev)} size ${f(g.png?.size)}${g.png?.refused ? ` REFUSED ${g.png.refused}` : ''}` +
          `${g.mask.refused ? `  MASK REFUSED ${g.mask.refused}` : ''}`);
        console.log(`      in px at the globe's tangential radius: mask ${f(g.mask.dev * g.rTan, 2)}, hull ${f(g.hull.dev === null ? NaN : g.hull.dev * g.rTan, 2)}, ` +
          `hdr ${f(g.hdr.dev * g.rTan, 2)}, frame ${f(g.png?.dev * g.rTan, 2)}`);
      }
      if (r.shadow) {
        console.log(`  noon shadows: ${r.shadow.predicted.length} predicted in frame, ${r.shadow.compCount} pieces changed, ` +
          `${r.shadow.changed} px over 1e-4; frame-to-frame drift ${r.shadow.drift} (${r.shadow.nonFinite} non-finite texels left out)`);
        for (const p of r.shadow.predicted.sort((a, b) => a.depth - b.depth).slice(0, 12)) {
          console.log(`    #${p.lamp} ${p.which.padEnd(5)} at (${p.sx}, ${p.sy}) ${p.depth} m, ${p.pxAcross} x ${p.pxAlong} px predicted; ` +
            (p.nearest ? `nearest piece ${p.nearest.d} px off: ${p.nearest.area} px, box ${p.nearest.box.join(',')}, ` +
              `darkening peak ${p.nearest.peak} mean ${p.nearest.mean}` : 'nothing changed'));
        }
      }
      runs.push({ shot: s.name, tod, placed, frameFile, frameErr, ...r });
      fs.writeFileSync(JSON_OUT, JSON.stringify({ runs, errors, partial: true }, null, 1));
    }
  }
  fs.writeFileSync(JSON_OUT, JSON.stringify({ runs, errors, partial: false }, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
  await browser.close();
  if (errors.length) { console.log('page errors:', errors.slice(0, 5)); process.exit(1); }
}

// ------------------------------------------------------------------------------- the verdict
/** Fixed, so a check cannot vanish when a population is empty. */
export const CHECK_COUNT = 13;
/**
 * HALF A PIXEL: the most a globe's outline may depart from the sphere's, at the globe's own size on
 * screen (tangential radius). It is the pixel grid's own limit — a departure under half a pixel cannot
 * move a pixel centre across the edge — and it is read at EVERY camera, so a geometry that is round
 * enough at 29 px and polygonal from under the lamp fails where it fails. The 96x64 reference sphere
 * reads 0.12-0.13 px at every camera (the mask's 1/16 px resolution, twice), the 20 facets 1.5-7.9 px.
 */
export const OUTLINE_PX = 0.5;

/** THE VERDICT, as a pure function of the page's report. Every read goes through an accessor. */
export function verdict(r) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const f = (v, d = 3) => (fin(v) === null ? 'absent' : Number(v).toFixed(d));
  const M = r.module ?? {}, B = r.buffer ?? {}, T = r.triangles ?? {};
  const runs = Array.isArray(r.runs) ? r.runs : [];
  const armOf = (x, a) => (x && x.arms && x.arms[a]) || {};
  const px = (x, a) => { const d = fin(armOf(x, a).outline?.dev), rt = fin(x.rTan); return d !== null && rt !== null ? d * rt : null; };
  const every = (pred) => runs.length > 0 && runs.every(pred);

  // --- the thing measured is the module's
  const globes = Array.isArray(M.globes) ? M.globes : [];
  const bufG = Array.isArray(B.globes) ? B.globes : [];
  const same = globes.length > 0 && bufG.length === globes.length && globes.every((g) => bufG.some((b) =>
    Math.abs(b[0] - g.x) < 1e-5 && Math.abs(b[1] - g.y) < 1e-5 && Math.abs(b[2] - g.z) < 1e-5 && Math.abs(b[3] - g.r) < 1e-6));
  add('the page\'s globe is the module\'s: its head mesh draws through the patched material, casts through the patched depth material, and its buffer carries LAMP_GLOBES',
    M.material === 'lit' && M.depthMaterial === 'depth' && M.castShadow === true && same &&
      Array.isArray(B.attributes) && B.attributes.includes('lampGlobe'),
    `material ${M.material ?? 'absent'}, sun-pass material ${M.depthMaterial ?? 'absent'}, casts ${M.castShadow}; buffer ${JSON.stringify(bufG)} against ${JSON.stringify(globes.map((g) => [g.x, g.y, g.z, g.r]))}`);
  // --- the price
  add('THE PRICE: the head buffer is two triangles a globe, where the facets were twenty',
    globes.length > 0 && T.shipped === 2 * globes.length && T.old === 20 * globes.length,
    `shipped ${T.shipped ?? 'absent'}, old ${T.old ?? 'absent'}, ico1 ${T.ico1 ?? 'absent'} a lamp, for ${globes.length} globes`);
  // --- the thing happened
  const ARMS = ['shipped', 'old', 'ico1', 'sphere'];
  const refused = runs.flatMap((x) => ARMS.filter((a) => !(armOf(x, a).outline?.n > 0) || armOf(x, a).outline?.refused)
    .map((a) => `${x.cam}/${x.gi}/${a}: ${armOf(x, a).outline?.refused ?? 'absent'}`));
  add('every arm\'s outline was read at every camera and globe, none refused',
    runs.length >= 6 && refused.length === 0, refused.length ? refused.slice(0, 4).join('; ') : `${runs.length} globes x ${ARMS.length} arms`);
  // --- the instrument
  const sphereWorst = runs.length ? Math.max(...runs.map((x) => px(x, 'sphere') ?? Infinity)) : null;
  add(`the instrument reads the reference 96x64 sphere round at every camera: under ${OUTLINE_PX} px`,
    sphereWorst !== null && sphereWorst <= OUTLINE_PX, `worst ${f(sphereWorst, 3)} px`);
  const disagree = runs.flatMap((x) => ['old', 'ico1', 'sphere'].filter((a) => {
    const p = fin(armOf(x, a).outline?.dev), h = fin(armOf(x, a).hull?.dev), rt = fin(x.rTan);
    return p === null || h === null || rt === null || Math.abs(p - h) > 0.01 + 0.15 / rt;
  }).map((a) => `${x.cam}/${x.gi}/${a} pixels ${f(armOf(x, a).outline?.dev, 4)} hull ${f(armOf(x, a).hull?.dev, 4)}`));
  add('...and off the PIXELS every faceted arm agrees with the hull of its own VERTICES, to 0.01 plus the mask\'s resolution',
    runs.length > 0 && disagree.length === 0, disagree.length ? disagree.slice(0, 4).join('; ') : `${runs.length * 3} pairs`);
  // --- the defect is live
  const oldPx = runs.map((x) => px(x, 'old'));
  const fp = runs.find((x) => x.cam === 'fp171' && x.gi === 0);
  add('KNOWN-BAD, LIVE: the 20-facet globe departs from a sphere by more than that at every camera, and by over 3 px at the reviewer\'s globe',
    every((x) => (px(x, 'old') ?? 0) > OUTLINE_PX) && fp && (px(fp, 'old') ?? 0) > 3,
    `${oldPx.map((v) => f(v, 2)).join(' / ')} px; the reviewer's ${fp ? f(px(fp, 'old'), 2) : 'absent'} px`);
  // --- the fix
  const shipPx = runs.map((x) => px(x, 'shipped'));
  add(`THE FIX: the shipped globe's outline departs from the sphere's by under ${OUTLINE_PX} px at every camera`,
    every((x) => { const v = px(x, 'shipped'); return v !== null && v <= OUTLINE_PX; }),
    `${shipPx.map((v) => f(v, 2)).join(' / ')} px`);
  const sizes = runs.map((x) => fin(armOf(x, 'shipped').outline?.size));
  add('...and it is the sphere of the stated radius, not a smaller or a larger one: its fitted size within 1% at every camera',
    sizes.length > 0 && sizes.every((v) => v !== null && Math.abs(v - 1) <= 0.01), sizes.map((v) => f(v, 4)).join(' / '));
  // --- what a frame shows
  const hdrShip = fp ? fin(armOf(fp, 'shipped').hdr?.dev) : null, hdrOld = fp ? fin(armOf(fp, 'old').hdr?.dev) : null;
  add('the frame shows it: the scene target as drawn at night reads the shipped globe at the reviewer\'s camera round to a pixel and the facets not',
    hdrShip !== null && hdrOld !== null && fp && hdrShip * fp.rTan <= 1 && hdrOld * fp.rTan > 3,
    `shipped ${f(hdrShip, 4)} (${fp ? f(hdrShip * fp.rTan, 2) : '-'} px), facets ${f(hdrOld, 4)} (${fp ? f(hdrOld * fp.rTan, 2) : '-'} px)`);
  // --- the depth
  const deps = runs.filter((x) => x.depth);
  const dShip = deps.map((x) => fin(x.depth.shipped?.worst)), dCard = deps.map((x) => fin(x.depth.card?.worst));
  add('the depth the AO and the fog read is the sphere\'s front, within 2 cm over every globe pixel; KNOWN-BAD, LIVE: a card through its centre is not, by over 10 cm',
    deps.length > 0 && dShip.every((v) => v !== null && v <= 0.02) && dCard.every((v) => v !== null && v >= 0.1) &&
      deps.every((x) => x.depth.shipped?.n > 100),
    `shipped worst ${dShip.map((v) => f(v, 4)).join(' / ')} m, card ${dCard.map((v) => f(v, 3)).join(' / ')} m`);
  // --- the shading
  const shades = runs.filter((x) => x.shading && x.shading.noon);
  const sShip = shades.map((x) => fin(x.shading.noon.shipped?.p95)), sOld = shades.map((x) => fin(x.shading.noon.old?.p95));
  add('the shading is a sphere\'s: under the noon sun the shipped globe matches the 96x64 sphere to 2% at p95 over its inside; KNOWN-BAD, LIVE: the facets miss by over 10%',
    shades.length > 0 && sShip.every((v) => v !== null && v <= 0.02) && sOld.every((v) => v !== null && v >= 0.1) &&
      shades.every((x) => x.shading.noon.px > 100 && !(x.shading.noon.shipped?.missing > 0)),
    `shipped p95 ${sShip.map((v) => f(v, 4)).join(' / ')}, facets ${sOld.map((v) => f(v, 3)).join(' / ')}`);
  // --- the shadow
  const sh = r.shadows ?? {};
  const ratios = (a) => (Array.isArray(sh[a]) ? sh[a].map((g) => fin(g.ratio)) : []);
  const shipR = ratios('shipped'), oldR = ratios('old');
  add('the shadow: at noon the shipped globes darken a sphere\'s area of ground, x0.95 to x1.05 for each globe',
    shipR.length === globes.length && shipR.length > 0 && shipR.every((v) => v !== null && v >= 0.95 && v <= 1.05),
    `shipped ${shipR.map((v) => 'x' + f(v, 3)).join(', ')}; the 96x64 sphere ${ratios('sphere').map((v) => 'x' + f(v, 3)).join(', ')}`);
  add('KNOWN-BAD, LIVE: the facets\' shadow is outside that band',
    oldR.length > 0 && oldR.every((v) => v !== null && (v < 0.95 || v > 1.05)), `facets ${oldR.map((v) => 'x' + f(v, 3)).join(', ')}`);
  return checks;
}

/**
 * A REAL REPORT, trimmed to what the verdict reads, from the passing run of the page at the commit that
 * made the globe a ray-cast sphere (six significant figures), so "correct" in the selftest is the shape and
 * the magnitude the page produces. It records the reviewer's globe at 0.13 px from round (the 20 facets
 * 4.50 px), the depth within 3.3 mm (a card 21 cm out), the noon shading within 0.8% at p95 of the 96x64
 * sphere (the facets 100%), and the noon shadow at x1.001 of a sphere's (the facets x0.674).
 */
const FIXTURE = {
  module: {"globes":[{"x":2.2,"y":7.7,"z":0,"r":0.25},{"x":-1,"y":7.66,"z":0,"r":0.22}],"material":"lit","depthMaterial":"depth","castShadow":true},
  buffer: {"globes":[[2.200000047683716,7.699999809265137,0,0.25],[-1,7.659999847412109,0,0.2199999988079071]],"attributes":["position","normal","lampGlobe"]},
  triangles: {"shipped":4,"old":40,"ico1":160,"sphere":24192},
  runs: [
    {"cam":"fp171","gi":0,"dist":19.772,"rTan":15.5412,"arms":{"shipped":{"outline":{"dev":0.00858231,"fitDev":0.00859766,"size":1.00004,"n":1104,"refused":null},"hull":null,"hdr":{"dev":0.0551145,"size":0.999953,"refused":null}},"old":{"outline":{"dev":0.289861,"fitDev":0.25554,"size":0.877459,"n":964,"refused":null},"hull":{"dev":0.291008,"sides":7},"hdr":{"dev":0.286136,"size":0.867895,"refused":null}},"ico1":{"outline":{"dev":0.0658325,"fitDev":0.0678316,"size":0.964222,"n":1082,"refused":null},"hull":{"dev":0.0638433,"sides":13},"hdr":{"dev":0.0691444,"size":0.964526,"refused":null}},"sphere":{"outline":{"dev":0.0077226,"fitDev":0.00774712,"size":0.999761,"n":1104,"refused":null},"hull":{"dev":0.000734948,"sides":204},"hdr":{"dev":0.0291667,"size":0.999372,"refused":null}}},"shading":{"noon":{"px":752,"shipped":{"p50":0.0011427,"p95":0.00790096,"missing":0},"old":{"p50":0.0892971,"p95":1.00029,"missing":75},"ico1":{"p50":0.0195725,"p95":0.131919,"missing":0}}},"depth":{"shipped":{"worst":0.00330815,"n":925},"card":{"worst":0.205623,"n":925}}},
    {"cam":"cor283","gi":0,"dist":22.517,"rTan":9.93782,"arms":{"shipped":{"outline":{"dev":0.0130307,"fitDev":0.0132476,"size":1.00006,"n":648,"refused":null},"hull":null,"hdr":{"dev":0.0825806,"size":0.99662,"refused":null}},"old":{"outline":{"dev":0.214674,"fitDev":0.213519,"size":0.882007,"n":580,"refused":null},"hull":{"dev":0.215552,"sides":7},"hdr":{"dev":0.193968,"size":0.872246,"refused":null}},"ico1":{"outline":{"dev":0.0601757,"fitDev":0.0623895,"size":0.959859,"n":632,"refused":null},"hull":{"dev":0.0556948,"sides":15},"hdr":{"dev":0.0701738,"size":0.957951,"refused":null}},"sphere":{"outline":{"dev":0.0121295,"fitDev":0.0122144,"size":0.999781,"n":646,"refused":null},"hull":{"dev":0.000753762,"sides":204},"hdr":{"dev":0.0423522,"size":1.00177,"refused":null}}}},
    {"cam":"cor283","gi":1,"dist":23.327,"rTan":8.75229,"arms":{"shipped":{"outline":{"dev":0.0145044,"fitDev":0.0146492,"size":0.999115,"n":580,"refused":null},"hull":null,"hdr":{"dev":0.0919474,"size":0.993526,"refused":null}},"old":{"outline":{"dev":0.175741,"fitDev":0.206916,"size":0.880828,"n":522,"refused":null},"hull":{"dev":0.176162,"sides":8},"hdr":{"dev":0.162458,"size":0.876309,"refused":null}},"ico1":{"outline":{"dev":0.0611686,"fitDev":0.0629188,"size":0.964819,"n":566,"refused":null},"hull":{"dev":0.0558999,"sides":12},"hdr":{"dev":0.0544578,"size":0.963584,"refused":null}},"sphere":{"outline":{"dev":0.0137234,"fitDev":0.014323,"size":0.999533,"n":580,"refused":null},"hull":{"dev":0.000783454,"sides":206},"hdr":{"dev":0.0517658,"size":0.998239,"refused":null}}}},
    {"cam":"under","gi":0,"dist":8.1523,"rTan":26.5216,"arms":{"shipped":{"outline":{"dev":0.00443233,"fitDev":0.00444248,"size":0.999993,"n":1696,"refused":null},"hull":null,"hdr":{"dev":0.0272458,"size":0.994973,"refused":null}},"old":{"outline":{"dev":0.297011,"fitDev":0.331021,"size":0.87779,"n":1478,"refused":null},"hull":{"dev":0.295502,"sides":7},"hdr":{"dev":0.283951,"size":0.868719,"refused":null}},"ico1":{"outline":{"dev":0.0607408,"fitDev":0.0602065,"size":0.966775,"n":1676,"refused":null},"hull":{"dev":0.057232,"sides":12},"hdr":{"dev":0.059956,"size":0.966501,"refused":null}},"sphere":{"outline":{"dev":0.00495684,"fitDev":0.00496626,"size":0.999562,"n":1696,"refused":null},"hull":{"dev":0.000788902,"sides":154},"hdr":{"dev":0.0189115,"size":0.998493,"refused":null}}},"shading":{"noon":{"px":1976,"shipped":{"p50":0.000372535,"p95":0.00194315,"missing":0},"old":{"p50":0.0902293,"p95":4.31217,"missing":317},"ico1":{"p50":0.0227974,"p95":0.450565,"missing":0}}},"depth":{"shipped":{"worst":0.00175182,"n":2188},"card":{"worst":0.249934,"n":2188}}},
    {"cam":"under","gi":1,"dist":9.76665,"rTan":20.458,"arms":{"shipped":{"outline":{"dev":0.00610354,"fitDev":0.00611859,"size":1.00005,"n":1344,"refused":null},"hull":null,"hdr":{"dev":0.0445138,"size":0.998477,"refused":null}},"old":{"outline":{"dev":0.172658,"fitDev":0.179209,"size":0.879024,"n":1216,"refused":null},"hull":{"dev":0.17156,"sides":7},"hdr":{"dev":0.170268,"size":0.874995,"refused":null}},"ico1":{"outline":{"dev":0.0579597,"fitDev":0.060575,"size":0.966928,"n":1318,"refused":null},"hull":{"dev":0.0536748,"sides":13},"hdr":{"dev":0.0574361,"size":0.9665,"refused":null}},"sphere":{"outline":{"dev":0.00629863,"fitDev":0.00631233,"size":0.999743,"n":1344,"refused":null},"hull":{"dev":0.000784717,"sides":170},"hdr":{"dev":0.0249078,"size":0.999672,"refused":null}}},"shading":{"noon":{"px":1183,"shipped":{"p50":0.000726554,"p95":0.00475528,"missing":0},"old":{"p50":0.071711,"p95":2.4933,"missing":137},"ico1":{"p50":0.017074,"p95":0.267924,"missing":0}}},"depth":{"shipped":{"worst":0.00835162,"n":1378},"card":{"worst":0.209421,"n":1378}}},
    {"cam":"level","gi":0,"dist":12.7279,"rTan":16.9825,"arms":{"shipped":{"outline":{"dev":0.00687618,"fitDev":0.00689877,"size":1.00072,"n":1088,"refused":null},"hull":null,"hdr":{"dev":0.0408491,"size":1.00297,"refused":null}},"old":{"outline":{"dev":0.220585,"fitDev":0.212112,"size":0.890022,"n":988,"refused":null},"hull":{"dev":0.222709,"sides":6},"hdr":{"dev":0.215524,"size":0.88265,"refused":null}},"ico1":{"outline":{"dev":0.065944,"fitDev":0.0694231,"size":0.95991,"n":1074,"refused":null},"hull":{"dev":0.0626366,"sides":14},"hdr":{"dev":0.0746085,"size":0.958915,"refused":null}},"sphere":{"outline":{"dev":0.00683607,"fitDev":0.00685725,"size":0.999885,"n":1088,"refused":null},"hull":{"dev":0.000512675,"sides":184},"hdr":{"dev":0.0218586,"size":1.00091,"refused":null}}}},
    {"cam":"level","gi":1,"dist":15.1588,"rTan":12.6894,"arms":{"shipped":{"outline":{"dev":0.0100172,"fitDev":0.0100082,"size":0.999603,"n":816,"refused":null},"hull":null,"hdr":{"dev":0.0675828,"size":0.995144,"refused":null}},"old":{"outline":{"dev":0.173231,"fitDev":0.192488,"size":0.894859,"n":746,"refused":null},"hull":{"dev":0.17528,"sides":6},"hdr":{"dev":0.177908,"size":0.887783,"refused":null}},"ico1":{"outline":{"dev":0.0562722,"fitDev":0.0568043,"size":0.966282,"n":796,"refused":null},"hull":{"dev":0.0533124,"sides":10},"hdr":{"dev":0.0709503,"size":0.963975,"refused":null}},"sphere":{"outline":{"dev":0.0100172,"fitDev":0.0101594,"size":0.999701,"n":816,"refused":null},"hull":{"dev":0.000836745,"sides":167},"hdr":{"dev":0.039295,"size":0.998677,"refused":null}}}},
  ],
  shadows: {"shipped":[{"gi":0,"ratio":1.00089},{"gi":1,"ratio":1.00094}],"old":[{"gi":0,"ratio":0.67402},{"gi":1,"ratio":0.673775}],"ico1":[{"gi":0,"ratio":0.928456},{"gi":1,"ratio":0.929062}],"sphere":[{"gi":0,"ratio":0.998587},{"gi":1,"ratio":0.999136}]},
};

/** The verdict on the real report and on known-bad versions of it. */
export function verdictChecks() {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const good = FIXTURE;
  const bad = (fn) => { const c = structuredClone(good); fn(c); return c; };
  const failing = (r) => verdict(r).filter((c) => !c.ok).map((c) => c.name);
  const fails = (r, needle) => failing(r).some((n) => n.includes(needle));
  add('a real passing report passes every check', failing(good).length === 0, failing(good).join(' | ') || `${verdict(good).length} checks`);
  add('and the check COUNT is fixed', verdict(good).length === CHECK_COUNT, `${verdict(good).length} of ${CHECK_COUNT}`);
  add('an EMPTY report fails every check rather than throwing or shrinking',
    verdict({}).length === CHECK_COUNT && failing({}).length === CHECK_COUNT, `${verdict({}).length} checks, ${failing({}).length} failed`);
  // The defect shipped: the facets' readings in the shipped arm.
  const facets = bad((c) => { for (const x of c.runs) { x.arms.shipped.outline = structuredClone(x.arms.old.outline); x.arms.shipped.hdr = structuredClone(x.arms.old.hdr); } });
  add('KNOWN-BAD: the 20-facet globe shipped fails the fix, the size and the frame',
    fails(facets, 'THE FIX') && fails(facets, 'stated radius') && fails(facets, 'the frame shows it'), failing(facets).join(' | '));
  // A card shipped: square outline 1 - 1/sqrt 2 out, card depth, a square's shadow.
  const card = bad((c) => {
    for (const x of c.runs) { x.arms.shipped.outline.dev = 0.2929; x.arms.shipped.outline.size = 1.11; if (x.depth) x.depth.shipped.worst = x.depth.card.worst; }
    c.shadows.shipped = c.shadows.shipped.map((g) => ({ ...g, ratio: 4 / Math.PI }));
  });
  add('KNOWN-BAD: a card that never discards fails the outline, the depth and the shadow',
    fails(card, 'THE FIX') && fails(card, 'front, within 2 cm') && fails(card, 'darken a sphere'), failing(card).join(' | '));
  const nodepth = bad((c) => { for (const x of c.runs) if (x.depth) x.depth.shipped.worst = x.depth.card.worst; });
  add('KNOWN-BAD: the depth write taken out alone fails the depth check', fails(nodepth, 'front, within 2 cm'), failing(nodepth).join(' | '));
  const noshadow = bad((c) => { c.shadows.shipped = c.shadows.shipped.map((g) => ({ ...g, ratio: 0 })); c.module.depthMaterial = 'unpatched'; });
  add('KNOWN-BAD: an unpatched sun-pass material — no shadow at all — fails the wiring and the shadow',
    fails(noshadow, 'the module\'s:') && fails(noshadow, 'darken a sphere'), failing(noshadow).join(' | '));
  const flat = bad((c) => { for (const x of c.runs) if (x.shading) x.shading.noon.shipped.p95 = 0.6; });
  add('KNOWN-BAD: a flat-shaded card (the card\'s normal, not the sphere\'s) fails the shading', fails(flat, 'shading is a sphere'), failing(flat).join(' | '));
  const dear = bad((c) => { c.triangles.shipped = 40; });
  add('KNOWN-BAD: a head buffer at the facets\' price fails the price', fails(dear, 'THE PRICE'), failing(dear).join(' | '));
  const moved = bad((c) => { c.buffer.globes[0][3] = 0.3; });
  add('KNOWN-BAD: a buffer whose globe is not LAMP_GLOBES\' fails the wiring', fails(moved, 'the module\'s:'), failing(moved).join(' | '));
  const unpatched = bad((c) => { c.module.material = null; });
  add('KNOWN-BAD: a head material without the patch fails the wiring', fails(unpatched, 'the module\'s:'), failing(unpatched).join(' | '));
  const blind = bad((c) => { for (const x of c.runs) x.arms.old.outline = structuredClone(x.arms.sphere.outline); });
  add('KNOWN-BAD: a page whose old arm reads round (the defect not live) fails the live check and the second protocol',
    fails(blind, 'KNOWN-BAD, LIVE: the 20-facet') && fails(blind, 'hull of its own'), failing(blind).join(' | '));
  const lost = bad((c) => { c.runs[0].arms.ico1.outline = { refused: 'nothing drawn near the projected centre', n: 0 }; });
  add('KNOWN-BAD: a refused outline fails the coverage check', fails(lost, 'none refused'), failing(lost).join(' | '));
  const tame = bad((c) => { c.shadows.old = c.shadows.old.map((g) => ({ ...g, ratio: 1 })); });
  add('KNOWN-BAD: a page whose facets cast a sphere\'s shadow fails the shadow\'s known-bad', fails(tame, 'facets\' shadow'), failing(tame).join(' | '));
  return checks;
}
export const VERDICT_CHECKS = 14;

// ------------------------------------------------------------------------------- the page
/** Load tools/globe-round.html and return its report (throws with the page's own error and console). */
export async function runPage(opts = {}) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const PORT = Number(process.env.GLOBE_ROUND_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const logs = [];
  page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/tools/globe-round.html${opts.query ?? ''}`, { waitUntil: 'commit', timeout: 120000 });
  let report = null, err = null;
  try {
    await page.waitForFunction('window.__globeRound', null, { timeout: 1200000, polling: 1000 });
    report = await page.evaluate(() => window.__globeRound);
  } catch (e) { err = e.message; }
  await browser.close();
  return { report, err, logs };
}

/** The table a run prints. */
export function table(r) {
  const f = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '   -  ');
  const out = [];
  out.push(`  head triangles a lamp: ${Object.entries(r.triangles ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  out.push('  cam     globe  dist   off-axis  r px (tan x rad)   arm       outline dev  fit  size    hull   frame   +bracket');
  for (const x of r.runs ?? []) {
    for (const [arm, a] of Object.entries(x.arms ?? {})) {
      const o = a.outline ?? {};
      out.push(`  ${x.cam.padEnd(7)} ${String(x.gi).padEnd(5)} ${f(x.dist, 1).padStart(6)} ${f(x.theta, 1).padStart(7)}  ` +
        `${f(x.rTan, 1).padStart(6)} x ${f(x.rRad, 1).padEnd(6)}   ${arm.padEnd(8)}  ${f(o.dev)} ${f(o.fitDev)} ${f(o.size, 3)}` +
        `  ${a.hull ? f(a.hull.dev) : '   -  '}  ${f(a.hdr?.dev)}  ${f(a.hdrFixture?.dev)}` +
        `${o.refused ? `  REFUSED ${o.refused}` : ''}   = ${f((o.dev ?? NaN) * x.rTan, 2)} px`);
    }
    if (x.shading) {
      for (const [h, s] of Object.entries(x.shading)) {
        out.push(`      shading ${h.padEnd(5)} against the 96x64 sphere (|dL|/L p50 / p95 over ${s.px} px, ref p95/p5 ${f(s.refSpread, 2)}): ` +
          ['shipped', 'old', 'ico1'].map((k) => `${k} ${f(s[k]?.p50, 3)}/${f(s[k]?.p95, 3)}${s[k]?.missing ? ` (${s[k].missing} missing)` : ''}`).join('  '));
      }
    }
    if (x.depth) out.push(`      depth against the sphere's front: shipped worst ${f(x.depth.shipped.worst, 4)} m mean ${f(x.depth.shipped.mean, 5)} ` +
      `over ${x.depth.shipped.n} px; card worst ${f(x.depth.card.worst, 4)} m mean ${f(x.depth.card.mean, 5)}`);
  }
  for (const [arm, s] of Object.entries(r.shadows ?? {})) {
    out.push(`  noon shadow ${arm.padEnd(8)} ` + s.map((g) => `globe ${g.gi}: ${f(g.area, 4)} m2 of a sphere's ${f(g.sphere, 4)} = x${f(g.ratio, 3)}, peak ${f(g.peak, 3)}`).join('   '));
  }
  return out.join('\n');
}

if (IS_MAIN && argv.includes('--measure')) {
  const { report, err, logs } = await runPage();
  if (!report || report.error) {
    console.error(`the page did not publish a report: ${report ? report.error : err}`);
    if (logs.length) console.error('console:\n' + logs.join('\n'));
    process.exit(1);
  }
  if (argv.includes('--json')) fs.writeFileSync(argv[argv.indexOf('--json') + 1], JSON.stringify(report, null, 1));
  console.log(table(report));
  if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
  process.exit(0);
}

// ------------------------------------------------------------------------------- the gate
if (IS_MAIN && !argv.includes('--selftest') && !argv.includes('--district') && !argv.includes('--measure')) {
  const t0 = Date.now();
  const { report, err, logs } = await runPage();
  if (!report || report.error) {
    console.error(`the page did not publish a report: ${report ? report.error : err}`);
    if (logs.length) console.error('console:\n' + logs.join('\n'));
    process.exit(1);
  }
  if (argv.includes('--json')) fs.writeFileSync(argv[argv.indexOf('--json') + 1], JSON.stringify(report, null, 1));
  console.log('GLOBE-ROUND — is a lamp\'s globe round? The module\'s lamp through the hero cameras that saw it');
  console.log(table(report));
  console.log('');
  const checks = verdict(report);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (logs.length) console.log('\nconsole:\n' + logs.join('\n'));
  const counted = checks.length === CHECK_COUNT;
  console.log(`\nGLOBE-ROUND: ${failed.length || !counted ? 'FAIL' : 'PASS'} — ${checks.length} checks in ${((Date.now() - t0) / 1000).toFixed(0)} s` +
    (failed.length ? `, ${failed.length} failed` : '') + (counted ? '' : ` (expected ${CHECK_COUNT})`));
  process.exit(failed.length || !counted ? 1 : 0);
}

// ------------------------------------------------------------------------------- the selftest
if (IS_MAIN && argv.includes('--selftest')) {
  console.log('GLOBE-ROUND SELFTEST — the instrument');
  const inst = await instrumentChecks();
  for (const c of inst) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  console.log('GLOBE-ROUND SELFTEST — the verdict');
  const ver = verdictChecks();
  for (const c of ver) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  const all = [...inst, ...ver];
  const failed = all.filter((c) => !c.ok).length;
  const counted = inst.length === INSTRUMENT_CHECKS && ver.length === VERDICT_CHECKS;
  console.log(`\nGLOBE-ROUND SELFTEST: ${failed || !counted ? 'FAIL' : 'PASS'} — ${all.length} checks` +
    (failed ? `, ${failed} failed` : '') + (counted ? '' : ` (expected ${INSTRUMENT_CHECKS} + ${VERDICT_CHECKS})`));
  process.exit(failed || !counted ? 1 : 0);
}
