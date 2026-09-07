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
export function checkBase(target) {
  const head = git('rev-parse', 'HEAD');
  if (!head) return { ok: false, reason: 'not a git working tree', head: null, target, base: null, behind: null, ahead: null };
  // Prefer the remote ref: a local branch of the same name in a worktree may
  // itself be stale, which is exactly the case this tool exists to catch.
  const ref = git('rev-parse', '--verify', `origin/${target}`) ? `origin/${target}` : target;
  const tip = git('rev-parse', ref);
  if (!tip) {
    return { ok: false, reason: `cannot resolve ${target} (fetch it first)`, head, target, base: null, behind: null, ahead: null };
  }
  const base = git('merge-base', 'HEAD', tip);
  const counts = git('rev-list', '--left-right', '--count', `${tip}...HEAD`);
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
  if (base === tip) {
    return { ok: true, reason: 'contains the branch tip', head, target: ref, base, behind, ahead };
  }
  return {
    ok: false,
    reason: behind === null ? 'diverged' : `MISSING ${behind} commit(s) from ${ref}`,
    head, target: ref, base, behind, ahead,
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
  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

const i = process.argv.indexOf('--branch');
const target = i >= 0 ? process.argv[i + 1] : WORK_BRANCH;
const r = checkBase(target);
if (r.ok) {
  console.log(`BASE OK — this tree contains ${r.target}` + (r.ahead ? ` (${r.ahead} commit(s) ahead)` : ''));
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
