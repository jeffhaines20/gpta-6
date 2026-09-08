// Square-on elevation of one building's street frontage, framed to a chosen
// number of metres, at two times of day.
//
// Why this exists rather than another hero angle: the hero cameras stand IN the
// carriageway and look ALONG it, so a frontage is seen at 10-20 degrees and half
// of it is behind street trees. That is the right frame for judging the street
// and the wrong one for judging whether a 181 m block reads as a row of shops -
// which is a question about the wall, and needs the wall square in frame at a
// known scale. tools/pano-match.mjs is square-on but is aimed by where a
// PHOTOGRAPH was taken, and two of the corridor stations look at elevations this
// district gives no frontage to at all (see --report).
//
//   node tools/lot-shots.mjs --tag after --b 18 --span 42
//   node tools/lot-shots.mjs --tag after --b 18,49,28 --span 42 --times noon,golden
//   node tools/lot-shots.mjs --report            # frontage audit, no browser
//
// The camera is derived from the footprint, so the same --b and --span give the
// same frame on any commit: that is what makes a before/after pair comparable.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';
import { streetDirFor as geomStreetDirFor, streetDirsFor as geomStreetDirsFor } from '../src/geom.js';

if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1, height: 1 };
      return (t[k] = (...a) => {
        if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
        if (String(k).startsWith('create')) return grad;
        if (k === 'getImageData') return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
        return undefined;
      });
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }) };
}
const FAC = await import('../src/facades.js');
const { buildingStyle, edgesOf, facingEdges } = FAC;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TAG = arg('tag', process.env.LOT_TAG ?? 'lot');
const TIMES = arg('times', 'noon,golden').split(',');
const SPAN = Number(arg('span', 26));           // metres of frontage to frame
const STANDOFF = Number(arg('standoff', 18));   // metres out from the wall
// `76` frames the primary frontage; `76:1` frames ring edge 1 of the same
// building. See frameFor().
const IDS = arg('b', '18,29,49').split(',');
// Pedestrian population. The crowd is instanced and its size varies run to run
// (74-96 alive at the same camera on the same commit), which moves the reported
// triangle count by more than this whole change costs - so a triangle A/B has to
// pin it. -1 leaves the app's own default alone, which is what a LOOK pass wants.
const PEDS = Number(arg('peds', -1));
const W = 1600, H = 900, ASPECT = W / H;

const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const CHUNK = d.meta.chunkSize;
const keyOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
// The frontage answer, imported from src/geom.js rather than replayed here. It
// used to be a hand-copy of streaming.js's nearest-road-VERTEX search, and when
// that turned out to be backwards on 99 buildings the copy in each tool would
// have gone on measuring a world nobody renders.
const streetDirFor = (b) => geomStreetDirFor(d, b);

// Where to stand and where to point, derived from the footprint alone.
//
// `--edge N` frames a NAMED ring edge instead of the primary frontage. It exists
// because the elevation a critic complains about is not always the elevation the
// frontage code picked: building #76's 123.2 m south wall faces the Five Points
// junction and has a 2.8 m SERVICE alley 2.4 m off its face, so streetDirsFor
// (rightly) fronts the building on its two tertiary streets instead and this
// tool framed a wall nobody was complaining about. An edge index is not a
// frontage claim - it is a way to photograph a specific piece of wall.
function frameFor(spec) {
  const [bi, forceEdge] = String(spec).split(':');
  return frameOf(Number(bi), forceEdge === undefined ? null : Number(forceEdge));
}

function frameOf(bi, forceEdge) {
  const b = d.buildings[bi];
  const street = streetDirFor(b);
  const fronts = street
    ? facingEdges(b.p, street[0], street[1], { minLen: 4, max: 2 })
    : edgesOf(b.p, { minLen: 4, longest: 2 });
  const e = forceEdge === null ? fronts[0]
    : edgesOf(b.p, { minLen: 0.05 }).find((x) => x.i === forceEdge);
  if (!e) return null;
  const style = buildingStyle(b);
  const h = b.h ?? 6;
  // Stand on the far pavement, not in the next block. 18 m and 26 m of frontage
  // is 71.8 degrees horizontal, which is within a degree of the 75 degrees
  // tools/reproject-pano.mjs renders a Mapillary station at - so this frame and
  // reference/sarasota/mapillary/views/*.png are the same picture of the same
  // width of street, and can be held side by side.
  const standoff = STANDOFF;
  const hfov = (2 * Math.atan((SPAN / 2) / standoff) * 180) / Math.PI;
  const s = Math.min(e.len - SPAN / 2, Math.max(SPAN / 2, Number(arg('s', e.len / 2))));
  const ax = e.a[0] + e.tx * s, az = e.a[1] + e.tz * s;
  const eye = 1.75;
  const vfov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / ASPECT) * 180) / Math.PI;
  // The lot report is asked of the edges the ENGINE plans, which is the UNION
  // over every street direction (appendBuilding's `streetEdges`), not the cone
  // around the primary alone. The camera above is left on `fronts[0]` so every
  // frame this tool has ever taken is still the same frame; only the numbers
  // printed beside it are corrected. On a corner site the two differ.
  const engineEdges = (() => {
    const dirs = geomStreetDirsFor(d, b, 2);
    if (!dirs.length) return edgesOf(b.p, { minLen: 4, longest: 2 });
    const seen = new Map();
    for (const dir of dirs) {
      for (const x of facingEdges(b.p, dir[0], dir[1], { minLen: 4, max: 2 })) {
        if (!seen.has(x.i)) seen.set(x.i, x);
      }
    }
    return [...seen.values()].sort((p, q) => q.len - p.len).slice(0, dirs.length > 1 ? 3 : 2);
  })();
  return {
    bi, edge: e.i, len: +e.len.toFixed(1), recipe: style.recipe, h,
    span: SPAN, standoff: +standoff.toFixed(1), hfov: +hfov.toFixed(1),
    street: engineEdges.some((x) => x.i === e.i),
    cam: [ax + e.nx * standoff, eye, az + e.nz * standoff],
    // Aim a little above the shopfront so the ground floor and the parapet are
    // both in frame on a two- to three-storey block.
    //
    // `--tgty` overrides it, and a TOWER needs it. h * 0.55 capped at 6.5 m puts
    // the frame centre 6.5 m up on anything over 11.8 m tall, which on a 35 m
    // tower means five storeys of repeating window band and a ground floor in
    // the last few rows of pixels - the wrong picture for judging a ground
    // floor. `--tgty 3.5 --span 40 --standoff 22` is the tower framing.
    tgt: [ax, Number(arg('tgty', Math.min(h * 0.55, 6.5))), az],
    fov: vfov,
    lots: (FAC.lotPlanFor ? (FAC.lotPlanFor(b.p, style, h, engineEdges).get(e.i)?.lots ?? []) : [])
      .filter((L) => L.s1 > s - SPAN / 2 && L.s0 < s + SPAN / 2)
      .map((L) => ({ s0: +L.s0.toFixed(1), w: +L.len.toFixed(1), par: +L.parapetH.toFixed(2),
        head: L.head ? +L.head.toFixed(2) : null, door: !!L.doorSpan, awn: !!L.awning })),
  };
}

