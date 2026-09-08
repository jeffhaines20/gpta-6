// Car legibility probe: are the wheels, the paint and the panel work of a
// PARKED car actually readable, and by how much did a change move that?
//
// Why this exists. Two blind rounds independently reported the cars as "wheels
// are featureless black discs with a baked vertical body gradient", and the
// cars had never had a measurement pass. Judging a car by eye off a hero frame
// is exactly the failure mode CLAUDE.md warns about: the subject drifts. At the
// corridor camera the pool re-seeds around the player, so "the nearest parked
// car" is not the same car twice, and every absolute number moves with it.
//
// So the subject is PINNED by its parking slot in world coordinates
// (--slot X,Z), the way ao-sweep's --slot pins its pavement. A run meant to be
// compared with an earlier one MUST pass the earlier run's slot; the tool prints
// the slot it chose so the next run can pin it.
//
// Every rectangle sampled is PROJECTED from the car's own geometry through the
// live camera, not drawn on the image by eye. The wheel disc is the projection
// of (axle centre, wheelR); the flank quad is the projection of a rectangle on
// the door skin. That is what makes "the rim is 1.02x the tyre" a statement
// about the rim rather than about whatever was at those pixels.
//
// The metrics, all ratios INSIDE one frame so they survive an exposure change
// between builds (CLAUDE.md: a raw level is not comparable across builds, and
// this project's exposure spans 1/78000 to 1/1.15):
//
//   rimTyre   median luma inside r < 0.55 R  /  median luma in 0.80..1.00 R.
//             "Is there a rim inside that tyre." A featureless black disc is
//             1.0. A real alloy against a black tyre is 2 and up.
//   rimCoV    std/mean of luma inside r < 0.75 R. "Is there structure in it" -
//             spokes, a hub, a lip. A flat disc is ~0 whatever its brightness,
//             which is why rimTyre alone is not enough: a uniformly BRIGHT disc
//             would score well on rimTyre and still read as a sticker.
//   spec      p98 / median luma over the flank quad. A matte body is ~1.2; a
//             clearcoat with a sun glint in it runs well above that.
//             LIMIT, measured in the self-test: a highlight covering under ~2%
//             of the quad does not move p98 at all - a 1.87% glint reads exactly
//             1.000. Do not quote spec for a small, tight highlight; it can only
//             see one that is broad enough to reach the top 2% of the samples.
//   vGrad     median luma of the flank quad's top third / its bottom third.
//             This is the "baked vertical gradient" complaint as a number.
//             It is NOT meant to reach 1.0 - a real car IS darker at the rocker
//             than at the shoulder - it is meant to stop being a black fade.
//   edges     mean |Laplacian| over the car's projected box / mean luma there.
//             Panel lines, shuts, lamp divisions and arch lips all raise it.
//             Exposure-invariant by the division; scale-dependent, so it is only
//             comparable between runs at the SAME distance and framing.
//
// Usage:
//   node tools/car-probe.mjs --selftest
//   CAR_TAG=before node tools/car-probe.mjs
//   CAR_TAG=after  node tools/car-probe.mjs --slot 118.4,-159.2
//   node tools/car-probe.mjs --report before after
//
// Env:
//   CAR_TAG    capture prefix (default 'car')
//   CAR_TIMES  times of day (default 'noon,night')
//   CAR_PORT   http port. NOT 8123 - that belongs to the main tree, and a
//              worktree that reuses it photographs the wrong build.
//   CAR_DIST   camera distance from the subject in metres (default 7)
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const OUT = 'docs/probe';
const ARGS = process.argv.slice(2);
const argOf = (name) => { const i = ARGS.indexOf(name); return i >= 0 ? ARGS[i + 1] : null; };

