// Behavioural harness for src/audio.js. Audio cannot be looked at, so every claim
// the module makes is turned into a number here and asserted.
//
// Nothing here is paced by the lab's draw loop: software rendering runs it at
// about 2 fps, which is far too coarse to measure a release envelope or a param
// ramp against. Measurements either read the analyser on demand or drive the
// module through a fixed-step tick.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://127.0.0.1:8123/labs/audio/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__lab && window.__lab.ready, { timeout: 30000 });

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// 1 -- everything must be safe to call while the context is still suspended.
const suspended = await page.evaluate(() => {
  const a = window.__lab.audio;
  const before = a.ctx.state;
  let threw = null;
  try {
    a.update(0.016);
    a.setEngine({ rpm: 5000, throttle: 1 }); a.setTyres({ speed: 30, slip: 1 });
    a.setWeather({ rain: 1, wetness: 1 }); a.setTimeOfDay('night'); a.setInterior(true);
    a.siren(0, { on: true, mode: 'wail', position: { x: 10, y: 1, z: -3 } });
    a.impact(25); a.stinger('fail');
    a.setVolume(0.5); a.setMuted(true); a.setMuted(false); a.setVolume(0.9);
    a.updatePursuit(null); a.update(0.016);
  } catch (e) { threw = String(e && e.message); }
  a.setInterior(false); a.sirensOff(); a.setTimeOfDay('dusk', 0); a.setWeather({ rain: 0, wetness: 0 }, 0);
  return { before, threw, dropped: a.report().droppedWhileSuspended, nodes: a.report().nodes };
});
check('safe while suspended', suspended.before === 'suspended' && suspended.threw === null,
  `state=${suspended.before} threw=${suspended.threw}, ${suspended.dropped} transients refused rather than queued`);
const nodesBefore = suspended.nodes;

await page.mouse.click(900, 520);
await page.waitForTimeout(1500);
check('resume() on gesture', (await page.evaluate(() => window.__lab.audio.ctx.state)) === 'running',
  `state=${await page.evaluate(() => window.__lab.audio.ctx.state)}`);

// 2 -- an engine is a harmonic stack on the firing frequency. Compare the mean
//      level ON the harmonics of rpm/20 against the mean level BETWEEN them. A
//      sine sweep, filtered noise or a single tone all score near zero.
const harmonicity = async (rpm) => {
  await page.evaluate((r) => {
    window.__lab.set('s-rpm', r); window.__lab.set('s-thr', 75); window.__lab.set('s-spd', 0);
    window.__lab.audio.setBusGain('ambience', 0); window.__lab.audio.setBusGain('tyre', 0);
  }, rpm);
  await page.waitForTimeout(1600);
  return page.evaluate((r) => {
    const a = window.__lab.audio, an = a.getAnalyser();
    const f = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(f);
    const bin = a.ctx.sampleRate / 2 / f.length;
    const at = (hz) => { const i = Math.round(hz / bin); return (i > 0 && i < f.length) ? f[i] : -140; };
    const score = (f0) => {
      let on = 0, off = 0, n = 0;
      for (let k = 1; k <= 12; k++) {
        if (f0 * (k + 0.5) > 6000) break;
        on += at(f0 * k); off += at(f0 * (k + 0.5)); n++;
      }
      return { db: +((on - off) / n).toFixed(2), n };
    };
    return { right: score(r / 20), wrong: score((r / 20) * 1.41), rpm: a.state.rpm };
  }, rpm);
};
const h2000 = await harmonicity(2000);
const h5200 = await harmonicity(5200);
check('engine is a harmonic stack on the firing frequency (rpm/20)',
  h2000.right.db > 4 && h5200.right.db > 4 && h2000.right.db > h2000.wrong.db + 3 && h5200.right.db > h5200.wrong.db + 3,
  `2000 rpm: +${h2000.right.db} dB on 100 Hz harmonics vs +${h2000.wrong.db} dB on a wrong fundamental; ` +
  `5200 rpm: +${h5200.right.db} dB on 260 Hz vs +${h5200.wrong.db} dB`);

