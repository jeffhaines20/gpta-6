// Subtract two tools/contact.mjs runs, box by box, and say which side of the
// noise floor each delta falls on. Also does the per-pixel work the box means
// cannot: how much of a box DARKENED, and by how much where it did, because a
// contact shadow is a small very dark region and a box mean dilutes it.
//
//   node tools/contact-diff.mjs <beforeTag> <afterTag>
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('usage: contact-diff.mjs <beforeTag> <afterTag>'); process.exit(1); }
const before = JSON.parse(fs.readFileSync(`docs/contact-${A}.json`, 'utf8'));
const after = JSON.parse(fs.readFileSync(`docs/contact-${B}.json`, 'utf8'));
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// The floor is the WORSE of the two runs' floors: a delta has to clear the noise
// of both captures it was made from.
const floor = {};
for (const k of new Set([...Object.keys(before.noiseFloor ?? {}), ...Object.keys(after.noiseFloor ?? {})])) {
  floor[k] = Math.max(before.noiseFloor?.[k] ?? 0, after.noiseFloor?.[k] ?? 0);
}

function pixelDiff(fa, fb, box) {
  const a = readPNG(fa), b = readPNG(fb);
  const W = a.width, c = a.channels;
  let dark = 0, bright = 0, n = 0, darkSum = 0, maxDark = 0;
  for (let y = box.y; y < Math.min(a.height, box.y + box.h); y++) {
    for (let x = box.x; x < Math.min(W, box.x + box.w); x++) {
      const i = (y * W + x) * c;
      const d = lum(b.data, i) - lum(a.data, i);
      n++;
      if (d <= -8) { dark++; darkSum += -d; if (-d > maxDark) maxDark = -d; }
      else if (d >= 8) bright++;
    }
  }
  return {
    darkenedPct: +((dark / n) * 100).toFixed(2),
    brightenedPct: +((bright / n) * 100).toFixed(2),
    meanDepthWhereDark: +(dark ? darkSum / dark : 0).toFixed(1),
    maxDark: +maxDark.toFixed(0),
  };
}

const rows = [];
for (const rb of before.results) {
  const ra = after.results.find((r) => r.shot === rb.shot && r.tod === rb.tod);
  if (!ra) continue;
  const boxes = after.boxes[rb.shot];
  console.log(`\n=== ${rb.shot} / ${rb.tod}   draw ${rb.audit.draw} -> ${ra.audit.draw}, ` +
    `tris ${rb.audit.tris} -> ${ra.audit.tris}, casters ${rb.audit.casters} -> ${ra.audit.casters}`);
  console.log(`box                 mean before -> after   delta   floor   darkened%  depth  crushed%  clip%`);
  for (const name of Object.keys(rb.stats)) {
    const sb = rb.stats[name], sa = ra.stats[name];
    const d = sa.mean - sb.mean;
    const f = floor[name] ?? 0;
    const meta = boxes.find((x) => x.name === name);
    const box = meta ?? { x: 0, y: 0, w: 1600, h: 900 };
    const pd = pixelDiff(rb.file, ra.file, box);
    const sig = Math.abs(d) > Math.max(f * 3, 0.05);
    rows.push({ shot: rb.shot, tod: rb.tod, box: name, before: sb.mean, after: sa.mean,
      delta: +d.toFixed(3), floor: f, significant: sig, ...pd,
      crushedBefore: sb.crushedPct, crushedAfter: sa.crushedPct,
      clipBefore: sb.clippedPct, clipAfter: sa.clippedPct,
      control: !!meta?.control, want: meta?.want ?? null });
    console.log(`${name.padEnd(18)} ${String(sb.mean).padStart(8)} -> ${String(sa.mean).padStart(8)} ` +
      `${(d >= 0 ? '+' : '') + d.toFixed(2).padStart(6)} ${String(f).padStart(7)} ` +
      `${String(pd.darkenedPct).padStart(9)} ${String(pd.meanDepthWhereDark).padStart(6)} ` +
      `${String(sb.crushedPct).padStart(6)}->${String(sa.crushedPct).padStart(6)} ` +
      `${String(sb.clippedPct).padStart(5)}->${String(sa.clippedPct).padStart(5)}` +
      (meta?.control ? '   [CONTROL]' : '') + (sig ? '' : '   (below floor)'));
  }
}
fs.writeFileSync(`docs/contact-diff-${A}-${B}.json`, JSON.stringify({ before: A, after: B, floor, rows }, null, 1));
console.log(`\nwrote docs/contact-diff-${A}-${B}.json`);
