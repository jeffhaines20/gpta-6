// Does the whole thing still run?
//
// Every gate in this repo is per-subsystem: check-syntax parses modules,
// golden-trace pins vehicle physics, geom-audit walks props, daynight-sweep
// checks lighting, oak-audit checks trees, traffic-selftest checks arbitration.
// Each one can pass while the built game fails to start, because none of them
// loads district/index.html and drives it.
//
// That gap became real when three rounds - a noon exposure change, a bark
// stencil, and junction arbitration - landed within an hour of each other, each
// gated on its own, none loaded alongside the others.
//
//   node tools/smoke.mjs
//   SMOKE_PORT=8129 node tools/smoke.mjs        # against a git worktree
//
// THE PORT MATTERS WHEN CHECKING A WORKTREE. ensureServer() serves the process's
// own cwd on 8123, and if a server is already up there it is REUSED - so running
// this from a clean worktree while the main tree's server is alive silently
// tests the main tree, in-flight edits and all. That is the same shape as the
// stale-frame failure this ledger has paid for twice: a confident result about
// the wrong thing. Pass SMOKE_PORT to get a server rooted where you are.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const PORT = Number(process.env.SMOKE_PORT ?? 8123);
const CARS = Number(process.env.SMOKE_CARS ?? 30);
const TIMES = (process.env.SMOKE_TIMES ?? 'noon,golden,dusk,night').split(',');

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [], failedRequests = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
page.on('requestfailed', (r) => failedRequests.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ''}`));

await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.evaluate((n) => __district.setTraffic(n), CARS);
await page.waitForTimeout(12000);

const rows = [];
for (const tod of TIMES) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(4000);
  rows.push({ tod, ...await page.evaluate(() => {
    const a = __district.audit(), r = __district.renderStats(), t = __district.trafficReport();
    return {
      stop: a.exposureAsStop, implausible: a.implausible.length,
      draws: r.calls, tris: r.triangles,
      carsAlive: t?.alive ?? null, overlapPct: t?.overlapPctOfFrames ?? null,
    };
  }) });
}
await browser.close();

const fails = [];
for (const r of rows) {
  console.log(`  ${r.tod.padEnd(7)} stop ${String(r.stop).padStart(8)}  draws ${String(r.draws).padStart(4)}`
    + `  tris ${String(r.tris).padStart(7)}  cars ${r.carsAlive}  overlap ${r.overlapPct}%`
    + `  implausible ${r.implausible}`);
  if (r.implausible > 0) fails.push(`${r.tod}: ${r.implausible} implausible lighting values`);
  // A time of day that renders nothing, or one where the fleet has died, is a
  // broken build that every per-subsystem gate would still pass.
  if (!(r.tris > 10000)) fails.push(`${r.tod}: only ${r.tris} triangles - scene did not build`);
  if (CARS > 0 && r.carsAlive !== CARS) fails.push(`${r.tod}: ${r.carsAlive} cars alive of ${CARS}`);
}
if (pageErrors.length) fails.push(`${pageErrors.length} page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
if (failedRequests.length) fails.push(`${failedRequests.length} failed requests: ${failedRequests.slice(0, 3).join(' | ')}`);

console.log(fails.length ? `\nSMOKE FAIL\n  ${fails.join('\n  ')}` : '\nSMOKE PASS - loads, renders and drives at every time of day');
process.exit(fails.length ? 1 : 0);
