// Loading screen.
//
// Binding constraint 7: procedural texture generation happens at runtime behind a
// loading screen, and an IndexedDB cache is adopted only if first load exceeds 8 s
// at a real-hardware checkpoint. So this screen has two jobs: cover the
// generation, and MEASURE it, because that measurement is what decides whether
// the cache is needed.
//
// Generation is synchronous canvas work. Yielding to the event loop between steps
// is what lets the browser actually paint the progress bar - without it the page
// freezes on a blank frame and the screen is decorative.

export class LoadingScreen {
  constructor(opts = {}) {
    this.title = opts.title ?? 'SARASOTA';
    this.steps = [];
    this.timings = [];
    this.t0 = 0;

    const el = document.createElement('div');
    el.id = 'loading';
    el.innerHTML = `
      <div class="lo-inner">
        <div class="lo-title"></div>
        <div class="lo-sub">generating world</div>
        <div class="lo-bar"><div class="lo-fill"></div></div>
        <div class="lo-step">starting</div>
      </div>
      <div class="lo-attr">Map data © OpenStreetMap contributors (ODbL) · names fictional</div>`;
    const style = document.createElement('style');
    style.textContent = `
      #loading{position:fixed;inset:0;z-index:50;background:#0a0d13;color:#e8edf5;
        display:flex;align-items:center;justify-content:center;
        font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
        transition:opacity .6s ease}
      #loading.done{opacity:0;pointer-events:none}
      .lo-inner{width:min(460px,80vw)}
      .lo-title{font-size:31px;letter-spacing:.34em;font-weight:600;margin-bottom:6px}
      .lo-sub{color:#7f8da0;letter-spacing:.22em;text-transform:uppercase;
        font-size:11px;margin-bottom:22px}
      .lo-bar{height:2px;background:#1e2735;overflow:hidden}
      .lo-fill{height:100%;width:0;background:linear-gradient(90deg,#c9762f,#f0b25e);
        transition:width .25s ease}
      .lo-step{margin-top:11px;color:#6f7d92;font-size:11.5px;min-height:1.4em}
      .lo-attr{position:fixed;bottom:14px;left:0;right:0;text-align:center;
        color:#4d5566;font-size:10.5px}`;
    document.head.appendChild(style);
    document.body.appendChild(el);
    this.el = el;
    el.querySelector('.lo-title').textContent = this.title;
    this.fill = el.querySelector('.lo-fill');
    this.stepEl = el.querySelector('.lo-step');
  }

  add(label, fn) { this.steps.push({ label, fn }); return this; }

  async run() {
    this.t0 = performance.now();
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      this.stepEl.textContent = s.label;
      this.fill.style.width = `${(i / this.steps.length) * 100}%`;
      // Two frames: one to paint the label, one to be sure it landed before the
      // main thread blocks again.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t = performance.now();
      await s.fn();
      this.timings.push({ label: s.label, ms: +(performance.now() - t).toFixed(1) });
    }
    this.fill.style.width = '100%';
    this.stepEl.textContent = 'ready';
    this.totalMs = performance.now() - this.t0;
    return this.report();
  }

  hide() {
    this.el.classList.add('done');
    setTimeout(() => this.el.remove(), 700);
  }

  report() {
    return {
      totalMs: +this.totalMs.toFixed(0),
      totalSeconds: +(this.totalMs / 1000).toFixed(2),
      steps: this.timings,
      // Constraint 7's decision point, evaluated rather than assumed.
      exceedsEightSecondBudget: this.totalMs > 8000,
    };
  }
}