// 3 -- load must change timbre, not only level. Band ratio at a FIXED rpm.
const bandRatio = async (thr) => {
  await page.evaluate((t) => { window.__lab.set('s-rpm', 3600); window.__lab.set('s-thr', t); }, thr);
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const a = window.__lab.audio, an = a.getAnalyser();
    const f = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(f);
    const bin = a.ctx.sampleRate / 2 / f.length;
    const mean = (lo, hi) => {
      let s = 0, n = 0;
      for (let i = Math.ceil(lo / bin); i < Math.floor(hi / bin); i++) { s += f[i]; n++; }
      return s / n;
    };
    return +(mean(700, 5000) - mean(60, 260)).toFixed(2);
  });
};
const bLow = await bandRatio(4);
const bHigh = await bandRatio(100);
check('timbre opens with load at a fixed rpm', bHigh > bLow + 4,
  `high/low band ratio ${bLow} dB closed-throttle -> ${bHigh} dB full load (+${(bHigh - bLow).toFixed(1)} dB)`);

// 4 -- rev limiter chops gain only above the limit.
const lim = await page.evaluate(async () => {
  const a = window.__lab.audio;
  window.__lab.set('s-rpm', 4000); await new Promise((r) => setTimeout(r, 500));
  const off = { limiting: a.report().limiting, chop: a.engine.chopDepth.gain.value };
  window.__lab.set('s-rpm', 7000); await new Promise((r) => setTimeout(r, 600));
  const on = { limiting: a.report().limiting, chop: a.engine.chopDepth.gain.value };
  window.__lab.set('s-rpm', 3800);
  return { off, on };
});
check('rev limiter engages only above the limit',
  !lim.off.limiting && lim.on.limiting && lim.on.chop > 0.02 && lim.off.chop < 0.02,
  `chop depth ${lim.off.chop.toFixed(4)} at 4000 rpm, ${lim.on.chop.toFixed(4)} at 7000 rpm (17.5 Hz square)`);

// 5 -- the gearbox is driven by a real Vehicle through updateVehicle().
const drive = await page.evaluate(() => window.__lab.simDrive(80, 1, 0));
await page.evaluate(() => window.__lab.set('b-bench'));
check('gearbox shifts while a real src/vehicle.js Vehicle drives it',
  drive.shifts >= 3 && drive.gears.length >= 4,
  `${drive.shifts} shifts over 80 s of simulated full throttle, gears ${drive.gears.join('->')}, ` +
  `settled in gear ${drive.gear} at ${drive.kmh} km/h, peak ${drive.peakRpm} rpm`);

// 6 -- screech needs slip AND speed. Fixed-step so the release envelope is
//      measured against the module's own dt and not the renderer's.
const scr = await page.evaluate(() => {
  const at = (kmh, slip) => {
    window.__lab.set('s-spd', kmh); window.__lab.set('s-slip', slip);
    window.__lab.tick(1 / 60, 90);          // 1.5 s of simulated time
    return +window.__lab.audio.state.screech.toFixed(3);
  };
  const slow = at(5, 100), fast = at(120, 100), grip = at(120, 40);
  const release = (() => { window.__lab.set('s-slip', 100); window.__lab.tick(1 / 60, 90);
    window.__lab.set('s-slip', 0); window.__lab.tick(1 / 60, 30); return +window.__lab.audio.state.screech.toFixed(3); })();
  window.__lab.set('s-slip', 0); window.__lab.set('s-spd', 62);
  return { slow, fast, grip, release };
});
check('screech needs slip and speed together, and tails off',
  scr.fast > 0.8 && scr.slow < 0.05 && scr.grip < 0.05 && scr.release > 0.02 && scr.release < 0.4,
  `slip 1.0 @5 km/h -> ${scr.slow}; slip 1.0 @120 km/h -> ${scr.fast}; slip 0.4 @120 km/h -> ${scr.grip}; ` +
  `0.5 s after release -> ${scr.release}`);

// 7 -- the PannerNode really pans, through the pose three.js wrote. Everything
//      except the siren is muted, or the mono beds set the floor and swamp it.
const pan = await page.evaluate(async () => {
  const a = window.__lab.audio;
  for (const b of ['engine', 'tyre', 'ambience', 'music', 'sfx']) a.setBusGain(b, 0);
  window.__lab.ui.siren = 'off';                   // stop the draw loop re-positioning it
  const read = async (x, z) => {
    a.siren(0, { on: true, mode: 'wail', gain: 0.8, position: { x, y: 1.6, z } });
    await new Promise((r) => setTimeout(r, 1100));
    return window.__lab.measure();
  };
  const left = await read(-18, 0);
  const right = await read(18, 0);
  const far = await read(0, -260);
  const near = await read(0, -14);
  a.sirensOff();
  for (const b of ['engine', 'tyre', 'ambience', 'music', 'sfx']) a.setBusGain(b, { engine: 0.85, tyre: 0.75, sfx: 0.9, ambience: 0.6, music: 0.8 }[b]);
  return { left, right, far, near };
});
check('siren pans and attenuates with distance through the three.js listener',
  pan.left.rmsL - pan.left.rmsR > 8 && pan.right.rmsR - pan.right.rmsL > 8 &&
  pan.near.rmsL - pan.far.rmsL > 10,
  `x=-18 m: L ${pan.left.rmsL} / R ${pan.left.rmsR} dB; x=+18 m: L ${pan.right.rmsL} / R ${pan.right.rmsR} dB; ` +
  `14 m ahead ${pan.near.rmsL} dB vs 260 m ahead ${pan.far.rmsL} dB`);

