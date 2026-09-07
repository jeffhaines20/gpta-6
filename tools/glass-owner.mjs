// WHICH MATERIAL is the glazing a street-level camera actually sees?
//
// Three review rounds reported dark shopfronts, and the standing diagnosis is
// that the facade atlas' lit-window machinery (cell.lit[t], LIT_TIMES,
// EMISSIVE_INTENSITY) never reaches them because the pane in frame belongs to
// the TRIM atlas, which has no emissive map at all. That is a claim about the
// build, not about the picture, and CLAUDE.md is explicit that a reviewer's
// diagnosis is weaker than their observation. So it is measured here rather than
// read off the source.
//
// Method: stand the hero corridor camera where hero-shots.mjs stands it, raycast
// a grid of pixels through the frame region the reports named, and read back for
// each hit the material NAME, its emissive state, and - for trim hits - which
// atlas cell the barycentric UV lands in. Nothing is inferred from colour.
//
// The UV -> cell classification is the load-bearing step, so it has a self-test
// that fails on known-bad input (a cell index computed with the wrong row
// orientation, which is the mistake trimCell's own comment warns about: canvas
// rows run top-down and texture v runs bottom-up).
//
//   node tools/glass-owner.mjs --selftest
//   GO_PORT=8137 node tools/glass-owner.mjs
import fs from 'node:fs';

const TRIM_GRID = 4;

// Names in TRIM order: index = iy * 4 + ix, matching facades.js' TRIM table.
export const TRIM_NAMES = [
  'stone', 'metalDark', 'gravel', 'fabricA',
  'glass', 'bulkhead', 'steel', 'signFace',
  'stucco', 'concrete', 'brick', 'mullion',
  'fabricB', 'rust', 'louvre', 'asphalt',
];

/**
 * Which trim atlas cell does a UV land in?
 *
 * v runs BOTTOM-UP in texture space while the atlas canvas was drawn TOP-DOWN,
 * so the row index is (1 - v) * grid, not v * grid. Getting that backwards
 * mirrors the table vertically and reports `fabricB` for every pane of glass -
 * a wrong answer that looks like a real answer, which is why it is self-tested.
 */
export function cellOfUV(u, v, grid = TRIM_GRID) {
  const ix = Math.min(grid - 1, Math.max(0, Math.floor(u * grid)));
  const iy = Math.min(grid - 1, Math.max(0, Math.floor((1 - v) * grid)));
  return { ix, iy, index: iy * grid + ix, name: TRIM_NAMES[iy * grid + ix] ?? `${ix},${iy}` };
}

