// THE SUN'S SHADOW BOX FOLLOWS THE VIEWER IN WHOLE TEXELS — BACKLOG #117's gate.
//
//   node tools/shadow-stable.mjs              the gate, offline, in about a tenth of a second
//   node tools/shadow-stable.mjs --selftest   the checks against the follow() this replaced
//
// A blind reviewer saw "22 isolated, soft-edged squares of about 0.5 m on the road" change between two
// stills half a second apart. They were shadow-map texels: TimeOfDay.follow() centred the sun's ortho
// shadow box on the player's car EXACTLY, so every centimetre the car moved re-rasterised every caster
// at a new sub-texel phase. Measured in the page at corridor noon with the car out of frame: a 2.3 cm
// step changed 12.6-13.1% of the ground pixels by more than 2 levels, every frame; with the box
// snapped it is 0.02-0.06%, the level of a still car (0.06-0.10%).
//
// This gate drives the REAL TimeOfDay — the same object district/main.js builds — through three's own
// LightShadow.updateMatrices, the function the renderer calls, and reads where a fixed point of the
// world lands in the shadow map. No GL context is needed for any of that, so it runs offline.
//
//   phase      a fixed world point lands at the same SUB-TEXEL position for every viewer position:
//              a move is then a whole-texel shift of the map, which rasterises to the same picture
//   whole      and a move does shift it: the map is not simply frozen in place
//   direction  the light's direction is the preset's, whatever the viewer's height: it took the sun's
//              height as an absolute while the target took the car's y, so a 20 cm kerb tilted every
//              shadow in the frame
//   centred    the box stays on the viewer, within half a texel on each lateral axis, and since
//              #124 within half a texel ALONG the light too: that axis is snapped at the same pitch
//   drift      a viewer creeping along the light a millimetre a step does not move the box. It was
//              left exact on the argument that a depth shift changes nothing, and on the GPU's float32
//              shadow matrix it re-rounds every contact edge: a parked car crawling 5.9 mm moved 57
//              pixels of the corridor's cornice edge 1-6 levels as shipped, and 0 snapped
//   post       the post stack's sun direction is the preset's too, after a follow AND after a weather
//              change: _applyPost normalised the light's POSITION, which after follow() is the viewer
//              plus 400 m toward the sun, so it pointed from the world origin
import * as THREE from '../vendor/three.module.min.js';
import { TimeOfDay, PRESETS } from '../src/daynight.js';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--selftest']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/shadow-stable.mjs [--selftest]`);
    process.exit(2);
  }
}

/** Fixed, so a check cannot vanish when a population is empty (CLAUDE.md, car-pixel). */
export const CHECK_COUNT = 8;

/** A TimeOfDay with a renderer that only has to accept the tone-mapping writes apply() makes. */
export function makeTod() {
  const renderer = { toneMapping: 0, toneMappingExposure: 1, shadowMap: {} };
  const tod = new TimeOfDay(new THREE.Scene(), renderer);
  // The fields _applyPost and normalisePostExposure write, and nothing else: a post stack stub.
  tod.attachPost({ params: { exposure: 1, fogColor: new THREE.Color(), fogInscatter: new THREE.Color(),
    fogDensity: 0, fogHeightFalloff: 0, bloomThreshold: 0, bloomStrength: 0, wetness: 0,
    sunDirection: new THREE.Vector3() } });
  return tod;
}

// A deterministic walk: sub-texel nudges, a suspension bob, a kerb, and real driving.
function* walk() {
  let s = 12345;
  const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const base = [[57.46, 0.717, -163.82], [-327.84, 0.717, 63.3], [412.0, 1.9, 288.5]];
  for (const [x, y, z] of base) {
    yield [x, y, z];
    for (let i = 0; i < 40; i++) yield [x + (r() - 0.5) * 0.2, y + (r() - 0.5) * 0.004, z + (r() - 0.5) * 0.2];
    yield [x, y + 0.2, z];                                   // a kerb
    for (let i = 0; i < 10; i++) yield [x + r() * 40, y + r() * 3, z + r() * 40];   // driving, a ramp
  }
}

