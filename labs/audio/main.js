// Audio bench.
//
// Sound cannot be screenshotted, so this page is built so that everything the
// module claims is visible as a picture:
//
//   1. The OSCILLOSCOPE is trigger-aligned on a rising zero crossing, so an
//      engine at a steady RPM draws a stable, repeating waveform. A sine sweep
//      would draw one smooth curve; what you should see instead is a lumpy
//      asymmetric pulse train, which is the claim the module makes about its
//      engine and the one that is easiest to fake.
//
//   2. The SPECTRUM is log-frequency with a real dBFS axis and a peak hold. The
//      harmonic comb, the three fixed formant peaks and the noise floor of the
//      induction layer are all separately identifiable in it.
//
//   3. The METERS show L and R independently, so the PannerNode moving a pursuit
//      unit around the listener is visible as the two bars trading level, and the
//      RADAR draws where that unit actually is relative to the listener pose that
//      three.js wrote into the context.
//
//   4. The HISTORY strip records RPM against output level over ten seconds, which
//      is where a gear change, the rev limiter chopping and a screech onset are
//      legible as shapes rather than as numbers.
//
// The bench drives src/audio.js through its override API. Switching to "drive
// car" instead runs a real src/vehicle.js Vehicle on a flat ground and feeds the
// module through updateVehicle(), which is the path the game uses.

import * as THREE from '../../vendor/three.module.min.js';
import { GameAudio } from '../../src/audio.js';
import { Vehicle } from '../../src/vehicle.js';
import { FlatGround } from '../../src/ground.js';
import { PursuitUnits } from '../../src/pursuit.js';

const errors = [];
window.__errors = errors;
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const $ = (id) => document.getElementById(id);
const cv = $('scope');
const ctx2d = cv.getContext('2d');

// ------------------------------------------------------------------- audio
const audio = new GameAudio({ timeOfDay: 'dusk', volume: 0.9 });

// A camera at the origin looking down -Z. three writes this pose onto the
// context listener, which is what makes the panner directional.
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
camera.position.set(0, 1.4, 0);
audio.attachListener(camera);

// Lab-side stereo tap. The module's own analyser is mono (an AnalyserNode always
// down-mixes), and a mono meter cannot show a panner working.
let anL = null, anR = null;
if (audio.available) {
  const split = audio.ctx.createChannelSplitter(2);
  anL = audio.ctx.createAnalyser(); anL.fftSize = 1024;
  anR = audio.ctx.createAnalyser(); anR.fftSize = 1024;
  audio.mute.connect(split);
  split.connect(anL, 0);
  split.connect(anR, 1);
}

const an = audio.getAnalyser();
if (an) { an.fftSize = 4096; an.smoothingTimeConstant = 0.62; }
const timeData = new Uint8Array(an ? an.fftSize : 2);
const freqData = new Float32Array(an ? an.frequencyBinCount : 1);
const peakHold = new Float32Array(an ? an.frequencyBinCount : 1).fill(-140);
const lrTime = [new Uint8Array(512), new Uint8Array(512)];

// -------------------------------------------------------------------- state
const ui = {
  mode: 'bench', rpm: 3800, throttle: 0.55, brake: 0, speed: 62, slip: 0,
  siren: 'off', orbit: true, rain: 0, hour: 18.5, tod: 'dusk', interior: false,
};
const vehicle = new Vehicle();
const ground = new FlatGround(0);
let driveT = 0;

// Siren source. Orbits the listener so the pan sweeps a full circle every 9 s.
const siren = { x: 0, y: 1.6, z: -34, angle: 0, radius: 34 };

const HIST_HZ = 10, HIST_S = 10;
const hist = { n: HIST_HZ * HIST_S, rpm: [], level: [], screech: [], acc: 0 };

// A real src/pursuit.js fleet on the real baked road graph. The siren voice pool
// is only three; the point of driving it from an actual PursuitUnits is that the
// pool assignment, the hysteresis and the InstancedMesh position read are all
// exercised against the interface as it really is, not as this module assumed.
const fleet = { units: null, scene: null, target: null, contacts: [], loading: false, error: null };
const _fm = new THREE.Matrix4();
const _fv = new THREE.Vector3();

// One shared promise, not a boolean: a second caller arriving while the district
// is still downloading must wait for the same load, not be handed a null fleet.
function ensureFleet() {
  if (fleet.units) return Promise.resolve(fleet.units);
  if (fleet.pending) return fleet.pending;
  fleet.pending = loadFleet();
  return fleet.pending;
}