function selftest() {
  let fail = 0;
  const ck = (name, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got}, want ${want}`);
  };
  // facades.js TRIM.glass is [0, 1]: column 0, canvas ROW 1 from the top.
  // trimCell maps that to v in [1 - 2/4, 1 - 1/4] = [0.50, 0.75].
  ck('centre of the glass cell', cellOfUV(0.125, 0.625).name, 'glass');
  ck('glass cell low v edge', cellOfUV(0.125, 0.51).name, 'glass');
  ck('glass cell high v edge', cellOfUV(0.125, 0.74).name, 'glass');
  // Its four neighbours, to prove the mapping is not merely centred by luck.
  ck('above the glass cell (row 0)', cellOfUV(0.125, 0.99).name, 'stone');
  ck('below the glass cell (row 2)', cellOfUV(0.125, 0.30).name, 'stucco');
  ck('right of the glass cell', cellOfUV(0.375, 0.625).name, 'bulkhead');
  ck('bottom-right corner', cellOfUV(0.99, 0.01).name, 'asphalt');
  ck('top-right corner', cellOfUV(0.99, 0.99).name, 'fabricA');

  // KNOWN-BAD INPUT: the flipped-row bug this function exists to not have.
  // A classifier that uses v directly instead of (1 - v) reports the mirror row.
  const flipped = (u, v, grid = TRIM_GRID) => {
    const ix = Math.min(grid - 1, Math.max(0, Math.floor(u * grid)));
    const iy = Math.min(grid - 1, Math.max(0, Math.floor(v * grid)));
    return TRIM_NAMES[iy * grid + ix];
  };
  // v 0.625 is canvas row 1 read correctly, and canvas row 2 read flipped, so a
  // flipped classifier calls the district's shopfront glass `stucco`.
  ck('flipped classifier misreads glass as stucco', flipped(0.125, 0.625), 'stucco');
  ck('and the correct one does not', cellOfUV(0.125, 0.625).name !== flipped(0.125, 0.625), true);

  // Out-of-range UVs clamp rather than index off the end and return undefined,
  // which would print as a hole in the histogram rather than as an error.
  ck('u past 1 clamps', cellOfUV(1.4, 0.625).name, 'signFace');
  // v below 0 is off the BOTTOM of the texture, which is the LAST canvas row.
  ck('v below 0 clamps', cellOfUV(0.125, -0.3).name, 'fabricB');

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const PORT = Number(process.env.GO_PORT ?? 8137);
const TOD = process.env.GO_TOD ?? 'night';
// Which hero camera. Both are hero-shots.mjs' own, verbatim; a probe standing
// anywhere else is answering a question about a different picture.
const VIEW = process.env.GO_VIEW ?? 'corridor';
const VIEWS = {
  corridor: { back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  fivepoints: { back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
};
// The region the reports named on a 1600x900 corridor frame: the CASSAVA /
// LUMEN CAMERA row.
const BOX = (process.env.GO_BOX ?? '60,380,420,220').split(',').map(Number);
const STEP = Number(process.env.GO_STEP ?? 6);

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
// 300 s, not 60. tools/load-time.mjs measures this district at 27.7 s to
// frames > 5 on an idle box, and CLAUDE.md already records that a headless
// browser here is at the mercy of whatever else is running - the same contention
// that makes `chunk stall ms` swing 7 to 68 ms. A 60 s wait turns a busy box into
// a tool failure, and a tool that fails when the machine is loaded gets retried
// rather than read.
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.GO_TIMEOUT ?? 300000), polling: 250 });

// hero-shots.mjs' corridor camera, verbatim: waypoint 3 -> 4, back -55, side 0,
// height 2.4, fov 55, target y 16 at 260 m. A probe standing anywhere else is
// answering a question about a different picture.
const placed = await page.evaluate((cfg) => {
  const r = __district.district.meta.route;
  const a = r[3], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  const px = a.x - (dx / len) * cfg.back + nx * cfg.side;
  const pz = a.z - (dz / len) * cfg.back + nz * cfg.side;
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([px, cfg.height, pz],
    [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd], cfg.fov);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return { x: +px.toFixed(1), z: +pz.toFixed(1) };
}, VIEWS[VIEW]);
console.log(`${VIEW} camera at (${placed.x}, ${placed.z}), ${TOD}`);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.waitForTimeout(15000);

const report = await page.evaluate(async ({ box, step, names }) => {
  const THREE = await import('/vendor/three.module.min.js');
  const [bx, by, bw, bh] = box;
  const cam = __district.camera;
  const rc = new THREE.Raycaster();
  rc.far = 220;
  const W = 1600, H = 900;
  const hits = {};
  const cells = {};
  const states = {};
  const glassDist = [];
  let miss = 0, total = 0;
  const mats = {};
  // Everything the raycast can reach, minus the sky dome, which is not a surface.
  const targets = [];
  __district.scene.traverse((o) => { if (o.isMesh && o.visible && o.name !== 'sky') targets.push(o); });

  for (let y = by; y < by + bh; y += step) {
    for (let x = bx; x < bx + bw; x += step) {
      total++;
      // NDC from pixel centre. y is flipped: pixel rows run down, NDC runs up.
      rc.setFromCamera(new THREE.Vector2(((x + 0.5) / W) * 2 - 1, -(((y + 0.5) / H) * 2 - 1)), cam);
      const its = rc.intersectObjects(targets, false);
      const h = its.find((i) => i.object.name !== 'sky');
      if (!h) { miss++; continue; }
      const mn = h.object.material?.name || '(unnamed)';
      hits[mn] = (hits[mn] ?? 0) + 1;
      if (!mats[mn]) {
        const m = h.object.material;
        mats[mn] = {
          hasEmissiveMap: !!m.emissiveMap,
          emissiveIntensity: m.emissiveIntensity ?? null,
          emissive: m.emissive ? m.emissive.getHexString() : null,
          vertexColors: !!m.vertexColors,
        };
      }
      // Which atlas cell, for trim hits. h.uv is the interpolated UV at the hit.
      //
      // The INTEGER PART OF V is the tenancy's lit state, so it is read out
      // separately and before the cell is resolved: v in [0,1) is dark, [1,2)
      // dim, [2,3) lit. This is the one measurement that says whether a black
      // shopfront in a frame is a tenancy that chose to be dark or a surface the
      // change never reached, and those have completely different fixes.
      if (mn === 'trim' && h.uv) {
        const grid = 4;
        const block = Math.floor(h.uv.y);
        const frac = h.uv.y - block;
        const ix = Math.min(grid - 1, Math.max(0, Math.floor(h.uv.x * grid)));
        const iy = Math.min(grid - 1, Math.max(0, Math.floor((1 - frac) * grid)));
        const nm = names[iy * grid + ix] ?? `${ix},${iy}`;
        cells[nm] = (cells[nm] ?? 0) + 1;
        const key = `${nm}@${['none', 'dark', 'dim', 'lit'][block] ?? `v+${block}`}`;
        states[key] = (states[key] ?? 0) + 1;
        if (nm === 'glass') { glassDist.push(+h.distance.toFixed(2)); }
      }
    }
  }
  glassDist.sort((a, b) => a - b);
  return { hits, cells, states, miss, total, mats,
    glassDist: glassDist.length
      ? { n: glassDist.length, min: glassDist[0], med: glassDist[glassDist.length >> 1],
        max: glassDist[glassDist.length - 1] }
      : null };
}, { box: BOX, step: STEP, names: TRIM_NAMES });

const pc = (n) => `${((100 * n) / report.total).toFixed(1)}%`;
console.log(`\n=== ${report.total} rays through box [${BOX}] at ${TOD} ===`);
console.log('material hits:');
for (const [k, v] of Object.entries(report.hits).sort((a, b) => b[1] - a[1])) {
  const m = report.mats[k];
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${pc(v).padStart(6)}   ` +
    `emissiveMap=${m.hasEmissiveMap ? 'yes' : 'NO '} intensity=${m.emissiveIntensity} vcol=${m.vertexColors}`);
}
console.log(`  ${'(sky / no hit)'.padEnd(22)} ${String(report.miss).padStart(5)}  ${pc(report.miss).padStart(6)}`);
console.log('\ntrim atlas cells hit:');
for (const [k, v] of Object.entries(report.cells).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${pc(v).padStart(6)}`);
}
console.log('\ntrim cell x tenancy state (integer part of v):');
for (const [k, v] of Object.entries(report.states).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${pc(v).padStart(6)}`);
}
if (report.glassDist) {
  const d = report.glassDist;
  console.log(`\nglass hit distance (m): min ${d.min}  median ${d.med}  max ${d.max}  over ${d.n} rays`);
}
if (errors.length) console.log('\npage errors:', errors.slice(0, 5));
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(process.env.GO_OUT ?? `docs/glass-owner-${VIEW}.json`, JSON.stringify({ tod: TOD, box: BOX, ...report }, null, 1));
console.log(`\nwrote ${process.env.GO_OUT ?? `docs/glass-owner-${VIEW}.json`}`);
await browser.close();
