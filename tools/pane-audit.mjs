// Pane audit: classify every screen pixel by the material it came from, then
// measure the frame the critics actually see inside the glazing only.
//
// Classification is a render, not a raycast: facade/trim meshes are temporarily
// swapped for an unlit basic material sampling their packed roughness/metalness
// map and drawn into an offscreen linear target, so a readback gives the exact
// (ao, roughness, metalness) texel behind every pixel with no ray budget at all.
// A second pass does the same with the emissive map (lit vs unlit), a third
// tags each mesh with a unique id colour, and a handful of real raycasts read
// the albedo texels back for the F0 table.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/tmp/claude-0/-home-user-gpta-6/e685c1d8-3ea2-5d09-9506-7019c96af5cb/scratchpad';
const TAG = process.env.PA_TAG ?? 'pa';
const TIMES = (process.env.PA_TIMES ?? 'dusk,night').split(',');
const SHOTS = (process.env.PA_SHOTS ?? 'corridor,fivepoints').split(',');
const OUT = path.join(DIR, 'audit');
fs.mkdirSync(OUT, { recursive: true });

// Reuse hero-shots' camera placement verbatim so the frames are the same frames.
const heroSrc = fs.readFileSync('/home/user/gpta-6/tools/hero-shots.mjs', 'utf8');
const fnStart = heroSrc.indexOf('(cfg) => {', heroSrc.indexOf('const placed = await page.evaluate('));
const fnEnd = heroSrc.indexOf('\n  }, s);', fnStart);
const PLACE_FN = heroSrc.slice(fnStart, fnEnd + 4);
if (!PLACE_FN.endsWith('}')) throw new Error('could not extract hero placement fn');

const ALL_SHOTS = {
  corridor: { name: 'corridor', wpA: 2, wpB: 4, back: 34, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  fivepoints: { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
};

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr{display:none!important}' });
await page.evaluate(() => __district.setHudEnabled(false));
// Freeze the scene's moving parts. A pedestrian walking across a facade splits a
// pane into two connected components and takes a bite out of the sample, so a
// pane count that wobbles run to run is the crowd, not the material.
await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });

await page.addStyleTag({ content: '#hud,.pv-hud{display:none!important}' });