async function loadFleet() {
  fleet.loading = true;
  try {
    const district = await (await fetch('../../data/district.json')).json();
    fleet.scene = new THREE.Scene();
    fleet.units = new PursuitUnits(fleet.scene, district, { count: 6, speed: 20, giveUpRadius: 420 });
    // Park the listener on a real road vertex so units have somewhere to come from.
    const v = district.verts[Math.floor(district.verts.length / 2)];
    fleet.target = { x: v.x, y: 0, z: v.z };
    camera.position.set(v.x, 1.4, v.z);
    camera.updateMatrixWorld();
  } catch (e) {
    fleet.error = String(e && e.message);
  }
  fleet.loading = false;
  return fleet.units;
}

function stepFleet(dt) {
  fleet.contacts.length = 0;
  if (!fleet.units) return 0;
  fleet.units.update(dt, fleet.target);
  const n = audio.updatePursuit(fleet.units, camera.position);
  const voiced = new Set(audio.sirenVoices.filter((v) => v.active).map((v) => v.unit));
  for (let i = 0; i < fleet.units.count; i++) {
    if (!fleet.units.units[i]) continue;
    fleet.units.mesh.getMatrixAt(i, _fm);
    _fv.setFromMatrixPosition(_fm);
    fleet.contacts.push({ x: _fv.x - camera.position.x, z: _fv.z - camera.position.z, voiced: voiced.has(i) });
  }
  return n;
}

// ------------------------------------------------------------------ helpers
const dbfs = (v) => 20 * Math.log10(Math.max(v, 1e-6));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function analyseRms(node, buf) {
  if (!node) return { rms: 0, peak: 0 };
  node.getByteTimeDomainData(buf);
  let sum = 0, peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = (buf[i] - 128) / 128;
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sum / buf.length), peak };
}

// ------------------------------------------------------------------ drawing
const COL = {
  bg: '#070b11', pane: '#0a1017', grid: '#152130', gridHi: '#1e2d3f',
  ink: '#e8edf5', dim: '#6d8098', label: '#8ea6c4',
  amber: '#ffb03a', cyan: '#4ad6ff', red: '#ff5f4a', green: '#54d98c', violet: '#b489ff',
};

function pane(x, y, w, h, title, sub) {
  ctx2d.fillStyle = COL.pane;
  ctx2d.fillRect(x, y, w, h);
  ctx2d.strokeStyle = 'rgba(120,150,190,.20)';
  ctx2d.lineWidth = 1;
  ctx2d.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx2d.fillStyle = COL.label;
  ctx2d.font = '700 10px ui-monospace,monospace';
  ctx2d.fillText(title, x + 10, y + 16);
  if (sub) {
    ctx2d.fillStyle = COL.dim;
    ctx2d.font = '10px ui-monospace,monospace';
    ctx2d.fillText(sub, x + 10 + ctx2d.measureText(title).width + 14, y + 16);
  }
  return { x: x + 10, y: y + 26, w: w - 20, h: h - 38 };
}

function trace(pts, colour, width, glow) {
  if (glow) {
    ctx2d.strokeStyle = glow;
    ctx2d.lineWidth = width * 3.2;
    ctx2d.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) ctx2d.moveTo(pts[0], pts[1]); else ctx2d.lineTo(pts[i], pts[i + 1]);
    }
    ctx2d.stroke();
  }
  ctx2d.strokeStyle = colour;
  ctx2d.lineWidth = width;
  ctx2d.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) ctx2d.moveTo(pts[0], pts[1]); else ctx2d.lineTo(pts[i], pts[i + 1]);
  }
  ctx2d.stroke();
}

