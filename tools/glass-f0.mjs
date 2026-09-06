// What F0 does DOWN one pane of the facade atlas.
//
// Every other glazing tool in this directory measures the rendered frame, which
// is the right place to judge the result and the wrong place to find the cause:
// a frame confounds the coating, the environment, the sun, the tonemap and the
// exposure. This reads the atlas itself - the albedo canvas and the packed
// roughness/metalness canvas that facades.js draws - and reports the one number
// that decides how much sky a pane can ever send back:
//
//   F0 = mix( 0.04, sRGBtoLinear( albedo ), metalness )
//
// which is exactly what three.js computes as `material.specularColor` for a
// MeshStandardMaterial (lights_physical_fragment; verified in
// vendor/three.module.min.js), and for a pane at metalness 0.84 it IS the
// mirror. It needs no scene, no lighting and no render: the page is loaded only
// because facades.js draws on a 2D canvas and Node has none.
//
// The reason it exists: `drawOpening` paints the recessed-reveal shading - a
// 0.62-black head gradient over the top 42% of the opening and a 0.40-black jamb
// gradient over its left 30% - into the ALBEDO, over the glass as well as the
// masonry. On a diffuse reveal that is ambient occlusion. On a pane at metalness
// 0.84 it is a 3x cut in mirror reflectance, strongest at the head, which is the
// "vertical profile is backwards" a review round measured off the frame.
//
// Usage:
//   node tools/glass-f0.mjs                  # every glazed recipe
//   GF0_PORT=8137 node tools/glass-f0.mjs
//   node tools/glass-f0.mjs --selftest       # no browser; the arithmetic only
//
// Output: a per-recipe table of F0 against height inside one opening, and a
// head/cill ratio. Above 1 = brighter mirror at the head, which is what a pane
// under a reveal does (the soffit is above it, the sky is what it reflects).
// Below 1 = the painted-AO defect.
import fs from 'node:fs';

const PORT = Number(process.env.GF0_PORT ?? 8123);
const OUT = process.env.GF0_OUT
  ?? '/tmp/claude-0/-home-user-gpta-6/481b6aa3-9372-53ec-9397-cb1259b5e6bf/scratchpad/glass-f0.json';

// ------------------------------------------------------------------ the maths
/** sRGB byte -> linear. The atlas albedo canvas is authored and uploaded as sRGB. */
export const s2l = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
/** three.js: material.specularColor = mix( vec3( 0.04 ), albedo, metalness ). */
export const f0 = (byte, metalness) => 0.04 * (1 - metalness) + s2l(byte) * metalness;
/** pane-audit / pane-stats / glaz-probe agree: a glass texel is smooth and metallic. */
export const isGlassTexel = (g, b) => g < 96 && b > 100;
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * One vertical scan through an atlas.
 * @param {{alW:number, alH:number, al:Uint8Array, rmW:number, rmH:number, rm:Uint8Array}} a
 * @param {number} u  horizontal position as a fraction of the panel width
 */
export function scanColumn(a, u) {
  const rows = [];
  const rx = Math.min(a.rmW - 1, Math.max(0, Math.round(u * a.rmW)));
  const ax = Math.min(a.alW - 1, Math.max(0, Math.round(u * a.alW)));
  for (let ry = 0; ry < a.rmH; ry++) {
    const i = (ry * a.rmW + rx) * 4;
    const g = a.rm[i + 1], b = a.rm[i + 2];
    if (!isGlassTexel(g, b)) continue;
    const ay = Math.min(a.alH - 1, Math.round(((ry + 0.5) / a.rmH) * a.alH));
    const j = (ay * a.alW + ax) * 4;
    const alb = [a.al[j], a.al[j + 1], a.al[j + 2]];
    const metal = b / 255, rough = g / 255;
    rows.push({
      ry, v: ry / a.rmH, alb, rough: +rough.toFixed(3), metal: +metal.toFixed(3),
      f0: alb.map((c) => +f0(c, metal).toFixed(4)),
      f0y: +(0.2126 * f0(alb[0], metal) + 0.7152 * f0(alb[1], metal) + 0.0722 * f0(alb[2], metal)).toFixed(4),
      albY: +lum(alb[0], alb[1], alb[2]).toFixed(1),
    });
  }
  return rows;
}

