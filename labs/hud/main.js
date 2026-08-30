// HUD lab.
//
// The HUD is judged on three things and this page is built to expose all three:
//
//   1. Does it read at speed without covering the road? So the backdrop is a dark
//      night street with a bright wet lane down the middle — the worst background
//      a light-on-dark HUD can sit on — painted ONCE into a canvas and never
//      touched again, so every millisecond the loop spends is the HUD's own.
//
//   2. Does the minimap show the real city? So it loads data/district.json and
//      drives a real src/vehicle.js Vehicle around a route solved with Dijkstra
//      over the baked road graph. Nothing about the map is mocked.
//
//   3. What does a frame cost? rAF pacing under software rendering is useless for
//      that, so `bench()` runs the HUD in a tight loop in two modes: the steady
//      case (car moving, everything else still) and the worst case (health,
//      armour, wanted and weapon all changing every frame, so every canvas is
//      dirty). Both numbers are on screen.

import * as THREE from '../../vendor/three.module.min.js';
import { Vehicle } from '../../src/vehicle.js';
import { HUD, MAP_PALETTE } from '../../src/hud.js';

const errors = [];
window.__errors = errors;
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const $ = (id) => document.getElementById(id);
const district = await (await fetch('../../data/district.json')).json();

// ---------------------------------------------------------------- backdrop
// A static painting, not a scene. It exists to be something hard to read over.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintBackdrop(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rand = mulberry32(0x5eed11);
  const hz = H * 0.46;

  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#05080e');
  sky.addColorStop(0.72, '#0b131f');
  sky.addColorStop(1, '#1b2434');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, hz);

  const glow = ctx.createRadialGradient(W * 0.5, hz, 8, W * 0.5, hz, W * 0.42);
  glow.addColorStop(0, 'rgba(255,168,84,0.30)');
  glow.addColorStop(1, 'rgba(255,168,84,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, hz + 40);

  // Skyline, both sides, receding toward the middle.
  for (let side = -1; side <= 1; side += 2) {
    let x = side < 0 ? 0 : W;
    while (side < 0 ? x < W * 0.42 : x > W * 0.58) {
      const bw = 40 + rand() * 110;
      const bh = 60 + rand() * (hz * 0.85);
      const bx = side < 0 ? x : x - bw;
      ctx.fillStyle = `rgb(${12 + rand() * 8 | 0},${16 + rand() * 9 | 0},${24 + rand() * 12 | 0})`;
      ctx.fillRect(bx, hz - bh, bw, bh);
      for (let wy = hz - bh + 9; wy < hz - 8; wy += 13) {
        for (let wx = bx + 6; wx < bx + bw - 8; wx += 11) {
          if (rand() > 0.62) {
            ctx.fillStyle = rand() > 0.75 ? 'rgba(255,206,140,0.55)' : 'rgba(150,190,235,0.28)';
            ctx.fillRect(wx, wy, 4, 6);
          }
        }
      }
      x -= side * (bw + 4 + rand() * 26);   // -1 starts at the left edge and walks right
    }
  }

  const ground = ctx.createLinearGradient(0, hz, 0, H);
  ground.addColorStop(0, '#141a22');
  ground.addColorStop(1, '#0c1015');
  ctx.fillStyle = ground;
  ctx.fillRect(0, hz, W, H - hz);

  // Carriageway converging on the vanishing point, plus a wet sheen. This is the
  // bright band the HUD has to stay legible over.
  const vpx = W * 0.5;
  ctx.beginPath();
  ctx.moveTo(vpx - 26, hz);
  ctx.lineTo(vpx + 26, hz);
  ctx.lineTo(W * 0.96, H);
  ctx.lineTo(W * 0.04, H);
  ctx.closePath();
  const road = ctx.createLinearGradient(0, hz, 0, H);
  road.addColorStop(0, '#2c3644');
  road.addColorStop(0.45, '#232b36');
  road.addColorStop(1, '#171d25');
  ctx.fillStyle = road;
  ctx.fill();
  ctx.save();
  ctx.clip();
  const sheen = ctx.createLinearGradient(vpx - 90, hz, vpx + 130, H);
  sheen.addColorStop(0, 'rgba(255,190,120,0.22)');
  sheen.addColorStop(0.5, 'rgba(190,215,255,0.10)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, hz, W, H - hz);
  for (let i = 0; i < 22; i++) {
    const t = Math.pow(i / 22, 2.1);
    const y = hz + (H - hz) * t;
    const half = 2 + 22 * t;
    const len = 6 + 62 * t;
    ctx.fillStyle = 'rgba(238,232,206,0.62)';
    ctx.fillRect(vpx - half * 0.16, y, half * 0.32, len);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(214,224,238,0.34)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(vpx - 26, hz); ctx.lineTo(W * 0.04, H);
  ctx.moveTo(vpx + 26, hz); ctx.lineTo(W * 0.96, H);
  ctx.stroke();
}

// ---------------------------------------------------------------- road graph
// Dijkstra over the baked vertices so the route line on the minimap follows real
// streets instead of cutting across blocks. Oneways are ignored: this is a demo
// route, not a navigation system, and traffic.js owns direction of travel.
function buildAdjacency(d) {
  const adj = Array.from({ length: d.verts.length }, () => []);
  for (const e of d.edges) {
    for (let i = 1; i < e.v.length; i++) {
      const a = e.v[i - 1], b = e.v[i];
      const va = d.verts[a], vb = d.verts[b];
      const w = Math.hypot(va.x - vb.x, va.z - vb.z);
      adj[a].push([b, w]);
      adj[b].push([a, w]);
    }
  }
  return adj;
}

class Heap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function nearestVert(d, x, z) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < d.verts.length; i++) {
    const v = d.verts[i];
    const dd = (v.x - x) ** 2 + (v.z - z) ** 2;
    if (dd < bd) { bd = dd; best = i; }
  }
  return best;
}

