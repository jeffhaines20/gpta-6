// Frames of the reaction, because "a struck pedestrian is knocked down" is a claim about
// pixels and every number in tools/reaction-test.mjs is a claim about state.
//
//   node tools/reaction-shots.mjs
//   REACTION_TOD=noon REACTION_SPEED=40 node tools/reaction-shots.mjs
//
// FIVE FRAMES, NAMED NOT NUMBERED: a ped upright, the same ped mid-fall, the same ped where
// the throw put it, a traffic car in its lane, and the same car rammed. Each pair is shot from
// ONE camera off ONE page load with the cloud deck frozen, so the only thing that differs
// between the two frames of a pair is the thing this round added. CLAUDE.md's sky-drift section
// is why the freeze is not optional.
//
// EVERY CLOCK THE PAIR READS IS PINNED, not just the sky. The first run of this tool froze the
// cloud deck and not the fleet: the "before" and "after" frames of the shunted car were shot
// 90 s of wall clock apart, during which the car drove 10.2 m up its own street at 11 m/s, so
// the pair showed a car that had MOVED and been knocked askew. The offset under test is 4.5 m.
// Both modules are therefore frozen before the first frame of each pair and advanced by hand.
//
// THE POSE IS HELD BY FREEZING THE MODULE, not by hoping. A headless frame is seconds and the
// fall is 0.32 s, so a screenshot started "just after" the impact would catch the body wherever
// it happened to be minutes later, differently in each run. So `update` is stubbed out and then
// called by hand with the exact dt wanted: the frame is a deterministic pose, and the same
// command twice gives the same picture.
import fs from 'node:fs';
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}docs/shots`;
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.REACTION_PORT ?? 8123);
const TOD = process.env.REACTION_TOD ?? 'golden';
const SPEED = Number(process.env.REACTION_SPEED ?? 40);       // km/h at the pedestrian
const DV = Number(process.env.REACTION_DV ?? 12);             // m/s of delta-v at the car
const TAG = process.env.REACTION_TAG ?? 'reaction';

await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 240000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
const froze = await page.evaluate(() => (__district.freezeClouds ? __district.freezeClouds() : null));
console.log(`clouds frozen: ${JSON.stringify(froze)}`);

const settle = async (n = 4) => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction(({ f, k }) => __district.frames > f + k, { f: f0, k: n },
    { timeout: 240000, polling: 100 }).catch(() => console.log('  (settle timed out, carrying on)'));
};

// Bounded AND non-fatal, and it says which frame it lost. A throw inside a capture loop
// destroys every frame after it and looks like a short run rather than a crash — that is a
// mistake this repo has made in four separate tools.
const shots = [];
async function shoot(name) {
  const path = `${OUT}/${TAG}-${name}-${TOD}.png`;
  try {
    await page.screenshot({ path, timeout: 180000 });
    shots.push(name);
    console.log(`  shot ${name}`);
  } catch (e) {
    console.error(`  LOST FRAME ${name}: ${e.message.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------- the pedestrian
//
// IN TOWN FIRST. The district's own spawn point is the marina at (-471, 205), and a 48-strong
// crowd asked to fill around it produces NOTHING: 0 of 48 slots, measured offline with the
// page's own spawn band, against 48 of 48 at Main Street. So the car is moved to a street with
// pavement before the crowd is created, and the crowd is checked rather than assumed.
const HOME = { x: 19, z: -6 };                       // Main St @ Pineapple Ave, route waypoint 2
await page.evaluate(({ x, z }) => {
  __district.setMode('car');
  __district.placeAt(x, z, Math.PI / 2);
  __district.setAutopilot(() => {});
  __district.setTraffic(false);
  __district.setPedestrians(48);
}, HOME);
await settle(14);
const crowdN = await page.evaluate(() => __district.pedestrianPositions().length);
console.log(`crowd: ${crowdN} of 48 slots filled`);

// Put the car on the road next to a pedestrian, facing along its own travel direction, and
// frame the victim from the side so the fall reads as a fall rather than as a body vanishing
// behind the bonnet.
const ped = await page.evaluate(() => {
  const P = __district.pedestrians();
  const list = P.positions();
  if (!list.length) return null;
  // The one with the most room around it: a fall inside a scrum reads as a scrum.
  let best = null;
  for (const p of list) {
    let near = Infinity;
    for (const q of list) if (q !== p) near = Math.min(near, Math.hypot(q.x - p.x, q.z - p.z));
    if (!best || near > best.near) best = { near, p };
  }
  const p = best.p;
  __district.setMode('car');
  __district.repairCar();
  // 6 m short of the ped, pointing at it, so the car in shot is where a car would be.
  __district.placeAt(p.x - 6, p.z, Math.PI / 2);
  const g = __district.world.heightAt(p.x, p.z);
  __district.freeCam([p.x - 3, g + 2.6, p.z + 9], [p.x + 2, g + 0.9, p.z], 46);
  __district.setAutopilot(() => {});
  return { i: p.i, x: +p.x.toFixed(2), z: +p.z.toFixed(2), roomM: +best.near.toFixed(2) };
});
console.log(`pedestrian: ${JSON.stringify(ped)}`);
if (ped) {
  await settle(6);
  // Freeze the crowd BEFORE the first frame of the pair, so the victim is in the same place in
  // both and is not simply a different person who walked into the shot.
  await page.evaluate(() => {
    const P = __district.pedestrians();
    window.__pedReal = P.update.bind(P);
    P.update = () => {};
  });
  await shoot('ped-before');

  // Advance the frozen crowd by hand. 0.16 s is half of PED_FALL_S, so the body is caught
  // halfway over rather than at either end of the arc.
  const fall = await page.evaluate(({ i, kmh }) => {
    const P = __district.pedestrians();
    const real = window.__pedReal;
    const r = P.hit(i, { speed: kmh / 3.6, dirX: 1, dirZ: 0 });
    real(0.16, __district.vehicle.position);
    const d = P.peds[i] && P.peds[i].down;
    return { hit: r, phase: d ? d.phase : null, t: d ? +d.t.toFixed(3) : null };
  }, { i: ped.i, kmh: SPEED });
  console.log(`hit at ${SPEED} km/h: ${JSON.stringify(fall)}`);
  await shoot('ped-falling');

  // Then run the slide out and reframe on where the body actually ended up, which is the
  // point of the throw model: 9.5 m at 40 km/h, not a body that drops where it stood.
  const thrown = await page.evaluate(({ i }) => {
    const P = __district.pedestrians();
    const real = window.__pedReal;
    for (let k = 0; k < 120; k++) {
      real(0.05, __district.vehicle.position);
      const d = P.peds[i] && P.peds[i].down;
      if (!d) break;
      if (Math.hypot(d.vx, d.vz) < 0.05) break;
    }
    const p = P.peds[i], d = p && p.down;
    const g = __district.world.heightAt(p.x, p.z);
    __district.freeCam([p.x - 5, g + 2.2, p.z + 7], [p.x, g + 0.4, p.z], 46);
    return d ? { travelled: +d.travelled.toFixed(2), want: +d.want.toFixed(2), phase: d.phase,
      x: +p.x.toFixed(2), z: +p.z.toFixed(2) } : null;
  }, { i: ped.i });
  console.log(`thrown: ${JSON.stringify(thrown)}`);
  await settle(3);
  await shoot('ped-thrown');
}

// ---------------------------------------------------------------- the traffic car
await page.evaluate(() => { __district.setPedestrians(0); __district.setTraffic(30); });
await page.waitForFunction(() => __district.trafficPositions().length > 0,
  null, { timeout: 240000, polling: 200 });
await settle(8);
const car = await page.evaluate(() => {
  // FREEZE FIRST, THEN FRAME. The camera is aimed at where a car IS, and a fleet still running
  // will have driven it out of that frame by the time the next screenshot completes.
  const T = __district.traffic();
  window.__trafficReal = T.update.bind(T);
  T.update = () => {};
  const cars = __district.trafficPositions();
  if (!cars.length) return null;
  // The one with the clearest view of it: nearest to the player, since the player's car has
  // to be in the frame for a ram to read as a ram.
  const v = __district.vehicle.position;
  let best = null;
  for (const c of cars) {
    const d = Math.hypot(c.x - v.x, c.z - v.z);
    if (!best || d < best.d) best = { d, c };
  }
  const c = best.c;
  const g = __district.world.heightAt(c.x, c.z);
  // Down the street, so a lane offset and a yaw both read.
  __district.freeCam([c.x - Math.sin(c.yaw) * 14, g + 3.2, c.z - Math.cos(c.yaw) * 14],
    [c.x, g + 0.8, c.z], 42);
  __district.placeAt(c.x - Math.sin(c.yaw) * 7, c.z - Math.cos(c.yaw) * 7, c.yaw);
  return { id: c.id, x: +c.x.toFixed(2), z: +c.z.toFixed(2), yaw: +c.yaw.toFixed(3),
    distM: +best.d.toFixed(1) };
});
console.log(`traffic car: ${JSON.stringify(car)}`);
if (car) {
  // The fleet is already frozen; these frames are only so the player's car settles on its
  // springs and district/main.js's focus catches up with where it was teleported.
  await settle(6);
  await shoot('car-before');
  const shunt = await page.evaluate((dv) => {
    const r = __district.shuntNearestCar(dv);
    // One publish so the matrices carry the offset, then hold it for the capture.
    window.__trafficReal(0.05, __district.vehicle.position);
    const p = __district.trafficPositions().find((c) => r && c.id === r.id) ?? null;
    return { hit: r, published: p ? { x: +p.x.toFixed(2), z: +p.z.toFixed(2),
      yaw: +p.yaw.toFixed(3), shunted: p.shunted, v: +p.v.toFixed(2) } : null };
  }, DV);
  console.log(`shunt at dv ${DV}: ${JSON.stringify(shunt)}`);
  await shoot('car-shunted');
}

console.log(`\n${shots.length} frames in docs/shots: ${shots.map((s) => `${TAG}-${s}-${TOD}.png`).join(', ')}`);
await browser.close();
