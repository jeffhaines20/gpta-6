// Clean captures for visual critique: no HUD, framed from the street, at two
// times of day. Every capture is paired with a scene-graph audit written next to
// it, because a critic's diagnosis is a hypothesis until it is audited.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { ARM_STATE, setArm, proveArmsDiffer } from './ground-albedo.mjs';
// The framings, their placement and the frame/streamer settle live in hero-cams.mjs so a probe can
// stand at exactly these cameras without copying them; see that file.
import { HERO_FRAMINGS, FRAME_SETTLE, settleFrames, placeHeroCam } from './hero-cams.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TIMES = (process.env.HERO_TIMES ?? 'dusk,night,noon').split(',');
const TAG = process.env.HERO_TAG ?? 'hero';
// Frames this run could not capture. Printed at the end so a short arm is
// visibly a short arm rather than something a reader has to count to notice.
const shotErrors = [];
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
// HERO_QUERY passes a query string to the page, so an A/B whose arms are a
// build-time option can be captured from ONE build on ONE port. Today that is
// `nofrontage=1` (see district/main.js); anything the page reads off its own
// search string works.
const HERO_QUERY = process.env.HERO_QUERY ? `?${process.env.HERO_QUERY}` : '';
await page.goto(`http://127.0.0.1:${HERO_PORT}/district/${HERO_QUERY}`, { waitUntil: 'networkidle' });
// HERO_BOOT, matching LOT_BOOT / DRIVE_BOOT / TB_BOOT. Five rendered frames
// through SwiftShader take well over 60 s when other agents' headless browsers
// are alive on the same box; this timed out three times in one session and each
// time threw away a capture that was working.
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.HERO_BOOT ?? 60000) });

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


// FREEZE THE CLOUD DECK BEFORE ANY ARM IS SHOT, unless HERO_CLOUDS=live.
//
// This tool's whole purpose is that every arm comes off ONE page load, ONE camera and
// ONE settled district - and the sky was the one thing still moving. sky.js advected
// the deck off performance.now() under a comment saying a capture 20 s later is the
// same sky; headless capture is MINUTES per frame. All three blind reviewers in the
// closing car round independently measured the sky as a large fraction of the pair
// and none could tell from the PNGs whether it was a second shipped term. A scrambled
// capture order settled it: sky difference correlates r = 0.9674 with capture
// separation and r = 0.0295 with the value of the term being swept.
//
// So every arm pair this tool has ever produced carried a sky offset proportional to
// how far apart its arms were shot. One frozen deck serves them all.
if (process.env.HERO_CLOUDS !== 'live') {
  const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds() : null));
  console.log(`cloud deck: ${froze ? `frozen at ${froze.atSeconds}s` : 'NOT FROZEN - no hook in this tree'}`);
}

const HERO_TRAFFIC = Number(process.env.HERO_TRAFFIC ?? 0);
if (HERO_TRAFFIC > 0) {
  await page.evaluate((n) => __district.setTraffic(n), HERO_TRAFFIC);
  await settleFrames(page, FRAME_SETTLE, 'traffic spawn');
}

// HERO_PEDS, and the reason it exists is the reason HERO_TRAFFIC is not enough.
//
// src/traffic.js calls Math.random() ten times and src/pedestrians.js thirteen,
// all unseeded, for spawn edge, direction, position along the edge, speed, limit
// and paint. So two page loads of the SAME BUILD carry different cars in
// different places with different colours, and different people walking. Frame
// settling fixes when the simulation is; it cannot fix what is in it.
//
// That makes a source-level A/B unregisterable while either population is alive,
// and it is not a small effect: two arms of one unchanged build at the SAME
// frame number (101 and 101) differed on 5.01% of pixels at noon, 27,745 of them
// BRIGHTER in the arm that had strictly less emissive in it.
//
// Setting both to 0 leaves the district, the props and the PARKED cars, which
// are placed from a position hash and are deterministic. That is a registered
// pair, and it is the only way to attribute a small change to its cause here.
const HERO_PEDS = process.env.HERO_PEDS;
if (HERO_PEDS !== undefined) {
  await page.evaluate((n) => __district.setPedestrians(n), Number(HERO_PEDS));
  await settleFrames(page, FRAME_SETTLE, `pedestrians ${HERO_PEDS}`);
}

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

const shots = HERO_FRAMINGS;