// ------------------------------------------------------------------ sampling
//
// readPNG returns `channels`, and for these screenshots it is 3, not 4. A
// hardcoded 4-byte stride misaligns every sample and runs off the end of the
// buffer in the bottom quarter, where the reads come back undefined -> NaN.
// NaN then fails every `>` comparison silently, so the corrupted rows report NO
// DIFFERENCE, which is the most dangerous shape a measurement bug can take.
// Everything below goes through this one accessor, and it throws rather than
// return a non-finite sample.
function sampler(png) {
  const { width: w, height: h, channels: ch, data } = png;
  if (!(ch === 3 || ch === 4)) throw new Error(`unexpected channels ${ch}`);
  return {
    w, h, ch,
    luma(x, y) {
      const xi = x | 0, yi = y | 0;
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
      const p = (yi * w + xi) * ch;
      const v = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      if (!Number.isFinite(v)) {
        throw new Error(`non-finite sample at ${xi},${yi} (channels=${ch}) - stride bug`);
      }
      return v;
    },
  };
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, q) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const stdev = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/** Luma inside the projected wheel disc, split into rim core and tyre annulus. */
export function wheelMetrics(png, cx, cy, r) {
  const s = sampler(png);
  const core = [], tyre = [], inner = [];
  const R = Math.max(1, r);
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      const d = Math.hypot(x - cx, y - cy) / R;
      if (d > 1) continue;
      const L = s.luma(x, y);
      if (L === null) continue;
      if (d < 0.55) core.push(L);
      if (d < 0.75) inner.push(L);
      if (d >= 0.80) tyre.push(L);
    }
  }
  const tyreMed = median(tyre);
  return {
    px: +(2 * R).toFixed(1),
    samples: core.length + tyre.length,
    rimTyre: tyreMed > 0.5 ? +(median(core) / tyreMed).toFixed(3) : null,
    rimCoV: +(stdev(inner) / Math.max(1e-6, mean(inner))).toFixed(3),
    rimLuma: +median(core).toFixed(1),
    tyreLuma: +tyreMed.toFixed(1),
  };
}

/** Specular response and vertical gradient over a projected quad on the flank. */
export function flankMetrics(png, quad) {
  const s = sampler(png);
  // quad: [tl, tr, br, bl] in screen px. Sample on a regular (u,v) grid inside it.
  const N = 48;
  const all = [], top = [], bot = [];
  for (let iv = 0; iv <= N; iv++) {
    const v = iv / N;
    for (let iu = 0; iu <= N; iu++) {
      const u = iu / N;
      const x = (1 - u) * ((1 - v) * quad[0][0] + v * quad[3][0])
              + u * ((1 - v) * quad[1][0] + v * quad[2][0]);
      const y = (1 - u) * ((1 - v) * quad[0][1] + v * quad[3][1])
              + u * ((1 - v) * quad[1][1] + v * quad[2][1]);
      const L = s.luma(x, y);
      if (L === null) continue;
      all.push(L);
      if (v < 1 / 3) top.push(L);
      else if (v > 2 / 3) bot.push(L);
    }
  }
  const med = median(all);
  const botMed = median(bot);
  return {
    samples: all.length,
    spec: med > 0.5 ? +(pct(all, 0.98) / med).toFixed(3) : null,
    vGrad: botMed > 0.5 ? +(median(top) / botMed).toFixed(3) : null,
    topLuma: +median(top).toFixed(1),
    botLuma: +botMed.toFixed(1),
  };
}

/** Detail density over the car's projected box: mean |Laplacian| / mean luma. */
export function edgeMetrics(png, box) {
  const s = sampler(png);
  const x0 = Math.max(1, Math.floor(box[0])), y0 = Math.max(1, Math.floor(box[1]));
  const x1 = Math.min(s.w - 2, Math.ceil(box[2])), y1 = Math.min(s.h - 2, Math.ceil(box[3]));
  let lap = 0, lum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = s.luma(x, y);
      const v = Math.abs(4 * c - s.luma(x - 1, y) - s.luma(x + 1, y)
                             - s.luma(x, y - 1) - s.luma(x, y + 1));
      lap += v; lum += c; n++;
    }
  }
  if (!n) return { edges: null, px: 0 };
  return {
    px: n,
    boxW: x1 - x0 + 1,
    boxH: y1 - y0 + 1,
    edges: +(lap / Math.max(1e-6, lum)).toFixed(4),
  };
}

// ------------------------------------------------------------------ selftest
//
// Each case is a KNOWN-BAD or KNOWN-GOOD synthetic frame, because a metric that
// has never been shown a wrong answer is not an instrument. Two probes in this
// project shipped bugs their own self-tests caught.
function synth(w, h, ch, paint) {
  const data = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      const p = (y * w + x) * ch;
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
      if (ch === 4) data[p + 3] = 255;
    }
  }
  return { width: w, height: h, channels: ch, data };
}

