// How high does the streetwall stand, in degrees above the horizon?
//
// A photograph and a render of the same street can be argued about forever. This
// turns the argument into one number per image column: the elevation angle of the
// topmost built thing. It works only because tools/pano-match.mjs captures with
// EXACTLY the camera model tools/reproject-pano.mjs reprojects with - same eye
// height, pitch, horizontal fov and aspect - so a row index maps to the same
// elevation angle in both, and the two profiles can be subtracted.
//
//   node tools/roofline.mjs 1414553883288835 R golden
//   node tools/roofline.mjs --all golden
//
// A column whose sky runs all the way to the bottom of the frame reports null
// (nothing built in that direction); a column with no sky at all reports the top
// of frame, which is a LOWER BOUND on the roofline and is flagged as clipped -
// "at least this tall", never "this tall".
import { readPNG } from './png.mjs';
import fs from 'node:fs';
import path from 'node:path';

const REF = 'reference/sarasota/mapillary/views';
const REN = 'docs/shots/pano-match';
const PITCH = 12, HFOV = 75, ASPECT = 4 / 3;
const VFOV = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / ASPECT) * 180) / Math.PI;

// Sky, deliberately conservative: bright AND blue-dominant. Sarasota's sky in
// these captures is a strong blue and the render's is a pale blue-grey, so the
// margin is small on purpose - a loose detector would eat pale stucco, and pale
// stucco under a bright sky is exactly what this is trying to measure past.
const isSky = (r, g, b) => b > 90 && b >= g && b > r + 6 && (r + g + b) / 3 > 85;

const elevOf = (row, h) => PITCH + (Math.atan((1 - 2 * (row + 0.5) / h) * Math.tan((VFOV * Math.PI) / 360)) * 180) / Math.PI;

/** Topmost non-sky row per column -> elevation angle. */
export function roofline(file) {
  const img = readPNG(file);
  const { width: w, height: h, channels: c, data } = img;
  const cols = [];
  let clipped = 0, open = 0;
  for (let x = 0; x < w; x++) {
    let row = -1;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * c;
      if (!isSky(data[i], data[i + 1], data[i + 2])) { row = y; break; }
    }
    if (row < 0) { cols.push(null); open++; continue; }   // sky all the way down
    if (row === 0) clipped++;                              // no sky at all in this column
    cols.push(elevOf(row, h));
  }
  const seen = cols.filter((v) => v !== null).sort((a, b) => a - b);
  const q = (p) => (seen.length ? seen[Math.floor((seen.length - 1) * p)] : null);
  return {
    file: path.basename(file), w, h,
    skyFrac: +(open / w).toFixed(3),
    clippedFrac: +(clipped / w).toFixed(3),
    p10: q(0.1), p50: q(0.5), p90: q(0.9),
    cols,
  };
}

const fmt = (v) => (v === null ? '  -  ' : `${v >= 0 ? ' ' : ''}${v.toFixed(1)}`);
const line = (label, r) => `  ${label.padEnd(9)} p10 ${fmt(r.p10)}  p50 ${fmt(r.p50)}  p90 ${fmt(r.p90)}   `
  + `sky-to-ground ${(r.skyFrac * 100).toFixed(0)}%  no-sky ${(r.clippedFrac * 100).toFixed(0)}%`;

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const all = process.argv.includes('--all');
  const time = process.argv[process.argv.length - 1];
  const pairs = [];
  if (all) {
    for (const f of fs.readdirSync(REN).filter((n) => n.endsWith(`-${time}.png`))) {
      const [id, side] = f.replace(`-${time}.png`, '').split('-');
      pairs.push([id, side]);
    }
  } else pairs.push([process.argv[2], process.argv[3]]);

  console.log(`camera: eye 2.5 m, pitch ${PITCH} deg, hfov ${HFOV} on ${ASPECT.toFixed(3)} -> vfov ${VFOV.toFixed(1)}`);
  console.log('roofline elevation above the horizon, degrees. higher = taller streetwall.\n');
  const rows = [];
  for (const [id, side] of pairs.sort()) {
    const rf = path.join(REF, `${id}-${side}.png`);
    const rn = path.join(REN, `${id}-${side}-${time}.png`);
    if (!fs.existsSync(rf) || !fs.existsSync(rn)) continue;
    const a = roofline(rf), b = roofline(rn);
    console.log(`${id} ${side}`);
    console.log(line('reference', a));
    console.log(line('built', b));
    const d = a.p50 !== null && b.p50 !== null ? b.p50 - a.p50 : null;
    console.log(`  ${d === null ? 'delta    n/a' : `delta     p50 ${d > 0 ? '+' : ''}${d.toFixed(1)} deg  (built is ${d > 0 ? 'TALLER' : 'shorter'})`}\n`);
    rows.push({ id, side, reference: { p10: a.p10, p50: a.p50, p90: a.p90, skyFrac: a.skyFrac, clippedFrac: a.clippedFrac },
      built: { p10: b.p10, p50: b.p50, p90: b.p90, skyFrac: b.skyFrac, clippedFrac: b.clippedFrac }, deltaP50: d });
  }
  if (rows.length > 1) {
    const ds = rows.map((r) => r.deltaP50).filter((v) => v !== null).sort((a, b) => a - b);
    console.log(`${rows.length} pairs.  delta p50: min ${ds[0]?.toFixed(1)}  median ${ds[Math.floor(ds.length / 2)]?.toFixed(1)}  max ${ds[ds.length - 1]?.toFixed(1)}`);
    console.log(`taller in ${ds.filter((v) => v > 0).length} of ${ds.length}`);
  }
  fs.writeFileSync(path.join(REN, `roofline-${time}.json`), JSON.stringify({
    camera: { eye: 2.5, pitchDeg: PITCH, hfovDeg: HFOV, vfovDeg: +VFOV.toFixed(2) },
    detector: 'sky = b>90 && b>=g && b>r+6 && mean>85',
    pairs: rows,
  }, null, 1));
}
