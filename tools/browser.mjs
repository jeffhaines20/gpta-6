// Where Chromium lives, resolved rather than assumed.
//
// Six harnesses used to hardcode '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'.
// That is this container's path and nowhere else's, so every harness failed on any
// other machine - including a CI runner, and including the owner's. The failure mode
// was also misleading: a missing browser surfaces as a launch error that reads like
// the harness is broken.
//
// Resolution order, first hit wins:
//   1. PLAYWRIGHT_CHROMIUM   - explicit override, for an unusual install
//   2. PLAYWRIGHT_BROWSERS_PATH/chromium-*/chrome-linux/chrome - the pinned container
//   3. undefined             - let Playwright resolve its own managed download
//
// Case 3 is what CI uses after `npx playwright install chromium`.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function chromiumExecutable() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM is set to ${explicit}, which does not exist`);
    }
    return explicit;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('chromium')) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
        const candidate = join(root, entry, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { /* directory absent - fall through to Playwright's own resolution */ }
  return undefined;
}

// SwiftShader flags. This container has no GPU, so every harness renders in
// software - which is exactly why frame rate is never reported as a finding.
export const SWIFTSHADER_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
];

export function launchOptions(extraArgs = []) {
  const exe = chromiumExecutable();
  return { ...(exe ? { executablePath: exe } : {}), args: [...SWIFTSHADER_ARGS, ...extraArgs] };
}
