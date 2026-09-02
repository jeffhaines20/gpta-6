// Equirectangular -> rectilinear, so the 2024 Mapillary panoramas are usable as
// facade reference.
//
// WHY THIS EXISTS. The dense, current street-level coverage of the district is
// 360 spheres: 431 of the 670 images within reach of a corridor station, and
// every one of the newest ones. Raw, they are useless for judging a building -
// an equirectangular frame bends a straight cornice into a sine wave, so any
// proportion read off one is wrong. Reprojected they are BETTER than the flat
// frames, because a flat frame points wherever the car was going (down the road)
// and a sphere can be aimed at the shopfront.
//
//   node tools/reproject-pano.mjs --facades          # both street walls, every corridor pano
//   node tools/reproject-pano.mjs --id 985260603777247 --yaw 90 --fov 70
//   node tools/reproject-pano.mjs --calibrate        # the convention test - see below
//
// Yaw is a WORLD bearing in degrees: 0 north, 90 east, matching compass_angle
// and the district's own axes (north is -Z). Pitch is degrees above the horizon.
//
// Output goes to reference/sarasota/mapillary/views/, which is NOT tracked: these
// are derived from CC BY-SA source imagery and regenerable from the tool plus the
// index, so committing them would double the reference weight for nothing. The
// licence discipline is unchanged and applies to the derivatives too - they are
// reference, never source assets, and nothing is traced, sampled or colour-picked
// into a shipped texture (binding constraint 1).
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const IN = 'reference/sarasota/mapillary';
const OUT = path.join(IN, 'views');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const W = Number(arg('w', 1280));
const H = Number(arg('h', 960));
const FOV = Number(arg('fov', 75));
const PITCH = Number(arg('pitch', 12));   // facades are TALL and the camera is low

// --- the convention, and how it was settled ---------------------------------
//
// Mapillary reports `compass_angle` as the bearing the camera faced. What that
// says about the IMAGE is a separate question: an equirectangular frame has to
// put some bearing at its horizontal centre, and which one is a convention, not
// a fact derivable from the file. Assuming wrong yields views that are sharp,
// plausible, and pointing at the wrong building - the worst kind of wrong,
// because nothing about the output looks broken.
//
// So it is measured, not assumed. `--calibrate` renders one pano at world yaw
// 0/90/180/270 and prints where the tool believes each is looking; the pano
// picked for it stands on the Main St east leg, where the carriageway runs dead
// east-west (constant z = -163.9 between x = 57 and x = 569). Two of those four
// views must look down a street and two must face a wall. If that is what comes
// out, the convention holds; if the street appears at 0/180 instead of 90/270,
// PANO_CENTRE_IS_HEADING is wrong and this constant is where to fix it.
//
// RUN AND PASSED 2026-09-02 on mly-1414553883288835 at (331.2, -166.1). Yaw 90
// gave the carriageway receding east to a vanishing point with the double yellow
// centreline straight and First Methodist's steeple standing where it stands;
// yaw 180 gave a shopfront square-on with a level parapet. Both halves, so the
// test could have failed and did not. Straight edges coming out straight is also
// the check that the gnomonic remap itself is right - a sign error here bends
// them, visibly.
const PANO_CENTRE_IS_HEADING = true;

const index = JSON.parse(fs.readFileSync(path.join(IN, 'index.json'), 'utf8'));
const panos = index.images.filter((i) => i.isPano);
if (!panos.length) { console.error(`no panoramas in ${IN}/index.json`); process.exit(2); }

