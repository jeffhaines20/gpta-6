// Street-level reference for the baked district, from Mapillary.
//
// Binding constraint 1 restricts real-location reference to openly licensed
// sources - Mapillary CC BY-SA, Wikimedia Commons - or photographs the user
// supplies. NO Google Maps or Street View imagery, anywhere, including as critic
// reference. Mapillary imagery is CC BY-SA 4.0; every file this writes is
// recorded with its creator and licence in index.json, and the README explains
// that these are REFERENCE, never source assets: nothing is traced, sampled or
// colour-picked into a texture, which is what keeps share-alike off the shipped
// work (and is binding constraint 9 anyway).
//
// Needs MAPILLARY_TOKEN in the environment. A cloud session copies environment
// values ONCE at startup, so a token added to the environment while a session is
// running is not visible to it - start a new session, or add the token as an API
// credential instead, which the agent proxy attaches outside the sandbox.
//
//   node tools/fetch-mapillary.mjs --census      # metadata only, downloads nothing
//   node tools/fetch-mapillary.mjs               # corridor stations, flat + pano
//   MLY_SELECT=all MLY_LIMIT=80 node tools/fetch-mapillary.mjs
//
// ---------------------------------------------------------------------------
// WHY THIS QUERIES SMALL BOXES AND NOT ONE BIG ONE
//
// The first version asked for the whole trim box with `limit=40` and got 39
// images back, every one of them a panorama from a single 2024 sequence. That
// read as "the district is pano-only". It is not. The Graph API's bbox response
// is capped and returns whatever it reaches first, so ONE query over a box this
// size returns roughly one sequence and silently hides the rest.
//
// Gridding the box helps but does not fix it, and the proof is that the answer
// keeps moving: the same trim box censused at GRID=4 twice returned 4,348 then
// 4,814 unique images, and at GRID=8 returned 6,686 (flat 1,257 / 1,586 / 2,513).
// A number that grows every time you subdivide is a number still hitting the cap,
// and one that changes between identical runs is a nondeterministic subset. So
// the census is a LOWER BOUND on what is there, never a count of it.
//
// Selection therefore does not run off the census at all. It queries a small box
// AROUND EACH CORRIDOR STATION - about 80 m across, far under the cap - which
// returns everything at that station and makes the pick deterministic and local.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.MAPILLARY_TOKEN || process.env.MAPILLARY_ACCESS_TOKEN;
// The baked district's own trim box, from tools/bake/bake.mjs TRIM.
const TRIM = { s: 27.3305, w: -82.5485, n: 27.3395, e: -82.5340 };
const BBOX = (process.env.MLY_BBOX || '').split(',').map(Number).filter((n) => !Number.isNaN(n));
const box = BBOX.length === 4
  ? { s: BBOX[0], w: BBOX[1], n: BBOX[2], e: BBOX[3] }
  : TRIM;
const OUT = 'reference/sarasota/mapillary';
const CENSUS = process.argv.includes('--census');

// Selection policy. `corridor` walks the hero corridor and takes the best image
// at each station; `all` reverts to "whatever the box returns", capped.
const SELECT = process.env.MLY_SELECT || 'corridor';
const LIMIT = Number(process.env.MLY_LIMIT ?? 40);
const STATION_M = Number(process.env.MLY_STATION_M ?? 45);   // spacing along the corridor
const STATION_R = Number(process.env.MLY_STATION_R ?? 40);   // search radius around a station
const GRID = Number(process.env.MLY_GRID ?? 4);              // cells per axis

// The bake's projection, so every image can be reported in the same local metres
// the district is authored in - which is what makes a photo findable in-engine.
const R = 6378137;
const lat0 = (TRIM.s + TRIM.n) / 2, lon0 = (TRIM.w + TRIM.e) / 2;
const cos0 = Math.cos((lat0 * Math.PI) / 180);
const toXZ = (lat, lon) => ({
  x: +(((lon - lon0) * Math.PI / 180) * R * cos0).toFixed(1),
  z: +(-((lat - lat0) * Math.PI / 180) * R).toFixed(1),   // north is -Z
});

if (!TOKEN) {
  console.error('MAPILLARY_TOKEN is not set in this environment.');
  console.error('A running cloud session cannot see a variable added after it started;');
  console.error('start a new session, or add the token as an API credential instead.');
  process.exit(2);
}

const api = async (url) => {
  const r = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN}` } });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.message} (code ${j.error.code})`);
  return j;
};

// `is_pano` is requested so panoramas can be told apart: a 360 sphere is useless
// as a facade reference until it is reprojected (tools/reproject-pano.mjs), and
// mixing them in silently would put warped buildings in front of an artist.
const FIELDS = ['id', 'computed_geometry', 'geometry', 'captured_at', 'compass_angle',
  'is_pano', 'creator', 'thumb_2048_url', 'thumb_1024_url'].join(',');