function shortestPath(adj, from, to) {
  const dist = new Float64Array(adj.length).fill(Infinity);
  const prev = new Int32Array(adj.length).fill(-1);
  const done = new Uint8Array(adj.length);
  dist[from] = 0;
  const h = new Heap();
  h.push(0, from);
  while (h.size) {
    const [dv, u] = h.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (const [v, w] of adj[u]) {
      const nd = dv + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push(nd, v); }
    }
  }
  if (!done[to] && dist[to] === Infinity) return null;
  const out = [];
  for (let u = to; u !== -1; u = prev[u]) out.push(u);
  return out.reverse();
}

const tBuild = performance.now();
const adj = buildAdjacency(district);
const wps = district.meta.route.map((r) => nearestVert(district, r.x, r.z));
const routeVerts = [];
for (let i = 0; i < wps.length; i++) {
  const p = shortestPath(adj, wps[i], wps[(i + 1) % wps.length]);
  if (!p) continue;
  for (const v of p) if (routeVerts[routeVerts.length - 1] !== v) routeVerts.push(v);
}
const routePts = routeVerts.map((i) => [district.verts[i].x, district.verts[i].z]);
const routeMs = +(performance.now() - tBuild).toFixed(1);

// Cumulative arc length, so the autopilot can look a fixed distance ahead.
const routeLen = [0];
for (let i = 1; i < routePts.length; i++) {
  routeLen[i] = routeLen[i - 1] + Math.hypot(
    routePts[i][0] - routePts[i - 1][0], routePts[i][1] - routePts[i - 1][1]);
}
const totalLen = routeLen[routeLen.length - 1];

function pointAt(sMetres) {
  const s = ((sMetres % totalLen) + totalLen) % totalLen;
  let lo = 0, hi = routeLen.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (routeLen[mid] <= s) lo = mid; else hi = mid; }
  const seg = Math.max(1e-6, routeLen[hi] - routeLen[lo]);
  const t = (s - routeLen[lo]) / seg;
  return [routePts[lo][0] + (routePts[hi][0] - routePts[lo][0]) * t,
          routePts[lo][1] + (routePts[hi][1] - routePts[lo][1]) * t];
}

// ---------------------------------------------------------------- the car
// A real Vehicle on the real ground interface. If the HUD can read this it can
// read the game's.
const ground = {
  heightAt: () => 0,
  raycastDown(origin, maxDist) {
    const d = origin.y;
    return d < 0 || d > maxDist ? null : { y: 0, normalY: 1 };
  },
};
const car = new Vehicle();
let progress = 0;
function placeOnRoute(s) {
  const a = pointAt(s), b = pointAt(s + 6);
  car.position.set(a[0], 1.0, a[1]);
  car.velocity.set(0, 0, 0);
  car.angularVelocity.set(0, 0, 0);
  car.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(b[0] - a[0], b[1] - a[1]));
  progress = s;
}
placeOnRoute(0);

