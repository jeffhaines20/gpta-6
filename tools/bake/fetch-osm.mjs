// AUTHOR-TIME ONLY. Downloads the OpenStreetMap extract for the district and
// writes the raw Overpass responses to disk. The game never runs this; it only
// ever reads the baked JSON in data/.
//
// Data © OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright
import fs from 'node:fs';
import path from 'node:path';

const BBOX = { s: 27.327, w: -82.552, n: 27.342, e: -82.528 };
const B = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;
const OUT = 'data/raw';
fs.mkdirSync(OUT, { recursive: true });

const QUERIES = {
  roads: `[out:json][timeout:180];(way["highway"](${B}););out body geom;`,
  buildings: `[out:json][timeout:180];(way["building"](${B});relation["building"](${B}););out body geom;`,
  water: `[out:json][timeout:180];(way["natural"="water"](${B});way["natural"="coastline"](${B});way["waterway"](${B});relation["natural"="water"](${B}););out body geom;`,
  land: `[out:json][timeout:180];(way["landuse"](${B});way["leisure"](${B});way["amenity"="parking"](${B}););out body geom;`,
};

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(name, query, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);           // fails loudly on a truncated body
      if (!json.elements) throw new Error('no elements key');
      fs.writeFileSync(path.join(OUT, `${name}.json`), text);
      console.log(`  ${name.padEnd(10)} ok  ${json.elements.length} elements, ${(text.length / 1024).toFixed(0)} KB`);
      return json;
    } catch (e) {
      const wait = Math.min(60000, 2000 * 2 ** (i - 1));
      console.log(`  ${name.padEnd(10)} attempt ${i}/${attempts} failed: ${e.message}${i < attempts ? ` — retrying in ${wait / 1000}s` : ''}`);
      if (i === attempts) throw e;
      await sleep(wait);
    }
  }
}

console.log(`Fetching OSM extract for bbox ${B}`);
const results = {};
for (const [name, q] of Object.entries(QUERIES)) {
  results[name] = await fetchWithRetry(name, q);
  await sleep(3000);   // be polite to a shared public endpoint
}

const totalBytes = fs.readdirSync(OUT).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(JSON.stringify({
  bbox: BBOX,
  extract_bytes: totalBytes,
  extract_kb: +(totalBytes / 1024).toFixed(1),
  counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.elements.length])),
}, null, 2));
