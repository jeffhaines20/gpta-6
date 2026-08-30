// Procedural game audio. Every sound is synthesised at run time from oscillators,
// filters and noise buffers built in code: there is no sample, no audio file and
// no base64 blob anywhere in this module or its lab.
//
// Three rules shape the design.
//
//   1. Nodes are created once, at construction, and never again. A driving game
//      fires impacts, gear changes and tyre chirps at a rate where per-event node
//      churn hands the audio thread a steady stream of allocation and teardown.
//      Every transient here is instead an envelope written onto a node that has
//      been alive since startup, so `report().nodes` is a constant. If that number
//      ever moves during play, something has regressed.
//
//   2. Nothing throws before the first user gesture. Browsers construct every
//      AudioContext suspended; the graph is therefore built AND started while
//      suspended, and `resume()` is the only call the game must remember. Every
//      public method is safe to call at any time and in any state.
//
//   3. An engine is a harmonic stack moving through fixed resonances, not a pitch
//      ramp. The oscillator bank sweeps with RPM while the formant filters stay
//      put, so partials cross resonant peaks and the timbre changes shape as the
//      revs climb. That crossing is the whole difference between an engine and a
//      siren sweep, and it is why the formants are absolutely not RPM-tracked.

import * as THREE from '../vendor/three.module.min.js';

// --------------------------------------------------------------- powertrain
// Ratios chosen so the shift ladder lands where src/vehicle.js actually drives:
// engineForce 7000 N on 1400 kg tops out around 45 m/s, and wheelRadius is 0.36.
// rpm per m/s = (60 / 2*pi*r) * gear * final.
const GEARS = [4.20, 2.55, 1.78, 1.32, 1.02, 0.82];
const FINAL_DRIVE = 3.85;
const IDLE_RPM = 820;
const SHIFT_UP_RPM = 6250;
const SHIFT_DOWN_RPM = 2500;
const LIMIT_RPM = 6900;
const MAX_RPM = 7100;
const SHIFT_TIME = 0.15;          // s of interrupted drive across a change
// Six-cylinder four-stroke: three firing events per crank revolution, so the
// fundamental the ear hears is rpm/20 Hz. 820 rpm idles at 41 Hz; the limiter
// sits at 345 Hz. Everything else in the bank is a ratio of this.
const FIRING_DIVISOR = 20;

// ------------------------------------------------------------------ helpers
// Deterministic noise. Seeded so two runs of the lab produce byte-identical
// buffers; a "random" texture that changes per load cannot be regression-tested.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

// Hermite ramp. Used everywhere a threshold would otherwise click on and off —
// tyre screech in particular, which crosses its trigger many times a second in
// normal cornering.
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function whiteNoiseBuffer(ctx, seconds, rand) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
  // Taper the seam so the loop point is not an audible tick every N seconds.
  const w = Math.min(1024, len >> 2);
  for (let i = 0; i < w; i++) {
    const f = i / w;
    d[i] *= f;
    d[len - 1 - i] = d[len - 1 - i] * f + d[w - 1 - i] * (1 - f);
  }
  return buf;
}

// Pink noise via Paul Kellet's economy filter: -3 dB/octave, which is what road
// roar, rain and distant traffic all actually measure as. White noise used raw
// for those beds sounds like a hiss generator, because it is one.
function pinkNoiseBuffer(ctx, seconds, rand) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  const wn = Math.min(1024, len >> 2);
  for (let i = 0; i < wn; i++) {
    const f = i / wn;
    d[i] *= f;
    d[len - 1 - i] = d[len - 1 - i] * f + d[wn - 1 - i] * (1 - f);
  }
  return buf;
}

// Master-bus ceiling: linear below the knee, then a tanh bend that reaches
// exactly 1.0 and never exceeds it.
//
// The obvious formulation, tanh(kx)/tanh(k), is WRONG here and was measured to be
// wrong: normalising so the curve hits 1.0 at x=1 gives it a slope of k/tanh(k)
// at the origin, so at k=1.9 it is a hidden +6 dB gain stage on every signal
// quiet enough not to need clipping at all. The bench read -1 dBFS with the
// limiter showing zero reduction because this curve, not the limiter, was setting
// the level. Slope at the knee is 1 on both sides, so below -2.9 dBFS this is
// mathematically a wire.
function softClipCurve(n = 2048, knee = 0.72) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return c;
}

// Asymmetric drive for the engine. Symmetric clipping produces odd harmonics only
// and reads as a fuzz pedal; a real exhaust has strong even harmonics, which come
// from the two halves of the waveform being treated differently. Unity slope at
// the origin for the same reason as above — the amount of drive must be set by
// the gain in front of the shaper and nowhere else, or it cannot be automated
// from engine load. The DC offset asymmetry introduces is removed by the highpass
// after the shaper.
function driveCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const k = x >= 0 ? 3.1 : 1.9;
    c[i] = Math.tanh(k * x) / k;
  }
  return c;
}

// A pulse train whose harmonic amplitudes are combed rather than smooth. A clean
// 1/n sawtooth reads as a synth; the comb puts notches in the series so the
// spectrum has structure of its own before the formants get to it.
function exhaustWave(ctx, harmonics = 26, comb = 2.1) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    imag[n] = (1 / Math.pow(n, 0.92)) * (0.55 + 0.45 * Math.cos(n * comb));
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

// Electronic siren horn: a driver in a horn flare, which is a square-ish source
// with the even harmonics suppressed and a strong 3rd/5th.
function hornWave(ctx) {
  const N = 12;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  const amp = [0, 1.0, 0.18, 0.62, 0.12, 0.38, 0.08, 0.22, 0.05, 0.14, 0.04, 0.09, 0.03];
  for (let n = 1; n <= N; n++) imag[n] = amp[n];
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

// Struck-body wave for the stingers: a metallophone-ish partial set. Inharmonic
// enough to read as struck metal rather than as an organ.
function stingerWave(ctx) {
  const N = 9;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  const amp = [0, 1.0, 0.34, 0.52, 0.13, 0.28, 0.07, 0.16, 0.05, 0.09];
  for (let n = 1; n <= N; n++) imag[n] = amp[n];
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

// Procedural room impulse: exponentially decaying noise plus a handful of early
// reflections at prime-ish delays, so the tail is diffuse and does not ring.
function roomImpulse(ctx, seconds, decay, rand) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const taps = [0.011, 0.019, 0.031, 0.043, 0.061, 0.079];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (rand() * 2 - 1) * Math.pow(1 - t, decay) * 0.55;
    }
    taps.forEach((tap, k) => {
      const i = Math.floor(tap * (1 + ch * 0.07) * ctx.sampleRate);
      if (i < len) d[i] += (k % 2 ? -1 : 1) * 0.42 / (k + 1);
    });
  }
  return buf;
}

// ------------------------------------------------------------- ambience mixes
// Bed weights per time of day. Named to match src/daynight.js PRESETS so the
// game can pass the preset name straight through.
const TOD_BEDS = {
  noon:  { day: 1.00, night: 0.02 },
  dusk:  { day: 0.48, night: 0.55 },
  night: { day: 0.06, night: 1.00 },
};