const _fwd = new THREE.Vector3();
function autopilot(dt) {
  _fwd.set(0, 0, 1).applyQuaternion(car.quaternion);
  // Advance the progress marker to the nearest point ahead, then aim past it.
  let best = progress, bd = Infinity;
  for (let s = progress - 4; s < progress + 40; s += 2) {
    const p = pointAt(s);
    const d = (p[0] - car.position.x) ** 2 + (p[1] - car.position.z) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  progress = best;
  if (bd > 45 * 45) { placeOnRoute(progress + 10); return; }

  const speed = car.speed;
  const look = 9 + speed * 0.62;
  const t = pointAt(progress + look);
  const dx = t[0] - car.position.x, dz = t[1] - car.position.z;
  const ang = Math.atan2(dx, dz) - Math.atan2(_fwd.x, _fwd.z);
  const err = Math.atan2(Math.sin(ang), Math.cos(ang));

  // Slow for whatever is coming: sample the route's own curvature ahead rather
  // than reacting to the error the car has already made.
  const a1 = pointAt(progress + 14), a2 = pointAt(progress + 34);
  const h1 = Math.atan2(a1[0] - car.position.x, a1[1] - car.position.z);
  const h2 = Math.atan2(a2[0] - a1[0], a2[1] - a1[1]);
  const bend = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
  const target = THREE.MathUtils.clamp(23 - bend * 17, 6.5, 23);

  car.setControls({
    throttle: speed < target ? 1 : 0,
    brake: speed > target + 3 ? 0.5 : 0,
    steer: THREE.MathUtils.clamp(err * 1.5, -1, 1),
    handbrake: false,
  });
  car.stepFixed(dt, ground, 120);
}

// ---------------------------------------------------------------- HUD
const bg = $('bg');
paintBackdrop(bg);
const hud = new HUD({ district, zoomMetres: 210 });
hud.update({ route: routePts, inVehicle: true, armour: 0.55,
  weapon: { name: 'Kestrel .40', ammo: 12, reserve: 84, icon: 'pistol' },
  location: 'Marlin Street', district: 'Verano Bay' });

const PROMPTS = [
  null,
  { key: 'F', text: 'Enter vehicle' },
  'PRESS F TO ENTER VEHICLE',
  { key: 'E', text: 'Hold to hotwire' },
];
const OBJECTIVES = [
  null,
  { title: 'Objective', text: 'Lose the patrol units before the bridge', distance: 620 },
  { title: 'Delivery', text: 'Drop the crate at the Halyard Avenue lockup' },
  { title: 'Warning', text: 'Return to the district' },
];
const SUBS = [
  null,
  { speaker: 'Renna', text: "Two units on Tarpon Row. Don't take the bridge." },
  { speaker: 'Dispatch', text: 'All cars, suspect vehicle heading north on Marlin.' },
  'The harbour lights went out one by one.',
];

const ui = {
  auto: true, manualSpeed: null, prompt: 0, obj: 0, sub: 0,
  north: false, inVehicle: true, wanted: 0,
  health: 1, armour: 0.55, vig: 0,
};

// A single marker set, built once. Rebuilding the array every frame would make the
// minimap redraw every frame even parked — the module documents that; the lab
// should not be the thing that demonstrates the bad path.
const markers = [
  { x: district.meta.route[4].x, z: district.meta.route[4].z, kind: 'objective' },
  { x: district.meta.route[6].x, z: district.meta.route[6].z, kind: 'shop' },
  { x: district.meta.route[2].x, z: district.meta.route[2].z, kind: 'enemy' },
];
const waypoint = { x: district.meta.route[7].x, z: district.meta.route[7].z };

// ---------------------------------------------------------------- controls
const bind = (id, out, fn) => {
  const el = $(id), v = $(out);
  const apply = () => { v.textContent = fn(Number(el.value)); };
  el.addEventListener('input', apply);
  apply();
  return el;
};
const sSpeed = bind('s-speed', 'v-speed', (n) => (ui.auto ? 'auto' : String(n)));
sSpeed.addEventListener('input', () => {
  ui.auto = false; $('b-auto').classList.remove('on');
  ui.manualSpeed = Number(sSpeed.value) / 3.6;
  $('v-speed').textContent = sSpeed.value;
});
bind('s-wanted', 'v-wanted', (n) => { ui.wanted = n; hud.setWanted(n); return String(n); });
bind('s-health', 'v-health', (n) => { ui.health = n / 100; return String(n); });
bind('s-armour', 'v-armour', (n) => { ui.armour = n / 100; return String(n); });
bind('s-vig', 'v-vig', (n) => { ui.vig = n / 100; return String(n); });
bind('s-zoom', 'v-zoom', (n) => { hud.update({ zoomMetres: n }); return String(n); });

const toggle = (id, key, fn) => $(id).addEventListener('click', () => {
  ui[key] = !ui[key];
  $(id).classList.toggle('on', ui[key]);
  if (fn) fn(ui[key]);
});
toggle('b-north', 'north', (v) => hud.setNorthUp(v));
toggle('b-veh', 'inVehicle', (v) => hud.update({ inVehicle: v }));
toggle('b-auto', 'auto', (v) => { if (v) ui.manualSpeed = null; $('v-speed').textContent = v ? 'auto' : sSpeed.value; });
const cycle = (id, key, list, apply) => $(id).addEventListener('click', () => {
  ui[key] = (ui[key] + 1) % list.length;
  apply(list[ui[key]]);
});
cycle('b-prompt', 'prompt', PROMPTS, (p) => hud.setPrompt(p));
cycle('b-obj', 'obj', OBJECTIVES, (o) => hud.setObjective(o));
cycle('b-sub', 'sub', SUBS, (s) => hud.setSubtitle(s));
$('b-dmg').addEventListener('click', () => hud.flashDamage(0.85));
$('b-bench').addEventListener('click', () => { lastBench = bench(400); });

const KEYS = {
  Digit0: 0, Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5,
};
addEventListener('keydown', (e) => {
  if (e.code in KEYS) {
    ui.wanted = KEYS[e.code];
    $('s-wanted').value = String(ui.wanted); $('v-wanted').textContent = String(ui.wanted);
    hud.setWanted(ui.wanted);
    return;
  }
  const step = (id, key, d, scale = 1) => {
    const el = $(id);
    el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), Number(el.value) + d)));
    el.dispatchEvent(new Event('input'));
    ui[key] = Number(el.value) * scale;
  };
  switch (e.code) {
    case 'KeyW': ui.auto = false; $('b-auto').classList.remove('on'); step('s-speed', 'x', 10); ui.manualSpeed = Number($('s-speed').value) / 3.6; $('v-speed').textContent = $('s-speed').value; break;
    case 'KeyS': ui.auto = false; $('b-auto').classList.remove('on'); step('s-speed', 'x', -10); ui.manualSpeed = Number($('s-speed').value) / 3.6; $('v-speed').textContent = $('s-speed').value; break;
    case 'KeyH': step('s-health', 'health', -10, 0.01); break;
    case 'KeyJ': step('s-health', 'health', 10, 0.01); break;
    case 'KeyK': step('s-armour', 'armour', -10, 0.01); break;
    case 'KeyL': step('s-armour', 'armour', 10, 0.01); break;
    case 'BracketLeft': step('s-zoom', 'x', -30); hud.update({ zoomMetres: Number($('s-zoom').value) }); break;
    case 'BracketRight': step('s-zoom', 'x', 30); hud.update({ zoomMetres: Number($('s-zoom').value) }); break;
    case 'KeyN': $('b-north').click(); break;
    case 'KeyV': $('b-veh').click(); break;
    case 'KeyP': $('b-prompt').click(); break;
    case 'KeyO': $('b-obj').click(); break;
    case 'KeyB': $('b-sub').click(); break;
    case 'KeyX': hud.flashDamage(0.85); break;
    case 'Space': $('b-auto').click(); e.preventDefault(); break;
    default: break;
  }
});
addEventListener('resize', () => { paintBackdrop(bg); hud.layout(); });

