// Clean captures for visual critique: no HUD, framed from the street, at two
// times of day. Every capture is paired with a scene-graph audit written next to
// it, because a critic's diagnosis is a hypothesis until it is audited.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { ARM_STATE, setArm, proveArmsDiffer } from './ground-albedo.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TIMES = (process.env.HERO_TIMES ?? 'dusk,night,noon').split(',');
const TAG = process.env.HERO_TAG ?? 'hero';
// HERO_ARMS=ground0,ground1 captures every framing and every hour under two
// UNIFORM states in one session instead of under two builds in two sessions.
// See tools/ground-albedo.mjs for what an arm is and why it exists.
const ARMS = (process.env.HERO_ARMS ?? '').split(',').map((a) => a.trim()).filter(Boolean);

// HERO_PORT exists because ensureServer() REUSES a server already listening on
// its port, and a worktree capture that does not override it silently
// photographs whichever tree owns 8123 - normally the main one. That is not a
// hypothetical: a before/after arm captured from a pre-round worktree came back
// identical to the after arm, because both had rendered the same tree. The same
// trap is already guarded in tools/smoke.mjs (SMOKE_PORT) and
// tools/junction-shot.mjs (JS_PORT); this tool was missing it.
const HERO_PORT = Number(process.env.HERO_PORT ?? 8123);
await ensureServer(HERO_PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${HERO_PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

// Hide the debug overlay: it is not part of what is being judged.
await page.addStyleTag({ content: '#attr{display:none!important}' });
// The HUD is hidden by DEFAULT. These frames exist to judge the rendered world,
// and a critic looking at a wanted meter and a speedometer is spending attention
// on the one part of the image that is not what the round is about. It used to be
// opt-in via HERO_HIDE_HUD=1, which meant the golden-hour captures went to review
// with the whole instrument cluster in them. HERO_SHOW_HUD=1 puts it back for the
// rounds that are actually about the HUD.
if (process.env.HERO_SHOW_HUD !== '1') {
  await page.addStyleTag({ content: '#hud,.pv-hud{display:none!important}' });
}
const HERO_TRAFFIC = Number(process.env.HERO_TRAFFIC ?? 0);
if (HERO_TRAFFIC > 0) {
  await page.evaluate((n) => __district.setTraffic(n), HERO_TRAFFIC);
  await page.waitForTimeout(6000);
}

// Stand in the carriageway on the Main Street corridor looking east toward
// Five Points, which is the district's hero view.
//
// THE CORRIDOR CAMERA WAS NOT ON THE CORRIDOR, and every visual round this
// project has run was judged partly on that frame. It interpolated waypoint 2
// (19, -6, "Main St @ Pineapple Ave") to waypoint 4 (569, -164, "Main St east")
// - a DIAGONAL across blocks - and then extrapolated 34 m backwards along it,
// landing the camera at about (-13.6, 3.9). An independent fidelity review
// measured it there: no Main Street edge within 45 m, nearest South Pineapple
// 33 m, McAnsh Square 21 m, and the street blade legible in the frame reads
// MC ANSH SQUARE.
//
// Main Street east is waypoint 3 to waypoint 4, constant z = -163.8 from x = 57
// to x = 569 - the same dead east-west leg tools/reproject-pano.mjs calibrates
// its panorama convention against. wpA: 2 was never that leg.
//
// The consequence was not cosmetic. A streetscape reviewer measured 0.097%
// foliage in this frame against 1.835% at fivepoints and concluded the corridor
// had no street trees; it has none because the oak profile is on Main Street east
// and the camera was two blocks off it. The trees, the placement rule and the
// canopy shadow were all fine.
//
// NOTE FOR ANYONE COMPARING OLD CAPTURES: every `*-corridor-*.png` committed
// before 2026-09-05 is the old, mis-sited framing and is NOT comparable with
// anything captured after it.
if (ARMS.length) {
  for (const a of ARMS) {
    if (!ARM_STATE[a]) { console.error(`unknown arm: ${a}`); await browser.close(); process.exit(2); }
  }
  const proof = await proveArmsDiffer(page, ARMS);
  console.log('arms:', JSON.stringify(proof.seen));
  if (!proof.ok) {
    console.error('ABORT: the arms resolve to the same uniforms; nothing would be measured.');
    await browser.close();
    process.exit(2);
  }
}

const shots = [
  // back is NEGATIVE here on purpose: it places the camera 55 m FORWARD of the
  // Five Points waypoint, at about x = 112 on the Main St east carriageway, which
  // is inside the oak run. src/streetfurniture.js records that the census put
  // nine of the district's twelve live oaks inside x 78..155, "a tree every 9 m
  // of street", so a corridor hero standing west of x = 78 photographs the
  // corridor's name rather than its trees. It also separates this camera from
  // the fivepoints one, which stands 26 m back from the same waypoint on the same
  // axis - at back = +34 the two were 8 m apart and were the same picture twice.
  { name: 'corridor', wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
];

const results = [];
for (const s of shots) {
  const placed = await page.evaluate((cfg) => {
    const r = __district.district.meta.route;
    const a = r[cfg.wpA], b = r[cfg.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;

    // Keep the camera OUT of the buildings.
    //
    // `back` extrapolates in a straight line from a route waypoint, and the route
    // bends: at back = 34 the corridor camera stood 3.7 m inside building 67's
    // footprint (an 8-point concave block). Walls are single-sided, so from in
    // there the block's own facades vanish and its awnings, cornice and parapet
    // are left hanging over the street with nothing under them. Three rounds of
    // blind critics reported that frame as floating props and an untethered
    // rooftop slab; it is the camera, not the geometry. A hero shot is a
    // measuring instrument, and one standing inside a wall manufactures exactly
    // the defect class it is being used to look for.
    const inRing = (ring, x, z) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    // Signed clearance to the nearest footprint: negative inside, metres outside.
    // Distance, not just in/out — a camera pressed flat against a wall is as
    // useless a hero frame as one buried in it.
    const segDist = (px, pz, x0, z0, x1, z1) => {
      const vx = x1 - x0, vz = z1 - z0;
      const l2 = vx * vx + vz * vz;
      const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0;
      return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t));
    };
    const clearance = (x, z) => {
      const [cx, cz] = __district.world.keyOf(x, z).split(',').map(Number);
      let best = Infinity, worst = -1;
      for (let ddz = -1; ddz <= 1; ddz++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const c = __district.district.chunks[`${cx + ddx},${cz + ddz}`];
          if (!c) continue;
          for (const bi of c.buildings) {
            const ring = __district.district.buildings[bi].p;
            let d = Infinity;
            for (let i = 0; i < ring.length; i++) {
              const A = ring[i], B = ring[(i + 1) % ring.length];
              d = Math.min(d, segDist(x, z, A[0], A[1], B[0], B[1]));
            }
            if (inRing(ring, x, z)) { worst = bi; d = -d; }
            if (d < best) { best = d; }
          }
        }
      }
      return { d: best === Infinity ? 99 : best, inside: worst };
    };
    const MIN_CLEAR = 3.0;                  // metres of pavement around the camera
    let back = cfg.back, px = 0, pz = 0, cl = { d: 99, inside: -1 };
    for (;;) {
      px = a.x - (dx / len) * back + nx * cfg.side;
      pz = a.z - (dz / len) * back + nz * cfg.side;
      cl = clearance(px, pz);
      if (cl.d >= MIN_CLEAR || back <= 8) break;
      back -= 1;
    }
    const hit = cl.inside;

    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam(
      [px, cfg.height, pz],
      [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd],
      cfg.fov
    );
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { back, requestedBack: cfg.back, x: +px.toFixed(1), z: +pz.toFixed(1),
      clearance: +cl.d.toFixed(1), stillInside: cl.d >= MIN_CLEAR ? -1 : hit };
  }, s);
  console.log(`${s.name}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ` +
    `${placed.clearance} m clear of the nearest footprint` +
    (placed.back !== placed.requestedBack ? ` (pulled in from ${placed.requestedBack})` : '') +
    (placed.stillInside >= 0 ? `  WARNING: still inside building ${placed.stillInside}` : ''));
  await page.waitForTimeout(14000);

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(15000);
    // One camera, one settled district, every arm. See tools/ground-albedo.mjs:
    // capturing a lighting A/B by editing the source between two runs only
    // measures that edit if nothing else in src/ moved in between, and in a tree
    // with three agents in it something usually did.
    for (const arm of (ARMS.length ? ARMS : [null])) {
      let applied = null;
      if (arm) {
        applied = await setArm(page, arm);
        // Rendered FRAMES after the uniforms were pushed, never milliseconds: on
        // the software rasteriser a short wait is sometimes less than one frame
        // and the screenshot then belongs to the previous arm.
        const f0 = await page.evaluate(() => __district.frames);
        await page.waitForFunction((f) => __district.frames > f + 4, f0, { timeout: 120000, polling: 100 });
      }
      const file = `${OUT}/${TAG}${arm ? `-${arm}` : ''}-${s.name}-${tod}.png`;
      await page.screenshot({ path: file, timeout: 180000 });
      const audit = await page.evaluate(() => {
        const a = __district.audit();
        const w = __district.worldReport();
        const r = __district.renderStats();
        let plain = 0, inst = 0, mats = new Set();
        __district.scene.traverse((o) => {
          if (o.isInstancedMesh) inst++; else if (o.isMesh) plain++;
          if (o.isMesh && o.material) mats.add(o.material.uuid);
        });
        return {
          ...a,
          drawCalls: r.calls, sceneCalls: r.sceneCalls, postPasses: r.postPasses, triangles: r.triangles,
          chunks: w.chunksLoaded, lodNear: w.lodNear, lodFar: w.lodFar,
          plainMeshes: plain, instancedMeshes: inst, distinctMaterialsInScene: mats.size,
          materialLibrary: w.materials,
          // HOW POPULATED IS THIS FRAME? The audit recorded lighting, draw state
          // and material counts and nothing at all about whether anyone was on the
          // street. So "the streets feel deserted" - a thing critics say about this
          // build, and a thing I said about m3base-fivepoints-golden after counting
          // zero pedestrians in it by eye - had no number behind it on either side:
          // nothing for a critic to point at, and nothing for a builder to show
          // they had fixed it. The engine has exposed all of this the whole time.
          //
          // IN FRUSTUM, not merely alive. A pedestrian pool of forty means nothing
          // if they are all behind the camera, and that distinction is the whole
          // question when the complaint is that a FRAME looks empty.
          population: (() => {
            const cam = __district.camera;
            if (!cam) return null;
            cam.updateMatrixWorld();
            // Raw matrix arithmetic rather than THREE.Frustum: main.js imports
            // three as a module, so THREE is NOT a browser global and naming it
            // in here throws ReferenceError at capture time - which would have
            // failed the whole audit, not just this field.
            //
            // three.js Matrix4.elements is COLUMN-major: element(row,col) is
            // elements[col*4+row]. M = projection * viewInverse.
            const P = cam.projectionMatrix.elements, V = cam.matrixWorldInverse.elements;
            const M = new Array(16).fill(0);
            for (let c = 0; c < 4; c++) {
              for (let r = 0; r < 4; r++) {
                let acc = 0;
                for (let k = 0; k < 4; k++) acc += P[k * 4 + r] * V[c * 4 + k];
                M[c * 4 + r] = acc;
              }
            }
            const inView = (p) => {
              const x = p.x, y = p.y ?? 1, z = p.z;
              const cx = M[0] * x + M[4] * y + M[8] * z + M[12];
              const cy = M[1] * x + M[5] * y + M[9] * z + M[13];
              const cz = M[2] * x + M[6] * y + M[10] * z + M[14];
              const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
              if (!(cw > 0)) return false;                       // behind the eye
              return Math.abs(cx) <= cw && Math.abs(cy) <= cw && Math.abs(cz) <= cw;
            };
            // Field names read off the sources, not guessed: traffic.report()
            // returns {fleet, alive, ...}, and furniture is an OBJECT on
            // __district whose report() returns {lamps, props, treeSpecies,
            // propCount, parked}. A first pass here invented `traf.cars` and
            // `fur.trees`, both of which would have written null forever while
            // looking like a measurement.
            // POSITIVE CONTROL. `pedsInFrustum: 0` is exactly what an always-false
            // inView() returns, and "the streets look empty" is precisely the
            // conclusion that would then be drawn from a broken test. So prove the
            // frustum test can say YES: the camera looks down its own -Z, and a
            // point 20 m along that direction is in view by construction. If this
            // is false the matrix arithmetic is wrong and every count below it is
            // meaningless - which is the whole reason it is recorded next to them
            // rather than asserted in a comment.
            const E = cam.matrixWorld.elements;
            const ahead = {
              x: E[12] - E[8] * 20, y: E[13] - E[9] * 20, z: E[14] - E[10] * 20,
            };
            const frustumWorks = inView(ahead);

            const peds = __district.pedestrianPositions?.() ?? [];
            const traf = __district.trafficReport?.() ?? null;
            const fur = __district.furniture?.report?.() ?? null;
            const trees = fur ? Object.values(fur.treeSpecies ?? {}).reduce((a, b) => a + b, 0) : null;
            return {
              pedsAlive: peds.length,
              pedsInFrustum: peds.filter(inView).length,
              trafficFleet: traf?.fleet ?? null,
              trafficAlive: traf?.alive ?? null,
              parkedFilled: fur?.parked?.filled ?? null,
              trees, treeSpecies: fur?.treeSpecies ?? null,
              propCount: fur?.propCount ?? null,
              frustumWorks,
            };
          })(),
        };
      });
      results.push({ shot: s.name, tod, arm, uniforms: applied, file, audit });
      const pop = audit.population;
      console.log(`${s.name}/${tod}${arm ? `/${arm}` : ''}: draw ${audit.drawCalls}, tris ${audit.triangles}, ` +
        `lights ${audit.lightCount}, lit lamps ${audit.litPointLights}, ` +
        `exposure ${audit.exposureAsStop}, implausible ${audit.implausible.length}` +
        (pop ? `, peds ${pop.pedsInFrustum}/${pop.pedsAlive} in frame, cars ${pop.trafficAlive}, `
          + `parked ${pop.parkedFilled}, trees ${pop.trees}, props ${pop.propCount}`
          + (pop.frustumWorks ? '' : '  FRUSTUM TEST BROKEN - in-frame counts are meaningless') : ''));
    }
  }
}
fs.writeFileSync(`docs/${TAG}-audits.json`, JSON.stringify({ results, errors }, null, 1));
console.log(`\nwrote docs/${TAG}-audits.json (${results.length} captures)`);
await browser.close();
