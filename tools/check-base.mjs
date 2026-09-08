// Is this working tree based on the branch the work is actually on?
//
// A worktree handed to a builder in this project has twice been created from
// `main` rather than from the working branch. `main` is a tree missing an entire
// session of work -- no lot subdivision, no glazing reflectance, no daylight
// round, no corner frontage. A builder that does not check will spend hours
// fixing a build nobody runs, and its before/after captures will look perfectly
// convincing, because every frame in them is internally consistent. One builder
// caught it and reset; the next one did not, and its whole round had to be
// discarded.
//
// This is the same shape as the ensureServer bug that cost a four-hour review
// round: the failure is silent, the output looks fine, and the only way to know
// is to ask a question with a mechanical answer BEFORE starting.
//
//   node tools/check-base.mjs                 check against the default branch
//   node tools/check-base.mjs --branch NAME   check against a specific one
//   node tools/check-base.mjs --selftest
import { execFileSync } from 'node:child_process';

const WORK_BRANCH = 'claude/gta-agentic-ai-game-n8sul2';

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
};

/**
 * @returns {{ok:boolean, reason:string, head:string, target:string, base:string|null,
 *             behind:number|null, ahead:number|null}}
 */
export function checkBase(target, opts = {}) {
  const head = git('rev-parse', 'HEAD');
  if (!head) return { ok: false, reason: 'not a git working tree', head: null, target, base: null, behind: null, ahead: null };
  // Prefer the remote ref: a local branch of the same name in a worktree may
  // itself be stale, which is exactly the case this tool exists to catch.
  const ref = git('rev-parse', '--verify', `origin/${target}`) ? `origin/${target}` : target;

  // FETCH FIRST, unless told not to. A builder reported this tool saying BASE OK
  // for a tree the branch had moved out from under three times in one round, and
  // they were right: `origin/<branch>` is a REMOTE-TRACKING ref, only as fresh as
  // the last fetch, so "contains the branch tip" was true of a tip that no longer
  // existed anywhere but this machine. The check passed and meant nothing, which
  // is the failure this tool was written to prevent, reproduced inside the tool.
  //
  // Non-fatal on failure: an offline box should still get the local comparison,
  // clearly labelled as unfetched, rather than a hard stop.
  let fetched = false;
  if (opts.fetch !== false && ref.startsWith('origin/')) {
    fetched = git('fetch', 'origin', target, '--quiet') !== null;
  }
  const tip = git('rev-parse', ref);
  if (!tip) {
    return { ok: false, reason: `cannot resolve ${target} (fetch it first)`, head, target, base: null, behind: null, ahead: null };
  }
  const base = git('merge-base', 'HEAD', tip);
  const counts = git('rev-list', '--left-right', '--count', `${tip}...HEAD`);
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
  if (base === tip) {
    return { ok: true, reason: 'contains the branch tip', head, target: ref, base, behind, ahead, tip, fetched };
  }
  return {
    ok: false,
    reason: behind === null ? 'diverged' : `MISSING ${behind} commit(s) from ${ref}`,
    head, target: ref, base, behind, ahead, tip, fetched,
  };
}

function selftest() {
  let fail = 0;
  // A branch that cannot exist must be reported as unresolvable, not silently
  // passed. A check that returns ok for a name it never found is worse than none.
  const bogus = checkBase('no-such-branch-' + Date.now());
  const ok1 = !bogus.ok && /cannot resolve/.test(bogus.reason);
  console.log(`  unresolvable branch : ${ok1 ? 'reported, not passed' : 'WRONG — ' + JSON.stringify(bogus)}`);
  if (!ok1) fail++;
  // HEAD against itself must pass and report zero behind.
  const self = checkBase('HEAD');
  const ok2 = self.ok && self.behind === 0;
  console.log(`  HEAD against itself : ${ok2 ? 'passes, 0 behind' : 'WRONG — ' + JSON.stringify(self)}`);
  if (!ok2) fail++;
  // The staleness guard itself. HEAD is not a remote ref, so no fetch is
  // attempted and `fetched` must be false — a tool that claimed it had fetched
  // when it had not would restore exactly the false assurance being fixed.
  const ok3 = self.fetched === false && typeof self.tip === 'string' && self.tip.length >= 7;
  console.log(`  tip reported, no bogus fetch : ${ok3 ? 'yes' : 'WRONG — ' + JSON.stringify({ f: self.fetched, t: self.tip })}`);
  if (!ok3) fail++;
  // And --no-fetch must be honoured rather than ignored.
  const nf = checkBase('HEAD', { fetch: false });
  const ok4 = nf.fetched === false && nf.ok;
  console.log(`  --no-fetch honoured          : ${ok4 ? 'yes' : 'WRONG — ' + JSON.stringify(nf)}`);
  if (!ok4) fail++;
  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

const i = process.argv.indexOf('--branch');
const target = i >= 0 ? process.argv[i + 1] : WORK_BRANCH;
const r = checkBase(target, { fetch: !process.argv.includes('--no-fetch') });
if (r.ok) {
  console.log(`BASE OK — this tree contains ${r.target}` + (r.ahead ? ` (${r.ahead} commit(s) ahead)` : ''));
  // Anchor the claim to a specific tip. "BASE OK" on its own is a claim about a
  // moment, and the moment is what went wrong for the builder who reported this.
  console.log(`  tip     ${r.tip}${r.fetched ? ' (fetched just now)' : '  NOT FETCHED — this may be stale'}`);
  if (!r.fetched && String(r.target).startsWith('origin/')) {
    console.log('  Re-run without --no-fetch, or on a box with network, before trusting it.');
  }
  process.exit(0);
}
console.error(`BASE WRONG — ${r.reason}`);
console.error(`  HEAD    ${r.head}`);
console.error(`  target  ${r.target}`);
console.error('');
console.error('  You are about to work on a tree that is not the one being shipped.');
console.error('  Captures from it will look fine and describe a build nobody runs.');
console.error('');
console.error(`    git fetch origin ${target}`);
console.error(`    git reset --hard origin/${target}`);
process.exit(1);