// ---------------------------------------------------------------- benchmark
function bench(n = 400) {
  const centre = district.meta.route[3];
  const run = (label, worst) => {
    hud.resetStats();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const st = {
        dt: 1 / 60, inVehicle: true,
        speed: 22 + 10 * Math.sin(t * 3), forwardSpeed: 22 + 10 * Math.sin(t * 3),
        slip: 0.3 + 0.3 * Math.sin(t * 7),
        player: { x: centre.x + Math.cos(t) * 170, z: centre.z + Math.sin(t) * 170, heading: t + Math.PI / 2 },
      };
      if (worst) {
        st.health = 0.5 + 0.5 * Math.sin(t * 2);
        st.armour = 0.5 + 0.45 * Math.cos(t * 2);
        st.wanted = (i >> 4) % 6;
        st.markers = markers.map((m) => ({ ...m }));
      }
      hud.update(st);
    }
    const total = performance.now() - t0;
    return { label, msPerFrame: +(total / n).toFixed(3),
      minimapMs: +hud.stats.avgMinimapMs.toFixed(3),
      worstFrameMs: +hud.stats.worstUpdateMs.toFixed(3) };
  };
  const out = { frames: n, steady: run('steady', false), worst: run('worst', true) };
  hud.resetStats();
  return out;
}
let lastBench = null;

