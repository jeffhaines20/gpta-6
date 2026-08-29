// Minimal OSM XML reader. The API's output is regular enough that a streaming
// tag scan is both sufficient and far faster than pulling in an XML dependency
// we would then have to vendor.
import fs from 'node:fs';

export function parseOSM(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const nodes = new Map();
  const ways = [];
  const relations = [];

  const attr = (s, k) => {
    const m = s.match(new RegExp(`\\s${k}="([^"]*)"`));
    return m ? m[1] : undefined;
  };
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  // Split on top-level elements. Each is either self-closing or has children.
  const re = /<(node|way|relation)\b([^>]*?)(\/)?>([\s\S]*?)?(?:<\/\1>)?(?=\s*<(?:node|way|relation|\/osm))/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, kind, head, selfClose, body = ''] = m;
    const id = attr(head, 'id');
    const tags = {};
    if (body) {
      for (const t of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)) {
        tags[decode(t[1])] = decode(t[2]);
      }
    }
    if (kind === 'node') {
      nodes.set(id, { id, lat: +attr(head, 'lat'), lon: +attr(head, 'lon'), tags });
    } else if (kind === 'way') {
      const refs = [...(body.matchAll(/<nd ref="([^"]*)"\s*\/>/g))].map((r) => r[1]);
      ways.push({ id, refs, tags });
    } else {
      const members = [...(body.matchAll(/<member type="([^"]*)" ref="([^"]*)" role="([^"]*)"\s*\/>/g))]
        .map((r) => ({ type: r[1], ref: r[2], role: r[3] }));
      relations.push({ id, members, tags });
    }
  }
  return { nodes, ways, relations };
}

// Equirectangular projection to local metres. At a 2 km span the error against a
// proper projection is centimetres, and it keeps the bake dependency-free.
export function makeProjector(lat0, lon0) {
  const R = 6378137;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0, lon0,
    toXZ(lat, lon) {
      return {
        x: ((lon - lon0) * Math.PI / 180) * R * cos0,
        z: -((lat - lat0) * Math.PI / 180) * R,   // north is -Z, matching Three.js convention
      };
    },
  };
}
