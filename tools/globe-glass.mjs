// #142 round 2: is an unlit street-lamp globe frosted glass or a matte ball? The blind reviewer's three
// statistics, as an instrument.
//
// THE REVIEW (2026-11-18, round 1's pair, decoded): at dusk it preferred the LIT build in both pairs, slightly,
// and said the unlit globes "look like orange, opaque balls" where the lit ones "look like glass". Its numbers,
// linear light within one frame, unlit against lit:
//     underside / top           corridor 0.473 vs 0.625   fivepoints 0.377 vs 0.530 (left globe 0.390 vs 0.506)
//     underside (R-B)/(R+G+B)   corridor 0.541 vs 0.438   fivepoints 0.538 vs 0.436
//     globe / the sky beside    corridor 0.59  vs 0.82    fivepoints 0.537 vs 0.659 (left 0.508 vs 0.636)
// and two bounds: nothing in that frame throws more than about 0.33 of (R-B)/(R+G+B) onto white (a white car's
// sunlit side 0.332), and its crude model puts an opaque white ball's underside/top at about 0.36 and a
// translucent shell's at about 0.55.
//
// THE STATISTIC, this instrument's own definition, stated so a number off it means one thing:
//   globe pixels   pixel centres inside the globe's projected circle less EDGE (0.7 px, the antialiased rim),
//                  inside the reviewer's box when one is given, and not an occluder: a pixel at or under
//                  OCCLUDER (0.25) of the region's median luminance is something in front of the globe (the
//                  leaf over corridor's)
//   top / under    the caps where the sphere's normal is within acos(CAP) of straight up or straight down,
//                  (cy - y) / r > CAP and (y - cy) / r > CAP, CAP 0.4
//   underside/top  mean linear luminance of the under cap over the top cap
//   cast           (R - B) / (R + G + B) of the under cap's mean linear colour
//   globe/sky      mean linear luminance of the globe pixels over the sky box's
// on sRGB bytes decoded to linear: the frame a reviewer reads.
//
// MODES
//   (none)         THE GATE: tools/globe-glass.html, the module's own lamp beside a white ball under the dusk
//                  preset's light, every term of the finish isolated against a known-bad arm (see verdict())
//   --json FILE    with the gate, also write the page's report
//   --selftest     the statistic on synthetic spheres, and the verdict on a real report and doctored ones
//   --reviewer     the reviewer's boxes on round 1's committed captures (d142b lit, d142 unlit), against the
//                  reviewer's own numbers; globe circles from docs/dusk-lamps-base-*.json, which projected them
//   --district     a page probe (GG_PORT, GG_ROOT, GG_TIMES, GG_SHOTS, GG_TAG): the hero cameras, each hour, the
//                  composited frame read back under each finish StreetFurniture.setGlobeFinish offers, one term
//                  at a time, on the globes nearest the reviewer's boxes; writes docs/globe-glass-<tag>.json
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CAP, OCCLUDER, EDGE, decodeLUT, globeStats } from './globe-glass-stats.mjs';
export { CAP, OCCLUDER, EDGE, decodeLUT, globeStats };
const IS_MAIN = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const argv = IS_MAIN ? process.argv.slice(2) : [];
const KNOWN = new Set(['--selftest', '--reviewer', '--district', '--json']);
for (const a of argv) {
  if (a.startsWith('--') && !KNOWN.has(a)) {
    console.error(`unknown flag: ${a}\n\nusage: node tools/globe-glass.mjs [--json FILE] | --selftest | --reviewer | --district`);
    process.exit(2);
  }
}
const SELFTEST = argv.includes('--selftest');
const REVIEWER = argv.includes('--reviewer');
const DISTRICT = argv.includes('--district');
const GATE = IS_MAIN && !SELFTEST && !REVIEWER && !DISTRICT;

