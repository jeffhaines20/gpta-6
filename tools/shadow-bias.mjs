// WHAT DOES THE SUN'S SHADOW BIAS COST, IN CONTACT AND IN ACNE, AT EACH HOUR? — BACKLOG #141's probe.
//
//   node tools/shadow-bias.mjs --selftest
//   node tools/shadow-bias.mjs --port 8251 --cam fivepoints --tods noon,golden,dusk,night \
//        --arms shipped,b0n0.06,b0n0.12 [--tag sb] [--ref 40] [--composite shipped,b0n0.12]
//
// #138's blind review saw "the road under all three cars reads sunlit, so the cars look lifted", and
// #141 put a mechanism under it: `bias` is in NORMALISED depth, so the shipped -0.0006 is 0.54 m
// along the light ray at every hour, and with `normalBias` 0.06 a receiver is unshadowed by anything
// closer to it than 0.54 sin(elevation) + 0.06 metres VERTICALLY. At noon that is 0.58 m, and a car's
// floor — which is what three's PCF pass puts in the map, because it draws a FrontSide material's back
// faces — is 0.192 m up. This probe measures that in the page, and then measures what every
// candidate setting costs.
//
// ---------------------------------------------------------------------------------------------------
// THE QUANTITY: A SHADOW FACTOR, READ OUT OF THE HDR SCENE TARGET, NOT A LUMA
// ---------------------------------------------------------------------------------------------------
// Every arm renders inside ONE page.evaluate (prop-ground's argument: requestAnimationFrame cannot fire
// inside a task, so the crowd, the traffic, the streamer and the clouds are bit-identical across arms)
// and reads post.hdr back — the scene's linear radiance BEFORE the AO, the bloom and the tone curve,
// which is what isolates the shadow term from #138's AO leak. Two control arms are rendered first:
//
//   noShadow   sun.shadow.intensity = 0     the sun reaches every surface it faces
//   noSun      sun.intensity = 0            everything but the sun's direct beam
//
// so at every pixel f = (L - L_noSun) / (L_noShadow - L_noSun) is the fraction of the sun's direct
// light that arrives: 1 lit, 0 in shadow. It is a ratio of three renders of ONE frame, so the exposure
// stop, the albedo, the sky and the lamps all cancel, and it is undefined — null, not 0 or 1 — where
// the sun contributes too little of the pixel to measure (`--minShare`, default 0.25 by day).
//
// ---------------------------------------------------------------------------------------------------
// THE TRUTH: A REFERENCE MAP EIGHT TIMES FINER
// ---------------------------------------------------------------------------------------------------
// "Lit" and "shadowed" need a reference that is neither the shipped bias nor the candidate. The `ref`
// arm puts a 4096 map over a +-`--ref` m box (0.0195 m a texel at 40, 6x finer than the shipped
// 0.1172) round a point 18 m in front of the camera, with a bias sized for ITS texel (0.01 m along the
// ray, 0.02 m normal). `ref2` halves the box again so the reference's own convergence is a printed
// number rather than an assumption. Pixels outside the reference box are excluded from every count
// that reads it, by a world-position pass rather than by guessing.
//
// ---------------------------------------------------------------------------------------------------
// WHAT IS COUNTED
// ---------------------------------------------------------------------------------------------------
//   CONTACT   per car (the player's, which is the "red car" at fivepoints, and the two nearest parked
//             cars in frame): f on the ROAD UNDER THE BODY that the camera can see between the sill
//             and the ground, against the reference's f at the same points. Per pedestrian (the four
//             nearest in frame): f along the ground running away from the sun from the body, the
//             first 0.30 m past it.
//   ACNE      per group of SURFACE (car, ped, facade, furniture, ground — tools/tri-buckets.mjs's
//             buckets, the one definition), over sun-facing pixels inside the reference box:
//               acne   lit in the reference (f_ref >= 0.9) and more than half shadowed in the arm
//               leak   shadowed in the reference (f_ref <= 0.1) and more than half lit in the arm
//             A coarse map gets both wrong near every shadow edge whatever its bias, so the number to
//             read is how an arm MOVES them against the shipped arm, which carries the same map.
//
// The census and the reductions are pure functions exported below and exercised by --selftest on
// inputs whose right answer is known, including the ones that must NOT read as a result: an empty
// group, a pixel the sun does not reach, a pixel outside the reference box.
import fs from 'node:fs';
import { PRESETS } from '../src/daynight.js';
import { bucketSource } from './tri-buckets.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

// ----------------------------------------------------------------------------------- the pure half

/** three's `shadow.bias` for a bias of `metres` along the ray, against an ortho camera near..far. */
export function biasFor(metres, near, far) { return -metres / (far - near); }

/** The vertical distance under which nothing can shadow a horizontal receiver: b sin(el) + nb. */
export function verticalTolerance(biasMetres, normalBias, elevation) {
  return biasMetres * Math.sin(elevation) + normalBias;
}

/**
 * An arm's name to the setting it applies. Named arms are controls; `bXnY` is a bias of X metres along
 * the ray with a normalBias of Y metres; `eTnY` is a bias SET FROM THE HOUR so the vertical tolerance
 * is T metres with a normalBias of Y: b = (T - Y) / sin(elevation), the "constant set from the preset's
 * elevation" candidate. Throws on anything else, because a typo that silently measured the shipped
 * arm twice would read as "this lever does nothing".
 */
export function parseArm(name, elevation) {
  if (['shipped', 'noShadow', 'noSun', 'ref', 'ref2', 'repeat', 'noContact'].includes(name)) return { name, kind: name };
  let m = /^b([0-9.]+)n([0-9.]+)$/.exec(name);
  if (m) return { name, kind: 'bias', b: Number(m[1]), nb: Number(m[2]) };
  m = /^e([0-9.]+)n([0-9.]+)$/.exec(name);
  if (m) {
    const T = Number(m[1]), nb = Number(m[2]);
    if (!(elevation > 0)) throw new Error(`arm ${name} needs a positive sun elevation, got ${elevation}`);
    return { name, kind: 'bias', b: Math.max(0, T - nb) / Math.sin(elevation), nb, tolerance: T };
  }
  throw new Error(`unknown arm "${name}" (named: shipped noShadow noSun ref ref2; or bXnY; or eTnY)`);
}

/** The fraction of the sun's direct light reaching a pixel, or null where it cannot be read. */
export function shadowFactor(L, Lns, L0, minShare = 0.25) {
  if (![L, Lns, L0].every(Number.isFinite)) return null;
  const sun = Lns - L0;
  if (!(Lns > 0) || !(sun > 0) || sun / Lns < minShare) return null;
  return (L - L0) / sun;
}

