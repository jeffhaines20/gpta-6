// What does the dome's GROUND ALBEDO actually do to the colour of a shaded wall?
//
// src/sky.js's skyRadiance() fades the dome into groundRadiance() = uGroundAlbedo
// * E / PI below the horizon, so the dome's lower hemisphere IS the district's
// ground bounce and uGroundAlbedo is the only lever in the whole lighting model
// that puts WARM light on a surface the sun cannot see. The transfer round sized
// a candidate change to it from arithmetic — the albedo reads luminance 0.129
// against a district ground of 0.18-0.19, which is +0.28 stops on roughly half a
// wall's ambient — and deliberately did not apply it.
//
// This is the measurement that arithmetic needs. The uniform is set once at
// construction and _pushUniforms() never rewrites it, so a candidate value can be
// injected into a running district and the LUT and PMREM rebuilt around it. Every
// candidate is therefore measured on ONE streamed scene at ONE camera with one
// browser launch: nothing else moves between arms.
//
// What it reads, per candidate per preset:
//
//   - the dome's own cosine-weighted integrals over the upper and lower
//     hemispheres, in lux and in linear RGB. The lower one is what the PMREM
//     hands every down-facing and vertical surface; the upper one is what
//     audit().skyLux gates, and it must NOT move (see below).
//   - a shaded wall, a sunlit wall and the road, read out of the HDR scene target
//     in linear nits — so blue/red is a ratio of LIGHT and not a ratio of bytes
//     that ACES has already compressed.
//   - sky.audit() and daynight.audit(), so the plausibility envelope's verdict is
//     recorded next to every arm rather than checked once at the end.
//
// THE CONTROL IS NOT OPTIONAL. A probe that changes nothing produces a beautifully
// stable set of numbers, and this project has shipped one before (a visibility
// toggle that affected zero meshes). `--controls` prepends a black albedo and a
// white one: if the shaded wall's blue/red does not move a long way between those
// two, the injection is not reaching the render and every other row is noise.
//
//   node tools/ground-albedo.mjs --albedos 6b6455,7d7362,8a8070 --controls
//   GA_SHOT=fivepoints GA_TIMES=noon,golden node tools/ground-albedo.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const TIMES = (process.env.GA_TIMES ?? 'noon,golden,dusk,night').split(',');
const SHOT = process.env.GA_SHOT ?? 'corridor';
const TAG = process.env.GA_TAG ?? 'ga';
const SHOOT = has('shots');
let ALBEDOS = String(arg('albedos', '6b6455')).split(',').filter(Boolean);
if (has('controls')) ALBEDOS = ['000000', 'ffffff', ...ALBEDOS];

// Regions in 1600x900 screenshot pixels, y down. The wall boxes are the two the
// round-7 lighting isolation and tools/sky-once.mjs already name, kept so the
// numbers can be laid beside theirs; `sunPct` beside each one is how a reader
// tells a shaded wall from a sunlit one rather than trusting the label.
const REGIONS = {
  wall:   [120, 120, 120, 60],
  ground: [250, 800, 120, 40],
  plaza:  [0, 700, 1000, 200],
  road:   [1340, 575, 240, 32],
};

// The same decode src/sky.js's `srgb()` helper applies, so a hex on this command
// line means exactly what the same hex means in the source.
export const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linear = (hex) => {
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbDecode);
};