// --------------------------------------------------------------------------------------------- the instrument's selftest
/** The statistic on synthetic spheres, with the known-bads it exists to refuse. */
export function instrumentChecks() {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const L = decodeLUT();
  const enc = (v) => { // linear -> sRGB byte
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  // A synthetic frame: sky everywhere at linear (0.3, 0.32, 0.36); a globe of radius 12 at (40.5, 40.5) whose
  // linear colour is TOP above the equator band and UNDER below it, so the expected statistics are exact.
  const make = (C, top, under, opts = {}) => {
    const W = 80, H = 80, data = new Uint8Array(W * H * C);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      const dx = (x + 0.5 - 40.5) / 12, dy = (y + 0.5 - 40.5) / 12;
      let c = [0.3, 0.32, 0.36];
      if (Math.hypot(dx, dy) <= 1) c = -dy > 0 ? top : under;
      if (opts.leaf && Math.hypot(dx, dy) <= 1 && y >= 32 && y <= 36) c = [0.01, 0.015, 0.008];
      data[i] = enc(c[0]); data[i + 1] = enc(c[1]); data[i + 2] = enc(c[2]); if (C === 4) data[i + 3] = 255;
    }
    return { width: W, height: H, channels: C, data };
  };
  const g = { cx: 40.5, cy: 40.5, r: 12 }, sky = [2, 10, 2, 10];
  const top = [0.6, 0.6, 0.6], under = [0.5, 0.25, 0.1];
  const yOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const want = { ut: yOf(under) / yOf(top), cast: (under[0] - under[2]) / (under[0] + under[1] + under[2]) };
  const tol = 0.02;
  const s3 = globeStats(make(3, top, under), g, sky, { lut: L });
  check('underside/top is the under cap over the top cap', Math.abs(s3.underOverTop - want.ut) < tol, `${s3.underOverTop?.toFixed(4)} vs ${want.ut.toFixed(4)}`);
  check('the cast is (R-B)/(R+G+B) of the under cap in linear light', Math.abs(s3.cast - want.cast) < tol, `${s3.cast?.toFixed(4)} vs ${want.cast.toFixed(4)}`);
  const gsWant = ((yOf(top) + yOf(under)) / 2) / yOf([0.3, 0.32, 0.36]);
  check('globe/sky is the mean over the globe against the sky box', Math.abs(s3.globeOverSky - gsWant) < 0.05, `${s3.globeOverSky?.toFixed(4)} vs ~${gsWant.toFixed(4)}`);
  const s4 = globeStats(make(4, top, under), g, sky, { lut: L });
  check('the same frame stored with 4 channels reads the same', Math.abs(s4.underOverTop - s3.underOverTop) < 1e-9 && Math.abs(s4.cast - s3.cast) < 1e-9);
  // KNOWN-BAD: a 3-channel frame read with a hardcoded 4-byte stride (CLAUDE.md's readPNG trap)
  const bad = globeStats({ ...make(3, top, under), channels: 4 }, g, sky, { lut: L });
  check('KNOWN-BAD: a 3-channel frame read as 4 does not reproduce the statistic', !(Math.abs(bad.underOverTop - want.ut) < tol && Math.abs(bad.cast - want.cast) < tol),
    `${bad.underOverTop?.toFixed(4)} / ${bad.cast?.toFixed(4)}`);
  // the occluder: a dark leaf across the top cap is dropped, and without the drop the ratio moves
  const leaf = make(3, top, under, { leaf: true });
  const sl = globeStats(leaf, g, sky, { lut: L });
  const sn = globeStats(leaf, g, sky, { lut: L, occluder: 0 });
  check('an occluder in front of the top cap is dropped, and the ratio stands', Math.abs(sl.underOverTop - want.ut) < tol && sl.occluded > 0, `${sl.underOverTop?.toFixed(4)}, ${sl.occluded} dropped`);
  check('KNOWN-BAD: without the drop the leaf drags the top cap down and the ratio rises', sn.underOverTop > sl.underOverTop * 1.1, `${sn.underOverTop?.toFixed(4)} vs ${sl.underOverTop?.toFixed(4)}`);
  // the caps are geometric: a box that crops the globe keeps only the caps inside it
  const sb = globeStats(make(3, top, under), { ...g, box: [30, 50, 31, 50] }, sky, { lut: L });
  check('a box crops the caps it does not contain', sb.top < s3.top && sb.under <= s3.under && Math.abs(sb.underOverTop - want.ut) < tol, `top ${sb.top} of ${s3.top}`);
  // a matte ball against a frosted shell, built as linear profiles: the statistic orders them
  const ball = make(3, [0.6, 0.6, 0.6], [0.2, 0.2, 0.2]), shell = make(3, [0.6, 0.6, 0.6], [0.35, 0.35, 0.35]);
  const sbA = globeStats(ball, g, sky, { lut: L }), sbS = globeStats(shell, g, sky, { lut: L });
  check('a shell lit through from above reads higher under/over than a ball lit only from below', sbS.underOverTop > sbA.underOverTop + 0.2, `${sbS.underOverTop.toFixed(3)} vs ${sbA.underOverTop.toFixed(3)}`);
  check('a neutral underside reads a cast of 0', Math.abs(sbS.cast) < 0.01, sbS.cast.toFixed(4));
  check('non-finite input throws rather than reading as no difference', (() => { try { globeStats({ ...make(3, top, under), data: new Float64Array(80 * 80 * 3).fill(NaN) }, g, sky, { lut: L }); return false; } catch { return true; } })());
  return checks;
}
export const INSTRUMENT_CHECKS = 11;

// --------------------------------------------------------------------------------------------- reviewer
/** The reviewer's boxes, in the 1600x900 hero frame, and the globes they hold in round 1's frames. */
export const REVIEW = [
  { shot: 'corridor', name: 'main', box: [965, 982, 287, 304], lamp: 283, globe: 'outer', sky: [984, 988, 296, 302],
    lit: { ut: 0.625, cast: 0.438, gs: 0.82 }, unlit: { ut: 0.473, cast: 0.541, gs: 0.59 } },
  { shot: 'fivepoints', name: 'top-left', box: [130, 164, 183, 212], lamp: 171, globe: 'outer', sky: [172, 199, 182, 207],
    lit: { ut: 0.530, cast: 0.436, gs: 0.659 }, unlit: { ut: 0.377, cast: 0.538, gs: 0.537 } },
  // lamp 837 in round 1's frames (dusk-lamps-base-fivepoints.json); #148 removed six lamps, so the same globe
  // (65.27, 281.89, r 11.07 px, 22.8 m) is lamp 831 in the merged build. --district picks by position.
  { shot: 'fivepoints', name: 'left', box: [55, 75, 274, 289], lamp: 837, globe: 'outer', sky: [172, 199, 182, 207],
    lit: { ut: 0.506, cast: null, gs: 0.636 }, unlit: { ut: 0.390, cast: null, gs: 0.508 } },
];
if (REVIEWER) {
  // GG_PAIR names the two tags (default round 1's: d142b, the lit build, then d142) and GG_HOURS the frames; the
  // globe circles are the projection round 1's dusk-lamps run wrote for each hero camera, which moves with the
  // camera and not with the build or the hour. The reviewer's own numbers are printed beside round 1's dusk only.
  const ROOT = new URL('..', import.meta.url).pathname;
  const { readPNG } = await import('./png.mjs');
  const L = decodeLUT();
  const [tagA, tagB] = (process.env.GG_PAIR ?? 'd142b,d142').split(',').map((x) => x.trim());
  const HOURS = (process.env.GG_HOURS ?? 'dusk').split(',').map((x) => x.trim()).filter(Boolean);
  const round1 = tagA === 'd142b' && tagB === 'd142';
  const out = [];
  console.log(`GLOBE-GLASS --reviewer: the reviewer's boxes on ${tagA} and ${tagB}, ${HOURS.join(', ')}\n`);
  for (const R of REVIEW) {
    const J = JSON.parse(fs.readFileSync(`${ROOT}docs/dusk-lamps-base-${R.shot}.json`, 'utf8'));
    const run = J.runs.find((r) => r.tod === 'dusk');
    const G = run.globes.find((q) => q.lamp === R.lamp && q.globe === R.globe);
    if (!G) throw new Error(`no ${R.globe} globe of lamp ${R.lamp} in ${R.shot}'s projection`);
    for (const hour of HOURS) {
      for (const [arm, tag] of [[round1 ? 'lit' : tagA, tagA], [round1 ? 'unlit' : tagB, tagB]]) {
        const file = `${ROOT}docs/shots/${tag}-${R.shot}-${hour}.png`;
        if (!fs.existsSync(file)) { console.log(`  (no ${file})`); continue; }
        const s = globeStats(readPNG(file), { cx: G.sx, cy: G.sy, r: G.rpx, box: R.box }, R.sky, { lut: L });
        const w = round1 && hour === 'dusk' ? R[arm] : null;
        out.push({ shot: R.shot, name: R.name, box: R.box, sky: R.sky, lamp: R.lamp, globe: R.globe, hour, arm, tag, stats: s });
        const q = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '  -  ');
        console.log(`${(R.shot + ' ' + R.name).padEnd(20)} ${hour.padEnd(6)} ${arm.padEnd(8)} n ${String(s.n).padStart(3)} (top ${s.top}, under ${s.under}, occluded ${s.occluded})` +
          `  under/top ${q(s.underOverTop)}${w ? ` (${w.ut})` : ''}  cast ${q(s.cast)}${w ? ` (${w.cast ?? '-'})` : ''}  globe/sky ${q(s.globeOverSky)}${w ? ` (${w.gs})` : ''}`);
      }
    }
  }
  const name = round1 ? 'docs/globe-glass-reviewer.json' : `docs/globe-glass-reviewer-${tagA}-${tagB}.json`;
  fs.writeFileSync(`${ROOT}${name}`, JSON.stringify({ cap: CAP, occluder: OCCLUDER, edge: EDGE, pair: [tagA, tagB], hours: HOURS, rows: out }, null, 1));
  console.log(`\nwrote ${name}`);
}

