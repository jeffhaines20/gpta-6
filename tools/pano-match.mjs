// Park the engine camera where a Mapillary panorama stood, aim it the same way,
// and capture. The photograph and the frame then differ only in what we built.
//
// This is what the reference fetch was for. Every image in
// reference/sarasota/mapillary/index.json carries the district's own local metres
// (the fetch reprojects through the bake's projection), so "the same place" is a
// coordinate, not a judgement. Without that, comparing a photograph to a render
// means eyeballing two different streets and arguing about vibes.
//
//   node tools/pano-match.mjs                        # every corridor pano, both walls
//   node tools/pano-match.mjs --id 1414553883288835  # one
//   PM_TIME=golden node tools/pano-match.mjs
//
// The camera settings deliberately mirror tools/reproject-pano.mjs: 2.5 m eye
// height (a roof-mounted capture rig), 12 degrees of up-pitch, 75 degrees
// horizontal on a 4:3 frame. Three.js takes a VERTICAL fov, so 75 h at 4:3 is
// 2*atan(tan(37.5)*0.75) = 59.9. Getting that wrong would make every building
// look the wrong size and the error would read as a massing fault.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';
import path from 'node:path';

const IN = 'reference/sarasota/mapillary';
const OUT = 'docs/shots/pano-match';
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const EYE = Number(process.env.PM_EYE ?? 2.5);
const PITCH = Number(process.env.PM_PITCH ?? 12);
const HFOV = 75, ASPECT = 4 / 3;
const VFOV = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / ASPECT) * 180) / Math.PI;
const TIME = process.env.PM_TIME ?? 'noon';
const W = 1280, H = 960;

const index = JSON.parse(fs.readFileSync(path.join(IN, 'index.json'), 'utf8'));
const route = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route;
const only = arg('id', null);
const panos = index.images
  .filter((i) => i.isPano && (!only || i.id === only || i.file.includes(only)))
  .sort((a, b) => a.x - b.x);
if (!panos.length) { console.error('no panoramas selected'); process.exit(2); }

// Same corridor bearing the reprojection used, so "L" here is "L" there.
const bearingAt = (x, z) => {
  // Only the first five waypoints: marina -> Five Points -> Main St east is the
  // hero corridor (binding constraint 2). The rest of the route loops back on
  // 2nd Street and would capture the nearest leg of the wrong street.
  let best = 0, bestD = Infinity;
  for (let i = 0; i + 1 < 5; i++) {
    const a = route[i], b = route[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < bestD) { bestD = d; best = (Math.atan2(dx, -dz) * 180) / Math.PI; }
  }
  return (best + 360) % 360;
};

fs.mkdirSync(OUT, { recursive: true });
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TIME);

const rows = [];
for (const p of panos) {
  const b = bearingAt(p.x, p.z);
  for (const [side, off] of [['L', -90], ['R', 90]]) {
    const yaw = ((b + off) % 360 + 360) % 360;
    const rad = (yaw * Math.PI) / 180;
    const D = 60;
    // Bearing 0 is north and north is -Z, so a bearing yaw points (sin, -cos).
    const tx = p.x + Math.sin(rad) * D;
    const tz = p.z - Math.cos(rad) * D;
    const ty = EYE + D * Math.tan((PITCH * Math.PI) / 180);

    const info = await page.evaluate(([x, z, ex, cam]) => {
      __district.placeAt(x, z);
      __district.setAutopilot(() => {});
      __district.freeCam([x, ex, z], [cam.tx, cam.ty, cam.tz], cam.fov);
      return { ok: true };
    }, [p.x, p.z, EYE, { tx, ty, tz, fov: VFOV }]);
    // The district streams; a fixed short wait measures a half-built block, which
    // is the sampling failure this ledger has paid for four times.
    await page.waitForFunction(
      () => __district.world?.pending === 0 || __district.frames > 0,
      null, { timeout: 30000 },
    ).catch(() => {});
    await page.waitForTimeout(Number(process.env.PM_SETTLE ?? 9000));

    const name = `${p.id}-${side}-${TIME}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    rows.push({ id: p.id, side, x: p.x, z: p.z, yaw: +yaw.toFixed(1), file: name, ok: info.ok });
    console.log(`  ${name}   at (${p.x}, ${p.z}) bearing ${yaw.toFixed(0)}`);
  }
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  time: TIME, eye: EYE, pitchDeg: PITCH, hfovDeg: HFOV, vfovDeg: +VFOV.toFixed(2),
  note: 'Each frame is the engine standing where the like-named Mapillary pano stood. '
      + 'Compare against reference/sarasota/mapillary/views/<id>-<side>.png.',
  pageErrors: errors, frames: rows,
}, null, 1));
console.log(`\n${rows.length} frames in ${OUT}${errors.length ? `  (${errors.length} page errors)` : ''}`);
await browser.close();