function selftest() {
  const fail = [];
  const ok = (name, cond, got) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? `  (${got})` : ''}`);
    if (!cond) fail.push(name);
  };

  // 1. The defect this tool was built to name: a featureless dark disc. The rim
  //    must NOT be reported as legible.
  const flat = synth(64, 64, 3, (x, y) =>
    (Math.hypot(x - 32, y - 32) < 24 ? [18, 19, 22] : [140, 140, 140]));
  const mFlat = wheelMetrics(flat, 32, 32, 24);
  ok('flat disc: rimTyre ~ 1', Math.abs(mFlat.rimTyre - 1) < 0.05, mFlat.rimTyre);
  ok('flat disc: rimCoV ~ 0', mFlat.rimCoV < 0.02, mFlat.rimCoV);

  // 2. A rim that IS legible: bright core, dark tyre. Both metrics must rise.
  const alloy = synth(64, 64, 3, (x, y) => {
    const d = Math.hypot(x - 32, y - 32);
    if (d > 24) return [140, 140, 140];
    if (d > 18) return [18, 19, 22];                       // tyre
    const a = Math.atan2(y - 32, x - 32);
    const lobe = 0.5 + 0.5 * Math.cos(5 * a);              // five spokes
    const v = Math.round(40 + 170 * lobe);
    return [v, v, v];
  });
  const mAlloy = wheelMetrics(alloy, 32, 32, 24);
  ok('alloy disc: rimTyre > 2', mAlloy.rimTyre > 2, mAlloy.rimTyre);
  ok('alloy disc: rimCoV > 0.3', mAlloy.rimCoV > 0.3, mAlloy.rimCoV);

  // 3. THE STRIDE TRAP. readPNG returns channels 3 for these screenshots. A
  //    4-byte stride misreads every pixel and runs off the buffer in the bottom
  //    quarter, where the samples come back NaN - and NaN loses every comparison
  //    silently, so the corrupted rows report "no difference". A known value is
  //    planted in the BOTTOM quarter of a 3-channel image; a tool with the bug
  //    cannot read it back.
  const planted = synth(40, 40, 3, (x, y) => (y >= 30 ? [200, 200, 200] : [10, 10, 10]));
  const sp = sampler(planted);
  ok('3ch: bottom quarter reads planted 200', Math.abs(sp.luma(20, 35) - 200) < 1,
    sp.luma(20, 35).toFixed(1));
  ok('3ch: top reads planted 10', Math.abs(sp.luma(20, 5) - 10) < 1, sp.luma(20, 5).toFixed(1));
  // The same image at 4 channels must give the SAME answer through the accessor.
  const planted4 = synth(40, 40, 4, (x, y) => (y >= 30 ? [200, 200, 200] : [10, 10, 10]));
  ok('4ch: same answer as 3ch', Math.abs(sampler(planted4).luma(20, 35) - 200) < 1);
  // And the naive 4-stride read of that same 3-channel buffer: index
  // (35*40+20)*4 = 5680 against a 4800-byte buffer, so it runs off the end and
  // comes back `undefined`. The second assertion is the point of the whole
  // case - `Math.abs(undefined - 200) > 1` is FALSE, so a tool written that way
  // reports the corrupted rows as MATCHING. That is the reassuring wrong answer.
  const bad = planted.data[(35 * 40 + 20) * 4];
  ok('a 4-stride read of a 3ch buffer runs off the end', bad === undefined, String(bad));
  ok('...and the naive NaN guard does not fire', (Math.abs(bad - 200) > 1) === false);

  // 4. vGrad must SEE a top-to-bottom fade, must report ~1 on a flat panel, and
  //    must be MONOTONIC in the steepness of the fade - that last property is
  //    the one a before/after comparison actually rests on.
  const fadeOf = (drop) => synth(64, 64, 3, (x, y) => {
    const v = Math.round(240 - drop * (y / 63)); return [v, v, v];
  });
  const q = [[8, 8], [56, 8], [56, 56], [8, 56]];
  const gentle = flankMetrics(fadeOf(120), q).vGrad;
  const steep = flankMetrics(fadeOf(220), q).vGrad;
  ok('fade: vGrad > 1.4', gentle > 1.4, gentle);
  ok('steeper fade reads higher', steep > gentle + 0.5, `${gentle} -> ${steep}`);
  const flatPanel = synth(64, 64, 3, () => [120, 120, 120]);
  const mFlatP = flankMetrics(flatPanel, q);
  ok('flat panel: vGrad ~ 1', Math.abs(mFlatP.vGrad - 1) < 0.02, mFlatP.vGrad);
  ok('flat panel: spec ~ 1', Math.abs(mFlatP.spec - 1) < 0.02, mFlatP.spec);

  // 5. A glint must raise spec - and a glint too SMALL to reach the top 2% of
  //    the samples must not, which is this metric's resolution limit stated as a
  //    test so that nobody later quotes spec for a highlight it cannot see.
  const glintOf = (r) => synth(64, 64, 3, (x, y) =>
    (Math.hypot(x - 32, y - 20) < r ? [250, 250, 250] : [110, 110, 110]));
  const bigGlint = flankMetrics(glintOf(9), q).spec;      // 9.4% of the quad
  const tinyGlint = flankMetrics(glintOf(4), q).spec;     // 1.87% of the quad
  ok('broad glint: spec > 1.5', bigGlint > 1.5, bigGlint);
  ok('sub-2% glint is BELOW this metric resolution', tinyGlint === 1, tinyGlint);

  // 6. edges must rise on a striped panel and sit near zero on a flat one.
  const stripes = synth(64, 64, 3, (x) => { const v = x % 6 < 3 ? 60 : 180; return [v, v, v]; });
  const eFlat = edgeMetrics(flatPanel, [8, 8, 56, 56]).edges;
  const eStripe = edgeMetrics(stripes, [8, 8, 56, 56]).edges;
  ok('flat panel: edges ~ 0', eFlat < 0.01, eFlat);
  ok('striped panel: edges > 10x flat', eStripe > 10 * Math.max(eFlat, 1e-4), eStripe);

  console.log(fail.length ? `\nSELFTEST FAILED: ${fail.join(', ')}` : '\nSELFTEST OK');
  return fail.length === 0;
}

if (ARGS.includes('--selftest')) process.exit(selftest() ? 0 : 1);

// ------------------------------------------------------------------ report
function loadRun(tag) {
  const f = `${OUT}/${tag}.json`;
  if (!fs.existsSync(f)) throw new Error(`no such run: ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

