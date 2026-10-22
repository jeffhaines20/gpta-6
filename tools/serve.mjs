// Every harness needs the static server up. Starting it by hand means a harness
// that "fails" only because the server died reads like a code failure.
//
// REUSE IS THE DANGEROUS PART. This function returns early when something is
// already listening on the port, and `http-server -s .` serves whatever
// directory the process that started it happened to be in. So a capture run
// from a worktree, against a port the MAIN tree already owns, photographs the
// main tree and reports success. Two before/after arms in this session came back
// pixel-identical for exactly that reason - the first time it was patched by
// giving one tool its own port env var (HERO_PORT), which fixed that tool and
// left the trap armed everywhere else. It went off again in the next round.
//
// So the check belongs here, once: before reusing a live server, prove it is
// serving THIS tree by asking it for a token only this tree has on disk. If it
// is not, fail loudly. A harness that stops with "the port belongs to another
// tree" costs a minute; one that silently renders the wrong commit costs a
// review round, and it costs it invisibly - the frames look fine, they are just
// not of the thing you changed.
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const SENTINEL = '.serve-sentinel';

/**
 * Is the server on `port` serving `root`? Writes a one-shot token into the tree
 * and reads it back over HTTP, so the answer is about the server's actual
 * document root and not about anything we believe.
 */
async function servesThisTree(port, root) {
  const token = randomBytes(16).toString('hex');
  const path = join(root, SENTINEL);
  try {
    writeFileSync(path, token);
    const r = await fetch(`http://127.0.0.1:${port}/${SENTINEL}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    return (await r.text()).trim() === token;
  } catch {
    return false;
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @param {{root?:string, allowForeign?:boolean}} opts
 *   root         document root to serve and to verify against; defaults to cwd.
 *   allowForeign reuse a live server even if it is serving a different tree.
 *                Only for callers that genuinely do not care which tree they
 *                get, and there are none today.
 */
export async function ensureServer(port = 8123, timeoutMs = 20000, opts = {}) {
  const root = opts.root ?? process.cwd();
  const url = `http://127.0.0.1:${port}/`;
  const alive = async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return r.ok || r.status === 404;
    } catch { return false; }
  };
  if (await alive()) {
    if (opts.allowForeign || await servesThisTree(port, root)) return { started: false, port, root };
    throw new Error(
      `port ${port} is already serving a DIFFERENT tree than ${root}.\n` +
      '  Reusing it would capture the wrong commit and the frames would look fine.\n' +
      '  Give this run its own port (the capture tools take one via env or --port)\n' +
      '  and run it with this tree as the working directory.');
  }
  // THE ROOT GOES FIRST, BECAUSE `-s` TOOK IT. This read `-p <port> -s <root>` under a comment
  // saying the root "is set explicitly rather than inherited", and it never was: http-server 14
  // parses its argv with minimist and declares no booleans, so `-s <root>` came out as
  // `{ s: '<root>' }` with no positional at all, and http-server fell back to `./` — the CHILD'S
  // CWD. Every tool here passes `root` and every one was served its cwd; that is the same
  // directory when a tool runs from its own tree's root, which is why nothing noticed. Measured
  // 2026-10-22 (#136): a server started for scratchpad/g136/mut-tree from cwd scratchpad/g136
  // answered `/` with "Index of /" listing mut-tree/ itself and 404'd /district/ — loudly, by luck
  // of the cwd having no district/. From another TREE's root it would have served that tree, and
  // a probe of a mutation would have measured the shipped build.
  //
  // So: the root is the positional and `-s` is last, the child also runs IN the root, and a fresh
  // server has to hand back this tree's token before it is used — the reuse path above always
  // checked, and a server this function started itself was trusted because it answered at all.
  const child = spawn('npx', ['--yes', 'http-server', root, '-p', String(port), '-s'],
    { detached: true, stdio: 'ignore', cwd: root });
  // A root that does not exist is now a spawn error rather than a server quietly rooted elsewhere,
  // and an unheard 'error' event would kill the caller with an unhandled exception instead.
  let spawnErr = null;
  child.on('error', (e) => { spawnErr = e; });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!up) up = await alive();
    if (up && await servesThisTree(port, root)) return { started: true, port, root };
  }
  throw new Error(up
    ? `the server started on :${port} answers but does not serve ${root} (its token never came back)`
    : `static server did not come up on :${port}${spawnErr ? ` (${spawnErr.message})` : ''}`);
}

/**
 * A PORT OF A TREE'S OWN, lifted here out of `tools/mutation-sweep.mjs` so the next browser tool
 * does not have to rediscover it.
 *
 * 8123 BELONGS TO THE MAIN TREE — CLAUDE.md says so in as many words — so a tool run from a
 * worktree that asks for 8123 finds a live server with a foreign document root and THROWS. In a
 * tool whose non-zero exit means something else, that throw reads as a result: `mutation-sweep
 * --browser` was a silent no-op in every tree but one for exactly this reason, and every
 * `[browser]` row came back "caught" whatever it mutated. That trap was patched in one tool and
 * left armed everywhere else, which is this repo's recurring shape — hence one definition.
 *
 * Derived from the tree's absolute path, so two trees never collide and one tree is stable across
 * runs, in the ephemeral range above 8200 and clear of 8123.
 */
export function treePort(root = process.cwd()) {
  let h = 2166136261;
  for (const c of String(root)) { h ^= c.charCodeAt(0); h = (h * 16777619) >>> 0; }
  return 8200 + (h % 1200);
}