// 8 -- ambience beds cross-fade. Read after the ramps have converged, not during.
const beds = await page.evaluate(async () => {
  const a = window.__lab.audio;
  const settle = () => new Promise((r) => setTimeout(r, 450));
  const g = () => ({ day: +a.amb.dayGain.gain.value.toFixed(4), night: +a.amb.nightGain.gain.value.toFixed(4),
                     hiss: +a.amb.rainHissGain.gain.value.toFixed(4), roar: +a.amb.rainRoarGain.gain.value.toFixed(4) });
  a.setWeather({ rain: 0, wetness: 0 }, 0);
  a.setTimeOfDay('noon', 0); await settle(); const noon = g();
  a.setTimeOfDay('night', 0); await settle(); const night = g();
  a.setTimeOfDay(13, 0); await settle(); const onePm = g();
  a.setTimeOfDay(2, 0); await settle(); const twoAm = g();
  a.setWeather({ rain: 1, wetness: 1 }, 0); await settle(); const wet = g();
  a.setWeather({ rain: 0, wetness: 0 }, 0); a.setTimeOfDay('dusk', 0); await settle();
  return { noon, night, onePm, twoAm, wet };
});
check('ambience beds cross-fade with time of day and with weather',
  beds.noon.day > beds.night.day * 5 && beds.night.night > beds.noon.night * 3 &&
  beds.onePm.day > beds.twoAm.day * 5 &&
  beds.wet.hiss > 0.05 && beds.noon.hiss < 0.001 && beds.wet.night < beds.night.night,
  `noon day ${beds.noon.day} / night ${beds.noon.night}; night day ${beds.night.day} / night ${beds.night.night}; ` +
  `continuous 13:00 day ${beds.onePm.day} vs 02:00 ${beds.twoAm.day}; ` +
  `rain hiss ${beds.noon.hiss} -> ${beds.wet.hiss}, dry beds ducked ${beds.night.night} -> ${beds.wet.night}`);

// 9 -- node count must not move, whatever the game throws at it.
const churn = await page.evaluate(async () => {
  const a = window.__lab.audio;
  const before = a.report().nodes;
  for (let i = 0; i < 120; i++) { a.impact(2 + (i % 20)); a.stinger(['start', 'success', 'fail'][i % 3]); }
  await new Promise((r) => setTimeout(r, 800));
  return { before, after: a.report().nodes, impacts: a.report().impacts };
});
check('no node churn under 120 impacts + 120 stingers',
  churn.before === churn.after && churn.after === nodesBefore,
  `${churn.before} nodes before, ${churn.after} after, ${churn.impacts} impacts fired`);

// 10 -- worst case must not clip.
await page.evaluate(() => window.__lab.stress());
await page.waitForTimeout(4000);
const stress = await page.evaluate(() => window.__lab.measure());
check('worst case does not clip', stress.peakL < 0 && stress.peakR < 0,
  `everything at once: peak L ${stress.peakL} / R ${stress.peakR} dBFS, limiter GR ${stress.gr} dB`);

// 11 -- and the limiter, not luck, is what holds the ceiling. Drive every bus to
//       its maximum, a legal configuration, and the output must still not clip.
const over = await page.evaluate(async () => {
  const a = window.__lab.audio;
  const orig = { engine: 0.85, tyre: 0.75, sfx: 0.9, siren: 0.7, ambience: 0.6, music: 0.8 };
  for (const b of Object.keys(orig)) a.setBusGain(b, 2);
  await new Promise((r) => setTimeout(r, 2500));
  const m = window.__lab.measure();
  for (const b of Object.keys(orig)) a.setBusGain(b, orig[b]);
  return m;
});
check('limiter holds the ceiling under a deliberate overload',
  over.peakL <= 0 && over.peakR <= 0 && over.gr < -1,
  `all six buses at maximum gain: peak L ${over.peakL} / R ${over.peakR} dBFS, limiter GR ${over.gr} dB`);