// ---------------------------------------------------------------- loop
let last = performance.now();
let ready = false;
const statsEl = $('stats');
let statAcc = 0;

function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (ui.auto) {
    autopilot(dt);
  } else if (ui.manualSpeed != null) {
    // Manual mode still moves the car so the minimap keeps panning; it just does
    // it kinematically instead of through the tyre model.
    progress += ui.manualSpeed * dt;
    const a = pointAt(progress), b = pointAt(progress + 6);
    car.position.set(a[0], 1.0, a[1]);
    car.velocity.set((b[0] - a[0]) / 6 * ui.manualSpeed, 0, (b[1] - a[1]) / 6 * ui.manualSpeed);
    car.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(b[0] - a[0], b[1] - a[1]));
    for (const w of car.wheels) w.slip = 0;
  }

  hud.update({
    vehicle: car,
    inVehicle: ui.inVehicle,
    health: ui.health, armour: ui.armour, vignette: ui.vig,
    markers, waypoint, northUp: ui.north,
  });

  statAcc += dt;
  if (statAcc > 0.4) {
    statAcc = 0;
    const s = hud.stats;
    statsEl.textContent =
      `scale      ${s.scale.toFixed(2)}  dpr ${s.dpr}\n` +
      `viewport   ${window.innerWidth}x${window.innerHeight}\n` +
      `webgl draw calls   ${s.drawCalls}\n` +
      `map bake   ${s.bakeMs} ms  ${s.bakeMB} MB\n` +
      `route      ${routePts.length} pts  ${routeMs} ms\n` +
      `update     avg ${s.avgUpdateMs.toFixed(2)} ms  worst ${s.worstUpdateMs.toFixed(2)}\n` +
      `minimap    avg ${s.avgMinimapMs.toFixed(2)} ms  worst ${s.worstMinimapMs.toFixed(2)}\n` +
      (lastBench
        ? `bench      steady ${lastBench.steady.msPerFrame} ms/f\n` +
          `           worst  ${lastBench.worst.msPerFrame} ms/f\n` +
          `           map    ${lastBench.worst.minimapMs} ms/f`
        : `bench      (press "bench 400")`);
  }
  requestAnimationFrame(frame);
}

$('load').remove();
requestAnimationFrame(frame);
ready = true;

window.__lab = {
  get ready() { return ready; },
  hud, car, district, bench,
  stats() {
    return {
      ...hud.stats,
      routePoints: routePts.length, routeMs,
      bake: hud.bake ? {
        ms: hud.bake.ms, megabytes: hud.bake.megabytes,
        width: hud.bake.width, height: hud.bake.height,
        ppm: hud.bake.ppm, timings: hud.bake.timings, counts: hud.bake.counts,
      } : null,
      lastBench,
      errors,
    };
  },
  // Deterministic scene setup for screenshots.
  scenario(name) {
    const set = {
      chase: () => {
        ui.auto = true; ui.wanted = 3; ui.health = 0.42; ui.armour = 0.66; ui.vig = 0;
        hud.setWanted(3, { flash: true });
        hud.setObjective(OBJECTIVES[1]);
        hud.setSubtitle(SUBS[1]);
        hud.setPrompt(null);
        hud.flashDamage(0.55);
      },
      onfoot: () => {
        ui.auto = false; ui.manualSpeed = 0; ui.inVehicle = false;
        $('b-veh').classList.remove('on');
        ui.wanted = 0; ui.health = 0.86; ui.armour = 0.3;
        hud.setWanted(0, { flash: false });
        hud.setPrompt({ key: 'F', text: 'Enter vehicle' });
        hud.setObjective(OBJECTIVES[2]);
        hud.setSubtitle(null);
      },
      cruise: () => {
        ui.auto = true; ui.inVehicle = true; $('b-veh').classList.add('on');
        ui.wanted = 0; ui.health = 1; ui.armour = 0.55; ui.vig = 0;
        hud.setWanted(0, { flash: false });
        hud.setObjective(null); hud.setSubtitle(null); hud.setPrompt(null);
      },
    };
    (set[name] || set.cruise)();
    $('s-wanted').value = String(ui.wanted);
    $('s-health').value = String(Math.round(ui.health * 100));
    $('s-armour').value = String(Math.round(ui.armour * 100));
  },
  setNorthUp(v) { ui.north = v; $('b-north').classList.toggle('on', v); hud.setNorthUp(v); },
  seek(s) { placeOnRoute(s); },
};
