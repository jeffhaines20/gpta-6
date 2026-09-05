// WHAT DOES THE SECOND HemisphereLight COST?
//
// src/daynight.js added a 'district-bounce' HemisphereLight beside the sky's, so
// the scene's light census goes 12 -> 13 and NUM_HEMI_LIGHTS goes 1 -> 2. A
// hemisphere light is cheap, and "cheap" is exactly the kind of thing this
// session has been wrong about twice by asserting it instead of measuring it.
// Three questions, each with a number:
//
//   1. Does it add DRAW CALLS? It must not - it is a light, not a mesh.
//   2. Does it add SHADER PROGRAMS? NUM_HEMI_LIGHTS is part of three.js's program
//      cache key, so flipping it recompiles every material - but the COUNT of
//      distinct programs should not move, because every material moves together.
//   3. Does it move the uniform budget anywhere near a limit? A hemisphere light
//      is 3 vec3 (direction, skyColor, groundColor) in the fragment stage.
//
// The arm is `bounce.visible = false`, which is how three.js drops a light from
// the list: WebGLLights.setup() skips invisible lights, so NUM_HEMI_LIGHTS goes
// back to 1 and every program is rebuilt. POSITIVE CONTROL: the run asserts that
// the arm actually changed NUM_HEMI_LIGHTS, because "nothing moved" is also what
// an arm that did nothing reports.
//
//   BC_PORT=8132 node tools/bounce-cost.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const PORT = Number(process.env.BC_PORT ?? 8132);
if (PORT === 8123) throw new Error('BC_PORT 8123 belongs to the main tree; pick another');
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); __district.setTimeOfDay('noon'); });
await page.waitForTimeout(12000);

const read = async (label) => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 6, f0, { timeout: 120000, polling: 100 });
  return {
    label,
    ...(await page.evaluate(() => {
      const r = __district.renderer;
      const gl = r.getContext();
      let hemi = 0, dir = 0, point = 0;
      __district.scene.traverse((o) => {
        if (!o.isLight || o.visible === false) return;
        if (o.isHemisphereLight) hemi++;
        else if (o.isDirectionalLight) dir++;
        else if (o.isPointLight && o.intensity > 0) point++;
      });
      return {
        // The engine's own counters, not a stopwatch: this box has four builders
        // rendering on it and any wall-clock number would be noise.
        drawCalls: __district.post.stats.totalCalls,
        sceneCalls: __district.post.stats.drawCalls,
        triangles: __district.post.stats.sceneTriangles,
        // TWO NUMBERS, because the first one lies on an A/B. r.info.programs is
        // a CACHE: flipping NUM_HEMI_LIGHTS re-keys every material, and the old
        // entries stay in it until their materials are disposed, so `length`
        // grows on the arm by the number of materials re-keyed even though
        // nothing extra is being used. usedTimes is three.js's own reference
        // count, so filtering on it gives the programs actually bound.
        programs: r.info.programs.length,
        programsInUse: r.info.programs.filter((pr) => pr.usedTimes > 0).length,
        hemiVisible: hemi, dirVisible: dir, pointLit: point,
        maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
      };
    })),
  };
};

// --single: one cold-load reading and no arm. THE IN-SESSION A/B CANNOT ANSWER
// THE PERMUTATION QUESTION and this is why: r.info.programs is a cache keyed on
// NUM_HEMI_LIGHTS among other things, so toggling the light re-keys every
// material and the old entries stay resident with usedTimes still positive. Both
// `length` and the usedTimes filter therefore grow by the number of material
// configurations re-keyed, whichever direction the arm runs. The only clean
// comparison is two COLD LOADS of two builds, which is what --single is for:
// run it here, restore the previous src/, run it again, compare.
const SINGLE = process.argv.includes('--single');
if (SINGLE) {
  const one = await read('cold load');
  console.log(JSON.stringify({ single: one, errors }, null, 1));
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(process.env.BC_OUT ?? 'docs/bounce-cost-single.json', JSON.stringify({ single: one, errors }, null, 1));
  await browser.close();
  process.exit(0);
}

const before = await read('bounce on');
await page.evaluate(() => {
  const b = __district.tod.bounce;
  b.visible = false;
  // follow() rewrites intensity every frame; visible is what actually drops it
  // from WebGLLights, so this arm survives the frame loop.
});
const after = await read('bounce off (visible = false)');

const out = { before, after, errors,
  drawCallDelta: before.drawCalls - after.drawCalls,
  programDelta: before.programs - after.programs,
  programsInUseDelta: before.programsInUse - after.programsInUse,
  hemiDelta: before.hemiVisible - after.hemiVisible };
console.log(JSON.stringify(out, null, 1));
const armReal = out.hemiDelta === 1;
const noDraws = out.drawCallDelta === 0;
const noPrograms = out.programsInUseDelta === 0;
console.log(armReal ? 'POSITIVE CONTROL: the arm moved the visible hemisphere count 2 -> 1.'
  : 'POSITIVE CONTROL FAILED: the arm did not change the hemisphere count, so nothing below means anything.');
console.log(noDraws ? `DRAW CALLS: unchanged at ${before.drawCalls}.` : `DRAW CALLS MOVED by ${out.drawCallDelta}`);
console.log(noPrograms
  ? `SHADER PROGRAMS IN USE: unchanged at ${before.programsInUse}. Cache size ${before.programs} -> ${after.programs}, which is the re-keying, not a cost.`
  : `PROGRAMS IN USE MOVED by ${out.programsInUseDelta}`);
console.log(`Fragment uniform vectors available: ${before.maxFragmentUniformVectors}. ` +
  'A HemisphereLight costs 3 vec3 in the fragment stage.');
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/bounce-cost.json', JSON.stringify(out, null, 1));
await browser.close();
process.exit(armReal && noDraws && noPrograms ? 0 : 1);