// --------------------------------------------------------------------------------------------- district
if (DISTRICT) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } = await import('./hero-cams.mjs');
  const ROOT = process.env.GG_ROOT ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const OUTROOT = new URL('..', import.meta.url).pathname;
  const PORT = Number(process.env.GG_PORT ?? treePort(ROOT));
  const TIMES = (process.env.GG_TIMES ?? 'dusk').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY = (process.env.GG_SHOTS ?? 'corridor,fivepoints').split(',').map((s) => s.trim()).filter(Boolean);
  const TAG = process.env.GG_TAG ?? 'tip';
  const shots = HERO_FRAMINGS.filter((s) => ONLY.includes(s.name));
  // Each finish is a full { shadow, color, transmit }; BEFORE is the build before this round, the terms are
  // added to it one at a time, then all three. `lit` re-lights the street lamps on top (the photocell holds
  // them off at dusk), so the lit build's globe can be read off the same page.
  const FIN = JSON.parse(process.env.GG_FINISHES ?? 'null') ?? [
    { name: 'before', f: { shadow: false, color: 0xd8d2c4, transmit: 0 } },
    { name: '+shadow', f: { shadow: true, color: 0xd8d2c4, transmit: 0 } },
    { name: '+neutral', f: { shadow: false, color: 0xd2d2d2, transmit: 0 } },
    { name: '+transmit', f: { shadow: false, color: 0xd8d2c4, transmit: 0.55 } },
    { name: 'all three', f: { shadow: true, color: 0xd2d2d2, transmit: 0.55 } },
    { name: 'before, lit', f: { shadow: false, color: 0xd8d2c4, transmit: 0 }, lit: true },
    { name: 'all three, lit', f: { shadow: true, color: 0xd2d2d2, transmit: 0.55 }, lit: true },
  ];
  await ensureServer(PORT, 20000, { root: ROOT });
  const runs = [], errors = [];
  const L = decodeLUT();
  for (const s of shots) {
    const browser = await chromium.launch(launchOptions());
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/district/?traffic=0`, { waitUntil: 'networkidle' });
    await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 900000 });
    await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
    await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds(20) : null));
    await page.evaluate(() => __district.setPedestrians(0));
    const placed = await placeHeroCam(page, s);
    console.log(`${s.name}: camera at (${placed.x}, ${placed.z})`);
    await settleFrames(page, FRAME_SETTLE, `camera ${s.name}`);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await settleFrames(page, FRAME_SETTLE, `tod ${tod}`);
      const boxes = REVIEW.filter((R) => R.shot === s.name);
      const SRC = `(() => { const decodeLUT = ${decodeLUT.toString()}; const globeStats = ${globeStats.toString()}; return { decodeLUT, globeStats }; })()`;
      const r = await page.evaluate(async ({ fin, boxes, src, opts }) => {
        const M = eval(src);   // eslint-disable-line no-eval
        const LUT = M.decodeLUT();
        const THREE = await import('/vendor/three.module.min.js');
        const SF = await import('/src/streetfurniture.js');
        const d = __district, fur = d.furniture, cam = d.camera, R = d.renderer, gl = R.getContext();
        const W = R.domElement.width, H = R.domElement.height;
        const waitFrames = (k) => new Promise((res) => { const f0 = d.frames; const t = () => (d.frames >= f0 + k ? res() : setTimeout(t, 100)); t(); });
        // every globe in frame, off the module's LAMP_GLOBES and each lamp's instance matrix
        cam.updateMatrixWorld();
        const tanH = Math.tan((cam.fov * Math.PI / 180) / 2);
        const im = new THREE.Matrix4(), wv = new THREE.Vector3(), vv = new THREE.Vector3();
        const globes = [];
        for (let li = 0; li < fur.count; li++) {
          fur.heads.getMatrixAt(li, im);
          for (const [gi, G] of SF.LAMP_GLOBES.entries()) {
            wv.set(G.x, G.y, G.z).applyMatrix4(im);
            vv.copy(wv).applyMatrix4(cam.matrixWorldInverse);
            const dep = -vv.z;
            if (!(dep > 0.5)) continue;
            const ndc = wv.clone().project(cam);
            if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
            globes.push({ lamp: li, globe: gi === 0 ? 'outer' : 'inner', sx: (ndc.x + 1) / 2 * W, sy: (1 - ndc.y) / 2 * H, rpx: G.r * (H / 2) / (tanH * dep), depth: dep });
          }
        }
        // the globe each reviewer box holds: the projected circle whose centre is nearest the box's centre
        const picks = boxes.map((b) => {
          const bx = (b.box[0] + b.box[1] + 1) / 2, by = (b.box[2] + b.box[3] + 1) / 2;
          let best = null;
          for (const g of globes) { const dd = Math.hypot(g.sx - bx, g.sy - by); if (!best || dd < best.dd) best = { ...g, dd }; }
          return { ...b, pick: best };
        });
        const prevFinish = fur.globeFinishReport ? fur.globeFinishReport() : null;
        const prevLit = d.tod.streetLampsOn;
        const frames = [];
        for (const F of fin) {
          if (!fur.setGlobeFinish) { frames.push({ name: F.name, refused: 'no setGlobeFinish in this build' }); continue; }
          const got = fur.setGlobeFinish(F.f);
          if (F.lit) fur.setLit(true); else fur.setLit(!!d.tod.streetLampsOn);
          await waitFrames(3);
          d.post.render();
          const px = new Uint8Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const top = new Uint8Array(W * H * 4);
          for (let y = 0; y < H; y++) top.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
          const img = { width: W, height: H, channels: 4, data: top };
          const per = picks.map((b) => ({ box: b.name, lamp: b.pick.lamp, globe: b.pick.globe, at: [+b.pick.sx.toFixed(1), +b.pick.sy.toFixed(1)], rpx: +b.pick.rpx.toFixed(2),
            stats: M.globeStats(img, { cx: b.pick.sx, cy: b.pick.sy, r: b.pick.rpx, box: b.box }, b.sky, { ...opts, lut: LUT }) }));
          frames.push({ name: F.name, got, lit: !!F.lit, per });
        }
        if (prevFinish) fur.setGlobeFinish(prevFinish);
        fur.setLit(!!prevLit);
        return { W, H, picks, frames, preset: d.tod.presetName, streetLampsOn: d.tod.streetLampsOn ?? null };
      }, { fin: FIN, boxes, src: SRC, opts: { cap: CAP, occluder: OCCLUDER, edge: EDGE } });
      const rows = [];
      for (const fr of r.frames) {
        if (fr.refused) { rows.push({ finish: fr.name, refused: fr.refused }); continue; }
        const per = fr.per;
        rows.push({ finish: fr.name, got: fr.got, lit: fr.lit, per });
        for (const p of per) {
          const st = p.stats;
          console.log(`  ${s.name}/${tod} ${fr.name.padEnd(15)} ${p.box.padEnd(9)} lamp ${p.lamp} ${p.globe} r ${p.rpx}: under/top ${st.underOverTop?.toFixed(3)}  cast ${st.cast?.toFixed(3)}  globe/sky ${st.globeOverSky?.toFixed(3)}  (n ${st.n}, occl ${st.occluded})`);
        }
      }
      runs.push({ shot: s.name, tod, preset: r.preset, streetLampsOn: r.streetLampsOn, picks: r.picks.map((b) => ({ box: b.name, ...b.pick })), rows });
    }
    await browser.close();
  }
  fs.writeFileSync(`${OUTROOT}docs/globe-glass-${TAG}.json`, JSON.stringify({ root: ROOT, cap: CAP, occluder: OCCLUDER, edge: EDGE, errors, runs }, null, 1));
  console.log(`\nwrote docs/globe-glass-${TAG}.json; page errors ${errors.length}`);
}

// --------------------------------------------------------------------------------------------- the gate
/**
 * THE GATE'S ARMS, each one tools/globe-glass.html __run config. `F` is the module's GLOBE_FINISH and `B` its
 * GLOBE_FINISH_BEFORE; every arm but `before` is the shipped finish with ONE term changed, so each check below
 * reads one term against its own known-bad, under one light, off one page load.
 */
/** 0xd8d2c4's luminance as a neutral grey: the colour arms' reference ball (see gateArms). */
export const GREY_REFERENCE = 0xd2d2d2;
export function gateArms(F, B) {
  return {
    ship: { finish: { ...F } },
    before: { finish: { ...B } },
    noShadow: { finish: { ...F, shadow: false } },
    // The colour arms read the shell against a NEUTRAL GREY BALL of the shipped shell's luminance, typed here and
    // not taken from F, so a warm F cannot bring its reference with it: same albedo, same specular share. They
    // hold the transmitted light and the sun's shadow off on BOTH subjects, because in open sun the shell's
    // lookup shades its own terminator and the ball's does not (0.021 of cast apart, head on: see the page), so
    // the cast left between them is the shell's own colour: -0.0001 measured, where 0xd8d2c4 is +0.069.
    // (This comment first said 0.010, read off ONE camera between the two subjects: that was +0.031 of view
    // asymmetry and -0.021 of shadow, two terms of opposite sign summing to a small one.)
    noTransmit: { finish: { ...F, transmit: 0, shadow: false }, ballColor: GREY_REFERENCE, ballShadow: false },
    warmNoTransmit: { finish: { ...F, color: B.color, transmit: 0, shadow: false }, ballColor: GREY_REFERENCE, ballShadow: false },
    shipWall: { finish: { ...F }, wall: true },
    noShadowWall: { finish: { ...F, shadow: false }, wall: true },
    furnace: { finish: { ...F }, furnace: true },
    furnaceBefore: { finish: { ...B }, furnace: true },
    furnaceOver: { finish: { ...F, transmit: 2 * F.transmit }, furnace: true },
    nightLit: { finish: { ...F }, lit: true, night: true },
    nightLitBefore: { finish: { ...B }, lit: true, night: true },
    nightUnlit: { finish: { ...F }, night: true },
  };
}

/** Load tools/globe-glass.html, run every arm, return { meta, arms } (throws with the page's own error). */
export async function runPage(arms) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer, treePort } = await import('./serve.mjs');
  const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const PORT = Number(process.env.GLOBE_GLASS_PORT ?? treePort(ROOT));
  await ensureServer(PORT, 20000, { root: ROOT });
  const browser = await chromium.launch(launchOptions());
  const logs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    page.on('console', (m) => { if (!/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) logs.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`http://127.0.0.1:${PORT}/tools/globe-glass.html`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__ready', null, { timeout: 600000, polling: 250 });
    const err = await page.evaluate(() => window.__error ?? null);
    if (err) throw new Error(`the page did not build: ${err}`);
    const meta = await page.evaluate(() => window.__meta);
    const out = {};
    for (const [name, cfg] of Object.entries(arms)) out[name] = await page.evaluate((c) => window.__run(c), cfg);
    return { meta, arms: out, logs };
  } finally {
    await browser.close();
  }
}