/** Mean of the non-null entries, and how many there were. Empty is null, never 0. */
export function meanOf(vals) {
  let s = 0, n = 0;
  for (const v of vals) if (v !== null && Number.isFinite(v)) { s += v; n++; }
  return { mean: n ? s / n : null, n };
}

/**
 * THE CENSUS, as a pure function of per-pixel arrays, so the page and the selftest run the same code.
 * It closes over nothing and uses no arrow functions, because it is stringified into the page.
 *
 *   group    Uint8Array, the pixel's surface group (index into GROUPS)
 *   inRef    Uint8Array, 1 where the pixel lies inside the reference map's box
 *   L0, Lns  the noSun and noShadow renders;  Lref the reference;  Lbase the shipped arm;  L the arm
 *   minShare the sun's share of the unshadowed pixel below which f is not read
 *   nGroups  how many groups
 *
 * Returns per group: n (readable pixels), meanF, acne (f_ref >= 0.9, f <= 0.5), leak (f_ref <= 0.1,
 * f >= 0.5), and against the shipped arm: darker / lighter by more than 0.3 of f. Rates are counts
 * here; the caller divides, and a group with n = 0 has no rate at all.
 */
export function census(group, inRef, L0, Lns, Lref, Lbase, L, minShare, nGroups) {
  var out = [];
  for (var g = 0; g < nGroups; g++) {
    out.push({ n: 0, sumF: 0, refLit: 0, refDark: 0, acne: 0, leak: 0, darker: 0, lighter: 0 });
  }
  for (var i = 0; i < group.length; i++) {
    if (!inRef[i]) continue;
    var gi = group[i];
    if (gi >= nGroups) continue;
    var sun = Lns[i] - L0[i];
    if (!(Lns[i] > 0) || !(sun > 0) || sun / Lns[i] < minShare) continue;
    var f = (L[i] - L0[i]) / sun, fr = (Lref[i] - L0[i]) / sun, fb = (Lbase[i] - L0[i]) / sun;
    if (!(f === f) || !(fr === fr) || !(fb === fb)) continue;
    var o = out[gi];
    o.n++; o.sumF += f;
    if (fr >= 0.9) { o.refLit++; if (f <= 0.5) o.acne++; }
    if (fr <= 0.1) { o.refDark++; if (f >= 0.5) o.leak++; }
    if (f < fb - 0.3) o.darker++;
    if (f > fb + 0.3) o.lighter++;
  }
  return out;
}
export const censusSource = census.toString();

/** The surface groups the census reports, from tools/tri-buckets.mjs's buckets. */
export const GROUPS = ['background', 'car', 'ped', 'facade', 'furniture', 'ground', 'sky', 'other'];
export function groupOfBucket(b) {
  if (b === 'vehicles') return 1;
  if (b === 'pedestrians') return 2;
  if (b === 'facade (near LOD)' || b === 'facade trim (near LOD)') return 3;
  if (b === 'street furniture + trees' || b === 'street lamps' || b === 'signage') return 4;
  // 'other: district' is the streamer's LAND PAD and its water, the two unnamed children of its root:
  // the pad is the pavement every pedestrian stands on (src/pedestrians.js places soles against it).
  if (b === 'roads' || b === 'kerbs (near LOD)' || b === 'ground zones' || b === 'buildings (far LOD)' ||
    b === 'other: district') return 5;
  if (b === 'sky dome') return 6;
  return 7;
}
export const groupSource = groupOfBucket.toString();

/** A census row as rates, with every rate null where its denominator is empty. */
export function rates(o) {
  const r = (a, b) => (b > 0 ? a / b : null);
  return { n: o.n, meanF: r(o.sumF, o.n), acne: r(o.acne, o.refLit), leak: r(o.leak, o.refDark),
    darker: r(o.darker, o.n), lighter: r(o.lighter, o.n), refLit: o.refLit, refDark: o.refDark };
}