/** Measure one TimeOfDay over every preset: the raw quantities the checks read. */
export function measure(tod) {
  const N = tod.sun.shadow.mapSize.x;
  const cam = tod.sun.shadow.camera;
  cam.updateProjectionMatrix();
  const texel = (cam.right - cam.left) / N;
  const points = [new THREE.Vector3(60, 0, -150), new THREE.Vector3(-300, 0, 80), new THREE.Vector3(430, 4, 300)];
  const v = new THREE.Vector4();
  const dir = new THREE.Vector3(), want = new THREE.Vector3();
  const out = { texel, presets: {} };
  for (const name of Object.keys(PRESETS)) {
    tod.apply(name);
    const p = PRESETS[name];
    want.set(Math.cos(p.azimuth) * Math.cos(p.elevation), Math.sin(p.elevation), Math.sin(p.azimuth) * Math.cos(p.elevation));
    let phaseDev = 0, dirDev = 0, offMax = 0, alongMax = 0, moves = 0, wholeMoves = 0, n = 0, firstPhase = null;
    let lastUV = null, postDev = 0;
    const postDir = () => tod.post.params.sunDirection.angleTo(want) * 180 / Math.PI;
    for (const [x, y, z] of walk()) {
      tod.follow({ x, y, z });
      tod.sun.updateMatrixWorld(); tod.sun.target.updateMatrixWorld();
      tod.sun.shadow.updateMatrices(tod.sun);
      n++;
      // The light's direction, as the renderer will build it.
      dir.copy(tod.sun.position).sub(tod.sun.target.position).normalize();
      dirDev = Math.max(dirDev, dir.angleTo(want));
      // Where the box sits against the viewer: across the light, and along it.
      const off = new THREE.Vector3().copy(tod.sun.target.position).sub(new THREE.Vector3(x, y, z));
      const along = off.dot(want);
      alongMax = Math.max(alongMax, Math.abs(along));
      offMax = Math.max(offMax, off.addScaledVector(want, -along).length() / texel);
      // Each fixed point's position in the map, in texels.
      const uv = points.map((P) => {
        v.set(P.x, P.y, P.z, 1).applyMatrix4(tod.sun.shadow.matrix);
        return [v.x * N, v.y * N];
      });
      const phase = uv.map(([u, w]) => [u - Math.floor(u), w - Math.floor(w)]);
      if (!firstPhase) firstPhase = phase;
      for (let i = 0; i < phase.length; i++) for (let k = 0; k < 2; k++) {
        // Distance on the circle, so 0.9999 against 0.0001 is a deviation of 0.0002.
        const d = Math.abs(phase[i][k] - firstPhase[i][k]);
        phaseDev = Math.max(phaseDev, Math.min(d, 1 - d));
      }
      if (lastUV) {
        const du = uv[0][0] - lastUV[0][0], dw = uv[0][1] - lastUV[0][1];
        if (Math.abs(du) > 0.5 || Math.abs(dw) > 0.5) moves++;
        if (Math.abs(du - Math.round(du)) < 1e-4 && Math.abs(dw - Math.round(dw)) < 1e-4 &&
          (Math.round(du) !== 0 || Math.round(dw) !== 0)) wholeMoves++;
      }
      lastUV = uv;
      // And the post stack's copy: after the follow, and after a weather change re-applies the post.
      postDev = Math.max(postDev, postDir());
      tod.setWeather({});
      postDev = Math.max(postDev, postDir());
    }
    // THE DRIFT: a viewer creeping ALONG THE LIGHT, a millimetre a step for 40 mm, which is under half
    // a texel, from a parked car's own position. Snapped, the box can cross at most one step boundary
    // in that; left exact, it moves on every step.
    let driftMoves = 0, driftN = 0, lastSun = null;
    for (let k = 0; k <= 40; k++) {
      tod.follow({ x: 57.46 + want.x * k * 0.001, y: 0.717 + want.y * k * 0.001, z: -163.82 + want.z * k * 0.001 });
      const sp = tod.sun.position.clone();
      if (lastSun) { driftN++; if (sp.distanceTo(lastSun) > 1e-9) driftMoves++; }
      lastSun = sp;
    }
    out.presets[name] = { n, phaseDev, dirDevDeg: dirDev * 180 / Math.PI, offMaxTexels: offMax, alongMax, moves,
      wholeMoves, postDevDeg: postDev, driftMoves, driftN };
  }
  return out;
}