// The remap. Runs in the page because Chromium is what can decode a JPEG here,
// and the repo ships no image codec (binding constraint 6 - no new dependencies).
const REMAP = `(src, opt) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const sw = img.width, sh = img.height;
    const sc = document.createElement('canvas');
    sc.width = sw; sc.height = sh;
    const sx = sc.getContext('2d', { willReadFrequently: true });
    sx.drawImage(img, 0, 0);
    const S = sx.getImageData(0, 0, sw, sh).data;

    const dc = document.createElement('canvas');
    dc.width = opt.w; dc.height = opt.h;
    const dx = dc.getContext('2d');
    const D = dx.createImageData(opt.w, opt.h);

    const rad = Math.PI / 180;
    const yaw = opt.yaw * rad, pitch = opt.pitch * rad;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // +X east, +Y up, +Z north. Bearing is measured from +Z toward +X.
    const f = [sy * cp, sp, cy * cp];
    const r = [f[2], 0, -f[0]];
    const rl = Math.hypot(r[0], r[2]) || 1; r[0] /= rl; r[2] /= rl;
    const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];

    const th = Math.tan(opt.fov * rad / 2);
    const tv = th * opt.h / opt.w;
    // Where the image's horizontal centre points, as a world bearing.
    const centre = opt.centreBearing * rad;

    let p = 0;
    for (let j = 0; j < opt.h; j++) {
      const vy = (1 - 2 * (j + 0.5) / opt.h) * tv;
      for (let i = 0; i < opt.w; i++) {
        const vx = (2 * (i + 0.5) / opt.w - 1) * th;
        let X = f[0] + vx * r[0] + vy * u[0];
        let Y = f[1] + vx * r[1] + vy * u[1];
        let Z = f[2] + vx * r[2] + vy * u[2];
        const L = Math.hypot(X, Y, Z); X /= L; Y /= L; Z /= L;

        const bearing = Math.atan2(X, Z);          // world bearing of this ray
        const lat = Math.asin(Math.max(-1, Math.min(1, Y)));
        let uu = 0.5 + (bearing - centre) / (2 * Math.PI);
        uu -= Math.floor(uu);                       // wrap into [0,1)
        const vv = 0.5 - lat / Math.PI;

        // Bilinear, wrapping in u because the sphere is seamless there.
        const fx = uu * sw - 0.5, fy = Math.max(0, Math.min(sh - 1.001, vv * sh - 0.5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const ax = fx - x0, ay = fy - y0;
        const x0w = ((x0 % sw) + sw) % sw, x1w = ((x0 + 1) % sw + sw) % sw;
        const y0c = y0 < 0 ? 0 : y0, y1c = Math.min(sh - 1, y0 + 1);
        const i00 = (y0c * sw + x0w) * 4, i10 = (y0c * sw + x1w) * 4;
        const i01 = (y1c * sw + x0w) * 4, i11 = (y1c * sw + x1w) * 4;
        for (let c = 0; c < 3; c++) {
          const top = S[i00 + c] * (1 - ax) + S[i10 + c] * ax;
          const bot = S[i01 + c] * (1 - ax) + S[i11 + c] * ax;
          D.data[p + c] = top * (1 - ay) + bot * ay;
        }
        D.data[p + 3] = 255;
        p += 4;
      }
    }
    dx.putImageData(D, 0, 0);
    resolve(dc.toDataURL('image/png'));
  };
  img.onerror = () => resolve(null);
  img.src = src;
})`;

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
await page.goto('about:blank');
fs.mkdirSync(OUT, { recursive: true });

const render = async (pano, yaw, pitch, fov, tag) => {
  const buf = fs.readFileSync(path.join(IN, pano.file));
  const src = `data:image/jpeg;base64,${buf.toString('base64')}`;
  const centreBearing = PANO_CENTRE_IS_HEADING ? (pano.headingDeg ?? 0) : 0;
  const dataUrl = await page.evaluate(
    ([fn, s, o]) => eval(fn)(s, o),
    [REMAP, src, { w: W, h: H, yaw, pitch, fov, centreBearing }],
  );
  if (!dataUrl) { console.error(`  decode failed: ${pano.file}`); return null; }
  const name = `${pano.id}-${tag}.png`;
  fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  return name;
};

if (has('calibrate')) {
  // The east-west leg: constant z, so a view down the street and a view at a
  // wall are ninety degrees apart and cannot be confused for one another.
  const onMainEast = panos
    .filter((p) => Math.abs(p.z + 163.9) < 25 && p.x > 60)
    .sort((a, b) => a.x - b.x);
  const pick = onMainEast[Math.floor(onMainEast.length / 2)] || panos[0];
  console.log(`calibrating on ${pick.file}  (${pick.x}, ${pick.z})  heading ${pick.headingDeg}`);
  console.log('Main St east runs dead east-west here, so yaw 90 and 270 should look');
  console.log('DOWN THE STREET and yaw 0 and 180 should face a WALL.\n');
  for (const yaw of [0, 90, 180, 270]) {
    const n = await render(pick, yaw, 0, 90, `cal-${String(yaw).padStart(3, '0')}`);
    console.log(`  yaw ${String(yaw).padStart(3)}  ->  ${n}`);
  }
  console.log(`\nOpen them. If the street is at 0/180 rather than 90/270, flip`);
  console.log(`PANO_CENTRE_IS_HEADING in this file.`);
} else if (has('facades')) {
  // Aim at both street walls. The corridor bearing comes from the route leg the
  // station sat on, so "left wall" and "right wall" mean the same thing at every
  // station regardless of which way the capture vehicle happened to be pointing.
  const route = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route;
  const bearingAt = (x, z) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i], b = route[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) { bestD = d; best = (Math.atan2(dx, -dz) * 180) / Math.PI; }
    }
    return (best + 360) % 360;
  };
  let n = 0;
  for (const p of panos) {
    const b = bearingAt(p.x, p.z);
    for (const [side, off] of [['L', -90], ['R', 90]]) {
      const name = await render(p, (b + off + 360) % 360, PITCH, FOV, `${side}`);
      if (name) n++;
    }
    console.log(`  ${p.file}  (${p.x}, ${p.z})  corridor bearing ${b.toFixed(0)}  -> L,R`);
  }
  console.log(`\n${n} facade views in ${OUT}`);
} else {
  const id = arg('id', null);
  const pano = id ? panos.find((p) => p.id === id || p.file.includes(id)) : panos[0];
  if (!pano) { console.error(`no pano matching ${id}`); process.exit(2); }
  const yaw = Number(arg('yaw', pano.headingDeg ?? 0));
  const name = await render(pano, yaw, PITCH, FOV, `y${Math.round(yaw)}`);
  console.log(`${OUT}/${name}   from ${pano.file} at (${pano.x}, ${pano.z})`);
}

await browser.close();