// The classification passes, installed once.
await page.evaluate(async () => {
  const THREE = await import('/vendor/three.module.min.js');
  window.__T = THREE;
  window.__scan = (mode) => {
    const d = __district, r = d.renderer, sc = d.scene, cam = d.camera;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const W = size.x, H = size.y;
    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType });
    const saved = [];
    const meshes = [];
    sc.traverse((o) => { if (o.isMesh && o.visible && o.material && !Array.isArray(o.material)) meshes.push(o); });

    const idOf = new Map();
    const swap = (o) => {
      const m = o.material;
      const name = m.name || '';
      let mat;
      if (mode === 'id') {
        let id = idOf.get(name);
        if (id === undefined) { id = idOf.size + 1; idOf.set(name, id); }
        mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(id / 255, 0, 0) });
        mat.toneMapped = false;
      } else {
        const tex = mode === 'rm' ? m.roughnessMap : (mode === 'em' ? m.emissiveMap : m.map);
        if (!tex) { mat = new THREE.MeshBasicMaterial({ color: 0x000000 }); mat.toneMapped = false; }
        else {
          mat = new THREE.MeshBasicMaterial({ map: tex });
          mat.toneMapped = false;
        }
      }
      mat.side = m.side; mat.fog = false;
      saved.push([o, m]);
      o.material = mat;
    };
    // sRGB textures decode in the shader; force raw bytes out for the readback.
    const csSaved = [];
    for (const o of meshes) {
      const t = mode === 'rm' ? o.material.roughnessMap : (mode === 'em' ? o.material.emissiveMap : o.material.map);
      if (t && t.colorSpace && t.colorSpace !== THREE.NoColorSpace) {
        csSaved.push([t, t.colorSpace]); t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
      }
      swap(o);
    }
    const oldTone = r.toneMapping, oldCS = r.outputColorSpace;
    const oldClear = r.getClearColor(new THREE.Color()).getHex(), oldAlpha = r.getClearAlpha();
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 1);

    r.clear();
    r.render(sc, cam);
    const buf = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    r.setRenderTarget(null);
    r.toneMapping = oldTone; r.outputColorSpace = oldCS;
    r.setClearColor(oldClear, oldAlpha);

    for (const [o, m] of saved) { o.material.dispose(); o.material = m; }
    for (const [t, cs] of csSaved) { t.colorSpace = cs; t.needsUpdate = true; }
    rt.dispose();
    // Readback is bottom-up; hand back top-down to match the screenshot.
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      out.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    }
    return { w: W, h: H, ids: [...idOf], data: Array.from(out) };
  };

  // A few real rays, to read the source texels behind chosen pixels.
  window.__rays = (pts) => {
    const rc = new THREE.Raycaster();
    const cam = __district.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const ctxOf = new Map();
    const texel = (tex, u, v) => {
      if (!tex || !tex.image) return null;
      const img = tex.image;
      if (!img.width) return null;
      let c = ctxOf.get(img);
      if (!c) {
        // Canvas-backed textures hand back their own 2d context; anything else
        // (ImageBitmap, <img>, a DataTexture's typed array) is blitted first.
        if (typeof img.getContext === 'function') c = img.getContext('2d');
        else if (img.data) {
          const cv = document.createElement('canvas');
          cv.width = img.width; cv.height = img.height;
          const cc = cv.getContext('2d');
          const id = cc.createImageData(img.width, img.height);
          id.data.set(img.data.subarray ? img.data.subarray(0, id.data.length) : img.data);
          cc.putImageData(id, 0, 0);
          c = cc;
        } else {
          const cv = document.createElement('canvas');
          cv.width = img.width; cv.height = img.height;
          const cc = cv.getContext('2d');
          try { cc.drawImage(img, 0, 0); } catch { return null; }
          c = cc;
        }
        ctxOf.set(img, c);
      }

      let uu = u * tex.repeat.x + tex.offset.x, vv = v * tex.repeat.y + tex.offset.y;
      uu -= Math.floor(uu); vv -= Math.floor(vv);
      const px = Math.min(img.width - 1, Math.max(0, Math.floor(uu * img.width)));
      const fy = tex.flipY ? 1 - vv : vv;
      const py = Math.min(img.height - 1, Math.max(0, Math.floor(fy * img.height)));

      const d = c.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };
    const out = [];
    for (const [px, py] of pts) {
      rc.setFromCamera(new THREE.Vector2((px / W) * 2 - 1, -(py / H) * 2 + 1), cam);
      const hits = rc.intersectObject(__district.scene, true);
      let hit = null;
      for (const h of hits) { if (h.object.visible && h.object.material && h.uv) { hit = h; break; } }
      if (!hit) { out.push({ px, py, miss: true }); continue; }
      const m = hit.object.material;
      out.push({
        px, py, mat: m.name || '(unnamed)', dist: +hit.distance.toFixed(2),
        uv: [+hit.uv.x.toFixed(3), +hit.uv.y.toFixed(3)],
        albedo: texel(m.map, hit.uv.x, hit.uv.y),
        rm: texel(m.roughnessMap, hit.uv.x, hit.uv.y),
        em: texel(m.emissiveMap, hit.uv.x, hit.uv.y),
        emI: m.emissiveIntensity,
      });
    }
    return out;
  };
});

const results = {};
for (const sname of SHOTS) {
  const s = ALL_SHOTS[sname];
  const placed = await page.evaluate(`(${PLACE_FN})(${JSON.stringify(s)})`);
  console.log(`${s.name}: camera (${placed.x}, ${placed.z}) back ${placed.back} clear ${placed.clearance}`);
  await page.waitForTimeout(14000);
  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(15000);
    const file = path.join(OUT, `${TAG}-${s.name}-${tod}.png`);
    await page.screenshot({ path: file, timeout: 180000 });
    const scans = {};
    for (const mode of ['rm', 'em', 'id']) {
      const r = await page.evaluate((m) => __scan(m), mode);
      scans[mode] = r;
    }
    const base = path.join(OUT, `${TAG}-${s.name}-${tod}`);
    for (const mode of ['rm', 'em', 'id']) {
      fs.writeFileSync(`${base}.${mode}.bin`, Buffer.from(scans[mode].data));
    }
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
      w: scans.rm.w, h: scans.rm.h, ids: scans.id.ids, placed,
    }, null, 1));
    // Sample rays at pixels the rm pass called glass.
    const { w, h } = scans.rm;
    const rm = scans.rm.data;
    const cand = [];
    for (let y = 40; y < h - 40; y += 7) {
      for (let x = 40; x < w - 40; x += 7) {
        const i = (y * w + x) * 4;
        if (rm[i + 1] < 90 && rm[i + 2] > 100) cand.push([x, y]);
      }
    }
    const step = Math.max(1, Math.floor(cand.length / 48));
    const pts = cand.filter((_, i) => i % step === 0).slice(0, 48);
    const rays = pts.length ? await page.evaluate((p) => __rays(p), pts) : [];
    fs.writeFileSync(`${base}.rays.json`, JSON.stringify(rays, null, 1));
    console.log(`  ${tod}: ${file} (${w}x${h}), ${cand.length} glass candidates, ${rays.length} rays`);
    results[`${s.name}/${tod}`] = { file, base, glassCandidates: cand.length };
  }
}
fs.writeFileSync(path.join(OUT, `${TAG}-index.json`), JSON.stringify({ results, errors }, null, 1));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