function drawScope(r) {
  ctx2d.save();
  ctx2d.beginPath(); ctx2d.rect(r.x, r.y, r.w, r.h); ctx2d.clip();
  ctx2d.strokeStyle = COL.grid; ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  for (let i = 1; i < 8; i++) { const x = r.x + (r.w * i) / 8; ctx2d.moveTo(x, r.y); ctx2d.lineTo(x, r.y + r.h); }
  for (let i = 1; i < 4; i++) { const y = r.y + (r.h * i) / 4; ctx2d.moveTo(r.x, y); ctx2d.lineTo(r.x + r.w, y); }
  ctx2d.stroke();
  ctx2d.strokeStyle = COL.gridHi;
  ctx2d.beginPath(); ctx2d.moveTo(r.x, r.y + r.h / 2); ctx2d.lineTo(r.x + r.w, r.y + r.h / 2); ctx2d.stroke();

  if (an) {
    an.getByteTimeDomainData(timeData);
    // Trigger on the first rising zero crossing, so a periodic signal stands
    // still instead of scrolling. Without this the engine waveform is unreadable.
    const span = Math.min(1400, timeData.length >> 1);
    let start = 0;
    for (let i = 1; i < timeData.length - span; i++) {
      if (timeData[i - 1] < 128 && timeData[i] >= 128) { start = i; break; }
    }
    const n = Math.max(64, Math.min(700, Math.floor(r.w)));
    const pts = new Array(n * 2);
    for (let k = 0; k < n; k++) {
      const i = Math.round((k / (n - 1)) * (span - 1));
      pts[k * 2] = r.x + (k / (n - 1)) * r.w;
      pts[k * 2 + 1] = r.y + r.h / 2 - ((timeData[start + i] - 128) / 128) * (r.h / 2 - 4) * 2.0;
    }
    trace(pts, COL.amber, 1.4, 'rgba(255,176,58,.16)');
  }
  ctx2d.restore();
  ctx2d.fillStyle = COL.dim;
  ctx2d.font = '9px ui-monospace,monospace';
  ctx2d.fillText('+0.50', r.x + 4, r.y + 10);
  ctx2d.fillText('-0.50', r.x + 4, r.y + r.h - 3);
  ctx2d.fillText(`${(1000 * 1400 / (audio.available ? audio.ctx.sampleRate : 44100)).toFixed(1)} ms window`,
    r.x + r.w - 78, r.y + r.h - 3);
}

let specGrad = null;
const FREQ_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FMIN = 22, FMAX = 20000;
const DB_MIN = -102, DB_MAX = -12;