/** A number off a report, or NaN: every read goes through this, so a missing arm FAILS a check rather than throwing past it. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
/** A globe's or ball's mean luminance over its kept pixels; `allY` over every disc pixel (for a globe too dark to keep any). */
const meanY = (s) => num(s?.globeY);
const allY = (s) => num(s?.allY);
/** sRGB hex -> linear luminance, independently of three (the gate re-derives the module's gain with it). */
export function hexLuminance(hex) {
  const ch = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Fixed, so a check cannot vanish when an arm is missing. */
export const CHECK_COUNT = 16;
/**
 * THE VERDICT on a report from tools/globe-glass.html, against the finish `F` the module ships. In order, and each
 * term against a known-bad that runs on every pass (LIVE), because a check that only ever sees the shipped arm
 * cannot say it would see the defect:
 *   the thing happened   the page's lamp is the module's, patched, the finish read back is F, the shadow is
 *                        the district's, and nothing in a daylight frame clips
 *   the gain             F.transmit is the lossless shell's (1 - R) / R, R re-derived here off F.color
 *   the shadow           a wall between the sun and the lamp shades the globe as it shades the ball; with
 *                        the term off the wall changes nothing on the globe (LIVE); and in open sun the
 *                        lookup at the hit takes nothing off a sunlit globe (a lookup at the card's vertex,
 *                        the globe's centre, would read its own shadow disc and darken it)
 *   the colour           with the transmitted light held off, the shell's underside is the white ball's
 *                        colour; 0xd8d2c4 is warmer than white in the same light (LIVE); and the shipped
 *                        underside is no more orange than white under this light, the reviewer's bound,
 *                        where the build before was (LIVE)
 *   the transmitted light  the underside is filled from inside, above the ball's under/top; with it off
 *                        the shell is the ball (LIVE); the globe reads brighter against the sky beside it
 *                        than the build before, and without the light it does not (LIVE); and in a uniform
 *                        field the lossless shell is exactly
 *                        as bright as the white ball, where the build before is its albedo and twice the
 *                        gain is brighter than white (both LIVE): energy, measured
 *   the night            a lit globe reads what it read before, under the clip, and an unlit one at night
 *                        is a small fraction of it (so "lit" is a distinction the instrument draws)
 */
export function verdict(rep, F) {
  const A = rep?.arms ?? {}, M = rep?.meta ?? {};
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const g = (arm) => A[arm]?.globe, b = (arm) => A[arm]?.ball;
  const gSun = (arm) => num(A[arm]?.globeSun), bSun = (arm) => num(A[arm]?.ballSun);
  const ut = (s) => num(s?.underOverTop), cast = (s) => num(s?.cast);
  // ---- the thing happened
  const got = A.ship?.got ?? {};
  add('the page is the module\'s lamp: the lit impostor patch, the shipped finish read back as the module\'s, and the district\'s sun shadow',
    M.impostor === 'lit' && got.shadow === F.shadow && got.color === F.color && Math.abs(num(got.transmit) - F.transmit) < 1e-9 &&
      M.shadow?.mapSize === 2048 && M.shadow?.half === 120 && M.shadow?.normalBias === 0.06 && M.headCastShadow === true,
    `impostor ${M.impostor}, got ${JSON.stringify(got)}, shadow ${JSON.stringify(M.shadow)}`);
  const day = ['ship', 'before', 'noShadow', 'noTransmit', 'warmNoTransmit', 'shipWall', 'noShadowWall', 'furnace', 'furnaceBefore', 'furnaceOver'];
  const sizes = day.flatMap((a) => [num(g(a)?.n), num(b(a)?.n), num(g(a)?.top), num(g(a)?.under)]);
  const maxB = Math.max(...day.map((a) => num(A[a]?.maxByte)));
  add('every daylight arm read both subjects whole and below the clip (no byte at 255; every cap over 200 px)',
    sizes.every((v) => v > 200) && maxB < 255, `brightest byte ${maxB}, smallest count ${Math.min(...sizes)}`);
  // ---- the gain
  const R = hexLuminance(F.color);
  add('the transmitted light\'s gain is the lossless shell\'s (1 - R) / R, R re-derived here off the shipped colour',
    Math.abs(F.transmit - (1 - R) / R) < 1e-9, `transmit ${f4(F.transmit)} against (1 - ${f4(R)}) / ${f4(R)} = ${f4((1 - R) / R)}`);
  // ---- the shadow
  const openRatio = gSun('ship') / gSun('noShadow');
  add('in open sun the shadow looked up at the hit takes nothing off a sunlit globe (at least 0.97 of the term off)',
    openRatio >= 0.97 && openRatio <= 1.01, `sun side ${f4(gSun('ship'))} against ${f4(gSun('noShadow'))}: x${f3(openRatio)}`);
  const gWall = gSun('shipWall') / gSun('ship'), bWall = bSun('shipWall') / bSun('ship');
  add('a wall between the sun and the lamp shades the globe\'s sun side as it shades the ball\'s: under 0.9, and at least half the ball\'s drop',
    gWall < 0.9 && (1 - gWall) >= 0.5 * (1 - bWall), `globe x${f3(gWall)}, ball x${f3(bWall)}`);
  const offWall = gSun('noShadowWall') / gSun('noShadow');
  add('KNOWN-BAD, LIVE: with the term off (the build before) the wall changes nothing on the globe while the ball loses its sun',
    Math.abs(offWall - 1) < 0.002 && bSun('noShadowWall') / bSun('noShadow') < 0.9, `globe x${f4(offWall)}, ball x${f3(bSun('noShadowWall') / bSun('noShadow'))}`);
  // ---- the colour
  const dNeutral = cast(g('noTransmit')) - cast(b('noTransmit'));
  add('the shell\'s colour is neutral: with the transmitted light held off its underside reads a neutral grey ball\'s cast, within 0.012',
    Math.abs(dNeutral) <= 0.012 && A.noTransmit?.cfg?.ballColor === GREY_REFERENCE && A.noTransmit?.cfg?.ballShadow === false,
    `globe ${f4(cast(g('noTransmit')))} against the grey ball's ${f4(cast(b('noTransmit')))}: ${f4(dNeutral)}`);
  const dWarm = cast(g('warmNoTransmit')) - cast(b('warmNoTransmit'));
  add('KNOWN-BAD, LIVE: 0xd8d2c4 under the same light is at least 0.04 more orange than the neutral grey of its luminance',
    dWarm >= 0.04 && A.warmNoTransmit?.cfg?.ballColor === GREY_REFERENCE && A.warmNoTransmit?.cfg?.ballShadow === false,
    `globe ${f4(cast(g('warmNoTransmit')))} against the grey ball's ${f4(cast(b('warmNoTransmit')))}: +${f4(dWarm)}`);
  add('the reviewer\'s bound: the shipped underside is no more orange than white in the same light',
    cast(g('ship')) <= cast(b('ship')) + 0.005, `globe ${f4(cast(g('ship')))}, white ${f4(cast(b('ship')))}`);
  add('KNOWN-BAD, LIVE: the build before is more orange underneath than white in the same light, by at least 0.02',
    cast(g('before')) >= cast(b('before')) + 0.02, `globe ${f4(cast(g('before')))}, white ${f4(cast(b('before')))}`);
  // ---- the transmitted light
  const lift = ut(g('ship')) - ut(b('ship'));
  add('the underside is filled from inside: the shipped globe\'s under/top is at least 0.10 above the opaque ball\'s',
    lift >= 0.10, `globe ${f3(ut(g('ship')))} against the ball's ${f3(ut(b('ship')))}: +${f3(lift)}`);
  const flat = ut(g('noTransmit')) - ut(b('noTransmit'));
  add('KNOWN-BAD, LIVE: with the transmitted light off the shell is the matte ball, under/top within 0.03 of it',
    Math.abs(flat) <= 0.03, `globe ${f3(ut(g('noTransmit')))} against the ball's ${f3(ut(b('noTransmit')))}`);
  const gs = (arm) => num(g(arm)?.globeOverSky);
  add('globe/sky: the transmitted light brightens the globe against the sky beside it, x1.10 over the build before; LIVE, without it the globe is no brighter than the build before\'s (under x1.03)',
    gs('ship') >= 1.10 * gs('before') && gs('noTransmit') / gs('before') < 1.03,
    `shipped ${f3(gs('ship'))}, before ${f3(gs('before'))} (x${f3(gs('ship') / gs('before'))}), without the light ${f3(gs('noTransmit'))}`);
  const furn = meanY(g('furnace')) / meanY(b('furnace')), furnB = meanY(g('furnaceBefore')) / meanY(b('furnaceBefore')),
    furnO = meanY(g('furnaceOver')) / meanY(b('furnaceOver'));
  add('ENERGY: in a uniform field the lossless shell is as bright as the white ball (x0.97 to x1.06); LIVE, the build before reads its albedo (under x0.75) and twice the gain is brighter than white (over x1.25)',
    furn >= 0.97 && furn <= 1.06 && furnB < 0.75 && furnO > 1.25, `shipped x${f4(furn)}, before x${f4(furnB)}, twice the gain x${f4(furnO)}`);
  // ---- the night
  const nl = allY(g('nightLit')), nb = allY(g('nightLitBefore')), nu = allY(g('nightUnlit'));
  add('a lit globe at night reads what it read before: mean within 1%, cast within 0.01, below the clip',
    Math.abs(nl / nb - 1) < 0.01 && Math.abs(cast(g('nightLit')) - cast(g('nightLitBefore'))) < 0.01 && num(g('nightLit')?.topY) < 0.9,
    `x${f4(nl / nb)}, cast ${f4(cast(g('nightLit')))} against ${f4(cast(g('nightLitBefore')))}, top ${f3(num(g('nightLit')?.topY))}`);
  add('a lit globe reads lit: an unlit one at night, its transmitted light and all, is under 5% of it',
    nu / nl < 0.05, `unlit/lit ${f4(nu / nl)}`);
  return out;
}

/** The table a run prints: the reviewer's three statistics for every arm, the globe beside the ball. */
export function table(rep) {
  const A = rep?.arms ?? {};
  const lines = ['  arm              globe: under/top   cast    globe/sky   sun side   |  ball: under/top   cast    ball/sky   sun side'];
  for (const [name, r] of Object.entries(A)) {
    const g = r.globe ?? {}, b = r.ball ?? {};
    lines.push(`  ${name.padEnd(16)}        ${f3(g.underOverTop).padStart(6)}  ${f4(g.cast).padStart(7)}  ${f3(g.globeOverSky).padStart(8)}   ${f4(r.globeSun).padStart(8)}` +
      `   |        ${f3(b.underOverTop).padStart(6)}  ${f4(b.cast).padStart(7)}  ${f3(b.globeOverSky).padStart(8)}   ${f4(r.ballSun).padStart(8)}   max byte ${r.maxByte}`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------------- the verdict's selftest
/**
 * A REAL REPORT, trimmed to what the verdict reads, from a passing run of the page (GOOD_REPORT_FROM says which), and
 * the finish it ran under. The selftest proves the verdict passes it with CHECK_COUNT checks and fails each doctored
 * copy on the check written for that defect — and on no fewer checks than that, so a check cannot vanish.
 */
export const GOOD_REPORT_FROM = 'the page at the commit that added it, 2026-11-18, 4.5 s, 16 of 16';
export const GOOD_REPORT = {
  finish: {"shadow": true, "color": 13816530, "transmit": 0.5516392959875095},
  report: {
    meta: {"impostor": "lit", "shadow": {"mapSize": 2048, "half": 120, "bias": 0, "normalBias": 0.06}, "headCastShadow": true},
    arms: {
      ship: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": true, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.136504, "underY": 0.0773329, "underOverTop": 0.566527, "cast": 0.0403384, "globeOverSky": 1.29525, "skyY": 0.0851681, "globeY": 0.110314, "allY": 0.110314}, "ball": {"n": 9762, "top": 2430, "under": 2320, "topY": 0.158133, "underY": 0.0686285, "underOverTop": 0.433992, "cast": 0.190561, "globeOverSky": 1.3882, "skyY": 0.0851697, "globeY": 0.118232, "allY": 0.117211}, "globeSun": 0.125099, "ballSun": 0.13863, "maxByte": 137},
      before: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": false, "color": 14209732, "transmit": 0}, "globe": {"n": 9761, "top": 2430, "under": 2319, "topY": 0.102694, "underY": 0.0451179, "underOverTop": 0.439345, "cast": 0.261207, "globeOverSky": 0.905194, "skyY": 0.0851681, "globeY": 0.0770936, "allY": 0.0764229}, "ball": {"n": 9762, "top": 2430, "under": 2320, "topY": 0.158133, "underY": 0.0686285, "underOverTop": 0.433992, "cast": 0.190561, "globeOverSky": 1.3882, "skyY": 0.0851697, "globeY": 0.118232, "allY": 0.117211}, "globeSun": 0.0907316, "ballSun": 0.13863, "maxByte": 137},
      noShadow: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": false, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.138287, "underY": 0.0789823, "underOverTop": 0.571147, "cast": 0.053568, "globeOverSky": 1.31162, "skyY": 0.0851681, "globeY": 0.111708, "allY": 0.111708}, "ball": {"n": 9762, "top": 2430, "under": 2320, "topY": 0.158133, "underY": 0.0686285, "underOverTop": 0.433992, "cast": 0.190561, "globeOverSky": 1.3882, "skyY": 0.0851697, "globeY": 0.118232, "allY": 0.117211}, "globeSun": 0.125602, "ballSun": 0.13863, "maxByte": 137},
      noTransmit: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": false, "ballColor": 13816530, "ballShadow": false}, "got": {"shadow": false, "color": 13816530, "transmit": 0}, "globe": {"n": 9755, "top": 2430, "under": 2313, "topY": 0.102645, "underY": 0.044663, "underOverTop": 0.435119, "cast": 0.191949, "globeOverSky": 0.901461, "skyY": 0.0851681, "globeY": 0.0767758, "allY": 0.0760734}, "ball": {"n": 9754, "top": 2430, "under": 2312, "topY": 0.102645, "underY": 0.0446392, "underOverTop": 0.434891, "cast": 0.19203, "globeOverSky": 0.901381, "skyY": 0.0851697, "globeY": 0.0767703, "allY": 0.0760616}, "globeSun": 0.0899557, "ballSun": 0.0899483, "maxByte": 112},
      warmNoTransmit: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": false, "ballColor": 13816530, "ballShadow": false}, "got": {"shadow": false, "color": 14209732, "transmit": 0}, "globe": {"n": 9761, "top": 2430, "under": 2319, "topY": 0.102694, "underY": 0.0451179, "underOverTop": 0.439345, "cast": 0.261207, "globeOverSky": 0.905194, "skyY": 0.0851681, "globeY": 0.0770936, "allY": 0.0764229}, "ball": {"n": 9754, "top": 2430, "under": 2312, "topY": 0.102645, "underY": 0.0446392, "underOverTop": 0.434891, "cast": 0.19203, "globeOverSky": 0.901381, "skyY": 0.0851697, "globeY": 0.0767703, "allY": 0.0760616}, "globeSun": 0.0907316, "ballSun": 0.0899483, "maxByte": 112},
      shipWall: {"cfg": {"finish": "custom", "wall": true, "lit": false, "night": false, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": true, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.113176, "underY": 0.0563876, "underOverTop": 0.49823, "cast": -0.195311, "globeOverSky": 1.00082, "skyY": 0.0851681, "globeY": 0.0852379, "allY": 0.0852379}, "ball": {"n": 9851, "top": 2430, "under": 2409, "topY": 0.127987, "underY": 0.0405202, "underOverTop": 0.316596, "cast": -0.141761, "globeOverSky": 0.997998, "skyY": 0.0851697, "globeY": 0.0849991, "allY": 0.0848629}, "globeSun": 0.0854113, "ballSun": 0.0851296, "maxByte": 137},
      noShadowWall: {"cfg": {"finish": "custom", "wall": true, "lit": false, "night": false, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": false, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.138287, "underY": 0.0789823, "underOverTop": 0.571147, "cast": 0.053568, "globeOverSky": 1.31162, "skyY": 0.0851681, "globeY": 0.111708, "allY": 0.111708}, "ball": {"n": 9851, "top": 2430, "under": 2409, "topY": 0.127987, "underY": 0.0405202, "underOverTop": 0.316596, "cast": -0.141761, "globeOverSky": 0.997998, "skyY": 0.0851697, "globeY": 0.0849991, "allY": 0.0848629}, "globeSun": 0.125602, "ballSun": 0.0851296, "maxByte": 137},
      furnace: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": true, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": true, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.300544, "underY": 0.300544, "underOverTop": 1, "cast": 0, "globeOverSky": 1, "skyY": 0.300544, "globeY": 0.300544, "allY": 0.300544}, "ball": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.300544, "underY": 0.300544, "underOverTop": 1, "cast": 0, "globeOverSky": 1, "skyY": 0.300544, "globeY": 0.300544, "allY": 0.300544}, "globeSun": 0.300544, "ballSun": 0.300544, "maxByte": 149},
      furnaceBefore: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": true, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": false, "color": 14209732, "transmit": 0}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.195696, "underY": 0.195696, "underOverTop": 1, "cast": 0.0706313, "globeOverSky": 0.651139, "skyY": 0.300544, "globeY": 0.195696, "allY": 0.195696}, "ball": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.300544, "underY": 0.300544, "underOverTop": 1, "cast": 0, "globeOverSky": 1, "skyY": 0.300544, "globeY": 0.300544, "allY": 0.300544}, "globeSun": 0.195696, "ballSun": 0.300544, "maxByte": 149},
      furnaceOver: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": false, "furnace": true, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": true, "color": 13816530, "transmit": 1.103278591975019}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.40724, "underY": 0.40724, "underOverTop": 1, "cast": 0, "globeOverSky": 1.35501, "skyY": 0.300544, "globeY": 0.40724, "allY": 0.40724}, "ball": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.300544, "underY": 0.300544, "underOverTop": 1, "cast": 0, "globeOverSky": 1, "skyY": 0.300544, "globeY": 0.300544, "allY": 0.300544}, "globeSun": 0.40724, "ballSun": 0.300544, "maxByte": 171},
      nightLit: {"cfg": {"finish": "custom", "wall": false, "lit": true, "night": true, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": true, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.398928, "underY": 0.398928, "underOverTop": 1, "cast": 0.318475, "globeOverSky": null, "skyY": 0, "globeY": 0.398928, "allY": 0.398928}, "ball": {"n": 0, "top": 0, "under": 0, "topY": null, "underY": null, "underOverTop": null, "cast": null, "globeOverSky": null, "skyY": 0, "globeY": null, "allY": 0}, "globeSun": 0.398928, "ballSun": 0, "maxByte": 195},
      nightLitBefore: {"cfg": {"finish": "custom", "wall": false, "lit": true, "night": true, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": false, "color": 14209732, "transmit": 0}, "globe": {"n": 9872, "top": 2430, "under": 2430, "topY": 0.398928, "underY": 0.398928, "underOverTop": 1, "cast": 0.318475, "globeOverSky": null, "skyY": 0, "globeY": 0.398928, "allY": 0.398928}, "ball": {"n": 0, "top": 0, "under": 0, "topY": null, "underY": null, "underOverTop": null, "cast": null, "globeOverSky": null, "skyY": 0, "globeY": null, "allY": 0}, "globeSun": 0.398928, "ballSun": 0, "maxByte": 195},
      nightUnlit: {"cfg": {"finish": "custom", "wall": false, "lit": false, "night": true, "furnace": false, "ballColor": 16777215, "ballShadow": true}, "got": {"shadow": true, "color": 13816530, "transmit": 0.5516392959875095}, "globe": {"n": 0, "top": 0, "under": 0, "topY": null, "underY": null, "underOverTop": null, "cast": null, "globeOverSky": null, "skyY": 0, "globeY": null, "allY": 0}, "ball": {"n": 0, "top": 0, "under": 0, "topY": null, "underY": null, "underOverTop": null, "cast": null, "globeOverSky": null, "skyY": 0, "globeY": null, "allY": 0}, "globeSun": 0, "ballSun": 0, "maxByte": 0},
    },
  },
};

/** The verdict against a real report and doctored copies of it. */
export function verdictChecks() {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  if (!GOOD_REPORT) { add('a recorded report to prove the verdict on', false, 'GOOD_REPORT is not recorded'); return checks; }
  const F = GOOD_REPORT.finish;
  const clone = () => JSON.parse(JSON.stringify(GOOD_REPORT.report));
  const fails = (rep, re, fin = F) => verdict(rep, fin).filter((c) => !c.ok && re.test(c.name)).length > 0;
  const failing = (rep, fin = F) => verdict(rep, fin).filter((c) => !c.ok).map((c) => c.name.slice(0, 48));
  const good = verdict(GOOD_REPORT.report, F);
  add(`the recorded report (${GOOD_REPORT_FROM}) passes all ${CHECK_COUNT} checks`, good.length === CHECK_COUNT && good.every((c) => c.ok),
    good.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | '));
  const cases = [
    ['a shadow the globe never receives', (r) => { r.arms.shipWall.globeSun = r.arms.ship.globeSun; }, /shades the globe/],
    ['the shadow looked up at the card\'s vertex, the globe\'s centre, darkening it in full sun', (r) => { r.arms.ship.globeSun *= 0.6; r.arms.shipWall.globeSun *= 0.6; }, /takes nothing off a sunlit globe/],
    ['a warm shell (0xd8d2c4 back)', (r) => { r.arms.noTransmit.globe.cast += 0.07; r.arms.ship.globe.cast += 0.07; }, /colour is neutral/],
    ['an underside more orange than white', (r) => { r.arms.ship.globe.cast = r.arms.ship.ball.cast + 0.03; }, /reviewer's bound/],
    ['no transmitted light (the matte ball)', (r) => { r.arms.ship.globe.underOverTop = r.arms.ship.ball.underOverTop; }, /filled from inside/],
    ['a globe no brighter against its sky than the build before', (r) => { r.arms.ship.globe.globeOverSky = r.arms.before.globe.globeOverSky; }, /globe\/sky/],
    ['a shell brighter than energy allows', (r) => { r.arms.furnace.globe.globeY *= 1.3; }, /ENERGY/],
    ['a lit globe that changed at night', (r) => { r.arms.nightLit.globe.allY *= 1.05; }, /reads what it read before/],
    ['a clipped daylight frame', (r) => { r.arms.ship.maxByte = 255; }, /below the clip/],
    ['a known-bad that no longer shows its defect (the warm arm reading white)', (r) => { r.arms.warmNoTransmit.globe.cast = r.arms.warmNoTransmit.ball.cast; }, /0xd8d2c4 under the same light/],
    ['the term-off wall arm shaded (the known-bad gone blind)', (r) => { r.arms.noShadowWall.globeSun *= 0.7; }, /wall changes nothing/],
  ];
  for (const [what, doctor, re] of cases) {
    const r = clone();
    doctor(r);
    const v = verdict(r, F);
    add(`KNOWN-BAD: ${what} fails ${re}`, fails(r, re) && v.length === CHECK_COUNT, failing(r).join(' | '));
  }
  // a picked gain where the lossless one belongs
  add('KNOWN-BAD: a picked gain (0.55) fails the derivation', fails(GOOD_REPORT.report, /lossless shell's/, { ...F, transmit: 0.55 }));
  // an arm missing is a failed check, not a throw and not a vanished check
  const miss = clone();
  delete miss.arms.furnace;
  let v = null, threw = null;
  try { v = verdict(miss, F); } catch (e) { threw = e.message; }
  add('KNOWN-BAD: a missing arm fails its check, with every check still counted, rather than throwing',
    !threw && v.length === CHECK_COUNT && v.some((c) => !c.ok && /ENERGY/.test(c.name)), threw ?? failing(miss).join(' | '));
  return checks;
}
export const VERDICT_CHECKS = 14;

// --------------------------------------------------------------------------------------------- dispatch
if (SELFTEST) {
  console.log('GLOBE-GLASS SELFTEST — the instrument');
  const inst = instrumentChecks();
  for (const c of inst) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
  console.log('GLOBE-GLASS SELFTEST — the verdict');
  const ver = verdictChecks();
  for (const c of ver) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
  const all = [...inst, ...ver];
  const failed = all.filter((c) => !c.ok).length;
  const counted = inst.length === INSTRUMENT_CHECKS && ver.length === VERDICT_CHECKS;
  console.log(`\nGLOBE-GLASS SELFTEST: ${failed || !counted ? 'FAIL' : 'PASS'} — ${all.length} checks` +
    (failed ? `, ${failed} failed` : '') + (counted ? '' : ` (expected ${INSTRUMENT_CHECKS} + ${VERDICT_CHECKS})`));
  process.exit(failed || !counted ? 1 : 0);
}

if (GATE) {
  const t0 = Date.now();
  const { GLOBE_FINISH, GLOBE_FINISH_BEFORE } = await import('../src/streetfurniture.js');
  const F = { ...GLOBE_FINISH }, B = { ...GLOBE_FINISH_BEFORE };
  let rep;
  try {
    rep = await runPage(gateArms(F, B));
  } catch (e) {
    console.error(`GLOBE-GLASS: FAIL — ${e.message}`);
    process.exit(1);
  }
  const ji = argv.indexOf('--json');
  if (ji >= 0) fs.writeFileSync(argv[ji + 1], JSON.stringify({ finish: F, report: { meta: rep.meta, arms: rep.arms } }, null, 1));
  console.log('GLOBE-GLASS — is an unlit globe frosted glass? The module\'s lamp beside a white ball, under the dusk preset\'s light');
  console.log(`  shipped finish ${JSON.stringify(F)}; before ${JSON.stringify(B)}`);
  console.log(table(rep));
  console.log('');
  const checks = verdict(rep, F);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  if (rep.logs.length) console.log('\nconsole:\n' + rep.logs.join('\n'));
  const failed = checks.filter((c) => !c.ok);
  const counted = checks.length === CHECK_COUNT;
  const errs = rep.logs.filter((l) => /^pageerror|^error|^http/.test(l));
  console.log(`\nGLOBE-GLASS: ${failed.length || !counted || errs.length ? 'FAIL' : 'PASS'} — ${checks.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
    (failed.length ? `, ${failed.length} failed` : '') + (counted ? '' : ` (expected ${CHECK_COUNT})`) + (errs.length ? `, ${errs.length} page errors` : ''));
  process.exit(failed.length || !counted || errs.length ? 1 : 0);
}