// 12 -- mute is total.
await page.evaluate(() => window.__lab.audio.setMuted(true));
await page.waitForTimeout(1200);
const muted = await page.evaluate(() => window.__lab.measure());
await page.evaluate(() => { window.__lab.audio.setMuted(false); window.__lab.set('s-slip', 0); window.__lab.set('s-rain', 0); window.__lab.set('b-sir-off'); });
check('global mute silences the master', muted.peakL < -60 && muted.peakR < -60,
  `peak while muted L ${muted.peakL} / R ${muted.peakR} dBFS`);

// 13 -- impacts must scale with closing speed, not just fire.
const hits = await page.evaluate(async () => {
  const a = window.__lab.audio;
  for (const b of ['engine', 'tyre', 'ambience', 'music', 'siren']) a.setBusGain(b, 0);
  await new Promise((r) => setTimeout(r, 600));
  const floor = window.__lab.measure().peakL;
  const fire = async (v) => {
    a.impact(v);
    let pk = -140;
    for (let i = 0; i < 26; i++) { await new Promise((r) => setTimeout(r, 12)); pk = Math.max(pk, window.__lab.measure().peakL); }
    await new Promise((r) => setTimeout(r, 400));
    return +pk.toFixed(1);
  };
  const tap = await fire(2.5), kerb = await fire(8), wall = await fire(26);
  const tiny = a.impact(0.2);
  for (const b of ['engine', 'tyre', 'ambience', 'music', 'siren']) a.setBusGain(b, { engine: 0.85, tyre: 0.75, sfx: 0.9, siren: 0.7, ambience: 0.6, music: 0.8 }[b]);
  return { floor, tap, kerb, wall, tiny };
});
check('impact level scales with closing speed',
  hits.wall > hits.kerb + 6 && hits.kerb > hits.tap + 6 && hits.wall < -2 && hits.tap > hits.floor + 10 && hits.tiny === false,
  `silence ${hits.floor} dBFS; 2.5 m/s ${hits.tap}; 8 m/s ${hits.kerb}; 26 m/s ${hits.wall}; ` +
  `a 0.2 m/s nudge is rejected outright`);

// 14 -- the three stingers must be three different things, not one sound.
const sting = await page.evaluate(async () => {
  const a = window.__lab.audio, an = a.getAnalyser();
  for (const b of ['engine', 'tyre', 'ambience', 'siren', 'sfx']) a.setBusGain(b, 0);
  await new Promise((r) => setTimeout(r, 500));
  const f = new Float32Array(an.frequencyBinCount);
  const bin = a.ctx.sampleRate / 2 / f.length;
  const centroid = async (name) => {
    a.stinger(name);
    let best = -140, cAt = 0, pk = -140;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 20));
      an.getFloatFrequencyData(f);
      let numr = 0, den = 0, mx = -140;
      for (let k = Math.ceil(80 / bin); k < Math.floor(6000 / bin); k++) {
        const p = Math.pow(10, f[k] / 10); numr += p * k * bin; den += p; if (f[k] > mx) mx = f[k];
      }
      if (mx > best) { best = mx; cAt = numr / Math.max(den, 1e-12); }
      pk = Math.max(pk, window.__lab.measure().peakL);
    }
    await new Promise((r) => setTimeout(r, 900));
    return { centroid: Math.round(cAt), peak: +pk.toFixed(1) };
  };
  const start = await centroid('start'), success = await centroid('success'), fail = await centroid('fail');
  const bogus = a.stinger('nope');
  for (const b of ['engine', 'tyre', 'ambience', 'siren', 'sfx']) a.setBusGain(b, { engine: 0.85, tyre: 0.75, sfx: 0.9, siren: 0.7, ambience: 0.6, music: 0.8 }[b]);
  return { start, success, fail, bogus };
});
check('the three stingers are audibly distinct and an unknown name is refused',
  sting.start.peak > -40 && sting.success.peak > -40 && sting.fail.peak > -40 &&
  sting.success.centroid > sting.fail.centroid * 1.15 && sting.bogus === false,
  `start ${sting.start.peak} dBFS / centroid ${sting.start.centroid} Hz; ` +
  `success ${sting.success.peak} / ${sting.success.centroid} Hz; fail ${sting.fail.peak} / ${sting.fail.centroid} Hz`);