function drawSpectrum(r) {
  const lx = (f) => r.x + (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * r.w;
  const ly = (db) => r.y + r.h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * r.h;

  ctx2d.save();
  ctx2d.beginPath(); ctx2d.rect(r.x, r.y, r.w, r.h); ctx2d.clip();
  ctx2d.strokeStyle = COL.grid; ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  for (const f of FREQ_TICKS) { const x = lx(f); ctx2d.moveTo(x, r.y); ctx2d.lineTo(x, r.y + r.h); }
  for (let db = DB_MIN + 6; db < DB_MAX; db += 18) { const y = ly(db); ctx2d.moveTo(r.x, y); ctx2d.lineTo(r.x + r.w, y); }
  ctx2d.stroke();

  if (an) {
    an.getFloatFrequencyData(freqData);
    const sr = audio.available ? audio.ctx.sampleRate : 44100;
    const bin = sr / 2 / freqData.length;
    // Decimate to screen columns, keeping the MAX of each column's bins. Stroking
    // all 2048 bins as line segments cost more than everything else on the page
    // put together under software rendering, and a max-envelope is also the
    // honest thing to draw: it cannot hide a narrow peak between two samples.
    const cols = Math.max(64, Math.min(520, Math.floor(r.w)));
    const top = new Float32Array(cols).fill(DB_MIN);
    const hold = new Float32Array(cols).fill(DB_MIN);
    const filled = new Uint8Array(cols);
    const span = Math.log(FMAX / FMIN);
    for (let i = 1; i < freqData.length; i++) {
      const f = i * bin;
      if (f < FMIN || f > FMAX) continue;
      const c = Math.min(cols - 1, Math.floor((Math.log(f / FMIN) / span) * cols));
      const db = Math.max(freqData[i], DB_MIN);
      peakHold[i] = Math.max(db, peakHold[i] - 0.55);
      if (!filled[c] || db > top[c]) top[c] = db;
      if (!filled[c] || peakHold[i] > hold[c]) hold[c] = peakHold[i];
      filled[c] = 1;
    }
    // Below about 1 kHz a log axis has more columns than the FFT has bins, so
    // most columns get nothing. Leaving those at the floor draws a picket fence
    // whose teeth are single bins and whose gaps are pure artifact — it LOOKS
    // like a harmonic comb, which is exactly the claim this pane exists to test,
    // so it has to be resampled rather than left to flatter the module.
    for (let c = 0; c < cols; c++) {
      if (filled[c]) continue;
      const f = FMIN * Math.exp(((c + 0.5) / cols) * span);
      const x = f / bin;
      const i0 = Math.max(1, Math.min(freqData.length - 2, Math.floor(x)));
      const t = clamp01(x - i0);
      top[c] = Math.max(DB_MIN, freqData[i0] * (1 - t) + freqData[i0 + 1] * t);
      hold[c] = Math.max(DB_MIN, peakHold[i0] * (1 - t) + peakHold[i0 + 1] * t);
    }
    const cx = (c) => r.x + ((c + 0.5) / cols) * r.w;
    const pts = [], pk = [];
    ctx2d.beginPath();
    for (let c = 0; c < cols; c++) {
      const x = cx(c), y = ly(top[c]);
      pts.push(x, y); pk.push(x, ly(hold[c]));
      if (c === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.lineTo(r.x + r.w, r.y + r.h);
    ctx2d.lineTo(r.x, r.y + r.h);
    ctx2d.closePath();
    if (!specGrad || specGrad.y !== r.y || specGrad.h !== r.h) {
      const g = ctx2d.createLinearGradient(0, r.y, 0, r.y + r.h);
      g.addColorStop(0, 'rgba(74,214,255,.42)');
      g.addColorStop(1, 'rgba(74,214,255,.03)');
      specGrad = { g, y: r.y, h: r.h };
    }
    ctx2d.fillStyle = specGrad.g;
    ctx2d.fill();
    trace(pk, 'rgba(180,137,255,.75)', 1);
    trace(pts, COL.cyan, 1.3);
  }
  ctx2d.restore();

  ctx2d.fillStyle = COL.dim;
  ctx2d.font = '9px ui-monospace,monospace';
  for (const f of FREQ_TICKS) {
    const x = lx(f);
    ctx2d.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x - 8, r.y + r.h + 10);
  }
  for (let db = DB_MIN + 6; db < DB_MAX; db += 18) ctx2d.fillText(`${db}`, r.x + 2, ly(db) - 2);
  ctx2d.fillStyle = COL.violet;
  ctx2d.fillText('peak hold', r.x + r.w - 62, r.y + 10);
}

function drawMeters(r, L, R, red) {
  const barW = 22, gap = 14;
  const scale = (v) => {
    const db = Math.max(dbfs(v), -60);
    return (db + 60) / 60;
  };
  const bars = [
    { label: 'L', v: L.rms, p: L.peak, c: COL.amber },
    { label: 'R', v: R.rms, p: R.peak, c: COL.amber },
    { label: 'GR', v: 0, p: 0, c: COL.red, gr: red },
  ];
  bars.forEach((b, i) => {
    const x = r.x + 26 + i * (barW + gap);
    const top = r.y + 6, h = r.h - 24;
    ctx2d.fillStyle = '#10161f';
    ctx2d.fillRect(x, top, barW, h);
    if (b.gr !== undefined) {
      // Gain reduction grows downward from the top: the bar is how much the
      // limiter is holding back, in dB, over a 0..-24 range.
      const f = Math.min(1, Math.abs(b.gr) / 24);
      ctx2d.fillStyle = COL.red;
      ctx2d.fillRect(x, top, barW, h * f);
    } else {
      const f = scale(b.v);
      const g = ctx2d.createLinearGradient(0, top + h, 0, top);
      g.addColorStop(0, '#2f7f5a'); g.addColorStop(0.72, COL.amber); g.addColorStop(1, COL.red);
      ctx2d.fillStyle = g;
      ctx2d.fillRect(x, top + h * (1 - f), barW, h * f);
      const pf = scale(b.p);
      ctx2d.fillStyle = COL.ink;
      ctx2d.fillRect(x, top + h * (1 - pf) - 1, barW, 2);
    }
    ctx2d.fillStyle = COL.label;
    ctx2d.font = '9px ui-monospace,monospace';
    ctx2d.fillText(b.label, x + barW / 2 - 4, r.y + r.h - 4);
  });
  ctx2d.fillStyle = COL.dim;
  ctx2d.font = '9px ui-monospace,monospace';
  for (let db = 0; db >= -60; db -= 12) {
    const y = r.y + 6 + (r.h - 24) * (1 - (db + 60) / 60);
    ctx2d.fillText(String(db), r.x, y + 3);
  }
  ctx2d.fillStyle = COL.ink;
  ctx2d.font = '10px ui-monospace,monospace';
  ctx2d.fillText(`${dbfs(Math.max(L.peak, R.peak)).toFixed(1)} dBFS pk`, r.x, r.y + r.h + 8);
}

function drawHistory(r) {
  ctx2d.save();
  ctx2d.beginPath(); ctx2d.rect(r.x, r.y, r.w, r.h); ctx2d.clip();
  ctx2d.strokeStyle = COL.grid;
  ctx2d.beginPath();
  for (let i = 1; i < 4; i++) { const y = r.y + (r.h * i) / 4; ctx2d.moveTo(r.x, y); ctx2d.lineTo(r.x + r.w, y); }
  ctx2d.stroke();
  const n = hist.rpm.length;
  if (n > 1) {
    const px = (i) => r.x + (i / (hist.n - 1)) * r.w;
    const line = (arr, norm, colour) => {
      const pts = [];
      for (let i = 0; i < n; i++) pts.push(px(i + (hist.n - n)), r.y + r.h - norm(arr[i]) * r.h);
      trace(pts, colour, 1.3);
    };
    line(hist.rpm, (v) => v / 7100, COL.amber);
    line(hist.level, (v) => Math.max(0, (v + 60) / 60), COL.cyan);
    line(hist.screech, (v) => v, COL.red);
  }
  ctx2d.restore();
  ctx2d.font = '9px ui-monospace,monospace';
  ctx2d.fillStyle = COL.amber; ctx2d.fillText('rpm', r.x + 4, r.y + 10);
  ctx2d.fillStyle = COL.cyan; ctx2d.fillText('level', r.x + 34, r.y + 10);
  ctx2d.fillStyle = COL.red; ctx2d.fillText('screech', r.x + 72, r.y + 10);
  ctx2d.fillStyle = COL.dim; ctx2d.fillText(`${HIST_S} s`, r.x + r.w - 24, r.y + r.h - 3);
}

function drawRadar(r, contacts, range) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const rad = Math.min(r.w, r.h) / 2 - 8;
  const scale = rad / range;
  ctx2d.strokeStyle = COL.grid;
  for (const m of [range / 3, (range * 2) / 3, range]) {
    ctx2d.beginPath(); ctx2d.arc(cx, cy, m * scale, 0, Math.PI * 2); ctx2d.stroke();
  }
  ctx2d.beginPath();
  ctx2d.moveTo(cx - rad, cy); ctx2d.lineTo(cx + rad, cy);
  ctx2d.moveTo(cx, cy - rad); ctx2d.lineTo(cx, cy + rad);
  ctx2d.stroke();
  // Listener, pointing up-screen: the camera looks down -Z, and -Z is up here.
  ctx2d.fillStyle = COL.green;
  ctx2d.beginPath();
  ctx2d.moveTo(cx, cy - 7); ctx2d.lineTo(cx - 5, cy + 5); ctx2d.lineTo(cx + 5, cy + 5);
  ctx2d.closePath(); ctx2d.fill();
  const pulse = 3.5 + 2.5 * (0.5 + 0.5 * Math.sin(performance.now() / 90));
  for (const c of contacts) {
    const d = Math.hypot(c.x, c.z);
    const k = d > range ? range / d : 1;         // clamp off-scale contacts to the rim
    const sx = cx + c.x * k * scale, sy = cy + c.z * k * scale;
    if (c.voiced) {
      ctx2d.strokeStyle = 'rgba(255,95,74,.55)';
      ctx2d.beginPath(); ctx2d.moveTo(cx, cy); ctx2d.lineTo(sx, sy); ctx2d.stroke();
    }
    ctx2d.fillStyle = c.voiced ? COL.red : 'rgba(140,160,185,.55)';
    ctx2d.beginPath(); ctx2d.arc(sx, sy, c.voiced ? pulse : 2.6, 0, Math.PI * 2); ctx2d.fill();
  }
  ctx2d.fillStyle = COL.dim;
  ctx2d.font = '9px ui-monospace,monospace';
  ctx2d.fillText(`${range} m`, cx + 4, cy - rad + 10);
  const voiced = contacts.filter((c) => c.voiced).length;
  ctx2d.fillText(ui.siren === 'off' ? 'siren off'
    : ui.siren === 'pursuit'
      ? (fleet.units ? `${contacts.length} units, ${voiced}/3 voices` : fleet.error ? 'district load failed' : 'loading district…')
      : `${Math.hypot(siren.x, siren.z).toFixed(0)} m ${ui.siren}`,
    r.x + 2, r.y + r.h - 2);
}

// -------------------------------------------------------------------- loop
let last = performance.now();
let frames = 0;
let lastLR = { L: { rms: 0, peak: 0 }, R: { rms: 0, peak: 0 } };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(window.innerWidth * dpr);
  cv.height = Math.round(window.innerHeight * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function frame(now) {
  const wall = (now - last) / 1000;
  const dt = Math.min(0.1, wall);      // clamped: a slow frame must not explode the integrator
  last = now;
  frames++;

  // ---- feed the module
  if (ui.mode === 'bench') {
    audio.setEngine({ rpm: ui.rpm, throttle: ui.throttle, brake: ui.brake });
    audio.setTyres({ speed: ui.speed / 3.6, slip: ui.slip });
    audio.update(dt);
  } else {
    driveT += dt;
    vehicle.setControls({
      throttle: ui.throttle,
      brake: ui.brake,
      steer: Math.sin(driveT * 0.55) * (0.35 + ui.slip * 0.65),
      handbrake: false,
    });
    vehicle.stepFixed(dt, ground);
    audio.update(dt, { vehicle });
    ui.rpm = audio.state.rpm;
    ui.speed = audio.state.speed * 3.6;
  }

  let radarRange = 60;
  if (ui.siren === 'pursuit') {
    radarRange = 400;
    stepFleet(dt);
  } else if (ui.siren !== 'off') {
    if (ui.orbit) {
      siren.angle += dt * (Math.PI * 2) / 9;
      siren.x = Math.sin(siren.angle) * siren.radius;
      siren.z = -Math.cos(siren.angle) * siren.radius;
    }
    audio.siren(0, { on: true, mode: ui.siren, gain: 0.6, position: siren });
    fleet.contacts = [{ x: siren.x, z: siren.z, voiced: true }];
  } else {
    fleet.contacts = [];
  }

  // ---- measure
  const L = analyseRms(anL, lrTime[0]);
  const R = analyseRms(anR, lrTime[1]);
  lastLR = { L, R };
  hist.acc += wall;   // the strip's axis is wall-clock seconds, not simulated ones
  let slots = 0;
  while (hist.acc >= 1 / HIST_HZ && slots < hist.n) {
    hist.acc -= 1 / HIST_HZ;
    slots++;
    hist.rpm.push(audio.state.rpm);
    hist.level.push(dbfs(Math.max(L.rms, R.rms)));
    hist.screech.push(audio.state.screech);
  }
  while (hist.rpm.length > hist.n) { hist.rpm.shift(); hist.level.shift(); hist.screech.shift(); }

  // ---- draw
  const W = window.innerWidth, H = window.innerHeight;
  ctx2d.fillStyle = COL.bg;
  ctx2d.fillRect(0, 0, W, H);

  const X = 320, PAD = 14;
  const w = W - X - PAD;
  const hTop = Math.round((H - PAD * 4) * 0.36);
  const hMid = Math.round((H - PAD * 4) * 0.36);
  const hBot = H - PAD * 4 - hTop - hMid;

  const rep = audio.report();
  drawScope(pane(X, PAD, w, hTop, 'OSCILLOSCOPE',
    `trigger-aligned  ·  engine ${Math.round(audio.state.rpm)} rpm  ·  gear ${rep.gear}  ·  load ${rep.load}`));
  drawSpectrum(pane(X, PAD * 2 + hTop, w, hMid, 'SPECTRUM',
    `${rep.sampleRate || 0} Hz  ·  4096-pt FFT  ·  log frequency, dBFS`));

  const yb = PAD * 3 + hTop + hMid;
  const wm = 190, wr = 240;
  drawMeters(pane(X, yb, wm, hBot, 'OUTPUT', 'L / R / limiter'), L, R, rep.limiterReductionDb);
  drawHistory(pane(X + wm + PAD, yb, w - wm - wr - PAD * 2, hBot, 'HISTORY', 'rpm · level · screech'));
  drawRadar(pane(X + w - wr, yb, wr, hBot, 'PANNER', 'listener-relative, top down'),
    fleet.contacts, radarRange);

  // ---- readout
  if (frames % 6 === 0) {
    $('stats').textContent =
      `ctx        ${rep.state}  ${rep.sampleRate} Hz\n` +
      `nodes      ${rep.nodes} live  (${rep.sources} sources)\n` +
      `draw calls ${rep.drawCalls}   buffers ${rep.buffers}\n` +
      `engine     ${rep.rpm} rpm  g${rep.gear}  load ${rep.load}${rep.limiting ? '  LIMIT' : ''}\n` +
      `tyres      ${rep.speedKmh} km/h  slip ${rep.slip}  scr ${rep.screech}\n` +
      `beds       day ${rep.beds.day}  night ${rep.beds.night}  rain ${rep.beds.rain}\n` +
      `master     ${dbfs(Math.max(L.peak, R.peak)).toFixed(1)} dBFS  GR ${rep.limiterReductionDb} dB\n` +
      `events     ${rep.shifts} shifts  ${rep.impacts} impacts  ${rep.droppedWhileSuspended} dropped\n` +
      `built in   ${rep.generationMs} ms`;
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ controls
function toggle(ids, onId) {
  for (const id of ids) $(id).classList.toggle('on', id === onId);
}

function slider(id, valId, fmt, apply) {
  const el = $(id);
  const run = () => { const v = Number(el.value); $(valId).textContent = fmt(v); apply(v); };
  el.addEventListener('input', run);
  run();
  return el;
}

slider('s-rpm', 'v-rpm', (v) => String(v), (v) => { ui.rpm = v; });
slider('s-thr', 'v-thr', (v) => (v / 100).toFixed(2), (v) => { ui.throttle = v / 100; });
slider('s-brk', 'v-brk', (v) => (v / 100).toFixed(2), (v) => { ui.brake = v / 100; });
slider('s-spd', 'v-spd', (v) => String(v), (v) => { ui.speed = v; });
slider('s-slip', 'v-slip', (v) => (v / 100).toFixed(2), (v) => { ui.slip = v / 100; });
slider('s-rain', 'v-rain', (v) => (v / 100).toFixed(2), (v) => {
  ui.rain = v / 100;
  audio.setWeather({ rain: ui.rain, wetness: Math.min(1, ui.rain * 1.25) }, 0.6);
});
slider('s-hour', 'v-hour', (v) => (v / 10).toFixed(1), (v) => {
  ui.hour = v / 10;
  ui.tod = null;
  audio.setTimeOfDay(ui.hour, 0.8);
  toggle(['b-noon', 'b-dusk', 'b-night'], null);
});

const setMode = (m) => {
  ui.mode = m;
  toggle(['b-bench', 'b-drive'], m === 'bench' ? 'b-bench' : 'b-drive');
  if (m === 'bench') {
    audio.setEngine({ rpm: ui.rpm, throttle: ui.throttle, brake: ui.brake });
    audio.setTyres({ speed: ui.speed / 3.6, slip: ui.slip });
  } else {
    audio.setEngine(null);
    audio.setTyres(null);
  }
};
$('b-bench').onclick = () => setMode('bench');
$('b-drive').onclick = () => setMode('drive');
$('b-mute').onclick = () => { $('b-mute').classList.toggle('on', audio.toggleMute()); };

const setSiren = (m) => {
  ui.siren = m;
  toggle(['b-sir-off', 'b-sir-wail', 'b-sir-yelp', 'b-sir-fleet'],
    m === 'off' ? 'b-sir-off' : m === 'wail' ? 'b-sir-wail' : m === 'yelp' ? 'b-sir-yelp' : 'b-sir-fleet');
  if (m === 'off') {
    audio.sirensOff();
    camera.position.set(0, 1.4, 0);
    camera.updateMatrixWorld();
  } else if (m === 'pursuit') {
    audio.sirensOff();
    ensureFleet();
  }
};
$('b-sir-off').onclick = () => setSiren('off');
$('b-sir-wail').onclick = () => setSiren('wail');
$('b-sir-yelp').onclick = () => setSiren('yelp');
$('b-sir-fleet').onclick = () => setSiren('pursuit');
$('b-orbit').onclick = () => { ui.orbit = !ui.orbit; $('b-orbit').classList.toggle('on', ui.orbit); };

const setTod = (name, btn) => {
  ui.tod = name;
  audio.setTimeOfDay(name, 1.2);
  toggle(['b-noon', 'b-dusk', 'b-night'], btn);
};
$('b-noon').onclick = () => setTod('noon', 'b-noon');
$('b-dusk').onclick = () => setTod('dusk', 'b-dusk');
$('b-night').onclick = () => setTod('night', 'b-night');
$('b-interior').onclick = () => {
  ui.interior = !ui.interior;
  audio.setInterior(ui.interior);
  $('b-interior').classList.toggle('on', ui.interior);
};

$('b-start').onclick = () => audio.stinger('start');
$('b-ok').onclick = () => audio.stinger('success');
$('b-fail').onclick = () => audio.stinger('fail');
$('b-tap').onclick = () => audio.impact(3);
$('b-crash').onclick = () => audio.impact(22);
$('b-vol').onclick = () => {
  const v = audio.volume > 0.5 ? 0.45 : 0.9;
  audio.setVolume(v);
  $('b-vol').textContent = `vol ${Math.round(v * 100)}%`;
};

const KEYS = {
  Digit1: () => setMode('bench'), Digit2: () => setMode('drive'),
  KeyM: () => $('b-mute').click(),
  KeyZ: () => setSiren('wail'), KeyX: () => setSiren('yelp'), KeyC: () => setSiren('off'),
  KeyP: () => setSiren('pursuit'),
  KeyQ: () => audio.stinger('start'), KeyE: () => audio.stinger('success'),
  KeyF: () => audio.stinger('fail'), Space: () => audio.impact(22),
  KeyI: () => $('b-interior').click(),
  KeyR: () => { $('s-rain').value = String(($('s-rain').valueAsNumber + 25) % 125); $('s-rain').dispatchEvent(new Event('input')); },
  KeyW: () => { $('s-rpm').value = String(Math.min(7100, $('s-rpm').valueAsNumber + 300)); $('s-rpm').dispatchEvent(new Event('input')); },
  KeyS: () => { $('s-rpm').value = String(Math.max(820, $('s-rpm').valueAsNumber - 300)); $('s-rpm').dispatchEvent(new Event('input')); },
  KeyD: () => { $('s-slip').value = String(Math.min(100, $('s-slip').valueAsNumber + 10)); $('s-slip').dispatchEvent(new Event('input')); },
  KeyA: () => { $('s-slip').value = String(Math.max(0, $('s-slip').valueAsNumber - 10)); $('s-slip').dispatchEvent(new Event('input')); },
};
window.addEventListener('keydown', (e) => {
  start();
  const fn = KEYS[e.code];
  if (fn) { e.preventDefault(); fn(); }
});

// ------------------------------------------------------------- gesture gate
let started = false;
async function start() {
  if (started) return;
  started = true;
  const ok = await audio.resume();
  const gate = $('gate');
  if (gate) gate.style.display = 'none';
  window.__lab.resumed = ok;
}
window.addEventListener('pointerdown', start);

// ---------------------------------------------------------------- lab hooks
window.__lab = {
  ready: false,
  resumed: false,
  audio,
  ui,
  fleet,
  ensureFleet,
  get stats() {
    return {
      ...audio.report(),
      mode: ui.mode,
      siren: ui.siren,
      peakDbfsL: +dbfs(lastLR.L.peak).toFixed(1),
      peakDbfsR: +dbfs(lastLR.R.peak).toFixed(1),
      rmsDbfsL: +dbfs(lastLR.L.rms).toFixed(1),
      rmsDbfsR: +dbfs(lastLR.R.rms).toFixed(1),
      frames,
      errors: errors.length,
    };
  },
  set(k, v) {
    const el = $(k);
    if (!el) return false;
    if (el.type === 'range') { el.value = String(v); el.dispatchEvent(new Event('input')); return true; }
    el.click();
    return true;
  },
  // Read the stereo tap right now. Software rendering paces the draw loop at
  // roughly 2 fps here, which is useless for measuring anything with a time
  // constant, so measurement must not be tied to it.
  measure() {
    const L = analyseRms(anL, lrTime[0]);
    const R = analyseRms(anR, lrTime[1]);
    return {
      peakL: +dbfs(L.peak).toFixed(1), peakR: +dbfs(R.peak).toFixed(1),
      rmsL: +dbfs(L.rms).toFixed(1), rmsR: +dbfs(R.rms).toFixed(1),
      gr: +audio.report().limiterReductionDb,
    };
  },
  // Advance the module by a fixed step, decoupled from wall clock, for testing
  // envelope and gearbox logic deterministically.
  tick(dt, n = 1) {
    for (let i = 0; i < n; i++) {
      if (ui.mode === 'bench') {
        audio.setEngine({ rpm: ui.rpm, throttle: ui.throttle, brake: ui.brake });
        audio.setTyres({ speed: ui.speed / 3.6, slip: ui.slip });
      }
      audio.update(dt);
    }
    return audio.report();
  },
  // Run a real src/vehicle.js Vehicle through the module's updateVehicle() path
  // at a fixed 60 Hz, faster than wall clock. This is the game's integration
  // path, just not paced by a renderer running at 2 fps.
  simDrive(seconds, throttle = 1, steerAmp = 0, brake = 0) {
    audio.setEngine(null); audio.setTyres(null);
    const step = 1 / 60;
    const seen = new Set();
    let t = 0, peak = 0;
    while (t < seconds) {
      vehicle.setControls({ throttle, brake, steer: Math.sin(t * 0.55) * steerAmp, handbrake: false });
      vehicle.stepFixed(step, ground);
      audio.updateVehicle(vehicle, step);
      seen.add(audio.state.gear);
      peak = Math.max(peak, audio.state.rpm);
      t += step;
    }
    const r = audio.report();
    return { shifts: r.shifts, gear: r.gear, kmh: r.speedKmh, gears: [...seen],
             peakRpm: Math.round(peak), impacts: r.impacts };
  },
  // Worst case on one bus: everything the module can make, at once. This is the
  // only state that should ever put the limiter to work, and the harness asserts
  // that it does and that the output still does not clip.
  stress() {
    this.set('s-rpm', 6950);
    this.set('s-thr', 100);
    this.set('s-spd', 190);
    this.set('s-slip', 100);
    this.set('s-rain', 100);
    setSiren('yelp');
    audio.stinger('fail');
    audio.impact(30);
    return true;
  },
};

requestAnimationFrame(frame);
window.__lab.ready = true;