/** Split one contiguous run of glass rows into openings and summarise each. */
export function openings(rows, minRows = 6) {
  const runs = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && r.ry !== cur[cur.length - 1].ry + 1) { if (cur.length >= minRows) runs.push(cur); cur = []; }
    cur.push(r);
  }
  if (cur.length >= minRows) runs.push(cur);
  return runs.map((run) => {
    const n = run.length;
    const third = Math.max(1, Math.round(n / 3));
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const head = mean(run.slice(0, third).map((r) => r.f0y));
    const cill = mean(run.slice(-third).map((r) => r.f0y));
    return {
      rows: n, ry0: run[0].ry, ry1: run[n - 1].ry,
      headF0: +head.toFixed(4), cillF0: +cill.toFixed(4),
      meanF0: +mean(run.map((r) => r.f0y)).toFixed(4),
      minF0: +Math.min(...run.map((r) => r.f0y)).toFixed(4),
      maxF0: +Math.max(...run.map((r) => r.f0y)).toFixed(4),
      headOverCill: +(head / Math.max(1e-6, cill)).toFixed(3),
      metal: +(mean(run.map((r) => r.metal))).toFixed(3),
      rough: +(mean(run.map((r) => r.rough))).toFixed(3),
      profile: run.filter((_, i) => i % Math.max(1, Math.floor(n / 8)) === 0)
        .map((r) => ({ v: +r.v.toFixed(3), albY: r.albY, f0y: r.f0y })),
    };
  });
}

