// Cheap first gate: every shipped module must parse. A syntax error in a module
// only surfaces as "__district is not defined" in a browser harness, which reads
// like a harness problem rather than a code problem and wastes a whole run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'tools', 'district', 'skeleton', 'visual', 'labs'];
const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
};
roots.forEach(walk);

const bad = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad.push({ file: f, error: String(e.stderr).split('\n').slice(0, 3).join(' ').trim() });
  }
}
if (bad.length) {
  console.error(`SYNTAX: FAIL — ${bad.length}/${files.length}`);
  for (const b of bad) console.error(`  ${b.file}: ${b.error}`);
  process.exit(1);
}
console.log(`SYNTAX: PASS — ${files.length} modules parse`);