// --- 1. queries --------------------------------------------------------------

const normalise = (raw) => {
  const out = [];
  for (const im of raw) {
    const g = im.computed_geometry || im.geometry;
    if (!g?.coordinates) continue;
    const url = im.thumb_2048_url || im.thumb_1024_url;
    if (!url) continue;
    const [lon, lat] = g.coordinates;
    const local = toXZ(lat, lon);
    out.push({
      file: `mly-${im.id}.jpg`, id: im.id, lat, lon, x: local.x, z: local.z,
      headingDeg: im.compass_angle ?? null, isPano: !!im.is_pano,
      capturedAt: im.captured_at ? new Date(im.captured_at).toISOString().slice(0, 10) : null,
      creator: im.creator?.username ?? null,
      licence: 'CC BY-SA 4.0',
      source: `https://www.mapillary.com/app/?pKey=${im.id}&focus=photo`,
      url,
    });
  }
  return out;
};

const tally = (arr, f) => [...arr.reduce((m, i) => m.set(f(i), (m.get(f(i)) || 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ');
const year = (i) => (i.capturedAt || '?').slice(0, 4);
const report = (meta, label) => {
  const flat = meta.filter((i) => !i.isPano), pano = meta.filter((i) => i.isPano);
  console.log(`\n${meta.length} unique images ${label}   flat ${flat.length}   pano ${pano.length}`);
  console.log(`  flat by year    ${tally(flat, year) || '(none)'}`);
  console.log(`  pano by year    ${tally(pano, year) || '(none)'}`);
  console.log(`  flat by creator ${tally(flat, (i) => i.creator ?? '?') || '(none)'}`);
  console.log(`  pano by creator ${tally(pano, (i) => i.creator ?? '?') || '(none)'}`);
};

// A grid census over the whole box. Capped, so this is a LOWER BOUND - see the
// header. Used by --census and by MLY_SELECT=all, never by corridor selection.
const censusBox = async () => {
  const seen = new Map();
  for (let iy = 0; iy < GRID; iy++) {
    for (let ix = 0; ix < GRID; ix++) {
      const w = box.w + (box.e - box.w) * ix / GRID, e = box.w + (box.e - box.w) * (ix + 1) / GRID;
      const s = box.s + (box.n - box.s) * iy / GRID, n = box.s + (box.n - box.s) * (iy + 1) / GRID;
      const j = await api(`https://graph.mapillary.com/images?fields=${FIELDS}&bbox=${w},${s},${e},${n}&limit=500`);
      for (const im of (j.data || [])) seen.set(im.id, im);
      process.stderr.write(`  cell ${ix},${iy}: ${(j.data || []).length}\n`);
    }
  }
  return normalise([...seen.values()]);
};

if (CENSUS) {
  report(await censusBox(), `over the box (GRID=${GRID}, a lower bound)`);
  console.log('\n--census: nothing downloaded. This count is capped and moves between runs;');
  console.log('it says what is THERE, not how much of it a single query can see.');
  process.exit(0);
}

// --- 2. select ---------------------------------------------------------------

// The hero corridor is the marina-through-Five-Points run of the drive route
// (binding constraint 2), read from the bake so it cannot drift out of sync.
const routeOf = () => {
  const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
  const from = Number(process.env.MLY_ROUTE_FROM ?? 0);
  const to = Number(process.env.MLY_ROUTE_TO ?? 4);
  return d.meta.route.slice(from, to + 1).map((p) => ({ x: p.x, z: p.z, name: p.name }));
};

// Walk the polyline at STATION_M and take the best image near each station. This
// is the whole point of the rewrite: selecting by API return order gave 39 frames
// of one street, and selecting by distance-to-origin gives a pile at the origin.
// Stations give EVEN COVERAGE OF THE CORRIDOR, which is what facade reference is.
const stationsOf = (route) => {
  const out = [];
  let carry = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i], b = route[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    for (let t = carry; t < len; t += STATION_M) {
      out.push({ x: a.x + ux * t, z: a.z + uz * t, ux, uz, leg: a.name });
    }
    carry = (carry - len) % STATION_M;
    if (carry < 0) carry += STATION_M;
  }
  return out;
};

let picked;
let pool = { total: 0, flat: 0, pano: 0 };   // what the queries SAW, recorded beside what was kept
if (SELECT === 'all') {
  const meta = await censusBox();
  report(meta, `over the box (GRID=${GRID}, a lower bound)`);
  pool = { total: meta.length, flat: meta.filter((i) => !i.isPano).length, pano: meta.filter((i) => i.isPano).length };
  picked = meta.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, LIMIT);
} else {
  const route = routeOf();
  const stations = stationsOf(route);
  console.log(`corridor: ${route.map((p) => p.name).join(' -> ')}`);
  console.log(`${stations.length} stations at ${STATION_M} m, radius ${STATION_R} m`);

  const taken = new Set();
  const chosen = [];
  const seenAll = new Map();
  let empty = 0;
  for (const [i, st] of stations.entries()) {
    // One small query per station. STATION_R metres converted back to degrees;
    // an ~80 m box is far under the response cap, so this returns everything
    // that is actually there instead of a nondeterministic slice of it.
    const dLat = STATION_R / 111320;
    const dLon = STATION_R / (111320 * cos0);
    const lat = lat0 - (st.z / R) * (180 / Math.PI);
    const lon = lon0 + (st.x / (R * cos0)) * (180 / Math.PI);
    const bb = `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`;
    const j = await api(`https://graph.mapillary.com/images?fields=${FIELDS}&bbox=${bb}&limit=500`);
    const local = normalise(j.data || []);
    for (const im of local) seenAll.set(im.id, im);
    if (!local.length) empty++;
    process.stderr.write(`  station ${String(i).padStart(2)} ${st.leg.padEnd(24)} ${String(local.length).padStart(4)} images\n`);

    // One FLAT and one PANO per station where each exists. They answer different
    // questions - a flat frame is a real camera with real optics, a pano can be
    // aimed at the shopfront instead of down the road - so neither replaces the other.
    for (const wantPano of [false, true]) {
      let best = null, bestScore = Infinity;
      for (const im of local) {
        if (im.isPano !== wantPano || taken.has(im.id)) continue;
        const d = Math.hypot(im.x - st.x, im.z - st.z);
        if (d > STATION_R) continue;
        // Prefer the newest capture at comparable distance: a 2 m closer frame
        // from 2014 is worse reference than a 2021 one, because the street has
        // been re-paved and re-awninged since.
        const ageYears = 2026 - Number((im.capturedAt || '2014').slice(0, 4));
        const score = d + ageYears * 2.5;
        if (score < bestScore) { bestScore = score; best = im; }
      }
      if (best) { taken.add(best.id); chosen.push({ ...best, station: st.leg }); }
    }
  }
  const saw = [...seenAll.values()];
  report(saw, 'within reach of a corridor station');
  pool = { total: saw.length, flat: saw.filter((i) => !i.isPano).length, pano: saw.filter((i) => i.isPano).length };
  if (empty) console.log(`  ${empty} of ${stations.length} stations returned nothing at all`);
  picked = chosen.slice(0, LIMIT);
  console.log(`\nselected ${picked.length} of ${chosen.length} station picks (MLY_LIMIT=${LIMIT})`);
}

// --- 3. download -------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
const index = [];
let fetched = 0, cached = 0;
for (const im of picked) {
  const file = path.join(OUT, im.file);
  if (!fs.existsSync(file)) {
    const r = await fetch(im.url);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    fetched++;
  } else cached++;
  const { url, ...rec } = im;
  index.push(rec);
}
index.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));