// ------------------------------------------------------------- stinger motifs
// Original interval patterns, written as scale-degree offsets in semitones from a
// root. They are shapes (rising modal fanfare, major arpeggio to the tenth,
// descending minor with a detuned tail), not transcriptions: no melody that
// exists is reproduced here.
const STINGERS = {
  start: {
    root: 146.83, gain: 0.85, reverb: 0.30, thud: 0,
    notes: [
      { t: 0.00, s: -12, d: 0.60, v: 0.85 },
      { t: 0.00, s: 0, d: 0.55, v: 0.45 },
      { t: 0.11, s: 7, d: 0.42, v: 0.70 },
      { t: 0.22, s: 10, d: 0.36, v: 0.62 },
      { t: 0.33, s: 14, d: 0.85, v: 0.90 },
      { t: 0.33, s: 2, d: 0.85, v: 0.40 },
    ],
  },
  success: {
    root: 174.61, gain: 0.85, reverb: 0.45, thud: 0,
    notes: [
      { t: 0.00, s: 0, d: 0.34, v: 0.62 },
      { t: 0.10, s: 4, d: 0.32, v: 0.66 },
      { t: 0.20, s: 7, d: 0.32, v: 0.72 },
      { t: 0.30, s: 12, d: 0.34, v: 0.78 },
      { t: 0.42, s: 16, d: 1.20, v: 0.92 },
      { t: 0.42, s: 7, d: 1.20, v: 0.42 },
      { t: 0.42, s: -5, d: 1.20, v: 0.36 },
    ],
  },
  fail: {
    root: 138.59, gain: 0.9, reverb: 0.55, thud: 7.5,
    notes: [
      { t: 0.00, s: 0, d: 0.44, v: 0.80 },
      { t: 0.00, s: -12, d: 0.90, v: 0.55 },
      { t: 0.17, s: -3, d: 0.42, v: 0.66 },
      { t: 0.36, s: -8, d: 0.46, v: 0.60 },
      { t: 0.58, s: -12, d: 1.35, v: 0.78, detune: -22 },
      { t: 0.58, s: -15, d: 1.35, v: 0.52, detune: 14 },
    ],
  },
};

export const STINGER_NAMES = Object.keys(STINGERS);

// ============================================================================

export class GameAudio {
  constructor(opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

    this.available = false;
    this.ctx = null;
    this._nodes = [];
    this._sources = [];
    this._started = false;
    this._dropped = 0;              // transients refused because ctx was suspended
    this._volume = clamp(num(opts.volume, 0.9), 0, 1);
    this._muted = !!opts.muted;
    this._autoImpacts = opts.autoImpacts !== false;

    // Live state, all readable through report() so the lab and any future gate
    // can assert on it rather than on what the graph sounds like.
    this.state = {
      rpm: IDLE_RPM, gear: 0, load: 0, speed: 0, forwardSpeed: 0,
      throttle: 0, brake: 0, slip: 0, screech: 0, limiting: false,
      shiftT: 0, shifts: 0, impacts: 0, wheelspin: 0,
      day: 0.48, night: 0.55, rain: 0, wetness: 0, interior: 0,
      sirenVoices: 0,
    };
    this._manual = null;            // bench override: { rpm, throttle }
    this._manualTyres = null;       // bench override: { speed, slip }
    this._prevSpeed = 0;
    this._idlePhase = 0;
    this._crackle = 0;

    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) {
      // Headless / unsupported: every method below no-ops. The game must not have
      // to branch on whether audio exists.
      this.generationMs = 0;
      return;
    }
    try {
      this.ctx = new AC({ latencyHint: opts.latencyHint || 'interactive' });
    } catch (e) {
      this.generationMs = 0;
      return;
    }

    // Hand three the same context BEFORE anything creates a THREE.AudioListener,
    // otherwise three quietly builds a second context and the listener pose is
    // written to a graph nothing is playing through.
    try { THREE.AudioContext.setContext(this.ctx); } catch (e) { /* older builds */ }

    const rand = mulberry32(opts.seed ?? 0xa11d10);
    this._buildMaster();
    this._buildNoise(rand);
    this._buildEngine(rand);
    this._buildTyres();
    this._buildImpacts();
    this._buildSirens();
    this._buildAmbience();
    this._buildMusic(rand);

    this.available = true;
    this._startSources();
    this._applyOutputGains();
    this.setTimeOfDay(opts.timeOfDay || 'dusk', 0);
    this.setWeather({ rain: 0, wetness: 0 }, 0);

    this.generationMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  // Every node in the graph goes through here, which is what makes the count in
  // report() a fact rather than a claim.
  _reg(node) { this._nodes.push(node); return node; }

  _gain(v = 1) { const g = this.ctx.createGain(); g.gain.value = v; return this._reg(g); }

