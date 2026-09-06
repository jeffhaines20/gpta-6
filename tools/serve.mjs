// Every harness needs the static server up. Starting it by hand means a harness
// that "fails" only because the server died reads like a code failure.
//
// AND it needs to be THIS tree's server. A four-hour review round was spent
// comparing a build against itself because a harness run from a worktree found
// an already-listening server on the default port, serving a different checkout,
// and captured it happily. Nothing in the frame says which tree it came from.
// So an already-listening server is now verified before it is reused: the files
// the render depends on are fetched back and checked against the ones on disk
// here, and a mismatch throws instead of quietly measuring someone else's work.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Small, cheap, and the ones an agent actually edits. A tree that agrees on all
// of these renders the same district whichever copy is being served.
const PROBES = ['src/streaming.js', 'src/materials.js', 'district/main.js'];

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * @param {number} port
 * @param {number} timeoutMs
 * @param {{root?:string, verify?:boolean}} [opts] root defaults to cwd.
 */
export async function ensureServer(port = 8123, timeoutMs = 20000, opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const verify = opts.verify !== false;
  const url = `http://127.0.0.1:${port}/`;

  const alive = async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return r.ok || r.status === 404;
    } catch { return false; }
  };
  const checkRoot = async () => {
    for (const rel of PROBES) {
      const local = path.join(root, rel);
      if (!fs.existsSync(local)) continue;
      let served;
      try {
        const r = await fetch(`${url}${rel}`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        served = Buffer.from(await r.arrayBuffer());
      } catch (e) {
        throw new Error(`:${port} would not serve ${rel} (${e.message}). ` +
          `Give this run its own port rather than borrowing one.`);
      }
      const want = sha(fs.readFileSync(local)), got = sha(served);
      if (want !== got) {
        throw new Error(
          `:${port} is serving a DIFFERENT checkout. ${rel} is ${got} there and ` +
          `${want} in ${root}. Start this run on its own port (HERO_PORT / the ` +
          `port argument) from the tree you mean to measure — port 8123 belongs ` +
          `to the main tree.`);
      }
    }
  };

  if (await alive()) {
    if (verify) await checkRoot();
    return { started: false, port, root };
  }
  const child = spawn('npx', ['--yes', 'http-server', '-p', String(port), '-s', '.'],
    { detached: true, stdio: 'ignore', cwd: root });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive()) {
      if (verify) await checkRoot();
      return { started: true, port, root };
    }
  }
  throw new Error(`static server did not come up on :${port}`);
}