if (ARGS.includes('--report')) {
  const i = ARGS.indexOf('--report');
  const a = loadRun(ARGS[i + 1]), b = loadRun(ARGS[i + 2]);
  if (a.slot !== b.slot) {
    console.log(`WARNING: different subjects - ${a.slot} vs ${b.slot}. `
      + 'Every absolute number below is of a different car; do not compare them.');
  }
  console.log(`subject slot ${a.slot}   camera ${a.dist} m   car ${a.carPx} px long on screen\n`);
  const head = 'tod      metric      before     after     change';
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const tod of Object.keys(a.tod)) {
    if (!b.tod[tod]) continue;
    const A = a.tod[tod], B = b.tod[tod];
    const row = (name, x, y, unit = '') => {
      if (x == null || y == null) return;
      const d = y - x;
      console.log(`${tod.padEnd(8)} ${name.padEnd(11)} ${String(x).padStart(8)}  `
        + `${String(y).padStart(8)}  ${(d >= 0 ? '+' : '') + d.toFixed(3)}${unit}`);
    };
    row('rimTyre F', A.wheelFront.rimTyre, B.wheelFront.rimTyre);
    row('rimCoV F', A.wheelFront.rimCoV, B.wheelFront.rimCoV);
    row('rimTyre R', A.wheelRear.rimTyre, B.wheelRear.rimTyre);
    row('rimCoV R', A.wheelRear.rimCoV, B.wheelRear.rimCoV);
    row('spec', A.flank.spec, B.flank.spec);
    row('vGrad', A.flank.vGrad, B.flank.vGrad);
    row('edges', A.edge.edges, B.edge.edges);
    console.log('');
  }
  process.exit(0);
}

