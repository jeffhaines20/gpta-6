// Generates docs/progress.html — a static page the user can open at any time to
// see where Phase 2 is, without interrupting the run. Reads whatever gate JSON
// and screenshots exist; missing artifacts are reported as missing rather than
// silently skipped.
import fs from 'node:fs';
import path from 'node:path';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SHOTS = 'docs/shots';
const shots = fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')) : [];
const shotMeta = shots.map((f) => {
  const st = fs.statSync(path.join(SHOTS, f));
  return { file: f, mtime: st.mtimeMs, kb: Math.round(st.size / 1024) };
}).sort((a, b) => b.mtime - a.mtime);

const GROUPS = [
  { title: 'District — time of day', match: /^tod-/ },
  { title: 'Chase harness (Risk 5)', match: /^chase/ },
  { title: 'District drive-through', match: /^district-/ },
  { title: 'Builder labs', match: /^(lab|verify)-/ },
  { title: 'Phase 1 / 1b reference', match: /^(skeleton|visual|0\d)/ },
];

const gates = [
  { name: 'Chase harness (worst case)', data: readJson('docs/chase-harness.json')?.result, file: 'docs/chase-harness.json' },
  { name: 'Drive-through + 30 traffic', data: readJson('docs/drive-traffic.json')?.result, file: 'docs/drive-traffic.json' },
  { name: 'Drive-through, no traffic', data: readJson('docs/drive.json')?.result, file: 'docs/drive.json' },
];
const daynight = readJson('docs/daynight.json');
const bake = readJson('data/bake-report.json');

function gateRows(g) {
  if (!g.data?.budget_gate) return `<tr><td colspan="6" class="muted">not yet run</td></tr>`;
  return g.data.budget_gate.rows.map((r) => `<tr>
    <td>${esc(g.name)}</td><td>${esc(r.name)}</td>
    <td class="num">${esc(r.value)}</td><td class="num muted">${esc(r.warn)}</td><td class="num muted">${esc(r.fail)}</td>
    <td><span class="pill ${r.status.toLowerCase()}">${r.status}</span></td></tr>`).join('');
}

const html = `<title>Port Verano — Phase 2 progress</title>
<style>
  :root{--bg:#0d1017;--panel:#151a23;--line:#232b38;--fg:#e8edf5;--dim:#8d9bb0;--acc:#6fa8f5;
    color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
  header{padding:34px 26px 20px;border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#141b28,#0d1017)}
  h1{margin:0 0 4px;font-size:25px;letter-spacing:-.02em}
  .sub{color:var(--dim);font-size:14px}
  main{max-width:1180px;margin:0 auto;padding:26px 22px 70px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--dim);
    margin:34px 0 12px;font-weight:600}
  table{width:100%;border-collapse:collapse;background:var(--panel);
    border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13.5px}
  th{text-align:left;padding:9px 12px;background:#1a212c;color:var(--dim);
    font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em}
  td{padding:8px 12px;border-top:1px solid var(--line)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .muted{color:var(--dim)}
  .pill{display:inline-block;padding:1px 9px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.05em}
  .pill.pass{background:#12351f;color:#63d98a}
  .pill.warn{background:#3a2f10;color:#e8bd52}
  .pill.fail{background:#3d1519;color:#ff7b7b}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
  figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
  figure img{display:block;width:100%;height:auto;background:#000}
  figcaption{padding:7px 11px;font-size:12px;color:var(--dim);
    display:flex;justify-content:space-between;gap:8px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:6px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .stat .v{font-size:21px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .stat .k{font-size:11.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em;margin-top:2px}
  a{color:var(--acc)}
  code{background:#1c2431;padding:1px 5px;border-radius:4px;font-size:12.5px}
</style>
<header>
  <h1>Port Verano — Phase 2 progress</h1>
  <div class="sub">Auto-generated from the gate artifacts and screenshots in this repo.
    Regenerate with <code>npm run progress</code>. Ledger: <a href="../PROGRESS.md">PROGRESS.md</a></div>
</header>
<main>

<h2>District bake</h2>
<div class="stats">
  ${bake ? `
  <div class="stat"><div class="v">${bake.area_km2} km²</div><div class="k">district area</div></div>
  <div class="stat"><div class="v">${bake.baked_kb} KB</div><div class="k">baked JSON</div></div>
  <div class="stat"><div class="v">${bake.footprints}</div><div class="k">footprints</div></div>
  <div class="stat"><div class="v">${bake.road_edges}</div><div class="k">road edges</div></div>
  <div class="stat"><div class="v">${bake.height_deliberate_pct ?? bake.height_real_pct}%</div><div class="k">deliberate massing</div></div>
  <div class="stat"><div class="v">${bake.height_authored ?? 0}</div><div class="k">authored heights</div></div>
  ` : '<div class="stat"><div class="v">—</div><div class="k">no bake report</div></div>'}
</div>

<h2>Budget gates</h2>
<table>
  <tr><th>Run</th><th>Metric</th><th>Value</th><th>Warn</th><th>Fail</th><th>Status</th></tr>
  ${gates.map(gateRows).join('')}
</table>

<h2>Lighting sweep — physical units</h2>
<table>
  <tr><th>Time</th><th>Sun (lux)</th><th>Sky (lux)</th><th>Lamps lit</th><th>Lamp (cd)</th><th>Exposure</th><th>Plausible</th></tr>
  ${daynight?.presets ? daynight.presets.map((p) => `<tr>
    <td>${esc(p.tod)}</td><td class="num">${esc(p.sunLux)}</td><td class="num">${esc(p.skyLux)}</td>
    <td class="num">${esc(p.litLamps)}</td><td class="num">${esc(p.lampCandela)}</td><td class="num">${esc(p.exposure)}</td>
    <td><span class="pill ${p.implausible?.length ? 'fail' : 'pass'}">${p.implausible?.length ? p.implausible.length + ' FLAGGED' : 'OK'}</span></td>
  </tr>`).join('') : '<tr><td colspan="7" class="muted">sweep not yet run</td></tr>'}
</table>

${GROUPS.map((g) => {
  const items = shotMeta.filter((s) => g.match.test(s.file));
  if (!items.length) return '';
  return `<h2>${esc(g.title)}</h2><div class="grid">${items.map((s) => `
    <figure><img src="shots/${esc(s.file)}" alt="${esc(s.file)}" loading="lazy">
    <figcaption><span>${esc(s.file.replace(/\.png$/, ''))}</span><span>${s.kb} KB</span></figcaption></figure>`).join('')}</div>`;
}).join('')}

${(() => {
  const ungrouped = shotMeta.filter((s) => !GROUPS.some((g) => g.match.test(s.file)));
  if (!ungrouped.length) return '';
  return `<h2>Other captures</h2><div class="grid">${ungrouped.map((s) => `
    <figure><img src="shots/${esc(s.file)}" alt="${esc(s.file)}" loading="lazy">
    <figcaption><span>${esc(s.file.replace(/\.png$/, ''))}</span><span>${s.kb} KB</span></figcaption></figure>`).join('')}</div>`;
})()}

<h2>Notes</h2>
<p class="muted">This container renders through SwiftShader (software). Frame rate is never
reported anywhere in this project; every metric above is either frame-rate independent or
measured against simulated time. Map data © OpenStreetMap contributors (ODbL).</p>
</main>`;

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/progress.html', html);
console.log(`docs/progress.html written — ${shotMeta.length} screenshots, ${gates.filter((g) => g.data?.budget_gate).length}/${gates.length} gates present`);