// ------------------------------------------------------------------------------------- selftest
function selftest() {
  let fail = 0, n = 0;
  const say = (name, ok, extra = '') => {
    n++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fail++;
  };
  console.log('SHADOW-BIAS SELFTEST');
  // The arithmetic the backlog quotes, re-derived from the presets rather than typed in.
  const b0 = 0.0006 * 899;
  const tol = (k) => verticalTolerance(b0, 0.06, PRESETS[k].elevation);
  say('the shipped bias is 0.54 m along the ray', Math.abs(b0 - 0.5394) < 1e-9, `${b0.toFixed(4)} m`);
  say('and its vertical tolerance is 0.58 m at noon, 0.48 night, 0.14 golden, 0.09 dusk',
    Math.abs(tol('noon') - 0.5825) < 5e-4 && Math.abs(tol('night') - 0.4825) < 5e-4 &&
    Math.abs(tol('golden') - 0.1351) < 5e-4 && Math.abs(tol('dusk') - 0.0896) < 5e-4,
    ['noon', 'night', 'golden', 'dusk'].map((k) => `${k} ${tol(k).toFixed(4)}`).join(', '));
  say('biasFor inverts the normalisation', Math.abs(biasFor(b0, 1, 900) + 0.0006) < 1e-12);

  // Arms.
  const a = parseArm('b0n0.12', 1.32);
  say('bXnY parses', a.kind === 'bias' && a.b === 0 && a.nb === 0.12);
  const e = parseArm('e0.10n0.06', PRESETS.noon.elevation);
  say('eTnY sets the bias from the hour so the tolerance is T',
    Math.abs(verticalTolerance(e.b, e.nb, PRESETS.noon.elevation) - 0.10) < 1e-12 &&
    Math.abs(verticalTolerance(parseArm('e0.10n0.06', PRESETS.dusk.elevation).b, 0.06, PRESETS.dusk.elevation) - 0.10) < 1e-12,
    `noon b ${e.b.toFixed(4)} m, dusk b ${parseArm('e0.10n0.06', PRESETS.dusk.elevation).b.toFixed(4)} m`);
  let threw = false;
  try { parseArm('b0.1', 1); } catch { threw = true; }
  say('KNOWN-BAD: a malformed arm throws rather than measuring the shipped one again', threw);

  // The shadow factor.
  say('f is 1 where the arm reads the unshadowed sun', shadowFactor(10, 10, 2) === 1);
  say('f is 0 where the arm reads only the sky', shadowFactor(2, 10, 2) === 0);
  say('KNOWN-BAD: a pixel the sun does not reach is null, not 0 or 1',
    shadowFactor(2, 2, 2) === null && shadowFactor(5, 10.1, 10) === null);
  say('KNOWN-BAD: a non-finite read is null', shadowFactor(NaN, 10, 2) === null);
  say('an empty mean is null, not 0', meanOf([null, null]).mean === null && meanOf([]).n === 0);

  // The census, on a synthetic frame whose answers are known.
  const N = 12;
  const group = new Uint8Array([1, 1, 1, 1, 2, 2, 5, 5, 5, 3, 3, 0]);
  const inRef = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]);
  const L0 = new Float32Array(N).fill(1), Lns = new Float32Array(N).fill(11);
  const Lref = new Float32Array([11, 11, 1, 1, 11, 11, 1, 1, 11, 11, 1, 11]);
  const Lbase = Lref.slice();
  // The arm: one car pixel lit in the reference goes dark (acne), one ground pixel shadowed in the
  // reference comes up lit (leak), and pixel 10 is acne-shaped but OUTSIDE the reference box.
  const L = Lref.slice(); L[0] = 1; L[7] = 11; L[10] = 11;
  const c = census(group, inRef, L0, Lns, Lref, Lbase, L, 0.25, GROUPS.length);
  say('the census finds the acne in the group it is in', c[1].acne === 1 && c[1].refLit === 2,
    `car acne ${c[1].acne}/${c[1].refLit}`);
  say('and the leak in its own', c[5].leak === 1 && c[5].refDark === 2, `ground leak ${c[5].leak}/${c[5].refDark}`);
  say('and nothing in a group the arm did not move', c[2].acne === 0 && c[2].leak === 0 && c[3].acne === 0);
  say('KNOWN-BAD: a pixel outside the reference box is not counted', c[3].n === 1, `facade n ${c[3].n}`);
  say('against the shipped arm: one darker, one lighter', c[1].darker === 1 && c[5].lighter === 1);
  const same = census(group, inRef, L0, Lns, Lref, Lbase, Lbase, 0.25, GROUPS.length);
  say('KNOWN-BAD: the shipped arm against itself moves nothing',
    same.every((o) => o.acne === 0 && o.leak === 0 && o.darker === 0 && o.lighter === 0));
  // A pixel whose sun share is under the floor must not be read at all.
  const dim = census(group, inRef, L0, new Float32Array(N).fill(1.2), Lref, Lbase, L, 0.25, GROUPS.length);
  say('KNOWN-BAD: a frame the sun barely reaches reads no pixels, not perfect contact',
    dim.every((o) => o.n === 0));
  const rr = rates({ n: 0, sumF: 0, refLit: 0, refDark: 0, acne: 0, leak: 0, darker: 0, lighter: 0 });
  say('an empty group has null rates, not 0%', rr.meanF === null && rr.acne === null && rr.leak === null);
  const inj = new Function(`return (${censusSource})`)();
  const c2 = inj(group, inRef, L0, Lns, Lref, Lbase, L, 0.25, GROUPS.length);
  say('the stringified census behaves like the original', JSON.stringify(c2) === JSON.stringify(c));
  say('and closes over nothing', !/=>/.test(censusSource) && !/\b(import|require)\b/.test(censusSource));
  const gi = new Function(`return (${groupSource})`)();
  say('the group map: a parked car is a car, a road is ground, a lamp is furniture, the land pad is ground',
    gi('vehicles') === 1 && gi('roads') === 5 && gi('street lamps') === 4 && gi('pedestrians') === 2 &&
    gi('other: district') === 5);
  console.log(`\nSHADOW-BIAS SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${n} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (IS_MAIN && has('selftest')) selftest();

// ------------------------------------------------------------------------------------ the page half

/**
 * Everything that runs in the page for ONE hour: the subjects' sample sets, the classification pass,
 * and every arm, inside one task. Self-contained (page.evaluate serialises it).
 */
async function measureInPage(args) {
  const { armSpecs, refHalf, minShare, bucketSrc, censusSrc, groupSrc, nGroups, compositeArms, wantShots, mapArms } = args;
  const THREE = await import('/vendor/three.module.min.js');
  const D = window.__district, scene = D.scene, cam = D.camera, r = D.renderer, post = D.post;
  const sun = D.tod.sun, sc = sun.shadow.camera;
  const bucketOf = new Function(`return (${bucketSrc})`)();
  const censusFn = new Function(`return (${censusSrc})`)();
  const groupOf = new Function(`return (${groupSrc})`)();
  const t0 = performance.now();
  scene.updateMatrixWorld(true);
  cam.updateMatrixWorld();
  const W = post.hdr.width, H = post.hdr.height;
  const gl = r.getContext();

  // ---------------------------------------------------------------- half floats, by table
  const HALF = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    HALF[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 0x1f ? (f ? NaN : s * Infinity)
      : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  const u16 = new Uint16Array(W * H * 4);
  /** Linear luma of the HDR scene target, row 0 = the TOP of the screen. */
  const readHDR = () => {
    r.readRenderTargetPixels(post.hdr, 0, 0, W, H, u16);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4, dst = y * W;
      for (let x = 0; x < W; x++) {
        const i = src + x * 4;
        out[dst + x] = 0.2126 * HALF[u16[i]] + 0.7152 * HALF[u16[i + 1]] + 0.0722 * HALF[u16[i + 2]];
      }
    }
    return out;
  };
  const u8 = new Uint8Array(W * H * 4);
  const SRGB = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; SRGB[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  /** The composited frame, sRGB-decoded luma: what the viewer sees, AO and tone curve included. */
  const readLDR = () => {
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4, dst = y * W;
      for (let x = 0; x < W; x++) {
        const i = src + x * 4;
        out[dst + x] = 0.2126 * SRGB[u8[i]] + 0.7152 * SRGB[u8[i + 1]] + 0.0722 * SRGB[u8[i + 2]];
      }
    }
    return out;
  };
  const pngOf = () => {
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); const im = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) im.data.set(u8.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    ctx.putImageData(im, 0, 0);
    return cv.toDataURL('image/png');
  };

  // ---------------------------------------------------------------- the scene, by group
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
  const depthWrites = (o) => (Array.isArray(o.material) ? o.material : [o.material]).some((m) => m && m.depthWrite !== false);
  // The class pass writes a BUCKET index (1-based; 0 is nothing drawn), so the pixels can be counted
  // per bucket as well as per group: a group that swallowed a surface nobody meant it to is visible.
  const bucketNames = [];
  const bucketIdx = new Map(meshes.map((m) => {
    const b = bucketOf(m);
    let i = bucketNames.indexOf(b);
    if (i < 0) { bucketNames.push(b); i = bucketNames.length - 1; }
    return [m, i + 1];
  }));
  const grp = new Map(meshes.map((m) => [m, groupOf(bucketOf(m))]));
  const camPos = cam.position.clone();
  const v3 = new THREE.Vector3();
  const project = (x, y, z) => {
    v3.set(x, y, z).project(cam);
    return { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H, z: v3.z };
  };
  const sunDir = D.tod.sunDirection(new THREE.Vector3());
  const elevation = Math.asin(Math.max(-1, Math.min(1, sunDir.y)));
  const hs = Math.hypot(sunDir.x, sunDir.z) || 1;
  const toSun = { x: sunDir.x / hs, z: sunDir.z / hs };

  // ---------------------------------------------------------------- classification + world position
  // Every mesh drawn once more with a material that writes its world position and its group, so a
  // pixel can be counted as a car, a wall or the road, tested against the reference box, and placed
  // under a car or beside a pedestrian WITHOUT A SINGLE RAYCAST: the subjects below are chosen from
  // the pixels the camera actually sees, which is also the visibility test. Decals (depthWrite off)
  // are hidden for this pass: they are not a surface anything stands on.
  const posRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, samples: 0 });
  const vs = `varying vec3 vW; varying vec2 vUv; void main() { vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    vec4 w = modelMatrix * p; vW = w.xyz; vUv = uv; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const fs_ = `uniform float cat; varying vec3 vW; varying vec2 vUv;
    #ifdef USE_AT
      uniform sampler2D aMap; uniform float aTest;
    #endif
    void main() {
    #ifdef USE_AT
      if (texture2D(aMap, vUv).g < aTest) discard;
    #endif
      gl_FragColor = vec4(vW, cat); }`;
  const classMats = new Map();
  const classMat = (gi, src) => {
    const at = !!(src && src.alphaMap && src.alphaTest > 0);
    const key = `${gi}:${src ? src.side : 0}:${at ? src.alphaMap.uuid + src.alphaTest : ''}`;
    if (!classMats.has(key)) {
      classMats.set(key, new THREE.ShaderMaterial({
        uniforms: { cat: { value: gi }, aMap: { value: at ? src.alphaMap : null }, aTest: { value: at ? src.alphaTest : 0 } },
        defines: at ? { USE_AT: '' } : {}, vertexShader: vs, fragmentShader: fs_, side: src ? src.side : THREE.FrontSide,
      }));
    }
    return classMats.get(key);
  };
  const saved = [];
  for (const m of meshes) {
    saved.push([m, m.material, m.visible]);
    if (!depthWrites(m)) { m.visible = false; continue; }
    const gi = bucketIdx.get(m);
    m.material = Array.isArray(m.material) ? m.material.map((x) => classMat(gi, x)) : classMat(gi, m.material);
  }
  const bg = scene.background; scene.background = null;
  const fog = scene.fog; scene.fog = null;
  const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
  r.setClearColor(0x000000, 0);
  r.setRenderTarget(posRT); r.clear(); r.render(scene, cam); r.setRenderTarget(null);
  r.setClearColor(prevClear, prevAlpha);
  for (const [m, mat, vis] of saved) { m.material = mat; m.visible = vis; }
  scene.background = bg; scene.fog = fog;
  for (const m of classMats.values()) m.dispose();
  const P = new Float32Array(W * H * 4);
  {
    const f32 = new Float32Array(W * H * 4);
    r.readRenderTargetPixels(posRT, 0, 0, W, H, f32);
    for (let y = 0; y < H; y++) P.set(f32.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  }
  posRT.dispose();
  const group = new Uint8Array(W * H);
  const groupCount = new Array(nGroups).fill(0);
  const bucketPx = new Array(bucketNames.length).fill(0);
  for (let k = 0; k < W * H; k++) {
    const bi = Math.round(P[k * 4 + 3]);
    const g = bi >= 1 && bi <= bucketNames.length ? groupOf(bucketNames[bi - 1]) : 0;
    group[k] = g >= 0 && g < nGroups ? g : 0;
    groupCount[group[k]]++;
    if (bi >= 1 && bi <= bucketNames.length) bucketPx[bi - 1]++;
  }
  // GROUND THE CAMERA SEES CLEANLY: a ground pixel whose four neighbours are ground too, so the
  // HDR target's MSAA resolve cannot have blended a sill or a shoe into it.
  const cleanGround = (k) => {
    if (group[k] !== 5) return false;
    const x = k % W, y = (k - x) / W;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    return group[k - 1] === 5 && group[k + 1] === 5 && group[k - W] === 5 && group[k + W] === 5;
  };

  // ---------------------------------------------------------------- the reference box
  // Round a ground point 18 m in front of the camera, in the light's own lateral axes.
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const fl = Math.hypot(fwd.x, fwd.z) || 1;
  const F = (() => {
    // The ground pixel nearest the screen point 18 m ahead at ground height, read off the position
    // pass rather than raycast.
    const gx = camPos.x + (fwd.x / fl) * 18, gz = camPos.z + (fwd.z / fl) * 18;
    let best = null, bd = Infinity;
    for (let k = 0; k < W * H; k += 7) {
      if (group[k] !== 5) continue;
      const d = Math.hypot(P[k * 4] - gx, P[k * 4 + 2] - gz);
      if (d < bd) { bd = d; best = k; }
    }
    return best === null ? new THREE.Vector3(gx, 0, gz) : new THREE.Vector3(gx, P[best * 4 + 1], gz);
  })();
  const LX = new THREE.Vector3(sunDir.z, 0, -sunDir.x).normalize();
  const LY = new THREE.Vector3().crossVectors(sunDir, LX);
  const inRef = new Uint8Array(W * H), inRef2 = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    const g = group[k];
    if (g === 0 || g === 6) continue;
    const dx = P[k * 4] - F.x, dy = P[k * 4 + 1] - F.y, dz = P[k * 4 + 2] - F.z;
    const a = Math.abs(dx * LX.x + dy * LX.y + dz * LX.z), b = Math.abs(dx * LY.x + dy * LY.y + dz * LY.z);
    if (a < refHalf - 1 && b < refHalf - 1) inRef[k] = 1;
    if (a < refHalf / 2 - 1 && b < refHalf / 2 - 1) inRef2[k] = 1;
  }

  // ---------------------------------------------------------------- subjects, from the pixels
  const subjects = [];
  const tmp = new THREE.Vector3();
  // A car: its world matrix and the height of its contact patch and underbody in its own frame. The
  // player's car is authored in CAR's frame (ground -0.717, underbody -0.525); a pooled car's geometry
  // is translated so its contact patch is its bounding box's floor.
  const carSubject = (name, wm, groundLocal, underLocal) => {
    const inv = new THREE.Matrix4().copy(wm).invert();
    const c = new THREE.Vector3(0, groundLocal, 0).applyMatrix4(wm);
    const q = project(c.x, c.y, c.z);
    if (q.z > 1 || q.x < 0 || q.x > W || q.y < 0 || q.y > H) return null;
    // A screen window round the car: its eight footprint corners, 7 m out, projected.
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const sx of [-7, 7]) for (const sz of [-7, 7]) for (const sy of [groundLocal, groundLocal + 1.6]) {
      const p = new THREE.Vector3(sx, sy, sz).applyMatrix4(wm); const pp = project(p.x, p.y, p.z);
      if (pp.z > 1) continue;
      x0 = Math.min(x0, pp.x); x1 = Math.max(x1, pp.x); y0 = Math.min(y0, pp.y); y1 = Math.max(y1, pp.y);
    }
    x0 = Math.max(1, Math.floor(x0)); x1 = Math.min(W - 2, Math.ceil(x1)); y0 = Math.max(1, Math.floor(y0)); y1 = Math.min(H - 2, Math.ceil(y1));
    const under = [], band = [], ring = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * W + x;
        if (!cleanGround(k)) continue;
        tmp.set(P[k * 4], P[k * 4 + 1], P[k * 4 + 2]);
        const gy = tmp.y;
        tmp.applyMatrix4(inv);
        const lx = tmp.x, lz = tmp.z, ly = tmp.y;
        if (Math.abs(ly - groundLocal) > 0.12) continue;        // a kerb top or a pavement, not the road it stands on
        const ax = Math.abs(lx), az = Math.abs(lz);
        if (ax <= 0.85 && az <= 0.85) under.push({ k, lx });
        else if ((ax >= 1.0 && ax <= 2.2 && az <= 2.3) || (ax <= 1.0 && az >= 2.35 && az <= 3.5)) band.push(k);
        else { const rr = Math.hypot(lx, lz); if (rr >= 3.5 && rr <= 6.0) ring.push(k); }
        void gy;
      }
    }
    return { kind: 'car', name, x: +c.x.toFixed(2), z: +c.z.toFixed(2), groundY: +c.y.toFixed(3),
      underbodyM: +(underLocal - groundLocal).toFixed(3), dist: +Math.hypot(c.x - camPos.x, c.z - camPos.z).toFixed(1),
      screen: [Math.round(q.x), Math.round(q.y)], under, band, ring };
  };
  if (D.car && D.car.group) {
    D.car.group.updateMatrixWorld(true);
    const s = carSubject('player', D.car.group.matrixWorld, -0.717, -0.525);
    if (s) subjects.push(s);
  }
  const parked = D.furniture && D.furniture.parked;
  if (parked && parked.meshes) {
    const cand = [];
    const mtx = new THREE.Matrix4(), pos = new THREE.Vector3();
    for (const m of parked.meshes) {
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      m.updateMatrixWorld(true);
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, mtx);
        if (Math.abs(mtx.elements[0]) + Math.abs(mtx.elements[2]) < 1e-6) continue;
        const wm = new THREE.Matrix4().multiplyMatrices(m.matrixWorld, mtx);
        pos.setFromMatrixPosition(wm);
        const qq = project(pos.x, pos.y, pos.z);
        if (qq.z > 1 || qq.x < 40 || qq.x > W - 40 || qq.y < 40 || qq.y > H - 20) continue;
        cand.push({ d: Math.hypot(pos.x - camPos.x, pos.z - camPos.z), wm, m, bb, i });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    // The underbody is CAR.sill, 0.192 m over the contact patch, in every shell: SHAPES varies the
    // width, the roof and the overhangs, never the sill (tools/shadow-floor reads it off the buffer).
    for (const c of cand.slice(0, 2)) {
      const s = carSubject(`parked#${c.i}:${c.m.name}`, c.wm, c.bb.min.y, c.bb.min.y + 0.192);
      if (s) subjects.push(s);
    }
  }
  // Pedestrians: the four nearest in frame, standing. The ground pixels in a 0.16 m corridor running
  // away from the sun from the body's centre, binned by distance.
  const peds = (D.pedestrianPositions ? D.pedestrianPositions() : []).filter((p) => !p.down);
  const pc = [];
  for (const p of peds) {
    const q = project(p.x, 0, p.z);
    if (q.z > 1 || q.x < 40 || q.x > W - 40 || q.y < 40 || q.y > H - 10) continue;
    pc.push({ ...p, d: Math.hypot(p.x - camPos.x, p.z - camPos.z) });
  }
  pc.sort((a, b) => a.d - b.d);
  for (const p of pc.slice(0, 4)) {
    const bins = new Map();
    let winGround = 0;
    // Its screen window: 1.6 m round it.
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const sx of [-1.6, 1.6]) for (const sz of [-1.6, 1.6]) for (const sy of [-1, 2]) {
      const pp = project(p.x + sx, sy, p.z + sz); if (pp.z > 1) continue;
      x0 = Math.min(x0, pp.x); x1 = Math.max(x1, pp.x); y0 = Math.min(y0, pp.y); y1 = Math.max(y1, pp.y);
    }
    x0 = Math.max(1, Math.floor(x0)); x1 = Math.min(W - 2, Math.ceil(x1)); y0 = Math.max(1, Math.floor(y0)); y1 = Math.min(H - 2, Math.ceil(y1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * W + x;
        if (!cleanGround(k)) continue;
        winGround++;
        const dx = P[k * 4] - p.x, dz = P[k * 4 + 2] - p.z;
        const along = -(dx * toSun.x + dz * toSun.z), across = Math.abs(-dx * toSun.z + dz * toSun.x);
        if (across > 0.08 || along < 0.05 || along > 1.55) continue;
        const b = Math.round(along / 0.05) * 0.05;
        const key = +b.toFixed(2);
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(k);
      }
    }
    const ray = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([d, pts]) => ({ d, pts }));
    const q = project(p.x, 0, p.z);
    const a = project(p.x, 0, p.z), b = project(p.x + 0.5, 0, p.z + 0.5);
    subjects.push({ kind: 'ped', name: `ped#${p.i}`, x: p.x, z: p.z, dist: +p.d.toFixed(1), winGround,
      screen: [Math.round(q.x), Math.round(q.y)], ray, pxPerM: +(Math.hypot(b.x - a.x, b.y - a.y) / Math.hypot(0.5, 0.5)).toFixed(1) });
  }

  // ---------------------------------------------------------------- the arms
  const keep = {
    bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, intensity: sun.intensity,
    shadowIntensity: sun.shadow.intensity, mapSize: sun.shadow.mapSize.x,
    box: [sc.left, sc.right, sc.top, sc.bottom], pos: sun.position.clone(), tgt: sun.target.position.clone(),
    contact: D.carContact ? D.carContact.mesh.visible : null,
  };
  const span = sc.far - sc.near;
  const setMap = (size, half, centre) => {
    if (sun.shadow.mapSize.x !== size) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(size, size);
    }
    Object.assign(sc, { left: -half, right: half, top: half, bottom: -half });
    sc.updateProjectionMatrix();
    sun.target.position.copy(centre); sun.position.copy(centre).addScaledVector(sunDir, 400);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  };
  const reset = () => {
    sun.shadow.bias = keep.bias; sun.shadow.normalBias = keep.normalBias;
    sun.intensity = keep.intensity; sun.shadow.intensity = keep.shadowIntensity;
    if (sun.shadow.mapSize.x !== keep.mapSize) {
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(keep.mapSize, keep.mapSize);
    }
    Object.assign(sc, { left: keep.box[0], right: keep.box[1], top: keep.box[2], bottom: keep.box[3] });
    sc.updateProjectionMatrix();
    sun.position.copy(keep.pos); sun.target.position.copy(keep.tgt);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    if (D.carContact) D.carContact.mesh.visible = keep.contact;
  };
  const apply = (spec) => {
    reset();
    if (spec.kind === 'noShadow') sun.shadow.intensity = 0;
    else if (spec.kind === 'noSun') sun.intensity = 0;
    // The footprint under every car (src/carcontact.js) hidden: what the road under a car reads
    // with the lamps' shadow taken away. It multiplies L, L_noSun and L_noShadow alike, so the
    // shadow factor f cannot see it and the luma ratios are what this arm is for.
    else if (spec.kind === 'noContact') { if (D.carContact) D.carContact.mesh.visible = false; }
    else if (spec.kind === 'ref') { setMap(4096, refHalf, F); sun.shadow.bias = -0.01 / span; sun.shadow.normalBias = 0.02; }
    else if (spec.kind === 'ref2') { setMap(4096, refHalf / 2, F); sun.shadow.bias = -0.005 / span; sun.shadow.normalBias = 0.01; }
    else if (spec.kind === 'bias') { sun.shadow.bias = -spec.b / span; sun.shadow.normalBias = spec.nb; }
    sun.shadow.needsUpdate = true;
  };
  const renderArm = (composite) => {
    if (composite) { post.render(); return { hdr: readHDR(), ldr: readLDR() }; }
    r.setRenderTarget(post.hdr); r.clear(); r.render(scene, cam); r.setRenderTarget(null);
    return { hdr: readHDR(), ldr: null };
  };

  const L = {};
  const ldr = {};
  const timings = {};
  const shots = {};
  const order = ['noShadow', 'noSun', 'shipped', 'ref', 'ref2'];
  for (const s of armSpecs) if (!order.includes(s.name)) order.push(s.name);
  order.push('repeat');
  const specOf = (n) => (n === 'repeat' ? { name: 'repeat', kind: 'shipped' } : armSpecs.find((s) => s.name === n) ?? { name: n, kind: n });
  const results = {};
  for (const name of order) {
    const spec = specOf(name);
    const ta = performance.now();
    apply(spec);
    const comp = compositeArms.includes(name);
    const out = renderArm(comp);
    timings[name] = +((performance.now() - ta) / 1000).toFixed(1);
    L[name] = out.hdr;
    if (out.ldr) ldr[name] = out.ldr;
    if (comp && wantShots) shots[name] = pngOf();
    results[name] = {
      config: { bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, mapSize: sun.shadow.mapSize.x,
        half: sc.right, biasMetres: +(-sun.shadow.bias * span).toFixed(4) },
    };
    // Free what is no longer needed: arms past the controls only need their own frame for the census.
    if (!['noShadow', 'noSun', 'shipped', 'ref', 'ref2'].includes(name)) {
      results[name].census = censusFn(group, inRef, L.noSun, L.noShadow, L.ref, L.shipped, L[name], minShare, nGroups);
    }
  }
  reset();
  sun.shadow.needsUpdate = true;
  results.shipped.census = censusFn(group, inRef, L.noSun, L.noShadow, L.ref, L.shipped, L.shipped, minShare, nGroups);
  // ref against ref2 inside ref2's box: the reference's own convergence.
  results.ref2.census = censusFn(group, inRef2, L.noSun, L.noShadow, L.ref, L.ref, L.ref2, minShare, nGroups);
  // Registration: the shipped arm rendered again, last.
  let regMax = 0;
  for (let i = 0; i < W * H; i++) { const d = Math.abs(L.repeat[i] - L.shipped[i]) / Math.max(1e-6, L.shipped[i]); if (d > regMax && L.shipped[i] > 1e-3) regMax = d; }

  // ---------------------------------------------------------------- maps: where the census counted
  // Grey is the arm's own HDR frame through a plain exposure curve; BLUE is acne (lit in the reference,
  // half shadowed or worse in the arm), RED is leak (shadowed in the reference, half lit or more in the
  // arm), both only where the census reads; pixels outside the reference box are dimmed.
  const maps = {};
  const expo = D.post.params.exposure;
  for (const name of mapArms) {
    if (!L[name]) continue;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); const im = ctx.createImageData(W, H);
    const A = L[name];
    for (let k = 0; k < W * H; k++) {
      let v = 255 * (1 - Math.exp(-A[k] * expo * 4));
      if (!inRef[k]) v *= 0.35;
      let rr = v, gg = v, bb = v;
      const L0 = L.noSun[k], Lns = L.noShadow[k], sun = Lns - L0;
      if (inRef[k] && Lns > 0 && sun > 0 && sun / Lns >= minShare) {
        const f = (A[k] - L0) / sun, fr = (L.ref[k] - L0) / sun;
        if (fr >= 0.9 && f <= 0.5) { rr = 30; gg = 60; bb = 255; }
        else if (fr <= 0.1 && f >= 0.5) { rr = 255; gg = 40; bb = 30; }
      }
      im.data[k * 4] = rr; im.data[k * 4 + 1] = gg; im.data[k * 4 + 2] = bb; im.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    maps[name] = cv.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- the subjects, per arm
  const fAt = (name, k) => {
    const L0 = L.noSun[k], Lns = L.noShadow[k], v = L[name][k];
    const s = Lns - L0;
    if (!(Lns > 0) || !(s > 0) || s / Lns < minShare) return null;
    return (v - L0) / s;
  };
  const meanF = (name, ks) => { let s = 0, n = 0; for (const k of ks) { const f = fAt(name, k); if (f !== null) { s += f; n++; } } return n ? s / n : null; };
  const meanL = (arr, ks) => { let s = 0, n = 0; for (const k of ks) { const v = arr[k]; if (Number.isFinite(v)) { s += v; n++; } } return n ? s / n : null; };
  const subjectsOut = subjects.map((s) => {
    const row = { kind: s.kind, name: s.name, dist: s.dist, screen: s.screen, winGround: s.winGround };
    if (s.kind === 'car') {
      Object.assign(row, { underbodyM: s.underbodyM, nUnder: s.under.length, nBand: s.band.length, nRing: s.ring.length });
      const uk = s.under.map((u) => u.k);
      // The band split by what the REFERENCE says: shadowed band and lit ring, so "the car's own
      // shadow" and "open road" are read off the truth rather than off a geometry guess.
      const bandDark = s.band.filter((k) => { const f = fAt('ref', k); return f !== null && f <= 0.1; });
      const ringLit = s.ring.filter((k) => { const f = fAt('ref', k); return f !== null && f >= 0.95; });
      row.nBandDark = bandDark.length; row.nRingLit = ringLit.length;
      row.arms = {};
      for (const name of order) {
        row.arms[name] = {
          fUnder: meanF(name, uk), fBandDark: meanF(name, bandDark), fRingLit: meanF(name, ringLit),
          lUnderOverRing: (() => { const a = meanL(L[name], uk), b = meanL(L[name], ringLit); return a !== null && b ? a / b : null; })(),
          lUnderOverBand: (() => { const a = meanL(L[name], uk), b = meanL(L[name], bandDark); return a !== null && b ? a / b : null; })(),
          ldrUnderOverRing: ldr[name] ? (() => { const a = meanL(ldr[name], uk), b = meanL(ldr[name], ringLit); return a !== null && b ? a / b : null; })() : null,
          ldrUnderOverBand: ldr[name] ? (() => { const a = meanL(ldr[name], uk), b = meanL(ldr[name], bandDark); return a !== null && b ? a / b : null; })() : null,
          // The whole ring, whatever lights it: at night the moon is under a tenth of the light on the
          // road, f cannot be read, and what the road under a car reads against the road round it is
          // the whole question.
          lUnderOverRingAll: (() => { const a = meanL(L[name], uk), b = meanL(L[name], s.ring); return a !== null && b ? a / b : null; })(),
          ldrUnderOverRingAll: ldr[name] ? (() => { const a = meanL(ldr[name], uk), b = meanL(ldr[name], s.ring); return a !== null && b ? a / b : null; })() : null,
        };
      }
      // Under the car, row by row inward from the visible sill, so a partial shadow is located.
      row.underByDepth = {};
      for (const name of ['shipped', 'ref', ...armSpecs.map((a) => a.name)]) {
        const byLx = new Map();
        for (const u of s.under) {
          const f = fAt(name, u.k); if (f === null) continue;
          const key = +(Math.round(u.lx * 10) / 10).toFixed(1);
          const e = byLx.get(key) ?? [0, 0]; e[0] += f; e[1]++; byLx.set(key, e);
        }
        row.underByDepth[name] = [...byLx.entries()].sort((a, b) => a[0] - b[0]).map(([lx, [sum, n]]) => [lx, +(sum / n).toFixed(3), n]);
      }
    } else {
      row.pxPerM = s.pxPerM;
      row.ds = s.ray.map((q) => q.d);
      row.arms = {};
      for (const name of order) row.arms[name] = s.ray.map((q) => { const m = meanF(name, q.pts); return m === null ? null : +m.toFixed(3); });
    }
    return row;
  });
  return {
    W, H, elevationDeg: +(elevation * 180 / Math.PI).toFixed(2), refHalf, minShare,
    F: [+F.x.toFixed(1), +F.y.toFixed(2), +F.z.toFixed(1)],
    groupCount, inRefCount: inRef.reduce((a, b) => a + b, 0), inRef2Count: inRef2.reduce((a, b) => a + b, 0),
    buckets: bucketNames.map((b, i) => ({ bucket: b, group: groupOf(b), px: bucketPx[i] })).filter((b) => b.px > 0)
      .sort((a, b) => b.px - a.px),
    registration: { maxRelDiff: regMax }, timings, subjects: subjectsOut,
    census: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { config: v.config, census: v.census ?? null }])),
    shots, maps, seconds: +((performance.now() - t0) / 1000).toFixed(1),
  };
}