// ------------------------------------------------------------------ selftest
// Known-good and known-bad, on synthetic atlases whose answer is arithmetic.
function selftest() {
  const fails = [];
  const ck = (name, ok, got) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}   ${got}`); if (!ok) fails.push(name); };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  // 1. The transfer function and F0, against hand-computed values.
  ck('sRGB 157 -> linear 0.3372', near(s2l(157), 0.3372, 0.0005), s2l(157).toFixed(4));
  ck('sRGB 60 -> linear 0.0452', near(s2l(60), 0.0452, 0.0005), s2l(60).toFixed(4));
  ck('F0(157, m=0.84) = 0.2896', near(f0(157, 0.84), 0.2896, 0.0005), f0(157, 0.84).toFixed(4));
  // 157 under the 0.62-black head gradient is 157*0.38 = 59.7 -> and this is the
  // number drawOpening's own comment records as measured off the shipped atlas.
  ck('F0(157 under 0.62 black, m=0.84) = 0.044 (the recorded 0.038-0.082 cell)',
    near(f0(Math.round(157 * 0.38), 0.84), 0.0439, 0.002), f0(Math.round(157 * 0.38), 0.84).toFixed(4));

  // 2. A synthetic atlas: one 30-row opening, glass texels, albedo dark at the
  //    head and bright at the cill - the reported defect.
  const mk = (top, bot) => {
    const rmW = 8, rmH = 64, alW = 16, alH = 128;
    const rm = new Uint8Array(rmW * rmH * 4), al = new Uint8Array(alW * alH * 4);
    for (let y = 0; y < rmH; y++) {
      for (let x = 0; x < rmW; x++) {
        const i = (y * rmW + x) * 4;
        const glass = y >= 16 && y < 46;
        rm[i] = 230; rm[i + 1] = glass ? 30 : 180; rm[i + 2] = glass ? 214 : 10; rm[i + 3] = 255;
      }
    }
    for (let y = 0; y < alH; y++) {
      const ry = Math.floor((y / alH) * rmH);
      const t = (ry - 16) / 29;
      const v = ry >= 16 && ry < 46 ? Math.round(top + (bot - top) * t) : 120;
      for (let x = 0; x < alW; x++) {
        const i = (y * alW + x) * 4;
        al[i] = al[i + 1] = al[i + 2] = v; al[i + 3] = 255;
      }
    }
    return { rmW, rmH, alW, alH, rm, al };
  };

  let o = openings(scanColumn(mk(60, 157), 0.5));
  ck('one opening found', o.length === 1, `${o.length}`);
  ck('KNOWN-BAD dark head / bright cill -> head/cill < 0.35 (the painted-AO defect)',
    o.length === 1 && o[0].headOverCill < 0.35, o.length ? String(o[0].headOverCill) : 'n/a');

  // 157 -> 108 is the recipe's own authored head/mid/cill stops with no reveal
  // shading over them. The threshold is 1.6 because that is what the arithmetic
  // gives (top third mean byte ~149, bottom third ~116, F0 0.259 / 0.156 = 1.66);
  // the first version of this test guessed 1.9 and failed on correct input,
  // which is the whole reason a selftest is written before the measurement.
  o = openings(scanColumn(mk(157, 108), 0.5));
  ck('KNOWN-GOOD bright head / dimmer cill -> head/cill > 1.6',
    o.length === 1 && o[0].headOverCill > 1.6, o.length ? String(o[0].headOverCill) : 'n/a');
  ck('KNOWN-GOOD head F0 lands near 0.28, not 0.04',
    o.length === 1 && near(o[0].headF0, 0.28, 0.03), o.length ? String(o[0].headF0) : 'n/a');

  // 3. A wall-only atlas must yield no openings at all, rather than a confident
  //    reading off masonry texels.
  const wallOnly = mk(157, 108);
  for (let i = 0; i < wallOnly.rm.length; i += 4) { wallOnly.rm[i + 1] = 180; wallOnly.rm[i + 2] = 10; }
  ck('KNOWN-BAD no glass texels -> no openings, not a wall reading',
    openings(scanColumn(wallOnly, 0.5)).length === 0, `${openings(scanColumn(wallOnly, 0.5)).length}`);

  console.log(fails.length ? `SELFTEST FAIL: ${fails.join(', ')}` : 'SELFTEST PASS');
  return fails.length;
}

// -------------------------------------------------------------------- capture
async function capture() {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 3', null, { timeout: 120000 });

  const atlases = await page.evaluate(async () => {
    const F = await import('/src/facades.js');
    const out = [];
    for (const name of F.RECIPE_NAMES) {
      const rec = F.RECIPES[name];
      if (rec.shape !== 'glazed') continue;
      const m = F.facadeMaps(name);
      const grab = (tex) => {
        const c = tex.image;
        const g = document.createElement('canvas');
        g.width = c.width; g.height = c.height;
        const x = g.getContext('2d');
        x.drawImage(c, 0, 0);
        return { w: c.width, h: c.height, data: [...x.getImageData(0, 0, c.width, c.height).data] };
      };
      const al = grab(m.map), rm = grab(m.rmMap);
      out.push({ name, label: rec.label, glass: rec.glass, reveal: rec.win.reveal,
        alW: al.w, alH: al.h, al: al.data, rmW: rm.w, rmH: rm.h, rm: rm.data });
    }
    return out;
  });
  await browser.close();
  if (errors.length) console.log('page errors:', errors);
  return atlases.map((a) => ({ ...a, al: Uint8Array.from(a.al), rm: Uint8Array.from(a.rm) }));
}

function fmt(rows) {
  const L = [];
  for (const a of rows) {
    L.push(`${a.name.padEnd(13)} ${a.label}   atlas ${a.alW}x${a.alH} albedo / ${a.rmW}x${a.rmH} rm   `
      + `authored glass head/mid/cill ${a.glass.map((c) => c.join('/')).join('  ')}`);
    for (const col of a.columns) {
      L.push(`  column u=${col.u}   ${col.openings.length} opening(s)`);
      for (const o of col.openings) {
        L.push(`    rows ${String(o.ry0).padStart(4)}-${String(o.ry1).padStart(4)}  `
          + `F0 head ${o.headF0.toFixed(4)}  cill ${o.cillF0.toFixed(4)}  mean ${o.meanF0.toFixed(4)}  `
          + `head/cill ${o.headOverCill.toFixed(3)}${o.headOverCill < 1 ? '  <-- INVERTED' : ''}  `
          + `(rough ${o.rough.toFixed(3)} metal ${o.metal.toFixed(3)})`);
        L.push('      down the pane  ' + o.profile.map((p) => `${p.v.toFixed(2)}:${p.f0y.toFixed(3)}`).join('  '));
      }
    }
    const all = a.columns.flatMap((c) => c.openings);
    if (all.length) {
      const m = (f) => all.reduce((s, o) => s + f(o), 0) / all.length;
      L.push(`  ${a.name} SUMMARY over ${all.length} openings:  mean F0 ${m((o) => o.meanF0).toFixed(4)}  `
        + `head ${m((o) => o.headF0).toFixed(4)}  cill ${m((o) => o.cillF0).toFixed(4)}  `
        + `head/cill ${m((o) => o.headOverCill).toFixed(3)}`);
    }
  }
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--selftest') process.exit(selftest() ? 1 : 0);
  const atlases = await capture();
  // Five columns across the panel: the jamb gradient darkens the left 30% of an
  // opening, so a single mid-bay column would under-report the spread.
  const US = [0.12, 0.3, 0.5, 0.7, 0.88];
  const rows = atlases.map((a) => ({
    ...a, al: undefined, rm: undefined,
    columns: US.map((u) => ({ u, openings: openings(scanColumn(a, u)) })),
  }));
  console.log(fmt(rows));
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
  console.log(`\nwritten: ${OUT}`);
}
