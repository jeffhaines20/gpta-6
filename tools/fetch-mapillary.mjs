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
//   MAPILLARY_TOKEN=MLY... node tools/fetch-mapillary.mjs
//   MLY_LIMIT=60 MLY_BBOX=27.334,-82.545,27.337,-82.539 node tools/fetch-mapillary.mjs
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.MAPILLARY_TOKEN || process.env.MAPILLARY_ACCESS_TOKEN;
// The baked district's own trim box, from tools/bake/bake.mjs TRIM.
const TRIM = { s: 27.3305, w: -82.5485, n: 27.3395, e: -82.5340 };
const BBOX = (process.env.MLY_BBOX || '').split(',').map(Number).filter((n) => !Number.isNaN(n));
const box = BBOX.length === 4
  ? { s: BBOX[0], w: BBOX[1], n: BBOX[2], e: BBOX[3] }
  : TRIM;
const LIMIT = Number(process.env.MLY_LIMIT ?? 40);
const OUT = 'reference/sarasota/mapillary';

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
// as a facade reference without reprojection, and mixing them in silently would
// put warped buildings in front of an artist.
const FIELDS = ['id', 'computed_geometry', 'geometry', 'captured_at', 'compass_angle',
  'is_pano', 'creator', 'thumb_2048_url', 'thumb_1024_url'].join(',');
const bbox = `${box.w},${box.s},${box.e},${box.n}`;   // Mapillary wants W,S,E,N
console.log(`bbox ${bbox}  limit ${LIMIT}`);

const res = await api(`https://graph.mapillary.com/images?fields=${FIELDS}&bbox=${bbox}&limit=${LIMIT}`);
const imgs = res.data || [];
console.log(`returned ${imgs.length} images`);
if (!imgs.length) { console.log('nothing in this bbox - widen MLY_BBOX or raise MLY_LIMIT'); process.exit(0); }

fs.mkdirSync(OUT, { recursive: true });
const index = [];
for (const im of imgs) {
  const g = im.computed_geometry || im.geometry;
  if (!g?.coordinates) continue;
  const [lon, lat] = g.coordinates;
  const url = im.thumb_2048_url || im.thumb_1024_url;
  if (!url) continue;
  const local = toXZ(lat, lon);
  const name = `mly-${im.id}.jpg`;
  const file = path.join(OUT, name);
  if (!fs.existsSync(file)) {
    const r = await fetch(url);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  index.push({
    file: name, id: im.id, lat, lon, x: local.x, z: local.z,
    headingDeg: im.compass_angle ?? null, isPano: !!im.is_pano,
    capturedAt: im.captured_at ? new Date(im.captured_at).toISOString().slice(0, 10) : null,
    creator: im.creator?.username ?? null,
    licence: 'CC BY-SA 4.0',
    source: `https://www.mapillary.com/app/?pKey=${im.id}&focus=photo`,
  });
}
index.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  bbox: box, fetched: new Date().toISOString().slice(0, 10),
  licence: 'CC BY-SA 4.0', attribution: 'Imagery © Mapillary contributors, CC BY-SA 4.0',
  note: 'Reference only. Not traced, sampled or copied into any shipped asset.',
  images: index,
}, null, 1));

const panos = index.filter((i) => i.isPano).length;
console.log(`wrote ${index.length} images to ${OUT}  (${panos} panoramic, ${index.length - panos} flat)`);
console.log('nearest to the district origin:');
index.slice(0, 8).forEach((i) => console.log(
  `  (${String(i.x).padStart(7)}, ${String(i.z).padStart(7)})  heading ${String(i.headingDeg ?? '?').padStart(5)}  ${i.capturedAt}  ${i.file}`));
