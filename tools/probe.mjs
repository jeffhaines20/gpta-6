// Headless harness: loads the skeleton, drives it through a scripted run
// (walk -> enter car -> accelerate -> turn), captures screenshots, and reports
// perf + physics telemetry. This is how the walking skeleton is verified
// without a human at the keyboard.
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:8123/skeleton/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__game && window.__game.frames > 20', null, { timeout: 20000 });

const wait = (ms) => page.waitForTimeout(ms);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const key = (fn) => page.evaluate(fn);

// --- 1. on foot, idle
await shot('01-onfoot');

// --- 2. walk toward the car
await key(() => { __game.press('KeyW'); __game.press('ShiftLeft'); });
await wait(700);
const walked = await page.evaluate(() => ({ ...__game.player.position }));
await shot('02-running');
await key(() => { __game.release('KeyW'); __game.release('ShiftLeft'); });

// --- 3. teleport next to the car and enter (scripted, deterministic)
await key(() => {
  __game.player.position.set(7.6, 0, 4);
  __game.player.velocity.set(0, 0, 0);
});
await wait(120);
await shot('03-near-vehicle');
await key(() => __game.toggleVehicle());
await wait(250);
await shot('04-in-vehicle');

// --- 4. drive: full throttle straight, then a hard turn
await key(() => __game.press('KeyW'));
await wait(2600);
const straight = await page.evaluate(() => ({
  kmh: __game.vehicle.speed * 3.6,
  fwd: __game.vehicle.forwardSpeed,
  y: __game.vehicle.position.y,
  contact: __game.vehicle.wheels.filter((w) => w.contact).length,
}));
await shot('05-driving');

await key(() => __game.press('KeyD'));
await wait(1400);
const turning = await page.evaluate(() => ({
  kmh: __game.vehicle.speed * 3.6,
  yawRate: __game.vehicle.angularVelocity.y,
  y: __game.vehicle.position.y,
  contact: __game.vehicle.wheels.filter((w) => w.contact).length,
  slip: __game.vehicle.wheels.map((w) => +w.slip.toFixed(2)),
}));
await shot('06-cornering');
await key(() => { __game.release('KeyD'); __game.release('KeyW'); });

// --- 5. brake to a stop, exit
await key(() => __game.press('KeyS'));
await wait(2200);
await key(() => __game.release('KeyS'));
await key(() => __game.toggleVehicle());
await wait(300);
await shot('07-exited');

// --- 6. frame-rate sample over 3 s
const fps = await page.evaluate(async () => {
  const a = __game.frames, t0 = performance.now();
  await new Promise((r) => setTimeout(r, 3000));
  return ((__game.frames - a) / ((performance.now() - t0) / 1000)).toFixed(1);
});

const final = await page.evaluate(() => ({ mode: __game.mode, frames: __game.frames }));
console.log(JSON.stringify({ walked, straight, turning, fps, final, errors }, null, 2));
await browser.close();