// ------------------------------------------------------------------ capture
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const TAG = process.env.CAR_TAG ?? 'car';
const TIMES = (process.env.CAR_TIMES ?? 'noon,night').split(',');
const PORT = Number(process.env.CAR_PORT ?? 8161);
const DIST = Number(process.env.CAR_DIST ?? 7);
const SLOT = argOf('--slot');
fs.mkdirSync(OUT, { recursive: true });

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

// Anchor on the Main Street east leg, the same carriageway the corridor hero
// stands on, so the subject is a car a reviewer of that frame could actually see.
const setup = await page.evaluate(async (cfg) => {
  const D = window.__district;
  const r = D.district.meta.route;
  const a = r[3], b = r[4];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ax = a.x + ((b.x - a.x) / len) * 55, az = a.z + ((b.z - a.z) / len) * 55;
  D.placeAt(ax, az);
  D.setAutopilot(() => {});
  for (let i = 0; i < 900; i++) D.world.update(D.vehicle.position);
  D.furniture.refreshParked(ax, az, true);

  const mesh = D.furniture.parked.mesh;
  const V3 = D.camera.position.constructor;
  const m = new (D.camera.matrixWorld.constructor)();
  // Every placed instance, with its world position and yaw read back off the
  // matrix rather than out of the placement code - the pool hides unused slots
  // by scaling them to zero, and a zero-scale matrix must not become a subject.
  const cars = [];
  for (let i = 0; i < D.furniture.parked.count; i++) {
    mesh.getMatrixAt(i, m);
    const e = m.elements;
    const sx = Math.hypot(e[0], e[1], e[2]);
    if (sx < 0.5) continue;
    cars.push({ i, x: e[12], y: e[13], z: e[14], yaw: Math.atan2(e[8] / sx, e[10] / sx) });
  }
  if (!cars.length) return { error: 'no parked cars placed' };

  let pick;
  if (cfg.slot) {
    const [sx2, sz2] = cfg.slot.split(',').map(Number);
    pick = cars.reduce((best, c) =>
      ((c.x - sx2) ** 2 + (c.z - sz2) ** 2 < (best.x - sx2) ** 2 + (best.z - sz2) ** 2 ? c : best));
  } else {
    // No slot given: the car nearest the anchor, which is the one a reviewer's
    // eye lands on in the corridor frame. Its slot is printed so the next run
    // can pin it - see the ao-sweep note in CLAUDE.md.
    pick = cars.reduce((best, c) =>
      ((c.x - ax) ** 2 + (c.z - az) ** 2 < (best.x - ax) ** 2 + (best.z - az) ** 2 ? c : best));
  }

  // Stand off the car's tail quarter, on whichever side is nearer the road
  // centreline - parked cars sit at the kerb and the other side is pavement.
  const cs = Math.cos(pick.yaw), sn = Math.sin(pick.yaw);
  const local = (lx, ly, lz) => [pick.x + lx * cs + lz * sn, pick.y + ly, pick.z - lx * sn + lz * cs];
  const roadT = Math.max(0, Math.min(1,
    ((pick.x - a.x) * (b.x - a.x) + (pick.z - a.z) * (b.z - a.z)) / (len * len)));
  const rx = a.x + (b.x - a.x) * roadT, rz = a.z + (b.z - a.z) * roadT;
  const side = (() => {
    const p = local(1, 0, 0);
    return Math.hypot(p[0] - rx, p[2] - rz) < Math.hypot(pick.x - rx, pick.z - rz) ? 1 : -1;
  })();
  const eye = local(side * cfg.dist * 0.62, 1.55, -cfg.dist * 0.78);
  const tgt = local(0, 0.62, -0.35);
  D.freeCam(eye, tgt, 40);
  for (let i = 0; i < 60; i++) D.world.update(D.vehicle.position);

  // Project the geometry the metrics need. Local Y of the wheel centre is
  // groundY + wheelR: buildTrafficCarGeometry translates the body so the tyres
  // rest on groundY, and the axle sits one wheel radius above that.
  const GROUND_Y = -0.05 - 0.02;         // PAD_Y - 0.02, streetfurniture.js
  const WHEEL_R = 0.36, F_AXLE = 1.32, R_AXLE = -1.30;
  const project = (lx, ly, lz) => {
    const w = new V3(...local(lx, ly, lz));
    w.project(D.camera);
    return [(w.x * 0.5 + 0.5) * innerWidth, (-w.y * 0.5 + 0.5) * innerHeight];
  };
  // A wheel's on-screen radius: project the axle and a point one radius above it.
  const wheelDisc = (lz) => {
    const c = project(side * 0.79, GROUND_Y + WHEEL_R, lz);
    const t = project(side * 0.79, GROUND_Y + WHEEL_R * 2, lz);
    return { cx: c[0], cy: c[1], r: Math.hypot(t[0] - c[0], t[1] - c[1]) };
  };
  // The flank quad: a rectangle on the door skin, shoulder down to rocker,
  // between the two arches. Deliberately clear of the glass and of the arches.
  const flank = [
    project(side * 0.94, 0.30, 0.55), project(side * 0.94, 0.30, -0.90),
    project(side * 0.94, -0.46, -0.90), project(side * 0.94, -0.46, 0.55),
  ];
  // The whole-car box, for the edge density.
  const corners = [];
  for (const lx of [-0.98, 0.98]) for (const ly of [GROUND_Y, 0.75]) for (const lz of [-2.3, 2.3]) {
    corners.push(project(lx, ly, lz));
  }
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const nose = project(0, 0.2, 2.24), tail = project(0, 0.2, -2.24);

  return {
    slot: `${pick.x.toFixed(1)},${pick.z.toFixed(1)}`,
    yaw: +pick.yaw.toFixed(3), side,
    eye: eye.map((v) => +v.toFixed(2)),
    wheelFront: wheelDisc(F_AXLE), wheelRear: wheelDisc(R_AXLE),
    flank,
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    carPx: +Math.hypot(nose[0] - tail[0], nose[1] - tail[1]).toFixed(1),
  };
}, { slot: SLOT, dist: DIST });