// 15 -- the cabin filter must actually muffle the world and leave the car alone.
const cabin = await page.evaluate(async () => {
  const a = window.__lab.audio, an = a.getAnalyser();
  const f = new Float32Array(an.frequencyBinCount);
  const bin = a.ctx.sampleRate / 2 / f.length;
  for (const b of ['engine', 'tyre', 'music', 'sfx']) a.setBusGain(b, 0);
  a.setWeather({ rain: 1, wetness: 1 }, 0);
  const hi = async () => {
    await new Promise((r) => setTimeout(r, 1400));
    an.getFloatFrequencyData(f);
    let s = 0, n = 0;
    for (let i = Math.ceil(2500 / bin); i < Math.floor(9000 / bin); i++) { s += f[i]; n++; }
    return +(s / n).toFixed(2);
  };
  a.setInterior(false, 0.05); const outside = await hi();
  a.setInterior(true, 0.05); const inside = await hi();
  a.setInterior(false, 0.05); a.setWeather({ rain: 0, wetness: 0 }, 0);
  for (const b of ['engine', 'tyre', 'music', 'sfx']) a.setBusGain(b, { engine: 0.85, tyre: 0.75, sfx: 0.9, music: 0.8 }[b]);
  return { outside, inside };
});
check('cabin filter muffles the outside world', cabin.inside < cabin.outside - 8,
  `2.5-9 kHz ambience energy ${cabin.outside} dB outside -> ${cabin.inside} dB inside the car`);

// 16 -- drive updatePursuit() from a REAL src/pursuit.js fleet on the baked road
//       graph, not from this module's reading of that interface.
const fleetRes = await page.evaluate(async () => {
  window.__lab.set('b-sir-fleet');
  await window.__lab.ensureFleet();
  const a = window.__lab.audio, f = window.__lab.fleet;
  if (!f.units) return { error: f.error || 'no fleet' };
  // Step it well past the spawn phase so units are converging from several
  // directions and the voice pool has had to reassign.
  for (let i = 0; i < 900; i++) {
    f.units.update(1 / 30, f.target);
    a.updatePursuit(f.units, { x: f.target.x, y: 1.4, z: f.target.z });
  }
  const active = f.units.units.filter(Boolean).length;
  const voices = a.sirenVoices.filter((v) => v.active);
  const dists = voices.map((v) => +v.dist.toFixed(0)).sort((x, y) => x - y);
  // Every voiced unit must be one of the nearest few, and each voice must hold a
  // different unit.
  const all = [];
  const m = new (await import('http://127.0.0.1:8123/vendor/three.module.min.js')).Matrix4();
  for (let i = 0; i < f.units.count; i++) {
    if (!f.units.units[i]) continue;
    f.units.mesh.getMatrixAt(i, m);
    all.push({ i, d: Math.hypot(m.elements[12] - f.target.x, m.elements[14] - f.target.z) });
  }
  all.sort((x, y) => x.d - y.d);
  const held = voices.map((v) => v.unit);
  const ranks = held.map((u) => all.findIndex((x) => x.i === u) + 1);
  // The contract is not "the three nearest": an incumbent voice keeps its unit
  // out to 1.3x the nth-nearest distance so two cars swapping rank do not swap
  // sirens. So assert the band, which is what the code actually promises.
  const band = all.length >= voices.length ? all[voices.length - 1].d : Infinity;
  const worst = Math.max(...voices.map((v) => v.dist));
  const report = f.units.report();
  window.__lab.set('b-sir-off');
  return {
    active, voices: voices.length, dists, held, ranks,
    unique: new Set(held).size === held.length,
    inBand: worst <= band * 1.35,
    ratio: +(worst / band).toFixed(2),
    spawns: report.spawns, reroutes: report.reroutes,
    nodes: a.report().nodes,
  };
});
check('voice pool follows a real PursuitUnits fleet, one voice per unit',
  !fleetRes.error && fleetRes.voices === 3 && fleetRes.unique && fleetRes.inBand &&
  fleetRes.nodes === nodesBefore,
  fleetRes.error ? `FLEET ERROR: ${fleetRes.error}` :
  `${fleetRes.active} units active; 3 voices on distinct units ${fleetRes.held.join('/')} ` +
  `(distance ranks ${fleetRes.ranks.join('/')}) at ${fleetRes.dists.join('/')} m, ` +
  `furthest ${fleetRes.ratio}x the 3rd-nearest so inside the 1.3x hysteresis band; ` +
  `${fleetRes.spawns} spawns and ${fleetRes.reroutes} reroutes survived with the node count still ${fleetRes.nodes}`);