// HERO_SHOTS picks which framings to run, comma-separated. Capture here is well
// under 1 fps through SwiftShader and this container has repeatedly been
// restarted mid-run, losing an eight-frame arm each time; being able to ask for
// one camera turns a lost round into a lost frame.
const ONLY = (process.env.HERO_SHOTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const chosen = ONLY.length ? shots.filter((s) => ONLY.includes(s.name)) : shots;
if (ONLY.length && chosen.length !== ONLY.length) {
  // A typo here would silently capture nothing and read as a completed run.
  throw new Error(`HERO_SHOTS names no such framing: ${ONLY.filter((n) => !shots.some((s) => s.name === n)).join(', ')}` +
    `  (have: ${shots.map((s) => s.name).join(', ')})`);
}

const results = [];
for (const s of chosen) {
  const placed = await placeHeroCam(page, s);
  console.log(`${s.name}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ` +
    `${placed.clearance} m clear of the nearest footprint` +
    (placed.back !== placed.requestedBack ? ` (pulled in from ${placed.requestedBack})` : '') +
    (placed.stillInside >= 0 ? `  WARNING: still inside building ${placed.stillInside}` : ''));
  await settleFrames(page, FRAME_SETTLE, `camera ${s.name}`);

  for (const tod of TIMES) {
    // HERO_AO=radius/intensity/strength overrides the SSAO parameters for the
    // whole capture, so a before/after on a post-pass number can be shot in ONE
    // session off ONE build. The same argument as HERO_ARMS: capturing a
    // lighting A/B by editing src/ between two runs only measures that edit if
    // nothing else in the tree moved in between, and in a tree with three
    // agents in it something usually did. Unset, nothing is touched and the
    // build's own defaults stand.
    if (process.env.HERO_AO) {
      const [r, i, st] = process.env.HERO_AO.split('/').map(Number);
      const got = await page.evaluate((v) => {
        const q = __district.postParams();
        q.aoRadius = v.r; q.aoIntensity = v.i; q.aoStrength = v.s; q.aoEnabled = true;
        return { r: q.aoRadius, i: q.aoIntensity, s: q.aoStrength };
      }, { r, i, s: st });
      console.log(`  HERO_AO applied: radius ${got.r} intensity ${got.i} strength ${got.s}`);
    }
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await settleFrames(page, FRAME_SETTLE, `tod ${tod}`);
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
      // BOUNDED **AND** NON-FATAL. The 180 s bound has been here for a while;
      // the catch had not, and the catch is the half that matters in a loop.
      //
      // A screenshot that times out threw straight out of the framing/tod loop,
      // so ONE slow frame destroyed every frame after it. That is what it did:
      // an eight-frame arm came back with six, missing both fivepoints night-side
      // captures, and the arm looked like a completed run with a short list
      // rather than like a crash. Its pair partner would have lost the same two,
      // so the loss is invisible in a pair set — six pairs, all consistent,
      // nothing to notice.
      //
      // tools/drive-through.mjs already carries both halves and its comment even
      // says "tools/hero-shots.mjs and tools/lot-shots.mjs already use 180 s for
      // the same reason" — true of the timeout, false of the catch. One round
      // fixed one half here and both halves there, leaving the trap armed in
      // three other tools. See CLAUDE.md on patching one tool and leaving the
      // rest.
      try {
        await page.screenshot({ path: file, timeout: 180000 });
      } catch (e) {
        shotErrors.push(`${file}: ${e.message.split('\n')[0]}`);
        console.log(`  SCREENSHOT FAILED (continuing): ${file}`);
      }
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
          // The simulation step this frame belongs to. Two arms of an A/B that
          // do not share it are not registered, and every absolute comparison
          // between them is measuring the world moving as well as the diff.
          frames: __district.frames,
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
              // MOVING CARS ACTUALLY IN VIEW, and the reason this field exists is
              // a review round that went wrong without it. Three blind reviewers
              // judged the fleet's lamp spill from six frames and one of them
              // wrote "there is no moving traffic visible in any of the six
              // frames" - correctly. The audits said trafficAlive 30 at both
              // hours, so nobody checked. Thirty cars alive somewhere in the
              // district is not thirty cars in the picture, which is the same
              // distinction pedsInFrustum was added for and which was never
              // carried across to traffic. Patch one, leave its siblings.
              trafficInFrustum: __district.trafficPositions
                ? __district.trafficPositions().filter(inView).length : null,
              // THE FLEET'S LAMP SPILL, which traffic.report() has exposed all
              // along and no capture has ever written down. `used` is how many
              // cars are casting a puddle on the road this frame and `edgeM` how
              // far the furthest of them is; `visible` is false by day. A round
              // that concludes "the lamps light nothing" needs to be able to say
              // whether any lamp was in frame to light anything with.
              fleetGlow: traf?.glow ?? null,
              parkedFilled: fur?.parked?.filled ?? null,
              // THE POOL'S OWN ACCOUNTING, because a triangle delta nobody can
              // attribute is how a gate stops being evidence. daynight-sweep read
              // 9,024 FEWER triangles at every hour after this round's pool
              // changes, consistently, and neither the shell split (zero by
              // construction, asserted by car-shapes) nor anything else in the
              // round predicts that number. `pool` is the capacity, `filled` how
              // many were placed, `perShell` how the fill split, and
              // trianglesDrawn what those actually cost - so the next reading can
              // be attributed instead of argued about.
              parkedPool: fur?.parked?.pool ?? null,
              parkedPerShell: fur?.parked?.perShell ?? null,
              parkedShells: fur?.parked?.shells ?? null,
              parkedTrianglesDrawn: fur?.parked?.trianglesDrawn ?? null,
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
fs.writeFileSync(`docs/${TAG}-audits.json`,
  JSON.stringify({ results, errors, shotErrors }, null, 1));
console.log(`\nwrote docs/${TAG}-audits.json (${results.length} captures)`);
// Say it loudly. A short arm that reads as a completed run is how two arms of a
// pair set quietly lose the same frames and nobody counts.
if (shotErrors.length) {
  console.log(`\n${shotErrors.length} FRAME(S) NOT CAPTURED — this arm is INCOMPLETE:`);
  for (const e of shotErrors) console.log(`  ${e}`);
}
await browser.close();