/** The verdict as a pure function of the measurement, so the selftest can feed it known-bads. */
export function verdict(m) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const P = Object.entries(m.presets ?? {});
  const num = (v) => (Number.isFinite(v) ? v : null);
  add('every preset was walked over the viewer positions', P.length >= 4 && P.every(([, r]) => r.n >= 150),
    P.map(([k, r]) => `${k} ${r.n}`).join(', '));
  const worstPhase = Math.max(...P.map(([, r]) => num(r.phaseDev) ?? Infinity));
  // 1e-4 of a texel is 12 microns of ground: float noise in a 64-bit matrix chain, nothing a
  // rasteriser can see, and four orders of magnitude under the 0.06 a 1 cm move used to cost.
  add('a fixed point of the world keeps its sub-texel phase whatever the viewer does',
    worstPhase < 1e-4, P.map(([k, r]) => `${k} ${r.phaseDev?.toExponential(2)}`).join(', ') + ' texel');
  add('and the map does move with the viewer, in whole texels',
    P.every(([, r]) => r.moves > 0 && r.wholeMoves >= r.moves),
    P.map(([k, r]) => `${k} ${r.wholeMoves}/${r.moves}`).join(', '));
  const worstDir = Math.max(...P.map(([, r]) => num(r.dirDevDeg) ?? Infinity));
  add('the light\'s direction is the preset\'s, whatever the viewer\'s height', worstDir < 1e-6,
    P.map(([k, r]) => `${k} ${r.dirDevDeg?.toExponential(2)}`).join(', ') + ' deg');
  // Half a texel on each of two axes is a diagonal of 0.707.
  const worstOff = Math.max(...P.map(([, r]) => num(r.offMaxTexels) ?? Infinity));
  add('the box stays on the viewer: within half a texel on each lateral axis', worstOff <= Math.SQRT1_2 + 1e-9,
    `worst ${worstOff.toFixed(4)} texel of ${m.texel} m`);
  // RESTATED for #124: this read "and is not moved along the light at all", worstAlong < 1e-9, which was
  // the old design. Along the light the box is snapped at the texel's pitch now, so it sits within half
  // a texel of the viewer on that axis exactly as it does on the other two.
  const worstAlong = Math.max(...P.map(([, r]) => num(r.alongMax) ?? Infinity));
  add('and within half a texel of the viewer along the light', worstAlong <= m.texel / 2 + 1e-9,
    `worst ${worstAlong.toExponential(2)} m against ${(m.texel / 2).toExponential(2)}`);
  add('a viewer creeping along the light does not move the box: at most one step in 40 mm of 1 mm creeps',
    P.length >= 4 && P.every(([, r]) => num(r.driftN) >= 40 && num(r.driftMoves) !== null && r.driftMoves <= 1),
    P.map(([k, r]) => `${k} ${r.driftMoves}/${r.driftN}`).join(', '));
  const worstPost = Math.max(...P.map(([, r]) => num(r.postDevDeg) ?? Infinity));
  add('the post stack\'s sun direction is the preset\'s too, after a follow and after a weather change',
    worstPost < 1e-6, P.map(([k, r]) => `${k} ${r.postDevDeg?.toExponential(2)}`).join(', ') + ' deg');
  return checks;
}