// ------------------------------------------------------------------------------------ the live half
if (IS_MAIN && !has('selftest')) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  const { HERO_FRAMINGS, placeHeroCam, settleFrames } = await import('./hero-cams.mjs');
  const PORT = Number(arg('port', 0));
  if (!PORT || PORT === 8123) { console.error('--port is required and may not be 8123 (the main tree)'); process.exit(2); }
  const CAM = arg('cam', 'fivepoints');
  const TODS = arg('tods', 'noon').split(',');
  const ARMS = arg('arms', 'shipped').split(',').filter(Boolean);
  const TAG = arg('tag', 'shadowbias');
  const REF = Number(arg('ref', 40));
  const COMPOSITE = arg('composite', 'shipped').split(',').filter(Boolean);
  const SHOTS = has('shots');
  const MAPS = arg('maps', '').split(',').filter(Boolean);
  // Where the frames, maps and the JSON go. docs/ by default, like every capture tool here; a sweep
  // run for a round's own reading belongs in a scratch directory, not in the repo.
  const OUT = arg('out', 'docs');
  fs.mkdirSync(`${OUT}/shots`, { recursive: true });
  const SETTLE = Number(arg('settle', 6));
  const framing = HERO_FRAMINGS.find((f) => f.name === CAM);
  if (!framing) { console.error(`unknown --cam ${CAM}`); process.exit(2); }
  for (const t of TODS) if (!PRESETS[t]) { console.error(`unknown tod ${t}`); process.exit(2); }

  const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
  console.log(`server: ${srv.started ? 'started' : 'reused'} :${srv.port} root=${srv.root}`);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 600000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
  const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
  console.log(`cloud deck: ${froze ? `frozen at ${froze.atSeconds}s` : 'NOT FROZEN'}`);
  const placed = await placeHeroCam(page, framing);
  console.log(`${CAM}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ${placed.clearance} m clear`);
  await settleFrames(page, 30, `camera ${CAM}`);

  const all = { tag: TAG, cam: CAM, port: PORT, placed, arms: ARMS, hours: {}, errors };
  for (const tod of TODS) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await settleFrames(page, SETTLE, `tod ${tod}`);
    const el = PRESETS[tod].elevation;
    const armSpecs = ARMS.filter((n) => !['shipped', 'noShadow', 'noSun', 'ref', 'ref2'].includes(n)).map((n) => parseArm(n, el));
    const contactNow = await page.evaluate(() => (__district.carContactReport ? __district.carContactReport() : null));
    console.log(`  car contact footprint: ${JSON.stringify(contactNow)}`);
    const minShare = Number(arg('minShare', tod === 'night' ? 0.10 : 0.25));
    const t0 = Date.now();
    const out = await page.evaluate(measureInPage, {
      armSpecs, refHalf: REF, minShare, bucketSrc: bucketSource, censusSrc: censusSource, groupSrc: groupSource,
      nGroups: GROUPS.length, compositeArms: COMPOSITE, wantShots: SHOTS, mapArms: MAPS,
    });
    console.log(`\n=== ${CAM} / ${tod}  (sun ${out.elevationDeg} deg, ${((Date.now() - t0) / 1000).toFixed(0)} s, ` +
      `registration max rel diff ${out.registration.maxRelDiff.toExponential(2)})`);
    console.log(`  arm timings (s): ${Object.entries(out.timings).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  reference box +-${out.refHalf} m round (${out.F.join(', ')}): ${out.inRefCount} px inside, ref2 ${out.inRef2Count}`);
    console.log(`  pixels by group: ${GROUPS.map((g, i) => `${g} ${out.groupCount[i]}`).join(', ')}`);
    for (const [name, c] of Object.entries(out.census)) {
      const cfg = c.config;
      console.log(`  arm ${name.padEnd(12)} bias ${cfg.biasMetres} m  normalBias ${cfg.normalBias}  map ${cfg.mapSize} +-${cfg.half}` +
        (name.startsWith('b') || name.startsWith('e') || name === 'shipped' ? `  vertical tolerance ${verticalTolerance(cfg.biasMetres, cfg.normalBias, el).toFixed(3)} m` : ''));
    }
    // CONTACT
    for (const s of out.subjects) {
      if (s.kind === 'car') {
        console.log(`\n  ${s.name} at ${s.dist} m, screen ${s.screen}, underbody ${s.underbodyM} m: ` +
          `${s.nUnder} road points under the body seen, band ${s.nBand} (${s.nBandDark} dark in ref), ring ${s.nRing} (${s.nRingLit} lit in ref)`);
        console.log('    arm            f under  f band   f ring   L under/ring  L under/band  seen under/ring  seen under/band   L under/all ring  seen under/all ring');
        for (const [name, a] of Object.entries(s.arms)) {
          const f = (v, d = 3) => (v === null || v === undefined ? '   -   ' : v.toFixed(d).padStart(7));
          console.log(`    ${name.padEnd(13)} ${f(a.fUnder)}  ${f(a.fBandDark)}  ${f(a.fRingLit)}   ${f(a.lUnderOverRing, 4)}       ${f(a.lUnderOverBand, 4)}        ${f(a.ldrUnderOverRing, 4)}         ${f(a.ldrUnderOverBand, 4)}           ${f(a.lUnderOverRingAll, 4)}            ${f(a.ldrUnderOverRingAll, 4)}`);
        }
        console.log('    f under the body by lateral position in the car (lx m: f, n):');
        for (const [name, rows] of Object.entries(s.underByDepth)) {
          console.log(`      ${name.padEnd(12)} ${rows.map(([lx, f, n]) => `${lx}:${f}/${n}`).join('  ')}`);
        }
      } else {
        const idx = s.ds.map((d, i) => [d, i]).filter(([d]) => [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5].some((q) => Math.abs(q - d) < 1e-6));
        console.log(`\n  ${s.name} at ${s.dist} m (${s.pxPerM} px/m, ${s.winGround} clean ground px within 1.6 m), f along the ground away from the sun:`);
        console.log('    arm          ' + idx.map(([d]) => `${d.toFixed(2)}m`.padStart(7)).join(''));
        for (const [name, a] of Object.entries(s.arms)) console.log(`    ${name.padEnd(12)} ` + idx.map(([, i]) => String(a[i] ?? '-').padStart(7)).join(''));
      }
    }
    // ACNE / LEAK
    console.log('\n  census over sun-facing pixels inside the reference box (acne: lit in ref, f<=0.5; leak: dark in ref, f>=0.5)');
    console.log('    arm            ' + GROUPS.slice(1, 6).map((g) => g.padStart(26)).join(''));
    for (const [name, c] of Object.entries(out.census)) {
      if (!c.census) continue;
      const cells = GROUPS.slice(1, 6).map((g, gi) => {
        const rr = rates(c.census[gi + 1]);
        const p = (v) => (v === null ? '  -  ' : (100 * v).toFixed(1).padStart(5));
        return `${p(rr.acne)}/${p(rr.leak)} f${rr.meanF === null ? ' -  ' : rr.meanF.toFixed(2)} n${String(rr.n).padStart(6)}`.padStart(26);
      });
      console.log(`    ${name.padEnd(13)} ${cells.join('')}`);
    }
    console.log('  the same in pixels, acne/refLit  leak/refDark:');
    for (const [name, c] of Object.entries(out.census)) {
      if (!c.census) continue;
      const cells = GROUPS.slice(1, 6).map((g, gi) => {
        const o = c.census[gi + 1];
        return `${o.acne}/${o.refLit} ${o.leak}/${o.refDark}`.padStart(26);
      });
      const tot = GROUPS.slice(1, 6).reduce((a, g, gi) => a + c.census[gi + 1].acne + c.census[gi + 1].leak, 0);
      console.log(`    ${name.padEnd(13)} ${cells.join('')}   errors ${tot}`);
    }
    if (SHOTS) {
      for (const [name, url] of Object.entries(out.shots)) {
        const f = `${OUT}/shots/${TAG}-${CAM}-${tod}-${name}.png`;
        fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
        console.log(`  wrote ${f}`);
      }
    }
    for (const [name, url] of Object.entries(out.maps ?? {})) {
      const f = `${OUT}/shots/${TAG}-${CAM}-${tod}-map-${name}.png`;
      fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`  wrote ${f}`);
    }
    console.log(`  pixels by bucket: ${out.buckets.map((b) => `${b.bucket} [${GROUPS[b.group]}] ${b.px}`).join(', ')}`);
    delete out.shots; delete out.maps;
    all.hours[tod] = out;
  }
  fs.writeFileSync(`${OUT}/${TAG}-${CAM}.json`, JSON.stringify(all, null, 1));
  console.log(`\nwrote ${OUT}/${TAG}-${CAM}.json`);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  await browser.close();
}
