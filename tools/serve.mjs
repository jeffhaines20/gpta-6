// Every harness needs the static server up. Starting it by hand means a harness
// that "fails" only because the server died reads like a code failure.
import { execFile, spawn } from 'node:child_process';

export async function ensureServer(port = 8123, timeoutMs = 20000) {
  const url = `http://127.0.0.1:${port}/`;
  const alive = async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return r.ok || r.status === 404;
    } catch { return false; }
  };
  if (await alive()) return { started: false, port };
  const child = spawn('npx', ['--yes', 'http-server', '-p', String(port), '-s', '.'],
    { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive()) return { started: true, port };
  }
  throw new Error(`static server did not come up on :${port}`);
}