// ------------------------------------------------------------------- ARMS
//
// TWO BUILDS IN ONE SESSION, and the reason is not convenience. A lighting change
// is normally A/B'd by capturing, editing the source, and capturing again - which
// measures that change only if nothing ELSE moved on disk in between. On
// 2026-09-05 three agents were in this tree at once and src/facades.js changed
// between one capture and the next, so a straight before/after would have
// measured a facade round and a sky round together and credited both to the sky.
//
// An arm is a set of uniform values pushed into a RUNNING district. The camera is
// placed and the streamer settles once; each arm then rebuilds the LUT and the
// PMREM around its own uniforms and takes its own frame. Geometry, materials,
// streaming state, traffic and camera are bit-identical across arms by
// construction. Exported here rather than copied into each harness, which is the
// mistake tools/framing.mjs exists because of.
export const ARM_STATE = {
  // The build as it stood before 2026-09-05: uGroundAlbedo 0x6b6455, and a ground
  // bounce whose sky term was 0.16 * uSunIlluminance * sin(elevation) PLUS the
  // night-glow constant (uNightHorizon + uNightZenith) * PI.
  //
  // That constant is 0.80 lux at every hour and it is not decoration at two of
  // them: this file's dusk preset puts the sun at elevation exactly 0 and its
  // night preset puts it below the horizon, so 0.16 * ndl is zero and the
  // constant is the WHOLE of the old sky term there. Leaving it out of the
  // emulation would have made the before-arm's ground bounce 0.000 nits at dusk
  // and night instead of 0.033, which is three display levels on a night wall lit
  // by the dome alone - small, and in the direction that would have flattered
  // this round.
  ground0: { albedo: linear('6b6455'), skyProxy: true, nightGlowLux: 0.8014 },
  // The build as it stands now - whatever the source says, untouched.
  ground1: { albedo: null, skyProxy: false, nightGlowLux: 0 },

  // THE MS WHITENING'S DIRECTIONAL SCOPE (src/sky.js, msWhitenAnti): how much of
  // the whitening survives at the anti-solar point. These arms leave the ground
  // exactly as the build has it and move only that scalar, so a frame-level
  // before/after on the anti-solar sky can be shot from ONE streamed district -
  // which matters more here than usual, because the quantity being read is a
  // 0.05 chroma offset on a sky rect and a moved cloud is worth more than that.
  //
  // anti100 IS the isotropic behaviour the whitening shipped with, so it is the
  // control: it must reproduce the r8 arm, and if it does not, the frames are
  // measuring something other than this change.
  anti100: { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 1.0 },
  anti50:  { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 0.5 },
  anti25:  { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 0.25 },
  anti00:  { albedo: null, skyProxy: false, nightGlowLux: 0, msWhitenAnti: 0.0 },

  // THE DISTRICT BOUNCE, scaled. It is a HemisphereLight and three.js gives it no
  // occlusion, so it reaches the road under a closed oak canopy in full - which is
  // exactly where noon's dapple is read. bounce00 is the build with the bounce
  // removed and nothing else touched, which is the only way to say how much of
  // noon's lost dapple contrast is the bounce and how much is everything else that
  // moved in the same round (SSAO went 2.2 m at exponent 3.8 -> 0.6 m at 8.5 and
  // the buffer to full resolution, and that is another agent's file).
  //
  // The scale is applied by WRAPPING _applyBounce, not by writing the intensity:
  // follow() recomputes the bounce from the sun every frame, so a value assigned
  // once is gone by the next frame and the arm would silently be the base build.
  bounce00: { albedo: null, skyProxy: false, nightGlowLux: 0, bounceScale: 0 },
  bounce50: { albedo: null, skyProxy: false, nightGlowLux: 0, bounceScale: 0.5 },

  // THE OTHER THING THAT MOVED IN THE SAME ROUND. Between r2post and r8 the SSAO
  // went from 2.2 m at exponent 3.8 to 0.6 m at 8.5 and its buffer to full
  // resolution, and a contact-shadow term of that size is a candidate for noon's
  // lost road dapple every bit as much as the ambient is. ao22 restores the old
  // parameters at runtime so the two can be separated in ONE session instead of
  // being attributed by argument. It writes postParams only - src/post.js is
  // another agent's file this round and is not touched.
  ao22: { albedo: null, skyProxy: false, nightGlowLux: 0, ao: [2.2, 3.8, 1.0] },
};