if (setup.error) { console.error(setup.error); await browser.close(); process.exit(2); }
console.log(`subject slot ${setup.slot}  (pin the next run with --slot ${setup.slot})`);
console.log(`camera ${DIST} m off the tail quarter, car ${setup.carPx} px long on screen`);
console.log(`front wheel ${(2 * setup.wheelFront.r).toFixed(1)} px across, `
  + `rear ${(2 * setup.wheelRear.r).toFixed(1)} px`);
if (setup.wheelRear.r < 4) {
  console.log('NOTE: a wheel under 8 px across cannot resolve a rim; treat rimCoV as indicative only.');
}

const run = { tag: TAG, slot: setup.slot, dist: DIST, carPx: setup.carPx, tod: {} };
for (const tod of TIMES) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 6, f0, { timeout: 180000, polling: 200 });
  const file = `${OUT}/${TAG}-${tod}.png`;
  await page.screenshot({ path: file, timeout: 180000 });
  const png = readPNG(file);
  const rec = {
    file,
    wheelFront: wheelMetrics(png, setup.wheelFront.cx, setup.wheelFront.cy, setup.wheelFront.r),
    wheelRear: wheelMetrics(png, setup.wheelRear.cx, setup.wheelRear.cy, setup.wheelRear.r),
    flank: flankMetrics(png, setup.flank),
    edge: edgeMetrics(png, setup.box),
  };
  run.tod[tod] = rec;
  console.log(`${tod.padEnd(7)} rimTyre F ${String(rec.wheelFront.rimTyre).padStart(6)} `
    + `R ${String(rec.wheelRear.rimTyre).padStart(6)}   `
    + `rimCoV F ${String(rec.wheelFront.rimCoV).padStart(5)} R ${String(rec.wheelRear.rimCoV).padStart(5)}   `
    + `spec ${String(rec.flank.spec).padStart(5)}  vGrad ${String(rec.flank.vGrad).padStart(6)}  `
    + `edges ${String(rec.edge.edges).padStart(6)}`);
}

fs.writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify({ ...run, setup, errors }, null, 2));
console.log(`\nwrote ${OUT}/${TAG}.json`);
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
await browser.close();