const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (IS_MAIN && argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const say = (ok, name, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); ok ? pass++ : fail++; };
  console.log('SHADOW-STABLE SELFTEST');
  const good = verdict(measure(makeTod()));
  say(good.length === CHECK_COUNT && good.every((c) => c.ok), `the shipped follow() passes all ${CHECK_COUNT} checks`,
    good.filter((c) => !c.ok).map((c) => c.name).join(' | '));
  const failsOn = (tod, needle) => {
    const v = verdict(measure(tod));
    return { hit: v.some((c) => !c.ok && c.name.includes(needle)), failing: v.filter((c) => !c.ok).map((c) => c.name) };
  };
  // KNOWN-BAD 1: the follow() this replaced, verbatim — the box on the viewer exactly, and the sun's
  // height an absolute while the target takes the viewer's y.
  const old = makeTod();
  old.follow = function follow(pos) {
    const p = this.preset, d = 400;
    this.sun.position.set(pos.x + Math.cos(p.azimuth) * Math.cos(p.elevation) * d, Math.sin(p.elevation) * d,
      pos.z + Math.sin(p.azimuth) * Math.cos(p.elevation) * d);
    this.sun.target.position.set(pos.x, pos.y, pos.z);
    this.sun.target.updateMatrixWorld();
  };
  let r = failsOn(old, 'sub-texel phase');
  say(r.hit, 'KNOWN-BAD: the unsnapped follow() fails the phase check', r.failing.join(' | '));
  r = failsOn(old, 'direction');
  say(r.hit, 'KNOWN-BAD: and its height term fails the direction check', r.failing.join(' | '));
  // KNOWN-BAD 2: snapped, but in WORLD x and z rather than the shadow camera's own axes.
  const world = makeTod();
  world.shadowCentre = function (pos, out) {
    const cam = this.sun.shadow.camera, t = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
    return out.set(Math.round(pos.x / t) * t, pos.y, Math.round(pos.z / t) * t);
  };
  r = failsOn(world, 'sub-texel phase');
  say(r.hit, 'KNOWN-BAD: a snap in world axes instead of the light\'s fails the phase check', r.failing.join(' | '));
  // KNOWN-BAD 3: a box that never moves passes the phase check for the most flattering reason.
  const frozen = makeTod();
  frozen.shadowCentre = (pos, out) => out.set(0, 0, 0);
  r = failsOn(frozen, 'whole texels');
  say(r.hit, 'KNOWN-BAD: a box frozen at the origin fails "the map does move"', r.failing.join(' | '));
  r = failsOn(frozen, 'stays on the viewer');
  say(r.hit, 'KNOWN-BAD: and fails "the box stays on the viewer"', r.failing.join(' | '));
  // KNOWN-BAD 4: the _applyPost this replaced, whose last line normalised the light's position.
  const origin = makeTod();
  const applied = origin._applyPost.bind(origin);
  origin._applyPost = function () { applied(); this.post.params.sunDirection.copy(this.sun.position).normalize(); };
  r = failsOn(origin, 'post stack');
  say(r.hit, 'KNOWN-BAD: the post\'s sun direction taken from the light\'s position fails', r.failing.join(' | '));
  // KNOWN-BAD 5b: the shadowCentre this round replaced, verbatim: snapped across the light and exact
  // along it. A creeping viewer moves the box on every step, which is #124's cornice shimmer.
  const exactAlong = makeTod();
  exactAlong.shadowCentre = function (pos, out) {
    const d = this.sunDirection(new THREE.Vector3());
    const c = Math.hypot(d.x, d.z);
    const X = c > 1e-6 ? new THREE.Vector3(d.z / c, 0, -d.x / c) : new THREE.Vector3(1, 0, 0);
    const Y = new THREE.Vector3().crossVectors(d, X);
    const cam = this.sun.shadow.camera, texel = (cam.right - cam.left) / this.sun.shadow.mapSize.x;
    const a = pos.x * X.x + pos.y * X.y + pos.z * X.z, b = pos.x * Y.x + pos.y * Y.y + pos.z * Y.z;
    return out.set(pos.x, pos.y, pos.z).addScaledVector(X, Math.round(a / texel) * texel - a)
      .addScaledVector(Y, Math.round(b / texel) * texel - b);
  };
  r = failsOn(exactAlong, 'creeping along the light');
  say(r.hit, 'KNOWN-BAD: the box exact along the light moves under a millimetre creep', r.failing.join(' | '));
  r = failsOn(exactAlong, 'sub-texel phase');
  say(!r.hit, 'and it still passes the phase check, so the drift check is the only thing that sees it', r.failing.join(' | '));
  // KNOWN-BAD 5: an empty measurement cannot pass.
  const empty = verdict({ texel: 0.117, presets: {} });
  say(empty.length === CHECK_COUNT && empty.filter((c) => !c.ok).length >= 1,
    'KNOWN-BAD: no presets walked fails, and the check count does not shrink', `${empty.length} checks`);
  console.log(`\nSHADOW-STABLE SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
if (IS_MAIN && !argv.includes('--selftest')) {
  const t0 = performance.now();
  const m = measure(makeTod());
  console.log(`SHADOW-STABLE — the sun's shadow box against a walk of ${m.presets.noon?.n} viewer positions per preset,` +
    ` texel ${m.texel} m\n`);
  console.log('  preset   phase dev (texel)   whole-texel moves   light vs preset (deg)   box off viewer (texel)   post vs preset (deg)');
  for (const [k, r] of Object.entries(m.presets)) {
    console.log(`  ${k.padEnd(8)} ${r.phaseDev.toExponential(2).padStart(12)}      ${String(r.wholeMoves).padStart(4)} of ${String(r.moves).padEnd(4)}` +
      `       ${r.dirDevDeg.toExponential(2).padStart(10)}            ${r.offMaxTexels.toFixed(4)}                ${r.postDevDeg.toExponential(2)}`);
  }
  console.log('');
  const checks = verdict(m);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nSHADOW-STABLE: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks in ${((performance.now() - t0) / 1000).toFixed(2)} s` +
    `${failed.length ? `, ${failed.length} failed` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