  _filter(type, freq, q = 1, gainDb = 0) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = this._safeFreq(freq);
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return this._reg(f);
  }

  _osc(type, freq, detune = 0) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.value = this._safeFreq(freq);
    o.detune.value = detune;
    this._sources.push(o);
    return this._reg(o);
  }

  _noiseSource(buffer) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    this._sources.push(s);
    return this._reg(s);
  }

  _safeFreq(f) { return clamp(num(f, 440), 1, this.ctx.sampleRate * 0.5 - 120); }

  // ------------------------------------------------------------------ master
  _buildMaster() {
    const ctx = this.ctx;
    this.mix = this._gain(1);

    // Limiter first, volume after: the limiter then guarantees the headroom and
    // the user's volume can only ever attenuate it, so no setting of the volume
    // control can reintroduce clipping.
    this.limiter = this._reg(ctx.createDynamicsCompressor());
    this.limiter.threshold.value = -7;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.14;

    this.makeup = this._gain(1.8);
    this.softClip = this._reg(ctx.createWaveShaper());
    this.softClip.curve = softClipCurve();
    this.softClip.oversample = '2x';

    this.master = this._gain(this._volume);
    this.mute = this._gain(this._muted ? 0 : 1);
    this.analyser = this._reg(ctx.createAnalyser());
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;

    this.mix.connect(this.limiter);
    this.limiter.connect(this.makeup);
    this.makeup.connect(this.softClip);
    this.softClip.connect(this.master);
    this.master.connect(this.mute);
    this.mute.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Sub-buses. Each is a single mix point the game can duck independently.
    this.bus = {
      engine: this._gain(0.85),
      tyre: this._gain(0.75),
      sfx: this._gain(0.9),
      siren: this._gain(0.7),
      ambience: this._gain(0.6),
      music: this._gain(0.8),
    };
    // The cabin muffles the world but not the car. Only ambience and sirens run
    // through the interior filter; the engine you are sitting on top of does not.
    this.interiorLP = this._filter('lowpass', 20000, 0.7);
    this.bus.ambience.connect(this.interiorLP);
    this.bus.siren.connect(this.interiorLP);
    this.interiorLP.connect(this.mix);
    this.bus.engine.connect(this.mix);
    this.bus.tyre.connect(this.mix);
    this.bus.sfx.connect(this.mix);
    this.bus.music.connect(this.mix);
  }

  _buildNoise(rand) {
    // Two shared loops fanned out to every noise consumer in the graph. Four
    // seconds is long enough that the loop is not a perceptible period and short
    // enough that the pair costs under 1.5 MB at 44.1 kHz.
    this.whiteBuf = whiteNoiseBuffer(this.ctx, 4.0, rand);
    this.pinkBuf = pinkNoiseBuffer(this.ctx, 4.0, rand);
    this.white = this._noiseSource(this.whiteBuf);
    this.pink = this._noiseSource(this.pinkBuf);
  }

  // ------------------------------------------------------------------ engine
  _buildEngine(rand) {
    const wave = exhaustWave(this.ctx);
    const e = this.engine = {};

    // Oscillator bank. The half-order partial is what makes the idle lumpy: real
    // engines are not periodic at the firing rate, they are periodic at the crank
    // rate, and the difference is audible as a beat you cannot get from harmonics
    // alone.
    e.bank = [
      { osc: this._osc(wave, 20), gain: this._gain(0.0), mul: 0.5, level: 0.50 },
      { osc: this._osc(wave, 41), gain: this._gain(0.0), mul: 1.0, level: 1.00 },
      { osc: this._osc('sawtooth', 82), gain: this._gain(0.0), mul: 2.0, level: 0.42 },
      { osc: this._osc('sawtooth', 123, 9), gain: this._gain(0.0), mul: 3.0, level: 0.24 },
    ];
    e.sum = this._gain(1);
    for (const b of e.bank) { b.osc.connect(b.gain); b.gain.connect(e.sum); }

    e.pre = this._gain(1);
    // Direct path plus three PARALLEL fixed formants. Bandpass-only would throw
    // away the body of the tone; this keeps it and adds resonant peaks on top.
    e.direct = this._gain(0.55);
    e.sum.connect(e.direct); e.direct.connect(e.pre);
    e.formants = [
      { bp: this._filter('bandpass', 105, 3.5), g: this._gain(1.05) },
      { bp: this._filter('bandpass', 420, 5.0), g: this._gain(0.70) },
      { bp: this._filter('bandpass', 1350, 7.0), g: this._gain(0.34) },
    ];
    for (const f of e.formants) { e.sum.connect(f.bp); f.bp.connect(f.g); f.g.connect(e.pre); }

    // Intake / induction noise. Saturates with the rest of the signal, which is
    // why it joins before the shaper and not after.
    e.intakeBP = this._filter('bandpass', 700, 0.9);
    e.intakeGain = this._gain(0);
    this.white.connect(e.intakeBP); e.intakeBP.connect(e.intakeGain); e.intakeGain.connect(e.pre);

    e.shaper = this._reg(this.ctx.createWaveShaper());
    e.shaper.curve = driveCurve();
    e.shaper.oversample = '2x';
    e.dcBlock = this._filter('highpass', 32, 0.6);
    e.lp = this._filter('lowpass', 900, 0.9);
    e.out = this._gain(0);

    e.pre.connect(e.shaper);
    e.shaper.connect(e.dcBlock);
    e.dcBlock.connect(e.lp);
    e.lp.connect(e.out);
    e.out.connect(this.bus.engine);

    // Rev limiter. A production limiter cuts spark, and what you hear is the
    // gain being chopped at a fixed rate rather than the pitch stopping. The
    // square LFO sums onto out.gain's intrinsic value, so depth 0 is silence
    // from this path and no extra cost when the limiter is not engaged.
    e.chopOsc = this._osc('square', 17.5);
    e.chopDepth = this._gain(0);
    e.chopOsc.connect(e.chopDepth);
    e.chopDepth.connect(e.out.gain);

    e.rand = rand;
  }

  // ------------------------------------------------------------------- tyres
  _buildTyres() {
    const t = this.tyre = {};
    t.rollBP = this._filter('bandpass', 120, 0.7);
    t.rollGain = this._gain(0);
    this.pink.connect(t.rollBP); t.rollBP.connect(t.rollGain); t.rollGain.connect(this.bus.tyre);

    t.rumbleLP = this._filter('lowpass', 90, 0.9);
    t.rumbleGain = this._gain(0);
    this.pink.connect(t.rumbleLP); t.rumbleLP.connect(t.rumbleGain); t.rumbleGain.connect(this.bus.tyre);

    // Wet road: tyres on standing water are a broadband hiss on top of the roll,
    // scaled by speed and by how wet the surface is.
    t.wetHP = this._filter('highpass', 1700, 0.7);
    t.wetGain = this._gain(0);
    this.white.connect(t.wetHP); t.wetHP.connect(t.wetGain); t.wetGain.connect(this.bus.tyre);

    // Screech is two very high-Q bands, not filtered noise: a slipping tyre is a
    // stick-slip oscillator with a strong pitched component and a subharmonic.
    t.scrOut = this._gain(0);
    t.scrBP1 = this._filter('bandpass', 1150, 14);
    t.scrG1 = this._gain(1.0);
    t.scrBP2 = this._filter('bandpass', 2360, 21);
    t.scrG2 = this._gain(0.55);
    this.white.connect(t.scrBP1); t.scrBP1.connect(t.scrG1); t.scrG1.connect(t.scrOut);
    this.white.connect(t.scrBP2); t.scrBP2.connect(t.scrG2); t.scrG2.connect(t.scrOut);
    t.scrOut.connect(this.bus.tyre);

    // The warble is what stops it sounding like a test tone. Real squeal wanders.
    t.warbleOsc = this._osc('sine', 7.3);
    t.warbleDepth = this._gain(70);
    t.warbleOsc.connect(t.warbleDepth);
    t.warbleDepth.connect(t.scrBP1.frequency);
    t.warbleDepth.connect(t.scrBP2.frequency);
  }

  // ----------------------------------------------------------------- impacts
  _buildImpacts() {
    // Four voices, round-robin. Each is a pitched body (the panel and chassis
    // ringing) plus a noise crunch band, both permanently wired and silent until
    // an envelope is written on them.
    this.impactVoices = [];
    for (let i = 0; i < 4; i++) {
      const v = {
        osc: this._osc('triangle', 90),
        bodyGain: this._gain(0),
        bp: this._filter('bandpass', 1400, 1.1),
        noiseGain: this._gain(0),
        free: 0,
      };
      v.osc.connect(v.bodyGain); v.bodyGain.connect(this.bus.sfx);
      this.white.connect(v.bp); v.bp.connect(v.noiseGain); v.noiseGain.connect(this.bus.sfx);
      this.impactVoices.push(v);
    }
    this._impactCursor = 0;
  }

  // ------------------------------------------------------------------ sirens
  _buildSirens() {
    const wave = hornWave(this.ctx);
    // Two shared modulators. Both are always running; a voice picks its mode by
    // opening one depth gain and closing the other, which cross-fades between
    // wail and yelp instead of switching discontinuously.
    this.wailLFO = this._osc('triangle', 0.30);
    this.yelpLFO = this._osc('sawtooth', 4.2);

    this.sirenVoices = [];
    for (let i = 0; i < 3; i++) {
      const v = {
        osc: this._osc(wave, 900),
        bp: this._filter('bandpass', 1250, 1.1),
        gain: this._gain(0),
        panner: this._reg(this.ctx.createPanner()),
        wailDepth: this._gain(0),
        yelpDepth: this._gain(0),
        unit: -1, mode: 'wail', active: false,
      };
      v.panner.panningModel = 'equalpower';   // HRTF is far dearer and pointless
      v.panner.distanceModel = 'inverse';     // on a bus already summed to stereo
      v.panner.refDistance = 14;
      v.panner.maxDistance = 400;
      v.panner.rolloffFactor = 1.15;
      // Each voice detunes slightly so three cars do not phase-lock into one horn.
      v.osc.detune.value = (i - 1) * 24;
      v.osc.connect(v.bp); v.bp.connect(v.gain); v.gain.connect(v.panner);
      v.panner.connect(this.bus.siren);
      this.wailLFO.connect(v.wailDepth); v.wailDepth.connect(v.osc.frequency);
      this.yelpLFO.connect(v.yelpDepth); v.yelpDepth.connect(v.osc.frequency);
      this.sirenVoices.push(v);
    }
  }

  // ---------------------------------------------------------------- ambience
  _buildAmbience() {
    const a = this.amb = {};
    a.mix = this._gain(1);
    a.mix.connect(this.bus.ambience);

    // Day: distant traffic roar with a slow swell, plus a thin air layer.
    a.dayBP = this._filter('bandpass', 420, 0.55);
    a.dayGain = this._gain(0);
    this.pink.connect(a.dayBP); a.dayBP.connect(a.dayGain); a.dayGain.connect(a.mix);
    a.dayHissHP = this._filter('highpass', 2200, 0.6);
    a.dayHissGain = this._gain(0);
    this.white.connect(a.dayHissHP); a.dayHissHP.connect(a.dayHissGain); a.dayHissGain.connect(a.mix);
    a.swellOsc = this._osc('sine', 0.068);
    a.swellDepth = this._gain(150);
    a.swellOsc.connect(a.swellDepth); a.swellDepth.connect(a.dayBP.frequency);

    // Night: the roar drops away and what is left is low rumble, a mains-frequency
    // hum off the transformers and street lighting, and a thin high air.
    a.nightLP = this._filter('lowpass', 260, 0.8);
    a.nightGain = this._gain(0);
    this.pink.connect(a.nightLP); a.nightLP.connect(a.nightGain); a.nightGain.connect(a.mix);
    a.nightAirBP = this._filter('bandpass', 5200, 1.4);
    a.nightAirGain = this._gain(0);
    this.white.connect(a.nightAirBP); a.nightAirBP.connect(a.nightAirGain); a.nightAirGain.connect(a.mix);
    a.droneOsc = this._osc('sine', 57.5);
    a.droneGain = this._gain(0);
    a.droneOsc.connect(a.droneGain); a.droneGain.connect(a.mix);

    // Rain: three layers because rain is three things at once — a near spatter, a
    // broadband hiss, and a far roar. Driving them from one gain sounds like a
    // hiss knob; driving them separately lets drizzle and downpour differ in
    // spectrum, not just level.
    a.rainHP = this._filter('highpass', 1400, 0.7);
    a.rainHissGain = this._gain(0);
    this.white.connect(a.rainHP); a.rainHP.connect(a.rainHissGain); a.rainHissGain.connect(a.mix);
    a.rainBP = this._filter('bandpass', 3600, 0.8);
    a.rainSpatterGain = this._gain(0);
    this.white.connect(a.rainBP); a.rainBP.connect(a.rainSpatterGain); a.rainSpatterGain.connect(a.mix);
    a.rainRoarLP = this._filter('lowpass', 700, 0.7);
    a.rainRoarGain = this._gain(0);
    this.pink.connect(a.rainRoarLP); a.rainRoarLP.connect(a.rainRoarGain); a.rainRoarGain.connect(a.mix);
    a.gustOsc = this._osc('sine', 0.127);
    a.gustDepth = this._gain(420);
    a.gustOsc.connect(a.gustDepth); a.gustDepth.connect(a.rainHP.frequency);
  }

  // ---------------------------------------------------------------- stingers
  _buildMusic(rand) {
    const wave = stingerWave(this.ctx);
    this.musicVoices = [];
    for (let i = 0; i < 4; i++) {
      const v = { osc: this._osc(wave, 220), lp: this._filter('lowpass', 2200, 0.9), gain: this._gain(0), free: 0 };
      v.osc.connect(v.lp); v.lp.connect(v.gain); v.gain.connect(this.bus.music);
      this.musicVoices.push(v);
    }
    this.reverbSend = this._gain(0.35);
    this.convolver = this._reg(this.ctx.createConvolver());
    this.convolver.buffer = roomImpulse(this.ctx, 1.35, 3.4, rand);
    this.reverbReturn = this._gain(0.9);
    this.bus.music.connect(this.reverbSend);
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.mix);
  }

  // Oscillators and buffer sources can only be started once, ever. Starting them
  // here — while the context is still suspended — means resume() has nothing to
  // coordinate and no ordering bug is possible.
  _startSources() {
    if (this._started) return;
    const t = this.ctx.currentTime;
    for (const s of this._sources) { try { s.start(t); } catch (e) { /* already started */ } }
    this._started = true;
  }

  // ------------------------------------------------------------------- state
  // setTargetAtTime allocates a scheduler event every call. At 60 Hz across ~35
  // continuously-driven params that is 2,100 events a second for values that
  // mostly have not changed, so a param is only rewritten when it actually moved.
  _set(param, value, tc = 0.03) {
    const v = num(value, 0);
    if (Math.abs((param.__last ?? Number.NaN) - v) < 1e-4) return;
    param.__last = v;
    try { param.setTargetAtTime(v, this.ctx.currentTime, Math.max(0.001, tc)); } catch (e) { /* suspended teardown */ }
  }

  _setFreq(param, hz, tc = 0.03) { this._set(param, this._safeFreq(hz), tc); }

  _applyOutputGains() {
    if (!this.available) return;
    this._set(this.master.gain, this._volume, 0.02);
    this._set(this.mute.gain, this._muted ? 0 : 1, 0.015);
  }

  // ------------------------------------------------------------------ public
  get volume() { return this._volume; }
  set volume(v) { this.setVolume(v); }
  setVolume(v) { this._volume = clamp(num(v, 0.9), 0, 1); this._applyOutputGains(); return this._volume; }

  get muted() { return this._muted; }
  set muted(m) { this.setMuted(m); }
  setMuted(m) { this._muted = !!m; this._applyOutputGains(); return this._muted; }
  toggleMute() { return this.setMuted(!this._muted); }

  setBusGain(name, v) {
    if (!this.available || !this.bus[name]) return false;
    this._set(this.bus[name].gain, clamp(num(v, 1), 0, 2), 0.05);
    return true;
  }

  // Call from the first pointerdown/keydown. Safe to call any number of times and
  // from anywhere; it never rejects and never throws.
  async resume() {
    if (!this.available) return false;
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this._startSources();
      return this.ctx.state === 'running';
    } catch (e) {
      return false;
    }
  }

  async suspend() {
    if (!this.available) return false;
    try { await this.ctx.suspend(); return true; } catch (e) { return false; }
  }

  get running() { return !!this.available && this.ctx.state === 'running'; }

  // 3D positioning follows the camera through three's own listener, so the pose
  // is whatever the renderer already computed and there is no second source of
  // truth for where the player's ears are.
  attachListener(camera) {
    if (!this.available) return null;
    try {
      // Two listeners would both write context.listener every frame and the pose
      // would be whichever updated last.
      if (this.listener && this.listener.parent) this.listener.parent.remove(this.listener);
      this.listener = new THREE.AudioListener();
      this.listenerCamera = camera || null;
      if (camera) camera.add(this.listener);
      return this.listener;
    } catch (e) {
      this.listener = null;
      return null;
    }
  }

  // Fallback for harnesses with no camera in a scene graph.
  setListenerPosition(x, y, z) {
    if (!this.available) return;
    const L = this.ctx.listener;
    if (L.positionX) {
      this._set(L.positionX, x, 0.02); this._set(L.positionY, y, 0.02); this._set(L.positionZ, z, 0.02);
    } else if (L.setPosition) {
      L.setPosition(num(x), num(y), num(z));
    }
  }

  // ------------------------------------------------------- time and weather
  // Accepts a src/daynight.js preset name, or hours 0..24 for a continuous cycle.
  setTimeOfDay(t, fade = 1.6) {
    let beds;
    if (typeof t === 'string') {
      beds = TOD_BEDS[t] || TOD_BEDS.dusk;
      this.timeOfDay = t;
    } else {
      const h = ((num(t, 12) % 24) + 24) % 24;
      // Day bed rises through dawn and falls through dusk; night is its complement
      // with a wide overlap so the two beds sit together at the edges of the day
      // rather than handing off at an instant.
      const day = smoothstep(4.5, 8.0, h) * (1 - smoothstep(17.5, 21.0, h));
      beds = { day: 0.06 + day * 0.94, night: 1 - day * 0.95 };
      this.timeOfDay = h;
    }
    this.state.day = beds.day;
    this.state.night = beds.night;
    this._pushAmbience(fade);
    return beds;
  }

  // Accepts { rain, wetness } or anything shaped like src/weather.js's report()
  // (rainIntensity / wetness), so the game can forward its weather system straight through.
  setWeather(w, fade = 2.2) {
    const src = (w && typeof w.report === 'function') ? w.report() : (w || {});
    this.state.rain = clamp(num(src.rain ?? src.rainIntensity, 0), 0, 1);
    this.state.wetness = clamp(num(src.wetness, this.state.rain * 0.8), 0, 1);
    this._pushAmbience(fade);
    return { rain: this.state.rain, wetness: this.state.wetness };
  }

  // Muffles the world when the player is inside a vehicle.
  setInterior(inside, fade = 0.35) {
    this.state.interior = inside ? 1 : 0;
    if (!this.available) return;
    this._setFreq(this.interiorLP.frequency, inside ? 850 : 20000, fade);
  }

  _pushAmbience(fade = 1.6) {
    if (!this.available) return;
    const s = this.state;
    const tc = Math.max(0.02, fade * 0.4);
    // Rain masks the city rather than adding to it: heavy rain takes the dry beds
    // down as it brings its own layers up, which is what stops the mix piling up.
    const dry = 1 - s.rain * 0.55;
    this._set(this.amb.dayGain.gain, 0.085 * s.day * dry, tc);
    this._set(this.amb.dayHissGain.gain, 0.010 * s.day * dry, tc);
    this._set(this.amb.nightGain.gain, 0.075 * s.night * dry, tc);
    this._set(this.amb.nightAirGain.gain, 0.0055 * s.night * dry, tc);
    this._set(this.amb.droneGain.gain, 0.020 * s.night * dry, tc);
    const r = s.rain;
    this._set(this.amb.rainHissGain.gain, 0.075 * r, tc);
    this._set(this.amb.rainSpatterGain.gain, 0.055 * r * r, tc);
    this._set(this.amb.rainRoarGain.gain, 0.090 * Math.pow(r, 0.7), tc);
    // Heavier rain drops in pitch: more water, bigger drops, lower spectrum.
    this._setFreq(this.amb.rainHP.frequency, 1900 - 700 * r, tc);
    this._setFreq(this.amb.rainBP.frequency, 4200 - 1100 * r, tc);
  }

  // ----------------------------------------------------------------- engine
  // Lab / cutscene override. Pass null to hand control back to the vehicle.
  setEngine(o) {
    if (!o) { this._manual = null; return null; }
    this._manual = {
      rpm: clamp(num(o.rpm, IDLE_RPM), 0, MAX_RPM),
      throttle: clamp(num(o.throttle, 0), 0, 1),
      brake: clamp(num(o.brake, 0), 0, 1),
    };
    this.state.brake = this._manual.brake;
    return this._manual;
  }

  // Bench override for the tyre layer, symmetric with setEngine(). Pass null to
  // hand control back to the vehicle.
  setTyres(o) {
    if (!o) { this._manualTyres = null; return null; }
    this._manualTyres = {
      speed: clamp(num(o.speed, 0), 0, 90),
      slip: clamp(num(o.slip, 0), 0, 1),
    };
    return this._manualTyres;
  }

  // Reads only the documented surface of src/vehicle.js: .speed, .forwardSpeed,
  // .throttle, .brake and .wheels[].slip/.contact/.drive.
  updateVehicle(vehicle, dt) {
    if (!vehicle) return this.state;
    const s = this.state;
    const step = clamp(num(dt, 0.016), 1 / 240, 0.1);
    const fwd = num(vehicle.forwardSpeed, 0);
    const speed = num(vehicle.speed, Math.abs(fwd));
    s.forwardSpeed = fwd;
    s.speed = speed;
    s.throttle = clamp(Math.abs(num(vehicle.throttle, 0)), 0, 1);
    s.brake = clamp(num(vehicle.brake, 0), 0, 1);

    let maxSlip = 0, driveSlip = 0, grounded = 0;
    const wheels = vehicle.wheels || [];
    for (const w of wheels) {
      if (w.contact === false) continue;
      grounded++;
      const sl = clamp(num(w.slip, 0), 0, 1);
      if (sl > maxSlip) maxSlip = sl;
      if (w.drive && sl > driveSlip) driveSlip = sl;
    }
    s.slip = maxSlip;
    s.grounded = grounded;

    // Nothing in the project reports collisions, so derive them: a wall takes a
    // car from 20 m/s to nothing inside one frame, which is order 1000 m/s^2,
    // while the hardest braking src/vehicle.js can produce is about 12 m/s^2.
    // Two orders of magnitude apart, so the threshold is not delicate.
    if (this._autoImpacts) {
      const decel = (this._prevSpeed - speed) / step;
      if (decel > 55 && this._prevSpeed > 3) this.impact(this._prevSpeed - speed);
    }
    this._prevSpeed = speed;

    this._gearbox(Math.abs(fwd), s.throttle, driveSlip, step);
    return s;
  }

  _gearbox(v, throttle, driveSlip, dt) {
    const s = this.state;
    const rpmPerMs = 60 / (2 * Math.PI * 0.36) * FINAL_DRIVE;
    const gearRpm = (g) => v * rpmPerMs * GEARS[g];

    if (s.shiftT > 0) {
      s.shiftT = Math.max(0, s.shiftT - dt);
    } else {
      if (gearRpm(s.gear) > SHIFT_UP_RPM && s.gear < GEARS.length - 1) {
        s.gear++; s.shiftT = SHIFT_TIME; s.shifts++;
        // The mechanical clunk of the change. Quiet, and it uses an impact voice
        // rather than a dedicated one, which is the entire point of the pool.
        this._transient(2.2, 0.35);
      } else if (s.gear > 0 && gearRpm(s.gear - 1) < SHIFT_DOWN_RPM) {
        s.gear--; s.shiftT = SHIFT_TIME * 0.7; s.shifts++;
      }
    }

    let target = gearRpm(s.gear);
    // Clutch. Below engagement speed the engine is not tied to the wheels, so the
    // revs answer the throttle instead — without this a standing start is silent
    // until the car is already moving, which is the single most obvious tell that
    // an engine sound is being driven from speed alone.
    const engage = clamp(v / 6, 0, 1);
    target = target * engage + (IDLE_RPM + throttle * 2600) * (1 - engage);
    // Wheelspin lifts the revs off the road speed entirely.
    s.wheelspin = smoothstep(0.85, 1.0, driveSlip) * throttle;
    target += s.wheelspin * 1900;
    if (s.shiftT > 0) target -= 1300 * (s.shiftT / SHIFT_TIME);
    target = clamp(target, IDLE_RPM, MAX_RPM);

    // Rotating inertia: the revs cannot step, and they rise faster than they fall
    // because the throttle is pushing one way and only friction pulls the other.
    const rate = target > s.rpm ? (3.4 + throttle * 4.5) : 3.0;
    s.rpm += (target - s.rpm) * (1 - Math.exp(-rate * dt));
    s.limiting = s.rpm >= LIMIT_RPM;
    if (s.rpm > MAX_RPM) s.rpm = MAX_RPM;

    // The brake pedal is part of engine load, not just of stopping: on the brakes
    // the engine is being driven by the wheels rather than driving them, so load
    // goes below closed-throttle and the overrun gets stronger.
    const loadTarget = s.shiftT > 0 ? 0.05 : Math.max(0, throttle - this.state.brake * 0.6);
    s.load += (loadTarget - s.load) * (1 - Math.exp(-11 * dt));
  }

  _pushEngine(dt) {
    const e = this.engine, s = this.state;
    let rpm = s.rpm, throttle = s.throttle, load = s.load;
    if (this._manual) {
      rpm = this._manual.rpm; throttle = this._manual.throttle;
      // Same load law as the gearbox, or the brake pedal would be inaudible
      // through setEngine() while being audible through updateVehicle().
      const target = Math.max(0, throttle - s.brake * 0.6);
      load += (target - load) * (1 - Math.exp(-11 * dt));
      s.load = load;
      s.rpm = rpm;
      s.limiting = rpm >= LIMIT_RPM;
    }

    // Idle is never dead: a real engine at rest wanders a few tens of rpm.
    this._idlePhase += dt * 2.3;
    const idleness = 1 - smoothstep(IDLE_RPM, IDLE_RPM + 900, rpm);
    const wobble = idleness * (Math.sin(this._idlePhase) * 18 + (e.rand() - 0.5) * 26);
    const f0 = (rpm + wobble) / FIRING_DIVISOR;

    for (const b of e.bank) {
      this._setFreq(b.osc.frequency, f0 * b.mul, 0.02);
      // Upper partials only arrive with load. Off throttle the bank collapses to
      // its bottom two members, which is the overrun timbre.
      const bright = b.mul >= 2 ? (0.25 + 0.75 * load) : 1;
      this._set(b.gain.gain, b.level * bright * 0.30, 0.03);
    }

    const rpmNorm = clamp((rpm - IDLE_RPM) / (LIMIT_RPM - IDLE_RPM), 0, 1);
    this._set(e.pre.gain, 0.8 + load * 1.9 + rpmNorm * 0.5, 0.04);
    this._setFreq(e.lp.frequency, 380 + load * 4200 + rpmNorm * 2600, 0.05);
    this._setFreq(e.intakeBP.frequency, 380 + rpmNorm * 2500, 0.05);

    // Overrun: closed throttle at speed pops and crackles on the trailing edge.
    // The gate is deliberately sparse. An earlier version fired 40% of the time at
    // a third of full amplitude, which is not a crackle, it is a hiss — and it was
    // loud enough that the spectral centroid FELL as throttle rose, so the engine
    // measurably got darker under load. Rare and loud, not frequent and quiet.
    const overrun = (1 - load) * (1 + s.brake * 0.7) * smoothstep(3200, 5000, rpm);
    this._crackle += dt;
    if (this._crackle > 0.05) { this._crackle = 0; this._overrunGate = e.rand(); }
    const gate = 0.88 - s.brake * 0.26;
    const crackle = overrun * (this._overrunGate > gate ? 1 : 0.04);
    this._set(e.intakeGain.gain, (0.022 + 0.085 * load) * (0.35 + rpmNorm) + crackle * 0.042, 0.02);

    // Level, then the limiter chop on top of it. Overrun to full load is about
    // 16 dB; the first cut spanned 6.6 dB, which is not what a throttle does.
    const level = 0.07 + 0.42 * load + 0.13 * rpmNorm;
    if (s.limiting) {
      this._set(e.out.gain, level * 0.62, 0.005);
      this._set(e.chopDepth.gain, level * 0.38, 0.005);
    } else {
      this._set(e.out.gain, level * (s.shiftT > 0 ? 0.45 : 1), 0.02);
      this._set(e.chopDepth.gain, 0, 0.01);
    }
  }

  _pushTyres(dt) {
    const t = this.tyre, s = this.state;
    if (this._manualTyres) { s.speed = this._manualTyres.speed; s.slip = this._manualTyres.slip; }
    const v = Math.min(Math.abs(s.speed), 70);
    // Rolling noise is roughly proportional to speed and rises in pitch with it,
    // because the tread block passing frequency is speed / block pitch.
    const roll = smoothstep(0.4, 10, v) * Math.min(1, v / 34);
    // Weight transfer under braking loads the front tyres: bigger contact patch,
    // more noise, and slightly lower in pitch as the sidewall deflects.
    const brakeLoad = 1 + s.brake * 0.9;
    this._setFreq(t.rollBP.frequency, (90 + v * 15) / (1 + s.brake * 0.12), 0.06);
    this._set(t.rollGain.gain, roll * brakeLoad * 0.115 * (1 + s.wetness * 0.3), 0.05);
    this._setFreq(t.rumbleLP.frequency, 60 + v * 5.5, 0.06);
    this._set(t.rumbleGain.gain, roll * brakeLoad * 0.15, 0.05);
    this._set(t.wetGain.gain, roll * s.wetness * 0.085, 0.08);

    // slip saturates at 1 whenever the friction circle is full, which includes
    // firm-but-normal cornering, so the audible threshold sits high and is gated
    // on speed as well: a wheel scrubbing at walking pace does not squeal.
    const speedGate = smoothstep(2.5, 9, v);
    const target = smoothstep(0.84, 0.985, s.slip) * speedGate;
    // Fast to engage, slower to release: a squeal starts abruptly and tails off.
    const k = target > s.screech ? 22 : 7;
    s.screech += (target - s.screech) * (1 - Math.exp(-k * dt));
    this._set(t.scrOut.gain, s.screech * 0.16, 0.02);
    // Squeal rises in pitch as the slide accelerates.
    this._setFreq(t.scrBP1.frequency, 1000 + v * 9, 0.05);
    this._setFreq(t.scrBP2.frequency, 2200 + v * 13, 0.05);
    this._set(t.warbleDepth.gain, 55 + s.screech * 90, 0.05);
  }

  // ----------------------------------------------------------------- impacts
  // velocity is the closing speed in m/s. 2 m/s is a kerb, 25 m/s is a wall.
  impact(velocity, opts = {}) {
    const v = clamp(num(velocity, 0), 0, 60);
    if (v < 0.6) return false;
    this.state.impacts++;
    return this._transient(v, num(opts.hardness, 1));
  }

  _transient(velocity, hardness) {
    if (!this.available || this.ctx.state !== 'running') { this._dropped++; return false; }
    const now = this.ctx.currentTime;
    // Oldest voice wins, so a burst of hits steals the one already decaying.
    let voice = this.impactVoices[0];
    for (const c of this.impactVoices) if (c.free < voice.free) voice = c;
    voice.free = now + 0.5;

    // Gain law, and it matters more than it looks. The first version used
    // velocity/16 with a 0.75 exponent and a 0.55 scale, which put an 8 m/s kerb
    // strike and a 26 m/s wall impact 0.4 dB apart at -1.8 and -1.4 dBFS: both
    // were far above the master limiter's threshold, so the limiter — correctly
    // doing its job — flattened the difference and every collision in the game
    // sounded identical and clipped. A compressive exponent BELOW 1 was the bug:
    // it needs to be above 1 so the range opens up rather than closing. This
    // spans about 23 dB from a 2.5 m/s scrape to a 26 m/s wall, and the loudest
    // hit lands near -4 dBFS, which leaves the limiter as a safety net instead of
    // a mix element.
    const e = clamp(velocity / 22, 0.02, 1.25);
    const amp = Math.pow(e, 1.15) * 0.23 * clamp(hardness, 0.1, 2);
    // A heavy hit is lower and longer. Panel resonance drops as the panel gets
    // bigger, and a bigger panel is what a bigger hit deforms.
    const f = 150 - 78 * clamp(e, 0, 1);
    const decay = 0.10 + 0.22 * clamp(e, 0, 1);

    try {
      const bg = voice.bodyGain.gain;
      bg.cancelScheduledValues(now);
      bg.setValueAtTime(0, now);
      bg.linearRampToValueAtTime(amp, now + 0.004);
      bg.exponentialRampToValueAtTime(0.0008, now + decay);
      bg.setValueAtTime(0, now + decay + 0.005);
      bg.__last = 0;

      const of = voice.osc.frequency;
      of.cancelScheduledValues(now);
      of.setValueAtTime(f * 2.1, now);
      of.exponentialRampToValueAtTime(Math.max(24, f * 0.55), now + decay);
      of.__last = undefined;

      const ng = voice.noiseGain.gain;
      const crunch = amp * 0.55 * (0.45 + 0.55 * clamp(hardness, 0, 1.5));
      ng.cancelScheduledValues(now);
      ng.setValueAtTime(0, now);
      ng.linearRampToValueAtTime(crunch, now + 0.002);
      ng.exponentialRampToValueAtTime(0.0008, now + decay * 0.55);
      ng.setValueAtTime(0, now + decay * 0.55 + 0.005);
      ng.__last = 0;

      const bf = voice.bp.frequency;
      bf.cancelScheduledValues(now);
      bf.setValueAtTime(this._safeFreq(900 + 2400 * clamp(e, 0, 1)), now);
      bf.exponentialRampToValueAtTime(this._safeFreq(320), now + decay * 0.55);
      bf.__last = undefined;
    } catch (err) {
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ siren
  // Drive one voice directly. mode is 'wail' (slow sweep) or 'yelp' (fast).
  siren(index, o = {}) {
    if (!this.available) return false;
    const v = this.sirenVoices[index];
    if (!v) return false;
    const on = o.on !== false;
    v.active = on;
    v.mode = o.mode || v.mode;
    const base = num(o.base, 900);
    this._setFreq(v.osc.frequency, base, 0.05);
    // Depth is on the same param as the base frequency: the LFOs sum onto it.
    this._set(v.wailDepth.gain, on && v.mode === 'wail' ? 340 : 0, 0.25);
    this._set(v.yelpDepth.gain, on && v.mode === 'yelp' ? 230 : 0, 0.25);
    this._set(v.gain.gain, on ? clamp(num(o.gain, 0.55), 0, 1) : 0, 0.12);
    if (o.position) this._panTo(v.panner, o.position);
    return true;
  }

  _panTo(p, pos, tc = 0.05) {
    const x = num(pos.x, 0), y = num(pos.y, 0), z = num(pos.z, 0);
    if (p.positionX) {
      this._set(p.positionX, x, tc); this._set(p.positionY, y, tc); this._set(p.positionZ, z, tc);
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
  }

  // Assigns the voice pool to the nearest active units of a src/pursuit.js
  // PursuitUnits. Positions come off the InstancedMesh matrices, which is the
  // rendered truth, rather than re-deriving them from the road graph.
  //
  // Assignment is two passes because one is not enough. The first version let
  // each voice check only its OWN incumbent against its own kth-nearest
  // candidate, with no record of what the other voices had taken — so as the
  // fleet converged, every voice independently decided the closest car was the
  // better choice and all three ended up on it. Measured against a real fleet:
  // three voices, one unit, 172 m, three sirens playing the same car in the same
  // place. Claims have to be exclusive, which means they have to be shared.
  updatePursuit(pursuit, listenerPos) {
    if (!this.available || !pursuit || !pursuit.mesh) return 0;
    const m = this._m4 || (this._m4 = new THREE.Matrix4());
    const p = this._v3 || (this._v3 = new THREE.Vector3());
    const lp = listenerPos || (this.listenerCamera ? this.listenerCamera.position : { x: 0, y: 0, z: 0 });
    const cands = [];
    for (let i = 0; i < pursuit.count; i++) {
      if (!pursuit.units[i]) continue;
      pursuit.mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      const d = Math.hypot(p.x - num(lp.x), p.z - num(lp.z));
      cands.push({ i, x: p.x, y: p.y + 1.6, z: p.z, d });
    }
    cands.sort((a, b) => a.d - b.d);

    const voices = this.sirenVoices;
    const n = Math.min(cands.length, voices.length);
    // A unit an incumbent voice already holds stays eligible a little past the
    // cut, so two cars swapping rank do not hand their sirens back and forth
    // across the stereo field every frame.
    const cutoff = n > 0 ? cands[n - 1].d * 1.3 : 0;
    const byId = new Map();
    for (const c of cands) byId.set(c.i, c);
    const claimed = new Set();

    for (const v of voices) {
      v._next = null;
      if (!v.active || v.unit < 0) continue;
      const held = byId.get(v.unit);
      if (held && held.d <= cutoff && !claimed.has(held.i)) { v._next = held; claimed.add(held.i); }
    }
    let ci = 0;
    for (const v of voices) {
      if (v._next) continue;
      while (ci < cands.length && claimed.has(cands[ci].i)) ci++;
      if (ci >= cands.length) break;
      v._next = cands[ci];
      claimed.add(cands[ci].i);
      ci++;
    }

    // The car in front yelps, the ones behind wail. Costs nothing, and it is what
    // a convoy actually sounds like.
    const lead = cands.length ? cands[0].i : -1;
    let active = 0;
    for (let k = 0; k < voices.length; k++) {
      const v = voices[k], c = v._next;
      if (c) {
        v.unit = c.i; v.dist = c.d;
        this.siren(k, { on: true, mode: c.i === lead ? 'yelp' : 'wail', gain: 0.55, position: c });
        active++;
      } else if (v.active) {
        v.active = false; v.unit = -1; v.dist = Infinity;
        this._set(v.gain.gain, 0, 0.35);
      }
    }
    this.state.sirenVoices = active;
    return active;
  }

  sirensOff() {
    for (let i = 0; i < this.sirenVoices.length; i++) this.siren(i, { on: false });
    this.state.sirenVoices = 0;
  }

  // --------------------------------------------------------------- stingers
  stinger(name) {
    if (!this.available || this.ctx.state !== 'running') { this._dropped++; return false; }
    const m = STINGERS[name];
    if (!m) return false;
    const t0 = this.ctx.currentTime + 0.02;
    this._set(this.reverbSend.gain, m.reverb, 0.05);
    for (const note of m.notes) {
      let voice = this.musicVoices[0];
      for (const c of this.musicVoices) if (c.free < voice.free) voice = c;
      const start = t0 + note.t;
      const f = m.root * Math.pow(2, note.s / 12);
      const dur = note.d;
      voice.free = start + dur;
      try {
        voice.osc.frequency.cancelScheduledValues(start);
        voice.osc.frequency.setValueAtTime(this._safeFreq(f), start);
        voice.osc.frequency.__last = undefined;
        voice.osc.detune.cancelScheduledValues(start);
        voice.osc.detune.setValueAtTime(num(note.detune, 0), start);
        // The filter sweep is the note's attack. A struck body is bright for a
        // few tens of milliseconds and then is not.
        voice.lp.frequency.cancelScheduledValues(start);
        voice.lp.frequency.setValueAtTime(this._safeFreq(f * 9), start);
        voice.lp.frequency.exponentialRampToValueAtTime(this._safeFreq(f * 2.4), start + dur * 0.6);
        voice.lp.frequency.__last = undefined;
        const g = voice.gain.gain;
        g.cancelScheduledValues(start);
        g.setValueAtTime(0, start);
        g.linearRampToValueAtTime(note.v * m.gain * 0.17, start + 0.012);
        g.exponentialRampToValueAtTime(0.0006, start + dur);
        g.setValueAtTime(0, start + dur + 0.005);
        g.__last = 0;
      } catch (e) { /* a suspend mid-schedule must not take the game down */ }
    }
    if (m.thud) this._transient(m.thud, 0.8);
    return true;
  }

  // ------------------------------------------------------------------- tick
  // Call once per rendered frame. Everything continuous is pushed here so the
  // per-frame param traffic is one predictable block rather than scattered.
  update(dt, o = {}) {
    if (!this.available) return this.state;
    const step = clamp(num(dt, 0.016), 1 / 240, 0.1);
    if (o.vehicle) this.updateVehicle(o.vehicle, step);
    else if (!this._manual) this._gearbox(Math.abs(this.state.forwardSpeed), this.state.throttle, 0, step);

    this._pushEngine(step);
    this._pushTyres(step);
    if (o.pursuit) this.updatePursuit(o.pursuit, o.listenerPos);

    // The renderer normally does this during its scene traversal; doing it again
    // is idempotent and makes the module correct in harnesses that never render.
    if (this.listener) {
      try {
        if (this.listenerCamera) this.listenerCamera.updateMatrixWorld();
        this.listener.updateMatrixWorld(true);
      } catch (e) { /* listener detached mid-frame */ }
    }
    return this.state;
  }

  // ----------------------------------------------------------------- report
  report() {
    if (!this.available) {
      return { available: false, reason: 'no AudioContext', nodes: 0, drawCalls: 0 };
    }
    const s = this.state;
    return {
      available: true,
      state: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      nodes: this._nodes.length,
      sources: this._sources.length,
      buffers: 3,                      // white, pink, reverb IR
      drawCalls: 0,                    // WebAudio only: this module renders nothing
      volume: +this._volume.toFixed(3),
      muted: this._muted,
      limiterReductionDb: +num(this.limiter.reduction, 0).toFixed(2),
      rpm: Math.round(s.rpm),
      gear: s.gear + 1,
      load: +s.load.toFixed(3),
      speedKmh: +(s.speed * 3.6).toFixed(1),
      slip: +s.slip.toFixed(3),
      screech: +s.screech.toFixed(3),
      limiting: s.limiting,
      shifts: s.shifts,
      impacts: s.impacts,
      wheelspin: +s.wheelspin.toFixed(3),
      timeOfDay: this.timeOfDay,
      beds: { day: +s.day.toFixed(2), night: +s.night.toFixed(2), rain: +s.rain.toFixed(2) },
      wetness: +s.wetness.toFixed(2),
      interior: !!s.interior,
      sirenVoices: s.sirenVoices,
      droppedWhileSuspended: this._dropped,
      generationMs: +num(this.generationMs, 0).toFixed(1),
    };
  }

  getAnalyser() { return this.available ? this.analyser : null; }

  dispose() {
    if (!this.available) return;
    for (const s of this._sources) { try { s.stop(); } catch (e) { /* not started */ } }
    for (const n of this._nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
    if (this.listener && this.listener.parent) this.listener.parent.remove(this.listener);
    try { this.ctx.close(); } catch (e) { /* already closed */ }
    this.available = false;
  }
}

export function createAudio(opts) { return new GameAudio(opts); }