/**
 * Push an arm's uniforms and rebuild everything derived from them.
 *
 * ground0's sky term is reproduced as a GREY illuminance, including the night-glow
 * constant. What is not reproduced is that constant's COLOUR - it was
 * [1.04, 0.73, 0.83] lux and this is 0.80 grey - which at noon and golden is four
 * parts in a hundred thousand of E, and at dusk and night is a hue error on a term
 * that renders 0.033 nits against a shaded wall reading 0.278. One display level,
 * stated rather than assumed away.
 */
export async function setArm(page, name) {
  const st = ARM_STATE[name];
  if (!st) throw new Error(`unknown arm ${name}; known: ${Object.keys(ARM_STATE).join(', ')}`);
  return page.evaluate((s) => {
    const sky = __district.sky, u = sky._uniforms;
    if (!window.__armSaved) {
      const a = u.uGroundAlbedo.value;
      window.__armSaved = { albedo: [a.r, a.g, a.b] };
    }
    const a = s.albedo ?? window.__armSaved.albedo;
    u.uGroundAlbedo.value.setRGB(a[0], a[1], a[2]);
    // uSkyIlluminance CANNOT simply be assigned. refresh() reads the probe and
    // _deriveFromProbe() writes this uniform from the dome's own integral before
    // the LUT is rendered, so a value set now is overwritten by the very value
    // the arm exists to replace. Wrap the writer instead: the override then lands
    // where the real value does, on every refresh, including the ones a
    // time-of-day change makes on its own.
    if (u.uSkyIlluminance && !sky.__armPatched) {
      const orig = sky._deriveFromProbe.bind(sky);
      sky._deriveFromProbe = function patched(buf, gen) {
        orig(buf, gen);
        if (window.__armOverride != null) u.uSkyIlluminance.value = window.__armOverride;
      };
      sky.__armPatched = true;
    }
    // 127,500 is src/sky.js's SUN_ILLUMINANCE. Taken off the dome's own sun
    // direction rather than a preset table, so it cannot disagree with the sun in
    // frame.
    window.__armOverride = s.skyProxy
      ? 127500 * 0.16 * Math.max(sky.sunDirection.y, 0) + (s.nightGlowLux ?? 0)
      : null;
    // Saved and restored like the albedo, so an arm that does not name it gets
    // the build's own value rather than the previous arm's.
    if (window.__armSaved.msWhitenAnti === undefined) {
      window.__armSaved.msWhitenAnti = sky.msWhitenAnti;
    }
    sky.msWhitenAnti = s.msWhitenAnti ?? window.__armSaved.msWhitenAnti;
    // The bounce scale, wrapped once and driven by a window global thereafter, so
    // that follow()'s per-frame _applyBounce() cannot restore the base value
    // between the arm being set and the shutter opening.
    const dn = window.__district && window.__district.tod;
    if (dn && !dn.__armPatched) {
      const origBounce = dn._applyBounce.bind(dn);
      dn._applyBounce = function patchedBounce() {
        const b = origBounce();
        const k = window.__bounceScale;
        if (k != null) this.bounce.intensity *= k;
        return b;
      };
      dn.__armPatched = true;
    }
    window.__bounceScale = s.bounceScale ?? null;
    if (dn) dn._applyBounce();
    // SSAO, saved and restored the same way, so an arm that does not name it gets
    // the build's own parameters rather than the previous arm's.
    const q = window.__district && window.__district.postParams && window.__district.postParams();
    if (q) {
      if (!window.__armSavedAO) window.__armSavedAO = [q.aoRadius, q.aoIntensity, q.aoStrength];
      const ao = s.ao ?? window.__armSavedAO;
      q.aoRadius = ao[0]; q.aoIntensity = ao[1]; q.aoStrength = ao[2]; q.aoEnabled = true;
    }
    sky._dirty = true;
    sky.refresh({ force: true, environment: true, sync: true });
    const g = u.uGroundAlbedo.value;
    return { albedo: [+g.r.toFixed(4), +g.g.toFixed(4), +g.b.toFixed(4)],
      skyIlluminance: u.uSkyIlluminance ? +u.uSkyIlluminance.value.toFixed(1) : null,
      // Read back off the UNIFORM, not off the property that was just written -
      // an arm that sets a field _pushUniforms never reads is an arm that does
      // nothing, and this is the number proveArmsDiffer keys on.
      msWhitenAnti: u.uMsWhitenAnti ? +u.uMsWhitenAnti.value.toFixed(3) : null,
      bounceLux: dn ? +dn.bounce.intensity.toFixed(2) : null,
      ao: q ? [q.aoRadius, q.aoIntensity, q.aoStrength] : null,
      skyLuxUpper: +(sky.audit().skyLux ?? 0).toFixed(1) };
  }, st);
}