const frames = IDS.map(frameFor).filter(Boolean);
// The corridor hero camera, replayed from tools/hero-shots.mjs, so the triangle
// A/B can be taken at the frame this round is actually judged on.
if (has('hero')) {
  frames.push({
    bi: 'corridor', edge: -1, len: 0, recipe: 'hero', h: 0, span: 0, standoff: 0, hfov: 55,
    cam: [112.4, 2.4, -163.8], tgt: [317.45, 16, -163.87], fov: 55, lots: [],
  });
}
for (const f of frames) {
  console.log(`#${f.bi} ${f.recipe} h ${f.h}  edge ${f.edge} ${f.len} m` +
    `${f.street === false ? ' (NOT a street edge: the kit builds no frontage here)' : ''}  ` +
    `camera (${f.cam[0].toFixed(1)}, ${f.cam[2].toFixed(1)}) at ${f.standoff} m, ` +
    `${f.span} m of frontage at ${f.hfov} deg, ${f.lots.length} lot(s) in frame`);
  if (f.lots.length) {
    console.log(`    widths ${f.lots.map((L) => L.w).join(' ')}`);
    console.log(`    parapet ${f.lots.map((L) => L.par).join(' ')}`);
    console.log(`    head    ${f.lots.map((L) => L.head ?? '-').join(' ')}`);
    console.log(`    door    ${f.lots.map((L) => (L.door ? 'D' : '.')).join('')}   ` +
      `awning ${f.lots.map((L) => (L.awn ? 'A' : '.')).join('')}`);
  }
}
if (has('report')) process.exit(0);

const LOT_PORT = Number(process.env.LOT_PORT ?? 8123);   // see DRIVE_PORT in tools/drive-through.mjs
await ensureServer(LOT_PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${LOT_PORT}/district/`, { waitUntil: 'networkidle' });
// LOT_BOOT: the district has to render five frames before anything can be
// framed, and headless SwiftShader does that in well under 1 fps. 60 s is
// enough on an idle box and is NOT enough when other agents are running their
// own headless browsers on the same machine - this timed out at 60 s with two
// other worktrees' servers alive. Raise it rather than reading the timeout as
// a broken build.
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.LOT_BOOT ?? 60000) });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
if (PEDS >= 0) {
  await page.evaluate((n) => __district.setPedestrians(n), PEDS);
  console.log(`pedestrians pinned at ${PEDS} for a repeatable triangle count`);
}

const results = [];
for (const f of frames) {
  await page.evaluate((cfg) => {
    __district.placeAt(cfg.cam[0], cfg.cam[2]);
    __district.setAutopilot(() => {});
    __district.freeCam(cfg.cam, cfg.tgt, cfg.fov);
    // Pump the streamer hard before waiting: a fixed short wait measures a
    // half-built district, which this ledger has paid for more than once.
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  }, f);
  await page.waitForTimeout(Number(process.env.LOT_SETTLE ?? 20000));
  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(12000);
    const file = `${OUT}/${TAG}-elev${f.bi}e${f.edge}-${tod}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    const a = await page.evaluate(() => {
      const r = __district.renderStats(); const w = __district.worldReport();
      return { triangles: r.triangles, drawCalls: r.calls, near: w.lodNear, chunks: w.chunksLoaded,
        peds: (__district.pedestrianPositions?.() ?? []).length };
    });
    results.push({ b: f.bi, tod, file, ...a });
    console.log(`  ${file}  tris ${a.triangles}  draw ${a.drawCalls}  near ${a.near}  peds ${a.peds}`);
  }
}
fs.writeFileSync(`docs/${TAG}-elev.json`, JSON.stringify({ frames, results, errors }, null, 1));
console.log(`\nwrote docs/${TAG}-elev.json`);
await browser.close();
