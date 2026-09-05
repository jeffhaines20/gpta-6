// The bench's before/after pair, measured on a FIXED PIXEL RECTANGLE instead of
// on the in-page sample plan.
//
// Why this exists. tools/ground-shade.mjs computes its sample points inside the
// page and keeps them there, so a run that dies before it writes its JSON leaves
// captures nobody can compare - and on a box at load 16 the after run's browser
// was closed by the OS three frames from the end. The frames survive, and they
// are comparable without the plan because the bench pins everything the plan
// depended on: the ped is TELEPORTED to a deterministic slot, posed at v = 1.35
// and phase 0.55 with hscale and build forced to 1.0, and the camera is placed
// by the same deterministic sweep. Same world point, same silhouette, same
// camera, same pixels - so one rectangle reads both arms.
//
// The rectangle is placed on the shadow's SHIN, well below the figure's own
// screen footprint, from the difference images the two runs produce
// (present minus absent). A control rectangle on open brick 4 m away must not
// move; if it does, something other than the subject changed between the arms
// and the reading is void.
//
//   node tools/ground-shade-rect.mjs
//   node tools/ground-shade-rect.mjs --selftest
import { readPNG } from './png.mjs';

// WHERE THE SHADOW ACTUALLY IS, found by profiling rather than by eye. At noon
// the sun is 75.6 degrees up, so a 1.7 m figure throws 0.44 m; at this bench the
// shadow direction projects almost exactly SCREEN-LEFT of the feet (the sun
// bearing dotted with screen-right is -0.997), and the first rectangle placed
// here from a difference image was on the figure's own dark trousers, not on its
// shadow. The vertical profile settles it: darkening runs 35-72% down to y = 445
// - the body - and collapses to 17.5% immediately below, which is an AO tail, not
// a shadow. The horizontal profile along the feet row finds the shadow plateau at
// x 744-812 and the figure's shoes at x 816-822.
const SHADOW = { x: 744, y: 420, w: 68, h: 33 };
// Open brick four metres away, outside even the 2.2 m AO radius.
const CONTROL = { x: 1010, y: 600, w: 110, h: 60 };

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

export function meanLum(img, r) {
  const { width, height, channels, data } = img;   // channels, NOT 4
  let s = 0, n = 0;
  for (let y = r.y; y < Math.min(height, r.y + r.h); y++) {
    for (let x = r.x; x < Math.min(width, r.x + r.w); x++) {
      s += lum(data, (y * width + x) * channels); n++;
    }
  }
  return n ? s / n : 0;
}

/** Darkening of `rect` caused by whatever differs between the two files. */
export function rectDarkening(onFile, offFile, rect = SHADOW) {
  const on = readPNG(onFile), off = readPNG(offFile);
  const a = meanLum(on, rect), b = meanLum(off, rect);
  return { on: +a.toFixed(2), off: +b.toFixed(2),
    darkPct: b > 0 ? +((1 - a / b) * 100).toFixed(2) : 0 };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/ground-shade-rect.mjs')) {
  if (process.argv.includes('--selftest')) {
    // KNOWN-BAD INPUT: the same file against itself must read 0.00%, and a file
    // against a copy of itself darkened by a known factor must read that factor.
    const f = 'docs/shots/_gs-before-noon-all.png';
    const same = rectDarkening(f, f);
    const img = readPNG(f);
    // Synthesise the "off" arm by scaling the rectangle up by 1/0.6, which is
    // what a 40% darkening looks like from the other side.
    const { writePNG } = await import('./crop.mjs');
    const rgb = Buffer.alloc(img.width * img.height * 3);
    for (let i = 0, j = 0; i < img.width * img.height; i++) {
      const s = i * img.channels;
      rgb[j++] = img.data[s]; rgb[j++] = img.data[s + 1]; rgb[j++] = img.data[s + 2];
    }
    for (let y = SHADOW.y; y < SHADOW.y + SHADOW.h; y++) {
      for (let x = SHADOW.x; x < SHADOW.x + SHADOW.w; x++) {
        const o = (y * img.width + x) * 3;
        for (let c = 0; c < 3; c++) rgb[o + c] = Math.min(255, Math.round(rgb[o + c] / 0.6));
      }
    }
    writePNG('docs/shots/_gsrect-selftest.png', img.width, img.height, rgb);
    const scaled = rectDarkening(f, 'docs/shots/_gsrect-selftest.png');
    console.log('selftest identical files      :', JSON.stringify(same));
    console.log('selftest 40% synthetic darkening:', JSON.stringify(scaled));
    const ok = Math.abs(same.darkPct) < 0.01 && Math.abs(scaled.darkPct - 40) < 2.5;
    console.log(ok ? 'SELFTEST PASSED' : 'SELFTEST FAILED');
    process.exit(ok ? 0 : 3);
  }

  const B = 'docs/shots/_gs-before-noon-';
  const A = 'docs/shots/_gs-after-noon-';
  const rows = [
    ['BEFORE  blob + body', `${B}all.png`, `${B}noped.png`],
    ['BEFORE  body only  ', `${B}noblob.png`, `${B}noblob-noped.png`],
    ['AFTER   body only  ', `${A}all.png`, `${A}noped.png`],
    ['AFTER   body only  ', `${A}noblob.png`, `${A}noped.png`],
  ];
  console.log(`shadow rect ${JSON.stringify(SHADOW)}   control rect ${JSON.stringify(CONTROL)}\n`);
  for (const [name, on, off] of rows) {
    try {
      const s = rectDarkening(on, off, SHADOW);
      const c = rectDarkening(on, off, CONTROL);
      console.log(`${name}  shadow ${String(s.darkPct).padStart(6)}%  (${s.off} -> ${s.on})` +
        `   control ${String(c.darkPct).padStart(6)}%  (${c.off} -> ${c.on})`);
    } catch (e) {
      console.log(`${name}  -- ${e.message}`);
    }
  }
  // THE EDGE, which is the half of the reviewers' complaint the depth number
  // cannot answer: "no edge and no direction". A horizontal cut across the
  // shadow's shin, printed so the transition can be counted rather than argued.
  const cut = (file, y) => {
    const img = readPNG(file);
    const out = [];
    for (let x = 690; x <= 860; x += 6) out.push(Math.round(meanLum(img, { x, y, w: 2, h: 24 })));
    return out;
  };
  console.log('\nhorizontal cut along the feet row, y = 424..448, x = 690..860 step 6');
  for (const [name, f] of [['BEFORE all   ', `${B}all.png`], ['BEFORE noblob', `${B}noblob.png`],
    ['BEFORE noped ', `${B}noped.png`], ['AFTER  all   ', `${A}all.png`],
    ['AFTER  noped ', `${A}noped.png`]]) {
    try { console.log(`${name}  ${cut(f, 424).join(' ')}`); } catch (e) { console.log(`${name} -- ${e.message}`); }
  }

  // Noise: the same frame captured twice, through the same rectangle.
  for (const [name, a, b] of [['BEFORE noise', `${B}all.png`, `${B}noise.png`],
    ['AFTER  noise', `${A}all.png`, `${A}noise.png`]]) {
    try {
      const s = rectDarkening(a, b, SHADOW);
      console.log(`${name}  shadow ${s.darkPct}%`);
    } catch (e) { console.log(`${name} -- ${e.message}`); }
  }
}