// Anything already on disk from an earlier run is kept in the index, so a
// re-run with a different policy does not orphan files whose licence record
// would then be lost. An image with no licence line is an image we cannot use.
const onDisk = new Set(fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')));
const indexed = new Set(index.map((i) => i.file));
let carried = 0;
if (fs.existsSync(path.join(OUT, 'index.json'))) {
  const prev = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
  for (const rec of (prev.images || [])) {
    if (onDisk.has(rec.file) && !indexed.has(rec.file)) { index.push(rec); indexed.add(rec.file); carried++; }
  }
}
const orphans = [...onDisk].filter((f) => !indexed.has(f));

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  bbox: box, fetched: new Date().toISOString().slice(0, 10),
  select: SELECT, stationM: STATION_M, stationR: STATION_R,
  sawTotal: pool.total, sawFlat: pool.flat, sawPano: pool.pano,
  licence: 'CC BY-SA 4.0', attribution: 'Imagery © Mapillary contributors, CC BY-SA 4.0',
  note: 'Reference only. Not traced, sampled or copied into any shipped asset.',
  images: index,
}, null, 1));

const panos = index.filter((i) => i.isPano).length;
console.log(`\n${OUT}: ${index.length} indexed  (${panos} pano, ${index.length - panos} flat)`);
console.log(`  ${fetched} downloaded, ${cached} already on disk, ${carried} carried from the previous index`);
if (orphans.length) console.log(`  WARNING ${orphans.length} files on disk with no licence record: ${orphans.slice(0, 3).join(', ')}`);
console.log('\nnearest to the district origin:');
index.slice(0, 8).forEach((i) => console.log(
  `  (${String(i.x).padStart(7)}, ${String(i.z).padStart(7)})  heading ${String(i.headingDeg ?? '?').padStart(7)}  ${i.capturedAt}  ${i.isPano ? 'pano' : 'flat'}  ${i.file}`));
