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
  // `-s .` is relative to the child's cwd, so the root is set explicitly rather
  // than inherited - a caller that passes `root` gets that root even when it is
  // invoked from somewhere else.
  const child = spawn('npx', ['--yes', 'http-server', '-p', String(port), '-s', root],
    { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive()) return { started: true, port, root };
  }
  throw new Error(`static server did not come up on :${port}`);
}
