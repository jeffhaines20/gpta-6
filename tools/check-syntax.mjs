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
/**
 * AND NO CHECK BELOW A GATE'S VERDICT. A gate file ends `process.exit(fail ? 1 : 0)`, and anything
 * after that line parses perfectly and never runs. CLAUDE.md records #106's arm being appended there
 * and losing twelve checks; what nobody looked for was an arm ALREADY there. `boot-check`'s
 * wedged-car cue — three checks, the only gate that sees that line reach the page — was moved below
 * the verdict by #89's commit (e6504de) and stayed unreachable for ten days, through every boot-check
 * run since, with the check count simply three lower. Nothing errors, so the only symptom is a count
 * nobody reads; this reads it.
 *
 * AT ANY INDENTATION. The first version took only a column-0 `process.exit(` as the verdict, and a gate
 * guarded on being the main module -- `if (IS_MAIN) { ... process.exit(...) }`, which is what
 * CLAUDE.md tells a tool to do -- has none, so 24 of the gates with `check(` calls were exempt: a
 * check planted below kerb-stand's verdict passed it. Now a statement that STARTS with
 * `process.exit(` is unconditional within its block, and any `check(` after it before the block
 * closes (a non-blank, non-comment line indented less than the exit) is dead. A column-0 exit's block
 * is the file, so the old rule is the special case.
 */
const dead = [];
const indentOf = (l) => l.match(/^\s*/)[0].length;
for (const f of files.filter((f) => f.startsWith(`tools${path.sep}`) && f.endsWith('.mjs'))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (!/^\s*process\.exit\(/.test(l)) return;
    const k = indentOf(l);
    let after = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (!t.trim() || /^\s*(\/\/|\*|\/\*)/.test(t)) continue;
      if (indentOf(t) < k) break;
      if (/\bcheck\(/.test(t)) after++;
    }
    if (after) dead.push({ file: f, line: i + 1, after });
  });
}
if (bad.length || dead.length) {
  if (bad.length) console.error(`SYNTAX: FAIL — ${bad.length}/${files.length}`);
  for (const b of bad) console.error(`  ${b.file}: ${b.error}`);
  for (const d of dead) {
    console.error(`  ${d.file}: ${d.after} check() call(s) after the verdict's process.exit at line ${d.line} — unreachable`);
  }
  if (!bad.length) console.error(`SYNTAX: FAIL — ${dead.length} gate(s) with checks below their verdict`);
  process.exit(1);
}
console.log(`SYNTAX: PASS — ${files.length} modules parse, and no gate has a check below its verdict`);
