// Does ?frontage= actually change anything?
//
// "A switch that silently does nothing has already cost this project a day" -
// tools/drive-through.mjs, about DRIVE_SHADOW. This is that check for the
// frontage switch, and it is deliberately a DIRECT observation of the cache
// rather than a timing: it loads the page, and before anything drives, counts
// how many of the district's buildings already carry the street elevations
// _stepBuild would otherwise compute inside a timed slice.
//
//   primed (default)  every building is warm before the first chunk is built
//   lazy              only the ones the initial fill happened to touch
//
// If those two numbers are equal, the switch is a no-op and every timing
// comparison built on it is meaningless - which is exactly the failure this
// file exists to make impossible to miss.
//
//   node tools/frontage-prime-check.mjs
//   node tools/frontage-prime-check.mjs --selftest
import { chromium } from 'playwright';

// The verdict logic is separated from the browser so --selftest can reach it.
export function verdict(primed, lazy, total) {
  const ok = primed === total && lazy < total;
  return {
    total, primed_warm: primed, lazy_warm: lazy,
    primed_pct: +(100 * primed / total).toFixed(1),
    lazy_pct: +(100 * lazy / total).toFixed(1),
    // What the streamer no longer has to compute inside a timed slice.
    moved_to_load: primed - lazy,
    status: ok ? 'PASS' : 'FAIL',
    why: ok ? 'primed warms every building; lazy does not'
      : primed !== total ? `primed left ${total - primed} buildings cold — the priming loop is not covering the district`
        : 'lazy warms every building too — the switch is a no-op and every timing comparison using it is meaningless',
  };
}

if (process.argv.includes('--selftest')) {
  const cases = [
    ['a no-op switch must FAIL', verdict(523, 523, 523).status === 'FAIL'],
    ['incomplete priming must FAIL', verdict(400, 90, 523).status === 'FAIL'],
    ['the real shape must PASS', verdict(523, 90, 523).status === 'PASS'],
    ['moved_to_load is the difference', verdict(523, 90, 523).moved_to_load === 433],
    ['lazy warming nothing still passes', verdict(523, 0, 523).status === 'PASS'],
  ];
  const bad = cases.filter(([, ok]) => !ok);
  if (bad.length) { console.error('SELFTEST: FAIL'); for (const [n] of bad) console.error('  ' + n); process.exit(1); }
  console.log(`SELFTEST: PASS — ${cases.length} cases`);
  process.exit(0);
}

const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');
const PORT = Number(process.env.STEP_PORT ?? process.env.DRIVE_PORT ?? 8123);
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());

async function warmCount(query) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`http://127.0.0.1:${PORT}/district/${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
  const r = await page.evaluate(() => {
    const bs = __district.district.buildings;
    let single = 0, plural = 0;
    for (const b of bs) {
      if (b._streetDir !== undefined) single++;
      if (b._streetDirs !== undefined) plural++;
    }
    return { total: bs.length, single, plural };
  });
  await page.close();
  return r;
}

// lazy first, so the primed run cannot be credited with a cache the lazy run
// left behind - they are separate pages, but separate pages have shared this
// project a wrong answer before.
const lazy = await warmCount('?frontage=lazy');
const primed = await warmCount('');
await browser.close();

const v = verdict(primed.plural, lazy.plural, primed.total);
console.log(JSON.stringify({
  lazy_streetDir: lazy.single, lazy_streetDirs: lazy.plural,
  primed_streetDir: primed.single, primed_streetDirs: primed.plural,
  ...v,
}, null, 2));
// _streetDir is reported separately because district/main.js's signage step
// already calls world._streetDirFor(b), so that half can be warm in BOTH arms.
// _streetDirs is the half nothing else warms, and it is the one appendBuilding
// consumes via `streets:`.
console.log(`\n${v.status}: ${v.why}`);
console.log(`frontage searches moved out of the timed slices: ${v.moved_to_load} buildings`);
process.exit(v.status === 'PASS' ? 0 : 1);