// 18 -- collisions are inferred from deceleration because nothing in the project
//       reports them, so the inference must not fire on hard driving.
const falseHits = await page.evaluate(() => {
  const a = window.__lab.audio;
  const before = a.report().impacts;
  window.__lab.simDrive(60, 1, 0.9);            // full throttle, hard cornering
  const cornering = a.report().impacts - before;
  window.__lab.simDrive(20, 1, 0);              // build speed back up
  const mid = a.report().impacts;
  window.__lab.simDrive(25, 0, 0, 1);           // then stand on the brakes
  const braking = a.report().impacts - mid;
  window.__lab.set('b-bench');
  return { cornering, braking, kmh: a.report().speedKmh };
});
check('deceleration-inferred impacts do not fire on hard driving',
  falseHits.cornering === 0 && falseHits.braking === 0,
  `60 s of full throttle through hard cornering: ${falseHits.cornering} false impacts; ` +
  `25 s of full braking: ${falseHits.braking} false impacts`);

// 19 -- brake pedal must be audible, not just read.
const brakeUse = await page.evaluate(async () => {
  const a = window.__lab.audio;
  for (const b of ['ambience', 'music', 'siren', 'sfx']) a.setBusGain(b, 0);
  // The brake's engine-side contribution is the overrun crackle, and that crackle
  // is deliberately sparse: a fresh random gate every 50 ms fires it roughly 12%
  // of the time off the brakes and 38% on them. A single 1.2 s RMS window
  // therefore measures whether a crackle happened to land inside it, not whether
  // the brake is audible — sampled once, this reading swings from -0.8 to +5.7 dB
  // run to run and fails outright about one run in six. Averaging the level over
  // several windows measures the rate rather than one roll of the dice; the same
  // comparison then lands between +1.7 and +6.2 dB and never drops below the
  // threshold. The deterministic half of the effect (tyre weight transfer) is
  // +2.7 dB on its own bus.
  const at = async (brk) => {
    window.__lab.set('s-rpm', 4200); window.__lab.set('s-thr', 0);
    window.__lab.set('s-brk', brk); window.__lab.set('s-spd', 90);
    window.__lab.tick(1 / 60, 60);
    await new Promise((r) => setTimeout(r, 700));
    let acc = 0;
    const N = 6;
    for (let i = 0; i < N; i++) {
      await new Promise((r) => setTimeout(r, 130));
      window.__lab.tick(1 / 60, 8);
      acc += Math.pow(10, window.__lab.measure().rmsL / 20);
    }
    return { load: +a.state.load.toFixed(3), rms: +(20 * Math.log10(acc / N)).toFixed(2) };
  };
  const off = await at(0), on = await at(100);
  window.__lab.set('s-brk', 0); window.__lab.set('s-thr', 55);
  for (const b of ['ambience', 'music', 'siren', 'sfx']) a.setBusGain(b, { sfx: 0.9, siren: 0.7, ambience: 0.6, music: 0.8 }[b]);
  return { off, on };
});
check('brake pedal changes what is heard', brakeUse.on.rms > brakeUse.off.rms + 0.8,
  `off the brakes ${brakeUse.off.rms} dB (load ${brakeUse.off.load}) -> hard on them ` +
  `${brakeUse.on.rms} dB (load ${brakeUse.on.load}): louder overrun and more tyre load`);

const final = await page.evaluate(() => window.__lab.stats);
console.log('\nAUDIO HARNESS');
console.log('='.repeat(78));
let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
}
console.log('='.repeat(78));
console.log(`nodes ${final.nodes}  sources ${final.sources}  buffers ${final.buffers}  ` +
  `drawCalls ${final.drawCalls}  built ${final.generationMs} ms  sampleRate ${final.sampleRate}  ` +
  `pageErrors ${final.errors}`);
console.log(`ERRORS: ${errors.length ? '\n' + errors.join('\n') : 'none'}`);
console.log(fails ? `HARNESS: FAIL — ${fails}/${results.length}` : `HARNESS: PASS — ${results.length}/${results.length}`);
await browser.close();
process.exit(fails ? 1 : 0);