/**
 * Apply every arm once and refuse to continue if they resolve to the same
 * uniforms. An injection that reaches nothing produces a beautifully consistent
 * set of frames and a confident "the change did nothing"; this project has
 * shipped exactly that probe before.
 */
export async function proveArmsDiffer(page, arms) {
  const seen = [];
  for (const a of arms) seen.push({ arm: a, ...(await setArm(page, a)) });
  // msWhitenAnti is in the key because the sky arms differ in NOTHING ELSE: with
  // the old two-field key, four whitening arms would have hashed identical and
  // this guard would have passed a set of frames that were all the same build.
  const distinct = new Set(seen.map((s) => JSON.stringify([s.albedo, s.skyIlluminance, s.msWhitenAnti, s.bounceLux, s.ao]))).size;
  return { seen, ok: distinct === arms.length };
}

// Everything below is the CLI. Guarded so that a harness importing setArm() from
// this module does not launch a browser as a side effect of the import - which is
// what a top-level-await script does otherwise.
if (process.argv[1] && process.argv[1].endsWith('ground-albedo.mjs')) await main();

async function main() {
  fs.mkdirSync('docs/shots', { recursive: true });
  await ensureServer();
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

  const placed = await page.evaluate(placeCamera, SHOTS[SHOT]);
  console.log(describe(SHOT, placed));
  await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });

  // Settle on the streaming COUNT holding still, not on a stopwatch: a fixed wait
  // measures a half-built district, which is the mistake the ledger records twice.
  await page.waitForFunction(() => {
    const w = __district.world.report();
    const prev = window.__gaSettle;
    const same = prev && prev.n === w.chunksLoaded && prev.m === w.meshes;
    window.__gaSettle = { n: w.chunksLoaded, m: w.meshes, still: same ? (prev.still ?? 0) + 1 : 0 };
    return window.__gaSettle.still >= 4;
  }, null, { timeout: 240000, polling: 2000 });
  const settled = await page.evaluate(() => {
    const w = __district.world.report();
    return { chunks: w.chunksLoaded, meshes: w.meshes, queued: w.queued ?? 0 };
  });
  console.log(`streaming settled: ${settled.chunks} chunks, ${settled.meshes} meshes, queue ${settled.queued}`);

  // --------------------------------------------------------------- in-page probe
  await page.evaluate(() => {
    const D = __district;
    // Half-float decode. THREE is not a browser global on this page, so DataUtils
    // is out of reach and this is ten lines rather than a dependency.
    const half = (h) => {
      const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 0x1f) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    function readBox(x, y, w, h) {
      const rt = D.post.hdr;
      const sx = rt.width / 1600, sy = rt.height / 900;
      const X = Math.round(x * sx), W = Math.max(1, Math.round(w * sx));
      const H = Math.max(1, Math.round(h * sy));
      const Y = Math.round(rt.height - (y + h) * sy);
      const buf = new Uint16Array(W * H * 4);
      D.renderer.readRenderTargetPixels(rt, X, Math.max(0, Y), W, H, buf);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < W * H; i++) {
        const R = half(buf[i * 4]), G = half(buf[i * 4 + 1]), B = half(buf[i * 4 + 2]);
        if (!isFinite(R) || !isFinite(G) || !isFinite(B)) continue;
        r += R; g += G; b += B; n++;
      }
      return n ? { r: r / n, g: g / n, b: b / n, y: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n, n }
               : { r: 0, g: 0, b: 0, y: 0, n: 0 };
    }

    // The dome's own cosine-weighted integrals, read off the LUT the PMREM is
    // built from. Same convention as sky.js's _deriveFromProbe: elevation runs
    // -pi/2..+pi/2 up the texture, azimuth is atan2(z, x) across it. The UPPER
    // integral is the one audit().skyLux gates and the LOWER one is the ground
    // bounce this tool exists to move; reading both makes "the envelope is
    // untouched" a measurement instead of a claim about which loop bound is used.
    function domeIntegrals() {
      const sky = D.sky;
      const W = sky.lutWidth, H = sky.lutHeight;
      const buf = new Uint16Array(W * H * 4);
      D.renderer.readRenderTargetPixels(sky.lut, 0, 0, W, H, buf);
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const dPhi = (Math.PI * 2) / W, dTheta = Math.PI / H;
      const up = [0, 0, 0], down = [0, 0, 0], wall = [0, 0, 0];
      let eUp = 0, eDown = 0, eWall = 0;
      // A wall normal pointing back down the lens: the facade on the camera's own
      // side of the street, which is the surface every "shaded wall" number here is
      // about. Read off the camera matrix rather than off a preset.
      const e = D.camera.matrixWorld.elements;
      const wallAz = Math.atan2(e[10], e[8]);       // +Z column: away from the view
      for (let y = 0; y < H; y++) {
        const el = ((y + 0.5) / H - 0.5) * Math.PI;
        const se = Math.sin(el), ce = Math.cos(el);
        for (let x = 0; x < W; x++) {
          const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
          const i = (y * W + x) * 4;
          const c = [half(buf[i]), half(buf[i + 1]), half(buf[i + 2])];
          if (!isFinite(c[0])) continue;
          const l = lum(c), dw = ce * dTheta * dPhi;
          if (se > 0) { const w = se * dw; eUp += l * w; for (let k = 0; k < 3; k++) up[k] += c[k] * w; }
          else { const w = -se * dw; eDown += l * w; for (let k = 0; k < 3; k++) down[k] += c[k] * w; }
          const dW = ce * Math.cos(phi - wallAz);
          if (dW > 0) { const w = dW * dw; eWall += l * w; for (let k = 0; k < 3; k++) wall[k] += c[k] * w; }
        }
      }
      const r3 = (a) => a.map((v) => +v.toFixed(2));
      return { eUp: +eUp.toFixed(2), eDown: +eDown.toFixed(2), eWall: +eWall.toFixed(2),
        upRGB: r3(up), downRGB: r3(down), wallRGB: r3(wall),
        upBR: +(up[2] / Math.max(1e-9, up[0])).toFixed(3),
        downBR: +(down[2] / Math.max(1e-9, down[0])).toFixed(3),
        wallBR: +(wall[2] / Math.max(1e-9, wall[0])).toFixed(3) };
    }

    // Inject a candidate ground albedo and rebuild everything derived from it.
    // uGroundAlbedo is set once in the constructor and _pushUniforms() never
    // rewrites it, so this survives a time-of-day change; refresh() regenerates the
    // scattering LUT, the probe-derived fog parameters and the PMREM around it.
    function setAlbedo(rgb) {
      const sky = D.sky;
      const u = sky._uniforms.uGroundAlbedo.value;
      if (!window.__gaOriginal) window.__gaOriginal = { r: u.r, g: u.g, b: u.b };
      // LINEAR components, decoded by the caller. setHex(hex, SRGBColorSpace) would
      // be the natural call and THREE is not a global on this page; passing the
      // decode in rather than guessing at three's colour-space token keeps the
      // injected value exactly the one src/sky.js's srgb() helper would produce.
      u.setRGB(rgb[0], rgb[1], rgb[2]);
      sky._dirty = true;
      sky.refresh({ force: true, environment: true, sync: true });
      return { r: +u.r.toFixed(4), g: +u.g.toFixed(4), b: +u.b.toFixed(4),
        lum: +(0.2126 * u.r + 0.7152 * u.g + 0.0722 * u.b).toFixed(4),
        br: +(u.b / Math.max(1e-9, u.r)).toFixed(3) };
    }
    window.__ga = { readBox, domeIntegrals, setAlbedo };
  });

  const readRegions = () => page.evaluate((bx) => {
    const out = {};
    for (const [k, b] of Object.entries(bx)) {
      const v = window.__ga.readBox(b[0], b[1], b[2], b[3]);
      out[k] = { nits: +v.y.toFixed(4), rgb: [+v.r.toFixed(4), +v.g.toFixed(4), +v.b.toFixed(4)],
        br: +(v.b / Math.max(1e-9, v.r)).toFixed(3) };
    }
    return out;
  }, REGIONS);

  // Wait for rendered FRAMES, never for milliseconds: on the software rasteriser a
  // fixed wait is sometimes less than one frame and the readback then returns the
  // previous arm's render target, which is how a probe reports a change it did not
  // make.
  async function settleFrames(n = 8) {
    const f0 = await page.evaluate(() => __district.frames);
    // Both numbers travel INTO the page. Closing over `n` here reads it in the
    // browser, where it does not exist, and the run dies after the first arm.
    await page.waitForFunction(([f, k]) => __district.frames > f + k, [f0, n], { timeout: 180000, polling: 100 });
  }

  const rows = [];
  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(9000);
    for (const hex of ALBEDOS) {
      const albedo = await page.evaluate((c) => window.__ga.setAlbedo(c), linear(hex));
      await settleFrames(8);
      const dome = await page.evaluate(() => window.__ga.domeIntegrals());
      const regions = await readRegions();
      const audit = await page.evaluate(() => __district.audit());
      if (SHOOT) {
        await page.screenshot({ path: `docs/shots/${TAG}-${SHOT}-${tod}-${hex}.png`, timeout: 180000 });
      }
      const row = { tod, hex, albedo, dome, regions,
        skyLuxUpper: audit.sky?.skyLux, skyDelivered: audit.skyDelivery?.totalLux,
        skyPaths: audit.skyDelivery?.paths, exposure: audit.exposureAsStop,
        implausible: audit.implausible };
      rows.push(row);
      console.log(`${tod.padEnd(7)} ${hex}  albedo lum ${String(albedo.lum).padEnd(6)} B/R ${String(albedo.br).padEnd(5)}` +
        `  dome up ${String(dome.eUp).padStart(9)} lux / down ${String(dome.eDown).padStart(9)} lux` +
        `  wall ${regions.wall.nits.toFixed(1).padStart(8)} nits B/R ${regions.wall.br}` +
        `  skyLux ${audit.sky?.skyLux?.toFixed?.(1)}  flags ${audit.implausible.length}`);
    }
  }
  await page.evaluate(() => {
    const o = window.__gaOriginal;
    if (!o) return;
    const u = __district.sky._uniforms.uGroundAlbedo.value;
    u.setRGB(o.r, o.g, o.b);
    __district.sky._dirty = true;
    __district.sky.refresh({ force: true, environment: true, sync: true });
  });
  fs.writeFileSync(`docs/${TAG}-albedo.json`, JSON.stringify({ shot: SHOT, placed, settled, regions: REGIONS, rows, errors }, null, 1));
  console.log(`\nwrote docs/${TAG}-albedo.json (${rows.length} arms)`);
  await browser.close();
}
